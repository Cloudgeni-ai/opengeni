//! A sandbox's saved memory images: immutable, self-contained generations.
//!
//! A save asks the VMM only for the pages that changed since the image the VM
//! started from (a diff). The diff is merged here, offline and never under a
//! live VM, into a new generation that holds every page, so any published
//! image restores on its own: there are no layer chains to walk or lose.
//!
//! ```text
//! <sandbox>/images/
//!   current                  the generation that matches the sandbox (written last)
//!   <generation>/            one published image, never modified (except hydration)
//!     image.json             lengths and hashes of everything below
//!     state                  processor and device state
//!     memory                 guest memory, sparse
//!     chunks                 BLAKE3 of each 256 KiB chunk of memory; zeros for a zero chunk
//!     remote.json            only while memory is still in object storage: its manifest
//!   <generation>.staging/    a generation being built; removed on recovery
//!   quarantine/              suspect generations, kept for inspection, never used
//! ```
//!
//! Publishing writes and syncs every file, renames the staging directory into
//! place, checks the result with [`Images::verify`], and only then points
//! `current` at it. Older generations are removed only through
//! [`Images::retire`], which needs that check's [`Verified`] proof of a newer
//! generation: the one rule that keeps a good copy of the newest state.
//!
//! Merging clones the parent's memory file (a shared-extent clone on XFS and
//! btrfs) and copies the diff's data ranges over it with
//! `copy_file_range`, which XFS also turns into extent sharing. A hole in a
//! diff means "unchanged"; zeros the guest wrote are data and are copied, so
//! nothing is ever made sparse by content.

use std::fmt;
use std::fs::{self, File};
use std::io;
use std::ops::Range;
use std::os::unix::fs::{FileExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::layout::{remove_durably, write_atomic};

/// Bytes per memory chunk: the unit of hashing, upload and lazy fetch.
pub const CHUNK_BYTES: u64 = 256 << 10;

/// The chunk map entry for a chunk of zeros.
pub(crate) const ZERO: Hash = [0; 32];

/// A chunk's BLAKE3 hash.
pub(crate) type Hash = [u8; 32];

const VERSION: u32 = 1;
const META: &str = "image.json";
const STATE: &str = "state";
const MEMORY: &str = "memory";
const CHUNKS: &str = "chunks";
const REMOTE: &str = "remote.json";
const CURRENT: &str = "current";
const QUARANTINE: &str = "quarantine";
/// Quarantined generations kept per sandbox; older ones are removed so a
/// repeatedly failing sandbox cannot fill the disk.
const QUARANTINE_KEEP: usize = 2;

/// One published image's number; later images have larger numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub(crate) struct Generation(pub u64);

impl fmt::Display for Generation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

impl Generation {
    fn parse(name: &str) -> Option<Self> {
        if name.len() != 16 {
            return None;
        }
        u64::from_str_radix(name, 16).ok().map(Self)
    }
}

/// What a generation holds, recorded when it is published.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
// Strict: a damaged field name must not pass as a missing optional one.
#[serde(deny_unknown_fields)]
pub(crate) struct Meta {
    pub version: u32,
    pub generation: Generation,
    /// The generation this one was merged over, if any.
    pub parent: Option<Generation>,
    pub memory_len: u64,
    pub state_len: u64,
    /// BLAKE3 of the state file, hex.
    pub state_hash: String,
    /// BLAKE3 of the chunk map, hex.
    pub chunks_hash: String,
    /// Whether the memory file is still being filled from object storage;
    /// `remote.json` then names the manifest the rest comes from.
    pub remote: bool,
}

/// Per-chunk hashes of a memory image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChunkMap(pub Vec<Hash>);

impl ChunkMap {
    /// A map of `len` bytes of zeros.
    #[cfg(test)]
    pub fn zeros(len: u64) -> Self {
        Self(vec![ZERO; chunk_count(len)])
    }

    fn encode(&self) -> Vec<u8> {
        self.0.concat()
    }

    fn decode(bytes: &[u8], len: u64) -> io::Result<Self> {
        if bytes.len() != chunk_count(len) * 32 {
            return Err(invalid("chunk map has the wrong length"));
        }
        Ok(Self(bytes.as_chunks::<32>().0.to_vec()))
    }
}

/// Proof that a generation passed [`Images::verify`]. Only that check makes
/// one, and only a proof lets [`Images::retire`] remove anything.
#[derive(Debug)]
pub(crate) struct Verified {
    meta: Meta,
}

impl Verified {
    pub fn generation(&self) -> Generation {
        self.meta.generation
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }
}

/// Why a generation is not good.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Suspect {
    #[error("image {0} is missing")]
    Missing(Generation),
    #[error("image {generation} is damaged: {reason}")]
    Damaged {
        generation: Generation,
        reason: String,
    },
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl Suspect {
    /// A short tag for the quarantine directory's name.
    fn tag(&self) -> &'static str {
        match self {
            Self::Missing(_) => "missing",
            Self::Damaged { .. } => "damaged",
            Self::Io(_) => "unreadable",
        }
    }
}

