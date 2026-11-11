//! The command line of a host in a fleet: `serve`'s fleet options, and the
//! `guard`, `guard-stopped` and `hand-over-guard` commands.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use clap::Args;
use compute_fleet::LeaseTerms;
use compute_host::fleet::{
    Fence, FleetConfig, GuardConfig, StopHook, TlsFiles, hand_over_guard, hand_over_mark,
};
use compute_protocol::fleet::HostInfo;

/// Joining a fleet ([ADR 18](../../docs/adr/0018-the-control-service-leases-and-fences.md)).
#[derive(Args, Debug)]
pub struct FleetArgs {
    /// Join a fleet: the control service's URL, such as
    /// `https://control.example:8443`. Needs a store in object storage and
    /// a running `compute-host guard`; the host then creates, adopts and
    /// hands off sandboxes only as the service asks.
    #[arg(
        long = "fleet-control",
        id = "fleet_control",
        requires_all = ["fleet_name", "fleet_address", "fleet_cert", "fleet_key", "fleet_ca"]
    )]
    pub control: Option<String>,
    /// This host's name in the fleet, unique, such as its instance name.
    #[arg(long = "fleet-name", id = "fleet_name")]
    pub name: Option<String>,
    /// Where the service reaches this host, as `host:port`.
    #[arg(long = "fleet-address", id = "fleet_address")]
    pub address: Option<String>,
    /// Where the host listens for the service.
    #[arg(
        long = "fleet-listen",
        id = "fleet_listen",
        default_value = "0.0.0.0:7443"
    )]
    pub listen: SocketAddr,
    /// The host's failure zone.
    #[arg(long = "fleet-zone", id = "fleet_zone", default_value = "default")]
    pub zone: String,
    /// The name the fleet gives the image `--base-image` holds, which the
    /// host's ready clones are reported under.
    #[arg(long = "fleet-image", id = "fleet_image", default_value = "base")]
    pub image: String,
    /// The host's certificate chain, PEM, from the hosts' authority, which
    /// the control service holds (`compute-host-certificate` gets and renews
    /// it).
    #[arg(long = "fleet-cert", id = "fleet_cert")]
    pub cert: Option<PathBuf>,
    /// The host's private key, PEM.
    #[arg(long = "fleet-key", id = "fleet_key")]
    pub key: Option<PathBuf>,
    /// The hosts' authority, PEM, which issues the control service's
    /// certificate too; the service is the holder of a certificate for the
    /// host of `--fleet-control`.
    #[arg(long = "fleet-ca", id = "fleet_ca")]
    pub ca: Option<PathBuf>,
    /// The only authority to trust for Opengeni's agent-link gateways, PEM,
    /// instead of the system's. For gateways with certificates of a
    /// private authority, as in tests.
    #[arg(long = "agent-link-ca", id = "agent_link_ca")]
    pub agent_link_ca: Option<PathBuf>,
    /// The lease file the guard reads.
    #[arg(
        long = "fleet-lease-file",
        id = "fleet_lease_file",
        default_value = "/run/compute-host/lease.json"
    )]
    pub lease_file: PathBuf,
    /// The lock a running guard holds.
    #[arg(
        long = "fleet-guard-lock",
        id = "fleet_guard_lock",
        default_value = "/run/compute-host/guard.lock"
    )]
    pub guard_lock: PathBuf,
}

/// What the host is, as it registers.
pub struct Described<'a> {
    pub root: &'a Path,
    pub memory_profile: String,
    pub cpu_template: String,
    pub memory_bytes: u64,
    pub cpu_millis: u64,
    /// The names of what it offers sandboxes to reach (`--offer`), in
    /// order.
    pub offers: Vec<String>,
    /// The digest of the guest programs it builds images with, if it
    /// builds any.
    pub guest: Option<String>,
}

