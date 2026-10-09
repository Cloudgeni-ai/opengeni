//! Maintain the existing approved connection files. The ordinary live file
//! reconciler adopts refreshed credentials without restarting the host engine.

use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

use crate::{config, enrollment};

/// Why an on-demand renewal could not run. Codes reach the control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RenewNowError {
    /// The connection file is gone (disconnected or replaced).
    ConnectionMissing,
    /// A legacy record has no verified deployment origin to renew against.
    LegacyOrigin,
    /// The install identity or connection store could not be read or written.
    LocalState,
    /// The control plane refused or could not be reached; retrying may help.
    Renewal,
}

impl RenewNowError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::ConnectionMissing => "connection_missing",
            Self::LegacyOrigin => "legacy_origin",
            Self::LocalState => "local_state_unavailable",
            Self::Renewal => "renewal_failed",
        }
    }

    pub(crate) fn retryable(self) -> bool {
        matches!(self, Self::Renewal)
    }
}

/// One on-demand renewal at a time. Every API replica may ask after the same
/// Hello; the later requests then find the consent already on disk.
static RENEW_NOW: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Renew one connection now, whatever its expiry. The control plane asks for
/// this after the enrollment's consent changed (screen control turned on). It
/// uses the same install-key proof and the same file as periodic renewal, so
/// the live reconciler adopts the result without a restart. Credentials on disk
/// that already carry the consent are reported as they are, so repeated or
/// concurrent requests never rewrite the file and restart the link again.
/// Returns the screen-control consent carried by the credentials now on disk.
pub(crate) async fn renew_now(connection_id: &str) -> Result<bool, RenewNowError> {
    let _one_at_a_time = RENEW_NOW.lock().await;
    let local = |error: &dyn std::fmt::Display| {
        warn!(%connection_id, %error, "on-demand credential renewal could not use local state");
        RenewNowError::LocalState
    };
    let connection = config::load_connection(connection_id)
        .map_err(|error| local(&error))?
        .ok_or(RenewNowError::ConnectionMissing)?;
    if connection.credentials.consented_screen_control {
        return Ok(true);
    }
    if connection.legacy_origin {
        return Err(RenewNowError::LegacyOrigin);
    }
    let identity = enrollment::InstallIdentity::load_existing(
        &config::config_dir().map_err(|error| local(&error))?,
    )
    .map_err(|error| local(&error))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let renewed = enrollment::renew_connection(&connection, &identity, now)
        .await
        .map_err(|error| {
            warn!(%connection_id, %error, "on-demand credential renewal failed");
            RenewNowError::Renewal
        })?;
    if config::save_renewed_connection(&connection, &renewed).map_err(|error| local(&error))? {
        info!(%connection_id, "renewed machine credentials on request");
        return Ok(renewed.credentials.consented_screen_control);
    }
    // Another writer (periodic renewal) replaced the file first. Report what is
    // on disk now; both came from the same enrollment row.
    Ok(config::load_connection(connection_id)
        .map_err(|error| local(&error))?
        .ok_or(RenewNowError::ConnectionMissing)?
        .credentials
        .consented_screen_control)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    fn bearer(expiry: u64) -> String {
        format!(
            "oge_{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(format!("{{\"exp\":{expiry}}}"))
        )
    }

    /// Answers one POST /v1/enrollments/renew with credentials carrying consent.
    async fn serve_one_renewal(listener: tokio::net::TcpListener, fresh: String) {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&chunk[..count]);
            let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..end]).unwrap();
            assert!(headers.starts_with("POST /v1/enrollments/renew HTTP/1.1"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            if request.len() >= end + 4 + length {
                break;
            }
        }
        let body = serde_json::json!({"credentials": {
            "agentId": "agent", "workspaceId": "workspace", "bearer": fresh,
            "natsUrls": ["wss://nats.example"], "relayUrl": "https://relay.example",
            "relayToken": "new-relay", "updatePublicKey": "update-key",
            "consentedWholeMachine": true, "consentedScreenControl": true
        }})
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard serializes the process-global config dir
    async fn renew_now_rewrites_the_same_connection_with_the_new_consent() {
        let (_lock, dir) = config::tests::with_temp_config();
        enrollment::InstallIdentity::load_or_generate(dir.path()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut credentials = config::StoredCredentials::from_proto(
            opengeni_agent_proto::v1::EnrollmentCredentials {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                nats_credentials: bearer(now + 20 * 24 * 3600),
                nats_urls: vec!["wss://nats.example".into()],
                relay_url: "https://relay.example".into(),
                relay_token: "old-relay".into(),
                update_pubkey: "update-key".into(),
                consented_whole_machine: true,
                consented_screen_control: false,
            },
            "stable",
        );
        credentials.resume_token = "retained-resume".into();
        let connection = config::StoredConnection::new(&url, credentials);
        config::save_connection(&connection).unwrap();
        let fresh = bearer(now + 30 * 24 * 3600);
        let server = tokio::spawn(serve_one_renewal(listener, fresh.clone()));

        // Not due for periodic renewal; the request renews it anyway.
        assert!(!enrollment::renewal_due(
            &connection.credentials.nats_bearer,
            now
        ));
        assert_eq!(renew_now(&connection.connection_id).await, Ok(true));
        server.await.unwrap();

        let saved = config::load_connection(&connection.connection_id)
            .unwrap()
            .unwrap();
        assert_eq!(saved.connection_id, connection.connection_id);
        assert_eq!(saved.api_url, connection.api_url);
        assert!(saved.credentials.consented_screen_control);
        assert_eq!(saved.credentials.nats_bearer, fresh);
        assert_eq!(saved.credentials.resume_token, "retained-resume");
        assert_eq!(config::load_connections(&url).unwrap().len(), 1);

        // Asked again (another API replica, a repeated call): the consent is
        // already on disk, so nothing is renewed or rewritten. The listener is
        // gone, so contacting it would fail.
        assert_eq!(renew_now(&connection.connection_id).await, Ok(true));
        assert_eq!(
            config::load_connection(&connection.connection_id)
                .unwrap()
                .unwrap(),
            saved
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn renew_now_reports_a_missing_connection_without_contacting_anyone() {
        let (_lock, _dir) = config::tests::with_temp_config();
        assert_eq!(
            renew_now("0123456789abcdef").await,
            Err(RenewNowError::ConnectionMissing)
        );
        assert_eq!(
            renew_now("../escape").await,
            Err(RenewNowError::ConnectionMissing)
        );
        assert!(!RenewNowError::ConnectionMissing.retryable());
        assert!(RenewNowError::Renewal.retryable());
    }
}
