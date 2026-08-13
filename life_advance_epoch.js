#!/usr/bin/env node
/**
 * Permissionless crank: calls advance_epoch on the LIFE Compute devnet program.
 * Usage: node life_advance_epoch.js
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("DzcQHhTPuiqxCxZurDbEAaV1U2JBFXWy6JG1LE6WsKvJ");
const RPC_URL    = "https://api.devnet.solana.com";
const IDL_PATH   = path.join(__dirname, "target/idl/life_core.json");
const CRANK_KP   = "/tmp/life-compute-dev-keypair.json";

async function main() {
  // Load crank keypair
  const crankKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(CRANK_KP, "utf8")))
  );
  console.log("Crank:", crankKp.publicKey.toBase58());

  // Provider
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(crankKp);
  const provider   = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });

  // Load IDL, override address
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  // Derive NetworkConfig PDA
  const [networkConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    PROGRAM_ID
  );
  console.log("NetworkConfig PDA:", networkConfigPda.toBase58());

  // Read current on-chain state before advancing
  const configBefore = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("Current epoch      :", configBefore.currentEpoch.toString());
  console.log("epoch_start_slot   :", configBefore.epochStartSlot.toString());
  console.log("epoch_duration_slots:", configBefore.epochDurationSlots.toString());

  const { slot: currentSlot } = await connection.getSlot("confirmed").then(s => ({ slot: s }));
  const elapsed = currentSlot - Number(configBefore.epochStartSlot);
  const duration = Number(configBefore.epochDurationSlots);
  console.log("Current slot       :", currentSlot);
  console.log("Elapsed slots      :", elapsed);
  console.log("Duration slots     :", duration);
  console.log("Ready?             :", elapsed >= duration ? "YES" : `NO (need ${duration - elapsed} more slots)`);

  if (elapsed < duration) {
    console.error("ERROR: Epoch not ready yet. Aborting.");
    process.exit(1);
  }

  // Call advance_epoch
  console.log("\nCalling advance_epoch...");
  let tx;
  try {
    tx = await program.methods
      .advanceEpoch()
      .accounts({
        crank:         crankKp.publicKey,
        networkConfig: networkConfigPda,
      })
      .signers([crankKp])
      .rpc();
  } catch (e) {
    console.error("ERROR calling advance_epoch:", e.message);
    if (e.logs)      console.error("Program logs:\n" + e.logs.join("\n"));
    if (e.errorLogs) console.error("Error logs:\n"   + e.errorLogs.join("\n"));
    if (e.error)     console.error("Anchor error:", JSON.stringify(e.error));
    process.exit(1);
  }

  console.log("Transaction signature:", tx);
  console.log("Explorer link: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");

  // Confirm and read new state
  await connection.confirmTransaction(tx, "confirmed");
  const configAfter = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("\nNew epoch          :", configAfter.currentEpoch.toString());
  console.log("New epoch_start_slot:", configAfter.epochStartSlot.toString());

  process.stdout.write(JSON.stringify({
    status:    "success",
    tx,
    old_epoch: configBefore.currentEpoch.toString(),
    new_epoch: configAfter.currentEpoch.toString(),
    explorer:  "https://explorer.solana.com/tx/" + tx + "?cluster=devnet",
  }) + "\n");
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
