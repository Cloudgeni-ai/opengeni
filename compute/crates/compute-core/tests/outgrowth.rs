//! Running sandboxes that borrow memory above their request (ADR 24): the
//! bounds the host sets on their VMs, and the shrinks and ends it asks for
//! when bounds are not enough. A sandbox within its request is never
//! touched, and none in use is ever paused for memory.

use std::time::Duration;

use compute_core::{
    Action, At, Durability, HoldId, Host, HostPolicy, Input, Level, MemoryLevels, MemoryPolicy,
    Outgrowth, Priority, SandboxId, ShrinkRequest, Size, SleepPolicy, SleepRules, State, Step,
};

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    /// The low watermark is 4 GiB, the high 5 GiB; outgrowth as by
    /// default: a shrink after 10 s, answered within 15 s, the next 10 s
    /// after, 256 MiB at least, bounds written in 64 MiB steps.
    fn new() -> Self {
        let policy = HostPolicy {
            memory: Some(MemoryPolicy {
                low_watermark: 4 * GIB,
                high_watermark: 5 * GIB,
                compressed_percent: 30,
                balloon_grace: Duration::from_secs(2),
                outgrowth: Some(Outgrowth::default()),
            }),
            ..HostPolicy::default()
        };
        Self {
            host: Host::new(policy).unwrap(),
            now: At::ZERO,
        }
    }

    fn send(&mut self, input: Input) -> Vec<Action> {
        let mut out = Vec::new();
        self.host.handle(self.now, input, &mut out);
        out
    }

    /// A running sandbox that never sleeps by its rules, with `request`
    /// of up to `limit` and a VM holding `resident`; held awake, in use,
    /// when `busy`.
    fn running(&mut self, id: u128, request: u64, limit: u64, resident: u64, busy: bool) {
        self.add(id, request, limit, resident, busy, SleepRules::NEVER);
    }

    /// A running sandbox as [`Self::running`], not held, that memory
    /// pressure may put to sleep: idle.
    fn sleepable(&mut self, id: u128, request: u64, limit: u64, resident: u64) {
        self.add(id, request, limit, resident, false, SleepRules::RECOMMENDED);
    }

    fn add(
        &mut self,
        id: u128,
        request: u64,
        limit: u64,
        resident: u64,
        busy: bool,
        rules: SleepRules,
    ) {
        let sandbox = SandboxId(id);
        self.send(Input::Add {
            sandbox,
            state: State::new(Level::Running, Durability::Volatile, true),
            policy: SleepPolicy::new(rules).unwrap(),
            size: Size {
                request,
                limit,
                save: limit,
                ..Size::default()
            },
            last_activity: self.now,
        });
        if busy {
            self.send(Input::Hold {
                sandbox,
                hold: HoldId(1),
                until: None,
                priority: Priority::Interactive,
            });
        }
        self.uses(id, resident, 0, 0, 0);
    }

    /// A reading of `id`'s VM: `resident` bytes, `compressed` of them its
    /// compressed pages, `swapped` of its memory out of RAM at its
    /// original size, `stall` thousandths of the last ten seconds stalled.
    fn uses(&mut self, id: u128, resident: u64, compressed: u64, swapped: u64, stall: u16) {
        self.held(id, resident, compressed, swapped, stall, None);
    }

    /// A reading as [`Self::uses`], with the VM's `memory.high` as the
    /// kernel holds it.
    fn held(
        &mut self,
        id: u128,
        resident: u64,
        compressed: u64,
        swapped: u64,
        stall: u16,
        high: Option<u64>,
    ) {
        self.read(id, resident, compressed, swapped, stall, high, false);
    }

    /// A reading as [`Self::uses`] of a VM `resident` bytes large that
    /// the engine is still bringing down toward its bound, then what is
    /// `available`: what the host does on both.
    fn descending(&mut self, id: u128, resident: u64, available: u64) -> Vec<Action> {
        let mut actions = self.read(id, resident, 0, 0, 0, None, true);
        actions.extend(self.available(available));
        actions
    }

    /// A reading as [`Self::held`], `bringing_down` saying whether the
    /// engine is still bringing the VM down toward its bound; what the
    /// host does on it.
    #[allow(clippy::too_many_arguments)]
    fn read(
        &mut self,
        id: u128,
        resident: u64,
        compressed: u64,
        swapped: u64,
        stall: u16,
        high: Option<u64>,
        bringing_down: bool,
    ) -> Vec<Action> {
        let sandbox = SandboxId(id);
        let mut actions = self.send(Input::Resident {
            sandbox,
            bytes: resident,
        });
        actions.extend(self.send(Input::MemoryUse {
            sandbox,
            compressed,
            swapped,
            stall,
            high,
            bringing_down,
        }));
        actions
    }

    fn available(&mut self, bytes: u64) -> Vec<Action> {
        self.send(Input::Memory { available: bytes })
    }

    fn at(&mut self, secs: u64) {
        self.now = At::from_duration(Duration::from_secs(secs));
    }

    fn levels(&self) -> MemoryLevels {
        self.host.memory_levels().unwrap()
    }

    fn level(&self, id: u128) -> Level {
        self.host.sandbox(SandboxId(id)).unwrap().state.level
    }
}

