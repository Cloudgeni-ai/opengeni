//! What a store stored itself, and in which period, so that a write of the
//! same bytes in a later period copies the earlier object within the store
//! instead of uploading the bytes again (ADR 28). An archive a sweep's
//! fence stopped then keeps what it already stored, whatever the sweep's
//! schedule.
//!
//! Only a hint: the earlier object may be gone (a sweep deletes it once
//! its period ended an hour before) or damaged, so a copy is verified and
//! the bytes are uploaded when it does not hold them.
//!
//! An archive in flight also carries what it stored into each new hour as
//! the hour begins ([`ChunkStore::keeping`]), so no sweep takes it before
//! the archive publishes or, stopped by a sweep's fence, starts again and
//! finds it: an archive of any length then publishes beside hourly sweeps.
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use futures::{StreamExt as _, stream};

use super::ChunkStore;
use crate::chunk::{ChunkRef, Codec};
use crate::fresh::{period_of, until_next_period};

/// How many chunks a store remembers: 64 GiB of a host's 256 KiB chunks.
/// An entry is 40 bytes (a stored hash, a codec and a period) and the
/// table keeps up to as much again spare, so a full record costs about
/// 20 MB.
pub(super) const REMEMBERED: usize = 262_144;

/// Chunks carried into a new hour at once.
const KEEPS: usize = 32;

/// How soon carrying is tried again after a request failed.
const RETRY: Duration = Duration::from_secs(60);

/// A chunk by the bytes stored: its stored hash and codec; or a pack by
/// its digest, with [`PACK`] for a codec.
type Key = ([u8; 32], u8);

/// What stands for a codec in a pack's [`Key`].
const PACK: u8 = u8::MAX;

pub(super) struct Stored {
    /// The period each chunk this store wrote was last stored in.
    periods: HashMap<Key, u32>,
    most: usize,
}

impl Stored {
    pub(super) fn new(most: usize) -> Self {
        Self {
            periods: HashMap::new(),
            most,
        }
    }

    /// The period this store stored `reference`'s bytes in, if earlier than
    /// `period`.
    #[cfg(test)]
    pub(super) fn earlier(&self, reference: &ChunkRef, period: u32) -> Option<u32> {
        self.period(reference).filter(|stored| *stored < period)
    }

    /// The period this store last stored `reference`'s bytes in.
    pub(super) fn period(&self, reference: &ChunkRef) -> Option<u32> {
        self.periods.get(&key(reference)?).copied()
    }

    /// The period this store last stored the pack whose digest is `digest`
    /// in.
    pub(super) fn pack_period(&self, digest: &str) -> Option<u32> {
        self.periods.get(&(hex32(digest)?, PACK)).copied()
    }

    /// Remembers that this store stored the pack whose digest is `digest`
    /// in `period`, as [`Self::remember`] does a chunk.
    pub(super) fn remember_pack(&mut self, digest: &str, period: u32) {
        if let Some(hash) = hex32(digest) {
            self.insert((hash, PACK), period);
        }
    }

    /// Remembers that this store stored `reference`'s bytes in `period`.
    /// When full, it forgets the oldest period's chunks first; it does not
    /// forget this period's to make room.
    pub(super) fn remember(&mut self, reference: &ChunkRef, period: u32) {
        if let Some(key) = key(reference) {
            self.insert(key, period);
        }
    }

    fn insert(&mut self, key: Key, period: u32) {
        if !self.periods.contains_key(&key) && self.periods.len() >= self.most {
            match self.periods.values().min().copied() {
                Some(oldest) if oldest < period => {
                    self.periods.retain(|_, stored| *stored != oldest);
                }
                _ => return,
            }
        }
        self.periods.insert(key, period);
    }
}

impl fmt::Debug for Stored {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Stored")
            .field("chunks", &self.periods.len())
            .field("most", &self.most)
            .finish()
    }
}

/// The chunks an archive stored that no pointer it published names yet,
/// each by its latest name. It holds about as much as the archive's own
/// references to what it stored, a few hundred bytes a chunk.
#[derive(Debug, Default)]
pub struct Held(Mutex<HashMap<HeldKey, ChunkRef>>);

/// A held chunk whatever period names it: by its bytes when stored on its
/// own, by its pack's digest and its place there when in a pack. The same
/// bytes may be in two packs, and each is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum HeldKey {
    Chunk(Key),
    Packed([u8; 32], u64),
}

