use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::TargetRegistered;
use crate::state::{DifficultyTier, NetworkConfig, TargetAccount};

/// Registers a new cancer protein target. Authority-only.
pub fn register_target(
    ctx: Context<RegisterTarget>,
    target_id: u16,
    uniprot_id: [u8; 10],
    difficulty: DifficultyTier,
) -> Result<()> {
    require!(target_id < MAX_TARGETS, LifeError::InvalidTargetId);

    let target = &mut ctx.accounts.target;
    target.target_id = target_id;
    target.uniprot_id = uniprot_id;
    target.difficulty = difficulty;
    target.is_active = true;
    target.best_score_this_week = 0.0;
    target.best_scorer_this_week = Pubkey::default();
    target.week_number = 0;
    target.hit_count = 0;
    target.bump = ctx.bumps.target;

    emit!(TargetRegistered {
        target_id,
        uniprot_id,
        difficulty: difficulty.as_u8(),
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(target_id: u16)]
pub struct RegisterTarget<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
        has_one = authority @ LifeError::Unauthorized,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    #[account(
        init,
        payer = authority,
        space = TargetAccount::LEN,
        seeds = [SEED_TARGET, &target_id.to_le_bytes()],
        bump,
    )]
    pub target: Account<'info, TargetAccount>,

    pub system_program: Program<'info, System>,
}
