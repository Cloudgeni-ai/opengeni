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
//! * [`status`] — local enrollment + authenticated control-plane reachability.
//! * [`dispatch`] — the `ControlRequest` → [`Platform`](opengeni_agent_platform::Platform)
//!   → `ControlResponse` table; a handler error is a typed `AgentError`, never a
//!   panic.
//! * [`backoff`] — full-jitter exponential backoff (the resiliency headline).
//! * [`job`] — the op-stream job pump: one task per op, streaming a contained
//!   child through the engine's retention/credit-flow to an injected frame sink.
//! * [`metrics`] — the heartbeat metrics sample (deepened in M10).
//! * [`supervisor`] — dial → serve → reconnect, forever, with heartbeats + the
//!   clean going-offline.
//! * [`cli`] — the `run` / `enroll` / `service` / `update` / `uninstall` surface.
//! * [`service`] — the opt-in always-on service install/uninstall/status glue.
//! * [`update`] — the `update` subcommand wiring the self-update crate.
//! * [`uninstall`] — the `uninstall` subcommand (attempt service cleanup and,
//!   with `--purge`, request remote deactivation before removing local credentials,
//!   unless explicitly local-only; retain the running executable for the installer
//!   uninstaller to delete after exit).
//!
//! The DESKTOP + terminal/framebuffer STREAMS are M8: the
//! [`Platform`](opengeni_agent_platform::Platform) trait declares them and the
//! dispatch table routes them, but they return a typed not-yet-implemented error
//! today, leaving clean seams.

#![doc(html_root_url = "https://docs.rs/opengeni-agent")]

mod backoff;
mod capacity;
mod cli;
mod config;
mod dispatch;
mod engine;
mod enrollment;
mod instance_lock;
mod job;
mod legacy;
mod metrics;
mod ops;
mod overrides;
mod service;
mod status;
mod supervisor;
mod uninstall;
mod update;

use std::sync::Arc;
use std::time::Duration;

use clap::{CommandFactory as _, Parser as _};
use opengeni_agent_platform::{NativePlatform, Platform};
use opengeni_agent_stream::{RelayHub, RelayHubConfig};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use cli::{Cli, Command, EnrollArgs, RunArgs};
use config::{SharedCredentials, StoredCredentials, DEFAULT_PUBLIC_ORIGIN};
use enrollment::{EnrollmentOffer, EnrollmentRequest, InstallIdentity};
use supervisor::Supervisor;

/// The default control-plane API base URL when neither `--api-url` nor
/// `$OPENGENI_API_URL` is set.
const DEFAULT_API_URL: &str = DEFAULT_PUBLIC_ORIGIN;
/// Refresh short-lived credentials this far before their absolute expiry.
const CREDENTIAL_REFRESH_LEAD_SECONDS: u64 = 60;
/// A deployment with no relay producer-token plane is rechecked periodically so
/// enabling it does not require re-enrollment or an agent restart.
const DISABLED_RELAY_RECHECK: Duration = Duration::from_secs(5 * 60);
/// A successful legacy response that still omits required expiry metadata must
/// not create a tight success loop. Retry soon, but with a fixed floor.
const LEGACY_REFRESH_RECHECK: Duration = Duration::from_secs(30);
/// Failure retries use full jitter, but never spin on a zero-length draw.
const MIN_REFRESH_FAILURE_DELAY: Duration = Duration::from_millis(250);

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
    let api_url = cli.api_url.clone();
    let Some(command) = cli.command else {
        // No subcommand. This is reached BOTH by a bare `opengeni-agent` in a
        // terminal AND by a Finder/Raycast/`open` launch of the .app bundle, which
        // execs the binary with no args and no controlling TTY. A blind
        // enroll-if-needed-then-serve (the old `Command::default()` = `run`) turns
        // that GUI launch into a headless process with no visible UI — which
        // LaunchServices reports as "the application does not respond" and which,
        // when not yet enrolled, drops into an invisible device-flow that can never
        // show its user code. So branch on enrollment: a double-click of an ENROLLED
        // machine starts the agent (the nicest outcome), and an un-enrolled one
        // prints usage and exits promptly — never a zombie.
        return run_default(api_url.as_deref()).await;
    };
    match command {
        Command::Run(args) => run(args, api_url.as_deref()).await,
        Command::Enroll(args) => {
            enroll_command(args, api_url.as_deref().unwrap_or(DEFAULT_API_URL))
                .await
                .map(|_| ())
        }
        Command::Status(args) => status::run(&args).await.map_err(string_err),
        Command::Service(args) => service::run(&args).map_err(string_err),
        Command::Update(args) => {
            // The updater is synchronous (download → verify → swap); run it on a
            // blocking thread so it never stalls the async runtime.
            tokio::task::spawn_blocking(move || update::run(&args))
                .await
                .map_err(to_boxed)?
                .map_err(string_err)
        }
        Command::Uninstall(args) => uninstall::run(&args, api_url.as_deref())
            .await
            .map_err(string_err),
    }
}

