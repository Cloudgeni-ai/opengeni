//! Real machine-metrics sampling for the heartbeat payload (dossier §10.7, M10).
//!
//! The heartbeat ([`AgentEvent`](opengeni_agent_proto::v1::AgentEvent)) carries a
//! [`MetricsSample`] so the control plane can upsert the machine's last sample
//! without a separate RPC; the same [`sample`] also answers the on-demand
//! `metrics.sample` RPC ([`crate::dispatch`]). M10 deepens the readings from the
//! M6 seam (timestamp + load averages only) to REAL whole-machine signals:
//!
//! * **cpu%** — whole-machine CPU utilization, the delta of two `/proc/stat`
//!   reads (the only correct way: a single read is meaningless).
//! * **mem used/total** — `/proc/meminfo` (`MemTotal - MemAvailable` is the
//!   "used" the dashboard wants, matching `free`'s used column).
//! * **disk used/total** — `statvfs` of the workspace root via the SAFE `nix`
//!   binding (no `unsafe`; the workspace `unsafe_code = forbid` holds).
//! * **load1/5/15 + run-queue** — `/proc/loadavg` (load averages were the M6
//!   seam; the 4th field `runnable/total` is the contention/run-queue signal).
//! * **gpu util/mem** — best-effort `nvidia-smi` (null when absent — the wire
//!   contract treats a missing GPU as "not reported", never a real zero).
//!
//! # Cross-platform posture
//!
//! The richer `/proc`-based readings are Linux-only (gated on `target_os`); on
//! other OSes those fields stay zero == "not reported" until their native
//! sources land (the same honest-degradation rule the M6 seam used). The
//! load-average reading is unix-wide via `/proc` on Linux. **No `unsafe`** — the
//! one syscall (`statvfs`) goes through the safe `nix` crate.
//!
//! # Determinism / testing
//!
//! The `/proc` parsing is factored into pure functions over text
//! (`parse_meminfo`, `parse_loadavg`, `cpu_busy_total_from_stat`) so the unit
//! tests parse committed fixtures with NO live host dependency — bounds, the
//! null-when-absent contract, and the CPU delta are all deterministic.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opengeni_agent_proto::v1::{GpuSample, MetricsSample};

/// The minimum interval between the two `/proc/stat` reads a CPU% delta needs.
/// A short window keeps the synchronous sample cheap while still being long
/// enough to register a non-trivial busy fraction.
const CPU_SAMPLE_INTERVAL: Duration = Duration::from_millis(200);

/// Produces a best-effort point-in-time metrics sample.
///
/// Always stamps `sampled_at_ms`. On Linux it fills cpu% (a `/proc/stat` delta
/// over [`CPU_SAMPLE_INTERVAL`]), mem used/total (`/proc/meminfo`), disk
/// used/total (`statvfs` of the workspace root), the load averages + run-queue
/// (`/proc/loadavg`), and best-effort GPU samples (`nvidia-smi`, omitted when no
/// GPU). Any individual reading that fails degrades to "not reported" (zero /
/// empty) — a metrics gap must NEVER fail a heartbeat.
///
/// This briefly blocks ([`CPU_SAMPLE_INTERVAL`]) for the CPU delta, so callers on
/// an async runtime should invoke it via `spawn_blocking` (the supervisor does).
#[must_use]
pub fn sample() -> MetricsSample {
    sample_with_root(&workspace_root())
}

/// [`sample`] against an explicit disk-root path (the path whose filesystem the
/// disk used/total reflects). Split out so the disk reading targets the agent's
/// actual workspace root rather than always `/`.
#[must_use]
// load1/load5/load15 are the wire-contract field names; clippy's similar-names
// lint flags them but they cannot be renamed without diverging from the proto.
#[allow(clippy::similar_names)]
pub fn sample_with_root(disk_root: &str) -> MetricsSample {
    let sampled_at_ms = now_millis();
    let (load1, load5, load15, run_queue) = read_loadavg();
    let cpu_percent = read_cpu_percent();
    let (mem_used_bytes, mem_total_bytes) = read_memory();
    let (disk_used_bytes, disk_total_bytes) = read_disk(disk_root);
    let gpus = read_gpus();

    MetricsSample {
        sampled_at_ms,
        cpu_percent,
        load1,
        load5,
        load15,
        mem_used_bytes,
        mem_total_bytes,
        disk_used_bytes,
        disk_total_bytes,
        run_queue,
        gpus,
    }
}

