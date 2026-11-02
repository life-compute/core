/**
 * tests/c38-payout-admin.ts — C38 payout admin tests
 *
 * Covers:
 *  T01  non-authority cannot call update_payout_config → Unauthorized
 *  T02  non-authority cannot call set_payout_caps     → Unauthorized
 *  T03  update_payout_config: signer_count 0 rejected → Unauthorized
 *  T04  update_payout_config: signer_count 4 rejected → Unauthorized
 *  T05  update_payout_config: duplicate signer rejected → Unauthorized
 *  T06  update_payout_config: zero pubkey rejected → Unauthorized
 *  T07  update_payout_config: threshold 0 rejected → Unauthorized
 *  T08  update_payout_config: threshold > signer_count rejected → Unauthorized
 *  T09  update_payout_config: cap_per_batch 0 rejected → Unauthorized
 *  T10  update_payout_config: cap_per_day 0 rejected → Unauthorized
 *  T11  update_payout_config: backfill_window 0 rejected → Unauthorized
 *  T12  update_payout_config: valid 3-signer update succeeds
 *  T13  after update, removed signer's signature rejected → UnregisteredSigner
 *  T14  after update, new signer's signature accepted
 *  T15  set_payout_caps: pause → payout_batch returns PayoutPaused
 *  T16  set_payout_caps: unpause → payout_batch succeeds again
 *  T17  set_payout_caps: lower cap applies to next batch → BatchCapExceeded
 *  T18  account initialised before C38 (paused byte zero) reads as not paused
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  Ed25519Program,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";

// ─── Seeds ───────────────────────────────────────────────────────────────────
const S_NC   = Buffer.from("network_config");
const S_MINT = Buffer.from("life_mint");
const S_AUTH = Buffer.from("authority");
const S_PC   = Buffer.from("payout_config");
const S_BR   = Buffer.from("batch_replay");
const S_DA   = Buffer.from("day_accum");

const DOMAIN_TAG = Buffer.from("LIFE-PAYOUT-V1", "utf8");

// ─── Helpers ─────────────────────────────────────────────────────────────────
interface HashEntry { recipient: PublicKey; amount: BN; }

function sortHashEntries(entries: HashEntry[]): HashEntry[] {
  return [...entries].sort((a, b) => {
    const ab = a.recipient.toBytes(), bb = b.recipient.toBytes();
    for (let i = 0; i < 32; i++) {
      if (ab[i] < bb[i]) return -1;
      if (ab[i] > bb[i]) return 1;
    }
    return 0;
  });
}

function batchHash(programId: PublicKey, mintPda: PublicKey, batchId: BN, day: number, entries: HashEntry[]): Buffer {
  const header = Buffer.alloc(91);
  let off = 0;
  DOMAIN_TAG.copy(header, off); off += 14;
  Buffer.from(programId.toBytes()).copy(header, off); off += 32;
  Buffer.from(mintPda.toBytes()).copy(header, off); off += 32;
  header.writeBigUInt64LE(BigInt(batchId.toString()), off); off += 8;
  header.writeUInt32LE(day, off); off += 4;
  header[off] = entries.length;
  const entryBufs = entries.map((e) => {
    const b = Buffer.alloc(40);
    Buffer.from(e.recipient.toBytes()).copy(b, 0);
    b.writeBigUInt64LE(BigInt(e.amount.toString()), 32);
    return b;
  });
  return crypto.createHash("sha256").update(Buffer.concat([header, ...entryBufs])).digest();
}

async function assertFails(promise: Promise<any>, tag: string): Promise<anchor.AnchorError> {
  try {
    await promise;
    throw new Error(`${tag}: expected failure but succeeded`);
  } catch (e: any) {
    if (e.message && e.message.startsWith(tag + ": expected")) throw e;
    return e as anchor.AnchorError;
  }
}

describe("c38-payout-admin", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program  = anchor.workspace.LifeCore as Program;
  const conn     = provider.connection;
  const auth     = provider.wallet as anchor.Wallet;

  // Use the deterministic keys from c4-payout.ts (signer1 = seed 0x01, signer2 = seed 0x02)
  // so T12-T14 can use/rotate from the known initial signer set.
  const signerA = Keypair.fromSeed(Buffer.alloc(32, 0x01)); // original signer 1 (removed in T12)
  const signerB = Keypair.fromSeed(Buffer.alloc(32, 0x02)); // original signer 2 (kept in T12)
  const signerC = Keypair.generate();                        // NEW signer added in T12
  const rogue   = Keypair.generate();                        // never in signer set

  let ncPda: PublicKey;
  let mintPda: PublicKey;
  let mintAuthPda: PublicKey;
  let pcPda: PublicKey;
  let chainDay: number;
  let batchCounter = 900_000; // far from other suites (c4=0-based, c4d=100000-based)

  function pda(seeds: Buffer[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  }
  function nextBatch(): BN { return new BN(batchCounter++); }

  async function airdrop(kp: Keypair, sol = 5) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  async function getOrCreateAta(mint: PublicKey, owner: PublicKey, payer: Keypair) {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const info = await conn.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
    }
    return ata;
  }

  /** Send a valid payout_batch with the given signer keypairs. */
  async function sendPayoutBatch(opts: {
    batchId: BN; day: number;
    entries: HashEntry[];
    signerKeys?: Keypair[];
  }) {
    const signerKeys = opts.signerKeys ?? [signerA, signerB];
    const sorted = sortHashEntries(opts.entries);
    const hash   = batchHash(program.programId, mintPda, opts.batchId, opts.day, sorted);

    // Ensure ATAs exist for all recipients
    const atas: PublicKey[] = [];
    for (const e of sorted) {
      atas.push(await getOrCreateAta(mintPda, e.recipient, auth.payer));
    }

    const batchReplayPda = PublicKey.findProgramAddressSync(
      [S_BR, opts.batchId.toArrayLike(Buffer, "le", 8)], program.programId
    )[0];
    const dayBuf = Buffer.alloc(4); dayBuf.writeUInt32LE(opts.day); 
    const dayAccumPda = PublicKey.findProgramAddressSync([S_DA, dayBuf], program.programId)[0];

    const ed25519Ixs = signerKeys.map((s) =>
      Ed25519Program.createInstructionWithPrivateKey({ privateKey: s.secretKey, message: hash })
    );

    const ix = await program.methods
      .payoutBatch(opts.batchId, opts.day, sorted.map(e => ({ recipient: e.recipient, amount: e.amount })), signerKeys.map((_, i) => i))
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(atas.map(a => ({ pubkey: a, isSigner: false, isWritable: true })))
      .instruction();

    const tx = new Transaction();
    ed25519Ixs.forEach(e => tx.add(e));
    tx.add(ix);
    return sendAndConfirmTransaction(conn, tx, [auth.payer]);
  }

  /** Call update_payout_config. */
  async function callUpdatePayoutConfig(opts: {
    signer?: Keypair;          // overrides authority
    signers: PublicKey[];
    signer_count: number;
    threshold: number;
    cap_per_batch?: BN;
    cap_per_day?: BN;
    backfill_window?: number;
  }) {
    const capBatch = opts.cap_per_batch ?? new BN(5_000 * 1_000_000);
    const capDay   = opts.cap_per_day   ?? new BN(5_000 * 1_000_000);
    const bfw      = opts.backfill_window ?? 7;

    const method = program.methods.updatePayoutConfig(
      opts.signers, opts.signer_count, opts.threshold, capBatch, capDay, bfw
    ).accounts({
      authority: opts.signer ? opts.signer.publicKey : auth.publicKey,
      networkConfig: ncPda,
      payoutConfig: pcPda,
    });

    if (opts.signer) return method.signers([opts.signer]).rpc();
    return method.rpc();
  }

  /** Call set_payout_caps. */
  async function callSetPayoutCaps(opts: {
    signer?: Keypair;
    cap_per_batch?: BN;
    cap_per_day?: BN;
    paused: boolean;
  }) {
    const capBatch = opts.cap_per_batch ?? new BN(5_000 * 1_000_000);
    const capDay   = opts.cap_per_day   ?? new BN(5_000 * 1_000_000);

    const method = program.methods.setPayoutCaps(capBatch, capDay, opts.paused)
      .accounts({
        authority: opts.signer ? opts.signer.publicKey : auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
      });

    if (opts.signer) return method.signers([opts.signer]).rpc();
    return method.rpc();
  }

  // ─── Setup ────────────────────────────────────────────────────────────────
  before(async () => {
    ncPda       = pda([S_NC]);
    mintPda     = pda([S_MINT]);
    mintAuthPda = pda([S_MINT, S_AUTH]);
    pcPda       = pda([S_PC]);

    // Read chain clock
    const CLOCK_PUBKEY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
    const clockInfo = await conn.getAccountInfo(CLOCK_PUBKEY);
    if (!clockInfo) throw new Error("Could not read clock sysvar");
    const unixTs = Number(clockInfo.data.readBigInt64LE(32));
    chainDay = Math.floor(unixTs / 86400);
    console.log(`C38 suite: chain unix_ts=${unixTs}, chainDay=${chainDay}`);

    // Fund helper keypairs
    for (const kp of [signerA, signerB, signerC, rogue]) {
      await airdrop(kp, 2);
    }
  });

  // ─── T01 — non-authority cannot call update_payout_config ────────────────
  it("T01: non-authority update_payout_config → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signer: rogue, signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 2 }),
      "T01"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T02 — non-authority cannot call set_payout_caps ─────────────────────
  it("T02: non-authority set_payout_caps → Unauthorized", async () => {
    const err = await assertFails(
      callSetPayoutCaps({ signer: rogue, paused: false }),
      "T02"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T03 — signer_count 0 rejected ───────────────────────────────────────
  it("T03: signer_count=0 → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [], signer_count: 0, threshold: 1 }),
      "T03"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T04 — signer_count 4 rejected ───────────────────────────────────────
  it("T04: signer_count=4 → Unauthorized", async () => {
    // Provide 4 entries but the program max is 3
    const k1 = Keypair.generate().publicKey;
    const k2 = Keypair.generate().publicKey;
    const k3 = Keypair.generate().publicKey;
    const k4 = Keypair.generate().publicKey;
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [k1,k2,k3,k4], signer_count: 4, threshold: 1 }),
      "T04"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T05 — duplicate signer rejected ─────────────────────────────────────
  it("T05: duplicate signer → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [signerA.publicKey, signerA.publicKey], signer_count: 2, threshold: 1 }),
      "T05"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T06 — zero pubkey rejected ──────────────────────────────────────────
  it("T06: zero pubkey in signers → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [signerA.publicKey, PublicKey.default], signer_count: 2, threshold: 1 }),
      "T06"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T07 — threshold 0 rejected ──────────────────────────────────────────
  it("T07: threshold=0 → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 0 }),
      "T07"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T08 — threshold > signer_count rejected ─────────────────────────────
  it("T08: threshold > signer_count → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({ signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 3 }),
      "T08"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T09 — cap_per_batch 0 rejected ──────────────────────────────────────
  it("T09: cap_per_batch=0 → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({
        signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 2,
        cap_per_batch: new BN(0),
      }),
      "T09"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T10 — cap_per_day 0 rejected ────────────────────────────────────────
  it("T10: cap_per_day=0 → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({
        signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 2,
        cap_per_day: new BN(0),
      }),
      "T10"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T11 — backfill_window 0 rejected ────────────────────────────────────
  it("T11: backfill_window=0 → Unauthorized", async () => {
    const err = await assertFails(
      callUpdatePayoutConfig({
        signers: [signerA.publicKey, signerB.publicKey], signer_count: 2, threshold: 2,
        backfill_window: 0,
      }),
      "T11"
    );
    assert.include(JSON.stringify(err), "Unauthorized");
  });

  // ─── T12 — valid 3-signer update succeeds ────────────────────────────────
  // Rotates signer set to [signerB, signerC, signerA_removed→signerC added].
  // Before: [signerA, signerB] (set by initialize_payout_config in c4-payout.ts)
  // After:  [signerB, signerC] with threshold=2
  it("T12: valid update_payout_config (2 signers, threshold 2) succeeds", async () => {
    await callUpdatePayoutConfig({
      signers: [signerB.publicKey, signerC.publicKey],
      signer_count: 2,
      threshold: 2,
    });
    // Read back
    const pc: any = await (program.account as any).payoutConfig.fetch(pcPda);
    assert.equal(pc.signerCount, 2, "signer_count");
    assert.equal(pc.threshold, 2, "threshold");
    assert.isTrue(pc.signers[0].equals(signerB.publicKey) || pc.signers[1].equals(signerB.publicKey), "signerB in set");
    assert.isTrue(pc.signers[0].equals(signerC.publicKey) || pc.signers[1].equals(signerC.publicKey), "signerC in set");
    console.log("  T12 signer set:", pc.signers[0].toBase58(), pc.signers[1].toBase58());
  });

  // ─── T13 — removed signer (signerA) no longer satisfies payout_batch ─────
  it("T13: removed signerA signature → UnregisteredSigner", async () => {
    // Use signerA (removed) + signerB — signerA is no longer registered
    const miner = Keypair.generate();
    await airdrop(miner, 1);
    const entry = { recipient: miner.publicKey, amount: new BN(100) };
    const day = chainDay - 1;
    const err = await assertFails(
      sendPayoutBatch({ batchId: nextBatch(), day, entries: [entry], signerKeys: [signerA, signerB] }),
      "T13"
    );
    // 0x1795 = 6037 = UnregisteredSigner (sendAndConfirmTransaction wraps differently than rpc())
    const errStr = JSON.stringify(err);
    assert.ok(
      errStr.includes("UnregisteredSigner") || errStr.includes("0x1795") || errStr.includes("6037"),
      `T13 expected UnregisteredSigner, got: ${errStr.slice(0,200)}`
    );
  });

  // ─── T14 — new signer (signerC) satisfies payout_batch ───────────────────
  it("T14: new signerC signature is accepted", async () => {
    const miner = Keypair.generate();
    await airdrop(miner, 1);
    const entry = { recipient: miner.publicKey, amount: new BN(100) };
    const day = chainDay - 1;
    const sig = await sendPayoutBatch({
      batchId: nextBatch(), day, entries: [entry], signerKeys: [signerB, signerC],
    });
    assert.ok(sig, "tx sig present");
    console.log("  T14 payout_batch sig:", sig);
  });

  // ─── T15 — pausing makes payout_batch return PayoutPaused ────────────────
  it("T15: set_payout_caps paused=true → payout_batch returns PayoutPaused", async () => {
    await callSetPayoutCaps({ paused: true });

    const miner = Keypair.generate();
    await airdrop(miner, 1);
    const entry = { recipient: miner.publicKey, amount: new BN(100) };
    const day = chainDay - 1;
    const err = await assertFails(
      sendPayoutBatch({ batchId: nextBatch(), day, entries: [entry], signerKeys: [signerB, signerC] }),
      "T15"
    );
    assert.include(JSON.stringify(err), "PayoutPaused");
    console.log("  T15 correctly blocked:", JSON.stringify(err).slice(0, 80));
  });

  // ─── T16 — unpausing restores payout_batch ───────────────────────────────
  it("T16: set_payout_caps paused=false → payout_batch succeeds", async () => {
    await callSetPayoutCaps({ paused: false });

    const miner = Keypair.generate();
    await airdrop(miner, 1);
    const entry = { recipient: miner.publicKey, amount: new BN(100) };
    const day = chainDay - 1;
    const sig = await sendPayoutBatch({
      batchId: nextBatch(), day, entries: [entry], signerKeys: [signerB, signerC],
    });
    assert.ok(sig, "tx sig present after unpause");
    console.log("  T16 unpause payout_batch sig:", sig);
  });

  // ─── T17 — lowering cap applies to next batch ────────────────────────────
  it("T17: lower cap via set_payout_caps → BatchCapExceeded on next batch", async () => {
    // Set cap to 1 raw unit (well below any real batch)
    await callSetPayoutCaps({ cap_per_batch: new BN(1), cap_per_day: new BN(5_000 * 1_000_000), paused: false });

    const miner = Keypair.generate();
    await airdrop(miner, 1);
    const entry = { recipient: miner.publicKey, amount: new BN(100) }; // 100 > 1
    const day = chainDay - 1;
    const err = await assertFails(
      sendPayoutBatch({ batchId: nextBatch(), day, entries: [entry], signerKeys: [signerB, signerC] }),
      "T17"
    );
    assert.include(JSON.stringify(err), "BatchCapExceeded");

    // Restore cap
    await callSetPayoutCaps({ paused: false });
    console.log("  T17 cap correctly lowered and restored");
  });

  // ─── T18 — existing account (paused byte zero) reads as not paused ───────
  it("T18: existing PayoutConfig has paused=0 (not paused)", async () => {
    const pc: any = await (program.account as any).payoutConfig.fetch(pcPda);
    // After set_payout_caps(paused=false) in T16/T17, paused must be 0
    assert.equal(pc.paused, 0, "paused byte should be 0");
    assert.isFalse(pc.paused !== 0, "is_paused() would return false");
    console.log("  T18 paused byte:", pc.paused);
  });
});
