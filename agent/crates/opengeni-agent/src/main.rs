//! The OpenGeni self-hosted agent binary.
//!
//! Run your own machine as a first-class OpenGeni sandbox. After a one-time
//! device-flow enrollment the agent dials the OpenGeni control plane over NATS,
//! subscribes to a subject that IS its identity (`agent.<ws>.<id>.rpc`), and
//! answers control RPCs (exec / filesystem / git today; terminal + desktop
//! streams in M8) against the host — all with bulletproof, full-jitter reconnect
//! resiliency (dossier §10.6) and a clean SIGINT/SIGTERM going-offline (§23.0).
//!
//! # Architecture (M6)
//!
//! * [`enrollment`] — the device-flow client; **the single module owning the
//!   enrollment HTTP wire shape** (the M5 reconciliation seam).
//! * [`config`] — the config dir + persisted credentials (`0600`) + resume token.
//! * [`dispatch`] — the `ControlRequest` → [`Platform`](opengeni_agent_platform::Platform)
//!   → `ControlResponse` table; a handler error is a typed `AgentError`, never a
//!   panic.
//! * [`backoff`] — full-jitter exponential backoff (the resiliency headline).
//! * [`metrics`] — the heartbeat metrics sample (deepened in M10).
//! * [`supervisor`] — dial → serve → reconnect, forever, with heartbeats + the
//!   clean going-offline.
//! * [`cli`] — the `run` / `enroll` / `service` / `update` / `uninstall` surface.
//! * [`service`] — the opt-in always-on service install/uninstall/status glue.
//! * [`update`] — the `update` subcommand wiring the self-update crate.
//! * [`uninstall`] — the `uninstall` subcommand (remove binary/creds/enrollment).
//!
//! The DESKTOP + terminal/framebuffer STREAMS are M8: the
//! [`Platform`](opengeni_agent_platform::Platform) trait declares them and the
//! dispatch table routes them, but they return a typed not-yet-implemented error
//! today, leaving clean seams.

#![doc(html_root_url = "https://docs.rs/opengeni-agent")]

mod backoff;
mod cli;
mod config;
mod dispatch;
mod enrollment;
mod metrics;
mod service;
mod supervisor;
mod uninstall;
mod update;

use std::sync::Arc;

use clap::Parser as _;
use opengeni_agent_platform::{NativePlatform, Platform};
use opengeni_agent_stream::{RelayHub, RelayHubConfig};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use cli::{Cli, Command, EnrollArgs, RunArgs};
use config::StoredCredentials;
use enrollment::{EnrollmentOffer, EnrollmentRequest, InstallIdentity};
use supervisor::Supervisor;

/// The default control-plane API base URL when neither `--api-url` nor
/// `$OPENGENI_API_URL` is set.
const DEFAULT_API_URL: &str = "https://api.opengeni.ai";

/// Process entry point. Parses the CLI, initializes tracing, and dispatches to
/// the selected subcommand. Returns a non-zero exit code on a fatal error.
fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    init_tracing();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start the async runtime: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let result = runtime.block_on(dispatch_command(cli));
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            error!(error = %e, "agent exited with an error");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Initializes structured `tracing` from `$RUST_LOG` (default `info`). Secret
/// values are NEVER logged (dossier §10.6); only op labels, counts, and timings.
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,opengeni_agent=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

/// Routes a parsed CLI to its handler.
async fn dispatch_command(cli: Cli) -> anyhow_lite::Result {
    let api_url = cli
        .api_url
        .clone()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    match cli.command.unwrap_or_default() {
        Command::Run(args) => run(args, &api_url).await,
        Command::Enroll(args) => enroll_command(args, &api_url).await.map(|_| ()),
        Command::Service(args) => service::run(&args).map_err(string_err),
        Command::Update(args) => {
            // The updater is synchronous (download → verify → swap); run it on a
            // blocking thread so it never stalls the async runtime.
            tokio::task::spawn_blocking(move || update::run(&args))
                .await
                .map_err(to_boxed)?
                .map_err(string_err)
        }
        Command::Uninstall(args) => uninstall::run(&args).map_err(string_err),
    }
}

/// Wraps a human-facing error string into the boxed handler error.
fn string_err(message: String) -> anyhow_lite::BoxError {
    Box::<dyn std::error::Error + Send + Sync>::from(message)
}

