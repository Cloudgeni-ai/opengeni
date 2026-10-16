//! `compute-host`: run the host agent, or talk to one.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use compute_core::{HostPolicy, MemoryPolicy, SandboxId, Step};
use compute_engine::MemoryProfile;
use compute_engine::firecracker::{Firecracker, FirecrackerConfig};
use compute_host::client::Client;
use compute_host::net::{Ipv4Net, NetworkConfig};
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig, step_name,
};
use compute_host::{
    BusyRule, Chunked, Directory, GuestPort, HostAgent, HostConfig, NoStore, Store, serve,
};
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
    Serve(Box<ServeArgs>),
    /// Create a sandbox.
    Create {
        id: Id,
        #[arg(long, default_value_t = 2)]
        vcpus: u8,
        #[arg(long, default_value_t = 1024)]
        memory_mib: u32,
        /// Start from the recommended sleep settings instead of never
        /// sleeping.
        #[arg(long)]
        recommended: bool,
        /// A sleep rule such as `pause=10s`, `save=30s`, `archive=2m`,
        /// `drop=1h`, `evict=3d` or `forget=30d`, or `rule=never` to turn
        /// one off. Repeatable; later rules override earlier ones.
        #[arg(long = "sleep", value_parser = parse_rule)]
        sleep: Vec<(SleepRuleName, Option<u64>)>,
        /// Let memory pressure compress the sandbox's memory while paused.
        #[arg(long)]
        compress: Option<bool>,
    },
    /// Delete a sandbox.
    Remove { id: Id },
    /// Put a sandbox at least as deep as a level now.
    Sleep {
        id: Id,
        #[arg(value_parser = parse_level)]
        level: LevelName,
    },
    /// Keep a sandbox awake for a named reason, waking it if it sleeps.
    Hold {
        id: Id,
        /// The reason, such as `turn`.
        name: String,
        /// Let the hold lapse after this long unless held again.
        #[arg(long, value_parser = parse_duration)]
        ttl: Option<Duration>,
    },
    /// End a named hold.
    Release { id: Id, name: String },
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
    /// Firecracker's jailer, from the same release.
    #[arg(long)]
    jailer: PathBuf,
    /// User id of the first sandbox; each sandbox's VMM runs as its own
    /// user and group from here up.
    #[arg(long, default_value_t = 1 << 30)]
    first_uid: u32,
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
    /// Where archived sandboxes go, which enables the archived and remote
    /// levels: a directory, or object storage as `gs://bucket/prefix`,
    /// `az://container/prefix` or `s3://bucket/prefix`, with credentials
    /// from the environment or the machine's own identity.
    #[arg(long)]
    store: Option<String>,
    /// A step concurrency limit such as `restore=32`; repeatable.
    #[arg(long = "limit", value_parser = parse_limit)]
    limits: Vec<(Step, u32)>,
    /// Push idle sandboxes deeper when available memory drops below this.
    #[arg(long)]
    memory_low_mib: Option<u64>,
    /// ...until expected available memory reaches this.
    #[arg(long)]
    memory_high_mib: Option<u64>,
    /// A port guests may connect to on this host, as `PORT=HOST:PORT`, with
    /// `,wake` appended to wake a sleeping sandbox when data arrives for it.
    /// Repeatable.
    #[arg(long = "guest-port")]
    guest_ports: Vec<GuestPort>,
    /// Guest vsock port to tell about each restore from a memory image, so
    /// the guest can set its clock and reconnect.
    #[arg(long)]
    restore_notice_port: Option<u32>,
    /// How guest memory is backed and saved: `bare-metal` (4 KiB pages,
    /// dirty-page tracking, compression allowed) or `nested` (2 MiB pages
    /// from the host's reserved huge-page pool, resident-page saves, no
    /// compression). Nested hosts need the pool reserved first, for example
    /// through `/proc/sys/vm/nr_hugepages`.
    #[arg(long, default_value_t = MemoryProfile::bare_metal())]
    memory_profile: MemoryProfile,
    /// Give every sandbox a network: its own namespace, a fixed guest
    /// address, internet access through NAT, and nothing else.
    #[arg(long)]
    network: bool,
    /// Addresses for the host's links to sandbox namespaces, two per
    /// sandbox. Must not be used for anything else.
    #[arg(long, default_value = "198.18.0.0/15")]
    network_pool: Ipv4Net,
    /// Let sandboxes reach this host's local network (private and shared
    /// ranges). The host itself, metadata services and other sandboxes
    /// stay blocked.
    #[arg(long)]
    trusted: bool,
    /// Another range sandboxes may not reach, such as the host's public
    /// address where the cloud maps it onto a private one. Repeatable.
    #[arg(long = "block")]
    blocked: Vec<Ipv4Net>,
    /// A name server for guests; repeatable, at most two are used.
    #[arg(long = "dns", default_values_t = [Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(8, 8, 8, 8)])]
    dns: Vec<Ipv4Addr>,
    /// A running sandbox whose VM uses at least this percent of one
    /// processor counts as busy and stays awake; 0 ignores processor use.
    #[arg(long, default_value_t = BusyRule::DEFAULT.cpu_percent)]
    busy_cpu_percent: u32,
    /// ...averaged over this long.
    #[arg(long, default_value = "5s", value_parser = parse_duration)]
    busy_window: Duration,
    /// This host cannot compress paused VMs' memory, for example because
    /// guest memory uses huge pages. The `nested` memory profile implies it.
    #[arg(long)]
    no_compress: bool,
}

