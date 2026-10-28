// C4: unstake_miner — returns the 0.05 SOL registration stake to a miner
// who is leaving the network in good standing.
//
// Good standing requires:
//   1. No failed_verification flag set on the MinerAccount.
//   2. No open_dispute flag set.
//   3. stake_locked_until_slot ≤ current slot (holdback served).
//   4. Stake has not already been returned (stake_returned == false).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::*;
use crate::errors::LifeError;
use crate::state::MinerAccount;

pub fn unstake_miner(ctx: Context<UnstakeMiner>) -> Result<()> {
    let miner_account = &mut ctx.accounts.miner_account;
    let clock = Clock::get()?;

    require!(!miner_account.failed_verification, LifeError::FailedVerificationOpen);
    require!(!miner_account.open_dispute, LifeError::OpenDisputeExists);
    require!(!miner_account.stake_returned, LifeError::AlreadyUnstaked);

    // Holdback check: if stake_locked_until_slot was set (> 0), it must have elapsed.
    if miner_account.stake_locked_until_slot > 0 {
        require!(
            clock.slot >= miner_account.stake_locked_until_slot,
            LifeError::HoldbackNotServed
        );
    }

    // Mark before CPI (CEI pattern).
    miner_account.stake_returned = true;

    // Transfer REGISTRATION_STAKE_C4 lamports from the miner_account PDA back to
    // the miner wallet.
    //
    // We cannot use system_program::transfer from a PDA that Anchor manages as a
    // deserialized account in the same ctx — we must manipulate lamports directly.
    // This is the standard pattern for returning lamports from a PDA to a signer.
    let stake = REGISTRATION_STAKE_C4;
    let miner_account_ai = ctx.accounts.miner_account.to_account_info();
    let miner_ai = ctx.accounts.miner.to_account_info();

    // Defensive: confirm the PDA holds enough lamports.
    require!(
        miner_account_ai.lamports() >= stake,
        LifeError::InsufficientStake
    );

    **miner_account_ai.try_borrow_mut_lamports()? -= stake;
    **miner_ai.try_borrow_mut_lamports()? += stake;

    Ok(())
}

#[derive(Accounts)]
pub struct UnstakeMiner<'info> {
    /// The miner reclaiming their stake — must be the MinerAccount owner.
    #[account(mut)]
    pub miner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MINER, miner.key().as_ref()],
        bump = miner_account.bump,
        constraint = miner_account.owner == miner.key() @ LifeError::Unauthorized,
        constraint = miner_account.is_registered @ LifeError::MinerNotRegistered,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    pub system_program: Program<'info, System>,
}
