//! Per-token leaky-bucket rate limiting (dossier §10.5/§18).
//!
//! Each splice direction is metered by a [`LeakyBucket`] keyed by the presenting
//! token's scope, so one noisy stream can never starve the relay or another tenant
//! (fate isolation). The bucket meters BYTES (the resource the relay actually
//! moves): it refills at `refill_bytes_per_sec` up to `capacity_bytes`; a frame
//! that does not fit is SHED (dropped + counted), never queued unboundedly — the
//! bounded ring buffer ([`ring`](crate::ring)) is the separate backpressure point
//! for a momentarily-slow peer, the rate limit is the sustained-abuse ceiling.
//!
//! The clock is injected (`now`) so tests are deterministic and the production path
//! uses [`Instant::now`].

use std::time::Instant;

/// A monotonic byte leaky-bucket. Not `Sync` — each channel direction owns its own
/// bucket behind the channel's task, so no lock is needed.
#[derive(Debug)]
pub struct LeakyBucket {
    /// Max burst the bucket holds (bytes).
    capacity_bytes: f64,
    /// Sustained refill rate (bytes/second).
    refill_bytes_per_sec: f64,
    /// Currently-available tokens (bytes). Starts full so a fresh stream is not
    /// throttled on its first frame.
    available: f64,
    /// When the bucket was last refilled.
    last: Instant,
}

impl LeakyBucket {
    /// Build a bucket with `capacity_bytes` burst and `refill_bytes_per_sec`
    /// sustained rate, starting full as of `now`.
    ///
    /// Byte counts are well under 2^52, so the `u64 → f64` conversions are exact in
    /// practice (the precision-loss lint is allowed deliberately).
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn new(capacity_bytes: u64, refill_bytes_per_sec: u64, now: Instant) -> Self {
        Self {
            capacity_bytes: capacity_bytes as f64,
            refill_bytes_per_sec: refill_bytes_per_sec as f64,
            available: capacity_bytes as f64,
            last: now,
        }
    }

    /// Refill the bucket for the elapsed time since the last call.
    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        if elapsed > 0.0 {
            self.available =
                (self.available + elapsed * self.refill_bytes_per_sec).min(self.capacity_bytes);
            self.last = now;
        }
    }

    /// Try to admit a frame of `bytes`. Returns `true` and debits the bucket when it
    /// fits; returns `false` (the frame should be SHED + counted) when it does not.
    /// A single frame larger than the whole capacity is admitted once the bucket is
    /// full (so a legitimately-large desktop frame is never permanently stuck) but
    /// drains the bucket to zero.
    #[allow(clippy::cast_precision_loss)]
    pub fn admit(&mut self, bytes: u64, now: Instant) -> bool {
        self.refill(now);
        let cost = bytes as f64;
        if cost <= self.available {
            self.available -= cost;
            true
        } else if (self.available - self.capacity_bytes).abs() < f64::EPSILON {
            // The bucket is full but the frame is bigger than capacity: admit it once
            // (drain to zero) rather than dropping a large frame forever.
            self.available = 0.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn admits_within_capacity_then_sheds() {
        let t0 = Instant::now();
        // 1 KiB burst, 0 refill: admit 1 KiB then shed.
        let mut b = LeakyBucket::new(1024, 0, t0);
        assert!(b.admit(512, t0));
        assert!(b.admit(512, t0));
        assert!(!b.admit(1, t0), "bucket is empty; the next byte is shed");
    }

    #[test]
    fn refills_over_time() {
        let t0 = Instant::now();
        let mut b = LeakyBucket::new(1000, 1000, t0); // 1000 B/s
        assert!(b.admit(1000, t0));
        assert!(!b.admit(1, t0));
        // Half a second later, ~500 B have refilled.
        let t1 = t0 + Duration::from_millis(500);
        assert!(b.admit(400, t1));
        assert!(
            !b.admit(200, t1),
            "only ~500B refilled; 400 spent, 200 sheds"
        );
    }

    #[test]
    fn an_oversize_frame_is_admitted_once_from_full() {
        let t0 = Instant::now();
        let mut b = LeakyBucket::new(100, 0, t0);
        // A 1 MiB frame is larger than the 100B capacity; admitted once from full.
        assert!(b.admit(1_048_576, t0));
        // Now empty — the next frame sheds.
        assert!(!b.admit(1, t0));
    }
}