/// How thoroughly [`Images::verify`] checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Depth {
    /// Lengths, the state's hash and the chunk map's hash: milliseconds.
    Light,
    /// Also hashes every data chunk of memory against the chunk map.
    Deep,
}

/// What a new generation is built from.
#[derive(Debug)]
pub(crate) enum Parts<'a> {
    /// A complete memory file and its state, both moved in.
    Whole { state: &'a Path, memory: &'a Path },
    /// The pages that changed since `base`, merged over a copy of it; holes
    /// in `diff` are pages equal to `base`. `state` and `diff` are moved in
    /// or consumed.
    Diff {
        base: Generation,
        state: &'a Path,
        diff: &'a Path,
    },
    /// Another directory's verified generation, such as a template's.
    /// Published files are never modified, so memory and state are shared
    /// by hard link where both directories are on one filesystem (one page
    /// cache serves every VM restored from them), and copied otherwise.
    Shared {
        from: &'a Images,
        image: &'a Verified,
    },
    /// Device state only; memory stays in object storage under `manifest`
    /// (its JSON), to be paged in on demand.
    Remote {
        state: &'a Path,
        memory_len: u64,
        chunks: ChunkMap,
        manifest: &'a [u8],
    },
}

/// The image generations of one sandbox.
#[derive(Clone, Debug)]
pub(crate) struct Images {
    dir: PathBuf,
}

