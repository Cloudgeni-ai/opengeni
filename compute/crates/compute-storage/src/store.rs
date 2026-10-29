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
//! deleting what an archive in flight is about to name. Chunks and
//! manifests are written only under the current day's name, so a delete
//! never needs a condition. Pointers are kept by a [`PointerStore`]: the
//! control service's in a fleet, the object store's own otherwise.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures::TryStreamExt as _;
use object_store::{ClientOptions, ObjectStore, PutMode, PutOptions, path::Path};

use crate::{
    Error, Result,
    chunk::{ChunkRef, EncodedChunk, decode},
    fresh::{Clock, day_of},
    manifest::{DiskManifest, MAX_MANIFEST_BYTES},
    pointer_store::{ObjectPointers, PointerStore},
    upload::{Created, Gcs},
};

/// Largest pointer object accepted; pointers only name manifests.
pub const MAX_POINTER_BYTES: usize = 64 * 1024;

mod pointers;

#[cfg(test)]
pub(crate) use crate::pointer_store::unstamped;
pub use pointers::{Begun, Publication, Rewrite, Stock};
#[cfg(test)]
pub(crate) use pointers::{TEST_EPOCH, next_save};

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

/// Told about every stored object found bad, and about each copy of one
/// kept in quarantine, for example to raise alarms. Called from whichever
/// task found it, so it must not wait.
pub trait QuarantineWatch: Send + Sync + std::fmt::Debug {
    /// The object stored under `key` (relative to the store's prefix) is
    /// bad, for the reason `why` gives: it failed its check on every read.
    fn verification_failed(&self, key: &str, why: &str);
    /// A copy of the bad object under `key` is now kept in quarantine.
    fn quarantined(&self, key: &str);
}

#[derive(Clone, Debug)]
pub struct ChunkStore {
    backend: Arc<dyn ObjectStore>,
    prefix: Path,
    uploader: Uploader,
    pointers: Arc<dyn PointerStore>,
    clock: Clock,
    watch: Option<Arc<dyn QuarantineWatch>>,
    /// How long a read of a chunk or manifest keeps trying while the store
    /// says it is not there ([`SETTLE`]).
    settle: Duration,
}

/// How long a read of a chunk or manifest keeps trying while the store
/// answers that it is not there, before it is taken as gone. Something
/// names every object read, and it was stored before anything named it;
/// but not every store reads what was just written: Garage, run so that a
/// write lands once one of its nodes has it, can answer from a node that
/// was away while the write landed until that node has caught up, minutes
/// after it is back.
pub const SETTLE: Duration = Duration::from_secs(5 * 60);

/// The longest wait between two reads while one settles.
const SETTLE_DELAY_MAX: Duration = Duration::from_secs(10);

/// The kinds of stored object a sweep deletes, each under its own prefix
/// (every layout of it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Manifests,
    Chunks,
}

impl Area {
    fn prefix(self) -> &'static str {
        match self {
            Self::Manifests => "manifests",
            Self::Chunks => "chunks",
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

/// A chunk as [`ChunkStore::put_chunk`] stored it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Put {
    /// What names it now: the reference it was given, under the day it was
    /// stored on.
    pub reference: ChunkRef,
    /// Whether this call wrote it; otherwise another write of the same
    /// bytes did, the same day.
    pub new: bool,
}

/// What is stored under a content name.
enum Found {
    /// Exactly the bytes the name allows.
    Ours,
    /// Nothing, or other bytes.
    Other,
}

impl ChunkStore {
    /// A store over any backend. Uploads are read back to verify them; use
    /// [`Self::from_url`] for stores that verify checksums themselves. A
    /// read of what is not there fails at once ([`Self::with_settle`]).
    #[must_use]
    pub fn new(backend: Arc<dyn ObjectStore>, prefix: Path) -> Self {
        Self {
            pointers: Arc::new(ObjectPointers::new(backend.clone(), prefix.clone())),
            backend,
            prefix,
            uploader: Uploader::ReadBack,
            clock: Clock::system(),
            watch: None,
            settle: Duration::ZERO,
        }
    }

    /// The same store reading a chunk or manifest again, for up to
    /// `settle`, while the store answers that it is not there ([`SETTLE`]).
    #[must_use]
    pub fn with_settle(self, settle: Duration) -> Self {
        Self { settle, ..self }
    }

    /// The same store telling `watch` about every object it quarantines.
    #[must_use]
    pub fn with_watch(self, watch: Arc<dyn QuarantineWatch>) -> Self {
        Self {
            watch: Some(watch),
            ..self
        }
    }

    /// The same store keeping its pointers in `pointers` rather than in
    /// its object store: a fleet's control service keeps them (ADR 25).
    #[must_use]
    pub fn with_pointers(self, pointers: Arc<dyn PointerStore>) -> Self {
        Self { pointers, ..self }
    }

    /// The pointers kept in its object store itself, as a host on its own
    /// and every host of an earlier release keeps them, whatever
    /// [`Self::with_pointers`] chose: what a control service imports when
    /// it takes over a fleet's pointers (ADR 25).
    #[must_use]
    pub fn object_pointers(&self) -> ObjectPointers {
        ObjectPointers::new(self.backend.clone(), self.prefix.clone())
    }

