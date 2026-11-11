//! Stored images that follow releases (ADR 19). The service may be told,
//! for some of the fleet's image names, the OCI image pinned by digest that
//! a release's sandboxes of that name start from (`--image-source
//! name=registry/repository@sha256:…`). An image is built from that and
//! the guest programs of the host that builds it (`compute-guest`, envd,
//! bash), so a release's images are the ones built with the programs most
//! live hosts have ([`Service::fleet_guest`]): a host upgrade that changes
//! them has the release's images built again, and only such an upgrade
//! does. A replica that finds no stored image recorded as built from both
//! ([`built_key`]) asks a live host with those programs to build one
//! ([`Request::Prepare`](compute_protocol::host::Request::Prepare)), asking
//! again until the host has, and records it; builds differ byte for byte,
//! so the first recorded is the one every replica uses. From then on
//! creates of the name start from it. Until then they start from the first
//! image built from the OCI image with any programs (a rollback's), or
//! else the image recorded under the name last, the release before's, or
//! failing that the one `--stored-image` names. A replica keeps looking
//! for as long as it runs.

use std::collections::BTreeMap;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use compute_protocol::host::ImageId;
use tokio::time::Instant;

use crate::service::Service;
use crate::service::now_ms;
use crate::store::Store;

/// How often a replica looks again at what each name should start from,
/// and asks again while a build is under way, or while no host with the
/// fleet's guest programs is live to build on.
const ASK_EVERY: Duration = Duration::from_secs(5);
/// How long a replica waits after a failed ask before the next, which goes
/// to the next host.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// What the store records an image built from the OCI image `source`
/// with the guest programs of digest `guest` under, as a host's base
/// image is named (`deploy/host/install.sh`): `<source> guest-<digest>`.
/// With no digest, `source` alone: an image a host of an earlier release
/// built, or the first built from `source` with any programs, which is
/// recorded under it too.
#[must_use]
pub fn built_key(source: &str, guest: Option<&str>) -> String {
    match guest {
        Some(guest) => format!("{source} guest-{guest}"),
        None => source.to_owned(),
    }
}

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

    /// Whether some name names `image`.
    #[must_use]
    pub fn names(&self, image: ImageId) -> bool {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .any(|named| *named == Some(image))
    }
}

/// One name's source, and how far the name's image follows it.
struct Followed {
    source: String,
    /// What the image the name starts from is recorded under
    /// ([`built_key`]), once it is one of the source's.
    built: Option<String>,
    /// Which live host to ask, counting from the first by name of those
    /// with the fleet's guest programs: the same for every replica, so
    /// they ask one host, which builds once, until an ask fails. It starts
    /// at [`first_turn`], so different sources build on different hosts.
    turn: usize,
    next_at: Instant,
}

/// Which turn the asks to build `source` start at: the same for every
/// replica, of any release (from the source's BLAKE3 hash), and spread
/// over sources, so a release's images, or all of them again for new
/// guest programs, build on several hosts at once rather than one after
/// another on one.
fn first_turn(source: &str) -> usize {
    let hash = blake3::hash(source.as_bytes());
    let [a, b, c, d, ..] = *hash.as_bytes();
    usize::try_from(u32::from_le_bytes([a, b, c, d])).unwrap_or_default()
}

/// Keeps each name in `sources` starting from the stored image built from
/// its OCI image with the fleet's guest programs, building it when none
/// was, for as long as it runs.
pub async fn follow<S: Store>(service: Arc<Service<S>>, sources: BTreeMap<String, String>) {
    if sources.is_empty() {
        return;
    }
    let images = service.settings().images.clone();
    let store = Arc::clone(service.store());
    let guest = service.fleet_guest();
    let mut followed = BTreeMap::new();
    for (name, source) in sources {
        let built = start(&*store, &images, &name, &source, guest.as_deref()).await;
        followed.insert(
            name,
            Followed {
                turn: first_turn(&source),
                source,
                built,
                next_at: Instant::now(),
            },
        );
    }
    loop {
        let guest = service.fleet_guest();
        for (name, following) in &mut followed {
            let key = built_key(&following.source, guest.as_deref());
            if following.built.as_ref() == Some(&key) || Instant::now() < following.next_at {
                continue;
            }
            match service
                .prepare_image(name, &following.source, guest.as_deref(), following.turn)
                .await
            {
                Ok(Some(image)) => {
                    tracing::info!(
                        %name,
                        source = %following.source,
                        guest = guest.as_deref().unwrap_or("unknown"),
                        %image,
                        "new creates start from the image built with the fleet's guest programs"
                    );
                    images.set(name, image);
                    following.built = Some(key);
                }
                Ok(None) => following.next_at = Instant::now() + ASK_EVERY,
                Err(error) => {
                    tracing::warn!(%error, %name, source = %following.source, "building an image failed; asking another host");
                    following.turn = following.turn.wrapping_add(1);
                    following.next_at = Instant::now() + RETRY_AFTER;
                }
            }
        }
        tokio::time::sleep(ASK_EVERY).await;
    }
}

