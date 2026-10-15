//! `compute-host`: run the host agent, or talk to one.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use compute_core::{HostPolicy, MemoryPolicy, SandboxId, Step};
use compute_engine::firecracker::Firecracker;
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepRule, step_name,
};
use compute_host::{Directory, HostAgent, HostConfig, NoStore, Store, serve};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio::time::Instant;

#[derive(Parser)]
#[command(about = "Run an Opengeni compute host agent, or talk to one")]
struct Cli {
    /// The agent's socket.
    #[arg(long, global = true, default_value = "/run/compute-host.sock")]
    socket: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the agent.
    Serve(ServeArgs),
    /// Create a sandbox.
    Create {
        id: Id,
        #[arg(long, default_value_t = 2)]
        vcpus: u8,
        #[arg(long, default_value_t = 1024)]
        memory_mib: u32,
        /// A sleep rule such as `paused=30s`; repeat for each level.
        #[arg(long = "sleep", value_parser = parse_rule)]
        sleep: Vec<SleepRule>,
    },
    /// Delete a sandbox.
    Remove { id: Id },
    /// Show every sandbox and the host's step counters.
    Status,
    /// Run a shell script inside a sandbox, waking it first.
    Exec {
        id: Id,
        script: String,
        #[arg(long, default_value_t = 52)]
        port: u32,
    },
    /// Create many sandboxes, let them sleep, then wake them all at once.
    Bench(BenchArgs),
}

#[derive(Args)]
struct ServeArgs {
    /// Directory for sandbox state.
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    firecracker: PathBuf,
    #[arg(long)]
    kernel: PathBuf,
    /// Root disk image new sandboxes start from.
    #[arg(long)]
    base_image: PathBuf,
    /// Parent cgroup for VMs.
    #[arg(long, default_value = "/sys/fs/cgroup/compute")]
    cgroup: PathBuf,
    #[arg(
        long,
        default_value = "console=ttyS0 reboot=k panic=1 quiet loglevel=1 page_reporting.page_reporting_order=0"
    )]
    boot_args: String,
    /// Archive into this directory (enables the archived and remote levels).
    #[arg(long)]
    store: Option<PathBuf>,
    /// A step concurrency limit such as `restore=32`; repeatable.
    #[arg(long = "limit", value_parser = parse_limit)]
    limits: Vec<(Step, u32)>,
    /// Push idle sandboxes deeper when available memory drops below this.
    #[arg(long)]
    memory_low_mib: Option<u64>,
    /// ...until expected available memory reaches this.
    #[arg(long)]
    memory_high_mib: Option<u64>,
}