/// Handles a bare `opengeni-agent` invocation (no subcommand) so a GUI launch of
/// the .app bundle NEVER hangs as a headless zombie (dossier §23.0; the
/// REPLACE_APP incident). Finder/Raycast/`open` exec the binary with no args and
/// no TTY:
///   * already enrolled → behave exactly like `run` (a double-click starts the
///     agent — the nicest outcome; it serves deliberately until stopped);
///   * not enrolled (or credentials unreadable) → print usage to stderr and exit 0
///     promptly, rather than dropping into an invisible device-flow enroll that
///     needs a workspace id + a visible TTY and would otherwise appear to hang.
async fn run_default(api_url: Option<&str>) -> anyhow_lite::Result {
    if let Ok(Some(_)) = config::load_credentials() {
        run(RunArgs::default(), api_url).await
    } else {
        // Not enrolled (or creds unreadable): show how to get started and exit
        // cleanly. Help goes to stderr so a `opengeni-agent | …` pipe is unchanged.
        eprintln!("{}", Cli::command().render_help());
        eprintln!(
            "This machine is not enrolled yet. Run `opengeni-agent enroll` (see the \
             Machines page for the one-liner), then `opengeni-agent run`."
        );
        Ok(())
    }
}

/// Wraps a human-facing error string into the boxed handler error.
fn string_err(message: String) -> anyhow_lite::BoxError {
    Box::<dyn std::error::Error + Send + Sync>::from(message)
}

