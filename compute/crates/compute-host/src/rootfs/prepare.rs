//! Sandbox images a host builds when the control service asks
//! ([`Request::Prepare`](crate::protocol::Request::Prepare)): from an OCI
//! image pinned by digest, with the host's guest programs, stored where its
//! sandboxes are kept. Builds are not byte for byte the same, so two hosts
//! building one OCI image store two images; the control service records
//! the first it is told of and creates use that one. Each build is told
//! with the digest of the guest programs it got
//! ([`PrepareConfig::guest_digest`]), which the host also registers with,
//! so the service builds a release's images again once its hosts' guest
//! programs change.
//!
//! An ask is answered at once, so no call stays open through a build that
//! takes minutes: the first starts the build and every ask until it ends
//! hears that it is under way. A host builds one image at a time, in
//! scratch space emptied before and after each build. Once stored, an
//! image is the answer to every ask for [`TOLD_FOR`]; a failed build is
//! told to the next ask, and the one after that builds again.
//!
//! The control service asks only for an image it has no record of, and
//! forgets a stored image nothing uses, with its record, no sooner than an
//! hour after it was last recorded (compute-control's `UNUSED_FOR`). So an
//! ask long after the store may be for an image the store no longer
//! holds, and the host's word that it stored it then is no longer true:
//! past [`TOLD_FOR`] the host builds the image again, which is a new
//! image, stored anew.
//!
//! A build ends by keeping the image in the host's cache of images
//! ([`Cache`]), so this host serves it without a fetch, and then storing
//! it. A store that fails (object storage refusing writes, or out of
//! reach) does not throw the build away: the host keeps its copy and tries
//! the store again in the background, waiting twice as long after each
//! failure up to [`STORE_AGAIN_MOST`], and asks meanwhile hear that the
//! image is under way. So the control service goes on creating sandboxes
//! from the image it used before, and the image is stored, and used, as
//! soon as the store takes it, without being built again. The copy is
//! only a cached image: disk relief may remove it when the host needs the
//! room (between tries, never under one), and then the next ask is told
//! the build failed and the one after builds again. Tries stop once the
//! control service has not asked for the image for [`UNASKED_AFTER`].

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use compute_engine::EngineError;
use compute_image::{Build, Credentials, Reference};
use futures::future::BoxFuture;
use tokio::time::Instant;

use super::Cache;
use crate::chunked::file_id;
use crate::protocol::ImageId;
use crate::store::Store;

/// The pause before an image's failed store is tried again; each next one
/// waits twice as long, up to [`STORE_AGAIN_MOST`].
const STORE_AGAIN_AFTER: Duration = Duration::from_secs(30);
const STORE_AGAIN_MOST: Duration = Duration::from_secs(10 * 60);
/// How long a built image whose store failed is still tried after the last
/// ask for it. The control service asks every few seconds while it waits
/// for an image, so one it has not asked for in this long it no longer
/// wants (a later release names another).
const UNASKED_AFTER: Duration = Duration::from_secs(30 * 60);
/// How long a stored image is the answer to asks for it: time for every
/// replica of the control service to hear of it, and less than the hour a
/// stored image nothing uses is kept (compute-control's `UNUSED_FOR`), so
/// an image told is one the store still holds.
const TOLD_FOR: Duration = Duration::from_secs(30 * 60);

/// How a host builds sandbox images.
#[derive(Clone, Debug)]
pub struct PrepareConfig {
    /// The guest programs every image gets: the directory `guest/build.sh`
    /// made, as a bundle's `guest/`.
    pub guest: PathBuf,
    /// The digest of the programs in `guest`
    /// ([`compute_image::assemble::guest_digest`]).
    pub guest_digest: String,
    /// Scratch space for a build, emptied before and after each.
    pub work: PathBuf,
    /// Free space each image's file system leaves for its sandboxes.
    pub free_bytes: u64,
    /// For the registry's token service, when pulls are not anonymous.
    pub credentials: Option<Credentials>,
}

