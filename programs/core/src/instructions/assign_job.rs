use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::JobAssigned;
use crate::state::{JobAssignment, MinerAccount, NetworkConfig, TargetAccount};

/// Assigns a cancer target to a miner for the current epoch.
/// A miner may receive up to MAX_SUBMISSIONS_PER_EPOCH assignments per epoch.
/// Called by the authority or a registered validator crank.
pub fn assign_job(ctx: Context<AssignJob>, target_id: u16, seq: u8) -> Result<()> {
    let config = &ctx.accounts.network_config;
    let target = &ctx.accounts.target;
    let miner_account = &mut ctx.accounts.miner_account;
    let job = &mut ctx.accounts.job_assignment;

    require!(target.is_active, LifeError::TargetInactive);
    require!(target.target_id == target_id, LifeError::InvalidTargetId);
    require!(seq < MAX_SUBMISSIONS_PER_EPOCH, LifeError::SubmissionLimitExceeded);

    let epoch = config.current_epoch;
    let clock = Clock::get()?;

    job.miner = ctx.accounts.miner.key();
    job.target_id = target_id;
    job.seq = seq;
    job.epoch = epoch;
    job.assigned_slot = clock.slot as i64;
    job.is_fulfilled = false;
    job.bump = ctx.bumps.job_assignment;

    miner_account.last_epoch = epoch;

    emit!(JobAssigned {
        miner: ctx.accounts.miner.key(),
        target_id,
        epoch,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(target_id: u16, seq: u8)]
pub struct AssignJob<'info> {
    /// Authority or validator calling the crank.
    #[account(mut)]
    pub crank: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
        constraint = (
            network_config.authority == crank.key() ||
            network_config.is_validator(&crank.key())
        ) @ LifeError::Unauthorized,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    #[account(
        seeds = [SEED_TARGET, &target_id.to_le_bytes()],
        bump = target.bump,
    )]
    pub target: Account<'info, TargetAccount>,

    /// CHECK: We only read the pubkey — ownership checked by miner_account seeds.
    pub miner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [SEED_MINER, miner.key().as_ref()],
        bump = miner_account.bump,
        constraint = miner_account.is_registered @ LifeError::MinerNotRegistered,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    #[account(
        init,
        payer = crank,
        space = JobAssignment::LEN,
        seeds = [
            SEED_JOB,
            &network_config.current_epoch.to_le_bytes(),
            miner.key().as_ref(),
            &[seq],
        ],
        bump,
    )]
    pub job_assignment: Account<'info, JobAssignment>,

    pub system_program: Program<'info, System>,
}
