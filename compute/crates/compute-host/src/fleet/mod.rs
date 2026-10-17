//! A host in a fleet ([ADR 18](../../docs/adr/0018-the-fleet-service-leases-and-fences.md)):
//! it registers with the fleet service, renews its lease, and serves the
//! service's requests over mutual TLS, each bounded by the lease.
//!
//! - [`LeaseGate`] says whether the host may run its VMs now. While it is
//!   closed the agent makes no decision of its own, local tools are
//!   refused, and no archive starts.
//! - The renewer ([`lease`]) registers, carries out the service's rulings
//!   on what the host still holds, and renews, writing the lease file
//!   before anything goes out under it.
//! - The guard ([`run_guard`]), a process of its own, freezes the VMs a
//!   second before the deadline in that file and kills them if they are
//!   not frozen by then, and holds the kernel watchdog, so the VMs stop
//!   whatever happens to the agent.

mod gate;
mod guard;
mod lease;
mod leased;
mod listen;
mod record;
mod tls;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use compute_fleet::{HostLease, LeaseTerms};
use compute_protocol::fleet::HostInfo;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub use gate::{LeaseGate, boot_now};
pub use guard::{GuardConfig, STEP as GUARD_STEP, guard_runs, hold_lock, run_guard};
pub use lease::{terms_of, wire_terms};
pub use leased::Leased;
pub use record::LeaseFile;
pub use tls::{Tls, TlsFiles};

use crate::agent::Handle;

/// How a host joins a fleet.
#[derive(Clone, Debug)]
pub struct FleetConfig {
    /// The service's base URL, such as `https://control.example:8443`.
    pub control: String,
    /// What the host tells the service it is.
    pub info: HostInfo,
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
}

/// What the agent starts with in a fleet.
#[derive(Debug)]
pub struct Prepared {
    /// The gate for the agent's config and store.
    pub gate: LeaseGate,
    file: LeaseFile,
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
        anyhow::ensure!(
            guard_runs(&self.guard_lock)
                .with_context(|| format!("checking {}", self.guard_lock.display()))?,
            "no guard holds {}: start `compute-host guard` before joining a fleet",
            self.guard_lock.display()
        );
        if let Some(dir) = self.lease_file.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let file = LeaseFile::read(&self.lease_file)
            .with_context(|| format!("reading {}", self.lease_file.display()))?;
        Ok(Prepared {
            gate: LeaseGate::new(file.deadline()),
            file,
        })
    }

    /// Registers, renews and serves the service until the agent stops.
    pub async fn run(self, prepared: Prepared, handle: Handle) -> anyhow::Result<()> {
        let Prepared { gate, file } = prepared;
        let tls = Tls::load(&self.tls)?;
        let current = Arc::new(lease::Current::new(file, self.terms.request_window));
        let listener = TcpListener::bind(self.listen)
            .await
            .with_context(|| format!("listening on {}", self.listen))?;
        tracing::info!(listen = %self.listen, control = %self.control, "joining the fleet");
        let listening = listen::Listening {
            acceptor: TlsAcceptor::from(Arc::clone(&tls.server)),
            handle: handle.clone(),
            gate: gate.clone(),
            current: Arc::clone(&current),
        };
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls.client)
            .build()
            .context("building the fleet service client")?;
        let mut attempts_from = [0; 8];
        getrandom::fill(&mut attempts_from).context("numbering registrations")?;
        let renewer = lease::Renewer {
            http,
            control: self.control.trim_end_matches('/').to_owned(),
            lease: HostLease::resume(self.terms, file.record(), u64::from_le_bytes(attempts_from)),
            host: file.host,
            file: self.lease_file,
            gate,
            current,
            handle,
            info: self.info,
        };
        tokio::select! {
            result = renewer.run() => result,
            result = listen::listen(listener, listening) => result.context("serving the fleet service"),
        }
    }
}
