//! Branch sequence floor / effective-max helpers (no DB).
//!
//! A branch's sequence high-water is the max of:
//! - MAX(seq) among envelopes stored directly on that branch
//! - the branch's own fork_seq (inherited floor for empty child branches)
//!
//! After restart, counters must re-hydrate from both sources so nested forks
//! without direct envelopes do not reset to 0.

/// Effective sequence floor / parent max for a branch.
pub fn effective_branch_high_water(
    direct_max_seq: Option<u64>,
    fork_seq: Option<u64>,
) -> u64 {
    direct_max_seq.unwrap_or(0).max(fork_seq.unwrap_or(0))
}

/// Whether `fork_seq` is allowed on a parent with the given effective max.
pub fn fork_seq_within_parent(fork_seq: u64, parent_effective_max: u64) -> bool {
    fork_seq <= parent_effective_max
}

/// Apply a persisted floor into an in-memory counter value (race-safe merge).
pub fn merge_seq_floor(current: u64, floor: u64) -> u64 {
    current.max(floor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_child_uses_fork_floor() {
        assert_eq!(effective_branch_high_water(None, Some(7)), 7);
        assert_eq!(effective_branch_high_water(Some(0), Some(7)), 7);
    }

    #[test]
    fn direct_envelopes_dominate_when_higher() {
        assert_eq!(effective_branch_high_water(Some(12), Some(7)), 12);
        assert_eq!(effective_branch_high_water(Some(3), None), 3);
    }

    #[test]
    fn nested_empty_parent_allows_inherited_fork_point() {
        // Parent is itself a fork at seq 5 with no direct envelopes yet.
        let parent_max = effective_branch_high_water(None, Some(5));
        assert_eq!(parent_max, 5);
        assert!(fork_seq_within_parent(5, parent_max));
        assert!(fork_seq_within_parent(3, parent_max));
        assert!(!fork_seq_within_parent(6, parent_max));
    }

    #[test]
    fn merge_floor_is_monotonic() {
        assert_eq!(merge_seq_floor(0, 9), 9);
        assert_eq!(merge_seq_floor(12, 9), 12);
        assert_eq!(merge_seq_floor(9, 9), 9);
    }
}
