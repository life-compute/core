use anchor_lang::prelude::*;

/// Per-miner on-chain record.
/// PDA seeds: [SEED_MINER, miner_pubkey.as_ref()]
///
/// On-chain byte layout (now 128 bytes total):
///   [  0..  7]  discriminator           (8)
///   [  8.. 39]  owner                   (32)
///   [ 40.. 47]  total_life_earned       (8)
///   [ 48.. 55]  molecules_screened      (8)
///   [ 56.. 63]  last_epoch              (8)
///   [ 64]       is_registered           (1)
///   [ 65]       bump                    (1)  ← canonical PDA bump; must stay at this offset
///   [ 66]       submission_count        (1)
///   [ 67.. 74]  submission_epoch        (8)
///   [ 75.. 97]  _reserved               (23) ← zero padding
///   [ 98]       stake_returned          (1)  ← C4: set by unstake_miner
///   [ 99]       failed_verification     (1)  ← C4: set by validate_result on rejection
///   [100]       open_dispute            (1)  ← C4: set by dispute mechanism
///   [101..108]  stake_locked_until_slot (8)  ← C4: holdback end slot
///   [109..127]  _reserved_c4            (19) ← padding
#[account]
#[derive(Default)]
pub struct MinerAccount {
    /// The wallet pubkey that owns this account.
    pub owner: Pubkey,

    /// Cumulative raw $LIFE earned (for dashboard display).
    pub total_life_earned: u64,

    /// Total molecules (SMILES submissions) that were confirmed by validators.
    pub molecules_screened: u64,

    /// Epoch number of the miner's most recent job assignment.
    pub last_epoch: u64,

    pub is_registered: bool,

    pub bump: u8,

    /// How many times this miner has submitted in the current epoch.
    /// Reset to 0 when submission_epoch < current_epoch.
    pub submission_count: u8,

    /// The epoch for which submission_count applies.
    /// When this differs from current_epoch, submission_count is stale.
    pub submission_epoch: u64,

    // ─── C4: Unstake fields ───────────────────────────────────────────────────
    /// True once `unstake_miner` has returned the registration stake.
    /// Prevents double-unstake.
    pub stake_returned: bool,

    /// True if this miner has a failed verification that has not been cleared.
    /// Set by `validate_result` when the result is Rejected and cleared by admin.
    pub failed_verification: bool,

    /// True if this miner has an open dispute.
    /// Reserved for future dispute mechanism; always false in C4.
    pub open_dispute: bool,

    /// The slot at which the registration stake becomes withdrawable.
    /// Set to `Clock::slot + UNSTAKE_HOLDBACK_SLOTS` on last activity.
    /// Zero means no holdback has been set (stake withdrawable immediately once
    /// UNSTAKE_HOLDBACK_SLOTS have elapsed from registration).
    pub stake_locked_until_slot: u64,
}

impl MinerAccount {
    pub const LEN: usize = 8
        + 32 // owner
        + 8  // total_life_earned
        + 8  // molecules_screened
        + 8  // last_epoch
        + 1  // is_registered
        + 1  // bump
        + 1  // submission_count
        + 8  // submission_epoch
        + 23 // reserved padding (preserves pre-C4 byte offsets)
        + 1  // stake_returned
        + 1  // failed_verification
        + 1  // open_dispute
        + 8  // stake_locked_until_slot
        + 19; // padding (C4)
}
