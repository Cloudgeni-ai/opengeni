//! `compute-host`: run the host agent, or talk to one.

mod bench;
mod fleet_cli;
mod observing;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use compute_core::{Admission, DiskPolicy, HostPolicy, MemoryPolicy, Step};
use compute_engine::MemoryProfile;
use compute_engine::firecracker::{Firecracker, FirecrackerConfig};
use compute_host::client::Client;
use compute_host::cpu_share::ProcessorShare;
use compute_host::fleet::{FleetConfig, Leased, Prepared};
use compute_host::net::{Ipv4Net, NetworkConfig};
use compute_host::observe::StoreAlarms;
use compute_host::observe::canary::{self, CanaryConfig};
use compute_host::protocol::{
    About, Id, ImageId, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
    step_name,
};
use compute_host::{
    BusyRule, Chunked, Directory, GuestPort, HostAgent, HostConfig, Keep, NoStore, PagerConfig,
    PoolConfig, Store, Threads, serve,
};
use tokio::signal::unix::SignalKind;

use crate::bench::{BenchArgs, bench, exec};

/// How long a template's freshly booted guest may take to become ready.
const TEMPLATE_READY_TIMEOUT: Duration = Duration::from_secs(120);

/// The agent's memory comes and goes in bursts: transfer buffers and
/// compression contexts while sandboxes archive and wake, on hundreds of
/// blocking threads at once. glibc keeps what each thread freed in that
/// thread's arena; measured, an agent that had archived ten sandboxes kept
/// about 750 MB it no longer used. jemalloc hands freed memory back after
/// a short decay, from background threads while the agent is idle. It
/// replaces `malloc` itself, so the C libraries linked in (zstd) use it
/// too. Pagers run from this binary and use it as well.
#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

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
    Create(Box<CreateArgs>),
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
    /// Build a sandbox image from an OCI image (ADR 19), and store it.
    BuildImage(Box<compute_host::rootfs::BuildArgs>),
    /// Run the guard of a host in a fleet: it stops the VMs when the
    /// host's lease runs out, whatever happens to the agent. Run it as a
    /// service of its own, before the agent.
    Guard(fleet_cli::GuardArgs),
    /// Delete the chunks and manifests in object storage that no sandbox's
    /// stored copy names any more, on any host. Run on a schedule, such as
    /// daily; safe while agents archive. Without `--delete`, only reports.
    Sweep {
        /// The store, as `serve --store` takes it: `gs://bucket/prefix`.
        #[arg(long)]
        store: String,
        #[arg(long)]
        delete: bool,
    },
}

/// The sandbox `create` asks for.
#[derive(Args)]
struct CreateArgs {
    id: Id,
    #[arg(long, default_value_t = 2)]
    vcpus: u8,
    #[arg(long, default_value_t = 1024)]
    memory_mib: u32,
    /// Memory it is guaranteed while it runs; defaults to all of it.
    #[arg(long)]
    memory_request_mib: Option<u32>,
    /// Processor time it is guaranteed under contention, in thousandths
    /// of a processor; defaults to a tenth of each of its processors.
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
    /// The image its disk starts as (ADR 19), by the id `build-image`
    /// printed; defaults to the host's base image.
    #[arg(long)]
    image: Option<ImageId>,
}

impl CreateArgs {
    /// The sandbox it asks for.
    fn config(self) -> SandboxConfig {
        let mut settings = if self.recommended {
            SleepConfig::RECOMMENDED
        } else {
            SleepConfig::default()
        };
        for (rule, after_ms) in self.sleep {
            rule.set(&mut settings, after_ms);
        }
        if let Some(compress) = self.compress {
            settings.compress = compress;
        }
        SandboxConfig {
            image: self.image,
            vcpus: self.vcpus,
            memory_mib: self.memory_mib,
            memory_request_mib: self.memory_request_mib,
            cpu_request_millis: self.cpu_request_millis,
            sleep: settings,
            link: None,
        }
    }
}

