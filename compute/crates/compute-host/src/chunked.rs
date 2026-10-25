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
//! Chunks no pointer refers to any more are deleted by a sweep
//! ([`Chunked::sweep`]); an archive publishes its pointer within the
//! window that keeps a sweep from deleting what it reused (see
//! [`compute_storage::fresh`]).
//!
//! An archive reuses what the sandbox's earlier copy holds at the same
//! offsets, and for a disk made from a stored image, what the image holds:
//! a first archive stores only what the sandbox changed. It asks the store
//! whether it still holds a chunk it reuses unless a copy this host
//! confirmed recently names it (see [`confirmed`]).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};
use std::time::SystemTime;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, ExtentSource};
use compute_storage::store::{Begun, ChunkStore, Publication, Rewrite};
pub use compute_storage::sweep::Report;
use futures::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};

pub use crate::image::CHUNK_BYTES;
use crate::image::{Hash, ZERO, chunk_count, chunk_range, hash_chunks};
use crate::lanes::Lanes;
use crate::protocol::{Id, ImageId};
use crate::store::{
    Archive, Claimed, FetchInto, FetchedMemory, Owned, OwnerEpoch, Prefilled, Receipt, SavedFiles,
    Stamp, Store,
};
use crate::threads::Threads;
use crate::working_set::{self, WakeProfile};
use confirmed::{Confirmed, ImageChunks};
use files::{Earlier, Reusable};

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
/// The stored copy's format. A host reads only this version and refuses
/// any other.
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
    profile: Option<ChunkRef>,
    /// The memory pages at the start of that order, packed for one fetch:
    /// the index chunk of a [`working_set`] pack.
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
    if head.version != HEAD_VERSION {
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
    /// The chunk hashes of the images disks are fetched over.
    seeds: Arc<Seeds>,
    /// The stored copies this host knows the store holds whole.
    confirmed: Arc<Confirmed>,
    /// Permits for chunk transfers, shared by every sandbox.
    transfers: Arc<Semaphore>,
    /// Permits for compressing chunks, shared by every sandbox: each holds
    /// a processor while it runs.
    compress: Arc<Semaphore>,
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

/// The chunk hashes of each local file disks are fetched over (the host's
/// base image and each sandbox image it keeps), computed at most once per
/// version of the file however many fetches ask at once. One file's
/// hashing never holds up fetches over another, and the hashes of a file
/// that is gone (an image retired) are dropped by the next fetch.
#[derive(Debug, Default)]
struct Seeds {
    by_path: std::sync::Mutex<HashMap<PathBuf, SeedSlot>>,
}

/// Where the hashes of one file are kept, once taken.
type SeedSlot = Arc<Mutex<Option<Arc<Seed>>>>;

impl Seeds {
    /// The hashes of `path` as it is now, from `compute` (which blocks) if
    /// none were taken of this version of it. `None` if it cannot be read.
    async fn get(
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

impl Chunked {
    /// Keeps sandboxes in `chunks`. Everything under its prefix shares
    /// chunks, so the prefix is also the boundary of who may see whose bytes.
    #[must_use]
    pub fn new(chunks: ChunkStore) -> Self {
        Self {
            chunks,
            seeds: Arc::default(),
            confirmed: Arc::default(),
            transfers: Arc::new(Semaphore::new(TRANSFERS_PER_HOST)),
            compress: Arc::new(Semaphore::new(Threads::for_host().compress)),
            lanes: Arc::default(),
        }
    }

    /// Compresses at most `chunks` chunks at once (at least one).
    #[must_use]
    pub fn with_compress_threads(mut self, chunks: usize) -> Self {
        self.compress = Arc::new(Semaphore::new(chunks.max(1)));
        self
    }

    /// Opens the object storage `url` names: `gs://bucket/prefix`,
    /// `az://container/prefix` or `s3://bucket/prefix`, with credentials
    /// from the environment or the machine's own identity. `None` if `url`
    /// is not an object storage URL.
    pub fn from_url(url: &str) -> Result<Option<Self>, compute_storage::Error> {
        Ok(ChunkStore::from_url(url)?.map(Self::new))
    }

    /// The same store telling `watch` about every object it quarantines.
    #[must_use]
    pub fn with_watch(self, watch: Arc<dyn compute_storage::store::QuarantineWatch>) -> Self {
        Self {
            chunks: self.chunks.with_watch(watch),
            ..self
        }
    }

    /// Deletes the chunks and manifests no sandbox's stored copy names any
    /// more, or with `delete` false only reports them (see
    /// [`compute_storage::sweep`]).
    pub async fn sweep(&self, delete: bool) -> Result<Report, StorageError> {
        compute_storage::sweep::sweep(
            &self.chunks,
            |pointer| async move { self.names(&pointer).await },
            delete,
        )
        .await
    }

    /// The chunk and manifest keys the stored copy whose pointer holds
    /// `pointer` keeps. Anything unreadable fails, so a sweep stops before
    /// deleting what it could not account for; only a damaged or missing
    /// working-set pack does not, since a wake without it is just slower.
    async fn names(&self, pointer: &[u8]) -> Result<Vec<String>, StorageError> {
        let head: Head = serde_json::from_slice(pointer)?;
        if head.version != HEAD_VERSION {
            return Err(StorageError::Invalid("a stored copy of an unknown version"));
        }
        let mut manifests = vec![head.disk];
        // A working-set pack holds memory pages, so it is kept only with
        // the memory image it serves.
        let pack = head.memory.as_ref().and(head.pack.as_ref());
        if let Some(memory) = &head.memory {
            manifests.extend([memory.state.clone(), memory.memory.clone()]);
        }
        let mut names = Vec::new();
        for digest in manifests {
            let manifest = self.chunks.get_manifest(&digest).await?;
            names.push(ChunkStore::manifest_key(&digest));
            names.extend(
                manifest
                    .extents
                    .iter()
                    .filter_map(|extent| match &extent.source {
                        ExtentSource::Chunk { reference, .. } => Some(reference.key()),
                        ExtentSource::Zero | ExtentSource::Base { .. } => None,
                    }),
            );
        }
        names.extend(head.profile.as_ref().map(ChunkRef::key));
        if let Some(index) = pack {
            names.push(index.key());
            match working_set::parts(&self.chunks, index).await {
                Ok(parts) => names.extend(parts.iter().map(ChunkRef::key)),
                Err(error) if error.is_permanent() => {
                    tracing::warn!(%error, "working-set pack unreadable; its parts may be swept");
                }
                Err(error) => return Err(error),
            }
        }
        Ok(names)
    }

    /// Begins an archive of `save`, checking the owner on the version its
    /// publication will be conditional on, or says what it comes to
    /// without one.
    async fn begin(
        &self,
        id: Id,
        save: Stamp,
    ) -> Result<Result<Publication, Archive>, EngineError> {
        const OP: &str = "archive";
        let name = id.to_string();
        match self.chunks.begin(&name, save).await {
            Ok(Begun::Publish(publication)) => Ok(Ok(publication)),
            // An earlier try of this very save, whose answer was lost.
            Ok(Begun::Stored(bytes)) => Ok(Err(Archive::Stored(receipt_of(&bytes)))),
            Ok(Begun::Outdated) => Ok(Err(Archive::Outdated)),
            Ok(Begun::Deleted) => Ok(Err(Archive::Deleted)),
            Err(StorageError::Fenced { by }) => Ok(Err(Archive::Fenced { by })),
            Err(error) => Err(storage_error(OP, error)),
        }
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

    /// The chunk hashes of `path` as it is now. `None` if it cannot be
    /// read: fetching then downloads everything.
    async fn seed(&self, path: &Path) -> Option<Arc<Seed>> {
        self.seeds.get(path, Seed::compute).await
    }

    /// The whole chunks of an earlier copy of a file, by offset, so bytes that
    /// did not change are neither compressed nor uploaded again. Without one,
    /// archiving still works; it just does more work.
    async fn earlier(&self, manifest: Option<&str>) -> HashMap<u64, ChunkRef> {
        let Some(digest) = manifest else {
            return HashMap::new();
        };
        match self.chunks.get_manifest(digest).await {
            Ok(manifest) => whole_chunks(manifest),
            Err(error) => {
                tracing::debug!(%error, "earlier copy unreadable; archiving everything");
                HashMap::new()
            }
        }
    }

    /// What an archive of `id` from `files`, begun at `now`, may reuse.
    /// Read after the archive began, so a sweep's fence covers it.
    async fn before(&self, id: Id, files: &SavedFiles, now: SystemTime) -> Before {
        const OP: &str = "archive";
        let earlier = match self.chunks.get_pointer(&id.to_string()).await {
            Ok(Some(bytes)) if !bytes.is_empty() => match parse_head(OP, &bytes) {
                Ok(head) => Some((receipt_of(&bytes), head)),
                Err(error) => {
                    tracing::debug!(%id, %error, "earlier copy unreadable; archiving everything");
                    None
                }
            },
            Ok(_) => None,
            Err(error) => {
                tracing::debug!(%id, %error, "earlier copy unreadable; archiving everything");
                None
            }
        };
        let confirmed = earlier
            .as_ref()
            .and_then(|(receipt, _)| self.confirmed.sandbox(id, receipt, now));
        let image = match files.image {
            Some(image) => self.image_chunks(image, now).await,
            None => None,
        };
        let earlier = earlier.map(|(_, head)| head);
        let memory = earlier.as_ref().and_then(|head| head.memory.as_ref());
        let (disk, state, memory) = tokio::join!(
            self.earlier(earlier.as_ref().map(|head| head.disk.as_str())),
            self.earlier(memory.map(|memory| memory.state.as_str())),
            self.earlier(memory.map(|memory| memory.memory.as_str())),
        );
        let own = confirmed.is_some();
        Before {
            confirmed,
            disk: reusable(disk, own, image.as_ref().map(|image| &image.chunks)),
            state: reusable(state, own, None),
            memory: reusable(memory, own, None),
            image,
        }
    }

    /// The chunks of the stored image `image`, if the store holds every one
    /// of them, checked at most once a day however many archives ask. The
    /// pointer is read on every call, after the archive asking began, so a
    /// sweep's fence covers what it names.
    async fn image_chunks(&self, image: ImageId, now: SystemTime) -> Option<Arc<ImageChunks>> {
        const OP: &str = "archive";
        let pointer = match self
            .chunks
            .get_pointer(&rootfs::rootfs_pointer(image))
            .await
        {
            Ok(Some(pointer)) if !pointer.is_empty() => pointer,
            Ok(_) => return None,
            Err(error) => {
                tracing::debug!(%image, %error, "image unreadable; archiving without it");
                return None;
            }
        };
        let receipt = receipt_of(&pointer);
        let slot = self.confirmed.image_slot(image, now);
        let mut held = slot.lock().await;
        if let Some(chunks) = held
            .as_ref()
            .filter(|chunks| chunks.receipt == receipt && confirmed::fresh(chunks.at, now))
        {
            return Some(Arc::clone(chunks));
        }
        *held = None;
        let manifest = match parse_head(OP, &pointer) {
            Ok(stored) => self.chunks.get_manifest(&stored.disk).await.ok(),
            Err(_) => None,
        };
        let Some(manifest) = manifest else {
            tracing::warn!(%image, "image manifest unreadable; archiving without it");
            return None;
        };
        let chunks = whole_chunks(manifest);
        match self.holds_all(OP, chunks.values().cloned()).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(%image, "the store lost part of an image; archiving without it");
                return None;
            }
            Err(error) => {
                tracing::debug!(%image, %error, "image not checked; archiving without it");
                return None;
            }
        }
        let chunks = Arc::new(ImageChunks {
            receipt,
            chunks,
            at: now,
        });
        *held = Some(Arc::clone(&chunks));
        Some(chunks)
    }

    /// Whether the store holds every one of `references`, intact.
    async fn holds_all(
        &self,
        op: &'static str,
        references: impl IntoIterator<Item = ChunkRef>,
    ) -> Result<bool, EngineError> {
        let checks: Vec<Result<bool, EngineError>> = stream::iter(references)
            .map(|reference| async move {
                let _permit = self
                    .transfers
                    .acquire()
                    .await
                    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, op, error))?;
                match self.chunks.has_chunk(&reference).await {
                    Ok(present) => Ok(present),
                    Err(StorageError::Invalid(_)) => Ok(false),
                    Err(error) => Err(storage_error(op, error)),
                }
            })
            .buffer_unordered(VERIFY_CHECKS)
            .collect()
            .await;
        checks
            .into_iter()
            .try_fold(true, |all, present| Ok(all && present?))
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

    /// Brings the memory image `head` names into `into.scratch`: the state
    /// whole, and the memory as the chunk list a pager fetches from, with
    /// the working-set pack already filled in, or whole when the manifest
    /// is not laid out in chunks.
    async fn fetch_memory(
        &self,
        head: &Head,
        into: &FetchInto,
    ) -> Result<FetchedMemory, EngineError> {
        const OP: &str = "fetch";
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
        // Both run to the end, so neither is still writing when the other
        // fails.
        let (state_fetched, memory) =
            tokio::join!(self.get_file(&stored.state, &state, None), memory);
        state_fetched?;
        let (manifest, refs, prefilled) = memory?;
        let Some(refs) = refs else {
            // A manifest not laid out in whole chunks cannot be paged in;
            // bring the memory back whole instead.
            let memory = into.scratch.join("memory");
            self.get_file(&stored.memory, &memory, None).await?;
            return Ok(FetchedMemory::Local {
                state,
                memory,
                runtime: stored.runtime.clone(),
            });
        };
        let chunks = refs
            .iter()
            .map(|reference| {
                reference
                    .as_ref()
                    .map_or(Ok(ZERO), |reference| hash_from_hex(&reference.hash))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|()| EngineError::new(ErrorKind::Fatal, OP, "bad chunk hash in manifest"))?;
        let manifest_bytes = manifest
            .encode()
            .map_err(|error| storage_error(OP, error))?;
        Ok(FetchedMemory::Remote {
            state,
            memory_len: manifest.disk_len,
            chunks,
            manifest: manifest_bytes,
            prefilled,
            runtime: stored.runtime.clone(),
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
        let stored = self
            .chunks
            .put_chunk(&chunk)
            .await
            .map_err(|error| storage_error("archive", error))?;
        if stored {
            crate::observe::notes::bytes("uploaded", chunk.bytes.len() as u64);
        }
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
            &self.compress,
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
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> Result<Archive, EngineError> {
        const OP: &str = "archive";
        if cancel.is_cancelled() {
            return Ok(Archive::Cancelled);
        }
        // Begun before the store is looked at: a sweep that takes stock
        // before this archive publishes stops it from publishing, so it
        // never names what that sweep deletes.
        let publication = match self.begin(id, save).await? {
            Ok(publication) => publication,
            Err(settled) => return Ok(settled),
        };
        let now = self.chunks.now();
        let Before {
            confirmed: earlier_confirmed,
            image,
            disk: disk_before,
            state: state_before,
            memory: memory_before,
        } = self.before(id, files, now).await;
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
        let receipt = receipt_of(&bytes);
        // Refused when the pointer changed since this archive began: the
        // next archive begins again and checks the owner anew.
        self.chunks
            .publish(publication, bytes)
            .await
            .map_err(|error| storage_error(OP, error))?;
        // Everything the new copy names was stored by now, or asked about
        // now, or confirmed when the copies it was reused from were.
        let confirmed = [earlier_confirmed, image.map(|image| image.at)]
            .into_iter()
            .flatten()
            .fold(now, SystemTime::min);
        self.confirmed
            .confirm_sandbox(id, receipt.clone(), confirmed);
        Ok(Archive::Stored(receipt))
    }

    async fn verify(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
        let now = self.chunks.now();
        let holds = self.holds(id, receipt).await;
        match holds {
            Ok(true) => self.confirmed.confirm_sandbox(id, receipt.clone(), now),
            // Something the copy needs is gone or damaged, and may be part of
            // an image: the next archive asks about everything it reuses, and
            // so stores it again.
            Ok(false) => {
                self.confirmed.drop_sandbox(id);
                self.confirmed.drop_images();
            }
            Err(_) => {}
        }
        holds
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        const OP: &str = "fetch";
        // A sandbox waits on all of it: its disk, state and pack.
        let _waited_on = self.lanes.foreground();
        let Some(head) = self.head(OP, id).await? else {
            crate::observe::notes::alarm(
                crate::observe::Alarm::CopyLost,
                &"the store holds no copy of this sandbox",
            );
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
        // Each runs to the end: a failure returns only once nothing of this
        // fetch writes into the sandbox's files any more.
        let (disk, profile, memory) = tokio::join!(disk, profile, self.fetch_memory(&head, into));
        disk?;
        profile?;
        memory
    }

    async fn delete(&self, id: Id, own: OwnerEpoch) -> Result<Owned<()>, EngineError> {
        match self.chunks.delete_pointer(&id.to_string(), own).await {
            Ok(()) => {
                self.confirmed.drop_sandbox(id);
                Ok(Owned::Done(()))
            }
            Err(StorageError::Fenced { by }) => Ok(Owned::Fenced { by }),
            Err(error) => Err(storage_error("delete", error)),
        }
    }

    async fn claim(&self, id: Id, own: OwnerEpoch) -> Result<Owned<Option<Claimed>>, EngineError> {
        const OP: &str = "claim";
        let (stamp, bytes) = match self.chunks.claim(&id.to_string(), own).await {
            Ok(Some(claimed)) => claimed,
            Ok(None) => return Ok(Owned::Done(None)),
            Err(StorageError::Fenced { by }) => return Ok(Owned::Fenced { by }),
            Err(error) => return Err(storage_error(OP, error)),
        };
        let head = parse_head(OP, &bytes)?;
        let disk = self
            .chunks
            .get_manifest(&head.disk)
            .await
            .map_err(|error| storage_error(OP, error))?;
        Ok(Owned::Done(Some(Claimed {
            save: stamp.save,
            receipt: receipt_of(&bytes),
            memory: head.memory.is_some(),
            disk_bytes: disk.disk_len,
        })))
    }

    async fn image_len(&self, image: ImageId) -> Result<Option<u64>, EngineError> {
        self.rootfs_len(image).await
    }

    async fn fetch_image(&self, image: ImageId, path: &Path) -> Result<bool, EngineError> {
        self.get_rootfs(image, path).await
    }

    async fn put_image(&self, path: &Path) -> Result<Option<ImageId>, EngineError> {
        self.put_rootfs(path).await.map(Some)
    }

    /// Points the sandbox at its disk alone, without the memory image or
    /// the working-set pack of its pages. Their chunks stay until a sweep
    /// finds nothing names them. The new pointer lands only on the version
    /// read, so a write held up past a newer copy never replaces it; a
    /// sweep's fence meanwhile means reading it again.
    ///
    /// It is stored under `change` even when the copy names no memory
    /// already: an earlier archive whose upload is still in flight is
    /// conditional on the version read here, and only a new version stops
    /// it from landing afterwards with the memory this forgets.
    async fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> Result<Owned<Option<Receipt>>, EngineError> {
        const OP: &str = "forget";
        /// Reads before giving up for now: each fence a sweep stored since
        /// the read costs one.
        const TRIES: usize = 3;
        let name = id.to_string();
        for _ in 0..TRIES {
            let (stored, change) = match self.chunks.read_for_change(&name, change).await {
                Ok(Rewrite::Change(stored, publication)) => (stored, publication),
                // An earlier try of this very change, whose answer was lost.
                Ok(Rewrite::Done(stored)) => return Ok(Owned::Done(Some(receipt_of(&stored)))),
                Ok(Rewrite::Outdated) => {
                    return Err(EngineError::new(
                        ErrorKind::Transient,
                        OP,
                        "the store holds a later change of this sandbox",
                    ));
                }
                Ok(Rewrite::Nothing) => return Ok(Owned::Done(None)),
                Err(StorageError::Fenced { by }) => return Ok(Owned::Fenced { by }),
                Err(error) => return Err(storage_error(OP, error)),
            };
            let head = parse_head(OP, &stored)?;
            let head = Head {
                memory: None,
                pack: None,
                ..head
            };
            let bytes = serde_json::to_vec(&head)
                .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
            let receipt = receipt_of(&bytes);
            match self.chunks.publish(change, bytes).await {
                Ok(()) => {
                    // The copy names part of what the one it replaces named.
                    let now = self.chunks.now();
                    if let Some(at) = self.confirmed.sandbox(id, &receipt_of(&stored), now) {
                        self.confirmed.confirm_sandbox(id, receipt.clone(), at);
                    }
                    return Ok(Owned::Done(Some(receipt)));
                }
                Err(StorageError::Superseded) => {}
                Err(error) => return Err(storage_error(OP, error)),
            }
        }
        Err(storage_error(OP, StorageError::Superseded))
    }

    fn chunks(&self) -> Option<(&ChunkStore, &Arc<Lanes>)> {
        Some((&self.chunks, &self.lanes))
    }
}

impl Chunked {
    /// Whether the store holds exactly the copy `receipt` names of `id`,
    /// every chunk of it intact (see [`Store::verify`]).
    async fn holds(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
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
        self.holds_all(OP, referenced.into_values()).await
    }
}

/// The whole chunks of a stored file, by offset.
fn whole_chunks(manifest: DiskManifest) -> HashMap<u64, ChunkRef> {
    manifest
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
        .collect()
}

/// What an archive may reuse (see [`Chunked::before`]).
struct Before {
    /// Since when everything the sandbox's earlier copy names is known to
    /// be stored, if this host stored or verified it recently.
    confirmed: Option<SystemTime>,
    /// The confirmed chunks of the image its disk was made from.
    image: Option<Arc<ImageChunks>>,
    disk: Earlier,
    state: Earlier,
    memory: Earlier,
}

/// What an archive may reuse of a file, by offset: what its own earlier
/// copy `own` holds there, confirmed to be stored if `own_confirmed`, and
/// what the confirmed `image` holds there if it differs. A chunk of the
/// earlier copy that the image holds at the same offset is confirmed with
/// the image.
fn reusable(
    own: HashMap<u64, ChunkRef>,
    own_confirmed: bool,
    image: Option<&HashMap<u64, ChunkRef>>,
) -> Earlier {
    let mut earlier: Earlier = HashMap::with_capacity(own.len().max(image.map_or(0, HashMap::len)));
    for (&offset, reference) in image.into_iter().flatten() {
        earlier.entry(offset).or_default().push(Reusable {
            reference: reference.clone(),
            confirmed: true,
        });
    }
    for (offset, reference) in own {
        let held = earlier.entry(offset).or_default();
        if held.iter().any(|reusable| reusable.reference == reference) {
            continue;
        }
        // After the image's, so a range that matches both names the
        // confirmed one.
        held.push(Reusable {
            reference,
            confirmed: own_confirmed,
        });
    }
    earlier
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

/// The receipt naming the copy a pointer holding `bytes` names.
fn receipt_of(bytes: &[u8]) -> Receipt {
    Receipt(blake3::hash(bytes).to_hex().to_string())
}

/// How a storage failure affects the sandbox.
fn storage_error(operation: &'static str, error: StorageError) -> EngineError {
    let kind = match &error {
        // Networks and disks recover; trying again later may work.
        StorageError::Io(_)
        | StorageError::Object(_)
        | StorageError::Transfer(_)
        | StorageError::Superseded => ErrorKind::Transient,
        // A stored copy that fails its checks will fail them again: the store
        // already retried the read and quarantined the object.
        // A later owner holds the copy: nothing this host does changes it.
        StorageError::Integrity
        | StorageError::Truncated { .. }
        | StorageError::Invalid(_)
        | StorageError::Unsupported(_)
        | StorageError::Fenced { .. }
        | StorageError::Json(_) => ErrorKind::Fatal,
    };
    EngineError::caused_by(kind, operation, error)
}

mod confirmed;
mod files;
mod rootfs;
pub(crate) use rootfs::file_id;
#[cfg(test)]
mod tests;