/// The FOREGROUND `run` command: enroll-if-needed, then dial + serve until a
/// clean SIGINT/SIGTERM stops it.
async fn run(args: RunArgs, api_url_override: Option<&str>) -> anyhow_lite::Result {
    // Single-instance guard, taken FIRST (before enroll-if-needed or any dial): an
    // enrolled agent's NATS subject IS its identity, so two `run` processes on one
    // machine become duplicate control-RPC responders + heartbeat publishers and
    // ops route nondeterministically. This was seen live twice — a Finder/Raycast
    // run-by-default racing a terminal `run`. Held for the whole process lifetime
    // (dropped when `run` returns), and by the OS when the process exits, so a
    // crashed holder self-heals. Covers BOTH explicit `run` and run-by-default,
    // since both land here; `enroll`/`service`/`update`/`uninstall` do NOT lock.
    let _instance_lock: Option<instance_lock::InstanceLock> = match instance_lock::acquire() {
        Ok(lock) => Some(lock),
        Err(instance_lock::LockError::Contended { holder_pid }) => {
            let pid = holder_pid.map_or_else(|| "unknown".to_owned(), |p| p.to_string());
            // A launcher double-click of an already-running agent is a no-op, not an
            // error: print a clear line and exit 0 (SUCCESS) rather than a failure.
            eprintln!("opengeni-agent is already running (pid {pid}) — this instance will exit");
            return Ok(());
        }
        Err(e) => {
            // Fail-open: the guard is a safety net, not a hard gate. If the lock
            // file cannot be created/locked (unusual — same dir as credentials),
            // warn and continue rather than refuse to start.
            warn!(error = %e, "could not acquire the single-instance lock; continuing without it");
            None
        }
    };

    // macOS: request the Screen Recording + Accessibility grants ONCE so a
    // display-capable Mac can probe + advertise its display (the supervisor's
    // per-connect `capabilities()` re-probe then reflects a freshly-granted
    // display). A denied/pending grant degrades cleanly to `display_unavailable`
    // and never blocks the serve loop. No-op on every non-macOS / feature-off build.
    ensure_macos_desktop_grants();

    // Enroll if we have no persisted credentials yet ("enroll-if-needed").
    let creds = if let Some(creds) = config::load_credentials().map_err(to_boxed)? {
        info!(agent_id = %creds.agent_id, "loaded existing enrollment");
        creds
    } else {
        info!("no enrollment found; starting device-flow enrollment");
        let enroll_args = EnrollArgs {
            channel: args.channel.clone(),
            workspace_id: args.workspace_id.clone(),
            machine_name: args.machine_name.clone(),
            force: false,
            // A foreground `run` that needs to enroll honors a CI token if present
            // (so `OPENGENI_ENROLL_TOKEN … run` works), else the device flow.
            token: std::env::var("OPENGENI_ENROLL_TOKEN").ok(),
            non_interactive: false,
        };
        enroll_command(enroll_args, api_url_override.unwrap_or(DEFAULT_API_URL)).await?
    };

    // Establish per-op OOM cgroup isolation (issue #345) BEFORE spawning any
    // agent-infra child (e.g. Xvfb below): the startup dance moves the agent into a
    // `supervisor` cgroup leaf, so children spawned afterward inherit that leaf and
    // only host execs land in their own per-op memory leaves. Returns None (a
    // logged, graceful no-op) off a delegated Linux cgroup v2 host — the agent then
    // serves exactly as before, with no per-op isolation.
    let op_cgroups = opengeni_agent_platform::establish_oom_isolation(
        opengeni_agent_platform::OpCgroupConfig::from_env(),
    );

    // Opt-in Xvfb for a headless Linux box (`--virtual-desktop`). Held for the run
    // lifetime; dropping it (on stop) tears the virtual display down. Linux-only.
    let _virtual_desktop = maybe_spawn_virtual_desktop(&args);

    let shared_credentials = SharedCredentials::new(creds);
    let initial_credentials = shared_credentials.snapshot();

    // Wire the relay stream hub so pty/desktop ops serve over the relay. The hub
    // presents the agent's enrollment-scoped relay token on channel registration.
    let hub = RelayHub::new(RelayHubConfig {
        workspace_id: initial_credentials.workspace_id.clone(),
        agent_id: initial_credentials.agent_id.clone(),
        relay_url: initial_credentials.relay_url.clone(),
        agent_token: initial_credentials.relay_token.clone(),
        allow_screen_control: initial_credentials.consented_screen_control,
    });
    // Build the platform with the relay registrar wired; its desktop backend is
    // (re)resolved against the now-present $DISPLAY (a real screen or the Xvfb one).
    // Wire the per-op cgroup manager in when the startup dance established one.
    let mut platform = NativePlatform::new().with_stream_registry(Arc::new(hub.clone()));
    if let Some(cgroups) = op_cgroups {
        platform = platform.with_oom_isolation(cgroups);
    }
    let platform = Arc::new(platform);

    // The engine's disk spool lives under the config dir — a real filesystem
    // (a tmpfs temp dir would spool "to disk" in RAM and defeat the budgets).
    let supervisor = match config::config_dir() {
        Ok(dir) => Supervisor::with_shared_credentials(
            platform.clone(),
            shared_credentials.clone(),
            env!("CARGO_PKG_VERSION"),
        )
        .with_spool_root(dir.join("spool")),
        Err(_) => Supervisor::with_shared_credentials(
            platform.clone(),
            shared_credentials.clone(),
            env!("CARGO_PKG_VERSION"),
        ),
    };
    let shutdown = supervisor.shutdown_handle();

    // The recovery bearer rotates the short-lived relay producer token and the
    // NATS auth material in place. Persistence happens before either live source
    // is published, so disk remains authoritative across a crash.
    let refresh_task = tokio::spawn(credential_refresh_loop(
        shared_credentials,
        hub,
        shutdown.clone(),
    ));

    // Wire SIGINT/SIGTERM to a clean shutdown so the lease flips offline
    // immediately (§23.0) rather than waiting on heartbeat dead-detect.
    spawn_signal_handler(shutdown);

    info!("agent online — press Ctrl-C to stop (the machine goes offline cleanly)");
    let result = supervisor.run().await.map_err(to_boxed);
    refresh_task.abort();
    let _ = refresh_task.await;
    result?;
    info!("agent stopped");
    Ok(())
}

