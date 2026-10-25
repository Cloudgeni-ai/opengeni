//! The Opengeni compute control service
//! ([ADR 18](../../docs/adr/0018-the-control-service-leases-and-fences.md)).
//!
//! Hosts register with it and renew their leases ([`hostapi`]); it keeps
//! which host owns each sandbox in a store ([`store`]); callers create,
//! wake, connect to, move and delete sandboxes through its public API
//! ([`api`]), which it carries out by the fleet's rules ([`service`]),
//! calling hosts over mutual TLS ([`hosts`]). Each replica follows the
//! hosts' rows into a view placement reads ([`view`]), and one replica at
//! a time leads: it gives up on hosts whose renewals stopped and grows the
//! host group ([`leader`], [`group`]). Replicas keep no state of their
//! own, so any of them serves any request.
//!
//! A replica may also serve E2B's API and sandbox traffic on a listener of
//! its own ([`e2b`]), so clients built for E2B use the fleet unchanged.
//!
//! Sandboxes that run Opengeni's agent are reached through their hosts'
//! links to Opengeni, whose tokens the service signs ([`link`]).
//!
//! The service is the hosts' certificate authority ([`authority`]): it
//! issues its own host-endpoint certificate and each host's, for the
//! instance an identity token proves ([`identity`]) or the name a current
//! certificate holds.
//!
//! Each replica may serve its metrics for Prometheus on a listener of its
//! own, and pass hosts' metrics on to a metrics store ([`metrics`]).

pub mod api;
pub mod authority;
pub mod e2b;
pub mod group;
pub mod hostapi;
pub mod hosts;
pub mod identity;
pub mod images;
pub mod init;
pub mod keys;
pub mod leader;
pub mod link;
pub mod metrics;
pub mod service;
pub mod store;
pub mod tls;
pub mod view;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use compute_storage::store::ChunkStore;
use rustls::ServerConfig;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::hosts::Hosts;
use crate::leader::Scaling;
use crate::metrics::Metrics;
use crate::service::{Service, Settings};
use crate::store::Store;
use crate::tls::Tls;
use crate::view::View;