/// The bounds `actions` set: sandbox, `memory.low`, `memory.high`.
fn bounds(actions: &[Action]) -> Vec<(u128, u64, Option<u64>)> {
    let mut set: Vec<_> = actions
        .iter()
        .filter_map(|action| match action {
            Action::Bound { sandbox, low, high } => Some((sandbox.0, *low, *high)),
            _ => None,
        })
        .collect();
    set.sort_unstable();
    set
}

/// The shrinks `actions` ask: sandbox, bytes to free, bytes to keep, and
/// the request.
fn shrinks(actions: &[Action]) -> Vec<(u128, u64, u64, ShrinkRequest)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Shrink {
                sandbox,
                free,
                keep,
                request,
            } => Some((sandbox.0, *free, *keep, *request)),
            _ => None,
        })
        .collect()
}

fn ended(actions: &[Action]) -> Vec<u128> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::EndForMemory { sandbox } => Some(sandbox.0),
            _ => None,
        })
        .collect()
}

/// Whether `actions` start a step that would take a sandbox off running.
fn sleeps(actions: &[Action]) -> bool {
    !sleeping(actions).is_empty()
}

/// The sandboxes `actions` start a step on that would take them off
/// running.
fn sleeping(actions: &[Action]) -> Vec<u128> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Start {
                sandbox,
                step: Step::Pause | Step::Save | Step::Drop | Step::Compress,
                ..
            } => Some(sandbox.0),
            _ => None,
        })
        .collect()
}

#[test]
fn with_room_to_spare_a_running_sandbox_keeps_its_request_and_what_it_compressed_unbounded() {
    let mut rig = Rig::new();
    rig.running(1, 2 * GIB, 8 * GIB, 6 * GIB, true);
    // Its bounds are what it started with: its request, and no high.
    assert_eq!(bounds(&rig.available(40 * GIB)), []);
    let levels = rig.levels();
    assert!(!levels.short);
    assert_eq!((levels.held_back, levels.idle_held_back), (0, 0));
    // What the kernel compressed of it is kept for it too.
    rig.uses(1, 6 * GIB, 512 * MIB, 1536 * MIB, 0);
    assert_eq!(
        bounds(&rig.available(40 * GIB)),
        [(1, 2 * GIB + 512 * MIB, None)]
    );
}

#[test]
fn a_level_that_holds_nobody_back_still_keeps_the_largest_from_taking_all_that_is_left() {
    let mut rig = Rig::new();
    // 2 GiB borrowed, and 2 GiB more available above the low watermark:
    // it may hold 4 GiB above its request, not the 15 GiB its size lets it.
    rig.running(1, GIB, 16 * GIB, 3 * GIB, true);
    assert_eq!(bounds(&rig.available(6 * GIB)), [(1, GIB, Some(5 * GIB))]);
    assert_eq!(rig.levels().busy, 4 * GIB);
    assert_eq!(rig.levels().held_back, 0, "it is not held back yet");
}

