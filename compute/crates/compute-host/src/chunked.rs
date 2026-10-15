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
//! Fetching brings the disk and device state back whole but leaves memory
//! in the store, to be paged in as the guest touches it (see
//! [`crate::lazy`]). A disk starts as a copy (a reflink where the
//! filesystem allows) of the host's base image it was created from, and
//! only chunks that differ from the base at the same offset are downloaded:
//! a sandbox that changed little of its disk wakes from local bytes.
//!
//! Chunks no pointer refers to any more are left for garbage collection,
//! which is not part of this module.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use compute_engine::{EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, Extent, ExtentSource};
use compute_storage::store::ChunkStore;
use futures::{StreamExt as _, TryStreamExt as _, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub use crate::image::CHUNK_BYTES;
use crate::image::{Hash, ZERO, chunk_count, chunk_range, data_ranges, hash_chunks, overlaps};
use crate::protocol::Id;
use crate::store::{FetchInto, FetchedMemory, Receipt, SavedFiles, Store};

/// Chunk transfers in flight per file.
const IN_FLIGHT: usize = 16;
/// zstd level 1: measured nearly as small as higher levels at a fraction of
/// the time, which matters because sleeping waits for it.
const ZSTD_LEVEL: i32 = 1;
/// Version 2 added the learned wake profile.
const HEAD_VERSION: u32 = 2;

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
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct MemoryHead {
    state: String,
    memory: String,
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

    /// Stores `path` and returns its manifest's digest. With `known`, the
    /// file's per-chunk hashes, chunks equal to the earlier copy's are taken
    /// from it without being read, and every chunk read is checked against
    /// its hash.
    async fn put_file(
        &self,
        path: &Path,
        earlier: HashMap<u64, ChunkRef>,
        known: Option<Arc<Vec<Hash>>>,
    ) -> Result<String, EngineError> {
        const OP: &str = "archive";
        let file = File::open(path).map_err(|error| EngineError::io(OP, error))?;
        let length = file
            .metadata()
            .map_err(|error| EngineError::io(OP, error))?
            .len();
        if known
            .as_ref()
            .is_some_and(|known| known.len() != chunk_count(length))
        {
            return Err(EngineError::new(
                ErrorKind::Fatal,
                OP,
                format!("{}: chunk map does not match its length", path.display()),
            ));
        }
        let data = data_ranges(&file, length).map_err(|error| EngineError::io(OP, error))?;
        let file = Arc::new(file);
        let earlier = Arc::new(earlier);
        let wanted = (0..chunk_count(length)).filter(|&index| match &known {
            Some(known) => known[index] != ZERO,
            None => overlaps(&data, &chunk_range(index, length)),
        });
        let pieces: Vec<(Range<u64>, Option<ChunkRef>)> = stream::iter(wanted)
            .map(|index| {
                let file = Arc::clone(&file);
                let earlier = Arc::clone(&earlier);
                let chunks = self.chunks.clone();
                let expected = known.as_ref().map(|known| known[index]);
                async move {
                    let range = chunk_range(index, length);
                    let at = range.start;
                    let read = range.clone();
                    let prepared = tokio::task::spawn_blocking(move || {
                        prepare(&file, read, earlier.get(&at), expected)
                    })
                    .await
                    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
                    .map_err(|error| storage_error(OP, error))?;
                    let reference = match prepared {
                        Prepared::Zero => None,
                        Prepared::Known(reference) => Some(reference),
                        Prepared::New(chunk) => {
                            chunks
                                .put_chunk(&chunk)
                                .await
                                .map_err(|error| storage_error(OP, error))?;
                            Some(chunk.reference)
                        }
                    };
                    Ok::<_, EngineError>((range, reference))
                }
            })
            .buffered(IN_FLIGHT)
            .try_collect()
            .await?;
        let manifest = DiskManifest {
            version: 1,
            disk_len: length,
            base_len: 0,
            base_digest: "0".repeat(64),
            extents: extents(length, pieces),
        };
        self.chunks
            .put_manifest(&manifest)
            .await
            .map_err(|error| storage_error(OP, error))
    }

    /// Writes the file a manifest describes to `path`, replacing it whole.
    /// With a `seed`, the file starts as a copy of it and only chunks that
    /// differ from the seed at the same offset are downloaded.
    async fn get_file(
        &self,
        digest: &str,
        path: &Path,
        seed: Option<&Seed>,
    ) -> Result<(), EngineError> {
        const OP: &str = "fetch";
        let manifest = self
            .chunks
            .get_manifest(digest)
            .await
            .map_err(|error| storage_error(OP, error))?;
        let staging = staging_path(path);
        let seed = match seed {
            Some(seed) if copy_seed(seed, &staging).await? => Some(seed),
            _ => None,
        };
        let file = if seed.is_some() {
            fs::OpenOptions::new().write(true).open(&staging)
        } else {
            File::create(&staging)
        }
        .map_err(|error| EngineError::io(OP, error))?;
        file.set_len(manifest.disk_len)
            .map_err(|error| EngineError::io(OP, error))?;
        let file = Arc::new(file);
        let Plan {
            reads,
            zeros,
            local,
        } = plan(manifest.extents, seed)?;
        if !zeros.is_empty() {
            let file = Arc::clone(&file);
            tokio::task::spawn_blocking(move || {
                zeros
                    .into_iter()
                    .try_for_each(|range| punch_hole(&file, range))
            })
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
            .map_err(|error| EngineError::io(OP, error))?;
        }
        let downloaded: u64 = reads.iter().map(|(_, length, ..)| length).sum();
        tracing::debug!(
            path = %path.display(),
            local_mib = local >> 20,
            downloaded_mib = downloaded >> 20,
            "fetching file"
        );
        stream::iter(reads)
            .map(|(at, length, reference, within)| {
                let file = Arc::clone(&file);
                let chunks = self.chunks.clone();
                async move {
                    let plain = chunks
                        .get_chunk(&reference)
                        .await
                        .map_err(|error| storage_error(OP, error))?;
                    tokio::task::spawn_blocking(move || {
                        let start = usize::try_from(within).unwrap_or(usize::MAX);
                        let bytes = usize::try_from(length)
                            .ok()
                            .and_then(|length| plain.get(start..start.checked_add(length)?))
                            .ok_or_else(|| io::Error::other("extent outside its chunk"))?;
                        file.write_all_at(bytes, at)
                    })
                    .await
                    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
                    .map_err(|error| EngineError::io(OP, error))
                }
            })
            .buffer_unordered(IN_FLIGHT)
            .try_collect::<()>()
            .await?;
        let target = path.to_owned();
        tokio::task::spawn_blocking(move || {
            file.sync_all()?;
            fs::rename(&staging, &target)?;
            match target.parent() {
                Some(parent) => File::open(parent)?.sync_all(),
                None => Ok(()),
            }
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| EngineError::io(OP, error))
    }
}

impl Store for Chunked {
    async fn archive(&self, id: Id, files: &SavedFiles) -> Result<Receipt, EngineError> {
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
        let disk = self.put_file(&files.disk, disk_before, None);
        let memory = async {
            let Some(image) = &files.memory else {
                return Ok(None);
            };
            let (state, memory) = tokio::try_join!(
                self.put_file(&image.state, state_before, None),
                self.put_file(&image.memory, memory_before, image.chunks.clone()),
            )?;
            Ok(Some(MemoryHead { state, memory }))
        };
        let profile = async {
            let Some(path) = &files.profile else {
                return Ok(None);
            };
            let Ok(bytes) = tokio::fs::read(path).await else {
                return Ok(None);
            };
            if bytes.is_empty() {
                return Ok(None);
            }
            let chunk = EncodedChunk::encode(&bytes, ZSTD_LEVEL)
                .map_err(|error| storage_error(OP, error))?;
            self.chunks
                .put_chunk(&chunk)
                .await
                .map_err(|error| storage_error(OP, error))?;
            Ok(Some(chunk.reference))
        };
        let (disk, memory, profile) = tokio::try_join!(disk, memory, profile)?;
        let head = Head {
            version: HEAD_VERSION,
            disk,
            memory,
            profile,
        };
        let bytes = serde_json::to_vec(&head)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
        let receipt = Receipt(blake3::hash(&bytes).to_hex().to_string());
        self.chunks
            .put_pointer(&id.to_string(), bytes)
            .await
            .map_err(|error| storage_error(OP, error))?;
        Ok(receipt)
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
        for digest in digests {
            // Fetching checks each manifest against its digest.
            match self.chunks.get_manifest(&digest).await {
                Ok(_) => {}
                Err(
                    StorageError::Object(object_store::Error::NotFound { .. })
                    | StorageError::Integrity
                    | StorageError::Invalid(_)
                    | StorageError::Json(_),
                ) => return Ok(false),
                Err(error) => return Err(storage_error(OP, error)),
            }
        }
        Ok(true)
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        const OP: &str = "fetch";
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
            let manifest = async {
                self.chunks
                    .get_manifest(&stored.memory)
                    .await
                    .map_err(|error| storage_error(OP, error))
            };
            let ((), manifest) =
                tokio::try_join!(self.get_file(&stored.state, &state, None), manifest)?;
            if let Some(refs) = chunk_refs(&manifest) {
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
                });
            }
            // A manifest not laid out in whole chunks cannot be paged in;
            // bring the memory back whole instead.
            let memory = into.scratch.join("memory");
            self.get_file(&stored.memory, &memory, None).await?;
            Ok(FetchedMemory::Local { state, memory })
        };
        let ((), (), memory) = tokio::try_join!(disk, profile, memory)?;
        Ok(memory)
    }

    async fn delete(&self, id: Id) -> Result<(), EngineError> {
        self.chunks
            .delete_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error("delete", error))
    }

    fn chunks(&self) -> Option<&ChunkStore> {
        Some(&self.chunks)
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

/// What one chunk-sized range of a file turned out to hold.
enum Prepared {
    Zero,
    Known(ChunkRef),
    New(EncodedChunk),
}

/// Reads `range` and decides how to store it: as zeros, as the chunk stored
/// there before if the bytes are unchanged, or as a new chunk. With
/// `expected`, the range's hash from the image's chunk map, an unchanged
/// chunk is recognised without reading it, and a chunk read is checked.
fn prepare(
    file: &File,
    range: Range<u64>,
    earlier: Option<&ChunkRef>,
    expected: Option<Hash>,
) -> Result<Prepared, StorageError> {
    if let (Some(expected), Some(earlier)) = (expected, earlier)
        && u64::from(earlier.plain_len) == range.end - range.start
        && hash_from_hex(&earlier.hash) == Ok(expected)
    {
        return Ok(Prepared::Known(earlier.clone()));
    }
    let length = usize::try_from(range.end - range.start)
        .map_err(|_| StorageError::Invalid("chunk length"))?;
    let mut plain = vec![0_u8; length];
    file.read_exact_at(&mut plain, range.start)?;
    let zero = plain.iter().all(|&byte| byte == 0);
    let hash = blake3::hash(&plain);
    if let Some(expected) = expected {
        let actual = if zero { ZERO } else { *hash.as_bytes() };
        if actual != expected {
            // The image no longer matches the map made when it was saved.
            return Err(StorageError::Integrity);
        }
    }
    if zero {
        return Ok(Prepared::Zero);
    }
    if let Some(earlier) = earlier
        && earlier.plain_len as usize == plain.len()
        && hash.to_hex().as_str() == earlier.hash
    {
        return Ok(Prepared::Known(earlier.clone()));
    }
    EncodedChunk::encode(&plain, ZSTD_LEVEL).map(Prepared::New)
}

/// A complete manifest from the stored chunks, with every gap between them
/// and every run of zero chunks recorded as zeros.
fn extents(length: u64, pieces: Vec<(Range<u64>, Option<ChunkRef>)>) -> Vec<Extent> {
    fn push_zeros(extents: &mut Vec<Extent>, from: Option<u64>, to: u64) {
        if let Some(from) = from
            && from < to
        {
            extents.push(Extent {
                offset: from,
                length: to - from,
                source: ExtentSource::Zero,
            });
        }
    }

    let mut extents: Vec<Extent> = Vec::with_capacity(pieces.len() + 1);
    let mut zero_from = None;
    let mut cursor = 0;
    for (range, reference) in pieces {
        if range.start > cursor {
            zero_from.get_or_insert(cursor);
        }
        match reference {
            None => {
                zero_from.get_or_insert(range.start);
            }
            Some(reference) => {
                push_zeros(&mut extents, zero_from.take(), range.start);
                extents.push(Extent {
                    offset: range.start,
                    length: range.end - range.start,
                    source: ExtentSource::Chunk {
                        reference,
                        offset: 0,
                    },
                });
            }
        }
        cursor = range.end;
    }
    if cursor < length {
        zero_from.get_or_insert(cursor);
    }
    push_zeros(&mut extents, zero_from, length);
    extents
}

fn staging_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".fetching");
    path.with_file_name(name)
}

