use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

const HOST: HostId = HostId(1);

/// [`HOST`] at `renewals`, its registration naming no boot.
fn counted(renewals: u64) -> Counted {
    Counted {
        host: HOST,
        renewals,
        boot: None,
    }
}

fn terms() -> LeaseTerms {
    let mut terms = LeaseTerms {
        term: Duration::from_secs(2),
        margin: Duration::from_secs(1),
        renew_every: Duration::from_millis(200),
        register_every: Duration::from_millis(200),
        request_window: 50,
        watchdog: Duration::from_secs(1),
        stop: Duration::from_millis(200),
        rate_error_ppm: 1_000,
    };
    terms.margin = terms.needed_margin();
    terms.validate().unwrap()
}

/// Renewal counts read through `delays`, one per read, then at once;
/// each read returns the count as it is when the read returns.
struct Slow {
    count: AtomicU64,
    delays: Mutex<Vec<Duration>>,
    given_up: Mutex<Option<Instant>>,
}

impl Leases for Slow {
    async fn renewals(&self) -> store::Result<Vec<Counted>> {
        let delay = {
            let mut delays = self.delays.lock().unwrap();
            if delays.is_empty() {
                Duration::ZERO
            } else {
                delays.remove(0)
            }
        };
        tokio::time::sleep(delay).await;
        Ok(vec![counted(self.count.load(Ordering::SeqCst))])
    }

    fn give_up(
        &self,
        _host: HostId,
        renewals: u64,
    ) -> impl Future<Output = store::Result<Option<usize>>> + Send {
        let answer = if self.count.load(Ordering::SeqCst) == renewals {
            self.given_up.lock().unwrap().get_or_insert(Instant::now());
            Some(0)
        } else {
            None
        };
        std::future::ready(Ok(answer))
    }

    fn deleted(&self, _host: HostId) -> impl Future<Output = store::Result<()>> + Send {
        std::future::ready(Ok(()))
    }
}

/// A read that takes longer than the margin shows a renewal sent just
/// before it returned: the host's lease runs a whole term from that
/// renewal, and the leader must not give up on it before then, however
/// fast its later reads are.
#[tokio::test(start_paused = true)]
async fn a_slow_read_never_gives_up_on_a_host_within_its_lease() {
    let terms = terms();
    let slow = terms.margin + Duration::from_secs(1);
    let leases = Arc::new(Slow {
        count: AtomicU64::new(1),
        delays: Mutex::new(vec![slow]),
        given_up: Mutex::new(None),
    });
    let view = View::new(1, terms.term);
    let mut leading = Leading::new(Arc::clone(&leases), terms, None);
    let begun = Instant::now();
    // The host renews once, just before the slow read returns, and
    // never again: its lease runs until then plus the term.
    let renews_after = slow.saturating_sub(Duration::from_millis(10));
    let renewer = tokio::spawn({
        let leases = Arc::clone(&leases);
        async move {
            tokio::time::sleep(renews_after).await;
            leases.count.store(2, Ordering::SeqCst);
        }
    });
    let lease_ends = begun + renews_after + terms.term;
    while leases.given_up.lock().unwrap().is_none() {
        leading.tick(&view).await;
        tokio::time::sleep(EVERY).await;
    }
    renewer.await.unwrap();
    let given_up = leases.given_up.lock().unwrap().unwrap();
    assert!(
        given_up >= lease_ends + terms.margin.saturating_sub(EVERY),
        "gave up {:?} after the start, the lease ran {:?}",
        given_up - begun,
        lease_ends - begun
    );
}

const GIB: u64 = 1024;

/// One host that stops renewing, and a give-up that takes but whose
/// answer is lost: the leader hears an error.
#[derive(Default)]
struct AnswerLost {
    given_up: std::sync::atomic::AtomicBool,
    give_ups: AtomicU64,
}

impl Leases for AnswerLost {
    fn renewals(&self) -> impl Future<Output = store::Result<Vec<Counted>>> + Send {
        std::future::ready(Ok(if self.given_up.load(Ordering::SeqCst) {
            Vec::new()
        } else {
            vec![counted(1)]
        }))
    }