#[test]
fn idle_sandboxes_go_to_sleep_before_those_in_use_give_back_anything() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 4 * GIB, true);
    rig.sleepable(2, GIB, 16 * GIB, 4 * GIB);
    // 2 GiB below the low watermark: the idle one is put to sleep, and
    // what it holds is on its way back. The one in use is not held back
    // for it: it keeps its 3 GiB and may grow by 2.
    let actions = rig.available(2 * GIB);
    assert_eq!(sleeping(&actions), [2], "{actions:?}");
    assert_eq!(bounds(&actions), [(1, GIB, Some(6 * GIB))]);
    let levels = rig.levels();
    assert_eq!((levels.relief, levels.busy), (4 * GIB, 5 * GIB));
    assert_eq!((levels.held_back, levels.idle_held_back), (0, 0));
    assert!(!levels.short);
    // Nothing is shrunk while it goes to sleep, and neither is shrunk.
    for second in 1..30 {
        rig.at(second);
        let actions = rig.available(2 * GIB);
        assert_eq!(shrinks(&actions), [], "at {second} s");
        assert_eq!(ended(&actions), [], "at {second} s");
    }
    assert_eq!(rig.level(1), Level::Running);
}

#[test]
fn a_quiet_sandbox_that_never_sleeps_counts_as_in_use() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 4 * GIB, true);
    // Not held, but it never sleeps, as a CI runner: its work goes on with
    // nobody calling it.
    rig.running(2, GIB, 16 * GIB, 4 * GIB, false);
    // 2 GiB below the low watermark: 4 GiB may be borrowed in all, and
    // both get the level of sandboxes in use.
    let actions = rig.available(2 * GIB);
    assert_eq!(
        bounds(&actions),
        [(1, GIB, Some(3 * GIB)), (2, GIB, Some(3 * GIB))]
    );
    let levels = rig.levels();
    assert_eq!(levels.busy, 2 * GIB);
    assert_eq!((levels.held_back, levels.idle_held_back), (2, 0));
    assert!(!sleeps(&actions), "{actions:?}");
}

#[test]
fn among_sandboxes_in_use_the_largest_borrowers_give_back_first() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 2 * GIB, true);
    rig.running(2, GIB, 16 * GIB, 6 * GIB, true);
    // 4 GiB may be borrowed: the one borrowing 1 GiB keeps it, the one
    // borrowing 5 GiB is held to the 3 GiB left.
    let actions = rig.available(2 * GIB);
    assert_eq!(
        bounds(&actions),
        [(1, GIB, Some(4 * GIB)), (2, GIB, Some(4 * GIB))]
    );
    assert_eq!(rig.levels().busy, 3 * GIB);
    assert_eq!(rig.levels().held_back, 1);
}

#[test]
fn a_bound_is_written_again_only_once_it_moved_by_a_step() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 3 * GIB, true);
    assert_eq!(bounds(&rig.available(6 * GIB)), [(1, GIB, Some(5 * GIB))]);
    // 10 MiB more compressed moves both bounds by less than a step.
    rig.uses(1, 3 * GIB, 10 * MIB, 30 * MIB, 0);
    assert_eq!(bounds(&rig.available(6 * GIB)), []);
    // 100 MiB does.
    rig.uses(1, 3 * GIB, 100 * MIB, 300 * MIB, 0);
    let set = bounds(&rig.available(6 * GIB));
    assert_eq!(set.len(), 1, "{set:?}");
    assert_eq!(set[0].1, GIB + 100 * MIB);
    // Room enough again: the high goes, whatever the step.
    assert_eq!(
        bounds(&rig.available(40 * GIB)),
        [(1, GIB + 100 * MIB, None)]
    );
}

/// Two sandboxes in use, both above their 1 GiB requests, much of their
/// memory compressed: even held to their requests, the host is 2.5 GiB
/// short of its low watermark. 1 uses 13 GiB above its request, 2 uses
/// 5.5.
fn short() -> Rig {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 6 * GIB, true);
    rig.running(2, GIB, 16 * GIB, 3 * GIB, true);
    rig.uses(1, 6 * GIB, 4 * GIB, 12 * GIB, 0);
    rig.uses(2, 3 * GIB + 512 * MIB, 2 * GIB, 5 * GIB, 0);
    rig
}

