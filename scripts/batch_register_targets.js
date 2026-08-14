#!/usr/bin/env node
/**
 * scripts/batch_register_targets.js
 * ───────────────────────────────────────────────────────────────────────────
 * LIFE Compute — Batch Target Registration
 *
 * Reads targets_2000.json (or targets.json fallback), registers each cancer
 * protein target on the Solana program in batches of 10, skips targets that
 * are already registered, and shows live progress.
 *
 * Usage:
 *   node scripts/batch_register_targets.js [options]
 *
 * Options:
 *   --targets   Path to targets JSON         (default: auto-discover)
 *   --rpc       Solana RPC endpoint           (default: $SOLANA_RPC or devnet)
 *   --keypair   Authority keypair path        (default: $AUTH_KEYPAIR or ~/.life-compute/wallet.json)
 *   --program   Program ID                    (default: $PROGRAM_ID or devnet ID)
 *   --idl       IDL path                      (default: auto-discover)
 *   --batch     Registrations per batch       (default: 10)
 *   --start     Start at this target index    (default: 0)
 *   --end       Stop after this index         (default: all)
 *   --dry-run   Print plan without sending txs
 *   --help      Show this message
 *
 * Environment variables (all overridable by CLI flags):
 *   SOLANA_RPC, PROGRAM_ID, AUTH_KEYPAIR
 *
 * Rate-limiting: 400ms between transactions to stay under devnet limits.
 * Retries: up to 3 attempts per target with exponential backoff.
 * ───────────────────────────────────────────────────────────────────────────
 */

"use strict";

const anchor    = require("@coral-xyz/anchor");
const web3      = require("@solana/web3.js");
const fs        = require("fs");
const path      = require("path");
const os        = require("os");

// ── CLI argument parsing ───────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
function hasFlag(name) { return args.includes(name); }

if (hasFlag("--help")) {
  console.log(`
LIFE Compute — Batch Target Registration
Usage: node scripts/batch_register_targets.js [options]

  --targets   <path>    Path to targets JSON (auto-discovers targets_2000.json)
  --rpc       <url>     Solana RPC URL (default: devnet)
  --keypair   <path>    Authority keypair JSON
  --program   <id>      Program ID (base58)
  --idl       <path>    IDL JSON path
  --batch     <N>       Targets per batch (default: 10)
  --start     <N>       Start index (0-based, default: 0)
  --end       <N>       Inclusive end index (default: last)
  --dry-run             Print plan, no on-chain calls
  --help                Show this help
`.trim());
  process.exit(0);
}

// ── Config ─────────────────────────────────────────────────────────────────
const SCRIPT_DIR   = __dirname;
const REPO_ROOT    = path.resolve(SCRIPT_DIR, "..");
const CORE_DIR     = path.join(REPO_ROOT, "..", "core");   // /tmp/life-compute/core

const RPC_URL      = flag("--rpc",     process.env.SOLANA_RPC   || "https://api.devnet.solana.com");
const PROGRAM_ID_S = flag("--program", process.env.PROGRAM_ID   || "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf");
const KEYPAIR_PATH = flag("--keypair", process.env.AUTH_KEYPAIR  || path.join(os.homedir(), ".life-compute/wallet.json"));
const BATCH_SIZE   = parseInt(flag("--batch", "10"), 10);
const DRY_RUN      = hasFlag("--dry-run");
const START_IDX    = parseInt(flag("--start", "0"), 10);
const END_IDX_ARG  = flag("--end", null);

