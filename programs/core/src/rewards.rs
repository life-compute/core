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
/// # Arguments
/// * `base_reward`   — flat reward for this difficulty tier (raw units)
/// * `total_minted`  — cumulative LIFE minted so far (raw units, BEFORE this mint)
/// * `hit_count`     — cumulative confirmed hits for this target (BEFORE this one)
///
/// # Returns
/// `Some((final_reward_raw, supply_tier, hit_tier))` or `None` on overflow.
/// * `supply_tier`: 0=100%, 1=50%, 2=25%, 3=12.5%
/// * `hit_tier`:    0=100%, 1=75%, 2=50%
pub fn calculate_reward(
    base_reward: u64,
    total_minted: u64,
    hit_count: u64,
) -> Option<(u64, u8, u8)> {
    // ── Layer 1: supply milestone ─────────────────────────────────────────────
    // Milestones in raw token units (6 decimals).
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

    // ── Combined: base * l1_num * l2_num / 32 ────────────────────────────────
    // Denominator is always 8 * 4 = 32.
    let numerator = base_reward
        .checked_mul(l1_num)?
        .checked_mul(l2_num)?;
    let final_reward = numerator.checked_div(32)?;

    Some((final_reward, supply_tier, hit_tier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    // Helper: raw units for N LIFE
    fn life(n: u64) -> u64 { n * ONE_LIFE }

    // ── Supply tier selection ──────────────────────────────────────────────────

    #[test]
    fn tier1_boundary_inclusive() {
        // Exactly at 5,250,000 LIFE → tier 0 (100%)
        let (amt, s, h) = calculate_reward(life(25), HALVING_MILESTONE_1, 0).unwrap();
        assert_eq!(s, 0);
        assert_eq!(h, 0);
        assert_eq!(amt, life(25)); // 25 * 8 * 4 / 32 = 25
    }

    #[test]
    fn tier2_starts_after_milestone1() {
        // 5,250,001 LIFE minted → tier 1 (50%)
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_1 + 1, 0).unwrap();
        assert_eq!(s, 1);
        assert_eq!(amt, life(25) / 2); // 12.5 LIFE
    }

    #[test]
    fn tier3_starts_after_milestone2() {
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_2 + 1, 0).unwrap();
        assert_eq!(s, 2);
        assert_eq!(amt, life(25) / 4); // 6.25 LIFE
    }

    #[test]
    fn tier4_starts_after_milestone3() {
        let (amt, s, _) = calculate_reward(life(25), HALVING_MILESTONE_3 + 1, 0).unwrap();
        assert_eq!(s, 3);
        assert_eq!(amt, life(25) / 8); // 3.125 LIFE
    }

    // ── Hit tier selection ─────────────────────────────────────────────────────

    #[test]
    fn hit_tier_0_at_99_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 99).unwrap();
        assert_eq!(h, 0);
    }

    #[test]
    fn hit_tier_1_at_100_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 100).unwrap();
        assert_eq!(h, 1);
    }

    #[test]
    fn hit_tier_2_at_1000_hits() {
        let (_, _, h) = calculate_reward(life(1), 0, 1000).unwrap();
        assert_eq!(h, 2);
    }

    // ── Whitepaper example ─────────────────────────────────────────────────────

    #[test]
    fn whitepaper_example_hard_milestone2_150_hits() {
        // Hard target (25 LIFE base) at supply milestone 2 with 150 hits
        // = 25 × 0.50 × 0.75 = 9.375 LIFE = 9_375_000 raw
        let minted = HALVING_MILESTONE_1 + ONE_LIFE; // just into milestone 2
        let (amt, s, h) = calculate_reward(life(25), minted, 150).unwrap();
        assert_eq!(s, 1); // 50%
        assert_eq!(h, 1); // 75%
        assert_eq!(amt, 9_375_000);
    }

    // ── All tiers combined ─────────────────────────────────────────────────────

    #[test]
    fn all_tiers_combined_minimum() {
        // Milestone 4 (12.5%) × hit tier 2 (50%) on Hard = 25 × 0.125 × 0.5 = 1.5625 LIFE
        // 25_000_000 * 1 * 2 / 32 = 1_562_500
        let (amt, s, h) = calculate_reward(life(25), HALVING_MILESTONE_3 + 1, 1000).unwrap();
        assert_eq!(s, 3);
        assert_eq!(h, 2);
        assert_eq!(amt, 1_562_500);
    }

    #[test]
    fn easy_target_full_reward() {
        // Easy target, no halving
        let (amt, s, h) = calculate_reward(life(1), 0, 0).unwrap();
        assert_eq!(s, 0);
        assert_eq!(h, 0);
        assert_eq!(amt, life(1));
    }

    #[test]
    fn medium_target_full_reward() {
        let (amt, _, _) = calculate_reward(life(5), 0, 0).unwrap();
        assert_eq!(amt, life(5));
    }
}
