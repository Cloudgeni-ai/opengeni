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
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use compute_core::{
    Action, At, Durability, Failure, HoldId, Host, HostPolicy, Input, Level, Notice, OpId, Outcome,
    Priority, SandboxId, SleepPolicy, State, Step,
};
use compute_engine::{CancellationToken, Engine, Found, VmSpec, vsock};
use futures::StreamExt;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until};

use crate::guest_ports::{self, Activity, GuestPort, Listeners};
use crate::layout::{Images, Paths, check_root, copy_sparse, link_kernel, vm_spec};
use crate::net::{NetworkConfig, Networks};
use crate::protocol::{
    HostStatus, Id, SandboxConfig, SandboxStatus, StepStats, UnreadableSandbox, step_name,
};
use crate::state::{Change, Disk, Fence, Record, Records, StateError, Stray, check_generation};
use crate::step::{After, Job, Live, LiveMemory};
use crate::store::Store;

/// How long a starting agent waits for the previous one to let go of the
/// state root.
const HANDOVER: Duration = Duration::from_secs(10);

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
    /// `first_uid + ordinal`, so no two VMMs share a user.
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
}

/// When a running sandbox counts as busy: its VM used at least
/// `cpu_percent` of one processor, averaged over `window`.
///
/// This is how the host sees work nobody told it about, such as a build or
/// test run an agent left in the background. A quiet guest uses well under
/// one percent; short periodic jobs average out over the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BusyRule {
    /// Percent of one processor.
    pub cpu_percent: u32,
    /// Averaging window. Readings come every [`HostConfig::sample_every`],
    /// so the effective window is at least that long.
    pub window: Duration,
}

impl BusyRule {
    /// A quarter of one processor over five seconds.
    pub const DEFAULT: Self = Self {
        cpu_percent: 25,
        window: Duration::from_secs(5),
    };

    /// Whether using `used` processor time over `elapsed` counts as busy.
    #[must_use]
    pub fn is_busy(&self, used: Duration, elapsed: Duration) -> bool {
        !elapsed.is_zero()
            && used.as_micros() * 100 >= elapsed.as_micros() * u128::from(self.cpu_percent)
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
    /// replaced by a boot or restore.
    #[error("sandbox {id} is at generation {found}, not {expected}")]
    Stale {
        /// The sandbox.
        id: Id,
        /// The generation the request names.
        expected: u64,
        /// The sandbox's generation now.
        found: u64,
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
        reply: Reply<PathBuf>,
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
}

#[derive(Debug)]
struct Running {
    op: OpId,
    step: Step,
    cancel: CancellationToken,
    started: Instant,
}

/// The start of one VM's current processor-use window.
#[derive(Clone, Copy, Debug)]
struct CpuWindow {
    incarnation: u64,
    started: Instant,
    cpu: Duration,
}

#[derive(Debug)]
struct Slot<V> {
    paths: Arc<Paths>,
    spec: Arc<VmSpec>,
    /// The VM, when one exists and no step holds it.
    vm: Option<Live<V>>,
    /// Incarnation of the VM that exists, wherever it is.
    incarnation: Option<u64>,
    /// A VM that died while a step held it.
    dead: Option<u64>,
    /// Listeners for connections the guest opens to the host.
    _ports: Option<Listeners>,
    op: Option<Running>,
    destroy: bool,
    removers: Vec<Reply<()>>,
    waiters: Vec<Reply<PathBuf>>,
    /// Processor use measured so far, while the VM runs.
    cpu: Option<CpuWindow>,
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
    commands: mpsc::UnboundedSender<Command>,
}

struct ReleaseOnDrop {
    id: Id,
    hold: HoldId,
    commands: mpsc::UnboundedSender<Command>,
    armed: bool,
}

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.commands.send(Command::Release {
                id: self.id,
                hold: self.hold,
            });
        }
    }
}

