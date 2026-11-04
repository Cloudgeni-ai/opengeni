//! The POSIX shell every shell command, and every exec's containment anchor,
//! starts through.
//!
//! The agent starts `/bin/sh` for each command. A machine where that path was
//! moved or deleted (one `mv /bin/sh …` from a command running as root is
//! enough) then failed every command with `ENOENT`, which surfaced as a
//! misleading "not found" for the command, and the root disk keeps the damage
//! across restarts. The agent therefore falls back to the first of dash or bash
//! it finds when `/bin/sh` is missing or not executable. On Linux, running as
//! root, it also points `/bin/sh` back at that shell, because the commands it
//! runs rely on `/bin/sh` too. It never refuses a command: when no shell exists
//! at all, the start fails with a short note naming the missing shell.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The shell path commands are started through.
pub(crate) const SYSTEM_SHELL: &str = "/bin/sh";

/// Where the agent looks, in order, when [`SYSTEM_SHELL`] cannot be started.
pub(crate) const FALLBACK_SHELLS: [&str; 4] =
    ["/bin/dash", "/usr/bin/dash", "/bin/bash", "/usr/bin/bash"];

/// The note a failed start carries when no shell can be started. Kept free of
/// quotes, colons and shell syntax: the runtime matches it exactly.
pub(crate) const MISSING_SHELL_NOTE: &str =
    "the shell /bin/sh is missing and no dash or bash was found";

/// What the agent found for [`SYSTEM_SHELL`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ShellChoice {
    /// The system shell can be started.
    System,
    /// The system shell cannot be started; this fallback can.
    Fallback(PathBuf),
    /// No shell can be started.
    Missing,
}

/// Whether `path` (followed through symlinks) is a file this process may
/// execute.
pub(crate) fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
        && nix::unistd::access(path, nix::unistd::AccessFlags::X_OK).is_ok()
}

/// Chooses the shell to start for `system`: itself while it can be started,
/// else the first fallback that can.
pub(crate) fn choose(system: &Path, fallbacks: &[&Path]) -> ShellChoice {
    if is_executable(system) {
        return ShellChoice::System;
    }
    fallbacks
        .iter()
        .find(|shell| is_executable(shell))
        .map_or(ShellChoice::Missing, |shell| {
            ShellChoice::Fallback(shell.to_path_buf())
        })
}

fn fallback_shells() -> [&'static Path; 4] {
    FALLBACK_SHELLS.map(Path::new)
}

/// The program to start for `/bin/sh`: `/bin/sh` itself while it works, else a
/// fallback shell (restoring `/bin/sh` where the agent may), else `/bin/sh`
/// anyway, so the start fails and [`spawn_failure_note`] explains why.
pub(crate) fn system_shell() -> PathBuf {
    resolve(Path::new(SYSTEM_SHELL), &fallback_shells(), may_restore())
}

/// [`system_shell`] for `program` when it names `/bin/sh`; `None` for any
/// other program, which is started exactly as given.
pub(crate) fn substitute(program: &OsStr) -> Option<PathBuf> {
    (Path::new(program) == Path::new(SYSTEM_SHELL)).then(system_shell)
}

/// The shell to start for a preferred shell (`$SHELL`, an account's login
/// shell): the preferred one while it can be started, else [`system_shell`].
/// A bare name is left to the `PATH` lookup.
pub(crate) fn usable_shell(preferred: &Path) -> PathBuf {
    if preferred.as_os_str().is_empty()
        || preferred == Path::new(SYSTEM_SHELL)
        || (preferred.is_absolute() && !is_executable(preferred))
    {
        system_shell()
    } else {
        preferred.to_path_buf()
    }
}

/// The shell named by `$SHELL`, or the system shell, checked as in
/// [`usable_shell`].
pub(crate) fn environment_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map_or_else(system_shell, |shell| usable_shell(Path::new(&shell)))
}

