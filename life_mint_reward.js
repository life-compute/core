#!/usr/bin/env node
/**
 * LIFE Compute — permissionless mint_reward crank.
 *
 * Scans all ResultSubmission PDAs for status=Confirmed + reward_minted=false,
 * then calls mint_reward for each one, minting the correct tier-based $LIFE
 * reward to the miner's ATA.
 *
 * Reward schedule (matches Rust DifficultyTier::base_reward_raw):
 *   tier 1 (easy)   =   1 LIFE
 *   tier 2 (medium) =   5 LIFE
 *   tier 3 (hard)   =  25 LIFE
 *   discovery bonus = 100 LIFE  (separate claim_discovery_bonus ix)
 *
 * Deduplication (added for sybil-bypass fix):
 *   Before minting, the crank derives a ConfirmedMolecule PDA keyed by
 *   (target_id, SHA-256(smiles_bytes)).  The program uses `init` on this
 *   account — if it already exists the tx reverts with DuplicateMolecule and
 *   the entry is logged as SKIP (not FAILED).  The crank increments `skipped`
 *   rather than `failed` for duplicate results so the operator can distinguish
 *   sybil rejections from genuine errors.
 *
 * Usage:
 *   node life_mint_reward.js
 *   node life_mint_reward.js --dry-run     # print pending mints, no TXs
 *   node life_mint_reward.js --result <ResultSubmissionPDA>  # single mint
 *
 * The caller pays gas (crank account). Any signer works — this ix is
 * permissionless; the miner does NOT need to call it themselves.
 */

"use strict";

const crypto = require("crypto");
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(
  process.env.LIFE_PROGRAM_ID ||
    "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf"
);
const RPC_URL =
  process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const IDL_PATH = path.join(__dirname, "target/idl/life_core.json");
const CRANK_KEYPAIR =
  process.env.CRANK_KEYPAIR || "/tmp/life-compute-dev-keypair.json";

// PDA seed for ConfirmedMolecule — must match SEED_CONFIRMED_MOL in constants.rs
const SEED_CONFIRMED_MOL = Buffer.from("confirmed_mol");

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, label, maxAttempts = 3, delayMs = 4000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const is429 =
        e?.message?.includes("429") || e?.status === 429 || e?.code === 429;
      if ((is429 || e?.message?.includes("timeout")) && attempt < maxAttempts) {
        console.warn(
          `  [retry ${attempt}/${maxAttempts}] ${label}: ${e.message.slice(0, 80)}`
        );
        await sleep(delayMs * attempt);
      } else {
        throw e;
      }
    }
  }
}

/** Encode a u16 target_id as 2-byte LE Buffer (matches Rust target_id.to_le_bytes()). */
function targetIdBytes(id) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(id);
  return b;
}

/**
 * Compute SHA-256(smiles_bytes[..smiles_len]) — matches the hash computed
 * inside mint_reward.rs using solana_program::hash::hash (which is SHA-256).
 *
 * `smilesArray` is the raw [u8; 512] array from the decoded ResultSubmission.
 * `smilesLen`   is the u16 smiles_len field (actual string length).
 *
 * We slice only the live bytes, not the zero-padding, exactly as Rust does:
 *   &smiles_bytes_copy[..smiles_len]
 */
function smilesHash(smilesArray, smilesLen) {
  // smilesArray comes from Anchor's borsh decode as a Uint8Array / number[]
  const buf = Buffer.from(smilesArray).subarray(0, smilesLen);
  return crypto.createHash("sha256").update(buf).digest(); // 32-byte Buffer
}

/**
 * Derive the ConfirmedMolecule PDA for a given (targetId, smilesArray, smilesLen).
 * Seeds: [SEED_CONFIRMED_MOL, targetId_le_bytes (2), smiles_hash (32)]
 *
 * Must exactly mirror the `#[account(init, seeds=[...])]` constraint in
 * mint_reward.rs — any mismatch causes an "address constraint violated" error.
 */
function confirmedMolPda(targetId, smilesArray, smilesLen) {
  const hash = smilesHash(smilesArray, smilesLen);
  return PublicKey.findProgramAddressSync(
    [SEED_CONFIRMED_MOL, targetIdBytes(targetId), hash],
    PROGRAM_ID
  );
}

/**
 * Return true if the error from a failed mint_reward call is the
 * DuplicateMolecule custom error from the Rust program.
 *
 * Anchor surfaces custom errors in e.error.errorCode.code (string) or as a
 * hex error code in e.message / e.logs.  We check multiple surfaces for safety.
 */
