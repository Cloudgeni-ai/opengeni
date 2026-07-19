//! The `update` subcommand — check for and apply a signed self-update.
//!
//! Thin binary-side glue over [`opengeni_agent_update`]: resolve the channel +
//! base URL (from the enrolled credentials, overridable by flags/env), run the
//! verified [`check_update`](opengeni_agent_update::check_update), and on `--check`
//! just report; otherwise apply the verified bytes to the RUNNING executable on
//! Linux/Windows (atomic swap, incl. the Windows rename-self-aside) and ask for a
//! restart. macOS apply fails before mutation and requires a complete signed app
//! bundle reinstall.
//!
//! The actual download + minisign/sha256 verify + version gating + atomic swap +
//! rollback primitives live in `opengeni-agent-update` (cargo-unit-tested there);
//! this command only verifies and atomically swaps. It does not claim a boot
//! health gate that no restarted process currently executes.

use opengeni_agent_update::{check_update, CheckOutcome, HttpSource, UpdateConfig, UpdateError};
use tracing::{info, warn};

use crate::cli::UpdateArgs;
use crate::config::{self, DEFAULT_PUBLIC_ORIGIN};

/// The default release base URL when neither the flag/env nor an enrolled value is
/// present (mirrors the install scripts' default).
const DEFAULT_BASE_URL: &str = DEFAULT_PUBLIC_ORIGIN;

/// Runs the `update` subcommand.
///
/// # Errors
///
/// Returns a human-facing error string on any fetch/verify/apply failure.
pub fn run(args: &UpdateArgs) -> Result<(), String> {
    let creds =
        config::load_credentials().map_err(|e| format!("could not load credentials: {e}"))?;

    // Resolve channel + agent id from the enrolled creds when present; flags win.
    let (agent_id, enrolled_channel) = creds.as_ref().map_or_else(
        || ("unenrolled".to_string(), "stable".to_string()),
        |c| (c.agent_id.clone(), c.update_channel.clone()),
    );
    let channel = args.channel.clone().unwrap_or(enrolled_channel);
    let base_url = args.base_url.clone().unwrap_or_else(|| {
        creds
            .as_ref()
            .map_or_else(|| DEFAULT_BASE_URL.to_string(), |c| c.api_base_url.clone())
    });

    let current_version = env!("CARGO_PKG_VERSION");
    let config = UpdateConfig::new(base_url, channel, agent_id, current_version);
    config
        .validate_channel()
        .map_err(|e| format!("invalid update channel: {e}"))?;

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
                println!(
                    "{}",
                    check_only_next_step(std::env::consts::OS, &config.base_url)
                );
                return Ok(());
            }
            // Apply to the running executable (atomic swap + retained backup). The
            // current process cannot prove the next process booted: a foreground
            // user or their service manager must restart it. Do not advertise an
            // automatic health check/rollback that this command does not execute.
            let backup = pending
                .apply_running()
                .map_err(|e| apply_error_message(&e, &config.base_url))?;
            warn!(backup = %backup.display(), version = %pending.version, "update applied; restart to run the new binary");
            println!(
                "update applied (v{}). The prior binary is retained at {} as a manual \n\
                 rollback copy. Restart the foreground agent or its service manager to run the new version; this build does not perform an automatic post-restart health gate.",
                pending.version,
                backup.display()
            );
            Ok(())
        }
    }
}

fn check_only_next_step(target_os: &str, base_url: &str) -> String {
    if target_os == "macos" {
        return format!(
            "(--check) not applying. macOS requires a complete signed app-bundle reinstall: {}",
            macos_bundle_reinstall_command(base_url)
        );
    }
    "(--check) not applying. Run `opengeni-agent update` to install it.".to_string()
}

fn apply_error_message(error: &UpdateError, base_url: &str) -> String {
    if matches!(error, UpdateError::BundleReinstallRequired { .. }) {
        return format!(
            "failed to apply the update: {error}. Reinstall the whole verified bundle with {}",
            macos_bundle_reinstall_command(base_url)
        );
    }
    format!("failed to apply the update: {error}")
}

fn macos_bundle_reinstall_command(base_url: &str) -> String {
    let installer_url = format!("{}/install.sh", base_url.trim_end_matches('/'));
    format!(
        "`curl -fsSL {} | OPENGENI_INSTALL_REPLACE_APP=1 sh`",
        quote_posix(&installer_url)
    )
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_check_guidance_uses_the_real_installer_url_and_whole_bundle_flag() {
        assert_eq!(
            check_only_next_step("macos", "https://app.opengeni.ai/"),
            "(--check) not applying. macOS requires a complete signed app-bundle reinstall: `curl -fsSL 'https://app.opengeni.ai/install.sh' | OPENGENI_INSTALL_REPLACE_APP=1 sh`"
        );
    }

    #[test]
    fn macos_apply_error_is_actionable_and_never_suggests_binary_replacement() {
        let error = UpdateError::BundleReinstallRequired {
            path: "/Users/u/Applications/OpenGeni Agent.app/Contents/MacOS/opengeni-agent"
                .to_string(),
        };
        let message = apply_error_message(&error, "https://updates.example");
        assert!(message.contains("no files were changed"));
        assert!(message.contains("https://updates.example/install.sh"));
        assert!(message.contains("OPENGENI_INSTALL_REPLACE_APP=1"));
        assert!(!message.contains("replace Contents/MacOS"));
    }

    #[test]
    fn non_macos_check_guidance_preserves_binary_self_update() {
        assert_eq!(
            check_only_next_step("windows", "https://app.opengeni.ai"),
            "(--check) not applying. Run `opengeni-agent update` to install it."
        );
    }
}
