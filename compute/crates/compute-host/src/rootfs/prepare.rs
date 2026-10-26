//! Sandbox images a host builds when the control service asks
//! ([`Request::Prepare`](crate::protocol::Request::Prepare)): from an OCI
//! image pinned by digest, with the host's guest programs, stored where its
//! sandboxes are kept. Builds are not byte for byte the same, so two hosts
//! building one OCI image store two images; the control service records
//! the first it is told of and creates use that one.
//!
//! An ask is answered at once, so no call stays open through a build that
//! takes minutes: the first starts the build and every ask until it ends
//! hears that it is under way. A host builds one image at a time, in
//! scratch space emptied before and after each build. Once stored, an
//! image is the answer to every later ask; a failed build is told to the
//! next ask, and the one after that builds again.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use compute_engine::EngineError;
use compute_image::{Build, Credentials, Reference};
use futures::future::BoxFuture;

use crate::protocol::ImageId;
use crate::store::Store;

/// How a host builds sandbox images.
#[derive(Clone, Debug)]
pub struct PrepareConfig {
    /// The guest programs every image gets: the directory `guest/build.sh`
    /// made, as a bundle's `guest/`.
    pub guest: PathBuf,
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
    #[must_use]
    pub fn new(root: &Path, guest: PathBuf, credentials: Option<Credentials>) -> Self {
        Self {
            guest,
            work: crate::layout::prepare_dir(root),
            free_bytes: 4 << 30,
            credentials,
        }
    }
}

impl PrepareConfig {
    /// Builds with the guest programs in `guest`, if given, as
    /// [`PrepareConfig::new`] says, pulling as `registry_user` (see
    /// [`super::registry_credentials`]).
    ///
    /// # Errors
    ///
    /// When a user is given without a token.
    pub fn of(
        root: &Path,
        guest: Option<PathBuf>,
        registry_user: Option<String>,
    ) -> anyhow::Result<Option<Self>> {
        let Some(guest) = guest else {
            return Ok(None);
        };
        let credentials = super::registry_credentials(registry_user)?;
        Ok(Some(Self::new(root, guest, credentials)))
    }
}

/// An image built and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// Its id, which creates name it by.
    pub image: ImageId,
    /// The digest of the image manifest built.
    pub digest: String,
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

/// What builds and stores one image: its id and the manifest digest
/// built, or what failed.
pub(crate) trait Builds: Send + Sync + 'static {
    fn build(&self, reference: Reference) -> BoxFuture<'_, Result<(ImageId, String), String>>;
}

/// Where an ask's build stands.
#[derive(Debug)]
enum Standing {
    Running,
    Done(Prepared),
    Failed(String),
}

/// Builds a host's images, one at a time.
pub(crate) struct Preparer {
    builder: Arc<dyn Builds>,
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
    /// Builds into `store`, as `config` says.
    pub(crate) fn new<S: Store>(config: PrepareConfig, store: Arc<S>) -> Self {
        Self::with(Arc::new(Builder { config, store }))
    }

    /// What builds the images a host asks for as `config` says, into
    /// `store`: nothing without a config, or without a store to keep them.
    pub(crate) fn of<S: Store>(config: Option<PrepareConfig>, store: &Arc<S>) -> Option<Arc<Self>> {
        let config = config.filter(|_| store.is_configured())?;
        Some(Arc::new(Self::new(config, Arc::clone(store))))
    }

    /// Builds with `builder`.
    fn with(builder: Arc<dyn Builds>) -> Self {
        Self {
            builder,
            builds: Mutex::default(),
            turn: tokio::sync::Mutex::default(),
        }
    }

    /// How the sandbox image of the OCI image `image` stands, starting its
    /// build if nothing has, or if the last one failed and was told.
    pub(crate) fn prepare(self: &Arc<Self>, image: &str) -> Result<Progress, PrepareError> {
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
            Some(Standing::Done(prepared)) => {
                let progress = Progress::Prepared(prepared.clone());
                builds.insert(image.to_owned(), Standing::Done(prepared));
                return Ok(progress);
            }
            Some(Standing::Running) => {
                builds.insert(image.to_owned(), Standing::Running);
                return Ok(Progress::Preparing);
            }
            None => {}
        }
        builds.insert(image.to_owned(), Standing::Running);
        drop(builds);
        let this = Arc::clone(self);
        let image = image.to_owned();
        tokio::spawn(async move {
            let standing = this.build(reference, &image).await;
            this.builds
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(image, standing);
        });
        Ok(Progress::Preparing)
    }

    /// Builds `reference` in its turn.
    async fn build(&self, reference: Reference, image: &str) -> Standing {
        let _turn = self.turn.lock().await;
        tracing::info!(%image, "building a sandbox image");
        let started = std::time::Instant::now();
        match self.builder.build(reference).await {
            Ok((id, digest)) => {
                tracing::info!(
                    %image,
                    %id,
                    %digest,
                    seconds = started.elapsed().as_secs_f64(),
                    "built and stored a sandbox image"
                );
                Standing::Done(Prepared { image: id, digest })
            }
            Err(message) => {
                tracing::warn!(%image, %message, "building a sandbox image failed");
                Standing::Failed(message)
            }
        }
    }
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

