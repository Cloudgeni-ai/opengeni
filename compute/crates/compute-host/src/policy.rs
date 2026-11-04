//! What the host may do and promise, from its flags and its machine:
//! admission and processor budgets, memory relief and disk booking.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};
use compute_core::{Admission, DiskPolicy, HostPolicy, MemoryPolicy, Outgrowth};
use compute_engine::MemoryProfile;
use compute_engine::firecracker::Firecracker;
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
    let total = memory_share(&meminfo, args.memory_total_mib)?;
    let budget = admission_budget(
        &meminfo,
        memory_profile,
        total,
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
        total,
    )?;
    if let Some(memory) = policy.memory.as_mut()
        && compresses_running(memory_profile, !args.no_compress, &meminfo, total)
    {
        memory.outgrowth = Some(Outgrowth::default());
    }
    if let Some(memory) = policy.memory {
        tracing::info!(
            low_mib = memory.low_watermark >> 20,
            high_mib = memory.high_watermark >> 20,
            running_compressed = memory.outgrowth.is_some(),
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

/// Bytes of host memory the sandboxes may use at most: `total_mib` where
/// the host shares its memory beyond compute, else all of `MemTotal`.
pub(super) fn memory_share(meminfo: &str, total_mib: Option<u64>) -> anyhow::Result<u64> {
    let host = meminfo_field(meminfo, "MemTotal:") << 10;
    let Some(mib) = total_mib else {
        return Ok(host);
    };
    anyhow::ensure!(
        mib << 20 <= host,
        "--memory-total-mib {mib} is more than the host's {} MiB",
        host >> 20
    );
    tracing::info!(
        share_mib = mib,
        host_mib = host >> 20,
        "sandboxes use only their share of the host's memory"
    );
    Ok(mib << 20)
}

/// The sandboxes' share of host memory in MiB, if they have one:
/// `--memory-total-mib` where given, else `COMPUTE_MEMORY_TOTAL_MIB` (`env`)
/// where that is set and not empty, as a fleet host's `host.env` sets it
/// (required on a shared machine: ADR 26). Empty is unset, so a `host.env`
/// that leaves the line blank, as the example does, keeps all of the
/// host's memory.
pub(super) fn memory_total_mib(
    flag: Option<u64>,
    env: Option<&str>,
) -> anyhow::Result<Option<u64>> {
    if flag.is_some() {
        return Ok(flag);
    }
    let Some(text) = env.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let mib = text
        .parse::<u64>()
        .ok()
        .filter(|mib| *mib > 0)
        .with_context(|| {
            format!("COMPUTE_MEMORY_TOTAL_MIB={text} is not a number of MiB above 0")
        })?;
    Ok(Some(mib))
}

/// Bytes of guest memory the host promises its sandboxes at once:
/// `capacity_mib` if given, else the huge-page pool where guest memory
/// lives in it (nothing else on the host uses it), else the `total` bytes
/// of host memory the sandboxes may use less `headroom_mib` (default a
/// sixteenth, at least 1 GiB).
pub(super) fn admission_budget(
    meminfo: &str,
    profile: MemoryProfile,
    total: u64,
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
        outgrowth: None,
    }))
}

/// The least zswap pool, in percent of the host's memory, worth
/// compressing running VMs into: when the pool is full zswap takes no more
/// pages until it has drained, so compression stops dead.
const LEAST_ZSWAP_POOL_PERCENT: u64 = 20;

/// What caps compressing the sandboxes' running VMs, measured against
/// `share`, the host memory they may use (all of it, or a shared machine's
/// share, ADR 26): a swap device under a quarter of it, since each
/// compressed page takes a slot at its original size, and a zswap pool
/// (`pool_percent` of all `host` memory, as zswap counts it) under
/// [`LEAST_ZSWAP_POOL_PERCENT`] of it.
#[derive(Debug, PartialEq, Eq)]
struct CompressionCaps {
    swap: bool,
    pool: bool,
}

