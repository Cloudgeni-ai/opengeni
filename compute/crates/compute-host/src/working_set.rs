//! A wake's working set: the pages a guest touched first after its last
//! wake ([`WakeProfile`]), and the pack they are archived in so that the
//! next wake from object storage fetches them in a few large reads.
//!
//! Memory is stored as 256 KiB chunks, but a guest's working set on a host
//! with 4 KiB pages is scattered: fetching every chunk that holds one of its
//! pages moves most of memory. So an archive also stores a *pack*: the
//! profile's first [`READY_BYTES`] of pages, in first-touch order, as a few
//! parts that grow from [`FIRST_PART`] to [`LARGEST_PART`] bytes so the
//! first pages arrive quickly. Each part is an ordinary content-addressed
//! chunk (compressed, uploaded with a checksum, read back with its length
//! and hash checked), and a small index chunk lists the pages in each part
//! and the pages that are zeros.
//!
//! A fetch writes the pack's pages into the new image's memory file and
//! reports them as [`filled`](fetch); the restored guest gets them at once.
//! The pack is only a cache: a part that cannot be fetched is skipped and
//! its pages come through chunks like any other. Hydration later checks
//! every filled page against the chunk that holds it (see
//! [`crate::lazy`]).

use std::collections::HashSet;
use std::fs::File;
use std::io;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::Arc;

use compute_engine::CancellationToken;
use compute_storage::Error as StorageError;
use compute_storage::chunk::{ChunkRef, EncodedChunk};
use compute_storage::store::ChunkStore;
use futures::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, mpsc};

use crate::image::CHUNK_BYTES;

/// How much of the learned working set a wake waits for before its guest
/// resumes, and so how much of it is packed.
pub(crate) const READY_BYTES: u64 = 128 << 20;
/// Most pages a learned profile keeps.
const PROFILE_PAGES: usize = 1 << 16;
/// The first part's size: small, so the first pages arrive quickly.
const FIRST_PART: u64 = 1 << 20;
/// Parts double in size up to this, so a pack is a handful of large reads.
const LARGEST_PART: u64 = 8 << 20;
/// Parts of one pack uploaded or fetched at once.
const PARTS_IN_FLIGHT: usize = 8;
const PACK_VERSION: u32 = 1;
/// The page sizes a guest's memory comes in.
const SMALLEST_PAGE: u64 = 4 << 10;
const LARGEST_PAGE: u64 = 2 << 20;
/// As for the memory image's own chunks: fast, and nearly as small.
const ZSTD_LEVEL: i32 = 1;

/// The pages a guest touched first after a wake, in order, as image
/// offsets. Prefetched before the next wake.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WakeProfile {
    pub version: u32,
    pub offsets: Vec<u64>,
    /// Bytes per page; 0 in profiles recorded before it was kept.
    #[serde(default)]
    pub page_size: u64,
}

impl WakeProfile {
    /// Reads a profile, or an empty one if there is none or it is unusable.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).map_or_else(|_| Self::default(), |bytes| Self::parse(&bytes))
    }

    /// Decodes a stored profile, or an empty one if it is unusable.
    pub fn parse(bytes: &[u8]) -> Self {
        serde_json::from_slice::<Self>(bytes)
            .ok()
            .filter(|profile| profile.version == 1)
            .unwrap_or_default()
    }

    /// The profile after a wake that prefetched `self` and then faulted on
    /// `touched`, pages of `page_size` bytes: pages prefetched never fault,
    /// so the old order is kept and new pages follow it, up to a bound.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    #[must_use]
    pub fn learn(&self, touched: &[u64], page_size: u64) -> Self {
        let mut seen = HashSet::new();
        let offsets = self
            .offsets
            .iter()
            .chain(touched)
            .copied()
            .filter(|offset| seen.insert(*offset))
            .take(PROFILE_PAGES)
            .collect();
        Self {
            version: 1,
            offsets,
            page_size,
        }
    }

    /// The page size, assuming the smallest for profiles without one.
    fn page(&self) -> u64 {
        if valid_page(self.page_size) {
            self.page_size
        } else {
            SMALLEST_PAGE
        }
    }

    /// The pages to pack from an image of `memory_len` bytes: the profile's
    /// first pages, each once, up to [`READY_BYTES`].
    fn packed(&self, memory_len: u64) -> Vec<u64> {
        let page = self.page();
        let mut seen = HashSet::new();
        self.offsets
            .iter()
            .map(|offset| offset / page * page)
            .filter(|offset| offset + page <= memory_len && seen.insert(*offset))
            .take(usize::try_from(READY_BYTES / page).unwrap_or(usize::MAX))
            .collect()
    }
}

