//! Sandboxes kept in object storage as compressed, deduplicated chunks.
//!
//! Each file of a saved sandbox (its disk, and its device state and memory
//! image if it has them) is stored as a manifest: a complete map of the file
//! in which every range is either zeros or one content-addressed chunk.
//! Chunks are immutable and shared by everything under the same prefix, so a
//! sandbox archived again after a small change, or two sandboxes holding the
//! same bytes, store those bytes once. Memory images bring their per-chunk
//! hashes, so chunks unchanged since the last archive are not even read.
//!
//! A small pointer per sandbox names the manifests of its current copy. It is
//! written last, after every chunk and manifest it names is stored, so a
//! crash mid-archive leaves the previous copy intact. Memory and disk are
//! named by the same pointer: they are only ever restored together.
//!
//! Fetching brings the disk and device state back whole, and of memory only
//! the working set its guest touched first after the last wake (see
//! [`crate::working_set`]); the rest stays in the store, to be paged in as
//! the guest touches it (see [`crate::lazy`]). A disk starts as a copy (a
//! reflink where the filesystem allows) of the host's base image it was
//! created from, and only chunks that differ from the base at the same
//! offset are downloaded: a sandbox that changed little of its disk wakes
//! from local bytes.
//!
//! Chunks no pointer refers to any more are left for garbage collection,
//! which is not part of this module.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, ExtentSource};
use compute_storage::store::ChunkStore;
use futures::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};

pub use crate::image::CHUNK_BYTES;
use crate::image::{Hash, ZERO, chunk_count, chunk_range, hash_chunks};
use crate::lanes::Lanes;
use crate::protocol::Id;
use crate::store::{Archive, FetchInto, FetchedMemory, Prefilled, Receipt, SavedFiles, Store};
use crate::working_set::{self, WakeProfile};

/// Chunk uploads in flight per file.
const UPLOADS_PER_FILE: usize = 32;
/// Chunk downloads in flight per file: a wake waits for them, and each one
/// is mostly store latency.
const DOWNLOADS_PER_FILE: usize = 64;
/// Chunk transfers in flight on the whole host, so a hundred sandboxes
/// sleeping or waking at once share a bounded set of connections.
const TRANSFERS_PER_HOST: usize = 512;
/// Presence checks in flight while verifying one copy: each is a small
/// metadata request, so many can share the host's transfers.
const VERIFY_CHECKS: usize = 64;
/// zstd level 1: measured nearly as small as higher levels at a fraction of
/// the time, which matters because sleeping waits for it.
const ZSTD_LEVEL: i32 = 1;
/// Version 2 added the learned wake profile; version 3 its working-set pack.
const HEAD_VERSION: u32 = 3;

/// One chunk-sized piece of a stored file: where it is, and the chunk
/// holding it (`None` for zeros).
type Piece = (Range<u64>, Option<ChunkRef>);

/// The manifests that make up one sandbox's stored copy.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Head {
    version: u32,
    disk: String,
    memory: Option<MemoryHead>,
    /// The order the guest touched memory after its last wake, stored as
    /// one chunk.
    #[serde(default)]
    profile: Option<ChunkRef>,
    /// The memory pages at the start of that order, packed for one fetch:
    /// the index chunk of a [`working_set`] pack.
    #[serde(default)]
    pack: Option<ChunkRef>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct MemoryHead {
    state: String,
    memory: String,
    /// The runtime that made the image, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime: Option<String>,
}

fn parse_head(operation: &'static str, bytes: &[u8]) -> Result<Head, EngineError> {
    let head: Head = serde_json::from_slice(bytes)
        .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, operation, error))?;
    if !(1..=HEAD_VERSION).contains(&head.version) {
        return Err(EngineError::new(
            ErrorKind::Fatal,
            operation,
            format!("unknown stored copy version {}", head.version),
        ));
    }
    Ok(head)
}

/// Keeps sandboxes in object storage (Google Cloud Storage, Azure Blob, S3)
/// as deduplicated chunks.
#[derive(Clone, Debug)]
pub struct Chunked {
    chunks: ChunkStore,
    /// The chunk hashes of the base image disks are fetched over, computed
    /// once per version of that file.
    seed: Arc<Mutex<Option<Arc<Seed>>>>,
    /// Permits for chunk transfers, shared by every sandbox.
    transfers: Arc<Semaphore>,
    /// A wake's transfers are foreground: background ones give way.
    lanes: Arc<Lanes>,
}

