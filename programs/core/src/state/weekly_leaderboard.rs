use anchor_lang::prelude::*;

/// Tracks the best-scoring molecule per target per week.
/// Used to gate discovery bonus minting.
/// PDA seeds: [SEED_LEADERBOARD, week.to_le_bytes(), &[target_id]]
#[account]
#[derive(Default)]
pub struct WeeklyLeaderboard {
    pub week: u64,
    pub target_id: u8,

    /// Pubkey of the miner with the best score this week for this target.
    pub leader_miner: Pubkey,

    /// Best ΔG score recorded (kcal/mol; more negative = better).
    pub leader_score: f32,

    /// Set to true once the 100 LIFE discovery bonus has been minted.
    pub bonus_minted: bool,

    pub bump: u8,
}

impl WeeklyLeaderboard {
    pub const LEN: usize = 8
        + 8  // week
        + 1  // target_id
        + 32 // leader_miner
        + 4  // leader_score (f32)
        + 1  // bonus_minted
        + 1  // bump
        + 16; // padding
}
