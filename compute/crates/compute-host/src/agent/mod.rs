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
    Action, At, BalloonRequest, HoldId, Host, Input, Level, LoanId, MemoryPolicy, OpId, Outcome,
    Priority, Resource, SandboxId, Size, SleepPolicy, State, Step,
};
use compute_engine::{CancellationToken, Engine, MemoryStats, PageSize, VmSpec};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use crate::fleet::{Admission, Freezes, LeaseGate};
use crate::guest_ports::{self, Activity, GuestPort, Listeners};
use crate::layout::{Images, Paths};
use crate::net::{NetworkConfig, Networks};
use crate::observe::{Observer, TraceContext};
use crate::pool::{Built, Held, Lender, Loaning, Pool, PoolConfig, Shape, Sources, Template, Uses};

use crate::protocol::{About, HostStatus, Id, ImageId, SandboxConfig, StepStats};
use crate::rootfs::{Cache, Missing};
use crate::state::{Ownership, Record, Records, StateError, Stray, claim_host, unix_ms_now};
use crate::step::{After, Live, Reading, Report};
use crate::store::{Claimed, OwnerEpoch, Store};
use compute_protocol::fleet::Ruling;

mod check;
mod config;
mod disk;
mod fetch;
mod handle;
mod holds;
mod link;
mod observe;
mod owners;
mod ready;
mod recover;
mod remove;
mod requests;
mod sample;
mod steps;
mod usage;
mod warm;

use config::check_config;
pub use config::{BusyRule, GuestChecks, HostConfig, PagerConfig};
pub use sample::DiskGauge;
use sample::ShareCheck;

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

/// Bytes a save writes besides guest memory at most: the device state, the
/// chunk map (32 bytes per 256 KiB) and the record, with room to spare.
const SAVE_EXTRA: u64 = 64 << 20;
/// Where the agent's clock for the decision core starts, so a sandbox found
/// on disk can have been idle since long before this agent started.
const CLOCK_BASE: Duration = Duration::from_secs(10 * 365 * 86_400);

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
    /// The sandbox failed in a way this host cannot retry.
    #[error("sandbox {0} is broken")]
    Broken(Id),
    /// The host does not manage the sandbox until someone resolves why,
    /// such as a record it cannot read or a VM it could not take back.
    #[error("sandbox {id} is not managed on this host: {reason}")]
    Blocked {
        /// The sandbox.
        id: Id,
        /// Why.
        reason: String,
    },
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
    /// The host cannot take on the sandbox's memory, or the local disk it
    /// may write (its next save, its disk's growth, its first files), now:
    /// even ending every idle VM already saved would not free enough.
    /// Retryable.
    #[error(
        "host full: sandbox {id} needs {needed} {what} and only {free} are free",
        what = shortage(*.resource)
    )]
    HostFull {
        /// The sandbox.
        id: Id,
        /// What the host is short of.
        resource: Resource,
        /// Bytes, or inodes, its wake needs.
        needed: u64,
        /// Bytes, or inodes, free when it was refused.
        free: u64,
    },
    /// The host agent has shut down.
    #[error("the host agent stopped")]
    Stopped,
    /// The request names an earlier ownership of the sandbox than the one
    /// this host holds.
    #[error("sandbox {id} is held under owner epoch {held}, not {asked}")]
    Superseded {
        /// The sandbox.
        id: Id,
        /// The owner epoch held.
        held: u64,
        /// The owner epoch the request names.
        asked: u64,
    },
    /// An adopt found no copy of the sandbox in the store.
    #[error("the store holds no copy of sandbox {0}")]
    NoCopy(Id),
    /// A hand-off was asked of a sandbox that is awake or held awake.
    #[error("sandbox {0} is awake; it is handed off only while it sleeps")]
    Awake(Id),
    /// The sandbox is being handed off and takes no wake.
    #[error("sandbox {0} is being handed off")]
    HandingOff(Id),
    /// The host's lease from the control service has run out: it runs
    /// nothing until it is renewed.
    #[error("this host's lease from the control service has run out")]
    LeaseLapsed,
    /// A request from the control service waited in the agent until the
    /// lease no longer admitted it: it was sent under a registration this
    /// host no longer holds or too many renewals ago, or the lease ran
    /// out.
    #[error("the request is no longer admitted under this host's lease")]
    NotAdmitted,
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
            StateError::Superseded { id, held, asked } => Self::Superseded { id, held, asked },
            other => Self::Io(other.to_string()),
        }
    }
}

