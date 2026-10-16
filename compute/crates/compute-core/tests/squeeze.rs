//! Relief from sandboxes in use above their request once idle ones have
//! nothing left to give: balloons first, then pausing and saving the one
//! furthest above its request, which wakes by itself once there is room.
//! A sandbox within its request is never touched.

use std::time::Duration;

use compute_core::{
    Action, At, Durability, HoldId, Host, HostPolicy, Input, Level, MemoryPolicy, Notice, OpId,
    Outcome, Priority, SandboxId, Size, SleepPolicy, SleepRules, State, Step,
};

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    /// Relief starts below 4 GiB available and aims for 5 GiB.
    fn new() -> Self {
        let policy = HostPolicy {
            memory: Some(MemoryPolicy {
                low_watermark: 4 * GIB,
                high_watermark: 5 * GIB,
                compressed_percent: 30,
                balloon_grace: Duration::from_secs(2),
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

    /// A running sandbox, held awake, whose VM holds `resident` bytes.
    fn running(&mut self, id: u128, size: Size, resident: u64) {
        let sandbox = SandboxId(id);
        self.send(Input::Add {
            sandbox,
            state: State::new(Level::Running, Durability::Volatile, true),
            policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
            size,
        });
        self.send(Input::Hold {
            sandbox,
            hold: HoldId(1),
            until: None,
            priority: Priority::Interactive,
        });
        self.resident(id, resident);
    }

    fn resident(&mut self, id: u128, bytes: u64) -> Vec<Action> {
        self.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes,
        })
    }

    fn available(&mut self, bytes: u64) -> Vec<Action> {
        self.send(Input::Memory { available: bytes })
    }

    fn at(&mut self, secs: u64) {
        self.now = At::from_duration(Duration::from_secs(secs));
    }

    /// Finishes every step started in `actions` for `id`, and those that
    /// follow, until none starts; returns everything that came out.
    fn settle(&mut self, id: u128, mut actions: Vec<Action>) -> Vec<Action> {
        let mut all = actions.clone();
        for _ in 0..10 {
            let Some(op) = started(&actions, id).first().map(|(_, op)| *op) else {
                return all;
            };
            actions = self.send(Input::Finished {
                sandbox: SandboxId(id),
                op,
                outcome: Outcome::Done,
            });
            all.extend(actions.iter().copied());
        }
        panic!("{id} never settled");
    }

    fn level(&self, id: u128) -> Level {
        self.host.sandbox(SandboxId(id)).unwrap().state.level
    }

    fn paused_for_memory(&self, id: u128) -> bool {
        self.host
            .sandbox(SandboxId(id))
            .unwrap()
            .paused_for_memory
            .is_some()
    }

    /// The VMs take every balloon setting asked in `actions`.
    fn confirm(&mut self, actions: &[Action]) {
        for (id, bytes) in balloons(actions) {
            self.send(Input::BalloonSet {
                sandbox: SandboxId(id),
                bytes,
            });
        }
    }
}

fn started(actions: &[Action], id: u128) -> Vec<(Step, OpId)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Start { sandbox, op, step } if sandbox.0 == id => Some((*step, *op)),
            _ => None,
        })
        .collect()
}

fn balloons(actions: &[Action]) -> Vec<(u128, u64)> {
    let mut set: Vec<(u128, u64)> = actions
        .iter()
        .filter_map(|action| match action {
            Action::Balloon { sandbox, bytes } => Some((sandbox.0, *bytes)),
            _ => None,
        })
        .collect();
    set.sort_unstable();
    set
}

fn size(request: u64, limit: u64) -> Size {
    Size {
        request,
        limit,
        save: limit,
    }
}

/// Two held sandboxes above their 1 GiB requests, and one held within its
/// request (all of its 4 GiB).
fn three_busy() -> Rig {
    let mut rig = Rig::new();
    rig.running(1, size(GIB, 4 * GIB), 3 * GIB);
    rig.running(2, size(GIB, 4 * GIB), 2 * GIB);
    rig.running(3, Size::whole(4 * GIB), 4 * GIB + 50 * MIB);
    rig
}