fn valid_page(size: u64) -> bool {
    size.is_power_of_two() && (SMALLEST_PAGE..=LARGEST_PAGE).contains(&size)
}

/// What a pack holds, stored as a chunk of its own.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackIndex {
    version: u32,
    page_size: u64,
    /// Pages of zeros, which no part carries.
    zeros: Vec<u64>,
    parts: Vec<PackPart>,
}

/// One part: the bytes of `pages`, one after another.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackPart {
    chunk: ChunkRef,
    pages: Vec<u64>,
}

impl PackIndex {
    /// Whether this index can describe an image of `memory_len` bytes.
    fn check(&self, memory_len: u64) -> Result<(), &'static str> {
        let page = self.page_size;
        if self.version != PACK_VERSION {
            return Err("unknown pack version");
        }
        if !valid_page(page) {
            return Err("bad page size");
        }
        let pages = self.zeros.len()
            + self
                .parts
                .iter()
                .map(|part| part.pages.len())
                .sum::<usize>();
        if pages as u64 > READY_BYTES / page {
            return Err("too many pages");
        }
        let offsets = self
            .zeros
            .iter()
            .chain(self.parts.iter().flat_map(|part| &part.pages));
        for offset in offsets {
            if offset % page != 0 || offset.checked_add(page).is_none_or(|end| end > memory_len) {
                return Err("page outside the image");
            }
        }
        for part in &self.parts {
            if part.pages.is_empty()
                || u64::from(part.chunk.plain_len) != part.pages.len() as u64 * page
            {
                return Err("part length does not match its pages");
            }
        }
        Ok(())
    }
}

/// Why a pack could not be stored.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PackError {
    #[error("reading the image: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("cancelled")]
    Cancelled,
}

/// Packs the first pages of `profile` from the memory image at `memory`
/// and stores the pack, uploading each part as soon as it is made. Returns
/// the index chunk, or `None` when the profile names no page of the image.
/// Uploads take a permit from `transfers` each.
pub(crate) async fn put(
    chunks: &ChunkStore,
    transfers: &Arc<Semaphore>,
    memory: &Path,
    profile: &WakeProfile,
    cancel: &CancellationToken,
) -> Result<Option<ChunkRef>, PackError> {
    let file = File::open(memory)?;
    let pages = profile.packed(file.metadata()?.len());
    if pages.is_empty() {
        return Ok(None);
    }
    let page_size = profile.page();
    // Stops the packing on a cancel or a failed upload.
    let stop = cancel.child_token();
    let (made, mut parts) = mpsc::channel(PARTS_IN_FLIGHT);
    let packing = {
        let stop = stop.clone();
        tokio::task::spawn_blocking(move || make_parts(&file, page_size, &pages, &made, &stop))
    };
    let uploads = stream::poll_fn(|context| parts.poll_recv(context))
        .map(|part: Result<(Vec<u64>, EncodedChunk), PackError>| {
            let stop = stop.clone();
            async move {
                let (pages, chunk) = part.inspect_err(|_| stop.cancel())?;
                let stored = match transfers.acquire().await {
                    Ok(_permit) => chunks.put_chunk(&chunk).await.map_err(PackError::Storage),
                    Err(_) => Err(PackError::Cancelled),
                };
                match stored {
                    Ok(_) => Ok(PackPart {
                        chunk: chunk.reference,
                        pages,
                    }),
                    Err(error) => {
                        stop.cancel();
                        Err(error)
                    }
                }
            }
        })
        .buffered(PARTS_IN_FLIGHT)
        // Every upload runs to its end, so none is still writing after a
        // failure is reported.
        .collect::<Vec<_>>()
        .await;
    let packed = packing
        .await
        .map_err(|error| PackError::Io(io::Error::other(error)))?;
    // What stopped the uploads outranks the packing's report of the stop.
    let parts = uploads.into_iter().collect::<Result<Vec<_>, _>>()?;
    let zeros = packed?;
    if stop.is_cancelled() {
        return Err(PackError::Cancelled);
    }
    let index = PackIndex {
        version: PACK_VERSION,
        page_size,
        zeros,
        parts,
    };
    let bytes = serde_json::to_vec(&index).map_err(io::Error::other)?;
    let chunk = EncodedChunk::encode(&bytes, ZSTD_LEVEL)?;
    chunks.put_chunk(&chunk).await?;
    Ok(Some(chunk.reference))
}

