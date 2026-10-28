use anchor_lang::prelude::*;

/// C4 — Batch replay-protection account.
/// PDA seeds: [SEED_BATCH_REPLAY, batch_id_le (8 bytes)]
///
/// Created by `payout_batch`; its existence signals that `batch_id` has
/// already been processed.  The account is never closed after creation
/// (small-account rent is acceptable anti-replay storage).
///
/// `init` (not `init_if_needed`) on this account in `payout_batch` is the
/// replay guard: if it already exists the transaction is rejected before
/// the handler body runs.
#[account]
pub struct BatchReplay {
    /// The batch identifier that this account marks as consumed.
    pub batch_id: u64,

    /// Day number on which this batch was processed (for audit).
    pub day: u32,

    /// Total LIFE raw units minted in this batch.
    pub total_minted: u64,

    /// Canonical bump.
    pub bump: u8,
}

impl BatchReplay {
    pub const LEN: usize = 8
        + 8   // batch_id
        + 4   // day
        + 8   // total_minted
        + 1   // bump
        + 11; // padding to 40 bytes total
}
