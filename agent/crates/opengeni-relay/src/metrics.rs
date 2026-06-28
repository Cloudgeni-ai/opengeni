//! Relay metrics — the operator-visible aggregates (dossier §18).
//!
//! Per-channel byte counters, buffer high-water marks, rate-limit drops, and
//! reconnect counts, aggregated process-wide. These are operator Prometheus-style
//! aggregates (the per-MACHINE metrics are a DIFFERENT plane — the agent samples
//! those onto the control-plane heartbeat, dossier §10.7). The relay never holds
//! per-channel history; counters are monotonic process totals plus a small live
//! gauge.
//!
//! Exposed at `GET /metrics` as a tiny line-oriented text body the
//! `deployment-preflight` probe + a Prometheus scrape can read.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

/// Process-wide relay metrics. Cheap to clone (an `Arc` over atomics) so every
/// connection + the HTTP handler share one instance.
#[derive(Clone, Default)]
pub struct RelayMetrics {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Bytes spliced agent → viewer (pty output / desktop frames).
    bytes_agent_to_viewer: AtomicU64,
    /// Bytes spliced viewer → agent (keystrokes / computer-use input).
    bytes_viewer_to_agent: AtomicU64,
    /// Frames spliced (either direction).
    frames_spliced: AtomicU64,
    /// Channel registrations accepted (a fresh or resumed open).
    opens_accepted: AtomicU64,
    /// Channel opens rejected (bad token / scope / stale epoch).
    opens_rejected: AtomicU64,
    /// Producer/consumer reconnects (a resume-from-seq open on a known key).
    reconnects: AtomicU64,
    /// Frames shed by a per-token rate limit (leaky-bucket overflow).
    rate_limit_drops: AtomicU64,
    /// Frames dropped because a ring buffer was full (slow-peer backpressure shed).
    buffer_drops: AtomicU64,
    /// The high-water mark of buffered frames across any single channel direction.
    buffer_high_water: AtomicU64,
    /// Currently-live channels (paired or half-open). A gauge, not a counter.
    live_channels: AtomicI64,
}