/// What identifies one version of a local file: if any of it changes, the
/// file's chunk hashes must be computed again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    len: u64,
    modified: Option<SystemTime>,
}

impl Identity {
    fn of(path: &Path) -> io::Result<Self> {
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
struct Seed {
    path: PathBuf,
    identity: Identity,
    hashes: Vec<Hash>,
}

impl Seed {
    fn compute(path: &Path) -> io::Result<Self> {
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
    fn holds(&self, index: usize, hash: &str) -> bool {
        self.hashes
            .get(index)
            .zip(hash_from_hex(hash).ok())
            .is_some_and(|(held, wanted)| *held == wanted)
    }
}

impl Chunked {
    /// Keeps sandboxes in `chunks`. Everything under its prefix shares
    /// chunks, so the prefix is also the boundary of who may see whose bytes.
    #[must_use]
    pub fn new(chunks: ChunkStore) -> Self {
        Self {
            chunks,
            seed: Arc::default(),
            transfers: Arc::new(Semaphore::new(TRANSFERS_PER_HOST)),
            lanes: Arc::default(),
        }
    }

    /// Opens the object storage `url` names: `gs://bucket/prefix`,
    /// `az://container/prefix` or `s3://bucket/prefix`, with credentials
    /// from the environment or the machine's own identity. `None` if `url`
    /// is not an object storage URL.
    pub fn from_url(url: &str) -> Result<Option<Self>, compute_storage::Error> {
        Ok(ChunkStore::from_url(url)?.map(Self::new))
    }

    async fn head(&self, operation: &'static str, id: Id) -> Result<Option<Head>, EngineError> {
        let Some(bytes) = self
            .chunks
            .get_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error(operation, error))?
        else {
            return Ok(None);
        };
        parse_head(operation, &bytes).map(Some)
    }

    /// The chunk hashes of `path` as it is now, computed at most once per
    /// version of the file however many fetches ask at once. `None` if it
    /// cannot be read: fetching then downloads everything.
    async fn seed(&self, path: &Path) -> Option<Arc<Seed>> {
        let mut cached = self.seed.lock().await;
        let current = Identity::of(path).ok()?;
        if let Some(seed) = cached.as_ref()
            && seed.path == path
            && seed.identity == current
        {
            return Some(Arc::clone(seed));
        }
        let owned = path.to_owned();
        match tokio::task::spawn_blocking(move || Seed::compute(&owned)).await {
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

    /// The whole chunks of an earlier copy of a file, by offset, so bytes that
    /// did not change are neither compressed nor uploaded again. Without one,
    /// archiving still works; it just does more work.
    async fn earlier(&self, manifest: Option<&str>) -> HashMap<u64, ChunkRef> {
        let Some(digest) = manifest else {
            return HashMap::new();
        };
        match self.chunks.get_manifest(digest).await {
            Ok(manifest) => manifest
                .extents
                .into_iter()
                .filter_map(|extent| match extent.source {
                    ExtentSource::Chunk {
                        reference,
                        offset: 0,
                    } if u64::from(reference.plain_len) == extent.length => {
                        Some((extent.offset, reference))
                    }
                    _ => None,
                })
                .collect(),
            Err(error) => {
                tracing::debug!(%error, "earlier copy unreadable; archiving everything");
                HashMap::new()
            }
        }
    }

    /// Brings the working-set pack `index` names into `memory` in
    /// `scratch`, a file of the image's `memory_len` bytes. `None` if it
    /// filled nothing: the wake then pages everything in by chunk.
    /// `zero_chunks` says which of the image's chunks are zeros.
    async fn fetch_pack(
        &self,
        index: &ChunkRef,
        scratch: &Path,
        memory_len: u64,
        zero_chunks: &Arc<[bool]>,
    ) -> Option<Prefilled> {
        let path = scratch.join("memory");
        let created = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let file = File::create(&path)?;
                file.set_len(memory_len)?;
                Ok::<_, io::Error>(Arc::new(file))
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)))
        };
        let file = match created {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(%error, "no file for the working-set pack");
                return None;
            }
        };
        let pages = working_set::fetch(
            &self.chunks,
            &self.transfers,
            index,
            &file,
            memory_len,
            zero_chunks,
        )
        .await;
        // Publishing the image makes the filled pages durable with it.
        if pages.is_empty() {
            let _ = tokio::fs::remove_file(&path).await;
            return None;
        }
        let bytes: u64 = pages.iter().map(|range| range.end - range.start).sum();
        tracing::debug!(bytes, ranges = pages.len(), "working-set pack brought back");
        Some(Prefilled {
            memory: path,
            pages,
        })
    }

    /// Stores the learned wake profile `learned`, if there is one, and
    /// returns its reference.
    async fn put_profile(
        &self,
        learned: Option<&[u8]>,
        cancel: &CancellationToken,
    ) -> Result<Option<ChunkRef>, EngineError> {
        let Some(bytes) = learned else {
            return Ok(None);
        };
        if cancel.is_cancelled() {
            return Ok(None);
        }
        let chunk = EncodedChunk::encode(bytes, ZSTD_LEVEL)
            .map_err(|error| storage_error("archive", error))?;
        self.chunks
            .put_chunk(&chunk)
            .await
            .map_err(|error| storage_error("archive", error))?;
        Ok(Some(chunk.reference))
    }

    /// Stores the working-set pack the learned profile `learned` asks for
    /// from the image in `files`. Only makes the next wake faster: a pack
    /// that cannot be stored is left out.
    async fn put_pack(
        &self,
        id: Id,
        files: &SavedFiles,
        learned: Option<&[u8]>,
        cancel: &CancellationToken,
    ) -> Option<ChunkRef> {
        let (Some(image), Some(learned)) = (&files.memory, learned) else {
            return None;
        };
        if cancel.is_cancelled() {
            return None;
        }
        let profile = WakeProfile::parse(learned);
        match working_set::put(
            &self.chunks,
            &self.transfers,
            &image.memory,
            image.chunks.clone(),
            &profile,
            cancel,
        )
        .await
        {
            Ok(index) => index,
            Err(working_set::PackError::Cancelled) => None,
            Err(error) => {
                tracing::warn!(%id, %error, "working-set pack not stored; the next wake fetches by chunk");
                None
            }
        }
    }
}

