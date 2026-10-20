//! The processor budget: every sandbox awake or waking reserves its CPU
//! request from it, a sleeping one reserves none, and a wake that does not
//! fit is refused at once, since nothing frees processor time instantly.
//! A held wake refused for it wakes by itself once another sandbox sleeps.

use std::time::Duration;

use compute_core::{
    Action, Admission, At, CpuCapacity, DiskSpace, Durability, HoldId, Host, HostPolicy, Input,
    Level, Notice, OpId, Outcome, Priority, Resource, SandboxId, Size, SleepPolicy, SleepRules,
    State, Step,
};

const GIB: u64 = 1 << 30;
/// A spare VM, such as a template build or a ready sandbox.
const SPARE: SandboxId = SandboxId(900);

fn saved() -> State {
    State::new(Level::Saved, Durability::Local, true)
}

fn paused_saved() -> State {
    State::new(Level::Paused, Durability::Local, true)
}

/// A sandbox of 1 GiB guaranteed `millis` of processor time.
fn size(millis: u64) -> Size {
    Size::whole(GIB).with_cpu(millis)
}

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    fn new(millis: u64) -> Self {
        Self::with(HostPolicy {
            cpu_budget: Some(millis),
            ..HostPolicy::default()
        })
    }

    fn with(policy: HostPolicy) -> Self {
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

    fn add(&mut self, id: u128, state: State, size: Size) -> Vec<Action> {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
            size,
            last_activity: self.now,
        })
    }

    fn touch(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Touch {
            sandbox: SandboxId(id),
            priority: Priority::Interactive,
        })
    }

    /// Books the spare VM: `filling` with `cpu` millicores, or ready.
    fn spare(&mut self, filling: bool, cpu: u64) -> Vec<Action> {
        self.send(Input::Spare {
            sandbox: SPARE,
            bytes: GIB,
            disk: DiskSpace::default(),
            filling,
            cpu,
        })
    }

    fn spare_fits(&self, cpu: u64) -> bool {
        self.host.spare_fits(GIB, DiskSpace::default(), cpu)
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
            wrote: true,
        })
    }

    fn at(&mut self, secs: u64) {
        self.now = At::from_duration(Duration::from_secs(secs));
    }

    fn level(&self, id: u128) -> Level {
        self.host.sandbox(SandboxId(id)).unwrap().state.level
    }

    fn cpu(&self) -> CpuCapacity {
        self.host.cpu_capacity().unwrap()
    }

    /// Finishes every step `actions` start, and those they lead to, until
    /// one starts for `until`; returns that one's step and op.
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

    /// Wakes `id`, held, all the way to running.
    fn hold_awake(&mut self, id: u128) {
        let actions = self.hold(id);
        let (_, op) = self.drive_until(actions, id);
        self.finish(id, op);
        assert_eq!(self.level(id), Level::Running);
    }

    /// Finishes every step `actions` start and those they lead to.
    fn settle(&mut self, mut actions: Vec<Action>) -> Vec<Action> {
        let mut all = Vec::new();
        while !started(&actions).is_empty() {
            let mut next = Vec::new();
            for (id, _, op) in started(&actions) {
                next.extend(self.finish(id, op));
            }
            all.append(&mut actions);
            actions = next;
        }
        all.append(&mut actions);
        all
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

fn host_full(actions: &[Action], id: u128) -> Option<(Resource, u64, u64)> {
    actions.iter().find_map(|action| match action {
        Action::Notify {
            sandbox,
            notice:
                Notice::HostFull {
                    resource,
                    needed,
                    free,
                },
        } if sandbox.0 == id => Some((*resource, *needed, *free)),
        _ => None,
    })
}

#[test]
fn a_wake_beyond_the_processor_budget_is_refused_at_once_with_what_it_needs() {
    let mut rig = Rig::new(1000);
    for id in 1..=3 {
        rig.add(id, saved(), size(400));
    }
    rig.hold_awake(1);
    rig.hold_awake(2);
    assert_eq!(
        rig.cpu(),
        CpuCapacity {
            budget: 1000,
            reserved: 800
        }
    );
    let actions = rig.touch(3);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 3), Some((Resource::Cpu, 400, 200)));
    assert_eq!(rig.level(3), Level::Saved);
    assert_eq!(rig.cpu().free(), 200);
    // One that fits still wakes.
    rig.add(4, saved(), size(200));
    let actions = rig.touch(4);
    assert!(matches!(started(&actions)[..], [(4, Step::Restore, _)]));
    assert_eq!(rig.cpu().free(), 0);
}

