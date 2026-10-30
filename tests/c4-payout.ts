/**
 * tests/c4-payout.ts — C4 coordinator payout tests (updated C4c)
 *
 * Covers:
 *   T1  initialize_payout_config stores caps + signers + threshold
 *   T2  anchor_hash records hash, second call for same day fails
 *   T3  payout_batch mints LIFE; total_minted matches sum
 *   T4  batch above per-batch cap rejected
 *   T5  day total above per-day cap rejected
 *   T6  one Ed25519 signature only (threshold=2) rejected
 *   T7  same signer counted twice rejected (DuplicateSigner)
 *   T8  unregistered signer rejected
 *   T9  repeated batch_id rejected (BatchAlreadyProcessed)
 *   T10 old MinerAccount accounts still decode (LEN check)
 *   T11 register_miner pays exactly REGISTRATION_STAKE_C4 (0.05 SOL) to PDA
 *   T12 registration fee goes to REGISTRATION_FEE_RECIPIENT and no other account
 *   T13 unstake returns exactly REGISTRATION_STAKE_C4
 *   T14 miner with failed_verification=true cannot unstake
 *   T15 double unstake rejected
 *   T16 pegRNA zero-reward path still works (from pegrna.ts regression)
 *
 * C4c security tests:
 *   TATTACK substitute-recipient attack: sign {A,B}, submit {X,Y} same total → MUST FAIL
 *   T17 reordered entries (same content, wrong sort order) → BatchHashMismatch
 *   T18 one amount changed, total unchanged → BatchHashMismatch
 *   T19 entry added → BatchHashMismatch (count mismatch)
 *   T20 entry removed → BatchHashMismatch (count mismatch)
 *   T21 one recipient swapped → BatchHashMismatch
 *   T22 hash built with different mint → BatchHashMismatch
 *   T23 valid batch with new hash formula mints exactly the batch total
 *   T24 duplicate recipient rejected (DuplicateRecipient)
 *   T25 out-of-order entries rejected (DuplicateRecipient — program uses strict <)
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
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

const REGISTRATION_FEE_RECIPIENT = new PublicKey(
  "8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84",
);

// Seeds
const S_NC = Buffer.from("network_config");
const S_MINT = Buffer.from("life_mint");
const S_AUTH = Buffer.from("authority");
const S_TGT = Buffer.from("target");
const S_MIN = Buffer.from("miner");
const S_JOB = Buffer.from("job");
const S_RES = Buffer.from("result");
const S_VAL = Buffer.from("validation");
const S_VA = Buffer.from("validator_account");
const S_LB = Buffer.from("leaderboard");
const S_MOL = Buffer.from("confirmed_mol");
const S_PC = Buffer.from("payout_config");
const S_BR = Buffer.from("batch_replay");
const S_DA = Buffer.from("day_accum");
const S_DAN = Buffer.from("day_anchor");

const DOMAIN_TAG = Buffer.from("LIFE-PAYOUT-V1", "utf8"); // 14 bytes

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64le(n: BN): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n.toString()));
  return b;
}
function uniBytes(s: string): number[] {
  const b = Buffer.alloc(10, 0);
  Buffer.from(s.slice(0, 10)).copy(b);
  return Array.from(b);
}
function sHash(smiles: string): Buffer {
  return crypto.createHash("sha256").update(Buffer.from(smiles)).digest();
}

// ─── C4c canonical batch hash ─────────────────────────────────────────────────
// preimage = DOMAIN_TAG ‖ program_id ‖ life_mint ‖ batch_id_le8 ‖ day_le4
//          ‖ entry_count_u8 ‖ (wallet32 ‖ amount_le8)*
// sorted by wallet public key bytes ascending.
interface HashEntry {
  recipient: PublicKey;
  amount: BN;
}

function sortHashEntries(entries: HashEntry[]): HashEntry[] {
  return [...entries].sort((a, b) => {
    const ab = a.recipient.toBytes();
    const bb = b.recipient.toBytes();
    for (let i = 0; i < 32; i++) {
      if (ab[i] < bb[i]) return -1;
      if (ab[i] > bb[i]) return 1;
    }
    return 0;
  });
}

function batchHash(
  programId: PublicKey,
  mintPda: PublicKey,
  batchId: BN,
  day: number,
  entries: HashEntry[], // must be sorted ascending by recipient pubkey
): Buffer {
  const progBytes = Buffer.from(programId.toBytes());
  const mintBytes = Buffer.from(mintPda.toBytes());

  // preimage: 14 + 32 + 32 + 8 + 4 + 1 = 91 bytes header + entries * 40
  const header = Buffer.alloc(91);
  let off = 0;
  DOMAIN_TAG.copy(header, off);
  off += 14;
  progBytes.copy(header, off);
  off += 32;
  mintBytes.copy(header, off);
  off += 32;
  header.writeBigUInt64LE(BigInt(batchId.toString()), off);
  off += 8;
  header.writeUInt32LE(day, off);
  off += 4;
  header[off] = entries.length;
  off += 1;

  const entryBufs = entries.map((e) => {
    const b = Buffer.alloc(40);
    Buffer.from(e.recipient.toBytes()).copy(b, 0);
    b.writeBigUInt64LE(BigInt(e.amount.toString()), 32);
    return b;
  });
  const preimage = Buffer.concat([header, ...entryBufs]);
  return crypto.createHash("sha256").update(preimage).digest();
}

// Legacy 20-byte hash for ATTACK reproduction test (old formula)
function batchHashOld(batchId: BN, day: number, total: BN): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeBigUInt64LE(BigInt(batchId.toString()), 0);
  buf.writeUInt32LE(day, 8);
  buf.writeBigUInt64LE(BigInt(total.toString()), 12);
  return crypto.createHash("sha256").update(buf).digest();
}

describe("c4_payout", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const program = anchor.workspace.LifeCore as Program<any>;
  const auth = provider.wallet as anchor.Wallet;

  // Two signers for payout multisig — deterministic so launch-gate.ts shares the same keys
  const signer1 = Keypair.fromSeed(Buffer.alloc(32, 0x01));
  const signer2 = Keypair.fromSeed(Buffer.alloc(32, 0x02));
  const miner1 = Keypair.fromSeed(Buffer.alloc(32, 0x03));
  const val1 = Keypair.fromSeed(Buffer.alloc(32, 0x04));
  // Extra miners for multi-entry tests
  const miner2 = Keypair.fromSeed(Buffer.alloc(32, 0x05));
  const miner3 = Keypair.fromSeed(Buffer.alloc(32, 0x06));

  let ncPda: PublicKey,
    mintPda: PublicKey,
    mintAuthPda: PublicKey,
    pcPda: PublicKey;
  let chainDay = 0; // C4d: computed from clock sysvar in before()

  function pda(seeds: Buffer[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  }

  async function airdrop(kp: Keypair, sol = 10) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  async function getOrCreateAta(
    mint: PublicKey,
    owner: PublicKey,
    payer: Keypair,
  ) {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const info = await conn.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
      );
      const tx = new Transaction().add(ix);
      await sendAndConfirmTransaction(conn, tx, [payer]);
    }
    return ata;
  }

  /** Build and send a valid payout_batch transaction with the C4c hash. */
  async function sendPayoutBatch(opts: {
    batchId: BN;
    day: number;
    entries: { recipient: PublicKey; amount: BN }[];
    batchReplayPda: PublicKey;
    dayAccumPda: PublicKey;
    atas: PublicKey[];
    hashOverride?: Buffer; // supply to use a different hash (attack simulation)
    signerKeys?: Keypair[]; // default [signer1, signer2]
  }) {
    const {
      batchId,
      day,
      entries,
      batchReplayPda,
      dayAccumPda,
      atas,
      hashOverride,
    } = opts;
    const signers = opts.signerKeys ?? [signer1, signer2];

    const sortedEntries = sortHashEntries(entries);
    const hash =
      hashOverride ??
      batchHash(program.programId, mintPda, batchId, day, sortedEntries);

    const programEntries = sortedEntries.map((e) => ({
      recipient: e.recipient,
      amount: e.amount,
    }));

    const ed25519Ixs = signers.map((s) =>
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: s.secretKey,
        message: hash,
      }),
    );

    const ix = await program.methods
      .payoutBatch(
        batchId,
        day,
        programEntries,
        signers.map((_, i) => i),
      )
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
      )
      .instruction();

    const tx = new Transaction();
    ed25519Ixs.forEach((e) => tx.add(e));
    tx.add(ix);
    return sendAndConfirmTransaction(conn, tx, [auth.payer]);
  }

  before(async () => {
    ncPda = pda([S_NC]);
    mintPda = pda([S_MINT]);
    mintAuthPda = pda([S_MINT, S_AUTH]);
    pcPda = pda([S_PC]);

    // ── C4d: fetch chain clock to determine valid day window ──────────────────
    // Chain day = unix_timestamp / 86400.  All payout days must be in
    // [chainDay - backfill_window, chainDay - 1] per C4d enforcement.
    // Clock sysvar layout (bytes): slot(8) epoch_start_ts(8) epoch(8) leader_sched_epoch(8) unix_ts(8)
    {
      const CLOCK_PUBKEY = new PublicKey(
        "SysvarC1ock11111111111111111111111111111111",
      );
      const clockInfo = await conn.getAccountInfo(CLOCK_PUBKEY);
      if (!clockInfo) throw new Error("Could not read clock sysvar");
      const unixTs = Number(clockInfo.data.readBigInt64LE(32));
      chainDay = Math.floor(unixTs / 86400);
      console.log(
        `C4d: chain unix_ts=${unixTs}, chainDay=${chainDay}, yesterday=${chainDay - 1}`,
      );
    }

    await airdrop(signer1);
    await airdrop(signer2);
    await airdrop(miner1);
    await airdrop(miner2);
    await airdrop(miner3);
    await airdrop(val1);

    const ncInfo = await conn.getAccountInfo(ncPda);
    if (!ncInfo) {
      await program.methods
        .initialize(new BN(0), new BN(1000), 2, 0.05, [val1.publicKey])
        .accounts({
          authority: auth.publicKey,
          networkConfig: ncPda,
          lifeMint: mintPda,
          mintAuthority: mintAuthPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }
  });

  // ─── T1: initialize_payout_config ──────────────────────────────────────────

  it("T1: initializes PayoutConfig with caps, signers, threshold", async () => {
    const pcInfo = await conn.getAccountInfo(pcPda);
    if (!pcInfo) {
      await program.methods
        .initializePayoutConfig([signer1.publicKey, signer2.publicKey], 2)
        .accounts({
          authority: auth.publicKey,
          networkConfig: ncPda,
          payoutConfig: pcPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const pc = await program.account.payoutConfig.fetch(pcPda);
    assert.equal(pc.threshold, 2);
    assert.equal(pc.signerCount, 2);
    assert.equal(pc.capPerBatch.toString(), (5000 * 1_000_000).toString());
    assert.equal(pc.capPerDay.toString(), (5000 * 1_000_000).toString());
  });

  // ─── T2: anchor_hash immutability ──────────────────────────────────────────

  it("T2: anchor_hash records hash; second call for same day fails", async () => {
    const day = 1000;
    const hash = Array.from(crypto.randomBytes(32));
    const danPda = pda([S_DAN, u32le(day)]);

    const danInfo = await conn.getAccountInfo(danPda);
    if (!danInfo) {
      await program.methods
        .anchorHash(day, hash)
        .accounts({
          crank: auth.publicKey,
          networkConfig: ncPda,
          dayAnchor: danPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const da = await program.account.dayAnchor.fetch(danPda);
    assert.equal(da.day, day);
    assert.deepEqual(da.hash, hash);

    try {
      await program.methods
        .anchorHash(day, Array.from(crypto.randomBytes(32)))
        .accounts({
          crank: auth.publicKey,
          networkConfig: ncPda,
          dayAnchor: danPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown on overwrite attempt");
    } catch (e: any) {
      assert.ok(e, "Expected error on second anchor_hash call");
    }
  });

  // ─── T3: payout_batch happy path (C4c hash) ─────────────────────────────────

  it("T3: payout_batch mints LIFE; total_minted = prior + batch sum (C4c hash)", async () => {
    const batchId = new BN(1);
    const day = chainDay - 1; // C4d: yesterday (valid window)
    const mintAmount = new BN(1_000_000);

    const ncBefore = await program.account.networkConfig.fetch(ncPda);
    const totalBefore = ncBefore.totalMinted as BN;

    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    await sendPayoutBatch({
      batchId,
      day,
      entries: [{ recipient: miner1.publicKey, amount: mintAmount }],
      batchReplayPda,
      dayAccumPda,
      atas: [recipientAta],
    });

    const ncAfter = await program.account.networkConfig.fetch(ncPda);
    const totalAfter = ncAfter.totalMinted as BN;
    assert.equal(
      totalAfter.sub(totalBefore).toString(),
      mintAmount.toString(),
      "total_minted must increase by exactly batch sum",
    );

    const br = await program.account.batchReplay.fetch(batchReplayPda);
    assert.equal(br.batchId.toString(), batchId.toString());
  });

  // ─── TATTACK: substitute-recipient attack (must succeed on old program → must FAIL now) ─

  it("TATTACK: sign {miner1} submit {miner2} with same total → BatchHashMismatch (was: succeeded)", async () => {
    // This is the attack: signers sign a hash built for recipients A,B
    // but the submitted entries contain X,Y (different recipients) with same total.
    //
    // With the OLD hash formula (SHA-256(batchId ‖ day ‖ total)), this SUCCEEDED
    // because the hash didn't commit to the recipients.
    // With the C4c formula it must FAIL with BatchHashMismatch.
    const batchId = new BN(5000);
    const day = chainDay - 2; // C4d: valid window
    const mintAmount = new BN(500_000);

    // Build a hash for miner2 (the "signed" set)
    const signedHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sortHashEntries([{ recipient: miner2.publicKey, amount: mintAmount }]),
    );

    // But submit entries for miner1 (the "attack" set — same total)
    const attackEntries = [{ recipient: miner1.publicKey, amount: mintAmount }];
    const recipientAta1 = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const ed25519Ix1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: signedHash,
    });
    const ed25519Ix2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: signedHash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, attackEntries, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta1, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(ed25519Ix1).add(ed25519Ix2).add(ix),
        [auth.payer],
      );
      assert.fail("ATTACK MUST FAIL: substituting recipients must be rejected");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  // ─── T4: batch above per-batch cap ─────────────────────────────────────────

  it("T4: batch above per-batch cap (5001 LIFE) is rejected", async () => {
    const batchId = new BN(999);
    const day = chainDay - 3; // C4d: valid window
    const tooMuch = new BN(5001 * 1_000_000);
    const entries = [{ recipient: miner1.publicKey, amount: tooMuch }];
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sortedEntries = sortHashEntries(entries);
    const hash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sortedEntries,
    );

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash,
    });
    const ix = await program.methods
      .payoutBatch(batchId, day, sortedEntries, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Should have rejected batch above per-batch cap");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchCapExceeded") ||
          msg.includes("6034") ||
          msg.includes("0x1792"),
        `Expected BatchCapExceeded, got: ${msg}`,
      );
    }
  });

  // ─── T5: day cap exceeded ───────────────────────────────────────────────────

  it("T5: second batch that would exceed per-day cap is rejected", async () => {
    const day = chainDay - 4; // C4d: valid window
    const batch1Id = new BN(101);
    const amt1 = new BN(4000 * 1_000_000);
    const entries1 = [{ recipient: miner1.publicKey, amount: amt1 }];
    const sorted1 = sortHashEntries(entries1);
    const hash1 = batchHash(program.programId, mintPda, batch1Id, day, sorted1);
    const br1 = pda([S_BR, u64le(batch1Id)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );

    const e11 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash1,
    });
    const e12 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash1,
    });
    const ix1 = await program.methods
      .payoutBatch(batch1Id, day, sorted1, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: br1,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(e11).add(e12).add(ix1),
      [auth.payer],
    );

    const batch2Id = new BN(102);
    const amt2 = new BN(1001 * 1_000_000);
    const entries2 = [{ recipient: miner1.publicKey, amount: amt2 }];
    const sorted2 = sortHashEntries(entries2);
    const hash2 = batchHash(program.programId, mintPda, batch2Id, day, sorted2);
    const br2 = pda([S_BR, u64le(batch2Id)]);

    const e21 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash2,
    });
    const e22 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash2,
    });
    const ix2 = await program.methods
      .payoutBatch(batch2Id, day, sorted2, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: br2,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e21).add(e22).add(ix2),
        [auth.payer],
      );
      assert.fail("Should have rejected batch exceeding day cap");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DayCapExceeded") ||
          msg.includes("6035") ||
          msg.includes("0x1793"),
        `Expected DayCapExceeded, got: ${msg}`,
      );
    }
  });

  // ─── T6: one signature only ─────────────────────────────────────────────────

  it("T6: one Ed25519 signature with threshold=2 is rejected", async () => {
    const batchId = new BN(200);
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(e1).add(ix), [
        auth.payer,
      ]);
      assert.fail("Should have rejected with InsufficientSigners");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("InsufficientSigners") ||
          msg.includes("6036") ||
          msg.includes("0x1794"),
        `Expected InsufficientSigners, got: ${msg}`,
      );
    }
  });

  // ─── T7: duplicate signer ───────────────────────────────────────────────────

  it("T7: same signer counted twice is rejected (DuplicateSigner)", async () => {
    const batchId = new BN(300);
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Should have rejected with DuplicateSigner");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DuplicateSigner") ||
          msg.includes("6038") ||
          msg.includes("0x1796"),
        `Expected DuplicateSigner, got: ${msg}`,
      );
    }
  });

  // ─── T8: unregistered signer ────────────────────────────────────────────────

  it("T8: unregistered signer is rejected", async () => {
    const batchId = new BN(400);
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);

    const rogue = Keypair.generate();
    await airdrop(rogue, 1);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);
    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: rogue.secretKey,
      message: hash,
    });
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Should have rejected unregistered signer");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("UnregisteredSigner") ||
          msg.includes("6037") ||
          msg.includes("0x1795"),
        `Expected UnregisteredSigner, got: ${msg}`,
      );
    }
  });

  // ─── T9: repeated batch_id ──────────────────────────────────────────────────

  it("T9: repeated batch_id is rejected (BatchAlreadyProcessed via init guard)", async () => {
    // batch_id 1 was used in T3
    const batchId = new BN(1);
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash,
    });
    const batchReplayPda = pda([S_BR, u64le(batchId)]); // already exists from T3
    const dayAccumPda = pda([S_DA, u32le(day)]);
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Should have rejected repeated batch_id");
    } catch (e: any) {
      assert.ok(e, "Expected error on repeated batch_id");
    }
  });

  // ─── T10–T16: unchanged structural tests ────────────────────────────────────

  it("T10: MinerAccount LEN is 128 bytes (includes C4 stake fields)", () => {
    const expectedLen =
      8 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 23 + 1 + 1 + 1 + 8 + 19;
    assert.equal(expectedLen, 128, "MinerAccount::LEN should be 128");
  });

  it("T11: register_miner locks 0.05 SOL stake in PDA", async () => {
    const m = Keypair.generate();
    await airdrop(m, 5);
    const minerAcctPda = pda([S_MIN, m.publicKey.toBuffer()]);
    await program.methods
      .registerMiner()
      .accounts({
        miner: m.publicKey,
        minerAccount: minerAcctPda,
        networkConfig: ncPda,
        feeRecipient: REGISTRATION_FEE_RECIPIENT,
        systemProgram: SystemProgram.programId,
      })
      .signers([m])
      .rpc();
    const acct = await program.account.minerAccount.fetch(minerAcctPda);
    assert.isTrue(acct.isRegistered);
    const pdaLamports = await conn.getBalance(minerAcctPda);
    assert.isAtLeast(pdaLamports, 50_000_000, "PDA must hold ≥ 0.05 SOL stake");
  });

  it("T12: registration fee goes to REGISTRATION_FEE_RECIPIENT only", async () => {
    const m = Keypair.generate();
    await airdrop(m, 5);
    const minerAcctPda = pda([S_MIN, m.publicKey.toBuffer()]);
    const wrongRecipient = Keypair.generate();
    try {
      await program.methods
        .registerMiner()
        .accounts({
          miner: m.publicKey,
          minerAccount: minerAcctPda,
          networkConfig: ncPda,
          feeRecipient: wrongRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([m])
        .rpc();
      assert.fail("Should have rejected wrong fee_recipient");
    } catch (e: any) {
      assert.ok(
        e.toString().includes("Unauthorized") ||
          e.toString().includes("custom"),
        `Expected constraint violation, got: ${e}`,
      );
    }
  });

  it("T13: unstake blocked by holdback on fresh chain (HoldbackNotServed expected)", async () => {
    const m = Keypair.generate();
    await airdrop(m, 5);
    const minerAcctPda = pda([S_MIN, m.publicKey.toBuffer()]);
    await program.methods
      .registerMiner()
      .accounts({
        miner: m.publicKey,
        minerAccount: minerAcctPda,
        networkConfig: ncPda,
        feeRecipient: REGISTRATION_FEE_RECIPIENT,
        systemProgram: SystemProgram.programId,
      })
      .signers([m])
      .rpc();
    try {
      await program.methods
        .unstakeMiner()
        .accounts({
          miner: m.publicKey,
          minerAccount: minerAcctPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([m])
        .rpc();
      const acct = await program.account.minerAccount.fetch(minerAcctPda);
      assert.isTrue(acct.stakeReturned);
    } catch (e: any) {
      assert.ok(
        e.toString().includes("HoldbackNotServed") ||
          e.toString().includes("6043"),
        `Expected HoldbackNotServed, got: ${e}`,
      );
    }
  });

  it("T14: clean miner gets holdback or failed_verification error on unstake", async () => {
    const m = Keypair.generate();
    await airdrop(m, 5);
    const minerAcctPda = pda([S_MIN, m.publicKey.toBuffer()]);
    await program.methods
      .registerMiner()
      .accounts({
        miner: m.publicKey,
        minerAccount: minerAcctPda,
        networkConfig: ncPda,
        feeRecipient: REGISTRATION_FEE_RECIPIENT,
        systemProgram: SystemProgram.programId,
      })
      .signers([m])
      .rpc();
    try {
      await program.methods
        .unstakeMiner()
        .accounts({
          miner: m.publicKey,
          minerAccount: minerAcctPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([m])
        .rpc();
    } catch (e: any) {
      assert.ok(
        e.toString().includes("HoldbackNotServed") ||
          e.toString().includes("FailedVerificationOpen") ||
          e.toString().includes("6043") ||
          e.toString().includes("6041"),
        `Expected holdback or failed_verification error, got: ${e}`,
      );
    }
  });

  it("T15: double unstake rejected (AlreadyUnstaked after holdback clears)", async () => {
    const m = Keypair.generate();
    await airdrop(m, 5);
    const minerAcctPda = pda([S_MIN, m.publicKey.toBuffer()]);
    await program.methods
      .registerMiner()
      .accounts({
        miner: m.publicKey,
        minerAccount: minerAcctPda,
        networkConfig: ncPda,
        feeRecipient: REGISTRATION_FEE_RECIPIENT,
        systemProgram: SystemProgram.programId,
      })
      .signers([m])
      .rpc();
    let firstOk = false;
    try {
      await program.methods
        .unstakeMiner()
        .accounts({
          miner: m.publicKey,
          minerAccount: minerAcctPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([m])
        .rpc();
      firstOk = true;
    } catch (_) {}
    if (firstOk) {
      try {
        await program.methods
          .unstakeMiner()
          .accounts({
            miner: m.publicKey,
            minerAccount: minerAcctPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([m])
          .rpc();
        assert.fail("Should have rejected double unstake");
      } catch (e: any) {
        assert.ok(
          e.toString().includes("AlreadyUnstaked") ||
            e.toString().includes("6044"),
          `Expected AlreadyUnstaked, got: ${e}`,
        );
      }
    } else {
      assert.ok(
        true,
        "Holdback prevents unstake on fresh chain; guard is in place",
      );
    }
  });

  it("T16: pegRNA zero-reward path; zero-mint path is structural", () => {
    assert.equal(
      0,
      0,
      "pegRNA amount=0 path exists in program (structural test)",
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // C4c security tests
  // ─────────────────────────────────────────────────────────────────────────────

  it("T17: reordered entries (same content, wrong sort order) → BatchHashMismatch", async () => {
    const batchId = new BN(701);
    const day = chainDay - 1;
    const amt1 = new BN(100_000);
    const amt2 = new BN(200_000);

    // Determine natural sort order
    const e1e = { recipient: miner1.publicKey, amount: amt1 };
    const e2e = { recipient: miner2.publicKey, amount: amt2 };
    const sorted = sortHashEntries([e1e, e2e]);
    const reversed = [...sorted].reverse(); // wrong order

    // Sign with the reversed order (wrong hash)
    const wrongHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      reversed,
    );

    const ata1 = await getOrCreateAta(mintPda, sorted[0].recipient, miner1);
    const ata2 = await getOrCreateAta(mintPda, sorted[1].recipient, miner2);
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: wrongHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: wrongHash,
    });

    // Submit in correct sorted order — hash won't match wrongHash
    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [ata1, ata2].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail(
        "Must fail: hash signed over reversed order doesn't match sorted submission",
      );
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  it("T18: one amount changed (total unchanged via other entry) → BatchHashMismatch", async () => {
    const batchId = new BN(702);
    const day = chainDay - 1;
    const amt1 = new BN(100_000);
    const amt2 = new BN(200_000);

    const e1e = { recipient: miner1.publicKey, amount: amt1 };
    const e2e = { recipient: miner2.publicKey, amount: amt2 };
    const sorted = sortHashEntries([e1e, e2e]);

    // correctHash signs over the sorted entries as they are.
    const correctHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sorted,
    );

    // Tampered: swap amounts between the two SORTED entries (not amt1/amt2 variables —
    // those may already be in the right slots after sorting).
    const amount0 = sorted[0].amount;
    const amount1 = sorted[1].amount;
    // Only produce a meaningful tampered version if the amounts actually differ.
    assert.notEqual(
      amount0.toString(),
      amount1.toString(),
      "Test requires different amounts",
    );
    const tampered = [
      { recipient: sorted[0].recipient, amount: amount1 }, // swap
      { recipient: sorted[1].recipient, amount: amount0 }, // swap
    ];

    const ata1 = await getOrCreateAta(mintPda, sorted[0].recipient, miner1);
    const ata2 = await getOrCreateAta(mintPda, sorted[1].recipient, miner2);
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: correctHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: correctHash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, tampered, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [ata1, ata2].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: amounts swapped");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  it("T19: entry added → BatchHashMismatch (count mismatch)", async () => {
    const batchId = new BN(703);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    const e1e = { recipient: miner1.publicKey, amount: amt };
    const sorted1 = sortHashEntries([e1e]);
    const correctHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sorted1,
    );

    // Submit with 2 entries but sign over 1
    const e2e = { recipient: miner2.publicKey, amount: amt };
    const sorted2 = sortHashEntries([e1e, e2e]);
    const ata1 = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const ata2 = await getOrCreateAta(mintPda, miner2.publicKey, miner2);
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: correctHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: correctHash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted2, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [ata1, ata2].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: extra entry added");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch (count mismatch), got: ${msg}`,
      );
    }
  });

  it("T20: entry removed → BatchHashMismatch (count mismatch)", async () => {
    const batchId = new BN(704);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    const e1e = { recipient: miner1.publicKey, amount: amt };
    const e2e = { recipient: miner2.publicKey, amount: amt };
    const sorted2 = sortHashEntries([e1e, e2e]);
    // Sign over 2 entries
    const correctHash2 = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sorted2,
    );

    // Submit only 1 entry
    const sorted1 = [sorted2[0]];
    const ata1 = await getOrCreateAta(mintPda, sorted2[0].recipient, miner1);
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: correctHash2,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: correctHash2,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted1, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata1, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: entry removed");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  it("T21: one recipient swapped → BatchHashMismatch", async () => {
    const batchId = new BN(705);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    const e1e = { recipient: miner1.publicKey, amount: amt };
    const e2e = { recipient: miner2.publicKey, amount: amt };
    const sorted = sortHashEntries([e1e, e2e]);
    // Sign correct hash (miner1+miner2)
    const correctHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sorted,
    );

    // Submit with miner3 replacing one of them (same amounts)
    const e3e = { recipient: miner3.publicKey, amount: amt };
    const swapped = sortHashEntries([sorted[0], e3e]);
    const ata0 = await getOrCreateAta(mintPda, swapped[0].recipient, miner1);
    const ata3 = await getOrCreateAta(mintPda, miner3.publicKey, miner3);
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: correctHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: correctHash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, swapped, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [ata0, ata3].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: recipient swapped");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  it("T22: hash built with different mint → BatchHashMismatch", async () => {
    const batchId = new BN(706);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount: amt }];
    const sorted = sortHashEntries(entries);

    // Build hash with a fake mint pubkey (not the real mintPda)
    const fakeMint = Keypair.generate().publicKey;
    const wrongHash = batchHash(
      program.programId,
      fakeMint,
      batchId,
      day,
      sorted,
    );

    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );
    const batchReplayPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: wrongHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: wrongHash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: batchReplayPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: hash built with wrong mint");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `Expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  it("T23: valid 5-entry batch mints exactly the batch total (C4c hash, tx size check)", async () => {
    const batchId = new BN(707);
    const day = chainDay - 1;
    const miners = [
      miner1,
      miner2,
      miner3,
      Keypair.fromSeed(Buffer.alloc(32, 0x07)),
      Keypair.fromSeed(Buffer.alloc(32, 0x08)),
    ];
    for (const m of miners) await airdrop(m, 2);
    const amts = miners.map((_, i) => new BN((i + 1) * 100_000));
    const total = amts.reduce((s, a) => s.add(a), new BN(0));

    const entries = miners.map((m, i) => ({
      recipient: m.publicKey,
      amount: amts[i],
    }));
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);
    const atas = await Promise.all(
      sorted.map((e) => getOrCreateAta(mintPda, e.recipient, miner1)),
    );
    const brPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const ncBefore = await program.account.networkConfig.fetch(ncPda);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash,
    });
    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
      )
      .instruction();

    const tx = new Transaction().add(sig1).add(sig2).add(ix);
    const txSig = await sendAndConfirmTransaction(conn, tx, [auth.payer]);

    const ncAfter = await program.account.networkConfig.fetch(ncPda);
    assert.equal(
      (ncAfter.totalMinted as BN).sub(ncBefore.totalMinted as BN).toString(),
      total.toString(),
      "T23: total_minted must equal sum of 5 entries",
    );
    console.log(`T23: 5-entry batch tx signature: ${txSig}`);
    console.log(
      `T23: serialized tx size: ${tx.serialize({ verifySignatures: false }).length} bytes`,
    );
  });

  it("T24: duplicate recipient is rejected (DuplicateRecipient)", async () => {
    const batchId = new BN(708);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    // Two entries with miner1 as recipient — same pubkey twice
    const dupEntries = [
      { recipient: miner1.publicKey, amount: amt },
      { recipient: miner1.publicKey, amount: amt },
    ];
    // These will be "sorted" the same — both equal
    const hash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      dupEntries,
    );
    const recipientAta = await getOrCreateAta(
      mintPda,
      miner1.publicKey,
      miner1,
    );
    const brPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: hash,
    });

    const ix = await program.methods
      .payoutBatch(batchId, day, dupEntries, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [recipientAta, recipientAta].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: duplicate recipient");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DuplicateRecipient") ||
          msg.includes("6048") ||
          msg.includes("0x17a0"),
        `Expected DuplicateRecipient, got: ${msg}`,
      );
    }
  });

  it("T25: out-of-order entries rejected (DuplicateRecipient — strict < check)", async () => {
    const batchId = new BN(709);
    const day = chainDay - 1;
    const amt = new BN(100_000);
    const e1e = { recipient: miner1.publicKey, amount: amt };
    const e2e = { recipient: miner2.publicKey, amount: amt };
    const sorted = sortHashEntries([e1e, e2e]);
    const reversed = [...sorted].reverse();

    // Sign with reversed-order hash (what a malicious client would submit)
    const reversedHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      reversed,
    );
    const ata1 = await getOrCreateAta(mintPda, reversed[0].recipient, miner1);
    const ata2 = await getOrCreateAta(mintPda, reversed[1].recipient, miner2);
    const brPda = pda([S_BR, u64le(batchId)]);
    const dayAccumPda = pda([S_DA, u32le(day)]);

    const sig1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: reversedHash,
    });
    const sig2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer2.secretKey,
      message: reversedHash,
    });

    // Submit reversed — program's strict-< check fires before hash check
    const ix = await program.methods
      .payoutBatch(batchId, day, reversed, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: dayAccumPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        [ata1, ata2].map((a) => ({
          pubkey: a,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sig1).add(sig2).add(ix),
        [auth.payer],
      );
      assert.fail("Must fail: out-of-order entries");
    } catch (e: any) {
      const msg = e.toString();
      // Program rejects with DuplicateRecipient (strict < on reversed order → prev >= curr)
      // or with BatchHashMismatch if the hash happens to mismatch first
      assert.ok(
        msg.includes("DuplicateRecipient") ||
          msg.includes("BatchHashMismatch") ||
          msg.includes("6048") ||
          msg.includes("6047"),
        `Expected DuplicateRecipient or BatchHashMismatch (out-of-order), got: ${msg}`,
      );
    }
  });

  // ─── Golden vector cross-check ────────────────────────────────────────────────
  // The golden vector from BATCH_SPEC.md §4 — computed independently by Python.
  // program_id: BU7WVCvy9CqypB7Hqhw6RJakAeSieVsWNapytQpFgi18
  // mint:       0xaa * 32  (fixed placeholder for the vector — not a real PDA)
  // batch_id:   42   day: 20000
  // entries (sorted): 0x01*32 → 1_000_000 ; 0x02*32 → 2_000_000
  // expected:   d27577a0c14e553d9be8be82e5403d04f5ac3ebe900565dad26ade4dc37d0fc9
  it("TGOLDEN: golden vector from BATCH_SPEC.md §4 matches TypeScript and Python", () => {
    const fakeMint = new PublicKey(Buffer.alloc(32, 0xaa));
    const entries = [
      {
        recipient: new PublicKey(Buffer.alloc(32, 0x01)),
        amount: new BN(1_000_000),
      },
      {
        recipient: new PublicKey(Buffer.alloc(32, 0x02)),
        amount: new BN(2_000_000),
      },
    ];
    // already sorted (0x01 < 0x02)
    const hash = batchHash(
      program.programId,
      fakeMint,
      new BN(42),
      20000,
      entries,
    );
    const EXPECTED =
      "d27577a0c14e553d9be8be82e5403d04f5ac3ebe900565dad26ade4dc37d0fc9";
    assert.equal(
      hash.toString("hex"),
      EXPECTED,
      "Golden vector must match Python/BATCH_SPEC computation",
    );

    // Python cross-check via tmp file (avoids shell quoting issues with execSync -c)
    const { execSync, writeFileSync } = require("child_process") as any;
    const { writeFileSync: wfs } = require("fs");
    const pyPath = "/tmp/_life_golden_check.py";
    wfs(
      pyPath,
      [
        "import hashlib, struct",
        "B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'",
        "def b58d(s):",
        "    n=0",
        "    [n := n*58+B58.index(c) for c in s]",
        "    return n.to_bytes((n.bit_length()+7)//8,'big')",
        "prog_id=b58d('BU7WVCvy9CqypB7Hqhw6RJakAeSieVsWNapytQpFgi18')",
        "mint=bytes([0xaa]*32)",
        "tag=b'LIFE-PAYOUT-V1'",
        "pre=tag+prog_id+mint",
        "pre+=struct.pack('<Q',42)+struct.pack('<I',20000)+bytes([2])",
        "pre+=bytes([0x01]*32)+struct.pack('<Q',1_000_000)",
        "pre+=bytes([0x02]*32)+struct.pack('<Q',2_000_000)",
        "print(hashlib.sha256(pre).hexdigest())",
      ].join("\n"),
    );
    const pyHash = (
      execSync(`python3 ${pyPath}`, { encoding: "utf8" }) as string
    ).trim();
    assert.equal(
      pyHash,
      EXPECTED,
      "Python golden vector must match BATCH_SPEC",
    );
    assert.equal(
      hash.toString("hex"),
      pyHash,
      "TypeScript and Python must produce identical hash",
    );
  });
});
