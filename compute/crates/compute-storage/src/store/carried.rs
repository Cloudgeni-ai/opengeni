//! What a store stored itself, and in which period, so that a write of the
//! same bytes in a later period copies the earlier object within the store
//! instead of uploading the bytes again (ADR 28). An archive a sweep's
//! fence stopped then keeps what it already stored, whatever the sweep's
//! schedule.
//!
//! Only a hint: the earlier object may be gone (a sweep deletes it once
//! its period ended an hour before) or damaged, so a copy is verified and
//! the bytes are uploaded when it does not hold them.
use std::collections::HashMap;
use std::fmt;

use crate::chunk::{ChunkRef, Codec};

/// How many chunks a store remembers: 64 GiB of a host's 256 KiB chunks.
/// An entry is 40 bytes (a stored hash, a codec and a period) and the
/// table keeps up to as much again spare, so a full record costs about
/// 20 MB.
pub(super) const REMEMBERED: usize = 262_144;

/// A chunk by the bytes stored: its stored hash and codec.
type Key = ([u8; 32], u8);

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
    pub(super) fn earlier(&self, reference: &ChunkRef, period: u32) -> Option<u32> {
        self.periods
            .get(&key(reference)?)
            .copied()
            .filter(|stored| *stored < period)
    }

    /// Remembers that this store stored `reference`'s bytes in `period`.
    /// When full, it forgets the oldest period's chunks first; it does not
    /// forget this period's to make room.
    pub(super) fn remember(&mut self, reference: &ChunkRef, period: u32) {
        let Some(key) = key(reference) else {
            return;
        };
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

/// `reference`'s key; `None` for a stored hash that is not 64 hex digits.
fn key(reference: &ChunkRef) -> Option<Key> {
    let hex = reference.stored_hash.as_bytes();
    if hex.len() != 64 {
        return None;
    }
    let mut hash = [0; 32];
    for (byte, pair) in hash.iter_mut().zip(hex.as_chunks::<2>().0) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    let codec = match reference.codec {
        Codec::Raw => 0,
        Codec::Zstd => 1,
    };
    Some((hash, codec))
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
}