impl PrepareConfig {
    /// Builds with the guest programs in `guest`, in scratch space under
    /// the state root `root`, leaving each image 4 GiB free.
    ///
    /// # Errors
    ///
    /// When the guest programs cannot be read.
    pub fn new(
        root: &Path,
        guest: PathBuf,
        credentials: Option<Credentials>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            guest_digest: compute_image::assemble::guest_digest(&guest)?,
            guest,
            work: crate::layout::prepare_dir(root),
            free_bytes: 4 << 30,
            credentials,
        })
    }
}

impl PrepareConfig {
    /// Builds with the guest programs in `guest`, if given, as
    /// [`PrepareConfig::new`] says, pulling as `registry_user` (see
    /// [`super::registry_credentials`]).
    ///
    /// # Errors
    ///
    /// When a user is given without a token, or the guest programs cannot
    /// be read.
    pub fn of(
        root: &Path,
        guest: Option<PathBuf>,
        registry_user: Option<String>,
    ) -> anyhow::Result<Option<Self>> {
        let Some(guest) = guest else {
            return Ok(None);
        };
        let credentials = super::registry_credentials(registry_user)?;
        Self::new(root, guest, credentials).map(Some)
    }
}

/// An image built and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// Its id, which creates name it by.
    pub image: ImageId,
    /// The digest of the image manifest built.
    pub digest: String,
    /// The digest of the guest programs it was built with.
    pub guest: String,
}

/// How an ask stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Progress {
    /// The build is under way, or waits for the one before it.
    Preparing,
    /// The image is stored.
    Prepared(Prepared),
}

/// Why an image was not prepared.
#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    /// The request names no image pinned by digest.
    #[error("{0}")]
    Invalid(String),
    /// This host builds no images.
    #[error("this host cannot build images: {0}")]
    Unavailable(&'static str),
    /// The build or the store failed.
    #[error("building {image}: {message}")]
    Failed {
        /// The OCI image asked for.
        image: String,
        /// What failed.
        message: String,
    },
}

/// What a store of an image the host keeps came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stored {
    /// The store holds it.
    Done,
    /// The host no longer keeps it (disk relief removed it): it is built
    /// again.
    NotKept,
}

/// What builds images and stores them.
pub(crate) trait Builds: Send + Sync + 'static {
    /// Builds the image of `reference` and keeps it on this host: its id
    /// and the manifest digest built, or what failed. With `before`, an
    /// image built earlier that this host keeps, the build changes a copy
    /// of it (ADR 40).
    fn build(
        &self,
        reference: Reference,
        before: Option<ImageId>,
    ) -> BoxFuture<'_, Result<(ImageId, String), String>>;

    /// Stores the image `image` this host keeps, or tells what failed.
    fn store(&self, image: ImageId) -> BoxFuture<'_, Result<Stored, String>>;
}

/// Where an ask's build stands.
#[derive(Debug)]
enum Standing {
    Running,
    /// Built and kept on this host, but not stored yet: the store is tried
    /// again in the background. `asked` is when it was last asked for.
    Storing {
        prepared: Prepared,
        asked: Instant,
    },
    /// Stored at `stored`, and the answer until [`TOLD_FOR`] after.
    Done {
        prepared: Prepared,
        stored: Instant,
    },
    Failed(String),
}

impl Standing {
    fn done(prepared: Prepared) -> Self {
        Self::Done {
            prepared,
            stored: Instant::now(),
        }
    }
}

/// Builds a host's images, one at a time.
pub(crate) struct Preparer {
    builder: Arc<dyn Builds>,
    /// The digest of the guest programs every build gets.
    guest: String,
    /// Each OCI image asked for, by the text asked with.
    builds: Mutex<HashMap<String, Standing>>,
    /// Held through each build, so builds run one at a time.
    turn: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Preparer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Preparer").finish_non_exhaustive()
    }
}

impl Preparer {
    /// Builds into `store`, as `config` says, keeping what it builds in
    /// `rootfs`.
    pub(crate) fn new<S: Store>(config: PrepareConfig, store: Arc<S>, rootfs: Arc<Cache>) -> Self {
        let guest = config.guest_digest.clone();
        Self::with(
            Arc::new(Builder {
                config,
                store,
                rootfs,
            }),
            guest,
        )
    }

