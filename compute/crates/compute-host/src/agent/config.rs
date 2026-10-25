//! How a host agent is set up, and which setups it refuses.

use std::path::PathBuf;
use std::time::Duration;

use compute_core::HostPolicy;
#[cfg(doc)]
use compute_engine::Engine;

use super::DiskGauge;
use crate::fleet::{Freezes, LeaseGate};
use crate::guest_ports::GuestPort;
use crate::layout::check_root;
use crate::net::NetworkConfig;
use crate::observe::Observer;
use crate::pool::PoolConfig;
use crate::protocol::About;

/// How a host is set up.
#[derive(Clone, Debug)]
pub struct HostConfig {
    /// Directory holding every sandbox's state.
    pub root: PathBuf,
    /// Uncompressed guest kernel.
    pub kernel: PathBuf,
    /// Kernel command line.
    pub boot_args: String,
    /// Root disk image every new sandbox starts from.
    pub base_image: PathBuf,
    /// Concurrency limits, backoff and memory-pressure handling.
    pub policy: HostPolicy,
    /// How often to sample host and VM memory.
    pub sample_every: Duration,
    /// Readings of the local disk given to the agent instead of its own of
    /// the state root's filesystem, as tests give (see [`DiskGauge`]).
    /// `None` reads the filesystem every sample.
    pub disk_reading: Option<DiskGauge>,
    /// Ports every sandbox may connect to on this host, and where they lead.
    pub guest_ports: Vec<GuestPort>,
    /// Guest vsock port told about every restore from a memory image, so the
    /// guest can set its clock and reconnect (see [`crate::restore_notice`]).
    /// `None` tells the guest nothing. With a port, every guest must listen
    /// on it: one that takes no connection on it for long enough while its
    /// VM runs is found stopped (see [`GuestChecks`]).
    pub restore_notice_port: Option<u32>,
    /// How often running guests are checked for having stopped, on a host
    /// with a restore notice port.
    pub guest_checks: GuestChecks,
    /// The user id of the sandbox with ordinal 0. Every sandbox on a host
    /// has its own ordinal, and its VMM runs as user and group
    /// `first_uid + ordinal`, so no two VMMs share a user. Must not be 0,
    /// and the range must be reserved for VMMs.
    pub first_uid: u32,
    /// How sandboxes reach the network (see [`crate::net`]). `None` gives
    /// them none.
    pub network: Option<NetworkConfig>,
    /// When a running sandbox counts as busy with work of its own, which
    /// keeps it awake like any other activity. `None` ignores such work.
    pub busy: Option<BusyRule>,
    /// Whether this host can compress a paused VM's memory. Hosts that back
    /// guest memory with huge pages cannot, so they ignore every sandbox's
    /// `compress` setting.
    pub can_compress: bool,
    /// A lock file every agent on this host takes, whatever its state root:
    /// user ids, sandbox networks and firewall rules are the host's, so one
    /// agent at a time may hand them out. The file also names the state root
    /// they belong to: an agent of another root is refused while that root
    /// still has sandboxes, whose VMs may outlive their agent. Work an agent
    /// leaves in flight when it ends keeps the lock until it finishes. `None`
    /// only where no two agents can meet, as in tests with fake VMs.
    pub host_lock: Option<PathBuf>,
    /// Warm templates new sandboxes start from (see [`crate::pool`]).
    /// `None` boots every new sandbox cold.
    pub pool: Option<PoolConfig>,
    /// How VMs whose memory needs a fault handler get one.
    pub pager: PagerConfig,
    /// How long a stream into a sandbox (see [`crate::protocol::Request::Connect`])
    /// may stay silent both ways and still keep it awake. A forgotten
    /// browser tab or terminal then lets its sandbox sleep; the next byte
    /// either way wakes it again.
    pub stream_idle: Duration,
    /// What the host runs, as status reports it. The runtime is the
    /// engine's; whatever is set here is replaced.
    pub about: About,
    /// On a host in a fleet, the lease it holds (see [`crate::fleet`]):
    /// while it has run out the agent decides nothing of its own (no
    /// sleeping, no ready sandboxes, no template builds) and serves its
    /// own tools only their status, since the guard keeps the VMs frozen
    /// and the control service may be handing its sandboxes to others.
    /// `None` on a host on its own.
    pub lease: Option<LeaseGate>,
    /// On a host in a fleet, the guard's count of its freezes, which a
    /// check of a guest needs to count a miss (see the agent's `check`
    /// module). `None` on a host on its own, which has no guard; a host
    /// with a lease and none counts no misses.
    pub guard_freezes: Option<Freezes>,
    /// Where the host's events and metrics go (see [`crate::observe`]).
    pub observer: Observer,
    /// How long a sandbox stays awake before it reports what it went
    /// through since its last step or summary.
    pub summary_every: Duration,
    /// The host's agent links, for sandboxes that run Opengeni's agent
    /// (see [`link`](super::link)). `None` refuses their guests' connections.
    pub agent_link: Option<compute_link::Hub>,
    /// The processor share of the VMs' group, which the agent reads again
    /// every few seconds, setting the group's weight and the processor
    /// time the host guarantees anew as the groups beside it change (see
    /// [`crate::cpu_share`]). `None` leaves both as they are, as in tests
    /// with fake VMs.
    pub processor_share: Option<crate::cpu_share::ProcessorShare>,
    /// How the host builds the sandbox images the control service asks for
    /// (see [`crate::rootfs::PrepareConfig`]); `None` refuses to.
    pub prepare: Option<crate::rootfs::PrepareConfig>,
}

