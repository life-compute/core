use anchor_lang::prelude::*;
use crate::constants::*;

/// Difficulty tier of a cancer target — determines base $LIFE reward.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DifficultyTier {
    Easy,   // 1 LIFE
    Medium, // 5 LIFE
    Hard,   // 25 LIFE
}

impl DifficultyTier {
    /// Base reward in raw token units for this difficulty.
    pub fn base_reward_raw(&self) -> u64 {
        match self {
            DifficultyTier::Easy => REWARD_EASY,
            DifficultyTier::Medium => REWARD_MEDIUM,
            DifficultyTier::Hard => REWARD_HARD,
        }
    }

    /// Numeric tag emitted in events (0/1/2) for easy indexer parsing.
    pub fn as_u8(&self) -> u8 {
        match self {
            DifficultyTier::Easy => 0,
            DifficultyTier::Medium => 1,
            DifficultyTier::Hard => 2,
        }
    }
}

/// On-chain record for a registered cancer protein target.
/// PDA seeds: [SEED_TARGET, &[target_id]]
#[account]
pub struct TargetAccount {
    /// 0-indexed ID (0–9 for the initial 10 targets).
    pub target_id: u8,

    /// UniProt accession, null-padded to 10 bytes (e.g. b"P04637\0\0\0\0").
    pub uniprot_id: [u8; 10],

    pub difficulty: DifficultyTier,

    /// Whether this target is currently being assigned to miners.
    pub is_active: bool,

    /// Best affinity score submitted this week for this target.
    /// Negative ΔG (kcal/mol) — more negative = stronger binding = better.
    pub best_score_this_week: f32,

    /// Pubkey of the miner who holds the current weekly best score.
    pub best_scorer_this_week: Pubkey,

    /// Week number when `best_score_this_week` was set.
    pub week_number: u64,

    /// Cumulative count of confirmed results ever submitted for this target.
    pub total_confirmed: u64,

    pub bump: u8,
}

impl TargetAccount {
    pub const LEN: usize = 8
        + 1   // target_id
        + 10  // uniprot_id
        + 1   // difficulty (enum = 1 byte)
        + 1   // is_active
        + 4   // best_score_this_week (f32)
        + 32  // best_scorer_this_week
        + 8   // week_number
        + 8   // total_confirmed
        + 1   // bump
        + 32; // padding
}
