//! Durable storage off the host, for the deepest sleep levels.
//!
//! Archiving copies a saved sandbox (its disk, plus its memory image if it
//! has one) somewhere that survives losing the host. The real store chunks,
//! compresses and deduplicates into object storage; [`Directory`] is a plain
//! directory used for tests and single-machine setups.
//!
//! An archive returns a [`Receipt`] naming exactly the copy it stored. The
//! host deletes its local files only after [`Store::verify`] confirms the
//! store still holds that copy: the local files may be the only good copy.

use std::fs;
use std::future::ready;
use std::path::PathBuf;
use std::sync::Arc;

use compute_engine::{EngineError, ErrorKind};
use compute_storage::store::ChunkStore;
use serde::{Deserialize, Serialize};

use crate::layout::{copy_sparse, sync_file};
use crate::protocol::Id;

/// A memory image as the store sees it.
#[derive(Clone, Debug)]
pub struct SavedImage {
    /// Processor and device state.
    pub state: PathBuf,
    /// Guest memory, sparse.
    pub memory: PathBuf,
    /// BLAKE3 of each 256 KiB chunk of `memory` (all zeros for a chunk of
    /// zeros), when known: chunks whose hash matches the stored copy are
    /// then neither read nor uploaded again.
    pub chunks: Option<Arc<Vec<[u8; 32]>>>,
}

/// The local files that make up a saved sandbox.
#[derive(Clone, Debug)]
pub struct SavedFiles {
    /// The root disk.
    pub disk: PathBuf,
    /// The memory image, when the sandbox has one.
    pub memory: Option<SavedImage>,
    /// The learned order in which the guest touches memory after a wake,
    /// when one exists.
    pub profile: Option<PathBuf>,
}

/// Names one stored copy of a sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt(pub String);

/// Where a fetch puts what it brings back.
#[derive(Clone, Debug)]
pub struct FetchInto {
    /// The root disk, replaced whole.
    pub disk: PathBuf,
    /// An empty directory for the memory image's files.
    pub scratch: PathBuf,
    /// Where the learned wake profile goes, if the copy has one.
    pub profile: PathBuf,
    /// Whether to bring back the memory image.
    pub memory: bool,
    /// A local file the disk was probably created from, such as the host's
    /// base image: a store may copy chunks that match it at the same offset
    /// instead of downloading them.
    pub seed: Option<PathBuf>,
}

/// The memory image a fetch brought back.
#[derive(Debug)]
pub enum FetchedMemory {
    /// No memory image was asked for.
    None,
    /// Complete files in the scratch directory.
    Local { state: PathBuf, memory: PathBuf },
    /// The state, in the scratch directory; memory stays in the store, to be
    /// paged in as the guest touches it.
    Remote {
        state: PathBuf,
        memory_len: u64,
        /// Per-chunk hashes, as in [`SavedImage::chunks`].
        chunks: Vec<[u8; 32]>,
        /// The stored memory manifest (JSON), from which the chunks come.
        manifest: Vec<u8>,
    },
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
    ) -> impl Future<Output = Result<Receipt, EngineError>> + Send;

    /// Whether the store still holds, intact, exactly the copy `receipt`
    /// names. Only `Ok(true)` permits deleting the local files.
    fn verify(
        &self,
        id: Id,
        receipt: &Receipt,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send;

    /// Copies the stored sandbox back as `into` says.
    fn fetch(
        &self,
        id: Id,
        into: &FetchInto,
    ) -> impl Future<Output = Result<FetchedMemory, EngineError>> + Send;

    /// Deletes the stored copy; succeeds when there is none.
    fn delete(&self, id: Id) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// The chunk store that remote memory images page in from, if this store
    /// keeps memory as chunks.
    fn chunks(&self) -> Option<&ChunkStore> {
        None
    }
}

/// No store: sandboxes never leave the host.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoStore;

