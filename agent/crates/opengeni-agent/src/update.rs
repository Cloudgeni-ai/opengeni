//! The `update` subcommand — check for and apply a signed self-update.
//!
//! Thin binary-side glue over [`opengeni_agent_update`]: resolve the channel +
//! base URL (from the enrolled credentials, overridable by flags/env), run the
//! verified [`check_update`](opengeni_agent_update::check_update), and on `--check`
//! just report; otherwise apply the verified bytes to the RUNNING executable
//! (atomic swap, incl. the Windows rename-self-aside) and ask for a restart.
//!
//! The actual download + minisign/sha256 verify + version gating + atomic swap +
//! rollback all live in `opengeni-agent-update` (cargo-unit-tested there); this
//! module only wires the config and prints the outcome.

use std::collections::BTreeSet;

use opengeni_agent_update::{check_update, CheckOutcome, HttpSource, UpdateConfig};
use tracing::{info, warn};

use crate::cli::UpdateArgs;
use crate::config::{self, StoredConnection};
use crate::enrollment::InstallIdentity;

/// The default release base URL when neither the flag/env nor an enrolled value is
/// present (mirrors the install scripts' default).
const DEFAULT_BASE_URL: &str = "https://get.opengeni.ai";

/// Runs the `update` subcommand.
///
/// # Errors
///
/// Returns a human-facing error string on any fetch/verify/apply failure.
pub fn run(args: &UpdateArgs) -> Result<(), String> {
    let legacy_api_url =
        std::env::var("OPENGENI_API_URL").unwrap_or_else(|_| "https://api.opengeni.ai".to_string());
    let connections = config::load_connections(&legacy_api_url)
        .map_err(|e| format!("could not load connections: {e}"))?;

    // The binary is process-global, so update policy is process-global too. Never
    // silently let whichever connection sorts first choose the channel for every
    // deployment. Matching channels compose naturally; a mixed setup requires an
    // explicit operator choice.
    let channel = resolve_channel(args.channel.as_deref(), &connections)?;
    // Staged rollout cohorting must be stable for the physical install, not tied
    // to an arbitrary workspace agent id. Every enrollment already shares this
    // durable keypair, including across independent OpenGeni deployments.
    let install_identity = InstallIdentity::load_or_generate(
        &config::config_dir().map_err(|e| format!("could not resolve config dir: {e}"))?,
    )
    .map_err(|e| format!("could not load install identity: {e}"))?;
    let agent_id = install_identity.public_key_base64();
    let base_url = args
        .base_url
        .clone()
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());

    let current_version = env!("CARGO_PKG_VERSION");
    let config = UpdateConfig::new(base_url, channel, agent_id, current_version);

    info!(
        version = current_version,
        channel = %config.channel,
        "checking for a self-update"
    );
    let source = HttpSource::new().map_err(|e| format!("update http source: {e}"))?;
    let outcome =
        check_update(&source, &config).map_err(|e| format!("update check failed: {e}"))?;

    match outcome {
        CheckOutcome::UpToDate(reason) => {
            println!("opengeni-agent is up to date ({current_version}). {reason}");
            Ok(())
        }
        CheckOutcome::Available(pending) => {
            println!(
                "a verified update is available: {current_version} -> {} ({} bytes).",
                pending.version,
                pending.size()
            );
            if args.check {
                println!("(--check) not applying. Run `opengeni-agent update` to install it.");
                return Ok(());
            }
            // Apply to the running executable (atomic swap + retained backup). The
            // boot health-gate + rollback run on the next start; the service manager
            // (or the user's `run`) brings up the new binary, which re-dials NATS —
            // a self-update is indistinguishable from a reconnect blip.
            let backup = pending
                .apply_running()
                .map_err(|e| format!("failed to apply the update: {e}"))?;
            warn!(backup = %backup.display(), version = %pending.version, "update applied; restart to run the new binary");
            println!(
                "update applied (v{}). The prior binary is kept at {} until the new \n\
                 version passes its boot health-gate. Restart opengeni-agent to run it.",
                pending.version,
                backup.display()
            );
            Ok(())
        }
    }
}

fn resolve_channel(
    explicit: Option<&str>,
    connections: &[StoredConnection],
) -> Result<String, String> {
    if let Some(channel) = explicit {
        return Ok(channel.to_string());
    }
    let channels: BTreeSet<_> = connections
        .iter()
        .map(|connection| connection.credentials.update_channel.as_str())
        .collect();
    match channels.len() {
        0 => Ok("stable".to_string()),
        1 => Ok(channels.into_iter().next().expect("one channel").to_string()),
        _ => Err(format!(
            "configured connections use multiple update channels ({}); pass --channel stable or --channel beta explicitly",
            channels.into_iter().collect::<Vec<_>>().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StoredCredentials;

    fn connection(channel: &str) -> StoredConnection {
        StoredConnection::new(
            "https://example.com",
            StoredCredentials {
                agent_id: "agent".to_string(),
                workspace_id: channel.to_string(),
                nats_bearer: "secret".to_string(),
                nats_urls: Vec::new(),
                relay_url: String::new(),
                relay_token: String::new(),
                update_pubkey: String::new(),
                consented_whole_machine: true,
                consented_screen_control: false,
                update_channel: channel.to_string(),
                resume_token: String::new(),
                last_known_epoch: 0,
            },
        )
    }

    #[test]
    fn matching_connection_channels_compose() {
        assert_eq!(
            resolve_channel(None, &[connection("stable"), connection("stable")]),
            Ok("stable".to_string())
        );
    }

    #[test]
    fn mixed_channels_require_an_explicit_global_choice() {
        let connections = [connection("stable"), connection("beta")];
        assert!(resolve_channel(None, &connections).is_err());
        assert_eq!(
            resolve_channel(Some("beta"), &connections),
            Ok("beta".to_string())
        );
    }
}
