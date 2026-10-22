//! Hosts' leases: when the service gives up on a host, what becomes of its
//! sandboxes, and how a host that comes back is told what is still its.

use std::sync::Arc;
use std::time::{Duration, Instant};

use compute_control::view::View;
use compute_protocol::fleet::{Capacity, Envelope, Registered};
use compute_protocol::host::{ErrorCode, Reply, Request};
use serde_json::json;

use super::support::{Act, FakeHost, Fleet, counted, given_up, id, roomy, until};

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
    // Its lost owner may have run it on past the archive, so it is taken
    // up from the archive's files alone.
    assert_eq!(b.adopts(id(&archived)), [true]);
    // With no archive, nothing of it exists anywhere but on the lost host.
    let (status, refused) = fleet
        .post(&format!("/v1/sandboxes/{unarchived}/wake"), json!({}))
        .await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(b.holds(id(&unarchived)), None);

    // Once an owner hands it off, its archive is its latest state again,
    // memory and all.
    let c = fleet.host("host-c.example").await;
    let (status, moved) = fleet
        .post(
            &format!("/v1/sandboxes/{archived}/move"),
            json!({ "to": "host-c.example" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(c.adopts(id(&archived)), [false]);
}

fn refuse_adopts(envelope: &Envelope) -> Act {
    match envelope.request {
        Request::Adopt { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    }
}

/// A host given a lost owner's copy that refused it holds nothing of it,
/// so moving the sandbox off that host vouches for nothing: the next host
/// still takes the copy up from its files.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_owners_copy_stays_unvouched_through_a_host_that_refused_it() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    a.archive(id(&sandbox), 1).await;
    let b = fleet.host("host-b.example").await;
    b.behave(refuse_adopts);
    a.renewing(false);
    given_up(&fleet, &a).await;
    let (status, refused) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_ne!(status, 200, "{refused}");
    assert_eq!(b.holds(id(&sandbox)), None);
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["host"], json!("host-b.example"), "given to b: {row}");

    b.behave(|_| Act::Ordinary);
    let c = fleet.host("host-c.example").await;
    let (status, moved) = fleet
        .post(
            &format!("/v1/sandboxes/{sandbox}/move"),
            json!({ "to": "host-c.example" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert!(b.ops().contains(&"hand_off"), "{:?}", b.ops());
    assert_eq!(c.adopts(id(&sandbox)), [true]);
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

/// What `view` last heard `host` can take on.
fn heard(view: &View, host: &FakeHost) -> Option<Capacity> {
    view.hosts()
        .into_iter()
        .find(|known| known.target.host.0 == host.id())
        .map(|known| known.capacity)
}

/// A restarted agent renews the lease it holds while it takes back its
/// sandboxes, which can outlast the term, before it can say what it can
/// take on, and refuses requests until then. The service keeps the host
/// and what it last reported, so neither placement nor scaling sees a
/// host gone empty, and a create it refuses meanwhile goes elsewhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_renewing_while_its_agent_starts_keeps_its_lease_and_last_capacity() {
    let fleet = Fleet::start().await;
    let a = fleet.host("host-a.example").await;
    let reported = Capacity {
        sandboxes: 7,
        awake: 3,
        ..roomy()
    };
    a.set_capacity(reported.clone());
    let view = Arc::clone(fleet.running.service.view());
    until(
        Duration::from_secs(5),
        "the service hears its capacity",
        async || heard(&view, &a).as_ref() == Some(&reported),
    )
    .await;
    a.starting(true);
    a.behave(|_| {
        Act::Reply(Reply::Error {
            message: "this host's agent is starting".into(),
            code: ErrorCode::Unavailable,
        })
    });
    let b = fleet.host("host-b.example").await;
    let terms = fleet.terms;
    tokio::time::sleep(terms.term + terms.margin + terms.renew_every).await;
    assert!(counted(&fleet, &a).await, "not given up on while it renews");
    assert_eq!(heard(&view, &a), Some(reported));

    for _ in 0..8 {
        let sandbox = fleet.create(json!({})).await;
        let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
        assert_eq!(row["host"], json!("host-b.example"), "{row}");
        assert!(b.holds(id(&sandbox)).is_some());
    }
}
