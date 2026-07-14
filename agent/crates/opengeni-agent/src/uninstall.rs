//! The `uninstall` subcommand — stop any service, remove credentials (with
//! `--purge`), and deactivate the enrollment. A direct invocation cannot delete
//! its currently running executable; the installer uninstaller removes that file
//! after this process exits.
//!
//! The binary-level uninstall complements the `uninstall.sh` script: the script
//! calls `opengeni-agent service uninstall` + `opengeni-agent uninstall --purge`.
//! Here we tear down the service (best-effort) and, only with `--purge`, revoke
//! remotely before deleting the persisted credentials. A failed/ambiguous revoke
//! preserves local state so the human can safely retry.

use tracing::info;

use crate::cli::{ServiceAction, ServiceArgs, ServiceScopeArgs, UninstallArgs};
use crate::config;
use crate::enrollment;

/// Runs the `uninstall` subcommand.
///
/// # Errors
///
/// Returns a human-facing error string if a filesystem op fails.
pub async fn run(args: &UninstallArgs, api_url_override: Option<&str>) -> Result<(), String> {
    let retained_binary = std::env::current_exe().map_or_else(
        |_| "the currently running opengeni-agent executable".to_string(),
        |path| path.display().to_string(),
    );

    // Best-effort: stop + remove any opt-in service first.
    let service_args = ServiceArgs {
        action: ServiceAction::Uninstall(ServiceScopeArgs { system: false }),
    };
    if let Err(e) = crate::service::run(&service_args) {
        info!(error = %e, "no service to uninstall (or already removed)");
    }

    if args.purge {
        let dir =
            config::config_dir().map_err(|e| format!("could not resolve the config dir: {e}"))?;
        if args.local_only {
            eprintln!(
                "WARNING: --local-only deletes local state without remote revoke; the dashboard enrollment may remain active."
            );
        } else if let Some(creds) = config::load_credentials()
            .map_err(|e| format!("could not load credentials; nothing was deleted: {e}"))?
        {
            let api_url = api_url_override.unwrap_or(&creds.api_base_url);
            enrollment::revoke_self(api_url, &creds.nats_bearer)
                .await
                .map_err(|e| {
                    format!("remote revoke was not confirmed; local credentials were retained: {e}")
                })?;
            info!(agent_id = %creds.agent_id, "remote enrollment revoke confirmed");
        } else {
            // No local bearer means there is nothing this agent can authenticate as.
            // It is safe to clear any remaining local directory after informing the
            // human that a dashboard record cannot be independently confirmed.
            eprintln!("no stored enrollment credentials found; deleting local state only");
        }
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("could not remove {}: {e}", dir.display()))?;
            println!("removed local credentials at {}.", dir.display());
        }
        println!("{}", uninstall_summary(true, &retained_binary));
    } else {
        println!("{}", uninstall_summary(false, &retained_binary));
    }
    Ok(())
}

fn uninstall_summary(purge: bool, retained_binary: &str) -> String {
    let state = if purge {
        "service cleanup attempted and local credentials purged"
    } else {
        "service cleanup attempted; credentials kept so a reinstall can reconnect (pass --purge to remove them and deactivate the enrollment)"
    };
    format!(
        "opengeni-agent {state}. This direct command retained the running executable at {retained_binary}; run the installer uninstaller or remove that file after the process exits."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_uninstall_never_claims_the_retained_binary_was_removed() {
        let path = "/home/u/.local/bin/opengeni-agent";
        for purge in [false, true] {
            let summary = uninstall_summary(purge, path);
            assert!(summary.contains("retained the running executable"));
            assert!(summary.contains(path));
            assert!(!summary.contains("fully uninstalled"));
        }
    }

    #[test]
    fn purge_summary_distinguishes_state_cleanup_from_executable_removal() {
        let summary = uninstall_summary(true, "opengeni-agent.exe");
        assert!(summary.contains("service cleanup attempted"));
        assert!(summary.contains("local credentials purged"));
        assert!(!summary.contains("enrollment state removed"));
        assert!(summary.contains("remove that file after the process exits"));
    }
}