/// One chunk range to download: where it goes, its length, its chunk and
/// where in the chunk it starts.
type Read = (u64, u64, ChunkRef, u32);

/// How a fetched file is filled in.
struct Plan {
    /// Ranges to download.
    reads: Vec<Read>,
    /// Ranges a seeded file must have zeroed.
    zeros: Vec<Range<u64>>,
    /// Bytes the seed already holds.
    local: u64,
}

/// Decides which of a manifest's `extents` must be downloaded, given the
/// file starts as a copy of `seed` (or empty without one).
fn plan(extents: Vec<Extent>, seed: Option<&Seed>) -> Result<Plan, EngineError> {
    let mut plan = Plan {
        reads: Vec::new(),
        zeros: Vec::new(),
        local: 0,
    };
    for extent in extents {
        match extent.source {
            // A fresh file is zeros already; a seeded one may not be.
            ExtentSource::Zero => {
                if seed.is_some() {
                    plan.zeros
                        .push(extent.offset..extent.offset + extent.length);
                }
            }
            ExtentSource::Chunk { reference, offset } => {
                let whole = offset == 0
                    && extent.offset % CHUNK_BYTES == 0
                    && extent.length == u64::from(reference.plain_len);
                let index = usize::try_from(extent.offset / CHUNK_BYTES).unwrap_or(usize::MAX);
                if whole && seed.is_some_and(|seed| seed.holds(index, &reference.hash)) {
                    plan.local += extent.length;
                } else {
                    plan.reads
                        .push((extent.offset, extent.length, reference, offset));
                }
            }
            ExtentSource::Base { .. } => {
                return Err(EngineError::new(
                    ErrorKind::Fatal,
                    "fetch",
                    "stored copy refers to a base image this store does not hold",
                ));
            }
        }
    }
    Ok(plan)
}

