//! Provider-neutral, immutable content publication over the native object APIs.
//!
//! GCS, Azure and S3 use the upstream `object_store` builders and their normal
//! credential chains. No account identifiers or credentials are stored here.
//! Scope each store prefix to an authorized tenant/deduplication domain.
//!
//! Chunks are named by their content and shared by every sandbox holding the
//! same bytes, so a bad chunk would poison all of them. Uploads are verified
//! (see [`crate::upload`]), every read checks the content hash, and a stored
//! object found to be bad is moved to `quarantine/v1/` rather than deleted,
//! so the next upload of the same content repairs it.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use object_store::{ClientOptions, ObjectStore, PutMode, PutOptions, path::Path};

use crate::{
    Error, Result,
    chunk::{ChunkRef, EncodedChunk, decode},
    manifest::{DiskManifest, MAX_MANIFEST_BYTES},
    upload::{Created, Gcs},
};

/// Largest pointer object accepted; pointers only name manifests.
pub const MAX_POINTER_BYTES: usize = 64 * 1024;

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

/// How an upload is known to have arrived intact.
#[derive(Clone, Debug)]
enum Uploader {
    /// The store checked a checksum sent with the bytes.
    StoreVerified,
    /// GCS, through its XML API with `x-goog-hash`.
    Gcs(Gcs),
    /// Nothing checks in transit: read the object back after storing it.
    ReadBack,
}

#[derive(Clone, Debug)]
pub struct ChunkStore {
    backend: Arc<dyn ObjectStore>,
    prefix: Path,
    uploader: Uploader,
}

impl ChunkStore {
    /// A store over any backend. Uploads are read back to verify them; use
    /// [`Self::from_url`] for stores that verify checksums themselves.
    #[must_use]
    pub fn new(backend: Arc<dyn ObjectStore>, prefix: Path) -> Self {
        Self {
            backend,
            prefix,
            uploader: Uploader::ReadBack,
        }
    }

    /// Opens `gs://bucket/prefix`, `s3://bucket/prefix` or
    /// `az://container/prefix` with the provider's usual credential chain;
    /// `None` when `url` is not a store URL.
    pub fn from_url(url: &str) -> Result<Option<Self>> {
        use object_store::aws::{AmazonS3Builder, Checksum};
        use object_store::azure::MicrosoftAzureBuilder;
        use object_store::client::{HttpConnector as _, ReqwestConnector};
        use object_store::gcp::GoogleCloudStorageBuilder;

        let Some((scheme, rest)) = url.split_once("://") else {
            return Ok(None);
        };
        let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
        let prefix = Path::from(prefix.trim_end_matches('/'));
        let (backend, uploader): (Arc<dyn ObjectStore>, _) = match scheme {
            "gs" => {
                let store = GoogleCloudStorageBuilder::from_env()
                    .with_bucket_name(bucket)
                    .build()?;
                let client = ReqwestConnector::default().connect(&ClientOptions::new())?;
                let gcs = Gcs::new(
                    client,
                    store.credentials().clone(),
                    "https://storage.googleapis.com",
                    bucket,
                );
                (Arc::new(store), Uploader::Gcs(gcs))
            }
            "s3" => (
                Arc::new(
                    AmazonS3Builder::from_env()
                        .with_bucket_name(bucket)
                        .with_checksum_algorithm(Checksum::SHA256)
                        .build()?,
                ),
                Uploader::StoreVerified,
            ),
            "az" => (
                Arc::new(
                    MicrosoftAzureBuilder::from_env()
                        .with_container_name(bucket)
                        .build()?,
                ),
                Uploader::ReadBack,
            ),
            _ => return Err(Error::Invalid("unknown store; use gs://, az:// or s3://")),
        };
        Ok(Some(Self {
            backend,
            prefix,
            uploader,
        }))
    }

    fn path(&self, key: &str) -> Path {
        // One path part per segment: a single `child` would escape the
        // slashes, so `chunks/v1/...` would become one opaque name that
        // prefix listings (and garbage collection) cannot walk.
        key.split('/')
            .fold(self.prefix.clone(), |path, part| path.child(part))
    }

