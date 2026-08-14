use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::state::{NetworkConfig, ValidatorAccount, MIN_VALIDATIONS_FOR_EVICTION, EVICTION_THRESHOLD_BPS};

/// Authority-callable: evict a validator whose reputation has fallen below the threshold.
/// Conditions (all must hold):
///   - validator_account.total_validations >= MIN_VALIDATIONS_FOR_EVICTION
///   - validator_account.reputation_bps < EVICTION_THRESHOLD_BPS
///   - validator is currently in NetworkConfig.validators
pub fn evict_validator(ctx: Context<EvictValidator>) -> Result<()> {
    let va = &mut ctx.accounts.validator_account;
    let config = &mut ctx.accounts.network_config;

    require!(
        va.total_validations >= MIN_VALIDATIONS_FOR_EVICTION,
        LifeError::InsufficientValidationHistory
    );
    require!(
        va.reputation_bps < EVICTION_THRESHOLD_BPS,
        LifeError::ReputationAboveThreshold
    );

    let target_key = ctx.accounts.validator_key.key();

    // Remove from NetworkConfig.validators array (compact by shifting left)
    let mut found = false;
    let count = config.validator_count as usize;
    for i in 0..count {
        if config.validators[i] == target_key {
            // Shift remaining validators left
            for j in i..count.saturating_sub(1) {
                config.validators[j] = config.validators[j + 1];
            }
            config.validators[count.saturating_sub(1)] = Pubkey::default();
            config.validator_count = config.validator_count.saturating_sub(1);
            found = true;
            break;
        }
    }
    require!(found, LifeError::ValidatorNotFound);

    va.is_active = false;

    msg!(
        "Evicted validator {} — reputation {}/10000 ({} validations)",
        target_key,
        va.reputation_bps,
        va.total_validations
    );

    Ok(())
}

#[derive(Accounts)]
pub struct EvictValidator<'info> {
    /// Only the authority may evict validators.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
        has_one = authority @ LifeError::Unauthorized,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    /// CHECK: We only read the pubkey to find it in the validators array.
    pub validator_key: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [SEED_VALIDATOR_ACCOUNT, validator_key.key().as_ref()],
        bump = validator_account.bump,
    )]
    pub validator_account: Account<'info, ValidatorAccount>,
}
