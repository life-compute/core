use anchor_lang::prelude::*;

/// C4 — Per-day minted-LIFE accumulator.
/// PDA seeds: [SEED_DAY_ACCUM, day_le (4 bytes)]
///
/// Tracks total LIFE minted across all batches on a given calendar day.
/// `payout_batch` uses this to enforce `PayoutConfig::cap_per_day`.
/// Created lazily on the first batch of each day via `init_if_needed`.
#[account]
#[derive(Default)]
pub struct DayAccum {
    /// The day number this accumulator covers (e.g. Unix epoch / 86400).
    pub day: u32,

    /// Raw LIFE units minted so far today.
    pub day_minted: u64,

    /// Canonical bump.
    pub bump: u8,
}

impl DayAccum {
    pub const LEN: usize = 8
        + 4   // day
        + 8   // day_minted
        + 1   // bump
        + 19; // padding to 40 bytes
}
