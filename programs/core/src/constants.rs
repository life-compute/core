// ─── LIFE Compute — constants ─────────────────────────────────────────────

/// SPL token decimals.  "1 LIFE" = 1_000_000 raw units.
pub const LIFE_DECIMALS: u8 = 6;

/// 10^6 — one token unit (used to build reward amounts).
pub const ONE_LIFE: u64 = 1_000_000;

/// Fixed supply cap: 21,000,000 LIFE (raw units).
pub const SUPPLY_CAP_RAW: u64 = 21_000_000 * ONE_LIFE;

/// Epoch length in slots (~24 h at 400 ms/slot).
pub const EPOCH_DURATION_SLOTS: u64 = 216_000;

/// Minimum validators required to confirm a result.
pub const VALIDATORS_REQUIRED: u8 = 2;

/// Maximum validators tracked per result (guards double-vote list size).
pub const MAX_VALIDATORS_PER_RESULT: usize = 5;

/// Rescoring tolerance: |rescored - claimed| / |claimed| ≤ this value.
/// 0.05 = ±5 % — accounts for Boltz2 stochasticity.
pub const VALIDATION_TOLERANCE: f32 = 0.05;

// ─── Reward amounts (raw token units at 6 decimals) ───────────────────────

pub const REWARD_EASY: u64 = ONE_LIFE;           //   1 LIFE
pub const REWARD_MEDIUM: u64 = 5 * ONE_LIFE;     //   5 LIFE
pub const REWARD_HARD: u64 = 25 * ONE_LIFE;      //  25 LIFE
pub const REWARD_DISCOVERY: u64 = 100 * ONE_LIFE; // 100 LIFE

// ─── Max sizes ────────────────────────────────────────────────────────────

/// Maximum number of registered cancer targets.
pub const MAX_TARGETS: u8 = 10;

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
pub const SEED_LEADERBOARD: &[u8] = b"leaderboard";

// ─── Slots per week (~7 days at 400 ms/slot) ──────────────────────────────
pub const SLOTS_PER_WEEK: u64 = EPOCH_DURATION_SLOTS * 7; // 1_512_000
