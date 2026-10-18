//! What the host keeps of a sandbox's session on disk, so that after the
//! host agent restarts it opens the session again, with its subscriptions,
//! before the sandbox's guest runs.
//!
//! A session is kept durably (the file and its directory are synced) and
//! replaced at once, never torn. One [`Saver`] writes them, the latest
//! asked for each file first superseding any older one not yet written,
//! and tries a failed write again until it succeeds or is superseded.
//! Stopped, it writes what it was asked once more and then is done:
//! [`Saver::finish`] returns only once no write of its is under way, so a
//! saver started after it never has its newer sessions replaced by an
//! older one. Each write goes through a temporary file of its own, so two
//! writes to one file never mix.
//!
//! What is lost if the host stops before a change is written: a
//! subscription the agent made just before, which a restarted host does
//! not hold for it. While the agent runs it subscribes again as it
//! reconnects; while its sandbox sleeps, a request for that subscription
//! finds no responder, and the sender wakes the sandbox through the fleet
//! ([agent link](../../docs/agent-link.md), section 5).

use std::collections::HashMap;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// A session as kept on disk.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    /// The agent's connection instance.
    pub instance: String,
    /// Its subscriptions, by the host's sid.
    pub subs: Vec<SavedSub>,
    /// The next sid the host gives.
    pub next_sid: u32,
}

/// One subscription of a [`Saved`] session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedSub {
    pub sid: u32,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<String>,
}

impl Saved {
    /// Reads the session kept at `path`, if one is. A file that does not
    /// parse is treated as none: the session then opens when the agent
    /// next connects, as for a new sandbox.
    ///
    /// # Errors
    ///
    /// When the file exists but cannot be read.
    pub fn load(path: &Path) -> io::Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(match serde_json::from_slice(&bytes) {
                Ok(saved) => Some(saved),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "ignoring an unreadable agent-link session");
                    None
                }
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Keeps `saved` at `path` durably, replacing what was there at once,
    /// or removes it for `None`.
    ///
    /// # Errors
    ///
    /// When the file cannot be written or removed; what was there stays.
    pub async fn store(path: &Path, saved: Option<&Self>) -> io::Result<()> {
        let bytes = saved
            .map(serde_json::to_vec)
            .transpose()
            .map_err(io::Error::other)?;
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || store(&path, bytes.as_deref()))
            .await
            .map_err(io::Error::other)?
    }
}

fn store(path: &Path, bytes: Option<&[u8]>) -> io::Result<()> {
    match bytes {
        None => match std::fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            result => result?,
        },
        Some(bytes) => {
            let temporary = temporary(path);
            let written = std::fs::File::create_new(&temporary).and_then(|mut file| {
                file.write_all(bytes)?;
                file.sync_all()
            });
            if let Err(error) = written.and_then(|()| std::fs::rename(&temporary, path)) {
                let _ = std::fs::remove_file(&temporary);
                return Err(error);
            }
        }
    }
    // The rename or removal lasts once the directory is synced.
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    std::fs::File::open(directory)?.sync_all()
}

/// A temporary name beside `path` that no other write uses: this
/// process's and this write's own. One a host that stopped mid-write left
/// goes with the sandbox's directory.
fn temporary(path: &Path) -> PathBuf {
    static WRITES: AtomicU64 = AtomicU64::new(0);
    let write = WRITES.fetch_add(1, Ordering::Relaxed);
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}-{write}.new", std::process::id()));
    PathBuf::from(temporary)
}

/// Writes kept sessions in the background, see the [module](self).
#[derive(Debug)]
pub(crate) struct Saver {
    shared: Arc<Shared>,
    stop: CancellationToken,
    running: JoinHandle<()>,
}

#[derive(Debug, Default)]
struct Shared {
    /// What is to be written to each file, the latest asked.
    dirty: Mutex<HashMap<PathBuf, Option<Saved>>>,
    asked: Notify,
    /// How long each write waits before it starts, to test what a slow
    /// disk does.
    #[cfg(test)]
    slow: Duration,
}

/// The first wait before a failed write is tried again; it doubles up to
/// [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_millis(500);
const RETRY_MAX: Duration = Duration::from_secs(30);

impl Saver {
    /// Starts the saver. Must run inside a Tokio runtime.
    pub(crate) fn start() -> Self {
        Self::with(Shared::default())
    }

    fn with(shared: Shared) -> Self {
        let shared = Arc::new(shared);
        let stop = CancellationToken::new();
        let running = tokio::spawn(run(Arc::clone(&shared), stop.clone()));
        Self {
            shared,
            stop,
            running,
        }
    }

    /// Asks for `saved` to be kept at `path`, or removed for `None`.
    pub(crate) fn put(&self, path: PathBuf, saved: Option<Saved>) {
        self.shared.lock().insert(path, saved);
        self.shared.asked.notify_one();
    }

