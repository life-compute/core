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
/// Finalization uses strict M-of-N counting:
/// - `confirmed_count` accumulates only validators whose rescore is within tolerance.
/// - Status becomes Confirmed when confirmed_count >= validators_required.
/// - Status becomes Rejected when the remaining unvoted slots cannot mathematically
///   push confirmed_count to validators_required.
/// Both paths require the full validators_required votes to have been cast first.
pub fn validate_result(ctx: Context<ValidateResult>, rescored_affinity: f32) -> Result<()> {
    let validator_key = ctx.accounts.validator.key();
    let result_pda_key = ctx.accounts.result_submission.key();

    let config = &ctx.accounts.network_config;
    let target = &mut ctx.accounts.target;
    let leaderboard = &mut ctx.accounts.weekly_leaderboard;
    let record = &mut ctx.accounts.validation_record;
    let clock = Clock::get()?;

    // Capture immutable fields before mutable borrow of result
    let target_id;
    let claimed_affinity;
    let result_miner;
    {
        let result = &ctx.accounts.result_submission;
        target_id = result.target_id;
        claimed_affinity = result.claimed_affinity;
        result_miner = result.miner;

        require!(
            result.status == ResultStatus::Pending || result.status == ResultStatus::Validating,
            LifeError::ResultAlreadyFinalized
        );
        require!(
            !result.validator_list[..result.validation_count as usize].contains(&validator_key),
            LifeError::ValidatorAlreadyVoted
        );
        require!(
            (result.validation_count as usize) < MAX_VALIDATORS_PER_RESULT,
            LifeError::ValidatorListFull
        );
    }

    // ── Fix 2-B: reject non-finite rescored_affinity before accumulating ─────
    require!(
        rescored_affinity.is_finite(),
        LifeError::InvalidAffinityScore
    );

    // Tolerance check: |rescored − claimed| / |claimed| ≤ tolerance
    // claimed_affinity is guaranteed < 0.0 by submit_result, so denominator safe.
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

    // Accumulate vote
    let result = &mut ctx.accounts.result_submission;
    let idx = result.validation_count as usize;
    result.validator_list[idx] = validator_key;
    result.validation_count = result
        .validation_count
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    // ── Fix 2-B: accumulate score sum with bounds guard ───────────────────────
    let new_sum = result.validation_score_sum + rescored_affinity;
    require!(new_sum.is_finite(), LifeError::Overflow);
    result.validation_score_sum = new_sum;

    result.status = ResultStatus::Validating;

    // ── Fix 4-A: accumulate confirmed_count independently ─────────────────────
    if is_confirmed {
        result.confirmed_count = result
            .confirmed_count
            .checked_add(1)
            .ok_or(LifeError::Overflow)?;
    }

    let validation_count = result.validation_count;
    let confirmed_count = result.confirmed_count;
    let validation_score_sum = result.validation_score_sum;

    emit!(ValidationCast {
        validator: validator_key,
        result_pda: result_pda_key,
        rescored_affinity,
        is_confirmed,
        validation_count,
        slot: clock.slot as i64,
    });

    // ── Fix 4-A: M-of-N finalization ──────────────────────────────────────────
    // Confirmed: M independent confirmations received.
    if confirmed_count >= config.validators_required {
        result.status = ResultStatus::Confirmed;

        // ── Fix 4-C: leaderboard records validated average, not claimed score ─
        let avg_score = validation_score_sum / validation_count as f32;

        emit!(ResultFinalized {
            miner: result_miner,
            result_pda: result_pda_key,
            target_id,
            status: 0, // Confirmed
            avg_validator_score: avg_score,
            slot: clock.slot as i64,
        });

        // Leaderboard: more negative = stronger binding = better
        let current_week = config.current_week();
        if leaderboard.leader_score == 0.0 || avg_score < leaderboard.leader_score {
            let prior = leaderboard.leader_score;
            leaderboard.week = current_week;
            leaderboard.target_id = target_id;
            leaderboard.leader_miner = result_miner;
            leaderboard.leader_score = avg_score;   // ← Fix 4-C: validated avg

            emit!(LeaderboardUpdated {
                week: current_week,
                target_id,
                new_leader: result_miner,
                new_score: avg_score,
                prior_score: prior,
            });
        }

        // Target best score also uses validated average
        if avg_score < target.best_score_this_week || target.best_score_this_week == 0.0 {
            target.best_score_this_week = avg_score;   // ← Fix 4-C
            target.best_scorer_this_week = result_miner;
            target.week_number = current_week;
        }
        target.hit_count = target
            .hit_count
            .checked_add(1)
            .ok_or(LifeError::Overflow)?;

    } else {
        // Rejected: remaining unvoted slots cannot reach the threshold
        let remaining_slots = (MAX_VALIDATORS_PER_RESULT as u8)
            .saturating_sub(validation_count);
        let max_possible = confirmed_count.saturating_add(remaining_slots);
        if max_possible < config.validators_required {
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

    // ── Fix 1-D: add seed constraint to bind result_submission to its PDA ────
    #[account(
        mut,
        seeds = [
            SEED_RESULT,
            &result_submission.epoch.to_le_bytes(),
            result_submission.miner.as_ref(),
        ],
        bump = result_submission.bump,
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