/// How long a create's request id keeps answering that its sandbox is
/// gone, counted from the deletion.
pub const REQUESTS_KEPT: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How long a host given up on stays listed (`GET /v1/hosts`, state
/// `lost`) before the service forgets it, counted from the give-up.
pub const LOST_HOSTS_KEPT: Duration = Duration::from_secs(24 * 60 * 60);

/// How a replica runs.
#[derive(Debug)]
pub struct Config {
    /// Where the public API listens.
    pub api: SocketAddr,
    /// The certificate the public API serves HTTPS with; `None` serves
    /// HTTP, for a TLS terminator in front.
    pub api_tls: Option<Arc<ServerConfig>>,
    /// Where hosts reach the service.
    pub hosts: SocketAddr,
    pub tls: Tls,
    /// What checks the instance identity tokens hosts on Google Cloud prove
    /// themselves with; `None` takes none.
    pub identity: Option<identity::GceIdentity>,
    /// The object store hosts archive to, if they do.
    pub archive: Option<ChunkStore>,
    pub settings: Settings,
    /// The team whose keys manage hosts.
    pub operator: String,
    /// The host group the leader sizes, if any.
    pub scaling: Option<Scaling>,
    /// Seeds placement's random choices.
    pub seed: u64,
    /// Where the E2B front door listens, and how it runs; `None` for no
    /// front door.
    pub e2b: Option<e2b::listen::Listen>,
    /// Where Prometheus scrapes the replica's metrics; `None` for nowhere.
    pub metrics: Option<SocketAddr>,
    /// The OTLP/HTTP metrics endpoint hosts' metrics are passed on to;
    /// `None` takes none.
    pub host_metrics: Option<String>,
    /// The OCI image, pinned by digest, each of these image names starts
    /// from in this release, built into a stored image when none was
    /// ([`images`]).
    pub image_sources: BTreeMap<String, String>,
}

/// A running replica; dropping it stops it.
#[derive(Debug)]
pub struct Running<S> {
    /// Where its public API listens.
    pub api: SocketAddr,
    /// Where hosts reach it.
    pub hosts: SocketAddr,
    /// Where its E2B front door listens, if it has one.
    pub e2b: Option<SocketAddr>,
    /// Where its metrics are served, if they are.
    pub metrics: Option<SocketAddr>,
    pub service: Arc<Service<S>>,
    tasks: Vec<JoinHandle<()>>,
}

impl<S> Drop for Running<S> {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Starts a replica over `store`.
pub async fn start<S: Store>(store: Arc<S>, config: Config) -> anyhow::Result<Running<S>> {
    let terms = config.settings.terms;
    terms
        .validate()
        .map_err(|error| anyhow::anyhow!("lease terms: {error}"))?;
    let view = Arc::new(View::new(config.seed));
    let service = Arc::new(Service::new(
        Arc::clone(&store),
        Arc::clone(&view),
        Hosts::new(config.tls.client.clone()),
        config.archive,
        config.settings,
    ));
    let host_listener = TcpListener::bind(config.hosts)
        .await
        .with_context(|| format!("listening for hosts on {}", config.hosts))?;
    let api_listener = TcpListener::bind(config.api)
        .await
        .with_context(|| format!("listening for callers on {}", config.api))?;
    let hosts = host_listener.local_addr()?;
    let api = api_listener.local_addr()?;
    let metrics = Arc::new(Metrics::default());
    let host_metrics = config
        .host_metrics
        .as_deref()
        .map(|url| hostapi::HostMetrics::new(url, Arc::clone(&metrics)).map(Arc::new))
        .transpose()?;
    let acceptor = TlsAcceptor::from(Arc::clone(&config.tls.server));
    let certificates = Arc::new(hostapi::Certificates {
        authority: Arc::clone(&config.tls.authority),
        identity: config.identity,
        reserved: config.tls.own.names().to_vec(),
    });
    let host_router = hostapi::router(
        Arc::clone(&store),
        terms,
        service.settings().links.clone(),
        certificates,
        host_metrics,
    );
    let api_router = api::router(Arc::clone(&service), config.operator, Arc::clone(&metrics));
    let mut tasks = vec![
        tokio::spawn(view::follow(Arc::clone(&view), Arc::clone(&store))),
        tokio::spawn(leader::lead(
            Arc::clone(&store),
            Arc::clone(&view),
            terms,
            config.scaling,
            Arc::clone(&metrics),
        )),
        tokio::spawn(hostapi::serve(host_listener, acceptor, host_router)),
        tokio::spawn(Arc::clone(&config.tls.own).keep_fresh()),
        tokio::spawn(tls::serve(
            api_listener,
            api_router,
            config.api_tls,
            "the public API",
        )),
        tokio::spawn(prune(Arc::clone(&service))),
        tokio::spawn(images::follow(Arc::clone(&service), config.image_sources)),
    ];
    let metrics = match config.metrics {
        Some(address) => {
            let listener = TcpListener::bind(address)
                .await
                .with_context(|| format!("listening for Prometheus on {address}"))?;
            let bound = listener.local_addr()?;
            let router = metrics::router(metrics, Arc::clone(&view));
            tasks.push(tokio::spawn(metrics::serve(listener, router)));
            Some(bound)
        }
        None => None,
    };
    let e2b = match config.e2b {
        Some(e2b::listen::Listen {
            address,
            tls,
            settings,
        }) => {
            let listener = TcpListener::bind(address)
                .await
                .with_context(|| format!("listening for E2B callers on {address}"))?;
            let bound = listener.local_addr()?;
            let front = e2b::Front::new(Arc::clone(&service), settings);
            let router = e2b::router(Arc::clone(&front));
            tasks.push(tokio::spawn(e2b::ops::sweep(front)));
            tasks.push(tokio::spawn(e2b::listen::serve(listener, router, tls)));
            Some(bound)
        }
        None => None,
    };
    Ok(Running {
        api,
        hosts,
        e2b,
        metrics,
        service,
        tasks,
    })
}

/// Forgets, once an hour, the requests whose sandboxes were deleted more
/// than [`REQUESTS_KEPT`] ago, and the hosts given up on more than
/// [`LOST_HOSTS_KEPT`] ago. Every replica does it; deleting twice is
/// harmless.
async fn prune<S: Store>(service: Arc<Service<S>>) {
    let keep = u64::try_from(REQUESTS_KEPT.as_millis()).unwrap_or(u64::MAX);
    let keep_hosts = u64::try_from(LOST_HOSTS_KEPT.as_millis()).unwrap_or(u64::MAX);
    let mut every = tokio::time::interval(Duration::from_secs(60 * 60));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        match service.prune_requests(keep).await {
            Ok(0) => {}
            Ok(pruned) => tracing::info!(pruned, "forgot old create requests"),
            Err(error) => tracing::warn!(%error, "forgetting old create requests failed"),
        }
        match service.prune_hosts(keep_hosts).await {
            Ok(0) => {}
            Ok(pruned) => tracing::info!(pruned, "forgot hosts given up on"),
            Err(error) => tracing::warn!(%error, "forgetting hosts given up on failed"),
        }
    }
}
