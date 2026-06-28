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

use opengeni_agent_update::{check_update, CheckOutcome, HttpSource, UpdateConfig};
use tracing::{info, warn};

use crate::cli::UpdateArgs;
use crate::config;

/// The default release base URL when neither the flag/env nor an enrolled value is
/// present (mirrors the install scripts' default).
const DEFAULT_BASE_URL: &str = "https://get.opengeni.ai";

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
