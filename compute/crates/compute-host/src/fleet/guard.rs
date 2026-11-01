//! The guard process: steps [`compute_fleet::Guard`] every 100 ms against
//! the lease file and the VMs' cgroup, and holds the kernel watchdog.
//!
//! It runs as a service of its own (`compute-host guard`), in a cgroup of
//! its own, so it outlives the agent as the VMs do and is never frozen
//! with them. It holds an exclusive lock on its lock file while it runs,
//! so a second guard refuses to start, and a second lock ([`ready_lock`])
//! once its watchdog is armed, systemd keeps it, and it has stepped once:
//! the agent refuses to join a fleet unless a guard holds that one. A
//! guard that fails to arm its watchdog, or whose watchdog systemd does
//! not keep, never takes it.
//!
//! Beside its lock it keeps [`Freezes`], the count of what it did to the
//! VMs' freezer, for the agent's checks of its guests, and [`Fenced`], the
//! VMs it ended because they had not frozen by the deadline, so the agent
//! says why they ended.
//!
//! Opening the watchdog feeds it, and so does closing it: it stays armed
//! (`nowayout`), and the kernel pings it as it stays so. A feed at any
//! other step than one that may feed it, with the lease run out and the
//! VMs still running, would give them one more watchdog timeout than the
//! fleet's margin allows for. So the guard opens the device only at a step
//! that may feed it, and has systemd keep it open beside it ([`kept`]):
//! the guard that ends, however it ends, then does not close it, and the
//! next one takes it over from systemd without opening it, which is what
//! lets an upgrade hand the guard over to a new release's. Asked to stop,
//! a guard stops only at a step that may feed it all the same, so a
//! device systemd did not keep is closed only then.
//!
//! On a machine the host shares, the guard feeds systemd's watchdog of its
//! own service instead, and the service's stop hook kills the VMs
//! ([`super::fence`], ADR 26).
//!
//! [`kept`]: super::kept

use std::fs::File;
use std::io;
use std::os::fd::{AsFd as _, BorrowedFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use compute_core::At;
use compute_engine::cgroup::{Cgroup, OnlyCopy};
use compute_engine::watchdog::Watchdog;
use compute_fleet::{Group, Guard, GuardAction, Observed, Plan};
use rustix::fs::{FlockOperation, flock};

use super::fence::ServiceWatchdog;
use super::gate::boot_now;
use super::gate::nanos;
use super::kept;
use super::record::LeaseFile;

mod fenced;

pub use fenced::Fenced;
use fenced::Fencing;

/// How often the guard steps.
pub const STEP: Duration = Duration::from_millis(100);

/// How often a guard whose watchdog systemd does not keep yet asks again.
const KEEP_AGAIN: Duration = Duration::from_secs(1);

/// The stack of the thread that lists the store. The guard's memory is
/// locked in ([`keep_resident`]), so the step that starts the thread
/// brings in its whole stack before it goes on: a small one keeps that
/// step short.
const LISTING_STACK: usize = 256 * 1024;

/// What the guard watches and holds.
#[derive(Clone, Debug)]
pub struct GuardConfig {
    /// The cgroup that holds every VM, such as `/sys/fs/cgroup/compute`.
    pub cgroup: PathBuf,
    /// The lease file the agent writes.
    pub lease_file: PathBuf,
    /// The lock the guard holds while it runs.
    pub lock: PathBuf,
    /// The mark the sleep hook leaves while a suspend is under way.
    pub suspending: PathBuf,
    /// What stops the VMs if the guard stalls or ends.
    pub fence: Fence,
}

/// What stops the VMs if the guard stalls or ends: the watchdog it feeds
/// at every step that may feed one (the lease valid or the VMs stopped).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fence {
    /// The machine's watchdog device, set up with the lease terms' timeout
    /// and `nowayout`: a guard that stops feeding it resets the machine.
    /// For a host that has its machine to itself.
    Machine {
        /// The device, such as `/dev/watchdog0`.
        device: PathBuf,
        /// The lease terms' watchdog timeout.
        timeout: Duration,
    },
    /// systemd's watchdog of the guard's own service, of at most `timeout`
    /// (the lease terms'): systemd kills a guard that stops feeding it,
    /// and the service's stop hook kills every VM. For a host that shares
    /// its machine (ADR 26).
    Service {
        /// The lease terms' watchdog timeout.
        timeout: Duration,
    },
    /// None, which leaves a stalled guard unchecked (tests only).
    None,
}

