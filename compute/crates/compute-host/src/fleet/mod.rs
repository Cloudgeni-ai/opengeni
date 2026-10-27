//! A host in a fleet ([ADR 18](../../docs/adr/0018-the-control-service-leases-and-fences.md)):
//! it registers with the control service, renews its lease, and serves the
//! service's requests over mutual TLS, each bounded by the lease.
//!
//! - [`LeaseGate`] says whether the host may run its VMs now. While it is
//!   closed the agent makes no decision of its own, local tools are
//!   refused, and no archive starts.
//! - The renewer ([`lease`]) registers, carries out the service's rulings
//!   on what the host still holds, and renews, writing the lease file
//!   before anything goes out under it.
//! - The renewer and the listener start before the agent takes back what
//!   an earlier run left ([`FleetConfig::start`]), which can take longer
//!   than the lease's term, and go on while it stops
//!   ([`Joined::stopping`]), until the process exits: while the agent does
//!   not serve, the lease held is renewed without a capacity, no
//!   registration is sent, and every request is refused as `unavailable`.
//! - The guard ([`run_guard`]), a process of its own, freezes the VMs a
//!   second before the deadline in that file and kills them if they are
//!   not frozen by then, and holds the kernel watchdog, so the VMs stop
//!   whatever happens to the agent.
//! - The host tells its cloud of the boot of its machine it runs under,
//!   and names it to the service once the cloud took it ([`boot`]), so
//!   that a restart, which ends every VM, is seen as one.

mod boot;
mod gate;
mod guard;
mod kept;
mod lease;
mod leased;
mod link;
mod listen;
mod lossy;
mod record;
mod tls;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use anyhow::Context as _;
use compute_fleet::{HostLease, LeaseTerms};
use compute_protocol::fleet::{Answered, HostInfo};
use futures::FutureExt as _;
use futures::future::Fuse;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

pub use boot::{METADATA, Telling, boot_id};
pub use gate::Admission;
pub use gate::{LeaseGate, boot_now, slept};
pub use guard::{
    Freezes, GuardConfig, STEP as GUARD_STEP, Said, guard_ready, hold_lock, keep_resident,
    ready_lock, run_guard,
};
pub use lease::{terms_of, wire_terms};
pub use leased::Leased;
pub use link::MetricsRoute;
pub use lossy::Lossy;
pub use record::LeaseFile;
pub use tls::{Tls, TlsFiles};

use crate::agent::{Handle, HostError};

/// How long the agent waits for its guard to be ready before it gives up
/// joining. A guard just started, at boot or handed over by an upgrade, is
/// ready moments later, once systemd keeps its watchdog; the agent, started
/// with it, waits rather than exiting and being started again, which five
/// times within ten seconds would hit systemd's start limit and leave it
/// down until the host's lease ran out.
pub const GUARD_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Waits until a guard whose lock is `lock` is ready, up to `within`, and
/// says whether it is.
///
/// # Errors
///
/// When the guard's ready lock cannot be checked.
pub async fn guard_ready_within(
    lock: &std::path::Path,
    within: std::time::Duration,
) -> std::io::Result<bool> {
    let until = tokio::time::Instant::now() + within;
    let mut told = false;
    loop {
        if guard_ready(lock)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= until {
            return Ok(false);
        }
        if !std::mem::replace(&mut told, true) {
            tracing::info!(lock = %lock.display(), "waiting for the guard to be ready");
        }
        tokio::time::sleep(GUARD_STEP).await;
    }
}

/// What [`FleetConfig::prepare`] gives for `fleet`, for a host in one, once
/// a guard is ready: it waits for one up to [`GUARD_WAIT`].
///
/// # Errors
///
/// As [`FleetConfig::prepare`].
pub async fn prepare_guarded(fleet: Option<&FleetConfig>) -> anyhow::Result<Option<Prepared>> {
    let Some(fleet) = fleet else {
        return Ok(None);
    };
    guard_ready_within(&fleet.guard_lock, GUARD_WAIT)
        .await
        .with_context(|| format!("checking {}", fleet.guard_lock.display()))?;
    fleet.prepare().map(Some)
}

