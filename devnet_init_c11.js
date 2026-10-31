#!/usr/bin/env node
/**
 * LIFE Compute c11 devnet initialization script.
 * Program: HhS2coMkjRc5SSPsJn4mTXcFYwWL9hz6cfAzoWKymadv
 * Steps:
 *   1. initialize (NetworkConfig + LIFE mint)
 *   2. initialize_payout_config (signers + threshold)
 *   3. register_target × 70
 * Idempotent: skips accounts that already exist.
 */

const anchor = require('@coral-xyz/anchor');
const {
  PublicKey, Connection, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────
const PROGRAM_ID  = new PublicKey('HhS2coMkjRc5SSPsJn4mTXcFYwWL9hz6cfAzoWKymadv');
const RPC_URL     = 'https://api.devnet.solana.com';
const IDL_PATH    = path.join(__dirname, 'target/idl/life_core.json');
const KEYPAIR_PATH = '/root/keys/devnet-deployer.json';

// Payout config signers (online, cold)
const ONLINE_SIGNER = new PublicKey('CizdSNWz7HMFhRMiFNkXiRXepEKV5pCcdS6YTsF9CauX');
const COLD_SIGNER   = new PublicKey('A4hNoTZ1PYdaTuHjCN65uwBgGijFZ2NZQt5ao2jiw9LP');
const THRESHOLD     = 2;

// Seeds (mirror constants.rs)
const SEED_NETWORK_CONFIG  = Buffer.from('network_config');
const SEED_LIFE_MINT       = Buffer.from('life_mint');
const SEED_PAYOUT_CONFIG   = Buffer.from('payout_config');
const SEED_TARGET          = Buffer.from('target');

// initialize() params — inert supply_cap accepted by program
const SUPPLY_CAP            = new anchor.BN(21_000_000).mul(new anchor.BN(1_000_000));
const DEVNET_EPOCH_SLOTS    = new anchor.BN(1_000);
const VALIDATORS_REQUIRED   = 2;
const VALIDATION_TOLERANCE  = 0.05;

// 70 targets from targets_table.json (in registration-ID order, 0-indexed)
const TARGETS = [
  { id:  0, uniprot: 'P00519', tier: 'medium' }, // ABL1
  { id:  1, uniprot: 'P25054', tier: 'hard'   }, // APC
  { id:  2, uniprot: 'P10275', tier: 'medium' }, // AR
  { id:  3, uniprot: 'ATM_mRNA', tier: 'mrna' }, // ATM_mRNA
  { id:  4, uniprot: 'P10415', tier: 'medium' }, // BCL2
  { id:  5, uniprot: 'BCL2_CRS', tier: 'mrna' }, // BCL2_CRISPR  (mrna slot→easy)
  { id:  6, uniprot: 'BCL2_RNA', tier: 'mrna' }, // BCL2_mRNA
  { id:  7, uniprot: 'P15056', tier: 'hard'   }, // BRAF
  { id:  8, uniprot: 'BRAF_RNA', tier: 'mrna' }, // BRAF_mRNA
  { id:  9, uniprot: 'P38398', tier: 'hard'   }, // BRCA1
  { id: 10, uniprot: 'BRC1_CRS', tier: 'mrna' }, // BRCA1_CRISPR
  { id: 11, uniprot: 'BRC2_RNA', tier: 'mrna' }, // BRCA2_mRNA
  { id: 12, uniprot: 'CCL2_RNA', tier: 'mrna' }, // CCL2_mRNA
  { id: 13, uniprot: 'CCND_RNA', tier: 'mrna' }, // CCND1_mRNA
  { id: 14, uniprot: 'P11802', tier: 'easy'   }, // CDK4
  { id: 15, uniprot: 'CDK4_CRS', tier: 'mrna' }, // CDK4_CRISPR
  { id: 16, uniprot: 'CDK4_RNA', tier: 'mrna' }, // CDK4_mRNA
  { id: 17, uniprot: 'CSF1_RNA', tier: 'mrna' }, // CSF1R_mRNA
  { id: 18, uniprot: 'CXCL_RNA', tier: 'mrna' }, // CXCL12_mRNA
  { id: 19, uniprot: 'P00533', tier: 'medium' }, // EGFR
  { id: 20, uniprot: 'EGFR_CRS', tier: 'mrna' }, // EGFR_CRISPR
  { id: 21, uniprot: 'EGFR_RNA', tier: 'mrna' }, // EGFR_mRNA
  { id: 22, uniprot: 'P03372', tier: 'medium' }, // ESR1
  { id: 23, uniprot: 'FASN_RNA', tier: 'mrna' }, // FASN_mRNA
  { id: 24, uniprot: 'P11362', tier: 'medium' }, // FGFR1
  { id: 25, uniprot: 'P36888', tier: 'hard'   }, // FLT3
  { id: 26, uniprot: 'GLU1_RNA', tier: 'mrna' }, // GLUT1_mRNA
  { id: 27, uniprot: 'Q13547', tier: 'medium' }, // HDAC1
  { id: 28, uniprot: 'Q92769', tier: 'medium' }, // HDAC2
  { id: 29, uniprot: 'P04626', tier: 'medium' }, // HER2
  { id: 30, uniprot: 'HER2_CRS', tier: 'mrna' }, // HER2_CRISPR
  { id: 31, uniprot: 'HER2_RNA', tier: 'mrna' }, // HER2_mRNA
  { id: 32, uniprot: 'HIF1_RNA', tier: 'mrna' }, // HIF1A_mRNA
  { id: 33, uniprot: 'HK2__RNA', tier: 'mrna' }, // HK2_mRNA
  { id: 34, uniprot: 'O75874', tier: 'hard'   }, // IDH1
  { id: 35, uniprot: 'IL6__RNA', tier: 'mrna' }, // IL6_mRNA
  { id: 36, uniprot: 'O60674', tier: 'medium' }, // JAK2
  { id: 37, uniprot: 'P01116', tier: 'hard'   }, // KRAS
  { id: 38, uniprot: 'KRAS_CRS', tier: 'mrna' }, // KRAS_CRISPR
  { id: 39, uniprot: 'KRAS_RNA', tier: 'mrna' }, // KRAS_mRNA
  { id: 40, uniprot: 'LDHA_RNA', tier: 'mrna' }, // LDHA_mRNA
  { id: 41, uniprot: 'Q00987', tier: 'easy'   }, // MDM2
  { id: 42, uniprot: 'MDM2_RNA', tier: 'mrna' }, // MDM2_mRNA
  { id: 43, uniprot: 'MMP9_RNA', tier: 'mrna' }, // MMP9_mRNA
  { id: 44, uniprot: 'P42345', tier: 'medium' }, // MTOR
  { id: 45, uniprot: 'P01106', tier: 'hard'   }, // MYC
  { id: 46, uniprot: 'MYC__CRS', tier: 'mrna' }, // MYC_CRISPR
  { id: 47, uniprot: 'MYC__RNA', tier: 'mrna' }, // MYC_mRNA
  { id: 48, uniprot: 'Q16288', tier: 'easy'   }, // NTRK1
  { id: 49, uniprot: 'P09874', tier: 'medium' }, // PARP1
  { id: 50, uniprot: 'PAR1_RNA', tier: 'mrna' }, // PARP1_mRNA
  { id: 51, uniprot: 'Q9NZQ7', tier: 'easy'   }, // PDL1
  { id: 52, uniprot: 'PDL1_CRS', tier: 'mrna' }, // PDL1_CRISPR
  { id: 53, uniprot: 'PDL1_RNA', tier: 'mrna' }, // PDL1_mRNA
  { id: 54, uniprot: 'P42336', tier: 'medium' }, // PIK3CA
  { id: 55, uniprot: 'PKM2_RNA', tier: 'mrna' }, // PKM2_mRNA
  { id: 56, uniprot: 'P60484', tier: 'hard'   }, // PTEN
  { id: 57, uniprot: 'RAD5_RNA', tier: 'mrna' }, // RAD51_mRNA
  { id: 58, uniprot: 'P07949', tier: 'medium' }, // RET
  { id: 59, uniprot: 'Q13485', tier: 'hard'   }, // SMAD4
  { id: 60, uniprot: 'P40763', tier: 'hard'   }, // STAT3
  { id: 61, uniprot: 'SURV_RNA', tier: 'mrna' }, // SURVIVIN_mRNA
  { id: 62, uniprot: 'TERT_CRS', tier: 'mrna' }, // TERT_CRISPR
  { id: 63, uniprot: 'TERT_RNA', tier: 'mrna' }, // TERT_mRNA
  { id: 64, uniprot: 'TGFB_RNA', tier: 'mrna' }, // TGFb1_mRNA
  { id: 65, uniprot: 'TNF__RNA', tier: 'mrna' }, // TNF_mRNA
  { id: 66, uniprot: 'P04637', tier: 'hard'   }, // TP53
  { id: 67, uniprot: 'TP53_CRS', tier: 'mrna' }, // TP53_CRISPR
  { id: 68, uniprot: 'P35968', tier: 'medium' }, // VEGFR2
  { id: 69, uniprot: 'VEGF_RNA', tier: 'mrna' }, // VEGF_mRNA
];

function uniprotBytes(s) {
  const buf = Buffer.alloc(10, 0);
  Buffer.from(s.slice(0, 10), 'utf8').copy(buf, 0);
  return Array.from(buf);
}

function difficultyArg(tier) {
  if (tier === 'easy')   return { easy: {} };
  if (tier === 'hard')   return { hard: {} };
  if (tier === 'mrna' || tier === 'crispr') return { easy: {} }; // mRNA/CRISPR map to Easy on-chain
  return { medium: {} };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll-based confirmation (no WebSocket subscriptions to avoid pubsub rate limits)
async function sendAndConfirmPoll(connection, tx, signers, label) {
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
  // Poll getSignatureStatus (HTTP, no WS) until confirmed or timeout
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (value?.err) throw new Error(`${label} failed: ${JSON.stringify(value.err)}`);
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
      return sig;
    }
  }
  throw new Error(`${label} confirmation timed out for ${sig}`);
}

