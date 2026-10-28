// ─── LIFE Compute — constants ─────────────────────────────────────────────
use anchor_lang::prelude::Pubkey;

/// SPL token decimals.  "1 LIFE" = 1_000_000 raw units.
pub const LIFE_DECIMALS: u8 = 6;

/// 10^6 — one token unit (used to build reward amounts).
pub const ONE_LIFE: u64 = 1_000_000;

// ─── Supply model ─────────────────────────────────────────────────────────
//
// There is NO fixed supply cap.  Total supply is defined, at every moment, as
// `total_minted - total_burned`: a live, running figure, not a historical
// total and not a target.  It rises ONLY when real work is verified and mints
// new $LIFE through `mint_reward` (or the weekly discovery bonus), at a flat
// per-tier rate with no time-based reduction schedule.
//
// The `NetworkConfig::supply_cap` field is retained as a vestigial no-op for
// on-chain byte-layout compatibility with already-deployed accounts.  It is
// no longer read or enforced anywhere.  Do not reintroduce a cap check.

/// Epoch length in slots (~24 h at 400 ms/slot) — mainnet default.
pub const EPOCH_DURATION_SLOTS: u64 = 216_000;

/// Epoch length in slots for devnet testing (~6 min at 400 ms/slot).
/// Allows multiple submissions per hour when verifying the full pipeline.
pub const DEVNET_EPOCH_DURATION_SLOTS: u64 = 1_000;

/// Minimum validators required to confirm a result.
pub const VALIDATORS_REQUIRED: u8 = 2;

/// Maximum validators tracked per result (guards double-vote list size).
pub const MAX_VALIDATORS_PER_RESULT: usize = 5;

/// Rescoring tolerance: |rescored - claimed| / |claimed| ≤ this value.
/// 0.05 = ±5 % — accounts for Boltz2 stochasticity.
pub const VALIDATION_TOLERANCE: f32 = 0.05;

// ─── Reward amounts (raw token units at 6 decimals) ───────────────────────

/// Flat base rewards per difficulty tier.  No halving, no schedule, no decay
/// over time or supply.  These values are final and are the only emission
/// control in the protocol.
///
/// Rationale (2026-09): at realistic multi-miner scale (~2,000 miners x 3
/// submissions/epoch) the previous 25/5/1 scale emitted ~157,500 LIFE/epoch,
/// which would have exhausted the old 21,000,000 cap in well under two days at
/// the live 6.67-minute epoch length.  The Hard tier was reduced 25 -> 0.9
/// (a 27.78x cut); every other tier is scaled to preserve sane relativities.
pub const REWARD_EASY:      u64 = 300_000;             //   0.3   LIFE
pub const REWARD_MEDIUM:    u64 = 700_000;             //   0.7   LIFE
pub const REWARD_HARD:      u64 = 900_000;             //   0.9   LIFE
pub const REWARD_CRISPR:    u64 = 252_000;             //   0.252 LIFE (gRNA targets)
pub const REWARD_MRNA:      u64 = 900_000;             //   0.9   LIFE (mRNA silencing, always Hard)
pub const REWARD_DISCOVERY: u64 = 100 * ONE_LIFE;      // 100     LIFE (weekly discovery bonus — UNCHANGED)

/// Flat reference-compound reward (raw units).
/// Scaled from the previous 3 LIFE flat rate by the same ratio as the Hard
/// tier reduction: 3.0 x (0.9 / 25) = 0.108 LIFE.
pub const REWARD_REFERENCE: u64 = 108_000;             //   0.108 LIFE

/// Validator commission reward for confirming a CRISPR submission (raw units).
/// Held equal to REWARD_CRISPR so validators cannot out-earn miners on the
/// same unit of work.
pub const VALIDATOR_REWARD_CRISPR: u64 = 252_000;      //   0.252 LIFE

// ─── Max sizes ────────────────────────────────────────────────────────────

