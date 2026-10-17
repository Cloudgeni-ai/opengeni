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
use object_store::{ClientOptions, ObjectStore, PutMode, PutOptions, UpdateVersion, path::Path};

use crate::{
    Error, Result,
    chunk::{ChunkRef, EncodedChunk, decode},
    fresh::{Clock, Freshness},
    manifest::{DiskManifest, MAX_MANIFEST_BYTES},
    upload::{Created, Deleted, Gcs},
};

/// Largest pointer object accepted; pointers only name manifests.
pub const MAX_POINTER_BYTES: usize = 64 * 1024;

/// Length of the stamp every stored pointer begins with (see [`stamped`]).
const STAMP_BYTES: usize = 16;

/// Where pointers were stored before they carried a stamp.
const UNSTAMPED_POINTERS: &str = "pointers/v1";

/// How often [`ChunkStore::begin`], [`ChunkStore::fence`] and
/// [`ChunkStore::delete_pointer`] try again when the pointer changes under
/// them; a pointer has one writer, so more means something else is wrong.
const POINTER_TRIES: usize = 4;

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

/// Told about every stored object found bad and copied to quarantine, for
/// example to raise an alarm. Called from whichever task found it, so it
/// must not wait.
pub trait QuarantineWatch: Send + Sync + std::fmt::Debug {
    /// The object stored under `key` (relative to the store's prefix) is
    /// bad, for the reason `why` gives.
    fn quarantined(&self, key: &str, why: &str);
}

#[derive(Clone, Debug)]
pub struct ChunkStore {
    backend: Arc<dyn ObjectStore>,
    prefix: Path,
    uploader: Uploader,
    freshness: Freshness,
    clock: Clock,
    watch: Option<Arc<dyn QuarantineWatch>>,
}

/// The kinds of stored object, each under its own prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    /// The only objects ever replaced: each names a copy's manifests.
    Pointers,
    Manifests,
    Chunks,
}

/// One change of a pointer between the version it started from and the
/// pointer it writes: an archive (see [`ChunkStore::begin`]) or a change
/// naming part of what the pointer named (see
/// [`ChunkStore::read_for_change`]). It lands only on that version.
#[derive(Clone, Debug)]
#[must_use = "a change lands through its publication"]
pub struct Publication {
    path: Path,
    /// The pointer's version when the change started.
    version: UpdateVersion,
}