#[test]
fn a_short_host_holds_every_sandbox_to_its_request_then_shrinks_the_furthest_above() {
    let mut rig = short();
    let actions = rig.available(0);
    // Each keeps its request and its compressed pages, and no more.
    assert_eq!(
        bounds(&actions),
        [(1, 5 * GIB, Some(5 * GIB)), (2, 3 * GIB, Some(3 * GIB))]
    );
    let levels = rig.levels();
    assert!(levels.short);
    assert_eq!(levels.shortfall, 2 * GIB + 512 * MIB);
    assert!(shrinks(&actions).is_empty(), "not at once");
    rig.at(5);
    assert_eq!(shrinks(&rig.available(0)), []);
    // Still short after the hold: 1's guest is asked to free what the host
    // is short of, never below its request.
    rig.at(10);
    let actions = rig.available(0);
    let [(1, free, keep, request)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (2 * GIB + 512 * MIB, GIB));
    // One at a time.
    rig.at(11);
    assert_eq!(shrinks(&rig.available(0)), []);
    // A stale answer changes nothing.
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request: ShrinkRequest(request.0 + 1),
        freed: GIB,
        spent: true,
    });
    assert_eq!(shrinks(&rig.available(0)), []);
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request,
        freed: GIB,
        spent: false,
    });
    // Not before what it freed has had time to reach the host, and a
    // reading taken after shows it.
    rig.at(15);
    assert_eq!(shrinks(&rig.available(0)), []);
    rig.at(21);
    assert!(shrinks(&rig.send(Input::Tick)).is_empty(), "no reading yet");
    let actions = rig.available(0);
    assert_eq!(shrinks(&actions)[0].0, 1, "{actions:?}");
    // Nothing in use is ever paused for it.
    assert!(!sleeps(&actions));
    assert_eq!(
        (rig.level(1), rig.level(2)),
        (Level::Running, Level::Running)
    );
}

#[test]
fn a_guest_with_nothing_left_to_end_has_its_vm_ended_while_the_host_stays_short() {
    let mut rig = short();
    rig.available(0);
    rig.at(10);
    let actions = rig.available(0);
    let (_, _, _, request) = shrinks(&actions)[0];
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request,
        freed: 0,
        spent: true,
    });
    rig.at(20);
    let actions = rig.available(0);
    assert_eq!(ended(&actions), [1]);
    assert_eq!(shrinks(&actions), []);
    // Nothing else while it ends.
    rig.at(31);
    let actions = rig.available(0);
    assert!(ended(&actions).is_empty() && shrinks(&actions).is_empty());
}

#[test]
fn a_guest_that_does_not_answer_counts_as_unable() {
    let mut rig = short();
    rig.available(0);
    rig.at(10);
    assert_eq!(shrinks(&rig.available(0)).len(), 1);
    // The agent gives a guest 15 s and says when it gave no answer. Not
    // even that word 10 s later: it counts as unable then, and its VM is
    // ended once a reading after that shows the host still short.
    rig.at(25);
    assert_eq!(ended(&rig.available(0)), [], "the agent may still say");
    rig.at(35);
    assert_eq!(ended(&rig.available(0)), [], "it settles first");
    rig.at(44);
    assert_eq!(ended(&rig.available(0)), []);
    rig.at(45);
    assert_eq!(ended(&rig.available(0)), [1]);
}

#[test]
fn a_guest_that_cannot_be_shrunk_is_ended_only_while_the_host_is_short() {
    let mut rig = short();
    rig.available(0);
    rig.at(10);
    let (_, _, _, request) = shrinks(&rig.available(0))[0];
    rig.send(Input::ShrinkFailed {
        sandbox: SandboxId(1),
        request,
    });
    // Room again before the next round: nothing is ended.
    rig.at(20);
    let actions = rig.available(20 * GIB);
    assert!(ended(&actions).is_empty() && shrinks(&actions).is_empty());
    assert!(!rig.levels().short);
    // Short again: it must hold again before anything is done.
    rig.at(30);
    assert_eq!(ended(&rig.available(0)), []);
    rig.at(40);
    assert_eq!(ended(&rig.available(0)), [1]);
}

#[test]
fn a_guest_back_within_its_request_may_be_shrunk_again() {
    let mut rig = short();
    rig.available(0);
    rig.at(10);
    let (_, _, _, request) = shrinks(&rig.available(0))[0];
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request,
        freed: 0,
        spent: true,
    });
    // It had nothing left to end, then went back within its request and
    // grew again: its guest is asked again, its VM not ended.
    rig.at(15);
    rig.uses(1, GIB, 0, 0, 0);
    rig.available(0);
    rig.at(20);
    rig.uses(1, 6 * GIB, 4 * GIB, 12 * GIB, 0);
    let actions = rig.available(0);
    assert_eq!(ended(&actions), []);
    assert_eq!(shrinks(&actions)[0].0, 1, "{actions:?}");
}

