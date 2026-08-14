#!/usr/bin/env node
/**
 * scripts/validator_registry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFE Compute — Validator Registry Utilities
 *
 * Exports:
 *   getActiveValidators(program, networkConfigPda)
 *     → [{pubkey, reputationBps, totalValidations, confirmations, isActive}]
 *
 *   pickRandomValidator(validators, slotSeed)
 *     → pubkey (weighted by reputation — higher rep = more likely to be picked)
 *     Returns null if no active validators.
 *
 *   getValidatorReputation(program, validatorPubkey)
 *     → {pubkey, reputationBps, totalValidations, confirmations, isActive, lastActiveSlot}
 *     Returns null if ValidatorAccount PDA does not exist.
 *
 *   printValidatorReport(program, networkConfigPda)
 *     → logs a formatted table of all validators + reputation scores
 *
 * Usage:
 *   node scripts/validator_registry.js [--rpc <url>] [--program <id>]
 *
 * When run directly, prints a live validator report for the devnet program.
 */

"use strict";

const anchor = require("@coral-xyz/anchor");
const web3   = require("@solana/web3.js");
const fs     = require("fs");
const path   = require("path");

// ── Constants ─────────────────────────────────────────────────────────────────
const SEED_NETWORK_CONFIG    = Buffer.from("network_config");
const SEED_VALIDATOR_ACCOUNT = Buffer.from("validator_account");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the ValidatorAccount PDA for a given validator pubkey.
 */
function validatorAccountPda(validatorPubkey, programId) {
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [SEED_VALIDATOR_ACCOUNT, validatorPubkey.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Fetch all active validators from NetworkConfig and augment with reputation data.
 * @returns {Array<{pubkey, reputationBps, totalValidations, confirmations, isActive, pdaExists}>}
 */
async function getActiveValidators(program, networkConfigPda) {
  const config = await program.account.networkConfig.fetch(networkConfigPda);
  const programId = program.programId;
  const count = config.validatorCount;

  const validators = [];
  for (let i = 0; i < count; i++) {
    const pk = config.validators[i];
    if (!pk || pk.equals(web3.PublicKey.default)) continue;

    let repData = {
      reputationBps:    10000,  // default: fully trusted (no history yet)
      totalValidations: 0,
      confirmations:    0,
      isActive:         true,
      lastActiveSlot:   null,
      pdaExists:        false,
    };

    try {
      const pda = validatorAccountPda(pk, programId);
      const va  = await program.account.validatorAccount.fetch(pda);
      repData = {
        reputationBps:    va.reputationBps,
        totalValidations: va.totalValidations.toNumber?.() ?? Number(va.totalValidations),
        confirmations:    va.confirmations.toNumber?.()    ?? Number(va.confirmations),
        isActive:         va.isActive,
        lastActiveSlot:   va.lastActiveSlot.toNumber?.()  ?? Number(va.lastActiveSlot),
        pdaExists:        true,
      };
    } catch {
      // ValidatorAccount not yet created (validator registered but never validated)
    }

    validators.push({ pubkey: pk.toBase58(), ...repData });
  }

  return validators;
}

/**
 * Pseudo-randomly pick a validator weighted by reputation (higher rep → more weight).
 * Uses `slotSeed` (current slot number) as entropy source — deterministic per slot
 * so all nodes arrive at the same selection without coordination.
 *
 * @param {Array} validators - output of getActiveValidators()
 * @param {number} slotSeed  - current Solana slot number
 * @returns {string|null}    - base58 pubkey of selected validator, or null
 */
function pickRandomValidator(validators, slotSeed) {
  const eligible = validators.filter(v => v.isActive && v.reputationBps > 0);
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0].pubkey;

  // Weight proportional to reputation (min weight = 1 even at 0 bps to avoid starvation)
  const weights = eligible.map(v => Math.max(1, v.reputationBps));
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  // Mix slot with a simple hash so consecutive slots pick differently
  const rng = ((slotSeed * 2654435761) >>> 0) % totalWeight;

  let cumulative = 0;
  for (let i = 0; i < eligible.length; i++) {
    cumulative += weights[i];
    if (rng < cumulative) return eligible[i].pubkey;
  }
  return eligible[eligible.length - 1].pubkey;
}

/**
 * Fetch reputation for a single validator. Returns null if PDA not yet created.
 */
async function getValidatorReputation(program, validatorPubkeyStr) {
  const programId = program.programId;
  const pk = new web3.PublicKey(validatorPubkeyStr);
  try {
    const pda = validatorAccountPda(pk, programId);
    const va  = await program.account.validatorAccount.fetch(pda);
    return {
      pubkey:           validatorPubkeyStr,
      reputationBps:    va.reputationBps,
      reputationPct:    (va.reputationBps / 100).toFixed(1) + "%",
      totalValidations: va.totalValidations.toNumber?.() ?? Number(va.totalValidations),
      confirmations:    va.confirmations.toNumber?.()    ?? Number(va.confirmations),
      isActive:         va.isActive,
      lastActiveSlot:   va.lastActiveSlot.toNumber?.()  ?? Number(va.lastActiveSlot),
    };
  } catch {
    return null;
  }
}

/**
 * Print a formatted validator report to stdout.
 */
async function printValidatorReport(program, networkConfigPda) {
  const validators = await getActiveValidators(program, networkConfigPda);
  const slot = await program.provider.connection.getSlot();

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  LIFE Compute — Active Validator Registry                            ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`  Current slot: ${slot}`);
  console.log(`  Active validators: ${validators.length}`);

  if (validators.length === 0) {
    console.log("  (no validators registered)\n");
    return;
  }

  console.log("\n  Pubkey                                        Rep%   Confirmations  Total");
  console.log("  " + "─".repeat(80));

  for (const v of validators) {
    const rep    = (v.reputationBps / 100).toFixed(1).padStart(6);
    const conf   = String(v.confirmations).padStart(13);
    const total  = String(v.totalValidations).padStart(7);
    const active = v.isActive ? "✓" : "✗";
    const hist   = v.pdaExists ? "" : " (no history)";
    console.log(`  ${active} ${v.pubkey}  ${rep}%  ${conf}  ${total}${hist}`);
  }

  const selected = pickRandomValidator(validators, slot);
  console.log(`\n  Random pick (slot ${slot}): ${selected ?? "(none)"}`);
  console.log();
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : d; };

    const RPC_URL   = flag("--rpc",     process.env.SOLANA_RPC   || "https://api.devnet.solana.com");
    const PROG_ID_S = flag("--program", process.env.PROGRAM_ID   || "74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf");

    // Find IDL
    const IDL_CANDIDATES = [
      path.join(__dirname, "../target/idl/life_core.json"),
      "/tmp/life-compute/core/target/idl/life_core.json",
    ];
    let idlPath = IDL_CANDIDATES.find(p => fs.existsSync(p));
    if (!idlPath) { console.error("IDL not found"); process.exit(1); }

    const connection = new web3.Connection(RPC_URL, "confirmed");
    // Read-only — use a throwaway keypair as wallet (no signing needed for read)
    const dummy = web3.Keypair.generate();
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(dummy),
                                               { commitment: "confirmed" });
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    idl.address = PROG_ID_S;
    const program   = new anchor.Program(idl, provider);
    const programId = new web3.PublicKey(PROG_ID_S);
    const [networkConfigPda] = web3.PublicKey.findProgramAddressSync(
      [SEED_NETWORK_CONFIG], programId
    );

    await printValidatorReport(program, networkConfigPda);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = {
  getActiveValidators,
  pickRandomValidator,
  getValidatorReputation,
  printValidatorReport,
  validatorAccountPda,
};
