//! Harness-only runtime overrides (`$OPENGENI_RUNNER_TEST_OVERRIDES`).
//!
//! The engine-era harness scenarios (`.agent/ENGINE-SCENARIOS.md`, open
//! question 2) need to shrink derived budgets and cadences so bounds-and-
//! eviction behavior is testable in seconds instead of gigabytes/hours:
//! retention quotas (E4), the completed-op cap + TTLs (E9/E10), the
//! housekeeping cadence (E10), and injected capacity figures (E12 scaling).
//!
//! Format: `OPENGENI_RUNNER_TEST_OVERRIDES="key=value,key=value"`. Unknown
//! keys are rejected LOUDLY (a typo must not silently test the defaults).
//! When ANY override is active the runner logs a warning banner every
//! construction — this surface exists for the harness's disposable agents and
//! must be conspicuous if it ever leaks toward a real deployment.

use std::sync::OnceLock;

use tracing::{error, warn};

/// The env var carrying the overrides.
pub const ENV_VAR: &str = "OPENGENI_RUNNER_TEST_OVERRIDES";

/// Parsed overrides; every field `None` unless explicitly set.
#[derive(Debug, Default, Clone)]
pub struct TestOverrides {
    /// Per-op retention memory cap (bytes).
    pub retention_memory_max_bytes: Option<usize>,
    /// Per-op retention spool quota (bytes).
    pub retention_spool_max_bytes: Option<u64>,
    /// Registry completed-op LRU cap.
    pub registry_max_completed: Option<usize>,
    /// Registry completed-op TTL (ms).
    pub registry_completed_ttl_ms: Option<u64>,
    /// Registry cancel-tombstone TTL (ms).
    pub registry_tombstone_ttl_ms: Option<u64>,
    /// Engine housekeeping cadence (ms) — registry GC + queue expiry.
    pub housekeeping_tick_ms: Option<u64>,
    /// Injected `HostCapacity.mem_available_bytes` (E12 scaling probe).
    pub capacity_mem_bytes: Option<u64>,
    /// Injected `HostCapacity.disk_free_bytes`.
    pub capacity_disk_bytes: Option<u64>,
}

impl TestOverrides {
    /// Whether any override is set.
    #[must_use]
    pub fn active(&self) -> bool {
        self.retention_memory_max_bytes.is_some()
            || self.retention_spool_max_bytes.is_some()
            || self.registry_max_completed.is_some()
            || self.registry_completed_ttl_ms.is_some()
            || self.registry_tombstone_ttl_ms.is_some()
            || self.housekeeping_tick_ms.is_some()
            || self.capacity_mem_bytes.is_some()
            || self.capacity_disk_bytes.is_some()
    }
}

/// The process-wide overrides, parsed once from the environment.
pub fn get() -> &'static TestOverrides {
    static PARSED: OnceLock<TestOverrides> = OnceLock::new();
    PARSED.get_or_init(|| {
        let Ok(raw) = std::env::var(ENV_VAR) else {
            return TestOverrides::default();
        };
        let parsed = parse(&raw);
        if parsed.active() {
            warn!(
                overrides = %raw,
                "TEST OVERRIDES ACTIVE ({ENV_VAR}) — budgets/cadences are NOT \
                 host-derived; this is a harness surface, never a deployment one"
            );
        }
        parsed
    })
}

/// Parses the `key=value,key=value` list. Unknown keys and unparsable values
/// are LOUD errors and are ignored (never a silent fallback to a default the
/// scenario did not intend).
fn parse(raw: &str) -> TestOverrides {
    /// Parses one value into its slot, loud on failure.
    fn set<T: std::str::FromStr>(slot: &mut Option<T>, key: &str, value: &str) {
        if let Ok(parsed) = value.parse() {
            *slot = Some(parsed);
        } else {
            error!(key, value, "unparsable test-override value; ignored");
        }
    }

    let mut out = TestOverrides::default();
    for pair in raw.split(',').filter(|p| !p.trim().is_empty()) {
        let Some((key, value)) = pair.split_once('=') else {
            error!(
                pair,
                "malformed test-override pair (want key=value); ignored"
            );
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "retention_memory_max_bytes" => set(&mut out.retention_memory_max_bytes, key, value),
            "retention_spool_max_bytes" => set(&mut out.retention_spool_max_bytes, key, value),
            "registry_max_completed" => set(&mut out.registry_max_completed, key, value),
            "registry_completed_ttl_ms" => set(&mut out.registry_completed_ttl_ms, key, value),
            "registry_tombstone_ttl_ms" => set(&mut out.registry_tombstone_ttl_ms, key, value),
            "housekeeping_tick_ms" => set(&mut out.housekeeping_tick_ms, key, value),
            "capacity_mem_bytes" => set(&mut out.capacity_mem_bytes, key, value),
            "capacity_disk_bytes" => set(&mut out.capacity_disk_bytes, key, value),
            other => error!(key = other, "unknown test-override key; ignored"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_keys_and_rejects_unknown() {
        let parsed = parse(
            "retention_memory_max_bytes=1024, registry_max_completed=2,\
             housekeeping_tick_ms=250,bogus_key=9,capacity_mem_bytes=42",
        );
        assert_eq!(parsed.retention_memory_max_bytes, Some(1024));
        assert_eq!(parsed.registry_max_completed, Some(2));
        assert_eq!(parsed.housekeeping_tick_ms, Some(250));
        assert_eq!(parsed.capacity_mem_bytes, Some(42));
        assert_eq!(parsed.capacity_disk_bytes, None);
        assert!(parsed.active());
    }

    #[test]
    fn empty_is_inactive() {
        assert!(!parse("").active());
        assert!(!TestOverrides::default().active());
    }
}
