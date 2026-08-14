use anchor_lang::prelude::*;

/// Records the cancer target assigned to a miner for one epoch.
/// PDA seeds: [SEED_JOB, epoch.to_le_bytes(), miner_pubkey.as_ref()]
#[account]
pub struct JobAssignment {
    pub miner: Pubkey,
    pub target_id: u16,
    /// Submission sequence within the epoch (0, 1, 2).
    /// Allows up to MAX_SUBMISSIONS_PER_EPOCH distinct job + result PDAs.
    pub seq: u8,
    pub epoch: u64,

    /// Slot at which the job was assigned.
    pub assigned_slot: i64,

    /// Set to true once the miner submits a result for this job.
    pub is_fulfilled: bool,

    pub bump: u8,
}

impl JobAssignment {
    pub const LEN: usize = 8
        + 32 // miner
        + 2  // target_id (u16)
        + 1  // seq
        + 8  // epoch
        + 8  // assigned_slot
        + 1  // is_fulfilled
        + 1  // bump
        + 15; // padding (was 16; 1 byte consumed by seq)
}