#[derive(Args)]
struct ServeArgs {
    /// Directory for sandbox state.
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    firecracker: PathBuf,
    /// An older Firecracker binary kept after an upgrade, so that memory
    /// images it made still wake with their programs. Repeatable; each
    /// file must be named `firecracker`.
    #[arg(long = "retained-firecracker")]
    retained_firecracker: Vec<PathBuf>,
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
    /// The guest kernel's command line. The engine adds the clock source and
    /// the free-page reporting order for the host's memory profile unless
    /// this names them.
    #[arg(
        long,
        default_value = "console=ttyS0 reboot=k panic=1 quiet loglevel=1"
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
    /// Push idle sandboxes deeper when available memory drops below this,
    /// then ask sandboxes in use above their request to give memory back.
    /// Given with `--memory-high-mib` or not at all. Defaults on 4 KiB
    /// pages to a thirty-second of the host's memory, at least 512 MiB;
    /// with huge pages there is no relief from pressure unless both are
    /// given.
    #[arg(long)]
    memory_low_mib: Option<u64>,
    /// ...until expected available memory reaches this. Defaults to twice
    /// the low watermark.
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
    /// Processor time, in millicores, this host guarantees its sandboxes
    /// at once: every sandbox awake or waking reserves its CPU request
    /// from it, and a wake that does not fit is refused at once as host
    /// full. Above it the host overcommits: requests then hold only in
    /// proportion. Kept as given, whatever the VMs' group gets. Defaults
    /// to the processors the VMs may run on, a thousand per processor,
    /// less `--cpu-headroom-millis`, and no more than the VMs' group gets
    /// with every group beside and above it busy, read again every few
    /// seconds.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    cpu_capacity_millis: Option<u64>,
    /// Processor time, in millicores, kept back from sandboxes for the
    /// agent, its pagers and the rest of the host when the capacity comes
    /// from the processors. Defaults to a sixteenth of them, at least 500.
    #[arg(long)]
    cpu_headroom_millis: Option<u64>,
    /// Local disk never booked for saves: room for records, logs and
    /// anything else written beside them. Every VM not saved yet books
    /// what its next save may write; a wake that would book more than is
    /// left beyond this is refused as host full. Defaults to a twentieth
    /// of the filesystem holding the state root, at least 1 GiB.
    #[arg(long)]
    disk_reserve_mib: Option<u64>,
    /// Inodes never booked for saves. Defaults to a twentieth of the
    /// filesystem's, at least 1024.
    #[arg(long)]
    disk_reserve_inodes: Option<u64>,
    /// A port guests may connect to on this host, as `PORT=HOST:PORT`, with
    /// `,wake` appended to wake a sleeping sandbox when data arrives for it.
    /// Repeatable.
    #[arg(long = "guest-port")]
    guest_ports: Vec<GuestPort>,
    /// Seconds a stream into a sandbox (a terminal, a preview, a forwarded
    /// port) may stay silent both ways and still keep it awake.
    #[arg(long, default_value_t = HostConfig::STREAM_IDLE.as_secs())]
    stream_idle_secs: u64,
    /// Guest vsock port to tell about each restore from a memory image, so
    /// the guest can set its clock, reconnect and learn its sandbox id.
    #[arg(long)]
    restore_notice_port: Option<u32>,
    /// Keep warm templates: a guest vsock port that accepts connections
    /// once a freshly booted guest is ready for work. New sandboxes then
    /// start from a saved, booted guest of their shape instead of booting.
    /// Needs `--restore-notice-port`: a sandbox started from a template is
    /// used only once its guest has acknowledged which sandbox it is.
    #[arg(long, requires = "restore_notice_port")]
    template_ready_port: Option<u32>,
    /// A shape, as `VCPUSxMEMORY_MIB[:READY]` such as `2x1024` or
    /// `1x512:16`, whose template is built as soon as the agent starts;
    /// other shapes get one on first use. `:READY` also keeps that many
    /// sandboxes of the shape restored, warm and paused, so a create of it
    /// only claims one. Repeatable. Needs `--template-ready-port`.
    #[arg(long = "template", requires = "template_ready_port")]
    templates: Vec<Keep>,
    /// How long a shape may go unused (no create) before its template and
    /// ready sandboxes are given up, until its next create.
    #[arg(long, default_value_t = PoolConfig::UNUSED_AFTER.as_secs())]
    template_unused_secs: u64,
    /// How guest memory is backed and saved: `bare-metal` (4 KiB pages,
    /// dirty-page tracking, compression allowed) or `nested` (2 MiB pages
    /// from the host's reserved huge-page pool, resident-page saves, no
    /// compression). By default `nested` when this host is itself a VM (its
    /// CPU reports the hypervisor flag) and `bare-metal` otherwise. Nested
    /// hosts need the pool reserved first, for example through
    /// `/proc/sys/vm/nr_hugepages`.
    #[arg(long)]
    memory_profile: Option<MemoryProfile>,
    /// Give every sandbox a network: its own namespace, a fixed guest
    /// address, internet access through NAT, and nothing else.
    #[arg(long)]
    network: bool,
    /// Addresses for the host's links to sandbox namespaces, two per
    /// sandbox. Must not be used for anything else.
    #[arg(long, default_value = "198.18.0.0/15")]
    network_pool: Ipv4Net,
    /// A destination beyond the internet that sandboxes may open TCP
    /// connections to, and its ports: `DESTINATION:PORTS`, the destination
    /// a DNS name, an address or `address/prefix`, the ports a list such as
    /// `443,9443-9445`. The host resolves a name when the agent starts, and
    /// sandboxes' name server answers it with those addresses. Nothing else
    /// on the host's local or overlay network is reachable, and never the
    /// host, metadata services or other sandboxes. Repeatable.
    #[arg(long = "reach")]
    reach: Vec<compute_host::net::Reach>,
    /// Another range sandboxes may not reach, such as the host's public
    /// address where the cloud maps it onto a private one. Repeatable.
    #[arg(long = "block")]
    blocked: Vec<Ipv4Net>,
    /// A name server the host asks for sandboxes, tried in order;
    /// repeatable. Use public ones: whatever names it knows, sandboxes can
    /// look up.
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
    /// Async worker threads. Defaults to a quarter of the host's
    /// processors, from 2 to 8.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    worker_threads: Option<u32>,
    /// Most threads for blocking work such as file copies and
    /// compression. Defaults to 64 more than `--compress-threads`.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    blocking_threads: Option<u32>,
    /// Most chunks compressed at once for object storage, each holding a
    /// processor. Defaults to a quarter of the host's processors, from 2
    /// to 8.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    compress_threads: Option<u32>,
    #[command(flatten)]
    fleet: fleet_cli::FleetArgs,
    #[command(flatten)]
    observe: observing::ObserveArgs,
}

