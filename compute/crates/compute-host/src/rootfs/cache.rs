//! The host's copies of sandbox images (ADR 19), by id.
//!
//! ```text
//! <root>/rootfs/
//!   <id>.ext4                   an image, whole and checked against its id
//!   <id>.ext4.fetching.<n>      one being fetched; removed on start
//! ```
//!
//! A create that names an image the host does not have fetches it from the
//! store first: into a staging name of its own, checked against its id,
//! synced, then renamed into place, so a file under its final name is
//! always whole. One fetch runs per image; other creates of it wait for
//! that one. New disks are copies of the image (a shared-extent clone where
//! the file system has them), as from the host's base image.
//!
//! The cache alone vouches for what an image's file holds: nothing copies
//! one it has not checked, and nothing writes to one, so whoever needs to
//! know its content (a template's inputs) takes the id for it instead of
//! reading the file.
//!
//! The cache keeps a share of the state root's ownership, and so does every
//! piece of its work in flight, blocking work included: a fetch or removal
//! an agent started ends before a successor takes the root. A successor
//! still trusts no file by its name alone: an image an earlier agent left
//! is checked against its id the first time a create wants it, and removed
//! (then fetched again) if it does not match.
//!
//! A file's modified time is when a create last used it. An image no
//! create used for as long as a template may go unused, that no template
//! is being built or kept from, is removed. Every create or template build
//! shares the image's lock from the check until its copy is made, so any
//! number copy one image at once; its fetch, its first check and its
//! removal take the lock alone, and a removal looks at the time again, so
//! an image is never removed under a copy of it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{OwnedRwLockReadGuard, RwLock};

use crate::layout::{remove_if_present, sync_parent};
use crate::protocol::ImageId;
use crate::state::Ownership;
use crate::store::Store;

const SUFFIX: &str = ".ext4";
const FETCHING: &str = ".ext4.fetching";

/// Why an image could not be had.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Missing {
    /// Neither this host nor its store has it.
    #[error("no image {0} on this host or in its store")]
    Unknown(ImageId),
    /// The fetch failed; a later one may succeed.
    #[error("fetching image {image}: {error}")]
    Failed { image: ImageId, error: String },
}

/// An image a create may copy: it stays on the host while this is held.
/// Others may hold it too.
pub(crate) struct Held {
    pub path: PathBuf,
    _lock: OwnedRwLockReadGuard<()>,
}

/// The host's images.
#[derive(Debug)]
pub(crate) struct Cache {
    dir: PathBuf,
    /// The images the directory holds whole.
    present: Mutex<HashSet<ImageId>>,
    /// Images an earlier agent left, not checked against their ids yet.
    recovered: Mutex<HashSet<ImageId>>,
    /// One lock per image: shared by its copies, taken alone by its fetch,
    /// its first check and its removal.
    locks: Mutex<HashMap<ImageId, Arc<RwLock<()>>>>,
    /// How long an image may go unused before it is removed.
    unused_after: Duration,
    /// Kept by every piece of work in flight.
    owner: Ownership,
    /// Numbers staging names, with the time the cache opened.
    attempts: AtomicU64,
    opened: u128,
}

