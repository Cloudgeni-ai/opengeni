//! The host agent: one task owns the decision core and every VM, and
//! carries out the core's decisions.
//!
//! Requests arrive through a [`Handle`]. Steps run as their own tasks and
//! report back as events, so the owning task never waits on a VM and a slow
//! save never delays a wake. Everything that changes a sandbox's state goes
//! through this one task, in order, which is what makes it safe without
//! locks.
//!
//! VM processes are not the agent's children and outlive it. A new agent
//! reads every sandbox's [record](crate::state) and takes back the VMs
//! still running, so restarting, upgrading or killing the agent costs the
//! guests nothing.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use compute_core::{
    Action, At, HoldId, Host, HostPolicy, Input, Level, LoanId, MemoryPolicy, OpId, Outcome,
    Priority, SandboxId, SleepPolicy, Step,
};
use compute_engine::{CancellationToken, Engine, VmSpec};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use crate::guest_ports::{self, Activity, GuestPort, Listeners};
use crate::layout::{Images, Paths, check_root};
use crate::net::{NetworkConfig, Networks};
use crate::pool::{Built, Lender, Loaning, Pool, PoolConfig, Shape, Sources, Template, Uses};

use crate::protocol::{HostStatus, Id, SandboxConfig, StepStats};
use crate::state::{Record, Records, StateError, claim_host};
use crate::step::{After, Live};
use crate::store::Store;

mod handle;
mod ready;
mod recover;
mod requests;
mod sample;
mod steps;
mod warm;

/// Takes the host's lock at `path` for state root `root`; see
/// [`HostConfig::host_lock`].
async fn claim(path: PathBuf, root: PathBuf) -> Result<std::fs::File, HostError> {
    tokio::task::spawn_blocking(move || claim_host(&path, &root, HANDOVER))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(HostError::from)
}

/// How long a starting agent waits for the previous one to let go of the
/// state root.
const HANDOVER: Duration = Duration::from_secs(10);

/// Longest pause between attempts to release what a dead VM left.
const TEARDOWN_RETRY: Duration = Duration::from_secs(30);

/// How a host is set up.
#[derive(Clone, Debug)]
pub struct HostConfig {
    /// Directory holding every sandbox's state.
    pub root: PathBuf,
    /// Uncompressed guest kernel.
    pub kernel: PathBuf,
    /// Kernel command line.
    pub boot_args: String,
    /// Root disk image every new sandbox starts from.
    pub base_image: PathBuf,
    /// Concurrency limits, backoff and memory-pressure handling.
    pub policy: HostPolicy,
    /// How often to sample host and VM memory.
    pub sample_every: Duration,
    /// Ports every sandbox may connect to on this host, and where they lead.
    pub guest_ports: Vec<GuestPort>,
    /// Guest vsock port told about every restore from a memory image, so the
    /// guest can set its clock and reconnect (see [`crate::restore_notice`]).
    /// `None` tells the guest nothing.
    pub restore_notice_port: Option<u32>,
    /// The user id of the sandbox with ordinal 0. Every sandbox on a host
    /// has its own ordinal, and its VMM runs as user and group
    /// `first_uid + ordinal`, so no two VMMs share a user. Must not be 0,
    /// and the range must be reserved for VMMs.
    pub first_uid: u32,
    /// How sandboxes reach the network (see [`crate::net`]). `None` gives
    /// them none.
    pub network: Option<NetworkConfig>,
    /// When a running sandbox counts as busy with work of its own, which
    /// keeps it awake like any other activity. `None` ignores such work.
    pub busy: Option<BusyRule>,
    /// Whether this host can compress a paused VM's memory. Hosts that back
    /// guest memory with huge pages cannot, so they ignore every sandbox's
    /// `compress` setting.
    pub can_compress: bool,
    /// A lock file every agent on this host takes, whatever its state root:
    /// user ids, sandbox networks and firewall rules are the host's, so one
    /// agent at a time may hand them out. The file also names the state root
    /// they belong to: an agent of another root is refused while that root
    /// still has sandboxes, whose VMs may outlive their agent. Work an agent
    /// leaves in flight when it ends keeps the lock until it finishes. `None`
    /// only where no two agents can meet, as in tests with fake VMs.
    pub host_lock: Option<PathBuf>,
    /// Warm templates new sandboxes start from (see [`crate::pool`]).
    /// `None` boots every new sandbox cold.
    pub pool: Option<PoolConfig>,
    /// How VMs whose memory needs a fault handler get one.
    pub pager: PagerConfig,
    /// How long a stream into a sandbox (see [`crate::protocol::Request::Connect`])
    /// may stay silent both ways and still keep it awake. A forgotten
    /// browser tab or terminal then lets its sandbox sleep; the next byte
    /// either way wakes it again.
    pub stream_idle: Duration,
}

