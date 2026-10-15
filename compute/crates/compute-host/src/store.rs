//! Durable storage off the host, for the deepest sleep levels.
//!
//! Archiving copies a saved sandbox (its disk, plus its memory image if it
//! has one) somewhere that survives losing the host. The real store chunks,
//! compresses and deduplicates into object storage; [`Directory`] is a plain
//! directory used for tests and single-machine setups.

use std::fs;
use std::path::{Path, PathBuf};

use compute_engine::{EngineError, ErrorKind, SnapshotFiles};

use crate::layout::{copy_sparse, sync_file};
use crate::protocol::Id;

/// The local files that make up a saved sandbox.
#[derive(Clone, Debug)]
pub struct SavedFiles {
    /// The root disk.
    pub disk: PathBuf,
    /// The memory image, when the sandbox has one.
    pub memory: Option<SnapshotFiles>,
}

/// Somewhere that keeps sandboxes when the host does not.
pub trait Store: Send + Sync + 'static {
    /// Whether this store can hold anything. A host without one rejects
    /// sleep ladders that reach [`compute_core::Level::Archived`].
    fn is_configured(&self) -> bool {
        true
    }

    /// Copies `files` to the store, replacing any older copy, and returns
    /// only once the copy is durable.
    fn archive(
        &self,
        id: Id,
        files: &SavedFiles,
    ) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Copies the stored sandbox back into `files`.
    fn fetch(
        &self,
        id: Id,
        files: &SavedFiles,
    ) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Deletes the stored copy; succeeds when there is none.
    fn delete(&self, id: Id) -> impl Future<Output = Result<(), EngineError>> + Send;
}

/// No store: sandboxes never leave the host.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoStore;

impl Store for NoStore {
    fn is_configured(&self) -> bool {
        false
    }

    async fn archive(&self, _: Id, _: &SavedFiles) -> Result<(), EngineError> {
        Err(EngineError::new(
            ErrorKind::Fatal,
            "archive",
            "no store configured",
        ))
    }

    async fn fetch(&self, _: Id, _: &SavedFiles) -> Result<(), EngineError> {
        Err(EngineError::new(
            ErrorKind::Fatal,
            "fetch",
            "no store configured",
        ))
    }

    async fn delete(&self, _: Id) -> Result<(), EngineError> {
        Ok(())
    }
}

/// A store in a local directory, one subdirectory per sandbox.
#[derive(Clone, Debug)]
pub struct Directory {
    root: PathBuf,
}

impl Directory {
    /// Keeps sandboxes under `root`.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn dir(&self, id: Id) -> PathBuf {
        self.root.join(id.to_string())
    }
}

fn pairs(stored: &Path, files: &SavedFiles) -> Vec<(PathBuf, PathBuf)> {
    let mut pairs = vec![(files.disk.clone(), stored.join("disk"))];
    if let Some(memory) = &files.memory {
        pairs.push((memory.state.clone(), stored.join("state")));
        pairs.push((memory.memory.clone(), stored.join("memory")));
    }
    pairs
}

async fn blocking(
    operation: &'static str,
    work: impl FnOnce() -> std::io::Result<()> + Send + 'static,
) -> Result<(), EngineError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, operation, error))?
        .map_err(|error| EngineError::io(operation, error))
}

impl Store for Directory {
    async fn archive(&self, id: Id, files: &SavedFiles) -> Result<(), EngineError> {
        let stored = self.dir(id);
        let pairs = pairs(&stored, files);
        blocking("archive", move || {
            // Write a fresh copy beside the old one, then swap, so a crash
            // never leaves a half-written archive in place.
            let staging = stored.with_extension("staging");
            if staging.exists() {
                fs::remove_dir_all(&staging)?;
            }
            fs::create_dir_all(&staging)?;
            for (local, remote) in &pairs {
                let remote = staging.join(remote.file_name().unwrap_or_default());
                copy_sparse(local, &remote)?;
            }
            sync_file(&staging)?;
            if stored.exists() {
                fs::remove_dir_all(&stored)?;
            }
            fs::rename(&staging, &stored)?;
            sync_file(stored.parent().unwrap_or(&stored))
        })
        .await
    }

    async fn fetch(&self, id: Id, files: &SavedFiles) -> Result<(), EngineError> {
        let pairs = pairs(&self.dir(id), files);
        blocking("fetch", move || {
            for (local, remote) in &pairs {
                copy_sparse(remote, local)?;
            }
            Ok(())
        })
        .await
    }

    async fn delete(&self, id: Id) -> Result<(), EngineError> {
        let stored = self.dir(id);
        blocking("delete", move || match fs::remove_dir_all(&stored) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        })
        .await
    }
}
