//! The guard process: steps [`compute_fleet::Guard`] every 100 ms against
//! the lease file and the VMs' cgroup, and holds the kernel watchdog.
//!
//! It runs as a service of its own (`compute-host guard`), in a cgroup of
//! its own, so it outlives the agent as the VMs do and is never frozen
//! with them. It holds an exclusive lock on its lock file while it runs:
//! a second guard refuses to start, and the agent refuses to join a fleet
//! unless a guard holds it.

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

/// Whether a guard holds the lock at `path`.
pub fn guard_runs(path: &Path) -> io::Result<bool> {
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
    let mut last = None;
    tracing::info!(cgroup = %config.cgroup.display(), "guard running");
    loop {
        let step = step_once(&guard, &cgroup, config, &mut last);
        if step && let Some(watchdog) = &mut watchdog {
            watchdog.feed().context("feeding the watchdog")?;
        }
        std::thread::sleep(STEP);
    }
}

/// One step: acts on the kernel and returns whether to feed the watchdog.
fn step_once(
    guard: &Guard,
    cgroup: &Cgroup,
    config: &GuardConfig,
    last: &mut Option<GuardAction>,
) -> bool {
    // A file it cannot read holds no lease it can trust.
    let deadline = LeaseFile::read(&config.lease_file).map_or(At::ZERO, LeaseFile::deadline);
    let suspending = config.suspending.exists();
    let observed = match cgroup.freezer() {
        Ok(freezer) => Observed {
            freezing: freezer.asked,
            frozen: freezer.frozen,
            empty: freezer.empty,
            suspending,
        },
        Err(error) => {
            tracing::warn!(%error, "reading the VMs' freezer failed");
            Observed {
                suspending,
                ..Observed::default()
            }
        }
    };
    let step = guard.step(boot_now(), deadline, observed);
    if let Some(action) = step.action {
        let result = match action {
            GuardAction::Freeze => cgroup.set_frozen(true),
            GuardAction::Kill => cgroup.kill_all(),
            GuardAction::Thaw => cgroup.set_frozen(false),
        };
        if *last != Some(action) {
            tracing::warn!(?action, ?observed, "guard acting on the VMs");
        }
        if let Err(error) = result {
            tracing::error!(?action, %error, "the guard could not act on the VMs");
        }
    }
    *last = step.action;
    step.feed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_guard_at_a_time_and_the_agent_sees_it() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("guard.lock");
        assert!(!guard_runs(&lock).unwrap(), "no lock file, no guard");
        let held = hold_lock(&lock).unwrap();
        assert!(guard_runs(&lock).unwrap());
        assert!(hold_lock(&lock).is_err(), "a second guard refuses");
        drop(held);
        assert!(!guard_runs(&lock).unwrap());
    }
}
