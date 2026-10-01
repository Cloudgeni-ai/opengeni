//! Maintain the existing approved connection files. The ordinary live file
//! reconciler adopts refreshed credentials without restarting the host engine.

use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

use crate::{config, enrollment};

pub(crate) async fn run(api_url: String) {
    loop {
        if let Err(error) = renew_due_connections(&api_url).await {
            warn!(%error, "could not inspect machine credential renewal");
        }
        // Bounds retries on older APIs, revoked grants and transport failures.
        // Jitter prevents a fleet waking together from repeatedly aligning.
        tokio::time::sleep(Duration::from_secs(60 + rand::random::<u64>() % 60)).await;
    }
}

async fn renew_due_connections(api_url: &str) -> Result<(), config::ConfigError> {
    let connections = config::load_connections(api_url)?;
    for connection in connections {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Legacy records lack a verified deployment origin. Never send their
        // credentials to a guessed/default API; explicit reconnect establishes it.
        if connection.legacy_origin
            || !enrollment::renewal_due(&connection.credentials.nats_bearer, now)
        {
            continue;
        }
        let identity = match enrollment::InstallIdentity::load_existing(&config::config_dir()?) {
            Ok(identity) => identity,
            Err(error) => {
                warn!(connection_id = %connection.connection_id, %error, "machine renewal needs its existing install identity");
                continue;
            }
        };
        match enrollment::renew_connection(&connection, &identity, now).await {
            Ok(renewed) => {
                if config::save_renewed_connection(&connection, &renewed)? {
                    info!(connection_id = %connection.connection_id, "renewed machine transport credentials");
                }
            }
            Err(error) => {
                warn!(connection_id = %connection.connection_id, %error, "machine credential renewal failed; retaining connection for retry");
            }
        }
    }
    Ok(())
}