    /// What builds the images a host asks for as `config` says, into
    /// `store`, keeping them in `rootfs`: nothing without a config, or
    /// without a store to keep them.
    pub(crate) fn of<S: Store>(
        config: Option<PrepareConfig>,
        store: &Arc<S>,
        rootfs: &Arc<Cache>,
    ) -> Option<Arc<Self>> {
        let config = config.filter(|_| store.is_configured())?;
        Some(Arc::new(Self::new(
            config,
            Arc::clone(store),
            Arc::clone(rootfs),
        )))
    }

    /// Builds with `builder`, which builds with the guest programs of
    /// digest `guest`.
    fn with(builder: Arc<dyn Builds>, guest: String) -> Self {
        Self {
            builder,
            guest,
            builds: Mutex::default(),
            turn: tokio::sync::Mutex::default(),
        }
    }

    /// How the sandbox image of the OCI image `image` stands, starting its
    /// build if nothing has, or if the last one failed and was told. A
    /// build starts from `before`, the image creates of its name start from
    /// now, when this host keeps it (ADR 40).
    pub(crate) fn prepare(
        self: &Arc<Self>,
        image: &str,
        before: Option<ImageId>,
    ) -> Result<Progress, PrepareError> {
        let reference = Reference::parse(image).map_err(PrepareError::Invalid)?;
        if reference.digest.is_none() {
            return Err(PrepareError::Invalid(format!(
                "{image:?} is not pinned by digest (`…@sha256:<hex>`)"
            )));
        }
        let mut builds = self.builds.lock().unwrap_or_else(PoisonError::into_inner);
        match builds.remove(image) {
            Some(Standing::Failed(message)) => {
                return Err(PrepareError::Failed {
                    image: image.to_owned(),
                    message,
                });
            }
            Some(Standing::Done { prepared, stored }) if stored.elapsed() < TOLD_FOR => {
                let progress = Progress::Prepared(prepared.clone());
                builds.insert(image.to_owned(), Standing::Done { prepared, stored });
                return Ok(progress);
            }
            // Stored too long ago to say the store still holds it: built
            // again.
            Some(Standing::Done { .. }) | None => {}
            Some(Standing::Running) => {
                builds.insert(image.to_owned(), Standing::Running);
                return Ok(Progress::Preparing);
            }
            Some(Standing::Storing { prepared, .. }) => {
                // Built here: its store is being tried again, which this
                // ask keeps going.
                let asked = Instant::now();
                builds.insert(image.to_owned(), Standing::Storing { prepared, asked });
                return Ok(Progress::Preparing);
            }
        }
        builds.insert(image.to_owned(), Standing::Running);
        drop(builds);
        let this = Arc::clone(self);
        let image = image.to_owned();
        tokio::spawn(async move {
            let standing = this.build(reference, before, &image).await;
            let unstored = match &standing {
                Standing::Storing { prepared, .. } => Some(prepared.clone()),
                _ => None,
            };
            this.builds
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(image.clone(), standing);
            if let Some(prepared) = unstored {
                this.store_later(&image, prepared).await;
            }
        });
        Ok(Progress::Preparing)
    }

    /// Builds `reference` in its turn and stores it.
    async fn build(&self, reference: Reference, before: Option<ImageId>, image: &str) -> Standing {
        let _turn = self.turn.lock().await;
        tracing::info!(%image, before = ?before.map(|id| id.to_string()), "building a sandbox image");
        let started = std::time::Instant::now();
        let (id, digest) = match self.builder.build(reference, before).await {
            Ok(built) => built,
            Err(message) => {
                tracing::warn!(%image, %message, "building a sandbox image failed");
                return Standing::Failed(message);
            }
        };
        let prepared = Prepared {
            image: id,
            digest,
            guest: self.guest.clone(),
        };
        match self.builder.store(id).await {
            Ok(Stored::Done) => {
                tracing::info!(
                    %image,
                    %id,
                    digest = %prepared.digest,
                    seconds = started.elapsed().as_secs_f64(),
                    "built and stored a sandbox image"
                );
                Standing::done(prepared)
            }
            Ok(Stored::NotKept) => {
                tracing::warn!(%image, %id, "a sandbox image was removed before it was stored");
                Standing::Failed(not_kept(id))
            }
            Err(message) => {
                tracing::warn!(
                    %image,
                    %id,
                    %message,
                    retry_in_s = STORE_AGAIN_AFTER.as_secs(),
                    "storing a built sandbox image failed; the host keeps it and tries again"
                );
                Standing::Storing {
                    prepared,
                    asked: Instant::now(),
                }
            }
        }
    }

