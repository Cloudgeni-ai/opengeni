//! Storing one file as a manifest of chunks, and writing it back.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::manifest::{DiskManifest, Extent, ExtentSource};
use futures::{StreamExt as _, stream};
use tokio::sync::{OnceCell, Semaphore};

use super::{
    CHUNK_BYTES, Chunked, DOWNLOADS_PER_FILE, Identity, Piece, Seed, UPLOADS_PER_FILE, ZSTD_LEVEL,
    hash_from_hex, storage_error,
};
use crate::image::{Hash, ZERO, chunk_count, chunk_range, data_ranges, overlaps, punch_hole};
use crate::layout::Staging;

/// A chunk an earlier copy holds at an offset of the file being stored: a
/// range there with the same bytes names it instead of storing them again.
#[derive(Clone, Debug)]
pub(super) struct Reusable {
    pub(super) reference: ChunkRef,
    /// Known to be in the store; otherwise the store is asked first.
    pub(super) confirmed: bool,
    /// Named by the image the file was made from, which keeps it stored
    /// whatever this copy names (ADR 31).
    pub(super) image: bool,
}

/// The store's answers about chunks an archive would reuse, by key, so
/// that each object, a pack of many of them above all, is asked about once
/// however many of its chunks are reused.
#[derive(Debug, Default)]
pub(super) struct Checks(Mutex<HashMap<String, Arc<OnceCell<bool>>>>);

impl Checks {
    fn slot(&self, key: String) -> Arc<OnceCell<bool>> {
        let mut checks = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(checks.entry(key).or_default())
    }
}

/// What earlier copies hold, by offset, the confirmed first.
pub(super) type Earlier = HashMap<u64, Vec<Reusable>>;

impl Chunked {
    /// Stores `path` and returns its manifest's digest. A chunk-sized range
    /// holding what an `earlier` copy holds at the same offset names that
    /// chunk. With `known`, the file's per-chunk hashes, such chunks are
    /// recognised without being read, and every chunk read is checked
    /// against its hash. A chunk not confirmed to be in the store is asked
    /// about first, and stored again from the local bytes if it is not.
    ///
    /// With `packing`, new chunks are stored in packs ([`Self::put_packed`],
    /// ADR 31); otherwise each as an object of its own.
    ///
    /// Once `cancel` fires, or a chunk fails, no further chunk is started;
    /// the call returns after the chunks under way have finished, so nothing
    /// is still writing. A cancelled file returns `None` and stores no
    /// manifest.
    pub(super) async fn put_file(
        &self,
        path: &Path,
        file: io::Result<File>,
        earlier: Earlier,
        known: Option<Arc<Vec<Hash>>>,
        packing: bool,
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
        if packing {
            let wanted: Vec<usize> = wanted.collect();
            let pieces =
                Box::pin(self.put_packed(&file, length, wanted, earlier, known.clone(), &stop))
                    .await?;
            return match pieces {
                Some(pieces) if !cancel.is_cancelled() => {
                    self.put_pieces(length, pieces).await.map(Some)
                }
                _ => Ok(None),
            };
        }
        let checks = &Checks::default();
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
                    let earlier = earlier.get(&range.start).cloned().unwrap_or_default();
                    let stored = self
                        .store_chunk(&file, range.clone(), earlier, expected, checks)
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
        self.put_pieces(length, pieces).await.map(Some)
    }

    /// Stores the manifest of a file of `length` bytes stored as `pieces`,
    /// and returns its name.
    async fn put_pieces(&self, length: u64, pieces: Vec<Piece>) -> Result<String, EngineError> {
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
            .map_err(|error| storage_error("archive", error))
    }

