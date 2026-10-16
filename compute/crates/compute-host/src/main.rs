//! `compute-host`: run the host agent, or talk to one.

mod bench;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use compute_core::{Admission, HostPolicy, MemoryPolicy, Step};
use compute_engine::MemoryProfile;
use compute_engine::firecracker::{Firecracker, FirecrackerConfig};
use compute_host::client::Client;
use compute_host::net::{Ipv4Net, NetworkConfig};
use compute_host::protocol::{
    Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig, step_name,
};
use compute_host::{
    BusyRule, Chunked, Directory, GuestPort, HostAgent, HostConfig, NoStore, PagerConfig, Store,
    serve,
};

use crate::bench::{BenchArgs, bench, exec};

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
        /// Memory it is guaranteed while it runs; defaults to all of it.
        #[arg(long)]
        memory_request_mib: Option<u32>,
        /// Processor time it is guaranteed under contention, in thousandths
        /// of a processor; defaults to all its processors.
        #[arg(long)]
        cpu_request_millis: Option<u32>,
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
    #[arg(long, default_value_t = 1 << 30, value_parser = clap::value_parser!(u32).range(1..))]
    first_uid: u32,
    /// A host-wide lock file: only one agent may manage VMs, users and
    /// networks on a host, whatever state root it uses.
    #[arg(long, default_value = "/run/opengeni-compute.lock")]
    host_lock: PathBuf,
    #[arg(long)]
    kernel: PathBuf,
    /// Root disk image new sandboxes start from.
    #[arg(long)]
    base_image: PathBuf,
    /// Parent cgroup for VMs.
    #[arg(long, default_value = "/sys/fs/cgroup/compute")]
    cgroup: PathBuf,
    /// The program VMs' memory pagers run as, given `pager` as its first
    /// argument. Defaults to this agent's own binary.
    #[arg(long)]
    pager: Option<PathBuf>,
    /// How long after a wake each pager records the order the guest
    /// touches memory in, for the next wake to prefetch.
    #[arg(long, default_value_t = 120_000)]
    pager_record_ms: u64,
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
    /// Guest memory this host promises its sandboxes at once: a wake beyond
    /// it may end idle VMs that are already saved, otherwise it is refused
    /// at once as host full.
    /// Defaults to the huge-page pool with huge pages, otherwise to the
    /// host's memory less `--memory-headroom-mib`.
    #[arg(long)]
    memory_capacity_mib: Option<u64>,
    /// Host memory kept back from sandboxes for the agent, VMMs, pagers and
    /// the page cache when the capacity comes from the host's memory.
    /// Defaults to a sixteenth of it, at least 1 GiB.
    #[arg(long)]
    memory_headroom_mib: Option<u64>,
    /// Memory kept free for wakes ahead of time by pushing idle sandboxes
    /// deeper in the background. Defaults to a sixteenth of the capacity.
    #[arg(long)]
    memory_buffer_mib: Option<u64>,
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
    /// A running sandbox whose VM moves at least this many KiB a second
    /// through its disk and network counts as busy and stays awake; 0
    /// ignores traffic.
    #[arg(long, default_value_t = BusyRule::DEFAULT.io_bytes_per_second >> 10)]
    busy_io_kib: u64,
    /// ...averaged over this long.
    #[arg(long, default_value = "5s", value_parser = parse_duration)]
    busy_window: Duration,
    /// This host cannot compress paused VMs' memory, for example because
    /// guest memory uses huge pages. The `nested` memory profile implies it.
    #[arg(long)]
    no_compress: bool,
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

/// Runs as a VM's memory pager when the first argument is `pager` (the
/// agent starts its pagers from its own binary; see
/// [`compute_host::PagerConfig`]), and as the agent or its client
/// otherwise.
fn main() -> std::process::ExitCode {
    let mut args = std::env::args_os().skip(1);
    #[cfg(target_os = "linux")]
    if args.next().is_some_and(|first| first == "pager") {
        return compute_pager::linux::serve::main(args);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = args.next();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build();
    let result = runtime
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(agent_main()));
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error:?}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn agent_main() -> anyhow::Result<()> {
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
            memory_request_mib,
            cpu_request_millis,
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
                memory_request_mib,
                cpu_request_millis,
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
        Command::Exec { id, script, port } => exec(&client, id, port, &script).await,
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
    let sample_every = Duration::from_secs(1);
    let budget = admission_budget(
        args.memory_profile,
        args.memory_capacity_mib,
        args.memory_headroom_mib,
    )?;
    tracing::info!(capacity_mib = budget >> 20, "guest memory capacity");
    policy.admission = Some(Admission {
        budget,
        buffer: args.memory_buffer_mib.map_or(budget / 16, |mib| mib << 20),
        // Work seen in the last two samples keeps a sandbox from being
        // pushed deeper to make room.
        busy_grace: 2 * sample_every,
    });
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
        sample_every,
        guest_ports: args.guest_ports,
        restore_notice_port: args.restore_notice_port,
        first_uid: args.first_uid,
        host_lock: Some(args.host_lock),
        network: args.network.then_some(NetworkConfig {
            pool: args.network_pool,
            trusted: args.trusted,
            blocked: args.blocked,
            dns: args.dns,
        }),
        busy: (args.busy_cpu_percent > 0 || args.busy_io_kib > 0).then_some(BusyRule {
            cpu_percent: args.busy_cpu_percent,
            io_bytes_per_second: args.busy_io_kib.saturating_mul(1024),
            window: args.busy_window,
        }),
        can_compress: !args.no_compress,
        // The running binary even once an upgrade has replaced its file,
        // so a pager always speaks its agent's protocol.
        pager: PagerConfig {
            program: args
                .pager
                .unwrap_or_else(|| PathBuf::from("/proc/self/exe")),
            record_for: Duration::from_millis(args.pager_record_ms),
        },
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

/// One number from `/proc/meminfo`, such as `MemTotal:` (in KiB) or
/// `HugePages_Total:`; 0 when missing.
fn meminfo_field(meminfo: &str, name: &str) -> u64 {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Bytes of guest memory the host promises its sandboxes at once:
/// `capacity_mib` if given, else the huge-page pool where guest memory
/// lives in it (nothing else on the host uses it), else the host's memory
/// less `headroom_mib` (default a sixteenth, at least 1 GiB).
fn admission_budget(
    profile: MemoryProfile,
    capacity_mib: Option<u64>,
    headroom_mib: Option<u64>,
) -> anyhow::Result<u64> {
    if let Some(capacity) = capacity_mib {
        return Ok(capacity << 20);
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    if profile.pages == compute_engine::PageSize::Huge {
        let pages = meminfo_field(&meminfo, "HugePages_Total:");
        return Ok(pages * (meminfo_field(&meminfo, "Hugepagesize:") << 10));
    }
    let total = meminfo_field(&meminfo, "MemTotal:") << 10;
    let headroom = headroom_mib.map_or((total / 16).max(1 << 30), |mib| mib << 20);
    Ok(total.saturating_sub(headroom))
}

/// Refuses a huge-page memory profile on a host without a reserved pool of
/// 2 MiB pages: every VM's memory would fail to allocate.
fn check_huge_pages(profile: MemoryProfile) -> anyhow::Result<()> {
    if profile.pages != compute_engine::PageSize::Huge {
        return Ok(());
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let field = |name: &str| meminfo_field(&meminfo, name);
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
