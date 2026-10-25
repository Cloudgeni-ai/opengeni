//! The guard process: steps [`compute_fleet::Guard`] every 100 ms against
//! the lease file and the VMs' cgroup, and holds the kernel watchdog.
//!
//! It runs as a service of its own (`compute-host guard`), in a cgroup of
//! its own, so it outlives the agent as the VMs do and is never frozen
//! with them. It holds an exclusive lock on its lock file while it runs,
//! so a second guard refuses to start, and a second lock ([`ready_lock`])
//! once its watchdog is armed and it has stepped once: the agent refuses
//! to join a fleet unless a guard holds that one. A guard that fails to
//! arm its watchdog never takes it.
//!
//! Beside its lock it keeps [`Freezes`], the count of what it did to the
//! VMs' freezer, for the agent's checks of its guests.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use compute_core::At;
use compute_engine::cgroup::Cgroup;
use compute_engine::watchdog::Watchdog;
use compute_fleet::{Guard, GuardAction, Observed};
use rustix::fs::{FlockOperation, flock};

use super::gate::boot_now;
use super::gate::nanos;
use super::record::LeaseFile;

/// How often the guard steps.
pub const STEP: Duration = Duration::from_millis(100);

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
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    flock(&file, FlockOperation::NonBlockingLockExclusive)
        .with_context(|| format!("another guard holds {}", path.display()))?;
    Ok(file)
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

/// Runs the guard until it fails to feed the watchdog, which then reboots
/// the machine; that is the point.
pub fn run_guard(config: &GuardConfig) -> anyhow::Result<()> {
    if let Some(dir) = config.lock.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let _lock = hold_lock(&config.lock)?;
    let mut watchdog = if let Some((device, timeout)) = &config.watchdog {
        Some(
            Watchdog::open(device, *timeout)
                .with_context(|| format!("opening the watchdog {}", device.display()))?,
        )
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
    tracing::info!(cgroup = %config.cgroup.display(), "guard running");
    loop {
        let step = step_once(&guard, &cgroup, config, &mut last, &mut saying);
        if step && let Some(watchdog) = &mut watchdog {
            watchdog.feed().context("feeding the watchdog")?;
        }
        if ready.is_none() {
            // Armed and stepped once: the VMs are guarded from here on.
            ready = Some(hold_lock(&ready_lock(&config.lock))?);
        }
        std::thread::sleep(STEP);
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
        assert!(run_guard(&broken).is_err());
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
        std::thread::spawn(move || run_guard(&working));
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
}
