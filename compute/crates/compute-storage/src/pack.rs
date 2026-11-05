//! Packs: an archive's chunks of one file, stored end to end as one object
//! (ADR 31), so a store holds a few large objects per archive rather than
//! one per 256 KiB chunk. A chunk reference names its pack and where in it
//! the chunk is ([`crate::chunk::Packed`]); a chunk is read with a range
//! read and checked against its hashes as one stored on its own is.
//!
//! A pack is named by its period and the BLAKE3 hash of its bytes, so a
//! name allows no other bytes, as every name (ADR 25, 28).

use crate::chunk::{ChunkRef, EncodedChunk, Packed};

/// The length at which an archive closes a pack: it holds that, plus at
/// most one chunk.
pub const PACK_BYTES: usize = 16 * 1024 * 1024;

/// The key of the pack of period `period` whose bytes hash to `digest`.
#[must_use]
pub fn key(period: u32, digest: &str) -> String {
    format!("packs/v1/{period}/{digest}")
}

/// A pack being filled: chunks' stored bytes end to end, and where each
/// starts.
#[derive(Debug, Default)]
pub struct Packer {
    bytes: Vec<u8>,
    chunks: Vec<(ChunkRef, u64)>,
}

impl Packer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `chunk` at the end; its place among the chunks added.
    pub fn push(&mut self, chunk: &EncodedChunk) -> usize {
        let offset = self.bytes.len() as u64;
        self.bytes.extend_from_slice(&chunk.bytes);
        let mut reference = chunk.reference.clone();
        reference.pack = None;
        reference.day = None;
        self.chunks.push((reference, offset));
        self.chunks.len() - 1
    }

    /// Whether it holds [`PACK_BYTES`] or more, and should be stored.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.bytes.len() >= PACK_BYTES
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    /// How many bytes it holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Its bytes, and the chunks added, in order, each with its offset.
    #[must_use]
    pub fn finish(self) -> (Vec<u8>, Vec<(ChunkRef, u64)>) {
        (self.bytes, self.chunks)
    }
}

/// Whether `next` is stored straight after `chunk` in the same pack, so
/// one ranged read gets both.
#[must_use]
pub fn follows(chunk: &ChunkRef, next: &ChunkRef) -> bool {
    match (&chunk.pack, &next.pack) {
        (Some(pack), Some(then)) => {
            chunk.day == next.day
                && pack.digest == then.digest
                && chunk.stored_range().end == then.offset
        }
        _ => false,
    }
}

/// What names each of `chunks` once the pack `bytes` holding them is stored
/// under period `period`, with `checksums`.
pub(crate) fn named(
    chunks: Vec<(ChunkRef, u64)>,
    period: u32,
    digest: &str,
    len: u64,
    checksums: &str,
) -> Vec<ChunkRef> {
    chunks
        .into_iter()
        .map(|(reference, offset)| ChunkRef {
            checksums: Some(checksums.to_owned()),
            day: Some(period),
            pack: Some(Packed {
                digest: digest.to_owned(),
                offset,
                len,
            }),
            ..reference
        })
        .collect()
}

#[cfg(test)]
mod tests;