    /// Tries the store of the built image `prepared` of the OCI image
    /// `image` again, with pauses that double, until it is stored, the host
    /// no longer keeps it, or no one asks for it any more.
    async fn store_later(&self, image: &str, prepared: Prepared) {
        let id = prepared.image;
        let mut pause = STORE_AGAIN_AFTER;
        let mut tries: u32 = 1;
        loop {
            tokio::time::sleep(pause).await;
            if !self.still_storing(image) {
                return;
            }
            tries += 1;
            match self.builder.store(id).await {
                Ok(Stored::Done) => {
                    tracing::info!(%image, %id, tries, "stored a sandbox image built earlier");
                    self.settle(image, Standing::done(prepared));
                    return;
                }
                Ok(Stored::NotKept) => {
                    tracing::warn!(%image, %id, tries, "a built sandbox image was removed before it was stored; it is built again");
                    self.settle(image, Standing::Failed(not_kept(id)));
                    return;
                }
                Err(message) => {
                    pause = (pause * 2).min(STORE_AGAIN_MOST);
                    tracing::warn!(
                        %image,
                        %id,
                        %message,
                        tries,
                        retry_in_s = pause.as_secs(),
                        "storing a built sandbox image failed again; the host keeps it and tries again"
                    );
                }
            }
        }
    }

    /// Whether the image of `image` is still to be stored: built, not
    /// stored, and asked for lately. One no one asked for lately is
    /// forgotten, and stays on the host only as a cached image.
    fn still_storing(&self, image: &str) -> bool {
        let mut builds = self.builds.lock().unwrap_or_else(PoisonError::into_inner);
        match builds.get(image) {
            Some(Standing::Storing { asked, .. }) if asked.elapsed() < UNASKED_AFTER => true,
            Some(Standing::Storing { prepared, .. }) => {
                tracing::info!(
                    %image,
                    id = %prepared.image,
                    "a built sandbox image not stored is no longer asked for; no longer trying to store it"
                );
                builds.remove(image);
                false
            }
            _ => false,
        }
    }

    /// Makes `standing` the answer for `image`, if its store was still
    /// being tried.
    fn settle(&self, image: &str, standing: Standing) {
        let mut builds = self.builds.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(builds.get(image), Some(Standing::Storing { .. })) {
            builds.insert(image.to_owned(), standing);
        }
    }
}

/// Why an image built but removed before it was stored is built again.
fn not_kept(id: ImageId) -> String {
    format!("the image built ({id}) was removed from this host before it was stored")
}

/// Where built and captured images go: the host's store.
pub(crate) trait Keeps: Send + Sync + 'static {
    fn keep<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Option<ImageId>, EngineError>>;
}

impl<S: Store> Keeps for S {
    fn keep<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Option<ImageId>, EngineError>> {
        Box::pin(self.put_image(path))
    }
}

/// Builds images with the host's guest programs, keeps them in its cache
/// of images and stores them in its store.
struct Builder<K: ?Sized> {
    config: PrepareConfig,
    store: Arc<K>,
    rootfs: Arc<Cache>,
}