// IDL auto-discover
let IDL_PATH = flag("--idl", null);
if (!IDL_PATH) {
  const candidates = [
    path.join(CORE_DIR, "target/idl/life_core.json"),
    path.join(REPO_ROOT, "target/idl/life_core.json"),
    path.join(SCRIPT_DIR, "..", "target/idl/life_core.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { IDL_PATH = c; break; }
  }
}
if (!IDL_PATH || !fs.existsSync(IDL_PATH)) {
  console.error("ERROR: Could not find life_core.json IDL. Pass --idl <path>.");
  process.exit(1);
}

// Targets file auto-discover
let TARGETS_PATH = flag("--targets", null);
if (!TARGETS_PATH) {
  const candidates = [
    path.join(REPO_ROOT, "targets_2000.json"),
    "/tmp/life-compute/targets/targets_2000.json",
    "/tmp/targets_2000.json",
    path.join(REPO_ROOT, "targets.json"),
    "/tmp/life-compute/targets/targets.json",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { TARGETS_PATH = c; break; }
  }
}
if (!TARGETS_PATH || !fs.existsSync(TARGETS_PATH)) {
  console.error("ERROR: Could not find targets JSON. Pass --targets <path>.");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode a UniProt ID into a [u8; 10] byte array (null-padded). */
function uniprotBytes(accession) {
  const buf = Buffer.alloc(10, 0);
  Buffer.from(accession.slice(0, 10), "ascii").copy(buf);
  return Array.from(buf);
}

/** Map difficulty_tier integer to on-chain DifficultyTier enum variant. */
function difficultyVariant(tier) {
  switch (tier) {
    case 1:  return { easy:   {} };
    case 2:  return { medium: {} };
    case 3:  return { hard:   {} };
    default: return { medium: {} };   // tier 4 (exploratory) → medium on-chain
  }
}

/** Sleep N ms. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retry fn up to maxAttempts with exponential backoff. */
async function withRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = attempt === maxAttempts;
      const wait   = 1000 * (2 ** (attempt - 1));  // 1s, 2s, 4s
      if (isLast) throw e;
      console.log(`    Retry ${attempt}/${maxAttempts - 1} for ${label} in ${wait}ms — ${e.message?.slice(0,80)}`);
      await sleep(wait);
    }
  }
}