impl HostConfig {
    /// The default for [`HostConfig::stream_idle`].
    pub const STREAM_IDLE: Duration = Duration::from_secs(10 * 60);
}

/// How VMs whose memory needs a fault handler get one: a pager process of
/// their own, which the engine starts with the VM (see `compute-pager`).
#[derive(Clone, Debug)]
pub struct PagerConfig {
    /// The program each pager runs as, with `pager` as its first argument:
    /// normally the agent's own binary.
    pub program: PathBuf,
    /// How long after a wake a pager records the order the guest touches
    /// memory in, for the next wake to prefetch. A pager exits no sooner,
    /// even once every page is in place. The window is wall-clock time, and
    /// a first wake on a busy host may take tens of seconds to reach the
    /// working set the next wake should prefetch, so the default is
    /// generous; the profile's order keeps the earliest pages first.
    pub record_for: Duration,
}

impl PagerConfig {
    /// The default recording window.
    pub const RECORD_FOR: Duration = Duration::from_secs(120);

    /// Pagers run as `program`, recording for [`Self::RECORD_FOR`].
    #[must_use]
    pub fn new(program: PathBuf) -> Self {
        Self {
            program,
            record_for: Self::RECORD_FOR,
        }
    }
}

/// When a running sandbox counts as busy: over `window`, its VM used at
/// least `cpu_percent` of one processor on average, or moved at least
/// `io_bytes_per_second` on average through its network and disk (see
/// [`Engine::io_bytes`]).
///
/// Vsock traffic is not reliably measured here: some of it reaches the
/// traffic counters and can count toward the rule, but no keep-awake
/// guarantee rests on it. Streams the host opens into the guest hold the
/// sandbox awake while they are open. Connections the
/// guest opens to its host (see [`crate::guest_ports`]) deliberately do
/// not: a control link carries keepalives for as long as the guest lives,
/// so its traffic alone must not keep a sandbox awake. Data arriving on one
/// can wake the sandbox, and the guest's own work for it shows as
/// processor use.
///
/// This is how the host sees work nobody told it about, such as a build or
/// test run an agent left in the background, or a download that mostly
/// waits on the network. A quiet guest uses well under one percent of a
/// processor and moves no data at all; short periodic jobs average out over
/// the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BusyRule {
    /// Percent of one processor; 0 ignores processor use.
    pub cpu_percent: u32,
    /// Bytes per second; 0 ignores traffic.
    pub io_bytes_per_second: u64,
    /// Averaging window. Readings come every [`HostConfig::sample_every`],
    /// so the effective window is at least that long.
    pub window: Duration,
}

impl BusyRule {
    /// A quarter of one processor, or 4 KiB a second of traffic, over five
    /// seconds. An idle guest moves nothing; a guest still writing back a
    /// finished command's files, or fetching something slowly, moves more.
    pub const DEFAULT: Self = Self {
        cpu_percent: 25,
        io_bytes_per_second: 4 << 10,
        window: Duration::from_secs(5),
    };

    /// Whether using `used` processor time and moving `moved` bytes over
    /// `elapsed` counts as busy.
    #[must_use]
    pub fn is_busy(&self, used: Duration, moved: u64, elapsed: Duration) -> bool {
        let elapsed_us = elapsed.as_micros();
        if elapsed_us == 0 {
            return false;
        }
        // Saturating: a product too large to hold is a bar nothing reaches.
        let cpu = self.cpu_percent > 0
            && used.as_micros().saturating_mul(100)
                >= elapsed_us.saturating_mul(u128::from(self.cpu_percent));
        let io = self.io_bytes_per_second > 0
            && u128::from(moved).saturating_mul(1_000_000)
                >= elapsed_us.saturating_mul(u128::from(self.io_bytes_per_second));
        cpu || io
    }