impl Images {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, generation: Generation) -> PathBuf {
        self.dir.join(generation.to_string())
    }

    /// The state file of `generation`.
    pub fn state(&self, generation: Generation) -> PathBuf {
        self.path(generation).join(STATE)
    }

    /// The memory file of `generation`.
    pub fn memory(&self, generation: Generation) -> PathBuf {
        self.path(generation).join(MEMORY)
    }

    /// The manifest the rest of `generation`'s memory comes from.
    pub fn remote(&self, generation: Generation) -> PathBuf {
        self.path(generation).join(REMOTE)
    }

    /// The generation `current` names, without checking it.
    pub fn current(&self) -> io::Result<Option<Generation>> {
        match fs::read_to_string(self.dir.join(CURRENT)) {
            Ok(text) => Generation::parse(text.trim())
                .map(Some)
                .ok_or_else(|| invalid("unreadable current image pointer")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Every published generation, oldest first.
    pub fn generations(&self) -> io::Result<Vec<Generation>> {
        let mut found = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(found),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            if let Some(generation) = entry.file_name().to_str().and_then(Generation::parse) {
                found.push(generation);
            }
        }
        found.sort_unstable();
        Ok(found)
    }

    /// The shared check that decides whether a generation is good.
    pub fn verify(&self, generation: Generation, depth: Depth) -> Result<Verified, Suspect> {
        let dir = self.path(generation);
        let damaged = |reason: String| Suspect::Damaged { generation, reason };
        let meta = match fs::read(dir.join(META)) {
            Ok(bytes) => serde_json::from_slice::<Meta>(&bytes)
                .map_err(|error| damaged(format!("{META}: {error}")))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(Suspect::Missing(generation));
            }
            Err(error) => return Err(error.into()),
        };
        if meta.version != VERSION || meta.generation != generation {
            return Err(damaged(format!(
                "{META} describes version {} generation {}",
                meta.version, meta.generation
            )));
        }
        let state = fs::read(dir.join(STATE))?;
        if state.len() as u64 != meta.state_len
            || blake3::hash(&state).to_hex().as_str() != meta.state_hash
        {
            return Err(damaged("state does not match its hash".into()));
        }
        let chunk_bytes = fs::read(dir.join(CHUNKS))?;
        if blake3::hash(&chunk_bytes).to_hex().as_str() != meta.chunks_hash {
            return Err(damaged("chunk map does not match its hash".into()));
        }
        let chunks = ChunkMap::decode(&chunk_bytes, meta.memory_len)
            .map_err(|error| damaged(error.to_string()))?;
        let memory = File::open(dir.join(MEMORY))?;
        let length = memory.metadata()?.len();
        if length != meta.memory_len {
            return Err(damaged(format!(
                "memory has {length} bytes, expected {}",
                meta.memory_len
            )));
        }
        if meta.remote && !dir.join(REMOTE).exists() {
            return Err(damaged("remote memory without its manifest".into()));
        }
        if depth == Depth::Deep && !meta.remote {
            let all: Vec<usize> = (0..chunks.0.len()).collect();
            let hashed = hash_chunks(&memory, meta.memory_len, &all)?;
            if let Some(index) = (0..all.len()).find(|&index| hashed[index] != chunks.0[index]) {
                return Err(damaged(format!("memory chunk {index} does not match")));
            }
        }
        Ok(Verified { meta })
    }

    /// The chunk map of a verified generation.
    pub fn chunk_map(&self, image: &Verified) -> io::Result<ChunkMap> {
        let bytes = fs::read(self.path(image.generation()).join(CHUNKS))?;
        if blake3::hash(&bytes).to_hex().as_str() != image.meta.chunks_hash {
            return Err(invalid("chunk map changed after it was verified"));
        }
        ChunkMap::decode(&bytes, image.meta.memory_len)
    }

    /// The newest generation `current` names, if it passes a light check.
    pub fn current_verified(&self) -> Result<Option<Verified>, Suspect> {
        match self.current()? {
            Some(generation) => self.verify(generation, Depth::Light).map(Some),
            None => Ok(None),
        }
    }

    /// Builds, checks and publishes a new generation from `parts`, then
    /// points `current` at it. Blocking: run off the async executor.
    pub fn publish(&self, parts: Parts<'_>) -> Result<Verified, Suspect> {
        // The record vouches for what is published here, so the directory
        // itself must survive a crash too.
        create_dir_durably(&self.dir)?;
        let generation = self.next_generation()?;
        let staging = self.dir.join(format!("{generation}.staging"));
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir(&staging)?;
        let memory = staging.join(MEMORY);
        let (parent, state, memory_len, chunks, remote) = match parts {
            Parts::Whole {
                state,
                memory: whole,
            } => {
                move_in(whole, &memory)?;
                let file = File::open(&memory)?;
                let len = file.metadata()?.len();
                let all: Vec<usize> = (0..chunk_count(len)).collect();
                let chunks = ChunkMap(hash_chunks(&file, len, &all)?);
                (None, Some(state), len, chunks, None)
            }
            Parts::Shared { from, image } => {
                let chunks = share_image(from, image, &staging)?;
                (None, None, image.meta.memory_len, chunks, None)
            }
            Parts::Diff { base, state, diff } => {
                let parent = self.verify(base, Depth::Light)?;
                if parent.meta.remote {
                    return Err(Suspect::Damaged {
                        generation: base,
                        reason: "merge base is not fully in local memory".into(),
                    });
                }
                let mut chunks = self.chunk_map(&parent)?;
                let len = parent.meta.memory_len;
                let touched = merge(&self.memory(base), diff, &memory, len)?;
                let file = File::open(&memory)?;
                for (index, hash) in touched.iter().zip(hash_chunks(&file, len, &touched)?) {
                    chunks.0[*index] = hash;
                }
                fs::remove_file(diff)?;
                (Some(base), Some(state), len, chunks, None)
            }
            Parts::Remote {
                state,
                memory_len,
                chunks,
                manifest,
            } => {
                let file = File::create(&memory)?;
                file.set_len(memory_len)?;
                (None, Some(state), memory_len, chunks, Some(manifest))
            }
        };
        if let Some(state) = state {
            move_in(state, &staging.join(STATE))?;
        }
        let state_bytes = fs::read(staging.join(STATE))?;
        let chunk_bytes = chunks.encode();
        if chunk_bytes.len() != chunk_count(memory_len) * 32 {
            return Err(invalid("chunk map does not cover memory").into());
        }
        write_synced(&staging.join(CHUNKS), &chunk_bytes)?;
        if let Some(manifest) = remote {
            write_synced(&staging.join(REMOTE), manifest)?;
        }
        let meta = Meta {
            version: VERSION,
            generation,
            parent,
            memory_len,
            state_len: state_bytes.len() as u64,
            state_hash: blake3::hash(&state_bytes).to_hex().to_string(),
            chunks_hash: blake3::hash(&chunk_bytes).to_hex().to_string(),
            remote: remote.is_some(),
        };
        write_synced(
            &staging.join(META),
            &serde_json::to_vec_pretty(&meta).map_err(io::Error::other)?,
        )?;
        seal_staged(&staging, remote.is_some())?;
        failpoint("staged")?;
        let published = self.path(generation);
        fs::rename(&staging, &published)?;
        sync_dir(&self.dir)?;
        failpoint("renamed")?;
        let verified = self.verify(generation, Depth::Light)?;
        write_atomic(
            &self.dir.join(CURRENT),
            format!("{generation}\n").as_bytes(),
        )?;
        failpoint("pointed")?;
        Ok(verified)
    }

    /// Records that `image`'s memory file is now complete, after hydration
    /// filled every chunk from object storage.
    pub fn mark_local(&self, image: &Verified) -> Result<Verified, Suspect> {
        let dir = self.path(image.generation());
        File::open(dir.join(MEMORY))?.sync_all()?;
        seal(&dir.join(MEMORY))?;
        let meta = Meta {
            remote: false,
            ..image.meta.clone()
        };
        write_atomic(
            &dir.join(META),
            &serde_json::to_vec_pretty(&meta).map_err(io::Error::other)?,
        )?;
        remove_durably(&dir.join(REMOTE))?;
        self.verify(image.generation(), Depth::Light)
    }

    /// Removes every generation older than `newest`, except those in
    /// `in_use` (for example the image a running VM still maps). Needs
    /// proof that `newest` is good.
    pub fn retire(&self, newest: &Verified, in_use: &[Generation]) -> io::Result<()> {
        for generation in retirable(&self.generations()?, newest.generation(), in_use) {
            let path = self.path(generation);
            let doomed = self.dir.join(format!("{generation}.retiring"));
            fs::rename(&path, &doomed)?;
            failpoint("retiring")?;
            fs::remove_dir_all(&doomed)?;
        }
        sync_dir(&self.dir)
    }

    /// Moves a suspect generation aside, out of every path that could use
    /// it, and clears `current` if it named it.
    pub fn quarantine(&self, generation: Generation, why: &Suspect) -> io::Result<()> {
        let quarantine = self.dir.join(QUARANTINE);
        fs::create_dir_all(&quarantine)?;
        if self.current()? == Some(generation) {
            remove_durably(&self.dir.join(CURRENT))?;
        }
        let from = self.path(generation);
        if from.exists() {
            let mut to = quarantine.join(format!("{generation}-{}", why.tag()));
            let mut attempt = 0;
            while to.exists() {
                attempt += 1;
                to = quarantine.join(format!("{generation}-{}-{attempt}", why.tag()));
            }
            fs::rename(&from, &to)?;
            fs::write(to.join("reason"), why.to_string())?;
            tracing::warn!(path = %to.display(), %why, "image quarantined");
        }
        let mut kept: Vec<_> = fs::read_dir(&quarantine)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        kept.sort();
        if kept.len() > QUARANTINE_KEEP {
            for old in &kept[..kept.len() - QUARANTINE_KEEP] {
                let _ = fs::remove_dir_all(old);
            }
        }
        sync_dir(&self.dir)
    }

    /// Makes the directory consistent after a crash: unfinished builds are
    /// removed, a damaged current generation is quarantined, and once the
    /// current generation checks out, leftovers older or newer than it are
    /// removed. Without a good current generation nothing is removed.
    pub fn recover(&self) -> io::Result<Option<Verified>> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Ok(None);
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".staging") || name.ends_with(".retiring") {
                fs::remove_dir_all(entry.path())?;
            }
        }
        let current = match self.current_verified() {
            Ok(current) => current,
            Err(why) => {
                if let Ok(Some(generation)) = self.current() {
                    self.quarantine(generation, &why)?;
                } else {
                    remove_durably(&self.dir.join(CURRENT))?;
                }
                return Ok(None);
            }
        };
        if let Some(current) = &current {
            for generation in self.generations()? {
                if generation != current.generation() {
                    fs::remove_dir_all(self.path(generation))?;
                }
            }
            sync_dir(&self.dir)?;
        }
        Ok(current)
    }

    /// Removes every image and the pointer: the sandbox has no memory image.
    pub fn clear(&self) -> io::Result<()> {
        remove_durably(&self.dir.join(CURRENT))?;
        for generation in self.generations()? {
            fs::remove_dir_all(self.path(generation))?;
        }
        Ok(())
    }

    fn next_generation(&self) -> io::Result<Generation> {
        let newest = self.generations()?.last().copied();
        let current = self.current().ok().flatten();
        let quarantined = fs::read_dir(self.dir.join(QUARANTINE))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                Generation::parse(name.to_str()?.get(..16)?)
            })
            .max();
        let highest = [newest, current, quarantined].into_iter().flatten().max();
        Ok(Generation(highest.map_or(1, |Generation(n)| n + 1)))
    }
}