#[derive(Args)]
struct BenchArgs {
    #[arg(long, default_value_t = 100)]
    count: usize,
    /// The level to wake from.
    #[arg(long, value_enum, default_value = "compressed")]
    level: BenchLevel,
    #[arg(long, default_value_t = 1)]
    vcpus: u8,
    #[arg(long, default_value_t = 512)]
    memory_mib: u32,
    #[arg(long, default_value_t = 52)]
    port: u32,
    /// Script each wake runs.
    #[arg(long, default_value = "cat /proc/loadavg")]
    script: String,
    /// Script the first wake (the boot) runs, to give each sandbox a
    /// realistic working set before it sleeps.
    #[arg(long, default_value = "echo ready")]
    warm: String,
    /// Idle time between sleep levels.
    #[arg(long, default_value = "3s", value_parser = parse_duration)]
    settle: Duration,
    /// Burst wakes to run, each after the sandboxes fall asleep again.
    #[arg(long, default_value_t = 1)]
    rounds: usize,
    /// Keep the sandboxes afterwards.
    #[arg(long)]
    keep: bool,
    /// Also write the results here as JSON.
    #[arg(long)]
    json: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum BenchLevel {
    Paused,
    Compressed,
    Saved,
    Archived,
    Remote,
}

fn parse_duration(text: &str) -> Result<Duration, String> {
    let split = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let value: f64 = number.parse().map_err(|_| format!("bad duration {text}"))?;
    let seconds = match unit {
        "ms" => value / 1000.0,
        "" | "s" => value,
        "m" => value * 60.0,
        "h" => value * 3600.0,
        _ => return Err(format!("bad duration unit in {text}; use ms, s, m or h")),
    };
    Duration::try_from_secs_f64(seconds).map_err(|error| error.to_string())
}

fn parse_level(text: &str) -> Result<LevelName, String> {
    serde_json::from_value(serde_json::Value::String(text.into()))
        .map_err(|_| format!("unknown level {text}"))
}

fn parse_rule(text: &str) -> Result<SleepRule, String> {
    let (level, after) = text
        .split_once('=')
        .ok_or_else(|| format!("expected level=duration, got {text}"))?;
    let after = parse_duration(after)?;
    Ok(SleepRule {
        level: parse_level(level)?,
        after_ms: u64::try_from(after.as_millis()).unwrap_or(u64::MAX),
    })
}

fn parse_limit(text: &str) -> Result<(Step, u32), String> {
    let (name, limit) = text
        .split_once('=')
        .ok_or_else(|| format!("expected step=limit, got {text}"))?;
    let step = Step::ALL
        .into_iter()
        .find(|step| step_name(*step) == name)
        .ok_or_else(|| format!("unknown step {name}"))?;
    let limit = limit.parse().map_err(|_| format!("bad limit {limit}"))?;
    Ok((step, limit))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let client = Client::new(&cli.socket);
    match cli.command {
        Command::Serve(args) => run_serve(args, cli.socket).await,
        Command::Create {
            id,
            vcpus,
            memory_mib,
            sleep,
        } => {
            let config = SandboxConfig {
                vcpus,
                memory_mib,
                sleep,
            };
            expect_done(client.call(&Request::Create { id, config }).await?)
        }
        Command::Remove { id } => expect_done(client.call(&Request::Remove { id }).await?),
        Command::Status => {
            let reply = client.call(&Request::Status).await?;
            println!("{}", serde_json::to_string_pretty(&reply)?);
            Ok(())
        }
        Command::Exec { id, script, port } => {
            let run = run_script(&client, id, port, &script, true).await?;
            eprintln!(
                "woke in {:?}, first byte {:?}, done {:?}",
                Duration::from_micros(run.waited_us),
                run.first_byte,
                run.done
            );
            Ok(())
        }
        Command::Bench(args) => bench(&client, &args).await,
    }
}

fn expect_done(reply: Reply) -> anyhow::Result<()> {
    match reply {
        Reply::Done => Ok(()),
        other => bail!("{other:?}"),
    }
}

async fn run_serve(args: ServeArgs, socket: PathBuf) -> anyhow::Result<()> {
    let engine = Firecracker::new(&args.firecracker, &args.cgroup)
        .with_context(|| format!("creating cgroup {}", args.cgroup.display()))?;
    let mut policy = HostPolicy::default();
    for (step, limit) in args.limits {
        policy.limits = policy.limits.with(step, limit);
    }
    if let (Some(low), Some(high)) = (args.memory_low_mib, args.memory_high_mib) {
        policy.memory = Some(MemoryPolicy {
            low_watermark: low << 20,
            high_watermark: high << 20,
            compressed_percent: 25,
        });
    }
    let config = HostConfig {
        root: args.root,
        kernel: args.kernel,
        boot_args: args.boot_args,
        base_image: args.base_image,
        policy,
        sample_every: Duration::from_secs(1),
    };
    match args.store {
        Some(dir) => run_agent(config, engine, Directory::new(dir), socket).await,
        None => run_agent(config, engine, NoStore, socket).await,
    }
}

async fn run_agent<S: Store>(
    config: HostConfig,
    engine: Firecracker,
    store: S,
    socket: PathBuf,
) -> anyhow::Result<()> {
    let (handle, agent) = HostAgent::start(config, engine, store).await?;
    tokio::select! {
        result = serve(handle, &socket) => result.context("serving")?,
        result = tokio::signal::ctrl_c() => result?,
        result = agent => result?,
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
struct Run {
    waited_us: u64,
    connect_us: u64,
    first_byte: Duration,
    done: Duration,
}

async fn run_script(
    client: &Client,
    id: Id,
    port: u32,
    script: &str,
    echo: bool,
) -> anyhow::Result<Run> {
    let started = Instant::now();
    let (reply, mut stream) = client.connect(id, port, PriorityName::Interactive).await?;
    let Reply::Connected {
        waited_us,
        connect_us,
    } = reply
    else {
        bail!("{reply:?}");
    };
    stream
        .get_mut()
        .write_all(format!("{script}\nexit\n").as_bytes())
        .await?;
    let mut output = vec![0_u8; 1];
    if stream.read(&mut output).await? == 0 {
        bail!("the guest closed the connection without output");
    }
    let first_byte = started.elapsed();
    stream.read_to_end(&mut output).await?;
    let done = started.elapsed();
    if echo {
        print!("{}", String::from_utf8_lossy(&output));
    }
    Ok(Run {
        waited_us,
        connect_us,
        first_byte,
        done,
    })
}

#[derive(Debug, Serialize)]
struct Burst {
    label: String,
    ok: usize,
    failed: Vec<String>,
    runs: Vec<Run>,
    steps: Vec<(String, compute_host::protocol::StepStats)>,
}

async fn burst(client: &Client, ids: &[Id], args: &BenchArgs, script: &str, label: &str) -> Burst {
    let before = client.call(&Request::Status).await.ok();
    let gate = Arc::new(tokio::sync::Barrier::new(ids.len()));
    let mut tasks = JoinSet::new();
    for id in ids {
        let (client, gate, id, port, script) = (
            client.clone(),
            Arc::clone(&gate),
            *id,
            args.port,
            script.to_owned(),
        );
        tasks.spawn(async move {
            gate.wait().await;
            run_script(&client, id, port, &script, false).await
        });
    }
    let mut runs = Vec::new();
    let mut failed = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(run)) => runs.push(run),
            Ok(Err(error)) => failed.push(error.to_string()),
            Err(error) => failed.push(error.to_string()),
        }
    }
    let after = client.call(&Request::Status).await.ok();
    let steps = step_delta(before, after);
    let burst = Burst {
        label: label.to_owned(),
        ok: runs.len(),
        failed,
        runs,
        steps,
    };
    report(&burst);
    burst
}