    /// Stores the chunk-sized `range` of `file` and returns its chunk
    /// (`None` for zeros): one of the `earlier` copies' chunks there if the
    /// bytes are the same and it is still in the store, otherwise a new one.
    async fn store_chunk(
        &self,
        file: &Arc<File>,
        range: Range<u64>,
        earlier: Vec<Reusable>,
        expected: Option<Hash>,
        checks: &Checks,
    ) -> Result<Option<ChunkRef>, EngineError> {
        const OP: &str = "archive";
        let transient = |error| EngineError::caused_by(ErrorKind::Transient, OP, error);
        let prepared = self
            .resolve_chunk(file, range, earlier, expected, checks)
            .await?;
        Ok(match prepared {
            Prepared::Zero => None,
            Prepared::Known(reusable) => Some(reusable.reference),
            Prepared::New(chunk) => {
                let _permit = self.transfers.acquire().await.map_err(transient)?;
                let put = self
                    .chunks
                    .put_chunk(&chunk)
                    .await
                    .map_err(|error| storage_error(OP, error))?;
                if put.new {
                    // A copy within the store, of what an archive a sweep stopped
                    // stored an hour before, moves nothing over the network.
                    let how = if put.copied { "copied" } else { "uploaded" };
                    crate::observe::notes::bytes(how, chunk.bytes.len() as u64);
                }
                // Named as stored, under the day it was stored on.
                Some(put.reference)
            }
        })
    }

