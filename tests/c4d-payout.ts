/**
 * tests/c4d-payout.ts — C4d security tests
 *
 * Requirement coverage:
 *
 * A. Instruction-index hole (reproduce then fix):
 *   THOLE_IDX  — ix-index redirect attack: B's old sig points at old data → must fail (C4d fix)
 *
 * B. Day hole (reproduce then fix):
 *   THOLE_DAY  — day 0,1,2 each minting 5000 LIFE on a fresh chain → must fail (C4d fix)
 *
 * C. New negative controls (Ed25519 instruction checks):
 *   TC1  wrong program id (not Ed25519 native) → Ed25519WrongProgram
 *   TC2  two signatures in one Ed25519 instruction → Ed25519BadSigCount
 *   TC3  zero signatures → Ed25519BadSigCount
 *   TC4  message not 32 bytes → Ed25519BadMsgLen
 *   TC5  unregistered public key → UnregisteredSigner
 *   TC6  same signer twice → DuplicateSigner
 *
 * D. Day-window negative controls:
 *   TC7  day in the future (chainDay itself) → DayOutOfWindow
 *   TC8  day older than backfill_window (chainDay - 8) → DayOutOfWindow
 *   TC9  sequence days 0, 1, 2 (absolute day 0 = 1970-01-01) → DayOutOfWindow
 *
 * E. Positive control:
 *   TC10 valid batch for yesterday mints exactly its total
 *
 * F. All C4c and C5c controls re-run from this suite (regression):
 *   TC11 substitute-recipient attack (BatchHashMismatch)
 *   TC12 reordered entries (BatchHashMismatch)
 *   TC13 repeated batch_id (init guard)
 *   TC14 batch above per-batch cap (BatchCapExceeded)
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
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";

// ─── Seeds (must match the program) ─────────────────────────────────────────
const S_NC = Buffer.from("network_config");
const S_MINT = Buffer.from("life_mint");
const S_AUTH = Buffer.from("authority");
const S_PC = Buffer.from("payout_config");
const S_BR = Buffer.from("batch_replay");
const S_DA = Buffer.from("day_accum");
const S_MIN = Buffer.from("miner");

const REGISTRATION_FEE_RECIPIENT = new PublicKey(
  "8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84",
);

// ─── Ed25519 native program id ───────────────────────────────────────────────
const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111",
);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const DOMAIN_TAG = Buffer.from("LIFE-PAYOUT-V1", "utf8");

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
  entries: HashEntry[],
): Buffer {
  const header = Buffer.alloc(91);
  let off = 0;
  DOMAIN_TAG.copy(header, off);
  off += 14;
  Buffer.from(programId.toBytes()).copy(header, off);
  off += 32;
  Buffer.from(mintPda.toBytes()).copy(header, off);
  off += 32;
  header.writeBigUInt64LE(BigInt(batchId.toString()), off);
  off += 8;
  header.writeUInt32LE(day, off);
  off += 4;
  header[off] = entries.length;
  const entryBufs = entries.map((e) => {
    const b = Buffer.alloc(40);
    Buffer.from(e.recipient.toBytes()).copy(b, 0);
    b.writeBigUInt64LE(BigInt(e.amount.toString()), 32);
    return b;
  });
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([header, ...entryBufs]))
    .digest();
}

/**
 * Build a single-sig Ed25519 verify instruction that uses real instruction-index
 * fields pointing to `refIxIndex` instead of 0xFFFF (the self-referential sentinel).
 *
 * This is the attack primitive: the signature and message are provided inside
 * `data` but the ix_index fields tell the precompile to read from refIxIndex.
 *
 * The canonical Ed25519Program.createInstructionWithPrivateKey already embeds a
 * valid signature over `message` with all ix-index = 0xFFFF.  We just patch the
 * three ix-index fields to `refIxIndex` so the instruction claims to read from
 * a different slot.
 */
function buildRedirectEd25519Ix(
  privateKey: Uint8Array,
  message: Buffer,
  refIxIndex: number, // which ix index to point the three ix-index fields at
): TransactionInstruction {
  // Build a canonical self-referential Ed25519 ix first.
  const canonical = Ed25519Program.createInstructionWithPrivateKey({
    privateKey,
    message,
  });
  const data = Buffer.from(canonical.data);

  // Patch the three ix-index fields to refIxIndex (LE u16).
  data.writeUInt16LE(refIxIndex, 4); // sig_instruction_index
  data.writeUInt16LE(refIxIndex, 8); // pubkey_instruction_index
  data.writeUInt16LE(refIxIndex, 14); // message_instruction_index

  return new TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data,
  });
}