    /// Stops the saver once it has written what it was asked, trying each
    /// failed write once more, and returns when no write of its is under
    /// way.
    pub(crate) async fn finish(self) {
        self.stop.cancel();
        if let Err(error) = self.running.await {
            tracing::error!(%error, "the agent-link saver ended unexpectedly");
        }
    }
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Option<Saved>>> {
        self.dirty.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

async fn run(shared: Arc<Shared>, stop: CancellationToken) {
    let mut retry = RETRY_MIN;
    let mut failed = false;
    loop {
        let stopping = tokio::select! {
            biased;
            () = stop.cancelled() => true,
            () = shared.asked.notified() => false,
            () = tokio::time::sleep(retry), if failed => false,
        };
        failed = write_dirty(&shared).await;
        if stopping {
            return;
        }
        retry = if failed {
            (retry * 2).min(RETRY_MAX)
        } else {
            RETRY_MIN
        };
    }
}

/// Writes what is dirty; what fails stays dirty unless it was asked again
/// meanwhile. Whether any failed.
async fn write_dirty(shared: &Shared) -> bool {
    let dirty = std::mem::take(&mut *shared.lock());
    let mut failed = false;
    for (path, saved) in dirty {
        #[cfg(test)]
        tokio::time::sleep(shared.slow).await;
        if let Err(error) = Saved::store(&path, saved.as_ref()).await {
            tracing::error!(path = %path.display(), %error, "could not keep an agent-link session; trying again");
            failed = true;
            shared.lock().entry(path).or_insert(saved);
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("compute-link-saved-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session(next_sid: u32) -> Saved {
        Saved {
            instance: "i1".into(),
            subs: vec![SavedSub {
                sid: 1,
                subject: "agent.w.a.connection.i1.rpc".into(),
                queue: None,
            }],
            next_sid,
        }
    }

    #[tokio::test]
    async fn a_session_is_kept_replaced_and_removed() {
        let dir = scratch("kept");
        let path = dir.join("link.json");
        assert_eq!(Saved::load(&path).unwrap(), None);
        Saved::store(&path, Some(&session(2))).await.unwrap();
        assert_eq!(Saved::load(&path).unwrap(), Some(session(2)));
        std::fs::write(&path, b"{").unwrap();
        assert_eq!(Saved::load(&path).unwrap(), None, "a torn file is none");
        Saved::store(&path, None).await.unwrap();
        Saved::store(&path, None).await.unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_interrupted_write_leaves_the_last_session_whole() {
        let dir = scratch("interrupted");
        let path = dir.join("link.json");
        Saved::store(&path, Some(&session(2))).await.unwrap();
        // A host that stopped while writing the next one left part of it
        // beside the file.
        std::fs::write(dir.join("link.json.1-0.new"), b"{\"instance\":").unwrap();
        assert_eq!(Saved::load(&path).unwrap(), Some(session(2)));
        // The next write replaces the file, beside what was left.
        Saved::store(&path, Some(&session(3))).await.unwrap();
        assert_eq!(Saved::load(&path).unwrap(), Some(session(3)));
        // A write that cannot happen leaves what was there.
        let missing = dir.join("gone").join("link.json");
        assert!(Saved::store(&missing, Some(&session(4))).await.is_err());
        assert_eq!(Saved::load(&path).unwrap(), Some(session(3)));
        // And no temporary file of its own.
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["link.json", "link.json.1-0.new"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn writes_to_one_file_at_once_never_mix() {
        let dir = scratch("concurrent");
        let path = dir.join("link.json");
        let writes: Vec<_> = (0..64)
            .map(|n| {
                let path = path.clone();
                tokio::spawn(async move { Saved::store(&path, Some(&session(n))).await })
            })
            .collect();
        for write in writes {
            write.await.unwrap().expect("every write succeeds");
        }
        let kept = Saved::load(&path)
            .unwrap()
            .expect("one of them is kept whole");
        assert!(kept.next_sid < 64);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_saver_writes_the_latest_and_tries_a_failed_write_again() {
        let dir = scratch("saver");
        let saver = Saver::start();
        // Its directory is not there yet, so the first writes fail.
        let later = dir.join("later");
        let path = later.join("link.json");
        saver.put(path.clone(), Some(session(2)));
        saver.put(path.clone(), Some(session(3)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!path.exists());
        std::fs::create_dir_all(&later).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while Saved::load(&path).unwrap() != Some(session(3)) {
            assert!(tokio::time::Instant::now() < deadline, "never retried");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // What is asked last before it stops is written before it is done.
        saver.put(path.clone(), Some(session(4)));
        saver.finish().await;
        assert_eq!(Saved::load(&path).unwrap(), Some(session(4)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_saver_started_after_another_finished_is_never_overwritten_by_it() {
        let dir = scratch("successor");
        let path = dir.join("link.json");
        // A slow disk: the old saver's last write is still under way when
        // it is told to stop.
        let old = Saver::with(Shared {
            slow: Duration::from_millis(300),
            ..Shared::default()
        });
        old.put(path.clone(), Some(session(2)));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let started = tokio::time::Instant::now();
        old.finish().await;
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert_eq!(Saved::load(&path).unwrap(), Some(session(2)));
        let new = Saver::start();
        new.put(path.clone(), Some(session(3)));
        new.finish().await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(Saved::load(&path).unwrap(), Some(session(3)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