#[test]
fn a_sandbox_barely_above_its_request_is_never_ended() {
    let mut rig = Rig::new();
    // 128 MiB above its request, and the host short anyway.
    rig.running(1, 4 * GIB, 16 * GIB, 4 * GIB, true);
    rig.uses(1, 4 * GIB + 128 * MIB, 0, 0, 0);
    rig.available(0);
    rig.at(10);
    let (_, free, _, request) = shrinks(&rig.available(0))[0];
    assert_eq!(
        free,
        128 * MIB,
        "never more than it holds above its request"
    );
    rig.send(Input::ShrinkFailed {
        sandbox: SandboxId(1),
        request,
    });
    for second in [20, 30, 60, 120] {
        rig.at(second);
        assert_eq!(ended(&rig.available(0)), []);
    }
}

#[test]
fn host_memory_held_above_the_request_ranks_a_guest_compressed_pages_included() {
    let mut rig = Rig::new();
    // 1 holds 5 GiB: 2 GiB in RAM, its request, and 3 GiB of compressed
    // pages. 2 holds 3 GiB in RAM, 2 GiB above its request.
    rig.running(1, 2 * GIB, 16 * GIB, 5 * GIB, true);
    rig.uses(1, 5 * GIB, 3 * GIB, 9 * GIB, 0);
    rig.running(2, GIB, 16 * GIB, 3 * GIB, true);
    // 2 GiB borrowed in RAM and none available: 2 GiB short.
    rig.available(0);
    assert_eq!(rig.levels().shortfall, 2 * GIB);
    rig.at(10);
    // Ending 1's programs gives the host 3 GiB, 2's only 2.
    let actions = rig.available(0);
    let [(1, free, keep, _)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (2 * GIB, 2 * GIB));
}

#[test]
fn what_is_on_its_way_back_is_not_asked_of_a_guest() {
    // 2.5 GiB short; an idle sandbox holding 1 GiB goes to sleep, so a
    // guest is asked for the other 1.5.
    let mut rig = short();
    rig.sleepable(3, GIB, 4 * GIB, GIB);
    let actions = rig.available(0);
    assert_eq!(sleeping(&actions), [3], "{actions:?}");
    let levels = rig.levels();
    assert_eq!((levels.relief, levels.shortfall), (GIB, GIB + 512 * MIB));
    rig.at(10);
    let actions = rig.available(0);
    let [(1, free, _, _)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!(free, GIB + 512 * MIB);
    // With 1 GiB available, 1.5 GiB short; one holding 3 GiB covers it
    // all, and with it what the two borrow: no guest is asked, and none
    // is held below what it holds.
    let mut rig = short();
    rig.sleepable(3, 3 * GIB, 4 * GIB, 3 * GIB);
    assert_eq!(sleeping(&rig.available(GIB)), [3]);
    let levels = rig.levels();
    assert!(!levels.short, "{levels:?}");
    assert_eq!(levels.busy, GIB);
    for second in 1..40 {
        rig.at(second);
        assert_eq!(shrinks(&rig.available(GIB)), [], "at {second} s");
        assert_eq!(rig.levels().over_bound, 0, "at {second} s");
    }
}

#[test]
fn a_host_with_the_rule_never_balloons_a_sandbox_in_use() {
    let mut rig = short();
    for second in 0..30 {
        rig.at(second);
        let actions = rig.available(0);
        assert!(
            !actions
                .iter()
                .any(|action| matches!(action, Action::Balloon { .. })),
            "at {second} s: {actions:?}"
        );
    }
}

#[test]
fn spares_wait_while_borrowers_are_held_back() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 3 * GIB, true);
    rig.available(40 * GIB);
    assert!(rig.host.spare_room().is_some_and(|room| room > 0));
    // 2 GiB below the low watermark: it is held back, and the room a new
    // spare would take is what it waits for.
    rig.at(1);
    rig.available(2 * GIB);
    assert_eq!(rig.levels().held_back, 1);
    assert_eq!(rig.host.spare_room(), Some(0));
}

#[test]
fn sandboxes_within_their_request_are_never_shrunk_or_ended_however_short_the_host() {
    let mut rig = Rig::new();
    rig.running(1, 4 * GIB, 16 * GIB, 3 * GIB, true);
    rig.running(2, 2 * GIB, 2 * GIB, 2 * GIB + 50 * MIB, true);
    for second in 0..30 {
        rig.at(second * 5);
        let actions = rig.available(0);
        assert!(shrinks(&actions).is_empty() && ended(&actions).is_empty());
        assert!(!sleeps(&actions), "{actions:?}");
    }
    assert!(rig.levels().short);
}

