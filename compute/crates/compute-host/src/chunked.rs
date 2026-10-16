//! Sandboxes kept in object storage as compressed, deduplicated chunks.
//!
//! Each file of a saved sandbox (its disk, and its device state and memory
//! image if it has them) is stored as a manifest: a complete map of the file
//! in which every range is either zeros or one content-addressed chunk.
//! Chunks are immutable and shared by everything under the same prefix, so a
//! sandbox archived again after a small change, or two sandboxes holding the
//! same bytes, store those bytes once.
//!
//! A small pointer per sandbox names the manifests of its current copy. It is
//! written last, after every chunk and manifest it names is stored, so a
//! crash mid-archive leaves the previous copy intact. Memory and disk are
//! named by the same pointer: they are only ever restored together.
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

use compute_engine::{EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, Extent, ExtentSource};
use compute_storage::store::ChunkStore;
use futures::{StreamExt as _, TryStreamExt as _, stream};
use serde::{Deserialize, Serialize};

use crate::protocol::Id;
use crate::store::{SavedFiles, Store};

/// Bytes per chunk. Large enough that one object request moves a useful
/// amount, small enough that a small edit re-uploads little.
pub const CHUNK_BYTES: u64 = 256 << 10;
/// Chunk transfers in flight per file.
const IN_FLIGHT: usize = 16;
/// zstd level 1: measured nearly as small as higher levels at a fraction of
/// the time, which matters because sleeping waits for it.
const ZSTD_LEVEL: i32 = 1;

/// The manifests that make up one sandbox's stored copy.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Head {
    version: u32,
    disk: String,
    memory: Option<MemoryHead>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct MemoryHead {
    state: String,
    memory: String,
}

/// Keeps sandboxes in object storage (Google Cloud Storage, Azure Blob, S3)
/// as deduplicated chunks.
#[derive(Clone, Debug)]
pub struct Chunked {
    chunks: ChunkStore,
}

impl Chunked {
    /// Keeps sandboxes in `chunks`. Everything under its prefix shares
    /// chunks, so the prefix is also the boundary of who may see whose bytes.
    #[must_use]
    pub fn new(chunks: ChunkStore) -> Self {
        Self { chunks }
    }