impl From<Missing> for HostError {
    /// An image nowhere to be had is the caller's mistake; a failed fetch
    /// may succeed when retried.
    fn from(missing: Missing) -> Self {
        match missing {
            Missing::Unknown(_) => Self::Invalid(missing.to_string()),
            Missing::Failed { .. } => Self::Io(missing.to_string()),
        }
    }
}

type Reply<T> = oneshot::Sender<Result<T, HostError>>;

/// Copies of guest memory one save may write at most on the filesystem
/// holding `root`: one where files share extents, otherwise two, since
/// the merged image is then a whole new copy.
fn save_copies(root: &std::path::Path) -> Result<u64, HostError> {
    match crate::layout::shares_extents(root) {
        Ok(true) => Ok(1),
        Ok(false) => Ok(2),
        Err(error) => Err(HostError::Io(format!("probing the state root: {error}"))),
    }
}

/// The bytes the filesystem holding `root` allocates at a time, which
/// sparse copies onto it are booked in; refused on a filesystem where
/// that bounds nothing.
fn allocation_unit(root: &std::path::Path) -> Result<u64, HostError> {
    crate::layout::allocation_unit(root)
        .map_err(|error| HostError::Io(format!("state root {}: {error}", root.display())))
}

/// What a host-full refusal counts.
fn shortage(resource: Resource) -> &'static str {
    match resource {
        Resource::Memory => "bytes of memory reserved",
        Resource::Disk => "bytes of local disk booked",
        Resource::Inodes => "local disk inodes booked",
        Resource::Cpu => "millicores of processor time reserved",
    }
}

