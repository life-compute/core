// ─── LIFE Compute — Flat Reward Calculator ───────────────────────────────────
//
// Rewards are FLAT.  There is no halving, no emission schedule, and no
// supply-based reduction of any kind.
//
// Removed 2026-09:
//   * Layer 0 — epoch-based halving (HALVING_INTERVAL, checked_shr).
//     Rewards no longer decrease with the passage of time.
//   * Layer 1 — supply milestones (HALVING_MILESTONE_1/2/3).
//     These were fractions of the old 21,000,000 fixed cap.  The cap is gone,
//     so there is nothing to measure milestones against.
//
// Retained:
//   * Layer 2 — per-target hit count.  This is NOT a monetary schedule; it
//     encodes scientific maturity.  The thousandth confirmed hit on a target
//     yields less new information than the first, so the reward tapers:
//
//       0    ..=   99 hits  →  100%  (4/4)
//       100  ..=  999 hits  →   75%  (3/4)
//       1000 ..             →   50%  (2/4)
//
// Combined: final = base * l2_num / 4
//
// Example: Hard target (0.9 LIFE base) with 150 confirmed hits (3/4):
//   900_000 * 3 / 4 = 675_000 raw = 0.675 LIFE ✓
//
// All arithmetic is checked (no panics). Returns None on overflow.
// ─────────────────────────────────────────────────────────────────────────────

use crate::constants::*;

