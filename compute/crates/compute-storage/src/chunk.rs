//! Deterministic fixed and bounded Gear content-defined chunking.
use std::{io::Read, ops::Range};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Upper bound on decoded chunks, including untrusted manifests.
pub const MAX_CHUNK: usize = 16 * 1024 * 1024;

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
}

impl ChunkRef {
    pub fn validate(&self) -> Result<()> {
        if [&self.hash, &self.stored_hash].iter().any(|hash| {
            hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) || self.plain_len == 0
            || self.plain_len as usize > MAX_CHUNK
            || self.stored_len == 0
            || self.stored_len as usize > MAX_CHUNK
        {
            return Err(Error::Invalid("chunk reference"));
        }
        if self.codec == Codec::Raw && self.plain_len != self.stored_len {
            return Err(Error::Invalid("raw chunk length"));
        }
        Ok(())
    }

    #[must_use]
    pub fn key(&self) -> String {
        let codec = match self.codec {
            Codec::Raw => "raw",
            Codec::Zstd => "zstd",
        };
        // The compressed bytes hash prevents different zstd levels/versions from
        // racing under the same key. See EncodedChunk::object_key.
        format!("chunks/v1/{codec}/{}/{}", self.hash, self.stored_hash)
    }
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
            },
            bytes,
        })
    }

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
