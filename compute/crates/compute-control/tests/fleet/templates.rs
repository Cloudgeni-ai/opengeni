//! Templates saved from sandboxes (ADR 22): a team's sandbox saved, its
//! disk captured by its host as a stored image, creates naming the
//! template starting from that image, and the image forgotten once
//! nothing has used it for a while.

use compute_control::store::{Collector, Store as _};
use compute_protocol::host::{ErrorCode, Reply, Request};
use serde_json::{Value, json};

use crate::support::{Act, CAPTURED_LENGTH, Fleet, captured_from, id, op_name};

/// Captures sandbox `source` as a template named `name`.
async fn capture(fleet: &Fleet, source: &str, name: Option<&str>) -> (u16, Value) {
    let body = name.map_or_else(|| json!({}), |name| json!({ "name": name }));
    fleet
        .post(&format!("/v1/sandboxes/{source}/templates"), body)
        .await
}

#[tokio::test]
async fn a_sandbox_saved_as_a_template_starts_new_sandboxes_from_its_disk() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let source = fleet.create(json!({})).await;

    let (status, body) = capture(&fleet, &source, Some("warm")).await;
    assert_eq!(status, 201, "capture: {body}");
    let image = captured_from(id(&source));
    assert_eq!(body["name"], "warm");
    assert_eq!(body["image"], serde_json::to_value(image).unwrap());
    assert_eq!(body["source"], source.as_str());
    assert_eq!(body["vcpus"], 1);
    assert_eq!(body["memory_mib"], 256);
    assert_eq!(
        body["disk_mib"],
        CAPTURED_LENGTH.div_ceil(1 << 20),
        "its disk's length, rounded up"
    );
    let template = body["id"].as_str().unwrap().to_owned();
    assert!(
        fleet
            .archive
            .get_pointer(&image.pointer())
            .await
            .unwrap()
            .is_some(),
        "the image is stored"
    );
    let ops: Vec<&str> = host.ops().into_iter().filter(|op| *op != "other").collect();
    assert_eq!(
        ops,
        ["create", "capture", "sleep", "capture", "capture", "wake"],
        "refused while awake, so saved; copied, then asked until stored; \
         and a sandbox that ran runs again after"
    );

    let (status, listed) = fleet.get("/v1/templates").await;
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed, json!([body.clone()]));
    for key in [template.as_str(), "warm"] {
        let (status, one) = fleet.get(&format!("/v1/templates/{key}")).await;
        assert_eq!((status, &one), (200, &body), "by {key}");
    }

    let (status, created) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "template": "warm", "vcpus": 2, "memory_mib": 512 }),
        )
        .await;
    assert_eq!(status, 201, "create: {created}");
    let from = id(created["id"].as_str().unwrap());
    let config = host
        .seen()
        .into_iter()
        .find_map(|seen| match seen.envelope.request {
            Request::Create { id, config, .. } if id == from => Some(config),
            _ => None,
        })
        .expect("the host was asked to create it");
    assert_eq!(config.image, Some(image), "it starts from the template");
    assert_eq!((config.vcpus, config.memory_mib), (2, 512));

    // The same name again, a name creates could not tell from an id, and
    // a create naming both an image and a template are refused.
    let (status, refused) = capture(&fleet, &source, Some("warm")).await;
    assert_eq!((status, &refused["code"]), (409, &json!("exists")));
    for name in ["-warm", source.as_str()] {
        let (status, refused) = capture(&fleet, &source, Some(name)).await;
        assert_eq!(status, 400, "{name}: {refused}");
    }
    let (status, refused) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "template": "warm", "image": "base", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let (status, _) = fleet.delete("/v1/templates/warm").await;
    assert_eq!(status, 204);
    let (status, _) = fleet.get(&format!("/v1/templates/{template}")).await;
    assert_eq!(status, 404);
    let (status, _) = fleet.delete(&format!("/v1/templates/{template}")).await;
    assert_eq!(status, 404);
    let (status, refused) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "template": "warm", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 400, "a create from a deleted template: {refused}");

    let captures = host
        .seen()
        .iter()
        .filter(|seen| op_name(&seen.envelope.request) == "capture")
        .count();
    assert_eq!(captures, 3, "refusals ask no host");
}

/// A running sandbox whose capture fails after it was saved for it runs
/// again all the same.
#[tokio::test]
async fn a_running_sandbox_whose_capture_fails_runs_again() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let source = fleet.create(json!({})).await;
    let asked = std::sync::atomic::AtomicU32::new(0);
    host.behave(move |envelope| match &envelope.request {
        // Refused while awake, so saved; then its store fails.
        Request::Capture { .. } if asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 => {
            Act::Reply(Reply::Error {
                code: ErrorCode::Internal,
                message: "storing the disk failed".into(),
            })
        }
        _ => Act::Ordinary,
    });

    let (status, body) = capture(&fleet, &source, None).await;
    assert!(status >= 500, "the capture fails: {status} {body}");
    let ops: Vec<&str> = host.ops().into_iter().filter(|op| *op != "other").collect();
    assert_eq!(ops, ["create", "capture", "sleep", "capture", "wake"]);
    let (status, listed) = fleet.get("/v1/templates").await;
    assert_eq!((status, listed), (200, json!([])));
}