    /// The object store and prefix it is over, for logs and records.
    #[must_use]
    pub fn describe(&self) -> String {
        format!("{} under {}", self.backend, self.prefix)
    }

    /// The same store reading the time from `clock`.
    #[must_use]
    pub fn with_clock(self, clock: Clock) -> Self {
        Self { clock, ..self }
    }

    #[must_use]
    pub fn now(&self) -> SystemTime {
        self.clock.now()
    }

    /// Checks that its pointers can be kept safely: an object store must
    /// refuse a second create of the same object (see
    /// [`ObjectPointers::check`]). Done once, before anything is stored.
    pub async fn check_pointers(&self) -> Result<()> {
        self.pointers.check().await
    }

    /// The name of every pointer kept, for a sweep.
    pub async fn pointer_names(&self) -> Result<Vec<String>> {
        self.pointers.names().await
    }

    /// A store over `fake`'s bucket, under `prefix`, on `fake`'s clock.
    #[cfg(test)]
    pub(crate) fn over_fake(fake: &Arc<crate::fake::Fake>, prefix: &str) -> Self {
        let backend: Arc<dyn ObjectStore> = Arc::new(crate::fake::Bucket(fake.clone()));
        Self {
            pointers: Arc::new(ObjectPointers::new(backend.clone(), Path::from(prefix))),
            backend,
            prefix: Path::from(prefix),
            uploader: Uploader::Gcs(crate::fake::gcs(fake)),
            clock: fake.clock.clone(),
            watch: None,
            settle: Duration::ZERO,
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
            pointers: Arc::new(ObjectPointers::new(backend.clone(), prefix.clone())),
            backend,
            prefix,
            uploader,
            clock: Clock::system(),
            watch: None,
            settle: SETTLE,
        }))
    }

    fn path(&self, key: &str) -> Path {
        // One path part per segment: a single `child` would escape the
        // slashes, so `chunks/v1/...` would become one opaque name that
        // prefix listings (and garbage collection) cannot walk.
        key.split('/')
            .fold(self.prefix.clone(), |path, part| path.child(part))
    }

    /// Stores `chunk` under today's name (see [`crate::fresh`]) unless
    /// another write stored the same bytes under it already, and returns
    /// the reference naming it there. An object of the same bytes stored
    /// on an earlier day is not looked for: what an archive reuses of an
    /// earlier copy it names by that copy's references.
    pub async fn put_chunk(&self, chunk: &EncodedChunk) -> Result<Put> {
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
        let reference = chunk.reference.on_day(day_of(self.clock.now()));
        let new = self
            .put_immutable(&reference.key(), Bytes::copy_from_slice(&chunk.bytes))
            .await?;
        Ok(Put { reference, new })
    }

    /// Writes `bytes` under `key`, a name that allows no other bytes,
    /// unless they are stored there already; whether this call wrote them.
    async fn put_immutable(&self, key: &str, bytes: Bytes) -> Result<bool> {
        let path = self.path(key);
        if self.create(&path, &bytes).await? == Created::New {
            return Ok(true);
        }
        if self.holds(&path, &bytes).await? {
            // Stored today by another write of the same bytes: no sweep
            // deletes it before the day after tomorrow (`crate::fresh`).
            return Ok(false);
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
        Ok(matches!(self.found(path, bytes).await?, Found::Ours))
    }

    async fn found(&self, path: &Path, bytes: &Bytes) -> Result<Found> {
        if let Uploader::Gcs(gcs) = &self.uploader {
            // GCS kept the checksums it verified at upload: no download.
            return Ok(match gcs.stored(path).await? {
                Some(stored) if stored.checksums == crate::upload::checksums(bytes) => Found::Ours,
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
        Ok(if result.bytes().await? == *bytes {
            Found::Ours
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
            watch.verification_failed(&relative, why);
        }
        let target = self.path(&format!("quarantine/v1/{relative}.{nanos}-{moves}"));
        match self.backend.copy(path, &target).await {
            Ok(()) => {
                if let Some(watch) = &self.watch {
                    watch.quarantined(&relative);
                }
                Ok(())
            }
            // Gone meanwhile: nothing to keep.
            Err(object_store::Error::NotFound { .. }) => Ok(()),
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
            match self
                .settled(&path, || self.read_chunk(&path, reference))
                .await
            {
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
    /// Returns the manifest's name: `<day>/<digest>`, the day it is stored
    /// under today's (see [`crate::fresh`]) and its digest.
    pub async fn put_manifest(&self, manifest: &DiskManifest) -> Result<String> {
        let bytes = manifest.encode()?;
        let digest = blake3::hash(&bytes).to_hex().to_string();
        let name = format!("{}/{digest}", day_of(self.clock.now()));
        self.put_immutable(&Self::manifest_key(&name)?, Bytes::from(bytes))
            .await?;
        Ok(name)
    }

    /// The key of the manifest named `name`: `<day>/<digest>`, or a digest
    /// alone for one stored in the old layout.
    pub fn manifest_key(name: &str) -> Result<String> {
        Ok(match manifest_name(name)? {
            (Some(day), digest) => format!("manifests/v2/{day}/{digest}.json"),
            (None, digest) => format!("manifests/v1/{digest}.json"),
        })
    }

    /// Reads the manifest named `name` (see [`Self::manifest_key`]),
    /// checking it against its digest. A read that does not match is tried
    /// once more, since the damage may have happened in transit; one bad
    /// twice is copied to quarantine.
    pub async fn get_manifest(&self, name: &str) -> Result<DiskManifest> {
        let (_, digest) = manifest_name(name)?;
        let path = self.path(&Self::manifest_key(name)?);
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self
                .settled(&path, || self.read_manifest(&path, digest))
                .await
            {
                Err(Error::Integrity) if attempt == 1 => {}
                Err(Error::Integrity) => {
                    self.quarantine(&path, "the manifest does not match its digest")
                        .await?;
                    return Err(Error::Integrity);
                }
                result => return result,
            }
        }
    }

    async fn read_manifest(&self, path: &Path, digest: &str) -> Result<DiskManifest> {
        let result = self.backend.get(path).await?;
        if result.meta.size > MAX_MANIFEST_BYTES as u64 {
            return Err(Error::Invalid("manifest too large"));
        }
        let bytes = result.bytes().await?;
        if blake3::hash(&bytes).to_hex().as_str() != digest {
            return Err(Error::Integrity);
        }
        DiskManifest::decode(&bytes)
    }

    /// Runs `read` of `path`, again while the store answers that nothing is
    /// there, for up to [`Self::with_settle`]'s time ([`SETTLE`]).
    async fn settled<T, F: Future<Output = Result<T>>>(
        &self,
        path: &Path,
        mut read: impl FnMut() -> F,
    ) -> Result<T> {
        let started = tokio::time::Instant::now();
        let mut delay = Duration::from_millis(100);
        loop {
            match read().await {
                Err(Error::Object(object_store::Error::NotFound { .. }))
                    if started.elapsed() < self.settle =>
                {
                    if delay == Duration::from_millis(100) {
                        tracing::warn!(
                            %path,
                            settle_s = self.settle.as_secs(),
                            "the store does not have an object a stored copy names; reading it \
                             again while the store may still be catching up"
                        );
                    }
                    tokio::time::sleep(delay.min(self.settle.saturating_sub(started.elapsed())))
                        .await;
                    delay = (delay * 2).min(SETTLE_DELAY_MAX);
                }
                result => return result,
            }
        }
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

    /// Deletes the chunk or manifest at `key` (as a listing gives it), with
    /// no condition: only a sweep does, of objects nothing writes again
    /// (see [`crate::fresh`]). Whether it was there.
    pub async fn delete(&self, key: &str) -> Result<bool> {
        if written(key).is_none() {
            return Err(Error::Invalid("only chunks and manifests are deleted"));
        }
        match self.backend.delete(&self.path(key)).await {
            Ok(()) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

/// When a chunk or manifest was written, as its key says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    /// On this UTC day ([`crate::fresh::day_of`]).
    On(u32),
    /// In the old layout, named by its content alone: its listing tells
    /// when it was last stored.
    Legacy,
}

/// When the chunk or manifest under `key` (as a listing gives it) was
/// written; `None` for a key of no layout this build writes or wrote,
/// which a sweep leaves alone.
#[must_use]
pub fn written(key: &str) -> Option<Written> {
    let parts: Vec<&str> = key.split('/').collect();
    let named = |part: &str| !part.is_empty();
    match parts.as_slice() {
        ["chunks", "v2", day, rest @ ..] if rest.len() == 3 && rest.iter().all(|p| named(p)) => {
            canonical_day(day).map(Written::On)
        }
        ["chunks", "v1", rest @ ..] if rest.len() == 3 && rest.iter().all(|p| named(p)) => {
            Some(Written::Legacy)
        }
        ["manifests", "v2", day, file] => {
            let digest = file.strip_suffix(".json")?;
            is_digest(digest).then_some(())?;
            canonical_day(day).map(Written::On)
        }
        ["manifests", "v1", file] => {
            let digest = file.strip_suffix(".json")?;
            is_digest(digest).then_some(Written::Legacy)
        }
        _ => None,
    }
}

/// A day as keys write it: decimal digits with no leading zero.
fn canonical_day(day: &str) -> Option<u32> {
    let parsed: u32 = day.parse().ok()?;
    (parsed.to_string() == day).then_some(parsed)
}

/// Whether `digest` is a manifest digest: 64 lowercase hex digits.
fn is_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The day (none in the old layout) and digest a manifest's name holds.
fn manifest_name(name: &str) -> Result<(Option<u32>, &str)> {
    let (day, digest) = match name.split_once('/') {
        Some((day, digest)) => (
            Some(canonical_day(day).ok_or(Error::Invalid("manifest day"))?),
            digest,
        ),
        None => (None, name),
    };
    if !is_digest(digest) {
        return Err(Error::Invalid("manifest digest"));
    }
    Ok((day, digest))
}

#[cfg(test)]
mod tests;
