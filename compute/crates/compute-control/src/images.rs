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

use std::collections::{BTreeMap, BTreeSet};
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
/// How long a captured image is spread to hosts that join after it: long
/// enough for the creates right after a capture, which a host joining
/// later fetches for on its first.
const SPREAD_FOR: Duration = Duration::from_secs(60 * 60);
/// How often a replica looks for live hosts that lack an image they are to
/// keep.
const KEEP_EVERY: Duration = Duration::from_secs(10);

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
pub struct Images {
    named: Arc<RwLock<BTreeMap<String, Option<ImageId>>>>,
    /// The images the service was started with (`--stored-image`): what a
    /// name starts from each time the service starts, until it has read
    /// what was built for the name since.
    pinned: Arc<BTreeSet<ImageId>>,
    /// For each image a name started from after another, that other one:
    /// what hosts fetch it over (ADR 41).
    befores: Arc<RwLock<BTreeMap<ImageId, ImageId>>>,
    /// Images every live host is to have besides the named ones, such as
    /// a template just captured, with the image each was made from and
    /// until when.
    spread: Arc<RwLock<Spread>>,
}

/// Images spread to every live host: each with the image it was made from,
/// and until when.
type Spread = BTreeMap<ImageId, (Option<ImageId>, Instant)>;

impl Images {
    /// These images.
    #[must_use]
    pub fn new(images: BTreeMap<String, Option<ImageId>>) -> Self {
        Self {
            pinned: Arc::new(images.values().copied().flatten().collect()),
            named: Arc::new(RwLock::new(images)),
            befores: Arc::default(),
            spread: Arc::default(),
        }
    }

