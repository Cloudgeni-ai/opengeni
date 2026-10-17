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
//!
//! Every write names its owner: the sandbox's owner epoch, raised each time
//! it changes hands between hosts, and for an archive the owner's number
//! for the save ([ADR 18](../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
//! A store refuses a write once a later owner holds the copy, so a host the
//! fleet gave up on can never overwrite what the next one stored.

use std::fmt::Write as _;
use std::fs::{self, File};
use std::future::ready;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
pub use compute_fleet::{OwnerEpoch, Stamp};
use compute_storage::store::ChunkStore;
use serde::{Deserialize, Serialize};

use crate::lanes::Lanes;
use crate::layout::{copy_file, copy_sparse, sync_file};
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
    /// The runtime that made it, if known ([`compute_engine::Engine::runtime`]),
    /// kept with the copy so a fetched image still says.
    pub runtime: Option<String>,
}

/// A file in a VM's jail. Its VMM can put a link to a host file or a pipe
/// in its place at any time, so it is only read through
/// [`JailedFile::open`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JailedFile(PathBuf);

impl JailedFile {
    /// The file at `path`, inside a VM's jail.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    /// Opens it for reading without following a link or blocking on a
    /// pipe, and only if it is a regular file with no other name.
    ///
    /// # Errors
    ///
    /// It is anything else, or opening it fails.
    pub fn open(&self) -> io::Result<File> {
        crate::layout::open_jailed(&self.0)
    }

    /// Where it is, for messages.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// The local files that make up a saved sandbox.
#[derive(Clone, Debug)]
pub struct SavedFiles {
    /// The root disk, in the sandbox's jail.
    pub disk: JailedFile,
    /// The memory image, when the sandbox has one.
    pub memory: Option<SavedImage>,
    /// The learned order in which the guest touches memory after a wake,
    /// when one exists.
    pub profile: Option<PathBuf>,
}

/// Names one stored copy of a sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt(pub String);

/// What an archive came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Archive {
    /// The copy is durable in the store and named by the receipt. An
    /// archive of a save the store already holds, as one whose answer was
    /// lost and that is tried again, finds it stored.
    Stored(Receipt),
    /// Cancelled before anything was published: the store's earlier copy,
    /// if any, is still the one it names.
    Cancelled,
    /// The store holds a later change by the same owner: this save
    /// changes nothing.
    Outdated,
    /// The sandbox was deleted: nothing of it is archived again.
    Deleted,
    /// A later owner holds the copy: the sandbox is no longer this host's.
    Fenced {
        /// The owner epoch that holds it.
        by: OwnerEpoch,
    },
}

impl Archive {
    /// The receipt, unless the archive stored nothing.
    #[must_use]
    pub fn stored(self) -> Option<Receipt> {
        match self {
            Self::Stored(receipt) => Some(receipt),
            Self::Cancelled | Self::Outdated | Self::Deleted | Self::Fenced { .. } => None,
        }
    }
}

/// What a write that changes the stored copy came to (see
/// [`Store::forget_memory`] and [`Store::delete`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owned<T> {
    /// It was carried out.
    Done(T),
    /// A later owner holds the copy, which stays as that owner stored it.
    Fenced {
        /// The owner epoch that holds it.
        by: OwnerEpoch,
    },
}

/// A stored copy a new owner took over (see [`Store::claim`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claimed {
    /// The number of the save it holds, which the new owner counts on from.
    pub save: u64,
    /// Names the copy, as an archive's receipt does.
    pub receipt: Receipt,
    /// Whether it holds a memory image.
    pub memory: bool,
}

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
    Local {
        state: PathBuf,
        memory: PathBuf,
        /// The runtime that made the image, as archived.
        runtime: Option<String>,
    },
    /// The state, in the scratch directory; memory stays in the store, to be
    /// paged in as the guest touches it.
    Remote {
        state: PathBuf,
        memory_len: u64,
        /// Per-chunk hashes, as in [`SavedImage::chunks`].
        chunks: Vec<[u8; 32]>,
        /// The stored memory manifest (JSON), from which the chunks come.
        manifest: Vec<u8>,
        /// What the fetch brought back of memory already: the working set
        /// the guest touched first after its last wake.
        prefilled: Option<Prefilled>,
        /// The runtime that made the image, as archived.
        runtime: Option<String>,
    },
}