/// The wall-clock stamp (unix epoch ms), saturating rather than panicking on the
/// (impossible) pre-epoch clock.
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The disk-root path whose filesystem the disk reading reflects: the agent's
/// current working directory (its workspace root), falling back to `/`.
fn workspace_root() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "/".to_string())
}

// ── load averages + run-queue (/proc/loadavg) ────────────────────────────────

/// Reads `(load1, load5, load15, run_queue)`. The run-queue is the runnable
/// count from the 4th field (`runnable/total`) — a contention signal. A read
/// failure (non-Linux, or `/proc` unavailable) degrades to all-zeros.
fn read_loadavg() -> (f64, f64, f64, f64) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/loadavg") {
            return parse_loadavg(&text);
        }
    }
    (0.0, 0.0, 0.0, 0.0)
}

/// Parse `/proc/loadavg`: `0.50 0.40 0.30 1/523 12345` →
/// `(0.50, 0.40, 0.30, 1.0)`. The 4th field is `runnable/total`; we surface the
/// runnable count as the run-queue contention signal. A malformed line yields
/// zeros for the fields it cannot parse.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_loadavg(text: &str) -> (f64, f64, f64, f64) {
    let mut parts = text.split_whitespace();
    let l1 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l5 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l15 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let run_queue = parts
        .next()
        .and_then(|field| field.split('/').next())
        .and_then(|runnable| runnable.parse::<f64>().ok())
        .unwrap_or(0.0);
    (l1, l5, l15, run_queue)
}

// ── cpu% (/proc/stat delta) ──────────────────────────────────────────────────

/// Whole-machine CPU utilization 0..100, the delta of two `/proc/stat` reads
/// over [`CPU_SAMPLE_INTERVAL`]. Returns 0.0 on non-Linux or any read failure
/// (zero == "not reported").
fn read_cpu_percent() -> f64 {
    #[cfg(target_os = "linux")]
    {
        let read = || {
            std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|t| cpu_busy_total_from_stat(&t))
        };
        let Some(first) = read() else { return 0.0 };
        std::thread::sleep(CPU_SAMPLE_INTERVAL);
        let Some(second) = read() else { return 0.0 };
        cpu_percent_from_deltas(first, second)
    }
    #[cfg(not(target_os = "linux"))]
    {
        0.0
    }
}

/// Parse the aggregate `cpu` line of `/proc/stat` into `(busy, total)` jiffy
/// counters. The line is `cpu user nice system idle iowait irq softirq steal
/// guest guest_nice`; total is the sum, busy is `total - (idle + iowait)`.
/// Returns `None` if the `cpu ` line is absent or unparseable.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn cpu_busy_total_from_stat(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().find(|l| l.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1) // skip the "cpu" label
        .filter_map(|f| f.parse::<u64>().ok())
        .collect();
    // Need at least user..iowait (indices 0..=4) to compute idle+iowait.
    if fields.len() < 5 {
        return None;
    }
    let total: u64 = fields.iter().sum();
    let idle = fields[3];
    let iowait = fields[4];
    let busy = total.saturating_sub(idle.saturating_add(iowait));
    Some((busy, total))
}

/// CPU% from two `(busy, total)` snapshots. A non-advancing or backwards `total`
/// (counter reset) yields 0.0; the result is clamped to `0..=100`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn cpu_percent_from_deltas(first: (u64, u64), second: (u64, u64)) -> f64 {
    let busy_delta = second.0.saturating_sub(first.0);
    let total_delta = second.1.saturating_sub(first.1);
    if total_delta == 0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let pct = (busy_delta as f64 / total_delta as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

// ── memory (/proc/meminfo) ───────────────────────────────────────────────────

/// Reads `(mem_used_bytes, mem_total_bytes)`. "Used" is `MemTotal -
/// MemAvailable` (matching `free`'s used column — the figure a human reads as
/// memory pressure). Returns `(0, 0)` on non-Linux or any read failure.
fn read_memory() -> (u64, u64) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
            return parse_meminfo(&text);
        }
    }
    (0, 0)
}