/// Whether the agent may restore `/bin/sh`: Linux, running as root.
fn may_restore() -> bool {
    #[cfg(target_os = "linux")]
    {
        nix::unistd::geteuid().is_root()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// The first fallback or missing shell is a warning; repeats are debug logs.
static WARNED: AtomicBool = AtomicBool::new(false);

/// The test seam behind [`system_shell`]: `system` and `fallbacks` are the
/// paths to check, `restore` whether `system` may be pointed back at a
/// fallback.
pub(crate) fn resolve(system: &Path, fallbacks: &[&Path], restore: bool) -> PathBuf {
    match choose(system, fallbacks) {
        ShellChoice::System => system.to_path_buf(),
        ShellChoice::Fallback(shell) => {
            let outcome = if restore {
                restore_link(system, &shell)
            } else {
                RestoreOutcome::NotRestored("the agent is not running as root on Linux".into())
            };
            if WARNED.swap(true, Ordering::Relaxed) {
                tracing::debug!(
                    system = %system.display(),
                    fallback = %shell.display(),
                    ?outcome,
                    "the system shell was missing again; commands start with a fallback shell"
                );
            } else {
                tracing::warn!(
                    system = %system.display(),
                    fallback = %shell.display(),
                    ?outcome,
                    "the system shell was missing or not executable; commands start with a fallback shell"
                );
            }
            shell
        }
        ShellChoice::Missing => {
            if WARNED.swap(true, Ordering::Relaxed) {
                tracing::debug!(system = %system.display(), "no shell can be started");
            } else {
                tracing::warn!(
                    system = %system.display(),
                    "the system shell is missing and no dash or bash was found; commands cannot start"
                );
            }
            system.to_path_buf()
        }
    }
}

/// The result of one restore attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestoreOutcome {
    /// The system shell path starts a shell again.
    Restored,
    /// It was left as it is, and why.
    NotRestored(String),
}

/// Serializes restores, so concurrent process starts do not race each other.
static RESTORE: Mutex<()> = Mutex::new(());

/// Points `system` at `shell` with a symlink. Only an empty path or a symlink
/// (dangling, or to a shell that no longer starts) is replaced, atomically by a
/// rename; a file or directory someone put there is left alone, since it may
/// hold data.
fn restore_link(system: &Path, shell: &Path) -> RestoreOutcome {
    let _guard = RESTORE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Another start may have restored it while this one waited.
    if is_executable(system) {
        return RestoreOutcome::Restored;
    }
    match std::fs::symlink_metadata(system) {
        Ok(meta) if meta.file_type().is_symlink() => {}
        Ok(meta) if meta.is_dir() => {
            return RestoreOutcome::NotRestored("a directory is at the path".to_string());
        }
        Ok(_) => return RestoreOutcome::NotRestored("a file is at the path".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return RestoreOutcome::NotRestored(format!("inspect the path: {error}")),
    }
    let (Some(parent), Some(name)) = (system.parent(), system.file_name()) else {
        return RestoreOutcome::NotRestored("the path has no parent directory".to_string());
    };
    let mut staged_name = std::ffi::OsString::from(".");
    staged_name.push(name);
    staged_name.push(format!(".opengeni-{}", std::process::id()));
    let staged = parent.join(staged_name);
    let _ = std::fs::remove_file(&staged);
    if let Err(error) = std::os::unix::fs::symlink(shell, &staged) {
        return RestoreOutcome::NotRestored(format!("create the link: {error}"));
    }
    if let Err(error) = std::fs::rename(&staged, system) {
        let _ = std::fs::remove_file(&staged);
        return RestoreOutcome::NotRestored(format!("put the link in place: {error}"));
    }
    if is_executable(system) {
        RestoreOutcome::Restored
    } else {
        RestoreOutcome::NotRestored("the path still does not start a shell".to_string())
    }
}

/// A short note for a failed process start when no shell exists, so the error
/// names what is actually missing. Every exec starts its containment anchor
/// through the shell, so this applies whatever program was asked for, but only
/// to a start that could not find something (`NotFound`).
pub(crate) fn spawn_failure_note(error: &std::io::Error) -> Option<&'static str> {
    note_for(error, &choose(Path::new(SYSTEM_SHELL), &fallback_shells()))
}

fn note_for(error: &std::io::Error, choice: &ShellChoice) -> Option<&'static str> {
    (error.kind() == std::io::ErrorKind::NotFound && *choice == ShellChoice::Missing)
        .then_some(MISSING_SHELL_NOTE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write_file(path: &Path, mode: u32) {
        std::fs::write(path, b"#!/bin/true\n").expect("write");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
    }

    /// A real shell a test can start: the machine's own `/bin/sh` target.
    fn real_shell() -> PathBuf {
        std::fs::canonicalize(SYSTEM_SHELL).expect("the test machine has a shell")
    }

    #[test]
    fn a_missing_or_unexecutable_system_shell_falls_back_in_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let system = dir.path().join("sh");
        let dash = dir.path().join("dash");
        let bash = dir.path().join("bash");
        let candidates = [dash.as_path(), bash.as_path()];

        assert_eq!(choose(&system, &candidates), ShellChoice::Missing);
        write_file(&bash, 0o755);
        assert_eq!(
            choose(&system, &candidates),
            ShellChoice::Fallback(bash.clone())
        );
        write_file(&dash, 0o755);
        assert_eq!(
            choose(&system, &candidates),
            ShellChoice::Fallback(dash.clone())
        );
        // Present but not executable counts as missing (unless running as
        // root, which may execute any file with an execute bit, none here).
        write_file(&system, 0o644);
        assert_eq!(
            choose(&system, &candidates),
            ShellChoice::Fallback(dash.clone())
        );
        std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert_eq!(choose(&system, &candidates), ShellChoice::System);
    }

    #[test]
    fn without_restore_the_fallback_is_started_and_the_path_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let system = dir.path().join("sh");
        let dash = real_shell();
        assert_eq!(resolve(&system, &[dash.as_path()], false), dash);
        assert!(std::fs::symlink_metadata(&system).is_err());
    }

    #[test]
    fn restore_points_a_missing_or_dangling_system_shell_at_the_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dash = real_shell();

        let missing = dir.path().join("sh");
        assert_eq!(resolve(&missing, &[dash.as_path()], true), dash);
        assert_eq!(std::fs::read_link(&missing).expect("a link"), dash);
        assert!(is_executable(&missing));
        // Once restored, the system shell is started again.
        assert_eq!(resolve(&missing, &[dash.as_path()], true), missing);

        let dangling = dir.path().join("dangling-sh");
        std::os::unix::fs::symlink(dir.path().join("moved-away"), &dangling).expect("symlink");
        assert_eq!(resolve(&dangling, &[dash.as_path()], true), dash);
        assert_eq!(std::fs::read_link(&dangling).expect("a link"), dash);
        // No staging link is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".opengeni-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn restore_never_replaces_a_file_or_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dash = real_shell();
        let file = dir.path().join("sh-file");
        write_file(&file, 0o644);
        if !is_executable(&file) {
            assert_eq!(resolve(&file, &[dash.as_path()], true), dash);
            assert!(std::fs::symlink_metadata(&file)
                .expect("still there")
                .is_file());
        }
        let directory = dir.path().join("sh-dir");
        std::fs::create_dir(&directory).expect("mkdir");
        assert_eq!(
            restore_link(&directory, &dash),
            RestoreOutcome::NotRestored("a directory is at the path".to_string())
        );
        assert!(directory.is_dir());
    }

    #[test]
    fn a_preferred_shell_that_cannot_start_uses_the_system_shell() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = real_shell();
        assert_eq!(usable_shell(&real), real);
        assert_eq!(usable_shell(Path::new("bash")), Path::new("bash"));
        let gone = dir.path().join("zsh");
        assert_eq!(usable_shell(&gone), system_shell());
        assert_eq!(usable_shell(Path::new("")), system_shell());
        assert_eq!(substitute(OsStr::new("/usr/bin/env")), None);
        assert_eq!(substitute(OsStr::new(SYSTEM_SHELL)), Some(system_shell()));
    }

    #[test]
    fn only_a_not_found_start_with_no_shell_names_the_missing_shell() {
        let not_found = std::io::Error::from(std::io::ErrorKind::NotFound);
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            note_for(&not_found, &ShellChoice::Missing),
            Some(MISSING_SHELL_NOTE)
        );
        assert_eq!(note_for(&denied, &ShellChoice::Missing), None);
        assert_eq!(note_for(&not_found, &ShellChoice::System), None);
        assert_eq!(
            note_for(&not_found, &ShellChoice::Fallback(real_shell())),
            None
        );
        // A healthy machine has a shell, so no failed start is blamed on it.
        assert_eq!(spawn_failure_note(&not_found), None);
        for forbidden in ['"', ':', '\'', '(', ')', '$', ';', '\n'] {
            assert!(!MISSING_SHELL_NOTE.contains(forbidden), "{forbidden:?}");
        }
    }
}