impl<K: Keeps> Builds for Builder<K> {
    fn build(
        &self,
        reference: Reference,
        before: Option<ImageId>,
    ) -> BoxFuture<'_, Result<(ImageId, String), String>> {
        Box::pin(async move {
            let work = &self.config.work;
            let made = self.make(reference, before).await;
            if let Err(error) = empty(work).await {
                tracing::warn!(%error, "emptying the image build's scratch space failed");
            }
            made
        })
    }

    fn store(&self, image: ImageId) -> BoxFuture<'_, Result<Stored, String>> {
        Box::pin(async move {
            // Held through the store, so disk relief leaves it meanwhile.
            let Some(held) = self.rootfs.hold(image).await else {
                return Ok(Stored::NotKept);
            };
            match self.store.keep(&held.path).await {
                Ok(Some(stored)) if stored == image => Ok(Stored::Done),
                Ok(Some(stored)) => {
                    Err(format!("the image kept as {image} was stored as {stored}"))
                }
                Ok(None) => Err("the host's store keeps no images".to_owned()),
                Err(error) => Err(error.to_string()),
            }
        })
    }
}

impl<K: Keeps> Builder<K> {
    /// Builds the image of `reference` in emptied scratch space and keeps
    /// it in the host's cache of images: over a copy of `before` if this
    /// host keeps it, which it holds meanwhile so disk relief leaves it.
    async fn make(
        &self,
        reference: Reference,
        before: Option<ImageId>,
    ) -> Result<(ImageId, String), String> {
        empty(&self.config.work).await?;
        let output = self.config.work.join("image.ext4");
        let held = match before {
            Some(before) => self.rootfs.hold(before).await,
            None => None,
        };
        if let (Some(before), None) = (before, &held) {
            tracing::info!(%before, "the image before is not on this host; building a new file system");
        }
        let build = Build {
            reference,
            credentials: self.config.credentials.clone(),
            guest: self.config.guest.clone(),
            work: self.config.work.join("work"),
            output: output.clone(),
            free_bytes: self.config.free_bytes,
            before: held.as_ref().map(|held| held.path.clone()),
        };
        let made = compute_image::build(&build)
            .await
            .map_err(|error| format!("{error:#}"))?;
        drop(held);
        tracing::info!(
            over_before = made.over_before,
            size = made.size_bytes,
            pull_s = made.pull_seconds,
            unpack_s = made.unpack_seconds,
            ext4_s = made.ext4_seconds,
            "made a sandbox image"
        );
        let id = file_id(&output).await.map_err(|error| error.to_string())?;
        self.rootfs
            .adopt(id, &output)
            .await
            .map_err(|error| format!("keeping the image built: {error}"))?;
        Ok((id, made.manifest_digest))
    }
}

