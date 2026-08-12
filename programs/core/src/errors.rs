use anchor_lang::prelude::*;

#[error_code]
pub enum LifeError {
    // ─── Authorization ──────────────────────────────────────────────────────
    #[msg("Signer is not the program authority")]
    Unauthorized,

    #[msg("Signer is not a registered validator")]
    NotAValidator,

    #[msg("Signer is not the winning miner for this discovery bonus")]
    NotTheWinner,

    // ─── Supply cap ─────────────────────────────────────────────────────────
    #[msg("Minting this reward would exceed the 21,000,000 LIFE supply cap")]
    SupplyCapExceeded,

    // ─── Target ─────────────────────────────────────────────────────────────
    #[msg("Target ID must be in range 0–9")]
    InvalidTargetId,

    #[msg("Target is not currently active")]
    TargetInactive,

    #[msg("Target with this ID already exists")]
    TargetAlreadyExists,

    // ─── Miner ──────────────────────────────────────────────────────────────
    #[msg("Miner is not registered")]
    MinerNotRegistered,

    #[msg("Miner is already registered")]
    MinerAlreadyRegistered,

    // ─── Job assignment ──────────────────────────────────────────────────────
    #[msg("A job has already been assigned to this miner for the current epoch")]
    JobAlreadyAssigned,

    #[msg("No job assignment found for this miner in the current epoch")]
    NoJobAssignment,

    #[msg("The assignment epoch does not match the current network epoch")]
    EpochMismatch,

    // ─── Result submission ───────────────────────────────────────────────────
    #[msg("A result has already been submitted for this miner this epoch")]
    ResultAlreadySubmitted,

    #[msg("SMILES string exceeds the 512-character limit")]
    SmilesTooLong,

    #[msg("Claimed affinity score must be negative (ΔG < 0 means binding)")]
    InvalidAffinityScore,

    // ─── Registration ────────────────────────────────────────────────────────
    #[msg("Registration stake transfer failed")]
    StakeTransferFailed,

    #[msg("Registration requires 0.01 SOL stake to prevent Sybil attacks")]
    InsufficientStake,

    // ─── Validation ──────────────────────────────────────────────────────────
    #[msg("This validator has already voted on this result")]
    ValidatorAlreadyVoted,

    #[msg("Validator list is full — maximum 5 validators per result")]
    ValidatorListFull,

    #[msg("Result has already been finalized (Confirmed or Rejected)")]
    ResultAlreadyFinalized,

    #[msg("Result is not yet confirmed — cannot mint reward")]
    ResultNotConfirmed,

    // ─── Reward ──────────────────────────────────────────────────────────────
    #[msg("Reward for this result has already been minted")]
    RewardAlreadyMinted,

    #[msg("Discovery bonus for this leaderboard entry has already been minted")]
    BonusAlreadyMinted,

    #[msg("Discovery bonus can only be claimed after the week has closed")]
    WeekNotClosed,

    // ─── Epoch ───────────────────────────────────────────────────────────────
    #[msg("Not enough slots have elapsed to advance the epoch")]
    EpochNotReady,

    // ─── Arithmetic ──────────────────────────────────────────────────────────
    #[msg("Arithmetic overflow")]
    Overflow,
}