impl Store for Chunked {
    async fn archive(
        &self,
        id: Id,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> Result<Archive, EngineError> {
        const OP: &str = "archive";
        let earlier = match self.head(OP, id).await {
            Ok(head) => head,
            Err(error) => {
                tracing::debug!(%id, %error, "earlier copy unreadable; archiving everything");
                None
            }
        };
        let memory_before = earlier.as_ref().and_then(|head| head.memory.as_ref());
        let (disk_before, state_before, memory_before) = tokio::join!(
            self.earlier(earlier.as_ref().map(|head| head.disk.as_str())),
            self.earlier(memory_before.map(|memory| memory.state.as_str())),
            self.earlier(memory_before.map(|memory| memory.memory.as_str())),
        );
        let disk = self.put_file(
            files.disk.path(),
            files.disk.open(),
            disk_before,
            None,
            cancel,
        );
        let memory = async {
            let Some(image) = &files.memory else {
                return Ok(Some(None));
            };
            // Both run to the end, so neither is still writing when the
            // other fails.
            let (state, memory) = tokio::join!(
                self.put_file(
                    &image.state,
                    File::open(&image.state),
                    state_before,
                    None,
                    cancel
                ),
                self.put_file(
                    &image.memory,
                    File::open(&image.memory),
                    memory_before,
                    image.chunks.clone(),
                    cancel,
                ),
            );
            Ok(match (state?, memory?) {
                (Some(state), Some(memory)) => Some(Some(MemoryHead {
                    state,
                    memory,
                    runtime: image.runtime.clone(),
                })),
                _ => None,
            })
        };
        let learned = match &files.profile {
            Some(path) => tokio::fs::read(path)
                .await
                .ok()
                .filter(|bytes| !bytes.is_empty()),
            None => None,
        };
        let profile = self.put_profile(learned.as_deref(), cancel);
        let pack = self.put_pack(id, files, learned.as_deref(), cancel);
        let (disk, memory, profile, pack) = tokio::join!(disk, memory, profile, pack);
        let (Some(disk), Some(memory), profile) = (disk?, memory?, profile?) else {
            return Ok(Archive::Cancelled);
        };
        if cancel.is_cancelled() {
            return Ok(Archive::Cancelled);
        }
        let head = Head {
            version: HEAD_VERSION,
            disk,
            memory,
            profile,
            pack,
        };
        let bytes = serde_json::to_vec(&head)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
        let receipt = Receipt(blake3::hash(&bytes).to_hex().to_string());
        self.chunks
            .put_pointer(&id.to_string(), bytes)
            .await
            .map_err(|error| storage_error(OP, error))?;
        Ok(Archive::Stored(receipt))
    }

    async fn verify(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
        const OP: &str = "verify";
        let Some(bytes) = self
            .chunks
            .get_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error(OP, error))?
        else {
            return Ok(false);
        };
        if blake3::hash(&bytes).to_hex().as_str() != receipt.0 {
            return Ok(false);
        }
        let Ok(head) = parse_head(OP, &bytes) else {
            return Ok(false);
        };
        let mut digests = vec![head.disk];
        if let Some(memory) = head.memory {
            digests.extend([memory.state, memory.memory]);
        }
        let mut referenced = HashMap::new();
        for digest in digests {
            // Fetching checks each manifest against its digest.
            match self.chunks.get_manifest(&digest).await {
                Ok(manifest) => {
                    for extent in manifest.extents {
                        if let ExtentSource::Chunk { reference, .. } = extent.source {
                            referenced.insert(reference.key(), reference);
                        }
                    }
                }
                Err(
                    StorageError::Object(object_store::Error::NotFound { .. })
                    | StorageError::Integrity
                    | StorageError::Invalid(_)
                    | StorageError::Json(_),
                ) => return Ok(false),
                Err(error) => return Err(storage_error(OP, error)),
            }
        }
        // The local copy may be deleted on this answer: every chunk the copy
        // needs must be there, not only the manifests naming them.
        let checks: Vec<Result<bool, EngineError>> = stream::iter(referenced.into_values())
            .map(|reference| async move {
                let _permit = self
                    .transfers
                    .acquire()
                    .await
                    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
                match self.chunks.has_chunk(&reference).await {
                    Ok(present) => Ok(present),
                    Err(StorageError::Invalid(_)) => Ok(false),
                    Err(error) => Err(storage_error(OP, error)),
                }
            })
            .buffer_unordered(VERIFY_CHECKS)
            .collect()
            .await;
        checks
            .into_iter()
            .try_fold(true, |all, present| Ok(all && present?))
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        const OP: &str = "fetch";
        // A sandbox waits on all of it: its disk, state and pack.
        let _waited_on = self.lanes.foreground();
        let Some(head) = self.head(OP, id).await? else {
            return Err(EngineError::new(
                ErrorKind::Fatal,
                OP,
                "no stored copy of this sandbox",
            ));
        };
        let disk = async {
            let seed = match &into.seed {
                Some(path) => self.seed(path).await,
                None => None,
            };
            self.get_file(&head.disk, &into.disk, seed.as_deref()).await
        };
        let profile = async {
            if let Some(reference) = &head.profile {
                // A missing or damaged profile only makes the wake slower.
                match self.chunks.get_chunk(reference).await {
                    Ok(bytes) => {
                        let _ = tokio::fs::write(&into.profile, bytes).await;
                    }
                    Err(error) => tracing::warn!(%id, %error, "wake profile unavailable"),
                }
            }
            Ok::<_, EngineError>(())
        };
        let memory = async {
            if !into.memory {
                return Ok(FetchedMemory::None);
            }
            let Some(stored) = &head.memory else {
                return Err(EngineError::new(
                    ErrorKind::MemoryLost,
                    OP,
                    "the stored copy has no memory image",
                ));
            };
            tokio::fs::create_dir_all(&into.scratch)
                .await
                .map_err(|error| EngineError::io(OP, error))?;
            let state = into.scratch.join("state");
            // The working set follows the manifest, which gives the image's
            // length, while the state comes in beside both.
            let memory = async {
                let manifest = self
                    .chunks
                    .get_manifest(&stored.memory)
                    .await
                    .map_err(|error| storage_error(OP, error))?;
                let refs = chunk_refs(&manifest);
                let prefilled = match (&head.pack, &refs) {
                    (Some(index), Some(refs)) => {
                        let zero_chunks = refs.iter().map(Option::is_none).collect();
                        self.fetch_pack(index, &into.scratch, manifest.disk_len, &zero_chunks)
                            .await
                    }
                    _ => None,
                };
                Ok::<_, EngineError>((manifest, refs, prefilled))
            };
            // Both run to the end, so neither is still writing when the
            // other fails.
            let (state_fetched, memory) =
                tokio::join!(self.get_file(&stored.state, &state, None), memory);
            state_fetched?;
            let (manifest, refs, prefilled) = memory?;
            if let Some(refs) = refs {
                let chunks = refs
                    .iter()
                    .map(|reference| {
                        reference
                            .as_ref()
                            .map_or(Ok(ZERO), |reference| hash_from_hex(&reference.hash))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|()| {
                        EngineError::new(ErrorKind::Fatal, OP, "bad chunk hash in manifest")
                    })?;
                let manifest_bytes = manifest
                    .encode()
                    .map_err(|error| storage_error(OP, error))?;
                return Ok(FetchedMemory::Remote {
                    state,
                    memory_len: manifest.disk_len,
                    chunks,
                    manifest: manifest_bytes,
                    prefilled,
                    runtime: stored.runtime.clone(),
                });
            }
            // A manifest not laid out in whole chunks cannot be paged in;
            // bring the memory back whole instead.
            let memory = into.scratch.join("memory");
            self.get_file(&stored.memory, &memory, None).await?;
            Ok(FetchedMemory::Local {
                state,
                memory,
                runtime: stored.runtime.clone(),
            })
        };
        // Each runs to the end: a failure returns only once nothing of this
        // fetch writes into the sandbox's files any more.
        let (disk, profile, memory) = tokio::join!(disk, profile, memory);
        disk?;
        profile?;
        memory
    }

    async fn delete(&self, id: Id) -> Result<(), EngineError> {
        self.chunks
            .delete_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error("delete", error))
    }