    fn give_up(
        &self,
        _host: HostId,
        _renewals: u64,
    ) -> impl Future<Output = store::Result<Option<usize>>> + Send {
        self.give_ups.fetch_add(1, Ordering::SeqCst);
        self.given_up.store(true, Ordering::SeqCst);
        std::future::ready(Err(store::StoreError::Database(
            "the connection closed".into(),
        )))
    }

    fn deleted(&self, _host: HostId) -> impl Future<Output = store::Result<()>> + Send {
        std::future::ready(Ok(()))
    }
}

/// A host given up on without the leader hearing it worked, and then
/// forgotten, leaves nothing behind in the leader: the next read lacks
/// it, so it is neither watched nor tried again.
#[tokio::test(start_paused = true)]
async fn a_host_the_reads_no_longer_list_is_neither_watched_nor_tried_again() {
    let terms = terms();
    let leases = Arc::new(AnswerLost::default());
    let view = View::new(1, terms.term);
    let mut leading = Leading::new(Arc::clone(&leases), terms, None);
    while leases.give_ups.load(Ordering::SeqCst) == 0 {
        leading.tick(&view).await;
        tokio::time::sleep(EVERY).await;
    }
    leading.tick(&view).await;
    assert_eq!(leading.still().count(), 0, "no longer watched");
    // Long past the wait before a failed give-up is tried again.
    for _ in 0..100 {
        tokio::time::sleep(FENCE_AGAIN).await;
        leading.tick(&view).await;
    }
    assert_eq!(leases.give_ups.load(Ordering::SeqCst), 1, "not tried again");
    assert!(leading.again_at.is_empty(), "nor waiting to be");
}

/// Rooms for sandboxes of up to 4 GiB and 2 processors, two kept.
const POLICY: ScalePolicy = ScalePolicy {
    spare_per_mille: 200,
    spare_largest: 2,
    largest_mib: 4 * GIB,
    largest_cpu_millis: 2000,
    host_memory_mib: 64 * GIB,
    min_hosts: 1,
    max_hosts: 10,
};

fn member(name: &str) -> Member {
    Member {
        name: name.to_owned(),
        stopped: false,
        idle: true,
        leaving: false,
    }
}

fn live(free_gib: u64) -> GroupHost {
    GroupHost {
        draining: false,
        memory_mib: 64 * GIB,
        free_memory_mib: free_gib * GIB,
        unreclaimed_free_mib: free_gib * GIB,
        sandboxes: 0,
        leader_drained_ms: None,
        keeps_memory: true,
        cpu_millis: 30_000,
        free_cpu_millis: 30_000,
        registered_cpu_millis: 30_000,
    }
}

fn hosts(named: &[(&str, GroupHost)]) -> HashMap<String, GroupHost> {
    named
        .iter()
        .map(|(name, host)| ((*name).to_owned(), *host))
        .collect()
}

/// An allowance every member without a host is within, and one every
/// such member is past.
const BOOTING: Duration = Duration::from_secs(3_600);
const STALLED: Duration = Duration::ZERO;

#[tokio::test]
async fn a_registered_host_the_listing_does_not_name_takes_one_place() {
    // One place asked for, nothing listed yet, and its host registered.
    let seen = Boots::default().count(1, &[], &hosts(&[("hosts-a", live(1))]), BOOTING, &POLICY);
    assert_eq!((seen.hosts, seen.booting), (1, 0), "{seen:?}");
    assert_eq!(grown_size(1, &seen, 2, 10, 0), 2);
    // Two places asked for: the other is booting.
    let seen = Boots::default().count(2, &[], &hosts(&[("hosts-a", live(1))]), BOOTING, &POLICY);
    assert_eq!((seen.hosts, seen.booting), (1, 1), "{seen:?}");
}