/// The FOREGROUND `run` command: enroll-if-needed, then dial + serve until a
/// clean SIGINT/SIGTERM stops it.
async fn run(args: RunArgs, api_url: &str) -> anyhow_lite::Result {
    // Enroll if we have no persisted credentials yet ("enroll-if-needed").
    let creds = if let Some(creds) = config::load_credentials().map_err(to_boxed)? {
        info!(agent_id = %creds.agent_id, "loaded existing enrollment");
        creds
    } else {
        info!("no enrollment found; starting device-flow enrollment");
        let enroll_args = EnrollArgs {
            channel: args.channel.clone(),
            machine_name: args.machine_name.clone(),
            force: false,
            // A foreground `run` that needs to enroll honors a CI token if present
            // (so `OPENGENI_ENROLL_TOKEN … run` works), else the device flow.
            token: std::env::var("OPENGENI_ENROLL_TOKEN").ok(),
            non_interactive: false,
        };
        enroll_command(enroll_args, api_url).await?
    };

    // Opt-in Xvfb for a headless Linux box (`--virtual-desktop`). Held for the run
    // lifetime; dropping it (on stop) tears the virtual display down. Linux-only.
    let _virtual_desktop = maybe_spawn_virtual_desktop(&args);

    // Wire the relay stream hub so pty/desktop ops serve over the relay. The hub
    // presents the agent's enrollment-scoped relay token on channel registration.
    let hub = RelayHub::new(RelayHubConfig {
        workspace_id: creds.workspace_id.clone(),
        agent_id: creds.agent_id.clone(),
        relay_url: creds.relay_url.clone(),
        agent_token: creds.relay_token.clone(),
        allow_screen_control: creds.consented_screen_control,
    });
    // Build the platform with the relay registrar wired; its desktop backend is
    // (re)resolved against the now-present $DISPLAY (a real screen or the Xvfb one).
    let platform = Arc::new(NativePlatform::new().with_stream_registry(Arc::new(hub)));

    let supervisor = Supervisor::new(platform.clone(), creds, env!("CARGO_PKG_VERSION"));
    let shutdown = supervisor.shutdown_handle();

    // Wire SIGINT/SIGTERM to a clean shutdown so the lease flips offline
    // immediately (§23.0) rather than waiting on heartbeat dead-detect.
    spawn_signal_handler(shutdown);

    info!("agent online — press Ctrl-C to stop (the machine goes offline cleanly)");
    supervisor.run().await.map_err(to_boxed)?;
    info!("agent stopped");
    Ok(())
}

/// Spawns an Xvfb virtual framebuffer when `--virtual-desktop` is set on Linux,
/// returning the handle (held for the run lifetime). A spawn failure is logged but
/// non-fatal — the agent still runs, just headless (`display_unavailable`). On
/// non-Linux the flag is ignored.
#[cfg(target_os = "linux")]
fn maybe_spawn_virtual_desktop(
    args: &RunArgs,
) -> Option<opengeni_agent_platform::virtual_desktop::VirtualXvfb> {
    if !args.virtual_desktop {
        return None;
    }
    let (w, h) = parse_geometry(&args.virtual_geometry);
    match opengeni_agent_platform::virtual_desktop::VirtualXvfb::spawn(&args.virtual_display, w, h)
    {
        Ok(xvfb) => {
            info!(display = xvfb.display(), "spawned Xvfb virtual desktop");
            Some(xvfb)
        }
        Err(e) => {
            warn!(error = %e, "failed to spawn Xvfb; running headless (desktop unavailable)");
            None
        }
    }
}

/// Non-Linux stub: a virtual framebuffer is not the macOS/Windows model (the user's
/// real GUI session is the desktop), so the flag is a no-op.
#[cfg(not(target_os = "linux"))]
fn maybe_spawn_virtual_desktop(_args: &RunArgs) -> Option<()> {
    None
}

/// Parses a `WIDTHxHEIGHT` geometry string, defaulting to 1280x800 on a malformed
/// value.
#[cfg(target_os = "linux")]
fn parse_geometry(geometry: &str) -> (u32, u32) {
    let mut parts = geometry.split(['x', 'X']);
    let w = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1280);
    let h = parts.next().and_then(|s| s.parse().ok()).unwrap_or(800);
    (w, h)
}

