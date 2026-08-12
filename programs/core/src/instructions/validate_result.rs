use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::{LeaderboardUpdated, ResultFinalized, ValidationCast};
use crate::state::{
    NetworkConfig, ResultStatus, ResultSubmission, TargetAccount, ValidationRecord,
    WeeklyLeaderboard,
};

/// A registered validator re-runs Boltz2 and posts their rescored affinity.
///
/// Design: validators_required confirmations are needed to finalize.
/// For the current 2-of-3 centralized validator set, this means the result is
/// Confirmed once 2 validators confirm within the tolerance window.
/// `validation_score_sum` accumulates ALL rescored affinities (used for avg).
/// A future v2 should add `confirmed_count: u8` for a stricter majority check.
pub fn validate_result(ctx: Context<ValidateResult>, rescored_affinity: f32) -> Result<()> {
    let validator_key = ctx.accounts.validator.key();
    // Capture key before taking mutable borrows
    let result_pda_key = ctx.accounts.result_submission.key();

    let config = &ctx.accounts.network_config;
    let target = &mut ctx.accounts.target;
    let leaderboard = &mut ctx.accounts.weekly_leaderboard;
    let record = &mut ctx.accounts.validation_record;
    let clock = Clock::get()?;

    // Capture fields we need from result BEFORE the mutable borrow
    let target_id;
    let claimed_affinity;
    let result_miner;
    let result_epoch;
    {
        let result = &ctx.accounts.result_submission;
        target_id = result.target_id;
        claimed_affinity = result.claimed_affinity;
        result_miner = result.miner;
        result_epoch = result.epoch;

        // Guard: not already finalized
        require!(
            result.status == ResultStatus::Pending || result.status == ResultStatus::Validating,
            LifeError::ResultAlreadyFinalized
        );
        // Guard: no double-vote
        require!(
            !result.validator_list[..result.validation_count as usize].contains(&validator_key),
            LifeError::ValidatorAlreadyVoted
        );
        require!(
            (result.validation_count as usize) < MAX_VALIDATORS_PER_RESULT,
            LifeError::ValidatorListFull
        );
    }

    // Tolerance check: |rescored - claimed| / |claimed| <= tolerance
    let is_confirmed = claimed_affinity != 0.0
        && ((rescored_affinity - claimed_affinity) / claimed_affinity).abs()
            <= config.validation_tolerance;

    // Write validation record
    record.validator = validator_key;
    record.result_pda = result_pda_key;
    record.rescored_affinity = rescored_affinity;
    record.is_confirmed = is_confirmed;
    record.validated_slot = clock.slot as i64;
    record.bump = ctx.bumps.validation_record;

    // Now take mutable borrow of result
    let result = &mut ctx.accounts.result_submission;
    let idx = result.validation_count as usize;
    result.validator_list[idx] = validator_key;
    result.validation_count = result
        .validation_count
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;
    result.validation_score_sum += rescored_affinity;
    result.status = ResultStatus::Validating;

    let validation_count = result.validation_count;
    let validation_score_sum = result.validation_score_sum;

    emit!(ValidationCast {
        validator: validator_key,
        result_pda: result_pda_key,
        rescored_affinity,
        is_confirmed,
        validation_count,
        slot: clock.slot as i64,
    });

    // Finalize once threshold reached
    if validation_count >= config.validators_required {
        if is_confirmed {
            result.status = ResultStatus::Confirmed;
            let avg_score = validation_score_sum / validation_count as f32;

            emit!(ResultFinalized {
                miner: result_miner,
                result_pda: result_pda_key,
                target_id,
                status: 0, // Confirmed
                avg_validator_score: avg_score,
                slot: clock.slot as i64,
            });

            // Update leaderboard (more negative = stronger binding = better)
            let current_week = config.current_week();
            if leaderboard.leader_score == 0.0 || claimed_affinity < leaderboard.leader_score {
                let prior = leaderboard.leader_score;
                leaderboard.week = current_week;
                leaderboard.target_id = target_id;
                leaderboard.leader_miner = result_miner;
                leaderboard.leader_score = claimed_affinity;

                emit!(LeaderboardUpdated {
                    week: current_week,
                    target_id,
                    new_leader: result_miner,
                    new_score: claimed_affinity,
                    prior_score: prior,
                });
            }

            // Update target stats
            if claimed_affinity < target.best_score_this_week || target.best_score_this_week == 0.0
            {
                target.best_score_this_week = claimed_affinity;
                target.best_scorer_this_week = result_miner;
                target.week_number = current_week;
            }
            target.hit_count = target
                .hit_count
                .checked_add(1)
                .ok_or(LifeError::Overflow)?;
        } else {
            result.status = ResultStatus::Rejected;
            emit!(ResultFinalized {
                miner: result_miner,
                result_pda: result_pda_key,
                target_id,
                status: 1, // Rejected
                avg_validator_score: validation_score_sum / validation_count as f32,
                slot: clock.slot as i64,
            });
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct ValidateResult<'info> {
    #[account(mut)]
    pub validator: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
        constraint = network_config.is_validator(&validator.key()) @ LifeError::NotAValidator,
    )]
    pub network_config: Box<Account<'info, NetworkConfig>>,

    #[account(
        mut,
        seeds = [SEED_TARGET, &[result_submission.target_id]],
        bump = target.bump,
    )]
    pub target: Box<Account<'info, TargetAccount>>,

    #[account(
        mut,
        constraint = (
            result_submission.status == ResultStatus::Pending ||
            result_submission.status == ResultStatus::Validating
        ) @ LifeError::ResultAlreadyFinalized,
    )]
    pub result_submission: Box<Account<'info, ResultSubmission>>,

    #[account(
        init,
        payer = validator,
        space = ValidationRecord::LEN,
        seeds = [
            SEED_VALIDATION,
            result_submission.key().as_ref(),
            validator.key().as_ref(),
        ],
        bump,
    )]
    pub validation_record: Box<Account<'info, ValidationRecord>>,

    /// init_if_needed: first confirmed result of the week creates the leaderboard account.
    #[account(
        init_if_needed,
        payer = validator,
        space = WeeklyLeaderboard::LEN,
        seeds = [
            SEED_LEADERBOARD,
            &network_config.current_week().to_le_bytes(),
            &[result_submission.target_id],
        ],
        bump,
    )]
    pub weekly_leaderboard: Box<Account<'info, WeeklyLeaderboard>>,

    pub system_program: Program<'info, System>,
}
