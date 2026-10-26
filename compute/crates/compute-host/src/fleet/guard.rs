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
//! VMs' freezer, for the agent's checks of its guests.
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
use compute_engine::cgroup::Cgroup;
use compute_engine::watchdog::Watchdog;
use compute_fleet::{Guard, GuardAction, Observed};
use rustix::fs::{FlockOperation, flock};

use super::gate::boot_now;
use super::gate::nanos;
use super::kept;
use super::record::LeaseFile;

/// How often the guard steps.
pub const STEP: Duration = Duration::from_millis(100);

/// How often a guard whose watchdog systemd does not keep yet asks again.
const KEEP_AGAIN: Duration = Duration::from_secs(1);

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
    /// The watchdog device and its timeout; `None` runs without one, which
    /// leaves a stalled guard unchecked (tests only).
    pub watchdog: Option<(PathBuf, Duration)>,
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
    let mut watchdog = if let Some((device, timeout)) = &config.watchdog {
        let kept = kept::kept(device, *timeout).with_context(|| {
            format!("taking over the watchdog {} systemd kept", device.display())
        })?;
        if kept.is_some() {
            tracing::info!("took over the watchdog systemd kept");
        }
        kept
    } else {
        tracing::warn!("no watchdog: a stalled guard leaves VMs running past their lease");
        None
    };
    let cgroup = Cgroup::at(&config.cgroup);
    let guard = Guard::new();
    let mut saying = Saying::new(Freezes::beside(&config.lock));
    saying.say(true);
    let mut last = None;
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
        let feed = step_once(&guard, &cgroup, config, &mut last, &mut saying);
        if feed {
            if watchdog.is_none()
                && let Some((device, timeout)) = &config.watchdog
            {
                watchdog = Some(
                    Watchdog::open(device, *timeout)
                        .with_context(|| format!("opening the watchdog {}", device.display()))?,
                );
            }
            if let Some(watchdog) = &mut watchdog {
                watchdog.feed().context("feeding the watchdog")?;
            }
        }
        if let Some(watchdog) = &watchdog
            && !kept_open
        {
            kept_open = keeping.kept(watchdog.as_fd(), socket.as_deref());
        }
        if ready.is_none() && (kept_open || config.watchdog.is_none()) {
            // Armed and stepped once: the VMs are guarded from here on. A
            // look at whether a guard is ready (the agent's, at its start)
            // holds the lock for a moment; then it is taken a step later.
            ready = try_hold_lock(&ready_lock(&config.lock))?;
        }
        if stop.load(Ordering::Relaxed) {
            // systemd keeps the watchdog open; one it does not keep is
            // closed now, which feeds it as this step just did. The lock
            // goes last, so the next guard opens the watchdog only once
            // this one has closed it.
            if feed {
                tracing::info!("guard stopping");
                return Ok(());
            }
            if !waiting {
                tracing::warn!(
                    "asked to stop with the lease run out and the VMs running: stopping them first"
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

/// One step: acts on the kernel, says the freeze count, and returns
/// whether to feed the watchdog.
fn step_once(
    guard: &Guard,
    cgroup: &Cgroup,
    config: &GuardConfig,
    last: &mut Option<GuardAction>,
    saying: &mut Saying,
) -> bool {
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
    let step = guard.step(boot_now(), deadline, observed);
    // Before the VMs stop, the count says so.
    if matches!(step.action, Some(GuardAction::Freeze | GuardAction::Kill)) {
        saying.say(true);
    }
    if let Some(action) = step.action {
        let result = match action {
            GuardAction::Freeze => cgroup.set_frozen(true),
            GuardAction::Kill => kill_running(cgroup),
            GuardAction::Thaw => cgroup.set_frozen(false),
        };
        if *last != Some(action) {
            tracing::warn!(?action, ?observed, "guard acting on the VMs");
        }
        if let Err(error) = result {
            tracing::error!(?action, %error, "the guard could not act on the VMs");
        }
    }
    // Once they run again, it says that; otherwise it follows the freezer.
    // Either way it says the count again, at every step.
    let stopped = match step.action {
        Some(GuardAction::Freeze | GuardAction::Kill) => true,
        Some(GuardAction::Thaw) => !cgroup.freezer().is_ok_and(|state| !state.asked),
        None => !known || observed.freezing || observed.frozen,
    };
    saying.say(stopped);
    *last = step.action;
    step.feed
}

/// Kills the VMs that still run: every group inside the VMs' cgroup that
/// is neither frozen nor empty. A VM that froze stays frozen, to run on if
/// the lease is renewed: one VM ending while frozen (deleted, or its
/// process killed) reads as not frozen, and so makes the whole cgroup
/// read so, until its memory is released, and that must not end the
/// others. Every process goes if any sits in the cgroup itself, or what
/// is inside cannot be read.
fn kill_running(cgroup: &Cgroup) -> std::io::Result<()> {
    let children = match (cgroup.processes(), cgroup.children()) {
        (Ok(own), Ok(children)) if own.is_empty() => children,
        _ => return cgroup.kill_all(),
    };
    let mut result = Ok(());
    for child in children {
        let stopped = child
            .freezer()
            .is_ok_and(|state| state.frozen || state.empty);
        if !stopped && let Err(error) = child.kill_all() {
            result = Err(error);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_guard_at_a_time_and_the_agent_sees_it() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("guard.lock");
        assert_eq!(ready_lock(&lock), dir.path().join("guard.lock.ready"));
        assert!(!held(&lock).unwrap(), "no lock file, no guard");
        let one = hold_lock(&lock).unwrap();
        assert!(held(&lock).unwrap());
        assert!(hold_lock(&lock).is_err(), "a second guard refuses");
        assert!(!guard_ready(&lock).unwrap(), "running is not yet guarding");
        drop(one);
        // A process another test starts at that moment holds a copy of the
        // lock's descriptor until it runs its program, so it may take that
        // long.
        let until = Instant::now() + Duration::from_secs(2);
        while held(&lock).unwrap() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!held(&lock).unwrap());
    }

    /// The count is odd exactly while the VMs may not run, moves only when
    /// that changes, is said again at every step, and vouches for nothing
    /// once damaged.
    #[test]
    fn the_freeze_count_is_odd_while_the_vms_may_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let freezes = Freezes::beside(&dir.path().join("guard.lock"));
        assert_eq!(freezes.path, dir.path().join("guard.lock.freezes"));
        assert_eq!(freezes.read(), None, "no count, nothing vouched for");
        let mut saying = Saying::new(freezes.clone());
        let count = |freezes: &Freezes| freezes.read().map(|said| said.count);
        saying.say(true);
        assert_eq!(count(&freezes), Some(1), "a guard starts odd");
        saying.say(false);
        assert_eq!(count(&freezes), Some(2));
        let said = freezes.read().unwrap();
        assert_eq!(said.guard, saying.guard);
        std::thread::sleep(Duration::from_millis(2));
        saying.say(false);
        let again = freezes.read().unwrap();
        assert_eq!(again.count, 2, "already even");
        assert!(again.at > said.at, "said again, later");
        saying.say(true);
        assert_eq!(count(&freezes), Some(3));
        saying.say(true);
        assert_eq!(count(&freezes), Some(3), "still frozen");
        saying.say(false);
        assert_eq!(count(&freezes), Some(4));
        std::fs::write(&freezes.path, "1 4x 9").unwrap();
        assert_eq!(freezes.read(), None);
        std::fs::write(&freezes.path, "4\n").unwrap();
        assert_eq!(freezes.read(), None, "a count without its guard and time");
        std::fs::write(&freezes.path, "1 4 9 9").unwrap();
        assert_eq!(freezes.read(), None);
    }

    /// A guard whose count cannot be written still freezes the VMs, and
    /// says nothing: what it said before stays, with the time it said it,
    /// so it vouches for nothing after the freeze. Its first step that can
    /// write says the count again, moved on past the freeze, without
    /// waiting for the freezer to change.
    #[test]
    fn a_count_the_guard_cannot_write_is_not_said() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("vms");
        std::fs::create_dir(&group).unwrap();
        std::fs::write(group.join("cgroup.freeze"), "0").unwrap();
        std::fs::write(group.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        let mut config = config(dir.path(), None);
        config.cgroup = group.clone();
        LeaseFile {
            host: Some(1),
            epoch: Some(1),
            deadline_ns: nanos(boot_now() + Duration::from_secs(600)),
            seq: 1,
        }
        .write(&config.lease_file)
        .unwrap();
        let (guard, cgroup) = (Guard::new(), Cgroup::at(&group));
        let freezes = Freezes::beside(&config.lock);
        let mut saying = Saying::new(freezes.clone());
        let mut last = None;
        let mut step = |saying: &mut Saying| {
            assert!(step_once(&guard, &cgroup, &config, &mut last, saying));
        };
        step(&mut saying);
        let running = freezes.read().unwrap();
        assert_eq!(running.count, 2, "running");

        // Nothing can be written there now, and a suspend is prepared.
        let staging = freezes.path.with_extension("freezes.staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(&config.suspending, "").unwrap();
        step(&mut saying);
        let frozen = |group: &Path| std::fs::read_to_string(group.join("cgroup.freeze")).unwrap();
        assert_eq!(frozen(&group), "1", "it froze them all the same");
        assert_eq!(freezes.read(), Some(running), "and said nothing");
        for _ in 0..3 {
            step(&mut saying);
        }
        assert_eq!(freezes.read(), Some(running), "nor at its next steps");

        // It can write again: its next step says the count, moved on.
        std::fs::remove_dir(&staging).unwrap();
        step(&mut saying);
        let said = freezes.read().unwrap();
        assert_eq!((said.guard, said.count), (running.guard, 3));
        assert!(said.at > running.at);

        // The suspend is over: it thaws them and says so.
        std::fs::remove_file(&config.suspending).unwrap();
        step(&mut saying);
        assert_eq!(frozen(&group), "0");
        assert_eq!(freezes.read().unwrap().count, 4);
    }

    fn config(dir: &Path, watchdog: Option<(PathBuf, Duration)>) -> GuardConfig {
        GuardConfig {
            cgroup: dir.join("no-cgroup"),
            lease_file: dir.join("lease.json"),
            lock: dir.join("guard.lock"),
            suspending: dir.join("suspending"),
            watchdog,
        }
    }

    /// Past the deadline the guard kills only the VMs that still run. One
    /// that is ending while frozen (deleted, or its process killed) reads
    /// as not frozen until its memory is released, and so makes the whole
    /// cgroup read so: the frozen ones stay frozen all the same, to run on
    /// if the lease is renewed.
    #[test]
    fn past_the_deadline_only_the_vms_still_running_are_killed() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("vms");
        let mut config = config(dir.path(), None);
        config.cgroup = group.clone();
        LeaseFile {
            host: Some(1),
            epoch: Some(1),
            deadline_ns: 1,
            seq: 1,
        }
        .write(&config.lease_file)
        .unwrap();
        let set = |path: &Path, freeze: &str, events: &str| {
            std::fs::create_dir_all(path).unwrap();
            std::fs::write(path.join("cgroup.freeze"), freeze).unwrap();
            std::fs::write(path.join("cgroup.events"), events).unwrap();
            std::fs::write(path.join("cgroup.procs"), "").unwrap();
        };
        set(&group, "1", "populated 1\nfrozen 0\n");
        set(&group.join("ending"), "0", "populated 1\nfrozen 0\n");
        set(&group.join("frozen"), "0", "populated 1\nfrozen 1\n");
        set(&group.join("gone"), "0", "populated 0\nfrozen 1\n");
        let killed = |path: &Path| path.join("cgroup.kill").exists();
        let (guard, cgroup) = (Guard::new(), Cgroup::at(&group));
        let mut saying = Saying::new(Freezes::beside(&config.lock));
        let mut last = None;
        let feed = step_once(&guard, &cgroup, &config, &mut last, &mut saying);
        assert_eq!(last, Some(GuardAction::Kill));
        assert!(!feed, "not every VM is known to be stopped yet");
        assert!(killed(&group.join("ending")), "the one still running");
        assert!(!killed(&group.join("frozen")), "a frozen VM stays frozen");
        assert!(!killed(&group.join("gone")));
        assert!(!killed(&group));

        // A process in the VMs' cgroup itself: everything goes.
        std::fs::write(group.join("cgroup.procs"), "4242\n").unwrap();
        assert!(!step_once(&guard, &cgroup, &config, &mut last, &mut saying));
        assert!(killed(&group));
    }

    /// A guard whose watchdog cannot be armed exits without ever looking
    /// ready, while one that guards does.
    #[test]
    fn a_guard_is_ready_only_once_its_watchdog_is_armed() {
        let dir = tempfile::tempdir().unwrap();
        let broken = config(
            dir.path(),
            Some((dir.path().join("no-watchdog"), Duration::from_secs(3))),
        );
        let watcher = {
            let lock = broken.lock.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                while started.elapsed() < Duration::from_millis(300) {
                    assert!(!guard_ready(&lock).unwrap(), "ready before armed");
                }
            })
        };
        assert!(run_guard(&broken, &AtomicBool::new(false)).is_err());
        watcher.join().unwrap();
        assert!(!guard_ready(&broken.lock).unwrap());
        assert!(!held(&broken.lock).unwrap(), "its lock went with it");

        let mut working = config(dir.path(), None);
        // A freezer it cannot read: a file where the group should be.
        working.cgroup = dir.path().join("not-a-group");
        std::fs::write(&working.cgroup, "").unwrap();
        let lock = working.lock.clone();
        // An earlier guard's count: this one says its own, odd, and stays
        // odd while it cannot read the freezer, saying so at every step.
        Freezes::beside(&lock).say(1, 6).unwrap();
        let earlier = Freezes::beside(&lock).read().unwrap();
        std::thread::spawn(move || run_guard(&working, &AtomicBool::new(false)));
        let started = std::time::Instant::now();
        while !guard_ready(&lock).unwrap() {
            assert!(started.elapsed() < Duration::from_secs(5), "never ready");
            std::thread::sleep(Duration::from_millis(10));
        }
        let first = Freezes::beside(&lock).read().unwrap();
        assert_ne!(first.guard, earlier.guard);
        assert_eq!(first.count, 1);
        std::thread::sleep(STEP * 3);
        let later = Freezes::beside(&lock).read().unwrap();
        assert_eq!((later.guard, later.count), (first.guard, 1));
        assert!(later.at > first.at, "said again at its steps");
    }

    /// A look at whether a guard is ready (the agent's, as it starts with
    /// the guard after an upgrade) holds the ready lock for a moment. A
    /// guard taking the lock just then runs on and takes it a step later,
    /// rather than ending, which the watchdog would answer with a reset.
    #[test]
    fn a_look_at_whether_the_guard_is_ready_does_not_end_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut working = config(dir.path(), None);
        working.cgroup = dir.path().join("not-a-group");
        std::fs::write(&working.cgroup, "").unwrap();
        let lock = working.lock.clone();
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        // One look, held for longer than a moment.
        let watcher = File::create(ready_lock(&lock)).unwrap();
        flock(&watcher, FlockOperation::NonBlockingLockShared).unwrap();
        let guard = std::thread::spawn(move || run_guard(&working, &AtomicBool::new(false)));
        std::thread::sleep(STEP * 3);
        assert!(!guard.is_finished(), "the guard runs on");
        assert!(!guard_ready(&lock).unwrap(), "not ready while looked at");
        drop(watcher);
        let started = std::time::Instant::now();
        while !guard_ready(&lock).unwrap() {
            assert!(started.elapsed() < Duration::from_secs(5), "never ready");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!guard.is_finished());
    }

    /// Asked to stop with its lease run out and the VMs still running, a
    /// guard goes on killing them and stops only once they are gone, at a
    /// step that may feed the watchdog, as closing it does. With a lease
    /// that is valid it stops at its first step.
    #[test]
    fn a_guard_asked_to_stop_stops_only_at_a_step_that_may_feed_the_watchdog() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("vms");
        std::fs::create_dir(&group).unwrap();
        std::fs::write(group.join("cgroup.freeze"), "0").unwrap();
        let events = group.join("cgroup.events");
        std::fs::write(&events, "populated 1\nfrozen 0\n").unwrap();
        let mut lapsed = config(dir.path(), None);
        lapsed.cgroup = group.clone();
        // No lease file: the lease has run out.
        let valid = lapsed.clone();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let guard = {
            let stop = std::sync::Arc::clone(&stop);
            std::thread::spawn(move || run_guard(&lapsed, &stop))
        };
        let started = std::time::Instant::now();
        while !guard_ready(&valid.lock).unwrap() {
            assert!(started.elapsed() < Duration::from_secs(5), "never ready");
            std::thread::sleep(Duration::from_millis(10));
        }
        stop.store(true, Ordering::Relaxed);
        std::thread::sleep(STEP * 5);
        assert!(!guard.is_finished(), "it stopped with the VMs running");
        assert_eq!(
            std::fs::read_to_string(group.join("cgroup.kill")).unwrap(),
            "1",
            "it goes on killing them"
        );
        // They are gone: it may feed the watchdog, and stops.
        std::fs::write(&events, "populated 0\nfrozen 0\n").unwrap();
        let started = std::time::Instant::now();
        while !guard.is_finished() {
            assert!(started.elapsed() < Duration::from_secs(5), "never stopped");
            std::thread::sleep(Duration::from_millis(10));
        }
        guard.join().unwrap().unwrap();
        assert!(!held(&valid.lock).unwrap(), "its lock went with it");

        std::fs::write(&events, "populated 1\nfrozen 0\n").unwrap();
        LeaseFile {
            host: Some(1),
            epoch: Some(1),
            deadline_ns: nanos(boot_now() + Duration::from_secs(600)),
            seq: 1,
        }
        .write(&valid.lease_file)
        .unwrap();
        let started = std::time::Instant::now();
        run_guard(&valid, &AtomicBool::new(true)).unwrap();
        assert!(
            started.elapsed() < STEP * 5,
            "a valid lease, it stops at once"
        );
    }

    /// A stand-in for systemd's notification socket, as systemd 255
    /// deals with it: it keeps a descriptor it is asked to keep if it
    /// `keeps`; one it refuses it holds on, `closing` long, and closes
    /// later, from another thread, after it went on to the messages after
    /// it; a barrier's it closes as it deals with it.
    struct Systemd {
        socket: PathBuf,
        /// What it keeps in the store.
        store: Arc<std::sync::Mutex<Vec<std::os::fd::OwnedFd>>>,
        /// What it refused and has yet to close.
        closing: Arc<std::sync::Mutex<Vec<std::os::fd::OwnedFd>>>,
        /// How many times it was asked to keep a descriptor.
        asked: Arc<std::sync::atomic::AtomicUsize>,
        done: Arc<AtomicBool>,
    }

    impl Systemd {
        fn start(socket: PathBuf, keeps: bool, closing: Duration) -> Self {
            use std::io::IoSliceMut;
            use std::mem::MaybeUninit;

            use rustix::net::{RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, recvmsg};

            let notifications = std::os::unix::net::UnixDatagram::bind(&socket).unwrap();
            notifications
                .set_read_timeout(Some(Duration::from_millis(20)))
                .unwrap();
            let systemd = Self {
                socket,
                store: Arc::default(),
                closing: Arc::default(),
                asked: Arc::default(),
                done: Arc::default(),
            };
            let (store, refused, asked, done) = (
                Arc::clone(&systemd.store),
                Arc::clone(&systemd.closing),
                Arc::clone(&systemd.asked),
                Arc::clone(&systemd.done),
            );
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    let mut text = [0_u8; 256];
                    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
                    let mut control = RecvAncillaryBuffer::new(&mut space);
                    let Ok(received) = recvmsg(
                        &notifications,
                        &mut [IoSliceMut::new(&mut text)],
                        &mut control,
                        RecvFlags::empty(),
                    ) else {
                        continue;
                    };
                    let fds: Vec<std::os::fd::OwnedFd> = control
                        .drain()
                        .filter_map(|message| match message {
                            RecvAncillaryMessage::ScmRights(fds) => Some(fds),
                            _ => None,
                        })
                        .flatten()
                        .collect();
                    if !text[..received.bytes].starts_with(b"FDSTORE=1\n") {
                        drop(fds);
                        continue;
                    }
                    asked.fetch_add(1, Ordering::Relaxed);
                    if keeps {
                        store.lock().unwrap().extend(fds);
                        continue;
                    }
                    let count = fds.len();
                    refused.lock().unwrap().extend(fds);
                    let refused = Arc::clone(&refused);
                    std::thread::spawn(move || {
                        std::thread::sleep(closing);
                        let mut held = refused.lock().unwrap();
                        let closed = count.min(held.len());
                        held.drain(..closed);
                    });
                }
            });
            systemd
        }

        fn socket(&self) -> Option<&str> {
            self.socket.to_str()
        }

        /// How the guard lists the store: what it keeps, not what it holds.
        fn list(&self) -> ListStore {
            let store = Arc::clone(&self.store);
            Arc::new(move |identity| {
                Ok(store
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|kept| kept::Identity::of(kept.as_fd()).unwrap() == identity))
            })
        }

        /// Whether it holds a file it refused, `fd`'s, yet to close it.
        fn closing(&self, fd: BorrowedFd<'_>) -> bool {
            let identity = kept::Identity::of(fd).unwrap();
            self.closing
                .lock()
                .unwrap()
                .iter()
                .any(|held| kept::Identity::of(held.as_fd()).unwrap() == identity)
        }
    }

    impl Drop for Systemd {
        fn drop(&mut self) {
            self.done.store(true, Ordering::Relaxed);
        }
    }

    /// Steps `keeping` every 20 ms for `within`, or until it sees the
    /// watchdog `device` kept; with `each` called on every step.
    fn keep_for(
        keeping: &mut Keeping,
        device: &File,
        socket: Option<&str>,
        within: Duration,
        mut each: impl FnMut(),
    ) -> bool {
        let until = Instant::now() + within;
        while Instant::now() < until {
            if keeping.kept(device.as_fd(), socket) {
                return true;
            }
            each();
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// A guard is ready only once systemd lists the watchdog in the
    /// service's store: not when systemd refuses it, though it still holds
    /// it after it dealt with the request, nor outside systemd, nor while
    /// it cannot list the store.
    #[test]
    fn a_guard_is_ready_only_once_systemd_lists_its_watchdog_in_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let device = File::create(dir.path().join("device")).unwrap();

        // systemd refuses it, and closes it only well after it went on.
        let systemd = Systemd::start(
            dir.path().join("refusing"),
            false,
            Duration::from_millis(900),
        );
        let mut keeping = Keeping::new(false, systemd.list());
        let mut seen_closing = false;
        let kept = keep_for(
            &mut keeping,
            &device,
            systemd.socket(),
            Duration::from_millis(1600),
            || seen_closing |= systemd.closing(device.as_fd()),
        );
        assert!(!kept, "systemd does not keep it");
        assert!(seen_closing, "systemd held it after it refused it");
        assert!(keeping.told);
        assert!(systemd.asked.load(Ordering::Relaxed) >= 2, "asked again");

        // systemd keeps it.
        let systemd = Systemd::start(dir.path().join("keeping"), true, Duration::ZERO);
        let mut keeping = Keeping::new(false, systemd.list());
        let socket = systemd.socket();
        assert!(keep_for(
            &mut keeping,
            &device,
            socket,
            Duration::from_secs(2),
            || {}
        ));
        assert!(!keeping.told);

        // Taken over from the store, it is kept there already: the guard
        // sends the barrier alone, not a second copy systemd would refuse.
        let systemd = Systemd::start(dir.path().join("taken-over"), true, Duration::ZERO);
        systemd
            .store
            .lock()
            .unwrap()
            .push(device.try_clone().unwrap().into());
        let mut keeping = Keeping::new(true, systemd.list());
        let socket = systemd.socket();
        assert!(keep_for(
            &mut keeping,
            &device,
            socket,
            Duration::from_secs(2),
            || {}
        ));
        assert_eq!(systemd.asked.load(Ordering::Relaxed), 0, "not asked again");
        assert_eq!(systemd.store.lock().unwrap().len(), 1);

        // The store cannot be listed: it is listed again, and systemd not
        // asked again to keep what it may keep already.
        let systemd = Systemd::start(dir.path().join("unlisted"), true, Duration::ZERO);
        let listed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counting = Arc::clone(&listed);
        let mut keeping = Keeping::new(
            false,
            Arc::new(move |_| {
                counting.fetch_add(1, Ordering::Relaxed);
                Err(io::Error::other("no systemd-analyze"))
            }),
        );
        let socket = systemd.socket();
        assert!(!keep_for(
            &mut keeping,
            &device,
            socket,
            Duration::from_millis(2500),
            || {}
        ));
        assert!(keeping.told);
        assert_eq!(systemd.asked.load(Ordering::Relaxed), 1, "asked once");
        assert!(listed.load(Ordering::Relaxed) >= 2, "listed again");

        // Not run by systemd.
        let mut keeping = Keeping::new(false, Arc::new(|_| Ok(true)));
        assert!(!keeping.kept(device.as_fd(), None));
        assert!(keeping.told);
    }
}