impl HeldKey {
    fn of(reference: &ChunkRef) -> Option<Self> {
        match &reference.pack {
            Some(pack) => Some(Self::Packed(hex32(&pack.digest)?, pack.offset)),
            None => key(reference).map(Self::Chunk),
        }
    }
}

impl Held {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many chunks it holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.chunks().len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.chunks().is_empty()
    }

    fn chunks(&self) -> std::sync::MutexGuard<'_, HashMap<HeldKey, ChunkRef>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds `reference`, unless it holds a later name of the same bytes.
    pub(super) fn hold(&self, reference: &ChunkRef) {
        let Some(key) = HeldKey::of(reference) else {
            return;
        };
        let mut chunks = self.chunks();
        if chunks.get(&key).is_none_or(|held| held.day < reference.day) {
            chunks.insert(key, reference.clone());
        }
    }

    /// Stops holding `reference`, unless it holds a later name of the same
    /// bytes.
    fn release(&self, reference: &ChunkRef) {
        let Some(key) = HeldKey::of(reference) else {
            return;
        };
        let mut chunks = self.chunks();
        if chunks
            .get(&key)
            .is_some_and(|held| held.day <= reference.day)
        {
            chunks.remove(&key);
        }
    }

    /// What it holds under a period before `period`.
    fn before(&self, period: u32) -> Vec<ChunkRef> {
        self.chunks()
            .values()
            .filter(|held| held.day.is_some_and(|day| day < period))
            .cloned()
            .collect()
    }
}

/// What carrying an archive's chunks into a new hour did, counted in
/// objects: a chunk stored on its own, or a pack.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Kept {
    /// Objects copied within the store under the new hour's name.
    pub copied: usize,
    pub copied_bytes: u64,
    /// Objects another write stored under the new hour's name already.
    pub found: usize,
    /// Objects gone, or not as stored, so not carried: a sweep took them.
    /// Their chunks are no longer held; the archive's next try stores
    /// them again.
    pub lost: usize,
    /// Objects not carried because a request failed; tried again soon.
    pub failed: usize,
}

impl Kept {
    fn add(&mut self, other: Self) {
        self.copied += other.copied;
        self.copied_bytes += other.copied_bytes;
        self.found += other.found;
        self.lost += other.lost;
        self.failed += other.failed;
    }
}

impl ChunkStore {
    /// Carries every chunk `held` holds under an earlier period's name into
    /// this period's, by a copy within the store checked as a write's is,
    /// and holds it by that name instead.
    ///
    /// A pack is carried once, whatever number of its chunks are held, and
    /// counts as one: what is copied is objects.
    pub async fn keep(&self, held: &Held) -> Kept {
        let period = period_of(self.clock.now());
        let mut objects: HashMap<String, Vec<ChunkRef>> = HashMap::new();
        for from in held.before(period) {
            objects.entry(from.key()).or_default().push(from);
        }
        let carried: Vec<_> = stream::iter(objects.into_values())
            .map(|chunks| async move {
                let to = chunks[0].on_day(period);
                let carried = self.carry(&chunks[0].key(), &to).await;
                (chunks, to, carried)
            })
            .buffer_unordered(KEEPS)
            .collect()
            .await;
        let mut kept = Kept::default();
        for (chunks, to, carried) in carried {
            match carried {
                Ok(Some(copied)) => {
                    if copied {
                        match &to.pack {
                            Some(pack) => self.stored().remember_pack(&pack.digest, period),
                            None => self.stored().remember(&to, period),
                        }
                        kept.copied += 1;
                        kept.copied_bytes += to.object_len();
                    } else {
                        kept.found += 1;
                    }
                    for from in &chunks {
                        held.hold(&from.on_day(period));
                    }
                }
                Ok(None) => {
                    for from in &chunks {
                        held.release(from);
                    }
                    kept.lost += 1;
                }
                Err(error) => {
                    tracing::warn!(object = %to.key(), %error, "object not carried into the new hour; trying again");
                    kept.failed += 1;
                }
            }
        }
        kept
    }