/// Which of `generations` may be removed once `newest` is verified good:
/// those older than it and not in use. Never `newest` itself, never anything
/// newer.
pub(crate) fn retirable(
    generations: &[Generation],
    newest: Generation,
    in_use: &[Generation],
) -> Vec<Generation> {
    generations
        .iter()
        .copied()
        .filter(|generation| *generation < newest && !in_use.contains(generation))
        .collect()
}

/// Number of chunks covering `len` bytes.
pub(crate) fn chunk_count(len: u64) -> usize {
    usize::try_from(len.div_ceil(CHUNK_BYTES)).unwrap_or(usize::MAX)
}

/// The byte range of chunk `index` in an image of `len` bytes.
pub(crate) fn chunk_range(index: usize, len: u64) -> Range<u64> {
    let start = index as u64 * CHUNK_BYTES;
    start..(start + CHUNK_BYTES).min(len)
}

/// Writes `base` with `diff`'s data ranges laid over it into `target`, and
/// returns the chunks those ranges touch.
fn merge(base: &Path, diff: &Path, target: &Path, len: u64) -> io::Result<Vec<usize>> {
    let diff = File::open(diff)?;
    let diff_len = diff.metadata()?.len();
    if diff_len != len {
        return Err(invalid("diff and base differ in length"));
    }
    clone_file(base, target)?;
    let out = fs::OpenOptions::new().write(true).open(target)?;
    let ranges = data_ranges(&diff, len)?;
    for range in &ranges {
        copy_range(&diff, &out, range.clone())?;
    }
    out.sync_all()?;
    let mut touched: Vec<usize> = Vec::new();
    for range in &ranges {
        let first = usize::try_from(range.start / CHUNK_BYTES).unwrap_or(usize::MAX);
        let last = usize::try_from((range.end - 1) / CHUNK_BYTES).unwrap_or(usize::MAX);
        for index in first..=last {
            if touched.last() != Some(&index) {
                touched.push(index);
            }
        }
    }
    touched.dedup();
    Ok(touched)
}

