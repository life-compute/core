// ─── C4d: payout_batch ───────────────────────────────────────────────────────
//
// Mints LIFE to a list of recipient ATAs, gated by:
//   1. Per-batch cap  (PayoutConfig::cap_per_batch / CAP_PER_BATCH)
//   2. Per-day cap    (DayAccum::day_minted + batch_total ≤ cap_per_day)
//   3. Ed25519 multisig: threshold distinct registered signers must have
//      pre-signed the batch hash via Ed25519 instructions in the same tx.
//   4. Replay protection: BatchReplay PDA (init guard).
//   5. Batch-content binding (C4c): the hash is computed from the entry list
//      itself; any Ed25519 message that doesn't match is rejected.
//   6. Sort + dedup: entries must be sorted by recipient pubkey ascending and
//      no two entries may share the same recipient.
//   7. Ed25519 instruction-index binding (C4d): every Ed25519 instruction's
//      three ix-index fields (sig, pubkey, message) must all equal 0xFFFF,
//      meaning "read from this instruction's own data".  Any other value
//      would allow an attacker to point the validator at data from a different
//      instruction (the old-signature / index-redirect attack).
//   8. Day-window enforcement (C4d): the `day` argument must satisfy
//          chain_day - backfill_window  ≤  day  ≤  chain_day - 1
//      where chain_day = Clock::unix_timestamp / 86_400.
//      "yesterday or within backfill_window days ago" — a day that has ended
//      but is not so old it falls outside the configured window.
//
// Canonical batch hash (C4c, unchanged)
// ──────────────────────────────────────
// preimage = "LIFE-PAYOUT-V1"       (14 bytes, domain tag)
//          ‖ program_id             (32 bytes)
//          ‖ life_mint              (32 bytes)
//          ‖ batch_id_le8           (u64, little-endian)
//          ‖ day_le4                (u32, little-endian)
//          ‖ entry_count_u8         (u8)
//          ‖ [for each entry, sorted by recipient pubkey bytes ascending]
//                recipient_pubkey   (32 bytes)
//              ‖ amount_le8         (u64, little-endian)
//
// batch_hash = SHA-256(preimage)   (32 bytes)
//
// Ed25519 instruction layout (single-signature canonical form, C4d-required)
// ─────────────────────────────────────────────────────────────────────────────
// Every Ed25519 instruction passed to this handler MUST use the canonical
// self-contained layout in which ALL three instruction-index fields equal 0xFFFF
// (the sentinel meaning "read from this instruction's own data").
//
//   program_id = ed25519_program_id()
//   data layout per instruction:
//     [0]       = 1 (num_signatures — exactly one required)
//     [1]       = padding
//     [2..3]    = sig_offset      = 16   (LE u16)
//     [4..5]    = sig_ix_index    = 0xFFFF (LE u16)  ← REQUIRED by C4d
//     [6..7]    = pubkey_offset   = 80   (LE u16)
//     [8..9]    = pubkey_ix_index = 0xFFFF (LE u16)  ← REQUIRED by C4d
//     [10..11]  = msg_offset      = 112  (LE u16)
//     [12..13]  = msg_size        = 32   (LE u16)  ← exactly 32 required
//     [14..15]  = msg_ix_index    = 0xFFFF (LE u16)  ← REQUIRED by C4d
//     [16..79]  = signature (64 bytes)
//     [80..111] = pubkey   (32 bytes)
//     [112..143]= message  (32 bytes — canonical batch hash)
//
// The handler reads back the Instructions sysvar to confirm:
//   (a) enough Ed25519 verify instructions exist before this ix
//   (b) program_id is ed25519_program::id()          [Ed25519WrongProgram]
//   (c) num_signatures == 1                           [Ed25519BadSigCount]
//   (d) all three ix_index fields == 0xFFFF           [Ed25519IndexMismatch]
//   (e) msg_size == 32                                [Ed25519BadMsgLen]
//   (f) message == batch_hash                         [BatchHashMismatch]
//   (g) pubkey is a registered signer                 [UnregisteredSigner]
//   (h) no pubkey appears twice                       [DuplicateSigner]
//   (i) day is in the allowed window                  [DayOutOfWindow]
//
// Governance note (req. 7)
// ────────────────────────
// `PayoutConfig` is created by `initialize_payout_config` (authority-only).
// Changing signers or caps requires calling `update_payout_config`, which is
// likewise authority-only.  If the upgrade-authority has been transferred to
// a Squads v4 multisig vault (AGKvdA3i… on mainnet), then any mutation to
// PayoutConfig must go through the Squads proposal flow:
//   1. Authority (Squads vault PDA) calls `createTransaction` on Squads v4.
//   2. Required members approve via `approve`.
//   3. `executeTransaction` issues the CPI that calls `update_payout_config`.
// No keys are created in this stage; the path is described, not implemented.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_lang::solana_program::ed25519_program;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::constants::*;
use crate::errors::LifeError;
use crate::state::{DayAccum, BatchReplay, NetworkConfig, PayoutConfig};