/// Part of a memory image brought back ahead of the rest.
#[derive(Debug)]
pub struct Prefilled {
    /// A file of the image's full length, in the scratch directory, holding
    /// the image's bytes in `pages` and zeros elsewhere.
    pub memory: PathBuf,
    /// The byte ranges filled, sorted, disjoint and 4 KiB-aligned.
    pub pages: Vec<std::ops::Range<u64>>,
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
    ///
    /// `save` is the owner's epoch and its number for this save, higher
    /// than any it archived before: the copy replaces only an earlier save
    /// of the same owner, or one of an earlier owner.
    ///
    /// `cancel` is checked between pieces of work. Once it is seen, nothing
    /// more is started, nothing is published, and [`Archive::Cancelled`] is
    /// returned after the work already under way has finished, so nothing
    /// is still writing when the call returns. A cancel that comes after the
    /// copy was published is too late and changes nothing.
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send;

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

    /// Deletes the stored copy as its owner under `own`; succeeds when there
    /// is none. Refused once a later owner holds it.
    fn delete(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<()>, EngineError>> + Send;

    /// Takes the stored copy over as its owner under `own`, a later epoch
    /// than any that wrote it, so no archive a former owner still has in
    /// flight can replace it. `None` when there is no copy. Taking over a
    /// copy this owner already holds changes nothing.
    fn claim(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send;

    /// The chunk store that remote memory images page in from, if this store
    /// keeps memory as chunks, and the host's transfer lanes, which the
    /// agent's own fetches from it share with the store's.
    fn chunks(&self) -> Option<(&ChunkStore, &Arc<Lanes>)> {
        None
    }

    /// Deletes the memory image from the stored copy and keeps its disk,
    /// as the change `change` of its owner: a number no other change of
    /// that owner has used, which the copy carries afterwards, so a try
    /// whose answer was lost finds itself done and an archive begun
    /// earlier no longer lands. Returns the receipt of what is stored
    /// afterwards, `None` if nothing is.
    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send;
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
        _: Stamp,
        _: &SavedFiles,
        _: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
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

    fn delete(
        &self,
        _: Id,
        _: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<()>, EngineError>> + Send {
        ready(Ok(Owned::Done(())))
    }

    fn claim(
        &self,
        _: Id,
        _: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send {
        ready(Ok(Owned::Done(None)))
    }

    fn forget_memory(
        &self,
        _: Id,
        _: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        ready(Ok(Owned::Done(None)))
    }
}

/// A store in a local directory, one subdirectory per sandbox.
///
/// It serves one host, so its sandboxes never change hands: it keeps no
/// owner stamps and refuses no owner. A fleet uses [`crate::chunked`].
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

/// The list of a stored copy's files and their hashes; its own hash is the
/// copy's receipt, so a receipt vouches for the files' contents, not only
/// their names.
const CONTENTS: &str = "contents";
/// The stored file naming the runtime that made the memory image.
const RUNTIME: &str = "runtime";

/// The contents list for `files` (name and path) as stored in `dir`, with
/// `made` telling apart copies of the same bytes.
fn contents(dir: &Path, names: &[&str], made: &str) -> std::io::Result<String> {
    let mut listed = String::new();
    for name in names {
        writeln!(listed, "{name} {}", hash_file(&dir.join(name))?)
            .map_err(std::io::Error::other)?;
    }
    writeln!(listed, "made {made}").map_err(std::io::Error::other)?;
    Ok(listed)
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(fs::File::open(path)?)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Whether the copy in `dir` is the one `receipt` names, with every file
/// as it was stored.
fn holds(dir: &Path, receipt: &str) -> std::io::Result<bool> {
    let listed = match fs::read_to_string(dir.join(CONTENTS)) {
        Ok(listed) => listed,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if blake3::hash(listed.as_bytes()).to_hex().as_str() != receipt {
        return Ok(false);
    }
    let mut disk = false;
    for line in listed.lines() {
        let Some((name, hash)) = line.split_once(' ') else {
            return Ok(false);
        };
        if name == "made" {
            continue;
        }
        disk |= name == "disk";
        match hash_file(&dir.join(name)) {
            Ok(found) if found == hash => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(disk)
}

/// The hash the contents list of the copy in `dir` records for each file.
fn listed(dir: &Path) -> std::io::Result<std::collections::HashMap<String, String>> {
    let listed = fs::read_to_string(dir.join(CONTENTS))?;
    Ok(listed
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(name, _)| *name != "made")
        .map(|(name, hash)| (name.to_owned(), hash.to_owned()))
        .collect())
}

/// Copies stored file `name` from `dir` to `to` and checks the copy against
/// the hash `listed` records for it; a copy that differs is removed.
fn copy_checked(
    dir: &Path,
    name: &str,
    to: &Path,
    listed: &std::collections::HashMap<String, String>,
) -> std::io::Result<()> {
    let differs = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the stored {name} differs from what was archived"),
        )
    };
    let expected = listed.get(name).ok_or_else(differs)?;
    copy_sparse(&dir.join(name), to)?;
    if hash_file(to)? != *expected {
        let _ = fs::remove_file(to);
        return Err(differs());
    }
    Ok(())
}

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
    async fn archive(
        &self,
        id: Id,
        _: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> Result<Archive, EngineError> {
        let stored = self.dir(id);
        let cancel = cancel.clone();
        let disk = files.disk.clone();
        let mut pairs = Vec::new();
        let runtime = files
            .memory
            .as_ref()
            .and_then(|memory| memory.runtime.clone());
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
            if cancel.is_cancelled() {
                fs::remove_dir_all(&staging)?;
                return Ok(Archive::Cancelled);
            }
            copy_file(&disk.open()?, &staging.join("disk"))?;
            let mut names = Vec::with_capacity(pairs.len() + 1);
            names.push("disk");
            for (local, name) in &pairs {
                if cancel.is_cancelled() {
                    fs::remove_dir_all(&staging)?;
                    return Ok(Archive::Cancelled);
                }
                copy_sparse(local, &staging.join(name))?;
                names.push(*name);
            }
            if let Some(runtime) = &runtime {
                fs::write(staging.join(RUNTIME), runtime)?;
                names.push(RUNTIME);
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos());
            let listed = contents(&staging, &names, &nanos.to_string())?;
            let receipt = blake3::hash(listed.as_bytes()).to_hex().to_string();
            fs::write(staging.join(CONTENTS), &listed)?;
            sync_file(&staging.join(CONTENTS))?;
            sync_file(&staging)?;
            if cancel.is_cancelled() {
                fs::remove_dir_all(&staging)?;
                return Ok(Archive::Cancelled);
            }
            if stored.exists() {
                fs::rename(&stored, &old)?;
            }
            fs::rename(&staging, &stored)?;
            sync_file(stored.parent().unwrap_or(&stored))?;
            if old.exists() {
                fs::remove_dir_all(&old)?;
            }
            Ok(Archive::Stored(Receipt(receipt)))
        })
        .await
    }

    async fn verify(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
        let stored = self.dir(id);
        let expected = receipt.0.clone();
        blocking("verify", move || holds(&stored, &expected)).await
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        let stored = self.dir(id);
        let into = into.clone();
        blocking("fetch", move || {
            // Every file is checked against the contents list before it is
            // used: what comes back is what was archived, or nothing.
            let listed = listed(&stored)?;
            let staging = crate::layout::Staging::beside(&into.disk)?;
            copy_checked(&stored, "disk", staging.path(), &listed)?;
            staging.publish()?;
            if listed.contains_key("profile") {
                copy_checked(&stored, "profile", &into.profile, &listed)?;
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
            copy_checked(&stored, "state", &state, &listed)?;
            copy_checked(&stored, "memory", &memory, &listed)?;
            let runtime = if listed.contains_key(RUNTIME) {
                let copy = into.scratch.join(RUNTIME);
                copy_checked(&stored, RUNTIME, &copy, &listed)?;
                Some(fs::read_to_string(&copy)?)
            } else {
                None
            };
            Ok(FetchedMemory::Local {
                state,
                memory,
                runtime,
            })
        })
        .await
    }

    async fn delete(&self, id: Id, _: OwnerEpoch) -> Result<Owned<()>, EngineError> {
        let stored = self.dir(id);
        blocking("delete", move || match fs::remove_dir_all(&stored) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(Owned::Done(())),
        })
        .await
    }

    async fn claim(&self, id: Id, _: OwnerEpoch) -> Result<Owned<Option<Claimed>>, EngineError> {
        let stored = self.dir(id);
        blocking("claim", move || {
            let listed = match fs::read_to_string(stored.join(CONTENTS)) {
                Ok(listed) => listed,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Owned::Done(None));
                }
                Err(error) => return Err(error),
            };
            let memory = listed.lines().any(|line| {
                line.split_once(' ')
                    .is_some_and(|(name, _)| name == "memory")
            });
            Ok(Owned::Done(Some(Claimed {
                save: 0,
                receipt: Receipt(blake3::hash(listed.as_bytes()).to_hex().to_string()),
                memory,
            })))
        })
        .await
    }

    async fn forget_memory(&self, id: Id, _: Stamp) -> Result<Owned<Option<Receipt>>, EngineError> {
        let stored = self.dir(id);
        blocking("forget", move || {
            // The device state goes first: without it, what remains of the
            // memory image can never be mistaken for a usable one.
            for name in ["state", "memory", RUNTIME] {
                match fs::remove_file(stored.join(name)) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(error);
                    }
                    _ => {}
                }
            }
            if !stored.exists() {
                return Ok(Owned::Done(None));
            }
            sync_file(&stored)?;
            // The copy now holds the same disk without the image: list what
            // is left, under the same `made`, as a new receipt.
            let listed = match fs::read_to_string(stored.join(CONTENTS)) {
                Ok(listed) => listed,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Owned::Done(None));
                }
                Err(error) => return Err(error),
            };
            let mut kept = String::with_capacity(listed.len());
            for line in listed.lines() {
                let name = line.split_once(' ').map_or(line, |(name, _)| name);
                if !["state", "memory", RUNTIME].contains(&name) {
                    kept.push_str(line);
                    kept.push('\n');
                }
            }
            crate::layout::write_atomic(&stored.join(CONTENTS), kept.as_bytes())?;
            Ok(Owned::Done(Some(Receipt(
                blake3::hash(kept.as_bytes()).to_hex().to_string(),
            ))))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAVE: Stamp = Stamp {
        epoch: OwnerEpoch::FIRST,
        save: 1,
    };

