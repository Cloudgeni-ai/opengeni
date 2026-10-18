//! Where the front door listens, and how: plain HTTP for a TLS terminator
//! in front of it, or HTTPS with its own certificate.
//!
//! The E2B SDK reaches the API and every sandbox host name
//! (`<port>-<id>.<domain>`) over HTTPS, so a certificate given here must
//! name the API's host and `*.<domain>`. Connections speak HTTP/1.1, with
//! upgrades for web sockets to sandbox ports.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use rustls::ServerConfig;
use tokio::net::TcpListener;

use super::Settings;

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
    crate::tls::serve(listener, router, tls, "the E2B front door").await;
}