#[derive(Args)]
struct BenchArgs {
    #[arg(long, default_value_t = 100)]
    count: usize,
    /// The level to wake from. After each wake the bench asks every sandbox
    /// to sleep this deep, timing the steps that get it there.
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
    /// Idle time after each wake before the sandboxes are sent to sleep.
    #[arg(long, default_value = "1s", value_parser = parse_duration)]
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

impl BenchLevel {
    const fn level(self) -> LevelName {
        match self {
            Self::Paused => LevelName::Paused,
            Self::Compressed => LevelName::Compressed,
            Self::Saved => LevelName::Saved,
            Self::Archived => LevelName::Archived,
            Self::Remote => LevelName::Remote,
        }
    }
}

/// One rule of [`SleepConfig`], named as on the command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SleepRuleName {
    Pause,
    Save,
    Archive,
    Drop,
    Evict,
    Forget,
}

impl SleepRuleName {
    fn set(self, config: &mut SleepConfig, after_ms: Option<u64>) {
        let field = match self {
            Self::Pause => &mut config.pause_after_ms,
            Self::Save => &mut config.save_after_ms,
            Self::Archive => &mut config.archive_after_ms,
            Self::Drop => &mut config.drop_after_ms,
            Self::Evict => &mut config.evict_after_ms,
            Self::Forget => &mut config.forget_after_ms,
        };
        *field = after_ms;
    }
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
        "d" => value * 86_400.0,
        _ => return Err(format!("bad duration unit in {text}; use ms, s, m, h or d")),
    };
    Duration::try_from_secs_f64(seconds).map_err(|error| error.to_string())
}

fn parse_level(text: &str) -> Result<LevelName, String> {
    serde_json::from_value(serde_json::Value::String(text.into()))
        .map_err(|_| format!("unknown level {text}"))
}

