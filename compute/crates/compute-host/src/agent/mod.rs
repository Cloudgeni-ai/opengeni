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
    Action, At, HoldId, Host, HostPolicy, Input, Level, OpId, Outcome, Priority, SandboxId,
    SleepPolicy, Step,
};
use compute_engine::{CancellationToken, Engine, VmSpec};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use crate::guest_ports::{self, Activity, GuestPort, Listeners};
use crate::layout::{Images, Paths, check_root};
use crate::net::{NetworkConfig, Networks};
use crate::protocol::{HostStatus, Id, SandboxConfig, StepStats};
use crate::state::{Record, Records, StateError, lock_exclusive};
use crate::step::{After, Live};
use crate::store::Store;

mod handle;
mod recover;
mod requests;
mod sample;
mod steps;

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
    /// agent at a time may hand them out. `None` only where no two agents
    /// can meet, as in tests with fake VMs.
    pub host_lock: Option<PathBuf>,
}

/// When a running sandbox counts as busy: over `window`, its VM used at
/// least `cpu_percent` of one processor on average, or moved at least
/// `io_bytes_per_second` on average through its network and disk (see
/// [`Engine::io_bytes`]). Vsock traffic needs no rule: it always runs over a
/// stream the agent proxies, and an open stream keeps a sandbox awake on its
/// own.
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
    },
    StepDone {
        id: Id,
        op: OpId,
        outcome: Outcome,
        after: After<V>,
        /// VM processes the step started, including ones it ended again.
        launches: u32,
    },
    Exited {
        id: Id,
        incarnation: u64,
    },
    Destroyed {
        id: Id,
        ordinal: u32,
        result: Result<(), HostError>,
    },
    /// Everything a VM process of `id` left behind is released.
    TornDown {
        id: Id,
    },
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
    core: Host,
    origin: Instant,
    slots: HashMap<SandboxId, Slot<E::Vm>>,
    preparing: HashSet<SandboxId>,
    ordinals: BTreeSet<u32>,
    /// Sandboxes on disk the host does not manage, with why: their ids are
    /// refused and their files and VMs left alone.
    blocked: BTreeMap<SandboxId, String>,
    destroying: HashMap<SandboxId, Vec<Reply<()>>>,
    /// Dead VM processes of each sandbox still being torn down. Nothing new
    /// starts for a sandbox until its count is back to zero, so no teardown
    /// ever removes files of a newer VM.
    tearing_down: HashMap<SandboxId, u32>,
    /// The teardown tasks, which the agent waits for before it lets go.
    teardowns: tokio::task::JoinSet<()>,
    /// Stops teardowns retrying once the agent ends; the next agent
    /// finishes them.
    shutdown: CancellationToken,
    /// The host-wide lock, held for the agent's life.
    _host_lock: Option<std::fs::File>,
    commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedReceiver<Event<E::Vm>>,
    events_tx: mpsc::UnboundedSender<Event<E::Vm>>,
    actions: Vec<Action>,
    next_incarnation: u64,
    stats: [StepStats; Step::COUNT],
    available_memory: Option<u64>,
    sample_every: Duration,
    pressure: bool,
    guest_ports: Arc<[GuestPort]>,
    restore_notice_port: Option<u32>,
    #[cfg(target_os = "linux")]
    fetcher: Option<Arc<crate::lazy::Fetcher>>,
    busy: Option<BusyRule>,
    can_compress: bool,
    /// Lets guest connections report activity without keeping the agent
    /// alive once every [`Handle`] is gone.
    commands_tx: mpsc::WeakUnboundedSender<Command>,
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
        check_root(&config.root).map_err(HostError::Invalid)?;
        if config.first_uid == 0 {
            return Err(HostError::Invalid(
                "first_uid must not be 0: VMMs run as unprivileged users".into(),
            ));
        }
        if let Some(network) = &config.network {
            network.check().map_err(HostError::Invalid)?;
        }
        let host_lock = match config.host_lock.clone() {
            Some(path) => Some(
                tokio::task::spawn_blocking(move || lock_exclusive(&path, HANDOVER))
                    .await
                    .map_err(|error| HostError::Io(error.to_string()))??,
            ),
            None => None,
        };
        let (records, strays) = Records::open(config.root.clone(), HANDOVER).await?;
        let images = Images {
            kernel: config.kernel,
            boot_args: match &config.network {
                Some(network) => format!("{} {}", config.boot_args, network.boot_args()),
                None => config.boot_args,
            },
            first_uid: config.first_uid,
            network: config.network.clone(),
        };
        // A sandbox keeps the user and addresses it was given; new ones
        // are handed out by today's settings, which therefore must agree.
        let misfits: Vec<String> = records
            .all()
            .iter()
            .filter_map(|record| images.check(record).err())
            .collect();
        if !misfits.is_empty() {
            return Err(HostError::Invalid(format!(
                "this host's settings do not fit its sandboxes: {}",
                misfits.join("; ")
            )));
        }
        let net = match config.network.clone() {
            Some(network) => Some(Arc::new(
                tokio::task::spawn_blocking(move || Networks::prepare(&network))
                    .await
                    .map_err(|error| HostError::Io(error.to_string()))?
                    .map_err(|error| HostError::Io(error.to_string()))?,
            )),
            None => None,
        };
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        #[cfg(target_os = "linux")]
        let fetcher = store
            .chunks()
            .map(|chunks| Arc::new(crate::lazy::Fetcher::new(chunks.clone())));
        // Huge-page profiles cannot compress, whatever the host says.
        let can_compress = config.can_compress && engine.memory_profile().compress;
        let mut agent = Self {
            engine: Arc::new(engine),
            store: Arc::new(store),
            #[cfg(target_os = "linux")]
            fetcher,
            records: Arc::new(records),
            net,
            images,
            root: config.root,
            base_image: config.base_image,
            pressure: config.policy.memory.is_some(),
            core,
            origin: Instant::now(),
            slots: HashMap::new(),
            preparing: HashSet::new(),
            ordinals: BTreeSet::new(),
            blocked: BTreeMap::new(),
            destroying: HashMap::new(),
            tearing_down: HashMap::new(),
            teardowns: tokio::task::JoinSet::new(),
            shutdown: CancellationToken::new(),
            _host_lock: host_lock,
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
        agent.recover(strays).await;
        let handle = Handle {
            commands: commands_tx,
            holds: Arc::new(AtomicU64::new(1)),
        };
        Ok((handle, tokio::spawn(agent.run())))
    }

    /// The lowest ordinal no sandbox holds.
    fn take_ordinal(&mut self) -> u32 {
        let mut free = 0;
        for taken in &self.ordinals {
            if *taken != free {
                break;
            }
            free += 1;
        }
        self.ordinals.insert(free);
        free
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