/// How a host joins a fleet.
#[derive(Clone, Debug)]
pub struct FleetConfig {
    /// The service's base URL, such as `https://control.example:8443`.
    pub control: String,
    /// What the host tells the service it is; the boot it names is the
    /// one its cloud took ([`Self::boot`]), whatever this says.
    pub info: HostInfo,
    /// The name the fleet gives the image this host's sandboxes start
    /// from, which its ready-clone reports carry.
    pub image: String,
    /// Where the host listens for the service.
    pub listen: SocketAddr,
    pub tls: TlsFiles,
    /// The lease file, in `/run`, which the guard reads.
    pub lease_file: PathBuf,
    /// The lock a running guard holds.
    pub guard_lock: PathBuf,
    /// The lease terms the guard and watchdog were set up for; the service
    /// must offer the same.
    pub terms: LeaseTerms,
    /// The only authority trusted for agent-link gateways; `None` trusts
    /// the system's.
    pub agent_link_ca: Option<PathBuf>,
    /// The boot of its machine the host tells its cloud of as it starts,
    /// before it first registers; `None` tells none, and names none.
    pub boot: Option<Telling>,
}

/// What the agent starts with in a fleet.
#[derive(Debug)]
pub struct Prepared {
    /// The gate for the agent's config and store.
    pub gate: LeaseGate,
    file: LeaseFile,
}

/// Where the agent stands, as the fleet sees it.
#[derive(Clone, Debug)]
enum Phase {
    /// Taking back what an earlier run left.
    Starting,
    Started(Handle),
    /// Stopping: the process exits next.
    Stopping,
}

/// The agent as the fleet sees it: its handle only while it serves.
#[derive(Clone, Debug)]
pub(crate) struct Agent(watch::Receiver<Phase>);

impl Agent {
    /// The agent's handle, while it serves.
    fn handle(&self) -> Option<Handle> {
        match &*self.0.borrow() {
            Phase::Started(handle) => Some(handle.clone()),
            Phase::Starting | Phase::Stopping => None,
        }
    }

    /// Why it does not serve now.
    fn not_serving(&self) -> &'static str {
        match &*self.0.borrow() {
            Phase::Stopping => {
                "this host's agent is stopping; the next one takes its sandboxes over"
            }
            Phase::Starting | Phase::Started(_) => {
                "this host's agent is starting: it is taking back the sandboxes an earlier run left"
            }
        }
    }
}

/// The fleet's part of a started agent: renewing the host's lease and
/// serving the service, until the agent's process exits.
pub struct Joined {
    /// Ends only with an error; pending for good once it has.
    running: Fuse<Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>>,
    phase: watch::Sender<Phase>,
}

impl std::fmt::Debug for Joined {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Joined")
            .field("phase", &*self.phase.borrow())
            .finish_non_exhaustive()
    }
}

impl Joined {
    /// Renews and serves; returns only the error that stopped that.
    pub async fn run(&mut self) -> anyhow::Result<()> {
        (&mut self.running).await
    }

    /// Goes on renewing the lease while the agent stops, until `stopping`
    /// ends, so the next agent finds as much of the lease's term left as
    /// the restart allows. Requests are refused as `unavailable`
    /// meanwhile: they would race the agent's stop.
    pub async fn stopping<T>(mut self, stopping: impl Future<Output = T>) -> T {
        self.phase.send_replace(Phase::Stopping);
        let mut stopping = std::pin::pin!(stopping);
        tokio::select! {
            output = &mut stopping => output,
            // It failed; the agent stops all the same.
            _ = &mut self.running => stopping.await,
        }
    }
}

/// Checks the service's URL is HTTPS: its lease answers and rulings must
/// come over mutual TLS.
fn control_url(control: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(control)
        .with_context(|| format!("the control service's URL {control:?}"))?;
    anyhow::ensure!(
        url.scheme() == "https" && url.host().is_some(),
        "the control service's URL must be https://host[:port], not {control:?}"
    );
    Ok(())
}

impl FleetConfig {
    /// Checks the host is fit to join (valid terms, a running guard) and
    /// reads the lease a previous run of the agent left. A lease file that
    /// cannot be read stops the agent: starting over could hand out
    /// sandboxes this host still runs.
    pub fn prepare(&self) -> anyhow::Result<Prepared> {
        self.terms
            .validate()
            .map_err(|error| anyhow::anyhow!("lease terms: {error}"))?;
        control_url(&self.control)?;
        anyhow::ensure!(
            guard_ready(&self.guard_lock)
                .with_context(|| format!("checking {}", self.guard_lock.display()))?,
            "no guard is ready at {}: start `compute-host guard`, and let it arm the \
             watchdog, before joining a fleet",
            self.guard_lock.display()
        );
        if let Some(dir) = self.lease_file.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let file = LeaseFile::read(&self.lease_file)
            .with_context(|| format!("reading {}", self.lease_file.display()))?;
        let held = Answered {
            host_epoch: file.epoch,
            seq: file.seq,
        };
        Ok(Prepared {
            gate: LeaseGate::holding(file.deadline(), held, self.terms.request_window),
            file,
        })
    }

