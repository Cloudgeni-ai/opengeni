use super::*;

const RULES: Shrinking = Shrinking {
    after: Duration::from_secs(1800),
    drain_every: Duration::from_secs(30),
    drain_within: Duration::from_secs(6 * 3600),
    adopt_after: None,
    quiet: Duration::from_secs(600),
};
const ADOPTING: Shrinking = Shrinking {
    adopt_after: Some(Duration::from_secs(3600)),
    ..RULES
};
const GIB: u64 = 1024;
/// The service's clock at every look but where a test says otherwise.
const NOW_MS: u64 = 1_800_000_000_000;

/// How a host of a test's group stands.
#[derive(Clone, Copy)]
enum Is {
    Live,
    /// Drained by the leader, at this time by the service's clock.
    Ours(u64),
    /// Drained by someone else.
    Theirs,
}

use Is::{Live, Ours, Theirs};

fn member(name: &str) -> Member {
    Member {
        name: name.to_owned(),
        stopped: false,
        idle: true,
        leaving: false,
    }
}

fn host(free_gib: u64, is: Is) -> GroupHost {
    GroupHost {
        draining: !matches!(is, Live),
        memory_mib: 30 * GIB,
        free_memory_mib: free_gib * GIB,
        unreclaimed_free_mib: free_gib * GIB,
        sandboxes: 0,
        leader_drained_ms: match is {
            Ours(at_ms) => Some(at_ms),
            Live | Theirs => None,
        },
        keeps_memory: true,
        cpu_millis: 7500,
        free_cpu_millis: 7500,
        registered_cpu_millis: 7500,
    }
}

struct Group {
    members: Vec<Member>,
    hosts: HashMap<String, GroupHost>,
}

fn group(hosts: &[(&str, u64, Is)]) -> Group {
    Group {
        members: hosts.iter().map(|(name, _, _)| member(name)).collect(),
        hosts: hosts
            .iter()
            .map(|(name, free, is)| ((*name).to_owned(), host(*free, *is)))
            .collect(),
    }
}

fn look(at: Instant, now_ms: u64, decision: ScaleDecision, group: &Group) -> Look<'_> {
    Look {
        now: at,
        now_ms,
        decision,
        members: &group.members,
        hosts: &group.hosts,
        min_hosts: 1,
    }
}

fn plan(shrinker: &mut Shrinker, at: Instant, decision: ScaleDecision, group: &Group) -> Step {
    shrinker.plan(&RULES, &look(at, NOW_MS, decision, group))
}

fn secs(secs: u64) -> Duration {
    Duration::from_secs(secs)
}

fn three() -> Group {
    group(&[("h-a", 10, Live), ("h-b", 25, Live), ("h-c", 20, Live)])
}

/// `h-b` drained by the leader.
fn draining() -> Group {
    group(&[
        ("h-a", 10, Live),
        ("h-b", 25, Ours(NOW_MS)),
        ("h-c", 20, Live),
    ])
}

/// A shrinker that has just drained `h-b` of [`three`], at `start` plus
/// the period.
fn draining_h_b(start: Instant) -> Shrinker {
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Shrink, &three());
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into())
    );
    shrinker
}

/// The leader used to only log that the group could shrink: now, once
/// the group has had more spare than it needs for the whole period,
/// it drains the host with the most spare, and not before.
#[test]
fn plenty_held_for_the_whole_period_drains_the_roomiest_host() {
    let start = Instant::now();
    let mut shrinker = Shrinker::default();
    assert_eq!(
        plan(&mut shrinker, start, ScaleDecision::Shrink, &three()),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1799),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into())
    );
    assert_eq!(shrinker.outgoing(), Some("h-b"));
    assert!(shrinker.ours("h-b"));
}

