//! The `uninstall` subcommand — stop any service, remove credentials (with
//! `--purge`), and deactivate the enrollment.
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
        println!("opengeni-agent fully uninstalled (credentials purged).");
    } else {
        println!(
            "opengeni-agent service removed. Credentials kept (re-install to reconnect); \n\
             pass --purge to remove them and deactivate the enrollment."
        );
    }
    Ok(())
}