/// Reads `pages` of `page_size` bytes from `file` and sends them on as
/// encoded parts, keeping the zero pages out. Returns the zero pages.
fn make_parts(
    file: &File,
    page_size: u64,
    pages: &[u64],
    made: &mpsc::Sender<Result<(Vec<u64>, EncodedChunk), PackError>>,
    stop: &CancellationToken,
) -> Result<Vec<u64>, PackError> {
    let size = usize::try_from(page_size).map_err(io::Error::other)?;
    let mut zeros = Vec::new();
    let mut target = FIRST_PART;
    let mut part_pages = Vec::new();
    let mut part = Vec::new();
    let mut page = vec![0; size];
    let send = |pages: Vec<u64>, bytes: &[u8]| {
        if stop.is_cancelled() {
            return Err(PackError::Cancelled);
        }
        let chunk = EncodedChunk::encode(bytes, ZSTD_LEVEL).map_err(PackError::Storage);
        // A closed channel means the uploads stopped; they say why.
        made.blocking_send(chunk.map(|chunk| (pages, chunk)))
            .map_err(|_| PackError::Cancelled)
    };
    for &offset in pages {
        file.read_exact_at(&mut page, offset)?;
        if page.iter().all(|&byte| byte == 0) {
            zeros.push(offset);
            continue;
        }
        part_pages.push(offset);
        part.extend_from_slice(&page);
        if part.len() as u64 >= target {
            send(std::mem::take(&mut part_pages), &part)?;
            part.clear();
            target = (target * 2).min(LARGEST_PART);
        }
    }
    if !part_pages.is_empty() {
        send(part_pages, &part)?;
    }
    Ok(zeros)
}

