//! `og-agent-harness` — a deterministic load/chaos harness for the real
//! `opengeni-agent` binary against a real local `nats-server`.
//!
//! It drives the agent exactly like the control plane does (prost `ControlRequest`
//! request/reply over NATS), measures latency/error/heartbeat/resource envelopes,
//! and emits machine-readable JSON + a human summary. It never touches the
//! machine's real enrollment — every agent is disposable, with hand-written
//! credentials in a temp dir, dialing a throwaway local server.
//!
//! See `README.md` for what each scenario proves and how to run it.

mod agent;
mod driver;
mod nats;
mod proc;
mod report;
mod scenario;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use nats::NatsServer;
use scenario::{Harness, HarnessConfig};

/// Deterministic load/chaos harness for the opengeni-agent control plane.
#[derive(Debug, Parser)]
#[command(name = "og-agent-harness", version, about)]
struct Cli {
    /// Path to a `nats-server` binary. Falls back to `$HX_NATS_SERVER`, then
    /// `$PATH`, then a nix-store scan.
    #[arg(long, env = "HX_NATS_SERVER", global = true)]
    nats_server: Option<String>,

    /// Path to the `opengeni-agent` binary under test. Defaults to a sibling of
    /// this harness binary (`<exe_dir>/opengeni-agent`).
    #[arg(long, global = true)]
    agent_bin: Option<PathBuf>,

    /// Directory for the JSON result files. Defaults to `<exe_dir>/harness-results`.
    #[arg(long, global = true)]
    results_dir: Option<PathBuf>,

    /// Seed for the deterministic op mixes.
    #[arg(long, default_value_t = 42, global = true)]
    seed: u64,

    /// Record measurements without failing on a broken invariant (baseline mode).
    #[arg(long, global = true)]
    no_assert: bool,

    /// `RUST_LOG` filter handed to the disposable agents.
    #[arg(long, default_value = "info", global = true)]
    agent_log: String,

    /// Fleet size for the flood scenario's part (b).
    #[arg(long, default_value_t = 32, global = true)]
    fleet_size: usize,

    /// SIGSTOP freeze duration (seconds) for chaos-nats part (b).
    #[arg(long, default_value_t = 30, global = true)]
    pause_secs: u64,

    /// Soak duration in seconds (default 10 minutes).
    #[arg(long, default_value_t = 600, global = true)]
    soak_secs: u64,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// MILESTONE 0: bring one disposable agent online, confirm heartbeats + a ping
    /// round-trip. Proves the whole disposable-agent path before any scenario.
    Milestone0,
    /// Scenario 1: reference numbers (pings, small execs, fs ops).
    Baseline,
    /// Scenario 2: concurrency flood (8-slot saturation + fleet shape).
    Flood,
    /// Scenario 3: large replies/requests (the ~1MB wall as a golden baseline).
    Large,
    /// Scenario 4: the 30s exec deadline (typed timeout vs success).
    Long,
    /// Scenario 5: server restart + freeze under an in-flight exec.
    ChaosNats,
    /// Scenario 6: agent SIGKILL (orphan) + clean SIGTERM (GoingOffline).
    ChaosAgent,
    /// Scenario 7: 10-minute soak (RSS/fd stability).
    Soak,
    /// Run scenarios 1-6 in sequence (soak excluded).
    All,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    init_tracing();
    proc::install_guards();

