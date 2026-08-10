// ─────────────────────────────────────────────────────────────────────────────
//  LIFE Compute — Solana Program (life-compute/core)
//
//  Decentralized cancer drug discovery network on Solana.
//  Miners run Boltz2 locally against cancer protein targets, submit their
//  best molecule + predicted binding affinity, and earn $LIFE tokens when
//  validators confirm the score.
//
//  Token economics
//  ───────────────
//  • Fixed supply cap: 21,000,000 LIFE (immutable)
//  • Decimals: 6 (1 LIFE = 1,000,000 raw units)
//  • Zero pre-mint, zero team allocation — miners only
//  • Rewards:  Easy target = 1 LIFE
//              Medium target = 5 LIFE
//              Hard target = 25 LIFE
//              Weekly discovery bonus (per-target) = 100 LIFE
//
//  Instructions
//  ────────────
//  initialize              — deploy once; creates NetworkConfig + $LIFE mint
//  register_target         — authority adds a cancer protein target (0-9)
//  register_miner          — permissionless; any wallet joins the network
//  assign_job              — crank assigns a target to a miner for the epoch
//  submit_result           — miner posts (SMILES, affinity_score)
//  validate_result         — validator re-scores and confirms/rejects
//  mint_reward             — permissionless crank; mints reward after Confirmed
//  claim_discovery_bonus   — weekly leader claims 100 LIFE bonus
//  advance_epoch           — permissionless crank; increments epoch counter
// ─────────────────────────────────────────────────────────────────────────────

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::DifficultyTier;

declare_id!("3AZnjfvbLCpb1QkvaTYRTY2YafXT3vM32bmBBM3H8FdL");

#[program]
pub mod life_core {
    use super::*;

    // ── Deployment ────────────────────────────────────────────────────────────

    /// One-time setup: creates NetworkConfig + $LIFE SPL mint.
    /// supply_cap MUST equal 21_000_000 * 10^6 (enforced in handler).
    pub fn initialize(
        ctx: Context<Initialize>,
        supply_cap: u64,
        epoch_duration_slots: u64,
        validators_required: u8,
        validation_tolerance: f32,
        initial_validators: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::initialize::initialize(
            ctx,
            supply_cap,
            epoch_duration_slots,
            validators_required,
            validation_tolerance,
            initial_validators,
        )
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Register one of the 10 initial cancer protein targets.
    /// `target_id` must be 0–9. Authority-only.
    pub fn register_target(
        ctx: Context<RegisterTarget>,
        target_id: u8,
        uniprot_id: [u8; 10],
        difficulty: DifficultyTier,
    ) -> Result<()> {
        instructions::register_target::register_target(ctx, target_id, uniprot_id, difficulty)
    }

    // ── Miner ─────────────────────────────────────────────────────────────────

    /// Permissionless: create a MinerAccount PDA for the calling wallet.
    pub fn register_miner(ctx: Context<RegisterMiner>) -> Result<()> {
        instructions::register_miner::register_miner(ctx)
    }

    /// Crank: assign a cancer target to a miner for the current epoch.
    /// Caller must be authority or a registered validator.
    pub fn assign_job(ctx: Context<AssignJob>, target_id: u8) -> Result<()> {
        instructions::assign_job::assign_job(ctx, target_id)
    }

    /// Miner submits their best candidate molecule (SMILES + Boltz2 score).
    /// One submission per miner per epoch.
    pub fn submit_result(
        ctx: Context<SubmitResult>,
        smiles: String,
        claimed_affinity: f32,
    ) -> Result<()> {
        instructions::submit_result::submit_result(ctx, smiles, claimed_affinity)
    }

    // ── Validators ────────────────────────────────────────────────────────────

    /// Validator re-runs Boltz2 and posts their score on-chain.
    /// Finalizes the result (Confirmed/Rejected) once threshold is reached.
    pub fn validate_result(ctx: Context<ValidateResult>, rescored_affinity: f32) -> Result<()> {
        instructions::validate_result::validate_result(ctx, rescored_affinity)
    }

    // ── Rewards ───────────────────────────────────────────────────────────────

    /// Permissionless crank: mint base $LIFE reward once result is Confirmed.
    pub fn mint_reward(ctx: Context<MintReward>) -> Result<()> {
        instructions::mint_reward::mint_reward(ctx)
    }

    /// Winning miner claims their 100 LIFE weekly discovery bonus.
    /// Must be called after the week closes (current_week > leaderboard.week).
    pub fn claim_discovery_bonus(ctx: Context<ClaimDiscoveryBonus>) -> Result<()> {
        instructions::claim_discovery_bonus::claim_discovery_bonus(ctx)
    }

    // ── Network ───────────────────────────────────────────────────────────────

    /// Permissionless crank: advance epoch once 216,000 slots have elapsed (~24h).
    pub fn advance_epoch(ctx: Context<AdvanceEpoch>) -> Result<()> {
        instructions::advance_epoch::advance_epoch(ctx)
    }
}
