//! Admission: wakes start only while what the sandbox then takes fits into
//! the host's memory budget. A wake waits only for instant relief, idle VM
//! processes already saved ending; otherwise it is refused at once, and the
//! host keeps room ahead of wakes in the background. Hand-written
//! scenarios, then a randomized simulation of the accounting.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use compute_core::{
    Action, Admission, At, Capacity, Durability, Failure, HoldId, Host, HostPolicy, Input, Level,
    MemoryPolicy, Notice, OpId, Outcome, Priority, SandboxId, Size, SleepPolicy, SleepRules, State,
    Step, StepLimits,
};

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;
const GRACE: Duration = Duration::from_secs(2);

/// Sleeps like the recommended rules but never compresses, as on a host
/// with huge pages, so making room ends VM processes.
fn no_compress() -> SleepPolicy {
    SleepPolicy::new(SleepRules {
        compress_under_pressure: false,
        ..SleepRules::RECOMMENDED
    })
    .unwrap()
}

fn saved() -> State {
    State::new(Level::Saved, Durability::Local, true)
}

fn paused_saved() -> State {
    State::new(Level::Paused, Durability::Local, true)
}

fn policy(budget: u64, buffer: u64) -> HostPolicy {
    HostPolicy {
        admission: Some(Admission {
            budget,
            buffer,
            busy_grace: GRACE,
        }),
        ..HostPolicy::default()
    }
}

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    fn new(budget: u64) -> Self {
        Self::buffered(budget, 0)
    }

    fn buffered(budget: u64, buffer: u64) -> Self {
        Self {
            host: Host::new(policy(budget, buffer)).unwrap(),
            now: At::ZERO,
        }
    }

    fn send(&mut self, input: Input) -> Vec<Action> {
        let mut out = Vec::new();
        self.host.handle(self.now, input, &mut out);
        out
    }

    fn add(&mut self, id: u128, state: State, size: Size) -> Vec<Action> {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy: no_compress(),
            size,
        })
    }

    fn busy(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Busy {
            sandbox: SandboxId(id),
        })
    }

    fn resident(&mut self, id: u128, bytes: u64) -> Vec<Action> {
        self.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes,
        })
    }

    fn touch(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Touch {
            sandbox: SandboxId(id),
            priority: Priority::Interactive,
        })
    }

    fn hold(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Hold {
            sandbox: SandboxId(id),
            hold: HoldId(u64::try_from(id).unwrap()),
            until: None,
            priority: Priority::Interactive,
        })
    }

    fn release(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Release {
            sandbox: SandboxId(id),
            hold: HoldId(u64::try_from(id).unwrap()),
        })
    }

    fn finish(&mut self, id: u128, op: OpId) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome: Outcome::Done,
        })
    }

    fn at(&mut self, secs: u64) {
        self.now = At::from_duration(Duration::from_secs(secs));
    }

    fn level(&self, id: u128) -> Level {
        self.host.sandbox(SandboxId(id)).unwrap().state.level
    }

    fn capacity(&self) -> Capacity {
        self.host.capacity().unwrap()
    }

    /// Finishes every step `actions` start, and those they lead to, until
    /// one starts for `until`; returns that one's step and op. Fails if
    /// work runs out first.
    fn drive_until(&mut self, mut actions: Vec<Action>, until: u128) -> (Step, OpId) {
        for _ in 0..50 {
            let mut next = Vec::new();
            for (id, step, op) in started(&actions) {
                if id == until {
                    return (step, op);
                }
                next.extend(self.finish(id, op));
            }
            assert!(!next.is_empty(), "nothing more started for {until}");
            actions = next;
        }
        panic!("{until} never started");
    }
}

fn started(actions: &[Action]) -> Vec<(u128, Step, OpId)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Start { sandbox, op, step } => Some((sandbox.0, *step, *op)),
            _ => None,
        })
        .collect()
}

fn host_full(actions: &[Action], id: u128) -> Option<(u64, u64)> {
    actions.iter().find_map(|action| match action {
        Action::Notify {
            sandbox,
            notice: Notice::HostFull { needed, free, .. },
        } if sandbox.0 == id => Some((*needed, *free)),
        _ => None,
    })
}

