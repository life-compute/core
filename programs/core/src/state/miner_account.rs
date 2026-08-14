use anchor_lang::prelude::*;

/// Per-miner on-chain record.
/// PDA seeds: [SEED_MINER, miner_pubkey.as_ref()]
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
        + 23; // padding
}
