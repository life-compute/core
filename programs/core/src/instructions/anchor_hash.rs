// C4: anchor_hash — records one 32-byte hash per calendar day, callable by the
// authority (or crank wallet in NetworkConfig.validators).  Immutable once written.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::state::{DayAnchor, NetworkConfig};

pub fn anchor_hash(ctx: Context<AnchorHash>, day: u32, hash: [u8; 32]) -> Result<()> {
    let caller = ctx.accounts.crank.key();
    let config = &ctx.accounts.network_config;

    // Only authority or a registered validator may call this.
    let is_auth = caller == config.authority;
    let is_validator = config.is_validator(&caller);
    require!(is_auth || is_validator, LifeError::Unauthorized);

    let anchor = &mut ctx.accounts.day_anchor;
    // `init` on day_anchor means a second call for the same `day` is rejected
    // by Anchor before this body runs.  The AnchorAlreadyWritten error is
    // belt-and-suspenders (it cannot be reached in practice).
    require!(anchor.hash == [0u8; 32], LifeError::AnchorAlreadyWritten);

    anchor.day = day;
    anchor.hash = hash;
    anchor.recorded_slot = Clock::get()?.slot;
    anchor.recorded_by = caller;
    anchor.bump = ctx.bumps.day_anchor;

    Ok(())
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct AnchorHash<'info> {
    /// Authority or registered validator.
    #[account(mut)]
    pub crank: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    /// DayAnchor PDA — created on first call; `init` rejects if already exists.
    #[account(
        init,
        payer = crank,
        space = DayAnchor::LEN,
        seeds = [SEED_DAY_ANCHOR, &day.to_le_bytes()],
        bump,
    )]
    pub day_anchor: Account<'info, DayAnchor>,

    pub system_program: Program<'info, System>,
}
