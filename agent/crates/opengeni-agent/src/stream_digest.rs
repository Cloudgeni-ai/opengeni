//! A blake3 stream digest whose state can be carried into a successor process.
//!
//! `blake3::Hasher` keeps its tree state private, so a running command's
//! output digest could not survive an in-place agent update. This hasher keeps
//! the same tree explicitly: a stack of completed-subtree chaining values plus
//! the bytes of the current (at most one) chunk. Its result is identical to
//! `blake3::hash` over the full stream, and [`DigestState`] round-trips it.

use blake3::hazmat::{
    merge_subtrees_non_root, merge_subtrees_root, ChainingValue, HasherExt as _, Mode,
};
use serde::{Deserialize, Serialize};

const CHUNK_LEN: usize = 1024;

/// Incremental blake3 over one output stream.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamDigest {
    /// Chaining values of completed subtrees, left to right.
    stack: Vec<ChainingValue>,
    /// Completed (non-final) chunks hashed so far.
    chunks: u64,
    /// The current chunk. A full chunk stays here until more input proves it
    /// is not the last one, exactly like `blake3::Hasher`.
    chunk: Vec<u8>,
}

/// Serializable form of a [`StreamDigest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DigestState {
    stack: Vec<String>,
    chunks: u64,
    chunk: String,
}

impl StreamDigest {
    /// Feeds more of the stream.
    pub fn update(&mut self, mut input: &[u8]) {
        while !input.is_empty() {
            if self.chunk.len() == CHUNK_LEN {
                let cv = chunk_cv(self.chunks, &self.chunk);
                self.chunk.clear();
                self.push_chunk_cv(cv);
            }
            let take = (CHUNK_LEN - self.chunk.len()).min(input.len());
            self.chunk.extend_from_slice(&input[..take]);
            input = &input[take..];
        }
    }

    /// The blake3 hash of everything fed so far.
    #[must_use]
    pub fn finalize(&self) -> blake3::Hash {
        let Some((first, rest)) = self.stack.split_first() else {
            return blake3::hash(&self.chunk);
        };
        let mut right = chunk_cv(self.chunks, &self.chunk);
        for left in rest.iter().rev() {
            right = merge_subtrees_non_root(left, &right, Mode::Hash);
        }
        merge_subtrees_root(first, &right, Mode::Hash)
    }

    /// The state to hand to a successor.
    #[must_use]
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn state(&self) -> DigestState {
        DigestState {
            stack: self.stack.iter().map(hex::encode).collect(),
            chunks: self.chunks,
            chunk: hex::encode(&self.chunk),
        }
    }

    /// Restores a predecessor's state, rejecting anything this hasher could
    /// not itself have produced.
    ///
    /// # Errors
    ///
    /// A malformed or inconsistent state.
    pub fn from_state(state: &DigestState) -> Result<Self, String> {
        let stack = state
            .stack
            .iter()
            .map(|cv| {
                hex::decode(cv)
                    .ok()
                    .and_then(|bytes| ChainingValue::try_from(bytes).ok())
                    .ok_or_else(|| "invalid chaining value".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let chunk = hex::decode(&state.chunk).map_err(|error| error.to_string())?;
        // Eager merging leaves one subtree per set bit of the chunk count, and
        // a completed chunk is only recorded once input follows it.
        let consistent = stack.len() == state.chunks.count_ones() as usize
            && chunk.len() <= CHUNK_LEN
            && (state.chunks == 0 || !chunk.is_empty());
        if !consistent {
            return Err("inconsistent digest state".to_owned());
        }
        Ok(Self {
            stack,
            chunks: state.chunks,
            chunk,
        })
    }

    fn push_chunk_cv(&mut self, mut cv: ChainingValue) {
        self.chunks += 1;
        // More input follows this chunk, so every merged parent is non-root.
        let mut total = self.chunks;
        while total & 1 == 0 {
            let left = self.stack.pop().expect("a subtree per set bit");
            cv = merge_subtrees_non_root(&left, &cv, Mode::Hash);
            total >>= 1;
        }
        self.stack.push(cv);
    }
}

fn chunk_cv(index: u64, chunk: &[u8]) -> ChainingValue {
    let mut hasher = blake3::Hasher::new();
    hasher.set_input_offset(index * CHUNK_LEN as u64);
    hasher.update(chunk);
    hasher.finalize_non_root()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| u8::try_from((i * 31 + i / 7) % 251).unwrap())
            .collect()
    }

    #[test]
    fn matches_blake3_for_every_tree_shape() {
        let lengths = [
            0, 1, 1023, 1024, 1025, 2047, 2048, 2049, 3072, 3073, 4096, 5000, 8193, 65_543, 200_000,
        ];
        for len in lengths {
            let input = stream(len);
            for step in [1, 7, 1024, 1500, 4096, usize::MAX] {
                let mut digest = StreamDigest::default();
                for piece in input.chunks(step.min(len.max(1))) {
                    digest.update(piece);
                }
                assert_eq!(
                    digest.finalize(),
                    blake3::hash(&input),
                    "len {len} step {step}"
                );
            }
        }
    }

    #[test]
    fn a_restored_state_continues_the_same_stream() {
        for len in [0, 5, 1024, 1025, 4097, 70_001] {
            let input = stream(len);
            for cut in [0, len / 3, len / 2, len.saturating_sub(1), len] {
                let mut before = StreamDigest::default();
                before.update(&input[..cut]);
                let carried = serde_json::to_string(&before.state()).unwrap();
                let mut after =
                    StreamDigest::from_state(&serde_json::from_str(&carried).unwrap()).unwrap();
                after.update(&input[cut..]);
                assert_eq!(
                    after.finalize(),
                    blake3::hash(&input),
                    "len {len} cut {cut}"
                );
            }
        }
    }

    #[test]
    fn inconsistent_states_are_refused() {
        let mut digest = StreamDigest::default();
        digest.update(&stream(5000));
        let mut state = digest.state();
        state.chunks += 1;
        assert!(StreamDigest::from_state(&state).is_err());
        let mut state = digest.state();
        state.chunk = hex::encode(stream(1025));
        assert!(StreamDigest::from_state(&state).is_err());
    }
}
