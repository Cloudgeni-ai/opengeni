//! Registering, renewing, and a sandbox's life on one host: create, wake,
//! connect, list, delete; refusals and keys.

use std::time::Duration;

use compute_fleet::HostId;
use compute_protocol::fleet::{HostInfo, REGISTER_PATH, Register, Registered};
use compute_protocol::host::{ErrorCode, Id, Reply, Request};
use reqwest::Method;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use crate::support::{
    Act, Fleet, KEY, OPERATOR_KEY, OTHER_KEY, connect, id, op_name, roomy, until,
};

#[tokio::test]
async fn a_host_registers_renews_and_the_operator_sees_it_live() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let (status, hosts) = fleet
        .call(Method::GET, "/v1/hosts", Some(OPERATOR_KEY), None)
        .await;
    assert_eq!(status, 200, "{hosts}");
    assert_eq!(hosts[0]["name"], "host-a.example");
    assert_eq!(hosts[0]["state"], "live");
    assert_eq!(hosts[0]["epoch"], host.epoch());

    // Renewals are accepted: the stamp on the service's requests rises.
    let view = std::sync::Arc::clone(fleet.running.service.view());
    let first = view.target(HostId(host.id())).unwrap().seq;
    until(
        Duration::from_secs(3),
        "a renewal is accepted",
        async || {
            view.target(HostId(host.id()))
                .is_some_and(|target| target.seq > first)
        },
    )
    .await;

    let (status, _) = fleet.call(Method::GET, "/v1/hosts", Some(KEY), None).await;
    assert_eq!(status, 403, "hosts are for the operator only");
}

#[tokio::test]
async fn a_registration_is_answered_again_and_refused_while_the_last_is_live() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let epoch = host.epoch();
    // Another copy of the attempt gets the answer the first got.
    match host.register_again().await {
        Registered::Registered { epoch: again, .. } => assert_eq!(again, epoch),
        other @ Registered::StillLive { .. } => panic!("{other:?}"),
    }
    // A new attempt waits for the live registration to lapse.
    assert!(matches!(
        host.register().await,
        Registered::StillLive { .. }
    ));
    assert_eq!(host.epoch(), epoch);
}

#[tokio::test]
async fn a_host_registers_only_under_a_name_its_certificate_carries() {
    let fleet = Fleet::start().await;
    let url = format!("https://{}{REGISTER_PATH}", fleet.running.hosts);
    let body = Register {
        host: None,
        attempt: 1,
        info: HostInfo {
            name: "host-c.example".into(),
            address: "127.0.0.1:1".into(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "none".into(),
            memory_mib: 1024,
            cpu_millis: 64_000,
            disk_mib: 1024,
        },
        capacity: roomy(),
        held: Vec::new(),
    };
    let other = reqwest::Client::builder()
        .use_preconfigured_tls(fleet.pki.host_client("host-b.example"))
        .build()
        .unwrap();
    let response = other.post(&url).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn a_sandbox_is_created_woken_connected_to_listed_and_deleted() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({ "purpose": "test" })).await;
    let path = format!("/v1/sandboxes/{sandbox}");
    let (status, row) = fleet.get(&path).await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["host"], "host-a.example");
    let owner_epoch = row["owner_epoch"].as_u64().unwrap();
    assert_eq!(host.holds(id(&sandbox)), Some(owner_epoch));
    // The create went out under the host's registration and the owner
    // epoch the store recorded.
    let created = &host.seen()[0].envelope;
    assert_eq!(created.sent.host_epoch, host.epoch());
    assert_eq!(created.sent.owner_epoch, Some(owner_epoch));

    let (status, woken) = fleet.post(&format!("{path}/wake"), json!({})).await;
    assert_eq!(status, 200, "{woken}");
    assert_eq!(woken["host"], "host-a.example");
    assert_eq!(woken["generation"], 1);

    let (head, mut stream) = connect(&fleet, &sandbox, 8080).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    let Request::Connect { port, .. } = host.seen().last().unwrap().envelope.request else {
        panic!("not a connect");
    };
    assert_eq!(port, 8080);

    let other = fleet.create(json!({ "purpose": "other" })).await;
    let (_, listed) = fleet.get("/v1/sandboxes?purpose=test").await;
    let listed: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(listed, [sandbox.as_str()]);
    let (_, all) = fleet.get("/v1/sandboxes").await;
    assert_eq!(all.as_array().unwrap().len(), 2);

    let (status, _) = fleet.delete(&path).await;
    assert_eq!(status, 204);
    assert_eq!(host.holds(id(&sandbox)), None);
    assert_eq!(fleet.get(&path).await.0, 404);
    assert!(host.holds(id(&other)).is_some());
}