/// Keeps server-issued credentials fresh for the lifetime of the supervisor.
/// Every iteration snapshots without holding the lock across an await. A refresh
/// is published only after exact identity/consent validation and durable atomic
/// persistence; every failure retains the previous working snapshot.
async fn credential_refresh_loop(
    shared: SharedCredentials,
    hub: RelayHub,
    shutdown: supervisor::ShutdownSignal,
) {
    let mut backoff = backoff::Backoff::standard();
    loop {
        if shutdown.is_requested() {
            return;
        }

        let current = shared.snapshot();
        let delay = credential_refresh_delay(&current, unix_now_seconds());
        if !delay.is_zero() && sleep_or_shutdown(&shutdown, delay).await {
            return;
        }
        if shutdown.is_requested() {
            return;
        }

        // Re-snapshot after the wait: another local publisher may have rotated the
        // value while this task slept. This clone is the exact validation base.
        let current = shared.snapshot();
        if current.nats_bearer.is_empty() {
            warn!("credential refresh unavailable: enrollment bearer is empty");
            if sleep_refresh_failure(&shutdown, &mut backoff).await {
                return;
            }
            continue;
        }

        let refreshed = tokio::select! {
            biased;
            () = shutdown.notified() => return,
            result = enrollment::refresh_self(&current.api_base_url, &current.nats_bearer) => result,
        };
        let refreshed = match refreshed {
            Ok(credentials) => credentials,
            Err(error) => {
                warn!(error = %error, "credential refresh failed; retaining previous credentials");
                if sleep_refresh_failure(&shutdown, &mut backoff).await {
                    return;
                }
                continue;
            }
        };
        let candidate = match current.refreshed_candidate(refreshed) {
            Ok(candidate) => candidate,
            Err(error) => {
                error!(error = %error, "credential refresh failed validation; retaining previous credentials");
                if sleep_refresh_failure(&shutdown, &mut backoff).await {
                    return;
                }
                continue;
            }
        };
        if let Err(error) = config::save_credentials(&candidate) {
            error!(error = %error, "credential refresh could not be persisted; retaining previous credentials");
            if sleep_refresh_failure(&shutdown, &mut backoff).await {
                return;
            }
            continue;
        }

        let relay_url = candidate.relay_url.clone();
        let relay_token = candidate.relay_token.clone();
        let allow_screen_control = candidate.consented_screen_control;
        let needs_legacy_floor = credential_refresh_delay(&candidate, unix_now_seconds()).is_zero();
        shared.publish_persisted(candidate);
        hub.update_credentials(relay_url, relay_token, allow_screen_control);
        backoff.reset();
        info!("refreshed and durably published enrollment credentials");

        if needs_legacy_floor && sleep_or_shutdown(&shutdown, LEGACY_REFRESH_RECHECK).await {
            return;
        }
    }
}

