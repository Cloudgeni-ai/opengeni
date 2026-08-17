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
use std::io::Write as _;

use opengeni_agent_update::{
    check_update_manifest, finalize_update, HttpSource, ManifestCheckOutcome, UpdateConfig,
    UpdateError, UpdateResult,
};
use semver::Version;
use tracing::{info, warn};

use crate::cli::UpdateArgs;
use crate::config::{self, StoredConnection};
use crate::enrollment::InstallIdentity;
use crate::DEFAULT_API_URL;

/// Public fallback used only before the machine has any enrolled deployment.
const DEFAULT_BASE_URL: &str = "https://get.opengeni.ai";
const COMPLETED_UPDATE_RECEIPT_FILE: &str = "completed-update.json";

/// Non-secret durable proof that the exact control-plane operation installed a
/// signed artifact and passed its startup preflight. The successor repeats this
/// in Hello until a later successful update atomically replaces the receipt.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct CompletedUpdateReceipt {
    pub operation_id: String,
    pub target_version: String,
    pub binary_sha256: String,
}

/// Read and validate the most recent completed managed-update proof.
pub fn load_completed_update_receipt() -> Result<Option<CompletedUpdateReceipt>, String> {
    let dir = config::config_dir().map_err(|_| "config_dir_unavailable".to_string())?;
    load_completed_update_receipt_at(&dir)
}

fn load_completed_update_receipt_at(
    dir: &std::path::Path,
) -> Result<Option<CompletedUpdateReceipt>, String> {
    let path = dir.join(COMPLETED_UPDATE_RECEIPT_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("update_receipt_read_failed".to_string()),
    };
    let receipt: CompletedUpdateReceipt =
        serde_json::from_slice(&bytes).map_err(|_| "update_receipt_invalid".to_string())?;
    validate_completed_update_receipt(&receipt)?;
    Ok(Some(receipt))
}

fn validate_completed_update_receipt(receipt: &CompletedUpdateReceipt) -> Result<(), String> {
    if uuid::Uuid::parse_str(&receipt.operation_id).is_err()
        || Version::parse(&receipt.target_version).is_err()
        || receipt.binary_sha256.len() != 64
        || !receipt
            .binary_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("update_receipt_invalid".to_string());
    }
    Ok(())
}

fn persist_completed_update_receipt(receipt: &CompletedUpdateReceipt) -> Result<(), String> {
    let dir = config::config_dir().map_err(|_| "config_dir_unavailable".to_string())?;
    persist_completed_update_receipt_at(&dir, receipt)
}

fn persist_completed_update_receipt_at(
    dir: &std::path::Path,
    receipt: &CompletedUpdateReceipt,
) -> Result<(), String> {
    validate_completed_update_receipt(receipt)?;
    std::fs::create_dir_all(dir).map_err(|_| "update_receipt_persist_failed".to_string())?;
    let path = dir.join(COMPLETED_UPDATE_RECEIPT_FILE);
    let temporary = dir.join(format!(
        ".{COMPLETED_UPDATE_RECEIPT_FILE}.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let body = serde_json::to_vec(receipt).map_err(|_| "update_receipt_invalid".to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "update_receipt_persist_failed".to_string())?;
    if file
        .write_all(&body)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err("update_receipt_persist_failed".to_string());
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, &path) {
        #[cfg(windows)]
        if matches!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
        ) && path.exists()
        {
            std::fs::remove_file(&path)
                .and_then(|()| std::fs::rename(&temporary, &path))
                .map_err(|_| "update_receipt_persist_failed".to_string())?;
            return Ok(());
        }
        let _ = error;
        let _ = std::fs::remove_file(&temporary);
        return Err("update_receipt_persist_failed".to_string());
    }
    Ok(())
}