#[test]
fn a_sandbox_that_only_stalls_is_never_shrunk_or_ended() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 3 * GIB, true);
    // Stalled most of the time on its own compressed pages, with the host
    // above its low watermark: it slows nobody but itself. Its stall is
    // reported, and it runs on, never shrunk or ended.
    for second in 0..300 {
        rig.at(second);
        rig.uses(1, 3 * GIB, 2 * GIB, 6 * GIB, 900);
        let actions = rig.available(5 * GIB);
        assert_eq!(shrinks(&actions), [], "at {second} s");
        assert_eq!(ended(&actions), [], "at {second} s");
        assert!(!sleeps(&actions), "at {second} s");
    }
    assert_eq!(rig.level(1), Level::Running);
}

#[test]
fn a_step_that_pauses_or_resumes_a_vm_has_its_bounds_asked_again() {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 3 * GIB, false);
    let set = bounds(&rig.available(6 * GIB));
    assert_eq!(set, [(1, GIB, Some(5 * GIB))]);
    // A pause starts.
    let actions = rig.send(Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Paused,
    });
    let op = actions
        .iter()
        .find_map(|action| match action {
            Action::Start { op, step, .. } if *step == Step::Pause => Some(*op),
            _ => None,
        })
        .expect("a pause");
    // It is needed again, and its pause is given up before the next
    // reading: the engine set the VM's bounds back to its request and no
    // high.
    rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    let after = rig.send(Input::Finished {
        sandbox: SandboxId(1),
        op,
        outcome: compute_core::Outcome::Cancelled,
        wrote: false,
    });
    assert!(
        !after
            .iter()
            .any(|action| matches!(action, Action::Start { .. })),
        "no step is started again: {after:?}"
    );
    assert_eq!(rig.level(1), Level::Running);
    // Running with no step on it, the same bounds are asked again.
    rig.uses(1, 3 * GIB, 0, 0, 0);
    assert_eq!(bounds(&rig.available(6 * GIB)), set);
}

/// 1 borrows 5 GiB above its 1 GiB request in pages that do not compress;
/// 2 grows within its 4 GiB request. Once the host is 2 GiB below its low
/// watermark, 1's level falls to 3 GiB.
fn incompressible() -> Rig {
    let mut rig = Rig::new();
    rig.running(1, GIB, 16 * GIB, 6 * GIB, true);
    rig.running(2, 4 * GIB, 8 * GIB, 3 * GIB, true);
    assert_eq!(bounds(&rig.available(6 * GIB)), [(1, GIB, Some(8 * GIB))]);
    rig.at(1);
    rig.uses(2, 4 * GIB, 0, 0, 0);
    assert_eq!(
        bounds(&rig.available(2 * GIB)),
        [(1, GIB, Some(4 * GIB)), (2, 4 * GIB, Some(7 * GIB))]
    );
    rig
}

#[test]
fn a_sandbox_the_kernel_cannot_hold_to_its_bound_is_shrunk_by_what_it_holds_above() {
    let mut rig = incompressible();
    // The kernel could not compress it to its bound, and it never stalls,
    // since it allocates nothing more: the other one pays while the host
    // stays below its low watermark.
    for second in 2..12 {
        rig.at(second);
        rig.uses(1, 6 * GIB, 0, 0, 0);
        let actions = rig.available(2 * GIB);
        assert!(
            shrinks(&actions).is_empty(),
            "not before the hold: {actions:?}"
        );
        assert!(!rig.levels().short);
        assert_eq!(rig.levels().over_bound, 1);
    }
    // Its own readings stay as they were from here on: a reading of it
    // would be what decides.
    rig.at(12);
    let actions = rig.available(2 * GIB);
    // Its guest frees what it holds above its bound, never below its
    // request; the one within its request is never asked.
    let [(1, free, keep, request)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (2 * GIB, GIB));
    assert!(!sleeps(&actions));
    // It had nothing left to end: its VM is ended while it still costs
    // the others, once what its guest did had time to show.
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request,
        freed: 0,
        spent: true,
    });
    rig.at(21);
    assert!(
        ended(&rig.available(2 * GIB)).is_empty(),
        "it settles first"
    );
    rig.at(22);
    assert_eq!(ended(&rig.available(2 * GIB)), [1]);
    assert_eq!(rig.level(2), Level::Running);
}

