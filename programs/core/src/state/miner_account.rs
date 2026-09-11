use anchor_lang::prelude::*;

/// Per-miner on-chain record.
/// PDA seeds: [SEED_MINER, miner_pubkey.as_ref()]
///
/// On-chain byte layout (98 bytes total):
///   [  0..  7]  discriminator      (8)
///   [  8.. 39]  owner              (32)
///   [ 40.. 47]  total_life_earned  (8)
///   [ 48.. 55]  molecules_screened (8)
///   [ 56.. 63]  last_epoch         (8)
///   [ 64]       is_registered      (1)
///   [ 65]       bump               (1)  ← canonical PDA bump; must stay at this offset
///   [ 66]       submission_count   (1)
///   [ 67.. 74]  submission_epoch   (8)
///   [ 75.. 97]  _reserved          (23) ← zero padding; field `multi_gpu` was inserted here
///                                        in a later program version but removed to preserve
///                                        the layout of accounts registered under the original
///                                        schema.  Do not reuse these bytes without a migration.
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
        + 23; // reserved padding — preserves 98-byte account size for pre-existing accounts
}
