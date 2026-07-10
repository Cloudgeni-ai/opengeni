//! The machine-readable result contract + the human summary.
//!
//! Every scenario emits one [`Report`] as `results/<scenario>-<ts>.json` (so a
//! run is reproducible from its `seed` + `config`) and prints a compact table.
//! Verdicts are the assertable invariants; a scenario's exit status is derived
//! from them unless `--no-assert` is set (baseline runs that only RECORD current
//! behavior, where e.g. large-reply failures are expected).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hdrhistogram::Histogram;
use serde::Serialize;

use crate::driver::{OpClass, OpOutcome};
use crate::proc;

/// Percentile summary of one op's latency distribution (microseconds).
#[derive(Debug, Clone, Serialize)]
pub struct LatencyStats {
    pub p50: u64,
    pub p90: u64,
    pub p95: u64,
    pub p99: u64,
    pub max: u64,
    pub count: u64,
}

/// One `/proc` resource sample of the agent over the run.
#[derive(Debug, Clone, Serialize)]
pub struct ResourceSample {
    pub t_ms: u64,
    pub rss_bytes: u64,
    pub fds: u64,
    pub threads: u64,
}

/// An assertable invariant and whether this run upheld it.
#[derive(Debug, Clone, Serialize)]
pub struct Verdict {
    pub check: String,
    pub pass: bool,
    pub detail: String,
}

/// The measurement block of the report.
#[derive(Debug, Clone, Serialize)]
pub struct Measurements {
    pub latency_us: BTreeMap<String, LatencyStats>,
    pub errors: BTreeMap<String, u64>,
    pub heartbeat_gaps_ms: BTreeMap<String, Vec<u64>>,
    pub resources: Vec<ResourceSample>,
}

/// The full per-scenario result document.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub scenario: String,
    pub seed: u64,
    pub config: serde_json::Value,
    pub started_at_unix_ms: u128,
    pub agent_version: String,
    pub measurements: Measurements,
    pub verdicts: Vec<Verdict>,
}

impl Report {
    /// Whether every verdict passed (the assert-mode exit condition).
    #[must_use]
    pub fn all_passed(&self) -> bool {
        self.verdicts.iter().all(|v| v.pass)
    }

    /// Writes the JSON document to `results_dir/<scenario>-<ts>.json`.
    ///
    /// # Errors
    ///
    /// Returns an IO error if the directory or file cannot be written.
    pub fn write(&self, results_dir: &Path) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(results_dir)?;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let path = results_dir.join(format!("{}-{}.json", self.scenario, ts));
        let body = serde_json::to_vec_pretty(self).expect("report serializes");
        std::fs::write(&path, body)?;
        Ok(path)
    }

    /// Prints the human summary table.
    pub fn print_summary(&self) {
        println!("\n=== scenario: {} (seed {}) ===", self.scenario, self.seed);
        println!("agent_version: {}", self.agent_version);

        if !self.measurements.latency_us.is_empty() {
            println!("\nlatency (microseconds):");
            println!(
                "  {:<12} {:>8} {:>10} {:>10} {:>10} {:>10}",
                "op", "count", "p50", "p95", "p99", "max"
            );
            for (op, s) in &self.measurements.latency_us {
                println!(
                    "  {:<12} {:>8} {:>10} {:>10} {:>10} {:>10}",
                    op, s.count, s.p50, s.p95, s.p99, s.max
                );
            }
        }

        if !self.measurements.errors.is_empty() {
            println!("\nerrors by code:");
            for (code, count) in &self.measurements.errors {
                println!("  {code:<22} {count}");
            }
        }

        if !self.measurements.resources.is_empty() {
            let first = &self.measurements.resources[0];
            let last = self.measurements.resources.last().unwrap();
            let max_rss = self
                .measurements
                .resources
                .iter()
                .map(|r| r.rss_bytes)
                .max()
                .unwrap_or(0);
            let (min_fd, max_fd) = self
                .measurements
                .resources
                .iter()
                .fold((u64::MAX, 0u64), |(lo, hi), r| {
                    (lo.min(r.fds), hi.max(r.fds))
                });
            println!(
                "\nagent resources ({} samples):",
                self.measurements.resources.len()
            );
            println!(
                "  rss  first={:.1}MiB last={:.1}MiB max={:.1}MiB",
                mib(first.rss_bytes),
                mib(last.rss_bytes),
                mib(max_rss)
            );
            println!(
                "  fds  first={} last={} range=[{}..{}]  threads last={}",
                first.fds, last.fds, min_fd, max_fd, last.threads
            );
        }

        if !self.measurements.heartbeat_gaps_ms.is_empty() {
            println!("\nheartbeat gaps (ms), per agent:");
            for (agent, gaps) in &self.measurements.heartbeat_gaps_ms {
                let max_gap = gaps.iter().copied().max().unwrap_or(0);
                let missed = gaps.iter().filter(|g| **g > 7500).count();
                println!(
                    "  {agent:<14} beats={} max_gap={}ms missed(>7.5s)={}",
                    gaps.len() + 1,
                    max_gap,
                    missed
                );
            }
        }

        println!("\nverdicts:");
        for v in &self.verdicts {
            let mark = if v.pass { "PASS" } else { "FAIL" };
            println!("  [{mark}] {} — {}", v.check, v.detail);
        }
        let overall = if self.all_passed() { "PASS" } else { "FAIL" };
        println!("\noverall: {overall}\n");
    }
}

