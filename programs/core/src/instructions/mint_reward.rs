use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::RewardMinted;
use crate::rewards::calculate_reward;
use crate::state::{NetworkConfig, MinerAccount, ResultSubmission, ResultStatus};

/// Permissionless crank: anyone can call this once a result is Confirmed.
/// Mints the halved $LIFE reward to the miner's Associated Token Account.
///
/// Reward = base_reward × supply_multiplier × hit_multiplier
///
/// Layer 1 (supply_multiplier — based on NetworkConfig.total_minted):
///   0 – 5,250,000 LIFE mined      →  100%
///   5,250,001 – 10,500,000 LIFE   →   50%
///   10,500,001 – 15,750,000 LIFE  →   25%
///   15,750,001 – 21,000,000 LIFE  →  12.5%
///
/// Layer 2 (hit_multiplier — based on TargetAccount.hit_count):
///   0 – 99 confirmed hits          →  100% of tier reward
///   100 – 999 confirmed hits       →   75% of tier reward
///   1,000+ confirmed hits          →   50% of tier reward
pub fn mint_reward(ctx: Context<MintReward>) -> Result<()> {
    // Capture immutable fields before taking mutable borrows
    let result_pda_key = ctx.accounts.result_submission.key();
    let result_miner;
    let result_target_id;
    {
        let result = &ctx.accounts.result_submission;
        result_miner = result.miner;
        result_target_id = result.target_id;
        require!(
            result.status == ResultStatus::Confirmed,
            LifeError::ResultNotConfirmed
        );
        require!(!result.reward_minted, LifeError::RewardAlreadyMinted);
    }

    let result = &mut ctx.accounts.result_submission;
    let config = &mut ctx.accounts.network_config;
    let target = &ctx.accounts.target;
    let miner_account = &mut ctx.accounts.miner_account;

    // ── Two-layer halving ────────────────────────────────────────────────────
    let base_reward = target.difficulty.base_reward_raw();
    let (amount, supply_tier, hit_tier) =
        calculate_reward(base_reward, config.total_minted, target.hit_count)
            .ok_or(LifeError::Overflow)?;

    // Supply cap check (uses the final halved amount)
    let new_total = config
        .total_minted
        .checked_add(amount)
        .ok_or(LifeError::Overflow)?;
    require!(new_total <= config.supply_cap, LifeError::SupplyCapExceeded);

    // Mint via CPI — authority is the mint_authority PDA
    let mint_auth_seeds: &[&[u8]] = &[
        SEED_LIFE_MINT,
        b"authority",
        &[ctx.bumps.mint_authority],
    ];
    let signer_seeds = &[mint_auth_seeds];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.life_mint.to_account_info(),
                to: ctx.accounts.miner_ata.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Update state
    config.total_minted = new_total;
    result.reward_minted = true;
    miner_account.total_life_earned = miner_account
        .total_life_earned
        .checked_add(amount)
        .ok_or(LifeError::Overflow)?;

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

    /// Program-controlled PDA that holds mint authority.
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

    /// Miner's $LIFE Associated Token Account (must exist before calling).
    #[account(
        mut,
        token::mint = life_mint,
        token::authority = result_submission.miner,
    )]
    pub miner_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
