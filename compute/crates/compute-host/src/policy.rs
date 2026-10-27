//! What the host may do and promise, from its flags and its machine:
//! admission and processor budgets, memory relief and disk booking.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};
use compute_core::{Admission, DiskPolicy, HostPolicy, MemoryPolicy};
use compute_engine::MemoryProfile;
use compute_host::cpu_share::ProcessorShare;

use crate::ServeArgs;

/// What the host may do, from its flags.
pub(super) fn host_policy(
    args: &ServeArgs,
    memory_profile: MemoryProfile,
    sample_every: Duration,
) -> anyhow::Result<HostPolicy> {
    let mut policy = HostPolicy::default();
    for &(step, limit) in &args.limits {
        policy.limits = policy.limits.with(step, limit);
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let budget = admission_budget(
        &meminfo,
        memory_profile,
        args.memory_capacity_mib,
        args.memory_headroom_mib,
    );
    tracing::info!(capacity_mib = budget >> 20, "guest memory capacity");
    policy.admission = Some(Admission {
        budget,
        buffer: args.memory_buffer_mib.map_or(budget / 16, |mib| mib << 20),
        // Work of its own is reported once per busy window, at the first
        // sample after the window ends: work seen within a window and two
        // samples keeps a sandbox from being pushed deeper to make room.
        busy_grace: args.busy_window + 2 * sample_every,
    });
    // Those its VMs may run on.
    let processors = compute_host::cpu_share::processors(&args.cgroup);
    let cpu = cpu_budget(
        processors,
        args.cpu_capacity_millis,
        args.cpu_headroom_millis,
    )?;
    policy.cpu_budget = Some(cpu);
    policy.memory = memory_policy(
        memory_profile,
        args.memory_low_mib,
        args.memory_high_mib,
        meminfo_field(&meminfo, "MemTotal:") << 10,
    )?;
    if let Some(memory) = policy.memory {
        tracing::info!(
            low_mib = memory.low_watermark >> 20,
            high_mib = memory.high_watermark >> 20,
            "memory pressure relief"
        );
    }
    policy.disk = Some(disk_policy(
        &args.root,
        args.disk_reserve_mib,
        args.disk_reserve_inodes,
    )?);
    Ok(policy)
}

/// One number from `/proc/meminfo`, such as `MemTotal:` (in KiB) or
/// `HugePages_Total:`; 0 when missing.
pub(super) fn meminfo_field(meminfo: &str, name: &str) -> u64 {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Bytes of guest memory the host promises its sandboxes at once:
/// `capacity_mib` if given, else the huge-page pool where guest memory
/// lives in it (nothing else on the host uses it), else the host's memory
/// less `headroom_mib` (default a sixteenth, at least 1 GiB).
pub(super) fn admission_budget(
    meminfo: &str,
    profile: MemoryProfile,
    capacity_mib: Option<u64>,
    headroom_mib: Option<u64>,
) -> u64 {
    if let Some(capacity) = capacity_mib {
        return capacity << 20;
    }
    if profile.pages == compute_engine::PageSize::Huge {
        let pages = meminfo_field(meminfo, "HugePages_Total:");
        return pages * (meminfo_field(meminfo, "Hugepagesize:") << 10);
    }
    let total = meminfo_field(meminfo, "MemTotal:") << 10;
    let headroom = headroom_mib.map_or((total / 16).max(1 << 30), |mib| mib << 20);
    total.saturating_sub(headroom)
}

/// Millicores a host of `processors` guarantees its sandboxes at once:
/// `capacity` when given, otherwise its processors less `headroom`, by
/// default a sixteenth of them, at least 500 millicores.
pub(super) fn cpu_budget(
    processors: usize,
    capacity: Option<u64>,
    headroom: Option<u64>,
) -> anyhow::Result<u64> {
    if let Some(capacity) = capacity {
        return Ok(capacity);
    }
    let total = u64::try_from(processors)
        .unwrap_or(u64::MAX)
        .saturating_mul(1000);
    let headroom = headroom.unwrap_or((total / 16).max(500));
    let budget = total.saturating_sub(headroom);
    anyhow::ensure!(
        budget > 0,
        "a processor headroom of {headroom} millicores leaves sandboxes none of this host's \
         {total}: lower --cpu-headroom-millis or give --cpu-capacity-millis"
    );
    Ok(budget)
}

/// The VMs' processor share, when the host guarantees processor time: of
/// `policy`'s budget, kept as given when the operator gave it.
pub(super) fn processor_share(args: &ServeArgs, policy: &HostPolicy) -> Option<ProcessorShare> {
    let share = ProcessorShare::new(args.cgroup.clone(), policy.cpu_budget?);
    Some(if args.cpu_capacity_millis.is_some() {
        share.stated()
    } else {
        share
    })
}

/// Gives the VMs' group the processor `share` that covers the host's
/// budget against the groups beside and above it (see
/// [`compute_host::cpu_share`]), and sets `policy`'s budget to what the
/// host guarantees with it; returns the share, which the agent keeps up
/// to date as those groups change.
pub(super) fn guarantee_vm_processors(
    share: Option<ProcessorShare>,
    policy: &mut HostPolicy,
) -> anyhow::Result<Option<ProcessorShare>> {
    let Some(share) = share else {
        return Ok(None);
    };
    let budget = share.budget();
    let applied = share.apply().with_context(|| {
        format!(
            "setting the processor share of {}",
            share.cgroup().display()
        )
    })?;
    if applied.capacity == budget && applied.whole(budget) {
        tracing::info!(
            capacity_millis = applied.capacity,
            weight = applied.weight,
            processors_millis = applied.processors,
            "guaranteed processor capacity"
        );
    } else if applied.capacity > applied.gets {
        tracing::warn!(
            capacity_millis = applied.capacity,
            gets_millis = applied.gets,
            weight = applied.weight,
            "the processor capacity given is more than the VMs get with every group beside \
             them busy: requests then hold only in proportion"
        );
    } else {
        tracing::warn!(
            capacity_millis = applied.capacity,
            budget_millis = budget,
            weight = applied.weight,
            "with every group beside and above them busy the VMs get less than the processor \
             budget; guaranteeing what they get"
        );
    }
    policy.cpu_budget = Some(applied.capacity);
    Ok(Some(share))
}

/// The least default low watermark on 4 KiB pages.
pub(super) const DEFAULT_LOW_WATERMARK_MIN: u64 = 512 << 20;

/// When the host relieves memory pressure (ADR 14): at the watermarks
/// given, which go together. Without them a host on 4 KiB pages still
/// relieves it, because its sandboxes may use more than their request and
/// nothing else keeps that use from running the host out of memory: from
/// a thirty-second of the host's `total` bytes available (at least
/// 512 MiB) until twice that is. With huge pages every awake sandbox is
/// booked whole, so there is relief only when asked for.
pub(super) fn memory_policy(
    profile: MemoryProfile,
    low_mib: Option<u64>,
    high_mib: Option<u64>,
    total: u64,
) -> anyhow::Result<Option<MemoryPolicy>> {
    let (low, high) = match (low_mib, high_mib) {
        (Some(low), Some(high)) => (low << 20, high << 20),
        (None, None) if profile.pages == compute_engine::PageSize::Base => {
            let low = (total / 32).max(DEFAULT_LOW_WATERMARK_MIN);
            (low, 2 * low)
        }
        (None, None) => return Ok(None),
        _ => bail!("--memory-low-mib and --memory-high-mib go together"),
    };
    if high < low {
        bail!("--memory-high-mib must be at least --memory-low-mib");
    }
    Ok(Some(MemoryPolicy {
        low_watermark: low,
        high_watermark: high,
        compressed_percent: 25,
        balloon_grace: Duration::from_secs(3),
    }))
}

/// The local disk kept back from saves on the filesystem holding `root`:
/// as given, or a twentieth of its bytes (at least 1 GiB) and inodes (at
/// least 1024).
pub(super) fn disk_policy(
    root: &Path,
    reserve_mib: Option<u64>,
    reserve_inodes: Option<u64>,
) -> anyhow::Result<DiskPolicy> {
    // Before anything is made there: a state root on a filesystem whose
    // saves cannot be booked is refused untouched.
    compute_host::check_filesystem(root)
        .with_context(|| format!("state root {}", root.display()))?;
    std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
    let stat = rustix::fs::statvfs(root)
        .with_context(|| format!("reading the filesystem of {}", root.display()))?;
    let size = stat.f_blocks.saturating_mul(stat.f_frsize);
    let policy = DiskPolicy {
        reserve: reserve_mib.map_or((size / 20).max(1 << 30), |mib| mib << 20),
        reserve_inodes: reserve_inodes.unwrap_or((stat.f_files / 20).max(1024)),
    };
    tracing::info!(
        reserve_mib = policy.reserve >> 20,
        reserve_inodes = policy.reserve_inodes,
        "disk kept back from saves"
    );
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    /// A host keeps a sixteenth of its processors back, at least half of
    /// one, unless told otherwise.
    #[test]
    fn processor_capacity_keeps_headroom_back() {
        assert_eq!(cpu_budget(16, None, None).unwrap(), 15_000);
        assert_eq!(cpu_budget(64, None, None).unwrap(), 60_000);
        assert_eq!(cpu_budget(2, None, None).unwrap(), 1500);
        assert_eq!(cpu_budget(8, None, Some(2000)).unwrap(), 6000);
        // Given outright, overcommitted or not.
        assert_eq!(cpu_budget(8, Some(32_000), None).unwrap(), 32_000);
        assert!(cpu_budget(1, None, Some(1000)).is_err());
    }

    /// A host on 4 KiB pages relieves memory pressure without being told
    /// to: its sandboxes may use more than they are guaranteed.
    #[test]
    fn four_kib_pages_relieve_pressure_by_default() {
        let policy = memory_policy(MemoryProfile::bare_metal(), None, None, 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(policy.low_watermark, GIB);
        assert_eq!(policy.high_watermark, 2 * GIB);
        // A small host keeps at least 512 MiB.
        let small = memory_policy(MemoryProfile::bare_metal(), None, None, 4 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(small.low_watermark, 512 << 20);
        assert_eq!(small.high_watermark, GIB);
    }

    /// Huge pages book every awake sandbox whole: relief only when asked.
    #[test]
    fn huge_pages_relieve_pressure_only_when_asked() {
        assert_eq!(
            memory_policy(MemoryProfile::nested(), None, None, 32 * GIB).unwrap(),
            None
        );
        let asked = memory_policy(MemoryProfile::nested(), Some(1024), Some(1536), 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(
            (asked.low_watermark, asked.high_watermark),
            (GIB, 1536 << 20)
        );
    }

    #[test]
    fn watermarks_go_together_in_order() {
        let profile = MemoryProfile::bare_metal();
        assert!(memory_policy(profile, Some(1024), None, 32 * GIB).is_err());
        assert!(memory_policy(profile, None, Some(1024), 32 * GIB).is_err());
        assert!(memory_policy(profile, Some(2048), Some(1024), 32 * GIB).is_err());
        let given = memory_policy(profile, Some(4096), Some(4096), 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(given.low_watermark, given.high_watermark);
    }

    /// The capacity a host offers: the huge-page pool, or its memory less
    /// a sixteenth (at least 1 GiB), unless given.
    #[test]
    fn capacity_follows_the_profile() {
        let meminfo =
            "MemTotal:       33554432 kB\nHugePages_Total:   13000\nHugepagesize:       2048 kB\n";
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::bare_metal(), None, None),
            30 * GIB
        );
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::nested(), None, None),
            13000 * (2 << 20)
        );
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::bare_metal(), Some(1024), None),
            GIB
        );
    }
}
