//! Complete, explicit disk maps; zero is never confused with an absent layer.
use serde::{Deserialize, Serialize};

use crate::{Error, Result, chunk::ChunkRef};

/// The largest manifest read or written. A guard against a corrupt or
/// runaway one, sized to hold a dense 64 GiB file: about 350 bytes per
/// 256 KiB chunk, so 92 MB. Real manifests are far smaller, since zero and
/// base ranges merge into one extent each.
pub const MAX_MANIFEST_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtentSource {
    Zero,
    /// Immutable base content must be verified against `base_digest`.
    Base {
        offset: u64,
    },
    Chunk {
        reference: ChunkRef,
        offset: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extent {
    pub offset: u64,
    pub length: u64,
    pub source: ExtentSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskManifest {
    pub version: u32,
    pub disk_len: u64,
    pub base_len: u64,
    pub base_digest: String,
    pub extents: Vec<Extent>,
}

impl DiskManifest {
    /// Reject unsupported versions, gaps, overlaps, overflow and bad references.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || self.disk_len == 0 || self.extents.is_empty() {
            return Err(Error::Invalid("manifest version or empty disk"));
        }
        if self.base_digest.len() != 64
            || !self
                .base_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("base digest"));
        }
        let mut cursor = 0_u64;
        for extent in &self.extents {
            if extent.offset != cursor || extent.length == 0 {
                return Err(Error::Invalid("manifest gap, overlap or empty extent"));
            }
            cursor = cursor
                .checked_add(extent.length)
                .ok_or(Error::Invalid("extent overflow"))?;
            match &extent.source {
                ExtentSource::Zero => {}
                ExtentSource::Base { offset } => {
                    if offset
                        .checked_add(extent.length)
                        .is_none_or(|end| end > self.base_len)
                    {
                        return Err(Error::Invalid("extent past base"));
                    }
                }
                ExtentSource::Chunk { reference, offset } => {
                    reference.validate()?;
                    if u64::from(*offset)
                        .checked_add(extent.length)
                        .is_none_or(|end| end > u64::from(reference.plain_len))
                    {
                        return Err(Error::Invalid("extent past chunk"));
                    }
                }
            }
        }
        if cursor != self.disk_len {
            return Err(Error::Invalid("incomplete disk map"));
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Invalid("manifest too large"));
        }
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Invalid("manifest too large"));
        }
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> DiskManifest {
        DiskManifest {
            version: 1,
            disk_len: 8192,
            base_len: 8192,
            base_digest: "a".repeat(64),
            extents: vec![
                Extent {
                    offset: 0,
                    length: 4096,
                    source: ExtentSource::Base { offset: 0 },
                },
                Extent {
                    offset: 4096,
                    length: 4096,
                    source: ExtentSource::Zero,
                },
            ],
        }
    }

    #[test]
    fn explicit_zero_and_exact_coverage() {
        let valid = fixture();
        assert_eq!(
            DiskManifest::decode(&valid.encode().unwrap()).unwrap(),
            valid
        );
        let mut bad = fixture();
        bad.extents[1].offset = 0;
        assert!(bad.validate().is_err());
        let mut bad = fixture();
        bad.extents.pop();
        assert!(bad.validate().is_err());
        let mut bad = fixture();
        bad.extents[1].length = u64::MAX;
        assert!(bad.validate().is_err());
        let mut bad = fixture();
        bad.version = 2;
        assert!(bad.validate().is_err());
        let mut bad = fixture();
        bad.base_len = 1;
        assert!(bad.validate().is_err());
    }
}