fn parse_rule(text: &str) -> Result<(SleepRuleName, Option<u64>), String> {
    let (name, after) = text
        .split_once('=')
        .ok_or_else(|| format!("expected rule=duration, got {text}"))?;
    let rule = match name {
        "pause" => SleepRuleName::Pause,
        "save" => SleepRuleName::Save,
        "archive" => SleepRuleName::Archive,
        "drop" => SleepRuleName::Drop,
        "evict" => SleepRuleName::Evict,
        "forget" => SleepRuleName::Forget,
        _ => {
            return Err(format!(
                "unknown sleep rule {name}; use pause, save, archive, drop, evict or forget"
            ));
        }
    };
    if after == "never" {
        return Ok((rule, None));
    }
    Ok((rule, Some(millis(parse_duration(after)?))))
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
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
        Command::Serve(args) => run_serve(*args, cli.socket).await,
        Command::Create {
            id,
            vcpus,
            memory_mib,
            recommended,
            sleep,
            compress,
        } => {
            let mut settings = if recommended {
                SleepConfig::RECOMMENDED
            } else {
                SleepConfig::default()
            };
            for (rule, after_ms) in sleep {
                rule.set(&mut settings, after_ms);
            }
            if let Some(compress) = compress {
                settings.compress = compress;
            }
            let config = SandboxConfig {
                vcpus,
                memory_mib,
                sleep: settings,
            };
            expect_done(client.call(&Request::Create { id, config }).await?)
        }
        Command::Remove { id } => expect_done(
            client
                .call(&Request::Remove {
                    id,
                    generation: None,
                })
                .await?,
        ),
        Command::Sleep { id, level } => expect_done(
            client
                .call(&Request::Sleep {
                    id,
                    generation: None,
                    level,
                })
                .await?,
        ),
        Command::Hold { id, name, ttl } => expect_done(
            client
                .call(&Request::Hold {
                    id,
                    generation: None,
                    hold: name,
                    ttl_ms: ttl.map(millis),
                    priority: PriorityName::Interactive,
                })
                .await?,
        ),
        Command::Release { id, name } => expect_done(
            client
                .call(&Request::Release {
                    id,
                    generation: None,
                    hold: name,
                })
                .await?,
        ),
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
    let engine = Firecracker::new(FirecrackerConfig {
        firecracker: args.firecracker,
        jailer: args.jailer,
        cgroup_parent: args.cgroup.clone(),
    })
    .with_context(|| format!("setting up Firecracker in cgroup {}", args.cgroup.display()))?
    .with_memory_profile(args.memory_profile)
    .with_context(|| format!("memory profile {}", args.memory_profile))?;
    check_huge_pages(args.memory_profile)?;
    raise_open_file_limit();
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
        guest_ports: args.guest_ports,
        restore_notice_port: args.restore_notice_port,
        first_uid: args.first_uid,
        network: args.network.then_some(NetworkConfig {
            pool: args.network_pool,
            trusted: args.trusted,
            blocked: args.blocked,
            dns: args.dns,
        }),
        busy: (args.busy_cpu_percent > 0).then_some(BusyRule {
            cpu_percent: args.busy_cpu_percent,
            window: args.busy_window,
        }),
        can_compress: !args.no_compress,
    };
    let Some(store) = args.store else {
        return run_agent(config, engine, NoStore, socket).await;
    };
    match Chunked::from_url(&store)? {
        Some(chunked) => run_agent(config, engine, chunked, socket).await,
        None => run_agent(config, engine, Directory::new(store), socket).await,
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
    report_steps(&burst.steps);
}

