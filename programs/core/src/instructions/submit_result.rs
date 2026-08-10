use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::ResultSubmitted;
use crate::state::{
    NetworkConfig, MinerAccount, JobAssignment, ResultSubmission, ResultStatus,
};

/// Miner submits their best molecule (SMILES + Boltz2 affinity) for the epoch.
pub fn submit_result(
    ctx: Context<SubmitResult>,
    smiles: String,
    claimed_affinity: f32,
) -> Result<()> {
    require!(smiles.len() <= MAX_SMILES_LEN, LifeError::SmilesTooLong);
    // ΔG must be negative: positive values mean no binding predicted
    require!(claimed_affinity < 0.0, LifeError::InvalidAffinityScore);

    let config = &ctx.accounts.network_config;
    let job = &mut ctx.accounts.job_assignment;
    let miner_account = &mut ctx.accounts.miner_account;
    let result = &mut ctx.accounts.result_submission;

    let epoch = config.current_epoch;
    require!(job.epoch == epoch, LifeError::EpochMismatch);
    require!(!job.is_fulfilled, LifeError::ResultAlreadySubmitted);

    let clock = Clock::get()?;

    // Store SMILES as fixed-size byte array
    let smiles_bytes = smiles.as_bytes();
    let mut smiles_arr = [0u8; 512];
    smiles_arr[..smiles_bytes.len()].copy_from_slice(smiles_bytes);

    result.miner = ctx.accounts.miner.key();
    result.target_id = job.target_id;
    result.epoch = epoch;
    result.smiles = smiles_arr;
    result.smiles_len = smiles_bytes.len() as u16;
    result.claimed_affinity = claimed_affinity;
    result.submitted_slot = clock.slot as i64;
    result.status = ResultStatus::Pending;
    result.validation_count = 0;
    result.validation_score_sum = 0.0;
    result.validator_list = [Pubkey::default(); 5];
    result.reward_minted = false;
    result.bump = ctx.bumps.result_submission;

    // Mark the job as fulfilled (prevents double submission)
    job.is_fulfilled = true;

    // Increment miner's molecule count
    miner_account.molecules_screened = miner_account
        .molecules_screened
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    emit!(ResultSubmitted {
        miner: ctx.accounts.miner.key(),
        target_id: job.target_id,
        epoch,
        smiles,
        claimed_affinity,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    #[account(mut)]
    pub miner: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    #[account(
        mut,
        seeds = [SEED_MINER, miner.key().as_ref()],
        bump = miner_account.bump,
        constraint = miner_account.is_registered @ LifeError::MinerNotRegistered,
        has_one = owner @ LifeError::Unauthorized,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    /// CHECK: owner field on miner_account already enforces this is the miner.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            SEED_JOB,
            &network_config.current_epoch.to_le_bytes(),
            miner.key().as_ref(),
        ],
        bump = job_assignment.bump,
    )]
    pub job_assignment: Account<'info, JobAssignment>,

    #[account(
        init,
        payer = miner,
        space = ResultSubmission::LEN,
        seeds = [
            SEED_RESULT,
            &network_config.current_epoch.to_le_bytes(),
            miner.key().as_ref(),
        ],
        bump,
    )]
    pub result_submission: Box<Account<'info, ResultSubmission>>,

    pub system_program: Program<'info, System>,
}
