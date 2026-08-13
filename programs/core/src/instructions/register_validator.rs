use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::ValidatorRegistered;
use crate::state::NetworkConfig;

/// Permissionless: any wallet can pay 0.1 SOL to the foundation and join the
/// active validator set.
///
/// Rules:
///   • Caller must NOT already be in NetworkConfig.validators.
///   • Registry must have a free slot (validator_count < 5).
///   • 0.1 SOL fee transferred directly to the foundation wallet (no PDA).
///   • Increments total_validators_registered (monotone counter, never resets).
pub fn register_validator(ctx: Context<RegisterValidator>) -> Result<()> {
    let config = &mut ctx.accounts.network_config;
    let validator_key = ctx.accounts.validator.key();

    // Guard: already registered
    require!(
        !config.is_validator(&validator_key),
        LifeError::ValidatorAlreadyRegistered
    );

    // Guard: registry full
    require!(
        (config.validator_count as usize) < 5,
        LifeError::ValidatorRegistryFull
    );

    // ── 0.1 SOL fee → foundation ──────────────────────────────────────────────
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.validator.to_account_info(),
                to:   ctx.accounts.foundation.to_account_info(),
            },
        ),
        VALIDATOR_REGISTRATION_FEE,
    )?;

    // ── Add to validator set ──────────────────────────────────────────────────
    let idx = config.validator_count as usize;
    config.validators[idx] = validator_key;
    config.validator_count = config
        .validator_count
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    // ── Increment global counter ──────────────────────────────────────────────
    config.total_validators_registered = config
        .total_validators_registered
        .checked_add(1)
        .ok_or(LifeError::Overflow)?;

    emit!(ValidatorRegistered {
        validator: validator_key,
        slot: Clock::get()?.slot as i64,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RegisterValidator<'info> {
    /// The wallet that wants to join as a validator; pays the 0.1 SOL fee.
    #[account(mut)]
    pub validator: Signer<'info>,

    /// Global config — updated to add the new validator pubkey.
    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    /// Foundation wallet — receives the 0.1 SOL validator registration fee.
    #[account(
        mut,
        constraint = foundation.key() == FOUNDATION_WALLET @ LifeError::Unauthorized,
    )]
    /// CHECK: externally-owned foundation wallet; no data expected.
    pub foundation: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