#[tokio::test]
async fn a_host_the_group_let_go_brings_nothing_without_a_place_for_it() {
    // One place, listed; the other host was let go (abandoned, its
    // listing gone) but is still registered.
    let members = [member("hosts-a")];
    let registered = hosts(&[("hosts-a", live(1)), ("hosts-b", live(64))]);
    let seen = Boots::default().count(1, &members, &registered, BOOTING, &POLICY);
    assert_eq!(
        (seen.hosts, seen.booting, seen.free_memory_mib),
        (1, 0, GIB),
        "{seen:?}"
    );
    assert_eq!(grown_size(1, &seen, 2, 10, 0), 2);
    // With one place not listed, only the host with least spare takes it.
    let registered = hosts(&[
        ("hosts-a", live(1)),
        ("hosts-b", live(64)),
        ("hosts-c", live(2)),
    ]);
    let seen = Boots::default().count(2, &members, &registered, BOOTING, &POLICY);
    assert_eq!(
        (seen.hosts, seen.booting, seen.free_memory_mib),
        (2, 0, 3 * GIB),
        "{seen:?}"
    );
}

#[tokio::test]
async fn draining_and_stalled_places_are_grown_around() {
    let mut draining = live(64);
    draining.draining = true;
    let members = [member("hosts-a"), member("hosts-b"), member("hosts-c")];
    let registered = hosts(&[("hosts-a", live(1)), ("hosts-b", draining)]);
    let seen = Boots::default().count(3, &members, &registered, STALLED, &POLICY);
    assert_eq!(
        (seen.hosts, seen.draining, seen.stalled, seen.booting),
        (1, 1, 1, 0),
        "{seen:?}"
    );
    // Two usable hosts wanted, one live: one more on top of the three
    // places.
    assert_eq!(grown_size(3, &seen, 2, 10, 1), 4);
    // The draining place does not count against the maximum; the
    // stalled one does.
    assert_eq!(draining_members(&members, &registered), 1);
    assert_eq!(grown_size(3, &seen, 2, 3, 1), 4, "draining comes on top");
    assert_eq!(grown_size(3, &seen, 2, 2, 1), 3, "never past the maximum");
    // Within the allowance the third member is coming.
    let seen = Boots::default().count(3, &members, &registered, BOOTING, &POLICY);
    assert_eq!((seen.booting, seen.stalled), (1, 0), "{seen:?}");
}

/// A group at its maximum with one host draining, the others full:
/// the draining host takes no sandboxes, so the group still grows by
/// one (#6976).
#[tokio::test]
async fn a_draining_host_does_not_hold_a_full_group_at_its_maximum() {
    let policy = ScalePolicy {
        max_hosts: 4,
        ..POLICY
    };
    let mut draining = live(64);
    draining.draining = true;
    let members = [
        member("hosts-a"),
        member("hosts-b"),
        member("hosts-c"),
        member("hosts-d"),
    ];
    let registered = hosts(&[
        ("hosts-a", live(1)),
        ("hosts-b", live(1)),
        ("hosts-c", live(1)),
        ("hosts-d", draining),
    ]);
    let seen = Boots::default().count(4, &members, &registered, BOOTING, &policy);
    assert_eq!((seen.hosts, seen.draining), (3, 1), "{seen:?}");
    let ScaleDecision::Grow { to } = policy.decide(&seen) else {
        panic!("three full hosts should grow the group: {seen:?}");
    };
    let draining = draining_members(&members, &registered);
    assert_eq!(grown_size(4, &seen, to, policy.max_hosts, draining), 5);
}

/// A draining host the group no longer lists, or one it is removing,
/// holds no member's place, so it lifts no maximum.
#[test]
fn only_listed_draining_members_lift_the_maximum() {
    let mut draining = live(64);
    draining.draining = true;
    let mut leaving = member("hosts-c");
    leaving.leaving = true;
    let members = [member("hosts-a"), member("hosts-b"), leaving];
    let registered = hosts(&[
        ("hosts-a", live(1)),
        ("hosts-b", draining),
        ("hosts-c", draining),
        ("hosts-gone", draining),
    ]);
    assert_eq!(draining_members(&members, &registered), 1);
}

