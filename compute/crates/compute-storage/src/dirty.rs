//! Generation-fenced dirty bitmap for a block backend.
//!
//! Mark writes and discards BEFORE acknowledging them. Rotate only after a
//! consistent snapshot has been captured. On failed shipping, merge the frozen
//! generation back; new writes must never be cleared by old checkpoint success.
use std::ops::Range;

use crate::{Error, Result};

#[derive(Debug)]
pub struct DirtyTracker {
    disk_len: u64,
    block_size: u64,
    active: Vec<u64>,
    pending: Option<(u64, Vec<u64>)>,
    next_generation: u64,
}

impl DirtyTracker {
    pub fn new(disk_len: u64, block_size: u64) -> Result<Self> {
        if disk_len == 0 || !block_size.is_power_of_two() {
            return Err(Error::Invalid("dirty bitmap geometry"));
        }
        let words = usize::try_from(disk_len.div_ceil(block_size).div_ceil(64))
            .map_err(|_| Error::Invalid("bitmap too large"))?;
        let mut active = Vec::new();
        active
            .try_reserve_exact(words)
            .map_err(|_| Error::Invalid("bitmap allocation"))?;
        active.resize(words, 0);
        Ok(Self {
            disk_len,
            block_size,
            active,
            pending: None,
            next_generation: 1,
        })
    }

    pub fn mark(&mut self, offset: u64, length: u64) -> Result<()> {
        let end = offset
            .checked_add(length)
            .ok_or(Error::Invalid("write overflow"))?;
        if end > self.disk_len {
            return Err(Error::Invalid("write past disk"));
        }
        if length == 0 {
            return Ok(());
        }
        for block in offset / self.block_size..end.div_ceil(self.block_size) {
            let word = usize::try_from(block / 64).map_err(|_| Error::Invalid("bitmap index"))?;
            self.active[word] |= 1 << (block % 64);
        }
        Ok(())
    }

    pub fn freeze(&mut self) -> Result<u64> {
        if self.pending.is_some() {
            return Err(Error::Invalid("checkpoint already in flight"));
        }
        let generation = self.next_generation;
        self.next_generation = generation
            .checked_add(1)
            .ok_or(Error::Invalid("generation overflow"))?;
        let replacement = vec![0; self.active.len()];
        self.pending = Some((generation, std::mem::replace(&mut self.active, replacement)));
        Ok(generation)
    }

    pub fn ranges(&self, generation: u64) -> Result<Vec<Range<u64>>> {
        let (_, words) = self
            .pending
            .as_ref()
            .filter(|(g, _)| *g == generation)
            .ok_or(Error::Invalid("unknown checkpoint generation"))?;
        let mut ranges: Vec<Range<u64>> = Vec::new();
        for (index, word) in words.iter().enumerate() {
            let mut bits = *word;
            while bits != 0 {
                let bit = u64::from(bits.trailing_zeros());
                let start = (index as u64 * 64 + bit) * self.block_size;
                let end = start.saturating_add(self.block_size).min(self.disk_len);
                if let Some(last) = ranges.last_mut().filter(|r| r.end == start) {
                    last.end = end;
                } else {
                    ranges.push(start..end);
                }
                bits &= bits - 1;
            }
        }
        Ok(ranges)
    }

    /// `committed` means immutable data, manifest and authoritative pointer are
    /// all durable. A successful object PUT alone is insufficient.
    pub fn finish(&mut self, generation: u64, committed: bool) -> Result<()> {
        if self.pending.as_ref().map(|(g, _)| *g) != Some(generation) {
            return Err(Error::Invalid("unknown checkpoint generation"));
        }
        let (_, words) = self
            .pending
            .take()
            .ok_or(Error::Invalid("missing checkpoint"))?;
        if !committed {
            for (active, frozen) in self.active.iter_mut().zip(words) {
                *active |= frozen;
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn active_bitmap_bytes(&self) -> usize {
        self.active.len() * size_of::<u64>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_writes_survive_old_commit_and_failure_merges() {
        let mut dirty = DirtyTracker::new(65536, 4096).unwrap();
        dirty.mark(1, 4096).unwrap();
        let first = dirty.freeze().unwrap();
        assert_eq!(dirty.ranges(first).unwrap(), vec![0..8192]);
        assert!(dirty.freeze().is_err());
        dirty.mark(16384, 1).unwrap();
        assert!(dirty.finish(first + 1, true).is_err());
        dirty.finish(first, true).unwrap();
        let second = dirty.freeze().unwrap();
        assert_eq!(dirty.ranges(second).unwrap(), vec![16384..20480]);
        dirty.mark(24576, 1).unwrap();
        dirty.finish(second, false).unwrap();
        let third = dirty.freeze().unwrap();
        assert_eq!(
            dirty.ranges(third).unwrap(),
            vec![16384..20480, 24576..28672]
        );
    }

    #[test]
    fn handles_partial_tail_and_overflow() {
        let mut dirty = DirtyTracker::new(4097, 4096).unwrap();
        dirty.mark(4096, 1).unwrap();
        assert!(dirty.mark(u64::MAX, 2).is_err());
        assert!(dirty.mark(4096, 2).is_err());
        let g = dirty.freeze().unwrap();
        assert_eq!(dirty.ranges(g).unwrap(), vec![4096..4097]);
    }
}
