//! Full-jitter exponential backoff for the resiliency supervisor.
//!
//! Reconnect-storm TLS-handshake CPU is the named #1 outage cause (dossier
//! §10.6/§19), so backoff is a **day-1, first-class** concern, not an
//! afterthought. We use the "full jitter" strategy from the canonical AWS
//! Architecture Blog analysis: each delay is a uniform random draw in
//! `[0, min(cap, base * 2^attempt)]`. Full jitter both spreads a thundering herd
//! across the whole window *and* keeps the expected delay low, beating
//! "equal jitter" and plain capped-exponential for de-correlating reconnects.
//!
//! The struct is deliberately decoupled from any clock or RNG source it cannot be
//! unit-tested against: [`Backoff::ceiling`] is the pure, exactly-checkable bound
//! and [`Backoff::next_delay`] draws within it. The supervisor sleeps for the
//! returned [`Duration`]; on a successful connect it calls [`Backoff::reset`].

use std::time::Duration;

/// Full-jitter exponential backoff state.
///
/// Construct with [`Backoff::new`], call [`Backoff::next_delay`] before each
/// reconnect attempt, and [`Backoff::reset`] after a successful connect so the
/// next blip starts from the base again.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    attempt: u32,
}

impl Backoff {
    /// Builds a backoff with the given `base` (the first window's ceiling) and
    /// `cap` (the maximum window the exponential is clamped to). The dossier
    /// §10.6 cadence is `base = 1s`, `cap = 60s`; see [`Backoff::standard`].
    #[must_use]
    pub fn new(base: Duration, cap: Duration) -> Self {
        Self {
            base,
            cap,
            attempt: 0,
        }
    }

    /// The dossier-standard reconnect backoff: base 1s, cap 60s (§10.6).
    #[must_use]
    pub fn standard() -> Self {
        Self::new(Duration::from_secs(1), Duration::from_secs(60))
    }

    /// The exponential ceiling for the *current* attempt: `min(cap, base*2^n)`,
    /// saturating so a large attempt count can never overflow. This is the upper
    /// bound the jittered delay is drawn within — the property the unit tests
    /// pin exactly.
    #[must_use]
    pub fn ceiling(&self) -> Duration {
        // base * 2^attempt, computed in nanoseconds (already u128) with saturating
        // shifts so we never panic on overflow; clamp to `cap`.
        let base_nanos = self.base.as_nanos();
        // Saturate the shift: anything past 127 bits is already way beyond `cap`.
        let scaled = if self.attempt >= 127 {
            u128::MAX
        } else {
            base_nanos.saturating_mul(1u128 << self.attempt)
        };
        let cap_nanos = self.cap.as_nanos();
        let bounded = scaled.min(cap_nanos);
        // `bounded <= cap_nanos` which fits a u64 nanos Duration for any sane cap.
        Duration::from_nanos(u64::try_from(bounded).unwrap_or(u64::MAX))
    }

    /// Draws the next delay uniformly in `[0, ceiling()]` and advances the
    /// attempt counter. The caller sleeps for the returned duration before the
    /// next reconnect attempt.
    #[must_use]
    pub fn next_delay(&mut self) -> Duration {
        let ceiling = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        jitter(ceiling, &mut rand::thread_rng())
    }

    /// Resets the attempt counter after a successful connect, so the next
    /// disconnect starts its backoff from `base` again.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// The number of attempts taken since the last [`Backoff::reset`] — exposed
    /// for structured logging (`reconnect_attempt`) and tests.
    #[must_use]
    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

/// Draws a uniform delay in `[0, ceiling]` from `rng`. Split out so the jitter
/// distribution can be exercised with a seeded RNG independent of the clock.
fn jitter(ceiling: Duration, rng: &mut impl rand::Rng) -> Duration {
    let max = ceiling.as_nanos();
    if max == 0 {
        return Duration::ZERO;
    }
    // `max` fits a u64 for any reasonable cap; clamp defensively.
    let max = u64::try_from(max).unwrap_or(u64::MAX);
    Duration::from_nanos(rng.gen_range(0..=max))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn ceiling_grows_exponentially_then_clamps_to_cap() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(60);
        let mut b = Backoff::new(base, cap);
        // attempt 0 -> 1s, 1 -> 2s, 2 -> 4s, ... clamped at 60s.
        let expected = [1, 2, 4, 8, 16, 32, 60, 60, 60];
        for want_secs in expected {
            assert_eq!(b.ceiling(), Duration::from_secs(want_secs));
            let _ = b.next_delay();
        }
    }

    #[test]
    fn full_jitter_delay_stays_within_zero_and_ceiling() {
        // The core resiliency invariant: every drawn delay is in
        // [0, min(cap, base*2^n)]. Exercise many attempts with a seeded RNG so
        // the bound holds deterministically.
        let base = Duration::from_millis(50);
        let cap = Duration::from_secs(10);
        let mut rng = StdRng::seed_from_u64(0xC0FF_EE99);
        for attempt in 0..40u32 {
            let b = Backoff { base, cap, attempt };
            let ceiling = b.ceiling();
            // Draw repeatedly at this fixed attempt.
            for _ in 0..200 {
                let d = jitter(ceiling, &mut rng);
                assert!(d <= ceiling, "delay {d:?} exceeded ceiling {ceiling:?}");
            }
        }
    }

    #[test]
    fn ceiling_never_overflows_for_huge_attempt() {
        let b = Backoff {
            base: Duration::from_secs(1),
            cap: Duration::from_secs(60),
            attempt: u32::MAX,
        };
        // Must not panic and must clamp to the cap.
        assert_eq!(b.ceiling(), Duration::from_secs(60));
    }

    #[test]
    fn reset_returns_to_base_window() {
        let mut b = Backoff::standard();
        for _ in 0..5 {
            let _ = b.next_delay();
        }
        assert!(b.attempt() > 0);
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.ceiling(), Duration::from_secs(1));
    }

    #[test]
    fn zero_ceiling_yields_zero_delay() {
        let mut rng = StdRng::seed_from_u64(1);
        assert_eq!(jitter(Duration::ZERO, &mut rng), Duration::ZERO);
    }
}