/// Builds images with the host's guest programs into its store.
struct Builder<K: ?Sized> {
    config: PrepareConfig,
    store: Arc<K>,
}

impl<K: Keeps> Builds for Builder<K> {
    fn build(&self, reference: Reference) -> BoxFuture<'_, Result<(ImageId, String), String>> {
        Box::pin(async move {
            let work = &self.config.work;
            let made = self.make(reference).await;
            if let Err(error) = empty(work).await {
                tracing::warn!(%error, "emptying the image build's scratch space failed");
            }
            made
        })
    }
}

impl<K: Keeps> Builder<K> {
    /// Builds the image of `reference` in emptied scratch space and stores
    /// it.
    async fn make(&self, reference: Reference) -> Result<(ImageId, String), String> {
        empty(&self.config.work).await?;
        let output = self.config.work.join("image.ext4");
        let build = Build {
            reference,
            credentials: self.config.credentials.clone(),
            guest: self.config.guest.clone(),
            work: self.config.work.join("work"),
            output: output.clone(),
            free_bytes: self.config.free_bytes,
        };
        let made = compute_image::build(&build)
            .await
            .map_err(|error| format!("{error:#}"))?;
        match self.store.keep(&output).await {
            Ok(Some(id)) => Ok((id, made.manifest_digest)),
            Ok(None) => Err("the host's store keeps no images".to_owned()),
            Err(error) => Err(error.to_string()),
        }
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

    const PINNED: &str = "registry.example/sandbox@sha256:\
        0000000000000000000000000000000000000000000000000000000000000001";
    const OTHER: &str = "registry.example/desktop@sha256:\
        0000000000000000000000000000000000000000000000000000000000000002";

    /// Builds only when let, each build failing while `fail` is set.
    struct Fake {
        go: Semaphore,
        started: AtomicUsize,
        running: AtomicUsize,
        most_at_once: AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
    }

    impl Default for Fake {
        fn default() -> Self {
            Self {
                go: Semaphore::new(0),
                started: AtomicUsize::default(),
                running: AtomicUsize::default(),
                most_at_once: AtomicUsize::default(),
                fail: std::sync::atomic::AtomicBool::default(),
            }
        }
    }

    impl Builds for Fake {
        fn build(&self, reference: Reference) -> BoxFuture<'_, Result<(ImageId, String), String>> {
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
    }

    fn preparer() -> (Arc<Fake>, Arc<Preparer>) {
        let fake = Arc::new(Fake::default());
        let builder: Arc<dyn Builds> = fake.clone();
        (fake, Arc::new(Preparer::with(builder)))
    }

    /// Asks until the answer is no longer that the build is under way.
    async fn settled(preparer: &Arc<Preparer>, image: &str) -> Result<Progress, PrepareError> {
        loop {
            match preparer.prepare(image) {
                Ok(Progress::Preparing) => tokio::task::yield_now().await,
                other => return other,
            }
        }
    }

    #[tokio::test]
    async fn an_image_not_pinned_by_digest_is_refused() {
        let (fake, preparer) = preparer();
        let refused = preparer.prepare("registry.example/sandbox:latest");
        assert!(
            matches!(refused, Err(PrepareError::Invalid(_))),
            "{refused:?}"
        );
        assert_eq!(fake.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn asks_during_a_build_hear_it_is_under_way_and_later_ones_get_its_image() {
        let (fake, preparer) = preparer();
        assert_eq!(preparer.prepare(PINNED).unwrap(), Progress::Preparing);
        for _ in 0..5 {
            tokio::task::yield_now().await;
            assert_eq!(preparer.prepare(PINNED).unwrap(), Progress::Preparing);
        }
        fake.go.add_permits(1);
        let Progress::Prepared(stored) = settled(&preparer, PINNED).await.unwrap() else {
            unreachable!()
        };
        assert_eq!(stored.digest, PINNED.split_once('@').unwrap().1);
        for _ in 0..3 {
            assert_eq!(
                preparer.prepare(PINNED).unwrap(),
                Progress::Prepared(stored.clone())
            );
        }
        assert_eq!(fake.started.load(Ordering::SeqCst), 1, "built once");
    }

    #[tokio::test]
    async fn a_failed_build_is_told_once_and_the_next_ask_builds_again() {
        let (fake, preparer) = preparer();
        fake.fail.store(true, Ordering::SeqCst);
        assert_eq!(preparer.prepare(PINNED).unwrap(), Progress::Preparing);
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
        assert_eq!(preparer.prepare(PINNED).unwrap(), Progress::Preparing);
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
        assert_eq!(preparer.prepare(PINNED).unwrap(), Progress::Preparing);
        assert_eq!(preparer.prepare(OTHER).unwrap(), Progress::Preparing);
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