/// Domain tag for the canonical batch hash (C4c).
const DOMAIN_TAG: &[u8] = b"LIFE-PAYOUT-V1";

/// Sentinel instruction-index value meaning "read from this instruction's own data".
/// All three instruction-index fields in an Ed25519 verify instruction must equal
/// this value (C4d requirement).
const IX_INDEX_SELF: u16 = 0xFFFF;

/// One entry in the payout list.
/// The caller builds this list off-chain and passes it as an instruction argument.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PayoutEntry {
    /// Recipient pubkey (must match the ATA owner).
    pub recipient: Pubkey,
    /// Raw LIFE units to mint.
    pub amount: u64,
}

/// Maximum entries per batch (keeps instruction size < 1232 bytes).
pub const MAX_BATCH_ENTRIES: usize = 20;

/// Offset within a single-signature Ed25519 instruction data where the signer
/// pubkey starts (see layout in module doc above).
const ED25519_PUBKEY_OFFSET: usize = 80;
/// Offset where the 32-byte message hash starts.
const ED25519_MSG_OFFSET: usize = 112;

/// Compute the canonical batch hash from the instruction's own data (C4c).
///
/// preimage = DOMAIN_TAG ‖ program_id ‖ life_mint ‖ batch_id_le8 ‖ day_le4
///          ‖ entry_count_u8 ‖ (wallet32 ‖ amount_le8)*
///
/// Entries must already be sorted by recipient pubkey bytes ascending.
fn compute_batch_hash(
    program_id: &Pubkey,
    life_mint: &Pubkey,
    batch_id: u64,
    day: u32,
    entries: &[PayoutEntry],
) -> [u8; 32] {
    // Build preimage: variable-length, use a Vec to avoid large stack allocation.
    let mut preimage: Vec<u8> = Vec::with_capacity(
        DOMAIN_TAG.len() + 32 + 32 + 8 + 4 + 1 + entries.len() * 40,
    );
    preimage.extend_from_slice(DOMAIN_TAG);
    preimage.extend_from_slice(program_id.as_ref());
    preimage.extend_from_slice(life_mint.as_ref());
    preimage.extend_from_slice(&batch_id.to_le_bytes());
    preimage.extend_from_slice(&day.to_le_bytes());
    preimage.push(entries.len() as u8);
    for e in entries {
        preimage.extend_from_slice(e.recipient.as_ref());
        preimage.extend_from_slice(&e.amount.to_le_bytes());
    }
    // SHA-256 via Solana's hashv (which is SHA-256)
    anchor_lang::solana_program::hash::hashv(&[&preimage]).to_bytes()
}