impl Cache {
    /// The images under `dir`, for the owner of the state root that
    /// `owner` shares. Removes what fetches an earlier agent left. Blocks.
    pub fn open(dir: PathBuf, unused_after: Duration, owner: Ownership) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let mut recovered = HashSet::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains(FETCHING) {
                remove_if_present(&entry.path())?;
            } else if let Some(image) = name
                .strip_suffix(SUFFIX)
                .and_then(|id| id.parse::<ImageId>().ok())
            {
                recovered.insert(image);
            }
        }
        Ok(Self {
            dir,
            present: Mutex::default(),
            recovered: Mutex::new(recovered),
            locks: Mutex::default(),
            unused_after,
            owner,
            attempts: AtomicU64::new(0),
            opened: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos()),
        })
    }

    /// A staging name no other fetch, of this agent or another, uses.
    fn staging(&self, image: ImageId) -> PathBuf {
        let attempt = self.attempts.fetch_add(1, Ordering::Relaxed);
        self.dir.join(format!(
            "{image}{FETCHING}.{}-{}-{attempt}",
            self.opened,
            std::process::id()
        ))
    }

    /// Runs `work` on a blocking thread, keeping the root's ownership
    /// until it ends, even if the task waiting for it is dropped.
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let owner = self.owner.clone();
        tokio::task::spawn_blocking(move || {
            let _owner = owner;
            work()
        })
        .await
        .unwrap_or_else(|error| Err(io::Error::other(error)))
    }

    /// Checks an image an earlier agent left against its id, once: it
    /// becomes present if it matches and is removed if not. Call under
    /// the image's lock, taken alone.
    async fn check_recovered(&self, image: ImageId) {
        if !self
            .recovered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&image)
        {
            return;
        }
        let path = self.path(image);
        let checked = self
            .blocking(move || {
                let mut hasher = blake3::Hasher::new();
                hasher.update_reader(io::BufReader::with_capacity(
                    1 << 20,
                    fs::File::open(&path)?,
                ))?;
                let matches = *hasher.finalize().as_bytes() == image.0;
                if !matches {
                    remove_if_present(&path)?;
                }
                Ok(matches)
            })
            .await;
        match checked {
            Ok(true) => {
                self.present
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(image);
            }
            Ok(false) => tracing::warn!(%image, "a kept image did not match its id; removed"),
            Err(error) => tracing::warn!(%image, %error, "could not check a kept image"),
        }
    }

    /// Where the image `image` is kept.
    pub fn path(&self, image: ImageId) -> PathBuf {
        self.dir.join(format!("{image}{SUFFIX}"))
    }

    /// Whether the host has `image`, checked, without waiting for
    /// anything.
    pub fn has(&self, image: ImageId) -> bool {
        self.present
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&image)
    }

    fn lock(&self, image: ImageId) -> Arc<RwLock<()>> {
        Arc::clone(
            self.locks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(image)
                .or_default(),
        )
    }

    /// The image's lock, shared, once the image is checked if an earlier
    /// agent left it: that first check takes the lock alone.
    async fn shared(&self, image: ImageId) -> OwnedRwLockReadGuard<()> {
        let lock = self.lock(image);
        // Only opening the cache adds to these, so one not among them now
        // never needs the check.
        let unchecked = self
            .recovered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&image);
        if unchecked {
            let alone = lock.write_owned().await;
            self.check_recovered(image).await;
            return alone.downgrade();
        }
        lock.read_owned().await
    }

    /// The image `image`, fetched from `store` first if the host does not
    /// have it, and marked used now.
    pub async fn get<S: Store>(&self, image: ImageId, store: &S) -> Result<Held, Missing> {
        let shared = self.shared(image).await;
        let path = self.path(image);
        if self.has(image) {
            return Ok(self.used(image, path, shared).await);
        }
        drop(shared);
        // One fetch runs per image: other creates of it wait here, then
        // find it present.
        let lock = self.lock(image).write_owned().await;
        let failed = |error: String| Missing::Failed { image, error };
        if !self.has(image) {
            let staging = self.staging(image);
            // Kept until the fetch's last write: the store writes into the
            // staging file.
            let owner = self.owner.clone();
            let fetched = store.fetch_image(image, &staging).await;
            let found = matches!(fetched, Ok(true));
            let placed = self
                .blocking({
                    let path = path.clone();
                    move || {
                        if found {
                            fs::rename(&staging, &path)?;
                            sync_parent(&path)
                        } else {
                            remove_if_present(&staging)
                        }
                    }
                })
                .await;
            drop(owner);
            match fetched {
                Ok(true) => placed.map_err(|error| failed(error.to_string()))?,
                Ok(false) => return Err(Missing::Unknown(image)),
                Err(error) => return Err(failed(error.to_string())),
            }
            self.present
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(image);
            tracing::info!(%image, "image fetched from the store");
        }
        Ok(self.used(image, path, lock.downgrade()).await)
    }

    /// The image `image` if the host has it, marked used now; never
    /// fetches.
    pub async fn hold(&self, image: ImageId) -> Option<Held> {
        let lock = self.shared(image).await;
        if !self.has(image) {
            return None;
        }
        Some(self.used(image, self.path(image), lock).await)
    }

    /// Marks the image at `path` used now and holds it with `lock`.
    async fn used(&self, image: ImageId, path: PathBuf, lock: OwnedRwLockReadGuard<()>) -> Held {
        // Only the retirement clock depends on it.
        let marked = self
            .blocking({
                let path = path.clone();
                move || {
                    fs::File::options()
                        .write(true)
                        .open(&path)?
                        .set_modified(SystemTime::now())
                }
            })
            .await;
        if let Err(error) = marked {
            tracing::warn!(%image, %error, "could not mark an image used");
        }
        Held { path, _lock: lock }
    }

    /// Removes the images no create used for long, except those in `keep`.
    /// Returns the ones removed.
    pub async fn retire(&self, keep: &HashSet<ImageId>, now: SystemTime) -> Vec<ImageId> {
        let present: Vec<ImageId> = {
            let present = self.present.lock().unwrap_or_else(PoisonError::into_inner);
            let recovered = self
                .recovered
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            present
                .union(&recovered)
                .copied()
                .filter(|image| !keep.contains(image))
                .collect()
        };
        let mut removed = Vec::new();
        for image in present {
            // A copy holding it is using it.
            let Ok(_lock) = self.lock(image).try_write_owned() else {
                continue;
            };
            let path = self.path(image);
            let used = self
                .blocking({
                    let path = path.clone();
                    move || fs::metadata(&path)?.modified()
                })
                .await;
            let unused = used.is_ok_and(|used| {
                now.duration_since(used)
                    .is_ok_and(|since| since >= self.unused_after)
            });
            if !unused {
                continue;
            }
            self.present
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&image);
            self.recovered
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&image);
            match self.blocking(move || remove_if_present(&path)).await {
                Ok(()) => {
                    tracing::info!(%image, "image unused for long; removed");
                    removed.push(image);
                }
                Err(error) => tracing::warn!(%image, %error, "could not remove an unused image"),
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests;