/** Check if a TargetAccount PDA exists on-chain. */
async function targetExists(connection, programId, targetId) {
  const idBytes = Buffer.alloc(2);
  idBytes.writeUInt16LE(targetId, 0);
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("target"), idBytes],
    programId
  );
  const info = await connection.getAccountInfo(pda);
  return { exists: info !== null, pda };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   LIFE Compute — Batch Target Registration               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`RPC:     ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID_S}`);
  console.log(`IDL:     ${IDL_PATH}`);
  console.log(`Targets: ${TARGETS_PATH}`);
  console.log(`Batch:   ${BATCH_SIZE}`);
  if (DRY_RUN) console.log("Mode:    DRY-RUN (no transactions will be sent)");
  console.log("");

  // ── Load keypair ──────────────────────────────────────────────────────
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`ERROR: Keypair not found: ${KEYPAIR_PATH}`);
    process.exit(1);
  }
  const authKp = web3.Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  console.log(`Authority: ${authKp.publicKey.toBase58()}`);

  // ── Set up Anchor ─────────────────────────────────────────────────────
  const connection = new web3.Connection(RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(authKp);
  const provider   = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID_S;
  const program   = new anchor.Program(idl, provider);
  const programId = new web3.PublicKey(PROGRAM_ID_S);

  const [networkConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    programId
  );

  // ── Load targets ──────────────────────────────────────────────────────
  const allTargets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  const endIdx     = END_IDX_ARG !== null ? parseInt(END_IDX_ARG, 10) : allTargets.length - 1;
  const targets    = allTargets.slice(START_IDX, endIdx + 1);

  console.log(`Targets to process: ${targets.length} (index ${START_IDX}–${endIdx} of ${allTargets.length} total)\n`);

  // ── Pre-flight: check which are already registered ─────────────────────
  console.log("Pre-flight: checking existing on-chain registrations...");
  const toRegister = [];
  const alreadyDone = [];

  for (let i = 0; i < targets.length; i++) {
    const globalIdx = START_IDX + i;
    const t = targets[i];
    const { exists } = await targetExists(connection, programId, globalIdx);
    if (exists) {
      alreadyDone.push({ idx: globalIdx, id: t.id });
    } else {
      toRegister.push({ idx: globalIdx, t });
    }
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`\r  Checked ${i + 1}/${targets.length}...`);
    }
    await sleep(50);  // gentle on the RPC
  }
  console.log(`\r  Checked ${targets.length}/${targets.length}          `);
  console.log(`  Already registered: ${alreadyDone.length}`);
  console.log(`  To register:        ${toRegister.length}\n`);

  if (toRegister.length === 0) {
    console.log("✓ All targets in range are already registered. Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY-RUN — would register:");
    for (const { idx, t } of toRegister.slice(0, 20)) {
      const diff = difficultyVariant(t.difficulty_tier);
      console.log(`  [${String(idx).padStart(4)}] ${(t.id || t.gene_name || "?").padEnd(15)} ${t.uniprot_id}  diff=${JSON.stringify(diff)}`);
    }
    if (toRegister.length > 20) {
      console.log(`  ... and ${toRegister.length - 20} more`);
    }
    return;
  }

  // ── Register in batches ──────────────────────────────────────────────
  let registered = 0;
  let failed     = 0;
  const failures = [];

  // Chunk into batches
  for (let b = 0; b < toRegister.length; b += BATCH_SIZE) {
    const batch = toRegister.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toRegister.length / BATCH_SIZE);

    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} targets):`);

    for (const { idx, t } of batch) {
      const geneId    = t.id || t.gene_name || `TARGET_${idx}`;
      const uniprotId = t.uniprot_id;
      const difficulty = difficultyVariant(t.difficulty_tier || 2);
      const uniprotArr = uniprotBytes(uniprotId);

      // Derive PDA with u16 LE bytes
      const idBytes = Buffer.alloc(2);
      idBytes.writeUInt16LE(idx, 0);
      const [targetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("target"), idBytes],
        programId
      );

      process.stdout.write(`  [${String(idx).padStart(4)}] ${geneId.padEnd(15)} ${uniprotId}  `);

      try {
        const tx = await withRetry(async () => {
          return await program.methods
            .registerTarget(idx, uniprotArr, difficulty)
            .accounts({
              authority:     authKp.publicKey,
              networkConfig: networkConfigPda,
              target:        targetPda,
              systemProgram: web3.SystemProgram.programId,
            })
            .signers([authKp])
            .rpc();
        }, geneId);

        console.log(`✓  tx: ${tx.slice(0, 16)}…`);
        registered++;
      } catch (e) {
        const msg = e.message?.slice(0, 120) || String(e);
        console.log(`✗  ERROR: ${msg}`);
        if (e.logs) {
          const relevant = e.logs.filter(l => l.includes("Error") || l.includes("failed"));
          if (relevant.length) console.log(`       logs: ${relevant.slice(-2).join(" | ")}`);
        }
        failed++;
        failures.push({ idx, id: geneId, error: msg });
      }

      // Rate-limit between TXs
      await sleep(400);
    }

    // Progress report after each batch
    const total = registered + failed;
    const pct   = Math.round((total / toRegister.length) * 100);
    console.log(`\n  Progress: Registered ${registered}/${toRegister.length} targets (${pct}%)  Failed: ${failed}`);

    if (b + BATCH_SIZE < toRegister.length) {
      // Pause between batches to avoid rate limiting
      await sleep(1000);
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("REGISTRATION COMPLETE");
  console.log("═".repeat(60));
  console.log(`Total processed:     ${toRegister.length}`);
  console.log(`Successfully registered: ${registered}`);
  console.log(`Already existed:     ${alreadyDone.length}`);
  console.log(`Failed:              ${failed}`);
  if (failures.length) {
    console.log("\nFailed targets:");
    for (const f of failures) {
      console.log(`  [${f.idx}] ${f.id}: ${f.error.slice(0, 80)}`);
    }
    console.log(`\nRe-run with --start ${failures[0].idx} to retry failed targets.`);
  }
  if (registered > 0) {
    console.log(`\n✓ ${registered} new target(s) registered on-chain.`);
  }
}

main().catch(e => {
  console.error("\nFatal error:", e.message || e);
  if (e.logs) console.error("Program logs:\n" + e.logs.join("\n"));
  process.exit(1);
});
