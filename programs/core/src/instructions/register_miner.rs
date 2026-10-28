use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::MinerRegistered;
use crate::state::{MinerAccount, NetworkConfig};

/// Permissionless: any wallet can register as a miner.
///
/// Fee schedule:
///   • Miners 1–FREE_MINER_SLOTS (first 20): register free.
///   • Miner FREE_MINER_SLOTS+1 onwards: pays MINER_REGISTRATION_FEE (0.033 SOL)
///     directly to REGISTRATION_FEE_RECIPIENT.
///
/// C4 stake: REGISTRATION_STAKE_C4 (0.05 SOL) is locked into the miner's PDA.
/// Recovered via `unstake_miner` when leaving in good standing after the
/// UNSTAKE_HOLDBACK_SLOTS holdback has been served.
///
/// Fee-recipient address (build-time constant, printed in initialize_payout_config log):
///   devnet/test:  8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84
///   mainnet:      AGKvdA3ipuyparVHQi4n7XAhzPsSU4ukp3u7dUg2z3wm
pub fn register_miner(ctx: Context<RegisterMiner>) -> Result<()> {
    let current_count = ctx.accounts.network_config.total_miners_registered;

    // ── Task 1: paid registration from miner #21 onward ──────────────────────
    if current_count >= FREE_MINER_SLOTS {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.miner.to_account_info(),
                    to:   ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            MINER_REGISTRATION_FEE,
        )?;
    }

    // ── Anti-Sybil stake into the MinerAccount PDA (C4: 0.05 SOL) ────────────
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.miner.to_account_info(),
                to:   ctx.accounts.miner_account.to_account_info(),
            },
        ),
        REGISTRATION_STAKE_C4,
    )?;

    // ── Increment global miner counter ────────────────────────────────────────
    ctx.accounts.network_config.total_miners_registered = current_count
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    let clock = Clock::get()?;
    let miner = &mut ctx.accounts.miner_account;
    miner.owner                  = ctx.accounts.miner.key();
    miner.total_life_earned      = 0;
    miner.molecules_screened     = 0;
    miner.last_epoch             = 0;
    miner.is_registered          = true;
    miner.bump                   = ctx.bumps.miner_account;
    miner.stake_returned         = false;
    miner.failed_verification    = false;
    miner.open_dispute           = false;
    // Holdback: stake withdrawable after UNSTAKE_HOLDBACK_SLOTS from registration.
    miner.stake_locked_until_slot = clock.slot
        .checked_add(UNSTAKE_HOLDBACK_SLOTS)
        .unwrap_or(u64::MAX);

    emit!(MinerRegistered {
        miner: ctx.accounts.miner.key(),
        slot:  clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RegisterMiner<'info> {
    #[account(mut)]
    pub miner: Signer<'info>,

    #[account(
        init,
        payer = miner,
        space = MinerAccount::LEN,
        seeds = [SEED_MINER, miner.key().as_ref()],
        bump,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    /// Global config — needed to read and increment total_miners_registered.
    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    /// Fee recipient for miner #21+.
    /// Verified against REGISTRATION_FEE_RECIPIENT (cluster-specific build constant).
    /// devnet/test: 8NQtHtcA839wPSfphsAuPCbfCajvFY5tmcWXKWsk1L84
    /// mainnet:     AGKvdA3ipuyparVHQi4n7XAhzPsSU4ukp3u7dUg2z3wm
    #[account(
        mut,
        constraint = fee_recipient.key() == REGISTRATION_FEE_RECIPIENT @ LifeError::Unauthorized,
    )]
    /// CHECK: externally-owned wallet; no data expected.
    pub fee_recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
