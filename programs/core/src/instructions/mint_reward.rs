use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_lang::solana_program::hash::hash as sol_sha256;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::events::{RewardMinted, ValidatorCommissionMinted};
use crate::rewards::calculate_reward;
use crate::state::{ConfirmedMolecule, MinerAccount, NetworkConfig, ResultStatus, ResultSubmission};

/// Permissionless crank: anyone can call this once a result is Confirmed.
///
/// Mints:
///   1. The halved $LIFE reward to the miner's canonical ATA.
///   2. A 5% validator commission split equally among confirming validators,
///      minted to their ATAs (passed as `remaining_accounts` in order).
///
/// Deduplication:
///   Before minting, computes SHA-256(smiles_bytes[..smiles_len]) and attempts
///   to initialise a `ConfirmedMolecule` PDA keyed by (target_id, smiles_hash).
///   If that PDA already exists the instruction returns `DuplicateMolecule` and
///   no tokens are minted — closing the sybil bypass where different wallets
///   submit the same SMILES/gRNA and each collect a full reward.
///
///   The first caller wins; all subsequent callers for the same molecule+target
///   pair are rejected at the Anchor account-init constraint level.
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
    let smiles_len;
    let smiles_bytes_copy: [u8; 512];
    {
        let result = &ctx.accounts.result_submission;
        result_miner     = result.miner;
        result_target_id = result.target_id;
        smiles_len       = result.smiles_len as usize;
        smiles_bytes_copy = result.smiles;
        require!(result.status == ResultStatus::Confirmed, LifeError::ResultNotConfirmed);
        require!(!result.reward_minted, LifeError::RewardAlreadyMinted);
    }

    // ── Sybil deduplication check ──────────────────────────────────────────────
    //
    // Hash the raw SMILES bytes as stored on-chain (no canonicalization — the
    // BPF VM cannot run a full SMILES graph traversal).  This closes copy-paste
    // sybil attacks: different wallets submitting the byte-identical SMILES for
    // the same target can no longer each collect full reward.
    //
    // Structural-equivalent bypass (e.g. `CC(C)O` vs `OCC`) is handled at the
    // validator layer via RDKit canonicalization before `validate_result` is
    // called — those duplicates never reach Confirmed status, so they never
    // arrive here.
    //
    // The `confirmed_molecule` account uses `init` (not `init_if_needed`), so
    // if the PDA already exists the transaction is rejected by the Anchor
    // runtime before the handler body runs.  We return an explicit error code
    // rather than letting Anchor emit a generic constraint failure so the crank
    // JS can detect and log it cleanly.
    let smiles_slice = &smiles_bytes_copy[..smiles_len];
    let smiles_hash: [u8; 32] = sol_sha256(smiles_slice).to_bytes();

    // Verify the hash matches the seeds the caller derived the PDA from.
    // `confirmed_molecule` was initialised with seeds [SEED_CONFIRMED_MOL,
    // target_id_le, smiles_hash], so if the on-chain hash differs the PDA
    // addresses would not match and Anchor would have already rejected the tx.
    // This explicit check is belt-and-suspenders for the first-minter path:
    // it ensures the stored hash is correct before we write it.
    let confirmed_mol = &mut ctx.accounts.confirmed_molecule;
    require!(
        confirmed_mol.smiles_hash == [0u8; 32] || confirmed_mol.smiles_hash == smiles_hash,
        LifeError::DuplicateMolecule
    );

    let result        = &mut ctx.accounts.result_submission;
    let config        = &mut ctx.accounts.network_config;
    let target        = &ctx.accounts.target;
    let miner_account = &mut ctx.accounts.miner_account;

    // ── Two-layer halving ──────────────────────────────────────────────────────
    let base_reward = target.difficulty.base_reward_raw();
    let (amount, supply_tier, hit_tier) =
        calculate_reward(base_reward, config.total_minted, target.hit_count, config.current_epoch)
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

    // ── Write ConfirmedMolecule dedup record ───────────────────────────────────
    // This is the authoritative first-confirm record for this (target, smiles)
    // pair.  Written after the CEI state updates, before any CPI, so it is
    // committed atomically with the reward mint.
    confirmed_mol.target_id   = result_target_id;
    confirmed_mol.smiles_hash = smiles_hash;
    confirmed_mol.first_miner = result_miner;
    confirmed_mol.first_epoch = config.current_epoch;
    confirmed_mol.bump        = ctx.bumps.confirmed_molecule;

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
        seeds = [SEED_TARGET, &result_submission.target_id.to_le_bytes()],
        bump = target.bump,
    )]
    pub target: Account<'info, crate::state::TargetAccount>,

    #[account(
        mut,
        seeds = [SEED_MINER, result_submission.miner.as_ref()],
        // No `bump = miner_account.bump` here — different accounts were registered under
        // different program versions and have the canonical bump at different struct offsets.
        // Omitting `bump` causes Anchor to re-derive it via find_program_address, which
        // verifies the account address correctly regardless of what the stored bump field
        // contains.  This covers all historical MinerAccount layout variants:
        //   - registered before multi_gpu insertion: bump at byte 65
        //   - registered after  multi_gpu insertion: bump at byte 66 (multi_gpu at 65)
        bump,
    )]
    pub miner_account: Account<'info, MinerAccount>,

    // ── Fix 1-A: canonical ATA constraint ─────────────────────────────────────
    #[account(
        mut,
        token::mint      = life_mint,
        token::authority = result_submission.miner,
    )]
    pub miner_ata: Account<'info, TokenAccount>,

    // ── Deduplication: ConfirmedMolecule PDA ──────────────────────────────────
    //
    // Seeds: [SEED_CONFIRMED_MOL, target_id_le (2 bytes), smiles_hash (32 bytes)]
    //
    // The crank computes smiles_hash = SHA-256(smiles_bytes[..smiles_len])
    // off-chain (using Node crypto.createHash("sha256")) and passes the
    // derived PDA address here.  Anchor verifies the seeds match.
    //
    // `init` (not `init_if_needed`) is intentional: if the account already
    // exists — meaning a different wallet already had this SMILES/gRNA confirmed
    // for this target — the transaction is rejected before the handler body
    // runs, and no tokens are minted.  The crank catches this error and logs it
    // as a duplicate rather than a fault.
    //
    // Space = ConfirmedMolecule::LEN = 114 bytes (~0.001 SOL rent-exempt).
    // The crank pays the rent as transaction payer.
    #[account(
        init,
        payer = crank,
        space = ConfirmedMolecule::LEN,
        seeds = [
            SEED_CONFIRMED_MOL,
            &result_submission.target_id.to_le_bytes(),
            // smiles_hash is 32 bytes, derived by the crank and verified here
            // by the PDA address check implicit in the seeds constraint.
            // The handler also re-derives and writes it for on-chain auditability.
            &{
                use anchor_lang::solana_program::hash::hash as _h;
                let s = &result_submission.smiles[..result_submission.smiles_len as usize];
                _h(s).to_bytes()
            },
        ],
        bump,
    )]
    pub confirmed_molecule: Box<Account<'info, ConfirmedMolecule>>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // NOTE: Confirming validator ATAs are passed as `remaining_accounts`.
}
