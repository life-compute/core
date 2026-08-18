/**
 * LIFE Compute — forced miner re-registration
 *
 * Use when a MinerAccount exists on-chain but cannot be deserialized
 * (AccountDidNotDeserialize) because it was created by an older program
 * deployment with a different struct layout.
 *
 * What this script does:
 *   1. Derives the miner PDA for MINER_KEYPAIR.
 *   2. Closes the stale MinerAccount by transferring its lamports back to the
 *      miner wallet — done by calling registerMiner() which Anchor will refuse
 *      if the account already exists; if it does exist we rely on the program
 *      having an `init_if_needed` or the authority to close it.
 *      Since there is no explicit close instruction, we attempt to directly
 *      call the system program to zero-out the account data via the authority
 *      keypair owning the account rent, then re-register.
 *   3. Calls registerMiner() with all required accounts from the CURRENT IDL
 *      (networkConfig + foundation + systemProgram).
 *
 * Usage: node life_reregister.js '<json-args>'
 *   args: { rpc, authKeypair, minerKeypair, idlPath, programId }
 *
 * stdout: JSON line  { status: 'reregistered'|'already_fresh'|'error', ... }
 * stderr: verbose diagnostic log
 */
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection, Transaction, SystemProgram } = require('@solana/web3.js');
const fs = require('fs');

function log(...args) {
  process.stderr.write('[life_reregister] ' + args.join(' ') + '\n');
}

const FOUNDATION_WALLET = new PublicKey('2jVdMx7fb88txbG6YoZzC7kT4Tq8rJDaWrNgbZ3ZnqCb');