/// Wakes `id`, saved, all the way to running.
fn wake(rig: &mut Rig, id: u128) {
    let actions = rig.touch(id);
    let (step, op) = rig.drive_until(actions, id);
    assert_eq!(step, Step::Restore);
    rig.finish(id, op);
    assert_eq!(rig.level(id), Level::Running);
}

#[test]
fn wakes_that_fit_start_and_count_their_request() {
    let mut rig = Rig::new(4 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    wake(&mut rig, 1);
    let actions = rig.touch(2);
    assert!(matches!(started(&actions)[..], [(2, Step::Restore, _)]));
    // Waking counts as much as running.
    let capacity = rig.capacity();
    assert_eq!(
        (capacity.reserved, capacity.occupied, capacity.awake),
        (2 * GIB, 2 * GIB, 2)
    );
    assert_eq!(capacity.free(), 2 * GIB);
}

#[test]
fn a_wake_no_room_can_be_made_for_is_refused_with_what_it_needs() {
    let mut rig = Rig::new(2 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    for id in 1..=2 {
        let actions = rig.hold(id);
        let (_, op) = rig.drive_until(actions, id);
        rig.finish(id, op);
    }
    let actions = rig.touch(3);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 3), Some((GIB, 0)));
    let view = rig.host.sandbox(SandboxId(3)).unwrap();
    assert!(!view.wants_awake, "a refused wake is dropped");
    assert!(!rig.host.waits_for_room(SandboxId(3)));
    assert_eq!(rig.level(3), Level::Saved);
    // Held sandboxes stay as they are.
    assert_eq!(
        (rig.level(1), rig.level(2)),
        (Level::Running, Level::Running)
    );
    // Nothing retries it on its own.
    rig.at(100);
    assert_eq!(started(&rig.send(Input::Tick)), []);
}

