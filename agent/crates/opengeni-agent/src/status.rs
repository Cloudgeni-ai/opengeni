//! Truthful local enrollment and control-plane status.
//!
//! This intentionally differs from `service status`: the service command asks
//! systemd/launchd whether the opt-in daemon is running, while this command reads
//! the durable enrollment and performs an authenticated NATS round trip with the
//! stored bearer. A local credentials file alone is never reported as "online".

use std::time::Duration;

use crate::cli::StatusArgs;
use crate::config::{self, StoredCredentials};

/// Report local enrollment and prove authenticated control-plane reachability.
///
/// A missing/malformed enrollment or an unreachable/rejected credential returns
/// an error so the process exits non-zero. No bearer, relay token, or URL is
/// printed.
pub async fn run(args: &StatusArgs) -> Result<(), String> {
    let credentials = match config::load_credentials() {
        Ok(Some(credentials)) => credentials,
        Ok(None) => {
            println!("Enrollment: not enrolled");
            println!("Control plane: not checked");
            return Err("this machine is not enrolled; run `opengeni-agent enroll`".to_string());
        }
        Err(error) => {
            println!("Enrollment: unreadable");
            println!("Control plane: not checked");
            return Err(format!("could not read local enrollment: {error}"));
        }
    };

    println!("Enrollment: enrolled");
    println!("Agent: {}", credentials.agent_id);
    println!("Workspace: {}", credentials.workspace_id);

    let timeout = Duration::from_secs(args.timeout_seconds);
    match probe_control_plane(&credentials, timeout).await {
        Ok(()) => {
            println!("Control plane: reachable (authenticated)");
            Ok(())
        }
        Err(error) => {
            println!("Control plane: unreachable");
            Err(error)
        }
    }
}

async fn probe_control_plane(
    credentials: &StoredCredentials,
    timeout: Duration,
) -> Result<(), String> {
    if credentials.nats_bearer.trim().is_empty() {
        return Err(
            "local enrollment has no bearer; run `opengeni-agent enroll --force`".to_string(),
        );
    }
    if credentials.nats_urls.is_empty() {
        return Err(
            "local enrollment has no control-plane endpoints; run `opengeni-agent enroll --force`"
                .to_string(),
        );
    }

    // Some(0) means unlimited reconnects in async-nats, so use the smallest
    // finite value and put the entire proof behind our own explicit deadline.
    let options = async_nats::ConnectOptions::new()
        .token(credentials.nats_bearer.clone())
        .name(format!("opengeni-agent-status/{}", credentials.agent_id))
        .max_reconnects(Some(1));

    tokio::time::timeout(timeout, async {
        let client = async_nats::connect_with_options(credentials.nats_urls.clone(), options)
            .await
            // Provider errors are deliberately not forwarded: depending on the
            // transport they can include a dial target. Status must never echo
            // the stored endpoint or bearer into a terminal or service log.
            .map_err(|_| "control-plane authentication or connection failed".to_string())?;
        client
            .flush()
            .await
            .map_err(|_| "control-plane round trip failed".to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| {
        format!(
            "control-plane status timed out after {}s",
            timeout.as_secs()
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> StoredCredentials {
        StoredCredentials {
            api_base_url: "https://example.test".to_string(),
            agent_id: "agent-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            nats_bearer: "test-bearer".to_string(),
            bearer_expires_at_unix_seconds: 4_102_444_800,
            nats_urls: vec!["nats://127.0.0.1:1".to_string()],
            relay_url: "https://relay.example.test".to_string(),
            relay_token: "test-relay-token".to_string(),
            relay_token_expires_at_unix_seconds: 4_102_444_500,
            update_pubkey: "test-key".to_string(),
            consented_whole_machine: true,
            consented_screen_control: false,
            update_channel: "stable".to_string(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }

    #[tokio::test]
    async fn missing_bearer_fails_before_dialing() {
        let mut credentials = credentials();
        credentials.nats_bearer.clear();
        let error = probe_control_plane(&credentials, Duration::from_millis(10))
            .await
            .expect_err("empty bearer must fail");
        assert!(error.contains("no bearer"));
    }

    #[tokio::test]
    async fn missing_endpoints_fail_before_dialing() {
        let mut credentials = credentials();
        credentials.nats_urls.clear();
        let error = probe_control_plane(&credentials, Duration::from_millis(10))
            .await
            .expect_err("empty endpoints must fail");
        assert!(error.contains("no control-plane endpoints"));
    }
}
