//! Restarting a sandbox: it is handed off as a resize does, even awake,
//! and taken anew with its copy's files only, so its next wake boots it
//! from its disk at the shape it had.

use compute_protocol::host::Request;
use serde_json::{Value, json};

use super::support::{Fleet, id};

async fn restart(fleet: &Fleet, sandbox: &str) -> (u16, Value) {
    fleet
        .post(&format!("/v1/sandboxes/{sandbox}/restart"), json!({}))
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_hands_an_awake_sandbox_off_and_its_next_wake_boots_it_from_its_disk() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    assert_eq!(a.holds(id(&sandbox)), Some(1));
    let (_, before) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;

    let (status, restarted) = restart(&fleet, &sandbox).await;
    assert_eq!(status, 200, "{restarted}");
    assert_eq!(restarted["host"], Value::Null, "{restarted}");
    assert_eq!(restarted["config"], before["config"], "its shape is kept");
    assert!(restarted["owner_epoch"].as_u64() > before["owner_epoch"].as_u64());
    // Handed off even though it was awake: a restart is for a running box.
    assert!(
        a.seen()
            .into_iter()
            .any(|seen| matches!(seen.envelope.request, Request::HandOff { awake: true, .. })),
        "{:?}",
        a.ops()
    );
    assert_eq!(a.holds(id(&sandbox)), None);

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!(status, 200, "{woken}");
    // Taken up from its files alone: it boots from its disk.
    assert_eq!(a.adopts(id(&sandbox)), [true]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_nobody_owns_is_restarted_at_once_without_asking_a_host() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (status, moved) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/move"), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    let asked = a.ops().len();

    let (status, restarted) = restart(&fleet, &sandbox).await;
    assert_eq!(status, 200, "{restarted}");
    assert!(restarted["owner_epoch"].as_u64() > moved["owner_epoch"].as_u64());
    assert_eq!(a.ops().len(), asked, "{:?}", a.ops());

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!(status, 200, "{woken}");
    // A move keeps the copy whole; the restart left it files only.
    assert_eq!(a.adopts(id(&sandbox)), [true]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restarting_an_unknown_sandbox_is_not_found() {
    let fleet = Fleet::start().await;
    let _a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (status, deleted) = fleet.delete(&format!("/v1/sandboxes/{sandbox}")).await;
    assert!(status == 204 || status == 200, "{deleted}");
    let (status, missing) = restart(&fleet, &sandbox).await;
    assert_eq!(
        (status, &missing["code"]),
        (404, &json!("not_found")),
        "{missing}"
    );
}