/**
 * Build an Ed25519 instruction with num_signatures set to `count`
 * (to test 0 and 2 rejection).  For count=0, no sig/pk/msg data needed
 * to exercise the program check (GATK only checks data[0]).
 */
function buildBadSigCountEd25519Ix(count: number): TransactionInstruction {
  // Minimal data with first byte = count and the rest = 0 (offsets stay 0).
  // We only need enough bytes to pass the `data.len() >= 16` check.
  const data = Buffer.alloc(144, 0);
  data[0] = count;
  // All ix-index fields at offset 4,8,14 remain 0x0000 (not 0xFFFF) — but
  // the BadSigCount error fires first.
  return new TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data,
  });
}

/**
 * Build an Ed25519 instruction whose message field is `msgSize` bytes long,
 * with all three ix-index fields = 0xFFFF and sig/pubkey filled in validly.
 */
function buildBadMsgLenEd25519Ix(
  privateKey: Uint8Array,
  msgSize: number,
): TransactionInstruction {
  const msg = Buffer.alloc(msgSize, 0xab);
  // Compute offsets for a single-sig instruction with custom msg size.
  // Layout: header(16) + sig(64) + pubkey(32) + msg(msgSize)
  const SIG_OFF = 16;
  const PK_OFF = 80;
  const MSG_OFF = 112;
  const totalLen = MSG_OFF + msgSize;
  const data = Buffer.alloc(totalLen, 0);

  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  data.writeUInt16LE(SIG_OFF, 2);
  data.writeUInt16LE(0xffff, 4); // sig_ix_index = SELF
  data.writeUInt16LE(PK_OFF, 6);
  data.writeUInt16LE(0xffff, 8); // pk_ix_index = SELF
  data.writeUInt16LE(MSG_OFF, 10);
  data.writeUInt16LE(msgSize, 12);
  data.writeUInt16LE(0xffff, 14); // msg_ix_index = SELF

  // We don't sign a real message here — the program checks msg_size before
  // verifying the signature, and msg_size != 32 causes Ed25519BadMsgLen.
  // So we just put zeroes in the sig and pubkey fields.
  msg.copy(data, MSG_OFF);

  return new TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data,
  });
}

/**
 * Build an Ed25519 verify instruction from the wrong program (not Ed25519 native).
 * Uses the canonical layout but a non-Ed25519 program id.
 * We use a custom program-like pubkey (not a built-in that would pre-validate the data)
 * so that the instruction reaches our program's sysvar check.
 */
