/**
 * LIFE Compute — on-chain submit helper
 * Usage: node submit.js '<json-args>'
 * Reads JSON from argv[2] (file invocation).
 */
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');

(async () => {
  const args = JSON.parse(process.argv[2]);
  const conn = new Connection(args.rpc, 'confirmed');

  const authKp  = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.authKeypair))));
  const minerKp = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.minerKeypair))));

  const wallet   = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl     = JSON.parse(fs.readFileSync(args.idlPath));
  const program  = new anchor.Program(idl, provider);
  const PROG_ID  = new PublicKey(args.programId);

  const SEED_NETWORK_CONFIG = Buffer.from('network_config');
  const SEED_TARGET = Buffer.from('target');
  const SEED_MINER  = Buffer.from('miner');
  const SEED_JOB    = Buffer.from('job');
  const SEED_RESULT = Buffer.from('result');

  const [networkConfigPda] = PublicKey.findProgramAddressSync([SEED_NETWORK_CONFIG], PROG_ID);
  const config = await program.account.networkConfig.fetch(networkConfigPda);
  const epoch  = config.currentEpoch;

  function epochBytes(e) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(e.toString()));
    return b;
  }

  const TARGET_ID_NUM = args.targetIdNum;
  const [minerAccountPda] = PublicKey.findProgramAddressSync([SEED_MINER, minerKp.publicKey.toBuffer()], PROG_ID);
  const [jobPda]          = PublicKey.findProgramAddressSync([SEED_JOB, epochBytes(epoch), minerKp.publicKey.toBuffer()], PROG_ID);
  const [resultPda]       = PublicKey.findProgramAddressSync([SEED_RESULT, epochBytes(epoch), minerKp.publicKey.toBuffer()], PROG_ID);

  // Check result first — bail if already submitted this epoch
  try {
    await program.account.resultSubmission.fetch(resultPda);
    process.stdout.write(JSON.stringify({ status: 'already_submitted', epoch: epoch.toString() }) + '\n');
    process.exit(0);
  } catch (_) {}

  // Register miner if needed
  let needsRegister = false;
  try { await program.account.minerAccount.fetch(minerAccountPda); } catch (_) { needsRegister = true; }
  if (needsRegister) {
    const t = await program.methods.registerMiner()
      .accounts({ miner: minerKp.publicKey, minerAccount: minerAccountPda, systemProgram: anchor.web3.SystemProgram.programId })
      .signers([minerKp]).rpc();
    process.stderr.write('registered miner: ' + t + '\n');
  }

  // Assign job if not yet assigned for this epoch
  let jobExists = false;
  try { await program.account.jobAssignment.fetch(jobPda); jobExists = true; } catch (_) {}
  if (!jobExists) {
    const [tgt] = PublicKey.findProgramAddressSync([SEED_TARGET, Buffer.from([TARGET_ID_NUM])], PROG_ID);
    const t = await program.methods.assignJob(TARGET_ID_NUM)
      .accounts({ crank: authKp.publicKey, networkConfig: networkConfigPda, target: tgt,
                  miner: minerKp.publicKey, minerAccount: minerAccountPda, jobAssignment: jobPda,
                  systemProgram: anchor.web3.SystemProgram.programId }).rpc();
    process.stderr.write('assigned job: ' + t + '\n');
  }

  // Submit result
  const submitTx = await program.methods
    .submitResult(args.smiles, args.affinity)
    .accounts({ miner: minerKp.publicKey, networkConfig: networkConfigPda,
                minerAccount: minerAccountPda, owner: minerKp.publicKey,
                jobAssignment: jobPda, resultSubmission: resultPda,
                systemProgram: anchor.web3.SystemProgram.programId })
    .signers([minerKp]).rpc();

  process.stdout.write(JSON.stringify({ status: 'submitted', tx: submitTx, epoch: epoch.toString() }) + '\n');
  process.exit(0);
})().catch(e => {
  process.stderr.write((e?.message || String(e)) + '\n');
  process.exit(1);
});