/// The host to drain is the one with the most memory free without ending
/// any VM process, not counting what idle sandboxes would give back (each
/// of which has to move, and wakes slower for it); among equals, the one
/// holding the fewest sandboxes.
#[test]
fn the_host_drained_has_the_most_memory_free_without_reclaiming_then_the_fewest_sandboxes() {
    let start = Instant::now();
    let mut hosts = three();
    // h-b looks roomiest only by what its many idle sandboxes hold.
    let b = hosts.hosts.get_mut("h-b").unwrap();
    b.free_memory_mib = 28 * GIB;
    b.unreclaimed_free_mib = 4 * GIB;
    b.sandboxes = 30;
    let a = hosts.hosts.get_mut("h-a").unwrap();
    a.free_memory_mib = 20 * GIB;
    a.unreclaimed_free_mib = 20 * GIB;
    a.sandboxes = 6;
    let c = hosts.hosts.get_mut("h-c").unwrap();
    c.unreclaimed_free_mib = 20 * GIB;
    c.sandboxes = 2;
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Shrink, &hosts);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800),
            ScaleDecision::Shrink,
            &hosts
        ),
        Step::Drain("h-c".into())
    );
}

#[test]
fn a_look_without_plenty_starts_the_period_again() {
    let start = Instant::now();
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Shrink, &three());
    plan(
        &mut shrinker,
        start + secs(1000),
        ScaleDecision::Hold,
        &three(),
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(3600),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into())
    );
}

#[test]
fn growth_holds_off_a_shrink_for_the_period() {
    let start = Instant::now();
    let mut shrinker = Shrinker::default();
    plan(
        &mut shrinker,
        start,
        ScaleDecision::Grow { to: 4 },
        &three(),
    );
    plan(
        &mut shrinker,
        start + secs(1),
        ScaleDecision::Shrink,
        &three(),
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1801),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into())
    );
}

#[test]
fn never_below_the_minimum() {
    let start = Instant::now();
    let one = group(&[("h-a", 30, Live)]);
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Shrink, &one);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(7200),
            ScaleDecision::Shrink,
            &one
        ),
        Step::Hold
    );
}

/// A host of an earlier release would end an idle sandbox's programs on
/// its way out: the group does not shrink until every host keeps them.
#[test]
fn no_host_is_drained_while_one_does_not_keep_memory_in_a_hand_off() {
    let start = Instant::now();
    let mut hosts = three();
    hosts.hosts.get_mut("h-a").unwrap().keeps_memory = false;
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Shrink, &hosts);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800),
            ScaleDecision::Shrink,
            &hosts
        ),
        Step::Hold
    );
    assert!(shrinker.seen(start + secs(1800)).held_back);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1810),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into()),
        "once it does"
    );
    assert!(!shrinker.seen(start + secs(1810)).held_back);
}

/// Draining it again every pass until a pass finds it owning nothing,
/// then removing it once it has drained for the quiet period, so that
/// a create, adopt or move placed on it before its drain landed has
/// landed; once the group no longer lists it, it is done.
#[test]
fn a_drained_host_is_removed_once_it_owns_nothing() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    let at = start + secs(1800);
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(10),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Hold
    );
    shrinker.drained("h-b", at + secs(20), Ok(Drained { moved: 3, left: 2 }));
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(30),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Drain("h-b".into())
    );
    shrinker.drained("h-b", at + secs(40), Ok(Drained::default()));
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(60),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Hold,
        "empty, but not yet quiet"
    );
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(619),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(620),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Remove("h-b".into())
    );
    shrinker.removed("h-b", Ok(()));
    let mut gone = draining();
    gone.members[1].leaving = true;
    assert_eq!(
        plan(&mut shrinker, at + secs(630), ScaleDecision::Hold, &gone),
        Step::Hold
    );
    assert_eq!(shrinker.outgoing(), None);
    assert_eq!(shrinker.seen(at + secs(630)).removals, 1);
    // The group lost a host: the next shrink waits the whole period.
    let two = group(&[("h-a", 10, Live), ("h-c", 20, Live)]);
    plan(&mut shrinker, at + secs(640), ScaleDecision::Shrink, &two);
    assert_eq!(
        plan(&mut shrinker, at + secs(1500), ScaleDecision::Shrink, &two),
        Step::Hold
    );
}

