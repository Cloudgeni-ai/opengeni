//! The impure [`HostCapacity`] sampler (LIMITS-DOCTRINE.md rule R).
//!
//! The pure engine receives measurements and never takes them; this module is
//! where the measurements happen. Every budget and breaker in the runner is
//! derived from these figures as a fraction of the machine, so the runner
//! scales itself to whatever host it lands on instead of hardcoding a claim
//! about it.
//!
//! Sampling is best-effort per field: a value that cannot be read falls back
//! to the corresponding [`HostCapacity::default`] figure (a generous honest
//! guess — derivations clamp to floors, so overstating capacity is safer than
//! accidentally constraining a healthy host).

use std::path::Path;

use opengeni_agent_engine::HostCapacity;

/// Samples the host. `spool_root` names the filesystem whose free space backs
/// the disk-spool budgets (it is created if missing so `statvfs` can run).
/// Blocking (procfs + statvfs reads) — call on the blocking pool from async
/// contexts.
#[must_use]
pub fn sample(spool_root: &Path) -> HostCapacity {
    let defaults = HostCapacity::default();
    HostCapacity {
        mem_available_bytes: mem_available_bytes().unwrap_or(defaults.mem_available_bytes),
        disk_free_bytes: disk_free_bytes(spool_root).unwrap_or(defaults.disk_free_bytes),
        fd_headroom: fd_headroom().unwrap_or(defaults.fd_headroom),
        pid_headroom: pid_headroom().unwrap_or(defaults.pid_headroom),
        nproc: std::thread::available_parallelism().map_or(defaults.nproc, |n| n.get() as u64),
    }
}

/// `MemAvailable` from `/proc/meminfo`, in bytes. Linux-only; `None` elsewhere.
fn mem_available_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        parse_mem_available(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Parses the `MemAvailable: <kB> kB` line. Split out for deterministic tests.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_mem_available(meminfo: &str) -> Option<u64> {
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb.saturating_mul(1024));
        }
    }
    None
}

/// Free bytes (available to an unprivileged user) on `spool_root`'s
/// filesystem, via the SAFE `nix` statvfs binding (the same pattern as the
/// metrics disk sample; f_frsize is the correct unit).
#[allow(clippy::unnecessary_cast, clippy::cast_lossless)] // statvfs counts: u64 on Linux, u32 on macOS
fn disk_free_bytes(spool_root: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        let _ = std::fs::create_dir_all(spool_root);
        let stat = nix::sys::statvfs::statvfs(spool_root).ok()?;
        Some((stat.blocks_available() as u64).saturating_mul(stat.fragment_size() as u64))
    }
    #[cfg(not(unix))]
    {
        let _ = spool_root;
        None
    }
}

/// File descriptors this process may still open: the soft `RLIMIT_NOFILE`
/// (from `/proc/self/limits`) minus the count of `/proc/self/fd` entries.
fn fd_headroom() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let limits = std::fs::read_to_string("/proc/self/limits").ok()?;
        let max = parse_limit_soft(&limits, "Max open files")?;
        let in_use = std::fs::read_dir("/proc/self/fd").ok()?.count() as u64;
        Some(max.saturating_sub(in_use))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Processes/threads that may still be spawned. Reads the cgroup `pids.max`
/// when the process lives in a bounded cgroup, else the soft `RLIMIT_NPROC`.
/// Current usage is NOT subtracted (counting a user's processes is expensive
/// and racy) — this errs generous, which the doctrine prefers, and the derived
/// breakers divide it well down.
fn pid_headroom() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        if let Some(max) = cgroup_pids_max() {
            return Some(max);
        }
        let limits = std::fs::read_to_string("/proc/self/limits").ok()?;
        parse_limit_soft(&limits, "Max processes")
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// The `pids.max` of this process's cgroup (v2 unified hierarchy), if bounded.
#[cfg(target_os = "linux")]
fn cgroup_pids_max() -> Option<u64> {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    // v2 unified: a single "0::/path" line.
    let path = cgroup
        .lines()
        .find_map(|l| l.strip_prefix("0::"))?
        .trim()
        .trim_start_matches('/');
    let pids_max = std::fs::read_to_string(
        std::path::Path::new("/sys/fs/cgroup")
            .join(path)
            .join("pids.max"),
    )
    .ok()?;
    // "max" = unbounded → let the rlimit fallback answer instead.
    pids_max.trim().parse().ok()
}

/// Parses one `/proc/self/limits` row's SOFT value; "unlimited" → `u64::MAX`.
/// Split out for deterministic tests.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_limit_soft(limits: &str, name: &str) -> Option<u64> {
    for line in limits.lines() {
        if let Some(rest) = line.strip_prefix(name) {
            let soft = rest.split_whitespace().next()?;
            if soft == "unlimited" {
                return Some(u64::MAX);
            }
            return soft.parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mem_available_from_meminfo() {
        let meminfo = "MemTotal:       32595504 kB\nMemFree:         1000000 kB\nMemAvailable:   16297752 kB\n";
        assert_eq!(
            parse_mem_available(meminfo),
            Some(16_297_752 * 1024),
            "kB converted to bytes"
        );
        assert_eq!(parse_mem_available("MemTotal: 1 kB\n"), None);
    }

    #[test]
    fn parses_soft_limits_including_unlimited() {
        let limits = "Limit                     Soft Limit           Hard Limit           Units\n\
                      Max processes             127420               127420               processes\n\
                      Max open files            65536                1048576              files\n\
                      Max locked memory         unlimited            unlimited            bytes\n";
        assert_eq!(parse_limit_soft(limits, "Max open files"), Some(65_536));
        assert_eq!(parse_limit_soft(limits, "Max processes"), Some(127_420));
        assert_eq!(
            parse_limit_soft(limits, "Max locked memory"),
            Some(u64::MAX)
        );
        assert_eq!(parse_limit_soft(limits, "Max nonexistent"), None);
    }

    #[test]
    fn live_sample_reports_nonzero_capacity_everywhere() {
        let dir = tempfile::tempdir().expect("tempdir");
        let capacity = sample(dir.path());
        // Every field is at least the honest-default floor's order of
        // magnitude — a broken reader degrades to defaults, never to zero.
        assert!(capacity.mem_available_bytes > 0);
        assert!(capacity.disk_free_bytes > 0);
        assert!(capacity.fd_headroom > 0);
        assert!(capacity.pid_headroom > 0);
        assert!(capacity.nproc > 0);
    }
}
