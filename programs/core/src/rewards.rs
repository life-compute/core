// ─── LIFE Compute — Two-Layer Halving Reward Calculator ──────────────────────
//
// Layer 1 — Supply Milestones (based on total_minted, in raw units):
//   0        ..= 5_250_000 LIFE  →  100%   (8/8)
//   5_250_001 ..= 10_500_000 LIFE →   50%   (4/8)
//   10_500_001 ..= 15_750_000 LIFE →   25%   (2/8)
//   15_750_001 ..  21_000_000 LIFE →  12.5%  (1/8)
//
// Layer 2 — Target Hit Count (per-target confirmed submissions):
//   0   ..=  99   →  100%  (4/4)
//   100 ..= 999   →   75%  (3/4)
//   1000 ..        →   50%  (2/4)
//
// Combined: final = base * l1_num * l2_num / 32
//
// Example: Hard target (25 LIFE base), milestone-2 (4/8), 150 hits (3/4):
//   25_000_000 * 4 * 3 / 32 = 9_375_000 raw = 9.375 LIFE ✓
//
// All arithmetic is checked (no panics). Returns None on overflow.
// ─────────────────────────────────────────────────────────────────────────────

use crate::constants::*;

/// Compute the halved reward for a single confirmed submission.
///
/// Three independent halving layers applied in sequence:
///
/// **Layer 0 — Epoch-based schedule** (new):
///   Every HALVING_INTERVAL epochs the initial base reward is halved by bit-shifting
///   right.  current_halving = current_epoch / HALVING_INTERVAL.
///   epoch_adjusted = initial_base_reward >> current_halving, minimum 1 raw unit.
///
/// **Layer 1 — Supply milestones** (existing):
///   Based on cumulative total_minted vs HALVING_MILESTONE_*.
///
/// **Layer 2 — Per-target hit count** (existing):
///   Based on how many confirmed results this target has accumulated.
///
/// # Arguments
/// * `base_reward`    — flat reward for this difficulty tier (raw units)
/// * `total_minted`   — cumulative LIFE minted so far (raw units, BEFORE this mint)
/// * `hit_count`      — cumulative confirmed hits for this target (BEFORE this one)
/// * `current_epoch`  — current network epoch (from NetworkConfig)
///
/// # Returns
/// `Some((final_reward_raw, supply_tier, hit_tier))` or `None` on overflow.
/// * `supply_tier`: 0=100%, 1=50%, 2=25%, 3=12.5%
/// * `hit_tier`:    0=100%, 1=75%, 2=50%
pub fn calculate_reward(
    base_reward: u64,
    total_minted: u64,
    hit_count: u64,
    current_epoch: u64,
) -> Option<(u64, u8, u8)> {
    // ── Layer 0: epoch-based halving ──────────────────────────────────────────
    // Shift right by the number of halvings that have occurred.
    // Saturate at 63 to avoid undefined shift behaviour on u64.
    let current_halving = current_epoch / HALVING_INTERVAL;
    let epoch_adjusted: u64 = if current_halving >= 64 {
        1 // minimum floor
    } else {
        base_reward.checked_shr(current_halving as u32)
            .unwrap_or(1)
            .max(1) // never zero
    };

    // ── Layer 1: supply milestone ─────────────────────────────────────────────
    let (l1_num, supply_tier): (u64, u8) = if total_minted <= HALVING_MILESTONE_1 {
        (8, 0) // 100%
    } else if total_minted <= HALVING_MILESTONE_2 {
        (4, 1) // 50%
    } else if total_minted <= HALVING_MILESTONE_3 {
        (2, 2) // 25%
    } else {
        (1, 3) // 12.5%
    };

    // ── Layer 2: target hit count ─────────────────────────────────────────────
    let (l2_num, hit_tier): (u64, u8) = if hit_count < HALVING_HIT_TIER_1 {
        (4, 0) // 100%
    } else if hit_count < HALVING_HIT_TIER_2 {
        (3, 1) // 75%
    } else {
        (2, 2) // 50%
    };

    // ── Combined: epoch_adjusted * l1_num * l2_num / 32 ──────────────────────
    // Denominator is always 8 * 4 = 32.  Minimum final reward = 1 raw unit.
    let numerator = epoch_adjusted
        .checked_mul(l1_num)?
        .checked_mul(l2_num)?;
    let final_reward = numerator.checked_div(32)?.max(1);

    Some((final_reward, supply_tier, hit_tier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    fn life(n: u64) -> u64 {
        n * ONE_LIFE
    }

    // ── Supply tier selection (epoch=0 → no epoch halving) ────────────────────

    #[test]
    fn tier1_boundary_inclusive() {
        let (amt, s, h) = calculate_reward(life(25), HALVING_MILESTONE_1, 0, 0).unwrap();
        assert_eq!(s, 0);
        assert_eq!(h, 0);
        assert_eq!(amt, life(25));
    }

    #[test]
    fn tier2_starts_after_milestone1() {
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_1 + 1, 0, 0).unwrap();
        assert_eq!(s, 1);
        assert_eq!(amt, life(25) / 2);
    }

    #[test]
    fn tier3_starts_after_milestone2() {
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_2 + 1, 0, 0).unwrap();
        assert_eq!(s, 2);
        assert_eq!(amt, life(25) / 4);
    }

    #[test]
    fn tier4_starts_after_milestone3() {
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_3 + 1, 0, 0).unwrap();
        assert_eq!(s, 3);
        assert_eq!(amt, life(25) / 8);
    }

    // ── Hit tier selection ─────────────────────────────────────────────────────

    #[test]
    fn hit_tier_0_at_99_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 99, 0).unwrap();
        assert_eq!(h, 0);
    }

    #[test]
    fn hit_tier_1_at_100_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 100, 0).unwrap();
        assert_eq!(h, 1);
    }

    #[test]
    fn hit_tier_2_at_1000_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 1000, 0).unwrap();
        assert_eq!(h, 2);
    }

    // ── Whitepaper example ─────────────────────────────────────────────────────

    #[test]
    fn whitepaper_example_hard_milestone2_150_hits() {
        // Hard (25 LIFE), supply tier 2 (50%), 150 hits (75%) → 9.375 LIFE
        let minted = HALVING_MILESTONE_1 + ONE_LIFE;
        let (amt, s, h) = calculate_reward(life(25), minted, 150, 0).unwrap();
        assert_eq!(s, 1);
        assert_eq!(h, 1);
        assert_eq!(amt, 9_375_000);
    }

    // ── All tiers combined ─────────────────────────────────────────────────────

    #[test]
    fn all_tiers_combined_minimum() {
        // Hard, milestone-4 (12.5%), 1000+ hits (50%) → 25 × 0.125 × 0.5 = 1.5625 LIFE
        let (amt, s, h) = calculate_reward(life(25), HALVING_MILESTONE_3 + 1, 1000, 0).unwrap();
        assert_eq!(s, 3);
        assert_eq!(h, 2);
        assert_eq!(amt, 1_562_500);
    }

    #[test]
    fn easy_target_full_reward() {
        let (amt, s, h) = calculate_reward(life(1), 0, 0, 0).unwrap();
        assert_eq!(s, 0);
        assert_eq!(h, 0);
        assert_eq!(amt, life(1));
    }

    #[test]
    fn medium_target_full_reward() {
        let (amt, _, _) = calculate_reward(life(5), 0, 0, 0).unwrap();
        assert_eq!(amt, life(5));
    }

    // ── Epoch-based halving (Layer 0) ──────────────────────────────────────────

    #[test]
    fn epoch_halving_first_interval() {
        // At epoch HALVING_INTERVAL (1 halving): 25 LIFE >> 1 = 12.5 LIFE
        let (amt, _, _) = calculate_reward(life(25), 0, 0, HALVING_INTERVAL).unwrap();
        assert_eq!(amt, life(25) / 2);
    }

    #[test]
    fn epoch_halving_second_interval() {
        // At epoch 2 × HALVING_INTERVAL (2 halvings): 25 LIFE >> 2 = 6.25 LIFE
        let (amt, _, _) = calculate_reward(life(25), 0, 0, HALVING_INTERVAL * 2).unwrap();
        assert_eq!(amt, life(25) / 4);
    }

    #[test]
    fn epoch_halving_minimum_floor() {
        // After many halvings, result must be ≥ 1 raw unit
        let (amt, _, _) = calculate_reward(life(1), 0, 0, HALVING_INTERVAL * 30).unwrap();
        assert!(amt >= 1);
    }

    #[test]
    fn crispr_reward_epoch0() {
        // CRISPR base = 7 LIFE, epoch 0 → full reward
        let (amt, _, _) = calculate_reward(REWARD_CRISPR, 0, 0, 0).unwrap();
        assert_eq!(amt, life(7));
    }

    #[test]
    fn crispr_reward_after_one_halving() {
        // CRISPR after 1 halving → 3.5 LIFE = 3_500_000 raw
        let (amt, _, _) = calculate_reward(REWARD_CRISPR, 0, 0, HALVING_INTERVAL).unwrap();
        assert_eq!(amt, REWARD_CRISPR / 2);
    }
}