/// The quiet period counts from the first pass that held, not from when
/// the leader chose the host: passes that failed (the store away) do not
/// count, so a host is never removed moments after its drain landed,
/// while something placed on it just before may still be landing.
#[test]
fn the_quiet_period_counts_from_the_first_pass_that_held() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    let at = start + secs(1800);
    for pass in 1..40 {
        shrinker.drained("h-b", at + secs(pass * 30), Err("the store is away".into()));
        assert_ne!(
            plan(
                &mut shrinker,
                at + secs(pass * 30 + 10),
                ScaleDecision::Hold,
                &three()
            ),
            Step::Remove("h-b".into())
        );
    }
    let held = at + secs(1200);
    shrinker.drained("h-b", held, Ok(Drained::default()));
    assert_eq!(
        plan(
            &mut shrinker,
            held + secs(30),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Hold,
        "chosen long ago, but drained only now"
    );
    assert_eq!(
        plan(
            &mut shrinker,
            held + secs(599),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            held + secs(600),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Remove("h-b".into())
    );
}

/// A take-back is asked again until it holds: one that failed (a store
/// error) does not leave the host draining, to be removed later as if
/// someone else had drained it.
#[test]
fn a_drain_is_taken_back_when_the_group_would_grow_or_takes_too_long() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1810),
            ScaleDecision::Grow { to: 3 },
            &draining()
        ),
        Step::TakeBack("h-b".into())
    );
    assert_eq!(shrinker.outgoing(), Some("h-b"), "until it holds");
    shrinker.taken_back("h-b", Err("the store is away".into()));
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1820),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::TakeBack("h-b".into()),
        "a failed take-back is asked again"
    );
    shrinker.taken_back("h-b", Ok(()));
    assert_eq!(shrinker.outgoing(), None);
    assert_eq!(shrinker.seen(start).taken_back, [1, 0]);

    let mut shrinker = draining_h_b(start);
    shrinker.drained("h-b", start + secs(1830), Ok(Drained { moved: 0, left: 1 }));
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1800 + 6 * 3600),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::TakeBack("h-b".into())
    );
    shrinker.taken_back("h-b", Ok(()));
    assert_eq!(shrinker.seen(start).taken_back, [0, 1]);
}

/// A host taken back because its sandboxes would not leave in time is not
/// drained again for a whole drain window: otherwise every sandbox placed
/// on it since would be moved again half an hour later, over and over.
#[test]
fn a_host_too_slow_to_drain_is_left_be_for_a_drain_window() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    shrinker.drained("h-b", start + secs(1830), Ok(Drained { moved: 0, left: 1 }));
    let gave_up = start + secs(1800 + 6 * 3600);
    assert_eq!(
        plan(&mut shrinker, gave_up, ScaleDecision::Shrink, &draining()),
        Step::TakeBack("h-b".into())
    );
    shrinker.taken_back("h-b", Ok(()));
    assert_eq!(shrinker.seen(gave_up).skipped, 1);
    // Still plenty: the period passes again, and another host goes.
    plan(
        &mut shrinker,
        gave_up + secs(10),
        ScaleDecision::Shrink,
        &three(),
    );
    assert_eq!(
        plan(
            &mut shrinker,
            gave_up + secs(1810),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-c".into())
    );
    shrinker.drained(
        "h-c",
        gave_up + secs(1820),
        Ok(Drained { moved: 0, left: 1 }),
    );
    let gave_up_again = gave_up + secs(1810 + 6 * 3600);
    let c_draining = group(&[
        ("h-a", 10, Live),
        ("h-b", 25, Live),
        ("h-c", 20, Ours(NOW_MS)),
    ]);
    assert_eq!(
        plan(
            &mut shrinker,
            gave_up_again,
            ScaleDecision::Shrink,
            &c_draining
        ),
        Step::TakeBack("h-c".into())
    );
    shrinker.taken_back("h-c", Ok(()));
    // h-b's window is over: it may go again; h-c's is not.
    plan(
        &mut shrinker,
        gave_up_again + secs(10),
        ScaleDecision::Shrink,
        &three(),
    );
    assert_eq!(
        plan(
            &mut shrinker,
            gave_up_again + secs(1810),
            ScaleDecision::Shrink,
            &three()
        ),
        Step::Drain("h-b".into())
    );
}