#[tokio::test]
async fn a_sandbox_whose_create_says_nothing_of_sleep_is_checkpointed_as_the_fleet_says() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(
        row["config"]["sleep"]["checkpoint_every_ms"], 600_000,
        "{row}"
    );
    let Request::Create { config, .. } = &host.seen()[0].envelope.request else {
        panic!("not a create");
    };
    assert_eq!(config.sleep, compute_control::service::DEFAULT_SLEEP);

    // One that says how it sleeps is taken at its word.
    let sleep = json!({ "pause_after_ms": 10_000, "compress": false });
    let (status, row) = fleet
        .post(
            "/v1/sandboxes",
            json!({ "vcpus": 1, "memory_mib": 256, "sleep": sleep }),
        )
        .await;
    assert_eq!(status, 201, "{row}");
    assert_eq!(row["config"]["sleep"], sleep);
}

#[tokio::test]
async fn keys_are_needed_and_a_team_sees_only_its_own_sandboxes() {
    let fleet = Fleet::start().await;
    let _host = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let path = format!("/v1/sandboxes/{sandbox}");
    assert_eq!(fleet.call(Method::GET, &path, None, None).await.0, 401);
    assert_eq!(
        fleet
            .call(Method::GET, &path, Some("not-a-key"), None)
            .await
            .0,
        401
    );
    assert_eq!(
        fleet
            .call(Method::GET, &path, Some(OTHER_KEY), None)
            .await
            .0,
        404
    );
    assert_eq!(
        fleet
            .call(Method::DELETE, &path, Some(OTHER_KEY), None)
            .await
            .0,
        404
    );
    let (_, theirs) = fleet
        .call(Method::GET, "/v1/sandboxes", Some(OTHER_KEY), None)
        .await;
    assert_eq!(theirs, json!([]));
    assert_eq!(fleet.get(&path).await.0, 200, "still there");
}

fn refuse_creates(envelope: &compute_protocol::fleet::Envelope) -> Act {
    match envelope.request {
        Request::Create { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    }
}

#[tokio::test]
async fn a_create_one_host_refuses_goes_to_another_under_a_later_owner_epoch() {
    let fleet = Fleet::start().await;
    let full = fleet.host("host-a.example").await;
    // Its ready clones make placement try it first.
    full.advertise_ready();
    full.behave(refuse_creates);
    let room = fleet.host("host-b.example").await;
    let view = std::sync::Arc::clone(fleet.running.service.view());
    until(
        Duration::from_secs(3),
        "the view has the ready clones",
        async || {
            view.named("host-a.example")
                .is_some_and(|known| !known.capacity.ready.is_empty())
        },
    )
    .await;

    let sandbox = fleet.create(json!({})).await;
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["host"], "host-b.example");
    assert_eq!(full.ops(), ["create"]);
    assert_eq!(room.ops(), ["create", "wake"]);
    let refused = full.seen()[0].envelope.sent.owner_epoch.unwrap();
    let taken = room.seen()[0].envelope.sent.owner_epoch.unwrap();
    assert!(taken > refused, "{taken} after {refused}");
    assert_eq!(room.holds(id(&sandbox)), Some(taken));
    assert_eq!(row["owner_epoch"], taken);
}

#[tokio::test]
async fn a_create_every_host_refuses_leaves_no_sandbox_behind() {
    let fleet = Fleet::start().await;
    let full = fleet.host("host-a.example").await;
    full.behave(refuse_creates);
    let (status, body) = fleet
        .post("/v1/sandboxes", json!({ "vcpus": 1, "memory_mib": 256 }))
        .await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(full.ops(), ["create"]);
    let (_, all) = fleet.get("/v1/sandboxes").await;
    assert_eq!(all, json!([]), "the refused create left a row");
}

#[tokio::test]
async fn the_service_keeps_its_side_open_until_a_host_answers() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    host.check_open();
    let sandbox = fleet.create(json!({})).await;
    let path = format!("/v1/sandboxes/{sandbox}");
    assert_eq!(fleet.post(&format!("{path}/wake"), json!({})).await.0, 200);
    assert_eq!(fleet.delete(&path).await.0, 204);
    let seen = host.seen();
    assert_eq!(seen.len(), 4, "create, its run, the wake and the remove");
    for request in seen {
        assert_eq!(
            request.open_until_answer,
            Some(true),
            "{} closed early",
            op_name(&request.envelope.request)
        );
    }
}

