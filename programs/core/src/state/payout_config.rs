use anchor_lang::prelude::*;

/// C4 — Payout configuration account.
/// PDA seeds: [SEED_PAYOUT_CONFIG]
///
/// Holds per-batch and per-day LIFE mint caps, the multisig signer set,
/// and the required signature threshold for `payout_batch`.
///
/// Changes require the upgrade-authority (or a future Squads multisig that
/// holds that authority).  No instruction mutates this account in C4 beyond
/// what the upgrade-authority controls directly:
///   • To rotate signers or change caps: the upgrade-authority calls
///     `update_payout_config` (not yet added) or, if program control has
///     been transferred to a Squads vault, proposes a transaction via
///     Squads v4 `createTransaction` → approval → `executeTransaction`.
///     Describe-only in this stage; no key material is created.
///
/// On-chain layout (discriminator 8 + fields below):
#[account]
pub struct PayoutConfig {
    /// Maximum LIFE raw units mintable per single batch (≤ CAP_PER_BATCH).
    pub cap_per_batch: u64,

    /// Maximum LIFE raw units mintable across all batches in a calendar day
    /// (identified by the `day` u32 argument — e.g. Unix-day number).
    /// Resets across `day` boundaries; enforced by `day_minted` in the day
    /// accumulator PDA (DayAccum).
    pub cap_per_day: u64,

    /// Ed25519 public keys authorised to sign `payout_batch` payloads.
    /// Index 0 is conventionally the "online validator key";
    /// index 1 is the "cold key";
    /// index 2 is reserved for the 2-of-3 expansion target.
    pub signers: [Pubkey; 3],

    /// Number of slots in `signers` that are populated (1–3).
    pub signer_count: u8,

    /// How many distinct registered signers must sign each batch.
    pub threshold: u8,

    /// Canonical bump for this PDA.
    pub bump: u8,
}

impl PayoutConfig {
    pub const LEN: usize = 8
        + 8   // cap_per_batch
        + 8   // cap_per_day
        + 32 * 3 // signers [Pubkey; 3]
        + 1   // signer_count
        + 1   // threshold
        + 1   // bump
        + 32; // padding

    /// Returns true if `key` is in the active signer set.
    pub fn is_registered_signer(&self, key: &Pubkey) -> bool {
        self.signers[..self.signer_count as usize].contains(key)
    }
}