    /// The image named `name`, if there is one.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Option<ImageId>> {
        self.named
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .copied()
    }

    /// Makes `image` the stored image named `name`.
    pub fn set(&self, name: &str, image: ImageId) {
        let before = self
            .named
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.to_owned(), Some(image))
            .flatten();
        if let Some(before) = before.filter(|before| *before != image) {
            self.befores
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(image, before);
        }
    }

    /// Has every live host keep `image`, made from `before`, for the next
    /// [`SPREAD_FOR`] (ADR 41).
    pub fn spread(&self, image: ImageId, before: Option<ImageId>) {
        self.spread
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(image, (before, Instant::now() + SPREAD_FOR));
    }

    /// The images every live host is to have now, each with the image it
    /// is fetched over, if one is known: every name's, and those spread
    /// lately.
    #[must_use]
    pub fn to_keep(&self) -> BTreeMap<ImageId, Option<ImageId>> {
        let befores = self.befores.read().unwrap_or_else(PoisonError::into_inner);
        let mut keep: BTreeMap<ImageId, Option<ImageId>> = self
            .named
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .flatten()
            .map(|image| (*image, befores.get(image).copied()))
            .collect();
        let mut spread = self.spread.write().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        spread.retain(|_, (_, until)| *until > now);
        for (image, (before, _)) in spread.iter() {
            keep.entry(*image).or_insert(*before);
        }
        keep
    }

    /// Whether some name names `image`, or did when the service started:
    /// such an image is never forgotten, as creates may start from it
    /// again the next time the service starts.
    #[must_use]
    pub fn names(&self, image: ImageId) -> bool {
        self.pinned.contains(&image)
            || self
                .named
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

/// Follows `sources` ([`follow`]) and has every live host keep the images
/// that follow ([`keep_on_hosts`]), for as long as it runs.
pub async fn run<S: Store>(service: Arc<Service<S>>, sources: BTreeMap<String, String>) {
    tokio::join!(
        follow(Arc::clone(&service), sources),
        keep_on_hosts(service)
    );
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
                // Built for another name, or before: this name uses it now,
                // so it is this name's to fall back on later too.
                match store.record_built(&key, name, image, now_ms()).await {
                    Ok(Some(image)) => {
                        images.set(name, image);
                        return Some(key);
                    }
                    // Claimed to be forgotten since it was read: not this
                    // name's any more, and built again at the next ask.
                    Ok(None) => {}
                    Err(error) => {
                        // Used meanwhile; recorded at the next ask.
                        tracing::warn!(%error, %name, "recording the image's use failed");
                        images.set(name, image);
                        return None;
                    }
                }
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

/// Has every live host keep the images [`Images::to_keep`] names, each
/// fetched over the image before it, so no create waits for a fetch (ADR
/// 41): asks each host once per image, for as long as it runs. A host that
/// cannot be reached is asked again; one from before the request is not.
pub async fn keep_on_hosts<S: Store>(service: Arc<Service<S>>) {
    let images = service.settings().images.clone();
    let mut asked: std::collections::HashMap<String, BTreeSet<ImageId>> =
        std::collections::HashMap::new();
    loop {
        let keep = images.to_keep();
        for target in service.live_hosts() {
            let done = asked.entry(target.name.clone()).or_default();
            for (image, before) in &keep {
                if done.contains(image) {
                    continue;
                }
                match service.keep_on(&target, *image, *before).await {
                    Ok(()) => {
                        tracing::info!(host = %target.name, %image, "asked a host to keep an image ahead of its creates");
                        done.insert(*image);
                    }
                    Err(error) => {
                        tracing::debug!(host = %target.name, %image, %error, "asking a host to keep an image failed; asking again later");
                    }
                }
            }
            done.retain(|image| keep.contains_key(image));
        }
        tokio::time::sleep(KEEP_EVERY).await;
    }
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

    /// The collector leaves what a name names, and what one named when
    /// the service started, though a build has replaced it since.
    #[test]
    fn an_image_the_service_started_with_stays_named() {
        let (pinned, built) = (ImageId([1; 32]), ImageId([2; 32]));
        let images = Images::new(BTreeMap::from([
            ("sandbox".to_owned(), Some(pinned)),
            ("base".to_owned(), None),
        ]));
        images.set("sandbox", built);
        assert_eq!(images.get("sandbox"), Some(Some(built)));
        assert!(images.names(built) && images.names(pinned));
        assert!(!images.names(ImageId([3; 32])));
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

    /// A rollback to a release whose image is being forgotten, as nothing
    /// used it for a while, does not start from it: the name stays on the
    /// image it used last until the release's is built again.
    #[tokio::test]
    async fn a_name_does_not_start_from_an_image_being_forgotten() {
        use crate::store::Collector;

        let store = MemoryStore::new();
        let (first, later, rebuilt) = (ImageId([1; 32]), ImageId([2; 32]), ImageId([3; 32]));
        let key = built_key(SOURCE, Some(NEW));
        store.record_built(&key, "sandbox", first, 1).await.unwrap();
        store
            .record_built(&built_key(NEXT, Some(NEW)), "sandbox", later, 2)
            .await
            .unwrap();
        assert_eq!(store.unused_images(10, 10).await.unwrap(), Vec::new());
        assert_eq!(store.unused_images(20, 11).await.unwrap(), vec![first]);
        let collector = Collector {
            id: "collector".to_owned(),
            at_ms: 20,
            lapsed_ms: 0,
        };
        assert!(store.collect_image(first, 11, &collector).await.unwrap());

        let images = Images::default();
        assert_eq!(
            start(&store, &images, "sandbox", SOURCE, Some(NEW)).await,
            None
        );
        assert_eq!(images.get("sandbox"), Some(Some(later)));

        // Forgotten, and built again: a new image, which the name starts
        // from.
        store.collected(first, &collector.id).await.unwrap();
        assert_eq!(store.image_built(&key).await.unwrap(), None);
        assert_eq!(
            store
                .record_built(&key, "sandbox", rebuilt, 30)
                .await
                .unwrap(),
            Some(rebuilt)
        );
        assert_eq!(
            start(&store, &images, "sandbox", SOURCE, Some(NEW)).await,
            Some(key)
        );
        assert_eq!(images.get("sandbox"), Some(Some(rebuilt)));
    }
}