    /// Opens the object storage `url` names: `gs://bucket/prefix`,
    /// `az://container/prefix` or `s3://bucket/prefix`, with credentials
    /// from the environment or the machine's own identity. `None` if `url`
    /// is not an object storage URL.
    pub fn from_url(url: &str) -> Result<Option<Self>, object_store::Error> {
        use object_store::ObjectStore;
        use object_store::aws::AmazonS3Builder;
        use object_store::azure::MicrosoftAzureBuilder;
        use object_store::gcp::GoogleCloudStorageBuilder;

        let Some((scheme, rest)) = url.split_once("://") else {
            return Ok(None);
        };
        let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
        let backend: Arc<dyn ObjectStore> = match scheme {
            "gs" => Arc::new(
                GoogleCloudStorageBuilder::from_env()
                    .with_bucket_name(bucket)
                    .build()?,
            ),
            "az" => Arc::new(
                MicrosoftAzureBuilder::from_env()
                    .with_container_name(bucket)
                    .build()?,
            ),
            "s3" => Arc::new(
                AmazonS3Builder::from_env()
                    .with_bucket_name(bucket)
                    .build()?,
            ),
            other => {
                return Err(object_store::Error::Generic {
                    store: "compute-host",
                    source: format!("unknown store {other}://; use gs://, az:// or s3://").into(),
                });
            }
        };
        let prefix = object_store::path::Path::from(prefix.trim_end_matches('/'));
        Ok(Some(Self::new(ChunkStore::new(backend, prefix))))
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
        let head: Head = serde_json::from_slice(&bytes)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, operation, error))?;
        if head.version != 1 {
            return Err(EngineError::new(
                ErrorKind::Fatal,
                operation,
                format!("unknown stored copy version {}", head.version),
            ));
        }
        Ok(Some(head))
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

    /// Stores `path` and returns its manifest's digest.
    async fn put_file(
        &self,
        path: &Path,
        earlier: HashMap<u64, ChunkRef>,
    ) -> Result<String, EngineError> {
        const OP: &str = "archive";
        let file = File::open(path).map_err(|error| EngineError::io(OP, error))?;
        let length = file
            .metadata()
            .map_err(|error| EngineError::io(OP, error))?
            .len();
        let data = data_ranges(&file, length).map_err(|error| EngineError::io(OP, error))?;
        let file = Arc::new(file);
        let earlier = Arc::new(earlier);
        let pieces: Vec<(Range<u64>, Option<ChunkRef>)> =
            stream::iter(chunk_ranges(length).filter(|range| overlaps(&data, range)))
                .map(|range| {
                    let file = Arc::clone(&file);
                    let earlier = Arc::clone(&earlier);
                    let chunks = self.chunks.clone();
                    async move {
                        let at = range.start;
                        let read = range.clone();
                        let prepared = tokio::task::spawn_blocking(move || {
                            prepare(&file, read, earlier.get(&at))
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
    async fn get_file(&self, digest: &str, path: &Path) -> Result<(), EngineError> {
        const OP: &str = "fetch";
        let manifest = self
            .chunks
            .get_manifest(digest)
            .await
            .map_err(|error| storage_error(OP, error))?;
        let staging = staging_path(path);
        let file = File::create(&staging).map_err(|error| EngineError::io(OP, error))?;
        file.set_len(manifest.disk_len)
            .map_err(|error| EngineError::io(OP, error))?;
        let file = Arc::new(file);
        let mut reads = Vec::new();
        for extent in manifest.extents {
            match extent.source {
                ExtentSource::Zero => {}
                ExtentSource::Chunk { reference, offset } => {
                    reads.push((extent.offset, extent.length, reference, offset));
                }
                ExtentSource::Base { .. } => {
                    return Err(EngineError::new(
                        ErrorKind::Fatal,
                        OP,
                        "stored copy refers to a base image this store does not hold",
                    ));
                }
            }
        }
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
    async fn archive(&self, id: Id, files: &SavedFiles) -> Result<(), EngineError> {
        let earlier = match self.head("archive", id).await {
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
        let disk = self.put_file(&files.disk, disk_before);
        let memory = async {
            let Some(snapshot) = &files.memory else {
                return Ok(None);
            };
            let (state, memory) = tokio::try_join!(
                self.put_file(&snapshot.state, state_before),
                self.put_file(&snapshot.memory, memory_before),
            )?;
            Ok(Some(MemoryHead { state, memory }))
        };
        let (disk, memory) = tokio::try_join!(disk, memory)?;
        let head = Head {
            version: 1,
            disk,
            memory,
        };
        let bytes = serde_json::to_vec(&head)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, "archive", error))?;
        self.chunks
            .put_pointer(&id.to_string(), bytes)
            .await
            .map_err(|error| storage_error("archive", error))
    }

    async fn fetch(&self, id: Id, files: &SavedFiles) -> Result<(), EngineError> {
        let Some(head) = self.head("fetch", id).await? else {
            return Err(EngineError::new(
                ErrorKind::Fatal,
                "fetch",
                "no stored copy of this sandbox",
            ));
        };
        let disk = self.get_file(&head.disk, &files.disk);
        let memory = async {
            let Some(snapshot) = &files.memory else {
                return Ok(());
            };
            let Some(stored) = &head.memory else {
                return Err(EngineError::new(
                    ErrorKind::MemoryLost,
                    "fetch",
                    "the stored copy has no memory image",
                ));
            };
            tokio::try_join!(
                self.get_file(&stored.state, &snapshot.state),
                self.get_file(&stored.memory, &snapshot.memory),
            )
            .map(|_| ())
        };
        tokio::try_join!(disk, memory).map(|_| ())
    }

    async fn delete(&self, id: Id) -> Result<(), EngineError> {
        self.chunks
            .delete_pointer(&id.to_string())
            .await
            .map_err(|error| storage_error("delete", error))
    }

    /// Points the sandbox at its disk alone. The memory chunks stay until
    /// garbage collection finds nothing refers to them.
    async fn forget_memory(&self, id: Id) -> Result<(), EngineError> {
        let Some(head) = self.head("forget", id).await? else {
            return Ok(());
        };
        if head.memory.is_none() {
            return Ok(());
        }
        let head = Head {
            memory: None,
            ..head
        };
        let bytes = serde_json::to_vec(&head)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, "forget", error))?;
        self.chunks
            .put_pointer(&id.to_string(), bytes)
            .await
            .map_err(|error| storage_error("forget", error))
    }
}

/// What one chunk-sized range of a file turned out to hold.
enum Prepared {
    Zero,
    Known(ChunkRef),
    New(EncodedChunk),
}

/// Reads `range` and decides how to store it: as zeros, as the chunk stored
/// there before if the bytes are unchanged, or as a new chunk.
fn prepare(
    file: &File,
    range: Range<u64>,
    earlier: Option<&ChunkRef>,
) -> Result<Prepared, StorageError> {
    let length = usize::try_from(range.end - range.start)
        .map_err(|_| StorageError::Invalid("chunk length"))?;
    let mut plain = vec![0_u8; length];
    file.read_exact_at(&mut plain, range.start)?;
    if plain.iter().all(|&byte| byte == 0) {
        return Ok(Prepared::Zero);
    }
    if let Some(earlier) = earlier
        && earlier.plain_len as usize == plain.len()
        && blake3::hash(&plain).to_hex().as_str() == earlier.hash
    {
        return Ok(Prepared::Known(earlier.clone()));
    }
    EncodedChunk::encode(&plain, ZSTD_LEVEL).map(Prepared::New)
}

/// The chunk-sized ranges covering a file of `length` bytes.
fn chunk_ranges(length: u64) -> impl Iterator<Item = Range<u64>> {
    (0..length.div_ceil(CHUNK_BYTES)).map(move |index| {
        let start = index * CHUNK_BYTES;
        start..(start + CHUNK_BYTES).min(length)
    })
}

/// Whether `range` touches any of the sorted, disjoint `data` ranges.
fn overlaps(data: &[Range<u64>], range: &Range<u64>) -> bool {
    let first_after = data.partition_point(|data| data.end <= range.start);
    data.get(first_after)
        .is_some_and(|data| data.start < range.end)
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

/// The ranges of `file` that hold data; holes in a sparse file are skipped
/// without being read.
#[cfg(target_os = "linux")]
fn data_ranges(file: &File, length: u64) -> io::Result<Vec<Range<u64>>> {
    use rustix::fs::SeekFrom;

    let mut ranges = Vec::new();
    let mut offset = 0_u64;
    while offset < length {
        let start = match rustix::fs::seek(file, SeekFrom::Data(offset)) {
            Ok(start) => start,
            Err(rustix::io::Errno::NXIO) => break,
            Err(error) => return Err(error.into()),
        };
        let end = rustix::fs::seek(file, SeekFrom::Hole(start))?.min(length);
        if end > start {
            ranges.push(start..end);
        }
        offset = end.max(start + 1);
    }
    Ok(ranges)
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::unnecessary_wraps)]
fn data_ranges(_: &File, length: u64) -> io::Result<Vec<Range<u64>>> {
    Ok(std::iter::once(0..length).collect())
}

/// How a storage failure affects the sandbox.
fn storage_error(operation: &'static str, error: StorageError) -> EngineError {
    let kind = match &error {
        // Networks and disks recover; trying again later may work.
        StorageError::Io(_) | StorageError::Object(_) => ErrorKind::Transient,
        // A stored copy that fails its checks will fail them again.
        StorageError::Integrity | StorageError::Invalid(_) | StorageError::Json(_) => {
            ErrorKind::Fatal
        }
    };
    EngineError::caused_by(kind, operation, error)
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::Arc;

    use compute_engine::SnapshotFiles;
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
            memory: memory.then(|| SnapshotFiles {
                state: dir.join("state"),
                memory: dir.join("memory"),
            }),
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

    #[tokio::test]
    async fn a_sandbox_comes_back_byte_for_byte_and_unchanged_chunks_are_not_stored_twice() {
        let dir = tempfile::tempdir().unwrap();
        let saved = files(dir.path(), true);
        let big = 3 * CHUNK_BYTES + 1000;
        sparse(
            &saved.disk,
            big,
            &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
        );
        let snapshot = saved.memory.as_ref().unwrap();
        sparse(&snapshot.state, 300, &[(0, b"state")]);
        sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"memory")]);

        let backend = Arc::new(InMemory::new());
        let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
        let sandbox = id("0123456789abcdef0123456789abcdef");
        store.archive(sandbox, &saved).await.unwrap();
        let chunks = objects(&backend, "t/chunks").await;
        assert_eq!(chunks, 4, "one chunk per range holding data");

        // Change one byte: only that chunk is stored again.
        sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"Memory")]);
        sparse(
            &saved.disk,
            big,
            &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
        );
        store.archive(sandbox, &saved).await.unwrap();
        assert_eq!(objects(&backend, "t/chunks").await, chunks + 1);

        let restored = tempfile::tempdir().unwrap();
        let into = files(restored.path(), true);
        store.fetch(sandbox, &into).await.unwrap();
        for (original, copy) in [
            (&saved.disk, &into.disk),
            (&snapshot.state, &into.memory.as_ref().unwrap().state),
            (&snapshot.memory, &into.memory.as_ref().unwrap().memory),
        ] {
            assert_eq!(fs::read(original).unwrap(), fs::read(copy).unwrap());
        }
        assert!(!staging_path(&into.disk).exists());

        store.delete(sandbox).await.unwrap();
        let gone = store.fetch(sandbox, &into).await.unwrap_err();
        assert_eq!(gone.kind, ErrorKind::Fatal);
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
            .fetch(sandbox, &files(restored.path(), true))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::MemoryLost);
    }
}
