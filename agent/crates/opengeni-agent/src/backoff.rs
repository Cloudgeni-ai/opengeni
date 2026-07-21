//! Full-jitter exponential backoff for the resiliency supervisor.
//!
//! Reconnect-storm TLS-handshake CPU is the named #1 outage cause (design
//! §10.6/§19), so backoff is a **day-1, first-class** concern, not an
//! afterthought. We use the "full jitter" strategy from the canonical AWS
//! Architecture Blog analysis: each delay is a uniform random draw in
//! `[0, min(cap, base * 2^attempt)]`. Full jitter both spreads a thundering herd
//! across the whole window *and* keeps the expected delay low, beating
//! "equal jitter" and plain capped-exponential for de-correlating reconnects.
//!
//! ## Fast phase (recover a rolling-deploy blip in seconds, not minutes)
//!
//! The control-plane connection, its RPC responder subscription, AND the ~5s
//! liveness heartbeat all ride ONE NATS connection (see `supervisor.rs`). When a
//! control-plane rolling deploy briefly drops that connection, everything the
//! control plane sees of the machine — `last_seen_at` and the attach-gate ping —
//! goes dark together and only returns once this backoff lets the agent re-dial.
//! With a pure `1s→60s` exponential, a ~2-minute deploy window pushes the ceiling
//! to the 60s cap, so recovery lags the deploy by up to a full cap window (and
//! compounds on any failed attempt) — observed as multi-minute "machine offline;
//! cannot attach" outages after every deploy. So [`Backoff::standard`] runs a
//! FAST PHASE first: the initial `fast_attempts` attempts draw within a small
//! `fast_ceiling` (≈30s of ~1.5s-median retries) to catch a returning control
//! plane within a few seconds, THEN falls back to the exponential up to `cap`
//! (now 10s, not 60s) so a genuinely PROLONGED outage still de-correlates the
//! fleet reconnect (the #1-outage-cause storm protection is retained, just bounded
//! to a tighter cap). Full jitter spreads the herd across every window.
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
    /// The ceiling used during the initial FAST phase — each of the first
    /// `fast_attempts` reconnect delays is drawn uniformly in `[0, fast_ceiling]`
    /// so a brief control-plane blip (a rolling api/relay deploy) is retried
    /// within ~`fast_ceiling` rather than waiting out the exponential climb.
    /// `Duration::ZERO` with `fast_attempts == 0` disables the fast phase (a pure
    /// exponential backoff — what [`Backoff::new`] builds).
    fast_ceiling: Duration,
    /// How many initial attempts stay in the fast phase before the exponential
    /// (`base` → `cap`) backoff takes over for a PROLONGED outage.
    fast_attempts: u32,
    attempt: u32,
}

impl Backoff {
    /// Builds a PURE exponential backoff with the given `base` (the first
    /// window's ceiling) and `cap` (the maximum window the exponential is clamped
    /// to) — no fast phase. For the control-plane cadence with the fast-recovery
    /// phase, use [`Backoff::standard`] / [`Backoff::with_fast_phase`].
    #[must_use]
    pub fn new(base: Duration, cap: Duration) -> Self {
        Self {
            base,
            cap,
            fast_ceiling: Duration::ZERO,
            fast_attempts: 0,
            attempt: 0,
        }
    }

    /// Builds a two-phase backoff: the first `fast_attempts` delays draw within
    /// `fast_ceiling` (fast recovery of a short blip), then the exponential
    /// `base` → `cap` takes over (storm protection for a prolonged outage).
    #[must_use]
    pub fn with_fast_phase(
        base: Duration,
        cap: Duration,
        fast_ceiling: Duration,
        fast_attempts: u32,
    ) -> Self {
        Self {
            fast_ceiling,
            fast_attempts,
            ..Self::new(base, cap)
        }
    }

    /// The standard control-plane reconnect backoff. FAST PHASE: 20 attempts
    /// drawn in `[0, 3s]` (≈30s of ~1.5s-median retries) so a rolling-deploy blip
    /// is recovered within a few seconds. COOL PHASE: exponential `1s → 10s` cap
    /// — a tighter cap than the historical 60s so a prolonged-outage reconnect
    /// wait is bounded to ≤10s while full jitter still de-correlates the fleet.
    #[must_use]
    pub fn standard() -> Self {
        Self::with_fast_phase(
            Duration::from_secs(1),
            Duration::from_secs(10),
            Duration::from_secs(3),
            20,
        )
    }

    /// The exponential ceiling for the *current* attempt: `min(cap, base*2^n)`,
    /// saturating so a large attempt count can never overflow. This is the upper
    /// bound the jittered delay is drawn within — the property the unit tests
    /// pin exactly.
    #[must_use]
    pub fn ceiling(&self) -> Duration {
        // Fast phase: the first `fast_attempts` attempts draw within the fixed
        // small `fast_ceiling` so a brief control-plane blip recovers quickly.
        if self.attempt < self.fast_attempts {
            return self.fast_ceiling;
        }
        // Cool phase: base * 2^n (n counted from the END of the fast phase),
        // computed in nanoseconds (already u128) with saturating shifts so we
        // never panic on overflow; clamp to `cap`.
        let n = self.attempt - self.fast_attempts;
        let base_nanos = self.base.as_nanos();
        // Saturate the shift: anything past 127 bits is already way beyond `cap`.
        let scaled = if n >= 127 {
            u128::MAX
        } else {
            base_nanos.saturating_mul(1u128 << n)
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
            let b = Backoff {
                base,
                cap,
                fast_ceiling: Duration::ZERO,
                fast_attempts: 0,
                attempt,
            };
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
            fast_ceiling: Duration::ZERO,
            fast_attempts: 0,
            attempt: u32::MAX,
        };
        // Must not panic and must clamp to the cap.
        assert_eq!(b.ceiling(), Duration::from_secs(60));
    }

    #[test]
    fn reset_returns_to_fast_window() {
        let mut b = Backoff::standard();
        for _ in 0..5 {
            let _ = b.next_delay();
        }
        assert!(b.attempt() > 0);
        b.reset();
        assert_eq!(b.attempt(), 0);
        // After a reset the next disconnect starts in the FAST phase again (the
        // standard backoff's first-window ceiling is `fast_ceiling` = 3s).
        assert_eq!(b.ceiling(), Duration::from_secs(3));
    }

    #[test]
    fn standard_fast_phase_then_exponential_to_ten_second_cap() {
        // The reconnect-latency fix: the standard backoff spends its first 20
        // attempts in a 3s fast window (so a rolling-deploy blip is retried
        // ~every ≤3s and recovers in seconds), THEN backs off exponentially to a
        // 10s cap (down from 60s) — bounding a prolonged-outage reconnect wait.
        let mut b = Backoff::standard();
        for _ in 0..20 {
            assert_eq!(b.ceiling(), Duration::from_secs(3));
            let _ = b.next_delay();
        }
        // Cool phase: 1s, 2s, 4s, 8s, then clamped at the 10s cap (NOT 60s).
        let expected = [1u64, 2, 4, 8, 10, 10, 10];
        for want_secs in expected {
            assert_eq!(b.ceiling(), Duration::from_secs(want_secs));
            let _ = b.next_delay();
        }
    }

    #[test]
    fn zero_ceiling_yields_zero_delay() {
        let mut rng = StdRng::seed_from_u64(1);
        assert_eq!(jitter(Duration::ZERO, &mut rng), Duration::ZERO);
    }
}
