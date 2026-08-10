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
}

impl MinerAccount {
    pub const LEN: usize = 8
        + 32 // owner
        + 8  // total_life_earned
        + 8  // molecules_screened
        + 8  // last_epoch
        + 1  // is_registered
        + 1  // bump
        + 32; // padding
}