    /// Points the sandbox at its disk alone. The memory chunks stay until
    /// garbage collection finds nothing refers to them.
    async fn forget_memory(&self, id: Id) -> Result<Option<Receipt>, EngineError> {
        const OP: &str = "forget";
        let Some(stored) = self
            .chunks
            .get_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error(OP, error))?
        else {
            return Ok(None);
        };
        let head = parse_head(OP, &stored)?;
        if head.memory.is_none() {
            return Ok(Some(Receipt(blake3::hash(&stored).to_hex().to_string())));
        }
        let head = Head {
            memory: None,
            ..head
        };
        let bytes = serde_json::to_vec(&head)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
        let receipt = Receipt(blake3::hash(&bytes).to_hex().to_string());
        self.chunks
            .put_pointer(&id.to_string(), bytes)
            .await
            .map_err(|error| storage_error(OP, error))?;
        Ok(Some(receipt))
    }

    fn chunks(&self) -> Option<(&ChunkStore, &Arc<Lanes>)> {
        Some((&self.chunks, &self.lanes))
    }
}

/// The chunk at each chunk-sized position of a memory manifest (`None` for
/// zeros), or `None` if the manifest is not laid out in whole chunks at
/// chunk boundaries, as [`Chunked`] stores memory.
pub(crate) fn chunk_refs(manifest: &DiskManifest) -> Option<Vec<Option<ChunkRef>>> {
    let length = manifest.disk_len;
    let mut refs = vec![None; chunk_count(length)];
    for extent in &manifest.extents {
        match &extent.source {
            ExtentSource::Zero => {}
            ExtentSource::Chunk {
                reference,
                offset: 0,
            } if extent.offset % CHUNK_BYTES == 0
                && extent.length == u64::from(reference.plain_len)
                && chunk_range(usize::try_from(extent.offset / CHUNK_BYTES).ok()?, length).end
                    == extent.offset + extent.length =>
            {
                let index = usize::try_from(extent.offset / CHUNK_BYTES).ok()?;
                *refs.get_mut(index)? = Some(reference.clone());
            }
            _ => return None,
        }
    }
    Some(refs)
}

/// Parses a 64-digit hex hash.
pub(crate) fn hash_from_hex(hex: &str) -> Result<Hash, ()> {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        return Err(());
    }
    let mut hash = ZERO;
    for (index, pair) in bytes.as_chunks::<2>().0.iter().enumerate() {
        let digit = |byte: u8| char::from(byte).to_digit(16).ok_or(());
        hash[index] = u8::try_from(digit(pair[0])? << 4 | digit(pair[1])?).map_err(|_| ())?;
    }
    Ok(hash)
}

/// How a storage failure affects the sandbox.
fn storage_error(operation: &'static str, error: StorageError) -> EngineError {
    let kind = match &error {
        // Networks and disks recover; trying again later may work.
        StorageError::Io(_) | StorageError::Object(_) | StorageError::Transfer(_) => {
            ErrorKind::Transient
        }
        // A stored copy that fails its checks will fail them again: the store
        // already retried the read and quarantined the object.
        StorageError::Integrity
        | StorageError::Truncated { .. }
        | StorageError::Invalid(_)
        | StorageError::Json(_) => ErrorKind::Fatal,
    };
    EngineError::caused_by(kind, operation, error)
}

mod files;
#[cfg(test)]
mod tests;
