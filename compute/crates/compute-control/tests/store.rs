//! What every store must do, checked against the store in memory and,
//! when `COMPUTE_TEST_POSTGRES` names a database, against Postgres: the
//! conditional writes the service's correctness rests on.
//!
//! Each check uses host names and sandbox ids of its own, so they can share
//! one database and run at once.

use std::collections::BTreeMap;
use std::future::Future;

use compute_control::e2b::lifecycle::{OnTimeout, Record, State};
use compute_control::store::{
    Admission, AgentRef, Collector, Inserted, LifecycleRow, Linked, MemoryStore, PostgresStore,
    RequestRow, SandboxRow, Spec, Store, TEMPLATE_PREFIX, TemplateRow, Write, replace_lifecycle,
};
use compute_fleet::{HostId, HostState, OwnerEpoch, Ownership, SandboxId, Sends};
use compute_protocol::fleet::{Capacity, Held, HostInfo, Register, Renew, Verdict};
use compute_protocol::host::{Id, ImageId, SandboxConfig, SleepConfig};

fn random() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}

/// The time now, which checks give up on hosts at: later than any time
/// [`forgetting`] prunes before.
fn now_ms() -> u64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    u64::try_from(since.as_millis()).unwrap()
}

fn capacity() -> Capacity {
    Capacity {
        memory_free_mib: 1024,
        memory_reclaimable_mib: 0,
        cpu_millis: 4000,
        cpu_free_millis: 4000,
        disk_free_mib: 1024,
        ready: Vec::new(),
        awake: 0,
        sandboxes: 0,
    }
}

/// A registration of a host named `name` under attempt `attempt`.
fn register(name: &str, attempt: u64, held: Vec<Held>) -> Register {
    Register {
        host: None,
        attempt,
        info: HostInfo {
            name: name.to_owned(),
            address: "127.0.0.1:1".into(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "none".into(),
            memory_mib: 4096,
            cpu_millis: 4000,
            disk_mib: 4096,
            boot: None,
        },
        capacity: capacity(),
        held,
    }
}

/// A host name no other check uses.
fn name() -> String {
    format!("host-{:016x}.example", random())
}

fn sandbox(owner: HostId) -> SandboxRow {
    SandboxRow {
        id: Id(SandboxId(u128::from(random()) << 64 | u128::from(random()))),
        team: format!("team-{:x}", random()),
        spec: Spec {
            image: "base".into(),
            config: SandboxConfig {
                disk_mib: None,
                vcpus: 1,
                memory_mib: 256,
                memory_request_mib: None,
                cpu_request_millis: None,
                sleep: SleepConfig::RECOMMENDED,
                image: None,
                link: None,
            },
            agent: Some(AgentRef {
                workspace: "w".into(),
                agent: "a".into(),
            }),
        },
        metadata: BTreeMap::from([("purpose".to_owned(), "conformance".to_owned())]),
        ownership: Ownership::created(owner),
        sends: Sends::default(),
        class: Some("nested/none".into()),
        created_ms: 1,
        version: 0,
    }
}

async fn registered<S: Store>(store: &S, register: &Register) -> (HostId, u64) {
    match store.register(register).await.unwrap() {
        Admission::Registered { host, epoch, .. } => (host, epoch.0),
        Admission::StillLive => panic!("{} is still live", register.info.name),
    }
}

async fn renewals<S: Store>(store: &S, host: HostId) -> Option<u64> {
    store
        .renewals()
        .await
        .unwrap()
        .into_iter()
        .find_map(|counted| (counted.host == host).then_some(counted.renewals))
}

/// Runs a check against every store at hand: `memory` and `postgres` are
/// the same check for each.
async fn each<M, P>(
    memory: impl FnOnce(MemoryStore) -> M,
    postgres: impl FnOnce(PostgresStore) -> P,
) where
    M: Future<Output = ()>,
    P: Future<Output = ()>,
{
    memory(MemoryStore::new()).await;
    if let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") {
        let store = PostgresStore::connect(&url, None, 16).await.unwrap();
        postgres(store).await;
    }
}

async fn registration<S: Store>(store: S) {
    let name = name();
    // Attempts are nonces over the whole of `u64`.
    let attempt = u64::MAX - random() % 1000;
    let first = register(&name, attempt, Vec::new());
    let (host, epoch) = registered(&store, &first).await;
    assert_eq!(
        registered(&store, &first).await,
        (host, epoch),
        "the same attempt is answered again"
    );
    let next = register(&name, attempt - 1, Vec::new());
    assert_eq!(store.register(&next).await.unwrap(), Admission::StillLive);
    let renew = Renew {
        host: host.0,
        epoch,
        seq: 1,
        capacity: Some(capacity()),
    };
    assert!(
        store
            .renew(&renew, std::slice::from_ref(&name))
            .await
            .unwrap()
    );
    // A restarted agent renews while it takes its sandboxes back, before
    // it can say what it can take on: the capacity last heard stays.
    let starting = Renew {
        seq: 2,
        capacity: None,
        ..renew.clone()
    };
    assert!(
        store
            .renew(&starting, std::slice::from_ref(&name))
            .await
            .unwrap()
    );
    let hosts = store.hosts_changed(0).await.unwrap();
    let row = hosts.iter().find(|row| row.id == host).unwrap();
    assert_eq!((row.seq, &row.capacity), (2, &capacity()));
    assert!(
        !store
            .renew(&renew, &["someone-else.example".into()])
            .await
            .unwrap(),
        "only the host named may renew"
    );
    let count = renewals(&store, host).await.expect("counted");
    assert_eq!(
        store.give_up(host, count - 1, now_ms()).await.unwrap(),
        None,
        "a renewal since saves it"
    );
    assert_eq!(store.give_up(host, count, now_ms()).await.unwrap(), Some(0));
    assert_eq!(renewals(&store, host).await, None);
    assert!(
        !store
            .renew(&renew, std::slice::from_ref(&name))
            .await
            .unwrap(),
        "a lost registration renews nothing"
    );
    let (again, fresh) = registered(&store, &next).await;
    assert_eq!(again, host, "the same host, by name");
    assert!(fresh > epoch, "a fresh epoch");
}

#[tokio::test]
async fn registrations_are_answered_once_refused_while_live_and_renewed_by_their_host() {
    each(registration, registration).await;
}

async fn conditional_writes<S: Store>(store: S) {
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let mut row = sandbox(host);
    assert_eq!(store.insert(&row).await.unwrap(), Write::Done);
    assert_eq!(store.insert(&row).await.unwrap(), Write::Conflict);
    assert_eq!(store.sandbox(row.id).await.unwrap().as_ref(), Some(&row));

    row.metadata.insert("step".into(), "one".into());
    assert_eq!(
        compute_control::store::replace(&store, &mut row)
            .await
            .unwrap(),
        Write::Done
    );
    assert_eq!(row.version, 1);
    let mut stale = row.clone();
    stale.version = 0;
    assert_eq!(store.replace(&stale).await.unwrap(), Write::Conflict);
    assert_eq!(store.sandbox(row.id).await.unwrap().as_ref(), Some(&row));

    let listed = store.list(&row.team, &row.metadata).await.unwrap();
    assert_eq!(listed, vec![row.clone()]);
    let other = BTreeMap::from([("step".to_owned(), "two".to_owned())]);
    assert_eq!(store.list(&row.team, &other).await.unwrap(), Vec::new());
    assert_eq!(store.owned_by(host).await.unwrap(), vec![row.clone()]);

    assert!(!store.delete(row.id, 0).await.unwrap(), "a stale delete");
    assert!(store.delete(row.id, row.version).await.unwrap());
    assert_eq!(store.sandbox(row.id).await.unwrap(), None);
}