#[tokio::test]
async fn an_image_is_forgotten_only_once_nothing_has_used_it_for_a_while() {
    let fleet = Fleet::start().await;
    let _host = fleet.host("host-a.example").await;
    let source = fleet.create(json!({})).await;
    let (status, body) = capture(&fleet, &source, None).await;
    assert_eq!(status, 201, "capture: {body}");
    let template = body["id"].as_str().unwrap().to_owned();
    let image = captured_from(id(&source));
    let (status, created) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "template": template, "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 201, "create: {created}");
    let (status, _) = fleet.delete(&format!("/v1/templates/{template}")).await;
    assert_eq!(status, 204);

    let service = &fleet.running.service;
    let stored = async || {
        fleet
            .archive
            .get_pointer(&image.pointer())
            .await
            .unwrap()
            .is_some()
    };
    // Found unused long ago, as an hour of looks would.
    fleet.store.unused_images(1, 0).await.unwrap();
    assert_eq!(
        service.collect_images().await.unwrap(),
        0,
        "a sandbox started from it keeps it"
    );
    assert!(stored().await);

    let started = created["id"].as_str().unwrap();
    let (status, _) = fleet.delete(&format!("/v1/sandboxes/{started}")).await;
    assert!(status < 300, "delete: {status}");
    fleet.store.unused_images(1, 0).await.unwrap();
    assert_eq!(service.collect_images().await.unwrap(), 1);
    assert!(!stored().await, "forgotten in object storage");
    assert_eq!(service.collect_images().await.unwrap(), 0, "and only once");

    // Captured again, it is stored again.
    let (status, body) = capture(&fleet, &source, None).await;
    assert_eq!(status, 201, "capture again: {body}");
    assert!(stored().await);
}

/// A collector held up after it checked its claim, just before it empties
/// the image's pointer, never forgets the image once another collector
/// took its lapsed claim over and finished, and a capture stored the
/// image again under a new template.
#[tokio::test]
async fn a_collector_held_up_never_forgets_an_image_captured_again_since() {
    let fleet = Fleet::start().await;
    let _host = fleet.host("host-a.example").await;
    let source = fleet.create(json!({})).await;
    let (status, body) = capture(&fleet, &source, None).await;
    assert_eq!(status, 201, "capture: {body}");
    let template = body["id"].as_str().unwrap().to_owned();
    let image = captured_from(id(&source));
    let (status, _) = fleet.delete(&format!("/v1/templates/{template}")).await;
    assert_eq!(status, 204);
    fleet.store.unused_images(1, 0).await.unwrap();

    // The held-up collector claimed it long ago, read its pointer and
    // found its claim still held.
    let held_up = Collector {
        id: "held-up".into(),
        at_ms: 1,
        lapsed_ms: 0,
    };
    assert!(fleet.store.collect_image(image, 2, &held_up).await.unwrap());
    let pointer = image.pointer();
    let stale = fleet
        .archive
        .read_to_forget(&pointer)
        .await
        .unwrap()
        .unwrap();
    assert!(fleet.store.collecting(image, "held-up").await.unwrap());

    // Another takes the lapsed claim over and forgets it; a capture then
    // stores it again.
    let service = &fleet.running.service;
    assert_eq!(service.collect_images().await.unwrap(), 1);
    assert!(fleet.archive.get_pointer(&pointer).await.unwrap().is_none());
    let (status, body) = capture(&fleet, &source, None).await;
    assert_eq!(status, 201, "capture again: {body}");
    let again = body["id"].as_str().unwrap().to_owned();

    // The held-up collector goes on: its empty pointer does not land, and
    // it no longer holds a claim to finish.
    let refused = fleet.archive.forget(stale).await;
    assert!(
        matches!(refused, Err(compute_storage::Error::Superseded)),
        "{refused:?}"
    );
    assert!(!fleet.store.collecting(image, "held-up").await.unwrap());
    fleet.store.collected(image, "held-up").await.unwrap();
    assert!(fleet.archive.get_pointer(&pointer).await.unwrap().is_some());
    let (status, found) = fleet.get(&format!("/v1/templates/{again}")).await;
    assert_eq!(status, 200, "{found}");
    fleet.store.unused_images(1, 0).await.unwrap();
    assert_eq!(
        service.collect_images().await.unwrap(),
        0,
        "its new template keeps it"
    );
}
