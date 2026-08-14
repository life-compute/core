use anchor_lang::prelude::*;

/// Per-validator reputation and lifetime stats.
/// PDA seeds: [SEED_VALIDATOR_ACCOUNT, validator_pubkey.as_ref()]
///
/// Created automatically when a validator first calls validate_result.
/// Reputation = confirmations / total_validations.
/// Validators with reputation < 0.5 after >= MIN_VALIDATIONS_FOR_EVICTION
/// are removed from the active pool by the next authority call to
/// update_validators.
#[account]
#[derive(Default)]
pub struct ValidatorAccount {
    pub validator: Pubkey,

    /// Total number of validation votes cast.
    pub total_validations: u64,

    /// Validations where the result was finalized as Confirmed AND
    /// this validator's vote agreed with the majority verdict.
    pub confirmations: u64,

    /// Reputation: confirmations / total_validations.
    /// Stored as a scaled integer (reputation_bps = confirmations * 10000 / total).
    /// 10000 = 100%, 5000 = 50%, etc. Default 10000 (new validators start trusted).
    pub reputation_bps: u16,

    /// Slot of the most recent validation cast by this validator.
    pub last_active_slot: i64,

    /// Whether this validator is currently in the active NetworkConfig.validators pool.
    pub is_active: bool,

    pub bump: u8,
}

impl ValidatorAccount {
    pub const LEN: usize = 8
        + 32 // validator
        + 8  // total_validations
        + 8  // confirmations
        + 2  // reputation_bps
        + 8  // last_active_slot
        + 1  // is_active
        + 1  // bump
        + 24; // padding

    /// Reputation as a float 0.0–1.0. Returns 1.0 for new validators (no data yet).
    pub fn reputation_f32(&self) -> f32 {
        self.reputation_bps as f32 / 10_000.0
    }

    /// Recompute reputation_bps from accumulated counters.
    pub fn recompute_reputation(&mut self) {
        if self.total_validations == 0 {
            self.reputation_bps = 10_000; // default: fully trusted
        } else {
            self.reputation_bps =
                ((self.confirmations * 10_000) / self.total_validations) as u16;
        }
    }
}

/// Minimum validations before reputation can trigger eviction.
/// Protects new validators from premature removal.
pub const MIN_VALIDATIONS_FOR_EVICTION: u64 = 10;

/// Reputation threshold below which a validator is evicted from the active pool.
/// 5000 bps = 0.50 = 50% agreement rate.
pub const EVICTION_THRESHOLD_BPS: u16 = 5_000;