#[test]
fn busy_sandboxes_above_their_request_give_memory_back_through_balloons_first() {
    let mut rig = three_busy();
    // 2.5 GiB short of the high watermark: it takes what both 1 and 2 hold
    // above their requests.
    let actions = rig.available(2 * GIB + 512 * MIB);
    assert_eq!(balloons(&actions), [(1, 3 * GIB), (2, 3 * GIB)]);
    assert!(started(&actions, 1).is_empty() && started(&actions, 2).is_empty());
    assert_eq!(rig.host.sandbox(SandboxId(1)).unwrap().balloon, 3 * GIB);
    // Within the grace the balloons count as on their way.
    rig.at(1);
    let actions = rig.available(3 * GIB + 512 * MIB);
    assert!(actions.is_empty(), "{actions:?}");
    // Room comes back with the balloons set; each goes once its guest
    // could take back all it gave with the high watermark still free.
    rig.at(3);
    assert_eq!(rig.available(6 * GIB + 512 * MIB), []);
    assert_eq!(balloons(&rig.available(8 * GIB)), [(1, 0), (2, 0)]);
    // Never anything for the sandbox within its request.
    assert_eq!(rig.host.sandbox(SandboxId(3)).unwrap().balloon, 0);
    assert!(!rig.paused_for_memory(3));
}

#[test]
fn the_sandbox_furthest_above_its_request_is_paused_and_saved_when_balloons_are_not_enough() {
    let mut rig = three_busy();
    rig.available(3 * GIB);
    // The guests gave less than hoped, and then the grace is over.
    rig.at(1);
    rig.resident(1, 2 * GIB + 512 * MIB);
    rig.resident(2, GIB + 768 * MIB);
    rig.at(3);
    let actions = rig.available(3 * GIB + 512 * MIB);
    // 1.5 GiB short: pausing 1, furthest above its request, frees its
    // 2.5 GiB, held or not.
    assert_eq!(started(&actions, 1)[0].0, Step::Pause);
    assert!(started(&actions, 2).is_empty() && started(&actions, 3).is_empty());
    assert!(rig.paused_for_memory(1));
    // Wanting it awake does not stop it.
    let touched = rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    assert!(
        !touched
            .iter()
            .any(|action| matches!(action, Action::Cancel { .. }))
    );
    let all = rig.settle(1, actions);
    assert_eq!(rig.level(1), Level::Saved);
    assert!(
        !started(&all, 1).iter().any(|(step, _)| step.wakes()),
        "it stays saved while the host is short: {all:?}"
    );
    assert!(rig.paused_for_memory(1));
    assert!(rig.host.waits_for_room(SandboxId(1)));
    // Room for the 2.5 GiB it held, above the high watermark: it wakes by
    // itself.
    rig.at(4);
    let actions = rig.available(7 * GIB);
    assert!(started(&actions, 1).is_empty(), "not yet: {actions:?}");
    let actions = rig.available(7 * GIB + 512 * MIB);
    assert_eq!(started(&actions, 1)[0].0, Step::Restore);
    rig.settle(1, actions);
    assert_eq!(rig.level(1), Level::Running);
    assert!(!rig.paused_for_memory(1));
}

#[test]
fn sandboxes_within_their_request_are_never_squeezed() {
    let mut rig = Rig::new();
    rig.running(1, Size::whole(4 * GIB), 4 * GIB + 50 * MIB);
    rig.running(2, Size::whole(2 * GIB), 2 * GIB);
    for second in 0..10 {
        rig.at(second * 3);
        let actions = rig.available(GIB);
        assert!(actions.is_empty(), "{actions:?}");
    }
    assert_eq!(rig.level(1), Level::Running);
    assert_eq!(rig.level(2), Level::Running);
}

#[test]
fn idle_sandboxes_go_before_busy_ones_are_squeezed() {
    let mut rig = three_busy();
    // An idle paused sandbox already saved: ending it frees 2 GiB.
    let idle = SandboxId(4);
    rig.send(Input::Add {
        sandbox: idle,
        state: State::new(Level::Paused, Durability::Local, true),
        policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
        size: Size::whole(4 * GIB),
    });
    rig.resident(4, 2 * GIB);
    rig.at(10);
    let actions = rig.available(3 * GIB + 512 * MIB);
    assert_eq!(started(&actions, 4)[0].0, Step::Drop);
    assert!(balloons(&actions).is_empty(), "{actions:?}");
    assert!(!rig.paused_for_memory(1) && !rig.paused_for_memory(2));
}

