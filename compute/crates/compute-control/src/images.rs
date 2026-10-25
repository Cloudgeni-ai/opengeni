//! Stored images that follow releases (ADR 19). The service may be told,
//! for some of the fleet's image names, the OCI image pinned by digest that
//! a release's sandboxes of that name start from (`--image-source
//! name=registry/repository@sha256:…`). A replica that finds no stored
//! image recorded as built from it asks a live host to build one
//! ([`Request::Prepare`](compute_protocol::host::Request::Prepare)), asking
//! again until the host has, and records it; builds differ byte for byte,
//! so the first recorded is the one every replica uses. From then on
//! creates of the name start from it. Until then they start from the image
//! recorded under the name last, the release before's, or failing that
//! from the one `--stored-image` names. A rollback finds its release's
//! image recorded already.

use std::collections::BTreeMap;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use compute_protocol::host::ImageId;
use tokio::time::Instant;

use crate::service::Service;
use crate::store::Store;

/// How often a replica asks again while a build is under way, or while no
/// host is live to build on.
const ASK_EVERY: Duration = Duration::from_secs(5);
/// How long a replica waits after a failed ask before the next, which goes
/// to the next host.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// The images creates may name, by the fleet's names for them: the id of
/// each stored image, which hosts fetch by it, or `None` for the hosts'
/// own base image. Every copy of the settings shares it, so an image built
/// for a release takes effect at once.
#[derive(Clone, Debug, Default)]
pub struct Images(Arc<RwLock<BTreeMap<String, Option<ImageId>>>>);

impl Images {
    /// These images.
    #[must_use]
    pub fn new(images: BTreeMap<String, Option<ImageId>>) -> Self {
        Self(Arc::new(RwLock::new(images)))
    }

    /// The image named `name`, if there is one.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Option<ImageId>> {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .copied()
    }

    /// Makes `image` the stored image named `name`.
    pub fn set(&self, name: &str, image: ImageId) {
        self.0
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.to_owned(), Some(image));
    }
}

/// One source still without its image.
struct Pending {
    source: String,
    /// Which live host to ask, counting from the first by name: the same
    /// for every replica, so they ask one host, which builds once, until
    /// an ask fails.
    turn: usize,
    next_at: Instant,
}

/// Makes each name in `sources` start from the stored image built from its
/// OCI image, building it first if none was, then returns.
pub async fn follow<S: Store>(service: Arc<Service<S>>, sources: BTreeMap<String, String>) {
    let images = service.settings().images.clone();
    let store = Arc::clone(service.store());
    let mut pending = BTreeMap::new();
    for (name, source) in sources {
        match store.image_built(&source).await {
            Ok(Some(image)) => {
                images.set(&name, image);
                continue;
            }
            Ok(None) => {
                if let Ok(Some(image)) = store.latest_built(&name).await {
                    images.set(&name, image);
                }
            }
            Err(error) => tracing::warn!(%error, %name, "reading the image built failed"),
        }
        pending.insert(
            name,
            Pending {
                source,
                turn: 0,
                next_at: Instant::now(),
            },
        );
    }
    while !pending.is_empty() {
        let mut built = Vec::new();
        for (name, waiting) in &mut pending {
            if Instant::now() < waiting.next_at {
                continue;
            }
            match service
                .prepare_image(name, &waiting.source, waiting.turn)
                .await
            {
                Ok(Some(image)) => {
                    tracing::info!(%name, source = %waiting.source, %image, "new creates start from a newly built image");
                    images.set(name, image);
                    built.push(name.clone());
                }
                Ok(None) => waiting.next_at = Instant::now() + ASK_EVERY,
                Err(error) => {
                    tracing::warn!(%error, %name, source = %waiting.source, "building an image failed; asking another host");
                    waiting.turn = waiting.turn.wrapping_add(1);
                    waiting.next_at = Instant::now() + RETRY_AFTER;
                }
            }
        }
        for name in built {
            pending.remove(&name);
        }
        let next = pending.values().map(|waiting| waiting.next_at).min();
        if let Some(next) = next {
            tokio::time::sleep_until(next).await;
        }
    }
}
