// C38: set_payout_caps — authority adjusts per-batch cap, per-day cap, and the paused flag.
//
// The paused flag is stored in PayoutConfig::paused (formerly padding[0]).
// Existing accounts have zero there → not paused (backward-compatible).
// While paused, payout_batch returns PayoutPaused immediately.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::PayoutCapsSet;
use crate::state::{NetworkConfig, PayoutConfig};

pub fn set_payout_caps(
    ctx: Context<SetPayoutCaps>,
    cap_per_batch: u64,
    cap_per_day: u64,
    paused: bool,
) -> Result<()> {
    // ── Authority check ─────────────────────────────────────────────────────
    require!(
        ctx.accounts.authority.key() == ctx.accounts.network_config.authority,
        LifeError::Unauthorized
    );

    // ── Cap range ────────────────────────────────────────────────────────────
    require!(cap_per_batch > 0, LifeError::Unauthorized);
    require!(cap_per_day > 0, LifeError::Unauthorized);

    // ── Apply ────────────────────────────────────────────────────────────────
    let pc = &mut ctx.accounts.payout_config;
    pc.cap_per_batch = cap_per_batch;
    pc.cap_per_day = cap_per_day;
    pc.paused = if paused { 1 } else { 0 };

    // ── Event ────────────────────────────────────────────────────────────────
    let clock = Clock::get()?;
    emit!(PayoutCapsSet {
        authority: ctx.accounts.authority.key(),
        cap_per_batch,
        cap_per_day,
        paused,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetPayoutCaps<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    #[account(
        mut,
        seeds = [SEED_PAYOUT_CONFIG],
        bump = payout_config.bump,
    )]
    pub payout_config: Account<'info, PayoutConfig>,
}
