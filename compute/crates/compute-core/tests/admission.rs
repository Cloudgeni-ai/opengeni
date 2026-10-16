//! Admission: wakes start only while what the sandbox then takes fits into
//! the host's memory budget; otherwise idle sandboxes make room, and a wake
//! nothing can make room for is refused. Hand-written scenarios, then a
//! randomized simulation of the accounting.

use std::collections::BTreeMap;
use std::time::Duration;

use compute_core::{
    Action, Admission, At, Capacity, Durability, HoldId, Host, HostPolicy, Input, Level, Notice,
    OpId, Outcome, Priority, SandboxId, Size, SleepPolicy, SleepRules, State, Step, StepLimits,
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

fn policy(budget: u64) -> HostPolicy {
    HostPolicy {
        admission: Some(Admission {
            budget,
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
        Self {
            host: Host::new(policy(budget)).unwrap(),
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
            notice: Notice::HostFull { needed, free },
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
fn idle_sandboxes_make_room_least_recently_used_first() {
    let mut rig = Rig::new(2 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    wake(&mut rig, 1);
    rig.at(1);
    wake(&mut rig, 2);
    // Both idle past the grace, before their own pause.
    rig.at(5);
    let actions = rig.touch(3);
    assert!(host_full(&actions, 3).is_none());
    let first = started(&actions);
    assert!(
        matches!(first[..], [(1, Step::Pause, _)]),
        "the least recently used makes room: {first:?}"
    );
    let (step, op) = rig.drive_until(actions, 3);
    assert_eq!(step, Step::Restore);
    assert_eq!(rig.level(1), Level::Saved, "its process ended");
    assert_eq!(rig.level(2), Level::Running, "only as many as needed");
    rig.finish(3, op);
    assert_eq!(rig.capacity().reserved, 2 * GIB);
}

#[test]
fn busy_sandboxes_are_never_pushed_to_make_room() {
    let mut rig = Rig::new(2 * GIB);
    for id in 1..=3 {
        rig.add(id, saved(), Size::whole(GIB));
    }
    wake(&mut rig, 1);
    wake(&mut rig, 2);
    rig.at(5);
    // Work of their own just now.
    let mut out = Vec::new();
    rig.host.handle_all(
        rig.now,
        [1, 2].map(|id| Input::Busy {
            sandbox: SandboxId(id),
        }),
        &mut out,
    );
    rig.at(6);
    let actions = rig.touch(3);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 3), Some((GIB, 0)));
    // Once they have been quiet for the grace, they make room.
    rig.at(8);
    let actions = rig.touch(3);
    assert!(host_full(&actions, 3).is_none());
    let (step, _) = rig.drive_until(actions, 3);
    assert_eq!(step, Step::Restore);
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
    // Quiet past the grace: the next decision makes room, unasked.
    rig.at(4);
    let actions = rig.send(Input::Tick);
    assert!(!rig.host.waits_for_room(SandboxId(3)));
    let (step, _) = rig.drive_until(actions, 3);
    assert_eq!(step, Step::Restore);
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
}

impl Sim {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed);
        let budget = (4 + rng.below(12)) * GIB;
        let limits = StepLimits::uniform(1 + u32::try_from(rng.below(8)).unwrap());
        let host = Host::new(HostPolicy {
            limits,
            ..policy(budget)
        })
        .unwrap();
        Self {
            host,
            now: At::ZERO,
            rng,
            budget,
            sizes: BTreeMap::new(),
            running: BTreeMap::new(),
            refusals: 0,
            starts: 0,
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
                    notice: Notice::HostFull { needed, free },
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
                let size = Size { request, limit };
                self.sizes.insert(id, size);
                Input::Add {
                    sandbox: id,
                    state: saved(),
                    policy: no_compress(),
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
                Input::Remove { sandbox: id }
            }
            _ => {
                let ops: Vec<OpId> = self.running.keys().copied().collect();
                if ops.is_empty() {
                    Input::Tick
                } else {
                    let op = ops[usize::try_from(self.rng.below(ops.len() as u64)).unwrap()];
                    let (sandbox, _) = self.running.remove(&op).unwrap();
                    Input::Finished {
                        sandbox,
                        op,
                        outcome: Outcome::Done,
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
