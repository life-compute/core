/**
 * call_set_tolerance.js
 * Call the new set_tolerance instruction on the deployed program.
 */
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, Connection } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

async function main() {
  const PROGRAM_ID = new PublicKey("74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf");
  const SEED_NETWORK_CONFIG = Buffer.from("network_config");

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // Load upgrade authority keypair
  const keypairPath = "/tmp/life-compute-dev-keypair.json";
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const authority = Keypair.fromSecretKey(new Uint8Array(raw));
  console.log("Authority:", authority.publicKey.toBase58());

  // Derive NetworkConfig PDA
  const [networkConfigPDA] = PublicKey.findProgramAddressSync(
    [SEED_NETWORK_CONFIG],
    PROGRAM_ID
  );
  console.log("NetworkConfig PDA:", networkConfigPDA.toBase58());

  // Load IDL — use the one we have on disk (won't have set_tolerance yet since IDL gen failed,
  // but we can build the instruction manually)
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load IDL from file and patch in set_tolerance
  const idlPath = path.join(__dirname, "target/idl/life_core.json");
  let idl;
  if (fs.existsSync(idlPath)) {
    idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  } else {
    // Fallback: minimal IDL stub just for set_tolerance
    idl = JSON.parse(fs.readFileSync("/mnt/minos-drive/life-compute-miner/life_core.json", "utf8"));
  }

  // Inject set_tolerance if missing from IDL (since IDL gen failed due to borsh conflict)
  const hasSetTolerance = idl.instructions.some(
    (ix) => ix.name === "setTolerance" || ix.name === "set_tolerance"
  );
  if (!hasSetTolerance) {
    console.log("Injecting set_tolerance into IDL...");
    idl.instructions.push({
      name: "setTolerance",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "networkConfig", isMut: true, isSigner: false },
      ],
      args: [{ name: "validationTolerance", type: "f32" }],
    });
  }

  const program = new anchor.Program(idl, provider);

  console.log("Calling set_tolerance(1.0)...");
  const tx = await program.methods
    .setTolerance(1.0)
    .accounts({
      authority: authority.publicKey,
      networkConfig: networkConfigPDA,
    })
    .signers([authority])
    .rpc({ commitment: "confirmed" });

  console.log("Transaction signature:", tx);

  // Verify on-chain
  await new Promise((r) => setTimeout(r, 2000));
  const accountInfo = await connection.getAccountInfo(networkConfigPDA);
  const raw2 = accountInfo.data;
  // bytes 112 = validators_required, 113-116 = validation_tolerance (f32 LE)
  const vr = raw2[112];
  const tol = Buffer.from(raw2.slice(113, 117)).readFloatLE(0);
  console.log("\n=== On-Chain Verification ===");
  console.log(`validators_required: ${vr}`);
  console.log(`validation_tolerance: ${tol}`);
  if (Math.abs(tol - 1.0) < 0.0001) {
    console.log("✅ validation_tolerance = 1.0 confirmed on-chain");
  } else {
    console.log("❌ MISMATCH — expected 1.0, got", tol);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