fn host_full(actions: &[Action], id: u128) -> bool {
    actions.iter().any(|action| {
        matches!(action, Action::Notify { sandbox, notice: Notice::HostFull { .. } }
            if sandbox.0 == id)
    })
}

#[test]
fn sandboxes_paused_for_memory_wake_one_at_a_time_as_room_returns() {
    let mut rig = Rig::new();
    rig.running(1, size(GIB, 8 * GIB), 3 * GIB);
    rig.running(2, size(GIB, 8 * GIB), 3 * GIB);
    // Nothing free: both balloons, and one is paused; once the grace is
    // over and the guests gave nothing, the other too.
    let actions = rig.available(0);
    assert_eq!(started(&actions, 2)[0].0, Step::Pause);
    rig.settle(2, actions);
    rig.at(3);
    let actions = rig.available(0);
    assert_eq!(started(&actions, 1)[0].0, Step::Pause);
    rig.settle(1, actions);
    assert_eq!((rig.level(1), rig.level(2)), (Level::Saved, Level::Saved));
    // Asking for one while the host is short tells at once that it waits.
    let touched = rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    assert!(host_full(&touched, 1), "{touched:?}");
    assert_eq!(started(&touched, 1), []);
    assert!(rig.paused_for_memory(1));
    // Room for one of the two 3 GiB VMs above the high watermark: only one
    // wakes, and the other waits until a reading shows it.
    rig.at(4);
    let actions = rig.available(8 * GIB);
    let waking: Vec<u128> = [1, 2]
        .into_iter()
        .filter(|id| !started(&actions, *id).is_empty())
        .collect();
    let [first] = waking[..] else {
        panic!("{actions:?}");
    };
    let second = 3 - first;
    let all = rig.settle(first, actions);
    assert_eq!(rig.level(first), Level::Running);
    let actions = rig.available(8 * GIB);
    assert!(started(&actions, second).is_empty(), "{actions:?}");
    // Measured running, with its balloon let go, the first's memory shows
    // in readings.
    rig.confirm(&all);
    rig.resident(first, 3 * GIB);
    let actions = rig.available(8 * GIB);
    assert_eq!(started(&actions, second)[0].0, Step::Restore);
}

#[test]
fn a_balloon_let_go_and_a_wake_never_share_the_same_room() {
    let mut rig = Rig::new();
    rig.running(1, size(GIB, 8 * GIB), 3 * GIB);
    rig.running(2, size(GIB, 8 * GIB), 4 * GIB);
    // Both balloons, then, with the guests giving nothing, 2 is paused and
    // saved while 1 keeps its balloon.
    assert_eq!(balloons(&rig.available(0)), [(1, 7 * GIB), (2, 7 * GIB)]);
    rig.at(3);
    let actions = rig.available(3 * GIB);
    assert_eq!(started(&actions, 2)[0].0, Step::Pause);
    assert!(started(&actions, 1).is_empty(), "{actions:?}");
    rig.settle(2, actions);
    assert!(rig.host.waits_for_room(SandboxId(2)));
    // 4 GiB above the high watermark: room for 2's 4 GiB, or for the
    // 2 GiB 1's guest may take back, not both.
    rig.at(4);
    let actions = rig.available(9 * GIB);
    let released = balloons(&actions).contains(&(1, 0));
    let woke = !started(&actions, 2).is_empty();
    assert!(released != woke, "{actions:?}");
    // A reading taken once it has taken its room lets the other through:
    // for a balloon, only after its VM confirmed letting it go.
    if woke {
        let all = rig.settle(2, actions);
        rig.confirm(&all);
        rig.resident(2, 4 * GIB);
        assert!(balloons(&rig.available(9 * GIB)).contains(&(1, 0)));
    } else {
        // The VM did not take it: its guest may still take its room back,
        // and the claim stays through the backoff.
        rig.send(Input::BalloonFailed {
            sandbox: SandboxId(1),
            bytes: 0,
        });
        assert_eq!(started(&rig.available(9 * GIB), 2), []);
        rig.now = rig.host.next_deadline().unwrap();
        let retried = rig.send(Input::Tick);
        assert_eq!(balloons(&retried), [(1, 0)]);
        assert_eq!(started(&rig.available(9 * GIB), 2), []);
        rig.confirm(&retried);
        assert_eq!(started(&rig.available(9 * GIB), 2)[0].0, Step::Restore);
    }
}