#[test]
fn a_sandbox_back_within_its_bound_or_a_host_back_above_its_low_watermark_stops_the_hold() {
    let mut rig = incompressible();
    // Each reading: when, 1's resident size, compressed and swapped, what
    // is available, and whether 1 holds more than its last bound.
    let readings = [
        (2, 6 * GIB, 0, 0, 2 * GIB, 1),
        // The host has its low watermark again: the hold starts over, and
        // 1 may hold 6 GiB.
        (8, 6 * GIB, 0, 0, 5 * GIB, 0),
        // Below it again, but 1 is within that bound; it may hold 4 GiB.
        (9, 6 * GIB, 0, 0, 2 * GIB, 0),
        // The kernel compressed it to that, and then to the 3 GiB next.
        (10, 4 * GIB, GIB, 3 * GIB, 3 * GIB, 0),
        (13, 3 * GIB, GIB + GIB / 4, 4 * GIB, 3 * GIB + GIB / 2, 0),
    ];
    for (second, resident, compressed, swapped, available, over) in readings {
        rig.at(second);
        rig.uses(1, resident, compressed, swapped, 0);
        let actions = rig.available(available);
        assert_eq!(rig.levels().over_bound, over, "at {second} s");
        assert!(
            shrinks(&actions).is_empty() && ended(&actions).is_empty(),
            "at {second} s: {actions:?}"
        );
        assert!(!rig.levels().short, "at {second} s");
    }
}