/// Fetches the pack `index` names into `memory`, a file of the image's
/// `memory_len` bytes, and returns the byte ranges it filled, sorted and
/// merged. Never fails: a part that cannot be fetched or checked is left
/// out, and its pages come through chunks like any other. Downloads take a
/// permit from `transfers` each.
///
/// `zero_chunks` says which of the image's chunks are zeros. Hydration
/// checks filled pages against every other chunk as it arrives, but no
/// chunk of zeros ever arrives, so a part that would put anything but
/// zeros there is left out here.
pub(crate) async fn fetch(
    chunks: &ChunkStore,
    transfers: &Arc<Semaphore>,
    index: &ChunkRef,
    memory: &Arc<File>,
    memory_len: u64,
    zero_chunks: &Arc<[bool]>,
) -> Vec<Range<u64>> {
    let index =
        match chunks.get_chunk(index).await.map(|bytes| {
            serde_json::from_slice::<PackIndex>(&bytes).map_err(|error| error.to_string())
        }) {
            Ok(Ok(index)) => index,
            Ok(Err(error)) => {
                tracing::warn!(%error, "working-set pack index unreadable");
                return Vec::new();
            }
            Err(error) => {
                tracing::warn!(%error, "working-set pack index unavailable");
                return Vec::new();
            }
        };
    if let Err(error) = index.check(memory_len) {
        tracing::warn!(error, "working-set pack index rejected");
        return Vec::new();
    }
    let page = index.page_size;
    let fetched: Vec<Option<Vec<u64>>> = stream::iter(index.parts)
        .map(|part| async move {
            let _permit = transfers.acquire().await.ok()?;
            let plain = match chunks.get_chunk(&part.chunk).await {
                Ok(plain) => plain,
                Err(error) => {
                    tracing::warn!(%error, "working-set pack part unavailable; its pages come through chunks");
                    return None;
                }
            };
            let memory = Arc::clone(memory);
            let zero_chunks = Arc::clone(zero_chunks);
            let written = tokio::task::spawn_blocking(move || {
                write_pages(&memory, page, &part.pages, &plain, &zero_chunks).map(|()| part.pages)
            })
            .await;
            match written {
                Ok(Ok(pages)) => Some(pages),
                Ok(Err(error)) => {
                    tracing::warn!(%error, "working-set pack part not written");
                    None
                }
                Err(error) => {
                    tracing::warn!(%error, "working-set pack part not written");
                    None
                }
            }
        })
        .buffer_unordered(PARTS_IN_FLIGHT)
        .collect()
        .await;
    let mut filled: Vec<Range<u64>> = index
        .zeros
        .iter()
        .chain(fetched.iter().flatten().flatten())
        .map(|&offset| offset..offset + page)
        .collect();
    filled.sort_unstable_by_key(|range| range.start);
    merge(filled)
}

/// Writes a part's `pages`, whose bytes are `plain`, unless any of them
/// would put data in a chunk of zeros.
fn write_pages(
    memory: &File,
    page: u64,
    pages: &[u64],
    plain: &[u8],
    zero_chunks: &[bool],
) -> io::Result<()> {
    let size = usize::try_from(page).map_err(io::Error::other)?;
    let invalid = |why| io::Error::new(io::ErrorKind::InvalidData, why);
    if plain.len() != pages.len() * size {
        return Err(invalid("pack part does not hold its pages"));
    }
    for (offset, bytes) in pages.iter().zip(plain.chunks_exact(size)) {
        if !zeros_where_the_image_has_them(*offset, bytes, zero_chunks) {
            return Err(invalid("pack part has data where the image has zeros"));
        }
    }
    for (offset, bytes) in pages.iter().zip(plain.chunks_exact(size)) {
        memory.write_all_at(bytes, *offset)?;
    }
    Ok(())
}

/// Whether the page at `offset`, holding `bytes`, is all zeros inside
/// every chunk of zeros it overlaps.
fn zeros_where_the_image_has_them(offset: u64, bytes: &[u8], zero_chunks: &[bool]) -> bool {
    let end = offset + bytes.len() as u64;
    let mut at = offset;
    while at < end {
        let chunk = at / CHUNK_BYTES;
        let stop = ((chunk + 1) * CHUNK_BYTES).min(end);
        let zero = usize::try_from(chunk)
            .ok()
            .and_then(|chunk| zero_chunks.get(chunk))
            .copied()
            // A page past the chunk list is outside the image.
            .unwrap_or(true);
        if zero {
            let within = |at: u64| usize::try_from(at - offset).unwrap_or(usize::MAX);
            if bytes
                .get(within(at)..within(stop))
                .is_none_or(|run| run.iter().any(|&byte| byte != 0))
            {
                return false;
            }
        }
        at = stop;
    }
    true
}

