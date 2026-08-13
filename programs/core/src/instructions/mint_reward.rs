use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::{RewardMinted, ValidatorCommissionMinted};
use crate::rewards::calculate_reward;
use crate::state::{MinerAccount, NetworkConfig, ResultStatus, ResultSubmission};

/// Permissionless crank: anyone can call this once a result is Confirmed.
///
/// Mints:
///   1. The halved $LIFE reward to the miner's canonical ATA.
///   2. A 5% validator commission split equally among confirming validators,
///      minted to their ATAs (passed as `remaining_accounts` in order).
///
/// `remaining_accounts` layout (caller-supplied):
///   [0..confirming_validator_count] = validator ATAs (mut), in list order.
///
/// If confirming_validator_count == 0 or per-validator share rounds to 0,
/// no commission is minted and the instruction still succeeds.
pub fn mint_reward<'info>(ctx: Context<'_, '_, '_, 'info, MintReward<'info>>) -> Result<()> {
    let result_pda_key = ctx.accounts.result_submission.key();
    let result_miner;
    let result_target_id;
    {
        let result = &ctx.accounts.result_submission;
        result_miner     = result.miner;
        result_target_id = result.target_id;
        require!(result.status == ResultStatus::Confirmed, LifeError::ResultNotConfirmed);
        require!(!result.reward_minted, LifeError::RewardAlreadyMinted);
    }

    let result        = &mut ctx.accounts.result_submission;
    let config        = &mut ctx.accounts.network_config;
    let target        = &ctx.accounts.target;
    let miner_account = &mut ctx.accounts.miner_account;

    // ── Two-layer halving ──────────────────────────────────────────────────────
    let base_reward = target.difficulty.base_reward_raw();
    let (amount, supply_tier, hit_tier) =
        calculate_reward(base_reward, config.total_minted, target.hit_count)
            .ok_or(LifeError::Overflow)?;

    // ── 5% validator commission ────────────────────────────────────────────────
    let confirming_count = result.confirming_validator_count as u64;
    let per_validator_commission: u64 = if confirming_count > 0 {
        (amount / 20) / confirming_count
    } else {
        0
    };
    let total_commission = per_validator_commission
        .checked_mul(confirming_count)
        .ok_or(LifeError::Overflow)?;

    let total_mint = amount
        .checked_add(total_commission)
        .ok_or(LifeError::Overflow)?;

    let new_total = config
        .total_minted
        .checked_add(total_mint)
        .ok_or(LifeError::Overflow)?;
    require!(new_total <= config.supply_cap, LifeError::SupplyCapExceeded);

    // ── Fix 6-B: CEI — update all state BEFORE any CPI ────────────────────────
    config.total_minted = new_total;
    result.reward_minted = true;
    miner_account.total_life_earned = miner_account
        .total_life_earned
        .checked_add(amount)
        .ok_or(LifeError::Overflow)?;

    // Capture confirming validators before mutable borrows end.
    let confirming_count_usize  = result.confirming_validator_count as usize;
    let confirming_validators: [Pubkey; 5] = result.confirming_validator_list;

    // ── Pre-extract all AccountInfos from ctx ─────────────────────────────────
    // Nightly Rust treats ctx.accounts and ctx.remaining_accounts as having
    // distinct invariant lifetimes.  Extracting everything before the CPIs
    // prevents "lifetime may not live long enough" errors.
    let mint_auth_seeds: &[&[u8]] = &[SEED_LIFE_MINT, b"authority", &[ctx.bumps.mint_authority]];
    let signer_seeds = &[mint_auth_seeds];

    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let life_mint_key    = ctx.accounts.life_mint.key();
    let life_mint_ai     = ctx.accounts.life_mint.to_account_info();
    let mint_auth_ai     = ctx.accounts.mint_authority.to_account_info();
    let miner_ata_ai     = ctx.accounts.miner_ata.to_account_info();

    // Snapshot remaining_accounts so we hold no live borrow from ctx.
    let remaining: Vec<AccountInfo> = ctx.remaining_accounts.to_vec();

    // ── CPI 1: mint miner reward ───────────────────────────────────────────────
    token::mint_to(
        CpiContext::new_with_signer(
            token_program_ai.clone(),
            MintTo {
                mint:      life_mint_ai.clone(),
                to:        miner_ata_ai,
                authority: mint_auth_ai.clone(),
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

    // ── CPI 2+: mint 5% commission to each confirming validator's ATA ──────────
    if per_validator_commission > 0 && confirming_count_usize > 0 {
        let slot = Clock::get()?.slot as i64;

        require!(
            remaining.len() >= confirming_count_usize,
            LifeError::ValidatorListFull
        );

        for i in 0..confirming_count_usize {
            let expected_owner = confirming_validators[i];
            let validator_ata_info = remaining[i].clone();

            // Verify mint and owner inline from raw account data.
            {
                let mut data: &[u8] = &validator_ata_info
                    .try_borrow_data()
                    .map_err(|_| error!(LifeError::Unauthorized))?;
                let ata = TokenAccount::try_deserialize(&mut data)
                    .map_err(|_| error!(LifeError::Unauthorized))?;
                require!(ata.mint == life_mint_key, LifeError::Unauthorized);
                require!(ata.owner == expected_owner, LifeError::Unauthorized);
            }

            token::mint_to(
                CpiContext::new_with_signer(
                    token_program_ai.clone(),
                    MintTo {
                        mint:      life_mint_ai.clone(),
                        to:        validator_ata_info,
                        authority: mint_auth_ai.clone(),
                    },
                    signer_seeds,
                ),
                per_validator_commission,
            )?;

            emit!(ValidatorCommissionMinted {
                validator: expected_owner,
                result_pda: result_pda_key,
                amount_raw: per_validator_commission,
                slot,
            });
        }
    }

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
    #[account(
        mut,
        token::mint      = life_mint,
        token::authority = result_submission.miner,
    )]
    pub miner_ata: Account<'info, TokenAccount>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // NOTE: Confirming validator ATAs are passed as `remaining_accounts`.
}