#[test]
fn waking_reserves_as_much_as_running_and_sleeping_none() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(600));
    assert_eq!(rig.cpu().reserved, 0, "a saved sandbox reserves nothing");
    let actions = rig.touch(1);
    let [(1, Step::Restore, op)] = started(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!(rig.cpu().reserved, 600, "waking");
    rig.finish(1, op);
    assert_eq!(rig.cpu().reserved, 600, "running");
    // Idle past its pause rule: it pauses, and reserves nothing paused.
    rig.at(11);
    let actions = rig.send(Input::Tick);
    let [(1, Step::Pause, op)] = started(&actions)[..] else {
        panic!("{actions:?}");
    };
    rig.finish(1, op);
    assert_eq!(rig.level(1), Level::Paused);
    assert_eq!(rig.cpu().reserved, 0);
    // A paused sandbox fits again on resuming.
    let actions = rig.touch(1);
    assert!(matches!(started(&actions)[..], [(1, Step::Resume, _)]));
    assert_eq!(rig.cpu().reserved, 600);
}

#[test]
fn a_held_wake_refused_for_processor_time_wakes_once_another_sleeps() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(600));
    rig.add(2, saved(), size(600));
    rig.hold_awake(1);
    let actions = rig.hold(2);
    assert_eq!(host_full(&actions, 2), Some((Resource::Cpu, 600, 400)));
    assert!(rig.host.waits_for_room(SandboxId(2)));
    // Nothing changes while 1 stays awake.
    rig.at(100);
    assert_eq!(started(&rig.send(Input::Tick)), []);
    // Let go, 1 pauses once idle; then 2 wakes by itself.
    rig.release(1);
    rig.at(120);
    let actions = rig.send(Input::Tick);
    let (step, op) = rig.drive_until(actions, 2);
    assert_eq!(step, Step::Restore);
    assert_ne!(rig.level(1), Level::Running);
    rig.finish(2, op);
    assert_eq!(rig.level(2), Level::Running);
    assert_eq!(rig.cpu().reserved, 600);
    assert!(!rig.host.waits_for_room(SandboxId(2)));
}

#[test]
fn a_removed_sandbox_keeps_its_processor_time_until_its_vm_ends() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(600));
    rig.add(2, saved(), size(600));
    rig.hold_awake(1);
    rig.send(Input::Remove {
        sandbox: SandboxId(1),
    });
    assert_eq!(rig.cpu().reserved, 600, "its VM may still run");
    let actions = rig.touch(2);
    assert_eq!(host_full(&actions, 2), Some((Resource::Cpu, 600, 400)));
    rig.send(Input::Unmanaged {
        sandbox: SandboxId(1),
        bytes: 0,
        cpu: 0,
    });
    assert_eq!(rig.cpu().reserved, 0);
    let actions = rig.touch(2);
    assert!(matches!(started(&actions)[..], [(2, Step::Restore, _)]));
}

#[test]
fn a_removed_sleeping_sandbox_reserves_nothing() {
    let mut rig = Rig::new(1000);
    rig.add(1, paused_saved(), size(600));
    rig.send(Input::Remove {
        sandbox: SandboxId(1),
    });
    assert_eq!(rig.cpu().reserved, 0);
}

