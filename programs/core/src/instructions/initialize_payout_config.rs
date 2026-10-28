// C4: initialize_payout_config — creates the PayoutConfig PDA with the initial
// caps and signer set.  Authority-only.  Must be called once after deploy.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LifeError;
use crate::state::{NetworkConfig, PayoutConfig};

pub fn initialize_payout_config(
    ctx: Context<InitializePayoutConfig>,
    signers: Vec<Pubkey>,
    threshold: u8,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.network_config.authority,
        LifeError::Unauthorized
    );
    require!(!signers.is_empty() && signers.len() <= 3, LifeError::Unauthorized);
    require!(
        threshold >= 1 && threshold <= signers.len() as u8,
        LifeError::Unauthorized
    );

    let pc = &mut ctx.accounts.payout_config;
    pc.cap_per_batch = CAP_PER_BATCH;
    pc.cap_per_day = CAP_PER_DAY;
    pc.signer_count = signers.len() as u8;
    pc.threshold = threshold;
    pc.bump = ctx.bumps.payout_config;

    // Print the embedded fee-recipient address so it can be compared char-by-char.
    msg!(
        "REGISTRATION_FEE_RECIPIENT: {}",
        REGISTRATION_FEE_RECIPIENT
    );

    let mut arr = [Pubkey::default(); 3];
    for (i, k) in signers.iter().enumerate() {
        arr[i] = *k;
    }
    pc.signers = arr;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializePayoutConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Account<'info, NetworkConfig>,

    #[account(
        init,
        payer = authority,
        space = PayoutConfig::LEN,
        seeds = [SEED_PAYOUT_CONFIG],
        bump,
    )]
    pub payout_config: Account<'info, PayoutConfig>,

    pub system_program: Program<'info, System>,
}