/// Hashes chunks `indices` of `file` (a memory image of `len` bytes) in
/// parallel; chunks that are holes or all zeros map to [`ZERO`].
pub(crate) fn hash_chunks(file: &File, len: u64, indices: &[usize]) -> io::Result<Vec<Hash>> {
    let data = data_ranges(file, len)?;
    let threads = std::thread::available_parallelism()
        .map_or(4, std::num::NonZero::get)
        .min(16);
    let per_thread = indices.len().div_ceil(threads).max(1);
    let mut hashes = vec![ZERO; indices.len()];
    std::thread::scope(|scope| {
        let workers: Vec<_> = indices
            .chunks(per_thread)
            .zip(hashes.chunks_mut(per_thread))
            .map(|(indices, out)| {
                let data = &data;
                scope.spawn(move || -> io::Result<()> {
                    let mut buffer = vec![0_u8; usize::try_from(CHUNK_BYTES).unwrap_or(0)];
                    for (index, slot) in indices.iter().zip(out) {
                        let range = chunk_range(*index, len);
                        if !overlaps(data, &range) {
                            continue;
                        }
                        let length = usize::try_from(range.end - range.start).unwrap_or(0);
                        let bytes = &mut buffer[..length];
                        file.read_exact_at(bytes, range.start)?;
                        if bytes.iter().any(|&byte| byte != 0) {
                            *slot = *blake3::hash(bytes).as_bytes();
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        workers.into_iter().try_for_each(|worker| {
            worker
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("hashing thread panicked")))
        })
    })?;
    Ok(hashes)
}

/// Whether `range` touches any of the sorted, disjoint `data` ranges.
pub(crate) fn overlaps(data: &[Range<u64>], range: &Range<u64>) -> bool {
    let first_after = data.partition_point(|data| data.end <= range.start);
    data.get(first_after)
        .is_some_and(|data| data.start < range.end)
}

/// The ranges of `file` (of `length` bytes) that hold data, sorted.
#[cfg(target_os = "linux")]
pub(crate) fn data_ranges(file: &File, length: u64) -> io::Result<Vec<Range<u64>>> {
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
pub(crate) fn data_ranges(_: &File, length: u64) -> io::Result<Vec<Range<u64>>> {
    Ok(std::iter::once(0..length).collect())
}

/// Copies `range` of `from` to the same offsets of `to`.
#[cfg(target_os = "linux")]
fn copy_range(from: &File, to: &File, range: Range<u64>) -> io::Result<()> {
    let mut source = range.start;
    let mut target = range.start;
    while source < range.end {
        let length = usize::try_from(range.end - source)
            .unwrap_or(usize::MAX)
            .min(1 << 30);
        let copied =
            rustix::fs::copy_file_range(from, Some(&mut source), to, Some(&mut target), length)?;
        if copied == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "diff shrank while merging",
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn copy_range(from: &File, to: &File, range: Range<u64>) -> io::Result<()> {
    let mut buffer = vec![0; usize::try_from(range.end - range.start).unwrap_or(0)];
    from.read_exact_at(&mut buffer, range.start)?;
    to.write_all_at(&buffer, range.start)
}

/// Copies `from` to a new file `to` sharing extents where the filesystem can.
fn clone_file(from: &Path, to: &Path) -> io::Result<()> {
    crate::layout::copy_sparse(from, to)?;
    // The parent is sealed read-only; the copy must be writable to merge into.
    fs::set_permissions(to, fs::Permissions::from_mode(0o600))
}

/// Moves `from` to `to`: a rename, or a copy where they are on different
/// filesystems.
fn move_in(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(rustix::io::Errno::XDEV.raw_os_error()) => {
            crate::layout::copy_sparse(from, to)?;
            fs::remove_file(from)
        }
        Err(error) => Err(error),
    }
}

/// Puts `image`, published in `from`, into `staging` as shared files and
/// returns its chunk map.
fn share_image(from: &Images, image: &Verified, staging: &Path) -> Result<ChunkMap, Suspect> {
    if image.meta.remote {
        return Err(Suspect::Damaged {
            generation: image.generation(),
            reason: "a shared image must be fully in local memory".into(),
        });
    }
    let generation = image.generation();
    share(&from.memory(generation), &staging.join(MEMORY))?;
    share(&from.state(generation), &staging.join(STATE))?;
    Ok(from.chunk_map(image)?)
}

/// Seals a staged generation's files and makes them and their directory
/// durable. Memory still being filled from the store (`remote`) stays
/// writable until [`Images::mark_local`].
fn seal_staged(staging: &Path, remote: bool) -> io::Result<()> {
    let sealed: &[&str] = if remote { &[STATE] } else { &[STATE, MEMORY] };
    for name in sealed {
        seal(&staging.join(name))?;
    }
    for name in [STATE, MEMORY] {
        File::open(staging.join(name))?.sync_all()?;
    }
    sync_dir(staging)
}

/// Makes `to` the same file as the published `from`: a hard link where
/// both are on one filesystem, otherwise a copy.
fn share(from: &Path, to: &Path) -> io::Result<()> {
    match fs::hard_link(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(rustix::io::Errno::XDEV.raw_os_error()) => {
            crate::layout::copy_sparse(from, to)
        }
        Err(error) => Err(error),
    }
}

/// Makes a published file read-only and owned by the host agent, so a VMM
/// that maps it (through a hard link in its jail) cannot change it.
fn seal(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let uid = rustix::process::geteuid();
        let gid = rustix::process::getegid();
        rustix::fs::chown(path, Some(uid), Some(gid))?;
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let file = File::create(path)?;
    file.write_all_at(bytes, 0)?;
    file.sync_all()
}

fn sync_dir(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

/// Creates `dir` if missing, with its entry in its parent made durable.
fn create_dir_durably(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    match dir.parent() {
        Some(parent) => sync_dir(parent),
        None => Ok(()),
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Where tests stop a publish or retire as if the host had crashed there.
#[cfg(test)]
fn failpoint(name: &'static str) -> io::Result<()> {
    tests::FAILPOINT.with(|point| {
        if point.get() == Some(name) {
            Err(io::Error::other(format!("simulated crash at {name}")))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
#[allow(clippy::unnecessary_wraps)]
fn failpoint(_: &'static str) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    thread_local! {
        pub(super) static FAILPOINT: Cell<Option<&'static str>> = const { Cell::new(None) };
    }

    const PAGE: u64 = 4096;
    const PAGE_BYTES: usize = 4096;
    /// Small images keep the tests fast; three and a half chunks, so the
    /// last chunk is partial.
    const LEN: u64 = CHUNK_BYTES * 3 + CHUNK_BYTES / 2;

    /// A deterministic pseudo-random sequence (xorshift), so failures replay.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("compute-image-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes a sparse diff: `pages` as (page number, fill byte), the rest holes.
    fn write_diff(path: &Path, pages: &[(u64, u8)]) {
        let file = File::create(path).unwrap();
        file.set_len(LEN).unwrap();
        for (page, fill) in pages {
            file.write_all_at(&[*fill; PAGE_BYTES], page * PAGE)
                .unwrap();
        }
        file.sync_all().unwrap();
    }

    fn write_state(path: &Path, content: &[u8]) {
        fs::write(path, content).unwrap();
    }

    fn random_pages(rng: &mut Rng) -> Vec<(u64, u8)> {
        let pages = LEN / PAGE;
        let count = rng.below(12);
        (0..count)
            // Zero fills included: zeros a guest wrote must survive the merge.
            .map(|_| (rng.below(pages), u8::try_from(rng.below(4)).unwrap() * 85))
            .collect()
    }

    fn apply(model: &mut [u8], pages: &[(u64, u8)]) {
        for (page, fill) in pages {
            let at = usize::try_from(page * PAGE).unwrap();
            model[at..at + PAGE_BYTES].fill(*fill);
        }
    }

    fn content(images: &Images, generation: Generation) -> Vec<u8> {
        fs::read(images.memory(generation)).unwrap()
    }

    #[test]
    fn merged_images_equal_their_base_with_the_diff_laid_over_it() {
        let dir = scratch("merge");
        let images = Images::new(dir.join("images"));
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut model = vec![0_u8; usize::try_from(LEN).unwrap()];
        let mut base = None;
        for round in 0..40 {
            let pages = random_pages(&mut rng);
            let diff = dir.join("diff");
            let state = dir.join("state");
            write_diff(&diff, &pages);
            write_state(&state, format!("state {round}").as_bytes());
            apply(&mut model, &pages);
            let image = match base {
                // The first diff stands on zeros: it is the whole image.
                None => images.publish(Parts::Whole {
                    state: &state,
                    memory: &diff,
                }),
                Some(base) => images.publish(Parts::Diff {
                    base,
                    state: &state,
                    diff: &diff,
                }),
            }
            .unwrap();
            let generation = image.generation();
            assert_eq!(content(&images, generation), model, "round {round}");
            // The incrementally maintained chunk map equals a fresh one.
            images.verify(generation, Depth::Deep).unwrap();
            assert_eq!(images.current().unwrap(), Some(generation));
            assert!(!diff.exists(), "the diff is consumed");
            images.retire(&image, &[]).unwrap();
            assert_eq!(images.generations().unwrap(), vec![generation]);
            base = Some(generation);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_diff_of_the_wrong_length_is_refused() {
        let dir = scratch("length");
        let images = Images::new(dir.join("images"));
        let (diff, state) = (dir.join("diff"), dir.join("state"));
        write_diff(&diff, &[(1, 7)]);
        write_state(&state, b"s");
        let base = images
            .publish(Parts::Whole {
                state: &state,
                memory: &diff,
            })
            .unwrap();
        File::create(&diff).unwrap().set_len(LEN - PAGE).unwrap();
        write_state(&state, b"t");
        assert!(
            images
                .publish(Parts::Diff {
                    base: base.generation(),
                    state: &state,
                    diff: &diff,
                })
                .is_err()
        );
        assert_eq!(images.current().unwrap(), Some(base.generation()));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A sandbox started from a template publishes the template's image as
    /// its own: the same memory file, and a later save merges over it
    /// without touching the template.
    #[test]
    fn a_shared_image_is_the_same_file_and_survives_its_source() {
        use std::os::unix::fs::MetadataExt;

        let dir = scratch("shared");
        let template = Images::new(dir.join("template"));
        let (memory, state) = (dir.join("memory"), dir.join("state"));
        write_diff(&memory, &[(1, 7), (40, 9)]);
        write_state(&state, b"template state");
        let source = template
            .publish(Parts::Whole {
                state: &state,
                memory: &memory,
            })
            .unwrap();
        let before = content(&template, source.generation());

        let sandbox = Images::new(dir.join("sandbox"));
        let image = sandbox
            .publish(Parts::Shared {
                from: &template,
                image: &source,
            })
            .unwrap();
        assert_eq!(sandbox.current().unwrap(), Some(image.generation()));
        sandbox.verify(image.generation(), Depth::Deep).unwrap();
        let inode = |path: PathBuf| fs::metadata(path).unwrap().ino();
        assert_eq!(
            inode(sandbox.memory(image.generation())),
            inode(template.memory(source.generation())),
            "one file, one page cache"
        );

        let diff = dir.join("diff");
        write_diff(&diff, &[(2, 5)]);
        write_state(&state, b"sandbox state");
        let saved = sandbox
            .publish(Parts::Diff {
                base: image.generation(),
                state: &state,
                diff: &diff,
            })
            .unwrap();
        sandbox.retire(&saved, &[]).unwrap();
        assert_eq!(content(&template, source.generation()), before);
        template.verify(source.generation(), Depth::Deep).unwrap();

        fs::remove_dir_all(dir.join("template")).unwrap();
        sandbox.verify(saved.generation(), Depth::Deep).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Simulates many save cycles in which the host crashes at any point of
    /// publishing or retiring, and in which stored files get corrupted. After
    /// every recovery, the current image is either exactly the last
    /// committed state or, if that image was damaged, absent and kept in
    /// quarantine; a damaged image is never used.
    #[test]
    fn crashes_and_corruption_never_lose_or_misuse_the_committed_image() {
        const POINTS: [Option<&str>; 5] = [
            None,
            Some("staged"),
            Some("renamed"),
            Some("pointed"),
            Some("retiring"),
        ];
        for seed in 1..=25_u64 {
            let dir = scratch(&format!("crash-{seed}"));
            let images = Images::new(dir.join("images"));
            let mut rng = Rng(seed.wrapping_mul(0x2545_f491_4f6c_dd1d) | 1);
            let mut model = vec![0_u8; usize::try_from(LEN).unwrap()];
            // The content `current` must have, if it exists.
            let mut committed: Option<Vec<u8>> = None;
            for _ in 0..30 {
                let pages = random_pages(&mut rng);
                let (diff, state) = (dir.join("diff"), dir.join("state"));
                write_diff(&diff, &pages);
                write_state(&state, b"state");
                let point = POINTS[usize::try_from(rng.below(POINTS.len() as u64)).unwrap()];
                FAILPOINT.with(|cell| cell.set(point));
                let base = images.current().unwrap();
                let result = match base {
                    None => images.publish(Parts::Whole {
                        state: &state,
                        memory: &diff,
                    }),
                    Some(base) => images.publish(Parts::Diff {
                        base,
                        state: &state,
                        diff: &diff,
                    }),
                };
                let mut next = if base.is_some() {
                    model.clone()
                } else {
                    vec![0; model.len()]
                };
                apply(&mut next, &pages);
                match result {
                    Ok(image) => {
                        committed = Some(next.clone());
                        model = next;
                        let _ = images.retire(&image, &[]);
                    }
                    // Crashed after the pointer moved: committed anyway.
                    Err(_) if point == Some("pointed") => {
                        committed = Some(next.clone());
                        model = next;
                    }
                    Err(_) => {}
                }
                FAILPOINT.with(|cell| cell.set(None));
                // Now and then, damage the current image on disk.
                let mut damaged = false;
                if rng.below(6) == 0
                    && let Some(generation) = images.current().unwrap()
                {
                    let victim = images.path(generation).join(match rng.below(3) {
                        0 => STATE,
                        1 => CHUNKS,
                        _ => META,
                    });
                    let mut bytes = fs::read(&victim).unwrap();
                    let at = usize::try_from(rng.below(bytes.len() as u64)).unwrap();
                    bytes[at] ^= 0x5a;
                    fs::set_permissions(&victim, fs::Permissions::from_mode(0o644)).unwrap();
                    fs::write(&victim, bytes).unwrap();
                    damaged = true;
                }
                let recovered = images.recover().unwrap();
                match (&committed, recovered) {
                    (Some(_), None) => {
                        assert!(damaged, "seed {seed}: a good committed image was lost");
                        assert!(
                            fs::read_dir(images.dir().join(QUARANTINE)).unwrap().count() > 0,
                            "seed {seed}: damaged image deleted instead of quarantined"
                        );
                        committed = None;
                        model.fill(0);
                    }
                    (Some(expected), Some(image)) => {
                        assert!(!damaged, "seed {seed}: a damaged image was trusted");
                        assert_eq!(&content(&images, image.generation()), expected);
                        images.verify(image.generation(), Depth::Deep).unwrap();
                        assert_eq!(images.generations().unwrap(), vec![image.generation()]);
                    }
                    (None, None) => {}
                    (None, Some(_)) => panic!("seed {seed}: an uncommitted image became current"),
                }
            }
            fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn retiring_needs_a_newer_good_image_and_spares_images_in_use() {
        let all = [Generation(1), Generation(2), Generation(3), Generation(4)];
        assert_eq!(
            retirable(&all, Generation(3), &[Generation(1)]),
            vec![Generation(2)]
        );
        assert_eq!(retirable(&all, Generation(1), &[]), Vec::new());
        // Exhaustively: never the proven image, never anything newer.
        for newest in 1..=4 {
            for mask in 0..16_u32 {
                let in_use: Vec<_> = all
                    .iter()
                    .copied()
                    .filter(|generation| mask & (1 << (generation.0 - 1)) != 0)
                    .collect();
                for gone in retirable(&all, Generation(newest), &in_use) {
                    assert!(gone.0 < newest && !in_use.contains(&gone));
                }
            }
        }
    }

    #[test]
    fn remote_images_become_local_once_hydrated() {
        let dir = scratch("remote");
        let images = Images::new(dir.join("images"));
        let state = dir.join("state");
        write_state(&state, b"s");
        let mut chunks = ChunkMap::zeros(LEN);
        let fill = vec![9_u8; usize::try_from(CHUNK_BYTES).unwrap()];
        chunks.0[1] = *blake3::hash(&fill).as_bytes();
        let image = images
            .publish(Parts::Remote {
                state: &state,
                memory_len: LEN,
                chunks,
                manifest: b"{}",
            })
            .unwrap();
        assert!(image.meta().remote);
        let generation = image.generation();
        assert!(images.remote(generation).exists());
        {
            let memory = images.memory(generation);
            fs::set_permissions(&memory, fs::Permissions::from_mode(0o644)).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&memory)
                .unwrap()
                .write_all_at(&fill, CHUNK_BYTES)
                .unwrap();
        }
        let local = images.mark_local(&image).unwrap();
        assert!(!local.meta().remote);
        assert!(!images.remote(generation).exists());
        images.verify(generation, Depth::Deep).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}
