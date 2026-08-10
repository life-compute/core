use anchor_lang::prelude::*;

/// A single validator's rescoring verdict for one result.
/// PDA seeds: [SEED_VALIDATION, result_pda.as_ref(), validator_pubkey.as_ref()]
#[account]
pub struct ValidationRecord {
    pub validator: Pubkey,
    pub result_pda: Pubkey,

    /// The affinity score the validator got when they re-ran Boltz2.
    pub rescored_affinity: f32,

    /// True if |rescored - claimed| / |claimed| ≤ validation_tolerance.
    pub is_confirmed: bool,

    pub validated_slot: i64,

    pub bump: u8,
}

impl ValidationRecord {
    pub const LEN: usize = 8
        + 32 // validator
        + 32 // result_pda
        + 4  // rescored_affinity (f32)
        + 1  // is_confirmed
        + 8  // validated_slot
        + 1  // bump
        + 16; // padding
}
