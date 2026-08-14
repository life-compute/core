#!/usr/bin/env node
/**
 * Register all 30 cancer targets, the miner wallet, and the validator wallet
 * on the new LIFE Compute devnet program.
 * Idempotent: skips accounts that already exist.
 */

const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey(
  "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf"
);
const RPC_URL = "https://api.devnet.solana.com";
const IDL_PATH = path.join(__dirname, "target/idl/life_core.json");
const AUTH_KEYPAIR = "/tmp/life-compute-dev-keypair.json";
const MINER_KEYPAIR = "/mnt/minos-drive/life-compute-miner/miner-keypair.json";
const TARGETS_PATH = "/tmp/life-compute/targets/targets.json";

// Wallets to register (pubkey strings — no secret keys needed here)
const MINER_PUBKEY = new PublicKey(
  "G8wkwTUC4nyQcaxDtRPPBeevS5pXque5hdExrNrhNa5L"
);
const VALIDATOR_PUBKEY = new PublicKey(
  "493jnXXvyQyjaSxeWeRGBcoXnokoUvMmfiJxr1V5i1Uo"
);

// Difficulty map
const DIFFICULTY = {
  1: { easy: {} },
  2: { medium: {} },
  3: { hard: {} },
};

function uniprotBytes(accession) {
  // UNIPROT_LEN = 10; pad with NUL
  const buf = Buffer.alloc(10, 0);
  Buffer.from(accession.slice(0, 10), "ascii").copy(buf);
  return Array.from(buf);
}