/// Bytes → MiB for the human summary. Precision loss above 2^52 bytes is
/// irrelevant for an agent RSS readout.
#[allow(clippy::cast_precision_loss)]
fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// Accumulates op outcomes into per-op latency histograms + error counters.
pub struct Aggregator {
    hists: BTreeMap<&'static str, Histogram<u64>>,
    errors: BTreeMap<String, u64>,
}

impl Default for Aggregator {
    fn default() -> Self {
        Self::new()
    }
}

impl Aggregator {
    #[must_use]
    pub fn new() -> Self {
        Self {
            hists: BTreeMap::new(),
            errors: BTreeMap::new(),
        }
    }

    /// Records one outcome: a successful op's latency lands in its histogram; a
    /// typed error or transport failure increments its code counter.
    pub fn record(&mut self, outcome: &OpOutcome) {
        match &outcome.class {
            OpClass::Ok => {
                let hist = self
                    .hists
                    .entry(outcome.label)
                    .or_insert_with(new_histogram);
                hist.saturating_record(outcome.latency_us.max(1));
            }
            OpClass::AgentError(code) | OpClass::Transport(code) => {
                *self.errors.entry(code.clone()).or_insert(0) += 1;
            }
        }
    }

    /// Records a batch.
    pub fn record_all(&mut self, outcomes: &[OpOutcome]) {
        for o in outcomes {
            self.record(o);
        }
    }

    /// The number of typed errors recorded under `code`.
    #[must_use]
    pub fn error_count(&self, code: &str) -> u64 {
        self.errors.get(code).copied().unwrap_or(0)
    }

    /// The percentile stats for one op, if any successful sample was recorded.
    #[must_use]
    pub fn stats(&self, label: &str) -> Option<LatencyStats> {
        self.hists.get(label).map(latency_stats)
    }

    /// Folds the accumulator into the report's `latency_us` + `errors` maps.
    #[must_use]
    pub fn into_maps(self) -> (BTreeMap<String, LatencyStats>, BTreeMap<String, u64>) {
        let latency = self
            .hists
            .iter()
            .map(|(k, h)| ((*k).to_string(), latency_stats(h)))
            .collect();
        (latency, self.errors)
    }
}

/// Periodically samples an agent's `/proc` resources on a background task, so a
/// scenario can watch the RSS/fd/thread envelope (leak detection) without
/// blocking the driver loop.
pub struct ResourceSampler {
    samples: Arc<Mutex<Vec<ResourceSample>>>,
    task: tokio::task::JoinHandle<()>,
}

impl ResourceSampler {
    /// Starts sampling `pid` every `interval`, timestamping each sample relative
    /// to `start`.
    #[must_use]
    pub fn spawn(pid: i32, start: Instant, interval: Duration) -> Self {
        let samples = Arc::new(Mutex::new(Vec::new()));
        let task_samples = samples.clone();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            loop {
                tick.tick().await;
                if let Some(s) = proc::sample_proc(pid) {
                    let t_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
                    task_samples.lock().unwrap().push(ResourceSample {
                        t_ms,
                        rss_bytes: s.rss_bytes,
                        fds: s.fds,
                        threads: s.threads,
                    });
                }
            }
        });
        Self { samples, task }
    }

    /// Stops sampling and returns the collected series.
    #[must_use]
    pub fn finish(self) -> Vec<ResourceSample> {
        self.task.abort();
        Arc::try_unwrap(self.samples).map_or_else(
            |arc| arc.lock().unwrap().clone(),
            |m| m.into_inner().unwrap(),
        )
    }
}

/// A microsecond-scale histogram spanning up to one hour at 3 significant figures.
fn new_histogram() -> Histogram<u64> {
    Histogram::new_with_bounds(1, 3_600_000_000, 3).expect("valid histogram bounds")
}

/// Extracts the percentile summary from a histogram.
fn latency_stats(h: &Histogram<u64>) -> LatencyStats {
    LatencyStats {
        p50: h.value_at_quantile(0.50),
        p90: h.value_at_quantile(0.90),
        p95: h.value_at_quantile(0.95),
        p99: h.value_at_quantile(0.99),
        max: h.max(),
        count: h.len(),
    }
}