function isDuplicateMoleculeError(e) {
  // Anchor >= 0.29 surfaces custom error code as a string
  if (e?.error?.errorCode?.code === "DuplicateMolecule") return true;
  // Anchor init constraint failure when PDA already exists
  if (e?.message?.includes("already in use")) return true;
  // Program log surface
  if (e?.logs) {
    const logStr = e.logs.join(" ");
    if (
      logStr.includes("DuplicateMolecule") ||
      logStr.includes("already in use")
    )
      return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes("--dry-run");
  const singleResult = args.includes("--result")
    ? new PublicKey(args[args.indexOf("--result") + 1])
    : null;

  console.log("LIFE Compute — mint_reward crank");
  console.log("  Program:", PROGRAM_ID.toBase58());
  console.log("  RPC:", RPC_URL);
  if (DRY_RUN) console.log("  DRY-RUN: no transactions will be sent");

  const crankKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(CRANK_KEYPAIR, "utf8")))
  );
  console.log("  Crank:", crankKp.publicKey.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(crankKp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  // ── PDAs ──────────────────────────────────────────────────────────────────
  const [networkConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    PROGRAM_ID
  );
  const [lifeMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("life_mint")],
    PROGRAM_ID
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("life_mint"), Buffer.from("authority")],
    PROGRAM_ID
  );

  console.log("\nFetching NetworkConfig...");
  const config = await withRetry(
    () => program.account.networkConfig.fetch(networkConfigPda),
    "networkConfig.fetch"
  );
  console.log(
    "  total_minted:",
    config.totalMinted.toString(),
    "/ supply_cap:",
    config.supplyCap.toString()
  );

  // ── Find pending ResultSubmissions ─────────────────────────────────────────
  let candidates;
  if (singleResult) {
    console.log("\nSingle-result mode:", singleResult.toBase58());
    const acct = await withRetry(
      () => program.account.resultSubmission.fetch(singleResult),
      "resultSubmission.fetch"
    );
    candidates = [{ publicKey: singleResult, account: acct }];
  } else {
    console.log("\nScanning all ResultSubmission PDAs...");
    candidates = await withRetry(
      () => program.account.resultSubmission.all(),
      "resultSubmission.all"
    );
    console.log(`  Total ResultSubmission accounts: ${candidates.length}`);
  }

  // Filter: status == Confirmed, reward_minted == false
  const pending = candidates.filter((c) => {
    const s = c.account.status;
    return "confirmed" in s && !c.account.rewardMinted;
  });
  console.log(`  Pending mints: ${pending.length}`);

  if (pending.length === 0) {
    console.log("\n✓ No pending mints. All done.");
    return;
  }

  // ── Mint rewards ───────────────────────────────────────────────────────────
  let minted = 0;
  let skipped = 0;  // duplicate molecules — not a fault
  let failed = 0;

  for (const { publicKey: resultPda, account: result } of pending) {
    const targetId = result.targetId;
    const minerPubkey = result.miner;

    // Derive target PDA (u16 LE seed — MUST match Rust program)
    const [targetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("target"), targetIdBytes(targetId)],
      PROGRAM_ID
    );

    // Derive miner account PDA
    const [minerAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("miner"), minerPubkey.toBuffer()],
      PROGRAM_ID
    );

    // Get or derive miner's ATA
    const minerAta = await getAssociatedTokenAddress(lifeMintPda, minerPubkey);

    // ── Derive ConfirmedMolecule dedup PDA ─────────────────────────────────
    // Seeds: [b"confirmed_mol", target_id_le (2 bytes), sha256(smiles)[..32]]
    // Must exactly match the `#[account(init, seeds=[...])]` in mint_reward.rs.
    const [confirmedMoleculePda] = confirmedMolPda(
      targetId,
      result.smiles,       // [u8; 512] decoded by Anchor
      result.smilesLen     // u16 actual string length
    );

    // Fetch target to display difficulty
    let targetInfo;
    let diffLabel = "?";
    let expectedLife = "?";
    try {
      targetInfo = await program.account.targetAccount.fetch(targetPda);
      const d = targetInfo.difficulty;
      if ("easy" in d) { diffLabel = "easy"; expectedLife = "1"; }
      else if ("medium" in d) { diffLabel = "medium"; expectedLife = "5"; }
      else if ("hard" in d) { diffLabel = "hard"; expectedLife = "25"; }
      else if ("crispr" in d) { diffLabel = "crispr"; expectedLife = "7"; }
      else if ("mrna" in d) { diffLabel = "mrna"; expectedLife = "25"; }
    } catch (e) {
      console.warn(
        `  WARN: could not fetch target ${targetId}: ${e.message.slice(0, 60)}`
      );
    }

    // Show the derived dedup hash for auditability in dry-run and live mode
    const hashHex = smilesHash(result.smiles, result.smilesLen).toString("hex").slice(0, 12);
    console.log(
      `\n  Result: ${resultPda.toBase58().slice(0, 16)}…` +
        `  target=${targetId} (${diffLabel})` +
        `  miner=${minerPubkey.toBase58().slice(0, 12)}…` +
        `  expected=${expectedLife} LIFE` +
        `  smiles_hash=${hashHex}…`
    );

    if (DRY_RUN) {
      // In dry-run mode, check whether the ConfirmedMolecule PDA already exists
      // so operators can predict which entries will be blocked.
      const existingDedup = await connection.getAccountInfo(confirmedMoleculePda);
      if (existingDedup) {
        console.log(`    [DRY-RUN] SKIP — ConfirmedMolecule PDA already exists (duplicate molecule)`);
        skipped++;
      } else {
        console.log(`    [DRY-RUN] would call mint_reward (new molecule — dedup PDA will be created)`);
        minted++;
      }
      continue;
    }

    // Ensure miner's ATA exists
    const ataInfo = await withRetry(
      () => connection.getAccountInfo(minerAta),
      "getAccountInfo:minerAta"
    );
    if (!ataInfo) {
      console.log("    Creating miner ATA...");
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          crankKp.publicKey, // payer
          minerAta,
          minerPubkey,
          lifeMintPda
        )
      );
      const sig = await withRetry(
        () => provider.sendAndConfirm(tx, [crankKp]),
        "createATA"
      );
      console.log(`    ATA created: ${sig.slice(0, 20)}…`);
    }

    // Build confirming validator ATA list for remaining_accounts
    const confirmingCount = result.confirmingValidatorCount;
    const confirmingValidators = result.confirmingValidatorList.slice(
      0,
      confirmingCount
    );
    const remainingAccounts = [];
    for (const valPk of confirmingValidators) {
      if (valPk.equals(PublicKey.default)) continue;
      const valAta = await getAssociatedTokenAddress(lifeMintPda, valPk);
      // Ensure validator ATA exists
      const valAtaInfo = await withRetry(
        () => connection.getAccountInfo(valAta),
        "getAccountInfo:valAta"
      );
      if (!valAtaInfo) {
        console.log(
          `    Creating validator ATA for ${valPk.toBase58().slice(0, 12)}…`
        );
        const tx = new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            crankKp.publicKey,
            valAta,
            valPk,
            lifeMintPda
          )
        );
        await withRetry(() => provider.sendAndConfirm(tx, [crankKp]), "createValATA");
      }
      remainingAccounts.push({
        pubkey: valAta,
        isSigner: false,
        isWritable: true,
      });
    }

    try {
      const tx = await withRetry(
        () =>
          program.methods
            .mintReward()
            .accounts({
              crank: crankKp.publicKey,
              networkConfig: networkConfigPda,
              lifeMint: lifeMintPda,
              mintAuthority: mintAuthPda,
              resultSubmission: resultPda,
              target: targetPda,
              minerAccount: minerAccountPda,
              minerAta: minerAta,
              // ── New dedup account ───────────────────────────────────────
              // The program uses `init` — if this PDA already exists the
              // tx reverts with DuplicateMolecule before any tokens mint.
              confirmedMolecule: confirmedMoleculePda,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(remainingAccounts)
            .rpc(),
        "mintReward"
      );
      console.log(`    ✓ minted ${expectedLife} LIFE  tx: ${tx.slice(0, 20)}…`);
      console.log(
        `    Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`
      );
      minted++;
    } catch (e) {
      if (isDuplicateMoleculeError(e)) {
        // Not a fault — this SMILES/gRNA was already confirmed for this target
        // by a different wallet.  The sybil bypass is working as intended.
        console.warn(
          `    [SKIP] duplicate molecule — ConfirmedMolecule PDA already exists` +
          `  (target=${targetId} hash=${hashHex}…  miner=${minerPubkey.toBase58().slice(0, 12)}…)`
        );
        skipped++;
      } else {
        console.error(`    ✗ FAILED: ${e.message.slice(0, 120)}`);
        if (e.logs) {
          const relevant = e.logs.filter(
            (l) => l.includes("Error") || l.includes("error") || l.includes("failed")
          );
          if (relevant.length)
            console.error("    logs:", relevant.slice(-3).join(" | "));
        }
        failed++;
      }
    }

    await sleep(2000); // rate-limit between TXs — increased for large backlogs on public devnet
  }

  console.log("\n" + "═".repeat(60));
  console.log("MINT CRANK COMPLETE");
  console.log("═".repeat(60));
  console.log(`  Minted:   ${minted}`);
  console.log(`  Skipped:  ${skipped}  (duplicate molecules — sybil blocked)`);
  console.log(`  Failed:   ${failed}`);

  if (skipped > 0) {
    console.log(
      `\n  NOTE: ${skipped} result(s) blocked as duplicates. Their ResultSubmission PDAs`
    );
    console.log(
      `  remain Confirmed but reward_minted=false — they are permanently inert.`
    );
    console.log(
      `  The ConfirmedMolecule PDA for each blocked entry already exists, meaning`
    );
    console.log(
      `  a different wallet submitted the same SMILES/gRNA and collected the reward first.`
    );
  }
}

main().catch((e) => {
  console.error("\nFatal:", e.message || e);
  if (e.logs) console.error("Program logs:\n" + e.logs.join("\n"));
  process.exit(1);
});
