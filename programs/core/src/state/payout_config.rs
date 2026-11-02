use anchor_lang::prelude::*;

/// C4 — Payout configuration account.
/// PDA seeds: [SEED_PAYOUT_CONFIG]
///
/// Holds per-batch and per-day LIFE mint caps, the multisig signer set,
/// and the required signature threshold for `payout_batch`.
///
/// C38 additions (no reallocation — fits in the existing 28-byte padding):
///   • `update_payout_config` — authority rotates signers/threshold/caps/window.
///   • `set_payout_caps`      — authority adjusts caps and the `paused` flag.
///   • `paused` byte occupies padding[0]; zero → not paused (existing accounts valid).
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

    /// How many days in the past a batch may still be submitted.
    /// A batch for day D is valid when: chain_day - backfill_window ≤ D ≤ chain_day - 1.
    pub backfill_window: u32,

    /// Canonical bump for this PDA.
    pub bump: u8,

    /// C38: pause flag. Non-zero → `payout_batch` returns PayoutPaused.
    /// Stored in the first byte of the former 28-byte padding region.
    /// Existing accounts have zero here → not paused (backward-compatible).
    pub paused: u8,

    /// Padding reserved for future fields (27 remaining bytes after paused).
    pub _padding: [u8; 27],
}

impl PayoutConfig {
    pub const LEN: usize = 8
        + 8   // cap_per_batch
        + 8   // cap_per_day
        + 32 * 3 // signers [Pubkey; 3]
        + 1   // signer_count
        + 1   // threshold
        + 4   // backfill_window
        + 1   // bump
        + 1   // paused  (C38)
        + 27; // _padding (27 remaining bytes)

    /// Returns true if `key` is in the active signer set.
    pub fn is_registered_signer(&self, key: &Pubkey) -> bool {
        self.signers[..self.signer_count as usize].contains(key)
    }

    /// Returns true when payouts are paused (C38).
    pub fn is_paused(&self) -> bool {
        self.paused != 0
    }
}