async function main() {
  const authKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(AUTH_KEYPAIR, "utf8")))
  );
  console.log("Authority:", authKp.publicKey.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  const [networkConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    PROGRAM_ID
  );

  // ── Register all 30 targets ──────────────────────────────────────────────
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  console.log(`\nRegistering ${targets.length} cancer targets...`);

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const targetId = i; // 0-indexed matches on-chain target_id u16

    // target_id is u16 in Rust → seeds use 2-byte little-endian (target_id.to_le_bytes()).
    // Buffer.from([targetId]) is 1-byte (u8) — that produces a different PDA address.
    const targetIdBuf = Buffer.alloc(2);
    targetIdBuf.writeUInt16LE(targetId);
    const [targetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("target"), targetIdBuf],
      PROGRAM_ID
    );

    const existing = await connection.getAccountInfo(targetPda);
    if (existing) {
      console.log(`  [${i.toString().padStart(2)}] ${t.id} — already registered, skipping`);
      continue;
    }

    const difficulty = DIFFICULTY[t.difficulty_tier] ?? { medium: {} };
    const uniprotArr = uniprotBytes(t.uniprot_id);

    let tx;
    try {
      tx = await program.methods
        .registerTarget(targetId, uniprotArr, difficulty)
        .accounts({
          authority: authKp.publicKey,
          networkConfig: networkConfigPda,
          target: targetPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([authKp])
        .rpc();
      console.log(`  [${i.toString().padStart(2)}] ${t.id} (tier=${t.difficulty_tier}) ✓  tx: ${tx.slice(0, 20)}…`);
    } catch (e) {
      console.error(`  [${i.toString().padStart(2)}] ${t.id} ERROR: ${e.message}`);
      if (e.logs) console.error("  logs:", e.logs.slice(-3).join(" | "));
    }
  }

  // ── Register miner ──────────────────────────────────────────────────────
  console.log("\nRegistering miner:", MINER_PUBKEY.toBase58());
  const [minerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("miner"), MINER_PUBKEY.toBuffer()],
    PROGRAM_ID
  );
  const minerExists = await connection.getAccountInfo(minerPda);
  if (minerExists) {
    console.log("  Miner already registered — skipping.");
  } else {
    const minerKp = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(MINER_KEYPAIR, "utf8")))
    );
    const FOUNDATION_WALLET = new PublicKey(
      "2jVdMx7fb88txbG6YoZzC7kT4Tq8rJDaWrNgbZ3ZnqCb"
    );
    // Fund miner if balance insufficient for stake (0.01 SOL) + tx fee
    const needed = 15_000_000; // 0.015 SOL covers stake + fees
    const minerBal = await connection.getBalance(MINER_PUBKEY);
    if (minerBal < needed) {
      const { Transaction, SystemProgram: SP2 } = require("@solana/web3.js");
      console.log(`  Funding miner (balance ${minerBal} < ${needed} lamports)...`);
      const fundTx = new Transaction().add(
        SP2.transfer({ fromPubkey: authKp.publicKey, toPubkey: MINER_PUBKEY, lamports: needed })
      );
      const fundSig = await provider.sendAndConfirm(fundTx, [authKp]);
      console.log(`  Funded ✓  tx: ${fundSig.slice(0, 20)}…`);
    }
    try {
      const tx = await program.methods
        .registerMiner()
        .accounts({
          miner: MINER_PUBKEY,
          minerAccount: minerPda,
          networkConfig: networkConfigPda,
          foundation: new PublicKey("2jVdMx7fb88txbG6YoZzC7kT4Tq8rJDaWrNgbZ3ZnqCb"),
          systemProgram: SystemProgram.programId,
        })
        .signers([minerKp])
        .rpc();
      console.log(`  Miner registered ✓  tx: ${tx.slice(0, 20)}…`);
      console.log(`  Full tx: ${tx}`);
    } catch (e) {
      console.error("  Miner registration ERROR:", e.message);
      if (e.logs) console.error("  logs:", e.logs.slice(-3).join(" | "));
    }
  }

  // ── Register validator ──────────────────────────────────────────────────
  console.log("\nRegistering validator:", VALIDATOR_PUBKEY.toBase58());
  // register_validator adds to the config's validators[] array via authority update_validators
  // Check: is there an authority-only path to add a validator without their key?
  console.log("  Using update_validators (authority-only) to add validator to set...");
  const config = await program.account.networkConfig.fetch(networkConfigPda);
  const currentValidators = config.validators
    .filter((v) => !v.equals(PublicKey.default))
    .map((v) => v.toBase58());
  console.log("  Current validators:", currentValidators);

  if (currentValidators.includes(VALIDATOR_PUBKEY.toBase58())) {
    console.log("  Validator already in set — skipping.");
  } else {
    // Build new validator list: keep existing + add new one (max 5)
    const existing = config.validators.filter((v) => !v.equals(PublicKey.default));
    const newList = [...existing, VALIDATOR_PUBKEY].slice(0, 5);
    const newRequired = Math.min(config.validatorsRequired, newList.length);

    try {
      const tx = await program.methods
        .updateValidators(newList, newRequired, config.validationTolerance)
        .accounts({
          authority: authKp.publicKey,
          networkConfig: networkConfigPda,
        })
        .signers([authKp])
        .rpc();
      console.log(`  Validator added ✓  tx: ${tx.slice(0, 20)}…`);
      console.log(`  Full tx: ${tx}`);
    } catch (e) {
      console.error("  Validator ERROR:", e.message);
      if (e.logs) console.error("  logs:", e.logs.slice(-3).join(" | "));
    }
  }

  // ── Final state ─────────────────────────────────────────────────────────
  const finalConfig = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("\n── Final NetworkConfig ─────────────────────────────────────");
  console.log("current_epoch       :", finalConfig.currentEpoch.toString());
  console.log("epoch_duration_slots:", finalConfig.epochDurationSlots.toString());
  console.log("validators_required :", finalConfig.validatorsRequired);
  console.log(
    "validators          :",
    finalConfig.validators
      .filter((v) => !v.equals(PublicKey.default))
      .map((v) => v.toBase58())
  );
  console.log("✓ Done.");
}

main().catch((e) => {
  console.error(e);
  if (e.logs) console.error("Program logs:\n" + e.logs.join("\n"));
  process.exit(1);
});