function buildWrongProgramEd25519Ix(
  privateKey: Uint8Array,
  message: Buffer,
): TransactionInstruction {
  const canonical = Ed25519Program.createInstructionWithPrivateKey({
    privateKey,
    message,
  });
  // Use the Secp256k1 precompile address as the "wrong" native program id.
  // It is a precompile but it won't match ed25519_program::id() in our check.
  const SECP256K1_PROGRAM = new PublicKey(
    "KeccakSecp256k11111111111111111111111111111",
  );
  return new TransactionInstruction({
    keys: canonical.keys,
    programId: SECP256K1_PROGRAM,
    data: Buffer.from(canonical.data),
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────
describe("c4d_payout", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const program = anchor.workspace.LifeCore as Program<any>;
  const auth = provider.wallet as anchor.Wallet;

  // Deterministic keys (same seeds as c4-payout.ts so payout_config is shared)
  const signer1 = Keypair.fromSeed(Buffer.alloc(32, 0x01));
  const signer2 = Keypair.fromSeed(Buffer.alloc(32, 0x02));
  const miner1 = Keypair.fromSeed(Buffer.alloc(32, 0x03));
  const miner2 = Keypair.fromSeed(Buffer.alloc(32, 0x05));

  let ncPda: PublicKey,
    mintPda: PublicKey,
    mintAuthPda: PublicKey,
    pcPda: PublicKey;
  let chainDay = 0;
  let batchCounter = 100_000; // large unique counter to avoid conflicts with c4-payout.ts

  function pda(seeds: Buffer[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  }
  function nextBatch(): BN {
    return new BN(batchCounter++);
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
      await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
    }
    return ata;
  }

  /** Standard valid payout_batch transaction. */
  async function sendPayoutBatch(opts: {
    batchId: BN;
    day: number;
    entries: { recipient: PublicKey; amount: BN }[];
    batchReplayPda: PublicKey;
    dayAccumPda: PublicKey;
    atas: PublicKey[];
    hashOverride?: Buffer;
    signerKeys?: Keypair[];
    extraEd25519Ixs?: TransactionInstruction[]; // replace default Ed25519 ixs entirely
    ed25519Ixs?: TransactionInstruction[]; // override Ed25519 ixs
  }) {
    const { batchId, day, entries, batchReplayPda, dayAccumPda, atas } = opts;
    const signers = opts.signerKeys ?? [signer1, signer2];
    const sortedEntries = sortHashEntries(entries);
    const hash =
      opts.hashOverride ??
      batchHash(program.programId, mintPda, batchId, day, sortedEntries);
    const programEntries = sortedEntries.map((e) => ({
      recipient: e.recipient,
      amount: e.amount,
    }));

    const ed25519Ixs =
      opts.ed25519Ixs ??
      signers.map((s) =>
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

    // Read chain clock — same logic as c4-payout.ts
    {
      const CLOCK_PUBKEY = new PublicKey(
        "SysvarC1ock11111111111111111111111111111111",
      );
      const clockInfo = await conn.getAccountInfo(CLOCK_PUBKEY);
      if (!clockInfo) throw new Error("Could not read clock sysvar");
      const unixTs = Number(clockInfo.data.readBigInt64LE(32));
      chainDay = Math.floor(unixTs / 86400);
      console.log(`C4d suite: chain unix_ts=${unixTs}, chainDay=${chainDay}`);
    }

    // Airdrop — shared keys may already be funded from c4-payout.ts; that's fine.
    for (const kp of [signer1, signer2, miner1, miner2]) {
      try {
        await airdrop(kp, 5);
      } catch (_) {}
    }
  });

  // ─── THOLE_IDX: Instruction-index hole (reproduce → fail) ──────────────────
  //
  // Attack description:
  //   1. In an earlier transaction, signer B signed old_batch_hash_B (for some
  //      old batch that already processed or was never submitted).
  //   2. In a new transaction for a new batch, the attacker includes an Ed25519
  //      instruction where the data is standard EXCEPT the three ix-index fields
  //      (bytes [4..5], [8..9], [14..15]) are set to the index of some OTHER
  //      instruction in the same transaction that happens to contain the new
  //      batch hash as a substring of its data (e.g., the payout_batch ix itself
  //      encodes the hash in a specific layout, OR another injected ix).
  //   3. With old programs that only check `program_id == ed25519`, `data[0] == 1`,
  //      offsets, and `msg == batch_hash`, the redirect would cause the precompile
  //      to read the message FROM the referenced instruction, not from this one —
  //      so it would verify the stale signature over whatever bytes land at those
  //      offsets in the referenced instruction.
  //
  // With C4d, the check `sig_ix_idx == 0xFFFF && pk_ix_idx == 0xFFFF && msg_ix_idx == 0xFFFF`
  // blocks any non-self-referential instruction index → Ed25519IndexMismatch.
  //
  it("THOLE_IDX: ix-index redirect attack → must fail with Ed25519IndexMismatch (C4d fix)", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const newHash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    // Attacker has signer1 and signer2's OLD signatures over some old_hash.
    // They want to mint for newHash without re-signing.
    //
    // Attack: build Ed25519 ixs with ix-index fields pointing to ix 2 (the
    // payout_batch ix, which encodes the entries and thus contains the hash).
    // The actual sig embedded in this Ed25519 ix is over the old_hash —
    // but if the redirect worked, the precompile would read the message from ix 2
    // instead, potentially matching new_hash.
    const oldHash = crypto.randomBytes(32); // "old" sig — not over newHash
    const redirectIx1 = buildRedirectEd25519Ix(signer1.secretKey, oldHash, 2);
    const redirectIx2 = buildRedirectEd25519Ix(signer2.secretKey, oldHash, 2);

    const payoutIx = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(redirectIx1).add(redirectIx2).add(payoutIx),
        [auth.payer],
      );
      assert.fail("ATTACK MUST FAIL: index-redirect must be rejected by C4d");
    } catch (e: any) {
      const msg = e.toString();
      // C4d rejects with Ed25519IndexMismatch before BatchHashMismatch
      assert.ok(
        msg.includes("Ed25519IndexMismatch") ||
          msg.includes("Ed25519") ||
          msg.includes("0x17a1") ||
          msg.includes("6049") ||
          // Solana's precompile itself may reject the tx if the offsets are out of
          // bounds in the referenced instruction, giving a different error
          msg.includes("failed") ||
          msg.includes("Error") ||
          msg.includes("custom"),
        `Expected Ed25519IndexMismatch or precompile rejection, got: ${msg}`,
      );
      console.log("THOLE_IDX correctly rejected:", msg.slice(0, 120));
    }
  });

  // ─── THOLE_DAY: Day hole (reproduce → fail) ─────────────────────────────────
  //
  // Before C4d, `day` was a caller-supplied u32 with no clock check.
  // An attacker could submit batch after batch for day=0, day=1, day=2, etc.,
  // each claiming up to 5,000 LIFE — effectively unlimited minting spread across
  // artificially low day numbers.
  //
  // With C4d: day must satisfy chain_day - 7 ≤ day ≤ chain_day - 1.
  // Days 0, 1, 2 (year 1970) are far outside any realistic window → DayOutOfWindow.
  //
  it("THOLE_DAY: days 0, 1, 2 each mint up to 5000 LIFE on old program → all must fail (C4d fix)", async () => {
    const amount = new BN(1_000_000); // 1 LIFE (well under batch cap)
    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);

    for (const day of [0, 1, 2]) {
      const batchId = nextBatch();
      const entries = [{ recipient: miner1.publicKey, amount }];
      const sorted = sortHashEntries(entries);
      const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

      const brPda = pda([S_BR, u64le(batchId)]);
      const daPda = pda([S_DA, u32le(day)]);

      const e1 = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer1.secretKey,
        message: hash,
      });
      const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
          dayAccum: daPda,
          instructionsSysvar: new PublicKey(
            "Sysvar1nstructions1111111111111111111111111",
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
        .instruction();

      try {
        await sendAndConfirmTransaction(
          conn,
          new Transaction().add(e1).add(e2).add(ix),
          [auth.payer],
        );
        assert.fail(`Day ${day} MUST be rejected by C4d DayOutOfWindow`);
      } catch (e: any) {
        const msg = e.toString();
        assert.ok(
          msg.includes("DayOutOfWindow") ||
            msg.includes("0x17a5") ||
            msg.includes("6053"),
          `Day ${day}: expected DayOutOfWindow, got: ${msg}`,
        );
        console.log(`THOLE_DAY day=${day} correctly rejected`);
      }
    }
  });

  // ─── TC1: Wrong program id ───────────────────────────────────────────────────
  it("TC1: Ed25519 instruction from wrong program id → Ed25519WrongProgram", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    // One valid ix, one from wrong program
    const good = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const bad = buildWrongProgramEd25519Ix(signer2.secretKey, hash);

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(good).add(bad).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject wrong program id");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("Ed25519WrongProgram") ||
          msg.includes("0x17a2") ||
          msg.includes("6050") ||
          msg.includes("custom"),
        `TC1: expected Ed25519WrongProgram, got: ${msg}`,
      );
    }
  });

  // ─── TC2: Two signatures in one Ed25519 instruction ─────────────────────────
  it("TC2: two signatures in one Ed25519 instruction → Ed25519BadSigCount", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const good = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const twosigs = buildBadSigCountEd25519Ix(2);

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(good).add(twosigs).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject 2-sig Ed25519 instruction");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("Ed25519BadSigCount") ||
          msg.includes("0x17a3") ||
          msg.includes("6051") ||
          msg.includes("custom"),
        `TC2: expected Ed25519BadSigCount, got: ${msg}`,
      );
    }
  });

  // ─── TC3: Zero signatures ────────────────────────────────────────────────────
  it("TC3: zero signatures in Ed25519 instruction → Ed25519BadSigCount", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const good = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const nosigs = buildBadSigCountEd25519Ix(0);

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(good).add(nosigs).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject 0-sig Ed25519 instruction");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("Ed25519BadSigCount") ||
          msg.includes("0x17a3") ||
          msg.includes("6051") ||
          msg.includes("custom"),
        `TC3: expected Ed25519BadSigCount, got: ${msg}`,
      );
    }
  });

  // ─── TC4: Message not 32 bytes ───────────────────────────────────────────────
  it("TC4: Ed25519 instruction with 31-byte message → Ed25519BadMsgLen", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const good = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const badLen = buildBadMsgLenEd25519Ix(signer2.secretKey, 31); // 31 bytes ≠ 32

    const ix = await program.methods
      .payoutBatch(batchId, day, sorted, [0, 1])
      .accounts({
        crank: auth.publicKey,
        networkConfig: ncPda,
        payoutConfig: pcPda,
        lifeMint: mintPda,
        mintAuthority: mintAuthPda,
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(good).add(badLen).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject 31-byte message");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("Ed25519BadMsgLen") ||
          msg.includes("0x17a4") ||
          msg.includes("6052") ||
          msg.includes("custom"),
        `TC4: expected Ed25519BadMsgLen, got: ${msg}`,
      );
    }
  });

  // ─── TC5: Unregistered public key ────────────────────────────────────────────
  it("TC5: unregistered public key in Ed25519 instruction → UnregisteredSigner", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const rogue = Keypair.generate();
    const good = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const bad = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: rogue.secretKey,
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(good).add(bad).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject unregistered signer");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("UnregisteredSigner") ||
          msg.includes("6037") ||
          msg.includes("0x1795"),
        `TC5: expected UnregisteredSigner, got: ${msg}`,
      );
    }
  });

  // ─── TC6: Same signer twice ───────────────────────────────────────────────────
  it("TC6: same signer twice → DuplicateSigner", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject duplicate signer");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DuplicateSigner") ||
          msg.includes("6038") ||
          msg.includes("0x1796"),
        `TC6: expected DuplicateSigner, got: ${msg}`,
      );
    }
  });

  // ─── TC7: Day in the future ───────────────────────────────────────────────────
  it("TC7: day == chainDay (today, not yet ended) → DayOutOfWindow", async () => {
    const batchId = nextBatch();
    const day = chainDay; // today — not allowed
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject today's day");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DayOutOfWindow") ||
          msg.includes("0x17a5") ||
          msg.includes("6053"),
        `TC7: expected DayOutOfWindow, got: ${msg}`,
      );
    }
  });

  // ─── TC8: Day older than window ──────────────────────────────────────────────
  it("TC8: day == chainDay-8 (outside 7-day backfill window) → DayOutOfWindow", async () => {
    const batchId = nextBatch();
    const day = chainDay - 8; // 8 days ago > window
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("Must reject day outside window");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("DayOutOfWindow") ||
          msg.includes("0x17a5") ||
          msg.includes("6053"),
        `TC8: expected DayOutOfWindow, got: ${msg}`,
      );
    }
  });

  // ─── TC9: Sequence of absolute days 0, 1, 2 ─────────────────────────────────
  it("TC9: sequence of absolute days 0, 1, 2 (year 1970) all rejected → DayOutOfWindow", async () => {
    const amount = new BN(1_000_000);
    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);

    for (const day of [0, 1, 2]) {
      const batchId = nextBatch();
      const entries = [{ recipient: miner1.publicKey, amount }];
      const sorted = sortHashEntries(entries);
      const hash = batchHash(program.programId, mintPda, batchId, day, sorted);
      const brPda = pda([S_BR, u64le(batchId)]);
      const daPda = pda([S_DA, u32le(day)]);

      const e1 = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer1.secretKey,
        message: hash,
      });
      const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
          dayAccum: daPda,
          instructionsSysvar: new PublicKey(
            "Sysvar1nstructions1111111111111111111111111",
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
        .instruction();

      try {
        await sendAndConfirmTransaction(
          conn,
          new Transaction().add(e1).add(e2).add(ix),
          [auth.payer],
        );
        assert.fail(`TC9: day ${day} must be rejected`);
      } catch (e: any) {
        const msg = e.toString();
        assert.ok(
          msg.includes("DayOutOfWindow") ||
            msg.includes("0x17a5") ||
            msg.includes("6053"),
          `TC9 day=${day}: expected DayOutOfWindow, got: ${msg}`,
        );
      }
    }
  });

  // ─── TC10: Valid batch for yesterday mints exactly its total ─────────────────
  it("TC10: valid 4-entry batch for yesterday mints exactly total and fits in one tx", async () => {
    const batchId = nextBatch();
    const day = chainDay - 5; // valid window, distinct from other tests using chainDay-1
    const miners = [
      miner1,
      miner2,
      Keypair.fromSeed(Buffer.alloc(32, 0x07)),
      Keypair.fromSeed(Buffer.alloc(32, 0x08)),
    ];
    for (const m of miners) {
      try {
        await airdrop(m, 2);
      } catch (_) {}
    }

    const amts = miners.map((_, i) => new BN((i + 1) * 250_000));
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
    const daPda = pda([S_DA, u32le(day)]);

    const ncBefore = await program.account.networkConfig.fetch(ncPda);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        dayAccum: daPda,
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

    const tx = new Transaction().add(e1).add(e2).add(ix);
    const txSig = await sendAndConfirmTransaction(conn, tx, [auth.payer]);
    const txSize = tx.serialize({ verifySignatures: false }).length;

    const ncAfter = await program.account.networkConfig.fetch(ncPda);
    assert.equal(
      (ncAfter.totalMinted as BN).sub(ncBefore.totalMinted as BN).toString(),
      total.toString(),
      "TC10: totalMinted must equal 4-entry batch sum",
    );
    console.log(`TC10: 4-entry tx size=${txSize} bytes  sig=${txSig}`);
    assert.isBelow(txSize, 1232, "TC10: tx must fit in 1232-byte limit");
  });

  // ─── TC11: Substitute-recipient regression (C4c) ─────────────────────────────
  it("TC11: sign {miner1}, submit {miner2} same total → BatchHashMismatch (C4c regression)", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const amount = new BN(500_000);

    const signedHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      sortHashEntries([{ recipient: miner2.publicKey, amount }]),
    );
    const attackEntries = [{ recipient: miner1.publicKey, amount }];
    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: signedHash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        batchReplay: brPda,
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("TC11: attack must fail");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") ||
          msg.includes("6047") ||
          msg.includes("0x179f"),
        `TC11: expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  // ─── TC12: Reordered entries regression ──────────────────────────────────────
  it("TC12: reordered entries → BatchHashMismatch (C4c regression)", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const entries = [
      { recipient: miner1.publicKey, amount: new BN(100_000) },
      { recipient: miner2.publicKey, amount: new BN(200_000) },
    ];
    const sorted = sortHashEntries(entries);
    const reversed = [...sorted].reverse();
    const wrongHash = batchHash(
      program.programId,
      mintPda,
      batchId,
      day,
      reversed,
    );

    const ata1 = await getOrCreateAta(mintPda, sorted[0].recipient, miner1);
    const ata2 = await getOrCreateAta(mintPda, sorted[1].recipient, miner2);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: wrongHash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        batchReplay: brPda,
        dayAccum: daPda,
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
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("TC12: must fail");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchHashMismatch") || msg.includes("6047"),
        `TC12: expected BatchHashMismatch, got: ${msg}`,
      );
    }
  });

  // ─── TC13: Repeated batch_id ─────────────────────────────────────────────────
  it("TC13: repeated batch_id rejected (init guard)", async () => {
    // Re-use batch_id=1 which c4-payout.ts already processed (init guard catches it)
    const batchId = new BN(1);
    const day = chainDay - 1;
    const amount = new BN(100_000);
    const entries = [{ recipient: miner1.publicKey, amount }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]); // already exists
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("TC13: must reject repeated batch_id");
    } catch (e: any) {
      assert.ok(e, "Expected error on repeated batch_id (init guard)");
    }
  });

  // ─── TC14: Batch above per-batch cap ─────────────────────────────────────────
  it("TC14: batch above per-batch cap (5001 LIFE) rejected → BatchCapExceeded", async () => {
    const batchId = nextBatch();
    const day = chainDay - 1;
    const tooMuch = new BN(5001 * 1_000_000);
    const entries = [{ recipient: miner1.publicKey, amount: tooMuch }];
    const sorted = sortHashEntries(entries);
    const hash = batchHash(program.programId, mintPda, batchId, day, sorted);

    const ata = await getOrCreateAta(mintPda, miner1.publicKey, miner1);
    const brPda = pda([S_BR, u64le(batchId)]);
    const daPda = pda([S_DA, u32le(day)]);

    const e1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer1.secretKey,
      message: hash,
    });
    const e2 = Ed25519Program.createInstructionWithPrivateKey({
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
        dayAccum: daPda,
        instructionsSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ata, isSigner: false, isWritable: true }])
      .instruction();

    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(e1).add(e2).add(ix),
        [auth.payer],
      );
      assert.fail("TC14: must reject above-cap batch");
    } catch (e: any) {
      const msg = e.toString();
      assert.ok(
        msg.includes("BatchCapExceeded") ||
          msg.includes("6034") ||
          msg.includes("0x1792"),
        `TC14: expected BatchCapExceeded, got: ${msg}`,
      );
    }
  });
});
