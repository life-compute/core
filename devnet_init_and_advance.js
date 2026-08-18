#!/usr/bin/env node
/**
 * LIFE Compute devnet setup: initialize + wait for epoch + advance.
 * Uses DEVNET_EPOCH_DURATION_SLOTS = 1_000 (~6 min at 400 ms/slot).
 */

const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey(
  "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf"
);
const RPC_URL = "https://api.devnet.solana.com";
const IDL_PATH = path.join(__dirname, "target/idl/life_core.json");
const KEYPAIR_PATH = "/tmp/life-compute-dev-keypair.json";

const SUPPLY_CAP = new anchor.BN(21_000_000).mul(new anchor.BN(1_000_000));
const DEVNET_EPOCH_SLOTS = new anchor.BN(1_000);
const VALIDATORS_REQUIRED = 2;
const VALIDATION_TOLERANCE = 0.05;
const FOUNDATION_WALLET = new PublicKey(
  "2jVdMx7fb88txbG6YoZzC7kT4Tq8rJDaWrNgbZ3ZnqCb"
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const kp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  console.log("Authority:", kp.publicKey.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  // ── PDAs ────────────────────────────────────────────────────────────────────
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
  console.log("NetworkConfig PDA:", networkConfigPda.toBase58());
  console.log("LIFE Mint PDA:    ", lifeMintPda.toBase58());

  // ── Initialize if not already done ─────────────────────────────────────────
  let initTx = null;
  const existing = await connection.getAccountInfo(networkConfigPda);
  if (existing) {
    console.log("\n✓ NetworkConfig already initialized — skipping init.");
  } else {
    console.log("\nInitializing program (epoch_duration_slots = 1_000)...");
    initTx = await program.methods
      .initialize(
        SUPPLY_CAP,
        DEVNET_EPOCH_SLOTS,
        VALIDATORS_REQUIRED,
        VALIDATION_TOLERANCE,
        [kp.publicKey] // authority as initial validator so threshold can be met
      )
      .accounts({
        authority: kp.publicKey,
        networkConfig: networkConfigPda,
        lifeMint: lifeMintPda,
        mintAuthority: mintAuthPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([kp])
      .rpc();
    await connection.confirmTransaction(initTx, "confirmed");
    console.log("Init tx:", initTx);
    console.log(
      "Explorer: https://explorer.solana.com/tx/" + initTx + "?cluster=devnet"
    );
  }

  // ── Read current state ──────────────────────────────────────────────────────
  let config = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("\n── On-chain state ──────────────────────────────────────────");
  console.log("current_epoch       :", config.currentEpoch.toString());
  console.log("epoch_start_slot    :", config.epochStartSlot.toString());
  console.log("epoch_duration_slots:", config.epochDurationSlots.toString());

  // ── Wait until epoch ready ──────────────────────────────────────────────────
  const duration = config.epochDurationSlots.toNumber();
  const startSlot = config.epochStartSlot.toNumber();
  const targetSlot = startSlot + duration;

  console.log("\nWaiting for slot", targetSlot, "to advance epoch...");
  let currentSlot = await connection.getSlot("confirmed");
  while (currentSlot < targetSlot) {
    const remaining = targetSlot - currentSlot;
    process.stdout.write(
      `\r  slot ${currentSlot} / ${targetSlot}  (${remaining} remaining, ~${(remaining * 0.4).toFixed(0)}s)   `
    );
    await sleep(4_000);
    currentSlot = await connection.getSlot("confirmed");
  }
  console.log(`\n✓ Slot ${currentSlot} reached — epoch is ready.`);

  // ── Advance epoch ───────────────────────────────────────────────────────────
  console.log("\nCalling advance_epoch...");
  const advanceTx = await program.methods
    .advanceEpoch()
    .accounts({
      crank: kp.publicKey,
      networkConfig: networkConfigPda,
    })
    .signers([kp])
    .rpc();
  await connection.confirmTransaction(advanceTx, "confirmed");

  const configAfter = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("\n── Result ──────────────────────────────────────────────────");
  console.log("advance_epoch tx   :", advanceTx);
  console.log(
    "Explorer           : https://explorer.solana.com/tx/" +
      advanceTx +
      "?cluster=devnet"
  );
  console.log("old epoch          :", config.currentEpoch.toString());
  console.log("new epoch          :", configAfter.currentEpoch.toString());
  console.log("new epoch_start_slot:", configAfter.epochStartSlot.toString());
  console.log("\n✓ Fresh epoch open — miner can submit immediately.");

  // ── Also update life_advance_epoch.js program ID ───────────────────────────
  process.stdout.write(
    JSON.stringify({
      init_tx: initTx,
      advance_tx: advanceTx,
      old_epoch: config.currentEpoch.toString(),
      new_epoch: configAfter.currentEpoch.toString(),
      explorer:
        "https://explorer.solana.com/tx/" + advanceTx + "?cluster=devnet",
    }) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  if (e.logs) console.error("Program logs:\n" + e.logs.join("\n"));
  process.exit(1);
});