#[test]
fn a_wake_never_waits_for_slow_relief() {
    let mut rig = Rig::new(2 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    wake(&mut rig, 1);
    wake(&mut rig, 2);
    // Both idle past the grace, but pausing and saving them takes seconds.
    rig.at(5);
    let actions = rig.touch(3);
    assert_eq!(host_full(&actions, 3), Some((GIB, 0)));
    assert_eq!(started(&actions), [], "nothing is pushed for it");
    assert_eq!(
        (rig.level(1), rig.level(2)),
        (Level::Running, Level::Running)
    );
}

#[test]
fn idle_saved_vms_end_at_once_for_a_wake_least_recently_used_first() {
    let mut rig = Rig::new(2 * GIB);
    rig.add(1, paused_saved(), Size::whole(GIB));
    rig.at(1);
    rig.add(2, paused_saved(), Size::whole(GIB));
    rig.add(3, saved(), Size::whole(GIB));
    rig.resident(1, GIB);
    rig.resident(2, GIB);
    rig.at(5);
    let actions = rig.touch(3);
    assert!(host_full(&actions, 3).is_none());
    let ends = started(&actions);
    assert!(
        matches!(ends[..], [(1, Step::Drop, _)]),
        "only the least recently used ends: {ends:?}"
    );
    let (step, op) = rig.drive_until(actions, 3);
    assert_eq!(step, Step::Restore);
    assert_eq!(rig.level(1), Level::Saved);
    assert_eq!(rig.level(2), Level::Paused, "only as many as needed");
    rig.finish(3, op);
    assert_eq!(rig.capacity().reserved, GIB);
}

#[test]
fn a_recently_active_or_unsaved_vm_never_ends_for_a_wake() {
    let mut rig = Rig::new(2 * GIB);
    rig.add(
        2,
        State::new(Level::Paused, Durability::Volatile, false),
        Size::whole(GIB),
    );
    rig.add(3, saved(), Size::whole(GIB));
    // Paused and saved, but active within the grace.
    rig.at(5);
    rig.add(1, paused_saved(), Size::whole(GIB));
    rig.at(6);
    let actions = rig.touch(3);
    assert_eq!(host_full(&actions, 3), Some((GIB, 0)));
    assert_eq!(started(&actions), []);
}

#[test]
fn the_buffer_is_kept_ahead_of_wakes_from_idle_sandboxes() {
    let mut rig = Rig::buffered(3 * GIB, GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    wake(&mut rig, 1);
    wake(&mut rig, 2);
    // Within the buffer is still free: wakes take it.
    let actions = rig.hold(3);
    let (_, op) = rig.drive_until(actions, 3);
    rig.finish(3, op);
    assert_eq!(rig.capacity().free(), 0);
    // Once idle past the grace, the least recently used idle one that is
    // not busy goes, in the background.
    rig.at(10);
    let actions = rig.busy(1);
    assert!(
        matches!(started(&actions)[..], [(2, Step::Pause, _)]),
        "{actions:?}"
    );
    let mut actions = actions;
    while !started(&actions).is_empty() {
        let mut next = Vec::new();
        for (id, _, op) in started(&actions) {
            next.extend(rig.finish(id, op));
        }
        actions = next;
    }
    assert_eq!(rig.level(2), Level::Saved);
    assert_eq!(
        (rig.level(1), rig.level(3)),
        (Level::Running, Level::Running)
    );
    assert_eq!(rig.capacity().free(), GIB);
    // Kept, not exceeded.
    rig.at(20);
    assert_eq!(started(&rig.busy(1)), []);
}

#[test]
fn a_held_sandbox_refused_wakes_once_room_can_be_made() {
    let mut rig = Rig::new(2 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    for id in 1..=2 {
        let actions = rig.hold(id);
        let (_, op) = rig.drive_until(actions, id);
        rig.finish(id, op);
    }
    let actions = rig.hold(3);
    assert_eq!(host_full(&actions, 3), Some((GIB, 0)));
    assert!(rig.host.waits_for_room(SandboxId(3)));
    assert!(rig.host.sandbox(SandboxId(3)).unwrap().wants_awake);
    // Released, but active just now: not yet.
    rig.at(1);
    assert_eq!(started(&rig.release(1)), []);
    // Quiet past the grace: room is made for it in the background, and it
    // wakes once there is.
    rig.at(4);
    let actions = rig.send(Input::Tick);
    assert!(matches!(started(&actions)[..], [(1, Step::Pause, _)]));
    assert!(rig.host.waits_for_room(SandboxId(3)));
    let (step, _) = rig.drive_until(actions, 3);
    assert_eq!(step, Step::Restore);
    assert!(!rig.host.waits_for_room(SandboxId(3)));
    assert_eq!(rig.level(1), Level::Saved);
}

#[test]
fn a_paused_vm_counts_what_it_holds_and_resumes_into_it() {
    let mut rig = Rig::new(2 * GIB);
    rig.add(1, State::RUNNING, Size::whole(GIB));
    rig.add(
        2,
        State::new(Level::Paused, Durability::Volatile, false),
        Size::whole(GIB),
    );
    rig.hold(1);
    // Not reported yet: a paused VM counts its whole size.
    assert_eq!(rig.capacity().occupied, 2 * GIB);
    rig.send(Input::Resident {
        sandbox: SandboxId(2),
        bytes: 600 * MIB,
    });
    assert_eq!(rig.capacity().occupied, GIB + 600 * MIB);
    // Resuming needs the rest of its request, which is free.
    let actions = rig.touch(2);
    assert!(matches!(started(&actions)[..], [(2, Step::Resume, _)]));
    assert_eq!(rig.capacity().occupied, 2 * GIB);
}

#[test]
fn requests_below_the_limit_pack_more_and_bursts_count() {
    let mut rig = Rig::new(2 * GIB);
    let size = Size {
        request: 512 * MIB,
        limit: GIB,
        save: GIB,
    };
    for id in 1..=5 {
        rig.add(id, saved(), size);
    }
    let mut actions = Vec::new();
    for id in 1..=5 {
        actions.extend(rig.hold(id));
    }
    let woken: Vec<u128> = started(&actions).iter().map(|start| start.0).collect();
    assert_eq!(woken, [1, 2, 3, 4], "four requests fit");
    assert!(rig.host.waits_for_room(SandboxId(5)));
    for (id, _, op) in started(&actions) {
        rig.finish(id, op);
    }
    // A burst past its request counts too.
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    let capacity = rig.capacity();
    assert_eq!(
        (capacity.reserved, capacity.occupied),
        (2 * GIB, 2 * GIB + 512 * MIB)
    );
    assert_eq!(capacity.free(), 0);
}

#[test]
fn reservations_are_rebuilt_from_the_records_after_a_restart() {
    let mut rig = Rig::new(4 * GIB);
    let sizes = [GIB, 512 * MIB, 2 * GIB];
    for (id, bytes) in (1..).zip(sizes) {
        rig.add(id, saved(), Size::whole(bytes));
    }
    wake(&mut rig, 1);
    wake(&mut rig, 2);
    let before = rig.capacity();
    // A new agent adds what it finds: its records and the VMs still
    // running.
    let mut again = Rig::new(4 * GIB);
    for (id, bytes) in (1..).zip(sizes) {
        let state = rig.host.sandbox(SandboxId(id)).unwrap().state;
        again.add(id, state, Size::whole(bytes));
    }
    assert_eq!(again.capacity(), before);
    let actions = again.touch(3);
    assert_eq!(host_full(&actions, 3), None);
}

#[test]
fn a_full_host_decides_in_microseconds() {
    // A thousand sandboxes, the budget full of busy ones, half the rest
    // paused but unsaved: nothing can end at once.
    let mut rig = Rig::new(500 * GIB);
    for id in 1..=1000 {
        let state = if id <= 500 {
            State::RUNNING
        } else {
            State::new(Level::Paused, Durability::Volatile, false)
        };
        rig.add(id, state, Size::whole(GIB));
        rig.hold(id);
    }
    rig.add(1001, saved(), Size::whole(GIB));
    let mut slowest = Duration::ZERO;
    for _ in 0..20 {
        let begin = Instant::now();
        let actions = rig.touch(1001);
        slowest = slowest.max(begin.elapsed());
        assert!(host_full(&actions, 1001).is_some());
    }
    println!("admission decision among 1001 sandboxes: at most {slowest:?}");
    assert!(slowest < Duration::from_millis(50), "{slowest:?}");
}

// --- Randomized simulation -------------------------------------------------

#[test]
fn a_removed_vm_counts_until_its_process_has_ended() {
    let mut rig = Rig::new(GIB);
    rig.add(1, State::RUNNING, Size::whole(GIB));
    rig.add(2, saved(), Size::whole(GIB));
    rig.hold(1);
    let actions = rig.hold(2);
    assert_eq!(host_full(&actions, 2), Some((GIB, 0)));
    // Removing the running one does not free its memory yet: the host
    // agent still has to end its VM.
    let actions = rig.send(Input::Remove {
        sandbox: SandboxId(1),
    });
    assert!(actions.contains(&Action::Destroy {
        sandbox: SandboxId(1)
    }));
    assert_eq!(started(&actions), []);
    assert_eq!(rig.capacity().occupied, GIB);
    let actions = rig.send(Input::Unmanaged {
        sandbox: SandboxId(1),
        bytes: 0,
    });
    assert!(matches!(started(&actions)[..], [(2, Step::Restore, _)]));
}

#[test]
fn a_vm_found_but_not_managed_counts_against_the_budget() {
    let mut rig = Rig::new(2 * GIB);
    rig.add(1, saved(), Size::whole(GIB));
    rig.send(Input::Unmanaged {
        sandbox: SandboxId(9),
        bytes: 1536 * MIB,
    });
    let actions = rig.touch(1);
    assert_eq!(host_full(&actions, 1), Some((GIB, 512 * MIB)));
}

#[test]
fn an_overdrawn_budget_admits_nothing_more() {
    // As after a restart with a smaller budget: a running and a paused VM
    // in the room of one.
    let mut rig = Rig::new(GIB);
    rig.add(1, State::RUNNING, Size::whole(GIB));
    rig.add(
        2,
        State::new(Level::Paused, Durability::Volatile, false),
        Size::whole(GIB),
    );
    rig.hold(1);
    rig.resident(2, GIB);
    // Resuming takes nothing more, but the budget is already overdrawn.
    let actions = rig.touch(2);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 2), Some((GIB, 0)));
    assert_eq!(rig.capacity().reserved, GIB);
}

#[test]
fn a_remote_wake_is_admitted_before_it_downloads() {
    let remote = State::new(Level::Remote, Durability::Remote, true);
    let mut rig = Rig::new(GIB);
    rig.add(1, State::RUNNING, Size::whole(GIB));
    rig.add(2, remote, Size::whole(GIB));
    rig.hold(1);
    let actions = rig.touch(2);
    assert_eq!(started(&actions), [], "nothing is downloaded");
    assert_eq!(host_full(&actions, 2), Some((GIB, 0)));
    // With room, the download holds it until the restore.
    let mut rig = Rig::new(2 * GIB);
    rig.add(2, remote, Size::whole(GIB));
    let actions = rig.touch(2);
    assert!(matches!(started(&actions)[..], [(2, Step::Fetch, _)]));
    assert_eq!(rig.capacity().reserved, GIB);
}

#[test]
fn a_vm_backing_off_is_not_instant_relief() {
    let mut rig = Rig::new(GIB);
    rig.add(1, paused_saved(), Size::whole(GIB));
    rig.add(2, saved(), Size::whole(GIB));
    rig.resident(1, GIB);
    rig.at(5);
    let actions = rig.touch(2);
    let [(1, Step::Drop, op)] = started(&actions)[..] else {
        panic!("the idle saved VM does not end: {actions:?}");
    };
    // Ending it fails; it backs off, and the wake does not wait for that.
    let actions = rig.send(Input::Finished {
        sandbox: SandboxId(1),
        op,
        outcome: Outcome::Failed(Failure::Transient),
    });
    assert_eq!(host_full(&actions, 2), Some((GIB, 0)));
    assert_eq!(started(&actions), []);
}

#[test]
fn compressing_that_frees_nothing_goes_deeper_for_the_buffer() {
    let policy = HostPolicy {
        memory: Some(MemoryPolicy {
            low_watermark: 0,
            high_watermark: 0,
            compressed_percent: 100,
            balloon_grace: Duration::ZERO,
        }),
        ..policy(GIB, 256 * MIB)
    };
    let mut rig = Rig {
        host: Host::new(policy).unwrap(),
        now: At::ZERO,
    };
    rig.send(Input::Add {
        sandbox: SandboxId(1),
        state: paused_saved(),
        policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
        size: Size::whole(GIB),
    });
    rig.resident(1, 1000 * MIB);
    rig.at(5);
    let actions = rig.send(Input::Tick);
    assert!(
        matches!(started(&actions)[..], [(1, Step::Drop, _)]),
        "{actions:?}"
    );
}

// --- Randomized simulation -------------------------------------------------

/// `SplitMix64`.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Sim {
    host: Host,
    now: At,
    rng: Rng,
    budget: u64,
    sizes: BTreeMap<SandboxId, Size>,
    running: BTreeMap<OpId, (SandboxId, Step)>,
    refusals: u64,
    starts: u64,
    limit: u32,
    /// Removed sandboxes whose VM the host agent has not ended yet.
    ending: Vec<SandboxId>,
    /// Sandboxes whose last step failed: they back off before any step.
    failed: BTreeSet<SandboxId>,
}