/// Computes when the next refresh should start from absolute expiry metadata.
/// A zero expiry on a present credential is legacy and refreshes immediately. An
/// empty relay token plus zero expiry is an intentionally disabled plane, which is
/// rechecked periodically instead of spinning.
fn credential_refresh_delay(creds: &StoredCredentials, now_unix_seconds: u64) -> Duration {
    let bearer = refresh_delay_for_expiry(creds.bearer_expires_at_unix_seconds, now_unix_seconds);
    let relay = if creds.relay_token.is_empty() && creds.relay_token_expires_at_unix_seconds == 0 {
        DISABLED_RELAY_RECHECK
    } else {
        refresh_delay_for_expiry(creds.relay_token_expires_at_unix_seconds, now_unix_seconds)
    };
    bearer.min(relay)
}

fn refresh_delay_for_expiry(expires_at: u64, now: u64) -> Duration {
    if expires_at == 0 {
        return Duration::ZERO;
    }
    Duration::from_secs(
        expires_at
            .saturating_sub(now)
            .saturating_sub(CREDENTIAL_REFRESH_LEAD_SECONDS),
    )
}

async fn sleep_refresh_failure(
    shutdown: &supervisor::ShutdownSignal,
    backoff: &mut backoff::Backoff,
) -> bool {
    let delay = backoff.next_delay().max(MIN_REFRESH_FAILURE_DELAY);
    warn!(
        attempt = backoff.attempt(),
        delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        "retrying credential refresh after backoff"
    );
    sleep_or_shutdown(shutdown, delay).await
}

async fn sleep_or_shutdown(shutdown: &supervisor::ShutdownSignal, duration: Duration) -> bool {
    if shutdown.is_requested() {
        return true;
    }
    tokio::select! {
        biased;
        () = shutdown.notified() => true,
        () = tokio::time::sleep(duration) => shutdown.is_requested(),
    }
}

fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
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

/// Probes whether this host currently has a usable display surface (a real X11
/// screen or an Xvfb virtual framebuffer), the value advertised as the offer's
/// `offers_display` at enroll. Mirrors how [`Supervisor::capabilities`] derives the
/// `desktop` capability: `probe()` does a synchronous x11rb connect, so run it on
/// the blocking pool — a wedged X server must not stall this async enroll task.
async fn probe_offers_display() -> bool {
    // On macOS, make sure the desktop grants have been requested before we probe,
    // so a freshly-granted Mac reports its display in the enroll offer. No-op on
    // every non-macOS / feature-off build.
    ensure_macos_desktop_grants();
    let desktop = opengeni_agent_platform::resolve_desktop();
    tokio::task::spawn_blocking(move || desktop.probe().is_some())
        .await
        .unwrap_or(false)
}

/// macOS consent flow (feature `macos-desktop`): ensure the OS TCC grants the
/// desktop backend needs — Screen Recording (probe + capture) and Accessibility
/// (CGEvent input) — have been requested, so a display-capable Mac can actually
/// probe and advertise its display.
///
/// If either grant is missing it logs a clear human message and fires the OS
/// prompts ONCE per process (a [`std::sync::Once`] guard), then re-reads the state
/// for an informative log. A still-denied grant degrades cleanly: `probe()` keeps
/// returning `None`, so the capability stays `display_unavailable` — this NEVER
/// blocks enroll or the serve loop, and exec/fs/git remain fully available.
///
/// The grant reads + request are non-blocking, non-prompting-preflight + a single
/// prompt fire (the OS shows the dialog / the user toggles System Settings).
#[cfg(all(target_os = "macos", feature = "macos-desktop"))]
fn ensure_macos_desktop_grants() {
    use std::sync::Once;
    static REQUESTED: Once = Once::new();

    let grants = opengeni_agent_platform::desktop_grants();
    if grants.all_granted() {
        return;
    }
    REQUESTED.call_once(|| {
        warn!(
            screen_recording = grants.screen_recording,
            accessibility = grants.accessibility,
            "this Mac needs OS permission to expose its display to OpenGeni — requesting \
             Screen Recording + Accessibility. Approve the system prompt(s), or open \
             System Settings > Privacy & Security and enable BOTH 'Screen Recording' and \
             'Accessibility' for opengeni-agent, then let it reconnect. Until then the \
             machine runs headless (exec/fs/git still work); the display appears once both \
             grants are in place."
        );
        opengeni_agent_platform::request_desktop_grants();
    });
    let after = opengeni_agent_platform::desktop_grants();
    if !after.all_granted() {
        info!(
            screen_recording = after.screen_recording,
            accessibility = after.accessibility,
            "macOS desktop grants still pending; display stays unavailable until both are \
             enabled in System Settings (does not block exec/fs/git or enroll)"
        );
    }
}