/// Takes the guard's lock: an exclusive lock on `path`, held while the
/// file stays open.
pub fn hold_lock(path: &Path) -> anyhow::Result<File> {
    try_hold_lock(path)?.with_context(|| format!("another guard holds {}", path.display()))
}

/// Takes an exclusive lock on `path` if no one holds it; `None` if someone
/// does.
fn try_hold_lock(path: &Path) -> anyhow::Result<Option<File>> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    match flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(Some(file)),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("locking {}", path.display())),
    }
}

/// The lock a guard whose lock is `lock` holds once it guards the VMs.
#[must_use]
pub fn ready_lock(lock: &Path) -> PathBuf {
    let mut name = lock.file_name().unwrap_or_default().to_owned();
    name.push(".ready");
    lock.with_file_name(name)
}

/// Whether a guard is ready: it holds the ready lock of `lock`.
pub fn guard_ready(lock: &Path) -> io::Result<bool> {
    held(&ready_lock(lock))
}

/// The guard's count of its freezes and thaws, kept beside its lock so
/// that the agent's checks of its guests can tell whether the guard froze
/// a guest while it was checked (see `agent::check`).
///
/// The guard moves it on before it freezes (or kills) the VMs and after it
/// thaws them, and otherwise follows what the freezer shows. So it is odd
/// while the VMs are frozen, freezing or in a state the guard does not
/// know, and even while they run. It says the count at each of its steps,
/// with which guard it is and when it said it ([`Said`]), and a count it
/// could not write it has not said: what it said before stays, with the
/// time it said it. So a check that reads an even count just before its
/// connection, and the same count of the same guard in what the guard
/// said after the connection ended, knows the guard did not freeze the
/// VMs meanwhile, for whatever reason (a lease about to run out, a suspend
/// being prepared), however late the guard acted; a guard that cannot
/// write, or has stopped, says nothing after it, and vouches for nothing.
/// A guard starts odd, since until its first step it does not know what
/// the freezer holds. A count that is missing or unreadable vouches for
/// nothing.
#[derive(Clone, Debug)]
pub struct Freezes {
    path: PathBuf,
}

/// What a guard said in its count of freezes (see [`Freezes`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Said {
    /// Which guard said it: when it started, in nanoseconds on the boot
    /// clock, so a count another guard said is never taken for its.
    pub guard: u64,
    /// The count.
    pub count: u64,
    /// When it said it, on the boot clock.
    pub at: At,
}

impl Freezes {
    /// The count the guard whose lock is `lock` keeps.
    #[must_use]
    pub fn beside(lock: &Path) -> Self {
        let mut name = lock.file_name().unwrap_or_default().to_owned();
        name.push(".freezes");
        Self {
            path: lock.with_file_name(name),
        }
    }

    /// What the guard last said, or `None` if there is nothing to trust.
    #[must_use]
    pub fn read(&self) -> Option<Said> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        let mut fields = text.split_ascii_whitespace().map(str::parse::<u64>);
        let (Some(Ok(guard)), Some(Ok(count)), Some(Ok(at)), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return None;
        };
        Some(Said {
            guard,
            count,
            at: At::from_duration(Duration::from_nanos(at)),
        })
    }

    /// Says `count` as guard `guard`, now, replacing what was said. The
    /// guard's; tests stand in for it.
    ///
    /// # Errors
    ///
    /// When it cannot be written: then it is not said, and what was said
    /// before stays, with the time it was said.
    pub fn say(&self, guard: u64, count: u64) -> io::Result<()> {
        let staging = self.path.with_extension("freezes.staging");
        std::fs::write(&staging, format!("{guard} {count} {}\n", nanos(boot_now())))?;
        std::fs::rename(&staging, &self.path)
    }

    /// The VMs the same guard records it ended.
    #[must_use]
    pub fn fenced(&self) -> Fenced {
        Fenced::at(self.path.with_extension("fenced"))
    }
}

/// The guard's side of [`Freezes`]: its count, which it moves on whether
/// or not it can say it, so whatever it says next differs from what it
/// said before a freeze.
#[derive(Debug)]
struct Saying {
    freezes: Freezes,
    guard: u64,
    count: u64,
    /// Whether the last count could not be said, so a failure is logged
    /// once, not at every step.
    failing: bool,
}