    /// Whether the rule reads processor use at all.
    #[must_use]
    pub fn watches_cpu(&self) -> bool {
        self.cpu_percent > 0
    }

    /// Whether the rule reads traffic at all.
    #[must_use]
    pub fn watches_io(&self) -> bool {
        self.io_bytes_per_second > 0
    }
}

/// A request the host could not carry out.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    /// No such sandbox.
    #[error("no sandbox {0}")]
    NotFound(Id),
    /// The id is taken.
    #[error("sandbox {0} already exists")]
    Exists(Id),
    /// The sandbox is still being created.
    #[error("sandbox {0} is still being created")]
    Busy(Id),
    /// The sandbox cannot be recovered on this host.
    #[error("sandbox {0} is broken")]
    Broken(Id),
    /// The sandbox was removed while the request waited.
    #[error("sandbox {0} was removed")]
    Removed(Id),
    /// The request is malformed.
    #[error("invalid request: {0}")]
    Invalid(String),
    /// The request names an execution of the sandbox that has since been
    /// replaced by a fresh boot.
    #[error("sandbox {id} is at generation {found}, not {expected}")]
    Stale {
        /// The sandbox.
        id: Id,
        /// The generation the request names.
        expected: u64,
        /// The sandbox's generation now.
        found: u64,
    },
    /// A guest port did not answer.
    #[error("guest port {port} unreachable: {message}")]
    Unreachable {
        /// The port.
        port: u32,
        /// Why.
        message: String,
    },
    /// Host storage failed.
    #[error("host I/O failed: {0}")]
    Io(String),
    /// The host agent has shut down.
    #[error("the host agent stopped")]
    Stopped,
}

impl From<StateError> for HostError {
    fn from(error: StateError) -> Self {
        match error {
            StateError::Generation {
                id,
                expected,
                found,
            } => Self::Stale {
                id,
                expected,
                found,
            },
            StateError::NotFound(id) => Self::NotFound(id),
            StateError::Exists(id) => Self::Exists(id),
            other => Self::Io(other.to_string()),
        }
    }
}

type Reply<T> = oneshot::Sender<Result<T, HostError>>;

#[derive(Debug)]
enum Command {
    Create {
        id: Id,
        config: SandboxConfig,
        reply: Reply<()>,
    },
    Remove {
        id: Id,
        generation: Option<u64>,
        reply: Reply<()>,
    },
    Touch {
        id: Id,
        generation: Option<u64>,
        priority: Priority,
        /// Told whether the request was accepted; guest activity needs no
        /// answer.
        reply: Option<Reply<()>>,
    },
    Sleep {
        id: Id,
        generation: Option<u64>,
        level: Level,
        reply: Reply<()>,
    },
    /// A named hold from the API, with an optional expiry.
    Hold {
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        ttl: Option<Duration>,
        priority: Priority,
        reply: Reply<()>,
    },
    /// Ends a named hold from the API.
    Unhold {
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        reply: Reply<()>,
    },
    Acquire {
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        priority: Priority,
        reply: Reply<Woke>,
    },
    /// Whether the sandbox is still at `generation`.
    Check {
        id: Id,
        generation: u64,
        reply: Reply<()>,
    },
    Release {
        id: Id,
        hold: HoldId,
    },
    Status {
        reply: oneshot::Sender<HostStatus>,
    },
}

