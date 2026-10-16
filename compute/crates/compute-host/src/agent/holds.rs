//! Named holds outlast the agent. Each sandbox's are kept in a small file
//! beside its record, written before a hold or release is acknowledged, so
//! a restart neither drops a hold a caller still counts on nor revives one
//! that lapsed meanwhile. The holds a connection takes end with the
//! connection, which a restart ends too, so only named holds are kept.
//!
//! Writes run in the background, one at a time per sandbox. A write that
//! has started keeps the sandbox's writer and a share of the state root's
//! ownership until it lands, even when nobody waits for it any more, so
//! it can neither land after the writer is closed nor after a successor
//! agent took the root and its holds. Removing a sandbox closes its
//! writer first: a write still pending then never lands, so it cannot
//! touch the files of a sandbox later made with the same id.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use compute_core::HoldId;

use crate::layout::write_atomic;
use crate::state::Ownership;

/// A pending write of a sandbox's holds; the change is durable once it
/// resolves.
pub(super) type Write = Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;

/// The closing of a removed sandbox's writer; see [`Holds::close`].
pub(super) type Closing = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The hold an unreadable holds file becomes: which holds it kept is
/// unknown, so the sandbox stays awake until this is released by name.
pub(super) const UNREADABLE: &str = "holds-file-unreadable";

/// The hold id for a hold named through the API. Leases count up from one,
/// so named holds take the upper half of the id space.
pub(super) fn hold_id(name: &str) -> HoldId {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    HoldId(hasher.finish() | 1 << 63)
}

/// A sandbox's named holds and the file that keeps them.
#[derive(Debug)]
pub(super) struct Holds {
    path: PathBuf,
    /// When each lapses, in milliseconds since the Unix epoch; `None` lasts
    /// until released.
    named: BTreeMap<String, Option<u64>>,
    /// Changes made so far; each write carries the count it saw.
    changes: u64,
    /// Held while writing, so writes happen one at a time and an older
    /// list never replaces a newer one.
    writer: Arc<tokio::sync::Mutex<Writer>>,
    /// Kept by every write until it lands.
    owner: Ownership,
}

#[derive(Debug, Default)]
struct Writer {
    /// The latest change durably written.
    written: u64,
    /// Set when the sandbox is removed; nothing is written after.
    closed: bool,
}

impl Holds {
    /// No holds, kept at `path` by the agent that holds `owner`.
    pub fn new(path: PathBuf, owner: Ownership) -> Self {
        Self {
            path,
            named: BTreeMap::new(),
            changes: 0,
            writer: Arc::default(),
            owner,
        }
    }

    /// The holds kept at `path` that have not lapsed by `now_ms`. A missing
    /// file holds none. One that cannot be read becomes the single hold
    /// [`UNREADABLE`], returned with the error: which holds it kept is
    /// unknown, and dropping one a caller counts on could let the sandbox
    /// sleep, and in time forget its memory, under a running task. The
    /// file stays, so a restart finds the same, until the next write
    /// replaces it; a copy is kept beside it for inspection.
    pub fn load(path: PathBuf, now_ms: u64, owner: Ownership) -> (Self, Option<io::Error>) {
        let mut holds = Self::new(path, owner);
        let read = std::fs::read(&holds.path).and_then(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        });
        match read {
            Ok(named) => {
                holds.named = named;
                holds.drop_lapsed(now_ms);
                (holds, None)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (holds, None),
            Err(error) => {
                let _ = std::fs::copy(&holds.path, holds.path.with_extension("json.unreadable"));
                holds.named.insert(UNREADABLE.to_owned(), None);
                (holds, Some(error))
            }
        }
    }

    /// Each hold's name and when it lapses.
    pub fn named(&self) -> impl Iterator<Item = (&str, Option<u64>)> {
        self.named
            .iter()
            .map(|(name, lapses)| (name.as_str(), *lapses))
    }

    /// Holds `name` until `lapses_ms`, or until released.
    pub fn set(&mut self, name: String, lapses_ms: Option<u64>) {
        self.named.insert(name, lapses_ms);
    }

    /// Forgets hold `name`. Returns whether it was held.
    pub fn remove(&mut self, name: &str) -> bool {
        self.named.remove(name).is_some()
    }

    /// A write of the holds as they are now, less those lapsed by `now_ms`.
    /// The change is durable once it resolves.
    pub fn write(&mut self, now_ms: u64) -> Write {
        self.drop_lapsed(now_ms);
        self.changes += 1;
        self.persist()
    }

    /// Resolves once the holds as they are now are durable, writing them
    /// again only if an earlier write of this state failed. A release of a
    /// hold that is already gone answers with this, so a retried release
    /// is acknowledged only once the first one's change is kept.
    pub fn flush(&mut self) -> Write {
        self.persist()
    }