#[test]
fn a_balloon_let_go_keeps_its_room_until_its_vm_has_let_it_go() {
    let mut rig = Rig::new();
    rig.running(1, size(GIB, 8 * GIB), 3 * GIB);
    rig.running(2, size(GIB, 8 * GIB), 4 * GIB);
    rig.available(0);
    rig.at(3);
    let actions = rig.available(3 * GIB);
    rig.settle(2, actions);
    assert!(rig.host.waits_for_room(SandboxId(2)));
    // 2 GiB above the high watermark: room for the 2 GiB 1's guest may
    // take back, not for 2's 4 GiB.
    rig.at(4);
    let actions = rig.available(7 * GIB);
    assert_eq!(balloons(&actions), [(1, 0)]);
    assert_eq!(started(&actions, 2), []);
    // The VM did not take it. Later readings show room for 2 only if 1's
    // guest takes nothing back, which it still may: 2 waits.
    rig.send(Input::BalloonFailed {
        sandbox: SandboxId(1),
        bytes: 0,
    });
    for _ in 0..3 {
        assert_eq!(started(&rig.available(9 * GIB), 2), []);
    }
    rig.now = rig.host.next_deadline().unwrap();
    let retried = rig.send(Input::Tick);
    assert_eq!(balloons(&retried), [(1, 0)]);
    assert_eq!(started(&rig.available(9 * GIB), 2), []);
    // Taken: the next reading shows what 1 holds, and 2 wakes.
    rig.confirm(&retried);
    assert_eq!(started(&rig.available(9 * GIB), 2)[0].0, Step::Restore);
}

#[test]
fn a_balloon_the_vm_did_not_take_is_set_again_after_a_backoff() {
    let mut rig = Rig::new();
    let sandbox = SandboxId(1);
    // Found running: its balloon is let go, in case it was left set.
    let actions = rig.send(Input::Add {
        sandbox,
        state: State::new(Level::Running, Durability::Volatile, true),
        policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
        size: size(GIB, 4 * GIB),
    });
    assert_eq!(balloons(&actions), [(1, 0)]);
    rig.send(Input::Hold {
        sandbox,
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    // An older setting failing changes nothing.
    assert_eq!(
        rig.send(Input::BalloonFailed {
            sandbox,
            bytes: GIB
        }),
        []
    );
    // This one failing: not at once, but after a backoff, and longer after
    // each failure.
    let mut waited = Duration::ZERO;
    let mut first = None;
    for _ in 0..3 {
        let actions = rig.send(Input::BalloonFailed { sandbox, bytes: 0 });
        assert_eq!(balloons(&actions), []);
        let failed = rig.now;
        let due = rig.host.next_deadline().unwrap();
        assert!(due.saturating_since(failed) > waited);
        waited = due.saturating_since(failed);
        first.get_or_insert(waited);
        rig.now = due;
        assert_eq!(balloons(&rig.send(Input::Tick)), [(1, 0)]);
    }
    // A confirmation of another setting changes nothing: the next failure
    // waits longer still.
    rig.send(Input::BalloonSet {
        sandbox,
        bytes: GIB,
    });
    rig.send(Input::BalloonFailed { sandbox, bytes: 0 });
    let due = rig.host.next_deadline().unwrap();
    assert!(due.saturating_since(rig.now) > waited);
    rig.now = due;
    assert_eq!(balloons(&rig.send(Input::Tick)), [(1, 0)]);
    // Once the VM takes it, failures before are forgotten: a failure after
    // waits the first backoff again.
    rig.send(Input::BalloonSet { sandbox, bytes: 0 });
    rig.send(Input::BalloonFailed { sandbox, bytes: 0 });
    let due = rig.host.next_deadline().unwrap();
    assert_eq!(Some(due.saturating_since(rig.now)), first);
}