impl Saying {
    /// A guard starting now: odd, since it does not yet know what the
    /// freezer holds.
    fn new(freezes: Freezes) -> Self {
        Self {
            freezes,
            guard: nanos(boot_now()),
            count: 1,
            failing: false,
        }
    }

    /// Moves the count on to the next number of the given parity, if it is
    /// not of that parity already, and says it.
    fn say(&mut self, frozen: bool) {
        if (self.count % 2 == 1) != frozen {
            self.count += 1;
        }
        match self.freezes.say(self.guard, self.count) {
            Ok(()) => {
                if std::mem::take(&mut self.failing) {
                    tracing::info!("the guard writes its freeze count again");
                }
            }
            Err(error) => {
                if !std::mem::replace(&mut self.failing, true) {
                    tracing::error!(
                        %error,
                        path = %self.freezes.path.display(),
                        "the guard could not write its freeze count: until it can, no check of a guest counts a miss"
                    );
                }
            }
        }
    }
}

/// Whether some process holds the lock at `path`.
fn held(path: &Path) -> io::Result<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match flock(&file, FlockOperation::NonBlockingLockShared) {
        Ok(()) => Ok(false),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(true),
        Err(error) => Err(error.into()),
    }
}

/// Locks every page the guard process maps, now and later, into memory.
///
/// The guard must feed the watchdog within its timeout (3 s) however
/// loaded the host is, or the watchdog resets the machine and every
/// sandbox on it loses its programs. A host whose guests hold more memory
/// than it has swaps and reclaims, and a guard whose code or data the
/// kernel took back then waits on that same busy disk to get them again,
/// for longer than the watchdog allows. Locked, its pages stay, including
/// those of steps it has not taken yet, such as stopping the VMs. Its unit
/// also gives it real-time priority (`compute-guard.service`), which puts
/// its turn first and lets its few allocations draw on the kernel's
/// reserve, and it never waits on the journal ([`super::Lossy`]) or on
/// systemd ([`kept`]).
///
/// Locking covers the guard's own memory only: not the pages of the files
/// it reads, such as the lease file (tmpfs, which a host short of memory
/// swaps out too), nor what the kernel does for it. Bringing every page in
/// takes a while on such a host, so the binary's own guard command calls
/// this on a thread of its own as the guard starts, which takes over the
/// watchdog and feeds it meanwhile. Tests running the guard in their own
/// process do not call it.
///
/// # Errors
///
/// When the kernel refuses, as without the right to lock memory: the
/// guard still guards, but a host short of memory may stall it.
pub fn keep_resident() -> io::Result<()> {
    rustix::mm::mlockall(rustix::mm::MlockAllFlags::CURRENT | rustix::mm::MlockAllFlags::FUTURE)
        .map_err(io::Error::from)
}