/// Once its deletion was asked for, which the group may have accepted
/// whatever the answer, a host is never taken back: not when the group
/// would grow, nor when its drain runs long.
#[test]
fn a_host_whose_removal_was_asked_for_is_never_taken_back() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    let at = start + secs(1800);
    shrinker.drained("h-b", at, Ok(Drained::default()));
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(600),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::Remove("h-b".into())
    );
    shrinker.removed("h-b", Err("timed out".into()));
    assert_eq!(shrinker.seen(at).removal_failures, 1);
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(610),
            ScaleDecision::Grow { to: 3 },
            &draining()
        ),
        Step::Hold
    );
    assert_eq!(
        plan(
            &mut shrinker,
            at + secs(640),
            ScaleDecision::Grow { to: 3 },
            &draining()
        ),
        Step::Remove("h-b".into()),
        "asked again, never taken back"
    );
    shrinker.drained("h-b", at + secs(650), Ok(Drained { moved: 0, left: 1 }));
    assert_ne!(
        plan(
            &mut shrinker,
            at + secs(6 * 3600),
            ScaleDecision::Hold,
            &draining()
        ),
        Step::TakeBack("h-b".into())
    );
}

/// The store notes that the leader drained a host, and when: a leader
/// after it (a deploy of the service mid-drain) goes on with that drain as
/// its own, from when it began. It used to take it for someone else's,
/// wait an hour, and never take it back, leaving a host whose sandbox was
/// held for hours draining for good.
#[test]
fn a_new_leader_goes_on_with_a_leaders_drain_as_its_own() {
    let start = Instant::now();
    let began_ms = NOW_MS - 3 * 3600 * 1000;
    let left = group(&[
        ("h-a", 10, Live),
        ("h-b", 25, Ours(began_ms)),
        ("h-c", 20, Live),
    ]);
    let mut shrinker = Shrinker::default();
    assert_eq!(
        plan(&mut shrinker, start, ScaleDecision::Hold, &left),
        Step::Drain("h-b".into()),
        "at once"
    );
    assert!(shrinker.ours("h-b"));
    assert_eq!(shrinker.seen(start).draining_for, secs(3 * 3600));
    shrinker.drained("h-b", start + secs(10), Ok(Drained { moved: 0, left: 1 }));
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(3 * 3600 - 1),
            ScaleDecision::Hold,
            &left
        ),
        Step::Drain("h-b".into())
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(3 * 3600),
            ScaleDecision::Hold,
            &left
        ),
        Step::TakeBack("h-b".into()),
        "six hours from when its drain began"
    );

    // One that empties is removed once quiet since this leader's first
    // pass that held.
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Hold, &left);
    shrinker.drained("h-b", start + secs(10), Ok(Drained::default()));
    assert_eq!(
        plan(&mut shrinker, start + secs(609), ScaleDecision::Hold, &left),
        Step::Hold
    );
    assert_eq!(
        plan(&mut shrinker, start + secs(610), ScaleDecision::Hold, &left),
        Step::Remove("h-b".into())
    );

    // And it takes it back when the group would grow.
    let mut shrinker = Shrinker::default();
    assert_eq!(
        plan(&mut shrinker, start, ScaleDecision::Grow { to: 3 }, &left),
        Step::TakeBack("h-b".into())
    );
}