#[test]
fn a_guest_asked_to_shrink_has_room_to_answer_and_is_bounded_again_after() {
    let mut rig = incompressible();
    for second in 2..12 {
        rig.at(second);
        rig.uses(1, 6 * GIB, 0, 0, 0);
        rig.available(2 * GIB);
    }
    rig.at(12);
    let actions = rig.available(2 * GIB);
    // Its high is lifted to what it holds and the least a shrink frees,
    // with the shrink: past its high its guest could not run to answer.
    assert_eq!(bounds(&actions), [(1, GIB, Some(6 * GIB + 256 * MIB))]);
    let [(1, _, _, request)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    // Until it answers it is not bounded again.
    rig.at(13);
    rig.uses(1, 6 * GIB + 200 * MIB, 0, 0, 0);
    assert_eq!(bounds(&rig.available(2 * GIB - 200 * MIB)), []);
    assert_eq!(rig.levels().over_bound, 0);
    rig.send(Input::Shrunk {
        sandbox: SandboxId(1),
        request,
        freed: 3 * GIB,
        spent: false,
    });
    // The first reading after its answer bounds it again.
    rig.at(14);
    rig.uses(1, 3 * GIB, 0, 0, 0);
    assert_eq!(bounds(&rig.available(5 * GIB)), [(1, GIB, Some(4 * GIB))]);
    rig.at(15);
    rig.uses(1, 3 * GIB, 0, 0, 0);
    assert_eq!(bounds(&rig.available(5 * GIB)), []);
}

#[test]
fn a_vm_the_kernel_holds_above_its_bound_is_bounded_again_once_it_comes_down() {
    let mut rig = incompressible();
    // The kernel could not compress it: its high stays at the 6 GiB it
    // holds, and bounding it again would change nothing.
    rig.at(2);
    rig.held(1, 6 * GIB, 0, 0, 0, Some(6 * GIB));
    assert_eq!(bounds(&rig.available(2 * GIB)), []);
    // It freed 3 GiB: bounded again, the high comes down to its bound.
    rig.at(3);
    rig.held(1, 3 * GIB, 0, 0, 0, Some(6 * GIB));
    assert_eq!(bounds(&rig.available(5 * GIB)), [(1, GIB, Some(4 * GIB))]);
    // Where it is now, there is nothing more to do.
    rig.at(4);
    rig.held(1, 3 * GIB, 0, 0, 0, Some(4 * GIB));
    assert_eq!(bounds(&rig.available(5 * GIB)), []);
}

#[test]
fn a_vm_the_kernel_is_bringing_down_is_not_over_its_bound_until_it_stops() {
    let mut rig = incompressible();
    // It comes down 128 MiB a reading, slowly but steadily, and what it
    // gives back is available: it is on its way to its 4 GiB bound.
    let mut resident = 6 * GIB;
    for second in 2..13 {
        rig.at(second);
        resident -= 128 * MIB;
        rig.uses(1, resident, 0, 0, 0);
        let actions = rig.available(2 * GIB + (6 * GIB - resident));
        assert_eq!(rig.levels().over_bound, 0, "at {second} s");
        assert_eq!(shrinks(&actions), [], "at {second} s");
    }
    // It stops 640 MiB above it: from then on the kernel cannot hold it,
    // and once that has lasted the hold its guest frees the rest.
    let available = 2 * GIB + (6 * GIB - resident);
    for second in 13..23 {
        rig.at(second);
        rig.uses(1, resident, 0, 0, 0);
        let actions = rig.available(available);
        assert_eq!(rig.levels().over_bound, 1, "at {second} s");
        assert_eq!(shrinks(&actions), [], "at {second} s");
    }
    // A reading of it would be what decides: the host reads first.
    rig.at(23);
    let actions = rig.available(available);
    let [(1, free, keep, _)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (640 * MIB, GIB));
}

#[test]
fn a_vm_the_engine_is_still_bringing_down_is_given_the_descent_before_it_counts_as_not_held() {
    let mut rig = incompressible();
    // The kernel ages its pages before it compresses any: for a minute
    // it does not come down, while the engine is still at work on it.
    // It is reported, never shrunk for it.
    for second in 2..62 {
        rig.at(second);
        let actions = rig.descending(1, 6 * GIB, 2 * GIB);
        assert_eq!(shrinks(&actions), [], "at {second} s");
        assert_eq!(rig.levels().over_bound, 0, "at {second} s");
        assert_eq!(rig.levels().bringing_down, 1, "at {second} s");
        assert_eq!(
            rig.host.next_deadline(),
            Some(At::from_duration(Duration::from_secs(62))),
            "at {second} s"
        );
    }
    // A minute without coming down a step: the kernel cannot hold it, and
    // its guest frees what it holds above its bound. Its own readings
    // stay as they were: a reading of it would be what decides.
    rig.at(62);
    let actions = rig.available(2 * GIB);
    assert_eq!(rig.levels().over_bound, 1);
    assert_eq!(rig.levels().bringing_down, 0);
    let [(1, free, keep, _)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (2 * GIB, GIB));
    assert!(!sleeps(&actions));
}

#[test]
fn a_vm_the_kernel_starts_to_compress_late_is_never_shrunk() {
    let mut rig = incompressible();
    // Twenty seconds of aging, twice the hold, then it comes down 256 MiB
    // a reading to its 4 GiB bound, and what it gives back is available.
    for second in 2..22 {
        rig.at(second);
        let actions = rig.descending(1, 6 * GIB, 2 * GIB);
        assert_eq!(shrinks(&actions), [], "at {second} s");
    }
    let mut resident = 6 * GIB;
    for second in 22..30 {
        rig.at(second);
        resident -= 256 * MIB;
        let actions = rig.descending(1, resident, 2 * GIB + (6 * GIB - resident));
        assert_eq!(shrinks(&actions), [], "at {second} s");
        assert_eq!(rig.levels().over_bound, 0, "at {second} s");
        assert_eq!(rig.levels().bringing_down, 0, "at {second} s");
    }
    // At its bound the engine is done, and nothing is asked of it.
    for second in 30..50 {
        rig.at(second);
        rig.uses(1, 4 * GIB, 0, 0, 0);
        let actions = rig.available(4 * GIB);
        assert!(
            shrinks(&actions).is_empty() && ended(&actions).is_empty(),
            "at {second} s: {actions:?}"
        );
        assert_eq!(rig.levels().over_bound, 0, "at {second} s");
    }
}

#[test]
fn a_vm_the_engine_brought_down_as_far_as_the_kernel_takes_is_shrunk_once_the_hold_has_passed() {
    let mut rig = incompressible();
    for second in 2..20 {
        rig.at(second);
        let actions = rig.descending(1, 6 * GIB, 2 * GIB);
        assert_eq!(shrinks(&actions), [], "at {second} s");
    }
    // The engine gives up above the bound: the kernel takes no more. It
    // has not come down for longer than the hold, so its guest is asked
    // at once.
    rig.at(20);
    let actions = rig.read(1, 6 * GIB, 0, 0, 0, None, false);
    let [(1, free, keep, _)] = shrinks(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!((free, keep), (2 * GIB, GIB));
}