async function withRetry(fn, label, retries = 8) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      const delay = 4000 * Math.pow(1.5, i);
      console.error(`  [retry ${i+1}/${retries-1}] ${label}: ${e.message?.slice(0, 80)} — wait ${(delay/1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }
}

async function main() {
  const kp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8')))
  );
  console.log('Authority (deployer):', kp.publicKey.toBase58());

  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed', skipPreflight: false });

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);

  // ── Derive PDAs ─────────────────────────────────────────────────────────────
  const [networkConfigPda] = PublicKey.findProgramAddressSync([SEED_NETWORK_CONFIG], PROGRAM_ID);
  const [lifeMintPda]      = PublicKey.findProgramAddressSync([SEED_LIFE_MINT], PROGRAM_ID);
  const [mintAuthPda]      = PublicKey.findProgramAddressSync([SEED_LIFE_MINT, Buffer.from('authority')], PROGRAM_ID);
  const [payoutConfigPda]  = PublicKey.findProgramAddressSync([SEED_PAYOUT_CONFIG], PROGRAM_ID);

  console.log('NetworkConfig PDA:', networkConfigPda.toBase58());
  console.log('LIFE Mint PDA:    ', lifeMintPda.toBase58());
  console.log('Mint Authority PDA:', mintAuthPda.toBase58());
  console.log('PayoutConfig PDA: ', payoutConfigPda.toBase58());

  const results = {
    programId: PROGRAM_ID.toBase58(),
    networkConfigPda: networkConfigPda.toBase58(),
    lifeMintPda: lifeMintPda.toBase58(),
    mintAuthPda: mintAuthPda.toBase58(),
    payoutConfigPda: payoutConfigPda.toBase58(),
    initTx: null,
    payoutConfigTx: null,
    targetTxs: [],
  };

  // ── Step 1: initialize ──────────────────────────────────────────────────────
  const existingNC = await connection.getAccountInfo(networkConfigPda);
  if (existingNC) {
    console.log('\n✓ NetworkConfig already exists — skipping initialize.');
  } else {
    console.log('\nCalling initialize...');
    const tx = await withRetry(() => program.methods
      .initialize(
        SUPPLY_CAP,
        DEVNET_EPOCH_SLOTS,
        VALIDATORS_REQUIRED,
        VALIDATION_TOLERANCE,
        [kp.publicKey],
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
      .rpc(), 'initialize');
    await connection.confirmTransaction(tx, 'confirmed');
    results.initTx = tx;
    console.log('initialize tx:', tx);
    console.log('Explorer: https://explorer.solana.com/tx/' + tx + '?cluster=devnet');
  }

  // Verify mint
  const mintInfo = await connection.getAccountInfo(lifeMintPda);
  if (!mintInfo) throw new Error('LIFE mint PDA not found after initialize!');
  console.log('\n✓ LIFE mint exists at:', lifeMintPda.toBase58());

  // ── Step 2: initialize_payout_config ───────────────────────────────────────
  const existingPC = await connection.getAccountInfo(payoutConfigPda);
  if (existingPC) {
    console.log('✓ PayoutConfig already exists — skipping.');
  } else {
    console.log('\nCalling initialize_payout_config...');
    const tx = await withRetry(() => program.methods
      .initializePayoutConfig(
        [ONLINE_SIGNER, COLD_SIGNER],
        THRESHOLD,
      )
      .accounts({
        authority: kp.publicKey,
        networkConfig: networkConfigPda,
        payoutConfig: payoutConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([kp])
      .rpc(), 'initialize_payout_config');
    await connection.confirmTransaction(tx, 'confirmed');
    results.payoutConfigTx = tx;
    console.log('initialize_payout_config tx:', tx);
    console.log('Explorer: https://explorer.solana.com/tx/' + tx + '?cluster=devnet');
  }

  // ── Step 3: register_target × 70 ───────────────────────────────────────────
  console.log('\nRegistering 70 targets (idempotent, HTTP polling confirmation)...');
  let registered = 0, skipped = 0;
  for (const t of TARGETS) {
    const [targetPda] = PublicKey.findProgramAddressSync(
      [SEED_TARGET, Buffer.from(new Uint16Array([t.id]).buffer)],
      PROGRAM_ID
    );
    const existing = await connection.getAccountInfo(targetPda);
    if (existing) {
      skipped++;
      continue;
    }
    const tx = await program.methods
      .registerTarget(
        t.id,
        uniprotBytes(t.uniprot),
        difficultyArg(t.tier),
      )
      .accounts({
        authority: kp.publicKey,
        networkConfig: networkConfigPda,
        target: targetPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    const sig = await withRetry(
      () => sendAndConfirmPoll(connection, tx, [kp], `register_target(${t.id})`),
      `register_target(${t.id})`
    );
    results.targetTxs.push({ id: t.id, tx: sig });
    registered++;
    if (registered % 10 === 0) console.log(`  Registered ${registered} targets...`);
    await sleep(2500); // rate-limit: public devnet — slower to avoid connection limit
  }
  console.log(`✓ Targets: ${registered} registered, ${skipped} already existed.`);

  // ── Print summary ────────────────────────────────────────────────────────────
  console.log('\n════ INIT COMPLETE ════');
  console.log(JSON.stringify(results, null, 2));
  return results;
}

main().catch(e => {
  console.error(e);
  if (e.logs) console.error('Program logs:\n' + e.logs.join('\n'));
  process.exit(1);
});