impl Handle {
    async fn ask<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(make(reply))
            .map_err(|_| HostError::Stopped)?;
        answer.await.map_err(|_| HostError::Stopped)
    }

    /// Creates a sandbox. It costs only disk until first needed.
    pub async fn create(&self, id: Id, config: SandboxConfig) -> Result<(), HostError> {
        self.ask(|reply| Command::Create { id, config, reply })
            .await?
    }

    /// Deletes a sandbox and everything it stores, waiting until it is gone.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn remove(&self, id: Id, generation: Option<u64>) -> Result<(), HostError> {
        self.ask(|reply| Command::Remove {
            id,
            generation,
            reply,
        })
        .await?
    }

    /// Starts waking a sandbox without waiting, for example when a turn
    /// starts and a command will probably follow. With a `generation`,
    /// only while the sandbox is still at it.
    pub fn touch(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.commands
            .send(Command::Touch {
                id,
                generation,
                priority,
            })
            .map_err(|_| HostError::Stopped)
    }

    /// Wakes a sandbox and keeps it awake until the lease is dropped.
    /// Dropping the returned future early releases the sandbox too. With a
    /// `generation`, only while the sandbox is still at it, so a caller
    /// that relies on programs it started can tell they are gone.
    pub async fn acquire(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<Lease, HostError> {
        let hold = HoldId(self.holds.fetch_add(1, Ordering::Relaxed));
        let started = Instant::now();
        let mut guard = ReleaseOnDrop {
            id,
            hold,
            commands: self.commands.clone(),
            armed: true,
        };
        let vsock = self
            .ask(|reply| Command::Acquire {
                id,
                generation,
                hold,
                priority,
                reply,
            })
            .await??;
        guard.armed = false;
        Ok(Lease {
            id,
            hold,
            vsock,
            waited: started.elapsed(),
            commands: self.commands.clone(),
        })
    }

    /// Every sandbox and the host's counters.
    pub async fn status(&self) -> Result<HostStatus, HostError> {
        self.ask(|reply| Command::Status { reply }).await
    }

    /// Puts a sandbox at least as deep as `level` now, whatever its sleep
    /// settings say. Returns once the request is accepted, not once the
    /// sandbox is there; a later wake cancels it. With a `generation`, only
    /// while the sandbox is still at it.
    pub async fn sleep(
        &self,
        id: Id,
        generation: Option<u64>,
        level: Level,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Sleep {
            id,
            generation,
            level,
            reply,
        })
        .await?
    }

    /// Keeps a sandbox awake for a named reason, such as an agent turn in
    /// progress, waking it if it sleeps. Holding again under the same name
    /// refreshes the hold; with a `ttl` it lapses on its own unless
    /// refreshed, so a caller that dies cannot keep a sandbox awake forever.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn hold(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<(), HostError> {
        let hold = named_hold(name);
        self.ask(|reply| Command::Hold {
            id,
            generation,
            hold,
            ttl,
            priority,
            reply,
        })
        .await?
    }

    /// Ends a named hold. Ending one that does not exist does nothing. With
    /// a `generation`, only while the sandbox is still at it.
    pub async fn release(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
    ) -> Result<(), HostError> {
        let hold = named_hold(name);
        self.ask(|reply| Command::Unhold {
            id,
            generation,
            hold,
            reply,
        })
        .await?
    }
}

/// The hold id for a hold named through the API. Leases count up from one,
/// so named holds take the upper half of the id space.
fn named_hold(name: &str) -> HoldId {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    HoldId(hasher.finish() | 1 << 63)
}

impl Lease {
    /// How long waking took.
    #[must_use]
    pub fn waited(&self) -> Duration {
        self.waited
    }

    /// Host side of the sandbox's vsock device.
    #[must_use]
    pub fn vsock(&self) -> &Path {
        &self.vsock
    }

