//! Stored images that follow releases (ADR 19): a host builds the
//! release's image of a name, the service records it, and new creates of
//! that name start from it.

use std::collections::BTreeMap;
use std::time::Duration;

use compute_control::images::Images;
use compute_control::store::Store as _;
use compute_protocol::host::{ImageId, Request};

use crate::support::{Fleet, built_from, until};

const SOURCE: &str = "registry.example/sandbox@sha256:\
    00000000000000000000000000000000000000000000000000000000000000aa";

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
