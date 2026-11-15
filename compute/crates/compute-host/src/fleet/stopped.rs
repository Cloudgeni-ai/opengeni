//! Whether the agent's previous run stopped because it was asked to.
//!
//! A run the service manager asks to stop (a signal, as an upgrade, a
//! restart or a planned reboot sends) leaves a mark in the host's root
//! once its stop is done; the next run takes the mark when it starts and
//! tells the service ([`Capacity::after_asked_stop`]). A run that never
//! got to leave it crashed, was stopped by its watchdog, hung in its stop
//! or lost its machine, and the service counts only those restarts as
//! faults.
//!
//! [`Capacity::after_asked_stop`]: compute_protocol::fleet::Capacity::after_asked_stop

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The mark's name in the host's root.
const MARK: &str = "agent-stopped-when-asked";

static AFTER_ASKED_STOP: OnceLock<bool> = OnceLock::new();

fn mark(root: &Path) -> PathBuf {
    root.join(MARK)
}

/// Takes the mark the previous run left in `root`, once, when this run
/// starts: whether that run stopped because it was asked to. Later calls
/// answer what the first found.
pub fn take_mark(root: &Path) -> bool {
    *AFTER_ASKED_STOP.get_or_init(|| take(root))
}

fn take(root: &Path) -> bool {
    let path = mark(root);
    match std::fs::remove_file(&path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            // Left in place, it would make the next run's start look asked
            // for as well, whatever stopped this one.
            tracing::warn!(path = %path.display(), %error, "could not take the previous run's stop mark");
            false
        }
    }
}

/// Whether the previous run stopped because it was asked to, as
/// [`take_mark`] found when this run started; `false` before it is called.
#[must_use]
pub fn after_asked_stop() -> bool {
    AFTER_ASKED_STOP.get().copied().unwrap_or(false)
}

/// Leaves the mark in `root` for the next run: this run was asked to stop
/// and its stop is done. Written through to the disk, so a reboot that
/// follows finds it.
pub fn leave_mark(root: &Path) {
    let path = mark(root);
    if let Err(error) = std::fs::File::create(&path).and_then(|file| file.sync_all()) {
        tracing::warn!(path = %path.display(), %error, "could not leave the stop mark: the next start counts as a fault");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mark left by one run is found by the next, and only by it: the
    /// run after that, with no mark, started after a fault.
    #[test]
    fn a_mark_is_taken_once() {
        let root = tempfile::tempdir().unwrap();
        assert!(!take(root.path()), "a first run, or one after a crash");
        leave_mark(root.path());
        assert!(take(root.path()), "the run after an asked stop");
        assert!(!take(root.path()), "the run after that one");
    }
}
