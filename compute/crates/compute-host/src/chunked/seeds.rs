//! The chunk hashes of the local files fetched disks start from (the host's
//! base image and the sandbox images it keeps), so a fetch downloads only
//! the chunks that differ from them.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};
use std::time::SystemTime;

use tokio::sync::Mutex;

use super::hash_from_hex;
use crate::image::{Hash, chunk_count, hash_chunks};

/// What identifies one version of a local file: if any of it changes, the
/// file's chunk hashes must be computed again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    device: u64,
    inode: u64,
    len: u64,
    modified: Option<SystemTime>,
}

impl Identity {
    pub(super) fn of(path: &Path) -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(path)?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

/// A local file a fetched disk probably shares most of its chunks with, at
/// the same offsets, and the hash of each of its chunks.
#[derive(Debug)]
pub(super) struct Seed {
    pub(super) path: PathBuf,
    pub(super) identity: Identity,
    pub(super) hashes: Vec<Hash>,
}

impl Seed {
    pub(super) fn compute(path: &Path) -> io::Result<Self> {
        let identity = Identity::of(path)?;
        let file = File::open(path)?;
        let indices: Vec<usize> = (0..chunk_count(identity.len)).collect();
        let hashes = hash_chunks(&file, identity.len, &indices)?;
        if Identity::of(path)? != identity {
            return Err(io::Error::other("the file changed while it was hashed"));
        }
        Ok(Self {
            path: path.to_owned(),
            identity,
            hashes,
        })
    }

    /// Whether chunk `index` of the seed holds exactly `hash`.
    pub(super) fn holds(&self, index: usize, hash: &str) -> bool {
        self.hashes
            .get(index)
            .zip(hash_from_hex(hash).ok())
            .is_some_and(|(held, wanted)| *held == wanted)
    }
}

/// The chunk hashes of each local file disks are fetched over (the host's
/// base image and each sandbox image it keeps), computed at most once per
/// version of the file however many fetches ask at once. One file's
/// hashing never holds up fetches over another, and the hashes of a file
/// that is gone (an image retired) are dropped by the next fetch.
#[derive(Debug, Default)]
pub(super) struct Seeds {
    pub(super) by_path: std::sync::Mutex<HashMap<PathBuf, SeedSlot>>,
}

/// Where the hashes of one file are kept, once taken.
type SeedSlot = Arc<Mutex<Option<Arc<Seed>>>>;

impl Seeds {
    /// The hashes of `path` as it is now, from `compute` (which blocks) if
    /// none were taken of this version of it. `None` if it cannot be read.
    pub(super) async fn get(
        &self,
        path: &Path,
        compute: impl FnOnce(&Path) -> io::Result<Seed> + Send + 'static,
    ) -> Option<Arc<Seed>> {
        let slot = {
            let mut by_path = self.by_path.lock().unwrap_or_else(PoisonError::into_inner);
            // A slot no fetch holds, for a file that is gone, keeps nothing
            // anyone can use again. There are only as many as the host has
            // had images since the last fetch.
            by_path
                .retain(|held, slot| held == path || Arc::strong_count(slot) > 1 || held.exists());
            Arc::clone(by_path.entry(path.to_owned()).or_default())
        };
        let mut cached = slot.lock().await;
        let current = match Identity::of(path) {
            Ok(current) => current,
            Err(error) => {
                // Gone (an image retired): nothing more to keep for it.
                drop(cached);
                self.forget(path, &slot);
                tracing::debug!(path = %path.display(), %error, "no seed to fetch over");
                return None;
            }
        };
        if let Some(seed) = cached.as_ref()
            && seed.identity == current
        {
            return Some(Arc::clone(seed));
        }
        *cached = None;
        let owned = path.to_owned();
        match tokio::task::spawn_blocking(move || compute(&owned)).await {
            Ok(Ok(seed)) => {
                let seed = Arc::new(seed);
                *cached = Some(Arc::clone(&seed));
                Some(seed)
            }
            Ok(Err(error)) => {
                tracing::warn!(path = %path.display(), %error, "base image unreadable; downloading whole disks");
                None
            }
            Err(error) => {
                tracing::warn!(%error, "hashing the base image failed");
                None
            }
        }
    }

    /// Drops the slot for `path` if it is still `slot`.
    fn forget(&self, path: &Path, slot: &SeedSlot) {
        let mut by_path = self.by_path.lock().unwrap_or_else(PoisonError::into_inner);
        if by_path
            .get(path)
            .is_some_and(|held| Arc::ptr_eq(held, slot))
        {
            by_path.remove(path);
        }
    }
}