#[test]
fn a_vm_not_managed_here_reserves_what_it_was_given() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(400));
    rig.send(Input::Unmanaged {
        sandbox: SandboxId(9),
        bytes: GIB,
        cpu: 700,
    });
    assert_eq!(rig.cpu().reserved, 700);
    let actions = rig.touch(1);
    assert_eq!(host_full(&actions, 1), Some((Resource::Cpu, 400, 300)));
    // A paused one reserves nothing.
    rig.send(Input::Unmanaged {
        sandbox: SandboxId(9),
        bytes: GIB,
        cpu: 0,
    });
    assert_eq!(rig.cpu().reserved, 0);
    rig.send(Input::Unmanaged {
        sandbox: SandboxId(9),
        bytes: 0,
        cpu: 0,
    });
    let actions = rig.touch(1);
    assert!(matches!(started(&actions)[..], [(1, Step::Restore, _)]));
}

#[test]
fn an_overdrawn_budget_admits_no_wake_until_enough_sleeps() {
    // As after a restart onto fewer processors: two found running already
    // reserve more than there is.
    let mut rig = Rig::new(1000);
    rig.add(1, State::RUNNING, size(800));
    rig.add(2, State::RUNNING, size(800));
    rig.add(3, saved(), size(100));
    assert_eq!(rig.cpu().free(), 0);
    let actions = rig.touch(3);
    assert_eq!(host_full(&actions, 3), Some((Resource::Cpu, 700, 0)));
    // Both pause once idle; then it fits.
    rig.at(11);
    let actions = rig.send(Input::Tick);
    rig.settle(actions);
    assert_eq!(rig.cpu().reserved, 0);
    let actions = rig.touch(3);
    assert!(matches!(started(&actions)[..], [(3, Step::Restore, _)]));
}

#[test]
fn a_wake_short_of_processor_time_ends_no_idle_vm_for_memory() {
    let mut rig = Rig::with(HostPolicy {
        cpu_budget: Some(1000),
        admission: Some(Admission {
            budget: 2 * GIB,
            buffer: 0,
            busy_grace: Duration::from_secs(2),
        }),
        ..HostPolicy::default()
    });
    rig.add(1, paused_saved(), size(0));
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    rig.add(2, saved(), size(800));
    rig.add(3, saved(), size(400));
    rig.hold_awake(2);
    rig.at(5);
    // 3 would need 1 ended for memory, but has no processor time anyway.
    let actions = rig.touch(3);
    assert_eq!(host_full(&actions, 3), Some((Resource::Cpu, 400, 200)));
    assert_eq!(started(&actions), [], "nothing ends for it");
    assert_eq!(rig.level(1), Level::Paused);
}

#[test]
fn a_wake_refused_for_memory_gives_its_processor_time_back() {
    let mut rig = Rig::with(HostPolicy {
        cpu_budget: Some(1000),
        admission: Some(Admission {
            budget: 4 * GIB,
            buffer: 0,
            busy_grace: Duration::from_secs(2),
        }),
        ..HostPolicy::default()
    });
    rig.add(1, saved(), Size::whole(GIB).with_cpu(100));
    rig.add(2, saved(), Size::whole(4 * GIB).with_cpu(500));
    rig.add(3, saved(), Size::whole(GIB).with_cpu(500));
    rig.hold_awake(1);
    // Both decided at once, 2 first: it does not fit in memory, so the
    // processor time it was charged is there for 3 again.
    let mut actions = Vec::new();
    let touch = |id| Input::Touch {
        sandbox: SandboxId(id),
        priority: Priority::Interactive,
    };
    rig.host
        .handle_all(rig.now, [touch(2), touch(3)], &mut actions);
    assert_eq!(
        host_full(&actions, 2).map(|(resource, ..)| resource),
        Some(Resource::Memory)
    );
    assert!(
        matches!(started(&actions)[..], [(3, Step::Restore, _)]),
        "{actions:?}"
    );
    assert_eq!(rig.cpu().reserved, 600);
}

