use anchor_lang::prelude::*;
use crate::constants::MAX_VALIDATORS_PER_RESULT;

/// Status lifecycle for a miner's result submission.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResultStatus {
    Pending,    // created, no validators yet
    Validating, // at least one validator has cast a vote
    Confirmed,  // validators_required met; scores within tolerance
    Rejected,   // majority of validators found a score discrepancy
}

/// A miner's molecule submission for one epoch job.
/// PDA seeds: [SEED_RESULT, epoch.to_le_bytes(), miner_pubkey.as_ref()]
#[account]
pub struct ResultSubmission {
    pub miner: Pubkey,
    pub target_id: u16,
    pub epoch: u64,

    /// SMILES string of the candidate molecule (max 512 chars, stored as
    /// a fixed-length byte array to keep the account size deterministic).
    pub smiles: [u8; 512],
    /// Actual length of the SMILES string stored in `smiles`.
    pub smiles_len: u16,

    /// Miner's claimed ΔG from Boltz2 (kcal/mol; negative = binding).
    pub claimed_affinity: f32,

    /// Slot at which the miner submitted.
    pub submitted_slot: i64,

    pub status: ResultStatus,

    /// Number of validators who have voted.
    pub validation_count: u8,

    /// Running sum of rescored affinities (for averaging after finalization).
    pub validation_score_sum: f32,

    /// Pubkeys of ALL validators who have voted (duplicate-vote guard).
    pub validator_list: [Pubkey; 5], // MAX_VALIDATORS_PER_RESULT

    /// Set to true once mint_reward has been called successfully.
    pub reward_minted: bool,

    /// Cumulative count of validators who independently confirmed this result.
    /// Finalization requires confirmed_count >= NetworkConfig.validators_required.
    pub confirmed_count: u8,

    /// Pubkeys of validators who voted IS_CONFIRMED.
    /// Populated in validate_result; read by mint_reward to split the 5% commission.
    pub confirming_validator_list: [Pubkey; 5], // MAX_VALIDATORS_PER_RESULT

    /// Number of entries in confirming_validator_list.
    pub confirming_validator_count: u8,

    pub bump: u8,
}

impl ResultSubmission {
    pub const LEN: usize = 8          // anchor discriminator
        + 32                          // miner
        + 2                           // target_id (u16)
        + 8                           // epoch
        + 512                         // smiles bytes
        + 2                           // smiles_len
        + 4                           // claimed_affinity (f32)
        + 8                           // submitted_slot
        + 1                           // status (enum)
        + 1                           // validation_count
        + 4                           // validation_score_sum (f32)
        + 32 * MAX_VALIDATORS_PER_RESULT // validator_list (all voters)
        + 1                           // reward_minted
        + 1                           // confirmed_count
        + 32 * MAX_VALIDATORS_PER_RESULT // confirming_validator_list
        + 1                           // confirming_validator_count
        + 1                           // bump
        + 32;                         // padding for future fields

    /// Return the SMILES as a &str slice (lossy if non-UTF8, but SMILES is ASCII).
    pub fn smiles_str(&self) -> &str {
        let len = self.smiles_len as usize;
        std::str::from_utf8(&self.smiles[..len]).unwrap_or("")
    }
}
