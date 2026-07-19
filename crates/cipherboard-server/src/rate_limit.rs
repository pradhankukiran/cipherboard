use std::collections::VecDeque;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

pub struct RateLimiter {
    max_per_window: u32,
    window: Duration,
    hits: Mutex<VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(max_per_second: u32) -> Self {
        Self {
            max_per_window: max_per_second.max(1),
            window: Duration::from_secs(1),
            hits: Mutex::new(VecDeque::new()),
        }
    }

    pub fn check(&self) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock();
        while let Some(front) = hits.front() {
            if now.duration_since(*front) > self.window {
                hits.pop_front();
            } else {
                break;
            }
        }
        if hits.len() as u32 >= self.max_per_window {
            return false;
        }
        hits.push_back(now);
        true
    }
}