/// Starts `staging` as a copy of `seed`'s file. Returns whether the copy
/// matches the seed's hashes; a file replaced since they were taken does
/// not, and the fetch then starts from an empty file instead.
async fn copy_seed(seed: &Seed, staging: &Path) -> Result<bool, EngineError> {
    let (from, to) = (seed.path.clone(), staging.to_owned());
    let identity = seed.identity;
    let copied = tokio::task::spawn_blocking(move || {
        crate::layout::copy_sparse(&from, &to)?;
        Ok::<_, io::Error>(Identity::of(&from)? == identity)
    })
    .await
    .map_err(|error| EngineError::caused_by(ErrorKind::Transient, "fetch", error))?;
    Ok(copied.unwrap_or_else(|error| {
        tracing::debug!(%error, "could not start from the base image");
        false
    }))
}

/// Makes `range` of `file` read as zeros, freeing its blocks.
#[cfg(target_os = "linux")]
fn punch_hole(file: &File, range: Range<u64>) -> io::Result<()> {
    use rustix::fs::{FallocateFlags, fallocate};
    fallocate(
        file,
        FallocateFlags::PUNCH_HOLE | FallocateFlags::KEEP_SIZE,
        range.start,
        range.end - range.start,
    )
    .map_err(io::Error::from)
}