    /// Connects to `port` inside the sandbox. Right after a fresh boot the
    /// guest may not listen yet, so this retries until `timeout`.
    pub async fn connect(&self, port: u32, timeout: Duration) -> io::Result<UnixStream> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(2);
        loop {
            match vsock::connect(&self.vsock, port).await {
                Ok(stream) => return Ok(stream),
                Err(error) if Instant::now() + delay >= deadline => return Err(error),
                Err(_) => {
                    sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Release {
            id: self.id,
            hold: self.hold,
        });
    }
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
    /// Sandboxes on disk the host cannot manage, with why: their ids are
    /// refused and their files and VMs left alone.
    unreadable: BTreeMap<SandboxId, String>,
    destroying: HashMap<SandboxId, Vec<Reply<()>>>,
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
        let (records, strays) = Records::open(config.root.clone(), HANDOVER).await?;
        let net = match config.network.clone() {
            Some(network) => Some(Arc::new(
                tokio::task::spawn_blocking(move || Networks::prepare(&network))
                    .await
                    .map_err(|error| HostError::Io(error.to_string()))?
                    .map_err(|error| HostError::Io(error.to_string()))?,
            )),
            None => None,
        };
        let boot_args = match &config.network {
            Some(network) => format!("{} {}", config.boot_args, network.boot_args()),
            None => config.boot_args,
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
            images: Images {
                kernel: config.kernel,
                boot_args,
                first_uid: config.first_uid,
                network: config.network,
            },
            root: config.root,
            base_image: config.base_image,
            pressure: config.policy.memory.is_some(),
            core,
            origin: Instant::now(),
            slots: HashMap::new(),
            preparing: HashSet::new(),
            ordinals: BTreeSet::new(),
            unreadable: BTreeMap::new(),
            destroying: HashMap::new(),
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

    async fn recover(&mut self, strays: Vec<Stray>) {
        for stray in strays {
            let dir = Paths::new(&self.root, stray.id).dir;
            match stray.problem {
                // Creation never finished or removal nearly had: nothing was
                // promised, and no VM runs without a record.
                None => {
                    if let Err(error) = self.remove_network(stray.id).await {
                        tracing::warn!(id = %stray.id, %error, "could not remove an unrecorded sandbox's network");
                    }
                    if let Err(error) = tokio::fs::remove_dir_all(&dir).await {
                        tracing::warn!(id = %stray.id, %error, "could not tidy an unrecorded sandbox");
                        self.unreadable.insert(
                            stray.id.0,
                            format!("unrecorded directory left behind: {error}"),
                        );
                    }
                }
                Some(problem) => {
                    // Its VM may still run as the user its ordinal names,
                    // behind the host link its ordinal names: no other
                    // sandbox may get that ordinal.
                    let ordinal = self.unreadable_ordinal(stray.id).await;
                    if let Some(ordinal) = ordinal {
                        self.ordinals.insert(ordinal);
                    }
                    tracing::error!(id = %stray.id, %problem, ?ordinal, "unreadable record; blocking the id and leaving the sandbox alone");
                    self.unreadable.insert(stray.id.0, problem.to_string());
                }
            }
        }
        let mut recovering = Vec::new();
        for record in self.records.all() {
            let id = record.id;
            if !self.ordinals.insert(record.ordinal) {
                tracing::error!(%id, ordinal = record.ordinal, "ordinal taken twice; leaving the sandbox on disk");
                continue;
            }
            if record.removing {
                self.remove_recorded(&record, None, Vec::new());
                continue;
            }
            recovering.push(record);
        }
        // Finding VMs and checking networks touch only their own sandbox,
        // so they run for every sandbox at once; the results are taken in
        // one by one.
        let (mut found, ()) = tokio::join!(self.find_vms(&recovering), self.ensure_networks());
        let mut adopted = 0_usize;
        for record in recovering {
            let id = record.id;
            let vm = found
                .remove(&id.0)
                .unwrap_or_else(|| Err(HostError::Io("no result from looking for the VM".into())));
            match self.recover_one(record, vm).await {
                Ok(true) => adopted += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(%id, %error, "could not recover sandbox; leaving it on disk");
                }
            }
        }
        tracing::info!(sandboxes = self.slots.len(), adopted, "recovered");
    }

    /// Looks for every recorded sandbox's VM, taking back those still
    /// running and clearing what dead ones left. Sandboxes whose disk is
    /// remote have no VM to find.
    async fn find_vms(
        &self,
        records: &[Record],
    ) -> HashMap<SandboxId, Result<Option<(E::Vm, Found)>, HostError>> {
        /// Enough to hide each lookup's round trip to its VMM without
        /// opening thousands of descriptors at once.
        const CONCURRENT: usize = 64;
        futures::stream::iter(records)
            .map(|record| async move {
                let paths = Paths::new(&self.root, record.id);
                let spec = vm_spec(
                    record.id,
                    record.ordinal,
                    &record.config,
                    &paths,
                    &self.images,
                );
                let found = match record.disk {
                    Disk::Local => self.engine.adopt(&spec).await,
                    Disk::Remote => self.engine.clean_up(&spec).await.map(|()| None),
                };
                (
                    record.id.0,
                    found.map_err(|error| HostError::Io(error.to_string())),
                )
            })
            .buffer_unordered(CONCURRENT)
            .collect()
            .await
    }

    /// Makes sure every recorded sandbox's network exists with the current
    /// rules, all at once. A VM still running keeps its network untouched
    /// but for the rules; after a host reboot every network is rebuilt.
    async fn ensure_networks(&self) {
        let Some(net) = &self.net else {
            return;
        };
        let mut work = tokio::task::JoinSet::new();
        for record in self.records.all() {
            if record.removing {
                continue;
            }
            let Ok(Some(link)) = self.images.link(record.id, record.ordinal) else {
                tracing::error!(id = %record.id, "no room for the sandbox's network");
                continue;
            };
            let net = Arc::clone(net);
            work.spawn_blocking(move || (record.id, net.ensure(&link)));
        }
        while let Some(done) = work.join_next().await {
            match done {
                Ok((_, Ok(()))) => {}
                Ok((id, Err(error))) => {
                    tracing::error!(%id, %error, "could not set up the sandbox's network");
                }
                Err(error) => tracing::error!(%error, "network setup panicked"),
            }
        }
    }

    async fn remove_network(&self, id: Id) -> Result<(), HostError> {
        let Some(net) = self.net.clone() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || net.remove_for(id))
            .await
            .map_err(|error| HostError::Io(error.to_string()))?
            .map_err(|error| HostError::Io(error.to_string()))
    }

    /// Serves the memory of a VM found running whose pager went with the
    /// previous agent; see [`crate::step::take_over_paging`].
    async fn take_over_paging(
        &self,
        vm: &E::Vm,
        paths: &Paths,
    ) -> Result<LiveMemory, compute_engine::EngineError> {
        #[cfg(target_os = "linux")]
        {
            crate::step::take_over_paging(&*self.engine, vm, paths, self.fetcher.as_ref()).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (vm, paths);
            Err(compute_engine::EngineError::new(
                compute_engine::ErrorKind::Fatal,
                "take over paging",
                "paged memory needs Linux",
            ))
        }
    }

    /// Brings one recorded sandbox back under management. Returns whether
    /// a VM was still running it.
    async fn recover_one(
        &mut self,
        record: Record,
        found: Result<Option<(E::Vm, Found)>, HostError>,
    ) -> Result<bool, HostError> {
        let id = record.id;
        let policy = self
            .sleep_policy(&record.config)
            .map_err(HostError::Invalid)?;
        let paths = Paths::new(&self.root, id);
        let spec = vm_spec(id, record.ordinal, &record.config, &paths, &self.images);
        let mut memory = None;
        let found = match found? {
            Some((vm, how)) if crate::step::paged(&paths) => {
                // The previous agent's pager served this VM's memory and
                // went with it, so the guest waits on its next page fault
                // until a new pager takes over.
                match self.take_over_paging(&vm, &paths).await {
                    Ok(taken) => {
                        tracing::info!(%id, "took over the VM's memory pager");
                        memory = Some(taken);
                        Some((vm, how))
                    }
                    Err(error) => {
                        // Its record still says whether a saved image
                        // stands in for it.
                        tracing::warn!(%id, %error, "the VM's memory pager cannot be taken over; stopping the VM");
                        self.engine
                            .stop(vm)
                            .await
                            .map_err(|error| HostError::Io(error.to_string()))?;
                        None
                    }
                }
            }
            found => found,
        };
        let (state, vm) = if let Some((vm, found)) = found {
            (self.adopted_state(&record, found).await?, Some(vm))
        } else {
            // A kernel upgrade on the host reaches the sandbox on its next
            // boot.
            if record.disk == Disk::Local {
                link_kernel(&self.images.kernel, &paths)
                    .map_err(|error| HostError::Io(error.to_string()))?;
            }
            (self.sleeping_state(&record, &paths).await?, None)
        };
        let adopted = vm.is_some();
        self.insert(id, paths, spec);
        if let Some(vm) = vm {
            // What its memory was based on is unknown, so its next save
            // holds every page.
            let live = self.own(id, vm, memory.unwrap_or_else(LiveMemory::adopted));
            if let Some(slot) = self.slots.get_mut(&id.0) {
                slot.incarnation = Some(live.incarnation);
                slot.vm = Some(live);
            }
        }
        self.input(Input::Add {
            sandbox: id.0,
            state,
            policy,
        });
        Ok(adopted)
    }