/// Parse `/proc/meminfo` into `(used_bytes, total_bytes)`. The file reports kB;
/// we convert to bytes. `used = MemTotal - MemAvailable`. If `MemAvailable` is
/// absent (very old kernels) we fall back to `MemFree`. A missing `MemTotal`
/// yields `(0, 0)` (not reported).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_meminfo(text: &str) -> (u64, u64) {
    let mut total_kb: Option<u64> = None;
    let mut available_kb: Option<u64> = None;
    let mut free_kb: Option<u64> = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let value = parts.next().and_then(|v| v.parse::<u64>().ok());
        match key {
            "MemTotal:" => total_kb = value,
            "MemAvailable:" => available_kb = value,
            "MemFree:" => free_kb = value,
            _ => {}
        }
    }
    let Some(total_kb) = total_kb else {
        return (0, 0);
    };
    let avail_kb = available_kb.or(free_kb).unwrap_or(0).min(total_kb);
    let used_kb = total_kb.saturating_sub(avail_kb);
    (used_kb.saturating_mul(1024), total_kb.saturating_mul(1024))
}

// ── disk (statvfs of the workspace root) ─────────────────────────────────────

/// Reads `(disk_used_bytes, disk_total_bytes)` for the filesystem containing
/// `root` via the SAFE `nix` `statvfs` binding. "Used" is `total - available`
/// (available-to-unprivileged, matching `df`'s used column for the non-root
/// user). Returns `(0, 0)` on any failure (non-unix or a statvfs error).
fn read_disk(root: &str) -> (u64, u64) {
    #[cfg(unix)]
    {
        use nix::sys::statvfs::statvfs;
        let Ok(stat) = statvfs(root.as_bytes()) else {
            return (0, 0);
        };
        // On Linux + macOS (our cargo targets) the statvfs block size + counts are
        // u64, so the byte arithmetic is done directly in u64 (the wire type).
        // saturating_* never overflows.
        let block: u64 = stat.fragment_size().max(stat.block_size());
        let total: u64 = stat.blocks().saturating_mul(block);
        let avail: u64 = stat.blocks_available().saturating_mul(block);
        let used: u64 = total.saturating_sub(avail);
        (used, total)
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        (0, 0)
    }
}

// ── gpu (best-effort nvidia-smi) ─────────────────────────────────────────────

/// Best-effort per-GPU samples via `nvidia-smi`. Returns an EMPTY vec when no
/// GPU / no `nvidia-smi` (the wire contract: absence == not reported, never a
/// real zero). Never fails the sample — a missing binary or a non-zero exit is
/// simply "no GPUs".
fn read_gpus() -> Vec<GpuSample> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_nvidia_smi(&text)
}

