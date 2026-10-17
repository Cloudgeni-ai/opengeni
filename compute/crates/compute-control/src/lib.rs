//! The Opengeni compute fleet service
//! ([ADR 18](../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
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

pub mod api;
pub mod e2b;
pub mod group;
pub mod hostapi;
pub mod hosts;
pub mod keys;
pub mod leader;
pub mod service;
pub mod store;
pub mod tls;
pub mod view;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use compute_storage::store::ChunkStore;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::hosts::Hosts;
use crate::leader::Scaling;
use crate::service::{Service, Settings};
use crate::store::Store;
use crate::tls::Tls;
use crate::view::View;

/// How a replica runs.
#[derive(Debug)]
pub struct Config {
    /// Where the public API listens.
    pub api: SocketAddr,
    /// Where hosts reach the service.
    pub hosts: SocketAddr,
    pub tls: Tls,
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
    let acceptor = TlsAcceptor::from(Arc::clone(&config.tls.server));
    let host_router = hostapi::router(Arc::clone(&store), terms);
    let api_router = api::router(Arc::clone(&service), config.operator);
    let mut tasks = vec![
        tokio::spawn(view::follow(Arc::clone(&view), Arc::clone(&store))),
        tokio::spawn(leader::lead(
            Arc::clone(&store),
            Arc::clone(&view),
            terms,
            config.scaling,
        )),
        tokio::spawn(hostapi::serve(host_listener, acceptor, host_router)),
        tokio::spawn(async move {
            if let Err(error) = axum::serve(api_listener, api_router).await {
                tracing::error!(%error, "the public API stopped");
            }
        }),
    ];
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
        service,
        tasks,
    })
}