fn unconfigured<T>(operation: &'static str) -> Result<T, EngineError> {
    Err(EngineError::new(
        ErrorKind::Fatal,
        operation,
        "no store configured",
    ))
}

impl Store for NoStore {
    fn is_configured(&self) -> bool {
        false
    }

    fn archive(
        &self,
        _: Id,
        _: &SavedFiles,
    ) -> impl Future<Output = Result<Receipt, EngineError>> + Send {
        ready(unconfigured("archive"))
    }

    fn verify(&self, _: Id, _: &Receipt) -> impl Future<Output = Result<bool, EngineError>> + Send {
        ready(Ok(false))
    }

    fn fetch(
        &self,
        _: Id,
        _: &FetchInto,
    ) -> impl Future<Output = Result<FetchedMemory, EngineError>> + Send {
        ready(unconfigured("fetch"))
    }

    fn delete(&self, _: Id) -> impl Future<Output = Result<(), EngineError>> + Send {
        ready(Ok(()))
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

const RECEIPT: &str = "receipt";

async fn blocking<T: Send + 'static>(
    operation: &'static str,
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, EngineError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, operation, error))?
        .map_err(|error| EngineError::io(operation, error))
}

impl Store for Directory {
    async fn archive(&self, id: Id, files: &SavedFiles) -> Result<Receipt, EngineError> {
        let stored = self.dir(id);
        let mut pairs = vec![(files.disk.clone(), "disk")];
        if let Some(memory) = &files.memory {
            pairs.push((memory.state.clone(), "state"));
            pairs.push((memory.memory.clone(), "memory"));
        }
        if let Some(profile) = &files.profile {
            pairs.push((profile.clone(), "profile"));
        }
        blocking("archive", move || {
            // Write a fresh copy beside the old one, then swap, so a crash
            // never leaves a half-written archive in place.
            let staging = stored.with_extension("staging");
            let old = stored.with_extension("old");
            for leftover in [&staging, &old] {
                if leftover.exists() {
                    fs::remove_dir_all(leftover)?;
                }
            }
            fs::create_dir_all(&staging)?;
            let mut summary = blake3::Hasher::new();
            for (local, name) in &pairs {
                copy_sparse(local, &staging.join(name))?;
                summary.update(name.as_bytes());
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos());
            summary.update(&nanos.to_le_bytes());
            let receipt = summary.finalize().to_hex().to_string();
            fs::write(staging.join(RECEIPT), &receipt)?;
            sync_file(&staging.join(RECEIPT))?;
            sync_file(&staging)?;
            if stored.exists() {
                fs::rename(&stored, &old)?;
            }
            fs::rename(&staging, &stored)?;
            sync_file(stored.parent().unwrap_or(&stored))?;
            if old.exists() {
                fs::remove_dir_all(&old)?;
            }
            Ok(Receipt(receipt))
        })
        .await
    }

    async fn verify(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
        let stored = self.dir(id);
        let expected = receipt.0.clone();
        blocking("verify", move || {
            Ok(
                fs::read_to_string(stored.join(RECEIPT)).is_ok_and(|found| found == expected)
                    && stored.join("disk").exists(),
            )
        })
        .await
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        let stored = self.dir(id);
        let into = into.clone();
        blocking("fetch", move || {
            let staging = into.disk.with_extension("fetching");
            copy_sparse(&stored.join("disk"), &staging)?;
            fs::rename(&staging, &into.disk)?;
            if stored.join("profile").exists() {
                copy_sparse(&stored.join("profile"), &into.profile)?;
            }
            if !into.memory {
                return Ok(FetchedMemory::None);
            }
            if !stored.join("memory").exists() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "the stored copy has no memory image",
                ));
            }
            fs::create_dir_all(&into.scratch)?;
            let state = into.scratch.join("state");
            let memory = into.scratch.join("memory");
            copy_sparse(&stored.join("state"), &state)?;
            copy_sparse(&stored.join("memory"), &memory)?;
            Ok(FetchedMemory::Local { state, memory })
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
