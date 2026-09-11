/**
 * update_validators_required.js
 * Sets validators_required=1, keeping only the active validator.
 * Must be signed by the NetworkConfig authority.
 */
"use strict";
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey(
  "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf",
);
const RPC_URL = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const AUTH_KEYPAIR =
  process.env.AUTH_KEYPAIR ||
  "/mnt/minos-drive/life-compute-miner/dev-keypair.json";
const IDL_PATH = path.join(__dirname, "target/idl/life_core.json");

// The one active validator to keep
const ACTIVE_VALIDATOR = new PublicKey(
  "4zn1WQZy48ysUeSo2WCFwF9LmoPhZedZq7iKLcAH3pc8",
);

async function main() {
  const authKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(AUTH_KEYPAIR, "utf8"))),
  );
  console.log("Authority:", authKp.publicKey.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authKp),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  const [networkConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("network_config")],
    PROGRAM_ID,
  );

  // Read current state
  const before = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("BEFORE: validators_required =", before.validatorsRequired);
  console.log("        validator_count      =", before.validatorCount);

  // Call update_validators
  const tx = await program.methods
    .updateValidators(
      [ACTIVE_VALIDATOR], // new_validators: keep only the active one
      1, // validators_required: 1
    )
    .accounts({
      authority: authKp.publicKey,
      networkConfig: networkConfigPda,
    })
    .rpc();

  console.log("\ntx:", tx);
  console.log(
    "Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet",
  );

  // Read back
  const after = await program.account.networkConfig.fetch(networkConfigPda);
  console.log("\nAFTER:  validators_required =", after.validatorsRequired);
  console.log("        validator_count      =", after.validatorCount);
  console.log("        validators[0]        =", after.validators[0].toBase58());

  if (after.validatorsRequired === 1) {
    console.log("\n✔ validators_required successfully set to 1");
  } else {
    console.error("\n✘ unexpected value:", after.validatorsRequired);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
