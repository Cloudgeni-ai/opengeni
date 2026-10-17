//! Where the front door listens, and how: plain HTTP for a TLS terminator
//! in front of it, or HTTPS with its own certificate.
//!
//! The E2B SDK reaches the API and every sandbox host name
//! (`<port>-<id>.<domain>`) over HTTPS, so a certificate given here must
//! name the API's host and `*.<domain>`. Connections speak HTTP/1.1, with
//! upgrades for web sockets to sandbox ports.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use rustls::ServerConfig;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::Settings;

/// Longest a caller may take over its TLS handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The front door of a replica.
#[derive(Clone, Debug)]
pub struct Listen {
    pub address: SocketAddr,
    /// The certificate and key to serve HTTPS with; `None` serves HTTP.
    pub tls: Option<Arc<ServerConfig>>,
    pub settings: Settings,
}

/// Serves `router` on `listener` for ever, over TLS when `tls` is given.
pub async fn serve(listener: TcpListener, router: Router, tls: Option<Arc<ServerConfig>>) {
    let Some(tls) = tls else {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "the E2B front door stopped");
        }
        return;
    };
    let acceptor = TlsAcceptor::from(tls);
    loop {
        let (tcp, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "accepting an E2B connection failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let (acceptor, router) = (acceptor.clone(), router.clone());
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let stream = match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "an E2B caller's TLS handshake failed");
                    return;
                }
                Err(_) => return,
            };
            let served = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(router))
                .with_upgrades()
                .await;
            if let Err(error) = served {
                tracing::debug!(%error, "an E2B connection ended with an error");
            }
        });
    }
}