/// Runs the `update` subcommand.
///
/// # Errors
///
/// Returns a human-facing error string on any fetch/verify/apply failure.
pub fn run(args: &UpdateArgs) -> Result<(), String> {
    let legacy_api_url =
        std::env::var("OPENGENI_API_URL").unwrap_or_else(|_| DEFAULT_API_URL.to_string());
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

/// Result of an explicitly requested control-plane update. The digest is the
/// artifact sha256 from the verified signed manifest and is echoed in progress;
/// the control plane requires the successor Hello to report it before success.
#[derive(Debug, Clone)]
pub struct ManagedUpdateResult {
    /// Lowercase sha256 pinned by the signed manifest.
    pub expected_sha256: String,
}

#[derive(Debug, Clone, Copy)]
pub enum ManagedUpdatePhase {
    Downloading,
    Verifying,
    Applying,
}

/// Applies one exact signed release from one deployment origin. This is the same
/// updater as the local CLI, narrowed by the control-plane request: the signed
/// manifest must offer exactly `target_version`, then artifact minisign+sha256,
/// atomic swap, startup health-gate, and rollback all run unchanged.
pub fn apply_managed(
    operation_id: &str,
    base_url: &str,
    channel: &str,
    target_version: &str,
    mut progress: impl FnMut(ManagedUpdatePhase),
) -> Result<ManagedUpdateResult, String> {
    if uuid::Uuid::parse_str(operation_id).is_err() {
        return Err("invalid_update_operation".to_string());
    }
    if !matches!(channel, "stable" | "beta") {
        return Err("unsupported_update_channel".to_string());
    }
    Version::parse(target_version).map_err(|_| "invalid_target_version".to_string())?;
    let install_identity = InstallIdentity::load_or_generate(
        &config::config_dir().map_err(|_| "config_dir_unavailable".to_string())?,
    )
    .map_err(|_| "install_identity_unavailable".to_string())?;
    let source = HttpSource::new().map_err(|_| "update_transport_unavailable".to_string())?;
    let mut config = UpdateConfig::new(
        base_url.trim_end_matches('/'),
        channel,
        install_identity.public_key_base64(),
        env!("CARGO_PKG_VERSION"),
    );
    // This path exists only after an authorized human/control-plane request.
    // Manual opt-in may cross a staged rollout boundary and may re-pin the same
    // version after a failed/rolled-back attempt; signature, digest, target,
    // monotonic-version, atomic-apply, health-gate, and rollback checks remain.
    config.allow_staged_rollout_opt_in = true;
    config.allow_same_version = true;
    let plan = match check_update_manifest(&source, &config) {
        Ok(ManifestCheckOutcome::Available(plan)) => plan,
        Ok(ManifestCheckOutcome::UpToDate(_)) => return Err("target_not_offered".to_string()),
        Err(_) => return Err("manifest_verification_failed".to_string()),
    };
    if plan.version != target_version {
        return Err("target_manifest_mismatch".to_string());
    }
    let expected_sha256 = plan.expected_sha256().to_string();
    progress(ManagedUpdatePhase::Downloading);
    let pending = plan
        .download(&source)
        .map_err(|_| "artifact_verification_failed".to_string())?;
    progress(ManagedUpdatePhase::Verifying);
    let install_path =
        std::env::current_exe().map_err(|_| "installed_binary_unavailable".to_string())?;
    progress(ManagedUpdatePhase::Applying);
    pending
        .apply_running()
        .map_err(|_| "atomic_apply_failed".to_string())?;
    let health = verify_installed_binary(&install_path, &pending.version);
    if let Err(error) = health {
        finalize_update(&install_path, Err(error))
            .map_err(|_| "startup_preflight_failed_rolled_back".to_string())?;
    }
    let receipt = CompletedUpdateReceipt {
        operation_id: operation_id.to_string(),
        target_version: pending.version.clone(),
        binary_sha256: expected_sha256.clone(),
    };
    if let Err(error_code) = persist_completed_update_receipt(&receipt) {
        finalize_update(
            &install_path,
            Err(UpdateError::HealthCheck(error_code.clone())),
        )
        .map_err(|_| "update_receipt_persist_failed_rolled_back".to_string())?;
    }
    // Once the new binary and its durable receipt are verified, failure to
    // delete the rollback backup is cleanup debt—not a failed installation.
    if let Err(error) = finalize_update(&install_path, Ok(())) {
        warn!(%error, "verified update is live; stale rollback backup cleanup failed");
    }
    Ok(ManagedUpdateResult { expected_sha256 })
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
    fn completed_update_receipt_is_atomic_replaceable_and_validated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = CompletedUpdateReceipt {
            operation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            target_version: "1.2.3".to_string(),
            binary_sha256: "ab".repeat(32),
        };
        persist_completed_update_receipt_at(dir.path(), &first).expect("persist first");
        assert_eq!(
            load_completed_update_receipt_at(dir.path()).expect("load first"),
            Some(first)
        );

        let second = CompletedUpdateReceipt {
            operation_id: "00000000-0000-4000-8000-000000000002".to_string(),
            target_version: "1.2.4-beta.1".to_string(),
            binary_sha256: "cd".repeat(32),
        };
        persist_completed_update_receipt_at(dir.path(), &second).expect("replace");
        assert_eq!(
            load_completed_update_receipt_at(dir.path()).expect("load replacement"),
            Some(second)
        );

        std::fs::write(dir.path().join(COMPLETED_UPDATE_RECEIPT_FILE), b"{}").expect("corrupt");
        assert_eq!(
            load_completed_update_receipt_at(dir.path()).expect_err("invalid receipt"),
            "update_receipt_invalid"
        );
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