pub fn payout_batch<'info>(
    ctx: Context<'_, '_, '_, 'info, PayoutBatch<'info>>,
    batch_id: u64,
    day: u32,
    entries: Vec<PayoutEntry>,
    // Indices (0-based) of the Ed25519 instructions in this tx that carry the
    // signatures.  The handler verifies exactly `threshold` of them.
    ed25519_ix_indices: Vec<u8>,
) -> Result<()> {
    // ── 1. Basic bounds ──────────────────────────────────────────────────────
    require!(entries.len() <= MAX_BATCH_ENTRIES, LifeError::Overflow);

    // ── 1b. Paused check (C38) ────────────────────────────────────────────────
    require!(!ctx.accounts.payout_config.is_paused(), LifeError::PayoutPaused);

    // ── 2. Sort check: entries must be in ascending recipient pubkey order ───
    // Also check for duplicate recipients (DuplicateRecipient).
    for i in 1..entries.len() {
        let prev = entries[i - 1].recipient.as_ref();
        let curr = entries[i].recipient.as_ref();
        require!(prev < curr, LifeError::DuplicateRecipient);  // < catches both out-of-order and equal
    }

    // ── 3. Compute batch total and check per-batch cap ───────────────────────
    let mut batch_total: u64 = 0;
    for e in &entries {
        batch_total = batch_total
            .checked_add(e.amount)
            .ok_or(LifeError::Overflow)?;
    }
    let config = &ctx.accounts.payout_config;
    require!(batch_total <= config.cap_per_batch, LifeError::BatchCapExceeded);

    // ── 4. Day-window check (C4d) ────────────────────────────────────────────
    // chain_day = clock.unix_timestamp / 86_400.
    // Allowed: chain_day - backfill_window  ≤  day  ≤  chain_day - 1
    {
        let clock = Clock::get()?;
        // unix_timestamp is i64; a negative clock should not happen on any real
        // cluster but guard defensively so we never underflow.
        let chain_day = clock.unix_timestamp.max(0) as u64 / 86_400;
        let day64 = day as u64;
        // day must be strictly in the past (≤ chain_day - 1)
        require!(day64 < chain_day, LifeError::DayOutOfWindow);
        // day must not be older than backfill_window days
        let oldest_allowed = chain_day.saturating_sub(config.backfill_window as u64);
        require!(day64 >= oldest_allowed, LifeError::DayOutOfWindow);
    }

    // ── 5. Per-day cap check ─────────────────────────────────────────────────
    let day_accum = &mut ctx.accounts.day_accum;
    let new_day_total = day_accum
        .day_minted
        .checked_add(batch_total)
        .ok_or(LifeError::Overflow)?;
    require!(new_day_total <= config.cap_per_day, LifeError::DayCapExceeded);

    // ── 6. Canonical batch hash from instruction data (C4c) ──────────────────
    let program_id = ctx.program_id;
    let life_mint_key = ctx.accounts.life_mint.key();
    let batch_hash = compute_batch_hash(
        program_id,
        &life_mint_key,
        batch_id,
        day,
        &entries,
    );

    // ── 7. Ed25519 multisig verification via Instructions sysvar (C4d) ───────
    //
    // C4d adds three new checks per instruction:
    //   (a) program_id must be ed25519_program::id()
    //   (b) num_signatures must equal 1
    //   (c) all three instruction-index fields must equal 0xFFFF (self-referential)
    //   (d) msg_size must equal 32
    //
    // Together these prevent the "index-redirect attack": an attacker who has a
    // valid signature by signer B over an *old* batch hash cannot reuse it in a
    // new transaction by pointing the sig/pubkey/message ix-index fields at
    // instruction slots that contain the old data.  When all fields are 0xFFFF,
    // the Ed25519 precompile always reads from the current instruction's own data,
    // so the message field IS the 32-byte message in that instruction — which must
    // equal the batch_hash we computed above.
    let ix_sysvar_info = &ctx.accounts.instructions_sysvar;
    let threshold = config.threshold as usize;
    require!(
        ed25519_ix_indices.len() >= threshold,
        LifeError::InsufficientSigners
    );

    // Track distinct signer pubkeys to prevent double-counting the same signer.
    let mut seen: [Option<Pubkey>; 3] = [None; 3];
    let mut valid_count: usize = 0;

    for &ix_idx in ed25519_ix_indices.iter().take(threshold + 2) {
        // Load the instruction at ix_idx from the sysvar.
        let ix = ix_sysvar::load_instruction_at_checked(ix_idx as usize, ix_sysvar_info)
            .map_err(|_| error!(LifeError::Unauthorized))?;

        // (a) Must be an Ed25519 verify instruction.
        require!(
            ix.program_id == ed25519_program::id(),
            LifeError::Ed25519WrongProgram
        );

        let data = &ix.data;
        // Ed25519 single-signature instruction layout:
        //   [0]      = num_signatures
        //   [1]      = padding
        //   [2..3]   = signature_offset (LE u16)
        //   [4..5]   = signature_instruction_index (LE u16)  ← must be 0xFFFF
        //   [6..7]   = public_key_offset (LE u16)
        //   [8..9]   = public_key_instruction_index (LE u16) ← must be 0xFFFF
        //   [10..11] = message_data_offset (LE u16)
        //   [12..13] = message_data_size (LE u16)            ← must be 32
        //   [14..15] = message_instruction_index (LE u16)    ← must be 0xFFFF
        require!(data.len() >= 16, LifeError::Unauthorized);

        // (b) Exactly one signature.
        require!(data[0] == 1, LifeError::Ed25519BadSigCount);

        // (c) All three instruction-index fields must be 0xFFFF.
        let sig_ix_idx    = u16::from_le_bytes([data[4],  data[5]]);
        let pk_ix_idx     = u16::from_le_bytes([data[8],  data[9]]);
        let msg_ix_idx    = u16::from_le_bytes([data[14], data[15]]);
        require!(
            sig_ix_idx == IX_INDEX_SELF && pk_ix_idx == IX_INDEX_SELF && msg_ix_idx == IX_INDEX_SELF,
            LifeError::Ed25519IndexMismatch
        );

        let pk_offset  = u16::from_le_bytes([data[6],  data[7]])  as usize;
        let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
        let msg_size   = u16::from_le_bytes([data[12], data[13]]) as usize;

        // (d) Message must be exactly 32 bytes.
        require!(msg_size == 32, LifeError::Ed25519BadMsgLen);
        require!(data.len() >= pk_offset + 32,  LifeError::Unauthorized);
        require!(data.len() >= msg_offset + 32, LifeError::Unauthorized);

        // Extract pubkey and message from the instruction data.
        let pubkey_bytes: [u8; 32] = data[pk_offset..pk_offset + 32]
            .try_into()
            .map_err(|_| error!(LifeError::Unauthorized))?;
        let msg_bytes: [u8; 32] = data[msg_offset..msg_offset + 32]
            .try_into()
            .map_err(|_| error!(LifeError::Unauthorized))?;

        // (e) Message must match the hash we computed from our own entry list.
        // This is the C4c binding check: prevents sign-one-set, submit-another.
        require!(msg_bytes == batch_hash, LifeError::BatchHashMismatch);

        let signer_key = Pubkey::from(pubkey_bytes);

        // (f) Signer must be registered.
        require!(
            config.is_registered_signer(&signer_key),
            LifeError::UnregisteredSigner
        );

        // (g) No duplicates.
        for s in &seen {
            if let Some(k) = s {
                require!(k != &signer_key, LifeError::DuplicateSigner);
            }
        }

        // Record this signer.
        if valid_count < 3 {
            seen[valid_count] = Some(signer_key);
        }
        valid_count += 1;

        if valid_count >= threshold {
            break;
        }
    }

    require!(valid_count >= threshold, LifeError::InsufficientSigners);

    // ── 8. CEI: update state before any CPI ──────────────────────────────────
    day_accum.day_minted = new_day_total;

    let net_config = &mut ctx.accounts.network_config;
    net_config.total_minted = net_config
        .total_minted
        .checked_add(batch_total)
        .ok_or(LifeError::Overflow)?;

    // Write replay sentinel (init constraint already prevents re-entry).
    let replay = &mut ctx.accounts.batch_replay;
    replay.batch_id = batch_id;
    replay.day = day;
    replay.total_minted = batch_total;
    replay.bump = ctx.bumps.batch_replay;

    // Initialise day_accum metadata (idempotent since init_if_needed).
    day_accum.day = day;
    day_accum.bump = ctx.bumps.day_accum;

    // ── 9. CPI: mint to each recipient ATA (from remaining_accounts) ─────────
    let mint_auth_seeds: &[&[u8]] = &[SEED_LIFE_MINT, b"authority", &[ctx.bumps.mint_authority]];
    let signer_seeds = &[mint_auth_seeds];

    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let life_mint_ai = ctx.accounts.life_mint.to_account_info();
    let mint_auth_ai = ctx.accounts.mint_authority.to_account_info();

    let remaining: Vec<AccountInfo> = ctx.remaining_accounts.to_vec();
    require!(remaining.len() >= entries.len(), LifeError::Unauthorized);

    for (i, entry) in entries.iter().enumerate() {
        if entry.amount == 0 {
            continue;
        }
        let ata_info = remaining[i].clone();
        // Verify ATA belongs to the expected recipient.
        {
            use anchor_lang::AccountDeserialize;
            let mut data: &[u8] = &ata_info
                .try_borrow_data()
                .map_err(|_| error!(LifeError::Unauthorized))?;
            let ata = TokenAccount::try_deserialize(&mut data)
                .map_err(|_| error!(LifeError::Unauthorized))?;
            require!(ata.owner == entry.recipient, LifeError::Unauthorized);
            require!(ata.mint == ctx.accounts.life_mint.key(), LifeError::Unauthorized);
        }
        token::mint_to(
            CpiContext::new_with_signer(
                token_program_ai.clone(),
                MintTo {
                    mint: life_mint_ai.clone(),
                    to: ata_info,
                    authority: mint_auth_ai.clone(),
                },
                signer_seeds,
            ),
            entry.amount,
        )?;
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(batch_id: u64, day: u32)]
pub struct PayoutBatch<'info> {
    /// Permissionless crank pays fees; anyone may relay.
    #[account(mut)]
    pub crank: Signer<'info>,

    /// Global config — updated for total_minted.
    #[account(
        mut,
        seeds = [SEED_NETWORK_CONFIG],
        bump = network_config.bump,
    )]
    pub network_config: Box<Account<'info, NetworkConfig>>,

    /// Payout config — caps and signer set.
    #[account(
        seeds = [SEED_PAYOUT_CONFIG],
        bump = payout_config.bump,
    )]
    pub payout_config: Box<Account<'info, PayoutConfig>>,

    /// $LIFE mint.
    #[account(
        mut,
        seeds = [SEED_LIFE_MINT],
        bump,
    )]
    pub life_mint: Account<'info, Mint>,

    /// Mint authority PDA.
    #[account(
        seeds = [SEED_LIFE_MINT, b"authority"],
        bump,
    )]
    /// CHECK: Pure PDA signer.
    pub mint_authority: UncheckedAccount<'info>,

    /// Replay guard — `init` rejects if batch_id already processed.
    #[account(
        init,
        payer = crank,
        space = BatchReplay::LEN,
        seeds = [SEED_BATCH_REPLAY, &batch_id.to_le_bytes()],
        bump,
    )]
    pub batch_replay: Account<'info, BatchReplay>,

    /// Day accumulator — tracks LIFE minted today.
    #[account(
        init_if_needed,
        payer = crank,
        space = DayAccum::LEN,
        seeds = [SEED_DAY_ACCUM, &day.to_le_bytes()],
        bump,
    )]
    pub day_accum: Account<'info, DayAccum>,

    /// Instructions sysvar — used to load Ed25519 verify instructions.
    /// CHECK: native sysvar, verified by address.
    #[account(address = ix_sysvar::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // Recipient ATAs passed as remaining_accounts in entry order.
}
