#!/usr/bin/env node
/**
 * scripts/register_crispr_targets.js
 * ───────────────────────────────────────────────────────────────────────────
 * LIFE Compute — CRISPR Target Registration (IDs 3000-3009)
 *
 * Registers 10 CRISPR gRNA targets on the Solana program at the 3000-3009
 * ID block. All targets are tier 3 (HARD). UniProt IDs match the protein
 * targets for MSA reuse (same gene, different modality).
 *
 * Skips any targets that are already registered on-chain.
 *
 * Usage:
 *   node scripts/register_crispr_targets.js --keypair <path> [--dry-run]
 *
 * Options:
 *   --rpc       Solana RPC endpoint     (default: devnet)
 *   --program   Program ID              (default: 74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf)
 *   --keypair   Authority keypair path  (default: /tmp/life-compute-dev-keypair.json)
 *   --idl       IDL JSON path           (default: auto-discover)
 *   --dry-run   Print plan, no txs
 * ───────────────────────────────────────────────────────────────────────────
 */
"use strict";

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const hasFlag = (n) => args.includes(n);

const RPC_URL = flag("--rpc", "https://api.devnet.solana.com");
const PROGRAM_ID = flag(
  "--program",
  "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf",
);
const DRY_RUN = hasFlag("--dry-run");
const DELAY_MS = 800; // rate-limit between txs

const KEYPAIR_PATH = flag("--keypair", "/tmp/life-compute-dev-keypair.json");

// IDL auto-discover
const REPO = path.resolve(__dirname, "..");
const IDL_PATH = [
  path.join(REPO, "target/idl/life_core.json"),
  path.join(REPO, "../../life-compute/core/target/idl/life_core.json"),
].find((p) => fs.existsSync(p));
if (!IDL_PATH) {
  console.error("ERROR: IDL not found. Pass --idl <path>.");
  process.exit(1);
}

