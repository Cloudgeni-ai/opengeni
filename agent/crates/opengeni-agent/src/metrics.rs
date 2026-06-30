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
//! Linux reads the rich `/proc` sources. **macOS** reads the same signals from
//! its native tools via subprocess — the SAME no-FFI strategy the GPU reader
//! uses for `nvidia-smi`, so the workspace `unsafe_code = forbid` holds with no
//! `libc`/`mach` bindings of our own: load from `sysctl vm.loadavg`, mem total
//! from `sysctl hw.memsize` (used best-effort from `vm_stat`), and cpu% from
//! `top -l 2` (its second sample reflects a real interval — the macOS analog of
//! the `/proc/stat` delta). The macOS run-queue has no cheap source, so it stays
//! zero == "not reported"; any other OS likewise degrades every rich field to
//! zero (the honest-degradation rule the M6 seam used). **No `unsafe`** —
//! `statvfs` goes through the safe `nix` crate and every macOS reading is a
//! subprocess parse, never our own FFI.
//!
//! # Determinism / testing
//!
//! Every text/number reading is factored into pure functions
//! (`parse_meminfo`, `parse_loadavg`, `cpu_busy_total_from_stat`, the macOS
//! `parse_sysctl_loadavg` / `parse_vm_stat_used` / `parse_top_cpu_busy`, and the
//! cross-platform `disk_used_total`) so the unit tests parse committed fixtures
//! with NO live host dependency — bounds, the null-when-absent contract, the CPU
//! delta, and the disk fragment-size unit are all deterministic.

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
    #[cfg(target_os = "macos")]
    {
        if let Some(text) = run_sysctl("vm.loadavg") {
            let (l1, l5, l15) = parse_sysctl_loadavg(&text);
            // The runnable run-queue count has no cheap macOS source (it is the
            // 4th `/proc/loadavg` field on Linux); 0 == "not reported".
            return (l1, l5, l15, 0.0);
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

/// Whole-machine CPU utilization 0..100.
///
/// Linux: the delta of two `/proc/stat` reads over [`CPU_SAMPLE_INTERVAL`]
/// (~200ms). macOS: `top -l 2 -n 0`, whose SECOND `CPU usage:` line reflects a
/// real sampling interval (the first is cumulative-since-boot, so a single read
/// is meaningless — the same reason the Linux path needs a delta); `top`'s
/// default interval is ~1s, so the macOS sample blocks ~1s rather than 200ms.
/// Returns 0.0 on any read failure or an unsupported OS (zero == "not reported").
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
    #[cfg(target_os = "macos")]
    {
        run_capture("top", &["-l", "2", "-n", "0"])
            .map(|text| parse_top_cpu_busy(&text))
            .unwrap_or(0.0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        // total is authoritative (`hw.memsize`, already bytes). used is
        // best-effort from `vm_stat`; if that is unreadable we still report the
        // correct total with used == 0 (the bounds invariant used <= total holds).
        if let Some(total) = run_sysctl("hw.memsize").and_then(|t| t.trim().parse::<u64>().ok()) {
            let used = run_capture("vm_stat", &[])
                .map(|t| parse_vm_stat_used(&t, total))
                .unwrap_or(0);
            return (used.min(total), total);
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
#[allow(clippy::unnecessary_cast, clippy::cast_lossless)] // statvfs counts are u64 on Linux, u32 on macOS
fn read_disk(root: &str) -> (u64, u64) {
    #[cfg(unix)]
    {
        use nix::sys::statvfs::statvfs;
        let Ok(stat) = statvfs(root.as_bytes()) else {
            return (0, 0);
        };
        // POSIX counts f_blocks/f_bavail in units of f_frsize (the FRAGMENT size),
        // NOT f_bsize. On Linux f_frsize == f_bsize so the distinction never bit;
        // on macOS f_bsize == f_iosize (~1 MiB) while f_frsize == 4096 and the
        // counts are in 4 KiB units, so multiplying by the larger f_bsize inflated
        // every figure by 1 MiB / 4 KiB == 256x (the reported ~237146 GB). Multiply
        // by f_frsize ALONE.
        //
        // The block COUNTS are `fsblkcnt_t` — u64 on Linux (glibc), u32 on macOS;
        // cast to the u64 wire type (a no-op on Linux, widening on macOS) before the
        // saturating arithmetic in `disk_used_total` (which never overflows).
        disk_used_total(
            stat.fragment_size(),
            stat.blocks() as u64,
            stat.blocks_available() as u64,
        )
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        (0, 0)
    }
}

/// Pure disk arithmetic: `bytes = block-count × fragment_size`, with
/// `used = total − available` (available clamped to `total`). Factored out of
/// [`read_disk`] so the fragment-size unit — the source of the macOS 256x bug —
/// is deterministically unit-testable without a live `statvfs`.
#[cfg_attr(not(unix), allow(dead_code))]
fn disk_used_total(fragment_size: u64, blocks: u64, blocks_available: u64) -> (u64, u64) {
    let total = blocks.saturating_mul(fragment_size);
    let avail = blocks_available.saturating_mul(fragment_size).min(total);
    let used = total.saturating_sub(avail);
    (used, total)
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

// ── macOS native readers (subprocess; no FFI → unsafe_code = forbid holds) ────
//
// The wrappers shell out exactly like `read_gpus` does for `nvidia-smi`; the
// parsers are pure functions over the tools' text so they unit-test on ANY host
// (the macOS branches above are the only macOS-gated code). The wrappers compile
// on every target (so a non-macOS `cargo check` still type-checks them) but are
// dead outside macOS — hence the `allow(dead_code)`.

/// Runs `cmd args…` and returns its stdout as a `String`, or `None` if the
/// process fails to spawn or exits non-zero. The macOS-metrics analog of the
/// `nvidia-smi` spawn in [`read_gpus`] — never panics, never blocks on input.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run_capture(cmd: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(cmd).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `sysctl -n <name>` → its trimmed-on-use stdout (e.g. `vm.loadavg`,
/// `hw.memsize`). A thin convenience over [`run_capture`].
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run_sysctl(name: &str) -> Option<String> {
    run_capture("sysctl", &["-n", name])
}

/// Parse `sysctl -n vm.loadavg` output — `{ 0.52 0.48 0.45 }` → `(0.52, 0.48,
/// 0.45)`. Tolerant of the surrounding braces and extra whitespace; any field it
/// cannot parse degrades to `0.0`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_sysctl_loadavg(text: &str) -> (f64, f64, f64) {
    let nums: Vec<f64> = text
        .replace(['{', '}'], " ")
        .split_whitespace()
        .filter_map(|tok| tok.parse::<f64>().ok())
        .collect();
    let l1 = nums.first().copied().unwrap_or(0.0);
    let l5 = nums.get(1).copied().unwrap_or(0.0);
    let l15 = nums.get(2).copied().unwrap_or(0.0);
    (l1, l5, l15)
}

/// Whole-machine busy% from `top -l 2 -n 0` output: the LAST `CPU usage:` line
/// (the second sample, a real interval), summing the `user` + `sys` percentages.
/// A line like `CPU usage: 4.76% user, 9.52% sys, 85.71% idle` → `14.28`. Missing
/// or unparseable → `0.0`; the result is clamped to `0..=100`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_top_cpu_busy(text: &str) -> f64 {
    let Some(line) = text.lines().rfind(|l| l.contains("CPU usage:")) else {
        return 0.0;
    };
    let after = line.split("CPU usage:").nth(1).unwrap_or("");
    let mut busy = 0.0;
    for seg in after.split(',') {
        let seg = seg.trim();
        if seg.ends_with("user") || seg.ends_with("sys") {
            if let Some(pct) = seg
                .split('%')
                .next()
                .and_then(|p| p.trim().parse::<f64>().ok())
            {
                busy += pct;
            }
        }
    }
    busy.clamp(0.0, 100.0)
}

/// "Used" bytes from `vm_stat`, given the authoritative `total_bytes`
/// (`hw.memsize`). macOS has no single "available" figure, so we treat the
/// reclaimable pages (free + inactive + speculative + purgeable) as available and
/// report `used = total − available` — the same memory-pressure framing as the
/// Linux `MemTotal − MemAvailable`. The page size is read from the `vm_stat`
/// header (4 KiB on Intel, 16 KiB on Apple Silicon); a missing field degrades to
/// 0 pages. `used` is clamped to `0..=total`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_vm_stat_used(text: &str, total_bytes: u64) -> u64 {
    let page = parse_vm_stat_page_size(text).unwrap_or(4096);
    let reclaimable_pages = vm_stat_value(text, "Pages free")
        .saturating_add(vm_stat_value(text, "Pages inactive"))
        .saturating_add(vm_stat_value(text, "Pages speculative"))
        .saturating_add(vm_stat_value(text, "Pages purgeable"));
    let available = reclaimable_pages.saturating_mul(page).min(total_bytes);
    total_bytes.saturating_sub(available)
}

/// The page size (bytes) from a `vm_stat` header line —
/// `…(page size of 16384 bytes)` → `16384`. `None` if the header is absent or
/// malformed (callers fall back to 4096).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_vm_stat_page_size(text: &str) -> Option<u64> {
    text.lines()
        .next()?
        .split("page size of")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()
}

/// The page count for a `vm_stat` row keyed by `key` (e.g. `Pages free`). The
/// value is the count before the trailing `.`; a missing or unparseable row is 0.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn vm_stat_value(text: &str, key: &str) -> u64 {
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == key {
                return v.trim().trim_end_matches('.').parse::<u64>().unwrap_or(0);
            }
        }
    }
    0
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

    #[test]
    fn disk_used_total_counts_blocks_in_fragment_size_units() {
        // POSIX counts f_blocks/f_bavail in f_frsize units. On macOS f_frsize is
        // 4096 while f_bsize == f_iosize (~1 MiB); the pre-fix code multiplied by
        // max(frsize, bsize) == 1 MiB, a 1 MiB / 4 KiB == 256x inflation (the
        // reported ~237146 GB). The fix multiplies by f_frsize alone.
        let frsize = 4096u64;
        let blocks = 262_144u64; // 262144 × 4096 == 1 GiB
        let avail = 131_072u64; // half free
        let (used, total) = disk_used_total(frsize, blocks, avail);
        assert_eq!(
            total,
            1024 * 1024 * 1024,
            "1 GiB total, counted in frsize units"
        );
        assert_eq!(used, 512 * 1024 * 1024, "half used");

        // Documents the bug the fix removes: had we used f_bsize (1 MiB) as the
        // multiplier the total would have been exactly 256x too large.
        let buggy_block = frsize.max(1024 * 1024);
        assert_eq!(
            blocks * buggy_block,
            total * 256,
            "the 256x inflation, gone"
        );
    }

    #[test]
    fn disk_used_total_clamps_available_and_saturates() {
        // A pathological avail > blocks still yields used == 0 (clamped), total
        // honest — never an underflow panic.
        let (used, total) = disk_used_total(4096, 10, 1_000);
        assert_eq!(total, 10 * 4096);
        assert_eq!(used, 0);
        // Saturating multiply: an absurd count cannot overflow u64.
        let (_, big) = disk_used_total(u64::MAX, u64::MAX, 0);
        assert_eq!(big, u64::MAX);
    }

    #[test]
    fn parse_sysctl_loadavg_extracts_three_loads() {
        let (l1, l5, l15) = parse_sysctl_loadavg("{ 0.52 0.48 0.45 }\n");
        assert!((l1 - 0.52).abs() < 1e-9);
        assert!((l5 - 0.48).abs() < 1e-9);
        assert!((l15 - 0.45).abs() < 1e-9);
    }

    #[test]
    fn parse_sysctl_loadavg_degrades_on_garbage() {
        assert_eq!(parse_sysctl_loadavg("not loadavg"), (0.0, 0.0, 0.0));
    }

    #[test]
    fn parse_top_cpu_busy_uses_the_second_sample_and_sums_user_sys() {
        // `top -l 2` prints two summaries; the FIRST is cumulative-since-boot, the
        // SECOND is the real interval. We must read the second and sum user + sys.
        let fixture = "\
Processes: 500 total, 2 running\n\
CPU usage: 1.00% user, 1.00% sys, 98.00% idle\n\
PhysMem: 8G used\n\
Processes: 500 total, 3 running\n\
CPU usage: 4.76% user, 9.52% sys, 85.71% idle\n\
PhysMem: 8G used\n";
        let busy = parse_top_cpu_busy(fixture);
        assert!(
            (busy - 14.28).abs() < 1e-9,
            "second sample: 4.76 + 9.52, not the first"
        );
    }

    #[test]
    fn parse_top_cpu_busy_clamps_and_degrades() {
        assert_eq!(parse_top_cpu_busy("no cpu line here"), 0.0);
        // A pathological >100 sum clamps to 100.
        let busy = parse_top_cpu_busy("CPU usage: 80.00% user, 40.00% sys, 0.00% idle\n");
        assert!((busy - 100.0).abs() < 1e-9);
    }

    #[test]
    fn parse_vm_stat_used_is_total_minus_reclaimable() {
        // 4096-byte pages. reclaimable = free + inactive + speculative + purgeable
        // = (10 + 20 + 5 + 5) = 40 pages == 163840 bytes available.
        let fixture = "\
Mach Virtual Memory Statistics: (page size of 4096 bytes)\n\
Pages free:                                  10.\n\
Pages active:                               100.\n\
Pages inactive:                              20.\n\
Pages speculative:                            5.\n\
Pages wired down:                            50.\n\
Pages purgeable:                              5.\n\
Pages occupied by compressor:                30.\n";
        let total = 1_000_000u64;
        let used = parse_vm_stat_used(fixture, total);
        let available = (10 + 20 + 5 + 5) * 4096;
        assert_eq!(used, total - available);
        assert!(used < total);
    }

    #[test]
    fn parse_vm_stat_used_reads_apple_silicon_page_size() {
        // 16 KiB pages (Apple Silicon); a missing purgeable row degrades to 0.
        let fixture = "\
Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
Pages free:                                  10.\n\
Pages inactive:                              10.\n\
Pages speculative:                            0.\n";
        let total = 10_000_000u64;
        let used = parse_vm_stat_used(fixture, total);
        let available = (10 + 10) * 16384;
        assert_eq!(used, total - available);
    }

    #[test]
    fn parse_vm_stat_used_clamps_when_reclaimable_exceeds_total() {
        // If reclaimable pages exceed the (tiny) total, used clamps to 0.
        let fixture = "\
Mach Virtual Memory Statistics: (page size of 4096 bytes)\n\
Pages free:                              100000.\n";
        assert_eq!(parse_vm_stat_used(fixture, 4096), 0);
    }

    #[test]
    fn parse_vm_stat_page_size_defaults_to_4096_when_absent() {
        // No header → fall back to 4096 (the parser returns None, caller defaults).
        assert!(parse_vm_stat_page_size("Pages free: 1.\n").is_none());
        assert_eq!(
            parse_vm_stat_page_size("foo (page size of 16384 bytes)\n"),
            Some(16384)
        );
    }
}