fn compression_caps(
    swap: u64,
    host: u64,
    share: u64,
    pool_percent: Option<u64>,
) -> CompressionCaps {
    CompressionCaps {
        swap: swap < share / 4,
        pool: pool_percent.is_some_and(|percent| {
            u128::from(percent) * u128::from(host)
                < u128::from(LEAST_ZSWAP_POOL_PERCENT) * u128::from(share)
        }),
    }
}

/// Whether running VMs may be compressed and held back (ADR 24): on 4 KiB
/// pages, with compression allowed (`compress`, which the readiness checks
/// already tied to zswap being on), and with swap for zswap's slots. A
/// compressed page takes a slot at its original size, though with
/// writeback off none reaches the device, so the swap device caps what can
/// be compressed; so does the pool, both against `share`, the memory the
/// sandboxes may use. Without, running VMs are never compressed and a host
/// short of memory reaches its wall sooner.
fn compresses_running(profile: MemoryProfile, compress: bool, meminfo: &str, share: u64) -> bool {
    if profile.pages != compute_engine::PageSize::Base || !profile.compress || !compress {
        return false;
    }
    let swap = meminfo_field(meminfo, "SwapTotal:") << 10;
    let host = meminfo_field(meminfo, "MemTotal:") << 10;
    if swap == 0 {
        tracing::warn!(
            "no swap device: running sandboxes are never compressed, so a host short of memory \
             ends programs in them sooner; add swap (it is never written: zswap writeback is off)"
        );
        return false;
    }
    let pool_percent = std::fs::read_to_string("/sys/module/zswap/parameters/max_pool_percent")
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    let caps = compression_caps(swap, host, share, pool_percent);
    if caps.swap {
        tracing::warn!(
            swap_mib = swap >> 20,
            share_mib = share >> 20,
            "the swap device is under a quarter of the sandboxes' memory: it caps what running \
             sandboxes can have compressed"
        );
    }
    if caps.pool {
        tracing::warn!(
            percent = pool_percent.unwrap_or(0),
            share_mib = share >> 20,
            "zswap's pool is small for the sandboxes' memory: compression stops once it is full"
        );
    }
    true
}

/// Lets `engine`'s VMs hold together what [`vms_memory_high`] allows of
/// the host memory they may use (all of it, or `total_mib`) under
/// `policy` before the kernel slows them, and never more than
/// [`vms_memory_max`], or lifts any earlier limit where none applies; lets
/// the kernel compress running VMs where `policy` holds them back (ADR
/// 24); and says which.
pub(super) fn limit_vm_memory(
    engine: Firecracker,
    profile: MemoryProfile,
    policy: &HostPolicy,
    total_mib: Option<u64>,
) -> anyhow::Result<Firecracker> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let total = memory_share(&meminfo, total_mib)?;
    let high = vms_memory_high(profile, policy.memory, total);
    let max = vms_memory_max(profile, policy.memory, total);
    let compress = policy
        .memory
        .is_some_and(|memory| memory.outgrowth.is_some());
    let engine = engine
        .with_memory_high(high)
        .context("limiting the memory the VMs hold together")?
        .with_memory_max(max)
        .context("walling the memory the VMs hold together")?
        .with_running_compression(compress)
        .context("compressing running VMs")?;
    log_memory_high(high, policy);
    if let Some(max) = max {
        tracing::info!(
            max_mib = max >> 20,
            "memory the VMs may never pass together: past it the kernel ends the VM furthest \
             above its request"
        );
    }
    Ok(engine)
}

