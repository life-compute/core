#!/usr/bin/env node
/**
 * register_mrna_targets.js
 * Register 30 mRNA silencing targets at on-chain IDs 2000-2029.
 * Reads the 30 mRNA entries from targets.json (target_type === "mRNA"),
 * skips any that already have a TargetAccount PDA, registers the rest.
 *
 * Usage:
 *   node scripts/register_mrna_targets.js --keypair <path> [--dry-run]
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
  "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf"
);
const DRY_RUN = hasFlag("--dry-run");
const DELAY_MS = 800; // rate-limit between txs

const KEYPAIR_PATH = flag(
  "--keypair",
  path.join(require("os").homedir(), ".config/solana/id.json")
);

// IDL auto-discover
const REPO = path.resolve(__dirname, "..");
const IDL_PATH = [
  path.join(REPO, "target/idl/life_core.json"),
  path.join(REPO, "../../life-compute/core/target/idl/life_core.json"),
].find((p) => fs.existsSync(p));
if (!IDL_PATH) {
  console.error("IDL not found");
  process.exit(1);
}

// Targets file: prefer /tmp/life-compute-targets, fallback repo
const TARGETS_PATH = [
  "/tmp/life-compute-targets/targets.json",
  path.join(REPO, "targets.json"),
].find((p) => fs.existsSync(p));
if (!TARGETS_PATH) {
  console.error("targets.json not found");
  process.exit(1);
}

// mRNA targets → on-chain IDs 2000-2029
const MRNA_BASE_ID = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uniprotBytes(s) {
  const buf = Buffer.alloc(10, 0);
  Buffer.from(s.slice(0, 10), "ascii").copy(buf);
  return Array.from(buf);
}

async function withRetry(fn, label, max = 3) {
  for (let a = 1; a <= max; a++) {
    try {
      return await fn();
    } catch (e) {
      if (a === max) throw e;
      const wait = 1000 * 2 ** (a - 1);
      console.log(
        `    retry ${a}/${
          max - 1
        } for ${label} in ${wait}ms — ${e.message?.slice(0, 80)}`
      );
      await sleep(wait);
    }
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   LIFE Compute — mRNA Target Registration (IDs 2000-2029)║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Program:  ${PROGRAM_ID}`);
  console.log(`Keypair:  ${KEYPAIR_PATH}`);
  console.log(`Targets:  ${TARGETS_PATH}`);
  if (DRY_RUN) console.log("Mode:     DRY-RUN\n");

  const authKp = web3.Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  console.log(`Authority: ${authKp.publicKey.toBase58()}\n`);

  const connection = new web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  const programId = new web3.PublicKey(PROGRAM_ID);

  const [networkConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    programId
  );

  // Load mRNA targets from file
  const allTargets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  const mrnaTargets = allTargets.filter((t) => t.target_type === "mRNA");
  if (mrnaTargets.length !== 30) {
    console.error(`Expected 30 mRNA targets, found ${mrnaTargets.length}`);
    process.exit(1);
  }
  console.log(`Found ${mrnaTargets.length} mRNA targets in targets.json`);

  // Pre-flight: check which are already registered
  const pdas = mrnaTargets.map((_, i) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(MRNA_BASE_ID + i, 0);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("target"), buf],
      programId
    )[0];
  });
  const infos = await connection.getMultipleAccountsInfo(pdas);
  const toRegister = [],
    alreadyDone = [];
  infos.forEach((info, i) => {
    const onchainId = MRNA_BASE_ID + i;
    if (info) alreadyDone.push({ onchainId, id: mrnaTargets[i].id });
    else toRegister.push({ onchainId, t: mrnaTargets[i], pda: pdas[i] });
  });

  console.log(`Already registered: ${alreadyDone.length}`);
  console.log(`To register:        ${toRegister.length}\n`);
  if (alreadyDone.length) {
    console.log(
      "Already done:",
      alreadyDone.map((x) => `${x.id}(${x.onchainId})`).join(", ")
    );
    console.log();
  }

  if (toRegister.length === 0) {
    console.log("✓ All 30 mRNA targets already registered. Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY-RUN — would register:");
    for (const { onchainId, t } of toRegister) {
      console.log(
        `  [${onchainId}] ${t.id.padEnd(20)} uniprot=${t.uniprot_id}  diff=Hard`
      );
    }
    return;
  }

  let registered = 0,
    failed = 0;
  const failures = [];

  for (const { onchainId, t, pda } of toRegister) {
    process.stdout.write(
      `  [${onchainId}] ${t.id.padEnd(20)} ${t.uniprot_id}  `
    );
    try {
      const tx = await withRetry(async () => {
        const ix = await program.methods
          .registerTarget(onchainId, uniprotBytes(t.uniprot_id), { hard: {} })
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
        for (let p = 0; p < 30; p++) {
          await sleep(1000);
          const st = await connection.getSignatureStatuses([sig]);
          const cs = st?.value?.[0]?.confirmationStatus;
          if (cs === "confirmed" || cs === "finalized") return sig;
          if (st?.value?.[0]?.err)
            throw new Error(`TX failed: ${JSON.stringify(st.value[0].err)}`);
        }
        throw new Error("TX not confirmed after 30s");
      }, t.id);

      console.log(`✓  ${tx.slice(0, 16)}…`);
      registered++;
    } catch (e) {
      console.log(`✗  ${e.message?.slice(0, 100)}`);
      failed++;
      failures.push({ onchainId, id: t.id, error: e.message?.slice(0, 120) });
    }
    await sleep(DELAY_MS);
  }

  console.log("\n" + "═".repeat(60));
  console.log("REGISTRATION COMPLETE");
  console.log("═".repeat(60));
  console.log(
    `Registered: ${registered}  |  Already existed: ${alreadyDone.length}  |  Failed: ${failed}`
  );
  if (failures.length) {
    console.log("\nFailed:");
    failures.forEach((f) =>
      console.log(`  [${f.onchainId}] ${f.id}: ${f.error}`)
    );
  }
  if (registered > 0)
    console.log(
      `\n✓ ${registered} mRNA target(s) registered on-chain at IDs 2000-${
        2000 + registered - 1
      }.`
    );
}

main().catch((e) => {
  console.error("\nFatal:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
