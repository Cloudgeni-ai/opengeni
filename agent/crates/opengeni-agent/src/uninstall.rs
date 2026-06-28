//! The `uninstall` subcommand — stop any service, remove credentials (with
//! `--purge`), and deactivate the enrollment.
//!
//! The binary-level uninstall complements the `uninstall.sh` script: the script
//! calls `opengeni-agent service uninstall` + `opengeni-agent uninstall --purge`.
//! Here we tear down the service (best-effort) and, only with `--purge`, delete the
//! persisted credentials so a re-install reconnects by default (no forced
//! re-enroll). Deactivating the enrollment with the control plane is the M5
//! enrollment seam; until that round-trip is wired we delete the local creds and
//! log the intent so the dashboard reconciler removes the ghost on its next sweep.

use tracing::info;

use crate::cli::{ServiceAction, ServiceArgs, ServiceScopeArgs, UninstallArgs};
use crate::config;

/// Runs the `uninstall` subcommand.
///
/// # Errors
///
/// Returns a human-facing error string if a filesystem op fails.
pub fn run(args: &UninstallArgs) -> Result<(), String> {
    // Best-effort: stop + remove any opt-in service first.
    let service_args = ServiceArgs {
        action: ServiceAction::Uninstall(ServiceScopeArgs { system: false }),
    };
    if let Err(e) = crate::service::run(&service_args) {
        info!(error = %e, "no service to uninstall (or already removed)");
    }

    if args.purge {
        match config::config_dir() {
            Ok(dir) => {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)
                        .map_err(|e| format!("could not remove {}: {e}", dir.display()))?;
                    println!("removed credentials at {}.", dir.display());
                }
                info!("purge requested: the enrollment will be deactivated on the next control-plane reconcile");
            }
            Err(e) => return Err(format!("could not resolve the config dir: {e}")),
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