#[derive(Debug)]
enum Event<V> {
    Prepared {
        id: Id,
        ordinal: u32,
        result: Result<Record, HostError>,
        reply: Reply<()>,
        /// The template the sandbox could not start from because it no
        /// longer fits today's inputs.
        stale: Option<Arc<Template>>,
    },
    /// A sandbox about to sleep only for being idle told whether a command
    /// started through its guest's helper still runs (see
    /// [`crate::restore_notice::ask_commands`]).
    Asked {
        id: Id,
        op: OpId,
        step: Step,
        running: bool,
    },
    /// The check of a template found on disk ended.
    TemplateChecked {
        shape: Shape,
        result: Box<Result<Template, String>>,
    },
    /// A template build ended; `ordinal` is free again if its VM is gone.
    TemplateBuilt {
        shape: Shape,
        ordinal: u32,
        built: Built,
    },
    StepDone {
        id: Id,
        op: OpId,
        outcome: Outcome,
        after: After<V>,
        /// VM processes the step started, including ones it ended again.
        launches: u32,
    },
    /// Work outside any sandbox asks for or gives back a place under a
    /// step limit.
    Loan(Loaning),
    /// Step `op` of `id` no longer does the work its kind's limit protects.
    Unthrottled {
        id: Id,
        op: OpId,
    },
    Exited {
        id: Id,
        incarnation: u64,
    },
    Destroyed {
        id: Id,
        /// The name its directory and network were made under.
        host: Id,
        /// The ordinal it held, when known.
        ordinal: Option<u32>,
        result: Result<(), HostError>,
    },
    /// Everything a VM process of `id` left behind is released.
    TornDown {
        id: Id,
    },
    /// A ready sandbox's fill ended.
    Filled {
        host: Id,
        filled: Box<ready::Filled<V>>,
    },
    /// A create's claim of a ready sandbox ended.
    Claimed {
        id: Id,
        config: SandboxConfig,
        reply: Reply<()>,
        claimed: Box<ready::Claimed<V>>,
    },
}

/// What a removal that stopped part way left of a sandbox whose record is
/// gone.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Leftover {
    /// The name its directory and network were made under.
    host: Id,
    /// The ordinal it still holds, if known.
    ordinal: Option<u32>,
}

#[derive(Debug)]
struct Running {
    op: OpId,
    step: Step,
    cancel: CancellationToken,
    started: Instant,
}

/// The start of one VM's current activity window. Each reading is kept only
/// when the rule wants it and it worked, so one signal failing leaves the
/// other to judge alone.
#[derive(Clone, Copy, Debug)]
struct ActivityWindow {
    incarnation: u64,
    started: Instant,
    /// Processor time so far.
    cpu: Option<Duration>,
    /// Traffic so far.
    io: Option<u64>,
}

#[derive(Debug)]
struct Slot<V> {
    paths: Arc<Paths>,
    spec: Arc<VmSpec>,
    /// The VM, when one exists and no step holds it.
    vm: Option<Live<V>>,
    /// Incarnation of the VM that exists, wherever it is.
    incarnation: Option<u64>,
    /// VM processes started for it (boots and restores) since the agent
    /// started.
    launches: u64,
    /// A VM that died while a step held it.
    dead: Option<u64>,
    /// Listeners for connections the guest opens to the host.
    _ports: Option<Listeners>,
    op: Option<Running>,
    destroy: bool,
    removers: Vec<Reply<()>>,
    /// Requests waiting for the sandbox to run.
    waiters: Vec<Waiter>,
    /// A step the core started that waits for a dead VM's teardown.
    deferred: Option<Step>,
    /// Processor use and traffic measured so far, while the VM runs.
    activity: Option<ActivityWindow>,
}

/// A request waiting for a sandbox to run.
#[derive(Debug)]
struct Waiter {
    /// The generation it names, if any.
    generation: Option<u64>,
    /// The step under way when it arrived.
    during: Option<Step>,
    reply: Reply<Woke>,
}

/// A sandbox that runs, as a waiter learns of it.
#[derive(Debug)]
struct Woke {
    vsock: PathBuf,
    during: Option<Step>,
}

/// Talks to a running host agent. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Handle {
    commands: mpsc::UnboundedSender<Command>,
    holds: Arc<AtomicU64>,
    stream_idle: Duration,
}

/// Keeps a sandbox awake while it lives. Dropping it lets the sandbox go
/// idle again.
#[derive(Debug)]
pub struct Lease {
    id: Id,
    hold: HoldId,
    vsock: PathBuf,
    waited: Duration,
    /// The step under way when the wake arrived.
    during: Option<Step>,
    /// The generation the lease was asked for, if any.
    generation: Option<u64>,
    commands: mpsc::UnboundedSender<Command>,
}

struct ReleaseOnDrop {
    id: Id,
    hold: HoldId,
    commands: mpsc::UnboundedSender<Command>,
    armed: bool,
}