#[cfg(not(target_os = "linux"))]
fn punch_hole(file: &File, range: Range<u64>) -> io::Result<()> {
    let zeros = vec![0_u8; usize::try_from(CHUNK_BYTES).unwrap_or(0)];
    let mut at = range.start;
    while at < range.end {
        let length = usize::try_from((range.end - at).min(CHUNK_BYTES)).unwrap_or(0);
        file.write_all_at(&zeros[..length], at)?;
        at += length as u64;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::Arc;

    use object_store::memory::InMemory;
    use object_store::{ObjectStore, path::Path as ObjectPath};

    use super::*;
    use crate::protocol::Id;

    fn id(value: &str) -> Id {
        value.parse().unwrap()
    }

    /// A sparse file of `length` bytes with `bytes` written at each offset.
    fn sparse(path: &Path, length: u64, writes: &[(u64, &[u8])]) {
        let mut file = File::create(path).unwrap();
        file.set_len(length).unwrap();
        for (at, bytes) in writes {
            file.seek(SeekFrom::Start(*at)).unwrap();
            file.write_all(bytes).unwrap();
        }
    }

    fn files(dir: &Path, memory: bool) -> SavedFiles {
        SavedFiles {
            disk: dir.join("disk"),
            memory: memory.then(|| crate::store::SavedImage {
                state: dir.join("state"),
                memory: dir.join("memory"),
                chunks: None,
            }),
            profile: None,
        }
    }

    async fn objects(backend: &InMemory, prefix: &str) -> usize {
        backend
            .list(Some(&ObjectPath::from(prefix)))
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .len()
    }

    #[test]
    fn manifests_cover_the_whole_file_and_merge_zeros() {
        let chunk = EncodedChunk::encode(&[1; 16], 1).unwrap().reference;
        let at = |start: u64| start..start + 16;
        let manifest = extents(
            100,
            vec![
                (at(16), None),
                (at(32), Some(chunk.clone())),
                (at(64), None),
            ],
        );
        let layout: Vec<_> = manifest
            .iter()
            .map(|extent| {
                let zero = matches!(extent.source, ExtentSource::Zero);
                (extent.offset, extent.length, zero)
            })
            .collect();
        assert_eq!(layout, [(0, 32, true), (32, 16, false), (48, 52, true)]);
        assert_eq!(
            extents(10, Vec::new())
                .iter()
                .map(|extent| (extent.offset, extent.length))
                .collect::<Vec<_>>(),
            [(0, 10)]
        );
    }

    #[test]
    fn overlap_finds_data_inside_a_chunk() {
        let data = [10..20, 40..50];
        assert!(overlaps(&data, &(0..11)));
        assert!(overlaps(&data, &(19..30)));
        assert!(!overlaps(&data, &(20..40)));
        assert!(overlaps(&data, &(30..60)));
        assert!(!overlaps(&data, &(50..90)));
    }

    fn into(dir: &Path, memory: bool) -> FetchInto {
        FetchInto {
            disk: dir.join("disk"),
            scratch: dir.join("scratch"),
            profile: dir.join("profile"),
            memory,
            seed: None,
        }
    }

    #[tokio::test]
    async fn a_disk_fetched_over_its_base_downloads_only_what_differs() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let at = |chunk: u64, within: u64| chunk * CHUNK_BYTES + within;
        sparse(
            &base,
            at(4, 500),
            &[
                (at(0, 1), b"same"),
                (at(1, 2), b"before"),
                (at(2, 3), b"erased"),
                (at(3, 4), b"kept"),
            ],
        );
        let backend = Arc::new(InMemory::new());
        let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
        let mut base_files = files(dir.path(), false);
        base_files.disk.clone_from(&base);
        store
            .archive(id("00000000000000000000000000000001"), &base_files)
            .await
            .unwrap();
        let base_chunks: Vec<_> = backend
            .list(Some(&ObjectPath::from("t/chunks")))
            .map_ok(|object| object.location)
            .try_collect()
            .await
            .unwrap();

        // The sandbox changed one chunk, erased another and grew.
        let saved = files(dir.path(), false);
        sparse(
            &saved.disk,
            at(5, 9),
            &[
                (at(0, 1), b"same"),
                (at(1, 2), b"after!"),
                (at(3, 4), b"kept"),
                (at(4, 600), b"grown"),
            ],
        );
        let sandbox = id("00000000000000000000000000000002");
        store.archive(sandbox, &saved).await.unwrap();
        // Only the base's copy of the unchanged chunks remains, locally.
        for location in &base_chunks {
            backend.delete(location).await.unwrap();
        }

        let restored = tempfile::tempdir().unwrap();
        let mut into = into(restored.path(), false);
        assert!(
            store.fetch(sandbox, &into).await.is_err(),
            "without the base the deleted chunks are needed"
        );
        into.seed = Some(base.clone());
        store.fetch(sandbox, &into).await.unwrap();
        assert_eq!(
            fs::read(&saved.disk).unwrap(),
            fs::read(&into.disk).unwrap()
        );

        // A changed base is hashed again, never trusted from before.
        sparse(&base, at(4, 500), &[(at(0, 1), b"SAME")]);
        assert!(store.fetch(sandbox, &into).await.is_err());
    }

    /// Rebuilds a memory file from a remote image's manifest, as lazy wake
    /// pages it in.
    async fn page_in(store: &Chunked, manifest: &[u8]) -> Vec<u8> {
        let manifest = DiskManifest::decode(manifest).unwrap();
        let refs = chunk_refs(&manifest).expect("memory is stored in whole chunks");
        let mut memory = vec![0; usize::try_from(manifest.disk_len).unwrap()];
        for (index, reference) in refs.iter().enumerate() {
            if let Some(reference) = reference {
                let range = chunk_range(index, manifest.disk_len);
                let bytes = store.chunks.get_chunk(reference).await.unwrap();
                memory[usize::try_from(range.start).unwrap()..usize::try_from(range.end).unwrap()]
                    .copy_from_slice(&bytes);
            }
        }
        memory
    }

    #[tokio::test]
    async fn a_sandbox_comes_back_byte_for_byte_and_unchanged_chunks_are_not_stored_twice() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = files(dir.path(), true);
        let big = 3 * CHUNK_BYTES + 1000;
        sparse(
            &saved.disk,
            big,
            &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
        );
        let snapshot = saved.memory.clone().unwrap();
        sparse(&snapshot.state, 300, &[(0, b"state")]);
        sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"memory")]);
        fs::write(dir.path().join("profile"), b"[1,2,3]").unwrap();
        saved.profile = Some(dir.path().join("profile"));

        let backend = Arc::new(InMemory::new());
        let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
        let sandbox = id("0123456789abcdef0123456789abcdef");
        let first = store.archive(sandbox, &saved).await.unwrap();
        let chunks = objects(&backend, "t/chunks").await;
        assert_eq!(
            chunks, 5,
            "one chunk per range holding data, and the profile"
        );
        assert!(store.verify(sandbox, &first).await.unwrap());

        // Change one byte: only that chunk is stored again, and the old
        // receipt no longer matches what the store holds.
        sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"Memory")]);
        sparse(
            &saved.disk,
            big,
            &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
        );
        let second = store.archive(sandbox, &saved).await.unwrap();
        assert_eq!(objects(&backend, "t/chunks").await, chunks + 1);
        assert!(!store.verify(sandbox, &first).await.unwrap());
        assert!(store.verify(sandbox, &second).await.unwrap());

        let restored = tempfile::tempdir().unwrap();
        let into = into(restored.path(), true);
        let FetchedMemory::Remote {
            state,
            memory_len,
            chunks: map,
            manifest,
        } = store.fetch(sandbox, &into).await.unwrap()
        else {
            panic!("memory should stay in the store");
        };
        assert_eq!(memory_len, big);
        assert_eq!(
            fs::read(&saved.disk).unwrap(),
            fs::read(&into.disk).unwrap()
        );
        assert_eq!(
            fs::read(&snapshot.state).unwrap(),
            fs::read(&state).unwrap()
        );
        assert_eq!(fs::read(&into.profile).unwrap(), b"[1,2,3]");
        let memory = fs::read(&snapshot.memory).unwrap();
        assert_eq!(page_in(&store, &manifest).await, memory);
        // The chunk map fetched equals one computed from the bytes.
        let file = File::open(&snapshot.memory).unwrap();
        let all: Vec<usize> = (0..chunk_count(big)).collect();
        assert_eq!(map, crate::image::hash_chunks(&file, big, &all).unwrap());
        assert!(!staging_path(&into.disk).exists());

        store.delete(sandbox).await.unwrap();
        assert!(!store.verify(sandbox, &second).await.unwrap());
        let gone = store.fetch(sandbox, &into).await.unwrap_err();
        assert_eq!(gone.kind, ErrorKind::Fatal);
    }

    #[tokio::test]
    async fn a_chunk_map_skips_unchanged_chunks_and_catches_a_changed_image() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = files(dir.path(), true);
        let big = 4 * CHUNK_BYTES;
        sparse(&saved.disk, CHUNK_BYTES, &[(0, b"disk")]);
        let image = saved.memory.clone().unwrap();
        sparse(&image.state, 10, &[(0, b"s")]);
        sparse(
            &image.memory,
            big,
            &[(0, b"zero"), (2 * CHUNK_BYTES, b"two")],
        );
        let file = File::open(&image.memory).unwrap();
        let all: Vec<usize> = (0..4).collect();
        let map = Arc::new(crate::image::hash_chunks(&file, big, &all).unwrap());
        saved.memory.as_mut().unwrap().chunks = Some(Arc::clone(&map));
        let store = Chunked::new(ChunkStore::new(
            Arc::new(InMemory::new()),
            ObjectPath::from("t"),
        ));
        let sandbox = id("00000000000000000000000000000002");
        store.archive(sandbox, &saved).await.unwrap();
        // Unchanged per the map: archived again without reading, so even an
        // unreadable memory file does not matter.
        fs::remove_file(&image.memory).unwrap();
        File::create(&image.memory).unwrap().set_len(big).unwrap();
        let mut stale = (*map).clone();
        stale[3] = [7; 32];
        saved.memory.as_mut().unwrap().chunks = Some(Arc::new(stale));
        // ...but a chunk the map says changed is read and must match it.
        let error = store.archive(sandbox, &saved).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Fatal);
        saved.memory.as_mut().unwrap().chunks = Some(map);
        store.archive(sandbox, &saved).await.unwrap();
    }

    #[tokio::test]
    async fn a_disk_only_copy_cannot_supply_a_memory_image() {
        let dir = tempfile::tempdir().unwrap();
        let saved = files(dir.path(), false);
        sparse(&saved.disk, CHUNK_BYTES, &[(0, b"disk")]);
        let store = Chunked::new(ChunkStore::new(
            Arc::new(InMemory::new()),
            ObjectPath::from("t"),
        ));
        let sandbox = id("00000000000000000000000000000001");
        store.archive(sandbox, &saved).await.unwrap();
        let restored = tempfile::tempdir().unwrap();
        let error = store
            .fetch(sandbox, &into(restored.path(), true))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::MemoryLost);
    }

    #[test]
    fn hex_hashes_round_trip() {
        let hash = blake3::hash(b"x");
        assert_eq!(hash_from_hex(hash.to_hex().as_str()), Ok(*hash.as_bytes()));
        assert!(hash_from_hex("zz").is_err());
    }
}