/// Maximum number of registered cancer targets (u16 → up to 65535).
/// 3010 = 2000 protein targets + 30 mRNA silencing targets (IDs 2000-2029)
///      + 10 CRISPR gRNA targets (IDs 3000-3009).
pub const MAX_TARGETS: u16 = 3010;

/// Maximum submissions a single miner may make per epoch.
/// Allows up to 3 bites at the apple per 24-hour epoch.
pub const MAX_SUBMISSIONS_PER_EPOCH: u8 = 3;

/// SMILES string character limit (covers 99%+ of known drugs).
pub const MAX_SMILES_LEN: usize = 512;

/// UniProt accession bytes (padded with NUL).
pub const UNIPROT_LEN: usize = 10;

// ─── PDA seeds ────────────────────────────────────────────────────────────

pub const SEED_NETWORK_CONFIG: &[u8] = b"network_config";
pub const SEED_LIFE_MINT: &[u8] = b"life_mint";
pub const SEED_TARGET: &[u8] = b"target";
pub const SEED_MINER: &[u8] = b"miner";
pub const SEED_JOB: &[u8] = b"job";
pub const SEED_RESULT: &[u8] = b"result";
pub const SEED_VALIDATION: &[u8] = b"validation";
pub const SEED_VALIDATOR_ACCOUNT: &[u8] = b"validator_account";
pub const SEED_LEADERBOARD: &[u8] = b"leaderboard";

/// PDA seed for ConfirmedMolecule deduplication accounts.
/// Seeds: [SEED_CONFIRMED_MOL, target_id_le_bytes (2), smiles_hash (32)]
pub const SEED_CONFIRMED_MOL: &[u8] = b"confirmed_mol";

// ─── Slots per week (~7 days at 400 ms/slot) ──────────────────────────────
pub const SLOTS_PER_WEEK: u64 = EPOCH_DURATION_SLOTS * 7; // 1_512_000

// ─── Emission control ─────────────────────────────────────────────────────
//
// Halving has been REMOVED ENTIRELY as an emission mechanism (2026-09):
//
//   * Layer 0 — epoch-based halving (HALVING_INTERVAL, checked_shr): REMOVED.
//     Rewards no longer decrease with time.  There is no schedule.
//
//   * Layer 1 — supply milestones (HALVING_MILESTONE_1/2/3): REMOVED.
//     These were defined as fractions of the old 21,000,000 cap.  With no cap
//     there is no milestone to measure against, and no supply-based reduction.
//
// The flat per-tier REWARD_* values above are now the ONLY emission control.
//
// Layer 2 (per-target hit count) is deliberately RETAINED below.  It is not a
// monetary schedule — it encodes scientific maturity: a target that has already
// been explored 1,000 times yields less new information per additional hit, so
// its reward tapers.  That taper is a property of the science, not of the token.

// ─── Reward taper: per-target hit count (Layer 2 — RETAINED) ──────────────

/// Below this many confirmed hits per target: 100% of tier reward.
pub const HALVING_HIT_TIER_1: u64 = 100;

/// At or above this many confirmed hits per target: 50% of tier reward.
/// Between HALVING_HIT_TIER_1 and this value: 75%.
pub const HALVING_HIT_TIER_2: u64 = 1_000;

// ─── Registration ─────────────────────────────────────────────────────────────

/// Minimum SOL locked in the MinerAccount PDA on registration (anti-Sybil stake).
/// 0.01 SOL = 10_000_000 lamports.  Recovered only if a close-account ix is added.
pub const REGISTRATION_STAKE: u64 = 10_000_000;

/// First N miners register for free; miner N+1 onwards pays MINER_REGISTRATION_FEE.
pub const FREE_MINER_SLOTS: u64 = 20;

/// Fee paid by miner #21+ directly to the foundation wallet (0.033 SOL ≈ $5).
/// This is on top of the REGISTRATION_STAKE which goes into the miner's PDA.
pub const MINER_REGISTRATION_FEE: u64 = 33_000_000; // lamports

/// Fee paid by multi-GPU miners (2+ GPUs) on registration (0.1 SOL = ~$15).
pub const MULTI_GPU_REGISTRATION_FEE: u64 = 100_000_000; // lamports