impl ServeArgs {
    /// The thread counts asked for, the host's defaults otherwise.
    fn threads(&self) -> Threads {
        let defaults = Threads::for_host();
        let get = |asked: Option<u32>, default: usize| {
            asked.map_or(default, |asked| usize::try_from(asked).unwrap_or(default))
        };
        let compress = get(self.compress_threads, defaults.compress);
        Threads {
            workers: get(self.worker_threads, defaults.workers),
            blocking: get(self.blocking_threads, compress + 64),
            compress,
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
    let cli = Cli::parse();
    let threads = match &cli.command {
        Command::Serve(args) => args.threads(),
        _ => Threads::for_host(),
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads.workers)
        .max_blocking_threads(threads.blocking)
        .enable_all()
        .build();
    let result = runtime
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(agent_main(cli)));
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error:?}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn agent_main(cli: Cli) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let client = Client::new(&cli.socket);
    match cli.command {
        Command::Serve(args) => Box::pin(run_serve(*args, cli.socket)).await,
        Command::Create(args) => {
            let id = args.id;
            let config = args.config();
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
        Command::BuildImage(args) => compute_host::rootfs::build(*args).await,
        Command::Guard(args) => {
            let config = args.config();
            tokio::task::spawn_blocking(move || compute_host::fleet::run_guard(&config)).await?
        }
        Command::Sweep { store, delete } => {
            let chunked = Chunked::from_url(&store)?
                .with_context(|| format!("{store} is not an object storage URL"))?;
            let report = chunked.sweep(delete).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
    }
}

fn expect_done(reply: Reply) -> anyhow::Result<()> {
    match reply {
        Reply::Done => Ok(()),
        other => bail!("{other:?}"),
    }
}

/// What this agent runs, as status reports it, so a measurement can say
/// what it measured. The engine adds its runtime.
fn describe(memory_profile: MemoryProfile, base_image: &std::path::Path) -> About {
    let build = std::fs::File::open("/proc/self/exe")
        .and_then(|exe| {
            let mut hasher = blake3::Hasher::new();
            std::io::copy(&mut std::io::BufReader::new(exe), &mut hasher)?;
            Ok(hasher.finalize().to_hex()[..16].to_owned())
        })
        .unwrap_or_else(|error| format!("unknown ({error})"));
    let base_image = match std::fs::metadata(base_image) {
        Ok(found) => {
            let changed = found
                .modified()
                .ok()
                .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_secs());
            format!(
                "{} ({} bytes, changed at {changed} s past the epoch)",
                base_image.display(),
                found.len()
            )
        }
        Err(error) => format!("{} ({error})", base_image.display()),
    };
    About {
        build,
        runtime: String::new(),
        memory_profile: memory_profile.to_string(),
        base_image,
        // The agent says, once it knows its store and state root.
        checkpoints: false,
    }
}

/// The ready pool and templates, if `--template-ready-port` turns them on.
fn pool_config(args: &ServeArgs) -> Option<PoolConfig> {
    args.template_ready_port.map(|ready_port| PoolConfig {
        ready_port,
        shapes: args.templates.iter().map(|keep| keep.shape).collect(),
        depends_on: vec![args.firecracker.clone(), args.jailer.clone()],
        ready_timeout: TEMPLATE_READY_TIMEOUT,
        ready: args
            .templates
            .iter()
            .filter(|keep| keep.ready > 0)
            .map(|keep| (keep.shape, keep.ready))
            .collect(),
        unused_after: Duration::from_secs(args.template_unused_secs),
    })
}

/// What the host may do, from its flags.
fn host_policy(
    args: &ServeArgs,
    memory_profile: MemoryProfile,
    sample_every: Duration,
) -> anyhow::Result<HostPolicy> {
    let mut policy = HostPolicy::default();
    for &(step, limit) in &args.limits {
        policy.limits = policy.limits.with(step, limit);
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("reading /proc/meminfo")?;
    let budget = admission_budget(
        &meminfo,
        memory_profile,
        args.memory_capacity_mib,
        args.memory_headroom_mib,
    );
    tracing::info!(capacity_mib = budget >> 20, "guest memory capacity");
    policy.admission = Some(Admission {
        budget,
        buffer: args.memory_buffer_mib.map_or(budget / 16, |mib| mib << 20),
        // Work of its own is reported once per busy window, at the first
        // sample after the window ends: work seen within a window and two
        // samples keeps a sandbox from being pushed deeper to make room.
        busy_grace: args.busy_window + 2 * sample_every,
    });
    // Those its VMs may run on.
    let processors = compute_host::cpu_share::processors(&args.cgroup);
    let cpu = cpu_budget(
        processors,
        args.cpu_capacity_millis,
        args.cpu_headroom_millis,
    )?;
    policy.cpu_budget = Some(cpu);
    policy.memory = memory_policy(
        memory_profile,
        args.memory_low_mib,
        args.memory_high_mib,
        meminfo_field(&meminfo, "MemTotal:") << 10,
    )?;
    if let Some(memory) = policy.memory {
        tracing::info!(
            low_mib = memory.low_watermark >> 20,
            high_mib = memory.high_watermark >> 20,
            "memory pressure relief"
        );
    }
    policy.disk = Some(disk_policy(
        &args.root,
        args.disk_reserve_mib,
        args.disk_reserve_inodes,
    )?);
    Ok(policy)
}

async fn run_serve(args: ServeArgs, socket: PathBuf) -> anyhow::Result<()> {
    let pool = pool_config(&args);
    let threads = args.threads();
    tracing::info!(?threads, "thread counts");
    let memory_profile = args.memory_profile.map_or_else(chosen_memory_profile, Ok)?;
    let sample_every = Duration::from_secs(1);
    let mut policy = host_policy(&args, memory_profile, sample_every)?;
    let share = processor_share(&args, &policy);
    let engine = Firecracker::new(FirecrackerConfig {
        firecracker: args.firecracker,
        retained: args.retained_firecracker,
        jailer: args.jailer,
        cgroup_parent: args.cgroup.clone(),
    })
    .with_context(|| format!("setting up Firecracker in cgroup {}", args.cgroup.display()))?
    .with_memory_profile(memory_profile)
    .with_context(|| format!("memory profile {memory_profile}"))?;
    let processor_share = guarantee_vm_processors(share, &mut policy)?;
    check_huge_pages(memory_profile)?;
    check_zswap(memory_profile.compress && !args.no_compress)?;
    raise_open_file_limit();
    protect_from_oom()?;
    let about = describe(memory_profile, &args.base_image);
    let budget = policy
        .admission
        .as_ref()
        .map_or(0, |admission| admission.budget);
    let fleet = args.fleet.config(&fleet_cli::Described {
        root: &args.root,
        memory_profile: memory_profile.to_string(),
        cpu_template: compute_engine::Engine::runtime(&engine).to_owned(),
        memory_bytes: budget,
        cpu_millis: policy
            .cpu_budget
            .context("a serving host guarantees processor time")?,
    })?;
    let prepared = fleet.as_ref().map(FleetConfig::prepare).transpose()?;
    // A host in a fleet keeps agent links for the sandboxes that run
    // Opengeni's agent; its tokens come from the control service.
    let agent_link = fleet.as_ref().map(FleetConfig::agent_links).transpose()?;
    let observer = args.observe.observer(&about, fleet.as_ref())?;
    let canary = args.observe.canary(&args.root, args.store.is_some())?;
    // The canary makes sandboxes of its own, which a fleet's service would
    // not know of: the host would drop them when it registers.
    anyhow::ensure!(
        fleet.is_none() || canary.is_none(),
        "the canary runs on a host outside a fleet; a host in a fleet takes its sandboxes from \
         the control service only"
    );
    let config = HostConfig {
        root: args.root,
        kernel: args.kernel,
        boot_args: args.boot_args,
        base_image: args.base_image,
        policy,
        sample_every,
        disk_reading: None,
        stream_idle: Duration::from_secs(args.stream_idle_secs),
        guest_ports: args.guest_ports,
        restore_notice_port: args.restore_notice_port,
        first_uid: args.first_uid,
        host_lock: Some(args.host_lock),
        pool,
        network: args.network.then_some(NetworkConfig {
            pool: args.network_pool,
            reach: args.reach,
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
        about,
        observer: observer.clone(),
        summary_every: HostConfig::SUMMARY_EVERY,
        lease: prepared.as_ref().map(|prepared| prepared.gate.clone()),
        agent_link,
        processor_share,
    };
    // Boxed: the agent and everything it was given are large.
    Box::pin(run_with_store(
        config,
        engine,
        args.store,
        threads,
        socket,
        canary,
        fleet.zip(prepared),
    ))
    .await
}

/// The memory profile the CPU's hypervisor flag calls for, when the
/// operator names none.
fn chosen_memory_profile() -> anyhow::Result<MemoryProfile> {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").context("reading /proc/cpuinfo")?;
    let profile = MemoryProfile::for_cpuinfo(&cpuinfo);
    tracing::info!(%profile, "memory profile chosen from the CPU's hypervisor flag");
    Ok(profile)
}

/// Runs the agent on the store `store` names: none, a bucket or a
/// directory. A host in a fleet needs a bucket, and archives there only
/// while it holds its lease.
async fn run_with_store(
    config: HostConfig,
    engine: Firecracker,
    store: Option<String>,
    threads: Threads,
    socket: PathBuf,
    canary: Option<CanaryConfig>,
    fleet: Option<(FleetConfig, Prepared)>,
) -> anyhow::Result<()> {
    let Some(store) = store else {
        anyhow::ensure!(
            fleet.is_none(),
            "a host in a fleet needs a store in object storage"
        );
        return run_agent(config, engine, NoStore, socket, canary, None).await;
    };
    if let Some(chunked) = Chunked::from_url(&store)? {
        let chunked = chunked
            .with_compress_threads(threads.compress)
            .with_watch(Arc::new(StoreAlarms(config.observer.clone())));
        if let Some((fleet, prepared)) = fleet {
            let leased = Leased::new(chunked, prepared.gate.clone());
            return run_agent(
                config,
                engine,
                leased,
                socket,
                canary,
                Some((fleet, prepared)),
            )
            .await;
        }
        return run_agent(config, engine, chunked, socket, canary, None).await;
    }
    anyhow::ensure!(
        fleet.is_none(),
        "a host in a fleet needs a store in object storage, which other hosts can reach"
    );
    // Fine for tests and a single machine, but an archive there does not
    // survive losing this host.
    tracing::warn!(%store, "archives go to a directory on this host, not off it");
    run_agent(config, engine, Directory::new(store), socket, canary, None).await
}

async fn run_agent<S: Store>(
    config: HostConfig,
    engine: Firecracker,
    store: S,
    socket: PathBuf,
    canary: Option<CanaryConfig>,
    fleet: Option<(FleetConfig, Prepared)>,
) -> anyhow::Result<()> {
    let observer = config.observer.clone();
    let links = config.agent_link.clone();
    let (handle, agent) = HostAgent::start(config, engine, store).await?;
    // On a host in a fleet only the service creates, adopts and hands off
    // sandboxes; the socket serves the host's own tools the rest.
    let local = if fleet.is_some() {
        handle.local_to_fleet()
    } else {
        handle.clone()
    };
    if let Some(canary) = canary {
        tokio::spawn(canary::run(handle.clone(), canary));
    }
    let joined = async {
        match fleet {
            Some((fleet, prepared)) => fleet.run(prepared, handle).await,
            None => std::future::pending().await,
        }
    };
    let mut terminate = tokio::signal::unix::signal(SignalKind::terminate())?;
    let result = tokio::select! {
        result = serve(local, &socket) => result.context("serving"),
        result = tokio::signal::ctrl_c() => result.map_err(Into::into),
        _ = terminate.recv() => Ok(()),
        result = agent => result.map_err(Into::into),
        result = joined => result.context("in the fleet"),
    };
    // Stopped by a signal, the agent did not get to it: the agent links'
    // sessions are on disk before the next agent reads them.
    if let Some(links) = links {
        links.shutdown().await;
    }
    // What happened last, often why it stopped, still reaches the
    // collector; a collector that is away does not hold the stop up long.
    if tokio::time::timeout(FLUSH_WITHIN, observer.flush())
        .await
        .is_err()
    {
        tracing::warn!("stopping before every event reached the collector");
    }
    result
}

/// How long a stopping agent waits for its last events to be exported.
const FLUSH_WITHIN: Duration = Duration::from_secs(5);

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

/// What the out-of-memory killer adds to the agent's badness, in
/// thousandths of the memory it weighs: the agent outlasts every VM
/// process (VMMs and pagers raise theirs to -900) and nearly anything
/// else on a short host. Not -1000: that makes a process unkillable even
/// inside its own service unit, so an agent that leaked up to the unit's
/// `MemoryMax` would hang in reclaim instead of being killed and restarted.
/// Its helpers inherit it.
const OOM_SCORE_ADJ: i32 = -999;

fn protect_from_oom() -> anyhow::Result<()> {
    std::fs::write("/proc/self/oom_score_adj", OOM_SCORE_ADJ.to_string())
        .context("lowering the agent's oom_score_adj (needs CAP_SYS_RESOURCE)")
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
    meminfo: &str,
    profile: MemoryProfile,
    capacity_mib: Option<u64>,
    headroom_mib: Option<u64>,
) -> u64 {
    if let Some(capacity) = capacity_mib {
        return capacity << 20;
    }
    if profile.pages == compute_engine::PageSize::Huge {
        let pages = meminfo_field(meminfo, "HugePages_Total:");
        return pages * (meminfo_field(meminfo, "Hugepagesize:") << 10);
    }
    let total = meminfo_field(meminfo, "MemTotal:") << 10;
    let headroom = headroom_mib.map_or((total / 16).max(1 << 30), |mib| mib << 20);
    total.saturating_sub(headroom)
}

/// Millicores a host of `processors` guarantees its sandboxes at once:
/// `capacity` when given, otherwise its processors less `headroom`, by
/// default a sixteenth of them, at least 500 millicores.
fn cpu_budget(
    processors: usize,
    capacity: Option<u64>,
    headroom: Option<u64>,
) -> anyhow::Result<u64> {
    if let Some(capacity) = capacity {
        return Ok(capacity);
    }
    let total = u64::try_from(processors)
        .unwrap_or(u64::MAX)
        .saturating_mul(1000);
    let headroom = headroom.unwrap_or((total / 16).max(500));
    let budget = total.saturating_sub(headroom);
    anyhow::ensure!(
        budget > 0,
        "a processor headroom of {headroom} millicores leaves sandboxes none of this host's \
         {total}: lower --cpu-headroom-millis or give --cpu-capacity-millis"
    );
    Ok(budget)
}

/// The VMs' processor share, when the host guarantees processor time: of
/// `policy`'s budget, kept as given when the operator gave it.
fn processor_share(args: &ServeArgs, policy: &HostPolicy) -> Option<ProcessorShare> {
    let share = ProcessorShare::new(args.cgroup.clone(), policy.cpu_budget?);
    Some(if args.cpu_capacity_millis.is_some() {
        share.stated()
    } else {
        share
    })
}

/// Gives the VMs' group the processor `share` that covers the host's
/// budget against the groups beside and above it (see
/// [`compute_host::cpu_share`]), and sets `policy`'s budget to what the
/// host guarantees with it; returns the share, which the agent keeps up
/// to date as those groups change.
fn guarantee_vm_processors(
    share: Option<ProcessorShare>,
    policy: &mut HostPolicy,
) -> anyhow::Result<Option<ProcessorShare>> {
    let Some(share) = share else {
        return Ok(None);
    };
    let budget = share.budget();
    let applied = share.apply().with_context(|| {
        format!(
            "setting the processor share of {}",
            share.cgroup().display()
        )
    })?;
    if applied.capacity == budget && applied.whole(budget) {
        tracing::info!(
            capacity_millis = applied.capacity,
            weight = applied.weight,
            processors_millis = applied.processors,
            "guaranteed processor capacity"
        );
    } else if applied.capacity > applied.gets {
        tracing::warn!(
            capacity_millis = applied.capacity,
            gets_millis = applied.gets,
            weight = applied.weight,
            "the processor capacity given is more than the VMs get with every group beside \
             them busy: requests then hold only in proportion"
        );
    } else {
        tracing::warn!(
            capacity_millis = applied.capacity,
            budget_millis = budget,
            weight = applied.weight,
            "with every group beside and above them busy the VMs get less than the processor \
             budget; guaranteeing what they get"
        );
    }
    policy.cpu_budget = Some(applied.capacity);
    Ok(Some(share))
}

/// The least default low watermark on 4 KiB pages.
const DEFAULT_LOW_WATERMARK_MIN: u64 = 512 << 20;

/// When the host relieves memory pressure (ADR 14): at the watermarks
/// given, which go together. Without them a host on 4 KiB pages still
/// relieves it, because its sandboxes may use more than their request and
/// nothing else keeps that use from running the host out of memory: from
/// a thirty-second of the host's `total` bytes available (at least
/// 512 MiB) until twice that is. With huge pages every awake sandbox is
/// booked whole, so there is relief only when asked for.
fn memory_policy(
    profile: MemoryProfile,
    low_mib: Option<u64>,
    high_mib: Option<u64>,
    total: u64,
) -> anyhow::Result<Option<MemoryPolicy>> {
    let (low, high) = match (low_mib, high_mib) {
        (Some(low), Some(high)) => (low << 20, high << 20),
        (None, None) if profile.pages == compute_engine::PageSize::Base => {
            let low = (total / 32).max(DEFAULT_LOW_WATERMARK_MIN);
            (low, 2 * low)
        }
        (None, None) => return Ok(None),
        _ => bail!("--memory-low-mib and --memory-high-mib go together"),
    };
    if high < low {
        bail!("--memory-high-mib must be at least --memory-low-mib");
    }
    Ok(Some(MemoryPolicy {
        low_watermark: low,
        high_watermark: high,
        compressed_percent: 25,
        balloon_grace: Duration::from_secs(3),
    }))
}

/// The local disk kept back from saves on the filesystem holding `root`:
/// as given, or a twentieth of its bytes (at least 1 GiB) and inodes (at
/// least 1024).
fn disk_policy(
    root: &Path,
    reserve_mib: Option<u64>,
    reserve_inodes: Option<u64>,
) -> anyhow::Result<DiskPolicy> {
    // Before anything is made there: a state root on a filesystem whose
    // saves cannot be booked is refused untouched.
    compute_host::check_filesystem(root)
        .with_context(|| format!("state root {}", root.display()))?;
    std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
    let stat = rustix::fs::statvfs(root)
        .with_context(|| format!("reading the filesystem of {}", root.display()))?;
    let size = stat.f_blocks.saturating_mul(stat.f_frsize);
    let policy = DiskPolicy {
        reserve: reserve_mib.map_or((size / 20).max(1 << 30), |mib| mib << 20),
        reserve_inodes: reserve_inodes.unwrap_or((stat.f_files / 20).max(1024)),
    };
    tracing::info!(
        reserve_mib = policy.reserve >> 20,
        reserve_inodes = policy.reserve_inodes,
        "disk kept back from saves"
    );
    Ok(policy)
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
            "the {profile} memory profile needs reserved huge pages; set \
             /proc/sys/vm/nr_hugepages, or choose a profile with --memory-profile"
        );
    }
    tracing::info!(
        pool_mib = total * 2,
        free_mib = field("HugePages_Free:") * 2,
        "huge-page pool"
    );
    Ok(())
}

/// Compressing paused VMs needs zswap: without it the memory pushed out
/// would go to the swap device, and `memory.zswap.writeback` would mean
/// nothing.
fn check_zswap(compress: bool) -> anyhow::Result<()> {
    if compress
        && !compute_engine::cgroup::zswap_enabled().context("reading whether zswap is on")?
    {
        bail!("compressing paused VMs needs zswap; turn it on or pass --no-compress");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    /// A host keeps a sixteenth of its processors back, at least half of
    /// one, unless told otherwise.
    #[test]
    fn processor_capacity_keeps_headroom_back() {
        assert_eq!(cpu_budget(16, None, None).unwrap(), 15_000);
        assert_eq!(cpu_budget(64, None, None).unwrap(), 60_000);
        assert_eq!(cpu_budget(2, None, None).unwrap(), 1500);
        assert_eq!(cpu_budget(8, None, Some(2000)).unwrap(), 6000);
        // Given outright, overcommitted or not.
        assert_eq!(cpu_budget(8, Some(32_000), None).unwrap(), 32_000);
        assert!(cpu_budget(1, None, Some(1000)).is_err());
    }

    /// A host on 4 KiB pages relieves memory pressure without being told
    /// to: its sandboxes may use more than they are guaranteed.
    #[test]
    fn four_kib_pages_relieve_pressure_by_default() {
        let policy = memory_policy(MemoryProfile::bare_metal(), None, None, 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(policy.low_watermark, GIB);
        assert_eq!(policy.high_watermark, 2 * GIB);
        // A small host keeps at least 512 MiB.
        let small = memory_policy(MemoryProfile::bare_metal(), None, None, 4 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(small.low_watermark, 512 << 20);
        assert_eq!(small.high_watermark, GIB);
    }

    /// Huge pages book every awake sandbox whole: relief only when asked.
    #[test]
    fn huge_pages_relieve_pressure_only_when_asked() {
        assert_eq!(
            memory_policy(MemoryProfile::nested(), None, None, 32 * GIB).unwrap(),
            None
        );
        let asked = memory_policy(MemoryProfile::nested(), Some(1024), Some(1536), 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(
            (asked.low_watermark, asked.high_watermark),
            (GIB, 1536 << 20)
        );
    }

    #[test]
    fn watermarks_go_together_in_order() {
        let profile = MemoryProfile::bare_metal();
        assert!(memory_policy(profile, Some(1024), None, 32 * GIB).is_err());
        assert!(memory_policy(profile, None, Some(1024), 32 * GIB).is_err());
        assert!(memory_policy(profile, Some(2048), Some(1024), 32 * GIB).is_err());
        let given = memory_policy(profile, Some(4096), Some(4096), 32 * GIB)
            .unwrap()
            .unwrap();
        assert_eq!(given.low_watermark, given.high_watermark);
    }

    /// The capacity a host offers: the huge-page pool, or its memory less
    /// a sixteenth (at least 1 GiB), unless given.
    #[test]
    fn capacity_follows_the_profile() {
        let meminfo =
            "MemTotal:       33554432 kB\nHugePages_Total:   13000\nHugepagesize:       2048 kB\n";
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::bare_metal(), None, None),
            30 * GIB
        );
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::nested(), None, None),
            13000 * (2 << 20)
        );
        assert_eq!(
            admission_budget(meminfo, MemoryProfile::bare_metal(), Some(1024), None),
            GIB
        );
    }
}
