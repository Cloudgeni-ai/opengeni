//! The null device every discarded stdio stream of a started process uses.
//!
//! `Stdio::null()` opens `/dev/null` by path at every spawn. A machine where
//! that path was deleted or replaced (one stray `rm -rf /dev/null` from an
//! agent running as root is enough) then failed every process start with
//! `ENOENT`, which surfaced as a misleading "not found" for the program being
//! started. The agent therefore opens the device once and hands each child a
//! duplicate of that retained handle, so a missing path can no longer stop it
//! from starting programs. On Linux, running as root, it also puts a missing or
//! replaced device back, because the commands it runs rely on `/dev/null` too.

use std::fs::File;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The null device's path on every Unix the agent supports.
pub(crate) const NULL_DEVICE_PATH: &str = "/dev/null";

/// What a path holds, compared with the null device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NullDeviceState {
    /// The path is the null character device.
    Healthy,
    /// Nothing exists at the path.
    Missing,
    /// Something other than the null device (a regular file a redirection
    /// created, a directory, another device) is at the path.
    Replaced,
}

/// Reads what `path` holds. A path that cannot be inspected for another
/// reason (permissions) is reported healthy: the agent only repairs what it
/// can see is wrong.
pub(crate) fn inspect(path: &Path) -> NullDeviceState {
    match std::fs::metadata(path) {
        Ok(meta) if is_null_device(&meta) => NullDeviceState::Healthy,
        Ok(_) => NullDeviceState::Replaced,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => NullDeviceState::Missing,
        Err(_) => NullDeviceState::Healthy,
    }
}

/// Whether `meta` describes the null character device. Linux pins its device
/// number (1, 3); elsewhere any character device at the path is accepted.
fn is_null_device(meta: &std::fs::Metadata) -> bool {
    if !meta.file_type().is_char_device() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        meta.rdev() == nix::sys::stat::makedev(1, 3)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// The handle opened while the device was healthy. `None` until an open
/// succeeds; later calls retry, so an agent that started without a usable
/// device picks one up once it is back.
static RETAINED: Mutex<Option<File>> = Mutex::new(None);
/// The first unhealthy observation is a warning; repeats are debug logs.
static WARNED: AtomicBool = AtomicBool::new(false);

/// Opens and retains the null device if that has not happened yet. Called when
/// the platform is built, so the handle exists before any command could remove
/// the path.
pub(crate) fn prime() {
    ensure_null_device();
    let mut retained = RETAINED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if retained.is_none() {
        *retained = open_null_device(Path::new(NULL_DEVICE_PATH));
    }
}

fn open_null_device(path: &Path) -> Option<File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    file.metadata().ok().filter(is_null_device).map(|_| file)
}

/// A stdio stream connected to the null device for a process about to start.
/// Checks the device first (one `stat`) and repairs it where allowed, then
/// hands out a duplicate of the retained handle. Falls back to
/// [`Stdio::null`] only when no handle could ever be opened.
pub(crate) fn null_stdio() -> Stdio {
    prime();
    let retained = RETAINED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    retained
        .as_ref()
        .and_then(|file| file.try_clone().ok())
        .map_or_else(Stdio::null, Stdio::from)
}

/// Checks `/dev/null` and, on Linux as root, puts it back when it is missing or
/// replaced. Never fails: a device it cannot repair is logged, and the
/// retained handle keeps the agent's own process starts working.
pub(crate) fn ensure_null_device() {
    let path = Path::new(NULL_DEVICE_PATH);
    let state = inspect(path);
    if state == NullDeviceState::Healthy {
        return;
    }
    let outcome = repair(path, state);
    if WARNED.swap(true, Ordering::Relaxed) {
        tracing::debug!(
            ?state,
            ?outcome,
            "the null device {NULL_DEVICE_PATH} was unhealthy again"
        );
    } else {
        tracing::warn!(
            ?state,
            ?outcome,
            "the null device {NULL_DEVICE_PATH} was missing or replaced; the agent keeps starting programs with its retained handle"
        );
    }
}

/// Serializes repairs, so concurrent process starts do not race each other.
static REPAIR: Mutex<()> = Mutex::new(());

/// The result of one repair attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RepairOutcome {
    /// The device is back at the path.
    Repaired,
    /// The device was not repaired, and why.
    NotRepaired(String),
}

