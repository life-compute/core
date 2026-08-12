use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::MinerRegistered;
use crate::state::MinerAccount;

/// Permissionless: any wallet can register as a miner by locking REGISTRATION_STAKE SOL.
///
/// Fix 3-A: requires 0.01 SOL minimum stake transferred into the MinerAccount PDA
/// to raise the cost of Sybil registration from ~0.002 SOL (rent only) to ~0.012 SOL.
/// This limits bulk registration to attackers willing to lock meaningful capital.
pub fn register_miner(ctx: Context<RegisterMiner>) -> Result<()> {
    // Transfer stake into the MinerAccount PDA (on top of rent)
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

    let miner = &mut ctx.accounts.miner_account;
    miner.owner            = ctx.accounts.miner.key();
    miner.total_life_earned = 0;
    miner.molecules_screened = 0;
    miner.last_epoch       = 0;
    miner.is_registered    = true;
    miner.bump             = ctx.bumps.miner_account;

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

    pub system_program: Program<'info, System>,
}
