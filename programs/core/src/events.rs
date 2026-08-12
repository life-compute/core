use anchor_lang::prelude::*;

// ─── LIFE Compute — on-chain events ───────────────────────────────────────
// All events are emitted via anchor's `emit!()` macro and can be consumed
// by off-chain indexers (Helius, Triton, custom websocket listeners).

#[event]
pub struct MinerRegistered {
    pub miner: Pubkey,
    pub slot: i64,
}

#[event]
pub struct TargetRegistered {
    pub target_id: u8,
    /// Null-padded UniProt accession bytes, e.g. b"P04637\0\0\0\0"
    pub uniprot_id: [u8; 10],
    pub difficulty: u8, // 0=Easy, 1=Medium, 2=Hard
}

#[event]
pub struct JobAssigned {
    pub miner: Pubkey,
    pub target_id: u8,
    pub epoch: u64,
    pub slot: i64,
}

#[event]
pub struct ResultSubmitted {
    pub miner: Pubkey,
    pub target_id: u8,
    pub epoch: u64,
    /// SMILES string of the best candidate molecule.
    pub smiles: String,
    /// Miner's claimed ΔG affinity score (kcal/mol; negative = better).
    pub claimed_affinity: f32,
    pub slot: i64,
}

#[event]
pub struct ValidationCast {
    pub validator: Pubkey,
    pub result_pda: Pubkey,
    pub rescored_affinity: f32,
    pub is_confirmed: bool,
    pub validation_count: u8,
    pub slot: i64,
}

#[event]
pub struct ResultFinalized {
    pub miner: Pubkey,
    pub result_pda: Pubkey,
    pub target_id: u8,
    /// 0=Confirmed, 1=Rejected
    pub status: u8,
    /// Average of all validator rescored affinities.
    pub avg_validator_score: f32,
    pub slot: i64,
}

#[event]
pub struct RewardMinted {
    pub miner: Pubkey,
    pub result_pda: Pubkey,
    pub target_id: u8,
    /// Base reward for this difficulty tier (before halving).
    pub base_reward_raw: u64,
    /// Final reward after both halving layers applied (raw units).
    pub amount_raw: u64,
    /// Supply milestone tier: 0=100%, 1=50%, 2=25%, 3=12.5%
    pub supply_tier: u8,
    /// Hit count tier: 0=100%, 1=75%, 2=50%
    pub hit_tier: u8,
    pub total_minted_after: u64,
    pub slot: i64,
}

#[event]
pub struct LeaderboardUpdated {
    pub week: u64,
    pub target_id: u8,
    pub new_leader: Pubkey,
    pub new_score: f32,
    pub prior_score: f32,
}

#[event]
pub struct DiscoveryBonusMinted {
    pub miner: Pubkey,
    pub week: u64,
    pub target_id: u8,
    pub amount_raw: u64,
    pub total_minted_after: u64,
    pub slot: i64,
}

#[event]
pub struct EpochAdvanced {
    pub old_epoch: u64,
    pub new_epoch: u64,
    pub slot: i64,
}
