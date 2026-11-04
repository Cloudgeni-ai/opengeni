//! Deterministic fixed and bounded Gear content-defined chunking.
use std::{io::Read, ops::Range};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Upper bound on decoded chunks, including untrusted manifests.
pub const MAX_CHUNK: usize = 16 * 1024 * 1024;

/// Upper bound on a pack's length, including untrusted manifests: an
/// archive closes one at [`crate::pack::PACK_BYTES`], so it holds that
/// plus at most one chunk.
pub const MAX_PACK: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Chunking {
    Fixed {
        size: usize,
    },
    /// Gear hash boundaries. `average` must be a power of two.
    Gear {
        min: usize,
        average: usize,
        max: usize,
    },
}

impl Chunking {
    pub fn validate(self) -> Result<()> {
        let valid = match self {
            Self::Fixed { size } => size > 0 && size <= MAX_CHUNK,
            Self::Gear { min, average, max } => {
                min > 0
                    && min <= average
                    && average <= max
                    && max <= MAX_CHUNK
                    && average.is_power_of_two()
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::Invalid("chunk geometry"))
        }
    }

    /// Partition one contiguous extent. Call separately for discontiguous ranges.
    pub fn ranges(self, input: &[u8]) -> Result<Vec<Range<usize>>> {
        self.validate()?;
        let mut ranges = Vec::new();
        let mut start = 0;
        while start < input.len() {
            let length = match self {
                Self::Fixed { size } => size.min(input.len() - start),
                Self::Gear { min, average, max } => {
                    let limit = max.min(input.len() - start);
                    let mut hash = 0_u64;
                    let mut length = limit;
                    for (i, byte) in input[start..start + limit].iter().enumerate() {
                        hash = hash
                            .wrapping_shl(1)
                            .wrapping_add(GEAR_TABLE[usize::from(*byte)]);
                        if i + 1 >= min && hash & (average as u64 - 1) == 0 {
                            length = i + 1;
                            break;
                        }
                    }
                    length
                }
            };
            ranges.push(start..start + length);
            start += length;
        }
        Ok(ranges)
    }
}

// Versioned deterministic table generator; no randomized per-process hashing.
const fn gear(byte: u8) -> u64 {
    let mut x = (byte as u64).wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

const GEAR_TABLE: [u64; 256] = {
    let mut table = [0; 256];
    let mut byte = 0_u8;
    loop {
        table[byte as usize] = gear(byte);
        if byte == u8::MAX {
            break;
        }
        byte += 1;
    }
    table
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Codec {
    Raw,
    Zstd,
}

/// Hash identifies plaintext. Object identity also includes encoding and version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    pub hash: String,
    pub stored_hash: String,
    pub plain_len: u32,
    pub stored_len: u32,
    pub codec: Codec,
    /// CRC32C and MD5 of the stored bytes (`crc32c=<b64>,md5=<b64>`), the
    /// checksums a store that reports them keeps for the object. Comparing
    /// them proves a stored object intact without downloading it; without
    /// them (older manifests) the object must be read to be proven.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksums: Option<String>,
    /// The period it was stored in ([`crate::fresh::period_of`]), part of
    /// its name (ADR 25, 28): an hour, or a day for one stored before
    /// periods were hours, under the same field and key so that every
    /// release reads both. `None` in the old layout, named by its content
    /// alone, and for a chunk not yet stored.
    /// For a chunk in a pack, the pack's period.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<u32>,
    /// Where it is stored, when it is stored in a pack (ADR 31) rather than
    /// as an object of its own. `checksums` are then the pack's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<Packed>,
}

/// Where in a pack a chunk is stored: the pack, by the BLAKE3 hash of its
/// bytes, the chunk's stored bytes' offset in it, and the pack's length.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Packed {
    pub digest: String,
    pub offset: u64,
    pub len: u64,
}

impl ChunkRef {
    pub fn validate(&self) -> Result<()> {
        if [&self.hash, &self.stored_hash]
            .iter()
            .any(|hash| !is_hex(hash))
            || self.plain_len == 0
            || self.plain_len as usize > MAX_CHUNK
            || self.stored_len == 0
            || self.stored_len as usize > MAX_CHUNK
            || self
                .checksums
                .as_ref()
                .is_some_and(|checksums| checksums.len() > 128 || !checksums.is_ascii())
        {
            return Err(Error::Invalid("chunk reference"));
        }
        if self.codec == Codec::Raw && self.plain_len != self.stored_len {
            return Err(Error::Invalid("raw chunk length"));
        }
        if let Some(pack) = &self.pack
            && (!is_hex(&pack.digest)
                || self.day.is_none()
                || pack.len > MAX_PACK
                || pack
                    .offset
                    .checked_add(u64::from(self.stored_len))
                    .is_none_or(|end| end > pack.len))
        {
            return Err(Error::Invalid("chunk reference's pack"));
        }
        Ok(())
    }

    /// The key of the object that holds it, as a listing gives it: its pack,
    /// or the chunk's own object.
    #[must_use]
    pub fn key(&self) -> String {
        if let (Some(pack), Some(day)) = (&self.pack, self.day) {
            return crate::pack::key(day, &pack.digest);
        }
        let codec = match self.codec {
            Codec::Raw => "raw",
            Codec::Zstd => "zstd",
        };
        // The compressed bytes hash prevents different zstd levels/versions from
        // racing under the same key. See EncodedChunk::object_key.
        match self.day {
            Some(day) => format!("chunks/v2/{day}/{codec}/{}/{}", self.hash, self.stored_hash),
            None => format!("chunks/v1/{codec}/{}/{}", self.hash, self.stored_hash),
        }
    }