/// The host agent. Start it with [`HostAgent::start`].
#[derive(Debug)]
pub struct HostAgent<E: Engine, S: Store> {
    engine: Arc<E>,
    store: Arc<S>,
    records: Arc<Records>,
    net: Option<Arc<Networks>>,
    root: PathBuf,
    base_image: PathBuf,
    images: Images,
    warm: Option<Warm>,
    core: Host,
    origin: Instant,
    slots: HashMap<SandboxId, Slot<E::Vm>>,
    preparing: HashSet<SandboxId>,
    ordinals: BTreeSet<u32>,
    /// Sandboxes on disk the host does not manage, with why: their ids are
    /// refused and their files and VMs left alone.
    blocked: BTreeMap<SandboxId, String>,
    destroying: HashMap<SandboxId, Vec<Reply<()>>>,
    /// Blocked sandboxes whose record is gone but whose files a removal
    /// could not finish deleting, with the ordinal they still hold if
    /// known. Removing one again retries.
    leftovers: HashMap<SandboxId, Leftover>,
    /// The host names of claimed ready sandboxes (see [`ready`]), with the
    /// id each answers to. No new sandbox may take one as its id.
    hosts: HashMap<SandboxId, SandboxId>,
    /// Blocked sandboxes with an unreadable record whose ordinal is
    /// unknown. Any new sandbox could clash with one, so none is created
    /// while there are any.
    unknown_ordinals: BTreeSet<SandboxId>,
    /// Template builds an earlier agent left whose VM may still run, as
    /// the user of an ordinal nothing records. No sandbox is created while
    /// there are any.
    unknown_builds: BTreeSet<String>,
    /// Asks this agent for places under its step limits.
    lender: Lender,
    /// Loans waiting for their place, with whom to tell.
    loans: HashMap<LoanId, oneshot::Sender<()>>,
    /// Dead VM processes of each sandbox still being torn down. Nothing new
    /// starts for a sandbox until its count is back to zero, so no teardown
    /// ever removes files of a newer VM.
    tearing_down: HashMap<SandboxId, u32>,
    /// The teardown tasks, which the agent waits for before it lets go.
    teardowns: tokio::task::JoinSet<()>,
    /// Stops teardowns retrying once the agent ends; the next agent
    /// finishes them.
    shutdown: CancellationToken,
    commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedReceiver<Event<E::Vm>>,
    events_tx: mpsc::UnboundedSender<Event<E::Vm>>,
    actions: Vec<Action>,
    next_incarnation: u64,
    stats: [StepStats; Step::COUNT],
    available_memory: Option<u64>,
    sample_every: Duration,
    /// When memory pressure frees memory, if it does.
    memory_policy: Option<MemoryPolicy>,
    /// Ready sandboxes, kept for creates to claim (see [`ready`]).
    ready: ready::Ready<E::Vm>,
    guest_ports: Arc<[GuestPort]>,
    restore_notice_port: Option<u32>,
    #[cfg(target_os = "linux")]
    fetcher: Option<Arc<crate::lazy::Fetcher>>,
    busy: Option<BusyRule>,
    can_compress: bool,
    pager: PagerConfig,
    /// Lets guest connections report activity without keeping the agent
    /// alive once every [`Handle`] is gone.
    commands_tx: mpsc::WeakUnboundedSender<Command>,
}

/// Checks that this host's settings fit every recorded sandbox: a sandbox
/// keeps the user and addresses it was given, and new ones are handed out
/// by today's settings, which therefore must agree.
fn check_fit(images: &Images, records: &Records) -> Result<(), HostError> {
    let misfits: Vec<String> = records
        .all()
        .iter()
        .filter_map(|record| images.check(record).err())
        .collect();
    if misfits.is_empty() {
        Ok(())
    } else {
        Err(HostError::Invalid(format!(
            "this host's settings do not fit its sandboxes: {}",
            misfits.join("; ")
        )))
    }
}

/// Sets up the host's sandbox networking, if sandboxes are networked.
async fn prepare_network(
    network: Option<NetworkConfig>,
) -> Result<Option<Arc<Networks>>, HostError> {
    let Some(network) = network else {
        return Ok(None);
    };
    let prepared = tokio::task::spawn_blocking(move || Networks::prepare(&network))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(|error| HostError::Io(error.to_string()))?;
    Ok(Some(Arc::new(prepared)))
}

/// The host's warm templates and how to build them.
#[derive(Debug)]
struct Warm {
    pool: Pool,
    /// Templates found on disk, until their check starts.
    found: Vec<Template>,
    sources: Arc<Sources>,
    ready_port: u32,
    ready_timeout: Duration,
    /// When each shape was last used.
    uses: Uses,
}

