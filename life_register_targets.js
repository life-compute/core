/**
 * LIFE Compute — register all cancer protein targets 0-29
 *
 * Usage: node life_register_targets.js '<json-args>'
 * JSON args: { rpc, authKeypair, idlPath, programId, startId, endId }
 *
 * Skips targets whose PDA already exists.
 * stdout: JSON array of { targetId, gene, status, tx, explorer }
 */
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');

function log(...args) {
  process.stderr.write('[life_reg] ' + args.join(' ') + '\n');
}

// Target definitions matching TARGET_ID_MAP in miner_daemon.py
const TARGETS = [
  { id: 0,  gene: 'TP53',   uniprot: 'P04637', difficulty: { hard: {} } },
  { id: 1,  gene: 'BRCA1',  uniprot: 'P38398', difficulty: { hard: {} } },
  { id: 2,  gene: 'EGFR',   uniprot: 'P00533', difficulty: { medium: {} } },
  { id: 3,  gene: 'HER2',   uniprot: 'P04626', difficulty: { medium: {} } },
  { id: 4,  gene: 'KRAS',   uniprot: 'P01116', difficulty: { hard: {} } },
  { id: 5,  gene: 'BCL2',   uniprot: 'P10415', difficulty: { medium: {} } },
  { id: 6,  gene: 'CDK4',   uniprot: 'P11802', difficulty: { medium: {} } },
  { id: 7,  gene: 'VEGFR2', uniprot: 'P35968', difficulty: { medium: {} } },
  { id: 8,  gene: 'PDL1',   uniprot: 'Q9NZQ7', difficulty: { easy: {} } },
  { id: 9,  gene: 'MDM2',   uniprot: 'Q00987', difficulty: { medium: {} } },
  { id: 10, gene: 'BRAF',   uniprot: 'P15056', difficulty: { medium: {} } },
  { id: 11, gene: 'PTEN',   uniprot: 'P60484', difficulty: { hard: {} } },
  { id: 12, gene: 'MYC',    uniprot: 'P01106', difficulty: { hard: {} } },
  { id: 13, gene: 'STAT3',  uniprot: 'P40763', difficulty: { medium: {} } },
  { id: 14, gene: 'PIK3CA', uniprot: 'P42336', difficulty: { medium: {} } },
  { id: 15, gene: 'MTOR',   uniprot: 'P42345', difficulty: { medium: {} } },
  { id: 16, gene: 'FGFR1',  uniprot: 'P11362', difficulty: { medium: {} } },
  { id: 17, gene: 'RET',    uniprot: 'P07949', difficulty: { medium: {} } },
  { id: 18, gene: 'AR',     uniprot: 'P10275', difficulty: { medium: {} } },
  { id: 19, gene: 'NTRK1',  uniprot: 'Q16288', difficulty: { medium: {} } },
  { id: 20, gene: 'IDH1',   uniprot: 'O75874', difficulty: { medium: {} } },
  { id: 21, gene: 'FLT3',   uniprot: 'P36888', difficulty: { medium: {} } },
  { id: 22, gene: 'SMAD4',  uniprot: 'Q13485', difficulty: { medium: {} } },
  { id: 23, gene: 'APC',    uniprot: 'P25054', difficulty: { hard: {} } },
  { id: 24, gene: 'PARP1',  uniprot: 'P09874', difficulty: { medium: {} } },
  { id: 25, gene: 'JAK2',   uniprot: 'O60674', difficulty: { medium: {} } },
  { id: 26, gene: 'ESR1',   uniprot: 'P03372', difficulty: { medium: {} } },
  { id: 27, gene: 'HDAC1',  uniprot: 'Q13547', difficulty: { medium: {} } },
  { id: 28, gene: 'HDAC2',  uniprot: 'Q92769', difficulty: { medium: {} } },
  { id: 29, gene: 'ABL1',   uniprot: 'P00519', difficulty: { hard: {} } },
];

function uniprotBytes(s) {
  // Null-pad to 10 bytes
  const buf = Buffer.alloc(10, 0);
  Buffer.from(s, 'utf8').copy(buf, 0);
  return Array.from(buf);
}

(async () => {
  const args = JSON.parse(process.argv[2]);
  const startId = args.startId ?? 0;
  const endId   = args.endId   ?? 29;

  log('rpc:', args.rpc);
  log('programId:', args.programId);
  log(`registering targets ${startId}–${endId}`);

  const conn = new Connection(args.rpc, 'confirmed');
  const authKp = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(args.authKeypair))));
  log('authority:', authKp.publicKey.toBase58());

  const wallet   = new anchor.Wallet(authKp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl    = JSON.parse(fs.readFileSync(args.idlPath));
  idl.address  = args.programId;
  const program = new anchor.Program(idl, provider);
  const PROG_ID = new PublicKey(args.programId);

  const SEED_NETWORK_CONFIG = Buffer.from('network_config');
  const SEED_TARGET         = Buffer.from('target');

  const [networkConfigPda] = PublicKey.findProgramAddressSync([SEED_NETWORK_CONFIG], PROG_ID);

  const results = [];
  const targets = TARGETS.filter(t => t.id >= startId && t.id <= endId);

  for (const tgt of targets) {
    const targetId = tgt.id;
    const [targetPda] = PublicKey.findProgramAddressSync([SEED_TARGET, Buffer.from([targetId])], PROG_ID);

    // Check if already exists
    const existing = await conn.getAccountInfo(targetPda);
    if (existing !== null) {
      log(`target ${targetId} (${tgt.gene}) already registered at ${targetPda.toBase58()} — skipping`);
      results.push({ targetId, gene: tgt.gene, status: 'already_exists', pda: targetPda.toBase58() });
      continue;
    }

    log(`registering target ${targetId} (${tgt.gene}, ${tgt.uniprot})...`);
    try {
      const uniprotArr = uniprotBytes(tgt.uniprot);
      const tx = await program.methods
        .registerTarget(targetId, uniprotArr, tgt.difficulty)
        .accounts({
          authority: authKp.publicKey,
          networkConfig: networkConfigPda,
          target: targetPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authKp])
        .rpc();

      const explorer = `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
      log(`  ✓ tx: ${tx}`);
      log(`  ✓ explorer: ${explorer}`);
      results.push({ targetId, gene: tgt.gene, status: 'registered', pda: targetPda.toBase58(), tx, explorer });
    } catch (err) {
      log(`  ✗ ERROR for target ${targetId} (${tgt.gene}): ${err.message}`);
      if (err.logs) log('  logs:\n' + err.logs.join('\n'));
      results.push({ targetId, gene: tgt.gene, status: 'error', error: err.message });
    }

    // Small delay to avoid rate-limit / nonce issues
    await new Promise(r => setTimeout(r, 1500));
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
})().catch(e => {
  process.stderr.write('FATAL: ' + e.message + '\n');
  if (e.stack) process.stderr.write(e.stack + '\n');
  process.exit(1);
});