impl HostConfig {
    /// The default for [`HostConfig::stream_idle`].
    pub const STREAM_IDLE: Duration = Duration::from_secs(10 * 60);
    /// The default for [`HostConfig::summary_every`].
    pub const SUMMARY_EVERY: Duration = Duration::from_secs(3600);
}

/// How VMs whose memory needs a fault handler get one: a pager process of
/// their own, which the engine starts with the VM (see `compute-pager`).
#[derive(Clone, Debug)]
pub struct PagerConfig {
    /// The program each pager runs as, with `pager` as its first argument:
    /// normally the agent's own binary.
    pub program: PathBuf,
    /// How long after a wake a pager records the order the guest touches
    /// memory in, for the next wake to prefetch. A pager exits no sooner,
    /// even once every page is in place. The window is wall-clock time, and
    /// a first wake on a busy host may take tens of seconds to reach the
    /// working set the next wake should prefetch, so the default is
    /// generous; the profile's order keeps the earliest pages first.
    pub record_for: Duration,
}

impl PagerConfig {
    /// The default recording window.
    pub const RECORD_FOR: Duration = Duration::from_secs(120);

    /// Pagers run as `program`, recording for [`Self::RECORD_FOR`].
    #[must_use]
    pub fn new(program: PathBuf) -> Self {
        Self {
            program,
            record_for: Self::RECORD_FOR,
        }
    }
}

/// How often the host checks that the guest of each running sandbox still
/// takes connections on its notice port, and how many checks in a row it
/// may miss before it counts as stopped (see the agent's `check` module):
/// powered off or halted, which Firecracker on x86 does not end the VM
/// for, or hung. Its VM is then ended as a crashed one is, and its next
/// wake boots from its disk.
///
/// A live guest's kernel takes such a connection by itself, however busy
/// the guest is, so the defaults leave a live guest that answers slowly
/// for a while (one of a burst of restores on a busy host takes seconds)
/// a wide margin: a stopped guest is found within three minutes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuestChecks {
    /// Between two checks of one guest.
    pub every: Duration,
    /// Checks in a row a guest may miss before it counts as stopped; at
    /// least one.
    pub misses: u32,
}

impl GuestChecks {
    /// A check every 30 seconds; stopped after five missed in a row, two
    /// minutes from the first to the last.
    pub const DEFAULT: Self = Self {
        every: Duration::from_secs(30),
        misses: 5,
    };
}

