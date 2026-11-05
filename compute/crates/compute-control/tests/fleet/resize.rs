//! Resizing a sandbox: it is handed off as a move does, and gets its new
//! shape while nobody owns it, so whichever host takes it up next takes
//! it up at that shape.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compute_protocol::host::{ErrorCode, Id, Reply, Request, SandboxConfig};
use serde_json::{Value, json};

use super::support::{Act, FakeHost, Fleet, id};

async fn resize(fleet: &Fleet, sandbox: &str, body: Value) -> (u16, Value) {
    fleet
        .post(&format!("/v1/sandboxes/{sandbox}/resize"), body)
        .await
}

/// The config of each adopt of `id` `host` received, with its owner
/// epoch, in the order received.
fn adopted(host: &FakeHost, id: Id) -> Vec<(u64, SandboxConfig)> {
    host.seen()
        .into_iter()
        .filter_map(|seen| match seen.envelope.request {
            Request::Adopt {
                id: adopted,
                config,
                owner_epoch,
                ..
            } if adopted == id => Some((owner_epoch, config)),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resize_hands_its_sandbox_off_and_its_next_wake_takes_it_up_at_the_new_shape() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    assert_eq!(a.holds(id(&sandbox)), Some(1));

    let (status, resized) = resize(
        &fleet,
        &sandbox,
        json!({ "vcpus": 2, "memory_mib": 512, "disk_mib": 4096 }),
    )
    .await;
    assert_eq!(status, 200, "{resized}");
    assert_eq!(resized["host"], Value::Null, "{resized}");
    assert_eq!(resized["config"]["vcpus"], 2, "{resized}");
    assert_eq!(resized["config"]["memory_mib"], 512, "{resized}");
    assert_eq!(resized["config"]["disk_mib"], 4096, "{resized}");
    // Requests it never set stay unset, so they follow the new shape.
    assert_eq!(resized["config"]["memory_request_mib"], Value::Null);
    assert_eq!(resized["config"]["cpu_request_millis"], Value::Null);
    assert!(a.ops().contains(&"hand_off"), "{:?}", a.ops());
    assert_eq!(a.holds(id(&sandbox)), None);
    let epoch = resized["owner_epoch"].as_u64().unwrap();
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["config"], resized["config"]);

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!(status, 200, "{woken}");
    let adopts = adopted(&a, id(&sandbox));
    let (adopted_under, config) = adopts.last().expect("adopted again");
    assert!(*adopted_under > epoch, "{adopts:?}");
    assert_eq!(
        (config.vcpus, config.memory_mib, config.disk_mib),
        (2, 512, Some(4096))
    );
    // On another machine, its copy is taken up from its files alone.
    assert_eq!(a.adopts(id(&sandbox)), [true]);
}

/// A resize to other processors or memory leaves the stored copy files
/// only, whatever its memory image records, so its next owner boots it
/// from its disk; new requests or a longer disk leave the copy whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_a_resize_to_another_machine_leaves_the_copy_files_only() {
    for (body, files_only) in [
        (json!({ "vcpus": 2 }), true),
        (json!({ "memory_mib": 512 }), true),
        (
            json!({ "memory_request_mib": 128, "cpu_request_millis": 500 }),
            false,
        ),
        (json!({ "disk_mib": 4096 }), false),
    ] {
        let fleet = Fleet::start().await;
        let a = fleet.host("host-a.example").await;
        let sandbox = fleet.create(json!({})).await;
        let (status, resized) = resize(&fleet, &sandbox, body.clone()).await;
        assert_eq!(status, 200, "{body}: {resized}");
        let (status, woken) = fleet
            .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
            .await;
        assert_eq!(status, 200, "{body}: {woken}");
        assert_eq!(a.adopts(id(&sandbox)), [files_only], "{body}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_nobody_owns_is_resized_at_once_and_one_at_its_shape_is_left_as_it_is() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (status, same) = resize(&fleet, &sandbox, json!({ "vcpus": 1 })).await;
    assert_eq!((status, &same["host"]), (200, &json!("host-a.example")));
    assert_eq!(same["owner_epoch"], 1);
    assert!(!a.ops().contains(&"hand_off"), "{:?}", a.ops());

    let (status, moved) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/move"), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    let handed_off = a.ops().len();
    let (status, resized) = resize(
        &fleet,
        &sandbox,
        json!({ "memory_request_mib": 128, "cpu_request_millis": 200 }),
    )
    .await;
    assert_eq!(status, 200, "{resized}");
    assert_eq!(resized["config"]["memory_request_mib"], 128);
    assert_eq!(resized["config"]["cpu_request_millis"], 200);
    assert_eq!(resized["config"]["vcpus"], 1);
    // Taken anew under a raised epoch, with no host asked anything.
    assert!(resized["owner_epoch"].as_u64() > moved["owner_epoch"].as_u64());
    assert_eq!(a.ops().len(), handed_off, "{:?}", a.ops());
    // Asked again, it is at that shape already.
    let (status, again) = resize(&fleet, &sandbox, json!({ "memory_request_mib": 128 })).await;
    assert_eq!(
        (status, &again["owner_epoch"]),
        (200, &resized["owner_epoch"])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resize_to_a_shape_a_create_would_refuse_or_a_shorter_disk_is_invalid() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let (status, created) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "vcpus": 1, "memory_mib": 512, "memory_request_mib": 256, "disk_mib": 2048 }),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    let sandbox = created["id"].as_str().unwrap().to_owned();
    for body in [
        json!({ "vcpus": 0 }),
        // Below the memory it asks for.
        json!({ "memory_mib": 128 }),
        // A file system does not shrink.
        json!({ "disk_mib": 1024 }),
    ] {
        let (status, refused) = resize(&fleet, &sandbox, body.clone()).await;
        assert_eq!(status, 400, "{body}: {refused}");
        assert_eq!(refused["code"], "invalid", "{body}: {refused}");
    }
    let (status, refused) = resize(&fleet, &sandbox, json!({ "cpus": 2 })).await;
    assert_eq!(status, 422, "{refused}");
    let (status, refused) = fleet
        .post(
            "/v1/sandboxes/6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c/resize",
            json!({ "vcpus": 2 }),
        )
        .await;
    assert_eq!(status, 404, "{refused}");
    assert!(!a.ops().contains(&"hand_off"), "{:?}", a.ops());
    assert_eq!(a.holds(id(&sandbox)), Some(1));
}

/// As a move does, a resize refuses a sandbox something holds awake as
/// busy, unless it is asked to resize it awake too.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resize_refuses_a_sandbox_held_awake_unless_asked_to_resize_it_awake() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    a.behave(|envelope| match envelope.request {
        Request::HandOff { awake: false, .. } => Act::Reply(Reply::Error {
            code: ErrorCode::Busy,
            message: "awake".into(),
        }),
        _ => Act::Ordinary,
    });
    let (status, refused) = resize(&fleet, &sandbox, json!({ "vcpus": 2 })).await;
    assert_eq!(
        (status, &refused["code"]),
        (409, &json!("busy")),
        "{refused}"
    );
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["config"]["vcpus"], 1, "{row}");
    assert_eq!(a.holds(id(&sandbox)), Some(1));

    let (status, resized) = resize(&fleet, &sandbox, json!({ "vcpus": 2, "awake": true })).await;
    assert_eq!(status, 200, "{resized}");
    assert_eq!(resized["config"]["vcpus"], 2, "{resized}");
    assert_eq!(a.holds(id(&sandbox)), None);
}

