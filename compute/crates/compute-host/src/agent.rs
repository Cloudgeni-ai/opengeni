//! The host agent: one task owns the decision core and every VM, and
//! carries out the core's decisions.
//!
//! Requests arrive through a [`Handle`]. Steps run as their own tasks and
//! report back as events, so the owning task never waits on a VM and a slow
//! save never delays a wake. Everything that changes a sandbox's state goes
//! through this one task, in order, which is what makes it safe without
//! locks.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use compute_core::{
    Action, At, Failure, HoldId, Host, HostPolicy, Input, Level, Notice, OpId, Outcome, Priority,
    SandboxId, Step,
};
use compute_engine::{CancellationToken, Engine, VmSpec, vsock};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until};

use crate::guest_ports::{self, Activity, GuestPort, Listeners};
use crate::layout::{
    Images, Paths, check_root, copy_sparse, link_kernel, sandboxes_dir, vm_spec, write_atomic,
};
use crate::protocol::{HostStatus, Id, SandboxConfig, SandboxStatus, StepStats, step_name};
use crate::step::{After, Job, Live};
use crate::store::Store;

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
    /// Host storage failed.
    #[error("host I/O failed: {0}")]
    Io(String),
    /// The host agent has shut down.
    #[error("the host agent stopped")]
    Stopped,
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
        reply: Reply<()>,
    },
    Touch {
        id: Id,
        priority: Priority,
    },
    Acquire {
        id: Id,
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
        config: SandboxConfig,
        result: io::Result<()>,
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

#[derive(Debug)]
struct Slot<V> {
    /// The sandbox's number on this host, unique among its sandboxes.
    ordinal: u32,
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
    pub async fn remove(&self, id: Id) -> Result<(), HostError> {
        self.ask(|reply| Command::Remove { id, reply }).await?
    }

    /// Starts waking a sandbox without waiting, for example when a turn
    /// starts and a command will probably follow.
    pub fn touch(&self, id: Id, priority: Priority) -> Result<(), HostError> {
        self.commands
            .send(Command::Touch { id, priority })
            .map_err(|_| HostError::Stopped)
    }

    /// Wakes a sandbox and keeps it awake until the lease is dropped.
    /// Dropping the returned future early releases the sandbox too.
    pub async fn acquire(&self, id: Id, priority: Priority) -> Result<Lease, HostError> {
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
    root: PathBuf,
    base_image: PathBuf,
    images: Images,
    core: Host,
    origin: Instant,
    slots: HashMap<SandboxId, Slot<E::Vm>>,
    preparing: HashSet<SandboxId>,
    ordinals: BTreeSet<u32>,
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
    /// Lets guest connections report activity without keeping the agent
    /// alive once every [`Handle`] is gone.
    commands_tx: mpsc::WeakUnboundedSender<Command>,
}

/// Reports a sandbox's guest traffic to the agent as a touch.
#[derive(Clone, Debug)]
struct Toucher {
    id: Id,
    commands: mpsc::WeakUnboundedSender<Command>,
}

impl Activity for Toucher {
    fn report(&self, priority: Priority) {
        if let Some(commands) = self.commands.upgrade() {
            let _ = commands.send(Command::Touch {
                id: self.id,
                priority,
            });
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Recovers every sandbox found under the root, then runs the agent
    /// until every [`Handle`] is dropped.
    ///
    /// VM processes left by an earlier run are ended; sandboxes come back
    /// at the level their files show, so a saved sandbox restores with its
    /// programs intact and one that only lived in memory boots from disk.
    pub async fn start(
        config: HostConfig,
        engine: E,
        store: S,
    ) -> Result<(Handle, JoinHandle<()>), HostError> {
        let core =
            Host::new(config.policy).map_err(|error| HostError::Invalid(format!("{error:?}")))?;
        check_root(&config.root).map_err(HostError::Invalid)?;
        tokio::fs::create_dir_all(sandboxes_dir(&config.root))
            .await
            .map_err(|error| HostError::Io(error.to_string()))?;
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        let mut agent = Self {
            engine: Arc::new(engine),
            store: Arc::new(store),
            images: Images {
                kernel: config.kernel,
                boot_args: config.boot_args,
                first_uid: config.first_uid,
            },
            root: config.root,
            base_image: config.base_image,
            pressure: config.policy.memory.is_some(),
            core,
            origin: Instant::now(),
            slots: HashMap::new(),
            preparing: HashSet::new(),
            ordinals: BTreeSet::new(),
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
            commands_tx: commands_tx.downgrade(),
        };
        agent.recover().await?;
        let handle = Handle {
            commands: commands_tx,
            holds: Arc::new(AtomicU64::new(1)),
        };
        Ok((handle, tokio::spawn(agent.run())))
    }

    async fn recover(&mut self) -> Result<(), HostError> {
        let dir = sandboxes_dir(&self.root);
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| HostError::Io(error.to_string()))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| HostError::Io(error.to_string()))?
        {
            let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<Id>().ok())
            else {
                continue;
            };
            if let Err(error) = self.recover_one(id).await {
                tracing::error!(%id, %error, "could not recover sandbox; leaving it on disk");
            }
        }
        tracing::info!(sandboxes = self.slots.len(), "recovered");
        Ok(())
    }

    async fn recover_one(&mut self, id: Id) -> Result<(), HostError> {
        let paths = Paths::new(&self.root, id);
        let record = match tokio::fs::read(&paths.record).await {
            Ok(record) => record,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Creation never finished; nothing was promised yet.
                let _ = tokio::fs::remove_dir_all(&paths.dir).await;
                return Ok(());
            }
            Err(error) => return Err(HostError::Io(error.to_string())),
        };
        let config: SandboxConfig =
            serde_json::from_slice(&record).map_err(|error| HostError::Io(error.to_string()))?;
        let policy = config.validate().map_err(HostError::Invalid)?;
        // A kernel upgrade on the host reaches the sandbox on its next boot.
        link_kernel(&self.images.kernel, &paths)
            .map_err(|error| HostError::Io(error.to_string()))?;
        let ordinal = self.take_ordinal();
        let spec = vm_spec(id, ordinal, &config, &paths, &self.images);
        self.engine.clean_up(&spec).await.map_err(|error| {
            self.ordinals.remove(&ordinal);
            HostError::Io(error.to_string())
        })?;
        let image =
            paths.saved.exists() && paths.snapshot.state.exists() && paths.snapshot.memory.exists();
        let (level, memory_saved) = if paths.disk.exists() {
            let level = if paths.archived.exists() {
                Level::Archived
            } else {
                Level::Saved
            };
            (level, image)
        } else if paths.archived.exists() {
            (Level::Remote, paths.saved.exists())
        } else {
            self.ordinals.remove(&ordinal);
            return Err(HostError::Io("disk missing and no archived copy".into()));
        };
        self.insert(id, ordinal, paths, spec);
        self.input(Input::Add {
            sandbox: id.0,
            level,
            memory_saved,
            policy,
        });
        Ok(())
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

    fn insert(&mut self, id: Id, ordinal: u32, paths: Paths, spec: VmSpec) {
        let toucher = Toucher {
            id,
            commands: self.commands_tx.clone(),
        };
        let ports = match guest_ports::listen(&spec.vsock_path(), &self.guest_ports, &toucher) {
            Ok(listeners) => Some(listeners),
            Err(error) => {
                tracing::error!(%id, %error, "could not listen for guest connections");
                None
            }
        };
        self.slots.insert(
            id.0,
            Slot {
                ordinal,
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
            },
        );
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
        let now = self.now();
        let mut actions = std::mem::take(&mut self.actions);
        self.core.handle(now, input, &mut actions);
        for action in actions.drain(..) {
            self.execute(action);
        }
        self.actions = actions;
    }

    fn on_command(&mut self, command: Command) {
        match command {
            Command::Create { id, config, reply } => self.create(id, config, reply),
            Command::Remove { id, reply } => {
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
            Command::Touch { id, priority } => {
                if self.slots.contains_key(&id.0) {
                    self.input(Input::Touch {
                        sandbox: id.0,
                        priority,
                    });
                }
            }
            Command::Acquire {
                id,
                hold,
                priority,
                reply,
            } => {
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

    fn create(&mut self, id: Id, config: SandboxConfig, reply: Reply<()>) {
        if self.slots.contains_key(&id.0)
            || self.preparing.contains(&id.0)
            || self.destroying.contains_key(&id.0)
        {
            let _ = reply.send(Err(HostError::Exists(id)));
            return;
        }
        let policy = match config.validate() {
            Ok(policy) => policy,
            Err(error) => {
                let _ = reply.send(Err(HostError::Invalid(error)));
                return;
            }
        };
        if policy.enables(Level::Archived) && !self.store.is_configured() {
            let _ = reply.send(Err(HostError::Invalid(
                "this host has no store, so sandboxes cannot be archived".into(),
            )));
            return;
        }
        self.preparing.insert(id.0);
        let paths = Paths::new(&self.root, id);
        let base = self.base_image.clone();
        let kernel = self.images.kernel.clone();
        let record = serde_json::to_vec(&config).unwrap_or_default();
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&paths.jail)?;
                link_kernel(&kernel, &paths)?;
                copy_sparse(&base, &paths.disk)?;
                // The record goes last: a directory without one is an
                // unfinished creation and is cleaned up on recovery.
                write_atomic(&paths.record, &record)
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
            let _ = events.send(Event::Prepared {
                id,
                config,
                result,
                reply,
            });
        });
    }

    fn on_event(&mut self, event: Event<E::Vm>) {
        match event {
            Event::Prepared {
                id,
                config,
                result,
                reply,
            } => {
                self.preparing.remove(&id.0);
                let paths = Paths::new(&self.root, id);
                if let Err(error) = result {
                    let _ = std::fs::remove_dir_all(&paths.dir);
                    let _ = reply.send(Err(HostError::Io(error.to_string())));
                    return;
                }
                let Ok(policy) = config.validate() else {
                    return;
                };
                let ordinal = self.take_ordinal();
                let spec = vm_spec(id, ordinal, &config, &paths, &self.images);
                self.insert(id, ordinal, paths, spec);
                // A new sandbox is a disk without a memory image: its first
                // wake boots it, under the same admission limits as any wake.
                self.input(Input::Add {
                    sandbox: id.0,
                    level: Level::Saved,
                    memory_saved: false,
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
            Event::Destroyed { id, result } => {
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
        let Some(slot) = self.slots.get_mut(&id.0) else {
            tracing::error!(%id, ?step, "step for a sandbox the host does not have");
            let _ = self.events_tx.send(Event::StepDone {
                id,
                op,
                outcome: Outcome::Failed(Failure::Fatal),
                after: After::NoVm,
            });
            return;
        };
        let needs_vm = matches!(
            step,
            Step::Pause | Step::Resume | Step::Compress | Step::Save
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
            id,
            spec: VmSpec::clone(&slot.spec),
            paths: Paths::clone(&slot.paths),
            cancel,
            live: if needs_vm { slot.vm.take() } else { None },
            restore_notice_port: self.restore_notice_port,
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
            After::New(vm) => Some(self.adopt(id, vm)),
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
                match outcome {
                    Outcome::Done => stats.done += 1,
                    Outcome::Cancelled => stats.cancelled += 1,
                    Outcome::Failed(_) => stats.failed += 1,
                }
            }
            match fresh {
                Some(live)
                    if slot.dead == Some(live.incarnation)
                        || outcome == Outcome::Failed(Failure::MemoryLost) =>
                {
                    slot.incarnation = None;
                    slot.dead = None;
                    reap = Some(live);
                }
                Some(live) => {
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

    /// Takes ownership of a VM process a step started and watches for it
    /// dying on its own.
    fn adopt(&mut self, id: Id, vm: E::Vm) -> Live<E::Vm> {
        let incarnation = self.next_incarnation;
        self.next_incarnation += 1;
        let stopping = Arc::new(AtomicBool::new(false));
        let exited = self.engine.exited(&vm);
        let events = self.events_tx.clone();
        let deliberate = Arc::clone(&stopping);
        tokio::spawn(async move {
            exited.await;
            if !deliberate.load(Ordering::Acquire) {
                let _ = events.send(Event::Exited { id, incarnation });
            }
        });
        Live {
            vm,
            incarnation,
            stopping,
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
        self.ordinals.remove(&slot.ordinal);
        for waiter in slot.waiters.drain(..) {
            let _ = waiter.send(Err(HostError::Removed(id)));
        }
        self.destroying
            .insert(id.0, std::mem::take(&mut slot.removers));
        let live = slot.vm.take();
        if let Some(live) = &live {
            live.stopping.store(true, Ordering::Release);
        }
        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let events = self.events_tx.clone();
        let dir = slot.paths.dir.clone();
        tokio::spawn(async move {
            if let Some(live) = live {
                let _ = engine.stop(live.vm).await;
            }
            let stored = store.delete(id).await;
            let removed = match tokio::fs::remove_dir_all(&dir).await {
                Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            };
            let result = match (stored, removed) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(error), _) => Err(HostError::Io(error.to_string())),
                (_, Err(error)) => Err(HostError::Io(error.to_string())),
            };
            let _ = events.send(Event::Destroyed { id, result });
        });
    }

    fn notify(&mut self, id: Id, notice: Notice) {
        match notice {
            Notice::Level {
                level,
                memory_saved,
            } => tracing::debug!(%id, ?level, memory_saved, "level"),
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
        } else if view.level == Level::Running && view.step.is_none() && slot.vm.is_some() {
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
        if !self.pressure {
            return;
        }
        if let Some(available) = self.available_memory {
            self.input(Input::Memory { available });
        }
        let readings: Vec<(SandboxId, u64)> = self
            .slots
            .iter()
            .filter_map(|(id, slot)| {
                let live = slot.vm.as_ref()?;
                Some((*id, self.engine.resident_bytes(&live.vm).ok()?))
            })
            .collect();
        for (sandbox, bytes) in readings {
            self.input(Input::Resident { sandbox, bytes });
        }
    }

    fn status(&self) -> HostStatus {
        let mut sandboxes: Vec<SandboxStatus> = self
            .slots
            .iter()
            .filter_map(|(id, slot)| {
                let view = self.core.sandbox(*id)?;
                Some(SandboxStatus {
                    id: Id(*id),
                    level: view.level.into(),
                    memory_saved: view.level.has_process() || view.memory_saved,
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
        }
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
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