fn report_steps(steps: &[(String, compute_host::protocol::StepStats)]) {
    for (name, stats) in steps {
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

/// Waits until every sandbox in `ids` is at `level` with no step running,
/// and reports how long that took.
async fn wait_for_level(client: &Client, ids: &[Id], level: LevelName) -> anyhow::Result<Duration> {
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
            let elapsed = started.elapsed();
            println!("all {} sandboxes at {level:?} after {elapsed:?}", ids.len());
            return Ok(elapsed);
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

/// Sends every sandbox to `level` at once and reports the steps that took
/// them there.
async fn put_to_sleep(
    client: &Client,
    ids: &[Id],
    level: LevelName,
    label: &str,
) -> anyhow::Result<Sleep> {
    let before = client.call(&Request::Status).await.ok();
    let mut requests = JoinSet::new();
    for id in ids {
        let (client, id) = (client.clone(), *id);
        requests.spawn(async move {
            client
                .call(&Request::Sleep {
                    id,
                    generation: None,
                    level,
                })
                .await
        });
    }
    while let Some(result) = requests.join_next().await {
        expect_done(result??)?;
    }
    let took = wait_for_level(client, ids, level).await?;
    let after = client.call(&Request::Status).await.ok();
    let sleep = Sleep {
        label: label.to_owned(),
        took_us: u64::try_from(took.as_micros()).unwrap_or(u64::MAX),
        resident_bytes: status_of(after.clone()).map(|status| {
            status
                .sandboxes
                .iter()
                .filter(|sandbox| ids.binary_search(&sandbox.id).is_ok())
                .filter_map(|sandbox| sandbox.resident_bytes)
                .sum()
        }),
        steps: step_delta(before, after),
    };
    println!("\n{label}: {took:?}");
    if let Some(bytes) = sleep.resident_bytes {
        println!(
            "  resident     {} MiB total, {} MiB per sandbox",
            bytes >> 20,
            (bytes / ids.len().max(1) as u64) >> 20
        );
    }
    report_steps(&sleep.steps);
    Ok(sleep)
}

#[derive(Debug, Serialize)]
struct Sleep {
    label: String,
    took_us: u64,
    resident_bytes: Option<u64>,
    steps: Vec<(String, compute_host::protocol::StepStats)>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Phase {
    Wake(Burst),
    Sleep(Sleep),
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
    // Sandboxes only sleep when the bench asks, so each phase is timed on
    // its own; idle timers would start steps at unpredictable moments.
    let config = SandboxConfig {
        vcpus: args.vcpus,
        memory_mib: args.memory_mib,
        sleep: SleepConfig::default(),
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

    let level = args.level.level();
    let mut phases = vec![Phase::Wake(
        burst(client, &ids, args, &args.warm, "first wake (boot)").await,
    )];
    for round in 1..=args.rounds {
        tokio::time::sleep(args.settle).await;
        let label = format!("round {round}: sleep to {level:?}");
        phases.push(Phase::Sleep(
            put_to_sleep(client, &ids, level, &label).await?,
        ));
        let label = format!("round {round}: wake from {level:?}");
        phases.push(Phase::Wake(
            burst(client, &ids, args, &args.script, &label).await,
        ));
    }
    if let Some(path) = &args.json {
        std::fs::write(path, serde_json::to_vec_pretty(&phases)?)?;
    }
    if !args.keep {
        let mut removes = JoinSet::new();
        for id in &ids {
            let (client, id) = (client.clone(), *id);
            removes.spawn(async move {
                client
                    .call(&Request::Remove {
                        id,
                        generation: None,
                    })
                    .await
            });
        }
        while let Some(result) = removes.join_next().await {
            expect_done(result??)?;
        }
    }
    Ok(())
}

/// Refuses a huge-page memory profile on a host without a reserved pool of
/// 2 MiB pages: every VM's memory would fail to allocate.
/// Lets the agent hold as many open files as the system allows it. Every VM
/// keeps several open here (its process, pager, image files and store
/// connections), so the usual soft limit of 1024 runs out near a hundred
/// VMs.
fn raise_open_file_limit() {
    use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
    let limit = getrlimit(Resource::Nofile);
    if limit.current == limit.maximum {
        return;
    }
    let raised = Rlimit {
        current: limit.maximum,
        maximum: limit.maximum,
    };
    match setrlimit(Resource::Nofile, raised) {
        Ok(()) => tracing::info!(limit = ?limit.maximum, "open-file limit raised"),
        Err(error) => {
            tracing::warn!(%error, current = ?limit.current, "could not raise the open-file limit");
        }
    }
}

fn check_huge_pages(profile: MemoryProfile) -> anyhow::Result<()> {
    if profile.pages != compute_engine::PageSize::Huge {
        return Ok(());
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let field = |name: &str| {
        meminfo
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };
    if field("Hugepagesize:") != 2048 {
        bail!("the {profile} memory profile needs 2 MiB default huge pages");
    }
    let total = field("HugePages_Total:");
    if total == 0 {
        bail!(
            "the {profile} memory profile needs reserved huge pages; set /proc/sys/vm/nr_hugepages"
        );
    }
    tracing::info!(
        pool_mib = total * 2,
        free_mib = field("HugePages_Free:") * 2,
        "huge-page pool"
    );
    Ok(())
}