#[derive(Debug)]
enum Command {
    Create {
        id: Id,
        config: SandboxConfig,
        /// The ownership it is created under.
        owner: OwnerEpoch,
        reply: Reply<()>,
    },
    /// See [`crate::protocol::Request::Adopt`].
    Adopt {
        id: Id,
        config: SandboxConfig,
        owner: OwnerEpoch,
        from_files: bool,
        reply: Reply<()>,
    },
    /// See [`crate::protocol::Request::HandOff`].
    HandOff {
        id: Id,
        owner: OwnerEpoch,
        reply: Reply<()>,
    },
    /// The control service's rulings on the sandboxes the host listed when
    /// it registered.
    Reconcile {
        rulings: Vec<Ruling>,
        reply: Reply<()>,
    },
    /// `command`, sent for the ownership of its sandbox under `owner`, and
    /// carried out only while `admission` still holds.
    Owned {
        owner: OwnerEpoch,
        admission: Option<Admission>,
        command: Box<Command>,
    },
    /// What the host holds, for a registration: answered once no create,
    /// adopt or change of owner is under way, or with how many are.
    Inventory {
        reply: oneshot::Sender<Result<HostStatus, usize>>,
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
        /// What asked.
        by: observe::By,
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
        name: String,
        ttl: Option<Duration>,
        priority: Priority,
        /// Told whether the hold was already there.
        reply: Reply<bool>,
    },
    /// Ends a named hold from the API.
    Unhold {
        id: Id,
        generation: Option<u64>,
        name: String,
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
    /// One sandbox's level and the step under way, if it has one: for the
    /// canary.
    Inspect {
        id: Id,
        reply: oneshot::Sender<Option<(Level, Option<Step>)>>,
    },
    /// A command from a caller that sent trace context.
    Traced(TraceContext, Box<Command>),
}

#[derive(Debug)]
enum Event<V> {
    /// A change of owner of `id` landed or failed; `reply` waits for it.
    OwnerTaken {
        id: Id,
        result: Result<(), HostError>,
        reply: Reply<()>,
    },
    Prepared {
        id: Id,
        ordinal: u32,
        result: Result<Box<Record>, HostError>,
        reply: Reply<()>,
        /// The template the sandbox could not start from because it no
        /// longer fits today's inputs.
        stale: Option<Arc<Template>>,
        /// Why a create or adopt that failed could not delete all it had
        /// made (see [`remove::unmake`]): its id stays blocked, and its
        /// ordinal taken, until removing it again deletes the rest.
        left: Option<String>,
    },
    /// An adopt claimed the store's copy of `record`'s sandbox, as
    /// `claimed`; its files and record are made only once its first wake
    /// is admitted with the copy's disk (see [`HostAgent::copy_claimed`]).
    CopyClaimed {
        record: Box<Record>,
        claimed: Box<Claimed>,
        reply: Reply<()>,
    },
    /// A sandbox about to sleep only for being idle told whether it stays
    /// awake: a command started through its guest's helper still runs (see
    /// [`crate::restore_notice::ask_commands`]), or its guest took no
    /// connection, so that it may have stopped (see [`check`]).
    Asked {
        id: Id,
        op: OpId,
        step: Step,
        stays: bool,
    },
    /// A check of whether VM process `incarnation` of `id`'s guest still
    /// takes connections ended (see [`check`]). `unfrozen`: the host has
    /// no guard, or its guard says it did not freeze the VMs meanwhile.
    Checked {
        id: Id,
        incarnation: u64,
        reach: crate::restore_notice::Reach,
        unfrozen: bool,
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
        report: Box<Report>,
    },
    /// Work outside any sandbox asks for or gives back a place under a
    /// step limit.
    Loan(Loaning),
    /// Step `op` of `id` no longer does the work its kind's limit protects.
    Unthrottled {
        id: Id,
        op: OpId,
    },
    /// A step that holds `id`'s running VM read its activity; see
    /// [`crate::step::Meter`].
    Reading {
        id: Id,
        reading: Reading,
    },
    Exited {
        id: Id,
        incarnation: u64,
    },
    /// The VM of `id`, under removal, is known to have ended; the rest of
    /// the removal may still be under way, or stop part way.
    VmEnded {
        id: Id,
        /// The name its directory and network were made under.
        host: Id,
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
    /// The VM of `id` did not take the balloon setting of `request`, or
    /// was not asked.
    BalloonFailed {
        id: Id,
        request: BalloonRequest,
    },
    /// The VM of `id` took the balloon setting of `request`.
    BalloonSet {
        id: Id,
        request: BalloonRequest,
    },
    /// A ready sandbox's fill ended.
    Filled {
        host: Id,
        filled: Box<ready::Filled<V>>,
    },
    /// The store told the length of an image creates wait for.
    ImageSized {
        image: ImageId,
        length: Result<Option<u64>, compute_engine::EngineError>,
    },
    /// The fetch of an image creates wait for ended.
    ImageFetched {
        image: ImageId,
        result: Result<(), HostError>,
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
    /// Why it runs.
    why: observe::Why,
    /// Where the sandbox's state was when it started.
    before: Option<State>,
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
    /// The listener for its agent's connections, on a host with links.
    _link: Option<Listeners>,
    /// Whether its guest can run, for its agent-link streams; see
    /// [`HostAgent::tell_clocks`].
    link_clock: crate::resume::RunClock,
    /// Since when its guest can run, if it can: its VM runs, with no step
    /// that pauses it, and the lease lets VMs run. A check counts only what
    /// a guest did not take while it could run all along (see [`check`]);
    /// see [`HostAgent::tell_clocks`].
    runs_since: Option<Instant>,
    op: Option<Running>,
    destroy: bool,
    removers: Vec<Reply<()>>,
    /// Requests waiting for the sandbox to run.
    waiters: Vec<Waiter>,
    /// A step the core started that waits for a dead VM's teardown.
    deferred: Option<Step>,
    /// Processor use and traffic measured so far, while its guest runs.
    usage: usage::Usage,
    /// Whether its running guest still takes connections (see [`check`]).
    check: Option<check::Check>,
    /// The incarnation of the running VM and its memory statistics when
    /// last sampled running; see [`HostAgent::check_uncompressed`].
    stats: Option<(u64, MemoryStats)>,
    /// The reading the last event about the sandbox's pressure counted up
    /// to.
    reported: Option<(u64, MemoryStats)>,
    /// When the sandbox last reported what it went through awake.
    summarized: Instant,
    /// The latest request to wake or hold it since its last sleep step
    /// began.
    asked: Option<observe::Why>,
    /// The latest request to sleep since its last wake step began: every
    /// step down to the level it asked for carries its trace.
    sleep_asked: Option<observe::Why>,
    /// The wake step started since its last sleep step began, if any.
    woke_by: Option<OpId>,
    /// The last step that failed and has not succeeded since, with its
    /// error, such as a save that could not be written.
    failed: Option<(Step, String)>,
    /// Its named holds, kept on disk.
    holds: holds::Holds,
    /// Its removal hands it off: it keeps the store's copy.
    hand_off: bool,
}

/// A request waiting for a sandbox to run.
#[derive(Debug)]
struct Waiter {
    /// The generation it names, if any.
    generation: Option<u64>,
    /// The step under way when it arrived.
    during: Option<Step>,
    /// Whether it had to wait for a step: then the wake step that ran, if
    /// any, is the one it joined.
    queued: bool,
    reply: Reply<Woke>,
}

/// A sandbox that runs, as a waiter learns of it.
#[derive(Debug)]
struct Woke {
    vsock: PathBuf,
    during: Option<Step>,
    /// The execution that is running.
    generation: u64,
    /// The wake step it waited for, if one ran.
    op: Option<OpId>,
}

/// Talks to a running host agent. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Handle {
    commands: mpsc::UnboundedSender<Command>,
    holds: Arc<AtomicU64>,
    stream_idle: Duration,
    /// Who sends through it; see [`Handle::owned`] and
    /// [`Handle::local_to_fleet`].
    origin: Origin,
    /// The host's lease in a fleet, which the host's own tools wait on.
    lease: Option<LeaseGate>,
    observer: Observer,
    /// Trace context every command carries, if any.
    trace: Option<TraceContext>,
    /// What builds the sandbox images asked for, if this host does.
    preparer: Option<Arc<crate::rootfs::Preparer>>,
}

/// Who sends requests through a [`Handle`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    /// The host's own tools, on a host outside a fleet.
    Local,
    /// The host's own tools, on a host in a fleet: they create, adopt and
    /// hand off nothing, since only the control service tracks sandboxes.
    LocalToFleet,
    /// The control service, for the ownership under this owner epoch of the
    /// sandbox each request is about, under the admission its listener
    /// gave the request, if it came through one.
    Fleet(OwnerEpoch, Option<Admission>),
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
    /// The wake step it waited for, if one ran.
    op: Option<OpId>,
    /// The execution the lease reaches: the one asked for, if any.
    generation: u64,
    /// Whether the caller asked for that execution. A lease that was not
    /// asked for one follows the sandbox to a fresh boot.
    pinned: bool,
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
    /// The sandbox images creates name (ADR 19).
    rootfs: Arc<Cache>,
    /// When unused images were last looked for.
    rootfs_retired: Instant,
    /// Images being fetched for the creates that wait for them.
    fetching: HashMap<ImageId, fetch::Fetch>,
    /// Work waiting for the next disk reading to say whether it fits.
    after_reading: Vec<disk::AfterReading>,
    images: Images,
    warm: Option<Warm>,
    core: Host,
    origin: Instant,
    slots: HashMap<SandboxId, Slot<E::Vm>>,
    preparing: HashSet<SandboxId>,
    /// Changes of owner under way, by sandbox (see [`owners`]).
    owning: HashMap<SandboxId, usize>,
    ordinals: BTreeSet<u32>,
    /// Sandboxes on disk the host does not manage, with why: their ids are
    /// refused and their files and VMs left alone.
    blocked: BTreeMap<SandboxId, String>,
    destroying: HashMap<SandboxId, Vec<Reply<()>>>,
    /// Those of `destroying` that hand their sandbox off, keeping the
    /// store's copy for its next owner.
    handing_away: HashSet<SandboxId>,
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
    /// Running sandboxes whose activity could not be read over their last
    /// window, so they count as busy; see [`HostAgent::sample_busy`].
    unseen_activity: usize,
    sample_every: Duration,
    /// Readings given in place of the agent's own; see
    /// [`HostConfig::disk_reading`].
    disk_gauge: Option<DiskGauge>,
    /// The VMs' processor share, read again every few seconds; see
    /// [`HostConfig::processor_share`].
    processor_share: Option<ShareCheck>,
    /// When memory pressure frees memory, if it does.
    memory_policy: Option<MemoryPolicy>,
    /// Ready sandboxes, kept for creates to claim (see [`ready`]).
    ready: ready::Ready<E::Vm>,
    /// Hand-offs under way (see [`owners`]).
    handing_off: owners::HandOffs,
    /// Adopts that wait for an earlier ownership's copy to go.
    then_adopt: owners::Adopts,
    guest_ports: Arc<[GuestPort]>,
    restore_notice_port: Option<u32>,
    guest_checks: GuestChecks,
    link: Option<compute_link::Hub>,
    #[cfg(target_os = "linux")]
    fetcher: Option<Arc<crate::lazy::Fetcher>>,
    busy: Option<BusyRule>,
    can_compress: bool,
    /// Whether guest memory is huge pages, which a guest never gives back:
    /// every sandbox then reserves its whole size.
    reserve_whole: bool,
    /// Copies of guest memory a save may write at most: one where files
    /// share extents, otherwise also the merged image.
    save_copies: u64,
    /// The base image's length when the agent started, for when it
    /// cannot be read later; see [`HostAgent::disk_bound`].
    base_length: u64,
    /// The bytes the state root's filesystem allocates at a time.
    allocation_unit: u64,
    pager: PagerConfig,
    /// What the host runs, as status reports it.
    about: About,
    /// The lease this host holds in a fleet; see [`HostConfig::lease`].
    lease: Option<LeaseGate>,
    /// The guard's freeze count; see [`HostConfig::guard_freezes`].
    guard_freezes: Option<Freezes>,
    /// Lets guest connections report activity without keeping the agent
    /// alive once every [`Handle`] is gone.
    commands_tx: mpsc::WeakUnboundedSender<Command>,
    observer: Observer,
    summary_every: Duration,
    /// Whether the agent is still taking over its state root: steps it
    /// starts meanwhile are for recovery.
    recovering: bool,
    /// The trace context of the command being handled, if it carried one.
    trace: Option<TraceContext>,
}

/// Checks that this host's settings fit every recorded sandbox: a sandbox
/// keeps the user and addresses it was given, and new ones are handed out
/// by today's settings, which therefore must agree.
/// Checks `config` and takes over its state root: its lock, then its
/// records, which must fit the host's images.
async fn open_root(config: &HostConfig) -> Result<(Host, Records, Vec<Stray>, Images), HostError> {
    let core =
        Host::new(config.policy).map_err(|error| HostError::Invalid(format!("{error:?}")))?;
    check_config(config).map_err(HostError::Invalid)?;
    let host_lock = match config.host_lock.clone() {
        Some(path) => Some(claim(path, config.root.clone()).await?),
        None => None,
    };
    let (records, strays) = Records::open(config.root.clone(), HANDOVER, host_lock).await?;
    let images = host_images(config);
    check_fit(&images, &records)?;
    Ok((core, records, strays, images))
}

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

/// How this host's VMs are laid out, from its settings.
fn host_images(config: &HostConfig) -> Images {
    Images {
        kernel: config.kernel.clone(),
        boot_args: match &config.network {
            Some(_) => format!("{} {}", config.boot_args, NetworkConfig::boot_args()),
            None => config.boot_args.clone(),
        },
        first_uid: config.first_uid,
        network: config.network.clone(),
    }
}

/// Lends step slots to the pool, reporting each loan as an event.
fn lender<V: Send + 'static>(events: mpsc::UnboundedSender<Event<V>>) -> Lender {
    Lender::new(move |loaning| {
        let _ = events.send(Event::Loan(loaning));
    })
}