    /// Joins the fleet, then starts the agent with `start`. The lease a
    /// previous run of the agent left is renewed meanwhile: taking back
    /// the sandboxes it ran can take longer than the lease's term, and
    /// once that ran out the guard would freeze their VMs, and the service
    /// give the host up, before this run answered anything. Returns what
    /// `start` did and the fleet's part, which goes on until the agent
    /// stops.
    pub async fn start<T>(
        self,
        prepared: Prepared,
        start: impl Future<Output = Result<(Handle, T), HostError>>,
    ) -> anyhow::Result<((Handle, T), Joined)> {
        let (phase, agent) = watch::channel(Phase::Starting);
        let running: Pin<Box<dyn Future<Output = _> + Send>> =
            Box::pin(self.run(prepared, Agent(agent)));
        let mut running = running.fuse();
        let started = tokio::select! {
            started = start => started?,
            result = &mut running => {
                return Err(result
                    .err()
                    .unwrap_or_else(|| anyhow::anyhow!("left the fleet"))
                    .context("in the fleet, while the agent started"));
            }
        };
        phase.send_replace(Phase::Started(started.0.clone()));
        Ok((started, Joined { running, phase }))
    }

    /// Registers, renews and serves the service until the agent stops,
    /// from before `agent` has started.
    async fn run(self, prepared: Prepared, agent: Agent) -> anyhow::Result<()> {
        let Prepared { gate, file } = prepared;
        let tls = Tls::load(&self.tls)?;
        let listener = TcpListener::bind(self.listen)
            .await
            .with_context(|| format!("listening on {}", self.listen))?;
        tracing::info!(listen = %self.listen, control = %self.control, "joining the fleet");
        // Whether the cloud took the machine's boot, once known: the host
        // names one only then, and registers only once it is known.
        let told = Arc::new(OnceLock::new());
        match self.boot.clone() {
            Some(telling) => {
                let told = Arc::clone(&told);
                tokio::spawn(async move {
                    let _ = told.set(boot::tell_cloud(&telling).await);
                });
            }
            None => {
                let _ = told.set(None);
            }
        }
        let listening = listen::Listening {
            acceptor: TlsAcceptor::from(Arc::clone(&tls.server)),
            service: tls::service_name(&self.control)?,
            agent: agent.clone(),
            gate: gate.clone(),
        };
        // Lease answers and rulings come only over mutual TLS, from the
        // address given: never in the clear, and never redirected.
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls.client)
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building the control service client")?;
        let mut attempts_from = [0; 8];
        getrandom::fill(&mut attempts_from).context("numbering registrations")?;
        let renewer = lease::Renewer {
            http,
            control: self.control.trim_end_matches('/').to_owned(),
            lease: HostLease::resume(self.terms, file.record(), u64::from_le_bytes(attempts_from)),
            host: file.host,
            file: self.lease_file,
            gate,
            agent,
            info: self.info,
            told,
            image: self.image,
        };
        tokio::select! {
            result = renewer.run() => result,
            result = listen::listen(listener, listening) => result.context("serving the control service"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The agent waits for a guard that gets ready a moment after it
    /// starts, and gives up on one that does not.
    #[tokio::test]
    async fn the_agent_waits_a_while_for_its_guard() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("guard.lock");
        let within = std::time::Duration::from_millis(400);
        let started = std::time::Instant::now();
        assert!(!guard_ready_within(&lock, within).await.unwrap());
        assert!(started.elapsed() >= within, "waited");

        let ready = ready_lock(&lock);
        let readying = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            hold_lock(&ready).unwrap()
        });
        assert!(
            guard_ready_within(&lock, std::time::Duration::from_secs(5))
                .await
                .unwrap(),
            "ready a moment later"
        );
        let _held = readying.join().unwrap();
    }

    #[test]
    fn the_service_is_reached_only_over_https() {
        assert!(control_url("https://control.example:8443").is_ok());
        assert!(control_url("https://10.0.0.2:8443/").is_ok());
        for bad in [
            "http://control.example:8443",
            "control.example:8443",
            "https://",
            "",
        ] {
            assert!(control_url(bad).is_err(), "{bad}");
        }
    }
}
