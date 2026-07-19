use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[wasm_bindgen]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub p: f64,
}

#[wasm_bindgen]
impl Point {
    #[wasm_bindgen(constructor)]
    pub fn new(x: f64, y: f64, p: f64) -> Point {
        Point {
            x,
            y,
            p: p.clamp(0.0, 1.0),
        }
    }
}

/// Chaikin-style corner cutting for stroke smoothing. Pure geometry — no secrets.
#[wasm_bindgen]
pub fn smooth_stroke(points_json: &str, iterations: u32) -> Result<String, String> {
    let points: Vec<Point> = serde_json::from_str(points_json)
        .map_err(|e| format!("invalid points: {e}"))?;
    if points.len() < 2 {
        return serde_json::to_string(&points).map_err(|e| e.to_string());
    }
    let iters = iterations.min(4);
    let mut current = points;
    for _ in 0..iters {
        current = chaikin(&current);
    }
    serde_json::to_string(&current).map_err(|e| e.to_string())
}

fn chaikin(points: &[Point]) -> Vec<Point> {
    if points.len() < 2 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(points.len() * 2);
    out.push(points[0]);
    for window in points.windows(2) {
        let a = window[0];
        let b = window[1];
        out.push(Point {
            x: 0.75 * a.x + 0.25 * b.x,
            y: 0.75 * a.y + 0.25 * b.y,
            p: 0.75 * a.p + 0.25 * b.p,
        });
        out.push(Point {
            x: 0.25 * a.x + 0.75 * b.x,
            y: 0.25 * a.y + 0.75 * b.y,
            p: 0.25 * a.p + 0.75 * b.p,
        });
    }
    out.push(*points.last().unwrap());
    out
}

/// Simplify stroke with a distance threshold (Ramer-Douglas-Peucker lite).
#[wasm_bindgen]
pub fn simplify_stroke(points_json: &str, tolerance: f64) -> Result<String, String> {
    let points: Vec<Point> = serde_json::from_str(points_json)
        .map_err(|e| format!("invalid points: {e}"))?;
    let simplified = rdp(&points, tolerance.max(0.0));
    serde_json::to_string(&simplified).map_err(|e| e.to_string())
}

fn rdp(points: &[Point], epsilon: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut max_dist = 0.0;
    let mut index = 0;
    let start = points[0];
    let end = points[points.len() - 1];
    for i in 1..points.len() - 1 {
        let d = perpendicular_distance(points[i], start, end);
        if d > max_dist {
            max_dist = d;
            index = i;
        }
    }
    if max_dist > epsilon {
        let mut left = rdp(&points[..=index], epsilon);
        let right = rdp(&points[index..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![start, end]
    }
}

fn perpendicular_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if dx == 0.0 && dy == 0.0 {
        return ((p.x - a.x).powi(2) + (p.y - a.y).powi(2)).sqrt();
    }
    let num = ((p.x - a.x) * dy - (p.y - a.y) * dx).abs();
    let den = (dx * dx + dy * dy).sqrt();
    num / den
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smooth_preserves_endpoints() {
        let pts = vec![
            Point {
                x: 0.0,
                y: 0.0,
                p: 1.0,
            },
            Point {
                x: 10.0,
                y: 10.0,
                p: 1.0,
            },
            Point {
                x: 20.0,
                y: 0.0,
                p: 1.0,
            },
        ];
        let json = serde_json::to_string(&pts).unwrap();
        let out: Vec<Point> = serde_json::from_str(&smooth_stroke(&json, 1).unwrap()).unwrap();
        assert!((out[0].x - 0.0).abs() < 1e-9);
        assert!((out.last().unwrap().x - 20.0).abs() < 1e-9);
        assert!(out.len() > pts.len());
    }

    #[test]
    fn simplify_collinear() {
        let pts = vec![
            Point {
                x: 0.0,
                y: 0.0,
                p: 1.0,
            },
            Point {
                x: 5.0,
                y: 0.0,
                p: 1.0,
            },
            Point {
                x: 10.0,
                y: 0.0,
                p: 1.0,
            },
        ];
        let json = serde_json::to_string(&pts).unwrap();
        let out: Vec<Point> = serde_json::from_str(&simplify_stroke(&json, 0.5).unwrap()).unwrap();
        assert_eq!(out.len(), 2);
    }
}