    /// Where a sandbox whose VM was found still running stands. A paused
    /// VM keeps the saved copy its record vouches for: every step that lets
    /// a guest run withdraws the record's word first. A running VM has
    /// moved past any copy, and a paused one without a memory image has no
    /// copy of its current state.
    async fn adopted_state(&self, record: &Record, found: Found) -> Result<State, HostError> {
        // The image itself is checked when a step relies on it, and set
        // aside if it proves bad.
        let keeps_copy = found == Found::Paused && record.image;
        if !keeps_copy && (record.image || record.archived) {
            let stale = Change::new().image(false).archived(false);
            self.records
                .commit(record.id, record.fence(), stale)
                .await?;
        }
        Ok(match found {
            Found::Running => State::RUNNING,
            Found::Paused if keeps_copy => {
                let durability = if record.archived {
                    Durability::Remote
                } else {
                    Durability::Local
                };
                State::new(Level::Paused, durability, true)
            }
            Found::Paused => State::new(Level::Paused, Durability::Volatile, false),
        })
    }

    /// The ordinal a sandbox with an unreadable record was given, from
    /// what is left: the record's `ordinal` field if the file still parses
    /// as JSON, else the owner of its disk, which every launch hands to
    /// the VM's user. `None` if it never launched, when no VM or user can
    /// clash with a newcomer's.
    async fn unreadable_ordinal(&self, id: Id) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        let paths = Paths::new(&self.root, id);
        let from_record = tokio::fs::read(&paths.record)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|record| record.get("ordinal")?.as_u64())
            .and_then(|ordinal| u32::try_from(ordinal).ok());
        if from_record.is_some() {
            return from_record;
        }
        let owner = tokio::fs::metadata(&paths.disk).await.ok()?.uid();
        owner.checked_sub(self.images.first_uid)
    }

    /// Where a sandbox without a VM stands, from its record, checked
    /// against the files the record relies on.
    async fn sleeping_state(&self, record: &Record, paths: &Paths) -> Result<State, HostError> {
        match record.disk {
            Disk::Remote => Ok(State::new(Level::Remote, Durability::Remote, record.image)),
            Disk::Local => {
                if !paths.disk.exists() {
                    return Err(HostError::Io("the recorded local disk is missing".into()));
                }
                let mut image = record.image;
                if image && !crate::step::recover_images(paths) {
                    tracing::warn!(id = %record.id, "recorded memory image is missing; its programs are lost");
                    let lost = Change::new().image(false);
                    self.records.commit(record.id, record.fence(), lost).await?;
                    image = false;
                }
                Ok(if record.archived {
                    State::new(Level::Archived, Durability::Remote, image)
                } else {
                    State::new(Level::Saved, Durability::Local, image)
                })
            }
        }
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
                dead: None,
                _ports: ports,
                op: None,
                destroy: false,
                removers: Vec::new(),
                waiters: Vec::new(),
                cpu: None,
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

    fn on_command(&mut self, command: Command) {
        match command {
            Command::Create { id, config, reply } => self.create(id, config, reply),
            Command::Remove {
                id,
                generation,
                reply,
            } => self.remove(id, generation, reply),
            Command::Touch {
                id,
                generation,
                priority,
            } => {
                if self.slots.contains_key(&id.0) && self.check(id, generation).is_ok() {
                    self.input(Input::Touch {
                        sandbox: id.0,
                        priority,
                    });
                }
            }
            Command::Sleep {
                id,
                generation,
                level,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.request_sleep(id, level));
                let _ = reply.send(result);
            }
            Command::Hold {
                id,
                generation,
                hold,
                ttl,
                priority,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.hold(id, hold, ttl, priority));
                let _ = reply.send(result);
            }
            Command::Unhold {
                id,
                generation,
                hold,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.unhold(id, hold));
                let _ = reply.send(result);
            }
            Command::Acquire {
                id,
                generation,
                hold,
                priority,
                reply,
            } => self.acquire(id, generation, hold, priority, reply),
            Command::Release { id, hold } => {
                if self.slots.contains_key(&id.0) {
                    self.input(Input::Release {
                        sandbox: id.0,
                        hold,
                    });
                }
            }
            Command::Status { reply } => {
                let _ = reply.send(self.status());
            }
        }
    }

    fn remove(&mut self, id: Id, generation: Option<u64>, reply: Reply<()>) {
        if let Err(error) = self.check(id, generation) {
            let _ = reply.send(Err(error));
            return;
        }
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.removers.push(reply);
            self.input(Input::Remove { sandbox: id.0 });
        } else if let Some(removers) = self.destroying.get_mut(&id.0) {
            removers.push(reply);
        } else if self.preparing.contains(&id.0) {
            let _ = reply.send(Err(HostError::Busy(id)));
        } else {
            let _ = reply.send(Err(HostError::NotFound(id)));
        }
    }

    fn unhold(&mut self, id: Id, hold: HoldId) -> Result<(), HostError> {
        if !self.slots.contains_key(&id.0) {
            return Err(HostError::NotFound(id));
        }
        self.input(Input::Release {
            sandbox: id.0,
            hold,
        });
        Ok(())
    }

    fn acquire(
        &mut self,
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        priority: Priority,
        reply: Reply<PathBuf>,
    ) {
        if let Err(error) = self.check(id, generation) {
            let _ = reply.send(Err(error));
            return;
        }
        let Some(slot) = self.slots.get_mut(&id.0).filter(|slot| !slot.destroy) else {
            let _ = reply.send(Err(HostError::NotFound(id)));
            return;
        };
        slot.waiters.push(reply);
        self.input(Input::Hold {
            sandbox: id.0,
            hold,
            until: None,
            priority,
        });
        self.settle(id);
    }

    /// Refuses a request that names an execution the sandbox no longer
    /// runs.
    fn check(&self, id: Id, generation: Option<u64>) -> Result<(), HostError> {
        if self.unreadable.contains_key(&id.0) {
            return Err(HostError::Broken(id));
        }
        match self.records.get(id) {
            Some(record) => Ok(check_generation(&record, generation)?),
            None => Ok(()),
        }
    }

    fn request_sleep(&mut self, id: Id, level: Level) -> Result<(), HostError> {
        if !self.slots.contains_key(&id.0) {
            return Err(HostError::NotFound(id));
        }
        if level >= Level::Archived && !self.store.is_configured() {
            return Err(HostError::Invalid(
                "this host has no store, so sandboxes cannot be archived".into(),
            ));
        }
        if level == Level::Compressed && !self.can_compress {
            return Err(HostError::Invalid(
                "this host cannot compress memory; ask for saved instead".into(),
            ));
        }
        self.input(Input::Sleep {
            sandbox: id.0,
            level,
        });
        Ok(())
    }

    fn hold(
        &mut self,
        id: Id,
        hold: HoldId,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<(), HostError> {
        if self.slots.get(&id.0).is_none_or(|slot| slot.destroy) {
            return Err(HostError::NotFound(id));
        }
        let until = ttl.map(|ttl| self.now() + ttl);
        self.input(Input::Hold {
            sandbox: id.0,
            hold,
            until,
            priority,
        });
        Ok(())
    }

    fn create(&mut self, id: Id, config: SandboxConfig, reply: Reply<()>) {
        if self.unreadable.contains_key(&id.0) {
            let _ = reply.send(Err(HostError::Broken(id)));
            return;
        }
        if self.slots.contains_key(&id.0)
            || self.preparing.contains(&id.0)
            || self.destroying.contains_key(&id.0)
        {
            let _ = reply.send(Err(HostError::Exists(id)));
            return;
        }
        let policy = match self.sleep_policy(&config) {
            Ok(policy) => policy,
            Err(error) => {
                let _ = reply.send(Err(HostError::Invalid(error)));
                return;
            }
        };
        if policy.rules().archive_after.is_some() && !self.store.is_configured() {
            let _ = reply.send(Err(HostError::Invalid(
                "this host has no store, so sandboxes cannot be archived".into(),
            )));
            return;
        }
        self.preparing.insert(id.0);
        let ordinal = self.take_ordinal();
        let link = match self.images.link(id, ordinal) {
            Ok(link) => link,
            Err(full) => {
                self.preparing.remove(&id.0);
                self.ordinals.remove(&ordinal);
                let _ = reply.send(Err(HostError::Invalid(full.to_string())));
                return;
            }
        };
        let record = Record::new(id, ordinal, config);
        let paths = Paths::new(&self.root, id);
        let dir = paths.dir.clone();
        let base = self.base_image.clone();
        let kernel = self.images.kernel.clone();
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let networks = net.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                // The directory must be new: one already there belongs to a
                // sandbox this agent does not know, and is left alone.
                std::fs::create_dir(&paths.dir)?;
                std::fs::create_dir_all(&paths.jail)?;
                link_kernel(&kernel, &paths)?;
                copy_sparse(&base, &paths.disk)?;
                if let (Some(net), Some(link)) = (&networks, &link) {
                    net.ensure(link)?;
                }
                Ok(())
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
            // The record goes last: a directory without one is an
            // unfinished creation and is cleaned up on recovery.
            let result = match prepared {
                Ok(()) => records.insert(record).await.map_err(HostError::from),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    tracing::error!(%id, "a directory for a new sandbox already exists; refusing it");
                    let _ = events.send(Event::Prepared {
                        id,
                        ordinal,
                        result: Err(HostError::Exists(id)),
                        reply,
                    });
                    return;
                }
                Err(error) => Err(HostError::Io(error.to_string())),
            };
            if result.is_err() {
                // The id stays reserved until this is done, so it cannot
                // remove a newer sandbox's files or network.
                if let Some(net) = net {
                    let _ = tokio::task::spawn_blocking(move || net.remove_for(id)).await;
                }
                let _ = tokio::fs::remove_dir_all(&dir).await;
            }
            let _ = events.send(Event::Prepared {
                id,
                ordinal,
                result,
                reply,
            });
        });
    }

    fn on_event(&mut self, event: Event<E::Vm>) {
        match event {
            Event::Prepared {
                id,
                ordinal,
                result,
                reply,
            } => {
                self.preparing.remove(&id.0);
                let record = match result {
                    Ok(record) => record,
                    Err(error) => {
                        self.ordinals.remove(&ordinal);
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let Ok(policy) = self.sleep_policy(&record.config) else {
                    return;
                };
                let paths = Paths::new(&self.root, id);
                let spec = vm_spec(id, record.ordinal, &record.config, &paths, &self.images);
                self.insert(id, paths, spec);
                // A new sandbox is a disk without a memory image: its first
                // wake boots it, under the same admission limits as any wake.
                self.input(Input::Add {
                    sandbox: id.0,
                    state: State::new(Level::Saved, Durability::Local, false),
                    policy,
                });
                let _ = reply.send(Ok(()));
            }
            Event::StepDone {
                id,
                op,
                outcome,
                after,
            } => self.step_done(id, op, outcome, after),
            Event::Exited { id, incarnation } => self.exited(id, incarnation),
            Event::Destroyed {
                id,
                ordinal,
                result,
            } => {
                // A removal that stopped part way keeps its ordinal and
                // record until the next start of the agent finishes it.
                if result.is_ok() {
                    self.ordinals.remove(&ordinal);
                }
                for remover in self.destroying.remove(&id.0).unwrap_or_default() {
                    let _ = remover.send(result.clone());
                }
            }
        }
    }

    fn execute(&mut self, action: Action) {
        match action {
            Action::Start { sandbox, op, step } => self.start_step(Id(sandbox), op, step),
            Action::Cancel { sandbox, op } => {
                if let Some(running) = self
                    .slots
                    .get(&sandbox)
                    .and_then(|slot| slot.op.as_ref())
                    .filter(|running| running.op == op)
                {
                    running.cancel.cancel();
                }
            }
            Action::Destroy { sandbox } => {
                if let Some(slot) = self.slots.get_mut(&sandbox) {
                    slot.destroy = true;
                    if slot.op.is_none() {
                        self.destroy_now(Id(sandbox));
                    }
                }
            }
            Action::Notify { sandbox, notice } => self.notify(Id(sandbox), notice),
        }
    }

    fn start_step(&mut self, id: Id, op: OpId, step: Step) {
        let (Some(slot), Some(record)) = (self.slots.get_mut(&id.0), self.records.get(id)) else {
            tracing::error!(%id, ?step, "step for a sandbox the host does not have");
            let _ = self.events_tx.send(Event::StepDone {
                id,
                op,
                outcome: Outcome::Failed(Failure::Fatal),
                after: After::NoVm,
            });
            return;
        };
        // A step that may run while a VM process exists owns it until the
        // step finishes; archiving a paused VM's saved copy hands it back.
        let needs_vm = matches!(
            step,
            Step::Pause | Step::Resume | Step::Compress | Step::Save | Step::Drop | Step::Archive
        );
        let cancel = CancellationToken::new();
        slot.op = Some(Running {
            op,
            step,
            cancel: cancel.clone(),
            started: Instant::now(),
        });
        self.stats[step.index()].started += 1;
        let job = Job {
            engine: Arc::clone(&self.engine),
            store: Arc::clone(&self.store),
            records: Arc::clone(&self.records),
            record,
            id,
            spec: VmSpec::clone(&slot.spec),
            paths: Paths::clone(&slot.paths),
            cancel,
            live: if needs_vm { slot.vm.take() } else { None },
            restore_notice_port: self.restore_notice_port,
            base_image: self.base_image.clone(),
            #[cfg(target_os = "linux")]
            fetcher: self.fetcher.clone(),
        };
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let (outcome, after) = job.run(step).await;
            let _ = events.send(Event::StepDone {
                id,
                op,
                outcome,
                after,
            });
        });
    }

    fn step_done(&mut self, id: Id, op: OpId, outcome: Outcome, after: After<E::Vm>) {
        let fresh = match after {
            After::New(vm, memory) => Some(self.own(id, vm, memory)),
            After::Kept(live) => Some(live),
            After::NoVm => None,
        };
        let mut reap = None;
        let mut destroy = false;
        if let Some(slot) = self.slots.get_mut(&id.0) {
            if let Some(running) = slot.op.take().filter(|running| running.op == op) {
                let stats = &mut self.stats[running.step.index()];
                let micros =
                    u64::try_from(running.started.elapsed().as_micros()).unwrap_or(u64::MAX);
                stats.total_us = stats.total_us.saturating_add(micros);
                stats.max_us = stats.max_us.max(micros);
                tracing::debug!(%id, step = ?running.step, micros, ?outcome, "step finished");
                match outcome {
                    Outcome::Done => stats.done += 1,
                    Outcome::Cancelled => stats.cancelled += 1,
                    Outcome::Failed(_) => stats.failed += 1,
                }
            }
            match fresh {
                // A process that already ended on its own only needs its
                // resources released. One that lost its memory was ended by
                // the step before it reported.
                Some(live) if slot.dead == Some(live.incarnation) => {
                    slot.incarnation = None;
                    slot.dead = None;
                    reap = Some(live);
                }
                Some(live) => {
                    debug_assert_ne!(outcome, Outcome::Failed(Failure::MemoryLost));
                    slot.incarnation = Some(live.incarnation);
                    slot.vm = Some(live);
                }
                None => {
                    slot.incarnation = None;
                    slot.dead = None;
                }
            }
            destroy = slot.destroy;
        } else {
            reap = fresh;
        }
        if let Some(live) = reap {
            self.reap(live);
        }
        self.input(Input::Finished {
            sandbox: id.0,
            op,
            outcome,
        });
        if destroy {
            self.destroy_now(id);
        } else {
            self.settle(id);
        }
    }

    /// Takes charge of a VM process, started by a step or found still
    /// running, and watches for it dying on its own.
    fn own(&mut self, id: Id, vm: E::Vm, memory: LiveMemory) -> Live<E::Vm> {
        let incarnation = self.next_incarnation;
        self.next_incarnation += 1;
        let stopping = Arc::new(AtomicBool::new(false));
        let exited = self.engine.exited(&vm);
        let events = self.events_tx.clone();
        let deliberate = Arc::clone(&stopping);
        let memory_lost = memory.failed();
        tokio::spawn(async move {
            let lost = memory_lost;
            tokio::select! {
                () = exited => {}
                // Its memory can no longer be served: the next page fault
                // would wait forever, so it counts as dead.
                () = lost => {}
            }
            if !deliberate.load(Ordering::Acquire) {
                let _ = events.send(Event::Exited { id, incarnation });
            }
        });
        Live {
            vm,
            incarnation,
            stopping,
            memory,
        }
    }

    fn reap(&self, live: Live<E::Vm>) {
        live.stopping.store(true, Ordering::Release);
        let engine = Arc::clone(&self.engine);
        tokio::spawn(async move {
            if let Err(error) = engine.stop(live.vm).await {
                tracing::error!(%error, "could not stop a dead VM");
            }
        });
    }

    fn exited(&mut self, id: Id, incarnation: u64) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.incarnation != Some(incarnation) {
            return;
        }
        tracing::warn!(%id, "VM process ended on its own; running programs are lost");
        if let Some(live) = slot.vm.take() {
            slot.incarnation = None;
            self.reap(live);
        } else {
            // A step holds it and will hand it back.
            slot.dead = Some(incarnation);
        }
        self.input(Input::Lost { sandbox: id.0 });
    }

    fn destroy_now(&mut self, id: Id) {
        let Some(mut slot) = self.slots.remove(&id.0) else {
            return;
        };
        for waiter in slot.waiters.drain(..) {
            let _ = waiter.send(Err(HostError::Removed(id)));
        }
        let live = slot.vm.take();
        if let Some(live) = &live {
            live.stopping.store(true, Ordering::Release);
        }
        let removers = std::mem::take(&mut slot.removers);
        if let Some(record) = self.records.get(id) {
            self.remove_recorded(&record, live.map(|live| (live.vm, live.memory)), removers);
        } else {
            tracing::error!(%id, "removing a sandbox without a record");
            for remover in removers {
                let _ = remover.send(Err(HostError::NotFound(id)));
            }
        }
    }

    /// Deletes a recorded sandbox in the background. Its ordinal and id
    /// stay taken until nothing of it is left.
    fn remove_recorded(
        &mut self,
        record: &Record,
        vm: Option<(E::Vm, LiveMemory)>,
        removers: Vec<Reply<()>>,
    ) {
        let id = record.id;
        self.destroying.insert(id.0, removers);
        let paths = Paths::new(&self.root, id);
        let spec = vm_spec(id, record.ordinal, &record.config, &paths, &self.images);
        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        let (ordinal, fence) = (record.ordinal, record.fence());
        tokio::spawn(async move {
            let removal = Removal {
                engine: &*engine,
                store: &*store,
                records: &records,
                net,
                id,
            };
            let result = removal.run(fence, vm, &spec, &paths.dir).await;
            if let Err(error) = &result {
                tracing::error!(%id, %error, "removal stopped; the next start of the agent finishes it");
            }
            let _ = events.send(Event::Destroyed {
                id,
                ordinal,
                result,
            });
        });
    }

    fn notify(&mut self, id: Id, notice: Notice) {
        match notice {
            Notice::State(state) => tracing::debug!(
                %id,
                level = ?state.level,
                durability = ?state.durability,
                memory_saved = state.memory_saved,
                "state"
            ),
            Notice::MemoryLost => tracing::warn!(%id, "running programs lost; files kept"),
            Notice::Retrying { step, failures } => {
                tracing::warn!(%id, ?step, failures, "step failed; retrying");
            }
            Notice::Broken => {
                tracing::error!(%id, "sandbox broken on this host");
                self.settle(id);
            }
        }
    }

    /// Answers everyone waiting for `id` once it runs or cannot.
    fn settle(&mut self, id: Id) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.waiters.is_empty() {
            return;
        }
        let Some(view) = self.core.sandbox(id.0) else {
            return;
        };
        let result = if view.broken {
            Err(HostError::Broken(id))
        } else if view.state.level == Level::Running && view.step.is_none() && slot.vm.is_some() {
            Ok(slot.spec.vsock_path())
        } else {
            return;
        };
        for waiter in slot.waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }

    fn sample(&mut self) {
        self.available_memory = read_available_memory();
        let mut batch: Vec<Input> = match self.busy {
            Some(rule) => self
                .sample_busy(rule)
                .into_iter()
                .map(|sandbox| Input::Busy { sandbox })
                .collect(),
            None => Vec::new(),
        };
        // Resident sizes always, so the status can report reclaimable
        // memory; they go in before the host total so relief is planned
        // from fresh numbers. The whole sweep is one batch, so no sleep
        // timer fires between two readings taken at the same moment.
        batch.extend(self.slots.iter().filter_map(|(id, slot)| {
            let live = slot.vm.as_ref()?;
            let bytes = self.engine.resident_bytes(&live.vm).ok()?;
            Some(Input::Resident {
                sandbox: *id,
                bytes,
            })
        }));
        if self.pressure
            && let Some(available) = self.available_memory
        {
            batch.push(Input::Memory { available });
        }
        self.inputs(batch);
    }

    /// Finds running sandboxes whose VMs used enough processor time over the
    /// last window. A window starts afresh whenever the sandbox is not simply
    /// running, so time spent waking or pausing never counts.
    fn sample_busy(&mut self, rule: BusyRule) -> Vec<SandboxId> {
        let now = Instant::now();
        let mut busy = Vec::new();
        for (id, slot) in &mut self.slots {
            let running = self
                .core
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            let Some(live) = slot.vm.as_ref().filter(|_| running) else {
                slot.cpu = None;
                continue;
            };
            let Ok(cpu) = self.engine.cpu_time(&live.vm) else {
                slot.cpu = None;
                continue;
            };
            let fresh = CpuWindow {
                incarnation: live.incarnation,
                started: now,
                cpu,
            };
            match slot.cpu {
                Some(window) if window.incarnation == live.incarnation => {
                    let elapsed = now.duration_since(window.started);
                    if elapsed >= rule.window {
                        if rule.is_busy(cpu.saturating_sub(window.cpu), elapsed) {
                            busy.push(*id);
                        }
                        slot.cpu = Some(fresh);
                    }
                }
                _ => slot.cpu = Some(fresh),
            }
        }
        busy
    }

    fn status(&self) -> HostStatus {
        let mut sandboxes: Vec<SandboxStatus> = self
            .slots
            .iter()
            .filter_map(|(id, slot)| {
                let view = self.core.sandbox(*id)?;
                let record = self.records.get(Id(*id));
                Some(SandboxStatus {
                    id: Id(*id),
                    generation: record.as_ref().map_or(0, |record| record.generation),
                    revision: record.as_ref().map_or(0, |record| record.revision),
                    level: view.state.level.into(),
                    durability: view.state.durability.into(),
                    memory_saved: view.state.keeps_programs(),
                    step: view.step.map(|step| step_name(step).to_owned()),
                    holds: view.holds,
                    resident_bytes: slot
                        .vm
                        .as_ref()
                        .and_then(|live| self.engine.resident_bytes(&live.vm).ok()),
                    broken: view.broken,
                })
            })
            .collect();
        sandboxes.sort_by_key(|sandbox| sandbox.id);
        let steps = Step::ALL
            .iter()
            .map(|step| {
                let mut stats = self.stats[step.index()];
                stats.in_flight = self.core.in_flight(*step);
                (step_name(*step).to_owned(), stats)
            })
            .collect();
        HostStatus {
            sandboxes,
            steps,
            available_memory: self.available_memory,
            reclaimable_memory: self.core.reclaimable_memory(),
            unreadable: self
                .unreadable
                .iter()
                .map(|(id, problem)| UnreadableSandbox {
                    id: Id(*id),
                    problem: problem.clone(),
                })
                .collect(),
        }
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Deleting one sandbox, in an order that a crash at any point leaves
/// either finishable on the next start or finished.
struct Removal<'a, E, S> {
    engine: &'a E,
    store: &'a S,
    records: &'a Records,
    net: Option<Arc<Networks>>,
    id: Id,
}