/// No-op on every build except macOS-with-`macos-desktop`, keeping the default and
/// non-macOS binaries byte-identical (mirrors the [`maybe_spawn_virtual_desktop`]
/// cfg-stub pattern).
#[cfg(not(all(target_os = "macos", feature = "macos-desktop")))]
fn ensure_macos_desktop_grants() {}

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
        return enroll_with_token(&args, api_url, &token).await;
    }

    // The device flow binds to a workspace the API requires at start. The user
    // supplies it via --workspace-id / $OPENGENI_WORKSPACE_ID; without it we cannot
    // enroll, so fail loudly rather than POST an invalid (workspace-less) start.
    let workspace_id = args.workspace_id.clone().ok_or_else(|| {
        string_err(
            "enrollment requires a workspace id: pass --workspace-id <UUID> (or set \
             $OPENGENI_WORKSPACE_ID). The user who approves this machine must hold a \
             grant in that workspace."
                .to_string(),
        )
    })?;

    let platform = NativePlatform::new();
    let identity = platform.host_identity();
    let machine_name = args
        .machine_name
        .clone()
        .unwrap_or_else(supervisor::hostname_or_default);

    // Probe the live display surface so a display-capable host enrolls as such
    // (rather than the old M6 hardcode that recorded every machine headless).
    let offers_display = probe_offers_display().await;

    let request = EnrollmentRequest {
        api_base_url: api_url.to_string(),
        workspace_id,
        machine_name,
        offer: EnrollmentOffer {
            os: identity.os,
            arch: identity.arch,
            // Whether this host currently has a probeable display (a real screen or
            // an Xvfb virtual framebuffer) — mirrors the supervisor's `desktop`
            // capability so the consent page only promises screen-control we can serve.
            offers_display,
            // The agent does not request screen control by default (the user's
            // approve-time allow_screen_control is the authoritative consent anyway).
            requests_screen_control: false,
        },
    };

    let config_dir = config::config_dir().map_err(to_boxed)?;
    let install = InstallIdentity::load_or_generate(&config_dir).map_err(to_boxed)?;
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

    let stored = StoredCredentials::from_proto(creds_proto, args.channel, api_url);
    let path = config::save_credentials(&stored).map_err(to_boxed)?;
    info!(agent_id = %stored.agent_id, path = %path.display(), "enrollment complete; credentials persisted");
    println!("Enrolled. This machine is now registered with OpenGeni.");
    Ok(stored)
}

