// C38: update_payout_config — authority rotates signers, threshold, caps and backfill window.
//
// Validation mirrors initialize_payout_config:
//   • 1–3 distinct signers, no Pubkey::default(), no duplicate
//   • 1 ≤ threshold ≤ signer_count
//   • caps > 0
//   • backfill_window in [1, 30]  (same range used by day-window logic)
//
// Account size is unchanged (fits in the pre-existing 28-byte padding).

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::PayoutConfigUpdated;
use crate::state::{NetworkConfig, PayoutConfig};

/// Maximum allowed backfill window (days).
const MAX_BACKFILL_WINDOW: u32 = 30;
/// Minimum allowed backfill window (days).
const MIN_BACKFILL_WINDOW: u32 = 1;

pub fn update_payout_config(
    ctx: Context<UpdatePayoutConfig>,
    signers: Vec<Pubkey>,
    signer_count: u8,
    threshold: u8,
    cap_per_batch: u64,
    cap_per_day: u64,
    backfill_window: u32,
) -> Result<()> {
    // ── Authority check ─────────────────────────────────────────────────────
    require!(
        ctx.accounts.authority.key() == ctx.accounts.network_config.authority,
        LifeError::Unauthorized
    );

    // ── Signer-count coherence ───────────────────────────────────────────────
    require!(
        signer_count >= 1 && signer_count <= 3,
        LifeError::Unauthorized
    );
    require!(signers.len() == signer_count as usize, LifeError::Unauthorized);

    // ── Validate each key: no default, no duplicate ─────────────────────────
    let default_key = Pubkey::default();
    for (i, k) in signers.iter().enumerate() {
        require!(*k != default_key, LifeError::Unauthorized);
        for j in 0..i {
            require!(signers[j] != *k, LifeError::Unauthorized);
        }
    }

    // ── Threshold range ──────────────────────────────────────────────────────
    require!(
        threshold >= 1 && threshold <= signer_count,
        LifeError::Unauthorized
    );

    // ── Cap range ────────────────────────────────────────────────────────────
    require!(cap_per_batch > 0, LifeError::Unauthorized);
    require!(cap_per_day > 0, LifeError::Unauthorized);

    // ── Backfill window range ────────────────────────────────────────────────
    require!(
        backfill_window >= MIN_BACKFILL_WINDOW && backfill_window <= MAX_BACKFILL_WINDOW,
        LifeError::Unauthorized
    );

    // ── Apply ────────────────────────────────────────────────────────────────
    let pc = &mut ctx.accounts.payout_config;
    let mut arr = [Pubkey::default(); 3];
    for (i, k) in signers.iter().enumerate() {
        arr[i] = *k;
    }
    pc.signers = arr;
    pc.signer_count = signer_count;
    pc.threshold = threshold;
    pc.cap_per_batch = cap_per_batch;
    pc.cap_per_day = cap_per_day;
    pc.backfill_window = backfill_window;
    // paused flag and bump are left unchanged

    // ── Event ────────────────────────────────────────────────────────────────
    let clock = Clock::get()?;
    emit!(PayoutConfigUpdated {
        authority: ctx.accounts.authority.key(),
        signer_count,
        threshold,
        cap_per_batch,
        cap_per_day,
        backfill_window,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePayoutConfig<'info> {
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