/// Wakes that keep taking the sandbox up while it is resized: each time
/// one does, the resize hands it off again, and it gives up after a few
/// tries. Whatever the interleaving, no host is ever given the sandbox at
/// a shape other than its row's when it was given it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wakes_during_a_resize_never_give_a_host_the_old_shape_after_the_new() {
    let fleet = Arc::new(Fleet::start().await);
    let a = fleet.host("host-a.example").await;
    let b = fleet.host("host-b.example").await;
    let sandbox = fleet.create(json!({})).await;
    // Hand-offs take a while, as archives do, and wakes keep coming.
    for host in [&a, &b] {
        host.behave(|envelope| match envelope.request {
            Request::HandOff { .. } => Act::After(Duration::from_millis(50)),
            _ => Act::Ordinary,
        });
    }
    let stop = Arc::new(AtomicBool::new(false));
    let waking: Vec<_> = (0..8)
        .map(|_| {
            let (fleet, stop, sandbox) = (Arc::clone(&fleet), Arc::clone(&stop), sandbox.clone());
            tokio::spawn(async move {
                while !stop.load(Ordering::SeqCst) {
                    let _ = fleet
                        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
                        .await;
                }
            })
        })
        .collect();
    for vcpus in 2..=4 {
        let (status, answered) = resize(&fleet, &sandbox, json!({ "vcpus": vcpus })).await;
        match status {
            200 => assert_eq!(answered["config"]["vcpus"], vcpus, "{answered}"),
            // Taken up again each time it was handed off.
            503 => assert_eq!(answered["code"], "unavailable", "{answered}"),
            _ => panic!("{status}: {answered}"),
        }
    }
    stop.store(true, Ordering::SeqCst);
    for waking in waking {
        waking.await.unwrap();
    }

    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    let mut adopts = adopted(&a, id(&sandbox));
    adopts.extend(adopted(&b, id(&sandbox)));
    adopts.sort_by_key(|(epoch, _)| *epoch);
    // A shape, once given, is never followed by an older one.
    for pair in adopts.windows(2) {
        assert!(pair[0].1.vcpus <= pair[1].1.vcpus, "{adopts:?}");
    }
    if let Some((epoch, config)) = adopts.last()
        && Some(*epoch) == row["owner_epoch"].as_u64()
    {
        assert_eq!(json!(config.vcpus), row["config"]["vcpus"], "{row}");
    }
}
