//! The `opengeni-relay` binary — the stateless stream-relay edge.
//!
//! Parses [`RelayConfig`] from env/CLI, wires structured `tracing`, and serves the
//! wss listener + health/metrics endpoints until SIGINT/SIGTERM, draining
//! gracefully. See the crate docs (`lib.rs`) for the relay-dial protocol it
//! implements.

use clap::Parser as _;
use opengeni_relay::{serve, RelayConfig, RelayMetrics};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    init_tracing();
    let config = RelayConfig::parse();
    tracing::info!(bind = %config.bind, "starting opengeni-relay");
    if config.stream_token_secret.is_empty() {
        tracing::warn!(
            "OPENGENI_STREAM_TOKEN_SECRET is empty — viewer connections will be rejected until configured"
        );
    }

    let metrics = RelayMetrics::new();
    match serve(config, metrics, shutdown_signal()).await {
        Ok(_addr) => {
            tracing::info!("relay shut down cleanly");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = %e, "relay failed");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Structured logging via `tracing` (env-filter; default `info`). NEVER logs secret
/// values (tokens/secrets are redacted at their use sites).
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("opengeni_relay=info,info"));
    let _ = fmt().with_env_filter(filter).try_init();
}

/// Resolves on SIGINT or (unix) SIGTERM so the listener drains in-flight streams.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    tracing::info!("shutdown signal received; draining");
}