#[test]
fn a_spare_vm_coming_up_books_its_processor_time_until_it_is_ready() {
    let mut rig = Rig::new(1000);
    assert!(rig.spare_fits(1000));
    assert!(!rig.spare_fits(1010), "more than the budget");
    // Its guest runs while it comes up.
    rig.spare(true, 600);
    assert_eq!(rig.cpu().reserved, 600);
    assert!(!rig.spare_fits(600), "only 400 left");
    rig.add(1, saved(), size(600));
    let actions = rig.touch(1);
    assert_eq!(host_full(&actions, 1), Some((Resource::Cpu, 600, 400)));
    // Ready, so paused: it books none.
    rig.spare(false, 0);
    assert_eq!(rig.cpu().reserved, 0);
    let actions = rig.touch(1);
    assert!(matches!(started(&actions)[..], [(1, Step::Restore, _)]));
}

#[test]
fn a_spare_vm_that_ends_while_coming_up_gives_its_processor_time_back() {
    let mut rig = Rig::new(1000);
    rig.spare(true, 600);
    rig.send(Input::Spare {
        sandbox: SPARE,
        bytes: 0,
        disk: DiskSpace::default(),
        filling: false,
        cpu: 0,
    });
    assert_eq!(rig.cpu().reserved, 0);
}

#[test]
fn no_spare_vm_starts_while_a_wake_waits_for_processor_time() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(600));
    rig.add(2, saved(), size(600));
    rig.hold_awake(1);
    rig.hold(2);
    assert!(rig.host.waits_for_room(SandboxId(2)));
    assert!(!rig.spare_fits(10), "the 400 left are the waiting wake's");
    rig.release(2);
    assert!(rig.spare_fits(400));
}

#[test]
fn a_spare_vm_that_could_not_be_ended_while_coming_up_keeps_its_processor_time() {
    let mut rig = Rig::new(1000);
    rig.spare(true, 600);
    // Its guest may still run, whatever the agent last saw of it.
    rig.send(Input::Unmanaged {
        sandbox: SPARE,
        bytes: GIB,
        cpu: 0,
    });
    assert_eq!(rig.cpu().reserved, 600);
    rig.add(1, saved(), size(600));
    let actions = rig.touch(1);
    assert_eq!(host_full(&actions, 1), Some((Resource::Cpu, 600, 400)));
    // Gone: nothing booked.
    rig.send(Input::Unmanaged {
        sandbox: SPARE,
        bytes: 0,
        cpu: 0,
    });
    assert_eq!(rig.cpu().reserved, 0);
}

#[test]
fn a_smaller_budget_admits_no_wake_until_it_fits_and_a_larger_one_lets_held_wakes_in() {
    let mut rig = Rig::new(1000);
    rig.add(1, saved(), size(600));
    rig.add(2, saved(), size(300));
    rig.hold_awake(1);
    // What else runs on the host now takes more than it kept back.
    rig.send(Input::CpuBudget { millis: 500 });
    assert_eq!(
        rig.cpu(),
        CpuCapacity {
            budget: 500,
            reserved: 600
        }
    );
    assert_eq!(rig.level(1), Level::Running, "an awake sandbox stays awake");
    let actions = rig.hold(2);
    assert!(host_full(&actions, 2).is_some_and(|(resource, ..)| resource == Resource::Cpu));
    assert!(rig.host.waits_for_room(SandboxId(2)));
    // Over: the held wake goes in by itself.
    let actions = rig.send(Input::CpuBudget { millis: 1000 });
    assert!(
        matches!(started(&actions)[..], [(2, Step::Restore, _)]),
        "{actions:?}"
    );
    // None left: no wake is admitted, and none is made up.
    rig.send(Input::CpuBudget { millis: 0 });
    assert_eq!(rig.cpu().budget, 0);
    assert_eq!(rig.level(1), Level::Running, "an awake sandbox stays awake");
    rig.add(3, saved(), size(10));
    let actions = rig.hold(3);
    assert_eq!(
        host_full(&actions, 3).map(|(resource, ..)| resource),
        Some(Resource::Cpu)
    );
    // Nothing to change without a budget.
    let mut unbudgeted = Rig::with(HostPolicy::default());
    unbudgeted.send(Input::CpuBudget { millis: 500 });
    assert_eq!(unbudgeted.host.cpu_capacity(), None);
}
