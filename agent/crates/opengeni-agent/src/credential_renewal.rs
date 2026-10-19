//! Maintain the existing approved connection files. The ordinary live file
//! reconciler adopts refreshed credentials without restarting the host engine.

use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
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
    /// This agent has no enrollment of its own to renew: a fabric sandbox's
    /// agent, whose enrollment the fabric keeps.
    Unsupported,
}

impl RenewNowError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::ConnectionMissing => "connection_missing",
            Self::LegacyOrigin => "legacy_origin",
            Self::LocalState => "local_state_unavailable",
            Self::Renewal => "renewal_failed",
            Self::Unsupported => "renewal_unsupported",
        }
    }

    pub(crate) fn retryable(self) -> bool {
        matches!(self, Self::Renewal)
    }
}

/// One on-demand renewal at a time. Every API replica may ask after the same
/// Hello; the later requests then find the consent already on disk.
static RENEW_NOW: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Fence the rejection to the exact bearer that failed. A concurrent explicit
/// reconnect or renewal must never be suspended by an older transport result.
pub(crate) fn record_authentication_rejection(
    connection_id: &str,
    rejected_bearer: &str,
) -> Result<(), config::ConfigError> {
    let Some(connection) = config::load_connection(connection_id)? else {
        return Ok(());
    };
    if connection.credentials.nats_bearer != rejected_bearer
        || connection.authentication_state.is_some()
    {
        return Ok(());
    }
    let mut suspended = connection.clone();
    suspended.authentication_state = Some(config::AuthenticationState::RenewalRequired);
    config::save_renewed_connection(&connection, &suspended)?;
    Ok(())
}

/// A rejected transport with no usable renewal path needs human reconnect.
/// Never clear its suspension without successfully obtaining credentials.
fn require_reconnect(connection: &config::StoredConnection) -> Result<(), config::ConfigError> {
    if connection.authentication_state == Some(config::AuthenticationState::RenewalRequired) {
        let mut suspended = connection.clone();
        suspended.authentication_state = Some(config::AuthenticationState::ReconnectRequired);
        if config::save_renewed_connection(connection, &suspended)? {
            warn!(connection_id = %connection.connection_id,
                "connection needs reauthorization; automatic retries stopped. Run `opengeni-agent connections` to reconnect or remove this saved connection");
        }
    }
    Ok(())
}

/// Only transitions are noteworthy; a temporary renewal outage is not a new
/// incident on every timer tick. Entries disappear with their saved connection.
#[derive(Default)]
pub(crate) struct RenewalDiagnostics(HashMap<String, String>);

impl RenewalDiagnostics {
    fn changed(&mut self, connection_id: &str, reason: String) -> bool {
        if self.0.get(connection_id) == Some(&reason) {
            return false;
        }
        self.0.insert(connection_id.to_owned(), reason);
        true
    }
}

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
    let mut diagnostics = RenewalDiagnostics::default();
    loop {
        if let Err(error) = renew_due_connections(&api_url, &mut diagnostics).await {
            warn!(%error, "could not inspect machine credential renewal");
        }
        // Bounds retries on older APIs, revoked grants and transport failures.
        // Jitter prevents a fleet waking together from repeatedly aligning.
        tokio::time::sleep(Duration::from_secs(60 + rand::random::<u64>() % 60)).await;
    }
}