/// Runs the guard until `stop` is set and it may stop, at a step that fed
/// the watchdog (the lease was valid or the VMs had stopped), or until it
/// fails to feed the watchdog, which then reboots the machine; that is the
/// point. Until it may stop it goes on as before, stopping the VMs, and if
/// they never stop, the watchdog resets the machine.
///
/// It takes over the watchdog an earlier guard had systemd keep, armed;
/// otherwise it opens it at its first step that may feed it, and has
/// systemd keep it (see the module's documentation). It is ready once
/// systemd keeps the watchdog and it has stepped; until then it guards all
/// the same, asking systemd again every [`KEEP_AGAIN`].
pub fn run_guard(config: &GuardConfig, stop: &AtomicBool) -> anyhow::Result<()> {
    if let Some(dir) = config.lock.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let _lock = hold_lock(&config.lock)?;
    let mut watchdog = match &config.fence {
        Fence::Machine { device, timeout } => {
            let kept = kept::kept(device, *timeout).with_context(|| {
                format!("taking over the watchdog {} systemd kept", device.display())
            })?;
            if kept.is_some() {
                tracing::info!("took over the watchdog systemd kept");
            }
            kept
        }
        Fence::Service { .. } => None,
        Fence::None => {
            tracing::warn!("no watchdog: a stalled guard leaves VMs running past their lease");
            None
        }
    };
    let mut service = match &config.fence {
        Fence::Service { timeout } => {
            let service = ServiceWatchdog::from_env(*timeout)?;
            tracing::info!("the guard feeds its service's watchdog: the machine is shared");
            Some(service)
        }
        Fence::Machine { .. } | Fence::None => None,
    };
    let cgroup = Cgroup::at(&config.cgroup);
    let guard = Guard::new();
    let freezes = Freezes::beside(&config.lock);
    let mut fencing = Fencing::new(freezes.fenced());
    let mut saying = Saying::new(freezes);
    saying.say(true);
    let mut last = Acted::default();
    let mut ready = None;
    let mut waiting = false;
    // Whether the guard has seen systemd keep the watchdog.
    let mut keeping = Keeping::new(
        watchdog.is_some(),
        Arc::new(|identity| kept::stored(kept::WATCHDOG, identity)),
    );
    let mut kept_open = false;
    let socket = std::env::var("NOTIFY_SOCKET").ok();
    tracing::info!(cgroup = %config.cgroup.display(), "guard running");
    loop {
        let stepped = step_once(
            &guard,
            &cgroup,
            config,
            &mut last,
            &mut saying,
            &mut fencing,
            stop.load(Ordering::Relaxed),
        );
        if stepped.feed {
            if watchdog.is_none()
                && let Fence::Machine { device, timeout } = &config.fence
            {
                watchdog = Some(
                    Watchdog::open(device, *timeout)
                        .with_context(|| format!("opening the watchdog {}", device.display()))?,
                );
            }
            if let Some(watchdog) = &mut watchdog {
                watchdog.feed().context("feeding the watchdog")?;
            }
            if let Some(service) = &mut service {
                service.feed();
            }
        }
        if let Some(watchdog) = &watchdog
            && !kept_open
        {
            kept_open = keeping.kept(watchdog.as_fd(), socket.as_deref());
        }
        let armed = match &config.fence {
            Fence::Machine { .. } => kept_open,
            Fence::Service { .. } => service.as_ref().is_some_and(ServiceWatchdog::fed),
            Fence::None => true,
        };
        if ready.is_none() && armed {
            // Armed and stepped once: the VMs are guarded from here on. A
            // look at whether a guard is ready (the agent's, at its start)
            // holds the lock for a moment; then it is taken a step later.
            ready = try_hold_lock(&ready_lock(&config.lock))?;
        }
        if stop.load(Ordering::Relaxed) {
            // systemd keeps the watchdog open; one it does not keep is
            // closed now, which feeds it as this step just did. The lock
            // goes last, so the next guard opens the watchdog only once
            // this one has closed it. It stops only with the VMs as any
            // guard expects them ([`Guard::plan`]), which a step asked to
            // stop sees to.
            if stepped.may_stop {
                tracing::info!("guard stopping");
                return Ok(());
            }
            if !waiting {
                tracing::warn!(
                    "asked to stop with the lease run out and VMs running: leaving them as any guard expects them first"
                );
                waiting = true;
            }
        }
        std::thread::sleep(STEP);
    }
}

/// Whether the store of the guard's service holds a file, as systemd lists
/// it ([`kept::stored`]); it waits for systemd.
type ListStore = Arc<dyn Fn(kept::Identity) -> io::Result<bool> + Send + Sync>;

/// The guard's asking systemd to keep its watchdog open.
struct Keeping {
    /// The guard took the watchdog over from the store.
    taken_over: bool,
    /// How it lists the store.
    list: ListStore,
    /// When it last asked.
    asked: Option<Instant>,
    /// The barrier sent after it asked, until systemd deals with it.
    barrier: Option<kept::Barrier>,
    /// The listing of the store under way since then, on a thread of its
    /// own, until systemd answers.
    listing: Option<(Instant, mpsc::Receiver<io::Result<bool>>)>,
    /// Whether systemd dealt with the last request, but the store could
    /// not be listed: it is listed again, without asking again.
    list_again: bool,
    /// Whether it said why it is not ready, so it says it once.
    told: bool,
}

impl Keeping {
    fn new(taken_over: bool, list: ListStore) -> Self {
        Self {
            taken_over,
            list,
            asked: None,
            barrier: None,
            listing: None,
            list_again: false,
            told: false,
        }
    }

