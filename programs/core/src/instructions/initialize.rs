use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::*;
use crate::state::NetworkConfig;

/// Initializes the program for the first time.
/// - Creates the `NetworkConfig` PDA (global state).
/// - Creates the $LIFE SPL mint with a PDA as mint authority.
/// This instruction can only be called once.
pub fn initialize(
    ctx: Context<Initialize>,
    supply_cap: u64,
    epoch_duration_slots: u64,
    validators_required: u8,
    validation_tolerance: f32,
    initial_validators: Vec<Pubkey>,
) -> Result<()> {
    require!(supply_cap == SUPPLY_CAP_RAW, LifeError::Unauthorized);
    require!(
        initial_validators.len() <= 5,
        LifeError::Unauthorized
    );

    let config = &mut ctx.accounts.network_config;
    config.authority = ctx.accounts.authority.key();
    config.life_mint = ctx.accounts.life_mint.key();
    config.supply_cap = supply_cap;
    config.total_minted = 0;
    config.current_epoch = 0;
    config.epoch_start_slot = Clock::get()?.slot as i64;
    config.epoch_duration_slots = epoch_duration_slots;
    config.validators_required = validators_required;
    config.validation_tolerance = validation_tolerance;
    config.validator_count = initial_validators.len() as u8;
    config.bump = ctx.bumps.network_config;
    config.mint_authority_bump = ctx.bumps.mint_authority;

    // Copy validators into fixed array
    let mut validators = [Pubkey::default(); 5];
    for (i, v) in initial_validators.iter().enumerate() {
        validators[i] = *v;
    }
    config.validators = validators;

    emit!(EpochAdvanced {
        old_epoch: 0,
        new_epoch: 0,
        slot: Clock::get()?.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The deployer / admin; becomes the permanent `authority`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Global program configuration PDA — created here, exists for program lifetime.
    #[account(
        init,
        payer = authority,
        space = NetworkConfig::LEN,
        seeds = [SEED_NETWORK_CONFIG],
        bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    /// $LIFE SPL mint — zero supply at genesis, mint authority is `mint_authority` PDA.
    #[account(
        init,
        payer = authority,
        seeds = [SEED_LIFE_MINT],
        bump,
        mint::decimals = LIFE_DECIMALS,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
    )]
    pub life_mint: Account<'info, Mint>,

    /// Program-controlled PDA that holds mint authority — never holds SOL.
    /// seeds: [SEED_LIFE_MINT, b"authority"]
    #[account(
        seeds = [SEED_LIFE_MINT, b"authority"],
        bump,
    )]
    /// CHECK: This is a pure PDA used only as a mint authority signer — no data needed.
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
