use anchor_lang::prelude::*;
/// Global program configuration.
/// PDA seeds: [SEED_NETWORK_CONFIG]
#[account]
#[derive(Default)]
pub struct NetworkConfig {
    /// Upgrade / admin authority (can register targets, update validators).
    pub authority: Pubkey,

    /// The $LIFE SPL mint address.
    pub life_mint: Pubkey,

    /// Fixed forever at `initialize` time: 21,000,000 LIFE in raw units.
    pub supply_cap: u64,

    /// Monotonically increasing total amount minted (raw units).
    pub total_minted: u64,

    /// Current epoch counter, incremented by `advance_epoch`.
    pub current_epoch: u64,

    /// Slot at which the current epoch started (set during `advance_epoch`).
    pub epoch_start_slot: i64,

    /// Epoch duration in slots (~24 h = 216,000).
    pub epoch_duration_slots: u64,

    /// Minimum independent validator confirmations before a result is Confirmed.
    pub validators_required: u8,

    /// Fractional tolerance for rescored affinity vs claimed.
    /// Stored as a 32-bit float; 0.05 = ±5 %.
    pub validation_tolerance: f32,

    /// Registered validator pubkeys (centralized initially; 3 keys).
    pub validators: [Pubkey; 5],

    /// Number of active validator slots in the array.
    pub validator_count: u8,

    /// Canonical bump for this PDA.
    pub bump: u8,

    /// Mint authority PDA bump (separate PDA: [SEED_LIFE_MINT]).
    pub mint_authority_bump: u8,

    /// Total miners that have ever registered (monotonically increasing).
    /// Used to gate the free-registration period (first FREE_MINER_SLOTS are free).
    pub total_miners_registered: u64,

    /// Total validators that have ever self-registered via register_validator.
    pub total_validators_registered: u64,
}

impl NetworkConfig {
    /// Discriminator (8) + fields.
    /// The two new u64 counters (16 bytes) fit inside the original 64-byte padding,
    /// so the on-chain account size does NOT change — no realloc needed.
    pub const LEN: usize = 8
        + 32  // authority
        + 32  // life_mint
        + 8   // supply_cap
        + 8   // total_minted
        + 8   // current_epoch
        + 8   // epoch_start_slot
        + 8   // epoch_duration_slots
        + 1   // validators_required
        + 4   // validation_tolerance (f32)
        + 32 * 5 // validators [Pubkey; 5]
        + 1   // validator_count
        + 1   // bump
        + 1   // mint_authority_bump
        + 8   // total_miners_registered
        + 8   // total_validators_registered
        + 48; // padding for future fields (was 64; 16 consumed by new counters)

    /// Returns the current week number derived from slot-based epoch arithmetic.
    pub fn current_week(&self) -> u64 {
        // Each epoch is 1 day; 7 epochs = 1 week.
        self.current_epoch / 7
    }

    /// Check whether `pubkey` is a registered validator.
    pub fn is_validator(&self, pubkey: &Pubkey) -> bool {
        self.validators[..self.validator_count as usize].contains(pubkey)
    }
}
