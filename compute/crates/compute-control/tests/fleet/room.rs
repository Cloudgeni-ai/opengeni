//! A fleet with no room for sandboxes nobody owns: the wakes waiting for
//! room cost almost nothing, and land as soon as room comes back.

use std::time::{Duration, Instant};

use compute_protocol::fleet::{Capacity, Envelope};
use compute_protocol::host::{ErrorCode, Reply, Request};
use futures::future::join_all;
use serde_json::json;

use super::support::{Act, Fleet, declare_gone, given_up, id, roomy};

fn refuse_adopts(envelope: &Envelope) -> Act {
    match envelope.request {
        Request::Adopt { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    }
}

/// How often the pointers of `sandboxes` were read, in all.
fn pointer_reads(fleet: &Fleet, sandboxes: &[String]) -> u64 {
    sandboxes
        .iter()
        .map(|sandbox| fleet.store.pointer_reads(sandbox))
        .sum()
}

fn adopts(ops: &[&str]) -> usize {
    ops.iter().filter(|op| **op == "adopt").count()
}

/// A fleet whose host `a`, given up on, owned `sandboxes` sandboxes, each
/// archived, and whose only other host `b` refuses every adopt as full.
async fn no_room(
    sandboxes: usize,
    wake_within: Duration,
) -> (Fleet, super::support::FakeHost, Vec<String>) {
    let fleet = Fleet::start_with(None, |settings| settings.wake_within = wake_within).await;
    let a = fleet.host("host-a.example").await;
    let mut created = Vec::new();
    for _ in 0..sandboxes {
        let sandbox = fleet.create(json!({})).await;
        a.archive(id(&sandbox), 1).await;
        created.push(sandbox);
    }
    let b = fleet.host("host-b.example").await;
    b.behave(refuse_adopts);
    a.renewing(false);
    given_up(&fleet, &a).await;
    declare_gone(&fleet, &a).await;
    (fleet, b, created)
}

/// Five sandboxes, four callers waking each, for a minute with no room:
/// the full host is asked again only once what it refused could have
/// changed, and a try that cannot place reads no archive pointer and
/// writes no row. Before, each caller asked it about four times a second,
/// each ask reading the pointer and writing the row twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wakes_waiting_a_minute_for_room_ask_the_full_host_only_when_it_could_have_changed() {
    const SANDBOXES: usize = 5;
    const CALLERS: usize = 4;
    let within = Duration::from_secs(60);
    let (fleet, b, sandboxes) = no_room(SANDBOXES, within).await;
    let before = fleet.store.calls();
    let read_before = pointer_reads(&fleet, &sandboxes);
    let started = Instant::now();
    let paths: Vec<String> = sandboxes
        .iter()
        .flat_map(|sandbox| (0..CALLERS).map(move |_| format!("/v1/sandboxes/{sandbox}/wake")))
        .collect();
    let wakes = paths.iter().map(|path| fleet.post(path, json!({})));
    let answers = join_all(wakes).await;
    let took = started.elapsed();
    let after = fleet.store.calls();
    for (status, body) in &answers {
        assert_eq!(*status, 503, "{body}");
    }
    assert!(took >= within, "{took:?}");
    let ops = b.ops();
    let asked = adopts(&ops);
    let woken = ops.iter().filter(|op| **op == "wake").count();
    let reads = pointer_reads(&fleet, &sandboxes) - read_before;
    let writes = after.sandbox_writes - before.sandbox_writes;
    let rows = after.sandbox_reads - before.sandbox_reads;
    eprintln!(
        "over {took:?}: {asked} adopts and {woken} wakes asked, {reads} pointer reads, \
         {writes} row writes, {rows} row reads"
    );
    // A refusal is believed for ten seconds at most while the host's
    // reports stay the same, so each sandbox asks about once per ten
    // seconds, however many callers wait.
    let periods = usize::try_from(within.as_secs() / 10).unwrap() + 1;
    assert!(asked <= SANDBOXES * periods, "{asked} adopts asked");
    assert!(woken <= SANDBOXES * periods, "{woken} wakes asked");
    // Each ask reads the pointer once at most (an adopt before it is sent,
    // a wake the host does not hold once it is answered), and writes the
    // row twice at most (the new owner epoch, then the refusal); a try
    // that cannot place does neither.
    let asked = u64::try_from(asked + woken).unwrap();
    assert!(reads <= asked, "{reads} pointer reads for {asked} asks");
    assert!(writes <= 2 * asked, "{writes} row writes for {asked} asks");
    // Waiting, each sandbox's row is read about once a second, by one
    // of its callers.
    let bound = 3 * u64::try_from(SANDBOXES).unwrap() * within.as_secs();
    assert!(rows <= bound, "{rows} row reads");
    for sandbox in &sandboxes {
        assert_eq!(b.holds(id(sandbox)), None);
    }
}

