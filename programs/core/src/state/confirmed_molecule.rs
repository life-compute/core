use anchor_lang::prelude::*;

/// On-chain record of the first confirmed SMILES/gRNA for a given target.
///
/// PDA seeds: [SEED_CONFIRMED_MOL, target_id_le_bytes (2), smiles_hash (32)]
///
/// Created atomically by `mint_reward` the first time a molecule is confirmed
/// for a target.  If this PDA already exists when `mint_reward` is called,
/// the instruction returns `LifeError::DuplicateMolecule` and no tokens are
/// minted — closing the sybil bypass where identical SMILES/gRNA strings
/// submitted from different wallets each collected a full reward.
///
/// Hash computation (done inside `mint_reward`):
///   smiles_hash = SHA-256( result_submission.smiles[..smiles_len] )
///
/// This is a raw-bytes hash of the stored SMILES, not a canonical SMILES hash.
/// It closes copy-paste sybil attacks (the demonstrated exploit).  Structural-
/// equivalent bypass (e.g. `CC(C)O` vs `OCC`) is closed separately at the
/// validator layer via RDKit canonicalization before `validate_result` is
/// called — that attack never reaches `mint_reward`.
#[account]
pub struct ConfirmedMolecule {
    /// Target for which this molecule was first confirmed.
    pub target_id: u16,

    /// SHA-256( smiles_bytes[..smiles_len] ) — 32 bytes.
    /// Part of the PDA seeds so each unique SMILES+target pair gets its own
    /// account; duplicate detection is a free PDA init conflict.
    pub smiles_hash: [u8; 32],

    /// Pubkey of the miner who received the first-confirm reward.
    /// Informational — used for on-chain auditability of who discovered first.
    pub first_miner: Pubkey,

    /// Epoch in which the first confirmation occurred.
    pub first_epoch: u64,

    /// Canonical bump for this PDA (stored for future CPI if needed).
    pub bump: u8,
}

impl ConfirmedMolecule {
    /// On-chain account size (bytes).
    ///
    /// Layout:
    ///   8  anchor discriminator
    ///   2  target_id (u16)
    ///  32  smiles_hash ([u8; 32])
    ///  32  first_miner (Pubkey)
    ///   8  first_epoch (u64)
    ///   1  bump (u8)
    ///  31  padding (reserved for future fields without realloc)
    /// ───
    /// 114  total
    pub const LEN: usize = 8 + 2 + 32 + 32 + 8 + 1 + 31;
}