/// Non-interactive token enrollment (the CI/automation / fleet path, dossier
/// §23.1, spec §A2.4). A workspace-scoped enroll token IS the grant — there is no
/// human approve step — so this exchanges it directly at the control plane's
/// `POST /v1/enrollments/token/exchange` for the SAME credentials the device flow
/// receives, then persists them `0600` exactly like the device path
/// ([`config::save_credentials`]). The workspace is encoded in the token, so none
/// is required on the CLI here.
async fn enroll_with_token(
    args: &EnrollArgs,
    api_url: &str,
    token: &str,
) -> anyhow_lite::ResultOf<StoredCredentials> {
    let platform = NativePlatform::new();
    let identity = platform.host_identity();
    let machine_name = args
        .machine_name
        .clone()
        .unwrap_or_else(supervisor::hostname_or_default);

    // Probe the live display surface so a display-capable host enrolls as such
    // (rather than the old M6 hardcode that recorded every machine headless).
    let offers_display = probe_offers_display().await;

    // The exchange carries the same identity fields as the device flow; the
    // workspace_id is unused on this path (it is encoded in the token) but the
    // EnrollmentRequest shape requires it, so pass an empty placeholder.
    let request = EnrollmentRequest {
        api_base_url: api_url.to_string(),
        workspace_id: String::new(),
        machine_name,
        offer: EnrollmentOffer {
            os: identity.os,
            arch: identity.arch,
            // Whether this host currently has a probeable display (a real screen or
            // an Xvfb virtual framebuffer) — mirrors the supervisor's `desktop`
            // capability so the control plane only records screen-control we can serve.
            offers_display,
            // The agent does not request screen control; the token's
            // allow_screen_control (set at mint time) is the authoritative consent.
            requests_screen_control: false,
        },
    };

    info!(channel = %args.channel, "non-interactive token enrollment; exchanging token for credentials");
    let config_dir = config::config_dir().map_err(to_boxed)?;
    let install = InstallIdentity::load_or_generate(&config_dir).map_err(to_boxed)?;
    let creds_proto = enrollment::exchange_token(&request, &install, token)
        .await
        .map_err(to_boxed)?;

    let stored = StoredCredentials::from_proto(creds_proto, args.channel.clone(), api_url);
    let path = config::save_credentials(&stored).map_err(to_boxed)?;
    info!(agent_id = %stored.agent_id, path = %path.display(), "enrollment complete; credentials persisted");
    println!("Enrolled. This machine is now registered with OpenGeni.");
    Ok(stored)
}

/// Spawns a task that triggers a clean shutdown on SIGINT or (unix) SIGTERM.
fn spawn_signal_handler(shutdown: supervisor::ShutdownSignal) {
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        info!("received stop signal; shutting down cleanly");
        shutdown.request();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> StoredCredentials {
        StoredCredentials {
            api_base_url: "https://api.example.test".to_string(),
            agent_id: "agent-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            nats_bearer: "oge_test".to_string(),
            bearer_expires_at_unix_seconds: 10_000,
            nats_urls: vec!["wss://nats.example.test".to_string()],
            relay_url: "wss://relay.example.test".to_string(),
            relay_token: "ogr_test".to_string(),
            relay_token_expires_at_unix_seconds: 9_000,
            update_pubkey: String::new(),
            consented_whole_machine: true,
            consented_screen_control: false,
            update_channel: "stable".to_string(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }

    #[test]
    fn refresh_uses_the_earliest_expiry_minus_the_lead() {
        let credentials = credentials();
        assert_eq!(
            credential_refresh_delay(&credentials, 8_000),
            Duration::from_secs(940)
        );
    }

    #[test]
    fn legacy_present_credentials_refresh_immediately() {
        let mut credentials = credentials();
        credentials.relay_token_expires_at_unix_seconds = 0;
        assert_eq!(
            credential_refresh_delay(&credentials, 8_000),
            Duration::ZERO
        );

        credentials.relay_token_expires_at_unix_seconds = 9_000;
        credentials.bearer_expires_at_unix_seconds = 0;
        assert_eq!(
            credential_refresh_delay(&credentials, 8_000),
            Duration::ZERO
        );
    }

    #[test]
    fn disabled_relay_plane_rechecks_without_spinning() {
        let mut credentials = credentials();
        credentials.relay_token.clear();
        credentials.relay_token_expires_at_unix_seconds = 0;
        credentials.bearer_expires_at_unix_seconds = 20_000;
        assert_eq!(
            credential_refresh_delay(&credentials, 8_000),
            DISABLED_RELAY_RECHECK
        );
    }

    #[test]
    fn expired_or_inside_lead_refreshes_immediately() {
        assert_eq!(refresh_delay_for_expiry(8_000, 8_000), Duration::ZERO);
        assert_eq!(refresh_delay_for_expiry(8_030, 8_000), Duration::ZERO);
        assert_eq!(
            refresh_delay_for_expiry(8_061, 8_000),
            Duration::from_secs(1)
        );
    }
}