/// Makes `dir` an empty directory.
async fn empty(dir: &Path) -> Result<(), String> {
    let dir = dir.to_owned();
    tokio::task::spawn_blocking(move || {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::create_dir_all(&dir)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("the scratch space: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Semaphore;

    use super::*;
    use crate::state::Ownership;
    use crate::store::Directory;

    const PINNED: &str = "registry.example/sandbox@sha256:\
        0000000000000000000000000000000000000000000000000000000000000001";
    const OTHER: &str = "registry.example/desktop@sha256:\
        0000000000000000000000000000000000000000000000000000000000000002";
    const GUEST: &str = "sha256:\
        00000000000000000000000000000000000000000000000000000000000000ee";

    /// Builds only when let, each build failing while `fail` is set. Its
    /// store refuses the next `refuse` stores, as object storage that
    /// refuses writes does, and finds the image gone once `kept` is unset.
    struct Fake {
        go: Semaphore,
        started: AtomicUsize,
        running: AtomicUsize,
        most_at_once: AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
        refuse: Mutex<usize>,
        kept: std::sync::atomic::AtomicBool,
        /// When each store was tried.
        stores: Mutex<Vec<Instant>>,
    }

    impl Default for Fake {
        fn default() -> Self {
            Self {
                go: Semaphore::new(0),
                started: AtomicUsize::default(),
                running: AtomicUsize::default(),
                most_at_once: AtomicUsize::default(),
                fail: std::sync::atomic::AtomicBool::default(),
                refuse: Mutex::default(),
                kept: std::sync::atomic::AtomicBool::new(true),
                stores: Mutex::default(),
            }
        }
    }

    impl Fake {
        /// The pauses between the stores tried so far, in seconds.
        fn pauses(&self) -> Vec<u64> {
            let stores = self.stores.lock().unwrap();
            stores
                .windows(2)
                .map(|pair| (pair[1] - pair[0]).as_secs())
                .collect()
        }

        fn stores(&self) -> usize {
            self.stores.lock().unwrap().len()
        }
    }

    impl Builds for Fake {
        fn build(
            &self,
            reference: Reference,
            _before: Option<ImageId>,
        ) -> BoxFuture<'_, Result<(ImageId, String), String>> {
            Box::pin(async move {
                let n = self.started.fetch_add(1, Ordering::SeqCst);
                let running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
                self.most_at_once.fetch_max(running, Ordering::SeqCst);
                self.go.acquire().await.unwrap().forget();
                self.running.fetch_sub(1, Ordering::SeqCst);
                if self.fail.load(Ordering::SeqCst) {
                    return Err("the registry refused".into());
                }
                let mut id = [0; 32];
                id[0] = u8::try_from(n + 1).unwrap();
                Ok((ImageId(id), reference.digest.unwrap()))
            })
        }

        fn store(&self, _image: ImageId) -> BoxFuture<'_, Result<Stored, String>> {
            Box::pin(async move {
                self.stores.lock().unwrap().push(Instant::now());
                if !self.kept.load(Ordering::SeqCst) {
                    return Ok(Stored::NotKept);
                }
                let mut refuse = self.refuse.lock().unwrap();
                if *refuse > 0 {
                    *refuse -= 1;
                    return Err(
                        "archive failed: Error performing PUT: error sending request".into(),
                    );
                }
                Ok(Stored::Done)
            })
        }
    }

    fn preparer() -> (Arc<Fake>, Arc<Preparer>) {
        let fake = Arc::new(Fake::default());
        let builder: Arc<dyn Builds> = fake.clone();
        (fake, Arc::new(Preparer::with(builder, GUEST.to_owned())))
    }

    /// Asks until the answer is no longer that the build is under way.
    async fn settled(preparer: &Arc<Preparer>, image: &str) -> Result<Progress, PrepareError> {
        loop {
            match preparer.prepare(image, None) {
                Ok(Progress::Preparing) => tokio::task::yield_now().await,
                other => return other,
            }
        }
    }

    /// Asks every five seconds, as the control service does, until the
    /// answer is no longer that the build is under way.
    async fn asked_until_settled(
        preparer: &Arc<Preparer>,
        image: &str,
    ) -> Result<Progress, PrepareError> {
        loop {
            match preparer.prepare(image, None) {
                Ok(Progress::Preparing) => tokio::time::sleep(Duration::from_secs(5)).await,
                other => return other,
            }
        }
    }

    /// Object storage refusing writes while a release's image is built:
    /// the build is kept, every ask meanwhile hears it is under way (so
    /// creates go on from the image before), the store is tried again with
    /// pauses that double, and once the store takes writes the image is
    /// stored and answered without being built again.
    #[tokio::test(start_paused = true)]
    async fn a_build_the_store_refuses_is_kept_and_stored_later_without_building_again() {
        let (fake, preparer) = preparer();
        *fake.refuse.lock().unwrap() = 4;
        fake.go.add_permits(1);
        let Progress::Prepared(stored) = asked_until_settled(&preparer, PINNED).await.unwrap()
        else {
            unreachable!()
        };
        assert_eq!(fake.started.load(Ordering::SeqCst), 1, "built once");
        assert_eq!(stored.image.0[0], 1, "the first build's image");
        assert_eq!(fake.stores(), 5, "stored at the fifth try");
        assert_eq!(fake.pauses(), [30, 60, 120, 240]);
        assert_eq!(
            preparer.prepare(PINNED, None).unwrap(),
            Progress::Prepared(stored)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_pause_between_tries_of_a_refused_store_stops_growing() {
        let (fake, preparer) = preparer();
        *fake.refuse.lock().unwrap() = usize::MAX;
        fake.go.add_permits(1);
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        for _ in 0..(20 * 60 / 5) {
            tokio::time::sleep(Duration::from_secs(5)).await;
            assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        }
        assert_eq!(fake.pauses(), [30, 60, 120, 240, 480]);
        for _ in 0..(30 * 60 / 5) {
            tokio::time::sleep(Duration::from_secs(5)).await;
            assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        }
        assert_eq!(fake.pauses()[5..], [600, 600, 600]);
        assert_eq!(fake.started.load(Ordering::SeqCst), 1, "never built again");
    }

    /// A built image no one asks for any more (a later release names
    /// another) is not tried for ever: tries stop, and a later ask builds
    /// it again.
    #[tokio::test(start_paused = true)]
    async fn tries_stop_once_no_one_asks_for_the_image() {
        let (fake, preparer) = preparer();
        *fake.refuse.lock().unwrap() = usize::MAX;
        fake.go.add_permits(1);
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        tokio::time::sleep(UNASKED_AFTER + STORE_AGAIN_MOST * 2).await;
        let tried = fake.stores();
        tokio::time::sleep(Duration::from_secs(4 * 3600)).await;
        assert_eq!(fake.stores(), tried, "no tries once unasked");

        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(fake.started.load(Ordering::SeqCst), 2, "built again");
    }

    /// When disk relief removed the copy a refused store kept, the next
    /// ask hears the build failed and the one after builds it again.
    #[tokio::test(start_paused = true)]
    async fn a_kept_build_removed_before_it_was_stored_is_built_again() {
        let (fake, preparer) = preparer();
        *fake.refuse.lock().unwrap() = 1;
        fake.kept.store(true, Ordering::SeqCst);
        fake.go.add_permits(1);
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        while fake.stores() < 1 {
            tokio::task::yield_now().await;
        }
        fake.kept.store(false, Ordering::SeqCst);
        let failed = asked_until_settled(&preparer, PINNED).await;
        let Err(PrepareError::Failed { message, .. }) = failed else {
            panic!("{failed:?}")
        };
        assert!(message.contains("removed from this host"), "{message}");
        fake.kept.store(true, Ordering::SeqCst);
        fake.go.add_permits(1);
        assert!(matches!(
            asked_until_settled(&preparer, PINNED).await,
            Ok(Progress::Prepared(_))
        ));
        assert_eq!(fake.started.load(Ordering::SeqCst), 2, "built again");
    }

    /// The host's own store, on object storage that refuses writes: the
    /// built image stays on the host, which serves it, and is stored once
    /// writes are taken again.
    #[tokio::test]
    async fn the_host_keeps_its_build_while_its_store_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = Arc::new(
            Cache::open(
                dir.path().join("rootfs"),
                Duration::from_secs(7 * 86_400),
                Ownership::detached(),
            )
            .unwrap(),
        );
        let work = dir.path().join("prepare");
        std::fs::create_dir_all(&work).unwrap();
        let built = work.join("image.ext4");
        std::fs::write(&built, b"a built image").unwrap();
        let id = file_id(&built).await.unwrap();
        rootfs.adopt(id, &built).await.unwrap();
        assert!(!built.exists(), "moved, not copied");

        // Nothing can be written under a store whose root is a file.
        let root = dir.path().join("store");
        std::fs::write(&root, b"").unwrap();
        let builder = Builder {
            config: PrepareConfig {
                guest: dir.path().join("guest"),
                guest_digest: GUEST.to_owned(),
                work,
                free_bytes: 0,
                credentials: None,
            },
            store: Arc::new(Directory::new(root.clone())),
            rootfs: Arc::clone(&rootfs),
        };
        assert!(builder.store(id).await.is_err());
        assert!(rootfs.has(id), "kept for the next try");
        let held = rootfs.hold(id).await.expect("served by this host");
        assert_eq!(std::fs::read(&held.path).unwrap(), b"a built image");
        drop(held);

        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert_eq!(builder.store(id).await, Ok(Stored::Done));
        let elsewhere = Cache::open(
            dir.path().join("elsewhere"),
            Duration::from_secs(7 * 86_400),
            Ownership::detached(),
        )
        .unwrap();
        assert!(elsewhere.get(id, &*builder.store).await.is_ok(), "stored");

        // Disk relief may remove the host's copy, which is built again.
        assert!(rootfs.remove(id).await);
        assert_eq!(builder.store(id).await, Ok(Stored::NotKept));
    }

    #[tokio::test]
    async fn an_image_not_pinned_by_digest_is_refused() {
        let (fake, preparer) = preparer();
        let refused = preparer.prepare("registry.example/sandbox:latest", None);
        assert!(
            matches!(refused, Err(PrepareError::Invalid(_))),
            "{refused:?}"
        );
        assert_eq!(fake.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn asks_during_a_build_hear_it_is_under_way_and_later_ones_get_its_image() {
        let (fake, preparer) = preparer();
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        for _ in 0..5 {
            tokio::task::yield_now().await;
            assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        }
        fake.go.add_permits(1);
        let Progress::Prepared(stored) = settled(&preparer, PINNED).await.unwrap() else {
            unreachable!()
        };
        assert_eq!(stored.digest, PINNED.split_once('@').unwrap().1);
        assert_eq!(stored.guest, GUEST, "told with the guest programs it got");
        for _ in 0..3 {
            assert_eq!(
                preparer.prepare(PINNED, None).unwrap(),
                Progress::Prepared(stored.clone())
            );
        }
        assert_eq!(fake.started.load(Ordering::SeqCst), 1, "built once");
    }

    /// The control service forgets a stored image nothing uses, and asks
    /// again when a name next uses its OCI image: by then the store may
    /// not hold what this host stored, so it builds a new image.
    #[tokio::test(start_paused = true)]
    async fn an_image_stored_long_ago_is_built_again_when_asked_for() {
        let (fake, preparer) = preparer();
        fake.go.add_permits(1);
        let first = settled(&preparer, PINNED).await.unwrap();
        tokio::time::sleep(TOLD_FOR / 2).await;
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), first, "still told");
        assert_eq!(fake.started.load(Ordering::SeqCst), 1);

        tokio::time::sleep(TOLD_FOR / 2).await;
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        fake.go.add_permits(1);
        let again = settled(&preparer, PINNED).await.unwrap();
        assert_ne!(again, first, "a new image");
        assert_eq!(fake.started.load(Ordering::SeqCst), 2, "built again");
        assert_eq!(fake.stores(), 2, "and stored anew");
    }

    #[tokio::test]
    async fn a_failed_build_is_told_once_and_the_next_ask_builds_again() {
        let (fake, preparer) = preparer();
        fake.fail.store(true, Ordering::SeqCst);
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        fake.go.add_permits(1);
        let failed = settled(&preparer, PINNED).await;
        let Err(PrepareError::Failed { image, message }) = failed else {
            panic!("{failed:?}")
        };
        assert_eq!(
            (image.as_str(), message.as_str()),
            (PINNED, "the registry refused")
        );

        fake.fail.store(false, Ordering::SeqCst);
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        fake.go.add_permits(1);
        assert!(matches!(
            settled(&preparer, PINNED).await,
            Ok(Progress::Prepared(_))
        ));
        assert_eq!(fake.started.load(Ordering::SeqCst), 2, "built again");
    }

    #[tokio::test]
    async fn images_are_built_one_at_a_time() {
        let (fake, preparer) = preparer();
        assert_eq!(preparer.prepare(PINNED, None).unwrap(), Progress::Preparing);
        assert_eq!(preparer.prepare(OTHER, None).unwrap(), Progress::Preparing);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(fake.started.load(Ordering::SeqCst), 1, "the second waits");
        fake.go.add_permits(2);
        let first = settled(&preparer, PINNED).await.unwrap();
        let second = settled(&preparer, OTHER).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(fake.most_at_once.load(Ordering::SeqCst), 1);
    }
}