/// A host the leader drains that an operator drains again is theirs from
/// then on, as is one an operator undrains: the leader leaves it.
#[test]
fn a_drain_someone_else_takes_over_is_theirs() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    plan(
        &mut shrinker,
        start + secs(1810),
        ScaleDecision::Hold,
        &draining(),
    );
    let theirs = group(&[("h-a", 10, Live), ("h-b", 25, Theirs), ("h-c", 20, Live)]);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1840),
            ScaleDecision::Grow { to: 3 },
            &theirs
        ),
        Step::Hold,
        "never taken back"
    );
    assert_eq!(shrinker.outgoing(), None);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1840 + 7200),
            ScaleDecision::Hold,
            &theirs
        ),
        Step::Hold,
        "nor adopted, by default"
    );
}

/// A host someone else drained is theirs: by default the leader never
/// removes it. Asked to adopt such hosts, it removes one after the
/// adoption period, as long as the group keeps its minimum, and never
/// takes it back.
#[test]
fn a_host_drained_by_someone_else_is_adopted_only_when_asked_and_above_the_minimum() {
    let start = Instant::now();
    let theirs = group(&[("h-a", 10, Live), ("h-b", 25, Theirs), ("h-c", 20, Live)]);
    let mut shrinker = Shrinker::default();
    plan(&mut shrinker, start, ScaleDecision::Hold, &theirs);
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(36_000),
            ScaleDecision::Hold,
            &theirs
        ),
        Step::Hold,
        "off by default"
    );

    let adopt = |shrinker: &mut Shrinker, at: Instant, decision, group: &Group| {
        shrinker.plan(&ADOPTING, &look(at, NOW_MS, decision, group))
    };
    let mut shrinker = Shrinker::default();
    assert_eq!(
        adopt(&mut shrinker, start, ScaleDecision::Hold, &theirs),
        Step::Hold
    );
    assert_eq!(
        adopt(
            &mut shrinker,
            start + secs(3599),
            ScaleDecision::Hold,
            &theirs
        ),
        Step::Hold
    );
    assert_eq!(
        adopt(
            &mut shrinker,
            start + secs(3600),
            ScaleDecision::Hold,
            &theirs
        ),
        Step::Drain("h-b".into())
    );
    assert!(!shrinker.ours("h-b"));
    assert_eq!(
        adopt(
            &mut shrinker,
            start + secs(3610),
            ScaleDecision::Grow { to: 3 },
            &theirs
        ),
        Step::Hold,
        "never taken back"
    );
    shrinker.drained("h-b", start + secs(3620), Ok(Drained { moved: 0, left: 1 }));
    let late = start + secs(3600 + 6 * 3600);
    assert_eq!(
        adopt(&mut shrinker, late, ScaleDecision::Hold, &theirs),
        Step::Hold
    );
    assert_eq!(shrinker.outgoing(), None);
    assert_eq!(
        adopt(
            &mut shrinker,
            late + secs(7200),
            ScaleDecision::Hold,
            &theirs
        ),
        Step::Hold,
        "left to whoever drained it"
    );

    // With one live host left and a minimum of one, it is not removed.
    let lone = group(&[("h-a", 10, Live), ("h-b", 25, Theirs)]);
    let mut shrinker = Shrinker::default();
    let at_minimum = |shrinker: &mut Shrinker, at: Instant| {
        let mut seen = look(at, NOW_MS, ScaleDecision::Hold, &lone);
        seen.min_hosts = 2;
        shrinker.plan(&ADOPTING, &seen)
    };
    at_minimum(&mut shrinker, start);
    assert_eq!(at_minimum(&mut shrinker, start + secs(7200)), Step::Hold);
}

#[test]
fn a_host_undrained_by_someone_else_is_left_alone() {
    let start = Instant::now();
    let mut shrinker = draining_h_b(start);
    // Its drain has not landed yet: drained again when due.
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1830),
            ScaleDecision::Hold,
            &three()
        ),
        Step::Drain("h-b".into())
    );
    plan(
        &mut shrinker,
        start + secs(1840),
        ScaleDecision::Hold,
        &draining(),
    );
    assert_eq!(
        plan(
            &mut shrinker,
            start + secs(1850),
            ScaleDecision::Hold,
            &three()
        ),
        Step::Hold
    );
    assert_eq!(shrinker.outgoing(), None);
}
