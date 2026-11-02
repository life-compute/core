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
pub mod rewards;
pub mod state;

use instructions::*;
use state::DifficultyTier;

declare_id!("HhS2coMkjRc5SSPsJn4mTXcFYwWL9hz6cfAzoWKymadv");

#[program]
pub mod life_core {
    use super::*;

    // ── Deployment ────────────────────────────────────────────────────────────

    /// One-time setup: creates NetworkConfig + $LIFE SPL mint.
    ///
    /// `supply_cap` is accepted for ABI compatibility with already-deployed
    /// accounts but is NOT enforced and has no effect.  There is no fixed
    /// supply cap: total supply is `total_minted - total_burned`, a live
    /// running figure that rises only when real verified work mints new $LIFE.
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

        /// Register a cancer protein target (up to MAX_TARGETS=2000). Authority-only.
    pub fn register_target(
        ctx: Context<RegisterTarget>,
        target_id: u16,
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
    pub fn assign_job(ctx: Context<AssignJob>, target_id: u16, seq: u8) -> Result<()> {
        instructions::assign_job::assign_job(ctx, target_id, seq)
    }

    /// Miner submits their best candidate molecule (SMILES + Boltz2 score).
    /// One submission per miner per epoch.
    pub fn submit_result(
        ctx: Context<SubmitResult>,
        smiles: String,
        claimed_affinity: f32,
        gpu_model: String,
    ) -> Result<()> {
        instructions::submit_result::submit_result(ctx, smiles, claimed_affinity, gpu_model)
    }

    // ── Validators ────────────────────────────────────────────────────────────

    /// Validator re-runs Boltz2 and posts their score on-chain.
    /// Finalizes the result (Confirmed/Rejected) once threshold is reached.
    pub fn validate_result(ctx: Context<ValidateResult>, rescored_affinity: f32) -> Result<()> {
        instructions::validate_result::validate_result(ctx, rescored_affinity)
    }

    // ── Rewards ───────────────────────────────────────────────────────────────

    /// Permissionless crank: mint base $LIFE reward once result is Confirmed.
    pub fn mint_reward<'info>(ctx: Context<'_, '_, '_, 'info, MintReward<'info>>) -> Result<()> {
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

    /// Authority removes a validator whose reputation has fallen below 50%.
    /// Requires >= 10 historical validations (protects new validators).
    pub fn evict_validator(ctx: Context<EvictValidator>) -> Result<()> {
        instructions::evict_validator::evict_validator(ctx)
    }

    pub fn update_validators(
        ctx: Context<UpdateValidators>,
        new_validators: Vec<Pubkey>,
        validators_required: u8,
    ) -> Result<()> {
        instructions::update_validators::update_validators(ctx, new_validators, validators_required)
    }

    /// Set validation_tolerance on NetworkConfig. Authority-only.
    /// Does not touch validators, validators_required, or any other state.
    pub fn set_tolerance(
        ctx: Context<SetTolerance>,
        validation_tolerance: f32,
    ) -> Result<()> {
        instructions::set_tolerance::set_tolerance(ctx, validation_tolerance)
    }

    /// Permissionless crank: re-evaluate all stored rescored_affinities for a
    /// Validating or Rejected result against the *current* validation_tolerance
    /// and re-finalize.  Use after set_tolerance to rescue stuck submissions.
    pub fn recount_confirmations(
        ctx: Context<RecountConfirmations>,
    ) -> Result<()> {
        instructions::recount_confirmations::recount_confirmations(ctx)
    }

    /// Permissionless: pay 0.05 SOL to the foundation and join the validator set.
    /// Increments total_validators_registered in NetworkConfig.
    pub fn register_validator(ctx: Context<RegisterValidator>) -> Result<()> {
        instructions::register_validator::register_validator(ctx)
    }

    // ── C4: Coordinator payout ────────────────────────────────────────────────

    /// Authority-only: create the PayoutConfig PDA with initial caps + signers.
    /// Must be called once after deployment.
    pub fn initialize_payout_config(
        ctx: Context<InitializePayoutConfig>,
        signers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        instructions::initialize_payout_config::initialize_payout_config(ctx, signers, threshold)
    }

    /// Permissionless crank (relay): mint LIFE to a batch of recipients.
    /// Requires Ed25519 multisig instructions prepended in the same tx.
    pub fn payout_batch<'info>(
        ctx: Context<'_, '_, '_, 'info, PayoutBatch<'info>>,
        batch_id: u64,
        day: u32,
        entries: Vec<payout_batch::PayoutEntry>,
        ed25519_ix_indices: Vec<u8>,
    ) -> Result<()> {
        instructions::payout_batch::payout_batch(ctx, batch_id, day, entries, ed25519_ix_indices)
    }

    /// Authority or validator: record one immutable 32-byte hash per calendar day.
    pub fn anchor_hash(ctx: Context<AnchorHash>, day: u32, hash: [u8; 32]) -> Result<()> {
        instructions::anchor_hash::anchor_hash(ctx, day, hash)
    }

    /// Miner reclaims 0.05 SOL stake when leaving in good standing.
    pub fn unstake_miner(ctx: Context<UnstakeMiner>) -> Result<()> {
        instructions::unstake_miner::unstake_miner(ctx)
    }

    // ── C38: payout admin ─────────────────────────────────────────────────────

    /// Authority-only: rotate signers, threshold, caps and backfill window on the PayoutConfig.
    /// Account size is unchanged — fits in the pre-existing 28-byte padding region.
    pub fn update_payout_config(
        ctx: Context<UpdatePayoutConfig>,
        signers: Vec<Pubkey>,
        signer_count: u8,
        threshold: u8,
        cap_per_batch: u64,
        cap_per_day: u64,
        backfill_window: u32,
    ) -> Result<()> {
        instructions::update_payout_config::update_payout_config(
            ctx, signers, signer_count, threshold, cap_per_batch, cap_per_day, backfill_window,
        )
    }

    /// Authority-only: adjust per-batch cap, per-day cap, and the paused flag.
    /// While paused, payout_batch returns PayoutPaused.
    /// Unpausing (paused=false) resumes normal operation immediately.
    pub fn set_payout_caps(
        ctx: Context<SetPayoutCaps>,
        cap_per_batch: u64,
        cap_per_day: u64,
        paused: bool,
    ) -> Result<()> {
        instructions::set_payout_caps::set_payout_caps(ctx, cap_per_batch, cap_per_day, paused)
    }
}