    /// Whether systemd keeps the watchdog `fd` is open on, as far as the
    /// guard has seen, without waiting: it asks systemd, through its
    /// notification socket `socket`, to keep it, with a barrier after that,
    /// and once the barrier has passed, lists the service's store, on
    /// another thread, for the device. Until it is listed it asks again
    /// every [`KEEP_AGAIN`] (systemd keeps one file once), or, when the
    /// store could not be listed, lists it again. A watchdog taken over
    /// from the store is kept there already, so the first time it sends the
    /// barrier alone: asked to keep it again, systemd would refuse the copy.
    fn kept(&mut self, fd: BorrowedFd<'_>, socket: Option<&str>) -> bool {
        if let Some((since, listing)) = &self.listing {
            let answer = match listing.try_recv() {
                Ok(answer) => answer,
                Err(mpsc::TryRecvError::Empty) => {
                    if since.elapsed() >= KEEP_AGAIN * 5 {
                        self.tell("systemd has not listed the service's file descriptor store");
                    }
                    return false;
                }
                Err(mpsc::TryRecvError::Disconnected) => Err(io::Error::other(
                    "listing the store ended without an answer",
                )),
            };
            self.listing = None;
            match answer {
                Ok(true) => {
                    tracing::info!("systemd keeps the watchdog open");
                    return true;
                }
                Ok(false) => self.tell(
                    "systemd does not keep the watchdog (its service sets no FileDescriptorStoreMax?)",
                ),
                Err(error) => {
                    self.list_again = true;
                    self.tell(&format!(
                        "could not see whether systemd keeps the watchdog: {error}"
                    ));
                }
            }
        }
        if let Some(barrier) = &self.barrier {
            match barrier.passed() {
                Ok(false) => {
                    if self.asked.is_some_and(|at| at.elapsed() >= KEEP_AGAIN * 5) {
                        self.tell("systemd has not dealt with the request to keep the watchdog");
                    }
                    return false;
                }
                Ok(true) => {
                    self.barrier = None;
                    self.list(fd);
                    return false;
                }
                Err(error) => {
                    self.barrier = None;
                    self.tell(&format!("could not see whether systemd has dealt with the request to keep the watchdog: {error}"));
                }
            }
        }
        if self.asked.is_some_and(|at| at.elapsed() < KEEP_AGAIN) {
            return false;
        }
        let first = self.asked.replace(Instant::now()).is_none();
        if std::mem::take(&mut self.list_again) {
            self.list(fd);
            return false;
        }
        let Some(socket) = socket else {
            self.tell("not run by systemd, which would keep the watchdog");
            return false;
        };
        let asking = if first && self.taken_over {
            Ok(())
        } else {
            kept::keep(socket, kept::WATCHDOG, fd)
        };
        match asking.and_then(|()| kept::Barrier::send(socket)) {
            Ok(barrier) => self.barrier = Some(barrier),
            Err(error) => self.tell(&format!(
                "asking systemd to keep the watchdog failed: {error}"
            )),
        }
        false
    }

    /// Starts listing the store for the file `fd` is open on.
    fn list(&mut self, fd: BorrowedFd<'_>) {
        let started = kept::Identity::of(fd).and_then(|identity| {
            let (answer, listing) = mpsc::channel();
            let list = Arc::clone(&self.list);
            std::thread::Builder::new()
                .name("guard-store".into())
                .stack_size(LISTING_STACK)
                .spawn(move || {
                    let _ = answer.send(list(identity));
                })?;
            Ok(listing)
        });
        match started {
            Ok(listing) => self.listing = Some((Instant::now(), listing)),
            Err(error) => {
                self.list_again = true;
                self.tell(&format!(
                    "could not see whether systemd keeps the watchdog: {error}"
                ));
            }
        }
    }

    /// Says, once, why the guard is not ready.
    fn tell(&mut self, problem: &str) {
        if !std::mem::replace(&mut self.told, true) {
            tracing::error!("{problem}: the guard guards, but is not ready until systemd keeps it");
        }
    }
}

/// What one step found the guard may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stepped {
    /// Feed the watchdog.
    feed: bool,
    /// Stop, if asked to.
    may_stop: bool,
}

/// What the guard last did, so it says so once when that changes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Acted {
    /// What it asked of the cgroup that holds every VM.
    vms: Option<GuardAction>,
    /// How many groups it asked to freeze, to kill, and to thaw.
    groups: (usize, usize, usize),
}

