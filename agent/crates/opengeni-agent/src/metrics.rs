//! Minimal machine-metrics sampling for the heartbeat payload.
//!
//! The heartbeat ([`AgentEvent`](opengeni_agent_proto::v1::AgentEvent)) carries a
//! [`MetricsSample`] so the control plane can upsert the machine's last sample
//! without a separate RPC (dossier §10.7). **Full metrics — load averages, RAM,
//! disk, GPU, the downsampled series — are M10**; this module is the seam: it
//! returns a structurally valid sample today (timestamped, fields it can cheaply
//! read on the current OS, zeros elsewhere) so the heartbeat wire shape is exact
//! and M10 only deepens the readings, never reshapes the call site.

use std::time::{SystemTime, UNIX_EPOCH};

use opengeni_agent_proto::v1::MetricsSample;

/// Produces a best-effort point-in-time metrics sample.
///
/// Always stamps `sampled_at_ms`. On unix it fills the load averages (the one
/// cheap, allocation-free, dependency-free reading available everywhere via
/// `getloadavg`-equivalent `/proc/loadavg`); the richer readings (per-core CPU%,
/// RAM/disk, GPU) arrive in M10. Fields it cannot read are left zero — the wire
/// contract treats absence as "not reported", never as a real zero.
#[must_use]
pub fn sample() -> MetricsSample {
    let sampled_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));

    let (one, five, fifteen) = read_load_averages();

    MetricsSample {
        sampled_at_ms,
        load1: one,
        load5: five,
        load15: fifteen,
        // The remaining fields (cpu_percent, mem/disk, run_queue, gpus) are the
        // M10 deepening; zero == "not reported" per the wire contract.
        ..Default::default()
    }
}

/// Reads the 1/5/15-minute load averages. On Linux this parses `/proc/loadavg`
/// (no syscall crate needed); other OSes return zeros until M10 wires their
/// native sources. A read failure degrades to zeros — a metrics gap must never
/// fail a heartbeat.
fn read_load_averages() -> (f64, f64, f64) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/loadavg") {
            let mut parts = text.split_whitespace();
            let l1 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let l5 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let l15 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            return (l1, l5, l15);
        }
    }
    (0.0, 0.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_is_timestamped() {
        let s = sample();
        assert!(s.sampled_at_ms > 0, "sample must carry a wall-clock stamp");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_sample_reports_nonnegative_load() {
        let s = sample();
        // Load averages are non-negative; on a live Linux host at least one is
        // typically > 0, but we only assert the invariant that holds always.
        assert!(s.load1 >= 0.0 && s.load5 >= 0.0 && s.load15 >= 0.0);
    }
}
