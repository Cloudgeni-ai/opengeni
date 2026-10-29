//! What the agent checks of its host, and sets on its own process, before
//! it serves.

use anyhow::{Context as _, bail};
use compute_engine::MemoryProfile;

use crate::policy::meminfo_field;

/// Everything here, in order: the host's checks, then the process's own
/// settings. `compress` is whether the agent compresses paused VMs.
pub(crate) fn ready(profile: MemoryProfile, compress: bool) -> anyhow::Result<()> {
    check_huge_pages(profile)?;
    check_zswap(compress)?;
    raise_open_file_limit();
    protect_from_oom()
}

/// Lets the agent hold as many open files as the system allows it. Every VM
/// keeps several open here (its process, pager, image files and store
/// connections), so the usual soft limit of 1024 runs out near a hundred
/// VMs.
fn raise_open_file_limit() {
    use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
    let limit = getrlimit(Resource::Nofile);
    if limit.current == limit.maximum {
        return;
    }
    let raised = Rlimit {
        current: limit.maximum,
        maximum: limit.maximum,
    };
    match setrlimit(Resource::Nofile, raised) {
        Ok(()) => tracing::info!(limit = ?limit.maximum, "open-file limit raised"),
        Err(error) => {
            tracing::warn!(%error, current = ?limit.current, "could not raise the open-file limit");
        }
    }
}

/// What the out-of-memory killer adds to the agent's badness, in
/// thousandths of the memory it weighs: the agent outlasts every VM
/// process (VMMs and pagers raise theirs to -900) and nearly anything
/// else on a short host. Not -1000: that makes a process unkillable even
/// inside its own service unit, so an agent that leaked up to the unit's
/// `MemoryMax` would hang in reclaim instead of being killed and restarted.
/// Its helpers inherit it.
const OOM_SCORE_ADJ: i32 = -999;

fn protect_from_oom() -> anyhow::Result<()> {
    std::fs::write("/proc/self/oom_score_adj", OOM_SCORE_ADJ.to_string())
        .context("lowering the agent's oom_score_adj (needs CAP_SYS_RESOURCE)")
}

/// Refuses a huge-page memory profile on a host without a reserved pool of
/// 2 MiB pages: every VM's memory would fail to allocate.
fn check_huge_pages(profile: MemoryProfile) -> anyhow::Result<()> {
    if profile.pages != compute_engine::PageSize::Huge {
        return Ok(());
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let field = |name: &str| meminfo_field(&meminfo, name);
    if field("Hugepagesize:") != 2048 {
        bail!("the {profile} memory profile needs 2 MiB default huge pages");
    }
    let total = field("HugePages_Total:");
    if total == 0 {
        bail!(
            "the {profile} memory profile needs reserved huge pages; set \
             /proc/sys/vm/nr_hugepages, or choose a profile with --memory-profile"
        );
    }
    tracing::info!(
        pool_mib = total * 2,
        free_mib = field("HugePages_Free:") * 2,
        "huge-page pool"
    );
    Ok(())
}

/// Compressing paused VMs needs zswap: without it the memory pushed out
/// would go to the swap device, and `memory.zswap.writeback` would mean
/// nothing.
fn check_zswap(compress: bool) -> anyhow::Result<()> {
    if compress
        && !compute_engine::cgroup::zswap_enabled().context("reading whether zswap is on")?
    {
        bail!("compressing paused VMs needs zswap; turn it on or pass --no-compress");
    }
    Ok(())
}