    /// What tells this chunk's stored bytes apart from every other's where
    /// they are kept: its key, and for a chunk in a pack its offset there.
    #[must_use]
    pub fn id(&self) -> String {
        match &self.pack {
            Some(pack) => format!("{}@{}", self.key(), pack.offset),
            None => self.key(),
        }
    }

    /// The range of its object its stored bytes take.
    #[must_use]
    pub fn stored_range(&self) -> std::ops::Range<u64> {
        let start = self.pack.as_ref().map_or(0, |pack| pack.offset);
        start..start + u64::from(self.stored_len)
    }

    /// The length of the object that holds it.
    #[must_use]
    pub fn object_len(&self) -> u64 {
        self.pack
            .as_ref()
            .map_or(u64::from(self.stored_len), |pack| pack.len)
    }

    /// The same chunk as stored under period `day`.
    #[must_use]
    pub fn on_day(&self, day: u32) -> Self {
        Self {
            day: Some(day),
            ..self.clone()
        }
    }

    /// Whether `other` names the same bytes, whatever day either was
    /// stored under.
    #[must_use]
    pub fn same_bytes(&self, other: &Self) -> bool {
        self.hash == other.hash
            && self.stored_hash == other.stored_hash
            && self.codec == other.codec
    }
}

/// Whether `hash` is 64 lowercase hex digits.
fn is_hex(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug)]
pub struct EncodedChunk {
    pub reference: ChunkRef,
    pub bytes: Vec<u8>,
}

impl EncodedChunk {
    pub fn encode(plain: &[u8], level: i32) -> Result<Self> {
        if plain.is_empty() || plain.len() > MAX_CHUNK {
            return Err(Error::Invalid("plaintext chunk length"));
        }
        let compressed = zstd::stream::encode_all(plain, level)?;
        let (codec, bytes) = if compressed.len() < plain.len() {
            (Codec::Zstd, compressed)
        } else {
            (Codec::Raw, plain.to_vec())
        };
        Ok(Self {
            reference: ChunkRef {
                hash: blake3::hash(plain).to_hex().to_string(),
                stored_hash: blake3::hash(&bytes).to_hex().to_string(),
                plain_len: u32::try_from(plain.len())
                    .map_err(|_| Error::Invalid("chunk length"))?,
                stored_len: u32::try_from(bytes.len())
                    .map_err(|_| Error::Invalid("stored length"))?,
                codec,
                checksums: Some(crate::upload::checksums(&bytes)),
                day: None,
                pack: None,
            },
            bytes,
        })
    }

    /// The key of the chunk as `reference` names it, which a stored chunk's
    /// reference ([`crate::store::ChunkStore::put_chunk`]) gives with its day.
    #[must_use]
    pub fn object_key(&self) -> String {
        self.reference.key()
    }
}

/// Bounded decode: neither corrupt frames nor malicious metadata can expand
/// beyond the declared plaintext length plus one byte.
pub fn decode(reference: &ChunkRef, bytes: &[u8]) -> Result<Vec<u8>> {
    reference.validate()?;
    if bytes.len() != reference.stored_len as usize
        || blake3::hash(bytes).to_hex().as_str() != reference.stored_hash
    {
        return Err(Error::Integrity);
    }
    let plain = match reference.codec {
        Codec::Raw => bytes.to_vec(),
        Codec::Zstd => {
            let mut decoder = zstd::stream::read::Decoder::new(bytes)?;
            decoder.window_log_max(24)?;
            let mut plain = Vec::with_capacity(reference.plain_len as usize);
            decoder
                .take(u64::from(reference.plain_len) + 1)
                .read_to_end(&mut plain)?;
            plain
        }
    };
    if plain.len() != reference.plain_len as usize
        || blake3::hash(&plain).to_hex().as_str() != reference.hash
    {
        return Err(Error::Integrity);
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_corruption() {
        let chunk = EncodedChunk::encode(&vec![7; 65536], 1).unwrap();
        assert_eq!(
            decode(&chunk.reference, &chunk.bytes).unwrap(),
            vec![7; 65536]
        );
        let mut bad = chunk.reference.clone();
        bad.hash
            .replace_range(..1, if bad.hash.starts_with('0') { "1" } else { "0" });
        assert!(decode(&bad, &chunk.bytes).is_err());
        bad = chunk.reference.clone();
        bad.plain_len = 1;
        assert!(decode(&bad, &chunk.bytes).is_err());
        assert!(decode(&chunk.reference, &chunk.bytes[..2]).is_err());
    }

    #[test]
    fn partitions_exactly_and_bounds_chunks() {
        let input = vec![42; 10000];
        for strategy in [
            Chunking::Fixed { size: 512 },
            Chunking::Gear {
                min: 256,
                average: 512,
                max: 1024,
            },
        ] {
            let ranges = strategy.ranges(&input).unwrap();
            assert_eq!(ranges.first().unwrap().start, 0);
            assert_eq!(ranges.last().unwrap().end, input.len());
            assert!(ranges.windows(2).all(|w| w[0].end == w[1].start));
            assert!(ranges.iter().all(|r| !r.is_empty() && r.len() <= 1024));
            assert_eq!(strategy.ranges(&[]).unwrap(), vec![]);
        }
        assert!(Chunking::Fixed { size: 0 }.ranges(&input).is_err());
    }
}