impl Area {
    fn prefix(self) -> &'static str {
        match self {
            Self::Pointers => "pointers/v2",
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
            watch: None,
        }
    }

    /// The same store telling `watch` about every object it quarantines.
    #[must_use]
    pub fn with_watch(self, watch: Arc<dyn QuarantineWatch>) -> Self {
        Self {
            watch: Some(watch),
            ..self
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
            watch: None,
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
            watch: None,
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
        Ok(self.path(&format!("pointers/v2/{name}")))
    }

    /// Whether this store deletes on condition (GCS), which a sweep that
    /// deletes needs.
    #[must_use]
    pub fn deletes_on_condition(&self) -> bool {
        matches!(self.uploader, Uploader::Gcs(_))
    }

    /// Refuses a store that holds pointers from before they carried a
    /// stamp: this release does not read them, so their copies would look
    /// absent and a sweep would delete what they name. Such a store needs
    /// migrating; a new prefix starts afresh.
    pub async fn refuse_unstamped_pointers(&self) -> Result<()> {
        let prefix = self.path(UNSTAMPED_POINTERS);
        match self.backend.list(Some(&prefix)).try_next().await? {
            None => Ok(()),
            Some(_) => Err(Error::Unsupported(
                "the store holds pointers in an older format (pointers/v1): \
                 migrate them or use a new prefix",
            )),
        }
    }

    /// Reads the pointer at `path`: what it holds, without its stamp, and
    /// the version it is stored as; `None` when there is none.
    async fn read_pointer(&self, path: &Path) -> Result<Option<(Bytes, UpdateVersion)>> {
        let read = match self.backend.get(path).await {
            Ok(read) => read,
            Err(object_store::Error::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if read.meta.size > (STAMP_BYTES + MAX_POINTER_BYTES) as u64 {
            return Err(Error::Invalid("pointer too large"));
        }
        let version = UpdateVersion {
            e_tag: read.meta.e_tag.clone(),
            version: read.meta.version.clone(),
        };
        let stored = read.bytes().await?;
        Ok(Some((unstamped(&stored)?, version)))
    }

    /// Reads pointer `name` to replace it with one naming part of what it
    /// names now, such as the same copy without its memory image. The
    /// replacement goes through [`Self::publish`] with the publication
    /// returned, so it lands only on the version read: a write held up in
    /// flight long after its caller stopped waiting can never replace a
    /// copy stored since, and a sweep's fence sends the caller to read
    /// again. `None` when there is no pointer, or only the empty one an
    /// archive in flight stored.
    pub async fn read_for_change(&self, name: &str) -> Result<Option<(Vec<u8>, Publication)>> {
        let path = self.pointer_path(name)?;
        match self.read_pointer(&path).await? {
            Some((pointer, version)) if !pointer.is_empty() => {
                Ok(Some((pointer.to_vec(), Publication { path, version })))
            }
            _ => Ok(None),
        }
    }

    /// Replaces pointer `name` with no condition, as a writer without the
    /// fence would; for tests that show what the fence prevents.
    #[cfg(test)]
    pub(crate) async fn put_pointer_unfenced(&self, name: &str, bytes: Vec<u8>) -> Result<()> {
        self.backend
            .put(&self.pointer_path(name)?, stamped(&bytes)?.into())
            .await?;
        Ok(())
    }

    /// Starts an archive that will replace pointer `name`: begin before
    /// looking at the store at all. Notes which version of the pointer is
    /// stored, first storing an empty one if there is none, so that a
    /// sweep can stop the archive from publishing once it has taken stock
    /// (see [`crate::fresh`]).
    pub async fn begin(&self, name: &str) -> Result<Publication> {
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            match self.backend.head(&path).await {
                Ok(meta) => {
                    let version = UpdateVersion {
                        e_tag: meta.e_tag,
                        version: meta.version,
                    };
                    return Ok(Publication { path, version });
                }
                Err(object_store::Error::NotFound { .. }) => {}
                Err(error) => return Err(error.into()),
            }
            let create = PutOptions {
                mode: PutMode::Create,
                ..Default::default()
            };
            match self
                .backend
                .put_opts(&path, stamped(&[])?.into(), create)
                .await
            {
                Ok(put) => {
                    let version = UpdateVersion {
                        e_tag: put.e_tag,
                        version: put.version,
                    };
                    return Ok(Publication { path, version });
                }
                // Made meanwhile, or by an earlier try whose answer was
                // lost: read its version.
                Err(object_store::Error::AlreadyExists { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(Error::Superseded)
    }

    /// Ends `publication` by replacing its pointer with `bytes`, on
    /// condition that the pointer is still the version the change started
    /// from. Refused with [`Error::Superseded`] otherwise: a sweep has
    /// taken stock since and may delete what an archive reused, or a newer
    /// copy was stored, so the change starts again.
    pub async fn publish(&self, publication: Publication, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(Error::Invalid("pointer too large"));
        }
        let options = PutOptions {
            mode: PutMode::Update(publication.version),
            ..Default::default()
        };
        match self
            .backend
            .put_opts(&publication.path, stamped(&bytes)?.into(), options)
            .await
        {
            Ok(_) => Ok(()),
            Err(
                object_store::Error::Precondition { .. } | object_store::Error::NotFound { .. },
            ) => Err(Error::Superseded),
            Err(error) => Err(error.into()),
        }
    }

    /// Stores pointer `key` (as a listing gives it) again as it is, on
    /// condition that it has not changed since it was read, and returns
    /// what it holds; `None` once it is gone. After this no archive that
    /// began earlier can publish it, so what it names now is all it can
    /// name until an archive begun later publishes: stored again under a
    /// new stamp, it has a new version on every store.
    pub async fn fence(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let name = Self::pointer_name(key).ok_or(Error::Invalid("pointer key"))?;
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            let Some((pointer, version)) = self.read_pointer(&path).await? else {
                return Ok(None);
            };
            let options = PutOptions {
                mode: PutMode::Update(version),
                ..Default::default()
            };
            match self
                .backend
                .put_opts(&path, stamped(&pointer)?.into(), options)
                .await
            {
                Ok(_) => return Ok(Some(pointer.to_vec())),
                // Published meanwhile, or fenced by an earlier try whose
                // answer was lost: read it again.
                Err(object_store::Error::Precondition { .. }) => {}
                Err(object_store::Error::NotFound { .. }) => return Ok(None),
                Err(error) => return Err(error.into()),
            }
        }
        Err(Error::Superseded)
    }

    /// Reads pointer `name`, or `None` when there is none or it is the
    /// empty one an archive in flight stored (see [`Self::begin`]).
    pub async fn get_pointer(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let path = self.pointer_path(name)?;
        Ok(self
            .read_pointer(&path)
            .await?
            .filter(|(pointer, _)| !pointer.is_empty())
            .map(|(pointer, _)| pointer.to_vec()))
    }

    /// Deletes pointer `name`; succeeds when there is none. It deletes only
    /// the version it read, so a delete held up in flight long after its
    /// caller stopped waiting can never take a copy stored since: on GCS by
    /// generation; elsewhere, where a delete carries no condition, by
    /// replacing the pointer with the empty one on condition, which reads
    /// as no copy and stays. Every pointer write has its own stamp, so even
    /// where the version follows the bytes (S3) a copy stored since with
    /// the same contents is a version the delete did not read. A version
    /// that changes between the read and the delete is read again. What
    /// the pointer named stays until a sweep finds nothing names it.
    pub async fn delete_pointer(&self, name: &str) -> Result<()> {
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            if let Uploader::Gcs(gcs) = &self.uploader {
                let Some(stored) = gcs.stored(&path).await? else {
                    return Ok(());
                };
                let generation = stored
                    .generation
                    .ok_or(Error::Invalid("the store gave no generation"))?;
                match gcs.delete_generation(&path, &generation).await? {
                    Deleted::Yes | Deleted::Gone => return Ok(()),
                    Deleted::Changed => continue,
                }
            }
            let Some((pointer, version)) = self.read_pointer(&path).await? else {
                return Ok(());
            };
            if pointer.is_empty() {
                return Ok(());
            }
            let options = PutOptions {
                mode: PutMode::Update(version),
                ..Default::default()
            };
            match self
                .backend
                .put_opts(&path, stamped(&[])?.into(), options)
                .await
            {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => return Ok(()),
                Err(object_store::Error::Precondition { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(Error::Superseded)
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
        self.quarantine(&path, "other bytes are stored under its name")
            .await?;
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
    async fn quarantine(&self, path: &Path, why: &str) -> Result<()> {
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
        if let Some(watch) = &self.watch {
            watch.quarantined(&relative, why);
        }
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
                    self.quarantine(&path, &error.to_string()).await?;
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

    /// The name of the pointer a listing of [`Area::Pointers`] shows as
    /// `key`.
    #[must_use]
    pub fn pointer_name(key: &str) -> Option<&str> {
        key.strip_prefix("pointers/v2/")
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

/// `pointer` as stored: after a stamp no other write uses. Storing the
/// same pointer again, or the empty one again, then still gives a new
/// version where a store's entity tag follows the bytes (S3), so a write
/// held up in flight, on condition of a version read long ago, can never
/// land on a later write that happens to hold the same bytes.
fn stamped(pointer: &[u8]) -> Result<Bytes> {
    let mut stored = vec![0; STAMP_BYTES + pointer.len()];
    let (stamp, rest) = stored.split_at_mut(STAMP_BYTES);
    getrandom::fill(stamp).map_err(std::io::Error::from)?;
    rest.copy_from_slice(pointer);
    Ok(stored.into())
}

/// The pointer `stored` holds, without its stamp (see [`stamped`]).
pub(crate) fn unstamped(stored: &Bytes) -> Result<Bytes> {
    if stored.len() < STAMP_BYTES {
        return Err(Error::Invalid("pointer without a stamp"));
    }
    Ok(stored.slice(STAMP_BYTES..))
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::memory::InMemory;

    #[tokio::test]
    async fn pointers_are_replaced_read_and_deleted() {
        let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("tenant/test"));
        assert_eq!(store.get_pointer("a1").await.unwrap(), None);
        assert!(store.read_for_change("a1").await.unwrap().is_none());
        let first = store.begin("a1").await.unwrap();
        store.publish(first, b"one two".to_vec()).await.unwrap();
        let (read, part) = store.read_for_change("a1").await.unwrap().unwrap();
        assert_eq!(read, b"one two".to_vec());
        store.publish(part, b"two".to_vec()).await.unwrap();
        assert_eq!(
            store.get_pointer("a1").await.unwrap(),
            Some(b"two".to_vec())
        );
        store.delete_pointer("a1").await.unwrap();
        store.delete_pointer("a1").await.unwrap();
        assert_eq!(store.get_pointer("a1").await.unwrap(), None);
        assert!(store.read_for_change("a1").await.unwrap().is_none());
        assert!(store.begin("../escape").await.is_err());
        let big = store.begin("big").await.unwrap();
        assert!(
            store
                .publish(big, vec![0; MAX_POINTER_BYTES + 1])
                .await
                .is_err()
        );
    }

    /// A change that read an older version never lands, and a delete
    /// where deletes carry no condition leaves the empty pointer.
    #[tokio::test]
    async fn changes_land_only_on_the_version_they_read() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("p"));
        let first = store.begin("a").await.unwrap();
        store.publish(first, b"old".to_vec()).await.unwrap();
        let (_, stale) = store.read_for_change("a").await.unwrap().unwrap();
        let newer = store.begin("a").await.unwrap();
        store.publish(newer, b"new".to_vec()).await.unwrap();
        let refused = store.publish(stale, b"part of old".to_vec()).await;
        assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");
        assert_eq!(store.get_pointer("a").await.unwrap(), Some(b"new".to_vec()));

        store.delete_pointer("a").await.unwrap();
        assert_eq!(store.get_pointer("a").await.unwrap(), None);
        let left = backend
            .get(&Path::from("p/pointers/v2/a"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert!(
            unstamped(&left).unwrap().is_empty(),
            "the empty pointer stays"
        );
        assert!(store.read_for_change("a").await.unwrap().is_none());
    }

    /// Every write of a pointer is stored differently, even of the same
    /// pointer, and a stored pointer without its stamp is refused.
    #[tokio::test]
    async fn every_pointer_write_has_its_own_stamp() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("p"));
        let path = Path::from("p/pointers/v2/a");
        let stored = || {
            let (backend, path) = (backend.clone(), path.clone());
            async move { backend.get(&path).await.unwrap().bytes().await.unwrap() }
        };
        let first = store.begin("a").await.unwrap();
        let empty = stored().await;
        store.publish(first, b"same".to_vec()).await.unwrap();
        let once = stored().await;
        let (_, again) = store.read_for_change("a").await.unwrap().unwrap();
        store.publish(again, b"same".to_vec()).await.unwrap();
        let twice = stored().await;
        assert_eq!(unstamped(&once).unwrap(), unstamped(&twice).unwrap());
        assert_ne!(once, twice);
        store.fence("pointers/v2/a").await.unwrap();
        assert_ne!(stored().await, twice, "a fence stores it anew");
        store.delete_pointer("a").await.unwrap();
        let deleted = stored().await;
        assert!(unstamped(&deleted).unwrap().is_empty());
        assert_ne!(deleted, empty, "two empty pointers differ by stamp");

        backend
            .put(&path, Bytes::from_static(b"short").into())
            .await
            .unwrap();
        assert!(matches!(
            store.get_pointer("a").await,
            Err(Error::Invalid(_))
        ));
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
        #[derive(Debug, Default)]
        struct Seen(std::sync::Mutex<Vec<String>>);
        impl QuarantineWatch for Seen {
            fn quarantined(&self, key: &str, _why: &str) {
                self.0.lock().unwrap().push(key.to_owned());
            }
        }
        let backend = Arc::new(InMemory::new());
        let seen = Arc::new(Seen::default());
        let store =
            ChunkStore::new(backend.clone(), Path::from("tenant/test")).with_watch(seen.clone());
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
            // A copy is kept for inspection.
            assert!(quarantined(&backend).await.contains(&bad));
            // The object itself stays until the right bytes replace it, and
            // neither a short nor a same-length damaged copy counts as held.
            assert!(!store.has_chunk(&chunk.reference).await.unwrap());
            // The next upload of the same content repairs the shared chunk.
            assert!(store.put_chunk(&chunk).await.unwrap());
            assert!(store.has_chunk(&chunk.reference).await.unwrap());
            assert_eq!(
                store.get_chunk(&chunk.reference).await.unwrap(),
                vec![7; 65536]
            );
        }
        // Each bad copy was reported by its key twice: when a read found it,
        // and when the repairing upload found it still there.
        assert_eq!(*seen.0.lock().unwrap(), vec![chunk.object_key(); 4]);
    }

    #[tokio::test]
    async fn a_missing_or_truncated_chunk_is_not_held() {
        let backend = Arc::new(InMemory::new());
        let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
        let chunk = EncodedChunk::encode(&[4; 8192], 1).unwrap();
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
        store.put_chunk(&chunk).await.unwrap();
        assert!(store.has_chunk(&chunk.reference).await.unwrap());
        let path = store.path(&chunk.object_key());
        backend
            .put(&path, Bytes::from(chunk.bytes[1..].to_vec()).into())
            .await
            .unwrap();
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
        backend.delete(&path).await.unwrap();
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
    }

    #[tokio::test]
    async fn gcs_checksums_prove_a_chunk_without_reading_it() {
        use crate::fake::{Fake, gcs};
        let fake = Arc::new(Fake::default());
        let store = ChunkStore {
            // Never read: GCS answers from the checksums it keeps.
            backend: Arc::new(InMemory::new()),
            prefix: Path::from("p"),
            uploader: Uploader::Gcs(gcs(&fake)),
            freshness: Freshness::DEFAULT,
            clock: Clock::system(),
            watch: None,
        };
        let chunk = EncodedChunk::encode(&[9; 16384], 1).unwrap();
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
        assert!(store.put_chunk(&chunk).await.unwrap());
        assert!(store.has_chunk(&chunk.reference).await.unwrap());
        // Same-length damage under the chunk's name is not held...
        let key = format!("p/{}", chunk.object_key());
        let mut damaged = chunk.bytes.clone();
        damaged[1] ^= 0x10;
        fake.put_raw(&key, Bytes::from(damaged));
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
        // ...and the next upload of the same content replaces it.
        assert!(store.put_chunk(&chunk).await.unwrap());
        assert_eq!(fake.bytes(&key).unwrap(), chunk.bytes);
        assert!(store.has_chunk(&chunk.reference).await.unwrap());
        // A reference whose checksums disagree with its bytes is refused.
        let mut forged = chunk.clone();
        forged.reference.checksums = Some(crate::upload::checksums(b"other"));
        assert!(matches!(
            store.put_chunk(&forged).await,
            Err(Error::Integrity)
        ));
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
