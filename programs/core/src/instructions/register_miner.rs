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
///     directly to the foundation wallet.
///
/// On top of any fee, REGISTRATION_STAKE (0.01 SOL) is locked into the miner's
/// PDA as an anti-Sybil measure.
pub fn register_miner(ctx: Context<RegisterMiner>, gpu_count: u8) -> Result<()> {
    let current_count = ctx.accounts.network_config.total_miners_registered;

    let is_multi_gpu = gpu_count >= 2;
    let fee = if is_multi_gpu { MULTI_GPU_REGISTRATION_FEE } else { MINER_REGISTRATION_FEE };

    // ── Task 1: paid registration from miner #21 onward ──────────────────────
    if current_count >= FREE_MINER_SLOTS {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.miner.to_account_info(),
                    to:   ctx.accounts.foundation.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    // ── Anti-Sybil stake into the MinerAccount PDA ───────────────────────────
    require!(
        ctx.accounts.miner.lamports() >= REGISTRATION_STAKE,
        LifeError::InsufficientStake
    );

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.miner.to_account_info(),
                to:   ctx.accounts.miner_account.to_account_info(),
            },
        ),
        REGISTRATION_STAKE,
    )?;

    // ── Increment global miner counter ────────────────────────────────────────
    ctx.accounts.network_config.total_miners_registered = current_count
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    let miner = &mut ctx.accounts.miner_account;
    miner.owner             = ctx.accounts.miner.key();
    miner.total_life_earned = 0;
    miner.molecules_screened = 0;
    miner.last_epoch        = 0;
    miner.is_registered     = true;
    miner.multi_gpu         = is_multi_gpu;
    miner.bump              = ctx.bumps.miner_account;

    emit!(MinerRegistered {
        miner: ctx.accounts.miner.key(),
        slot:  Clock::get()?.slot as i64,
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

    /// Foundation wallet — receives registration fee from miner #21+.
    /// Verified against the hardcoded FOUNDATION_WALLET constant.
    #[account(
        mut,
        constraint = foundation.key() == FOUNDATION_WALLET @ LifeError::Unauthorized,
    )]
    /// CHECK: externally-owned foundation wallet; no data expected.
    pub foundation: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
