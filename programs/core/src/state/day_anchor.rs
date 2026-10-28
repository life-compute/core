use anchor_lang::prelude::*;

/// C4 — Per-day anchor hash record.
/// PDA seeds: [SEED_DAY_ANCHOR, day_le (4 bytes)]
///
/// Written once by `anchor_hash` (callable by the authorised crank only).
/// Immutable after creation: the `init` constraint on the account means any
/// second call for the same `day` will be rejected before the handler runs.
///
/// Typically stores the Merkle root of all payout entries for a day, or
/// any other commitment the off-chain coordinator wants to anchor on-chain.
#[account]
pub struct DayAnchor {
    /// The day number this hash covers.
    pub day: u32,

    /// The 32-byte hash (e.g. SHA-256 Merkle root of daily payout entries).
    pub hash: [u8; 32],

    /// Slot at which the hash was recorded (audit trail).
    pub recorded_slot: u64,

    /// Who called `anchor_hash` (must be authority or registered crank).
    pub recorded_by: Pubkey,

    /// Canonical bump.
    pub bump: u8,
}

impl DayAnchor {
    pub const LEN: usize = 8
        + 4   // day
        + 32  // hash
        + 8   // recorded_slot
        + 32  // recorded_by
        + 1   // bump
        + 7; // padding to 92 bytes
}
