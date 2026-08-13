use anchor_lang::prelude::*;
use crate::state::NetworkConfig;
use crate::errors::LifeError;
use crate::constants::SEED_NETWORK_CONFIG;

/// Update the validator set and related consensus params.
/// Only callable by the original `authority` set during `initialize`.
pub fn update_validators(
    ctx: Context<UpdateValidators>,
    new_validators: Vec<Pubkey>,
    validators_required: u8,
) -> Result<()> {
    require!(new_validators.len() <= 5, LifeError::Unauthorized);
    require!(validators_required >= 1, LifeError::Unauthorized);
    require!(validators_required as usize <= new_validators.len(), LifeError::Unauthorized);

    let config = &mut ctx.accounts.network_config;
    config.validator_count = new_validators.len() as u8;
    config.validators_required = validators_required;

    let mut validators = [Pubkey::default(); 5];
    for (i, v) in new_validators.iter().enumerate() {
        validators[i] = *v;
    }
    config.validators = validators;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateValidators<'info> {
    /// Must be the authority recorded in NetworkConfig.
    #[account(
        constraint = authority.key() == network_config.authority @ LifeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,
}