    #[tokio::test]
    async fn a_cancelled_directory_archive_keeps_the_earlier_copy() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("disk");
        fs::write(&disk, b"first").unwrap();
        let files = SavedFiles {
            disk: JailedFile::new(disk.clone()),
            memory: None,
            profile: None,
        };
        let store = Directory::new(dir.path().join("store"));
        let id: Id = "00000000000000000000000000000004".parse().unwrap();
        let first = store
            .archive(id, SAVE, &files, &CancellationToken::new())
            .await
            .unwrap()
            .stored()
            .unwrap();
        fs::write(&disk, b"second").unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let outcome = store.archive(id, SAVE, &files, &cancelled).await.unwrap();
        assert_eq!(outcome, Archive::Cancelled);
        assert!(store.verify(id, &first).await.unwrap());
        assert_eq!(fs::read(store.dir(id).join("disk")).unwrap(), b"first");
        assert!(!store.dir(id).with_extension("staging").exists());
    }

    #[tokio::test]
    async fn a_directory_receipt_vouches_for_the_stored_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let files = SavedFiles {
            disk: JailedFile::new(dir.path().join("disk")),
            memory: Some(SavedImage {
                state: dir.path().join("state"),
                memory: dir.path().join("memory"),
                chunks: None,
                runtime: None,
            }),
            profile: None,
        };
        for (path, bytes) in [
            (files.disk.path(), &b"disk"[..]),
            (files.memory.as_ref().unwrap().state.as_path(), b"state"),
            (files.memory.as_ref().unwrap().memory.as_path(), b"memory"),
        ] {
            fs::write(path, bytes).unwrap();
        }
        let store = Directory::new(dir.path().join("store"));
        let id: Id = "00000000000000000000000000000006".parse().unwrap();
        let archive = || async {
            store
                .archive(id, SAVE, &files, &CancellationToken::new())
                .await
                .unwrap()
                .stored()
                .unwrap()
        };
        let first = archive().await;
        assert!(store.verify(id, &first).await.unwrap());
        // Same names, other bytes: not the copy the receipt names.
        fs::write(store.dir(id).join("memory"), b"memorX").unwrap();
        assert!(!store.verify(id, &first).await.unwrap());
        fs::remove_file(store.dir(id).join("memory")).unwrap();
        assert!(!store.verify(id, &first).await.unwrap());

        let second = archive().await;
        assert!(store.verify(id, &second).await.unwrap());
        let Owned::Done(Some(disk_only)) = store.forget_memory(id, SAVE).await.unwrap() else {
            panic!("the disk stays");
        };
        assert!(!store.verify(id, &second).await.unwrap());
        assert!(store.verify(id, &disk_only).await.unwrap());
    }

    #[tokio::test]
    async fn a_directory_fetch_brings_back_only_what_was_archived() {
        let dir = tempfile::tempdir().unwrap();
        let files = SavedFiles {
            disk: JailedFile::new(dir.path().join("disk")),
            memory: Some(SavedImage {
                state: dir.path().join("state"),
                memory: dir.path().join("memory"),
                chunks: None,
                runtime: Some("Firecracker v1.0.0 on a test processor".into()),
            }),
            profile: None,
        };
        fs::write(files.disk.path(), b"GOOD").unwrap();
        fs::write(&files.memory.as_ref().unwrap().state, b"state").unwrap();
        fs::write(&files.memory.as_ref().unwrap().memory, b"memory").unwrap();
        let store = Directory::new(dir.path().join("store"));
        let id: Id = "00000000000000000000000000000007".parse().unwrap();
        store
            .archive(id, SAVE, &files, &CancellationToken::new())
            .await
            .unwrap();
        let into = |name: &str| FetchInto {
            disk: dir.path().join(name).join("disk"),
            scratch: dir.path().join(name).join("scratch"),
            profile: dir.path().join(name).join("profile"),
            memory: true,
            seed: None,
        };
        let good = into("good");
        fs::create_dir_all(dir.path().join("good")).unwrap();
        assert!(matches!(
            store.fetch(id, &good).await.unwrap(),
            FetchedMemory::Local { runtime: Some(runtime), .. }
                if runtime == "Firecracker v1.0.0 on a test processor"
        ));
        assert_eq!(fs::read(&good.disk).unwrap(), b"GOOD");

        // The same length, other bytes: refused, and nothing published.
        fs::write(store.dir(id).join("disk"), b"BADD").unwrap();
        let bad = into("bad");
        fs::create_dir_all(dir.path().join("bad")).unwrap();
        let error = store.fetch(id, &bad).await.unwrap_err();
        assert!(error.to_string().contains("differs"), "{error}");
        assert!(!bad.disk.exists());
        fs::write(store.dir(id).join("disk"), b"GOOD").unwrap();
        fs::write(store.dir(id).join("memory"), b"memorX").unwrap();
        let worse = into("worse");
        fs::create_dir_all(dir.path().join("worse")).unwrap();
        assert!(store.fetch(id, &worse).await.is_err());
        assert!(!worse.scratch.join("memory").exists());
    }
}