/// The VMs' own groups as the kernel reports them, or `None` when they
/// cannot be told apart: a process sits in the cgroup itself, or what is
/// inside it cannot be listed. A group whose freezer cannot be read counts
/// as running and not marked, so it is frozen with the others, and makes
/// the count of freezes vouch for nothing.
fn groups_of(cgroup: &Cgroup) -> Option<(Vec<Cgroup>, Vec<Group>, bool)> {
    let (Ok(own), Ok(children)) = (cgroup.processes(), cgroup.children()) else {
        return None;
    };
    if !own.is_empty() {
        return None;
    }
    let mut unknown = false;
    let groups = children
        .iter()
        .map(|child| {
            let Ok(state) = child.freezer() else {
                unknown = true;
                return Group::default();
            };
            // A mark that cannot be read is not there.
            let mark = if state.empty {
                OnlyCopy::No
            } else {
                child.only_copy().unwrap_or(OnlyCopy::No)
            };
            Group {
                only_copy: mark == OnlyCopy::Yes,
                orphaned: mark == OnlyCopy::Orphaned,
                freezing: state.asked,
                frozen: state.frozen,
                empty: state.empty,
            }
        })
        .collect();
    Some((children, groups, unknown))
}

/// The name a VM's group goes by in [`Fenced`].
fn name_of(group: &Cgroup) -> String {
    group.path().file_name().map_or_else(
        || "*".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// One step: acts on the kernel, says the freeze count, and returns
/// whether to feed the watchdog and whether the guard may stop;
/// `stopping`: it is asked to.
fn step_once(
    guard: &Guard,
    cgroup: &Cgroup,
    config: &GuardConfig,
    last: &mut Acted,
    saying: &mut Saying,
    fencing: &mut Fencing,
    stopping: bool,
) -> Stepped {
    // A file it cannot read holds no lease it can trust.
    let deadline = LeaseFile::read(&config.lease_file).map_or(At::ZERO, LeaseFile::deadline);
    let suspending = config.suspending.exists();
    let (observed, known) = match cgroup.freezer() {
        Ok(state) => (
            Observed {
                freezing: state.asked,
                frozen: state.frozen,
                empty: state.empty,
                suspending,
            },
            true,
        ),
        Err(error) => {
            tracing::warn!(%error, "reading the VMs' freezer failed");
            (
                Observed {
                    suspending,
                    ..Observed::default()
                },
                false,
            )
        }
    };
    let apart = if known { groups_of(cgroup) } else { None };
    let now = boot_now();
    let plan = guard.plan(
        now,
        deadline,
        observed,
        apart.as_ref().map(|(_, groups, _)| groups.as_slice()),
        stopping,
    );
    let stops = |action: &Option<GuardAction>| {
        matches!(action, Some(GuardAction::Freeze | GuardAction::Kill))
    };
    // Before the VMs stop, the count says so.
    let stopping_vms = stops(&plan.vms) || plan.groups.iter().any(stops);
    if stopping_vms {
        saying.say(true);
    }
    // A kill episode ends once the lease is valid again: until then a VM
    // is recorded once, however many steps its kill takes and whatever a
    // step in between reads.
    if deadline > now {
        fencing.lease_valid();
    }
    let overdue = now.saturating_since(deadline);
    let (acted, groups_held) = act_on_groups(apart.as_ref(), &plan, fencing, overdue);
    let acted = Acted {
        vms: plan.vms,
        groups: acted,
    };
    if let Some(action) = plan.vms {
        let result = match action {
            GuardAction::Freeze => cgroup.set_frozen(true),
            GuardAction::Kill => kill_running(cgroup, fencing, overdue),
            // A group that could not ask for its own freeze stays held by
            // this one.
            GuardAction::Thaw if !groups_held => Err(io::Error::other(
                "a VM's group could not be frozen on its own, so the cgroup above stays frozen",
            )),
            GuardAction::Thaw => cgroup.set_frozen(false),
        };
        if let Err(error) = result {
            tracing::error!(?action, %error, "the guard could not act on the VMs");
        }
    }
    if *last != acted && acted != Acted::default() {
        // Ahead of the deadline, how long the lease had left; past it,
        // negative, how long it is overdue.
        let lease_left_ms =
            i128::from(nanos(deadline)).saturating_sub(i128::from(nanos(now))) / 1_000_000;
        let (freeze, kill, thaw) = acted.groups;
        tracing::warn!(action = ?acted.vms, groups_frozen = freeze, groups_killed = kill, groups_thawed = thaw, ?observed, %lease_left_ms, "guard acting on the VMs");
    }
    // Once they run again, it says that; otherwise it follows the freezer.
    // Either way it says the count again, at every step.
    let stopped = stopping_vms
        || match plan.vms {
            Some(GuardAction::Thaw) => !cgroup.freezer().is_ok_and(|state| !state.asked),
            _ => !known || observed.freezing || observed.frozen,
        }
        || apart.as_ref().is_some_and(|(children, groups, unknown)| {
            *unknown
                || children
                    .iter()
                    .zip(groups)
                    .zip(&plan.groups)
                    .any(|((child, group), action)| match action {
                        Some(GuardAction::Thaw) => !child.freezer().is_ok_and(|state| !state.asked),
                        _ => group.freezing,
                    })
        });
    saying.say(stopped);
    *last = acted;
    Stepped {
        feed: plan.feed,
        may_stop: plan.may_stop,
    }
}

/// Asks of each VM's group what `plan` says, recording in [`Fenced`] each
/// one it kills, `overdue` past the deadline. Returns how many it asked to
/// freeze, to kill and to thaw, and whether every freeze it asked for was
/// taken.
fn act_on_groups(
    apart: Option<&(Vec<Cgroup>, Vec<Group>, bool)>,
    plan: &Plan,
    fencing: &mut Fencing,
    overdue: Duration,
) -> ((usize, usize, usize), bool) {
    let Some((children, _, _)) = apart else {
        return ((0, 0, 0), true);
    };
    let (mut frozen, mut thawed, mut held) = (0, 0, true);
    let mut killing = Vec::new();
    for (child, action) in children.iter().zip(&plan.groups) {
        match action {
            Some(GuardAction::Freeze) => {
                frozen += 1;
                if let Err(error) = child.set_frozen(true) {
                    held = false;
                    tracing::error!(group = %name_of(child), %error, "the guard could not freeze a VM");
                }
            }
            Some(GuardAction::Thaw) => {
                thawed += 1;
                if let Err(error) = child.set_frozen(false) {
                    tracing::error!(group = %name_of(child), %error, "the guard could not thaw a VM");
                }
            }
            Some(GuardAction::Kill) => killing.push(child),
            None => {}
        }
    }
    if !killing.is_empty() {
        fencing.ending(
            killing.iter().map(|child| name_of(child)).collect(),
            overdue,
        );
        for child in &killing {
            if let Err(error) = child.kill_all() {
                tracing::error!(group = %name_of(child), %error, "the guard could not kill a VM");
            }
        }
    }
    ((frozen, killing.len(), thawed), held)
}

/// Kills the VMs that still run, `overdue` past the deadline: every group
/// inside the VMs' cgroup that is neither frozen nor empty. A VM that
/// froze stays frozen, to run on if the lease is renewed: one VM ending
/// while frozen (deleted, or its process killed) reads as not frozen, and
/// so makes the whole cgroup read so, until its memory is released, and
/// that must not end the others. Every process goes if any sits in the
/// cgroup itself, or what is inside cannot be read. Each VM is recorded
/// in [`Fenced`] before it is killed.
fn kill_running(cgroup: &Cgroup, fencing: &mut Fencing, overdue: Duration) -> std::io::Result<()> {
    let children = match (cgroup.processes(), cgroup.children()) {
        (Ok(own), Ok(children)) if own.is_empty() => children,
        _ => {
            fencing.ending(vec!["*".to_owned()], overdue);
            return cgroup.kill_all();
        }
    };
    let running: Vec<Cgroup> = children
        .into_iter()
        .filter(|child| {
            !child
                .freezer()
                .is_ok_and(|state| state.frozen || state.empty)
        })
        .collect();
    fencing.ending(running.iter().map(name_of).collect(), overdue);
    let mut result = Ok(());
    for child in running {
        if let Err(error) = child.kill_all() {
            result = Err(error);
        }
    }
    result
}

#[cfg(test)]
mod tests;
