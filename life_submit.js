/**
 * LIFE Compute — on-chain submit helper
 * Usage: node life_submit.js '<json-args>'
 * Reads JSON from argv[2] (file invocation).
 *
 * stdout: one JSON line — the final result (last line is parsed by Python).
 * stderr: verbose diagnostic log — everything interesting about what happened.
 */
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');

function log(...args) {
  process.stderr.write('[life_submit] ' + args.join(' ') + '\n');
}

(async () => {
  const args = JSON.parse(process.argv[2]);
  log('rpc:', args.rpc);
  log('programId:', args.programId);
  log('targetIdNum:', args.targetIdNum);

  const conn = new Connection(args.rpc, 'confirmed');

  const authKp  = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.authKeypair))));
  const minerKp = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.minerKeypair))));
  log('auth pubkey :', authKp.publicKey.toBase58());
  log('miner pubkey:', minerKp.publicKey.toBase58());

  const wallet   = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: 'confirmed',
    skipPreflight: false,   // surface simulation errors before sending
  });
  anchor.setProvider(provider);

  const idl     = JSON.parse(fs.readFileSync(args.idlPath));
  idl.address   = args.programId;  // override stale IDL address
  const program  = new anchor.Program(idl, provider);
  const PROG_ID  = new PublicKey(args.programId);

  const SEED_NETWORK_CONFIG = Buffer.from('network_config');
  const SEED_TARGET = Buffer.from('target');
  const SEED_MINER  = Buffer.from('miner');
  const SEED_JOB    = Buffer.from('job');
  const SEED_RESULT = Buffer.from('result');

  // ── Fetch network config / epoch ──────────────────────────────────────────
  const [networkConfigPda] = PublicKey.findProgramAddressSync([SEED_NETWORK_CONFIG], PROG_ID);
  log('networkConfig PDA:', networkConfigPda.toBase58());
  const config = await program.account.networkConfig.fetch(networkConfigPda);
  const epoch  = config.currentEpoch;
  log('currentEpoch:', epoch.toString());
  log('epochStartSlot:', config.epochStartSlot?.toString());
  log('epochDurationSlots:', config.epochDurationSlots?.toString());

  const currentSlot = await conn.getSlot();
  const endSlot = (config.epochStartSlot?.toNumber?.() || 0) + (config.epochDurationSlots?.toNumber?.() || 0);
  log('currentSlot:', currentSlot, '| epochEndsAt:', endSlot, '| slotsRemaining:', endSlot - currentSlot);

  function epochBytes(e) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(e.toString()));
    return b;
  }

  const TARGET_ID_NUM = args.targetIdNum;
  // seq: which submission slot to use (0, 1, or 2 per epoch).
  // Caller may pass args.seq; default to 0 for first submission.
  const SEQ = (typeof args.seq === 'number') ? args.seq : 0;
  log('seq:', SEQ);

  const [minerAccountPda] = PublicKey.findProgramAddressSync([SEED_MINER, minerKp.publicKey.toBuffer()], PROG_ID);
  const [jobPda]          = PublicKey.findProgramAddressSync([SEED_JOB, epochBytes(epoch), minerKp.publicKey.toBuffer(), Buffer.from([SEQ])], PROG_ID);
  const [resultPda]       = PublicKey.findProgramAddressSync([SEED_RESULT, epochBytes(epoch), minerKp.publicKey.toBuffer(), Buffer.from([SEQ])], PROG_ID);
  log('minerAccount PDA:', minerAccountPda.toBase58());
  log('jobAssignment PDA:', jobPda.toBase58());
  log('resultSubmission PDA:', resultPda.toBase58());

  // ── Check on-chain state before acting ───────────────────────────────────
  const resultInfo = await conn.getAccountInfo(resultPda);
  log('resultPda on-chain:', resultInfo !== null ? `YES (${resultInfo.data.length} bytes)` : 'NO');

  if (resultInfo !== null) {
    // Decode and report the existing submission so callers can see what's there
    try {
      const existing = await program.account.resultSubmission.fetch(resultPda);
      const smilesArr = Array.from(existing.smiles);
      const smilesLen = existing.smilesLen ?? existing.smiles_len ?? 0;
      const smilesStr = Buffer.from(smilesArr.slice(0, smilesLen)).toString('utf8');
      log('existing resultSubmission:',
        'epoch=' + (existing.epoch?.toString()),
        'targetId=' + (existing.targetId ?? existing.target_id),
        'status=' + JSON.stringify(existing.status),
        'validationCount=' + (existing.validationCount ?? existing.validation_count),
        'confirmedCount=' + (existing.confirmedCount ?? existing.confirmed_count),
        'submittedSlot=' + (existing.submittedSlot?.toString() ?? existing.submitted_slot?.toString()),
        'smilesLen=' + smilesLen,
        'smiles=' + smilesStr,
        'claimedAffinity=' + existing.claimedAffinity,
      );
    } catch (decodeErr) {
      log('WARN: could not decode existing resultSubmission:', decodeErr.message);
    }
    process.stdout.write(JSON.stringify({ status: 'already_submitted', epoch: epoch.toString() }) + '\n');
    process.exit(0);
  }

  // ── Register miner if needed ──────────────────────────────────────────────
  const minerInfo = await conn.getAccountInfo(minerAccountPda);
  log('minerAccount on-chain:', minerInfo !== null ? 'YES' : 'NO (will register)');
  if (minerInfo !== null) {
    // Log rate-limit fields from the upgraded MinerAccount
    try {
      const ma = await program.account.minerAccount.fetch(minerAccountPda);
      const submissionCount = ma.submissionCount ?? ma.submission_count ?? 0;
      const submissionEpoch = ma.submissionEpoch ?? ma.submission_epoch ?? 0;
      log('minerAccount submissionCount:', submissionCount, '| submissionEpoch:', submissionEpoch.toString(), '| currentEpoch:', epoch.toString());
      if (submissionEpoch.toString() === epoch.toString() && submissionCount >= 3) {
        log('WARN: submission rate limit reached for this epoch (count=' + submissionCount + ')');
      }
    } catch (maErr) {
      log('WARN: could not decode minerAccount details:', maErr.message);
    }
  }
  if (minerInfo === null) {
    try {
      const t = await program.methods.registerMiner()
        .accounts({
          miner: minerKp.publicKey,
          minerAccount: minerAccountPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([minerKp]).rpc();
      log('registerMiner tx:', t);
      log('registerMiner explorer: https://explorer.solana.com/tx/' + t + '?cluster=devnet');
    } catch (regErr) {
      log('ERROR registerMiner:', regErr.message);
      if (regErr.logs) { log('program logs:\n' + regErr.logs.join('\n')); }
      throw regErr;
    }
  }

  // ── Assign job if not yet assigned for this epoch ─────────────────────────
  const jobInfo = await conn.getAccountInfo(jobPda);
  log('jobAssignment on-chain:', jobInfo !== null ? 'YES' : 'NO (will assign)');
  if (jobInfo === null) {
    const [tgt] = PublicKey.findProgramAddressSync([SEED_TARGET, Buffer.from([TARGET_ID_NUM])], PROG_ID);
    log('target PDA for id', TARGET_ID_NUM, ':', tgt.toBase58());
    const tgtInfo = await conn.getAccountInfo(tgt);
    log('target PDA on-chain:', tgtInfo !== null ? `YES (${tgtInfo.data.length} bytes)` : 'NO (target not registered!)');
    try {
      const t = await program.methods.assignJob(TARGET_ID_NUM, SEQ)
        .accounts({
          crank: authKp.publicKey,
          networkConfig: networkConfigPda,
          target: tgt,
          miner: minerKp.publicKey,
          minerAccount: minerAccountPda,
          jobAssignment: jobPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        }).rpc();
      log('assignJob tx:', t);
      log('assignJob explorer: https://explorer.solana.com/tx/' + t + '?cluster=devnet');
    } catch (jobErr) {
      log('ERROR assignJob:', jobErr.message);
      if (jobErr.logs) { log('program logs:\n' + jobErr.logs.join('\n')); }
      throw jobErr;
    }
  }

  // ── Submit result ─────────────────────────────────────────────────────────
  log('submitting: smiles=' + args.smiles.substring(0, 60) + ' affinity=' + args.affinity);
  let submitTx;
  try {
    submitTx = await program.methods
      .submitResult(args.smiles, args.affinity)
      .accounts({
        miner: minerKp.publicKey,
        networkConfig: networkConfigPda,
        minerAccount: minerAccountPda,
        owner: minerKp.publicKey,
        jobAssignment: jobPda,
        resultSubmission: resultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([minerKp]).rpc();
  } catch (submitErr) {
    log('ERROR submitResult:', submitErr.message);
    if (submitErr.logs) {
      log('program logs:\n' + submitErr.logs.join('\n'));
    }
    if (submitErr.errorLogs) {
      log('errorLogs:\n' + submitErr.errorLogs.join('\n'));
    }
    if (submitErr.error) {
      log('anchor error:', JSON.stringify(submitErr.error));
    }
    throw submitErr;
  }

  log('submitResult tx:', submitTx);
  log('submitResult explorer: https://explorer.solana.com/tx/' + submitTx + '?cluster=devnet');

  // ── Confirm the transaction landed ───────────────────────────────────────
  log('waiting for confirmation...');
  try {
    const latestBlockhash = await conn.getLatestBlockhash('confirmed');
    const confirmResult = await conn.confirmTransaction(
      { signature: submitTx, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      'confirmed'
    );
    if (confirmResult.value.err) {
      log('ERROR: tx confirmed but with error:', JSON.stringify(confirmResult.value.err));
    } else {
      log('tx confirmed OK');
    }
  } catch (confirmErr) {
    log('WARN: confirmTransaction threw (tx may still have landed):', confirmErr.message);
  }

  // ── Fetch and log the full on-chain tx ───────────────────────────────────
  try {
    const txDetail = await conn.getTransaction(submitTx, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (txDetail) {
      log('tx slot:', txDetail.slot);
      log('tx fee (lamports):', txDetail.meta?.fee);
      log('tx computeUnitsConsumed:', txDetail.meta?.computeUnitsConsumed);
      if (txDetail.meta?.logMessages?.length) {
        log('program logs:\n' + txDetail.meta.logMessages.join('\n'));
      }
      if (txDetail.meta?.err) {
        log('tx meta err:', JSON.stringify(txDetail.meta.err));
      }
    } else {
      log('WARN: getTransaction returned null (not yet available at confirmed commitment)');
    }
  } catch (fetchErr) {
    log('WARN: could not fetch tx detail:', fetchErr.message);
  }

  // ── Verify resultSubmission was actually created ──────────────────────────
  const createdInfo = await conn.getAccountInfo(resultPda);
  log('resultPda after submit:', createdInfo !== null ? `EXISTS (${createdInfo.data.length} bytes)` : 'MISSING — tx did not create account!');

  process.stdout.write(JSON.stringify({ status: 'submitted', tx: submitTx, epoch: epoch.toString() }) + '\n');
  process.exit(0);
})().catch(e => {
  // Surface the full error including Anchor program logs
  log('FATAL:', e.message);
  if (e.logs) {
    log('program logs:\n' + e.logs.join('\n'));
  }
  if (e.stack) {
    log('stack:', e.stack.split('\n').slice(0, 6).join('\n'));
  }
  process.stderr.write((e?.message || String(e)) + '\n');
  process.exit(1);
});
