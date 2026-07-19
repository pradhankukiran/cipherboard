use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::encode::BoardEvent;
use crate::replay::{compute_snapshot, BoardSnapshot, TimelineEntry};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchMeta {
    pub id: String,
    pub parent_branch_id: Option<String>,
    pub fork_seq: Option<u64>,
}

/// Collect timeline entries visible on `branch_id`: recursive parent history
/// through each fork_seq, then events on the child branch itself.
pub fn collect_branch_entries(
    all: &[TimelineEntry],
    branches: &[BranchMeta],
    branch_id: &str,
) -> Vec<TimelineEntry> {
    let mut chain: Vec<(String, Option<u64>)> = Vec::new();
    let mut cur = Some(branch_id.to_string());
    let mut guard = 0;
    while let Some(id) = cur {
        guard += 1;
        if guard > 64 {
            break;
        }
        let meta = branches.iter().find(|b| b.id == id);
        let fork = meta.and_then(|m| m.fork_seq);
        let parent = meta.and_then(|m| m.parent_branch_id.clone());
        chain.push((id, fork));
        cur = parent;
    }
    chain.reverse();

    let mut out: Vec<TimelineEntry> = Vec::new();
    for (i, (id, _fork)) in chain.iter().enumerate() {
        let is_leaf = i + 1 == chain.len();
        let limit = if is_leaf {
            u64::MAX
        } else {
            // parent contribution stops at child's fork_seq
            chain[i + 1].1.unwrap_or(0)
        };
        for e in all.iter().filter(|e| e.branch_id == *id && e.seq <= limit) {
            // skip cursors in inherited history
            if matches!(e.event, BoardEvent::Cursor { .. }) {
                continue;
            }
            out.push(e.clone());
        }
    }
    out.sort_by(|a, b| a.seq.cmp(&b.seq).then_with(|| a.event_id.cmp(&b.event_id)));
    out
}

#[wasm_bindgen]
pub fn branch_timeline(
    entries_json: &str,
    branches_json: &str,
    branch_id: &str,
) -> Result<String, String> {
    let entries: Vec<TimelineEntry> =
        serde_json::from_str(entries_json).map_err(|e| format!("entries: {e}"))?;
    let branches: Vec<BranchMeta> =
        serde_json::from_str(branches_json).map_err(|e| format!("branches: {e}"))?;
    let collected = collect_branch_entries(&entries, &branches, branch_id);
    serde_json::to_string(&collected).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn replay_branch(
    entries_json: &str,
    branches_json: &str,
    branch_id: &str,
    through_seq: u64,
    author_filter: Option<String>,
) -> Result<String, String> {
    let entries: Vec<TimelineEntry> =
        serde_json::from_str(entries_json).map_err(|e| format!("entries: {e}"))?;
    let branches: Vec<BranchMeta> =
        serde_json::from_str(branches_json).map_err(|e| format!("branches: {e}"))?;
    let collected = collect_branch_entries(&entries, &branches, branch_id);
    let snap: BoardSnapshot =
        compute_snapshot(&collected, through_seq, author_filter.as_deref());
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::BoardEvent;
    use crate::smooth::Point;

    fn te(seq: u64, branch: &str, id: &str) -> TimelineEntry {
        TimelineEntry {
            seq,
            event_id: format!("e{seq}"),
            sender_id: "a".into(),
            branch_id: branch.into(),
            event: BoardEvent::StrokeEnd { id: id.into() },
        }
    }

    fn begin(seq: u64, branch: &str, id: &str) -> TimelineEntry {
        TimelineEntry {
            seq,
            event_id: format!("b{seq}"),
            sender_id: "a".into(),
            branch_id: branch.into(),
            event: BoardEvent::StrokeBegin {
                id: id.into(),
                color: "#000".into(),
                width: 2.0,
                tool: "pen".into(),
            },
        }
    }

    #[test]
    fn fork_inherits_parent_through_fork_seq() {
        let entries = vec![
            begin(1, "main", "s1"),
            te(2, "main", "s1"),
            begin(3, "main", "s2"),
            te(4, "main", "s2"),
            begin(5, "fork", "s3"),
            te(6, "fork", "s3"),
        ];
        // Also need stroke end only works if begin exists - for collect we just check seqs
        let branches = vec![
            BranchMeta {
                id: "main".into(),
                parent_branch_id: None,
                fork_seq: None,
            },
            BranchMeta {
                id: "fork".into(),
                parent_branch_id: Some("main".into()),
                fork_seq: Some(2),
            },
        ];
        let col = collect_branch_entries(&entries, &branches, "fork");
        let seqs: Vec<u64> = col.iter().map(|e| e.seq).collect();
        assert!(seqs.contains(&1));
        assert!(seqs.contains(&2));
        assert!(!seqs.contains(&3));
        assert!(!seqs.contains(&4));
        assert!(seqs.contains(&5));
        assert!(seqs.contains(&6));
    }

    #[test]
    fn nested_fork_inheritance() {
        let entries = vec![
            te(1, "main", "a"),
            te(2, "main", "b"),
            te(3, "mid", "c"),
            te(4, "leaf", "d"),
        ];
        let branches = vec![
            BranchMeta {
                id: "main".into(),
                parent_branch_id: None,
                fork_seq: None,
            },
            BranchMeta {
                id: "mid".into(),
                parent_branch_id: Some("main".into()),
                fork_seq: Some(1),
            },
            BranchMeta {
                id: "leaf".into(),
                parent_branch_id: Some("mid".into()),
                fork_seq: Some(3),
            },
        ];
        let col = collect_branch_entries(&entries, &branches, "leaf");
        let seqs: Vec<u64> = col.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 3, 4]);
    }

    #[test]
    fn replay_fork_shows_parent_strokes() {
        let entries = vec![
            TimelineEntry {
                seq: 1,
                event_id: "e1".into(),
                sender_id: "a".into(),
                branch_id: "main".into(),
                event: BoardEvent::StrokeBegin {
                    id: "s1".into(),
                    color: "#111".into(),
                    width: 2.0,
                    tool: "pen".into(),
                },
            },
            TimelineEntry {
                seq: 2,
                event_id: "e2".into(),
                sender_id: "a".into(),
                branch_id: "main".into(),
                event: BoardEvent::StrokePoints {
                    id: "s1".into(),
                    points: vec![Point {
                        x: 1.0,
                        y: 1.0,
                        p: 1.0,
                    }],
                },
            },
            TimelineEntry {
                seq: 3,
                event_id: "e3".into(),
                sender_id: "a".into(),
                branch_id: "main".into(),
                event: BoardEvent::StrokeEnd { id: "s1".into() },
            },
        ];
        let branches = vec![
            BranchMeta {
                id: "main".into(),
                parent_branch_id: None,
                fork_seq: None,
            },
            BranchMeta {
                id: "fork".into(),
                parent_branch_id: Some("main".into()),
                fork_seq: Some(3),
            },
        ];
        let json = serde_json::to_string(&entries).unwrap();
        let bj = serde_json::to_string(&branches).unwrap();
        let snap: BoardSnapshot =
            serde_json::from_str(&replay_branch(&json, &bj, "fork", 3, None).unwrap()).unwrap();
        assert_eq!(snap.strokes.len(), 1);
        assert_eq!(snap.strokes[0].id, "s1");
    }
}
