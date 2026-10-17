//! Provider-neutral, immutable content publication over the native object APIs.
//!
//! GCS, Azure and S3 use the upstream `object_store` builders and their normal
//! credential chains. No account identifiers or credentials are stored here.
//! Scope each store prefix to an authorized tenant/deduplication domain.
//!
//! Chunks are named by their content and shared by every sandbox holding the
//! same bytes, so a bad chunk would poison all of them. Uploads are verified
//! (see [`crate::upload`]), and every read checks the content hash.
//!
//! A stored object found to be bad is copied to `quarantine/v1/` for
//! inspection and left where it is: nothing here ever deletes a chunk or a
//! manifest. The next upload of the same content writes the right bytes over
//! it. Names include the hash of the stored bytes, so every writer of a name
//! writes exactly the same bytes: two repairs racing write the same object,
//! and no operation can undo another's repair.
//!
//! Only a sweep (see [`crate::sweep`]) deletes chunks and manifests, once
//! no pointer names them; the rules in [`crate::fresh`] keep it from
//! deleting what an archive in flight is about to name.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures::TryStreamExt as _;
use object_store::{ClientOptions, ObjectStore, PutMode, PutOptions, path::Path};

use crate::{
    Error, Result,
    chunk::{ChunkRef, EncodedChunk, decode},
    fresh::{Clock, Freshness},
    manifest::{DiskManifest, MAX_MANIFEST_BYTES},
    upload::{Created, Deleted, Gcs},
};

/// Largest pointer object accepted; pointers only name manifests.
pub const MAX_POINTER_BYTES: usize = 64 * 1024;

mod pointers;

pub use pointers::{Begun, Publication, Stock};
#[cfg(test)]
pub(crate) use pointers::{TEST_EPOCH, next_save, unstamped};

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
    freshness: Freshness,
    clock: Clock,
}

/// The kinds of stored object, each under its own prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    /// The only objects ever replaced: each names a copy's manifests.
    Pointers,
    Manifests,
    Chunks,
}

impl Area {
    fn prefix(self) -> &'static str {
        match self {
            Self::Pointers => pointers::POINTERS,
            Self::Manifests => "manifests/v1",
            Self::Chunks => "chunks/v1",
        }
    }
}

/// One stored object, as a listing shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    /// Its key under the store's prefix, as [`ChunkRef::key`] gives it.
    pub key: String,
    pub stored_at: SystemTime,
    pub size: u64,
}

/// What a delete on condition did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    Deleted,
    /// It was stored again recently, so it stays.
    Kept,
    /// Nothing was stored under the key any more.
    Gone,
}