#[cfg(target_os = "linux")]
fn repair(path: &Path, observed: NullDeviceState) -> RepairOutcome {
    use nix::sys::stat::{makedev, mknod, Mode, SFlag};
    use std::os::unix::fs::PermissionsExt;

    if !nix::unistd::geteuid().is_root() {
        return RepairOutcome::NotRepaired("the agent is not running as root".to_string());
    }
    let _guard = REPAIR
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Another start may have repaired it while this one waited.
    let state = inspect(path);
    if state == NullDeviceState::Healthy {
        return RepairOutcome::Repaired;
    }
    if state == NullDeviceState::Replaced || observed == NullDeviceState::Replaced {
        match std::fs::symlink_metadata(path) {
            // Never delete a directory someone made there: it may hold data.
            Ok(meta) if meta.is_dir() => {
                return RepairOutcome::NotRepaired("a directory is at the path".to_string());
            }
            Ok(_) => {
                if let Err(error) = std::fs::remove_file(path) {
                    return RepairOutcome::NotRepaired(format!("remove the replacement: {error}"));
                }
            }
            Err(_) => {}
        }
    }
    let created = mknod(
        path,
        SFlag::S_IFCHR,
        Mode::from_bits_truncate(0o666),
        makedev(1, 3),
    );
    match created {
        Ok(()) => {
            // mknod applies the umask; the device must be usable by every
            // user. Only the node made here is changed: something that raced
            // in at the path (a symlink) is never followed.
            if let Err(error) =
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))
            {
                return RepairOutcome::NotRepaired(format!("chmod: {error}"));
            }
        }
        Err(nix::errno::Errno::EEXIST) => {}
        Err(error) => return RepairOutcome::NotRepaired(format!("mknod: {error}")),
    }
    if inspect(path) == NullDeviceState::Healthy {
        RepairOutcome::Repaired
    } else {
        RepairOutcome::NotRepaired("the path still does not hold the null device".to_string())
    }
}

#[cfg(not(target_os = "linux"))]
fn repair(_path: &Path, _observed: NullDeviceState) -> RepairOutcome {
    RepairOutcome::NotRepaired("repair is only done on Linux".to_string())
}

/// A short note for a failed process start when the null device is the cause,
/// so the error names what is actually missing.
pub(crate) fn spawn_failure_note() -> Option<&'static str> {
    match inspect(Path::new(NULL_DEVICE_PATH)) {
        NullDeviceState::Healthy => None,
        NullDeviceState::Missing => Some("the null device /dev/null is missing"),
        NullDeviceState::Replaced => {
            Some("/dev/null has been replaced by something other than the null device")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_tells_the_device_from_a_missing_or_replaced_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            inspect(Path::new(NULL_DEVICE_PATH)),
            NullDeviceState::Healthy
        );
        assert_eq!(inspect(&dir.path().join("null")), NullDeviceState::Missing);
        let file = dir.path().join("file");
        std::fs::write(&file, b"redirected output").expect("write");
        assert_eq!(inspect(&file), NullDeviceState::Replaced);
        assert_eq!(inspect(dir.path()), NullDeviceState::Replaced);
    }

    #[test]
    fn the_retained_handle_is_the_null_device() {
        prime();
        let retained = RETAINED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let file = retained
            .as_ref()
            .expect("a healthy machine retains the device");
        assert!(is_null_device(&file.metadata().expect("metadata")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn repair_never_removes_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outcome = repair(dir.path(), NullDeviceState::Replaced);
        assert!(dir.path().is_dir());
        assert!(
            matches!(outcome, RepairOutcome::NotRepaired(_)),
            "{outcome:?}"
        );
    }

    /// Root only (`mknod` needs it): skipped, and says so, otherwise.
    #[cfg(target_os = "linux")]
    #[test]
    fn repair_puts_back_a_missing_or_replaced_device_as_root() {
        use std::os::unix::fs::PermissionsExt;
        if !nix::unistd::geteuid().is_root() {
            eprintln!("skipping: mknod needs root");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing");
        assert_eq!(
            repair(&missing, NullDeviceState::Missing),
            RepairOutcome::Repaired
        );
        assert_eq!(inspect(&missing), NullDeviceState::Healthy);
        let mode = std::fs::metadata(&missing)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o666, "{mode:o}");

        // What `> /dev/null` leaves once the device is gone: a regular file.
        let replaced = dir.path().join("replaced");
        std::fs::write(&replaced, b"redirected output").expect("write");
        assert_eq!(
            repair(&replaced, NullDeviceState::Replaced),
            RepairOutcome::Repaired
        );
        assert_eq!(inspect(&replaced), NullDeviceState::Healthy);
    }
}
