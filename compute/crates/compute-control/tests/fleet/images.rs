//! Stored images that follow releases (ADR 19): a host builds the
//! release's image of a name, the service records it, and new creates of
//! that name start from it, built again once the fleet's hosts have other
//! guest programs.

use std::collections::BTreeMap;
use std::time::Duration;

use compute_control::images::{Images, built_key};
use compute_control::store::Store as _;
use compute_protocol::host::{ImageId, Request};

use crate::support::{Fleet, built_from, built_with, until};

const SOURCE: &str = "registry.example/sandbox@sha256:\
    00000000000000000000000000000000000000000000000000000000000000aa";
/// Two bundles' guest programs, by digest, the first the lower.
const OLD: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const NEW: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

#[tokio::test]
async fn a_release_s_image_is_built_by_a_host_and_new_creates_start_from_it() {
    let before = ImageId([7; 32]);
    let fleet = Fleet::start_with_sources(&[("sandbox", SOURCE)], |settings| {
        settings.images = Images::new(BTreeMap::from([("sandbox".to_owned(), Some(before))]));
    })
    .await;
    let settings = fleet.running.service.settings();
    assert_eq!(
        settings.image_named("sandbox"),
        Some(Some(before)),
        "until it is built, the image before"
    );
    let host = fleet.host("host-a.example").await;
    let built = built_from(SOURCE);
    until(Duration::from_secs(30), "the image is built", async || {
        settings.image_named("sandbox") == Some(Some(built))
    })
    .await;
    assert_eq!(fleet.store.image_built(SOURCE).await.unwrap(), Some(built));
    assert_eq!(
        fleet.store.latest_built("sandbox").await.unwrap(),
        Some(built)
    );
    let asks = host
        .seen()
        .iter()
        .filter(
            |seen| matches!(&seen.envelope.request, Request::Prepare { image } if image == SOURCE),
        )
        .count();
    assert_eq!(asks, 2, "asked once to build and once more to learn it was");

    let (status, body) = fleet
        .post(
            "/v1/sandboxes",
            serde_json::json!({ "image": "sandbox", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 201, "create: {body}");
    let created = host
        .seen()
        .into_iter()
        .find_map(|seen| match seen.envelope.request {
            Request::Create { config, .. } => Some(config.image),
            _ => None,
        });
    assert_eq!(created, Some(Some(built)), "the create starts from it");
}

/// Two names a release builds from one source both start from its image,
/// and each is recorded, so either keeps it while a later release's source
/// of its own is built.
#[tokio::test]
async fn names_sharing_a_source_each_record_its_image() {
    let fleet = Fleet::start_with_sources(&[("sandbox", SOURCE), ("alias", SOURCE)], |_| {}).await;
    let settings = fleet.running.service.settings();
    let _host = fleet.host("host-a.example").await;
    let built = built_from(SOURCE);
    until(
        Duration::from_secs(30),
        "both names follow the image",
        async || {
            settings.image_named("sandbox") == Some(Some(built))
                && settings.image_named("alias") == Some(Some(built))
        },
    )
    .await;
    for name in ["sandbox", "alias"] {
        assert_eq!(
            fleet.store.latest_built(name).await.unwrap(),
            Some(built),
            "{name} is recorded with the image it starts from"
        );
    }
}

/// A host upgraded to a bundle with other guest programs has the
/// release's image built again with them; the first build stays recorded
/// under the OCI image alone, for a rollback and replicas of an earlier
/// release.
#[tokio::test]
async fn a_host_upgrade_with_other_guest_programs_has_the_release_s_image_built_again() {
    let fleet = Fleet::start_with_sources(&[("sandbox", SOURCE)], |_| {}).await;
    let settings = fleet.running.service.settings();
    let host = fleet.host_building_with("host-a.example", OLD).await;
    let old = built_with(SOURCE, Some(OLD));
    until(
        Duration::from_secs(30),
        "the image is built with the host's programs",
        async || settings.image_named("sandbox") == Some(Some(old)),
    )
    .await;
    assert_eq!(
        fleet
            .store
            .image_built(&built_key(SOURCE, Some(OLD)))
            .await
            .unwrap(),
        Some(old)
    );
    assert_eq!(fleet.store.image_built(SOURCE).await.unwrap(), Some(old));

    // Upgraded in place: the agent keeps its registration and tells its
    // new programs with what it can take on.
    host.builds_with(Some(NEW));
    let new = built_with(SOURCE, Some(NEW));
    until(
        Duration::from_secs(30),
        "the image is built again with the upgraded host's programs",
        async || settings.image_named("sandbox") == Some(Some(new)),
    )
    .await;
    assert_eq!(
        fleet
            .store
            .image_built(&built_key(SOURCE, Some(NEW)))
            .await
            .unwrap(),
        Some(new)
    );
    assert_eq!(
        fleet.store.image_built(SOURCE).await.unwrap(),
        Some(old),
        "the first build of the OCI image stays its image with any programs"
    );
    assert_eq!(
        fleet.store.latest_built("sandbox").await.unwrap(),
        Some(new)
    );

    let (status, body) = fleet
        .post(
            "/v1/sandboxes",
            serde_json::json!({ "image": "sandbox", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 201, "create: {body}");
    let created = host
        .seen()
        .into_iter()
        .find_map(|seen| match seen.envelope.request {
            Request::Create { config, .. } => Some(config.image),
            _ => None,
        });
    assert_eq!(created, Some(Some(new)), "the create starts from it");
}

/// The image is built with the programs most live hosts have, by one of
/// them: only those can build the image of that id, and a host with others
/// is never asked once they are fewer.
#[tokio::test]
async fn images_are_built_with_the_guest_programs_most_live_hosts_have() {
    let fleet = Fleet::start_with_sources(&[("sandbox", SOURCE)], |_| {}).await;
    let settings = fleet.running.service.settings();
    let _a = fleet.host_building_with("host-a.example", NEW).await;
    let _b = fleet.host_building_with("host-b.example", OLD).await;
    let _c = fleet.host_building_with("host-c.example", OLD).await;
    let most = built_with(SOURCE, Some(OLD));
    until(
        Duration::from_secs(30),
        "the image is built with what most hosts have",
        async || settings.image_named("sandbox") == Some(Some(most)),
    )
    .await;
    assert_eq!(
        fleet
            .store
            .image_built(&built_key(SOURCE, Some(OLD)))
            .await
            .unwrap(),
        Some(most)
    );
}