#[tokio::test]
async fn a_stalled_member_holds_off_a_shrink() {
    let policy = POLICY;
    let members = [
        member("hosts-a"),
        member("hosts-b"),
        member("hosts-c"),
        member("hosts-d"),
    ];
    let registered = hosts(&[
        ("hosts-a", live(64)),
        ("hosts-b", live(64)),
        ("hosts-c", live(64)),
    ]);
    let mut boots = Boots::default();
    let booting = boots.count(4, &members, &registered, BOOTING, &POLICY);
    assert_eq!(policy.decide(&booting), ScaleDecision::Hold);
    let stalled = boots.count(4, &members, &registered, STALLED, &POLICY);
    assert_eq!(stalled.stalled, 1, "{stalled:?}");
    assert_eq!(policy.decide(&stalled), ScaleDecision::Hold);
    let settled = boots.count(3, &members[..3], &registered, STALLED, &POLICY);
    assert_eq!(policy.decide(&settled), ScaleDecision::Shrink, "control");
}

#[tokio::test]
async fn a_member_the_group_is_removing_holds_no_place() {
    let mut leaving = member("hosts-a");
    leaving.leaving = true;
    let members = [leaving, member("hosts-b")];
    let registered = hosts(&[("hosts-a", live(64)), ("hosts-b", live(1))]);
    let seen = Boots::default().count(1, &members, &registered, BOOTING, &POLICY);
    assert_eq!(
        (seen.hosts, seen.booting, seen.free_memory_mib),
        (1, 0, GIB),
        "{seen:?}"
    );
}

#[tokio::test]
async fn spare_in_slivers_across_hosts_holds_no_room_and_grows_the_group() {
    let sliver = GroupHost {
        cpu_millis: 7500,
        free_cpu_millis: 1500,
        registered_cpu_millis: 7500,
        ..live(64)
    };
    let members = [
        member("hosts-a"),
        member("hosts-b"),
        member("hosts-c"),
        member("hosts-d"),
    ];
    let registered = hosts(&[
        ("hosts-a", sliver),
        ("hosts-b", sliver),
        ("hosts-c", sliver),
        ("hosts-d", sliver),
    ]);
    let seen = Boots::default().count(4, &members, &registered, BOOTING, &POLICY);
    assert_eq!(
        (seen.free_cpu_millis, seen.rooms, seen.memory_rooms),
        (6000, 0, 64),
        "{seen:?}"
    );
    // 6000 free is all the share asks, but no host can take a sandbox
    // of 2 processors: one more host, which brings three rooms.
    assert_eq!(POLICY.decide(&seen), ScaleDecision::Grow { to: 5 });
}

/// Hosts that registered with 7.5 processors but guarantee none now,
/// say while something beside their sandboxes takes all of them, have
/// no processor time to spare: the group grows by what a new host
/// brings and never shrinks, however much memory is free.
#[tokio::test]
async fn hosts_guaranteeing_no_processor_time_now_grow_the_group() {
    let none = GroupHost {
        cpu_millis: 0,
        free_cpu_millis: 0,
        registered_cpu_millis: 7500,
        ..live(64)
    };
    let members = [
        member("hosts-a"),
        member("hosts-b"),
        member("hosts-c"),
        member("hosts-d"),
    ];
    let registered = hosts(&[
        ("hosts-a", none),
        ("hosts-b", none),
        ("hosts-c", none),
        ("hosts-d", none),
    ]);
    let seen = Boots::default().count(4, &members, &registered, BOOTING, &POLICY);
    assert_eq!(
        (
            seen.cpu_millis,
            seen.host_cpu_millis,
            seen.most_cpu_millis,
            seen.rooms
        ),
        (0, 7500, 0, 0),
        "{seen:?}"
    );
    assert_eq!(POLICY.decide(&seen), ScaleDecision::Grow { to: 5 });
    let full = ScalePolicy {
        max_hosts: 4,
        ..POLICY
    };
    assert_eq!(full.decide(&seen), ScaleDecision::Hold);
}