    /// Runs `work`, an archive storing its chunks through a store
    /// [`holding`](Self::holding) `held`, and while it runs carries what
    /// `held` holds into each new hour as the hour begins by this store's
    /// clock ([`Self::keep`]), and once at the start, for what an earlier
    /// try stored. A sweep deletes an hour's objects once the hour ended
    /// [`crate::fresh::CLOCK_SKEW`] before by its clock, so what the
    /// archive stored stays while it runs, and a try a sweep's fence
    /// stopped is followed by one that finds it. `work`'s result, and what
    /// carrying did.
    pub async fn keeping<T>(&self, held: &Held, work: impl Future<Output = T>) -> (T, Kept) {
        let total = Mutex::new(Kept::default());
        let carrying = async {
            loop {
                let kept = self.keep(held).await;
                total
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .add(kept);
                let next = until_next_period(self.clock.now());
                let wait = if kept.failed > 0 {
                    next.min(RETRY)
                } else {
                    next
                };
                tokio::time::sleep(wait.max(Duration::from_secs(1))).await;
            }
        };
        let out = tokio::select! {
            out = work => out,
            () = carrying => unreachable!("carrying never ends"),
        };
        (
            out,
            total.into_inner().unwrap_or_else(PoisonError::into_inner),
        )
    }
}

/// `reference`'s key; `None` for a stored hash that is not 64 hex digits.
fn key(reference: &ChunkRef) -> Option<Key> {
    let codec = match reference.codec {
        Codec::Raw => 0,
        Codec::Zstd => 1,
    };
    Some((hex32(&reference.stored_hash)?, codec))
}

/// The 32 bytes 64 hex digits spell.
fn hex32(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.as_bytes();
    if hex.len() != 64 {
        return None;
    }
    let mut hash = [0; 32];
    for (byte, pair) in hash.iter_mut().zip(hex.as_chunks::<2>().0) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::EncodedChunk;

    fn chunk(n: u8) -> ChunkRef {
        EncodedChunk::encode(&[n; 64], 1).unwrap().reference
    }

    #[test]
    fn only_an_earlier_period_is_offered() {
        let mut stored = Stored::new(4);
        stored.remember(&chunk(1), 10);
        assert_eq!(stored.earlier(&chunk(1), 11), Some(10));
        assert_eq!(stored.earlier(&chunk(1), 10), None, "this period's");
        assert_eq!(stored.earlier(&chunk(1), 9), None, "a later one's");
        assert_eq!(stored.earlier(&chunk(2), 11), None, "never stored");
        stored.remember(&chunk(1), 11);
        assert_eq!(stored.earlier(&chunk(1), 12), Some(11), "the latest");
    }

    #[test]
    fn a_full_record_forgets_the_oldest_period_first() {
        let mut stored = Stored::new(3);
        stored.remember(&chunk(1), 10);
        stored.remember(&chunk(2), 10);
        stored.remember(&chunk(3), 11);
        stored.remember(&chunk(4), 12);
        assert_eq!(stored.earlier(&chunk(1), 13), None);
        assert_eq!(stored.earlier(&chunk(2), 13), None);
        assert_eq!(stored.earlier(&chunk(3), 13), Some(11));
        assert_eq!(stored.earlier(&chunk(4), 13), Some(12));
        // Full of this period's: the newcomer is not remembered.
        let mut stored = Stored::new(1);
        stored.remember(&chunk(1), 12);
        stored.remember(&chunk(2), 12);
        assert_eq!(stored.earlier(&chunk(1), 13), Some(12));
        assert_eq!(stored.earlier(&chunk(2), 13), None);
        // Nothing is remembered at all with no room.
        let mut stored = Stored::new(0);
        stored.remember(&chunk(1), 12);
        assert_eq!(stored.earlier(&chunk(1), 13), None);
    }

    #[test]
    fn an_archive_holds_the_latest_name_of_each_chunk() {
        let held = Held::new();
        held.hold(&chunk(1).on_day(10));
        held.hold(&chunk(1).on_day(11));
        held.hold(&chunk(1).on_day(10));
        held.hold(&chunk(2).on_day(12));
        assert_eq!(held.len(), 2);
        let before: Vec<_> = held.before(12).into_iter().map(|held| held.day).collect();
        assert_eq!(before, [Some(11)], "the latest, and only those earlier");
        held.release(&chunk(2).on_day(11));
        assert_eq!(held.len(), 2, "a later name stays");
        held.release(&chunk(1).on_day(11));
        assert_eq!(held.len(), 1);
        assert!(held.before(13).iter().all(|held| held.day == Some(12)));
    }
}
