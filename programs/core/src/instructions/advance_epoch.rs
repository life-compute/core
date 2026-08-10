use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::EpochAdvanced;
use crate::state::NetworkConfig;

/// Permissionless crank: advances the epoch once enough slots have elapsed.
pub fn advance_epoch(ctx: Context<AdvanceEpoch>) -> Result<()> {
    let config = &mut ctx.accounts.network_config;
    let clock = Clock::get()?;
    let current_slot = clock.slot as i64;

    let elapsed = current_slot
        .checked_sub(config.epoch_start_slot)
        .ok_or(LifeError::Overflow)?;
    require!(
        elapsed >= config.epoch_duration_slots as i64,
        LifeError::EpochNotReady
    );

    let old_epoch = config.current_epoch;
    config.current_epoch = config
        .current_epoch
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;
    config.epoch_start_slot = current_slot;

    emit!(EpochAdvanced {
        old_epoch,
        new_epoch: config.current_epoch,
        slot: current_slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AdvanceEpoch<'info> {
    /// Anyone can advance the epoch — permissionless crank.
    pub crank: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,
}