fn status_of(reply: Option<Reply>) -> Option<HostStatus> {
    match reply {
        Some(Reply::Status(status)) => Some(*status),
        _ => None,
    }
}

fn step_delta(
    before: Option<Reply>,
    after: Option<Reply>,
) -> Vec<(String, compute_host::protocol::StepStats)> {
    let (Some(before), Some(after)) = (status_of(before), status_of(after)) else {
        return Vec::new();
    };
    after
        .steps
        .into_iter()
        .zip(before.steps)
        .filter_map(|((name, after), (_, before))| {
            let started = after.started - before.started;
            (started > 0).then(|| {
                let mut delta = after;
                delta.started = started;
                delta.done -= before.done;
                delta.cancelled -= before.cancelled;
                delta.failed -= before.failed;
                delta.total_us -= before.total_us;
                (name, delta)
            })
        })
        .collect()
}

fn percentiles(mut values: Vec<Duration>) -> String {
    if values.is_empty() {
        return "-".into();
    }
    values.sort_unstable();
    let at = |q: f64| {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let index = ((values.len() - 1) as f64 * q).round() as usize;
        values[index]
    };
    format!(
        "p50 {:>9.1?}  p90 {:>9.1?}  p99 {:>9.1?}  max {:>9.1?}",
        at(0.5),
        at(0.9),
        at(0.99),
        at(1.0)
    )
}

fn report(burst: &Burst) {
    println!(
        "\n{}: {} ok, {} failed",
        burst.label,
        burst.ok,
        burst.failed.len()
    );
    for error in burst.failed.iter().take(3) {
        println!("  error: {error}");
    }
    let pick = |f: fn(&Run) -> Duration| burst.runs.iter().map(f).collect::<Vec<_>>();
    println!(
        "  host wake    {}",
        percentiles(pick(|run| Duration::from_micros(run.waited_us)))
    );
    println!(
        "  guest port   {}",
        percentiles(pick(|run| Duration::from_micros(run.connect_us)))
    );
    println!("  first byte   {}", percentiles(pick(|run| run.first_byte)));
    println!("  done         {}", percentiles(pick(|run| run.done)));
    for (name, stats) in &burst.steps {
        let mean = stats.total_us / stats.done.max(1);
        println!(
            "  step {name:<9} {} started, {} done, {} cancelled, {} failed, mean {:?}, max so far {:?}",
            stats.started,
            stats.done,
            stats.cancelled,
            stats.failed,
            Duration::from_micros(mean),
            Duration::from_micros(stats.max_us)
        );
    }
}