    /// Reads the chunk-sized `range` of `file` and decides how to store it
    /// ([`prepare`]), asking the store, once per object through `checks`,
    /// about a chunk of an `earlier` copy not known to be there.
    pub(super) async fn resolve_chunk(
        &self,
        file: &Arc<File>,
        range: Range<u64>,
        earlier: Vec<Reusable>,
        expected: Option<Hash>,
        checks: &Checks,
    ) -> Result<Prepared, EngineError> {
        const OP: &str = "archive";
        let transient = |error| EngineError::caused_by(ErrorKind::Transient, OP, error);
        Ok(
            match prepare_blocking(&self.compress, file, range.clone(), earlier, expected).await? {
                Prepared::Known(reusable) if reusable.confirmed => Prepared::Known(reusable),
                Prepared::Known(reusable) => {
                    let slot = checks.slot(reusable.reference.key());
                    let present = slot
                        .get_or_try_init(|| async {
                            let _permit = self.transfers.acquire().await.map_err(transient)?;
                            self.chunks
                                .has_chunk(&reusable.reference)
                                .await
                                .map_err(|error| storage_error(OP, error))
                        })
                        .await?;
                    let present = *present;
                    if present {
                        Prepared::Known(reusable)
                    } else {
                        // Gone or cut short since: store these bytes again
                        // rather than name a chunk no copy can be read from.
                        tracing::warn!(chunk = %reusable.reference.key(), "stored chunk missing; storing it again");
                        prepare_blocking(&self.compress, file, range, Vec::new(), expected).await?
                    }
                }
                prepared => prepared,
            },
        )
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
        // Chunks that follow one another in a pack come in one read.
        let stop = CancellationToken::new();
        let results: Vec<Result<(), EngineError>> = stream::iter(runs(reads))
            .map(|run| {
                let file = Arc::clone(&file);
                let stop = stop.clone();
                async move {
                    let written = self.fetch_run(file, run, &stop).await;
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

    /// Downloads `run`, chunks that follow one another (see [`runs`]), with
    /// one read, and writes each where it goes in `file`; nothing once
    /// `stop` fired.
    async fn fetch_run(
        &self,
        file: Arc<File>,
        run: Vec<Read>,
        stop: &CancellationToken,
    ) -> Result<(), EngineError> {
        const OP: &str = "fetch";
        let plains = {
            let _permit = self
                .transfers
                .acquire()
                .await
                .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
            if stop.is_cancelled() {
                return Ok(());
            }
            let references: Vec<ChunkRef> = run
                .iter()
                .map(|(_, _, reference, _)| reference.clone())
                .collect();
            let plains = self
                .chunks
                .get_chunks(&references)
                .await
                .map_err(|error| storage_error(OP, error))?;
            let fetched = plains.iter().map(|plain| plain.len() as u64).sum();
            crate::observe::notes::bytes("fetched", fetched);
            plains
        };
        tokio::task::spawn_blocking(move || {
            for ((at, length, _, within), plain) in run.into_iter().zip(plains) {
                let start = usize::try_from(within).unwrap_or(usize::MAX);
                let bytes = usize::try_from(length)
                    .ok()
                    .and_then(|length| plain.get(start..start.checked_add(length)?))
                    .ok_or_else(|| io::Error::other("extent outside its chunk"))?;
                file.write_all_at(bytes, at)?;
            }
            Ok(())
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| EngineError::io(OP, error))
    }
}

/// What one chunk-sized range of a file turned out to hold.
pub(super) enum Prepared {
    Zero,
    Known(Reusable),
    New(EncodedChunk),
}

/// Reads `range` and decides how to store it: as zeros, as a chunk an
/// earlier copy holds there if the bytes are the same (the first that
/// matches), or as a new chunk. With `expected`, the range's hash from the
/// image's chunk map, an unchanged chunk is recognised without reading it,
/// and a chunk read is checked.
fn prepare(
    file: &File,
    range: Range<u64>,
    earlier: &[Reusable],
    expected: Option<Hash>,
) -> Result<Prepared, StorageError> {
    let whole =
        |reusable: &&Reusable| u64::from(reusable.reference.plain_len) == range.end - range.start;
    if let Some(expected) = expected
        && let Some(found) = earlier
            .iter()
            .filter(whole)
            .find(|reusable| hash_from_hex(&reusable.reference.hash) == Ok(expected))
    {
        return Ok(Prepared::Known(found.clone()));
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
    let hex = hash.to_hex();
    if let Some(found) = earlier
        .iter()
        .filter(whole)
        .find(|reusable| hex.as_str() == reusable.reference.hash)
    {
        return Ok(Prepared::Known(found.clone()));
    }
    EncodedChunk::encode(&plain, ZSTD_LEVEL).map(Prepared::New)
}

/// [`prepare`] on a blocking thread, once one of `permits` is free.
pub(super) async fn prepare_blocking(
    permits: &Semaphore,
    file: &Arc<File>,
    range: Range<u64>,
    earlier: Vec<Reusable>,
    expected: Option<Hash>,
) -> Result<Prepared, EngineError> {
    const OP: &str = "archive";
    let file = Arc::clone(file);
    let _permit = permits
        .acquire()
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
    tokio::task::spawn_blocking(move || prepare(&file, range, &earlier, expected))
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

/// The most stored bytes one read of consecutive chunks in a pack gets.
const RUN_BYTES: u64 = 4 << 20;

/// `reads` in order, in runs of chunks that follow one another in one pack
/// ([`compute_storage::pack::follows`]), each read with one request.
fn runs(reads: Vec<Read>) -> Vec<Vec<Read>> {
    let mut runs: Vec<Vec<Read>> = Vec::new();
    let mut bytes = 0;
    for read in reads {
        let stored = u64::from(read.2.stored_len);
        if let Some(run) = runs.last_mut()
            && let Some((_, _, last, _)) = run.last()
            && compute_storage::pack::follows(last, &read.2)
            && bytes + stored <= RUN_BYTES
        {
            bytes += stored;
            run.push(read);
            continue;
        }
        bytes = stored;
        runs.push(vec![read]);
    }
    runs
}

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

/// What an archive may reuse of a file, by offset: what its own earlier
/// copy `own` holds there, confirmed to be stored if `own_confirmed`, and
/// what the confirmed `image` holds there if it differs. A chunk of the
/// earlier copy that the image holds at the same offset is confirmed with
/// the image.
pub(super) fn reusable(
    own: HashMap<u64, ChunkRef>,
    own_confirmed: bool,
    image: Option<&HashMap<u64, ChunkRef>>,
) -> Earlier {
    let mut earlier: Earlier = HashMap::with_capacity(own.len().max(image.map_or(0, HashMap::len)));
    let mut kept_by_image = std::collections::HashSet::new();
    for (&offset, reference) in image.into_iter().flatten() {
        kept_by_image.insert(reference.key());
        earlier.entry(offset).or_default().push(Reusable {
            reference: reference.clone(),
            confirmed: true,
            image: true,
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
            image: kept_by_image.contains(&reference.key()),
            reference,
            confirmed: own_confirmed,
        });
    }
    earlier
}
