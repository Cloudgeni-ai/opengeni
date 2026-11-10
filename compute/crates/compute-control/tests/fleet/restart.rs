//! Restarting a sandbox: its owner restarts it where it is, ending its VM
//! unsaved and forgetting its memory image, so its next wake boots it from
//! its disk on the same host with nothing stored first. An owner from
//! before that request hands it off as a resize does, even awake, and it
//! is taken anew with its copy's files only.

use compute_protocol::host::{ErrorCode, Reply, Request};
use serde_json::{Value, json};

use super::support::{Act, Fleet, id};

async fn restart(fleet: &Fleet, sandbox: &str) -> (u16, Value) {
    fleet
        .post(&format!("/v1/sandboxes/{sandbox}/restart"), json!({}))
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_is_done_where_the_sandbox_is_with_nothing_handed_off() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (_, before) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;

    let (status, restarted) = restart(&fleet, &sandbox).await;
    assert_eq!(status, 200, "{restarted}");
    assert_eq!(restarted["host"], before["host"], "it stays where it is");
    assert_eq!(restarted["config"], before["config"], "its shape is kept");
    assert_eq!(restarted["owner_epoch"], before["owner_epoch"]);
    let ops = a.ops();
    assert!(ops.contains(&"restart"), "{ops:?}");
    assert!(
        !ops.contains(&"hand_off"),
        "nothing is stored first: {ops:?}"
    );
    assert_eq!(a.holds(id(&sandbox)), Some(1));

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!(status, 200, "{woken}");
    assert_eq!(a.adopts(id(&sandbox)), Vec::<bool>::new());
}

/// A host busy with the sandbox, as one handing it off, says so, and the
/// caller hears it plainly, with nothing taken from the host.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_a_busy_host_refuses_is_told_why() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    a.behave(|envelope| match envelope.request {
        Request::Restart { .. } => Act::Reply(Reply::Error {
            code: ErrorCode::Busy,
            message: "sandbox is being handed off".into(),
        }),
        _ => Act::Ordinary,
    });
    let (status, refused) = restart(&fleet, &sandbox).await;
    assert_eq!(status, 409, "{refused}");
    assert!(
        refused.to_string().contains("being handed off"),
        "{refused}"
    );
    assert_eq!(a.holds(id(&sandbox)), Some(1));
}

/// A host from before the restart request refuses it as invalid: the
/// sandbox is handed off, even awake, and its next wake boots it from its
/// disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_older_host_restarts_by_a_hand_off_and_its_next_wake_boots_from_the_disk() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    assert_eq!(a.holds(id(&sandbox)), Some(1));
    let (_, before) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    a.behave(|envelope| match envelope.request {
        Request::Restart { .. } => Act::Reply(Reply::Error {
            code: ErrorCode::Invalid,
            message: "invalid request: unknown variant `restart`".into(),
        }),
        _ => Act::Ordinary,
    });

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