/// Refuses every wake as a host too full to run another sandbox would.
fn refuse_wakes(envelope: &compute_protocol::fleet::Envelope) -> Act {
    match envelope.request {
        Request::Wake { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    }
}

#[tokio::test]
async fn a_create_its_host_cannot_run_goes_to_another_host() {
    let fleet = Fleet::start().await;
    let full = fleet.host("host-a.example").await;
    // Its ready clones make placement try it first.
    full.advertise_ready();
    full.behave(refuse_wakes);
    let room = fleet.host("host-b.example").await;
    let view = std::sync::Arc::clone(fleet.running.service.view());
    until(
        Duration::from_secs(3),
        "the view has the ready clones",
        async || {
            view.named("host-a.example")
                .is_some_and(|known| !known.capacity.ready.is_empty())
        },
    )
    .await;

    let sandbox = fleet.create(json!({})).await;
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["host"], "host-b.example");
    assert_eq!(full.ops(), ["create", "wake", "remove"]);
    assert_eq!(full.holds(id(&sandbox)), None, "the full host kept it");
    assert_eq!(room.ops(), ["create", "wake"]);
    let removed = full.seen()[0].envelope.sent.owner_epoch.unwrap();
    let taken = room.seen()[0].envelope.sent.owner_epoch.unwrap();
    assert!(taken > removed, "{taken} after {removed}");
    assert_eq!(room.holds(id(&sandbox)), Some(taken));
}

#[tokio::test]
async fn a_create_no_host_can_run_leaves_no_sandbox_behind() {
    let fleet = Fleet::start().await;
    let full = fleet.host("host-a.example").await;
    full.behave(refuse_wakes);
    let (status, body) = fleet
        .post("/v1/sandboxes", json!({ "vcpus": 1, "memory_mib": 256 }))
        .await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(full.ops(), ["create", "wake", "remove"]);
    let (_, all) = fleet.get("/v1/sandboxes").await;
    assert_eq!(all, json!([]), "the create left a row");
    assert!(full.seen().iter().all(|seen| match &seen.envelope.request {
        Request::Create { id, .. } => full.holds(*id).is_none(),
        _ => true,
    }));
}

/// A burst of creates on one host whose report fits them all but which can
/// run only two: all are sent to it, the two it can run are created, and
/// the rest leave nothing behind, on the host or in the store.
#[tokio::test]
async fn a_burst_of_creates_leaves_only_the_sandboxes_its_host_can_run() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let running = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new()));
    let woken = std::sync::Arc::clone(&running);
    host.behave(move |envelope| match envelope.request {
        Request::Wake { id, .. } => {
            let mut running = woken.lock().unwrap();
            if running.contains(&id) || running.len() < 2 {
                running.insert(id);
                Act::Ordinary
            } else {
                Act::Reply(Reply::Error {
                    message: "full".into(),
                    code: ErrorCode::HostFull,
                })
            }
        }
        _ => Act::Ordinary,
    });
    let creates =
        (0..8).map(|_| fleet.post("/v1/sandboxes", json!({ "vcpus": 1, "memory_mib": 256 })));
    let answers = futures::future::join_all(creates).await;
    let made: Vec<&serde_json::Value> = answers
        .iter()
        .filter(|(status, _)| *status == 201)
        .map(|(_, body)| body)
        .collect();
    assert_eq!(made.len(), 2, "{answers:?}");
    assert!(
        answers
            .iter()
            .all(|(status, _)| *status == 201 || *status == 503),
        "{answers:?}"
    );
    let (_, all) = fleet.get("/v1/sandboxes").await;
    assert_eq!(all.as_array().unwrap().len(), 2, "{all}");
    let held: Vec<Id> = running.lock().unwrap().iter().copied().collect();
    for made in made {
        let sandbox = id(made["id"].as_str().unwrap());
        assert!(held.contains(&sandbox));
        assert!(host.holds(sandbox).is_some());
    }
    let creates = host.ops().iter().filter(|op| **op == "create").count();
    let removes = host.ops().iter().filter(|op| **op == "remove").count();
    assert_eq!((creates, removes), (8, 6));
}

/// Hosts start sandboxes from their one base image, so a create naming
/// another image is refused rather than given the base.
#[tokio::test]
async fn a_create_naming_an_image_the_fleet_lacks_is_refused() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let (status, body) = fleet
        .post(
            "/v1/sandboxes",
            serde_json::json!({ "image": "ghcr.io/example/other:1", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(!host.ops().contains(&"create"), "{:?}", host.ops());
    let (status, body) = fleet
        .post(
            "/v1/sandboxes",
            serde_json::json!({ "image": "base", "vcpus": 1, "memory_mib": 256 }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
}
