/**
 * call_set_tolerance_raw.js
 * Build set_tolerance(1.0) instruction with raw discriminator + Borsh encoding.
 * Bypasses IDL encoder — safe for newly added instructions not yet in IDL file.
 */
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const fs = require("fs");

async function main() {
  const PROGRAM_ID = new PublicKey("74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf");
  const NETWORK_CONFIG_PDA = new PublicKey("BgW8KxfMmEEDPwuQiXUBdUATXqtSVT3TYDhf9qXDpbrt");
  const RPC = "https://api.devnet.solana.com";

  const raw = JSON.parse(fs.readFileSync("/tmp/life-compute-dev-keypair.json", "utf8"));
  const authority = Keypair.fromSecretKey(new Uint8Array(raw));
  console.log("Authority:", authority.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");

  // Anchor discriminator for "global:set_tolerance" = sha256()[0..8]
  // Pre-computed: [87, 0, 237, 120, 189, 148, 98, 241]
  const discriminator = Buffer.from([87, 0, 237, 120, 189, 148, 98, 241]);

  // Arg: validation_tolerance f32 = 1.0 — Borsh encodes f32 as 4-byte LE IEEE 754
  const argBuf = Buffer.allocUnsafe(4);
  argBuf.writeFloatLE(1.0, 0);
  console.log("f32(1.0) LE bytes:", Array.from(argBuf));

  const data = Buffer.concat([discriminator, argBuf]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: NETWORK_CONFIG_PDA, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  console.log("Sending set_tolerance(1.0)...");
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  console.log("Signature:", sig);

  // Verify on-chain
  await new Promise((r) => setTimeout(r, 2000));
  const info = await connection.getAccountInfo(NETWORK_CONFIG_PDA);
  const d = info.data;
  const tol = d.readFloatLE(113);   // bytes 113-116 = validation_tolerance f32
  const vr = d[112];                 // byte 112 = validators_required u8
  console.log("\n=== On-Chain Verification ===");
  console.log("validators_required:", vr);
  console.log("validation_tolerance:", tol);
  if (Math.abs(tol - 1.0) < 0.0001) {
    console.log("✅ validation_tolerance = 1.0 confirmed on-chain");
  } else {
    console.error("❌ MISMATCH — expected 1.0, got", tol);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