/// Sets up the host's sandbox networking, if sandboxes are networked.
async fn prepare_network(
    network: Option<NetworkConfig>,
) -> Result<Option<Arc<Networks>>, HostError> {
    let Some(network) = network else {
        return Ok(None);
    };
    let runtime = tokio::runtime::Handle::current();
    let prepared = tokio::task::spawn_blocking(move || Networks::prepare(&network, runtime))
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

/// Wakes a sandbox when data arrives for it on a guest port, or a request
/// for its agent on its agent link: `by` says which.
#[derive(Clone, Debug)]
struct Toucher {
    id: Id,
    commands: mpsc::WeakUnboundedSender<Command>,
    by: observe::By,
}

impl Activity for Toucher {
    fn wake(&self) {
        if let Some(commands) = self.commands.upgrade() {
            let _ = commands.send(Command::Touch {
                id: self.id,
                generation: None,
                priority: Priority::Interactive,
                by: self.by,
                reply: None,
            });
        }
    }
}

/// The host's sandbox images. An image goes unused as long as a template
/// may before it is removed.
async fn open_rootfs(config: &HostConfig, owner: Ownership) -> Result<Arc<Cache>, HostError> {
    let dir = crate::layout::rootfs_dir(&config.root);
    let unused_after = config
        .pool
        .as_ref()
        .map_or(PoolConfig::UNUSED_AFTER, |pool| pool.unused_after);
    let cache = tokio::task::spawn_blocking(move || Cache::open(dir, unused_after, owner))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(|error| HostError::Io(format!("sandbox images: {error}")))?;
    Ok(Arc::new(cache))
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
        // On a host in a fleet requests wait until it has started; it logs
        // how long that took.
        let began = Instant::now();
        let (core, records, strays, images) = open_root(&config).await?;
        let net = prepare_network(config.network.clone()).await?;
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        // Huge-page profiles cannot compress, whatever the host says.
        let profile = engine.memory_profile();
        let allocation_unit = allocation_unit(&config.root)?;
        let save_copies = save_copies(&config.root)?;
        let rootfs = open_rootfs(&config, records.ownership()).await?;
        // Template VMs an earlier agent left are ended before any sandbox
        // can be given the user one of them ran as.
        let warm::Started {
            warm,
            shapes: warm_shapes,
            held,
            ready,
        } = Warm::start(&engine, &config, &rootfs, &images).await;
        let about = About {
            runtime: engine.runtime().to_owned(),
            checkpoints: store.is_configured() && save_copies == 1,
            ..config.about
        };
        let mut agent = Self {
            engine: Arc::new(engine),
            #[cfg(target_os = "linux")]
            fetcher: (store.chunks()).map(|(chunks, lanes)| {
                Arc::new(crate::lazy::Fetcher::new(chunks.clone(), Arc::clone(lanes)))
            }),
            store: Arc::new(store),
            records: Arc::new(records),
            net,
            images,
            root: config.root,
            base_length: std::fs::metadata(&config.base_image).map_or(0, |found| found.len()),
            base_image: config.base_image,
            rootfs,
            rootfs_retired: Instant::now(),
            fetching: HashMap::new(),
            warm,
            memory_policy: config.policy.memory,
            ready: ready::Ready::new(ready),
            handing_off: HashMap::new(),
            then_adopt: HashMap::new(),
            pager: config.pager,
            core,
            origin: Instant::now(),
            slots: HashMap::new(),
            preparing: HashSet::new(),
            after_reading: Vec::new(),
            owning: HashMap::new(),
            ordinals: BTreeSet::new(),
            blocked: BTreeMap::new(),
            destroying: HashMap::new(),
            handing_away: HashSet::new(),
            leftovers: HashMap::new(),
            hosts: HashMap::new(),
            unknown_ordinals: BTreeSet::new(),
            unknown_builds: BTreeSet::new(),
            lender: lender(events_tx.clone()),
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
            unseen_activity: 0,
            sample_every: config.sample_every,
            disk_gauge: config.disk_reading,
            processor_share: ShareCheck::of(config.processor_share, config.policy.cpu_budget),
            guest_ports: config.guest_ports.into(),
            restore_notice_port: config.restore_notice_port,
            guest_checks: config.guest_checks,
            link: config.agent_link,
            busy: config.busy,
            can_compress: config.can_compress && profile.compress,
            reserve_whole: profile.pages == PageSize::Huge,
            save_copies,
            allocation_unit,
            about,
            lease: config.lease,
            guard_freezes: config.guard_freezes,
            commands_tx: commands_tx.downgrade(),
            observer: config.observer,
            summary_every: config.summary_every,
            recovering: true,
            trace: None,
        };
        // Boxed: recovery's future is large, and every caller awaits this one.
        Box::pin(agent.begin(held, strays, warm_shapes, began)).await;
        let handle = agent.handle(commands_tx, config.stream_idle, config.prepare);
        Ok((handle, tokio::spawn(agent.run())))
    }

    /// A handle sending commands on `commands`, that builds the images the
    /// control service asks for as `prepare` says.
    fn handle(
        &self,
        commands: mpsc::UnboundedSender<Command>,
        stream_idle: Duration,
        prepare: Option<crate::rootfs::PrepareConfig>,
    ) -> Handle {
        Handle::new(
            commands,
            stream_idle,
            self.lease.clone(),
            self.observer.clone(),
            crate::rootfs::Preparer::of(prepare, &self.store),
        )
    }

    /// Takes back what an earlier agent left, then takes a first reading
    /// and starts the templates; then logs how long the start that `began`
    /// then took, and its recovery.
    async fn begin(
        &mut self,
        held: Vec<Held>,
        strays: Vec<Stray>,
        shapes: Vec<Shape>,
        began: Instant,
    ) {
        let recovering = Instant::now();
        // Before any VM starts or is adopted, so no group being set up
        // looks left behind.
        if let Err(error) = self.engine.clean_up_left_behind() {
            tracing::warn!(%error, "could not release what VMs that ended unmanaged left behind");
        }
        self.hold_builds(held);
        self.recover(strays).await;
        // Admission refuses what needs disk until it has a reading, and
        // spare VMs wait for a memory reading too, so one is taken before
        // any build starts or request is served.
        self.sample();
        self.recovering = false;
        self.start_templates(shapes);
        tracing::info!(
            ms = began.elapsed().as_millis(),
            recovery_ms = recovering.elapsed().as_millis(),
            "started"
        );
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
            by: observe::By::GuestPort,
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
        let holds = holds::Holds::new(paths.holds.clone(), self.records.ownership());
        let link_clock = crate::resume::RunClock::default();
        let link = self.listen_link(id, &spec, &link_clock);
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
                _link: link,
                link_clock,
                runs_since: None,
                op: None,
                destroy: false,
                removers: Vec::new(),
                waiters: Vec::new(),
                hand_off: false,
                deferred: None,
                usage: usage::Usage::default(),
                check: None,
                stats: None,
                reported: None,
                summarized: Instant::now(),
                asked: None,
                sleep_asked: None,
                woke_by: None,
                failed: None,
                holds,
            },
        );
        self.link_as_recorded(id);
    }

    /// Validates a sandbox's settings and fits its sleep policy to this
    /// host.
    fn sleep_policy(&self, config: &SandboxConfig) -> Result<SleepPolicy, String> {
        config.validate()?;
        let mut rules = config.sleep.rules();
        rules.compress_under_pressure &= self.can_compress;
        // A checkpoint clones the disk while its VM is paused. Where files
        // cannot share extents that would copy the whole disk with the VM
        // paused, so such a host takes none (its status says so), and its
        // sandboxes reach the store only as they sleep.
        if !self.shares_extents() {
            rules.checkpoint_every = None;
        }
        SleepPolicy::new(rules).map_err(|error| format!("invalid sleep settings: {error}"))
    }

    /// Whether files under the state root share extents, which checkpoints
    /// need: a save then writes one copy of memory at most.
    const fn shares_extents(&self) -> bool {
        self.save_copies == 1
    }

    /// What a sandbox of `config` whose disk is `disk_bytes` long reserves
    /// and may use of host memory, and what one save of it may write: the
    /// memory that changed, the merged image where files cannot share
    /// extents, and its device state and chunk map; what its disk may grow
    /// by while it runs; and what a wake from object storage writes
    /// locally: its disk, the memory image its pager fills, and its device
    /// state. A disk of unknown length counts as a copy of its image as it
    /// is today, as a new sandbox's is.
    fn size(&self, config: &SandboxConfig, disk_bytes: Option<u64>) -> Size {
        let limit = u64::from(config.memory_mib) << 20;
        let request = if self.reserve_whole {
            limit
        } else {
            u64::from(config.memory_request()) << 20
        };
        let disk = disk_bytes.map_or_else(
            || self.disk_bound(config.image),
            |length| crate::disk_growth::disk_bound(length, self.allocation_unit),
        );
        Size {
            request,
            limit,
            cpu: u64::from(config.cpu_request()),
            save: limit * self.save_copies + SAVE_EXTRA,
            disk,
            fetch: disk
                .saturating_add(limit.next_multiple_of(self.allocation_unit.max(1)))
                .saturating_add(SAVE_EXTRA),
        }
    }

    /// [`Self::size`] for the sandbox `record` describes.
    fn record_size(&self, record: &Record) -> Size {
        self.size(&record.config, record.allocation.disk_bytes)
    }

    async fn run(mut self) {
        let mut sample = tokio::time::interval(self.sample_every);
        sample.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        #[cfg(target_os = "linux")]
        let trimming = tokio::spawn(crate::logs::keep_trimmed(
            self.root.clone(),
            self.shutdown.clone(),
        ));
        let lease = self.lease.clone();
        loop {
            let deadline = self
                .core
                .next_deadline()
                .map(|at| self.origin + at.since_origin().saturating_sub(CLOCK_BASE));
            // While the lease has run out, time decides nothing: the VMs
            // are frozen, and the service may be giving their sandboxes to
            // other hosts. Events and requests still come in, so the
            // service's rulings can be carried out; the core decides
            // nothing of its own on them either (see `inputs`).
            let acting = self.may_act();
            tokio::select! {
                biased;
                // First, so a steady stream of events and requests cannot
                // starve it: it is ready at most once per interval.
                _ = sample.tick(), if acting => self.sample(),
                Some(event) = self.events.recv() => self.on_event(event),
                command = self.commands.recv() => match command {
                    Some(command) => self.on_command(command),
                    None => break,
                },
                () = sleep_until_some(deadline), if acting => self.input(Input::Tick),
                // Renewed, the core reconsiders every sandbox.
                () = lease_changed(lease.as_ref()) => self.input(Input::Tick),
            }
        }
        tracing::info!("every handle dropped; host agent stopping, VMs keep running");
        // Teardowns under way finish their current attempt; the next agent
        // retries any that failed.
        self.shutdown.cancel();
        #[cfg(target_os = "linux")]
        let _ = trimming.await;
        while self.teardowns.join_next().await.is_some() {}
        // The agent links' sessions are on disk before the next agent
        // reads them.
        if let Some(hub) = &self.link {
            hub.shutdown().await;
        }
    }

    fn now(&self) -> At {
        At::from_duration(CLOCK_BASE + self.origin.elapsed())
    }

    /// Whether the agent may decide anything of its own now: always, except
    /// on a host in a fleet whose lease has run out.
    fn may_act(&self) -> bool {
        self.lease.as_ref().is_none_or(LeaseGate::is_open)
    }

    /// `at` in milliseconds since the Unix epoch.
    fn unix_ms(&self, at: At) -> u64 {
        let ago = self.now().saturating_since(at);
        unix_ms_now().saturating_sub(u64::try_from(ago.as_millis()).unwrap_or(u64::MAX))
    }

    /// The time `unix_ms` milliseconds after the Unix epoch on the agent's
    /// clock; one before the clock's start counts as its start.
    fn at_unix_ms(&self, unix_ms: u64) -> At {
        let ago = Duration::from_millis(unix_ms_now().saturating_sub(unix_ms));
        At::from_duration(self.now().since_origin().saturating_sub(ago))
    }

    fn input(&mut self, input: Input) {
        self.inputs([input]);
    }

    /// Feeds inputs observed together to the core, which decides once after
    /// all of them.
    /// On a host in a fleet whose lease has run out the core is suspended
    /// ([`Host::suspend`]): it takes the inputs in and carries out removals,
    /// but nothing it would decide of its own, such as pausing a sandbox
    /// that went idle, starts until the lease is renewed.
    fn inputs(&mut self, inputs: impl IntoIterator<Item = Input>) {
        let acting = self.may_act();
        if acting == self.core.is_suspended() {
            self.core.suspend(!acting);
        }
        let now = self.now();
        let mut actions = std::mem::take(&mut self.actions);
        // The inputs after which a sandbox may be at another level.
        let mut moved = Vec::new();
        let inputs = inputs.into_iter().inspect(|input| match input {
            Input::Add { sandbox, .. }
            | Input::Finished { sandbox, .. }
            | Input::Lost { sandbox } => {
                moved.push(*sandbox);
            }
            _ => {}
        });
        self.core.handle_all(now, inputs, &mut actions);
        for sandbox in moved {
            self.tell_link(Id(sandbox));
        }
        for action in actions.drain(..) {
            self.execute(action);
        }
        self.actions = actions;
        self.tell_clocks();
    }
}

/// Returns when `lease` may have opened or closed; never without one.
async fn lease_changed(lease: Option<&LeaseGate>) {
    match lease {
        Some(lease) => lease.changed().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