/// When a running sandbox counts as busy: over `window`, its VM used at
/// least `cpu_percent` of one processor on average, or moved at least
/// `io_bytes_per_second` on average through its network and disk (see
/// [`Engine::io_bytes`]).
///
/// Vsock traffic is not reliably measured here: some of it reaches the
/// traffic counters and can count toward the rule, but no keep-awake
/// guarantee rests on it. Streams the host opens into the guest hold the
/// sandbox awake while they are open. Connections the
/// guest opens to its host (see [`crate::guest_ports`]) deliberately do
/// not: a control link carries keepalives for as long as the guest lives,
/// so its traffic alone must not keep a sandbox awake. Data arriving on one
/// can wake the sandbox, and the guest's own work for it shows as
/// processor use.
///
/// This is how the host sees work nobody told it about, such as a build or
/// test run an agent left in the background, or a download that mostly
/// waits on the network. A quiet guest uses well under one percent of a
/// processor and moves no data at all; short periodic jobs average out over
/// the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BusyRule {
    /// Percent of one processor; 0 ignores processor use.
    pub cpu_percent: u32,
    /// Bytes per second; 0 ignores traffic.
    pub io_bytes_per_second: u64,
    /// Averaging window. Readings come every [`HostConfig::sample_every`],
    /// so the effective window is at least that long.
    pub window: Duration,
}

impl BusyRule {
    /// A quarter of one processor, or 4 KiB a second of traffic, over five
    /// seconds. An idle guest moves nothing; a guest still writing back a
    /// finished command's files, or fetching something slowly, moves more.
    pub const DEFAULT: Self = Self {
        cpu_percent: 25,
        io_bytes_per_second: 4 << 10,
        window: Duration::from_secs(5),
    };

    /// Whether using `used` processor time and moving `moved` bytes over
    /// `elapsed` counts as busy.
    #[must_use]
    pub fn is_busy(&self, used: Duration, moved: u64, elapsed: Duration) -> bool {
        let elapsed_us = elapsed.as_micros();
        if elapsed_us == 0 {
            return false;
        }
        // Saturating: a product too large to hold is a bar nothing reaches.
        let cpu = self.cpu_percent > 0
            && used.as_micros().saturating_mul(100)
                >= elapsed_us.saturating_mul(u128::from(self.cpu_percent));
        let io = self.io_bytes_per_second > 0
            && u128::from(moved).saturating_mul(1_000_000)
                >= elapsed_us.saturating_mul(u128::from(self.io_bytes_per_second));
        cpu || io
    }

    /// Whether the rule reads processor use at all.
    #[must_use]
    pub fn watches_cpu(&self) -> bool {
        self.cpu_percent > 0
    }

    /// Whether the rule reads traffic at all.
    #[must_use]
    pub fn watches_io(&self) -> bool {
        self.io_bytes_per_second > 0
    }
}

/// Why `config` cannot run an agent, if it cannot.
pub(super) fn check_config(config: &HostConfig) -> Result<(), String> {
    check_root(&config.root)?;
    // Only reads: a state root on a filesystem the agent cannot book saves
    // on is refused before it takes a lock, makes a directory or writes
    // anything.
    crate::layout::check_filesystem(&config.root)
        .map_err(|error| format!("state root {}: {error}", config.root.display()))?;
    if config.first_uid == 0 {
        return Err("first_uid must not be 0: VMMs run as unprivileged users".into());
    }
    if config.guest_checks.misses == 0 || config.guest_checks.every.is_zero() {
        return Err("guest checks need a period and at least one miss".into());
    }
    if let Some(network) = &config.network {
        network.check()?;
    }
    if config.pool.is_some() && config.restore_notice_port.is_none() {
        // A sandbox started from a template learns which it is only from
        // the restore notice; see `Identity::Pending`.
        return Err("warm templates need a restore notice port".into());
    }
    let link_port = compute_protocol::link::AGENT_LINK_PORT;
    if config.agent_link.is_some()
        && (config.restore_notice_port == Some(link_port)
            || config.guest_ports.iter().any(|port| port.port == link_port))
    {
        return Err(format!("guest port {link_port} is the agent link's"));
    }
    Ok(())
}