/// What the VMs may hold together before the kernel slows them down (their
/// group's `memory.high`), on a host of `total` bytes that relieves
/// pressure with `memory` on 4 KiB pages: all of it but the high
/// watermark, the memory relief keeps available for the host.
///
/// Sandboxes in use may go above their request into whatever is free, and
/// running guests are never swapped, so without it the kernel takes what
/// they reach for from everything else instead: the agent's own memory and
/// code, and the guard's and the rest of the host's, leaving the agent too
/// slow to renew its lease or pause anyone (measured: eight guests growing
/// together took a 32 GiB host from 12 GiB available to none in 17 s; the
/// lease ran out and the guard ended every VM). With it, a guest reaching
/// past it waits on its own allocations, and the host keeps the rest. Not
/// the low watermark: the kernel's own memory, page tables and compressed
/// pages took most of a gigabyte beside the VMs on that host, and with
/// the VMs a low watermark short of all of it, under 350 MiB was available
/// and the lease still ran out. The agent counts what the limit leaves as
/// the most that is available, so before the limit available memory is
/// below the low watermark and relief is already pushing idle sandboxes
/// out and holding back those above their request. `None` (no limit)
/// without relief or on huge pages, where guests take their memory from
/// the pool, which their groups do not count, and every awake sandbox is
/// booked whole.
pub(super) fn vms_memory_high(
    profile: MemoryProfile,
    memory: Option<MemoryPolicy>,
    total: u64,
) -> Option<u64> {
    let memory = memory?;
    (profile.pages == compute_engine::PageSize::Base)
        .then(|| total.saturating_sub(memory.high_watermark))
}

/// The most the VMs may ever hold together (their group's `memory.max`):
/// all of the host's `total` bytes but the midpoint of the two
/// watermarks, past the [`vms_memory_high`] point where the kernel slows
/// them. Only VMs that keep growing however they are slowed and compressed
/// reach it, and then the kernel ends the one furthest above its request
/// (its VMM's out-of-memory score is lowered by its request), never the
/// agent or anything else on the host: the host's last defence (ADR 24).
/// Not a low watermark short of all of it: the kernel's own memory beside
/// the VMs left under 350 MiB there (see [`vms_memory_high`]). `None`
/// where there is no [`vms_memory_high`] either.
pub(super) fn vms_memory_max(
    profile: MemoryProfile,
    memory: Option<MemoryPolicy>,
    total: u64,
) -> Option<u64> {
    vms_memory_high(profile, memory, total)?;
    memory.map(|memory| {
        let margin = memory.low_watermark / 2 + memory.high_watermark / 2;
        total.saturating_sub(margin)
    })
}

