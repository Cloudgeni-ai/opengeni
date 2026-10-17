//! The host's copies of sandbox images (ADR 19), by id.
//!
//! ```text
//! <root>/rootfs/
//!   <id>.ext4            an image, whole and checked against its id
//!   <id>.ext4.fetching   one being fetched; removed on start
//! ```
//!
//! A create that names an image the host does not have fetches it from the
//! store first: into a staging name, checked against its id, synced, then
//! renamed into place, so a file under its final name is always whole. One
//! fetch runs per image; other creates of it wait for that one. New disks
//! are copies of the image (a shared-extent clone where the file system has
//! them), as from the host's base image.
//!
//! A file's modified time is when a create last used it. An image no
//! create used for as long as a template may go unused, that no template
//! is being built or kept from, is removed. A create holds the image's lock
//! from the check until its copy is made, and a removal takes the same lock
//! and looks at the time again, so an image is never removed under a
//! create that is copying it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::layout::{remove_if_present, sync_parent};
use crate::protocol::ImageId;
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
pub(crate) struct Held {
    pub path: PathBuf,
    _lock: OwnedMutexGuard<()>,
}

/// The host's images.
#[derive(Debug)]
pub(crate) struct Cache {
    dir: PathBuf,
    /// The images the directory holds whole.
    present: Mutex<HashSet<ImageId>>,
    /// One lock per image, taken by its fetch, its copies and its removal.
    locks: Mutex<HashMap<ImageId, Arc<AsyncMutex<()>>>>,
    /// How long an image may go unused before it is removed.
    unused_after: Duration,
}

impl Cache {
    /// The images under `dir`. Removes what fetches an earlier agent left.
    /// Blocks.
    pub fn open(dir: PathBuf, unused_after: Duration) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let mut present = HashSet::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(FETCHING) {
                remove_if_present(&entry.path())?;
            } else if let Some(image) = name
                .strip_suffix(SUFFIX)
                .and_then(|id| id.parse::<ImageId>().ok())
            {
                present.insert(image);
            }
        }
        Ok(Self {
            dir,
            present: Mutex::new(present),
            locks: Mutex::default(),
            unused_after,
        })
    }

    /// Where the image `image` is kept.
    pub fn path(&self, image: ImageId) -> PathBuf {
        self.dir.join(format!("{image}{SUFFIX}"))
    }

    /// Whether the host has `image`, without waiting for anything.
    pub fn has(&self, image: ImageId) -> bool {
        self.present
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&image)
    }

    fn lock(&self, image: ImageId) -> Arc<AsyncMutex<()>> {
        Arc::clone(
            self.locks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(image)
                .or_default(),
        )
    }

    /// The image `image`, fetched from `store` first if the host does not
    /// have it, and marked used now.
    pub async fn get<S: Store>(&self, image: ImageId, store: &S) -> Result<Held, Missing> {
        let lock = self.lock(image).lock_owned().await;
        let path = self.path(image);
        let failed = |error: String| Missing::Failed { image, error };
        if !self.has(image) {
            let staging = self.dir.join(format!("{image}{FETCHING}"));
            let fetched = match blocking({
                let staging = staging.clone();
                move || remove_if_present(&staging)
            })
            .await
            {
                Ok(()) => store.fetch_image(image, &staging).await,
                Err(error) => return Err(failed(error.to_string())),
            };
            let found = matches!(fetched, Ok(true));
            let placed = blocking({
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
        // Only the retirement clock depends on it.
        let marked = blocking({
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
        Ok(Held { path, _lock: lock })
    }

    /// Removes the images no create used for long, except those in `keep`.
    /// Returns the ones removed.
    pub async fn retire(&self, keep: &HashSet<ImageId>, now: SystemTime) -> Vec<ImageId> {
        let present: Vec<ImageId> = self
            .present
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .copied()
            .filter(|image| !keep.contains(image))
            .collect();
        let mut removed = Vec::new();
        for image in present {
            // A create holding it is using it.
            let Ok(_lock) = self.lock(image).try_lock_owned() else {
                continue;
            };
            let path = self.path(image);
            let used = blocking({
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
            match blocking(move || remove_if_present(&path)).await {
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

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| Err(io::Error::other(error)))
}

#[cfg(test)]
mod tests;