// ── CRISPR target definitions (IDs 3000-3009, all tier 3 / HARD) ──────────
// UniProt IDs sourced from adaptive/life_crispr.py CRISPR_TARGETS list.
const CRISPR_TARGETS = [
  { onchainId: 3000, id: "TP53_CRISPR", uniprotId: "P04637" },
  { onchainId: 3001, id: "KRAS_CRISPR", uniprotId: "P01116" },
  { onchainId: 3002, id: "BCL2_CRISPR", uniprotId: "P10415" },
  { onchainId: 3003, id: "MYC_CRISPR", uniprotId: "P01106" },
  { onchainId: 3004, id: "EGFR_CRISPR", uniprotId: "P00533" },
  { onchainId: 3005, id: "HER2_CRISPR", uniprotId: "P04626" },
  { onchainId: 3006, id: "BRCA1_CRISPR", uniprotId: "P38398" },
  { onchainId: 3007, id: "PDL1_CRISPR", uniprotId: "Q9NZQ7" },
  { onchainId: 3008, id: "TERT_CRISPR", uniprotId: "O14746" },
  { onchainId: 3009, id: "CDK4_CRISPR", uniprotId: "P11802" },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode a UniProt ID into a [u8; 10] byte array (null-padded). */
function uniprotBytes(s) {
  const buf = Buffer.alloc(10, 0);
  Buffer.from(s.slice(0, 10), "ascii").copy(buf);
  return Array.from(buf);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, max = 3) {
  for (let a = 1; a <= max; a++) {
    try {
      return await fn();
    } catch (e) {
      if (a === max) throw e;
      const wait = 1000 * 2 ** (a - 1);
      console.log(
        `    retry ${a}/${max - 1} for ${label} in ${wait}ms — ${e.message?.slice(0, 80)}`,
      );
      await sleep(wait);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  LIFE Compute — CRISPR Target Registration (3000-3009)   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Program:  ${PROGRAM_ID}`);
  console.log(`Keypair:  ${KEYPAIR_PATH}`);
  console.log(`IDL:      ${IDL_PATH}`);
  if (DRY_RUN) console.log("Mode:     DRY-RUN\n");
  else console.log();

  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`ERROR: Keypair not found: ${KEYPAIR_PATH}`);
    process.exit(1);
  }
  const authKp = web3.Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))),
  );
  console.log(`Authority: ${authKp.publicKey.toBase58()}\n`);

  const connection = new web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  const programId = new web3.PublicKey(PROGRAM_ID);

  const [networkConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    programId,
  );

  // ── Pre-flight: check existing registrations ───────────────────────────
  console.log("Pre-flight: checking existing on-chain registrations...");
  const pdas = CRISPR_TARGETS.map(({ onchainId }) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(onchainId, 0);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("target"), buf],
      programId,
    )[0];
  });

  const infos = await withRetry(
    () => connection.getMultipleAccountsInfo(pdas),
    "preflight",
  );

  const toRegister = [];
  const alreadyDone = [];
  infos.forEach((info, i) => {
    const t = CRISPR_TARGETS[i];
    if (info !== null) alreadyDone.push(t);
    else toRegister.push({ ...t, pda: pdas[i] });
  });

  console.log(`Already registered: ${alreadyDone.length}`);
  if (alreadyDone.length > 0) {
    console.log(
      "  Already done:",
      alreadyDone.map((t) => `${t.id}(${t.onchainId})`).join(", "),
    );
  }
  console.log(`To register:        ${toRegister.length}\n`);

  if (toRegister.length === 0) {
    console.log("✓ All 10 CRISPR targets already registered. Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY-RUN — would register:");
    for (const { onchainId, id, uniprotId } of toRegister) {
      console.log(
        `  [${onchainId}] ${id.padEnd(20)} uniprot=${uniprotId}  diff=Hard`,
      );
    }
    return;
  }

  // ── Register ───────────────────────────────────────────────────────────
  let registered = 0,
    failed = 0;
  const failures = [];
  const signatures = [];

  for (const { onchainId, id, uniprotId, pda } of toRegister) {
    process.stdout.write(`  [${onchainId}] ${id.padEnd(20)} ${uniprotId}  `);
    try {
      const tx = await withRetry(async () => {
        const ix = await program.methods
          .registerTarget(onchainId, uniprotBytes(uniprotId), { hard: {} })
          .accounts({
            authority: authKp.publicKey,
            networkConfig: networkConfigPda,
            target: pda,
            systemProgram: web3.SystemProgram.programId,
          })
          .instruction();
        const bh = await connection.getLatestBlockhash("confirmed");
        const msg = new web3.TransactionMessage({
          payerKey: authKp.publicKey,
          recentBlockhash: bh.blockhash,
          instructions: [ix],
        }).compileToV0Message();
        const vtx = new web3.VersionedTransaction(msg);
        vtx.sign([authKp]);
        const sig = await connection.sendTransaction(vtx, {
          skipPreflight: false,
          maxRetries: 3,
        });
        // Poll for confirmation via HTTP (no websocket)
        for (let p = 0; p < 30; p++) {
          await sleep(1000);
          const st = await connection.getSignatureStatuses([sig]);
          const cs = st?.value?.[0]?.confirmationStatus;
          if (cs === "confirmed" || cs === "finalized") return sig;
          if (st?.value?.[0]?.err)
            throw new Error(`TX failed: ${JSON.stringify(st.value[0].err)}`);
        }
        throw new Error("TX not confirmed after 30s");
      }, id);

      console.log(`✓  tx: ${tx}`);
      signatures.push({ onchainId, id, uniprotId, tx });
      registered++;
    } catch (e) {
      const msg = e.message?.slice(0, 120) || String(e);
      console.log(`✗  ERROR: ${msg}`);
      if (e.logs) {
        const rel = e.logs.filter(
          (l) => l.includes("Error") || l.includes("failed"),
        );
        if (rel.length)
          console.log(`       logs: ${rel.slice(-2).join(" | ")}`);
      }
      failed++;
      failures.push({ onchainId, id, error: msg });
    }
    await sleep(DELAY_MS);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("REGISTRATION COMPLETE");
  console.log("═".repeat(60));
  console.log(`Total targets:       10`);
  console.log(`Already existed:     ${alreadyDone.length}`);
  console.log(`Successfully registered: ${registered}`);
  console.log(`Failed:              ${failed}`);

  if (signatures.length > 0) {
    console.log("\n── Registration Transactions ─────────────────────────────");
    for (const { onchainId, id, uniprotId, tx } of signatures) {
      console.log(`  [${onchainId}] ${id.padEnd(20)} ${uniprotId}`);
      console.log(`          tx: ${tx}`);
      console.log(
        `          explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`,
      );
    }
  }

  if (failures.length > 0) {
    console.log("\nFailed targets:");
    failures.forEach((f) =>
      console.log(`  [${f.onchainId}] ${f.id}: ${f.error}`),
    );
    console.log(`\nRe-run the script to retry failed targets.`);
  }

  if (registered > 0) {
    console.log(
      `\n✓ ${registered} CRISPR target(s) registered on-chain at IDs 3000-3009.`,
    );
  }
}

main().catch((e) => {
  console.error("\nFatal:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
