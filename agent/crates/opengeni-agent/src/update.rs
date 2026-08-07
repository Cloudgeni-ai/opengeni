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

use opengeni_agent_update::{
    check_update_manifest, finalize_update, HttpSource, ManifestCheckOutcome, UpdateConfig,
    UpdateError, UpdateResult,
};
use semver::Version;
use tracing::{info, warn};

use crate::cli::UpdateArgs;
use crate::config::{self, StoredConnection};
use crate::enrollment::InstallIdentity;

/// Public fallback used only before the machine has any enrolled deployment.
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
    let current_version = env!("CARGO_PKG_VERSION");
    let bases = resolve_update_bases(args.base_url.as_deref(), &connections);
    let source = HttpSource::new().map_err(|e| format!("update http source: {e}"))?;
    let mut best: Option<(String, opengeni_agent_update::PendingUpdatePlan)> = None;
    let mut current_reasons = Vec::new();
    let mut failures = Vec::new();

    for base_url in &bases {
        let config = UpdateConfig::new(base_url, &channel, &agent_id, current_version);
        info!(
            version = current_version,
            channel = %config.channel,
            update_origin = %base_url,
            "checking a deployment for a self-update"
        );
        match check_update_manifest(&source, &config) {
            Ok(ManifestCheckOutcome::Available(plan)) => {
                let candidate = Version::parse(&plan.version)
                    .map_err(|error| format!("verified update has invalid version: {error}"))?;
                let replace = best.as_ref().is_none_or(|(_, current)| {
                    Version::parse(&current.version).is_ok_and(|version| candidate > version)
                });
                if replace {
                    best = Some((base_url.clone(), plan));
                }
            }
            Ok(ManifestCheckOutcome::UpToDate(reason)) => {
                current_reasons.push(format!("{base_url}: {reason}"));
            }
            Err(error) => failures.push(format!("{base_url}: {error}")),
        }
    }

    let Some((selected_origin, plan)) = best else {
        if !current_reasons.is_empty() {
            println!("opengeni-agent is up to date ({current_version}).");
            if !failures.is_empty() {
                warn!(failures = ?failures, "some enrolled deployments could not serve an update manifest");
            }
            return Ok(());
        }
        return Err(format!(
            "update check failed for every configured deployment: {}",
            failures.join("; ")
        ));
    };

    if !failures.is_empty() {
        eprintln!(
            "warning: could not check every enrolled deployment: {}",
            failures.join("; ")
        );
    }

    println!(
        "a verified update is available from {selected_origin}: {current_version} -> {} ({} bytes).",
        plan.version,
        plan.expected_size()
    );
    if args.check {
        println!("(--check) not applying. Run `opengeni-agent update` to install it.");
        return Ok(());
    }
    let pending = plan
        .download(&source)
        .map_err(|error| format!("failed to download the selected update: {error}"))?;
    let install_path = std::env::current_exe()
        .map_err(|error| format!("could not resolve installed agent path: {error}"))?;
    pending
        .apply_running()
        .map_err(|e| format!("failed to apply the update: {e}"))?;
    finalize_update(
        &install_path,
        verify_installed_binary(&install_path, &pending.version),
    )
    .map_err(|error| {
        format!("new binary failed its startup preflight and was rolled back: {error}")
    })?;
    info!(version = %pending.version, "update applied and startup preflight passed; prior binary removed");
    println!(
        "update applied and verified (v{}). Restart the agent to activate it.",
        pending.version
    );
    Ok(())
}

/// Executes the newly-swapped binary through the smallest stable startup surface.
/// If the loader, executable bit, CLI wiring, or embedded version is wrong, the
/// updater rolls back atomically before reporting success.
fn verify_installed_binary(install_path: &std::path::Path, version: &str) -> UpdateResult<()> {
    let output = std::process::Command::new(install_path)
        .arg("--version")
        .output()
        .map_err(|source| UpdateError::Io {
            path: install_path.display().to_string(),
            source,
        })?;
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let expected = format!("opengeni-agent {version}");
    if output.status.success() && actual == expected {
        Ok(())
    } else {
        Err(UpdateError::HealthCheck(format!(
            "expected {expected:?}, got status {} and stdout {actual:?}",
            output.status
        )))
    }
}

/// Explicit overrides are singular. Otherwise every distinct enrolled deployment
/// is a candidate source; the pinned signing key, not the deployment, decides
/// which manifest/artifact is trusted.
fn resolve_update_bases(explicit: Option<&str>, connections: &[StoredConnection]) -> Vec<String> {
    if let Some(base) = explicit {
        return vec![base.trim_end_matches('/').to_string()];
    }
    let bases: BTreeSet<_> = connections
        .iter()
        // A pre-multi-connection credentials file did not persist its control-
        // plane origin. `load_connections` keeps the caller/default URL only as
        // a visibly unverified hint so the runtime transport remains usable.
        // Never turn that hint into update authority: on a private deployment it
        // is commonly the public default and would query the wrong server. The
        // public signed channel remains the safe fallback until one explicit
        // reconnect confirms the deployment origin.
        .filter(|connection| !connection.legacy_origin)
        .map(|connection| connection.api_url.trim_end_matches('/').to_string())
        .collect();
    if bases.is_empty() {
        vec![DEFAULT_BASE_URL.to_string()]
    } else {
        bases.into_iter().collect()
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

    #[test]
    fn update_sources_are_all_enrolled_deployments_and_deduplicated() {
        let mut a = connection("stable");
        a.api_url = "https://one.example/".to_string();
        let mut duplicate = connection("stable");
        duplicate.api_url = "https://one.example".to_string();
        let mut b = connection("stable");
        b.api_url = "https://two.example".to_string();
        assert_eq!(
            resolve_update_bases(None, &[a, duplicate, b]),
            vec![
                "https://one.example".to_string(),
                "https://two.example".to_string()
            ]
        );
    }

    #[test]
    fn explicit_update_source_wins_and_empty_store_uses_public_fallback() {
        assert_eq!(
            resolve_update_bases(Some("https://mirror.example/"), &[connection("stable")]),
            vec!["https://mirror.example".to_string()]
        );
        assert_eq!(
            resolve_update_bases(None, &[]),
            vec![DEFAULT_BASE_URL.to_string()]
        );
    }

    #[test]
    fn unverified_legacy_origin_is_never_an_update_source() {
        let mut legacy = connection("stable");
        legacy.api_url = "https://possibly-wrong.example".to_string();
        legacy.legacy_origin = true;

        assert_eq!(
            resolve_update_bases(None, &[legacy.clone()]),
            vec![DEFAULT_BASE_URL.to_string()]
        );
        assert_eq!(
            resolve_update_bases(Some("https://operator.example/"), &[legacy]),
            vec!["https://operator.example".to_string()]
        );
    }
}