    let cli = Cli::parse();
    match run(cli).await {
        Ok(all_passed) => {
            if all_passed {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "harness failed");
            eprintln!("\nHARNESS ERROR: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Initializes tracing (default `info`; the agent's own logs are captured to
/// per-agent files, not this stream).
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,og_agent_harness=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

/// Resolves binaries + paths, then dispatches to the selected scenario(s).
/// Returns whether all verdicts across all run scenarios passed.
async fn run(cli: Cli) -> Result<bool, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .ok_or("could not resolve the harness executable directory")?;

    let agent_bin = cli
        .agent_bin
        .clone()
        .unwrap_or_else(|| exe_dir.join("opengeni-agent"));
    if !agent_bin.is_file() {
        return Err(format!(
            "agent binary not found at {}. Build it with `cargo build -p opengeni-agent`, \
             or pass --agent-bin <path>.",
            agent_bin.display()
        ));
    }
    let nats_bin = NatsServer::resolve_binary(cli.nats_server.as_deref())?;
    let results_dir = cli
        .results_dir
        .clone()
        .unwrap_or_else(|| exe_dir.join("harness-results"));

    tracing::info!(
        agent = %agent_bin.display(),
        nats = %nats_bin.display(),
        results = %results_dir.display(),
        seed = cli.seed,
        "harness configured"
    );

    let mk = |agent_count: usize| HarnessConfig {
        nats_binary: nats_bin.clone(),
        agent_binary: agent_bin.clone(),
        results_dir: results_dir.clone(),
        seed: cli.seed,
        no_assert: cli.no_assert,
        agent_log_level: cli.agent_log.clone(),
        agent_count,
    };

    match cli.command {
        Command::Milestone0 => milestone0(mk(1)).await,
        Command::Baseline => {
            let h = Harness::bootstrap(mk(1)).await?;
            Ok(h.baseline().await.all_passed())
        }
        Command::Flood => {
            let h = Harness::bootstrap(mk(cli.fleet_size.max(1))).await?;
            Ok(h.flood(cli.fleet_size).await.all_passed())
        }
        Command::Large => {
            let h = Harness::bootstrap(mk(1)).await?;
            Ok(h.large().await.all_passed())
        }
        Command::Long => {
            let h = Harness::bootstrap(mk(1)).await?;
            Ok(h.long().await.all_passed())
        }
        Command::ChaosNats => {
            let mut h = Harness::bootstrap(mk(1)).await?;
            Ok(h.chaos_nats(cli.pause_secs).await.all_passed())
        }
        Command::ChaosAgent => {
            let mut h = Harness::bootstrap(mk(1)).await?;
            Ok(h.chaos_agent().await.all_passed())
        }
        Command::Soak => {
            let h = Harness::bootstrap(mk(1)).await?;
            Ok(h.soak(cli.soak_secs).await.all_passed())
        }
        Command::All => run_all(&cli, &mk).await,
    }
}

/// Runs scenarios 1-6, each on a fresh fleet, and returns whether all passed.
async fn run_all(cli: &Cli, mk: &impl Fn(usize) -> HarnessConfig) -> Result<bool, String> {
    let mut all = true;

    let h = Harness::bootstrap(mk(1)).await?;
    all &= h.baseline().await.all_passed();
    drop(h);

    let h = Harness::bootstrap(mk(cli.fleet_size.max(1))).await?;
    all &= h.flood(cli.fleet_size).await.all_passed();
    drop(h);

    let h = Harness::bootstrap(mk(1)).await?;
    all &= h.large().await.all_passed();
    drop(h);

    let h = Harness::bootstrap(mk(1)).await?;
    all &= h.long().await.all_passed();
    drop(h);

    let mut h = Harness::bootstrap(mk(1)).await?;
    all &= h.chaos_nats(cli.pause_secs).await.all_passed();
    drop(h);

    let mut h = Harness::bootstrap(mk(1)).await?;
    all &= h.chaos_agent().await.all_passed();
    drop(h);

    Ok(all)
}

/// MILESTONE 0: prove one disposable agent comes online (heartbeats) and answers
/// a ping round-trip. Reports the exact failure (with the agent log tail) if not.
async fn milestone0(cfg: HarnessConfig) -> Result<bool, String> {
    let h = Harness::bootstrap(cfg).await?;
    let agent = &h.agents[0];
    let subject = agent.rpc_subject();
    let beats = h.collector.beat_count(agent.agent_id());
    tracing::info!(agent = agent.agent_id(), beats, "agent is heartbeating");

    let outcome = h
        .driver
        .execute(
            &subject,
            driver::Op::Ping,
            std::time::Duration::from_secs(5),
        )
        .await;
    let ping_ok = matches!(outcome.class, driver::OpClass::Ok);

    println!("\n=== MILESTONE 0 ===");
    println!("agent_id:        {}", agent.agent_id());
    println!("agent_version:   {}", h.agent_version);
    println!("nats_url:        {}", agent.nats_url());
    println!("heartbeats seen: {beats}");
    println!(
        "ping round-trip: {} ({}us, class={:?})",
        if ping_ok { "OK" } else { "FAILED" },
        outcome.latency_us,
        outcome.class
    );
    let pass = beats >= 1 && ping_ok;
    println!("result:          {}", if pass { "PASS" } else { "FAIL" });
    if !pass {
        println!("\nagent log tail:\n{}", agent.log_tail(40));
    }
    Ok(pass)
}
