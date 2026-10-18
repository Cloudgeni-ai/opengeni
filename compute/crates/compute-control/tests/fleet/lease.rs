//! Hosts' leases: when the service gives up on a host, what becomes of its
//! sandboxes, and how a host that comes back is told what is still its.

use std::time::{Duration, Instant};

use compute_protocol::fleet::Registered;
use serde_json::json;

use super::support::{Fleet, counted, given_up, id, until};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_is_given_up_on_no_sooner_than_its_term_and_margin_after_it_stopped() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let (_, before) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    host.renewing(false);
    let stopped = Instant::now();
    let gone = given_up(&fleet, &host).await;
    let terms = fleet.terms;
    assert!(
        gone - stopped >= (terms.term + terms.margin).saturating_sub(terms.renew_every),
        "given up on {:?} after its last renewal",
        gone - stopped
    );
    let (_, after) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(after["host"], serde_json::Value::Null, "{after}");
    assert!(
        after["owner_epoch"].as_u64() > before["owner_epoch"].as_u64(),
        "its epoch is raised past the lost owner's: {before} {after}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_of_a_host_given_up_on_wakes_elsewhere_from_its_archive() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let archived = fleet.create(json!({})).await;
    let unarchived = fleet.create(json!({})).await;
    a.archive(id(&archived), 1).await;
    let b = fleet.host("host-b.example").await;
    a.renewing(false);
    given_up(&fleet, &a).await;

    let (status, woken) = fleet
        .post(&format!("/v1/sandboxes/{archived}/wake"), json!({}))
        .await;
    assert_eq!((status, &woken["host"]), (200, &json!("host-b.example")));
    assert!(b.holds(id(&archived)).is_some_and(|epoch| epoch > 1));
    // With no archive, nothing of it exists anywhere but on the lost host.
    let (status, refused) = fleet
        .post(&format!("/v1/sandboxes/{unarchived}/wake"), json!({}))
        .await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(b.holds(id(&unarchived)), None);
}

/// A host given up on that comes back lists what it holds: what went
/// elsewhere meanwhile it drops, and what nobody took it gets back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_host_drops_what_moved_and_keeps_what_did_not() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let moved = fleet.create(json!({})).await;
    let kept = fleet.create(json!({})).await;
    a.archive(id(&moved), 1).await;
    let b = fleet.host("host-b.example").await;
    a.renewing(false);
    given_up(&fleet, &a).await;
    let (status, _) = fleet
        .post(&format!("/v1/sandboxes/{moved}/wake"), json!({}))
        .await;
    assert_eq!(status, 200);
    assert!(b.holds(id(&moved)).is_some());

    let old = a.epoch();
    let Registered::Registered { epoch, .. } = a.register().await else {
        panic!("a host given up on registers afresh");
    };
    assert!(epoch > old);
    assert_eq!(a.holds(id(&moved)), None, "taken by another host meanwhile");
    let reclaimed = a.holds(id(&kept)).expect("nobody took it");
    assert!(reclaimed > 1, "under a raised epoch");
    fleet.sees(&a).await;
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{kept}")).await;
    assert_eq!(
        (&row["host"], row["owner_epoch"].as_u64()),
        (&json!("host-a.example"), Some(reclaimed))
    );
}

/// A host that renews a registration the service gave up on is told so,
/// and registers again under a new epoch; until then a new attempt waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_renewing_a_lost_registration_registers_again() {
    let fleet = Fleet::start().await;
    let host = fleet.host("host-a.example").await;
    let old = host.epoch();
    host.renewing(false);
    assert!(matches!(
        host.register().await,
        Registered::StillLive { .. }
    ));
    given_up(&fleet, &host).await;
    host.renewing(true);
    until(Duration::from_secs(5), "it registers again", async || {
        host.epoch() > old && counted(&fleet, &host).await
    })
    .await;
}