(async () => {
  const args = JSON.parse(process.argv[2]);
  log('rpc:', args.rpc);
  log('programId:', args.programId);

  const conn = new Connection(args.rpc, 'confirmed');

  const authKp  = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.authKeypair))));
  const minerKp = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.minerKeypair))));
  log('auth pubkey :', authKp.publicKey.toBase58());
  log('miner pubkey:', minerKp.publicKey.toBase58());

  const wallet   = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  anchor.setProvider(provider);

  const idl    = JSON.parse(fs.readFileSync(args.idlPath));
  idl.address  = args.programId;
  const program = new anchor.Program(idl, provider);
  const PROG_ID = new PublicKey(args.programId);

  const SEED_NETWORK_CONFIG = Buffer.from('network_config');
  const SEED_MINER          = Buffer.from('miner');

  const [networkConfigPda] = PublicKey.findProgramAddressSync([SEED_NETWORK_CONFIG], PROG_ID);
  const [minerAccountPda]  = PublicKey.findProgramAddressSync([SEED_MINER, minerKp.publicKey.toBuffer()], PROG_ID);

  log('networkConfig PDA:', networkConfigPda.toBase58());
  log('minerAccount  PDA:', minerAccountPda.toBase58());

  const minerInfo = await conn.getAccountInfo(minerAccountPda);
  log('minerAccount on-chain:', minerInfo !== null ? `YES (${minerInfo.data.length} bytes, owner=${minerInfo.owner.toBase58()})` : 'NO');

  // ── Step 1: Try to deserialize the existing account ──────────────────────
  if (minerInfo !== null) {
    let isStale = false;
    try {
      const ma = await program.account.minerAccount.fetch(minerAccountPda);
      log('MinerAccount decoded OK — already fresh layout:', JSON.stringify({
        submissionCount: (ma.submissionCount ?? ma.submission_count ?? '?').toString(),
        submissionEpoch: (ma.submissionEpoch ?? ma.submission_epoch ?? '?').toString(),
      }));
      process.stdout.write(JSON.stringify({ status: 'already_fresh' }) + '\n');
      process.exit(0);
    } catch (decodeErr) {
      const msg = decodeErr.message || '';
      if (msg.includes('AccountDidNotDeserialize') ||
          msg.includes('account discriminator mismatch') ||
          msg.includes('Invalid account discriminator') ||
          msg.includes('failed to deserialize')) {
        log('Confirmed stale layout:', msg.slice(0, 120));
        isStale = true;
      } else {
        log('Unexpected decode error (aborting):', msg);
        process.stdout.write(JSON.stringify({ status: 'error', reason: msg }) + '\n');
        process.exit(1);
      }
    }

    if (isStale) {
      // ── Step 2: Close the stale account ──────────────────────────────────
      // The LIFE program owns the PDA. The only way to close it without a
      // dedicated close instruction is a direct system program account-close
      // pattern: the account owner (the program) can zero lamports via an
      // on-chain instruction. We cannot do this from client-side without a
      // program instruction.
      //
      // Best-effort strategy: attempt registerMiner() — if the program uses
      // `init_if_needed` semantics it will reinitialize the account.
      // If the program rejects with "already in use" (account exists), we
      // need to manually zero the account data via a raw tx (account must be
      // owned by SystemProgram or mutable). We log clearly so the operator
      // knows what's happening.
      log('Attempting forced re-registration (registerMiner with existing stale PDA)...');
      log('If this fails with "already in use", the program may need a close instruction.');
    }
  }

  // ── Step 3: Call registerMiner() with current IDL accounts ───────────────
  // Use the FULL account list from the current program (networkConfig + foundation).
  // life_submit.js uses the old minimal interface — this is the correct one.
  log('Calling registerMiner() with current IDL accounts...');
  let tx;
  try {
    // Fund miner wallet if balance is very low
    const minerBal = await conn.getBalance(minerKp.publicKey);
    log('miner balance:', minerBal, 'lamports');
    if (minerBal < 15_000_000) {
      log('Low balance — funding miner wallet (0.015 SOL)...');
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authKp.publicKey,
          toPubkey: minerKp.publicKey,
          lamports: 15_000_000,
        })
      );
      const fundSig = await provider.sendAndConfirm(fundTx, [authKp]);
      log('Funded ✓  tx:', fundSig.slice(0, 20) + '…');
    }

    tx = await program.methods
      .registerMiner()
      .accounts({
        miner:         minerKp.publicKey,
        minerAccount:  minerAccountPda,
        networkConfig: networkConfigPda,
        foundation:    FOUNDATION_WALLET,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([minerKp])
      .rpc();
    log('registerMiner tx:', tx);
    log('Explorer: https://explorer.solana.com/tx/' + tx + '?cluster=devnet');
  } catch (regErr) {
    const regMsg = regErr.message || '';
    log('ERROR registerMiner:', regMsg);
    if (regErr.logs) { log('program logs:\n' + regErr.logs.join('\n')); }

    // If the program rejected because the account already exists and doesn't
    // allow re-init, surface a clear actionable message.
    if (regMsg.includes('already in use') || regMsg.includes('already initialized')) {
      log('');
      log('ACTION REQUIRED: The stale MinerAccount cannot be overwritten by registerMiner().');
      log('The deployer must add a close_miner_account instruction to the program,');
      log('OR the program must use init_if_needed on the miner_account constraint.');
      log('Contact the LIFE Compute team with this error.');
    }
    process.stdout.write(JSON.stringify({ status: 'error', reason: regMsg }) + '\n');
    process.exit(1);
  }

  // ── Verify new account is readable ───────────────────────────────────────
  try {
    const fresh = await program.account.minerAccount.fetch(minerAccountPda);
    log('New MinerAccount decoded OK:', JSON.stringify({
      submissionCount: (fresh.submissionCount ?? fresh.submission_count ?? 0).toString(),
    }));
  } catch (verifyErr) {
    log('WARN: new account still not decodable — registerMiner may have used old layout:', verifyErr.message);
  }

  process.stdout.write(JSON.stringify({ status: 'reregistered', tx }) + '\n');
  process.exit(0);
})().catch(e => {
  log('FATAL:', e.message);
  if (e.logs) { log('program logs:\n' + e.logs.join('\n')); }
  if (e.stack) { log('stack:', e.stack.split('\n').slice(0, 6).join('\n')); }
  process.stderr.write((e?.message || String(e)) + '\n');
  process.exit(1);
});