/// Compute the reward for a single confirmed submission.
///
/// Only one reduction layer remains:
///
/// **Layer 2 — Per-target hit count:**
///   Based on how many confirmed results this target has already accumulated.
///   Reflects diminishing scientific return, not token scarcity.
///
/// # Arguments
/// * `base_reward` — flat reward for this difficulty tier (raw units)
/// * `hit_count`   — cumulative confirmed hits for this target (BEFORE this one)
///
/// # Returns
/// `Some((final_reward_raw, supply_tier, hit_tier))` or `None` on overflow.
/// * `supply_tier`: always 0 — retained in the tuple (and in the `RewardMinted`
///   event) purely for ABI/indexer compatibility.  Supply milestones no longer
///   exist, so this value is meaningless and must not be interpreted.
/// * `hit_tier`:    0=100%, 1=75%, 2=50%
pub fn calculate_reward(base_reward: u64, hit_count: u64) -> Option<(u64, u8, u8)> {
    // ── Layer 2: target hit count ─────────────────────────────────────────────
    let (l2_num, hit_tier): (u64, u8) = if hit_count < HALVING_HIT_TIER_1 {
        (4, 0) // 100%
    } else if hit_count < HALVING_HIT_TIER_2 {
        (3, 1) // 75%
    } else {
        (2, 2) // 50%
    };

    // ── final = base * l2_num / 4.  Minimum final reward = 1 raw unit. ───────
    let final_reward = base_reward.checked_mul(l2_num)?.checked_div(4)?.max(1);

    // supply_tier is hard-coded 0: supply milestones were removed.
    Some((final_reward, 0, hit_tier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    // ── Flat tier rewards at low hit count (no reduction) ─────────────────────

    #[test]
    fn easy_target_flat_reward() {
        let (amt, s, h) = calculate_reward(REWARD_EASY, 0).unwrap();
        assert_eq!(amt, 300_000); // 0.3 LIFE
        assert_eq!(s, 0);
        assert_eq!(h, 0);
    }

    #[test]
    fn medium_target_flat_reward() {
        let (amt, _, _) = calculate_reward(REWARD_MEDIUM, 0).unwrap();
        assert_eq!(amt, 700_000); // 0.7 LIFE
    }

    #[test]
    fn hard_target_flat_reward() {
        let (amt, _, _) = calculate_reward(REWARD_HARD, 0).unwrap();
        assert_eq!(amt, 900_000); // 0.9 LIFE
    }

    #[test]
    fn mrna_target_flat_reward() {
        // mRNA is always Hard tier.
        let (amt, _, _) = calculate_reward(REWARD_MRNA, 0).unwrap();
        assert_eq!(amt, 900_000); // 0.9 LIFE
        assert_eq!(REWARD_MRNA, REWARD_HARD);
    }

    #[test]
    fn crispr_target_flat_reward() {
        let (amt, _, _) = calculate_reward(REWARD_CRISPR, 0).unwrap();
        assert_eq!(amt, 252_000); // 0.252 LIFE
    }

    #[test]
    fn reference_compound_flat_reward() {
        // 3.0 LIFE scaled by the Hard reduction ratio (0.9 / 25) = 0.108 LIFE.
        let (amt, _, _) = calculate_reward(REWARD_REFERENCE, 0).unwrap();
        assert_eq!(amt, 108_000);
    }

    #[test]
    fn discovery_bonus_unchanged() {
        // Part 4: the 100 LIFE weekly bonus must remain exactly 100 LIFE.
        assert_eq!(REWARD_DISCOVERY, 100 * ONE_LIFE);
    }

    #[test]
    fn validator_crispr_commission_matches_miner_reward() {
        assert_eq!(VALIDATOR_REWARD_CRISPR, REWARD_CRISPR);
    }

    // ── Tier relativities are preserved ───────────────────────────────────────

    #[test]
    fn tier_ordering_is_monotonic() {
        assert!(REWARD_EASY < REWARD_MEDIUM);
        assert!(REWARD_MEDIUM < REWARD_HARD);
        // CRISPR (CPU-scored) must stay below Hard (full GPU Boltz2 run).
        assert!(REWARD_CRISPR < REWARD_HARD);
    }

    // ── Layer 2 hit-count taper (RETAINED) ────────────────────────────────────

    #[test]
    fn hit_tier_0_at_99_hits() {
        let (amt, _, h) = calculate_reward(REWARD_HARD, 99).unwrap();
        assert_eq!(h, 0);
        assert_eq!(amt, 900_000); // 100%
    }

    #[test]
    fn hit_tier_1_at_100_hits() {
        let (amt, _, h) = calculate_reward(REWARD_HARD, 100).unwrap();
        assert_eq!(h, 1);
        assert_eq!(amt, 675_000); // 0.9 * 0.75 = 0.675 LIFE
    }

    #[test]
    fn hit_tier_1_at_150_hits() {
        // Worked example from the module docs.
        let (amt, _, h) = calculate_reward(REWARD_HARD, 150).unwrap();
        assert_eq!(h, 1);
        assert_eq!(amt, 675_000);
    }

    #[test]
    fn hit_tier_2_at_1000_hits() {
        let (amt, _, h) = calculate_reward(REWARD_HARD, 1000).unwrap();
        assert_eq!(h, 2);
        assert_eq!(amt, 450_000); // 0.9 * 0.50 = 0.45 LIFE
    }

    #[test]
    fn hit_taper_applies_to_every_tier() {
        // Easy at 1000+ hits: 0.3 * 0.5 = 0.15 LIFE
        let (amt, _, _) = calculate_reward(REWARD_EASY, 1000).unwrap();
        assert_eq!(amt, 150_000);
        // CRISPR at 1000+ hits: 0.252 * 0.5 = 0.126 LIFE
        let (amt, _, _) = calculate_reward(REWARD_CRISPR, 1000).unwrap();
        assert_eq!(amt, 126_000);
    }

    // ── No time / supply dependence ───────────────────────────────────────────

    #[test]
    fn reward_is_independent_of_time_and_supply() {
        // calculate_reward no longer accepts total_minted or current_epoch.
        // Same hit_count must always yield the same reward, forever.
        let a = calculate_reward(REWARD_HARD, 0).unwrap();
        let b = calculate_reward(REWARD_HARD, 0).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.0, 900_000);
    }

    #[test]
    fn no_supply_milestone_reduction_at_any_volume() {
        // Previously 5.25M/10.5M/15.75M minted triggered 50/25/12.5% cuts.
        // Those milestones are gone; reward depends only on hit_count now.
        let low = calculate_reward(REWARD_HARD, 0).unwrap().0;
        let high = calculate_reward(REWARD_HARD, 0).unwrap().0;
        assert_eq!(low, high);
        assert_eq!(low, REWARD_HARD);
    }

    #[test]
    fn supply_tier_is_always_zero() {
        // Retained in the tuple for event/ABI compatibility only.
        for hits in [0u64, 100, 1000, 10_000] {
            assert_eq!(calculate_reward(REWARD_HARD, hits).unwrap().1, 0);
        }
    }

    // ── Safety ────────────────────────────────────────────────────────────────

    #[test]
    fn minimum_reward_floor_is_one_raw_unit() {
        // A 1-raw-unit base at the harshest taper must still mint >= 1.
        let (amt, _, _) = calculate_reward(1, 10_000).unwrap();
        assert!(amt >= 1);
    }

    #[test]
    fn overflow_is_handled() {
        // base * 4 would overflow u64; must return None, not panic.
        assert!(calculate_reward(u64::MAX, 0).is_none());
    }
}