/// Says what the VMs may hold together, and warns when the capacity
/// promised to their requests is more than that: requests within it could
/// then be slowed down at the limit.
fn log_memory_high(memory_high: Option<u64>, policy: &HostPolicy) {
    let Some(high) = memory_high else {
        return;
    };
    let capacity = policy.admission.map_or(0, |admission| admission.budget);
    if capacity > high {
        tracing::warn!(
            capacity_mib = capacity >> 20,
            high_mib = high >> 20,
            "the memory capacity is more than the VMs may hold together before the kernel \
             slows them down: sandboxes within their request may be slowed at that limit"
        );
    } else {
        tracing::info!(high_mib = high >> 20, "memory the VMs may hold together");
    }
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

    /// The swap device and zswap's pool are judged against the memory the
    /// sandboxes may use: a shared machine's share, not all of it.
    #[test]
    fn compression_caps_are_judged_against_the_share() {
        let host = 64 * GIB;
        // A dedicated host: 8 GiB of swap caps 64 GiB, a 20 % pool does not.
        assert_eq!(
            compression_caps(8 * GIB, host, host, Some(20)),
            CompressionCaps {
                swap: true,
                pool: false
            }
        );
        assert_eq!(
            compression_caps(16 * GIB, host, host, Some(11)),
            CompressionCaps {
                swap: false,
                pool: true
            }
        );
        // A shared one with 16 GiB for sandboxes: host-setup's 8 GiB of swap
        // and 11 % of the machine (7 GiB, 44 % of the share) are plenty.
        assert_eq!(
            compression_caps(8 * GIB, host, 16 * GIB, Some(11)),
            CompressionCaps {
                swap: false,
                pool: false
            }
        );
        assert_eq!(
            compression_caps(2 * GIB, host, 16 * GIB, Some(4)),
            CompressionCaps {
                swap: true,
                pool: true
            }
        );
        // An unreadable pool setting caps nothing it can tell.
        assert!(!compression_caps(16 * GIB, host, host, None).pool);
    }

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

    /// The VMs together leave the host its high watermark where they take
    /// their memory from the host and relief runs, which by default is
    /// what the capacity leaves too; nothing limits them on huge pages or
    /// without relief.
    #[test]
    fn the_vms_leave_the_host_its_high_watermark() {
        let base = MemoryProfile::bare_metal();
        let relief = memory_policy(base, None, None, 32 * GIB).unwrap();
        assert_eq!(vms_memory_high(base, relief, 32 * GIB), Some(30 * GIB));
        let meminfo = format!("MemTotal: {} kB\n", (32 * GIB) >> 10);
        assert_eq!(
            admission_budget(&meminfo, base, 32 * GIB, None, None),
            30 * GIB,
            "the default capacity is what the limit leaves"
        );
        let given = memory_policy(base, Some(2048), Some(4096), 32 * GIB).unwrap();
        assert_eq!(vms_memory_high(base, given, 32 * GIB), Some(28 * GIB));
        assert_eq!(vms_memory_high(base, None, 32 * GIB), None);
        let nested = MemoryProfile::nested();
        let asked = memory_policy(nested, Some(1024), Some(1536), 32 * GIB).unwrap();
        assert_eq!(vms_memory_high(nested, asked, 32 * GIB), None);
    }

    /// The capacity a host offers: the huge-page pool, or its memory less
    /// a sixteenth (at least 1 GiB), unless given.
    #[test]
    fn capacity_follows_the_profile() {
        let meminfo =
            "MemTotal:       33554432 kB\nHugePages_Total:   13000\nHugepagesize:       2048 kB\n";
        let total = memory_share(meminfo, None).unwrap();
        assert_eq!(total, 32 * GIB);
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::bare_metal(), total, None, None),
            30 * GIB
        );
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::nested(), total, None, None),
            13000 * (2 << 20)
        );
        assert_eq!(
            admission_budget(
                meminfo,
                MemoryProfile::bare_metal(),
                total,
                Some(1024),
                None
            ),
            GIB
        );
    }

    /// On a host shared beyond compute, the sandboxes' share is what the
    /// capacity, the watermarks and the VMs' limits come from, so they
    /// never reach what the host's other VMs were promised.
    #[test]
    fn a_shared_host_sizes_everything_from_its_share() {
        let meminfo = format!("MemTotal: {} kB\n", (128 * GIB) >> 10);
        let base = MemoryProfile::bare_metal();
        let share = memory_share(&meminfo, Some(32 * 1024)).unwrap();
        assert_eq!(share, 32 * GIB);
        assert!(memory_share(&meminfo, Some(129 * 1024)).is_err());
        assert_eq!(
            admission_budget(&meminfo, base, share, None, None),
            30 * GIB
        );
        let relief = memory_policy(base, None, None, share).unwrap();
        assert_eq!(relief.unwrap().low_watermark, GIB);
        assert_eq!(vms_memory_high(base, relief, share), Some(30 * GIB));
        // The wall: halfway between the watermarks, 1.5 GiB short.
        assert_eq!(
            vms_memory_max(base, relief, share),
            Some(30 * GIB + GIB / 2)
        );
    }

    /// The share comes from the flag, else from `host.env`'s line, which
    /// left blank means no share; a line that is no share is an error.
    #[test]
    fn the_share_is_the_flag_else_a_set_host_env_line() {
        assert_eq!(memory_total_mib(Some(16), Some("32768")).unwrap(), Some(16));
        assert_eq!(memory_total_mib(None, Some("32768")).unwrap(), Some(32_768));
        assert_eq!(
            memory_total_mib(None, Some(" 32768\n")).unwrap(),
            Some(32_768)
        );
        assert_eq!(memory_total_mib(None, Some("")).unwrap(), None);
        assert_eq!(memory_total_mib(None, Some("  ")).unwrap(), None);
        assert_eq!(memory_total_mib(None, None).unwrap(), None);
        for wrong in ["0", "abc", "-1", "32G"] {
            assert!(memory_total_mib(None, Some(wrong)).is_err(), "{wrong}");
        }
    }
}