fn ladder(level: BenchLevel, settle: Duration) -> Vec<SleepRule> {
    let rule = |level, factor: u32| SleepRule {
        level,
        after_ms: u64::try_from((settle * factor).as_millis()).unwrap_or(u64::MAX),
    };
    match level {
        BenchLevel::Paused => vec![rule(LevelName::Paused, 1)],
        BenchLevel::Compressed => vec![rule(LevelName::Paused, 1), rule(LevelName::Compressed, 2)],
        BenchLevel::Saved => vec![rule(LevelName::Paused, 1), rule(LevelName::Saved, 2)],
        BenchLevel::Archived => vec![
            rule(LevelName::Paused, 1),
            rule(LevelName::Saved, 2),
            rule(LevelName::Archived, 3),
        ],
        BenchLevel::Remote => vec![
            rule(LevelName::Paused, 1),
            rule(LevelName::Saved, 2),
            rule(LevelName::Archived, 3),
            rule(LevelName::Remote, 4),
        ],
    }
}

fn target(level: BenchLevel) -> LevelName {
    match level {
        BenchLevel::Paused => LevelName::Paused,
        BenchLevel::Compressed => LevelName::Compressed,
        BenchLevel::Saved => LevelName::Saved,
        BenchLevel::Archived => LevelName::Archived,
        BenchLevel::Remote => LevelName::Remote,
    }
}

async fn wait_for_level(client: &Client, ids: &[Id], level: LevelName) -> anyhow::Result<()> {
    let started = Instant::now();
    let mut last_report = Instant::now();
    loop {
        let Reply::Status(status) = client.call(&Request::Status).await? else {
            bail!("status failed");
        };
        let reached = status
            .sandboxes
            .iter()
            .filter(|sandbox| {
                ids.binary_search(&sandbox.id).is_ok()
                    && sandbox.level == level
                    && sandbox.step.is_none()
            })
            .count();
        if reached == ids.len() {
            println!(
                "all {} sandboxes at {level:?} after {:?}",
                ids.len(),
                started.elapsed()
            );
            return Ok(());
        }
        if last_report.elapsed() > Duration::from_secs(10) {
            println!("  {reached}/{} at {level:?}", ids.len());
            last_report = Instant::now();
        }
        if started.elapsed() > Duration::from_secs(1800) {
            bail!("only {reached}/{} sandboxes reached {level:?}", ids.len());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn bench(client: &Client, args: &BenchArgs) -> anyhow::Result<()> {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut ids: Vec<Id> = (0..args.count)
        .map(|index| Id(SandboxId((seed << 32) | index as u128)))
        .collect();
    ids.sort_unstable();
    let config = SandboxConfig {
        vcpus: args.vcpus,
        memory_mib: args.memory_mib,
        sleep: ladder(args.level, args.settle),
    };
    let started = Instant::now();
    let mut creates = JoinSet::new();
    for id in &ids {
        let (client, id, config) = (client.clone(), *id, config.clone());
        creates.spawn(async move { client.call(&Request::Create { id, config }).await });
    }
    while let Some(result) = creates.join_next().await {
        expect_done(result??)?;
    }
    println!("created {} sandboxes in {:?}", ids.len(), started.elapsed());

    let mut bursts = vec![burst(client, &ids, args, &args.warm, "first wake (boot)").await];
    for round in 1..=args.rounds {
        wait_for_level(client, &ids, target(args.level)).await?;
        let label = format!("round {round}: wake from {:?}", target(args.level));
        bursts.push(burst(client, &ids, args, &args.script, &label).await);
    }
    if let Some(path) = &args.json {
        std::fs::write(path, serde_json::to_vec_pretty(&bursts)?)?;
    }
    if !args.keep {
        let mut removes = JoinSet::new();
        for id in &ids {
            let (client, id) = (client.clone(), *id);
            removes.spawn(async move { client.call(&Request::Remove { id }).await });
        }
        while let Some(result) = removes.join_next().await {
            expect_done(result??)?;
        }
    }
    Ok(())
}
