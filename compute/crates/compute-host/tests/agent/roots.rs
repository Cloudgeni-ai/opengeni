//! Lab roots. Unix socket paths are short, so a root sits directly under a
//! short directory, and it outlives the labs on it: a restarted agent takes
//! its root back, and agents keep running as background tasks until their
//! test's runtime ends. So this process owns its roots and removes all of
//! them when it exits, whether its tests passed or failed. A process that is
//! killed cannot, so the first root made in a directory removes the roots
//! there whose process is gone.

use std::os::raw::c_int;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, Once, PoisonError, TryLockError};

use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};

/// Roots are named `ch-<process id>-<n>`.
const PREFIX: &str = "ch-";

static MADE: Mutex<Made> = Mutex::new(Made {
    roots: Vec::new(),
    swept: Vec::new(),
});
static NEXT: AtomicUsize = AtomicUsize::new(0);
static AT_EXIT: Once = Once::new();

/// The roots this process made, and the directories it has swept.
struct Made {
    roots: Vec<PathBuf>,
    swept: Vec<PathBuf>,
}

unsafe extern "C" {
    fn atexit(callback: extern "C" fn()) -> c_int;
}

/// A new empty root directly under `dir`, removed when this process exits.
pub(crate) fn make(dir: &Path) -> PathBuf {
    AT_EXIT.call_once(|| {
        // SAFETY: `remove_made` takes no arguments, touches only statics and
        // cannot unwind (a panic in an `extern "C"` function aborts).
        assert_eq!(unsafe { atexit(remove_made) }, 0, "atexit refused");
    });
    let mut made = MADE.lock().unwrap_or_else(PoisonError::into_inner);
    if !made.swept.iter().any(|swept| swept == dir) {
        remove_orphans(dir);
        made.swept.push(dir.to_owned());
    }
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = dir.join(format!("{PREFIX}{}-{n}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    made.roots.push(root.clone());
    root
}

extern "C" fn remove_made() {
    // A test still making a root as the process exits keeps the lock; its
    // roots are then left for the next run to sweep.
    let mut made = match MADE.try_lock() {
        Ok(made) => made,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    for root in std::mem::take(&mut made.roots) {
        remove(&root);
    }
}

/// Removes `root`, first making writable again any directory in it that a
/// test left read-only to make a removal fail, as one that panicked or was
/// killed before undoing it does.
fn remove(root: &Path) {
    if std::fs::remove_dir_all(root).is_ok() || !root.exists() {
        return;
    }
    open_up(root);
    let _ = std::fs::remove_dir_all(root);
}

/// Gives the owner full access to `dir` and every directory below it,
/// without following symbolic links.
fn open_up(dir: &Path) {
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            open_up(&entry.path());
        }
    }
}

/// Removes the roots under `dir` that no running process owns: those of a
/// process that is gone, and any an earlier process left with this one's id,
/// since this one has made none there yet.
fn remove_orphans(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let me = std::process::id();
    for entry in entries.flatten() {
        let Some(owner) = entry.file_name().to_str().and_then(owner) else {
            continue;
        };
        if owner == me || !running(owner) {
            remove(&entry.path());
        }
    }
}

/// The process id in a root's name.
fn owner(name: &str) -> Option<u32> {
    let (pid, n) = name.strip_prefix(PREFIX)?.split_once('-')?;
    n.parse::<usize>().ok()?;
    pid.parse().ok()
}

fn running(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    // Signal 0 only checks that the process exists; EPERM means it does,
    // under another user.
    matches!(test_kill_process(pid), Ok(()) | Err(Errno::PERM))
}

#[test]
fn only_lab_roots_have_an_owner() {
    assert_eq!(owner("ch-1234-0"), Some(1234));
    assert_eq!(owner("ch-1234-17"), Some(1234));
    for name in [
        "ch-1234",
        "ch-1234-",
        "ch-x-1",
        "ch-1-x",
        "chr-1-1",
        "ch--1",
        "notch-1-1",
    ] {
        assert_eq!(owner(name), None, "{name}");
    }
}

/// A root of a process that is gone is removed by the next process's first
/// root in the same directory, even with a read-only directory left in it;
/// a running process's root is kept.
#[test]
fn the_first_root_in_a_directory_removes_those_whose_process_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    // Process ids stay below pid_max, so none has this one.
    let gone: u32 = std::fs::read_to_string("/proc/sys/kernel/pid_max")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(!running(gone));
    let orphan = dir.path().join(format!("{PREFIX}{gone}-0"));
    let init = dir.path().join("ch-1-0");
    let mine = dir
        .path()
        .join(format!("{PREFIX}{}-9999", std::process::id()));
    let other = dir.path().join("ch-other");
    for made in [&orphan, &init, &mine, &other] {
        std::fs::create_dir(made).unwrap();
        std::fs::write(made.join("base.img"), "base").unwrap();
    }
    let frozen = orphan.join("state/stuck");
    std::fs::create_dir_all(&frozen).unwrap();
    std::fs::write(frozen.join("file"), "").unwrap();
    std::fs::set_permissions(&frozen, std::fs::Permissions::from_mode(0o555)).unwrap();
    let root = make(dir.path());
    assert!(root.is_dir());
    assert!(!orphan.exists(), "a gone process's root was kept");
    assert!(
        !mine.exists(),
        "an earlier process's root with this id was kept"
    );
    assert!(init.is_dir(), "init's root was removed");
    assert!(other.is_dir(), "a directory that is no root was removed");
    // Swept once: a later root leaves the directory as it is.
    let later = dir.path().join(format!("{PREFIX}{gone}-1"));
    std::fs::create_dir(&later).unwrap();
    make(dir.path());
    assert!(later.is_dir());
}