    /// Closes the writer: once this resolves, no write has landed since or
    /// ever will. A write that has started finishes first.
    pub fn close(&self) -> Closing {
        let writer = Arc::clone(&self.writer);
        Box::pin(async move {
            writer.lock().await.closed = true;
        })
    }

    /// Makes change `self.changes` durable, unless a later one already is.
    /// Once the write starts it runs to the end on a blocking thread that
    /// keeps the writer and the root's ownership, whether or not anyone
    /// still waits for it.
    fn persist(&self) -> Write {
        let change = self.changes;
        let bytes = serde_json::to_vec(&self.named);
        let path = self.path.clone();
        let writer = Arc::clone(&self.writer);
        let owner = self.owner.clone();
        Box::pin(async move {
            let bytes = bytes.map_err(io::Error::other)?;
            let mut writer = writer.lock_owned().await;
            tokio::task::spawn_blocking(move || {
                let _owner = owner;
                if writer.closed {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        "the sandbox was removed",
                    ));
                }
                if writer.written >= change {
                    return Ok(());
                }
                #[cfg(test)]
                tests::pause_at(&path);
                write_atomic(&path, &bytes)?;
                writer.written = change;
                Ok(())
            })
            .await
            .map_err(io::Error::other)?
        })
    }

    fn drop_lapsed(&mut self, now_ms: u64) {
        self.named
            .retain(|_, lapses| lapses.is_none_or(|lapses| lapses > now_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::FAILPOINTS;
    use crate::state::{Records, StateError};
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A write paused just before it touches the file.
    struct Pause {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    static PAUSES: std::sync::Mutex<Vec<(PathBuf, Pause)>> = std::sync::Mutex::new(Vec::new());

    /// Pauses the next write to `path` until the test releases it.
    pub(super) fn pause_at(path: &Path) {
        let pause = {
            let mut pauses = PAUSES
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let at = pauses.iter().position(|(paused, _)| paused == path);
            at.map(|at| pauses.remove(at).1)
        };
        if let Some(pause) = pause {
            let _ = pause.started.send(());
            let _ = pause.release.recv();
        }
    }

    /// Pauses the next write to `path`. Returns what tells when it has
    /// started and what releases it.
    fn pause(path: &Path) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, on_start) = mpsc::channel();
        let (release, on_release) = mpsc::channel();
        PAUSES.lock().unwrap().push((
            path.to_owned(),
            Pause {
                started,
                release: on_release,
            },
        ));
        (on_start, release)
    }

    fn file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "holds-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("holds.json")
    }

    #[tokio::test]
    async fn holds_written_come_back_without_the_lapsed_ones() {
        let path = file();
        let mut holds = Holds::new(path.clone(), Ownership::detached());
        holds.set("turn".into(), None);
        holds.set("timeout".into(), Some(2_000));
        holds.set("brief".into(), Some(1_500));
        holds.write(1_000).await.unwrap();
        let (loaded, error) = Holds::load(path.clone(), 1_600, Ownership::detached());
        assert!(error.is_none());
        let named: Vec<_> = loaded.named().collect();
        assert_eq!(named, [("timeout", Some(2_000)), ("turn", None)]);

        holds.remove("turn");
        holds.write(1_000).await.unwrap();
        let (loaded, _) = Holds::load(path.clone(), 2_000, Ownership::detached());
        assert_eq!(loaded.named().count(), 0, "lapsed at 2000");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn an_older_list_never_replaces_a_newer_one() {
        let path = file();
        let mut holds = Holds::new(path.clone(), Ownership::detached());
        holds.set("first".into(), None);
        let older = holds.write(0);
        holds.set("second".into(), None);
        let newer = holds.write(0);
        // The newer write lands first; the older one then finds it
        // superseded and leaves the file alone.
        newer.await.unwrap();
        older.await.unwrap();
        let (loaded, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(loaded.named().count(), 2);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// Which holds a damaged file kept is unknown, so it becomes one hold
    /// that keeps the sandbox awake, again after every restart, until it
    /// is released by name.
    #[tokio::test]
    async fn a_missing_file_holds_nothing_and_a_damaged_one_holds_until_released() {
        let path = file();
        let (empty, error) = Holds::load(path.clone(), 0, Ownership::detached());
        assert!(error.is_none());
        assert_eq!(empty.named().count(), 0);
        std::fs::write(&path, "not json").unwrap();
        for _restart in 0..2 {
            let (held, error) = Holds::load(path.clone(), 0, Ownership::detached());
            assert_eq!(error.unwrap().kind(), io::ErrorKind::InvalidData);
            assert_eq!(held.named().collect::<Vec<_>>(), [(UNREADABLE, None)]);
        }
        let copy = path.with_extension("json.unreadable");
        assert_eq!(std::fs::read(&copy).unwrap(), b"not json");

        let (mut held, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert!(held.remove(UNREADABLE));
        held.write(0).await.unwrap();
        let (released, error) = Holds::load(path.clone(), 0, Ownership::detached());
        assert!(error.is_none());
        assert_eq!(released.named().count(), 0);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// A release whose write failed, retried after the hold is already
    /// gone from memory, is acknowledged only once the release is on disk:
    /// otherwise a restart would bring back a hold the caller was told had
    /// ended.
    #[tokio::test]
    async fn a_retried_release_waits_for_the_first_ones_change_to_be_kept() {
        let path = file();
        let mut holds = Holds::new(path.clone(), Ownership::detached());
        holds.set("turn".into(), None);
        holds.write(0).await.unwrap();

        FAILPOINTS.lock().unwrap().push((path.clone(), "staged"));
        assert!(holds.remove("turn"));
        let failed = holds.write(0).await;
        FAILPOINTS
            .lock()
            .unwrap()
            .retain(|(failing, _)| failing != &path);
        assert!(failed.is_err());
        let (on_disk, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(on_disk.named().count(), 1, "the failed release left it");

        assert!(!holds.remove("turn"));
        holds.flush().await.unwrap();
        let (on_disk, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(on_disk.named().count(), 0, "the retry kept the release");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// Once a removed sandbox's writer is closed, a write still pending
    /// never lands, so it cannot replace the holds of a sandbox made later
    /// under the same id; a write in progress finishes before the close.
    #[tokio::test]
    async fn a_closed_writer_never_writes_again() {
        let path = file();
        let mut old = Holds::new(path.clone(), Ownership::detached());
        old.set("old".into(), None);
        let pending = old.write(0);
        old.close().await;
        assert_eq!(pending.await.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!path.exists());

        let mut new = Holds::new(path.clone(), Ownership::detached());
        new.set("new".into(), None);
        new.write(0).await.unwrap();
        assert!(old.write(0).await.is_err());
        let (on_disk, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(on_disk.named().collect::<Vec<_>>(), [("new", None)]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// A write whose caller stopped waiting still keeps the writer until
    /// it lands, so closing the writer waits for it, and nothing lands
    /// once the close has resolved.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_nobody_waits_for_still_holds_the_writer_until_it_lands() {
        let path = file();
        let mut holds = Holds::new(path.clone(), Ownership::detached());
        holds.set("old".into(), None);
        let (started, release) = pause(&path);
        let write = tokio::spawn(holds.write(0));
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        write.abort();
        assert!(write.await.unwrap_err().is_cancelled());

        let closing = tokio::spawn(holds.close());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!closing.is_finished(), "closed under a write in flight");
        release.send(()).unwrap();
        closing.await.unwrap();
        let (on_disk, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(on_disk.named().collect::<Vec<_>>(), [("old", None)]);

        holds.set("later".into(), None);
        assert!(holds.write(0).await.is_err());
        let (on_disk, _) = Holds::load(path.clone(), 0, Ownership::detached());
        assert_eq!(on_disk.named().collect::<Vec<_>>(), [("old", None)]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// An agent that stops while a holds write is in flight keeps its
    /// state root until the write lands: a successor that took the root
    /// earlier could load the holds, acknowledge a new one, and then have
    /// the old write replace it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_successor_takes_the_root_only_after_the_last_write_lands() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("state");
        let (records, _) = Records::open(root.clone(), Duration::from_millis(100), None)
            .await
            .unwrap();
        let path = dir.path().join("holds.json");
        let mut holds = Holds::new(path.clone(), records.ownership());
        holds.set("old".into(), None);
        let (started, release) = pause(&path);
        let write = tokio::spawn(holds.write(0));
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        write.abort();
        assert!(write.await.unwrap_err().is_cancelled());
        drop(holds);
        drop(records);

        let early = Records::open(root.clone(), Duration::from_millis(100), None).await;
        assert!(
            matches!(early, Err(StateError::Locked(_))),
            "a successor took the root under a write in flight"
        );
        release.send(()).unwrap();
        let (successor, _) = Records::open(root, Duration::from_secs(10), None)
            .await
            .unwrap();
        let (mut loaded, _) = Holds::load(path.clone(), 0, successor.ownership());
        assert_eq!(loaded.named().collect::<Vec<_>>(), [("old", None)]);
        loaded.set("new".into(), None);
        loaded.write(0).await.unwrap();
        let (on_disk, _) = Holds::load(path, 0, Ownership::detached());
        assert_eq!(on_disk.named().count(), 2, "the successor's hold was kept");
    }
}
