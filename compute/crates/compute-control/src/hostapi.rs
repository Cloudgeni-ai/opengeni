//! The API hosts call: register, renew and report, and ask for their
//! agent-link tokens, over mutual TLS.
//!
//! Each connection carries the names its client certificate is valid for,
//! and a host may act only under one of them.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Json, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Router, response::IntoResponse};
use compute_fleet::LeaseTerms;
use compute_protocol::fleet::{
    LINK_TOKENS_PATH, LinkTokens, LinkTokensAsked, REGISTER_PATH, RENEW_PATH, REPORT_PATH,
    Register, Registered, Renew, Renewed, Report, Terms,
};
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt as _;

use crate::link::Links;
use crate::store::{Admission, Store};
use crate::tls::names_of;

/// How long a host may take to agree TLS.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The names the caller's certificate is valid for.
#[derive(Clone, Debug, Default)]
pub struct Peer(pub Arc<[String]>);

/// Lease terms as hosts are told them.
#[must_use]
pub fn wire_terms(terms: LeaseTerms) -> Terms {
    let ms = |duration: Duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
    Terms {
        term_ms: ms(terms.term),
        margin_ms: ms(terms.margin),
        renew_every_ms: ms(terms.renew_every),
        register_every_ms: ms(terms.register_every),
        request_window: terms.request_window,
        watchdog_ms: ms(terms.watchdog),
        stop_ms: ms(terms.stop),
        rate_error_ppm: terms.rate_error_ppm,
    }
}

struct Inner<S> {
    store: Arc<S>,
    terms: LeaseTerms,
    links: Option<Arc<Links>>,
}

/// The host API's state.
pub struct HostApi<S>(Arc<Inner<S>>);

impl<S> Clone for HostApi<S> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<S> std::fmt::Debug for HostApi<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostApi")
    }
}

fn unavailable(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::SERVICE_UNAVAILABLE, error.to_string())
}

async fn register<S: Store>(
    State(api): State<HostApi<S>>,
    Extension(peer): Extension<Peer>,
    Json(register): Json<Register>,
) -> Result<Json<Registered>, (StatusCode, String)> {
    if !peer.0.contains(&register.info.name) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("the certificate does not name {}", register.info.name),
        ));
    }
    let terms = api.0.terms;
    let answer = match api.0.store.register(&register).await.map_err(unavailable)? {
        Admission::Registered {
            host,
            epoch,
            rulings,
        } => {
            tracing::info!(
                host = %register.info.name,
                id = host.0,
                epoch = epoch.0,
                listed = register.held.len(),
                "a host registered"
            );
            Registered::Registered {
                host: host.0,
                epoch: epoch.0,
                terms: wire_terms(terms),
                rulings,
            }
        }
        Admission::StillLive => Registered::StillLive {
            retry_after_ms: wire_terms(terms).register_every_ms,
        },
    };
    Ok(Json(answer))
}

async fn renew<S: Store>(
    State(api): State<HostApi<S>>,
    Extension(peer): Extension<Peer>,
    Json(renew): Json<Renew>,
) -> Result<Json<Renewed>, (StatusCode, String)> {
    let accepted = api
        .0
        .store
        .renew(&renew, &peer.0)
        .await
        .map_err(unavailable)?;
    Ok(Json(if accepted {
        Renewed::Renewed {
            epoch: renew.epoch,
            seq: renew.seq,
        }
    } else {
        Renewed::Unknown
    }))
}

async fn report<S: Store>(
    State(api): State<HostApi<S>>,
    Extension(peer): Extension<Peer>,
    Json(report): Json<Report>,
) -> impl IntoResponse {
    match api.0.store.report(&report, &peer.0).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(error) => {
            tracing::warn!(%error, "recording a report failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Signs a token for each gateway the host asks for, under the name its
/// certificate holds. Only gateways some team's sandboxes use are signed
/// for.
async fn link_tokens<S: Store>(
    State(api): State<HostApi<S>>,
    Extension(peer): Extension<Peer>,
    Json(asked): Json<LinkTokensAsked>,
) -> Result<Json<LinkTokens>, (StatusCode, String)> {
    if !peer.0.contains(&asked.name) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("the certificate does not name {}", asked.name),
        ));
    }
    let Some(links) = &api.0.links else {
        return Err((
            StatusCode::NOT_FOUND,
            "this fleet runs no agent links".into(),
        ));
    };
    if let Some(unknown) = asked.gateways.iter().find(|url| !links.knows(url)) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("no team's sandboxes use the gateway {unknown}"),
        ));
    }
    let now = now_ms();
    let tokens = asked
        .gateways
        .iter()
        .map(|gateway| links.host_token(gateway, &asked.name, now))
        .collect();
    Ok(Json(LinkTokens { tokens }))
}

/// The host API's routes.
pub fn router<S: Store>(store: Arc<S>, terms: LeaseTerms, links: Option<Arc<Links>>) -> Router {
    Router::new()
        .route(REGISTER_PATH, post(register::<S>))
        .route(RENEW_PATH, post(renew::<S>))
        .route(REPORT_PATH, post(report::<S>))
        .route(LINK_TOKENS_PATH, post(link_tokens::<S>))
        .with_state(HostApi(Arc::new(Inner {
            store,
            terms,
            links,
        })))
}

/// Serves `router` on `listener` to clients `acceptor` verifies, each
/// request carrying its caller's [`Peer`].
pub async fn serve(listener: TcpListener, acceptor: TlsAcceptor, router: Router) {
    loop {
        let (tcp, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "accepting a host connection failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let router = router.clone();
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let tls = match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                Ok(Ok(tls)) => tls,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "a host's TLS handshake failed");
                    return;
                }
                Err(_) => return,
            };
            let names: Vec<String> = tls
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|chain| chain.first())
                .map(names_of)
                .unwrap_or_default();
            let peer = Peer(names.into());
            let service = router.map_request(
                move |mut request: axum::http::Request<hyper::body::Incoming>| {
                    request.extensions_mut().insert(peer.clone());
                    request
                },
            );
            let served = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(tls), TowerToHyperService::new(service))
                .await;
            if let Err(error) = served {
                tracing::debug!(%error, "a host connection ended with an error");
            }
        });
    }
}
