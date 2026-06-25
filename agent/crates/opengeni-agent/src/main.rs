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
//! * [`cli`] — the `run` / `enroll` / `service` (stub) surface.
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
mod supervisor;

use std::sync::Arc;

use clap::Parser as _;
use opengeni_agent_platform::{NativePlatform, Platform};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use cli::{Cli, Command, EnrollArgs, RunArgs, ServiceArgs};
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
        Command::Service(args) => {
            service_command(&args);
            Ok(())
        }
    }
}

/// The FOREGROUND `run` command: enroll-if-needed, then dial + serve until a
/// clean SIGINT/SIGTERM stops it.
async fn run(args: RunArgs, api_url: &str) -> anyhow_lite::Result {
    let platform = Arc::new(NativePlatform::new());

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
        };
        enroll_command(enroll_args, api_url).await?
    };

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

/// The `service` command — a structured stub until the per-OS `ServiceManager`
/// lands in M11 (dossier §23.1). It parses + prints an honest message and exits
/// non-fatally so scripts can probe the surface.
fn service_command(args: &ServiceArgs) {
    let action = args.action.label();
    warn!(
        action,
        "`service` is an opt-in daemon path not yet implemented (M11)"
    );
    println!(
        "opengeni-agent service {action}: the opt-in always-on service is not yet implemented (M11).\n\
         The default, supported run model is FOREGROUND: `opengeni-agent run`."
    );
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
