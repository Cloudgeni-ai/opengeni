//! Full-jitter exponential backoff for stream-channel reconnects.
//!
//! A relay blip must re-register the channel WITHOUT triggering a reconnect storm
//! (the named #1 outage cause, dossier §10.6/§19). [`ChannelBackoff`] is the
//! stream-plane peer of the agent supervisor's backoff: the same "full jitter"
//! strategy (each delay a uniform draw in `[0, min(cap, base·2ⁿ)]`), so a fleet of
//! channels re-registering after a relay pod death spreads across the window.
//!
//! It is duplicated here rather than shared because the stream crate cannot depend
//! on the agent binary crate; the strategy + bounds are identical and both are
//! unit-tested against the pure ceiling.

use std::time::Duration;

/// Full-jitter exponential backoff for channel re-registration.
#[derive(Debug, Clone)]
pub struct ChannelBackoff {
    base: Duration,
    cap: Duration,
    attempt: u32,
}

impl ChannelBackoff {
    /// Builds a backoff with `base` (first window ceiling) and `cap` (max window).
    #[must_use]
    pub fn new(base: Duration, cap: Duration) -> Self {
        Self {
            base,
            cap,
            attempt: 0,
        }
    }

    /// The standard stream-reconnect backoff: base 500ms, cap 30s. A touch tighter
    /// than the control-plane reconnect (base 1s/cap 60s) because a stream resume is
    /// cheap and the user is actively watching — but still jittered + capped.
    #[must_use]
    pub fn standard() -> Self {
        Self::new(Duration::from_millis(500), Duration::from_secs(30))
    }

    /// The exponential ceiling for the current attempt: `min(cap, base·2ⁿ)`,
    /// saturating so a large attempt count never overflows.
    #[must_use]
    pub fn ceiling(&self) -> Duration {
        let base_nanos = self.base.as_nanos();
        let scaled = if self.attempt >= 127 {
            u128::MAX
        } else {
            base_nanos.saturating_mul(1u128 << self.attempt)
        };
        let bounded = scaled.min(self.cap.as_nanos());
        Duration::from_nanos(u64::try_from(bounded).unwrap_or(u64::MAX))
    }

    /// Draws the next delay uniformly in `[0, ceiling()]` and advances the attempt.
    #[must_use]
    pub fn next_delay(&mut self) -> Duration {
        let ceiling = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        jitter(ceiling, &mut rand::thread_rng())
    }

    /// Resets the attempt counter after a successful re-register.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Attempts since the last reset (for structured logs / tests).
    #[must_use]
    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

/// Draws a uniform delay in `[0, ceiling]` from `rng`.
fn jitter(ceiling: Duration, rng: &mut impl rand::Rng) -> Duration {
    let max = ceiling.as_nanos();
    if max == 0 {
        return Duration::ZERO;
    }
    let max = u64::try_from(max).unwrap_or(u64::MAX);
    Duration::from_nanos(rng.gen_range(0..=max))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn ceiling_grows_then_clamps() {
        let mut b = ChannelBackoff::new(Duration::from_millis(500), Duration::from_secs(30));
        // 500ms, 1s, 2s, 4s, 8s, 16s, 30s(clamped), 30s...
        let expected_ms = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
        for want in expected_ms {
            assert_eq!(b.ceiling(), Duration::from_millis(want));
            let _ = b.next_delay();
        }
    }

    #[test]
    fn jittered_delay_within_ceiling() {
        let mut rng = StdRng::seed_from_u64(0xDEAD_BEEF);
        for attempt in 0..32u32 {
            let b = ChannelBackoff {
                base: Duration::from_millis(20),
                cap: Duration::from_secs(5),
                attempt,
            };
            let ceiling = b.ceiling();
            for _ in 0..100 {
                let d = jitter(ceiling, &mut rng);
                assert!(d <= ceiling, "delay {d:?} exceeded ceiling {ceiling:?}");
            }
        }
    }

    #[test]
    fn reset_returns_to_base() {
        let mut b = ChannelBackoff::standard();
        for _ in 0..4 {
            let _ = b.next_delay();
        }
        assert!(b.attempt() > 0);
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.ceiling(), Duration::from_millis(500));
    }

    #[test]
    fn huge_attempt_does_not_overflow() {
        let b = ChannelBackoff {
            base: Duration::from_millis(500),
            cap: Duration::from_secs(30),
            attempt: u32::MAX,
        };
        assert_eq!(b.ceiling(), Duration::from_secs(30));
    }
}
