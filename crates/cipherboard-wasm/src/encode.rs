use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::smooth::Point;

/// Board event kinds encoded as compact JSON for encryption envelopes.
/// Plaintext event payloads only — encryption happens in JS WebCrypto.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum BoardEvent {
    StrokeBegin {
        id: String,
        color: String,
        width: f64,
        tool: String,
    },
    StrokePoints {
        id: String,
        points: Vec<Point>,
    },
    StrokeEnd {
        id: String,
    },
    Erase {
        id: String,
        points: Vec<Point>,
        width: f64,
    },
    Clear {
        nonce: String,
    },
    Undo {
        target: String,
    },
    Redo {
        target: String,
    },
    Cursor {
        x: f64,
        y: f64,
        visible: bool,
    },
    SnapshotMarker {
        label: String,
    },
}

#[wasm_bindgen]
pub fn encode_event(event_json: &str) -> Result<String, String> {
    let event: BoardEvent = serde_json::from_str(event_json)
        .map_err(|e| format!("encode: invalid event: {e}"))?;
    validate_event_limits(&event).map_err(|e| e)?;
    // Canonical compact JSON
    serde_json::to_string(&event).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn decode_event(encoded: &str) -> Result<String, String> {
    if encoded.len() > MAX_EVENT_BYTES {
        return Err("decode: event too large".into());
    }
    let event: BoardEvent = serde_json::from_str(encoded)
        .map_err(|e| format!("decode: invalid event: {e}"))?;
    validate_event_limits(&event).map_err(|e| e)?;
    serde_json::to_string(&event).map_err(|e| e.to_string())
}

const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_POINTS: usize = 2048;
const MAX_ID_LEN: usize = 128;
const MAX_COLOR_LEN: usize = 32;
const MAX_TOOL_LEN: usize = 32;

fn validate_event_limits(event: &BoardEvent) -> Result<(), String> {
    match event {
        BoardEvent::StrokeBegin {
            id,
            color,
            width,
            tool,
        } => {
            check_id(id)?;
            if color.is_empty() || color.len() > MAX_COLOR_LEN {
                return Err("invalid color".into());
            }
            if tool.is_empty() || tool.len() > MAX_TOOL_LEN {
                return Err("invalid tool".into());
            }
            if !width.is_finite() || *width <= 0.0 || *width > 64.0 {
                return Err("invalid width".into());
            }
        }
        BoardEvent::StrokePoints { id, points } | BoardEvent::Erase { id, points, .. } => {
            check_id(id)?;
            if points.len() > MAX_POINTS {
                return Err("too many points".into());
            }
            for p in points {
                if !p.x.is_finite() || !p.y.is_finite() || !p.p.is_finite() {
                    return Err("non-finite point".into());
                }
                if p.x.abs() > 1_000_000.0 || p.y.abs() > 1_000_000.0 {
                    return Err("point out of range".into());
                }
            }
            if let BoardEvent::Erase { width, .. } = event {
                if !width.is_finite() || *width <= 0.0 || *width > 128.0 {
                    return Err("invalid erase width".into());
                }
            }
        }
        BoardEvent::StrokeEnd { id }
        | BoardEvent::Undo { target: id }
        | BoardEvent::Redo { target: id } => {
            check_id(id)?;
        }
        BoardEvent::Clear { nonce } => {
            if nonce.is_empty() || nonce.len() > MAX_ID_LEN {
                return Err("invalid clear nonce".into());
            }
        }
        BoardEvent::Cursor { x, y, .. } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("non-finite cursor".into());
            }
        }
        BoardEvent::SnapshotMarker { label } => {
            if label.len() > 256 {
                return Err("label too long".into());
            }
        }
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err("invalid id".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_stroke_begin() {
        let ev = BoardEvent::StrokeBegin {
            id: "s1".into(),
            color: "#000000".into(),
            width: 2.0,
            tool: "pen".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        let encoded = encode_event(&json).unwrap();
        let decoded = decode_event(&encoded).unwrap();
        let back: BoardEvent = serde_json::from_str(&decoded).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn rejects_too_many_points() {
        let points: Vec<Point> = (0..3000)
            .map(|i| Point {
                x: i as f64,
                y: 0.0,
                p: 1.0,
            })
            .collect();
        let ev = BoardEvent::StrokePoints {
            id: "s1".into(),
            points,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(encode_event(&json).is_err());
    }
}
