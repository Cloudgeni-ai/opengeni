//! Sandbox images saved from sandboxes
//! ([`Request::Capture`](crate::protocol::Request::Capture), ADR 22).
//!
//! The agent copies a saved sandbox's disk beside it, sharing its blocks
//! (see the agent's `capture`), and this stores the copy as a sandbox
//! image in the background, then deletes it. An ask is answered at once,
//! so no call stays open while a large disk is stored: the first copies
//! and starts the store, and every ask with the same key until it ends
//! hears that it is under way. A stored capture is the answer to every
//! later ask with its key for a while; a failed one is told to the next
//! ask, and the one after that copies again.
//!
//! Copies live under the state root, on the same file system as the disks
//! they share blocks with. They are scratch: a restarted agent deletes
//! every copy an earlier one left, and an ask with its key copies again.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::protocol::ImageId;
use crate::rootfs::Keeps;
use crate::store::Store;

/// How long a stored capture's answer is kept for asks with its key.
const ANSWERED_FOR: Duration = Duration::from_secs(3600);

/// How an ask stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureProgress {
    /// The copy is being stored.
    Capturing,
    /// The copy is stored as this image, of this many bytes.
    Captured { image: ImageId, length: u64 },
}

#[derive(Debug)]
enum Standing {
    /// One ask is copying the disk.
    Copying,
    /// The copy is being stored.
    Storing,
    Stored {
        image: ImageId,
        length: u64,
        at: Instant,
    },
    Failed(String),
}

/// What the next ask with a key does.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Begun {
    /// Copy the disk to [`Captures::path`], then report how it went.
    Copy,
    /// Answer this: the key's capture is under way or stored.
    Known(CaptureProgress),
    /// Answer this failure: the key's last store failed. The next ask
    /// copies again.
    Failed(String),
}

/// The captures a host stores.
pub(crate) struct Captures {
    keeps: Arc<dyn Keeps>,
    dir: PathBuf,
    standing: Mutex<HashMap<String, Standing>>,
}

impl std::fmt::Debug for Captures {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Captures")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

/// Where captures are copied under the state root `root`.
pub(crate) fn capture_dir(root: &Path) -> PathBuf {
    root.join("capture")
}

impl Captures {
    /// The captures of a host whose state root is `root`, into `store`:
    /// none without a store to keep images in. Deletes every copy an
    /// earlier agent left.
    ///
    /// # Errors
    ///
    /// When the copies' directory cannot be emptied or made.
    pub(crate) fn of<S: Store>(root: &Path, store: &Arc<S>) -> io::Result<Option<Arc<Self>>> {
        if !store.is_configured() {
            return Ok(None);
        }
        let keeps: Arc<dyn Keeps> = Arc::clone(store) as Arc<dyn Keeps>;
        Self::with(capture_dir(root), keeps).map(|captures| Some(Arc::new(captures)))
    }

    fn with(dir: PathBuf, keeps: Arc<dyn Keeps>) -> io::Result<Self> {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            keeps,
            dir,
            standing: Mutex::default(),
        })
    }

    /// Where the capture `key` copies its disk. Keys are checked by
    /// [`crate::protocol::valid_capture_key`], so this names a file in the
    /// copies' directory and nowhere else.
    pub(crate) fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.ext4"))
    }

    /// What an ask with `key` does; with [`Begun::Copy`] the caller copies
    /// and must then call [`Captures::copied`] or [`Captures::not_copied`].
    pub(crate) fn begin(&self, key: &str) -> Begun {
        let mut standing = self.standing.lock().unwrap_or_else(PoisonError::into_inner);
        standing.retain(|_, stood| {
            !matches!(stood, Standing::Stored { at, .. } if at.elapsed() >= ANSWERED_FOR)
        });
        match standing.get(key) {
            Some(Standing::Copying | Standing::Storing) => Begun::Known(CaptureProgress::Capturing),
            Some(Standing::Stored { image, length, .. }) => {
                Begun::Known(CaptureProgress::Captured {
                    image: *image,
                    length: *length,
                })
            }
            Some(Standing::Failed(_)) => match standing.remove(key) {
                Some(Standing::Failed(message)) => Begun::Failed(message),
                _ => unreachable!("the entry was read under the same lock"),
            },
            None => {
                standing.insert(key.to_owned(), Standing::Copying);
                Begun::Copy
            }
        }
    }

    /// The copy for `key` could not be made: the next ask tries again.
    pub(crate) fn not_copied(&self, key: &str) {
        let mut standing = self.standing.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(standing.get(key), Some(Standing::Copying)) {
            standing.remove(key);
        }
        drop(standing);
        remove_copy(&self.path(key));
    }

    /// The copy for `key`, `length` bytes, is made: stores it in the
    /// background, then deletes it.
    pub(crate) fn copied(self: &Arc<Self>, key: &str, length: u64) {
        self.set(key, Standing::Storing);
        let this = Arc::clone(self);
        let key = key.to_owned();
        tokio::spawn(async move {
            let path = this.path(&key);
            let started = Instant::now();
            let stood = match this.keeps.keep(&path).await {
                Ok(Some(image)) => {
                    tracing::info!(
                        %key,
                        %image,
                        length,
                        seconds = started.elapsed().as_secs_f64(),
                        "stored a sandbox's disk as an image"
                    );
                    Standing::Stored {
                        image,
                        length,
                        at: Instant::now(),
                    }
                }
                Ok(None) => Standing::Failed("this host's store keeps no images".into()),
                Err(error) => {
                    tracing::warn!(%key, %error, "storing a sandbox's disk as an image failed");
                    Standing::Failed(error.to_string())
                }
            };
            let removed = path.clone();
            let _ = tokio::task::spawn_blocking(move || remove_copy(&removed)).await;
            this.set(&key, stood);
        });
    }

    fn set(&self, key: &str, stood: Standing) {
        self.standing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.to_owned(), stood);
    }
}