impl FleetArgs {
    /// The fleet this host joins, if any.
    pub fn config(&self, host: &Described<'_>) -> anyhow::Result<Option<FleetConfig>> {
        let Some(control) = self.control.clone() else {
            return Ok(None);
        };
        let required = |value: &Option<PathBuf>, flag: &str| {
            value
                .clone()
                .with_context(|| format!("--fleet-control needs {flag}"))
        };
        let stat = rustix::fs::statvfs(host.root)
            .with_context(|| format!("reading the filesystem of {}", host.root.display()))?;
        Ok(Some(FleetConfig {
            control,
            info: HostInfo {
                name: self
                    .name
                    .clone()
                    .context("--fleet-control needs --fleet-name")?,
                address: self
                    .address
                    .clone()
                    .context("--fleet-control needs --fleet-address")?,
                zone: self.zone.clone(),
                profile: host.memory_profile.clone(),
                cpu_template: host.cpu_template.clone(),
                memory_mib: host.memory_bytes >> 20,
                cpu_millis: host.cpu_millis,
                disk_mib: stat.f_blocks.saturating_mul(stat.f_frsize) >> 20,
                offers: host.offers.clone(),
                boot: None,
            },
            image: self.image.clone(),
            guest: host.guest.clone(),
            listen: self.listen,
            tls: TlsFiles {
                cert: required(&self.cert, "--fleet-cert")?,
                key: required(&self.key, "--fleet-key")?,
                peer_ca: required(&self.ca, "--fleet-ca")?,
            },
            lease_file: self.lease_file.clone(),
            guard_lock: self.guard_lock.clone(),
            terms: LeaseTerms::RECOMMENDED,
            agent_link_ca: self.agent_link_ca.clone(),
            boot: compute_host::fleet::boot_id().map(|id| compute_host::fleet::Telling {
                id,
                metadata: compute_host::fleet::METADATA.to_owned(),
            }),
        }))
    }
}

/// `compute-host guard`.
#[derive(Args, Debug)]
pub struct GuardArgs {
    /// The cgroup that holds every VM.
    #[arg(long, default_value = "/sys/fs/cgroup/compute")]
    cgroup: PathBuf,
    /// The lease file the agent writes.
    #[arg(long, default_value = "/run/compute-host/lease.json")]
    lease_file: PathBuf,
    /// The lock the guard holds while it runs.
    #[arg(long, default_value = "/run/compute-host/guard.lock")]
    lock: PathBuf,
    /// The mark the host's sleep hook leaves while a suspend is under way.
    #[arg(long, default_value = "/run/compute-host/suspending")]
    suspending: PathBuf,
    /// The watchdog device, set up with the lease terms' timeout and
    /// `nowayout`; `service` feeds systemd's watchdog of the guard's own
    /// service instead, on a machine the host shares (its stop hook,
    /// `guard-stopped`, then kills the VMs; ADR 26); `none` runs without
    /// one, for tests only.
    #[arg(long, default_value = "/dev/watchdog0")]
    watchdog: PathBuf,
}

impl GuardArgs {
    /// The guard's settings.
    pub fn config(self) -> GuardConfig {
        let timeout = LeaseTerms::RECOMMENDED.watchdog;
        let fence = if self.watchdog == Path::new("none") {
            Fence::None
        } else if self.watchdog == Path::new("service") {
            Fence::Service { timeout }
        } else {
            Fence::Machine {
                device: self.watchdog,
                timeout,
            }
        };
        GuardConfig {
            cgroup: self.cgroup,
            lease_file: self.lease_file,
            lock: self.lock,
            suspending: self.suspending,
            fence,
        }
    }
}

/// `compute-host guard-stopped`.
#[derive(Args, Debug)]
pub struct GuardStoppedArgs {
    /// The cgroup that holds every VM.
    #[arg(long, default_value = "/sys/fs/cgroup/compute")]
    cgroup: PathBuf,
    /// The guard's lock, beside which an upgrade marks a hand-over.
    #[arg(long, default_value = "/run/compute-host/guard.lock")]
    lock: PathBuf,
    /// The agent's service, restarted if it runs.
    #[arg(long, default_value = "compute-host.service")]
    agent: String,
}

impl GuardStoppedArgs {
    /// The hook's settings.
    pub fn hook(self) -> StopHook {
        StopHook {
            cgroup: self.cgroup,
            mark: hand_over_mark(&self.lock),
            agent: self.agent,
        }
    }
}

/// `compute-host hand-over-guard`.
#[derive(Args, Debug)]
pub struct HandOverArgs {
    /// The guard's lock, beside which the hand-over is marked.
    #[arg(long, default_value = "/run/compute-host/guard.lock")]
    lock: PathBuf,
    /// The guard's service, restarted.
    #[arg(long, default_value = "compute-guard.service")]
    unit: String,
}

impl HandOverArgs {
    /// Marks the hand-over and restarts the guard's service, waiting for
    /// systemd to have done so.
    ///
    /// # Errors
    ///
    /// When the mark cannot be written or systemd fails the restart.
    pub fn hand_over(self) -> anyhow::Result<()> {
        hand_over_guard(&self.lock, &self.unit)
    }
}
