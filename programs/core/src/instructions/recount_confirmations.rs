use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::{LeaderboardUpdated, ResultFinalized};
use crate::state::{NetworkConfig, ResultStatus, ResultSubmission, TargetAccount, WeeklyLeaderboard};

/// Recount confirmed_count for a Validating or Rejected result using the *current*
/// validation_tolerance stored in NetworkConfig.
///
/// Use case: after set_tolerance raises the tolerance, previously-rejected or
/// stalled validator votes (whose ValidationRecord.is_confirmed was frozen at
/// the old tolerance) can be re-evaluated without requiring a new validator vote.
///
/// The caller passes each ValidationRecord PDA (in the same order as
/// result_submission.validator_list[0..validation_count]) as remaining_accounts.
/// The instruction re-reads the stored rescored_affinity from each account,
/// re-evaluates the tolerance check, and re-derives confirmed_count.
/// If the new confirmed_count >= validators_required the result is Confirmed.
///
/// Permissionless — anyone can call.  Safe because all inputs are on-chain.
pub fn recount_confirmations(ctx: Context<RecountConfirmations>) -> Result<()> {
    let config = &ctx.accounts.network_config;

    // Capture the result PDA key BEFORE taking any mutable borrow.
    let result_pda_key = ctx.accounts.result_submission.key();

    let result = &mut ctx.accounts.result_submission;

    // Only Validating or Rejected results can be recounted; Confirmed and
    // Pending are either already done or haven't been voted on yet.
    require!(
        result.status == ResultStatus::Validating
            || result.status == ResultStatus::Rejected,
        LifeError::ResultAlreadyFinalized
    );
    require!(!result.reward_minted, LifeError::RewardAlreadyMinted);

    let claimed_affinity = result.claimed_affinity;
    let validation_count = result.validation_count as usize;
    let tolerance = config.validation_tolerance;
    let validators_required = config.validators_required;

    // Remaining accounts must have at least validation_count entries.
    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() >= validation_count,
        LifeError::Unauthorized
    );

    // Reset confirmation tracking; we recompute from scratch.
    result.confirmed_count            = 0;
    result.confirming_validator_count = 0;
    result.confirming_validator_list  = [Pubkey::default(); MAX_VALIDATORS_PER_RESULT];

    for i in 0..validation_count {
        let validator_key = result.validator_list[i];
        let vr_info       = &remaining[i];

        // Derive and verify the expected ValidationRecord PDA.
        // Seeds: [SEED_VALIDATION, result_pda, validator_pubkey]
        // We read the bump from the account data (offset 85) to use
        // create_program_address, which is cheaper than find_program_address.
        {
            let data = vr_info.try_borrow_data()?;
            // Minimum length: 8 (disc) + 32 + 32 + 4 + 1 + 8 + 1 + 16 = 102
            require!(data.len() >= 102, LifeError::Unauthorized);
            let bump = data[85];
            let expected = Pubkey::create_program_address(
                &[
                    SEED_VALIDATION,
                    result_pda_key.as_ref(),
                    validator_key.as_ref(),
                    &[bump],
                ],
                ctx.program_id,
            ).map_err(|_| error!(LifeError::Unauthorized))?;
            require!(vr_info.key() == expected, LifeError::Unauthorized);

            // rescored_affinity: offset 72..76
            let rescored = f32::from_le_bytes(
                data[72..76].try_into().map_err(|_| error!(LifeError::Overflow))?
            );
            require!(rescored.is_finite(), LifeError::InvalidAffinityScore);

            let is_confirmed = claimed_affinity != 0.0
                && ((rescored - claimed_affinity) / claimed_affinity).abs() <= tolerance;

            if is_confirmed {
                let cidx = result.confirming_validator_count as usize;
                if cidx < MAX_VALIDATORS_PER_RESULT {
                    result.confirming_validator_list[cidx] = validator_key;
                    result.confirming_validator_count = result
                        .confirming_validator_count
                        .checked_add(1)
                        .ok_or(LifeError::Overflow)?;
                }
                result.confirmed_count = result
                    .confirmed_count
                    .checked_add(1)
                    .ok_or(LifeError::Overflow)?;
            }
        }
    }

    // Snapshot fields before mutable borrow of target/leaderboard.
    let confirmed_count      = result.confirmed_count;
    let validation_count_u8  = result.validation_count;
    let validation_score_sum = result.validation_score_sum;
    let target_id            = result.target_id;
    let result_miner         = result.miner;

    if confirmed_count >= validators_required {
        result.status = ResultStatus::Confirmed;
        let avg_score = validation_score_sum / validation_count_u8 as f32;
        let clock = Clock::get()?;

        emit!(ResultFinalized {
            miner: result_miner,
            result_pda: result_pda_key,
            target_id,
            status: 0, // Confirmed
            avg_validator_score: avg_score,
            slot: clock.slot as i64,
        });

        let leaderboard  = &mut ctx.accounts.weekly_leaderboard;
        let target       = &mut ctx.accounts.target;
        let current_week = config.current_week();

        if leaderboard.leader_score == 0.0 || avg_score < leaderboard.leader_score {
            let prior = leaderboard.leader_score;
            leaderboard.week         = current_week;
            leaderboard.target_id    = target_id;
            leaderboard.leader_miner = result_miner;
            leaderboard.leader_score = avg_score;
            emit!(LeaderboardUpdated {
                week:       current_week,
                target_id,
                new_leader: result_miner,
                new_score:  avg_score,
                prior_score: prior,
            });
        }
        if avg_score < target.best_score_this_week || target.best_score_this_week == 0.0 {
            target.best_score_this_week   = avg_score;
            target.best_scorer_this_week  = result_miner;
            target.week_number            = current_week;
        }
        target.hit_count = target
            .hit_count
            .checked_add(1)
            .ok_or(LifeError::Overflow)?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct RecountConfirmations<'info> {
    /// Permissionless caller — pays rent for leaderboard if needed.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Box<Account<'info, NetworkConfig>>,

    #[account(
        mut,
        seeds = [
            SEED_RESULT,
            &result_submission.epoch.to_le_bytes(),
            result_submission.miner.as_ref(),
            &[result_submission.seq],
        ],
        bump = result_submission.bump,
        constraint = (
            result_submission.status == ResultStatus::Validating ||
            result_submission.status == ResultStatus::Rejected
        ) @ LifeError::ResultAlreadyFinalized,
        constraint = !result_submission.reward_minted @ LifeError::RewardAlreadyMinted,
    )]
    pub result_submission: Box<Account<'info, ResultSubmission>>,

    #[account(
        mut,
        seeds = [SEED_TARGET, &result_submission.target_id.to_le_bytes()],
        bump = target.bump,
    )]
    pub target: Box<Account<'info, TargetAccount>>,

    #[account(
        init_if_needed,
        payer = caller,
        space = WeeklyLeaderboard::LEN,
        seeds = [
            SEED_LEADERBOARD,
            &network_config.current_week().to_le_bytes(),
            &result_submission.target_id.to_le_bytes(),
        ],
        bump,
    )]
    pub weekly_leaderboard: Box<Account<'info, WeeklyLeaderboard>>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: ValidationRecord PDAs in validator_list order
}
