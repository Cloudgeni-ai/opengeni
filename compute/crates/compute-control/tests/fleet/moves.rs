//! Moving sandboxes between hosts: to a named host, off a host for the
//! next wake to place, and off a draining host.

use std::time::Duration;

use compute_protocol::host::Request;
use serde_json::{Value, json};

use super::support::{Act, Fleet, OPERATOR_KEY, id};

async fn operator(fleet: &Fleet, method: reqwest::Method, path: &str) -> (u16, Value) {
    fleet.call(method, path, Some(OPERATOR_KEY), None).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_to_a_named_host_hands_off_then_adopts_there_and_fences_the_old_owner() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    assert_eq!(a.holds(id(&sandbox)), Some(1));
    let b = fleet.host("host-b.example").await;

    let (status, moved) = fleet
        .post(
            &format!("/v1/sandboxes/{sandbox}/move"),
            json!({ "to": "host-b.example" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["host"], "host-b.example", "{moved}");
    let epoch = moved["owner_epoch"].as_u64().unwrap();
    assert!(epoch > 1, "{moved}");
    assert_eq!(a.holds(id(&sandbox)), None);
    assert_eq!(b.holds(id(&sandbox)), Some(epoch));
    assert!(a.ops().contains(&"hand_off"), "{:?}", a.ops());
    assert!(b.ops().contains(&"adopt"), "{:?}", b.ops());
    // An archive the old owner finishes late lands nowhere.
    assert!(a.try_archive(id(&sandbox), 1).await.is_err());
    // Moving it to where it is changes nothing.
    let (status, again) = fleet
        .post(
            &format!("/v1/sandboxes/{sandbox}/move"),
            json!({ "to": "host-b.example" }),
        )
        .await;
    assert_eq!((status, again["owner_epoch"].as_u64()), (200, Some(epoch)));
}

/// A hand-off can take minutes (the owner archives first), far longer than
/// a host accepts a request for. The named host still adopts: its adopt
/// carries that host's renewal as it stands once the hand-off is done.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_whose_hand_off_outlasts_the_request_window_still_adopts_on_the_named_host() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let b = fleet.host("host-b.example").await;
    // Five renewals are a second here; the hand-off takes about ten.
    b.refuse_older_than(5);
    a.behave(|envelope| match envelope.request {
        Request::HandOff { .. } => Act::After(Duration::from_secs(2)),
        _ => Act::Ordinary,
    });
    let (status, moved) = fleet
        .post(
            &format!("/v1/sandboxes/{sandbox}/move"),
            json!({ "to": "host-b.example" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["host"], "host-b.example", "{moved}");
    let epoch = moved["owner_epoch"].as_u64().unwrap();
    assert_eq!(b.holds(id(&sandbox)), Some(epoch));
    assert_eq!(a.holds(id(&sandbox)), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_without_a_target_leaves_it_for_its_next_wake_to_place() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (status, moved) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/move"), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["host"], Value::Null, "{moved}");
    assert_eq!(a.holds(id(&sandbox)), None);

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!(status, 200, "{woken}");
    assert_eq!(woken["host"], "host-a.example", "{woken}");
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    let epoch = row["owner_epoch"].as_u64().unwrap();
    assert_eq!(a.holds(id(&sandbox)), Some(epoch));
    assert!(epoch > 1, "adopted under a raised epoch: {row}");
}

/// A sandbox's state is what its owner says of it now, and with no owner
/// it is in the store alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandboxs_state_is_what_its_owner_says_of_it() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let path = format!("/v1/sandboxes/{sandbox}/state");
    let (status, state) = fleet.get(&path).await;
    assert_eq!(status, 200, "{state}");
    assert_eq!(
        state,
        json!({
            "host": "host-a.example",
            "level": "running",
            "step": null,
            "generation": 1,
        })
    );
    assert!(matches!(
        a.seen().last().unwrap().envelope.request,
        Request::Status
    ));

    // Its host says nothing of it under its owner epoch, as before it
    // takes it up: that is for later.
    let wrong = a.holds(id(&sandbox)).unwrap() + 1;
    a.hold(id(&sandbox), wrong);
    let (status, refused) = fleet.get(&path).await;
    assert_eq!(status, 503, "{refused}");

    let (status, moved) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/move"), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    let (status, state) = fleet.get(&path).await;
    assert_eq!(status, 200, "{state}");
    assert_eq!(
        state,
        json!({ "host": null, "level": "remote", "step": null, "generation": null })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draining_host_hands_its_sandboxes_off_and_gets_nothing_new_until_undrained() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let first = fleet.create(json!({})).await;
    let second = fleet.create(json!({})).await;
    let b = fleet.host("host-b.example").await;

    let (status, drained) = operator(
        &fleet,
        reqwest::Method::POST,
        "/v1/hosts/host-a.example/drain",
    )
    .await;
    assert_eq!(status, 200, "{drained}");
    assert_eq!(drained, json!({ "moved": 2, "left": 0 }));
    assert_eq!((a.holds(id(&first)), a.holds(id(&second))), (None, None));
    let state = |hosts: &Value, name: &str| {
        hosts
            .as_array()
            .unwrap()
            .iter()
            .find(|host| host["name"] == name)
            .map(|host| host["state"].clone())
    };
    super::support::until(
        std::time::Duration::from_secs(5),
        "the view sees it draining",
        async || {
            let (_, hosts) = operator(&fleet, reqwest::Method::GET, "/v1/hosts").await;
            state(&hosts, "host-a.example") == Some(json!("draining"))
        },
    )
    .await;

    // Placement passes it by, for creates and for the moved sandboxes'
    // next wakes.
    for _ in 0..4 {
        let created = fleet.create(json!({})).await;
        assert!(b.holds(id(&created)).is_some());
    }
    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{first}/wake"), json!({}))
        .await;
    assert_eq!((status, &woken["host"]), (200, &json!("host-b.example")));

    let (status, _) = operator(
        &fleet,
        reqwest::Method::POST,
        "/v1/hosts/host-a.example/undrain",
    )
    .await;
    assert_eq!(status, 204);
    super::support::until(
        std::time::Duration::from_secs(5),
        "the view sees it live again",
        async || {
            let (_, hosts) = operator(&fleet, reqwest::Method::GET, "/v1/hosts").await;
            state(&hosts, "host-a.example") == Some(json!("live"))
        },
    )
    .await;
}