/// Wakes a sandbox when data arrives for it on a guest port.
#[derive(Clone, Debug)]
struct Toucher {
    id: Id,
    commands: mpsc::WeakUnboundedSender<Command>,
}

impl Activity for Toucher {
    fn wake(&self) {
        if let Some(commands) = self.commands.upgrade() {
            let _ = commands.send(Command::Touch {
                id: self.id,
                generation: None,
                priority: Priority::Interactive,
                reply: None,
            });
        }
    }
}

/// Why `config` cannot run an agent, if it cannot.
fn check_config(config: &HostConfig) -> Result<(), String> {
    check_root(&config.root)?;
    if config.first_uid == 0 {
        return Err("first_uid must not be 0: VMMs run as unprivileged users".into());
    }
    if let Some(network) = &config.network {
        network.check()?;
    }
    if config.pool.is_some() && config.restore_notice_port.is_none() {
        // A sandbox started from a template learns which it is only from
        // the restore notice; see `Identity::Pending`.
        return Err("warm templates need a restore notice port".into());
    }
    Ok(())
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Takes over the state root, recovers every sandbox recorded under it,
    /// then runs the agent until every [`Handle`] is dropped.
    ///
    /// VMs an earlier run left running are taken back as they are, running
    /// or paused, with their programs intact. Every other sandbox comes back
    /// at the level its record shows, and removals that were under way
    /// finish.
    pub async fn start(
        config: HostConfig,
        engine: E,
        store: S,
    ) -> Result<(Handle, JoinHandle<()>), HostError> {
        let core =
            Host::new(config.policy).map_err(|error| HostError::Invalid(format!("{error:?}")))?;
        check_config(&config).map_err(HostError::Invalid)?;
        let stream_idle = config.stream_idle;
        let host_lock = match config.host_lock.clone() {
            Some(path) => Some(claim(path, config.root.clone()).await?),
            None => None,
        };
        let (records, strays) = Records::open(config.root.clone(), HANDOVER, host_lock).await?;
        let images = Images {
            kernel: config.kernel,
            boot_args: match &config.network {
                Some(network) => format!("{} {}", config.boot_args, network.boot_args()),
                None => config.boot_args,
            },
            first_uid: config.first_uid,
            network: config.network.clone(),
        };
        check_fit(&images, &records)?;
        let net = prepare_network(config.network.clone()).await?;
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        // Huge-page profiles cannot compress, whatever the host says.
        let can_compress = config.can_compress && engine.memory_profile().compress;
        // Template VMs an earlier agent left are ended before any sandbox
        // can be given the user one of them ran as.
        let warm::Started {
            warm,
            shapes: warm_shapes,
            held,
            ready,
        } = Warm::start(
            config.pool,
            &engine,
            &config.root,
            &config.base_image,
            config.network.is_some(),
            &images,
        )
        .await;
        let mut agent = Self {
            engine: Arc::new(engine),
            #[cfg(target_os = "linux")]
            fetcher: (store.chunks())
                .map(|chunks| Arc::new(crate::lazy::Fetcher::new(chunks.clone()))),
            store: Arc::new(store),
            records: Arc::new(records),
            net,
            images,
            root: config.root,
            base_image: config.base_image,
            warm,
            memory_policy: config.policy.memory,
            ready: ready::Ready::new(ready, config.policy.memory),
            pager: config.pager,
            core,
            origin: Instant::now(),
            slots: HashMap::new(),
            preparing: HashSet::new(),
            ordinals: BTreeSet::new(),
            blocked: BTreeMap::new(),
            destroying: HashMap::new(),
            leftovers: HashMap::new(),
            hosts: HashMap::new(),
            unknown_ordinals: BTreeSet::new(),
            unknown_builds: BTreeSet::new(),
            lender: {
                let events = events_tx.clone();
                Lender::new(move |loaning| {
                    let _ = events.send(Event::Loan(loaning));
                })
            },
            loans: HashMap::new(),
            tearing_down: HashMap::new(),
            teardowns: tokio::task::JoinSet::new(),
            shutdown: CancellationToken::new(),
            commands,
            events,
            events_tx,
            actions: Vec::new(),
            next_incarnation: 1,
            stats: [StepStats::default(); Step::COUNT],
            available_memory: None,
            sample_every: config.sample_every,
            guest_ports: config.guest_ports.into(),
            restore_notice_port: config.restore_notice_port,
            busy: config.busy,
            can_compress,
            commands_tx: commands_tx.downgrade(),
        };
        agent.hold_builds(held);
        agent.recover(strays).await;
        agent.start_templates(warm_shapes);
        let handle = Handle {
            commands: commands_tx,
            holds: Arc::new(AtomicU64::new(1)),
            stream_idle,
        };
        Ok((handle, tokio::spawn(agent.run())))
    }

    /// Refuses while some ordinal is unknown: any ordinal that looks free
    /// could then belong to a VM that still runs as its user.
    fn ordinals_known(&self) -> Result<(), String> {
        if let Some(unknown) = self.unknown_ordinals.first() {
            return Err(format!(
                "sandbox {}'s record is unreadable and the user and network it holds unknown; \
                 no sandbox is created until it is resolved",
                Id(*unknown)
            ));
        }
        if let Some(build) = self.unknown_builds.first() {
            return Err(format!(
                "template build {build} may still run as a user nothing records; \
                 no sandbox is created until a restart of the agent ends it"
            ));
        }
        Ok(())
    }

    /// The lowest ordinal no sandbox holds, unless some ordinal is unknown.
    fn take_ordinal(&mut self) -> Result<u32, String> {
        self.ordinals_known()?;
        let mut free = 0;
        for taken in &self.ordinals {
            if *taken != free {
                break;
            }
            free += 1;
        }
        self.ordinals.insert(free);
        Ok(free)
    }

    fn insert(&mut self, id: Id, paths: Paths, spec: VmSpec) {
        let toucher = Toucher {
            id,
            commands: self.commands_tx.clone(),
        };
        let owner = (spec.uid, spec.gid);
        let ports =
            match guest_ports::listen(&spec.vsock_path(), owner, &self.guest_ports, &toucher) {
                Ok(listeners) => Some(listeners),
                Err(error) => {
                    tracing::error!(%id, %error, "could not listen for guest connections");
                    None
                }
            };
        self.slots.insert(
            id.0,
            Slot {
                paths: Arc::new(paths),
                spec: Arc::new(spec),
                vm: None,
                incarnation: None,
                launches: 0,
                dead: None,
                _ports: ports,
                op: None,
                destroy: false,
                removers: Vec::new(),
                waiters: Vec::new(),
                deferred: None,
                activity: None,
            },
        );
    }

    /// Validates a sandbox's settings and fits its sleep policy to this
    /// host.
    fn sleep_policy(&self, config: &SandboxConfig) -> Result<SleepPolicy, String> {
        config.validate()?;
        let mut rules = config.sleep.rules();
        rules.compress_under_pressure &= self.can_compress;
        SleepPolicy::new(rules).map_err(|error| format!("invalid sleep settings: {error}"))
    }

    async fn run(mut self) {
        let mut sample = tokio::time::interval(self.sample_every);
        sample.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let deadline = self
                .core
                .next_deadline()
                .map(|at| self.origin + at.since_origin());
            tokio::select! {
                biased;
                Some(event) = self.events.recv() => self.on_event(event),
                command = self.commands.recv() => match command {
                    Some(command) => self.on_command(command),
                    None => break,
                },
                () = sleep_until_some(deadline) => self.input(Input::Tick),
                _ = sample.tick() => self.sample(),
            }
        }
        tracing::info!("every handle dropped; host agent stopping, VMs keep running");
        // Teardowns under way finish their current attempt; the next agent
        // retries any that failed.
        self.shutdown.cancel();
        while self.teardowns.join_next().await.is_some() {}
    }

    fn now(&self) -> At {
        At::from_duration(self.origin.elapsed())
    }

    fn input(&mut self, input: Input) {
        self.inputs([input]);
    }

    /// Feeds inputs observed together to the core, which decides once after
    /// all of them.
    fn inputs(&mut self, inputs: impl IntoIterator<Item = Input>) {
        let now = self.now();
        let mut actions = std::mem::take(&mut self.actions);
        self.core.handle_all(now, inputs, &mut actions);
        for action in actions.drain(..) {
            self.execute(action);
        }
        self.actions = actions;
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