/// Fee paid by every validator on self-registration (0.05 SOL ≈ $5), sent directly to
/// the foundation wallet.
pub const VALIDATOR_REGISTRATION_FEE: u64 = 50_000_000; // lamports

/// Registration-fee recipient — a single build-time constant that differs
/// by cluster so the same source can target devnet/test or mainnet without
/// any runtime switch.
///
/// Devnet / localnet / test builds (default feature set):
///   8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84
/// Mainnet build (feature "mainnet"):
///   AGKvdA3ipuyparVHQi4n7XAhzPsSU4ukp3u7dUg2z3wm
///
/// Every build prints this address in the program's startup log so you can
/// compare it character by character against the expected value.
///
/// Users of this constant:
///   1. `register_miner`    — fee from miner #21+   → REGISTRATION_FEE_RECIPIENT
///   2. `register_validator`— validator fee          → REGISTRATION_FEE_RECIPIENT
///
/// The old FOUNDATION_WALLET constant (2jVdMx7…) is replaced by this one.
/// It remains defined below only as a compatibility alias used in tests that
/// have already been written against that address; do NOT introduce new uses.
#[cfg(not(feature = "mainnet"))]
pub const REGISTRATION_FEE_RECIPIENT: Pubkey = Pubkey::new_from_array([
    // 8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84
    109, 126, 2, 246, 136, 111, 99, 133, 47, 54, 226, 11, 234, 193, 186, 41,
    208, 20, 130, 152, 124, 44, 247, 195, 13, 154, 64, 24, 243, 116, 68, 117,
]);

#[cfg(feature = "mainnet")]
pub const REGISTRATION_FEE_RECIPIENT: Pubkey = Pubkey::new_from_array([
    // AGKvdA3ipuyparVHQi4n7XAhzPsSU4ukp3u7dUg2z3wm
    137, 166, 74, 226, 151, 242, 84, 175, 202, 215, 45, 185, 10, 110, 73, 199,
    38, 137, 79, 44, 221, 253, 227, 42, 244, 220, 115, 23, 152, 253, 82, 200,
]);

/// Legacy alias — kept so old tests that still reference FOUNDATION_WALLET
/// compile without changes.  Points to the same cluster-appropriate address.
pub use REGISTRATION_FEE_RECIPIENT as FOUNDATION_WALLET;

// ─── C4: Payout / coordinator constants ───────────────────────────────────────

/// Maximum LIFE raw units mintable per single `payout_batch` call (5,000 LIFE).
pub const CAP_PER_BATCH: u64 = 5_000 * ONE_LIFE;

/// Maximum LIFE raw units mintable across all batches in one calendar day
/// (5,000 LIFE).  Enforced via a DayAccum PDA; resets each new day.
pub const CAP_PER_DAY: u64 = 5_000 * ONE_LIFE;

/// Initial payout signer threshold (2-of-2 → 2-of-3 expansion target).
pub const PAYOUT_THRESHOLD: u8 = 2;

// ─── PDA seeds (C4 additions) ─────────────────────────────────────────────────

pub const SEED_PAYOUT_CONFIG: &[u8] = b"payout_config";
pub const SEED_BATCH_REPLAY: &[u8] = b"batch_replay";
pub const SEED_DAY_ACCUM: &[u8] = b"day_accum";
pub const SEED_DAY_ANCHOR: &[u8] = b"day_anchor";

// ─── Registration (updated C4 values) ────────────────────────────────────────

/// New anti-Sybil stake: 0.05 SOL (was 0.01 SOL).
/// Recovered via `unstake_miner` when leaving in good standing.
pub const REGISTRATION_STAKE_C4: u64 = 50_000_000; // lamports

/// Holdback period in slots before stake can be withdrawn (~7 days at 400ms/slot).
/// Gives validators time to flag any disputed activity.
pub const UNSTAKE_HOLDBACK_SLOTS: u64 = 1_512_000; // ~7 days

