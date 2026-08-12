use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::DiscoveryBonusMinted;
use crate::state::{MinerAccount, NetworkConfig, WeeklyLeaderboard};

/// Miner claims their 100 LIFE discovery bonus for topping a target leaderboard
/// in a closed week. Only the winning miner may call this.
pub fn claim_discovery_bonus(ctx: Context<ClaimDiscoveryBonus>) -> Result<()> {
    let config      = &mut ctx.accounts.network_config;
    let leaderboard = &mut ctx.accounts.weekly_leaderboard;
    let miner_account = &mut ctx.accounts.miner_account;
    let clock       = Clock::get()?;

    require!(config.current_week() > leaderboard.week, LifeError::WeekNotClosed);
    require!(!leaderboard.bonus_minted, LifeError::BonusAlreadyMinted);

    let amount    = REWARD_DISCOVERY;
    let new_total = config.total_minted.checked_add(amount).ok_or(LifeError::Overflow)?;
    require!(new_total <= config.supply_cap, LifeError::SupplyCapExceeded);

    // ── Fix 6-B: CEI — update all state BEFORE the CPI ────────────────────────
    config.total_minted    = new_total;
    leaderboard.bonus_minted = true;
    miner_account.total_life_earned = miner_account
        .total_life_earned
        .checked_add(amount)
        .ok_or(LifeError::Overflow)?;

    // ── CPI: mint 100 LIFE ─────────────────────────────────────────────────────
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

    emit!(DiscoveryBonusMinted {
        miner:             ctx.accounts.miner.key(),
        week:              leaderboard.week,
        target_id:         leaderboard.target_id,
        amount_raw:        amount,
        total_minted_after: new_total,
        slot:              clock.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimDiscoveryBonus<'info> {
    /// Must be the winning miner — enforced by leaderboard.leader_miner constraint.
    #[account(mut)]
    pub miner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

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
    /// CHECK: Pure PDA signer.
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = network_config.current_week() > weekly_leaderboard.week @ LifeError::WeekNotClosed,
        constraint = weekly_leaderboard.leader_miner == miner.key() @ LifeError::NotTheWinner,
        constraint = !weekly_leaderboard.bonus_minted @ LifeError::BonusAlreadyMinted,
    )]
    pub weekly_leaderboard: Account<'info, WeeklyLeaderboard>,

    #[account(
        mut,
        seeds = [SEED_MINER, miner.key().as_ref()],
        bump = miner_account.bump,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    #[account(
        mut,
        token::mint      = life_mint,
        token::authority = miner,
    )]
    pub miner_ata: Account<'info, TokenAccount>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