pub(crate) async fn renew_due_connections(
    api_url: &str,
    diagnostics: &mut RenewalDiagnostics,
) -> Result<(), config::ConfigError> {
    let connections = config::load_connections(api_url)?;
    diagnostics.0.retain(|id, _| {
        connections
            .iter()
            .any(|connection| &connection.connection_id == id)
    });
    for connection in connections {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Legacy records lack a verified deployment origin. Never send their
        // credentials to a guessed/default API; explicit reconnect establishes it.
        if connection.legacy_origin {
            require_reconnect(&connection)?;
            continue;
        }
        if connection.authentication_state == Some(config::AuthenticationState::ReconnectRequired)
            || (connection.authentication_state
                != Some(config::AuthenticationState::RenewalRequired)
                && !enrollment::renewal_due(&connection.credentials.nats_bearer, now))
        {
            continue;
        }
        let identity = match enrollment::InstallIdentity::load_existing(&config::config_dir()?) {
            Ok(identity) => identity,
            Err(error) => {
                if connection.authentication_state.is_some() {
                    require_reconnect(&connection)?;
                } else if diagnostics.changed(&connection.connection_id, error.to_string()) {
                    warn!(connection_id = %connection.connection_id, %error, "machine renewal needs its existing install identity");
                }
                continue;
            }
        };
        match enrollment::renew_connection(&connection, &identity, now).await {
            Ok(renewed) => {
                if config::save_renewed_connection(&connection, &renewed)? {
                    diagnostics.0.remove(&connection.connection_id);
                    info!(connection_id = %connection.connection_id, "renewed machine transport credentials");
                }
            }
            Err(enrollment::EnrollmentError::ReconnectRequired) => {
                let mut suspended = connection.clone();
                suspended.authentication_state =
                    Some(config::AuthenticationState::ReconnectRequired);
                if config::save_renewed_connection(&connection, &suspended)? {
                    warn!(connection_id = %connection.connection_id,
                        "enrollment renewal rejected permanently; automatic retries stopped. Run `opengeni-agent connections` to reconnect or remove this saved connection");
                }
            }
            // An older API can only give a generic refusal or have no renewal
            // endpoint. Combined with a transport rejection, retrying cannot
            // recover this connection. Do not apply this to a healthy link or
            // to explicit clock skew, server outages, or network failures.
            Err(enrollment::EnrollmentError::Status {
                status: 401 | 403 | 404 | 405,
                ..
            }) if connection.authentication_state
                == Some(config::AuthenticationState::RenewalRequired) =>
            {
                require_reconnect(&connection)?;
            }
            Err(error) => {
                if diagnostics.changed(&connection.connection_id, error.to_string()) {
                    warn!(connection_id = %connection.connection_id, %error, "machine credential renewal was not definitive; retaining recovery on the renewal cadence");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine as _;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tracing::instrument::WithSubscriber as _;
    use tracing_subscriber::layer::SubscriberExt as _;

    #[derive(Clone, Default)]
    struct WarningCount(Arc<AtomicUsize>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for WarningCount {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if *event.metadata().level() == tracing::Level::WARN {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn bearer(expiry: u64) -> String {
        format!(
            "oge_{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(format!("{{\"exp\":{expiry}}}"))
        )
    }

    fn connection(url: &str) -> config::StoredConnection {
        let credentials = config::StoredCredentials::from_proto(
            opengeni_agent_proto::v1::EnrollmentCredentials {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                nats_credentials: bearer(u64::MAX / 2),
                ..Default::default()
            },
            "stable",
        );
        config::StoredConnection::new(url, credentials)
    }

    #[test]
    fn renewal_diagnostics_report_only_changes_per_connection() {
        let mut diagnostics = RenewalDiagnostics::default();
        assert!(diagnostics.changed("one", "HTTP 503".into()));
        for _ in 0..100 {
            assert!(!diagnostics.changed("one", "HTTP 503".into()));
        }
        assert!(diagnostics.changed("two", "HTTP 503".into()));
        assert!(diagnostics.changed("one", "clock skew".into()));
        assert!(!diagnostics.changed("two", "HTTP 503".into()));
        diagnostics.0.remove("one");
        assert!(diagnostics.changed("one", "HTTP 503".into()));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn rejected_connection_without_install_identity_requires_reconnect() {
        let (_lock, _dir) = config::tests::with_temp_config();
        let mut saved = connection("http://127.0.0.1:1");
        saved.authentication_state = Some(config::AuthenticationState::RenewalRequired);
        config::save_connection(&saved).unwrap();
        let mut diagnostics = RenewalDiagnostics::default();
        for _ in 0..3 {
            renew_due_connections(&saved.api_url, &mut diagnostics)
                .await
                .unwrap();
        }
        assert_eq!(
            config::load_connection(&saved.connection_id)
                .unwrap()
                .unwrap()
                .authentication_state,
            Some(config::AuthenticationState::ReconnectRequired)
        );
        config::remove_connection(&saved.connection_id, &saved.api_url).unwrap();
        renew_due_connections(&saved.api_url, &mut diagnostics)
            .await
            .unwrap();
        assert!(diagnostics.0.is_empty());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn temporary_renewal_failure_never_resumes_rejected_transport_and_logs_once() {
        let (_lock, dir) = config::tests::with_temp_config();
        enrollment::InstallIdentity::load_or_generate(dir.path()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut saved = connection(&url);
        saved.authentication_state = Some(config::AuthenticationState::RenewalRequired);
        config::save_connection(&saved).unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_renewal_request(&mut socket).await;
                socket.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        let mut diagnostics = RenewalDiagnostics::default();
        let warnings = WarningCount::default();
        let subscriber =
            tracing::Dispatch::new(tracing_subscriber::registry().with(warnings.clone()));
        for _ in 0..3 {
            renew_due_connections(&url, &mut diagnostics)
                .with_subscriber(subscriber.clone())
                .await
                .unwrap();
            assert_eq!(
                config::load_connection(&saved.connection_id)
                    .unwrap()
                    .unwrap(),
                saved
            );
            assert_eq!(diagnostics.0.len(), 1);
        }
        server.await.unwrap();
        assert_eq!(
            warnings.0.load(Ordering::Relaxed),
            1,
            "unchanged failure logs only once"
        );
        // Deleting the connection also deletes its diagnostic state.
        config::remove_connection(&saved.connection_id, &url).unwrap();
        renew_due_connections(&url, &mut diagnostics).await.unwrap();
        assert!(diagnostics.0.is_empty());
    }

    #[test]
    fn rejection_is_persisted_only_for_the_exact_credential_document() {
        let (_lock, _dir) = config::tests::with_temp_config();
        let original = connection("https://one.example");
        config::save_connection(&original).unwrap();
        record_authentication_rejection(&original.connection_id, &original.credentials.nats_bearer)
            .unwrap();
        let suspended = config::load_connection(&original.connection_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            suspended.authentication_state,
            Some(config::AuthenticationState::RenewalRequired)
        );
        // Explicit reconnect clears the state; an old transport's delayed
        // rejection cannot suspend the replacement credentials.
        let mut replacement = original.clone();
        replacement.credentials.nats_bearer = "replacement".into();
        config::save_connection(&replacement).unwrap();
        record_authentication_rejection(&original.connection_id, &original.credentials.nats_bearer)
            .unwrap();
        assert_eq!(
            config::load_connection(&original.connection_id)
                .unwrap()
                .unwrap(),
            replacement
        );
        assert!(!config::save_renewed_connection(&suspended, &original).unwrap());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn rejected_legacy_origin_stays_paused_without_sending_credentials_to_a_guessed_api() {
        let (_lock, _dir) = config::tests::with_temp_config();
        let original = connection("http://127.0.0.1:1");
        config::save_credentials(&original.credentials).unwrap();
        let mut saved = config::load_connections(&original.api_url)
            .unwrap()
            .remove(0);
        assert!(saved.legacy_origin);
        saved.authentication_state = Some(config::AuthenticationState::RenewalRequired);
        config::save_connection(&saved).unwrap();
        let mut diagnostics = RenewalDiagnostics::default();
        for _ in 0..3 {
            renew_due_connections(&saved.api_url, &mut diagnostics)
                .await
                .unwrap();
        }
        assert_eq!(
            config::load_connection(&saved.connection_id)
                .unwrap()
                .unwrap()
                .authentication_state,
            Some(config::AuthenticationState::ReconnectRequired)
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn rejected_connections_stop_on_refusal_but_temporary_outages_remain_recoverable() {
        let (_lock, dir) = config::tests::with_temp_config();
        enrollment::InstallIdentity::load_or_generate(dir.path()).unwrap();
        for (status, body, terminal) in [
            (401, r#"{"code":"enrollment_reconnect_required"}"#, true),
            (401, r#"{"code":"enrollment_clock_skew"}"#, false),
            (401, "machine renewal not authorized", true),
            (403, "forbidden", true),
            (503, r#"{"code":"enrollment_reconnect_required"}"#, false),
            (404, "older API", true),
            (405, "older API", true),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let mut saved = connection(&url);
            saved.authentication_state = Some(config::AuthenticationState::RenewalRequired);
            config::save_connection(&saved).unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_renewal_request(&mut socket).await;
                socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                listener
            });
            let mut diagnostics = RenewalDiagnostics::default();
            renew_due_connections(&url, &mut diagnostics).await.unwrap();
            let listener = server.await.unwrap();
            let current = config::load_connection(&saved.connection_id)
                .unwrap()
                .unwrap();
            assert_eq!(
                current.authentication_state,
                if terminal {
                    Some(config::AuthenticationState::ReconnectRequired)
                } else {
                    Some(config::AuthenticationState::RenewalRequired)
                }
            );
            // A terminal connection is skipped entirely, including HTTP renewal.
            if terminal {
                let attempted = tokio::spawn(async move {
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_ok()
                });
                for _ in 0..3 {
                    renew_due_connections(&url, &mut diagnostics).await.unwrap();
                }
                assert!(!attempted.await.unwrap());
            }
            config::remove_connection(&saved.connection_id, &url).unwrap();
        }
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn rejected_unexpired_credentials_renew_and_clear_the_suspension() {
        let (_lock, dir) = config::tests::with_temp_config();
        enrollment::InstallIdentity::load_or_generate(dir.path()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut saved = connection(&url);
        saved.authentication_state = Some(config::AuthenticationState::RenewalRequired);
        config::save_connection(&saved).unwrap();
        let fresh = bearer(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 30 * 24 * 3600,
        );
        let server = tokio::spawn(serve_one_renewal(listener, fresh.clone()));
        renew_due_connections(&url, &mut RenewalDiagnostics::default())
            .await
            .unwrap();
        server.await.unwrap();
        let current = config::load_connection(&saved.connection_id)
            .unwrap()
            .unwrap();
        assert_eq!(current.authentication_state, None);
        assert_eq!(current.credentials.nats_bearer, fresh);
    }

    pub(crate) async fn read_renewal_request(socket: &mut tokio::net::TcpStream) {
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
    }

    /// Answers one POST /v1/enrollments/renew with credentials carrying consent.
    async fn serve_one_renewal(listener: tokio::net::TcpListener, fresh: String) {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_renewal_request(&mut socket).await;
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
