//! Single-instance guard: at most ONE enrolled agent process per machine.
//!
//! An enrolled agent's identity IS its NATS subject (`agent.<ws>.<id>.rpc`, see
//! [`config::StoredCredentials::rpc_subject`](crate::config::StoredCredentials::rpc_subject)).
//! Two `run` processes on one machine share that single identity: BOTH subscribe
//! as duplicate control-RPC responders and BOTH publish heartbeats, so ops route
//! nondeterministically to one responder or the other and the lease flaps. This
//! is not theoretical — it was observed live (twice): a Finder/Raycast launch (now
//! run-by-default when enrolled, see [`run_default`](crate::run_default)) racing a
//! terminal `opengeni-agent run` produced a second full agent sharing the identity
//! for 16+ minutes.
//!
//! The fix is an OS-level advisory lock (`flock(LOCK_EX | LOCK_NB)`) on a per-user
//! lock file next to the credentials (same config dir, [`config::config_dir`]).
//! The FIRST `run` takes it and holds it for the whole process lifetime; a SECOND
//! `run` fails the non-blocking acquire and exits cleanly (a launcher double-click
//! of an already-running agent is a no-op, not an error). The lock is released when
//! the holding process exits — the OS drops the `flock` when the fd closes, so a
//! crash never leaves a stale lock wedged.
//!
//! Only `run` (explicit and run-by-default) takes the lock. `enroll`, `uninstall`,
//! `service`, and `update` legitimately run BESIDE a live agent and must not.

use std::path::{Path, PathBuf};

use thiserror::Error;

/// The lock file name inside the config dir. Sits next to `credentials.json` so
/// the whole per-user agent state lives in one place.
const LOCK_FILE: &str = "agent.lock";