/// Sorted ranges with touching or overlapping ones joined.
fn merge(sorted: Vec<Range<u64>>) -> Vec<Range<u64>> {
    let mut merged: Vec<Range<u64>> = Vec::with_capacity(sorted.len());
    for range in sorted {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

/// Encodes filled ranges for an image's `filled` file.
pub(crate) fn encode_filled(filled: &[Range<u64>]) -> Vec<u8> {
    filled
        .iter()
        .flat_map(|range| [range.start, range.end])
        .flat_map(u64::to_le_bytes)
        .collect()
}

/// Decodes an image's `filled` file, which must hold sorted, disjoint,
/// page-aligned ranges inside `memory_len` bytes.
pub(crate) fn decode_filled(bytes: &[u8], memory_len: u64) -> io::Result<Vec<Range<u64>>> {
    let invalid = |why| io::Error::new(io::ErrorKind::InvalidData, why);
    let (words, rest) = bytes.as_chunks::<8>();
    if !rest.is_empty() || words.len() % 2 != 0 {
        return Err(invalid("filled ranges have a partial entry"));
    }
    let mut ranges = Vec::with_capacity(words.len() / 2);
    let mut end = 0;
    for pair in words.as_chunks::<2>().0 {
        let range = u64::from_le_bytes(pair[0])..u64::from_le_bytes(pair[1]);
        if range.start < end
            || range.start >= range.end
            || range.end > memory_len
            || range.start % SMALLEST_PAGE != 0
            || range.end % SMALLEST_PAGE != 0
        {
            return Err(invalid(
                "filled ranges are out of order or outside the image",
            ));
        }
        end = range.end;
        ranges.push(range);
    }
    Ok(ranges)
}

/// Which [`SMALLEST_PAGE`]s of an image are filled; fixed once made.
#[derive(Debug, Default)]
pub(crate) struct PageSet {
    words: Vec<u64>,
}

impl PageSet {
    /// The pages in `ranges`, which must be page-aligned.
    pub fn new(ranges: &[Range<u64>]) -> Self {
        let pages = ranges.last().map_or(0, |last| last.end / SMALLEST_PAGE);
        let mut words = vec![0_u64; usize::try_from(pages.div_ceil(64)).unwrap_or(0)];
        for range in ranges {
            for page in range.start / SMALLEST_PAGE..range.end / SMALLEST_PAGE {
                let page = usize::try_from(page).unwrap_or(usize::MAX);
                if let Some(word) = words.get_mut(page / 64) {
                    *word |= 1 << (page % 64);
                }
            }
        }
        Self { words }
    }

    fn contains(&self, page: u64) -> bool {
        usize::try_from(page).is_ok_and(|page| {
            self.words
                .get(page / 64)
                .is_some_and(|word| word & (1 << (page % 64)) != 0)
        })
    }

    /// Whether every page `range` touches is filled.
    pub fn covers(&self, range: Range<u64>) -> bool {
        !range.is_empty()
            && (range.start / SMALLEST_PAGE..range.end.div_ceil(SMALLEST_PAGE))
                .all(|page| self.contains(page))
    }

    /// `range` (page-aligned at both ends, or at the image's end) split into
    /// its longest runs of filled and of unfilled pages, in order.
    pub fn runs(&self, range: Range<u64>) -> Vec<(Range<u64>, bool)> {
        let mut runs: Vec<(Range<u64>, bool)> = Vec::new();
        let mut at = range.start;
        while at < range.end {
            let end = (at / SMALLEST_PAGE + 1) * SMALLEST_PAGE;
            let piece = at..end.min(range.end);
            let filled = self.contains(at / SMALLEST_PAGE);
            match runs.last_mut() {
                Some((last, was)) if *was == filled => last.end = piece.end,
                _ => runs.push((piece.clone(), filled)),
            }
            at = piece.end;
        }
        runs
    }
}

#[cfg(test)]
mod tests;
