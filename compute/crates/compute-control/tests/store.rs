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
    Admission, AgentRef, LifecycleRow, Linked, MemoryStore, PostgresStore, RequestRow, SandboxRow,
    Spec, Store, Write, replace_lifecycle,
};
use compute_fleet::{HostId, HostState, OwnerEpoch, Ownership, SandboxId, Sends};
use compute_protocol::fleet::{Capacity, Held, HostInfo, Register, Renew, Verdict};
use compute_protocol::host::{Id, SandboxConfig, SleepConfig};

fn random() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}

fn capacity() -> Capacity {
    Capacity {
        memory_free_mib: 1024,
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
            disk_mib: 4096,
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
        .find_map(|(counted, renewals)| (counted == host).then_some(renewals))
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
        capacity: capacity(),
    };
    assert!(
        store
            .renew(&renew, std::slice::from_ref(&name))
            .await
            .unwrap()
    );
    assert!(
        !store
            .renew(&renew, &["someone-else.example".into()])
            .await
            .unwrap(),
        "only the host named may renew"
    );
    let count = renewals(&store, host).await.expect("counted");
    assert_eq!(
        store.give_up(host, count - 1).await.unwrap(),
        None,
        "a renewal since saves it"
    );
    assert_eq!(store.give_up(host, count).await.unwrap(), Some(0));
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
    assert_eq!(store.give_up(lost, count).await.unwrap(), Some(1));

    // Giving up cleared its owner under a raised epoch.
    let cleared = store.sandbox(owned.id).await.unwrap().unwrap();
    assert_eq!(cleared.ownership.owner, None);
    assert!(cleared.ownership.epoch > owned.ownership.epoch);
    assert!(cleared.version > owned.version);

    // Nothing can make it, or a new sandbox, the lost host's again.
    assert_eq!(
        store.insert(&sandbox(lost)).await.unwrap(),
        Write::OwnerLost
    );
    owned = cleared;
    let mut back = owned.clone();
    back.ownership = owned.ownership.give(lost).set;
    assert_eq!(store.replace(&back).await.unwrap(), Write::OwnerLost);
    let mut elsewhere = owned.clone();
    elsewhere.ownership = owned.ownership.give(live).set;
    assert_eq!(store.replace(&elsewhere).await.unwrap(), Write::Done);
    assert_eq!(
        store.owned_by(live).await.unwrap()[0].ownership.owner,
        Some(live)
    );
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
            store.give_up(host, count),
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

async fn reclaim<S: Store>(store: S) {
    let returning = name();
    let (host, _) = registered(&store, &register(&returning, random(), Vec::new())).await;
    let kept = sandbox(host);
    let moved = sandbox(host);
    for row in [&kept, &moved] {
        assert_eq!(store.insert(row).await.unwrap(), Write::Done);
    }
    let count = renewals(&store, host).await.unwrap();
    store.give_up(host, count).await.unwrap();
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
    let row = sandbox(HostId(1));
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
    for _ in 0..30 {
        let row = sandbox(HostId(1));
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
