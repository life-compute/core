use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::RewardMinted;
use crate::rewards::calculate_reward;
use crate::state::{MinerAccount, NetworkConfig, ResultStatus, ResultSubmission};

/// Permissionless crank: anyone can call this once a result is Confirmed.
/// Mints the halved $LIFE reward to the miner's canonical Associated Token Account.
pub fn mint_reward(ctx: Context<MintReward>) -> Result<()> {
    let result_pda_key = ctx.accounts.result_submission.key();
    let result_miner;
    let result_target_id;
    {
        let result = &ctx.accounts.result_submission;
        result_miner   = result.miner;
        result_target_id = result.target_id;
        require!(result.status == ResultStatus::Confirmed, LifeError::ResultNotConfirmed);
        require!(!result.reward_minted, LifeError::RewardAlreadyMinted);
    }

    let result      = &mut ctx.accounts.result_submission;
    let config      = &mut ctx.accounts.network_config;
    let target      = &ctx.accounts.target;
    let miner_account = &mut ctx.accounts.miner_account;

    // ── Two-layer halving ──────────────────────────────────────────────────────
    let base_reward = target.difficulty.base_reward_raw();
    let (amount, supply_tier, hit_tier) =
        calculate_reward(base_reward, config.total_minted, target.hit_count)
            .ok_or(LifeError::Overflow)?;

    let new_total = config.total_minted.checked_add(amount).ok_or(LifeError::Overflow)?;
    require!(new_total <= config.supply_cap, LifeError::SupplyCapExceeded);

    // ── Fix 6-B: CEI — update all state BEFORE the CPI ────────────────────────
    config.total_minted = new_total;
    result.reward_minted = true;
    miner_account.total_life_earned = miner_account
        .total_life_earned
        .checked_add(amount)
        .ok_or(LifeError::Overflow)?;

    // ── CPI: mint to the miner's canonical ATA ─────────────────────────────────
    let mint_auth_seeds: &[&[u8]] = &[SEED_LIFE_MINT, b"authority", &[ctx.bumps.mint_authority]];
    let signer_seeds = &[mint_auth_seeds];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint:      ctx.accounts.life_mint.to_account_info(),
                to:        ctx.accounts.miner_ata.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(RewardMinted {
        miner: result_miner,
        result_pda: result_pda_key,
        target_id: result_target_id,
        base_reward_raw: base_reward,
        amount_raw: amount,
        supply_tier,
        hit_tier,
        total_minted_after: new_total,
        slot: Clock::get()?.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct MintReward<'info> {
    /// Anyone can pay the CPI fee — permissionless crank.
    #[account(mut)]
    pub crank: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Box<Account<'info, NetworkConfig>>,

    #[account(
        mut,
        seeds = [SEED_LIFE_MINT],
        bump,
    )]
    pub life_mint: Account<'info, Mint>,

    #[account(
        seeds = [SEED_LIFE_MINT, b"authority"],
        bump,
    )]
    /// CHECK: Pure PDA signer — no data stored.
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = result_submission.status == ResultStatus::Confirmed @ LifeError::ResultNotConfirmed,
        constraint = !result_submission.reward_minted @ LifeError::RewardAlreadyMinted,
    )]
    pub result_submission: Box<Account<'info, ResultSubmission>>,

    #[account(
        seeds = [SEED_TARGET, &[result_submission.target_id]],
        bump = target.bump,
    )]
    pub target: Account<'info, crate::state::TargetAccount>,

    #[account(
        mut,
        seeds = [SEED_MINER, result_submission.miner.as_ref()],
        bump = miner_account.bump,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    // ── Fix 1-A: canonical ATA constraint ─────────────────────────────────────
    // associated_token::mint + associated_token::authority together enforce that
    // this is the canonical ATA derived from (miner, life_mint) — not just any
    // token account where authority == miner.
    #[account(
        mut,
        associated_token::mint      = life_mint,
        associated_token::authority = result_submission.miner,
    )]
    pub miner_ata: Account<'info, TokenAccount>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}