#[tokio::test]
async fn sandbox_writes_are_conditional_on_the_version_read() {
    each(conditional_writes, conditional_writes).await;
}

async fn owner_lost<S: Store>(store: S) {
    let (lost, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let (live, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let mut owned = sandbox(lost);
    assert_eq!(store.insert(&owned).await.unwrap(), Write::Done);
    let count = renewals(&store, lost).await.unwrap();
    assert_eq!(store.give_up(lost, count, now_ms()).await.unwrap(), Some(1));

    // Giving up cleared its owner under a raised epoch.
    let cleared = store.sandbox(owned.id).await.unwrap().unwrap();
    assert_eq!(cleared.ownership.owner, None);
    assert!(cleared.ownership.epoch > owned.ownership.epoch);
    assert!(cleared.version > owned.version);
    // Its next owner starts it from its stored files.
    assert!(!cleared.ownership.whole_copy(), "{cleared:?}");

    // Nothing can make it, or a new sandbox, the lost host's again.
    assert_eq!(
        store.insert(&sandbox(lost)).await.unwrap(),
        Write::OwnerLost
    );
    // Nor a host the store never had.
    let unknown = HostId((1 << 62) + random() % 1000);
    assert_eq!(
        store.insert(&sandbox(unknown)).await.unwrap(),
        Write::OwnerLost
    );
    owned = cleared;
    let mut back = owned.clone();
    back.ownership = owned.ownership.give(lost).set;
    assert_eq!(store.replace(&back).await.unwrap(), Write::OwnerLost);
    let mut unknown_owner = owned.clone();
    unknown_owner.ownership = owned.ownership.give(unknown).set;
    assert_eq!(
        store.replace(&unknown_owner).await.unwrap(),
        Write::OwnerLost
    );
    let mut elsewhere = owned.clone();
    elsewhere.ownership = owned.ownership.give(live).set;
    assert_eq!(store.replace(&elsewhere).await.unwrap(), Write::Done);
    let given = store.owned_by(live).await.unwrap().remove(0);
    assert_eq!(given.ownership.owner, Some(live));
    assert!(!given.ownership.whole_copy(), "giving it on keeps that");
    // Cleared from an owner that held nothing, it is no more whole...
    let mut cleared = given.clone();
    cleared.ownership = given.ownership.clear().set;
    assert_eq!(store.replace(&cleared).await.unwrap(), Write::Done);
    let cleared = store.sandbox(owned.id).await.unwrap().unwrap();
    assert!(!cleared.ownership.whole_copy(), "{cleared:?}");
    // ...until an owner hands it off.
    let mut given = cleared.clone();
    given.ownership = cleared.ownership.give(live).set;
    assert_eq!(store.replace(&given).await.unwrap(), Write::Done);
    let given = store.sandbox(owned.id).await.unwrap().unwrap();
    let mut released = given.clone();
    released.ownership = given.ownership.release().set;
    assert_eq!(store.replace(&released).await.unwrap(), Write::Done);
    let handed_off = store.sandbox(owned.id).await.unwrap().unwrap();
    assert!(handed_off.ownership.whole_copy(), "{handed_off:?}");
}

#[tokio::test]
async fn no_write_gives_a_sandbox_to_a_host_given_up_on() {
    each(owner_lost, owner_lost).await;
}

async fn racing_give_up<S: Store>(store: S) {
    // Writes naming a host race its give-up: whichever order they land in,
    // no sandbox ends up owned by the lost host.
    for _ in 0..20 {
        let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
        let count = renewals(&store, host).await.unwrap();
        let rows: Vec<SandboxRow> = (0..8).map(|_| sandbox(host)).collect();
        let (writes, given_up) = tokio::join!(
            futures::future::join_all(rows.iter().map(|row| store.insert(row))),
            store.give_up(host, count, now_ms()),
        );
        assert_eq!(
            given_up.unwrap(),
            Some(
                writes
                    .iter()
                    .filter(|write| matches!(write, Ok(Write::Done)))
                    .count()
            )
        );
        for row in &rows {
            if let Some(stored) = store.sandbox(row.id).await.unwrap() {
                assert_ne!(stored.ownership.owner, Some(host), "{stored:?}");
            }
        }
    }
}

#[tokio::test]
async fn writes_racing_a_give_up_never_leave_a_sandbox_with_the_lost_host() {
    each(racing_give_up, racing_give_up).await;
}

/// Whether the store lists `host`, in any state.
async fn listed<S: Store>(store: &S, host: HostId) -> bool {
    store
        .hosts_changed(0)
        .await
        .unwrap()
        .iter()
        .any(|row| row.id == host)
}

async fn forgetting<S: Store>(store: S) {
    let replaced = name();
    let (host, _) = registered(&store, &register(&replaced, random(), Vec::new())).await;
    let owned = sandbox(host);
    assert_eq!(store.insert(&owned).await.unwrap(), Write::Done);
    let (live, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    // Given up on long ago, before any other check's give-ups, so pruning
    // before then forgets only hosts like this one.
    let count = renewals(&store, host).await.unwrap();
    assert_eq!(store.give_up(host, count, 10).await.unwrap(), Some(1));
    store.prune_hosts(10).await.unwrap();
    assert!(listed(&store, host).await, "kept until its time is up");
    assert!(store.prune_hosts(11).await.unwrap() >= 1);
    assert!(!listed(&store, host).await, "forgotten");
    assert!(listed(&store, live).await, "a live host is kept");
    assert_eq!(renewals(&store, host).await, None);

    // A write naming the forgotten host is refused, as for any host given
    // up on; one naming no owner, or a live one, is not.
    assert_eq!(
        store.insert(&sandbox(host)).await.unwrap(),
        Write::OwnerLost
    );
    let cleared = store.sandbox(owned.id).await.unwrap().unwrap();
    assert_eq!(cleared.ownership.owner, None);
    let mut back = cleared.clone();
    back.ownership = cleared.ownership.give(host).set;
    assert_eq!(store.replace(&back).await.unwrap(), Write::OwnerLost);
    let mut unowned = cleared.clone();
    unowned.metadata.insert("step".into(), "unowned".into());
    assert_eq!(store.replace(&unowned).await.unwrap(), Write::Done);
    let mut unowned = store.sandbox(owned.id).await.unwrap().unwrap();
    let mut elsewhere = unowned.clone();
    elsewhere.ownership = unowned.ownership.give(live).set;
    assert_eq!(store.replace(&elsewhere).await.unwrap(), Write::Done);
    unowned = store.sandbox(owned.id).await.unwrap().unwrap();
    assert_eq!(unowned.ownership.owner, Some(live));

    // Its name registers afresh, as a new host that writes may name.
    let (again, _) = registered(&store, &register(&replaced, random(), Vec::new())).await;
    assert_ne!(again, host, "a new host");
    assert!(renewals(&store, again).await.is_some());
    assert_eq!(store.insert(&sandbox(again)).await.unwrap(), Write::Done);
    store.prune_hosts(11).await.unwrap();
    assert!(listed(&store, again).await, "a registered host is kept");
}

#[tokio::test]
async fn hosts_given_up_on_are_forgotten_in_time_and_stay_refused() {
    each(forgetting, forgetting).await;
}

/// The state the store has for `host`.
async fn state<S: Store>(store: &S, host: HostId) -> HostState {
    store
        .hosts_changed(0)
        .await
        .unwrap()
        .iter()
        .find(|row| row.id == host)
        .expect("listed")
        .state
}

/// Gives up on `host` and registers it again, as after a fence.
async fn back_after_a_fence<S: Store>(store: &S, name: &str, host: HostId) {
    let count = renewals(store, host).await.unwrap();
    assert_eq!(store.give_up(host, count, now_ms()).await.unwrap(), Some(0));
    assert_eq!(state(store, host).await, HostState::Lost);
    let (again, _) = registered(store, &register(name, random(), Vec::new())).await;
    assert_eq!(again, host, "the same host, by name");
}

async fn drained<S: Store>(store: S) {
    let name = name();
    let (host, _) = registered(&store, &register(&name, random(), Vec::new())).await;
    assert_eq!(state(&store, host).await, HostState::Live);
    assert!(
        store
            .set_state(host, HostState::Live, HostState::Draining)
            .await
            .unwrap()
    );
    back_after_a_fence(&store, &name, host).await;
    assert_eq!(
        state(&store, host).await,
        HostState::Draining,
        "a drained host comes back drained"
    );
    assert!(
        store
            .set_state(host, HostState::Draining, HostState::Live)
            .await
            .unwrap()
    );
    back_after_a_fence(&store, &name, host).await;
    assert_eq!(
        state(&store, host).await,
        HostState::Live,
        "an undrained host comes back live"
    );

    // Undrained while given up on, it stays given up on, then comes back
    // live; a host given up on cannot be drained.
    assert!(
        store
            .set_state(host, HostState::Live, HostState::Draining)
            .await
            .unwrap()
    );
    let count = renewals(&store, host).await.unwrap();
    assert_eq!(store.give_up(host, count, now_ms()).await.unwrap(), Some(0));
    assert!(
        store
            .set_state(host, HostState::Draining, HostState::Live)
            .await
            .unwrap(),
        "undrained while given up on"
    );
    assert_eq!(state(&store, host).await, HostState::Lost);
    assert!(
        !store
            .set_state(host, HostState::Draining, HostState::Live)
            .await
            .unwrap(),
        "undrained once"
    );
    assert!(
        !store
            .set_state(host, HostState::Live, HostState::Draining)
            .await
            .unwrap(),
        "not drained while given up on"
    );
    let (again, _) = registered(&store, &register(&name, random(), Vec::new())).await;
    assert_eq!(again, host);
    assert_eq!(state(&store, host).await, HostState::Live);
}

#[tokio::test]
async fn a_drained_host_given_up_on_registers_again_drained_until_undrained() {
    each(drained, drained).await;
}

/// Moves `host` from `from` to `to` as a build from before the drain mark
/// did.
async fn moved_by_an_older_build(
    client: &tokio_postgres::Client,
    host: HostId,
    from: &'static str,
    to: &'static str,
) {
    let moved = client
        .execute(
            "update compute_hosts set state = $3, changed = nextval('compute_changes') \
             where id = $1 and state = $2",
            &[&i64::try_from(host.0).unwrap(), &from, &to],
        )
        .await
        .unwrap();
    assert_eq!(moved, 1);
}

/// A build from before the mark, still running during a rollout, moves a
/// host without it: repeating the drain or undrain sets the mark for the
/// state the host is in already, so the operator's latest word holds when
/// the host is given up on and comes back. Repeated with the mark in step,
/// it changes nothing.
#[tokio::test]
async fn a_repeated_drain_or_undrain_mends_the_mark_an_older_build_left() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let store = PostgresStore::connect(&url, None, 2).await.unwrap();
    let older = |host, from, to| moved_by_an_older_build(&client, host, from, to);

    // Drained by the older build, then again by this one.
    let name = name();
    let (host, _) = registered(&store, &register(&name, random(), Vec::new())).await;
    older(host, "live", "draining").await;
    assert!(
        store
            .set_state(host, HostState::Live, HostState::Draining)
            .await
            .unwrap(),
        "the mark is set"
    );
    assert!(
        !store
            .set_state(host, HostState::Live, HostState::Draining)
            .await
            .unwrap(),
        "once"
    );
    back_after_a_fence(&store, &name, host).await;
    assert_eq!(state(&store, host).await, HostState::Draining);

    // Undrained by the older build, then again by this one.
    older(host, "draining", "live").await;
    assert!(
        store
            .set_state(host, HostState::Draining, HostState::Live)
            .await
            .unwrap(),
        "the mark is cleared"
    );
    assert!(
        !store
            .set_state(host, HostState::Draining, HostState::Live)
            .await
            .unwrap(),
        "once"
    );
    back_after_a_fence(&store, &name, host).await;
    assert_eq!(state(&store, host).await, HostState::Live);
}

async fn reclaim<S: Store>(store: S) {
    let returning = name();
    let (host, _) = registered(&store, &register(&returning, random(), Vec::new())).await;
    let kept = sandbox(host);
    let moved = sandbox(host);
    for row in [&kept, &moved] {
        assert_eq!(store.insert(row).await.unwrap(), Write::Done);
    }
    let count = renewals(&store, host).await.unwrap();
    store.give_up(host, count, now_ms()).await.unwrap();
    let (other, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let mut taken = store.sandbox(moved.id).await.unwrap().unwrap();
    taken.ownership = taken.ownership.give(other).set;
    assert_eq!(store.replace(&taken).await.unwrap(), Write::Done);

    let held = [&kept, &moved]
        .map(|row| Held {
            id: row.id,
            owner_epoch: row.ownership.epoch.0,
        })
        .to_vec();
    let Admission::Registered { rulings, .. } = store
        .register(&register(&returning, random(), held))
        .await
        .unwrap()
    else {
        panic!("a host given up on registers afresh");
    };
    let verdict = |id: Id| {
        rulings
            .iter()
            .find(|ruling| ruling.id == id)
            .map(|ruling| ruling.verdict)
    };
    assert_eq!(verdict(moved.id), Some(Verdict::Drop));
    let Some(Verdict::Keep { owner_epoch }) = verdict(kept.id) else {
        panic!("{rulings:?}");
    };
    let back = store.sandbox(kept.id).await.unwrap().unwrap();
    assert_eq!(
        (back.ownership.owner, back.ownership.epoch),
        (Some(host), OwnerEpoch(owner_epoch))
    );
    let hosts = store.hosts_changed(0).await.unwrap();
    let row = hosts.iter().find(|row| row.id == host).unwrap();
    assert_eq!(row.state, HostState::Live);
}

#[tokio::test]
async fn a_returning_host_gets_back_only_what_nobody_took() {
    each(reclaim, reclaim).await;
}

async fn reclaim_forgotten<S: Store>(store: S) {
    let returning = name();
    let (host, _) = registered(&store, &register(&returning, random(), Vec::new())).await;
    let row = sandbox(host);
    assert_eq!(store.insert(&row).await.unwrap(), Write::Done);
    // Given up on long ago, before the give-ups other checks count on
    // keeping, then forgotten.
    let count = renewals(&store, host).await.unwrap();
    assert_eq!(store.give_up(host, count, 5).await.unwrap(), Some(1));
    store.prune_hosts(6).await.unwrap();
    assert!(!listed(&store, host).await, "forgotten");

    // Back after being forgotten, it registers as a new host and gets back
    // what it still holds and nobody took.
    let held = vec![Held {
        id: row.id,
        owner_epoch: row.ownership.epoch.0,
    }];
    let Admission::Registered {
        host: again,
        rulings,
        ..
    } = store
        .register(&register(&returning, random(), held))
        .await
        .unwrap()
    else {
        panic!("a forgotten host registers afresh");
    };
    assert_ne!(again, host, "a new host");
    let Some(Verdict::Keep { owner_epoch }) = rulings
        .iter()
        .find(|ruling| ruling.id == row.id)
        .map(|ruling| ruling.verdict)
    else {
        panic!("{rulings:?}");
    };
    let back = store.sandbox(row.id).await.unwrap().unwrap();
    assert_eq!(
        (back.ownership.owner, back.ownership.epoch),
        (Some(again), OwnerEpoch(owner_epoch))
    );
}

#[tokio::test]
async fn a_host_back_after_being_forgotten_gets_back_what_nobody_took() {
    each(reclaim_forgotten, reclaim_forgotten).await;
}

fn image_id() -> ImageId {
    let mut id = [0; 32];
    for chunk in id.chunks_mut(8) {
        chunk.copy_from_slice(&random().to_le_bytes());
    }
    ImageId(id)
}

async fn images<S: Store>(store: S) {
    let name = format!("image-{:016x}", random());
    let old = format!("registry.example/sandbox@sha256:{:064x}", random());
    let new = format!("registry.example/sandbox@sha256:{:064x}", random());
    assert_eq!(store.image_built(&old).await.unwrap(), None);
    assert_eq!(store.latest_built(&name).await.unwrap(), None);

    let first = image_id();
    assert_eq!(
        store.record_built(&old, &name, first, 1).await.unwrap(),
        first
    );
    // Another host's build of the same OCI image is not the image recorded.
    let again = image_id();
    assert_eq!(
        store.record_built(&old, &name, again, 2).await.unwrap(),
        first
    );
    assert_eq!(store.image_built(&old).await.unwrap(), Some(first));
    assert_eq!(store.latest_built(&name).await.unwrap(), Some(first));

    // A newer source under the name is its latest; the older one keeps its
    // image, for a rollback to find.
    let next = image_id();
    assert_eq!(
        store.record_built(&new, &name, next, 3).await.unwrap(),
        next
    );
    assert_eq!(store.latest_built(&name).await.unwrap(), Some(next));
    assert_eq!(store.image_built(&old).await.unwrap(), Some(first));
    assert_eq!(store.image_built(&new).await.unwrap(), Some(next));

    // A second name using the old source keeps it as its latest, with the
    // image recorded first, while the first name moved on.
    let alias = format!("{name}-alias");
    assert_eq!(
        store
            .record_built(&old, &alias, image_id(), 4)
            .await
            .unwrap(),
        first
    );
    assert_eq!(store.latest_built(&alias).await.unwrap(), Some(first));
    assert_eq!(store.latest_built(&name).await.unwrap(), Some(next));

    // A rollback to the old source makes it the name's latest again.
    assert_eq!(
        store
            .record_built(&old, &name, image_id(), 5)
            .await
            .unwrap(),
        first
    );
    assert_eq!(store.latest_built(&name).await.unwrap(), Some(first));
}

#[tokio::test]
async fn the_first_image_recorded_for_a_source_is_the_one_kept() {
    each(images, images).await;
}

/// A use of a name's source that waited on its row while later uses were
/// recorded does not undo them: a rollback to that source, recorded
/// meanwhile, stays the name's latest.
#[tokio::test]
async fn a_delayed_use_does_not_undo_a_later_one() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let (mut client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let (watch, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let schema = format!("compute_uses_{:x}", random());
    client
        .batch_execute(&format!("create schema {schema}"))
        .await
        .unwrap();
    // The store's connections carry the schema's name, so the wait below
    // sees only this check's writes, not another run's on the same server.
    let scoped = format!("{url} options='-c search_path={schema}' application_name={schema}");
    let store = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    let name = "sandbox";
    let old = "registry.example/sandbox@sha256:01";
    let new = "registry.example/sandbox@sha256:02";
    let first = image_id();
    store.record_built(old, name, first, 1).await.unwrap();

    // Another write of the old source draws its number, then waits on the
    // row this transaction holds.
    let holder = client.transaction().await.unwrap();
    holder
        .execute(
            &format!(
                "select 1 from {schema}.compute_image_names \
                 where name = $1 and source = $2 for update"
            ),
            &[&name, &old],
        )
        .await
        .unwrap();
    let delayed = {
        let store = store.clone();
        tokio::spawn(async move { store.record_built(old, name, image_id(), 2).await })
    };
    let waiting = "select count(*) from pg_stat_activity where application_name = $1 \
                   and wait_event_type = 'Lock' and query like 'insert into compute_image_names%'";
    let mut waited = 0;
    while watch
        .query_one(waiting, &[&schema])
        .await
        .unwrap()
        .get::<_, i64>(0)
        == 0
    {
        assert!(waited < 500, "the delayed write never waited on the row");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        waited += 1;
    }

    // Meanwhile the name moves to a new source and rolls back to the old
    // one: the rollback is recorded by the transaction holding the row.
    let next = image_id();
    assert_eq!(store.record_built(new, name, next, 3).await.unwrap(), next);
    holder
        .execute(
            &format!(
                "update {schema}.compute_image_names \
                 set used = nextval('{schema}.compute_image_uses') \
                 where name = $1 and source = $2"
            ),
            &[&name, &old],
        )
        .await
        .unwrap();
    holder.commit().await.unwrap();
    assert_eq!(delayed.await.unwrap().unwrap(), first);
    assert_eq!(store.latest_built(name).await.unwrap(), Some(first));

    drop(store);
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .await
        .unwrap();
}

async fn keys<S: Store>(store: S) {
    let digest = format!("{:x}", random());
    assert_eq!(store.team_of(&digest).await.unwrap(), None);
    store.add_key(&digest, "team-k").await.unwrap();
    assert_eq!(
        store.team_of(&digest).await.unwrap().as_deref(),
        Some("team-k")
    );
}

#[tokio::test]
async fn keys_name_their_team() {
    each(keys, keys).await;
}

fn request(row: &SandboxRow, request_id: &str) -> RequestRow {
    RequestRow {
        team: row.team.clone(),
        request_id: request_id.into(),
        id: row.id,
        digest: "d1".into(),
        created_ms: 10,
        gone_ms: None,
    }
}

async fn requests<S: Store>(store: S) {
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let row = sandbox(host);
    let team = row.team.clone();
    let first = request(&row, "lease-1");
    assert_eq!(store.claim_request(&first).await.unwrap(), first);
    let again = RequestRow {
        id: Id(SandboxId(u128::from(random()))),
        digest: "d2".into(),
        ..first.clone()
    };
    assert_eq!(
        store.claim_request(&again).await.unwrap(),
        first,
        "a request id answers what it first made"
    );
    let other_team = RequestRow {
        team: format!("team-{:x}", random()),
        ..first.clone()
    };
    assert_eq!(store.claim_request(&other_team).await.unwrap(), other_team);
    assert_eq!(
        store.request(&team, "lease-1").await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(store.request(&team, "lease-2").await.unwrap(), None);

    // Made for its request, while the request is live.
    assert_eq!(
        store.insert_requested(&row, "lease-1").await.unwrap(),
        Some(Write::Done)
    );
    // A delete for a create that left nothing retires nothing.
    let stale = row.version + 1;
    assert!(!store.delete_retiring(row.id, stale, 50).await.unwrap());
    assert!(
        !store
            .request(&team, "lease-1")
            .await
            .unwrap()
            .unwrap()
            .gone()
    );
    // Deleted for good: its team's requests retire with it, in one write.
    assert!(
        store
            .delete_retiring(row.id, row.version, 50)
            .await
            .unwrap()
    );
    let gone = store.request(&team, "lease-1").await.unwrap().unwrap();
    assert_eq!(gone.gone_ms, Some(50));
    assert!(store.claim_request(&first).await.unwrap().gone());
    assert!(
        !store
            .request(&other_team.team, "lease-1")
            .await
            .unwrap()
            .unwrap()
            .gone(),
        "only the deleting team's requests retire"
    );
    // A replay that read the request before it retired cannot make the
    // sandbox again.
    assert_eq!(store.insert_requested(&row, "lease-1").await.unwrap(), None);
    assert_eq!(store.sandbox(row.id).await.unwrap(), None);
    // Nor can a request no create claimed.
    assert_eq!(store.insert_requested(&row, "lease-9").await.unwrap(), None);

    // Kept for as long from the deletion, however old the create.
    assert_eq!(store.prune_requests(50).await.unwrap(), 0);
    assert!(store.prune_requests(51).await.unwrap() >= 1);
    assert_eq!(store.request(&team, "lease-1").await.unwrap(), None);
    assert!(
        store
            .request(&other_team.team, "lease-1")
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn create_requests_answer_their_first_sandbox_until_it_is_gone() {
    each(requests, requests).await;
}

async fn replay_racing_delete<S: Store>(store: S) {
    // A replay that finds no row creates the sandbox again only if it was
    // never made: one that races its deletion never brings it back.
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    for _ in 0..30 {
        let row = sandbox(host);
        store.claim_request(&request(&row, "lease")).await.unwrap();
        assert_eq!(
            store.insert_requested(&row, "lease").await.unwrap(),
            Some(Write::Done)
        );
        let replay = async {
            loop {
                if store.sandbox(row.id).await.unwrap().is_none() {
                    return store.insert_requested(&row, "lease").await.unwrap();
                }
                tokio::task::yield_now().await;
            }
        };
        let (deleted, replayed) =
            tokio::join!(store.delete_retiring(row.id, row.version, 99), replay);
        assert!(deleted.unwrap());
        assert_eq!(replayed, None, "a deleted sandbox was made again");
        assert_eq!(store.sandbox(row.id).await.unwrap(), None);
        let request = store.request(&row.team, "lease").await.unwrap().unwrap();
        assert_eq!(request.gone_ms, Some(99));
    }
}

#[tokio::test]
async fn a_replayed_create_never_brings_back_a_deleted_sandbox() {
    each(replay_racing_delete, replay_racing_delete).await;
}

async fn agents<S: Store>(store: S) {
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let linked = sandbox(host);
    let mut plain = sandbox(host);
    plain.spec.agent = None;
    for row in [&linked, &plain] {
        assert_eq!(store.insert(row).await.unwrap(), Write::Done);
    }
    let missing = sandbox(host).id;
    let found = store.agents(&[linked.id, plain.id, missing]).await.unwrap();
    assert_eq!(
        found,
        vec![Linked {
            id: linked.id,
            team: linked.team.clone(),
            agent: linked.spec.agent.clone().unwrap(),
        }]
    );
    assert_eq!(store.agents(&[]).await.unwrap(), Vec::new());
}

#[tokio::test]
async fn the_agents_of_listed_sandboxes_are_found_in_one_read() {
    each(agents, agents).await;
}

fn lifecycle(team: &str, state: State, end_ms: u64) -> LifecycleRow {
    LifecycleRow {
        id: Id(SandboxId(u128::from(random()) << 64 | u128::from(random()))),
        team: team.to_owned(),
        record: Record {
            template: "base".into(),
            state,
            started_ms: 1,
            end_ms,
            timeout_ms: 300_000,
            on_timeout: OnTimeout::Pause,
            auto_resume: true,
            envd_token: "token".into(),
            traffic_token: None,
            cpu_count: 1,
            memory_mb: 512,
            changed_ms: 1,
        },
        version: 0,
    }
}

async fn lifecycles<S: Store>(store: S) {
    let team = format!("team-{:x}", random());
    // Due long ago, so other checks sharing the database find it first.
    let mut running = lifecycle(&team, State::Running, 5);
    let paused = lifecycle(&team, State::Paused, 5);
    assert!(store.insert_lifecycle(&running).await.unwrap());
    assert!(!store.insert_lifecycle(&running).await.unwrap(), "exists");
    assert!(store.insert_lifecycle(&paused).await.unwrap());
    assert_eq!(
        store.lifecycle(running.id).await.unwrap().as_ref(),
        Some(&running)
    );

    let stale = running.clone();
    running.record.set(State::Pausing, 7);
    assert!(replace_lifecycle(&store, &mut running).await.unwrap());
    assert_eq!(running.version, 1);
    assert!(
        !store.replace_lifecycle(&stale).await.unwrap(),
        "a write from the version before loses"
    );
    assert_eq!(
        store.lifecycle(running.id).await.unwrap(),
        Some(running.clone())
    );

    let mut listed = store.lifecycles(&team).await.unwrap();
    listed.sort_by_key(|row| row.id);
    let mut both = vec![running.clone(), paused.clone()];
    both.sort_by_key(|row| row.id);
    assert_eq!(listed, both);

    // A pause under way is due at once; a paused sandbox never is.
    let due: Vec<Id> = store
        .lifecycles_due(u64::MAX - 1, None, 100_000)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect();
    assert!(due.contains(&running.id));
    assert!(!due.contains(&paused.id));
    assert!(
        store
            .lifecycles_due(0, None, 10)
            .await
            .unwrap()
            .iter()
            .all(|row| row.record.due_ms() == 0)
    );

    // Read a page at a time, the due ones come each once, in order, past
    // any number due at the same time.
    let mut same = Vec::new();
    for _ in 0..5 {
        let row = lifecycle(&team, State::Killing, 0);
        assert!(store.insert_lifecycle(&row).await.unwrap());
        same.push(row.id);
    }
    let mut paged = Vec::new();
    let mut after = None;
    loop {
        let page = store.lifecycles_due(u64::MAX - 1, after, 2).await.unwrap();
        after = page.last().map(|row| (row.record.due_ms(), row.id));
        paged.extend(page.iter().map(|row| (row.record.due_ms(), row.id)));
        if page.len() < 2 {
            break;
        }
    }
    let mut sorted = paged.clone();
    sorted.sort_by_key(|(due, id)| (*due, id.to_string()));
    sorted.dedup();
    assert_eq!(paged, sorted, "in order, each once");
    for id in same.iter().chain([&running.id]) {
        assert!(paged.iter().any(|(_, paged)| paged == id));
    }
    for id in same {
        assert!(store.delete_lifecycle(id, 0).await.unwrap());
    }

    assert!(!store.delete_lifecycle(running.id, 0).await.unwrap());
    assert!(store.delete_lifecycle(running.id, 1).await.unwrap());
    assert!(store.delete_lifecycle(paused.id, 0).await.unwrap());
    assert_eq!(store.lifecycle(running.id).await.unwrap(), None);
    assert_eq!(store.lifecycles(&team).await.unwrap().len(), 0);
}

#[tokio::test]
async fn e2b_lifecycle_writes_are_conditional_and_due_ones_are_found() {
    each(lifecycles, lifecycles).await;
}

/// Paused lifecycles come a page at a time, each once, in order of id, and
/// nothing else does.
async fn paused_lifecycles<S: Store>(store: S) {
    let team = format!("team-{:x}", random());
    let running = lifecycle(&team, State::Running, 5);
    assert!(store.insert_lifecycle(&running).await.unwrap());
    let mut more = Vec::new();
    for _ in 0..5 {
        let row = lifecycle(&team, State::Paused, 5);
        assert!(store.insert_lifecycle(&row).await.unwrap());
        more.push(row.id);
    }
    let mut paged = Vec::new();
    let mut after = None;
    loop {
        let page = store.lifecycles_paused(after, 2).await.unwrap();
        assert!(page.iter().all(|row| row.record.state == State::Paused));
        after = page.last().map(|row| row.id);
        paged.extend(page.iter().map(|row| row.id.to_string()));
        if page.len() < 2 {
            break;
        }
    }
    let mut sorted = paged.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(paged, sorted, "in order, each once");
    for id in &more {
        assert!(paged.contains(&id.to_string()));
    }
    assert!(!paged.contains(&running.id.to_string()));
    assert!(store.delete_lifecycle(running.id, 0).await.unwrap());
    for id in &more {
        assert!(store.delete_lifecycle(*id, 0).await.unwrap());
    }
}

#[tokio::test]
async fn paused_e2b_lifecycles_are_read_a_page_at_a_time() {
    each(paused_lifecycles, paused_lifecycles).await;
}

/// Replicas starting together on an empty database migrate it once, to
/// the latest version, and starting again changes nothing.
#[tokio::test]
async fn replicas_starting_together_migrate_a_new_database_once() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let schema = format!("compute_upgrade_{:x}", random());
    client
        .batch_execute(&format!("create schema {schema}"))
        .await
        .unwrap();
    let scoped = format!("{url} options='-c search_path={schema}'");
    let replicas: Vec<_> = (0..4)
        .map(|_| {
            let scoped = scoped.clone();
            tokio::spawn(async move { PostgresStore::connect(&scoped, None, 2).await })
        })
        .collect();
    let mut stores = Vec::new();
    for replica in replicas {
        stores.push(replica.await.unwrap().expect("every replica starts"));
    }
    let (host, _) = registered(&stores[0], &register(&name(), random(), Vec::new())).await;
    let row = sandbox(host);
    assert_eq!(stores[0].insert(&row).await.unwrap(), Write::Done);
    drop(stores);
    let again = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    assert_eq!(again.sandbox(row.id).await.unwrap(), Some(row));
    let version: i32 = client
        .query_one(&format!("select version from {schema}.compute_schema"), &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(version, 6);
    drop(again);
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .await
        .unwrap();
}

/// A replica of an older build, still running during a rollout, refuses
/// only a sandbox write naming an owner listed as lost, so a host it does
/// not find passes its check. The database itself refuses a write naming a
/// host since forgotten: no build can leave a sandbox owned by a host that
/// nothing can give up on.
#[tokio::test]
async fn the_database_refuses_an_older_builds_write_naming_a_forgotten_host() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let store = PostgresStore::connect(&url, None, 2).await.unwrap();
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let (live, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let row = sandbox(live);
    assert_eq!(store.insert(&row).await.unwrap(), Write::Done);
    // Given up on before any other check's give-ups, then forgotten.
    let count = renewals(&store, host).await.unwrap();
    assert_eq!(store.give_up(host, count, 5).await.unwrap(), Some(0));
    store.prune_hosts(6).await.unwrap();
    assert!(!listed(&store, host).await, "forgotten");

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let forgotten = i64::try_from(host.0).unwrap();
    let older = "with owner as (select state = 'lost' as lost from compute_hosts \
                 where id = $1 for share) \
                 update compute_sandboxes set owner = $1, epoch = epoch + 1, \
                 version = version + 1 \
                 where id = $2 and not exists (select 1 from owner where lost)";
    let refused = client
        .execute(older, &[&forgotten, &row.id.to_string()])
        .await
        .expect_err("refused by the database");
    assert_eq!(
        refused.code(),
        Some(&tokio_postgres::error::SqlState::FOREIGN_KEY_VIOLATION),
        "{refused}"
    );
    let kept = store.sandbox(row.id).await.unwrap().unwrap();
    assert_eq!(kept.ownership, row.ownership, "the sandbox is unchanged");
}

/// A database whose sandbox names a host it does not have (none should)
/// still migrates: that sandbox is given up on, as giving up on its host
/// would, before the owner must be a host the store has.
#[tokio::test]
async fn migrating_gives_up_on_a_sandbox_naming_a_host_the_store_lacks() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let schema = format!("compute_dangling_{:x}", random());
    client
        .batch_execute(&format!("create schema {schema}"))
        .await
        .unwrap();
    let scoped = format!("{url} options='-c search_path={schema}'");
    let store = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let (live, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let dangling = sandbox(host);
    let kept = sandbox(live);
    for row in [&dangling, &kept] {
        assert_eq!(store.insert(row).await.unwrap(), Write::Done);
    }
    drop(store);
    // As the database was before this version: no constraint, and here a
    // host row gone that a sandbox still names.
    client
        .batch_execute(&format!(
            "alter table {schema}.compute_sandboxes drop constraint compute_sandboxes_owner_host; \
             delete from {schema}.compute_hosts where id = {}; \
             update {schema}.compute_schema set version = 2",
            host.0
        ))
        .await
        .unwrap();

    let store = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    let given_up = store.sandbox(dangling.id).await.unwrap().unwrap();
    assert_eq!(given_up.ownership.owner, None);
    assert_eq!(given_up.ownership.epoch.0, dangling.ownership.epoch.0 + 1);
    assert_eq!(
        store.sandbox(kept.id).await.unwrap().unwrap().ownership,
        kept.ownership,
        "a sandbox naming a host the store has is unchanged"
    );
    let refused = client
        .execute(
            &format!("update {schema}.compute_sandboxes set owner = $1 where id = $2"),
            &[&i64::try_from(host.0).unwrap(), &kept.id.to_string()],
        )
        .await
        .expect_err("the owner must be a host the store has");
    assert_eq!(
        refused.code(),
        Some(&tokio_postgres::error::SqlState::FOREIGN_KEY_VIOLATION),
        "{refused}"
    );
    drop(store);
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .await
        .unwrap();
}

/// A host draining when the database is brought to the version that
/// remembers drains is remembered as drained, so it too comes back
/// draining after a fence.
#[tokio::test]
async fn migrating_remembers_the_hosts_draining_then_as_drained() {
    let Ok(url) = std::env::var("COMPUTE_TEST_POSTGRES") else {
        return;
    };
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let schema = format!("compute_drained_{:x}", random());
    client
        .batch_execute(&format!("create schema {schema}"))
        .await
        .unwrap();
    let scoped = format!("{url} options='-c search_path={schema}'");
    let store = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    let name = name();
    let (host, _) = registered(&store, &register(&name, random(), Vec::new())).await;
    drop(store);
    // As the database was before this version, with the host draining.
    client
        .batch_execute(&format!(
            "alter table {schema}.compute_hosts drop column drained; \
             update {schema}.compute_hosts set state = 'draining' where id = {}; \
             update {schema}.compute_schema set version = 4",
            host.0
        ))
        .await
        .unwrap();

    let store = PostgresStore::connect(&scoped, None, 2).await.unwrap();
    back_after_a_fence(&store, &name, host).await;
    assert_eq!(state(&store, host).await, HostState::Draining);
    drop(store);
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .await
        .unwrap();
}

/// A template of team `team`'s, of image `image`.
fn template(team: &str, image: ImageId, name: Option<&str>, created_ms: u64) -> TemplateRow {
    TemplateRow {
        team: team.to_owned(),
        id: Id(SandboxId(u128::from(random()) << 64 | u128::from(random()))).to_string(),
        name: name.map(str::to_owned),
        image,
        source: Id(SandboxId(u128::from(random()) << 64 | u128::from(random()))),
        vcpus: 2,
        memory_mib: 1024,
        disk_mib: 8192,
        created_ms,
    }
}

async fn templates<S: Store>(store: S) {
    let team = format!("team-{:x}", random());
    let other = format!("team-{:x}", random());
    let named = template(&team, image_id(), Some("warm"), 2);
    let plain = template(&team, image_id(), None, 1);
    for row in [&named, &plain] {
        assert_eq!(store.insert_template(row).await.unwrap(), Inserted::Done);
    }
    assert_eq!(
        store.template(&team, &named.id).await.unwrap().as_ref(),
        Some(&named),
        "by its id"
    );
    assert_eq!(
        store.template(&team, "warm").await.unwrap().as_ref(),
        Some(&named),
        "by its name"
    );
    assert_eq!(store.template(&other, "warm").await.unwrap(), None);
    assert_eq!(store.template(&other, &named.id).await.unwrap(), None);

    // A name is its team's only: taken there, free in another team.
    let again = template(&team, image_id(), Some("warm"), 3);
    assert_eq!(
        store.insert_template(&again).await.unwrap(),
        Inserted::NameTaken
    );
    assert_eq!(store.template(&team, &again.id).await.unwrap(), None);
    let elsewhere = template(&other, again.image, Some("warm"), 3);
    assert_eq!(
        store.insert_template(&elsewhere).await.unwrap(),
        Inserted::Done
    );

    assert_eq!(
        store.templates(&team).await.unwrap(),
        vec![plain.clone(), named.clone()],
        "oldest first"
    );
    assert_eq!(
        store.templates(&other).await.unwrap(),
        vec![elsewhere.clone()]
    );

    assert!(
        !store.delete_template(&other, &named.id).await.unwrap(),
        "another team's"
    );
    assert!(store.delete_template(&team, &named.id).await.unwrap());
    assert!(!store.delete_template(&team, &named.id).await.unwrap());
    assert_eq!(store.template(&team, "warm").await.unwrap(), None);
    let reused = template(&team, image_id(), Some("warm"), 4);
    assert_eq!(
        store.insert_template(&reused).await.unwrap(),
        Inserted::Done,
        "a deleted template's name is free again"
    );

    for (team, id) in [
        (&team, &plain.id),
        (&team, &reused.id),
        (&other, &elsewhere.id),
    ] {
        assert!(store.delete_template(team, id).await.unwrap());
    }
}

#[tokio::test]
async fn templates_are_found_by_id_or_by_a_name_unique_in_their_team() {
    each(templates, templates).await;
}

/// Of the images `unused_images` answers, the ones in `mine`: other checks
/// sharing the database capture images of their own.
async fn unused<S: Store>(
    store: &S,
    now_ms: u64,
    before_ms: u64,
    mine: &[ImageId],
) -> Vec<ImageId> {
    let mut found: Vec<ImageId> = store
        .unused_images(now_ms, before_ms)
        .await
        .unwrap()
        .into_iter()
        .filter(|image| mine.contains(image))
        .collect();
    found.sort();
    found
}

/// A collector that claims at `at_ms`, taking over claims made before
/// `lapsed_ms`.
fn collector(at_ms: u64, lapsed_ms: u64) -> Collector {
    Collector {
        id: format!("collector-{:x}", random()),
        at_ms,
        lapsed_ms,
    }
}

async fn collecting<S: Store>(store: &S) {
    let team = format!("team-{:x}", random());
    let kept = template(&team, image_id(), None, 1);
    let dropped = template(&team, image_id(), None, 1);
    let booted = template(&team, image_id(), None, 1);
    let built = template(&team, image_id(), None, 1);
    for row in [&kept, &dropped, &booted, &built] {
        assert_eq!(store.insert_template(row).await.unwrap(), Inserted::Done);
    }
    // A sandbox started from a template keeps its image once the template
    // is gone; so does an image a host built, which a capture of an
    // unchanged disk can be.
    let (host, _) = registered(store, &register(&name(), random(), Vec::new())).await;
    let mut started = sandbox(host);
    started.team = team.clone();
    started.spec.config.image = Some(booted.image);
    assert_eq!(store.insert(&started).await.unwrap(), Write::Done);
    let source = format!("registry.example/sandbox@sha256:{:064x}", random());
    store
        .record_built(&source, &format!("image-{:016x}", random()), built.image, 1)
        .await
        .unwrap();
    for row in [&dropped, &booted, &built] {
        assert!(store.delete_template(&team, &row.id).await.unwrap());
    }
    let mine = [kept.image, dropped.image, booted.image, built.image];

    let at = now_ms();
    let first = collector(at, 0);
    assert_eq!(
        unused(store, at, at, &mine).await,
        Vec::new(),
        "nothing is collected as it is first found unused"
    );
    assert_eq!(
        unused(store, at + 10, at, &mine).await,
        Vec::new(),
        "a later look keeps the time it was first found unused"
    );
    assert_eq!(
        unused(store, at + 20, at + 1, &mine).await,
        vec![dropped.image]
    );

    let collects = |image: ImageId, before: u64| store.collect_image(image, before, &first);
    assert!(
        !collects(dropped.image, at).await.unwrap(),
        "not unused for long enough"
    );
    for used in [kept.image, booted.image, built.image] {
        assert!(!collects(used, at + 1).await.unwrap());
    }
    assert!(!collects(image_id(), at + 1).await.unwrap());
    assert!(collects(dropped.image, at + 1).await.unwrap());
    assert!(
        collects(dropped.image, 0).await.unwrap(),
        "its collector holds its claim whatever the time"
    );
    assert_eq!(unused(store, at + 30, 0, &mine).await, vec![dropped.image]);

    let late = template(&team, dropped.image, None, 2);
    assert_eq!(
        store.insert_template(&late).await.unwrap(),
        Inserted::Collecting,
        "no template is recorded over an image being collected"
    );
    assert_eq!(store.template(&team, &late.id).await.unwrap(), None);
    store.collected(dropped.image, &first.id).await.unwrap();
    assert_eq!(unused(store, at + 40, at + 41, &mine).await, Vec::new());
    assert_eq!(
        store.insert_template(&late).await.unwrap(),
        Inserted::Done,
        "once forgotten, it can be captured again"
    );

    // Unused once its sandbox is gone; then a sandbox started from it
    // before the next look keeps it, though that look is not yet taken.
    assert!(store.delete(started.id, started.version).await.unwrap());
    assert_eq!(unused(store, at + 50, at + 50, &mine).await, Vec::new());
    assert_eq!(
        unused(store, at + 60, at + 51, &mine).await,
        vec![booted.image]
    );
    let mut again = sandbox(host);
    again.team = team.clone();
    again.spec.config.image = Some(booted.image);
    assert_eq!(store.insert(&again).await.unwrap(), Write::Done);
    assert!(!collects(booted.image, at + 51).await.unwrap());
    assert_eq!(unused(store, at + 70, at + 61, &mine).await, Vec::new());

    assert!(store.delete(again.id, again.version).await.unwrap());
    for row in [&kept, &late] {
        assert!(store.delete_template(&team, &row.id).await.unwrap());
    }
}

/// An unused captured image of team `team`'s, its template deleted, found
/// unused at `at` and so unused since before `at + 1`.
async fn unused_image<S: Store>(store: &S, team: &str, at: u64) -> ImageId {
    let row = template(team, image_id(), None, 1);
    assert_eq!(store.insert_template(&row).await.unwrap(), Inserted::Done);
    assert!(store.delete_template(team, &row.id).await.unwrap());
    assert_eq!(unused(store, at, at, &[row.image]).await, Vec::new());
    row.image
}

async fn claims<S: Store>(store: &S) {
    let team = format!("team-{:x}", random());
    let at = now_ms();
    let image = unused_image(store, &team, at).await;

    let first = collector(at + 10, at);
    assert!(store.collect_image(image, at + 1, &first).await.unwrap());
    assert!(store.collecting(image, &first.id).await.unwrap());
    // Another collector neither shares the claim nor, while it lasts,
    // takes it over.
    let second = collector(at + 20, at + 10);
    assert!(!store.collect_image(image, at + 1, &second).await.unwrap());
    assert!(!store.collecting(image, &second.id).await.unwrap());
    store.collected(image, &second.id).await.unwrap();
    assert!(
        store.collecting(image, &first.id).await.unwrap(),
        "only its collector deletes its record"
    );

    // Once it lapses, another takes it over; the first, held up, finds
    // its claim lost and deletes nothing.
    let third = collector(at + 30, at + 11);
    assert!(store.collect_image(image, at + 1, &third).await.unwrap());
    assert!(!store.collecting(image, &first.id).await.unwrap());
    assert!(store.collecting(image, &third.id).await.unwrap());
    assert!(
        !store.collect_image(image, at + 1, &first).await.unwrap(),
        "a lost claim is not taken back while the new one lasts"
    );
    store.collected(image, &first.id).await.unwrap();
    assert!(store.collecting(image, &third.id).await.unwrap());
    store.collected(image, &third.id).await.unwrap();
    assert!(!store.collecting(image, &third.id).await.unwrap());
    assert_eq!(unused(store, at + 40, at + 41, &[image]).await, Vec::new());

    // Captured again after, it is a new record: the old collectors hold
    // nothing of it.
    let late = template(&team, image, None, 2);
    assert_eq!(store.insert_template(&late).await.unwrap(), Inserted::Done);
    for old in [&first, &third] {
        assert!(!store.collecting(image, &old.id).await.unwrap());
        assert!(!store.collect_image(image, u64::MAX, old).await.unwrap());
    }
    assert!(store.delete_template(&team, &late.id).await.unwrap());
}

async fn uses_after_a_claim<S: Store>(store: &S) {
    let team = format!("team-{:x}", random());
    let at = now_ms();
    let image = unused_image(store, &team, at).await;
    let claimed = collector(at + 10, 0);
    assert!(store.collect_image(image, at + 1, &claimed).await.unwrap());

    // A template of the claimed image is not recorded.
    assert_eq!(
        store
            .insert_template(&template(&team, image, None, 3))
            .await
            .unwrap(),
        Inserted::Collecting
    );
    assert!(store.collecting(image, &claimed.id).await.unwrap());
}

/// Captured images are collected only once nothing has used them for a
/// while, by one collector at a time, which holds an image until its
/// claim lapses, and no use of an image is recorded once one claims it.
/// One check, its parts in turn: each look for unused images notes the
/// time on every captured image in the store, so two at once would move
/// each other's.
async fn collection<S: Store>(store: S) {
    collecting(&store).await;
    claims(&store).await;
    uses_after_a_claim(&store).await;
}

#[tokio::test]
async fn captured_images_are_collected_only_once_nothing_has_used_them_for_a_while() {
    each(collection, collection).await;
}

async fn sandboxes_from_templates<S: Store>(store: S) {
    let team = format!("team-{:x}", random());
    let row = template(&team, image_id(), None, 1);
    assert_eq!(store.insert_template(&row).await.unwrap(), Inserted::Done);
    let (host, _) = registered(&store, &register(&name(), random(), Vec::new())).await;
    let from = |id: &str| {
        let mut created = sandbox(host);
        created.team.clone_from(&team);
        created.spec.image = format!("{TEMPLATE_PREFIX}{id}");
        created.spec.config.image = Some(row.image);
        created
    };
    let first = from(&row.id);
    assert_eq!(store.insert(&first).await.unwrap(), Write::Done);

    // Another team's template of the same id is not this team's.
    let mut elsewhere = from(&row.id);
    elsewhere.team = format!("team-{:x}", random());
    assert_eq!(store.insert(&elsewhere).await.unwrap(), Write::TemplateGone);

    assert!(store.delete_template(&team, &row.id).await.unwrap());
    let late = from(&row.id);
    assert_eq!(
        store.insert(&late).await.unwrap(),
        Write::TemplateGone,
        "a create that found the template before its delete inserts nothing"
    );
    assert_eq!(store.sandbox(late.id).await.unwrap(), None);
    let request_id = format!("request-{:x}", random());
    let claimed = request(&late, &request_id);
    assert_eq!(store.claim_request(&claimed).await.unwrap(), claimed);
    assert_eq!(
        store.insert_requested(&late, &request_id).await.unwrap(),
        Some(Write::TemplateGone)
    );
    assert_eq!(store.sandbox(late.id).await.unwrap(), None);
    assert!(store.delete(first.id, first.version).await.unwrap());
}

#[tokio::test]
async fn a_sandbox_is_created_from_a_template_only_while_the_template_is_there() {
    each(sandboxes_from_templates, sandboxes_from_templates).await;
}