/// The `enroll` command: drive the device flow, persist the credentials, and
/// return them (so `run` can chain straight into serving).
async fn enroll_command(
    args: EnrollArgs,
    api_url: &str,
) -> anyhow_lite::ResultOf<StoredCredentials> {
    // If already enrolled and not forced, reuse the existing credentials.
    if !args.force {
        if let Some(existing) = config::load_credentials().map_err(to_boxed)? {
            info!(agent_id = %existing.agent_id, "already enrolled; reusing credentials (pass --force to re-enroll)");
            return Ok(existing);
        }
    }

    // Non-interactive (CI/automation) enroll: a workspace-scoped token short-circuits
    // the device flow (dossier §23.1). The token→credentials exchange is the M5
    // enrollment endpoint; until that endpoint accepts a token here we refuse loudly
    // rather than fall back to a device flow that would hang an unattended install.
    if args.non_interactive || args.token.is_some() {
        let token = args.token.clone().ok_or_else(|| {
            string_err("--non-interactive requires --token (or $OPENGENI_ENROLL_TOKEN)".to_string())
        })?;
        return enroll_with_token(&args, api_url, &token);
    }

    let platform = NativePlatform::new();
    let identity = platform.host_identity();
    let machine_name = args
        .machine_name
        .clone()
        .unwrap_or_else(supervisor::hostname_or_default);

    let request = EnrollmentRequest {
        api_base_url: api_url.to_string(),
        machine_name,
        update_channel: args.channel.clone(),
        offer: EnrollmentOffer {
            os: identity.os,
            arch: identity.arch,
            // M6 has no live display surface yet (that is M8); offer false so the
            // consent page does not promise screen-control we cannot serve.
            offers_display: false,
        },
    };

    let install = InstallIdentity::generate();
    let creds_proto = enrollment::enroll(&request, &install, |pending| {
        // Print the device-flow prompt exactly once, loudly, for the human.
        println!();
        println!("  To authorize this machine, visit:");
        println!("      {}", pending.verification_uri);
        println!("  and enter the code:");
        println!("      {}", pending.user_code);
        if !pending.verification_uri_complete.is_empty() {
            println!(
                "  (or open directly: {})",
                pending.verification_uri_complete
            );
        }
        println!();
        println!("  Waiting for authorization...");
    })
    .await
    .map_err(to_boxed)?;

    let stored = StoredCredentials::from_proto(creds_proto, args.channel);
    let path = config::save_credentials(&stored).map_err(to_boxed)?;
    info!(agent_id = %stored.agent_id, path = %path.display(), "enrollment complete; credentials persisted");
    println!("Enrolled. This machine is now registered with OpenGeni.");
    Ok(stored)
}

/// Non-interactive token enrollment (the CI/automation path, dossier §23.1). The
/// token→credentials EXCHANGE is the M5 enrollment endpoint; the install scripts
/// pass `OPENGENI_ENROLL_TOKEN` and the CLI surface is stable, but the agent does
/// not fabricate credentials — until the token-exchange endpoint is wired it
/// returns a precise error so an unattended install fails loudly (never silently
/// falling back to a device flow that would hang). The `_api_url`/`_token` are
/// threaded so the reconciliation against the M5 endpoint is a one-function change.
fn enroll_with_token(
    args: &EnrollArgs,
    _api_url: &str,
    _token: &str,
) -> anyhow_lite::ResultOf<StoredCredentials> {
    warn!(
        channel = %args.channel,
        "non-interactive token enrollment requested; the token-exchange endpoint is the M5 enrollment seam"
    );
    Err(string_err(
        "non-interactive token enrollment is not yet wired to the control-plane \
         token-exchange endpoint (the M5 enrollment seam). Use the interactive \
         `opengeni-agent enroll` device flow, or set OPENGENI_API_URL to a control \
         plane exposing the token exchange."
            .to_string(),
    ))
}

/// Spawns a task that triggers a clean shutdown on SIGINT or (unix) SIGTERM.
fn spawn_signal_handler(shutdown: Arc<tokio::sync::Notify>) {
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        info!("received stop signal; shutting down cleanly");
        shutdown.notify_waiters();
    });
}

/// Resolves once an OS stop signal arrives (Ctrl-C everywhere; SIGTERM on unix).
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "could not install SIGTERM handler; relying on Ctrl-C only");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Converts any `std::error::Error` into the boxed error our handlers return.
fn to_boxed<E: std::error::Error + Send + Sync + 'static>(e: E) -> anyhow_lite::BoxError {
    Box::new(e)
}

/// A tiny local error-alias module so the binary needs no `anyhow` dependency:
/// handlers return `Result<(), Box<dyn Error>>`. (We keep our own typed errors at
/// the module boundaries; this is only the top-level glue.)
mod anyhow_lite {
    /// A boxed, thread-safe error.
    pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;
    /// The handler result returning `()`.
    pub type Result = std::result::Result<(), BoxError>;
    /// A handler result returning a value.
    pub type ResultOf<T> = std::result::Result<T, BoxError>;
}