fn remove_copy(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "deleting a capture's copy failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use compute_engine::{EngineError, ErrorKind};
    use futures::future::BoxFuture;

    use super::*;

    /// Stores by hashing the file's first byte, or fails while `fail` is
    /// set, counting stores.
    struct Fake {
        stores: AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
    }

    impl Keeps for Fake {
        fn keep<'a>(
            &'a self,
            path: &'a Path,
        ) -> BoxFuture<'a, Result<Option<ImageId>, EngineError>> {
            Box::pin(async move {
                self.stores.fetch_add(1, Ordering::SeqCst);
                if self.fail.load(Ordering::SeqCst) {
                    return Err(EngineError::new(ErrorKind::Fatal, "store", "full"));
                }
                let bytes = std::fs::read(path).map_err(|error| EngineError::io("read", error))?;
                Ok(Some(ImageId([bytes[0]; 32])))
            })
        }
    }

    async fn settled(captures: &Captures, key: &str) -> Begun {
        for _ in 0..200 {
            let begun = captures.begin(key);
            if begun != Begun::Known(CaptureProgress::Capturing) {
                return begun;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the capture never settled");
    }

    #[tokio::test]
    async fn an_ask_copies_once_and_later_asks_learn_how_the_store_went() {
        let root = tempfile::tempdir().unwrap();
        let dir = capture_dir(root.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("left.ext4"), b"an earlier agent's copy").unwrap();
        let fake = Arc::new(Fake {
            stores: AtomicUsize::new(0),
            fail: false.into(),
        });
        let captures =
            Arc::new(Captures::with(dir.clone(), Arc::clone(&fake) as Arc<dyn Keeps>).unwrap());
        assert!(
            !dir.join("left.ext4").exists(),
            "copies left behind are deleted"
        );

        assert_eq!(captures.begin("k"), Begun::Copy);
        assert_eq!(
            captures.begin("k"),
            Begun::Known(CaptureProgress::Capturing),
            "a second ask while the first copies copies nothing"
        );
        std::fs::write(captures.path("k"), [9_u8; 4]).unwrap();
        captures.copied("k", 4);
        assert_eq!(
            settled(&captures, "k").await,
            Begun::Known(CaptureProgress::Captured {
                image: ImageId([9; 32]),
                length: 4
            })
        );
        assert_eq!(fake.stores.load(Ordering::SeqCst), 1);
        assert!(!captures.path("k").exists(), "the copy goes once stored");
        assert!(matches!(
            captures.begin("k"),
            Begun::Known(CaptureProgress::Captured { .. })
        ));

        // A copy that could not be made is tried again by the next ask.
        assert_eq!(captures.begin("other"), Begun::Copy);
        captures.not_copied("other");
        assert_eq!(captures.begin("other"), Begun::Copy);
    }

    #[tokio::test]
    async fn a_failed_store_is_told_once_then_copied_again() {
        let root = tempfile::tempdir().unwrap();
        let fake = Arc::new(Fake {
            stores: AtomicUsize::new(0),
            fail: true.into(),
        });
        let captures = Arc::new(
            Captures::with(
                capture_dir(root.path()),
                Arc::clone(&fake) as Arc<dyn Keeps>,
            )
            .unwrap(),
        );
        assert_eq!(captures.begin("k"), Begun::Copy);
        std::fs::write(captures.path("k"), [1_u8; 4]).unwrap();
        captures.copied("k", 4);
        assert!(
            matches!(settled(&captures, "k").await, Begun::Failed(message) if message.contains("full"))
        );
        assert!(
            !captures.path("k").exists(),
            "a failed store's copy goes too"
        );
        assert_eq!(captures.begin("k"), Begun::Copy, "the failure is told once");
    }
}
