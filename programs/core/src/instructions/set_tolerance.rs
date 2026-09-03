use anchor_lang::prelude::*;
use crate::state::NetworkConfig;
use crate::errors::LifeError;
use crate::constants::SEED_NETWORK_CONFIG;

/// Set the validation_tolerance field on NetworkConfig.
/// Only callable by the upgrade authority recorded at initialize time.
/// Does not touch validators, validators_required, or any other state.
pub fn set_tolerance(ctx: Context<SetTolerance>, validation_tolerance: f32) -> Result<()> {
    require!(validation_tolerance.is_finite(), LifeError::InvalidAffinityScore);
    require!(validation_tolerance >= 0.0, LifeError::Unauthorized);

    ctx.accounts.network_config.validation_tolerance = validation_tolerance;
    Ok(())
}

#[derive(Accounts)]
pub struct SetTolerance<'info> {
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
