//! Storing one file as a manifest of chunks, and writing it back.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::Arc;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, Extent, ExtentSource};
use futures::{StreamExt as _, stream};

use super::{
    CHUNK_BYTES, Chunked, DOWNLOADS_PER_FILE, Identity, Piece, Seed, UPLOADS_PER_FILE, ZSTD_LEVEL,
    hash_from_hex, storage_error,
};
use crate::image::{Hash, ZERO, chunk_count, chunk_range, data_ranges, overlaps};
use crate::layout::Staging;

impl Chunked {
    /// Stores `path` and returns its manifest's digest. With `known`, the
    /// file's per-chunk hashes, chunks equal to the earlier copy's are taken
    /// from it without being read, and every chunk read is checked against
    /// its hash. A chunk taken from the earlier copy is first checked to be
    /// in the store, and stored again from the local bytes if it is not.
    ///
    /// Once `cancel` fires, or a chunk fails, no further chunk is started;
    /// the call returns after the chunks under way have finished, so nothing
    /// is still writing. A cancelled file returns `None` and stores no
    /// manifest.
    pub(super) async fn put_file(
        &self,
        path: &Path,
        file: io::Result<File>,
        earlier: HashMap<u64, ChunkRef>,
        known: Option<Arc<Vec<Hash>>>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, EngineError> {
        const OP: &str = "archive";
        let file = file.map_err(|error| EngineError::io(OP, error))?;
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
        // Stops new chunks on a cancel or on the first failure.
        let stop = cancel.child_token();
        let wanted = (0..chunk_count(length)).filter(|&index| match &known {
            Some(known) => known[index] != ZERO,
            None => overlaps(&data, &chunk_range(index, length)),
        });
        let results: Vec<Result<Option<Piece>, EngineError>> = stream::iter(wanted)
            .map(|index| {
                let file = Arc::clone(&file);
                let earlier = Arc::clone(&earlier);
                let expected = known.as_ref().map(|known| known[index]);
                let stop = stop.clone();
                async move {
                    if stop.is_cancelled() {
                        return Ok(None);
                    }
                    let range = chunk_range(index, length);
                    let earlier = earlier.get(&range.start).cloned();
                    let stored = self
                        .store_chunk(&file, range.clone(), earlier, expected)
                        .await;
                    match stored {
                        Ok(reference) => Ok(Some((range, reference))),
                        Err(error) => {
                            stop.cancel();
                            Err(error)
                        }
                    }
                }
            })
            .buffered(UPLOADS_PER_FILE)
            .collect()
            .await;
        // A failure outranks a cancel: chunks skipped after it are not a
        // cancel.
        let mut pieces = Vec::with_capacity(results.len());
        let mut skipped = false;
        for result in results {
            match result? {
                Some(piece) => pieces.push(piece),
                None => skipped = true,
            }
        }
        if skipped || cancel.is_cancelled() {
            return Ok(None);
        }
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
            .map(Some)
            .map_err(|error| storage_error(OP, error))
    }

    /// Stores the chunk-sized `range` of `file` and returns its chunk
    /// (`None` for zeros): the `earlier` copy's chunk if the bytes are the
    /// same and it is still in the store, otherwise a new one.
    async fn store_chunk(
        &self,
        file: &Arc<File>,
        range: Range<u64>,
        earlier: Option<ChunkRef>,
        expected: Option<Hash>,
    ) -> Result<Option<ChunkRef>, EngineError> {
        const OP: &str = "archive";
        let transient = |error| EngineError::caused_by(ErrorKind::Transient, OP, error);
        let prepared = match prepare_blocking(file, range.clone(), earlier, expected).await? {
            Prepared::Known(reference) => {
                let present = {
                    let _permit = self.transfers.acquire().await.map_err(transient)?;
                    self.chunks
                        .has_chunk(&reference)
                        .await
                        .map_err(|error| storage_error(OP, error))?
                };
                if present {
                    Prepared::Known(reference)
                } else {
                    // Gone or cut short since: store these bytes again
                    // rather than name a chunk no copy can be read from.
                    tracing::warn!(chunk = %reference.key(), "stored chunk missing; storing it again");
                    prepare_blocking(file, range, None, expected).await?
                }
            }
            prepared => prepared,
        };
        Ok(match prepared {
            Prepared::Zero => None,
            Prepared::Known(reference) => Some(reference),
            Prepared::New(chunk) => {
                let _permit = self.transfers.acquire().await.map_err(transient)?;
                let stored = self
                    .chunks
                    .put_chunk(&chunk)
                    .await
                    .map_err(|error| storage_error(OP, error))?;
                if stored {
                    crate::observe::notes::bytes("uploaded", chunk.bytes.len() as u64);
                }
                Some(chunk.reference)
            }
        })
    }

    /// Writes the file a manifest describes to `path`, replacing it whole.
    /// With a `seed`, the file starts as a copy of it and only chunks that
    /// differ from the seed at the same offset are downloaded.
    pub(super) async fn get_file(
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
        // A name of this attempt's own: blocking writes of an attempt that
        // was abandoned mid-way land in its file, never in this one.
        let staging = Staging::beside(path).map_err(|error| EngineError::io(OP, error))?;
        let seed = match seed {
            Some(seed) if copy_seed(seed, staging.path()).await? => Some(seed),
            _ => None,
        };
        let file = if seed.is_some() {
            fs::OpenOptions::new().write(true).open(staging.path())
        } else {
            File::create(staging.path())
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
        // Every download runs to its end, so nothing writes into the file
        // once this returns; after the first failure the rest are skipped.
        let stop = CancellationToken::new();
        let results: Vec<Result<(), EngineError>> = stream::iter(reads)
            .map(|(at, length, reference, within)| {
                let file = Arc::clone(&file);
                let chunks = self.chunks.clone();
                let transfers = Arc::clone(&self.transfers);
                let stop = stop.clone();
                async move {
                    let written = async {
                        let plain = {
                            let _permit = transfers.acquire_owned().await.map_err(|error| {
                                EngineError::caused_by(ErrorKind::Transient, OP, error)
                            })?;
                            if stop.is_cancelled() {
                                return Ok(());
                            }
                            let plain = chunks
                                .get_chunk(&reference)
                                .await
                                .map_err(|error| storage_error(OP, error))?;
                            crate::observe::notes::bytes("fetched", plain.len() as u64);
                            plain
                        };
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
                    .await;
                    if written.is_err() {
                        stop.cancel();
                    }
                    written
                }
            })
            .buffer_unordered(DOWNLOADS_PER_FILE)
            .collect()
            .await;
        results.into_iter().collect::<Result<(), _>>()?;
        drop(file);
        tokio::task::spawn_blocking(move || staging.publish())
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
            .map_err(|error| EngineError::io(OP, error))
    }
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

/// [`prepare`] on a blocking thread.
async fn prepare_blocking(
    file: &Arc<File>,
    range: Range<u64>,
    earlier: Option<ChunkRef>,
    expected: Option<Hash>,
) -> Result<Prepared, EngineError> {
    const OP: &str = "archive";
    let file = Arc::clone(file);
    tokio::task::spawn_blocking(move || prepare(&file, range, earlier.as_ref(), expected))
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| storage_error(OP, error))
}

/// A complete manifest from the stored chunks, with every gap between them
/// and every run of zero chunks recorded as zeros.
pub(super) fn extents(length: u64, pieces: Vec<(Range<u64>, Option<ChunkRef>)>) -> Vec<Extent> {
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