/// Why a single-instance lock could not be taken.
#[derive(Debug, Error)]
pub enum LockError {
    /// Another `opengeni-agent run` process already holds the lock. `holder_pid`
    /// is the pid recorded in the lock file by the holder at acquire time, or
    /// `None` if it could not be read (stale/racy content is tolerated — the pid
    /// is only used to make the "already running" message more helpful).
    #[error("another opengeni-agent instance holds the lock")]
    Contended {
        /// The pid the holder wrote into the lock file, best-effort.
        holder_pid: Option<u32>,
    },
    /// The config directory backing the lock file could not be resolved.
    #[error("could not resolve the config directory for the lock: {0}")]
    Config(#[from] crate::config::ConfigError),
    /// A filesystem operation on the lock file/dir failed (create/open).
    #[error("lock io error at {path}: {source}")]
    Io {
        /// The path the failing op touched.
        path: PathBuf,
        /// The underlying IO error.
        source: std::io::Error,
    },
}

impl LockError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// A held single-instance lock. Keep this alive for the process lifetime: dropping
/// it releases the lock (the OS also releases it automatically when the process
/// exits, which is what makes a crashed holder self-heal).
#[must_use = "the lock is released as soon as this guard is dropped"]
pub struct InstanceLock {
    // The `flock` lives on the open file description; holding the owned handle
    // holds the lock. `nix::fcntl::Flock` owns the `File` and unlocks on drop.
    #[cfg(unix)]
    _flock: nix::fcntl::Flock<std::fs::File>,
    // Non-unix: we keep the file open but do not (yet) take a real OS lock — see
    // [`acquire_in`]. Held so the handle has consistent drop semantics.
    #[cfg(not(unix))]
    _file: std::fs::File,
}

/// Acquires the single-instance lock in the agent's config dir. Convenience over
/// [`acquire_in`] using [`config::config_dir`](crate::config::config_dir).
///
/// # Errors
///
/// [`LockError::Contended`] if another instance holds it, [`LockError::Config`] if
/// the config dir cannot be resolved, or [`LockError::Io`] on a filesystem failure.
pub fn acquire() -> Result<InstanceLock, LockError> {
    let dir = crate::config::config_dir()?;
    acquire_in(&dir)
}

/// Acquires the lock file inside `dir`, creating the directory if needed. Takes a
/// non-blocking exclusive `flock`; on contention returns [`LockError::Contended`]
/// with the holder's recorded pid (best-effort). On success records THIS process's
/// pid into the file so a later contender can name us.
///
/// The `dir` seam exists so tests can point at a temp dir (real acquisition,
/// isolated path) without touching the user's real config dir.
///
/// # Errors
///
/// See [`acquire`].
pub fn acquire_in(dir: &Path) -> Result<InstanceLock, LockError> {
    std::fs::create_dir_all(dir).map_err(|source| LockError::io(dir, source))?;
    let path = dir.join(LOCK_FILE);
    // read+write+create, but DO NOT truncate: on contention we must leave the
    // holder's pid intact (we never win the lock, so we never rewrite it).
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|source| LockError::io(&path, source))?;

    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::fcntl::{Flock, FlockArg};

        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(mut flock) => {
                record_pid(&mut flock);
                Ok(InstanceLock { _flock: flock })
            }
            // A non-blocking exclusive lock that fails with EWOULDBLOCK/EAGAIN means
            // another process holds it — that is our contention signal. (`Flock::lock`
            // hands the file back on error; we drop it and re-read the pid from the
            // path.) Any OTHER errno is a genuine IO failure, surfaced as such.
            Err((_file, errno)) => {
                if errno == Errno::EWOULDBLOCK {
                    Err(LockError::Contended {
                        holder_pid: read_holder_pid(&path),
                    })
                } else {
                    Err(LockError::io(
                        &path,
                        std::io::Error::from_raw_os_error(errno as i32),
                    ))
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        // Windows has no `flock`; a safe cross-platform lock would need a named
        // mutex / `LockFileEx` binding (and the workspace forbids `unsafe`, so a
        // raw win32 call is out). The Windows model is the always-on Service, not a
        // double-clickable launcher, so the Raycast+terminal race this guards does
        // not arise there. Keep the file open for symmetric drop semantics and
        // treat acquisition as a no-op success. (Tracked for a future named-mutex.)
        Ok(InstanceLock { _file: file })
    }
}

/// Records this process's pid into the (now-locked) lock file so a later contender
/// can name the holder. Best-effort: a write failure only degrades the contention
/// message, never the lock itself.
#[cfg(unix)]
fn record_pid(flock: &mut nix::fcntl::Flock<std::fs::File>) {
    use std::io::{Seek, SeekFrom, Write};
    // Method calls auto-deref through `Flock`'s `DerefMut` to the inner `File`.
    let pid = std::process::id().to_string();
    let _ = flock.set_len(0);
    let _ = flock.seek(SeekFrom::Start(0));
    let _ = flock.write_all(pid.as_bytes());
    let _ = flock.flush();
}

/// Reads the holder pid the lock file records, tolerating stale/garbage content
/// (returns `None` rather than erroring — the pid is purely advisory).
#[cfg(unix)]
fn read_holder_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A fresh acquire in an empty dir succeeds and records our pid.
    #[test]
    fn acquire_succeeds_and_records_pid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock = acquire_in(dir.path()).expect("first acquire");
        let recorded = read_holder_pid(&dir.path().join(LOCK_FILE));
        assert_eq!(recorded, Some(std::process::id()));
        drop(lock);
    }

    /// A SECOND acquire against the same dir while the first is held contends —
    /// even within one process, because two independent `open` file descriptions
    /// contend under `flock` (the exact same-machine race the guard exists for).
    /// The contention carries the first holder's recorded pid (this process).
    #[test]
    fn second_acquire_while_held_contends() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _held = acquire_in(dir.path()).expect("first acquire");
        // `InstanceLock` wraps a non-`Debug` `Flock`, so match without formatting
        // the `Ok` value.
        match acquire_in(dir.path()) {
            Err(LockError::Contended { holder_pid }) => {
                assert_eq!(holder_pid, Some(std::process::id()));
            }
            Err(e) => panic!("expected Contended, got a different error: {e:?}"),
            Ok(_) => panic!("expected Contended, but the second acquire succeeded"),
        }
    }

    /// Dropping the guard releases the lock, so a subsequent acquire succeeds.
    #[test]
    fn lock_is_released_on_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = acquire_in(dir.path()).expect("first acquire");
        drop(first);
        let _second = acquire_in(dir.path()).expect("re-acquire after drop");
    }
}
