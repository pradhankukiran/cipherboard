use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::encode::BoardEvent;
use crate::smooth::Point;

/// A timeline entry used for Private Time Travel replay computation.
/// Ciphertext is decrypted in JS before being passed here as plaintext events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub seq: u64,
    pub event_id: String,
    pub sender_id: String,
    pub branch_id: String,
    pub event: BoardEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrokeRecord {
    pub id: String,
    pub sender_id: String,
    pub color: String,
    pub width: f64,
    pub tool: String,
    pub points: Vec<Point>,
    pub erased: bool,
    pub seq_begin: u64,
    pub seq_end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BoardSnapshot {
    pub strokes: Vec<StrokeRecord>,
    pub undo_stack: Vec<String>,
    pub redo_stack: Vec<String>,
    pub last_seq: u64,
}

/// Replay timeline entries up to `through_seq` (inclusive). Optional author filter.
#[wasm_bindgen]
pub fn replay_through(
    entries_json: &str,
    through_seq: u64,
    author_filter: Option<String>,
) -> Result<String, String> {
    let entries: Vec<TimelineEntry> = serde_json::from_str(entries_json)
        .map_err(|e| format!("replay: bad entries: {e}"))?;
    let snap = compute_snapshot(&entries, through_seq, author_filter.as_deref());
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

/// Compute fork base: snapshot at fork point for a new branch.
#[wasm_bindgen]
pub fn fork_snapshot(entries_json: &str, fork_seq: u64) -> Result<String, String> {
    replay_through(entries_json, fork_seq, None)
}

pub fn compute_snapshot(
    entries: &[TimelineEntry],
    through_seq: u64,
    author_filter: Option<&str>,
) -> BoardSnapshot {
    let mut snap = BoardSnapshot::default();
    let mut active: std::collections::HashMap<String, StrokeRecord> =
        std::collections::HashMap::new();

    for entry in entries.iter().filter(|e| e.seq <= through_seq) {
        if let Some(author) = author_filter {
            if entry.sender_id != author {
                // Still advance last_seq for ordering awareness
                snap.last_seq = entry.seq;
                continue;
            }
        }
        snap.last_seq = entry.seq;
        match &entry.event {
            BoardEvent::StrokeBegin {
                id,
                color,
                width,
                tool,
            } => {
                active.insert(
                    id.clone(),
                    StrokeRecord {
                        id: id.clone(),
                        sender_id: entry.sender_id.clone(),
                        color: color.clone(),
                        width: *width,
                        tool: tool.clone(),
                        points: Vec::new(),
                        erased: false,
                        seq_begin: entry.seq,
                        seq_end: entry.seq,
                    },
                );
            }
            BoardEvent::StrokePoints { id, points } => {
                if let Some(s) = active.get_mut(id) {
                    s.points.extend_from_slice(points);
                    s.seq_end = entry.seq;
                }
            }
            BoardEvent::StrokeEnd { id } => {
                if let Some(mut s) = active.remove(id) {
                    s.seq_end = entry.seq;
                    snap.undo_stack.push(s.id.clone());
                    snap.strokes.push(s);
                    snap.redo_stack.clear();
                }
            }
            BoardEvent::Erase { id, points, width } => {
                // Treat erase as a special stroke with tool=eraser
                let rec = StrokeRecord {
                    id: id.clone(),
                    sender_id: entry.sender_id.clone(),
                    color: "#ffffff".into(),
                    width: *width,
                    tool: "eraser".into(),
                    points: points.clone(),
                    erased: false,
                    seq_begin: entry.seq,
                    seq_end: entry.seq,
                };
                snap.undo_stack.push(rec.id.clone());
                snap.strokes.push(rec);
                snap.redo_stack.clear();
            }
            BoardEvent::Clear { .. } => {
                for s in snap.strokes.iter_mut() {
                    s.erased = true;
                }
                snap.undo_stack.clear();
                snap.redo_stack.clear();
            }
            BoardEvent::Undo { target } => {
                if let Some(s) = snap.strokes.iter_mut().rev().find(|s| s.id == *target) {
                    s.erased = true;
                    snap.redo_stack.push(target.clone());
                    snap.undo_stack.retain(|id| id != target);
                }
            }
            BoardEvent::Redo { target } => {
                if let Some(s) = snap.strokes.iter_mut().rev().find(|s| s.id == *target) {
                    s.erased = false;
                    snap.undo_stack.push(target.clone());
                    snap.redo_stack.retain(|id| id != target);
                }
            }
            BoardEvent::Cursor { .. } | BoardEvent::SnapshotMarker { .. } => {}
        }
    }

    // Flush unfinished strokes as visible
    for (_, s) in active {
        snap.strokes.push(s);
    }

    snap
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::BoardEvent;
    use crate::smooth::Point;

    fn entry(seq: u64, sender: &str, event: BoardEvent) -> TimelineEntry {
        TimelineEntry {
            seq,
            event_id: format!("e{seq}"),
            sender_id: sender.into(),
            branch_id: "main".into(),
            event,
        }
    }

    #[test]
    fn replay_builds_stroke() {
        let entries = vec![
            entry(
                1,
                "a",
                BoardEvent::StrokeBegin {
                    id: "s1".into(),
                    color: "#111".into(),
                    width: 2.0,
                    tool: "pen".into(),
                },
            ),
            entry(
                2,
                "a",
                BoardEvent::StrokePoints {
                    id: "s1".into(),
                    points: vec![
                        Point {
                            x: 1.0,
                            y: 2.0,
                            p: 1.0,
                        },
                        Point {
                            x: 3.0,
                            y: 4.0,
                            p: 1.0,
                        },
                    ],
                },
            ),
            entry(3, "a", BoardEvent::StrokeEnd { id: "s1".into() }),
        ];
        let snap = compute_snapshot(&entries, 3, None);
        assert_eq!(snap.strokes.len(), 1);
        assert_eq!(snap.strokes[0].points.len(), 2);
        assert!(!snap.strokes[0].erased);
    }

    #[test]
    fn undo_marks_erased() {
        let entries = vec![
            entry(
                1,
                "a",
                BoardEvent::StrokeBegin {
                    id: "s1".into(),
                    color: "#111".into(),
                    width: 2.0,
                    tool: "pen".into(),
                },
            ),
            entry(2, "a", BoardEvent::StrokeEnd { id: "s1".into() }),
            entry(3, "a", BoardEvent::Undo { target: "s1".into() }),
        ];
        let snap = compute_snapshot(&entries, 3, None);
        assert!(snap.strokes[0].erased);
    }

    #[test]
    fn author_filter() {
        let entries = vec![
            entry(
                1,
                "a",
                BoardEvent::StrokeBegin {
                    id: "s1".into(),
                    color: "#111".into(),
                    width: 2.0,
                    tool: "pen".into(),
                },
            ),
            entry(2, "a", BoardEvent::StrokeEnd { id: "s1".into() }),
            entry(
                3,
                "b",
                BoardEvent::StrokeBegin {
                    id: "s2".into(),
                    color: "#222".into(),
                    width: 2.0,
                    tool: "pen".into(),
                },
            ),
            entry(4, "b", BoardEvent::StrokeEnd { id: "s2".into() }),
        ];
        let snap = compute_snapshot(&entries, 4, Some("a"));
        assert_eq!(snap.strokes.len(), 1);
        assert_eq!(snap.strokes[0].id, "s1");
    }
}