impl Sim {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed);
        let budget = (4 + rng.below(12)) * GIB;
        let buffer = rng.below(3) * GIB;
        let limit = 1 + u32::try_from(rng.below(8)).unwrap();
        let limits = StepLimits::uniform(limit);
        let host = Host::new(HostPolicy {
            limits,
            ..policy(budget, buffer)
        })
        .unwrap();
        Self {
            host,
            now: At::ZERO,
            rng,
            budget,
            sizes: BTreeMap::new(),
            running: BTreeMap::new(),
            ending: Vec::new(),
            failed: BTreeSet::new(),
            refusals: 0,
            starts: 0,
            limit,
        }
    }

    fn send(&mut self, inputs: Vec<Input>) {
        let mut out = Vec::new();
        self.host.handle_all(self.now, inputs, &mut out);
        for action in out {
            match action {
                Action::Start { sandbox, op, step } => {
                    self.starts += 1;
                    self.running.insert(op, (sandbox, step));
                }
                Action::Notify {
                    sandbox,
                    notice: Notice::HostFull { needed, free, .. },
                } => {
                    self.refusals += 1;
                    assert!(needed > free, "{sandbox:?} refused though it fits");
                }
                _ => {}
            }
        }
        let capacity = self.host.capacity().unwrap();
        assert!(
            capacity.reserved <= self.budget,
            "requests of awake sandboxes exceed the budget: {capacity:?}"
        );
        self.check_waits_only_for_instant_relief();
    }

    /// A wake that neither started nor was refused waits for a free slot
    /// of its step or for a VM process that is ending; never for slow
    /// relief.
    fn check_waits_only_for_instant_relief(&self) {
        let views: Vec<_> = self
            .sizes
            .keys()
            .filter_map(|id| Some((*id, self.host.sandbox(*id)?)))
            .collect();
        let ending = views.iter().any(|(_, view)| {
            view.step == Some(Step::Drop)
                || (view.floor >= Level::Saved
                    && view.step.is_none()
                    && matches!(view.state.level, Level::Paused | Level::Compressed)
                    && view.state.durability != Durability::Volatile)
        });
        for (id, view) in &views {
            if !view.wants_awake
                || view.state.level == Level::Running
                || view.step.is_some()
                || self.host.waits_for_room(*id)
                || self.failed.contains(id)
            {
                continue;
            }
            let step = match view.state.level {
                Level::Paused | Level::Compressed => Step::Resume,
                Level::Remote => Step::Fetch,
                _ => Step::Restore,
            };
            let limited = self.host.in_flight(step) >= self.limit;
            assert!(limited || ending, "{id:?} waits for slow relief: {view:?}");
        }
    }

    fn sandbox(&mut self) -> SandboxId {
        SandboxId(u128::from(self.rng.below(24)))
    }

    fn step(&mut self) {
        let id = self.sandbox();
        let input = match self.rng.below(100) {
            0..10 if !self.sizes.contains_key(&id) => {
                let limit = (1 + self.rng.below(4)) * GIB;
                let request = limit / (1 + self.rng.below(4));
                let size = Size {
                    request,
                    limit,
                    save: limit,
                };
                self.sizes.insert(id, size);
                // Saved, paused with a saved copy, or only in object
                // storage; compressing under pressure or not.
                let state = match self.rng.below(3) {
                    0 => saved(),
                    1 => paused_saved(),
                    _ => State::new(Level::Remote, Durability::Remote, true),
                };
                let policy = if self.rng.below(2) == 0 {
                    no_compress()
                } else {
                    SleepPolicy::new(SleepRules::RECOMMENDED).unwrap()
                };
                Input::Add {
                    sandbox: id,
                    state,
                    policy,
                    size,
                }
            }
            0..30 => Input::Touch {
                sandbox: id,
                priority: Priority::Interactive,
            },
            30..40 => Input::Hold {
                sandbox: id,
                hold: HoldId(1),
                until: None,
                priority: Priority::Interactive,
            },
            40..55 => Input::Release {
                sandbox: id,
                hold: HoldId(1),
            },
            55..65 => Input::Busy { sandbox: id },
            65..75 => {
                let limit = self.sizes.get(&id).map_or(GIB, |size| size.limit);
                Input::Resident {
                    sandbox: id,
                    bytes: self.rng.below(limit + 1),
                }
            }
            75..78 => {
                self.sizes.remove(&id);
                self.ending.push(id);
                Input::Remove { sandbox: id }
            }
            78..81 if !self.ending.is_empty() => {
                let index = self.rng.below(self.ending.len() as u64);
                let sandbox = self.ending.swap_remove(usize::try_from(index).unwrap());
                Input::Unmanaged { sandbox, bytes: 0 }
            }
            _ => {
                let ops: Vec<OpId> = self.running.keys().copied().collect();
                if ops.is_empty() {
                    Input::Tick
                } else {
                    let op = ops[usize::try_from(self.rng.below(ops.len() as u64)).unwrap()];
                    let (sandbox, step) = self.running.remove(&op).unwrap();
                    // Steps putting a sandbox to sleep sometimes fail and
                    // back off.
                    let outcome = if !step.wakes() && self.rng.below(10) == 0 {
                        self.failed.insert(sandbox);
                        Outcome::Failed(Failure::Transient)
                    } else {
                        self.failed.remove(&sandbox);
                        Outcome::Done
                    };
                    Input::Finished {
                        sandbox,
                        op,
                        outcome,
                    }
                }
            }
        };
        self.now = self.now + Duration::from_millis(self.rng.below(3000));
        self.send(vec![input]);
    }
}

#[test]
fn awake_requests_never_exceed_the_budget() {
    let (mut starts, mut refusals) = (0, 0);
    for seed in 0..200 {
        let mut sim = Sim::new(seed);
        for _ in 0..2_000 {
            sim.step();
        }
        starts += sim.starts;
        refusals += sim.refusals;
    }
    assert!(
        starts > 10_000 && refusals > 100,
        "{starts} starts, {refusals} refusals"
    );
}