/// What is stored under a content name.
enum Found {
    /// Exactly the bytes the name allows, stored at the time given if the
    /// store says.
    Ours(Option<SystemTime>),
    /// Nothing, or other bytes.
    Other,
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
            freshness: Freshness::DEFAULT,
            clock: Clock::system(),
        }
    }

    /// The same store under other time rules; host agents and sweeps of
    /// one store must agree on them.
    #[must_use]
    pub fn with_freshness(self, freshness: Freshness) -> Self {
        Self { freshness, ..self }
    }

    /// The same store reading the time from `clock`.
    #[must_use]
    pub fn with_clock(self, clock: Clock) -> Self {
        Self { clock, ..self }
    }

    #[must_use]
    pub fn freshness(&self) -> Freshness {
        self.freshness
    }

    #[must_use]
    pub fn now(&self) -> SystemTime {
        self.clock.now()
    }

    /// A store over `fake`'s bucket, under `prefix`, on `fake`'s clock.
    #[cfg(test)]
    pub(crate) fn over_fake(fake: &Arc<crate::fake::Fake>, prefix: &str) -> Self {
        Self {
            backend: Arc::new(crate::fake::Bucket(fake.clone())),
            prefix: Path::from(prefix),
            uploader: Uploader::Gcs(crate::fake::gcs(fake)),
            freshness: Freshness::DEFAULT,
            clock: fake.clock.clone(),
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
            freshness: Freshness::DEFAULT,
            clock: Clock::system(),
        }))
    }

    fn path(&self, key: &str) -> Path {
        // One path part per segment: a single `child` would escape the
        // slashes, so `chunks/v1/...` would become one opaque name that
        // prefix listings (and garbage collection) cannot walk.
        key.split('/')
            .fold(self.prefix.clone(), |path, part| path.child(part))
    }

    /// Whether this store deletes on condition (GCS), which a sweep that
    /// deletes needs.
    #[must_use]
    pub fn deletes_on_condition(&self) -> bool {
        matches!(self.uploader, Uploader::Gcs(_))
    }

    /// Returns true only when this call created the object; never overwrites it.
    pub async fn put_chunk(&self, chunk: &EncodedChunk) -> Result<bool> {
        // Public structs may have been modified since encoding.
        decode(&chunk.reference, &chunk.bytes)?;
        if chunk
            .reference
            .checksums
            .as_ref()
            .is_some_and(|checksums| *checksums != crate::upload::checksums(&chunk.bytes))
        {
            return Err(Error::Integrity);
        }
        self.put_immutable(&chunk.object_key(), Bytes::copy_from_slice(&chunk.bytes))
            .await
    }

    async fn put_immutable(&self, key: &str, bytes: Bytes) -> Result<bool> {
        let path = self.path(key);
        if self.create(&path, &bytes).await? == Created::New {
            return Ok(true);
        }
        if let Found::Ours(stored_at) = self.found(&path, &bytes).await? {
            // Reused as it is, unless it was stored too long ago for a
            // sweep to see the pointer this archive will publish: then it
            // is stored again (see `crate::fresh`).
            let now = self.clock.now();
            if stored_at.is_some_and(|at| !self.freshness.is_stale(at, now)) {
                return Ok(false);
            }
            self.replace(&path, &bytes).await?;
            return if self.holds(&path, &bytes).await? {
                Ok(false)
            } else {
                Err(Error::Integrity)
            };
        }
        // Something else is stored under our name: the remains of a bad
        // write or a damaged copy. Keep it for inspection and write ours
        // over it; the name allows no other bytes, so this cannot replace
        // a good object.
        self.quarantine(&path).await?;
        self.replace(&path, &bytes).await?;
        if self.holds(&path, &bytes).await? {
            Ok(true)
        } else {
            Err(Error::Integrity)
        }
    }

    /// Writes `bytes` at `path` whatever is stored there, verified in
    /// transit as [`Self::create`] is. Only for repairing an object whose
    /// name allows no other bytes.
    async fn replace(&self, path: &Path, bytes: &Bytes) -> Result<()> {
        if let Uploader::Gcs(gcs) = &self.uploader {
            return gcs.replace(path, bytes).await;
        }
        let options = PutOptions {
            mode: PutMode::Overwrite,
            ..Default::default()
        };
        self.backend
            .put_opts(path, bytes.clone().into(), options)
            .await?;
        Ok(())
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
        Ok(matches!(self.found(path, bytes).await?, Found::Ours(_)))
    }

    async fn found(&self, path: &Path, bytes: &Bytes) -> Result<Found> {
        if let Uploader::Gcs(gcs) = &self.uploader {
            // GCS kept the checksums it verified at upload: no download.
            return Ok(match gcs.stored(path).await? {
                Some(stored) if stored.checksums == crate::upload::checksums(bytes) => {
                    Found::Ours(stored.at)
                }
                _ => Found::Other,
            });
        }
        let result = match self.backend.get(path).await {
            Ok(result) => result,
            Err(object_store::Error::NotFound { .. }) => return Ok(Found::Other),
            Err(error) => return Err(error.into()),
        };
        if result.meta.size != bytes.len() as u64 {
            return Ok(Found::Other);
        }
        let stored_at = SystemTime::from(result.meta.last_modified);
        Ok(if result.bytes().await? == *bytes {
            Found::Ours(Some(stored_at))
        } else {
            Found::Other
        })
    }

    /// Copies the object at `path` under `quarantine/v1/` for inspection.
    /// The object itself stays: only a write of the bytes its name allows
    /// replaces it, so a copy repaired meanwhile is never lost.
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
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Whether the chunk `reference` names is stored with exactly the bytes
    /// it names. A local copy may be deleted on this answer, so a stored
    /// length is not enough: same-length damage must be found too.
    ///
    /// GCS keeps the CRC32C and MD5 it computed when the object was stored;
    /// matching them against the checksums recorded in `reference` proves
    /// the bytes without downloading them, and any write that changed the
    /// bytes changed them. Other stores, and references recorded without
    /// checksums, are read and hashed in full.
    pub async fn has_chunk(&self, reference: &ChunkRef) -> Result<bool> {
        reference.validate()?;
        let path = self.path(&reference.key());
        if let (Uploader::Gcs(gcs), Some(expected)) = (&self.uploader, &reference.checksums) {
            return Ok(gcs
                .stored(&path)
                .await?
                .is_some_and(|stored| stored.checksums == *expected));
        }
        match self.read_chunk(&path, reference).await {
            Ok(_) => Ok(true),
            Err(
                Error::Integrity
                | Error::Truncated { .. }
                | Error::Object(object_store::Error::NotFound { .. }),
            ) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Reads and decodes a chunk, checking its length and content hash. A
    /// read that fails the checks is tried once more, since the damage may
    /// have happened in transit; a chunk that is bad twice is copied to
    /// quarantine, and a later upload of the same content repairs it.
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
        self.put_immutable(&Self::manifest_key(&digest), Bytes::from(bytes))
            .await?;
        Ok(digest)
    }

    /// The key of the manifest whose digest is `digest`.
    #[must_use]
    pub fn manifest_key(digest: &str) -> String {
        format!("manifests/v1/{digest}.json")
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
            .get(&self.path(&Self::manifest_key(digest)))
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

    /// Every object stored in `area`.
    pub async fn list(&self, area: Area) -> Result<Vec<Listed>> {
        let prefix = self.path(area.prefix());
        self.backend
            .list(Some(&prefix))
            .map_err(Error::from)
            .and_then(|meta| async move {
                let key = meta
                    .location
                    .prefix_match(&self.prefix)
                    .map(|parts| parts.map(|part| part.as_ref().to_owned()))
                    .ok_or(Error::Invalid("listed object outside the store"))?
                    .collect::<Vec<_>>()
                    .join("/");
                Ok(Listed {
                    key,
                    stored_at: meta.last_modified.into(),
                    size: meta.size,
                })
            })
            .try_collect()
            .await
    }

    /// Deletes the chunk or manifest at `key` if it was stored before
    /// `before` and has not been stored again since this call looked. Only
    /// GCS deletes on that condition; elsewhere this refuses with
    /// [`Error::Unsupported`].
    pub async fn delete_if_stored_before(&self, key: &str, before: SystemTime) -> Result<Removal> {
        let Uploader::Gcs(gcs) = &self.uploader else {
            return Err(Error::Unsupported(
                "deleting stored objects needs a delete on condition (GCS)",
            ));
        };
        if !(key.starts_with(Area::Chunks.prefix()) || key.starts_with(Area::Manifests.prefix())) {
            return Err(Error::Invalid("only chunks and manifests are deleted"));
        }
        let path = self.path(key);
        let Some(stored) = gcs.stored(&path).await? else {
            return Ok(Removal::Gone);
        };
        let (Some(at), Some(generation)) = (stored.at, stored.generation) else {
            return Ok(Removal::Kept);
        };
        if at >= before {
            return Ok(Removal::Kept);
        }
        Ok(match gcs.delete_generation(&path, &generation).await? {
            Deleted::Yes => Removal::Deleted,
            Deleted::Changed => Removal::Kept,
            Deleted::Gone => Removal::Gone,
        })
    }
}

#[cfg(test)]
mod tests;