    fn pointer_path(&self, name: &str) -> Result<Path> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::Invalid("pointer name"));
        }
        Ok(self.path(&format!("pointers/v1/{name}")))
    }

    /// Replaces the small mutable object `name`, such as the record of which
    /// manifests make up a sandbox's current copy. Chunks and manifests are
    /// immutable; pointers are the only objects ever overwritten, so write one
    /// only after everything it names is stored.
    pub async fn put_pointer(&self, name: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(Error::Invalid("pointer too large"));
        }
        self.backend
            .put(&self.pointer_path(name)?, Bytes::from(bytes).into())
            .await?;
        Ok(())
    }

    /// Reads pointer `name`, or `None` when there is none.
    pub async fn get_pointer(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match self.backend.get(&self.pointer_path(name)?).await {
            Ok(result) => {
                if result.meta.size > MAX_POINTER_BYTES as u64 {
                    return Err(Error::Invalid("pointer too large"));
                }
                Ok(Some(result.bytes().await?.to_vec()))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Deletes pointer `name`; succeeds when there is none. What it named
    /// stays until garbage collection finds nothing refers to it.
    pub async fn delete_pointer(&self, name: &str) -> Result<()> {
        match self.backend.delete(&self.pointer_path(name)?).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => Err(error.into()),
        }
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
        // An object already stored under this name may be the remains of a
        // bad write or a corrupted copy. Verify it; if it is bad, move it to
        // quarantine and store ours once more.
        for _ in 0..2 {
            if self.create(&path, &bytes).await? == Created::New {
                return Ok(true);
            }
            if self.holds(&path, &bytes).await? {
                return Ok(false);
            }
            self.quarantine(&path).await?;
        }
        Err(Error::Integrity)
    }

    /// Creates the object unless one exists. `New` means our bytes are
    /// stored and verified.
    async fn create(&self, path: &Path, bytes: &Bytes) -> Result<Created> {
        if let Uploader::Gcs(gcs) = &self.uploader {
            return gcs.create(path, bytes).await;
        }
        let options = PutOptions {
            mode: PutMode::Create,
            ..Default::default()
        };
        match self
            .backend
            .put_opts(path, bytes.clone().into(), options)
            .await
        {
            Ok(_) => {}
            Err(object_store::Error::AlreadyExists { .. }) => return Ok(Created::Exists),
            Err(error) => return Err(error.into()),
        }
        if matches!(self.uploader, Uploader::ReadBack) && !self.holds(path, bytes).await? {
            // Report it as found rather than created: the caller then
            // quarantines the bad copy and tries again.
            return Ok(Created::Exists);
        }
        Ok(Created::New)
    }

    /// Whether the object at `path` holds exactly `bytes`.
    async fn holds(&self, path: &Path, bytes: &Bytes) -> Result<bool> {
        if let Uploader::Gcs(gcs) = &self.uploader {
            // GCS kept the checksums it verified at upload: no download.
            return Ok(gcs.stored(path).await? == Some(crate::upload::checksums(bytes)));
        }
        let result = match self.backend.get(path).await {
            Ok(result) => result,
            Err(object_store::Error::NotFound { .. }) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if result.meta.size != bytes.len() as u64 {
            return Ok(false);
        }
        Ok(result.bytes().await? == *bytes)
    }

    /// Moves the object at `path` under `quarantine/v1/`, keeping it for
    /// inspection; never deletes it outright.
    async fn quarantine(&self, path: &Path) -> Result<()> {
        // Unique per move, so quarantining the same name twice keeps both.
        static MOVES: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let moves = MOVES.fetch_add(1, Ordering::Relaxed);
        let relative = path
            .prefix_match(&self.prefix)
            .map(|parts| {
                parts
                    .map(|part| part.as_ref().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
            .join("/");
        let target = self.path(&format!("quarantine/v1/{relative}.{nanos}-{moves}"));
        match self.backend.copy(path, &target).await {
            Ok(()) => {}
            Err(object_store::Error::NotFound { .. }) => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        match self.backend.delete(path).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Reads and decodes a chunk, checking its length and content hash. A
    /// read that fails the checks is tried once more, since the damage may
    /// have happened in transit; a chunk that is bad twice is quarantined so
    /// a later upload of the same content can repair it.
    pub async fn get_chunk(&self, reference: &ChunkRef) -> Result<Vec<u8>> {
        reference.validate()?;
        let path = self.path(&reference.key());
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.read_chunk(&path, reference).await {
                Err(Error::Integrity | Error::Truncated { .. }) if attempt == 1 => {}
                Err(error @ (Error::Integrity | Error::Truncated { .. })) => {
                    self.quarantine(&path).await?;
                    return Err(error);
                }
                result => return result,
            }
        }
    }

    async fn read_chunk(&self, path: &Path, reference: &ChunkRef) -> Result<Vec<u8>> {
        let expected = u64::from(reference.stored_len);
        let result = self.backend.get(path).await?;
        if result.meta.size != expected {
            return Err(Error::Truncated {
                expected,
                actual: result.meta.size,
            });
        }
        let bytes = result.bytes().await?;
        if bytes.len() as u64 != expected {
            return Err(Error::Truncated {
                expected,
                actual: bytes.len() as u64,
            });
        }
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
    async fn pointers_are_replaced_read_and_deleted() {
        let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("tenant/test"));
        assert_eq!(store.get_pointer("a1").await.unwrap(), None);
        store.put_pointer("a1", b"one".to_vec()).await.unwrap();
        store.put_pointer("a1", b"two".to_vec()).await.unwrap();
        assert_eq!(
            store.get_pointer("a1").await.unwrap(),
            Some(b"two".to_vec())
        );
        store.delete_pointer("a1").await.unwrap();
        store.delete_pointer("a1").await.unwrap();
        assert_eq!(store.get_pointer("a1").await.unwrap(), None);
        assert!(store.put_pointer("../escape", Vec::new()).await.is_err());
        assert!(
            store
                .put_pointer("big", vec![0; MAX_POINTER_BYTES + 1])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn keys_nest_under_the_prefix_so_they_can_be_listed() {
        use futures::TryStreamExt as _;

        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let chunk = EncodedChunk::encode(&[5; 4096], 1).unwrap();
        store.put_chunk(&chunk).await.unwrap();
        let listed: Vec<_> = backend
            .list(Some(&Path::from("tenant/test/chunks/v1")))
            .try_collect()
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].location.as_ref(),
            format!("tenant/test/{}", chunk.object_key())
        );
    }

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
    }

    async fn quarantined(backend: &InMemory) -> Vec<Bytes> {
        use futures::TryStreamExt as _;
        let listed: Vec<_> = backend
            .list(Some(&Path::from("tenant/test/quarantine/v1")))
            .try_collect()
            .await
            .unwrap();
        let mut found = Vec::new();
        for meta in listed {
            found.push(
                backend
                    .get(&meta.location)
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap(),
            );
        }
        found
    }

    #[tokio::test]
    async fn truncated_and_corrupt_chunks_are_rejected_quarantined_and_repaired() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let chunk = EncodedChunk::encode(&vec![7; 65536], 1).unwrap();
        let path = store.path(&chunk.object_key());
        let good = Bytes::from(chunk.bytes.clone());
        let truncated = good.slice(..good.len() - 1);
        let mut flipped = chunk.bytes.clone();
        flipped[3] ^= 0x40;
        let flipped = Bytes::from(flipped);

        for (bad, truncation) in [(truncated, true), (flipped, false)] {
            backend.put(&path, bad.clone().into()).await.unwrap();
            let error = store.get_chunk(&chunk.reference).await.unwrap_err();
            assert_eq!(
                matches!(error, Error::Truncated { .. }),
                truncation,
                "{error}"
            );
            assert!(matches!(error, Error::Truncated { .. } | Error::Integrity));
            // Moved aside, not deleted.
            assert!(quarantined(&backend).await.contains(&bad));
            assert!(matches!(
                backend.head(&path).await,
                Err(object_store::Error::NotFound { .. })
            ));
            // The next upload of the same content repairs the shared chunk.
            assert!(store.put_chunk(&chunk).await.unwrap());
            assert_eq!(
                store.get_chunk(&chunk.reference).await.unwrap(),
                vec![7; 65536]
            );
        }
    }

    #[tokio::test]
    async fn an_upload_finding_a_bad_object_replaces_it() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let chunk = EncodedChunk::encode(&[3; 4096], 1).unwrap();
        let path = store.path(&chunk.object_key());
        backend
            .put(&path, Bytes::from_static(b"bad").into())
            .await
            .unwrap();
        assert!(store.put_chunk(&chunk).await.unwrap());
        assert_eq!(
            store.get_chunk(&chunk.reference).await.unwrap(),
            vec![3; 4096]
        );
        assert_eq!(
            quarantined(&backend).await,
            vec![Bytes::from_static(b"bad")]
        );
    }

    #[test]
    fn store_urls_pick_the_verifying_uploader() {
        assert!(ChunkStore::from_url("/local/path").unwrap().is_none());
        assert!(ChunkStore::from_url("ftp://x/y").is_err());
        let s3 = ChunkStore::from_url("s3://bucket/a/b").unwrap().unwrap();
        assert!(matches!(s3.uploader, Uploader::StoreVerified));
        assert_eq!(s3.prefix.as_ref(), "a/b");
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