/// Parse the CSV `nvidia-smi --query-gpu` output (one GPU per line:
/// `name, util%, mem_used_MiB, mem_total_MiB`). A malformed line is skipped (the
/// other GPUs still report). MiB are converted to bytes.
fn parse_nvidia_smi(text: &str) -> Vec<GpuSample> {
    let mib = 1024u64 * 1024;
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() < 4 {
                return None;
            }
            let name = fields[0].to_string();
            let util_percent = fields[1].parse::<f64>().ok()?.clamp(0.0, 100.0);
            let mem_used_bytes = fields[2].parse::<u64>().ok()?.saturating_mul(mib);
            let mem_total_bytes = fields[3].parse::<u64>().ok()?.saturating_mul(mib);
            Some(GpuSample {
                name,
                util_percent,
                mem_used_bytes,
                mem_total_bytes,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    // The CPU/gpu/loadavg assertions compare deterministic, exactly-representable
    // f64 results (50.0, 0.0, 100.0) — an epsilon dance would only obscure intent.
    #![allow(clippy::float_cmp)]
    use super::*;

    #[test]
    fn sample_is_timestamped() {
        let s = sample();
        assert!(s.sampled_at_ms > 0, "sample must carry a wall-clock stamp");
    }

    #[test]
    fn sample_bounds_are_sane() {
        // Whatever the host, the structural invariants always hold (no negative
        // load, cpu% in range, used <= total when both reported).
        let s = sample();
        assert!(s.load1 >= 0.0 && s.load5 >= 0.0 && s.load15 >= 0.0);
        assert!((0.0..=100.0).contains(&s.cpu_percent));
        assert!(s.run_queue >= 0.0);
        if s.mem_total_bytes > 0 {
            assert!(s.mem_used_bytes <= s.mem_total_bytes);
        }
        if s.disk_total_bytes > 0 {
            assert!(s.disk_used_bytes <= s.disk_total_bytes);
        }
    }

    #[test]
    fn parse_loadavg_extracts_three_loads_and_run_queue() {
        let (l1, l5, l15, rq) = parse_loadavg("0.50 0.40 0.30 2/523 98765\n");
        assert!((l1 - 0.50).abs() < 1e-9);
        assert!((l5 - 0.40).abs() < 1e-9);
        assert!((l15 - 0.30).abs() < 1e-9);
        assert!((rq - 2.0).abs() < 1e-9, "run-queue is the runnable count");
    }

    #[test]
    fn parse_loadavg_degrades_on_garbage() {
        let (l1, l5, l15, rq) = parse_loadavg("not a loadavg line");
        assert_eq!((l1, l5, l15, rq), (0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn parse_meminfo_uses_total_minus_available() {
        let fixture = "\
MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8192000 kB
Buffers:          500000 kB
";
        let (used, total) = parse_meminfo(fixture);
        assert_eq!(total, 16_384_000 * 1024);
        // used = (16_384_000 - 8_192_000) kB → bytes.
        assert_eq!(used, 8_192_000 * 1024);
        assert!(used < total);
    }

    #[test]
    fn parse_meminfo_falls_back_to_memfree_when_no_available() {
        let fixture = "MemTotal: 1000 kB\nMemFree: 400 kB\n";
        let (used, total) = parse_meminfo(fixture);
        assert_eq!(total, 1000 * 1024);
        assert_eq!(used, 600 * 1024); // 1000 - 400
    }

    #[test]
    fn parse_meminfo_missing_total_is_not_reported() {
        let (used, total) = parse_meminfo("Buffers: 123 kB\n");
        assert_eq!((used, total), (0, 0));
    }

    #[test]
    fn cpu_busy_total_parses_the_aggregate_line() {
        // cpu user nice system idle iowait irq softirq steal ...
        let fixture = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 ...\n";
        let (busy, total) = cpu_busy_total_from_stat(fixture).expect("cpu line");
        assert_eq!(total, 100 + 50 + 800 + 50);
        // busy = total - (idle + iowait) = 1000 - (800 + 50) = 150.
        assert_eq!(busy, 150);
    }

    #[test]
    fn cpu_busy_total_none_without_cpu_line() {
        assert!(cpu_busy_total_from_stat("intr 1 2 3\n").is_none());
    }

    #[test]
    fn cpu_percent_from_deltas_is_a_clamped_ratio() {
        // Between snapshots: busy advanced 50, total advanced 100 → 50%.
        let pct = cpu_percent_from_deltas((100, 1000), (150, 1100));
        assert!((pct - 50.0).abs() < 1e-9);
    }

    #[test]
    fn cpu_percent_from_deltas_handles_no_advance_and_clamps() {
        assert_eq!(cpu_percent_from_deltas((100, 1000), (100, 1000)), 0.0);
        // A pathological busy>total delta clamps to 100, never overflows.
        assert_eq!(cpu_percent_from_deltas((0, 0), (1000, 100)), 100.0);
    }

    #[test]
    fn parse_nvidia_smi_reads_each_gpu_and_converts_mib() {
        let fixture = "NVIDIA A100, 73, 4096, 40960\nNVIDIA A100, 12, 1024, 40960\n";
        let gpus = parse_nvidia_smi(fixture);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].name, "NVIDIA A100");
        assert!((gpus[0].util_percent - 73.0).abs() < 1e-9);
        assert_eq!(gpus[0].mem_used_bytes, 4096 * 1024 * 1024);
        assert_eq!(gpus[0].mem_total_bytes, 40960 * 1024 * 1024);
    }

    #[test]
    fn parse_nvidia_smi_skips_malformed_lines_and_empty_is_none() {
        // A header-ish / short line is skipped; a fully empty output → no GPUs
        // (the null-when-absent contract).
        assert!(parse_nvidia_smi("").is_empty());
        let gpus = parse_nvidia_smi("garbage line with too few fields\nNVIDIA T4, 5, 100, 16000\n");
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "NVIDIA T4");
    }

    #[test]
    fn read_disk_reports_used_le_total_for_an_existing_root() {
        // The repo root always exists; used must not exceed total (or both 0 on a
        // platform without statvfs).
        let (used, total) = read_disk(".");
        assert!(used <= total || total == 0);
    }
}
