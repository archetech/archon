use std::time::{Duration, Instant};

/// Aggregate progress without per-DID identifiers or additional database reads.
pub(crate) struct ProgressLogger {
    phase: &'static str,
    total: usize,
    started: Instant,
    last_log: Instant,
}

impl ProgressLogger {
    pub(crate) fn new(phase: &'static str, total: usize) -> Self {
        let now = Instant::now();
        let mut progress = Self {
            phase,
            total,
            started: now,
            last_log: now,
        };
        progress.log(0, now);
        progress
    }

    pub(crate) fn update(&mut self, completed: usize) {
        let now = Instant::now();
        if completed == self.total || now.duration_since(self.last_log) >= Duration::from_secs(5) {
            self.log(completed, now);
        }
    }

    fn log(&mut self, completed: usize, now: Instant) {
        tracing::info!(
            "Gatekeeper {}: {}/{} DIDs ({:.1}s)",
            self.phase,
            completed,
            self.total,
            now.duration_since(self.started).as_secs_f64()
        );
        self.last_log = now;
    }
}