/// Room that comes back shows in the full host's next report, and a wake
/// waiting for it lands within about a second.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_waiting_for_room_lands_within_a_second_once_room_comes_back() {
    let (fleet, b, sandboxes) = no_room(1, Duration::from_secs(30)).await;
    let sandbox = &sandboxes[0];
    let path = format!("/v1/sandboxes/{sandbox}/wake");
    let woken = fleet.post(&path, json!({}));
    let room = async {
        // Long enough to be refused and wait.
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(adopts(&b.ops()), 1, "{:?}", b.ops());
        b.behave(|_| Act::Ordinary);
        b.set_capacity(Capacity {
            sandboxes: 1,
            ..roomy()
        });
        Instant::now()
    };
    let ((status, body), back) = tokio::join!(woken, room);
    let took = back.elapsed();
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["host"], "host-b.example", "{body}");
    eprintln!("woken {took:?} after room came back");
    assert!(took < Duration::from_millis(1500), "{took:?}");
    assert_eq!(adopts(&b.ops()), 2, "{:?}", b.ops());
}

/// A create a full host refused is not sent there again, nor one asking
/// for more of the same shape, until its report changes: the next goes
/// straight to no capacity, writing nothing. One of another shape, which
/// a ready clone could take, is still sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_a_full_host_refused_is_not_sent_there_again_until_it_reports_anew() {
    let fleet = Fleet::start().await;
    let full = fleet.host("host-a.example").await;
    full.behave(|envelope| match envelope.request {
        Request::Create { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    });
    let asking = |memory_mib: u32, disk_mib: u32| json!({ "vcpus": 1, "memory_mib": memory_mib, "disk_mib": disk_mib });
    let (status, body) = fleet.post("/v1/sandboxes", asking(512, 16 << 10)).await;
    assert_eq!(status, 503, "{body}");
    let before = fleet.store.calls();
    for disk_mib in [16 << 10, 32 << 10] {
        let (status, body) = fleet.post("/v1/sandboxes", asking(512, disk_mib)).await;
        assert_eq!(status, 503, "{body}");
    }
    assert_eq!(full.ops(), ["create"]);
    assert_eq!(fleet.store.calls().sandbox_writes, before.sandbox_writes);
    let (status, body) = fleet.post("/v1/sandboxes", asking(256, 16 << 10)).await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(full.ops(), ["create", "create"]);

    // Once what it reports changes, it is asked again.
    full.set_capacity(Capacity {
        sandboxes: 1,
        ..roomy()
    });
    let view = std::sync::Arc::clone(fleet.running.service.view());
    super::support::until(
        Duration::from_secs(3),
        "the view has its report",
        async || {
            view.named("host-a.example")
                .is_some_and(|known| known.capacity.sandboxes == 1)
        },
    )
    .await;
    let (status, body) = fleet.post("/v1/sandboxes", asking(512, 32 << 10)).await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(full.ops(), ["create", "create", "create"]);
}

fn refuse_wakes(envelope: &Envelope) -> Act {
    match envelope.request {
        Request::Wake { .. } => Act::Reply(Reply::Error {
            message: "full".into(),
            code: ErrorCode::HostFull,
        }),
        _ => Act::Ordinary,
    }
}

/// An owner with no room for a wake hands the sandbox off, and the wake
/// places it on a host that has room, at once, instead of waiting for
/// room where it last ran (ADR 38). Before, the wake waited for the full
/// owner until its deadline although another host had room.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_owner_hands_a_wake_on_to_a_host_with_room() {
    let fleet = Fleet::start_with(None, |settings| {
        settings.wake_within = Duration::from_secs(20);
    })
    .await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    assert_eq!(a.holds(id(&sandbox)), Some(1));
    let b = fleet.host("host-b.example").await;
    a.behave(refuse_wakes);

    let started = Instant::now();
    let (status, body) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    let took = started.elapsed();
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["host"], "host-b.example", "{body}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    assert_eq!(a.ops(), ["create", "wake", "hand_off"]);
    assert_eq!(a.holds(id(&sandbox)), None);
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    let epoch = row["owner_epoch"].as_u64().unwrap();
    assert_eq!(b.holds(id(&sandbox)), Some(epoch));
    assert_eq!(adopts(&b.ops()), 1, "{:?}", b.ops());
}

/// With no other host that has room, moving would not wake it sooner: the
/// full owner keeps it, the wake waits for room there, and lands there as
/// soon as the owner has room again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_owner_keeps_a_sandbox_no_other_host_has_room_for() {
    let fleet = Fleet::start_with(None, |settings| {
        settings.wake_within = Duration::from_secs(20);
    })
    .await;
    let a = fleet.host("host-a.example").await;
    let sandbox = fleet.create(json!({})).await;
    let b = fleet.host("host-b.example").await;
    b.set_capacity(Capacity {
        memory_free_mib: 0,
        ..roomy()
    });
    let view = std::sync::Arc::clone(fleet.running.service.view());
    super::support::until(
        Duration::from_secs(3),
        "the view has the full host's report",
        async || {
            view.named("host-b.example")
                .is_some_and(|known| known.capacity.memory_free_mib == 0)
        },
    )
    .await;
    a.behave(refuse_wakes);
    let path = format!("/v1/sandboxes/{sandbox}/wake");
    let woken = fleet.post(&path, json!({}));
    let room = async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        a.behave(|_| Act::Ordinary);
        a.set_capacity(Capacity {
            sandboxes: 1,
            ..roomy()
        });
    };
    let ((status, body), ()) = tokio::join!(woken, room);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["host"], "host-a.example", "{body}");
    assert!(!a.ops().contains(&"hand_off"), "{:?}", a.ops());
    assert_eq!(adopts(&b.ops()), 0, "{:?}", b.ops());
}
