use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::MinerRegistered;
use crate::state::MinerAccount;

/// Permissionless: any wallet can register as a miner.
pub fn register_miner(ctx: Context<RegisterMiner>) -> Result<()> {
    let miner = &mut ctx.accounts.miner_account;
    miner.owner = ctx.accounts.miner.key();
    miner.total_life_earned = 0;
    miner.molecules_screened = 0;
    miner.last_epoch = 0;
    miner.is_registered = true;
    miner.bump = ctx.bumps.miner_account;

    emit!(MinerRegistered {
        miner: ctx.accounts.miner.key(),
        slot: Clock::get()?.slot as i64,
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