impl<E: Engine, S: Store> Removal<'_, E, S> {
    /// Records that removal began, ends the VM, deletes the store's copy,
    /// then the record, then the files. Until the record is gone a restart
    /// resumes the removal; after, the directory is an unrecorded stray
    /// that recovery deletes.
    async fn run(
        &self,
        fence: Fence,
        vm: Option<(E::Vm, LiveMemory)>,
        spec: &VmSpec,
        dir: &Path,
    ) -> Result<(), HostError> {
        let id = self.id;
        let record = self
            .records
            .commit(id, fence, Change::new().removing())
            .await?;
        let stopped = match vm {
            Some((vm, memory)) => {
                let stopped = self.engine.stop(vm).await;
                // Whatever serves or fetches its memory writes into the
                // directory about to go, so it ends first.
                memory.close().await;
                stopped
            }
            None => self.engine.clean_up(spec).await,
        };
        stopped.map_err(|error| HostError::Io(error.to_string()))?;
        if let Some(net) = self.net.clone() {
            tokio::task::spawn_blocking(move || net.remove_for(id))
                .await
                .map_err(|error| HostError::Io(error.to_string()))?
                .map_err(|error| HostError::Io(error.to_string()))?;
        }
        self.store
            .delete(id)
            .await
            .map_err(|error| HostError::Io(error.to_string()))?;
        self.records.remove(id, record.fence()).await?;
        // A pager thread of a VM that ended on its own may still be writing
        // its last file here; a moment later the directory is quiet.
        let mut tries = 0;
        loop {
            match tokio::fs::remove_dir_all(dir).await {
                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty && tries < 10 => {
                    tries += 1;
                    sleep(Duration::from_millis(50)).await;
                }
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    return Err(HostError::Io(error.to_string()));
                }
                _ => return Ok(()),
            }
        }
    }
}

fn read_available_memory() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}
