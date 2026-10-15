//! Provider-neutral, immutable content publication over the native object APIs.
//!
//! GCS, Azure and S3 use the upstream `object_store` builders and their normal
//! credential chains. No account identifiers or credentials are stored here.
//! Scope each store prefix to an authorized tenant/deduplication domain.
use std::sync::Arc;

use bytes::Bytes;
use object_store::{ObjectStore, PutMode, PutOptions, path::Path};

use crate::{
    Error, Result,
    chunk::{ChunkRef, EncodedChunk, decode},
    manifest::{DiskManifest, MAX_MANIFEST_BYTES},
};

/// Use provider-native environment or machine-identity credentials.
pub fn provider_from_env(kind: &str) -> Result<Arc<dyn ObjectStore>> {
    match kind {
        "gcs" => Ok(Arc::new(
            object_store::gcp::GoogleCloudStorageBuilder::from_env().build()?,
        )),
        "azure" => Ok(Arc::new(
            object_store::azure::MicrosoftAzureBuilder::from_env().build()?,
        )),
        "s3" => Ok(Arc::new(
            object_store::aws::AmazonS3Builder::from_env().build()?,
        )),
        _ => Err(Error::Invalid("unknown object provider")),
    }
}

#[derive(Clone, Debug)]
pub struct ChunkStore {
    backend: Arc<dyn ObjectStore>,
    prefix: Path,
}

impl ChunkStore {
    #[must_use]
    pub fn new(backend: Arc<dyn ObjectStore>, prefix: Path) -> Self {
        Self { backend, prefix }
    }

    fn path(&self, key: &str) -> Path {
        self.prefix.child(key)
    }

    /// Returns true only when this call created the object; never overwrites it.
    pub async fn put_chunk(&self, chunk: &EncodedChunk) -> Result<bool> {
        // Public structs may have been modified since encoding.
        decode(&chunk.reference, &chunk.bytes)?;
        self.put_immutable(&chunk.object_key(), Bytes::copy_from_slice(&chunk.bytes))
            .await
    }

    async fn put_immutable(&self, key: &str, bytes: Bytes) -> Result<bool> {
        let path = self.path(key);
        match self
            .backend
            .put_opts(
                &path,
                bytes.clone().into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) => Ok(true),
            Err(object_store::Error::AlreadyExists { .. }) => {
                // Verify existing data rather than blindly trusting a collision,
                // interrupted prior write or misconfigured shared namespace.
                let result = self.backend.get(&path).await?;
                if result.meta.size != bytes.len() as u64 {
                    return Err(Error::Integrity);
                }
                let old = result.bytes().await?;
                if old != bytes {
                    return Err(Error::Integrity);
                }
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn get_chunk(&self, reference: &ChunkRef) -> Result<Vec<u8>> {
        reference.validate()?;
        let result = self.backend.get(&self.path(&reference.key())).await?;
        if result.meta.size != u64::from(reference.stored_len) {
            return Err(Error::Integrity);
        }
        let bytes = result.bytes().await?;
        decode(reference, &bytes)
    }

    /// Publish only after every referenced chunk has completed uploading.
    /// This does NOT commit a control-plane checkpoint or permit local deletion.
    pub async fn put_manifest(&self, manifest: &DiskManifest) -> Result<String> {
        let bytes = manifest.encode()?;
        let digest = blake3::hash(&bytes).to_hex().to_string();
        self.put_immutable(&format!("manifests/v1/{digest}.json"), Bytes::from(bytes))
            .await?;
        Ok(digest)
    }

    pub async fn get_manifest(&self, digest: &str) -> Result<DiskManifest> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("manifest digest"));
        }
        let result = self
            .backend
            .get(&self.path(&format!("manifests/v1/{digest}.json")))
            .await?;
        if result.meta.size > MAX_MANIFEST_BYTES as u64 {
            return Err(Error::Invalid("manifest too large"));
        }
        let bytes = result.bytes().await?;
        if blake3::hash(&bytes).to_hex().as_str() != digest {
            return Err(Error::Integrity);
        }
        DiskManifest::decode(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::memory::InMemory;

    #[tokio::test]
    async fn deduplicates_and_verifies() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let chunk = EncodedChunk::encode(&vec![9; 4096], 1).unwrap();
        assert!(store.put_chunk(&chunk).await.unwrap());
        assert!(!store.put_chunk(&chunk).await.unwrap());
        assert_eq!(
            store.get_chunk(&chunk.reference).await.unwrap(),
            vec![9; 4096]
        );
        backend
            .put(
                &store.path(&chunk.object_key()),
                Bytes::from_static(b"bad").into(),
            )
            .await
            .unwrap();
        assert!(store.get_chunk(&chunk.reference).await.is_err());
        assert!(store.put_chunk(&chunk).await.is_err());
    }

    #[tokio::test]
    async fn manifest_round_trip_rejects_corruption_and_invalid_digest() {
        use crate::manifest::{Extent, ExtentSource};
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let manifest = DiskManifest {
            version: 1,
            disk_len: 4096,
            base_len: 0,
            base_digest: "0".repeat(64),
            extents: vec![Extent {
                offset: 0,
                length: 4096,
                source: ExtentSource::Zero,
            }],
        };
        let digest = store.put_manifest(&manifest).await.unwrap();
        assert_eq!(store.get_manifest(&digest).await.unwrap(), manifest);
        assert_eq!(store.put_manifest(&manifest).await.unwrap(), digest);
        assert!(store.get_manifest("../unexpected").await.is_err());
        backend
            .put(
                &store.path(&format!("manifests/v1/{digest}.json")),
                Bytes::from_static(b"{}").into(),
            )
            .await
            .unwrap();
        assert!(matches!(
            store.get_manifest(&digest).await,
            Err(Error::Integrity)
        ));
    }
}