impl RelayMetrics {
    /// A fresh metrics registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn record_agent_to_viewer(&self, bytes: u64) {
        self.inner
            .bytes_agent_to_viewer
            .fetch_add(bytes, Ordering::Relaxed);
        self.inner.frames_spliced.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_viewer_to_agent(&self, bytes: u64) {
        self.inner
            .bytes_viewer_to_agent
            .fetch_add(bytes, Ordering::Relaxed);
        self.inner.frames_spliced.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_open_accepted(&self) {
        self.inner.opens_accepted.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_open_rejected(&self) {
        self.inner.opens_rejected.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_reconnect(&self) {
        self.inner.reconnects.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_rate_limit_drop(&self) {
        self.inner.rate_limit_drops.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_buffer_drop(&self) {
        self.inner.buffer_drops.fetch_add(1, Ordering::Relaxed);
    }

    /// Update the buffer high-water mark to `depth` if it exceeds the current max.
    pub(crate) fn observe_buffer_depth(&self, depth: u64) {
        // A relaxed CAS loop: monotonic max, no ordering needed across counters.
        let mut cur = self.inner.buffer_high_water.load(Ordering::Relaxed);
        while depth > cur {
            match self.inner.buffer_high_water.compare_exchange_weak(
                cur,
                depth,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(observed) => cur = observed,
            }
        }
    }

    pub(crate) fn channel_opened(&self) {
        self.inner.live_channels.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn channel_closed(&self) {
        self.inner.live_channels.fetch_sub(1, Ordering::Relaxed);
    }

    /// The number of live channels (the operator gauge).
    #[must_use]
    pub fn live_channels(&self) -> i64 {
        self.inner.live_channels.load(Ordering::Relaxed)
    }

    /// Channel opens rejected (for tests / the dashboard).
    #[must_use]
    pub fn opens_rejected(&self) -> u64 {
        self.inner.opens_rejected.load(Ordering::Relaxed)
    }

    /// Frames shed by the per-token rate limit (for tests / the dashboard).
    #[must_use]
    pub fn rate_limit_drops(&self) -> u64 {
        self.inner.rate_limit_drops.load(Ordering::Relaxed)
    }

    /// Reconnects observed (for tests / the dashboard).
    #[must_use]
    pub fn reconnects(&self) -> u64 {
        self.inner.reconnects.load(Ordering::Relaxed)
    }

    /// Render the metrics as a Prometheus-style text exposition.
    #[must_use]
    pub fn render_prometheus(&self) -> String {
        use std::fmt::Write as _;
        let i = &self.inner;
        let mut out = String::new();
        let line = |out: &mut String, name: &str, help: &str, kind: &str, value: i64| {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} {kind}");
            let _ = writeln!(out, "{name} {value}");
        };
        let u = |a: &AtomicU64| i64::try_from(a.load(Ordering::Relaxed)).unwrap_or(i64::MAX);
        line(
            &mut out,
            "opengeni_relay_bytes_agent_to_viewer_total",
            "Bytes spliced from the agent to the viewer.",
            "counter",
            u(&i.bytes_agent_to_viewer),
        );
        line(
            &mut out,
            "opengeni_relay_bytes_viewer_to_agent_total",
            "Bytes spliced from the viewer to the agent.",
            "counter",
            u(&i.bytes_viewer_to_agent),
        );
        line(
            &mut out,
            "opengeni_relay_frames_spliced_total",
            "Frames spliced in either direction.",
            "counter",
            u(&i.frames_spliced),
        );
        line(
            &mut out,
            "opengeni_relay_opens_accepted_total",
            "Channel opens accepted.",
            "counter",
            u(&i.opens_accepted),
        );
        line(
            &mut out,
            "opengeni_relay_opens_rejected_total",
            "Channel opens rejected (bad token/scope/epoch).",
            "counter",
            u(&i.opens_rejected),
        );
        line(
            &mut out,
            "opengeni_relay_reconnects_total",
            "Producer/consumer reconnects (resume opens).",
            "counter",
            u(&i.reconnects),
        );
        line(
            &mut out,
            "opengeni_relay_rate_limit_drops_total",
            "Frames shed by a per-token rate limit.",
            "counter",
            u(&i.rate_limit_drops),
        );
        line(
            &mut out,
            "opengeni_relay_buffer_drops_total",
            "Frames dropped because a ring buffer was full.",
            "counter",
            u(&i.buffer_drops),
        );
        line(
            &mut out,
            "opengeni_relay_buffer_high_water",
            "Max buffered frames on any single channel direction.",
            "gauge",
            u(&i.buffer_high_water),
        );
        line(
            &mut out,
            "opengeni_relay_live_channels",
            "Currently-live channels.",
            "gauge",
            i.live_channels.load(Ordering::Relaxed),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_accumulate_and_render() {
        let m = RelayMetrics::new();
        m.record_agent_to_viewer(10);
        m.record_viewer_to_agent(5);
        m.record_open_accepted();
        m.record_open_rejected();
        m.record_reconnect();
        m.record_rate_limit_drop();
        m.observe_buffer_depth(7);
        m.observe_buffer_depth(3); // does not lower the high-water
        m.channel_opened();
        assert_eq!(m.live_channels(), 1);
        assert_eq!(m.opens_rejected(), 1);
        assert_eq!(m.rate_limit_drops(), 1);
        assert_eq!(m.reconnects(), 1);
        let text = m.render_prometheus();
        assert!(text.contains("opengeni_relay_bytes_agent_to_viewer_total 10"));
        assert!(text.contains("opengeni_relay_buffer_high_water 7"));
        assert!(text.contains("opengeni_relay_live_channels 1"));
        m.channel_closed();
        assert_eq!(m.live_channels(), 0);
    }
}