/// Has the name `name` start at once from an image recorded for its OCI
/// image `source`: the one built with the guest programs `guest`, or else
/// the first built with any (while one with `guest`'s is built), or else
/// the image recorded under the name last. Answers what the image it
/// starts from is recorded under, if it is one of `source`'s.
async fn start<S: Store>(
    store: &S,
    images: &Images,
    name: &str,
    source: &str,
    guest: Option<&str>,
) -> Option<String> {
    let wanted = built_key(source, guest);
    let any = built_key(source, None);
    let keys = if wanted == any {
        vec![wanted]
    } else {
        vec![wanted, any]
    };
    for key in keys {
        match store.image_built(&key).await {
            Ok(Some(image)) => {
                images.set(name, image);
                // Built for another name, or before: this name uses it now,
                // so it is this name's to fall back on later too.
                return match store.record_built(&key, name, image, now_ms()).await {
                    Ok(_) => Some(key),
                    Err(error) => {
                        // Used meanwhile; recorded at the next ask.
                        tracing::warn!(%error, %name, "recording the image's use failed");
                        None
                    }
                };
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, %name, "reading the image built failed"),
        }
    }
    if let Ok(Some(image)) = store.latest_built(name).await {
        images.set(name, image);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;

    const SOURCE: &str = "registry.example/sandbox@sha256:\
        00000000000000000000000000000000000000000000000000000000000000aa";
    const NEXT: &str = "registry.example/sandbox@sha256:\
        00000000000000000000000000000000000000000000000000000000000000bb";
    const OLD: &str = "sha256:11";
    const NEW: &str = "sha256:22";

    #[test]
    fn a_build_is_recorded_as_a_host_s_base_image_is_named() {
        assert_eq!(
            built_key(SOURCE, Some(NEW)),
            format!("{SOURCE} guest-sha256:22")
        );
        assert_eq!(built_key(SOURCE, None), SOURCE);
    }

    #[test]
    fn asks_start_at_a_turn_every_release_agrees_on_and_spread_over_sources() {
        // Pinned: replicas of different releases ask the same host.
        assert_eq!(first_turn(SOURCE), 160_453_724);
        let hosts: std::collections::BTreeSet<usize> = [SOURCE, NEXT, "a", "b", "c"]
            .iter()
            .map(|source| first_turn(source) % 2)
            .collect();
        assert_eq!(hosts.len(), 2, "two hosts share the builds");
    }

    /// A rollback to a release whose image was built only with an earlier
    /// bundle's guest programs starts from that image at once, not from the
    /// later release's the name used last, while it is built again.
    #[tokio::test]
    async fn a_name_starts_at_once_from_its_source_s_image_with_any_programs() {
        let store = MemoryStore::new();
        let (first, later, rebuilt) = (ImageId([1; 32]), ImageId([2; 32]), ImageId([3; 32]));
        for key in [built_key(SOURCE, None), built_key(SOURCE, Some(OLD))] {
            store.record_built(&key, "sandbox", first, 1).await.unwrap();
        }
        store
            .record_built(&built_key(NEXT, Some(NEW)), "sandbox", later, 2)
            .await
            .unwrap();

        let images = Images::default();
        let started = start(&store, &images, "sandbox", SOURCE, Some(NEW)).await;
        assert_eq!(started.as_deref(), Some(SOURCE), "not yet the fleet's");
        assert_eq!(images.get("sandbox"), Some(Some(first)));

        store
            .record_built(&built_key(SOURCE, Some(NEW)), "sandbox", rebuilt, 3)
            .await
            .unwrap();
        let started = start(&store, &images, "sandbox", SOURCE, Some(NEW)).await;
        assert_eq!(started, Some(built_key(SOURCE, Some(NEW))));
        assert_eq!(images.get("sandbox"), Some(Some(rebuilt)));

        let fresh = Images::default();
        let other = "registry.example/sandbox@sha256:\
            00000000000000000000000000000000000000000000000000000000000000cc";
        assert_eq!(
            start(&store, &fresh, "sandbox", other, Some(NEW)).await,
            None
        );
        assert_eq!(
            fresh.get("sandbox"),
            Some(Some(rebuilt)),
            "nothing built from it yet: the image the name used last"
        );
    }
}
