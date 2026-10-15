//! Hand-written scenarios for the host decision core.

use std::time::Duration;

use compute_core::{
    Action, At, Failure, HoldId, Host, HostPolicy, Input, Level, MemoryPolicy, Notice, OpId,
    Outcome, Priority, SandboxId, SleepPolicy, Step, StepLimits,
};

const GIB: u64 = 1 << 30;

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

fn full_ladder() -> SleepPolicy {
    SleepPolicy::new([
        (Level::Paused, secs(30)),
        (Level::Compressed, secs(120)),
        (Level::Saved, secs(900)),
        (Level::Archived, secs(3600)),
        (Level::Remote, secs(86_400)),
    ])
    .unwrap()
}

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    fn new(policy: HostPolicy) -> Self {
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

    fn at(&mut self, at: Duration) -> &mut Self {
        self.now = At::from_duration(at);
        self
    }

    fn add(
        &mut self,
        id: u128,
        level: Level,
        memory_saved: bool,
        policy: SleepPolicy,
    ) -> Vec<Action> {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            level,
            memory_saved,
            policy,
        })
    }

    fn finish(&mut self, id: u128, op: OpId, outcome: Outcome) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome,
        })
    }

    fn tick_at_deadline(&mut self) -> Vec<Action> {
        self.now = self.host.next_deadline().expect("a deadline");
        self.send(Input::Tick)
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

fn only_start(actions: &[Action]) -> (Step, OpId) {
    let starts = started(actions);
    assert_eq!(starts.len(), 1, "expected exactly one start in {actions:?}");
    (starts[0].1, starts[0].2)
}

#[test]
fn idle_sandbox_walks_down_the_ladder_on_schedule() {
    let mut rig = Rig::new(HostPolicy::default());
    assert!(rig.add(1, Level::Running, false, full_ladder()).is_empty());
    let expected = [
        (Step::Pause, 30),
        (Step::Compress, 120),
        (Step::Save, 900),
        (Step::Archive, 3600),
        (Step::Evict, 86_400),
    ];
    for (step, at) in expected {
        let actions = rig.tick_at_deadline();
        assert_eq!(rig.now, At::from_duration(secs(at)));
        let (started_step, op) = only_start(&actions);
        assert_eq!(started_step, step);
        let done = rig.finish(1, op, Outcome::Done);
        assert!(done.contains(&Action::Notify {
            sandbox: SandboxId(1),
            notice: Notice::Level {
                level: step.target(),
                memory_saved: step >= Step::Save
            },
        }));
    }
    assert_eq!(rig.host.sandbox(SandboxId(1)).unwrap().level, Level::Remote);
    assert_eq!(rig.host.next_deadline(), None);
}

#[test]
fn touch_cancels_a_sleep_step_in_flight() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, full_ladder());
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Pause);
    rig.at(secs(31));
    let actions = rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    assert_eq!(
        actions,
        vec![Action::Cancel {
            sandbox: SandboxId(1),
            op
        }]
    );
    // Cancelled in time: still running, nothing more to do.
    assert!(rig.finish(1, op, Outcome::Cancelled).is_empty());
    let view = rig.host.sandbox(SandboxId(1)).unwrap();
    assert_eq!(view.level, Level::Running);
    assert!(!view.wants_awake);
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(61))));
}

#[test]
fn a_sleep_step_that_finishes_despite_cancel_is_undone() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, full_ladder());
    let (_, op) = only_start(&rig.tick_at_deadline());
    rig.at(secs(31));
    rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    let (step, resume) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Resume);
    rig.finish(1, resume, Outcome::Done);
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().level,
        Level::Running
    );
}

#[test]
fn restore_falls_back_to_boot_when_the_memory_image_is_lost() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Saved, true, full_ladder());
    let (step, op) = only_start(&rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    }));
    assert_eq!(step, Step::Restore);
    let actions = rig.finish(1, op, Outcome::Failed(Failure::MemoryLost));
    assert!(actions.contains(&Action::Notify {
        sandbox: SandboxId(1),
        notice: Notice::MemoryLost
    }));
    assert_eq!(only_start(&actions).0, Step::Boot);
}

#[test]
fn wakes_respect_limits_and_priority() {
    let limits = StepLimits::default().with(Step::Restore, 2);
    let mut rig = Rig::new(HostPolicy {
        limits,
        ..HostPolicy::default()
    });
    for id in 1..=4 {
        rig.add(id, Level::Saved, true, full_ladder());
    }
    let touches = [
        (1, Priority::Background),
        (2, Priority::Interactive),
        (3, Priority::Proactive),
        (4, Priority::Interactive),
    ];
    let mut starts = Vec::new();
    for (index, (id, priority)) in touches.into_iter().enumerate() {
        rig.at(Duration::from_millis(index as u64));
        starts.extend(started(&rig.send(Input::Touch {
            sandbox: SandboxId(id),
            priority,
        })));
    }
    // The first two arrivals take both slots, whatever their priority.
    assert_eq!(starts.iter().map(|s| s.0).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(rig.host.in_flight(Step::Restore), 2);
    // Freed slots go to the most urgent waiting wake first.
    let next = started(&rig.finish(1, starts[0].2, Outcome::Done));
    assert_eq!(next[0].0, 4);
    let next = started(&rig.finish(2, starts[1].2, Outcome::Done));
    assert_eq!(next[0].0, 3);
}

#[test]
fn holds_keep_a_sandbox_awake_and_their_expiry_counts_as_activity() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, full_ladder());
    rig.send(Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(7),
        until: Some(At::from_duration(secs(100))),
        priority: Priority::Background,
    });
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(100))));
    assert!(rig.tick_at_deadline().is_empty());
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(130))));
    assert_eq!(only_start(&rig.tick_at_deadline()).0, Step::Pause);
}

#[test]
fn releasing_the_last_hold_starts_the_idle_clock() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, full_ladder());
    let hold = Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    };
    rig.send(hold);
    assert_eq!(rig.host.next_deadline(), None);
    rig.at(secs(500));
    rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    });
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(530))));
}

#[test]
fn transient_failures_back_off_exponentially() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Saved, true, full_ladder());
    let (_, op) = only_start(&rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    }));
    let actions = rig.finish(1, op, Outcome::Failed(Failure::Transient));
    assert!(actions.contains(&Action::Notify {
        sandbox: SandboxId(1),
        notice: Notice::Retrying {
            step: Step::Restore,
            failures: 1
        },
    }));
    assert_eq!(rig.host.next_deadline(), Some(At::from_millis(200)));
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Restore);
    rig.finish(1, op, Outcome::Failed(Failure::Transient));
    assert_eq!(rig.host.next_deadline(), Some(At::from_millis(600)));
}

#[test]
fn memory_pressure_pushes_the_least_recently_used_idle_sandboxes() {
    let memory = MemoryPolicy {
        low_watermark: 8 * GIB,
        high_watermark: 10 * GIB,
        compressed_percent: 30,
    };
    let mut rig = Rig::new(HostPolicy {
        memory: Some(memory),
        ..HostPolicy::default()
    });
    for id in 1..=4_u128 {
        rig.at(secs(u64::try_from(id).unwrap()));
        rig.add(id, Level::Running, false, full_ladder());
        rig.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes: GIB,
        });
    }
    rig.send(Input::Hold {
        sandbox: SandboxId(2),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    rig.at(secs(10));
    // 1.2 GiB short of the high watermark; compressing frees 0.7 GiB each.
    let actions = rig.send(Input::Memory {
        available: 8 * GIB + 8 * GIB / 10 - 1,
    });
    assert!(
        actions.is_empty(),
        "above the low watermark nothing happens"
    );
    let actions = rig.send(Input::Memory { available: 7 * GIB });
    let mut paused: Vec<u128> = started(&actions).iter().map(|s| s.0).collect();
    paused.sort_unstable();
    assert_eq!(paused, vec![1, 3, 4], "held sandbox 2 is left alone");
    for id in [1, 3, 4] {
        assert_eq!(
            rig.host.sandbox(SandboxId(id)).unwrap().floor,
            Level::Compressed
        );
    }
}

#[test]
fn removing_a_sandbox_cancels_its_step_and_frees_the_slot_when_it_ends() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Saved, true, full_ladder());
    let (_, op) = only_start(&rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    }));
    let actions = rig.send(Input::Remove {
        sandbox: SandboxId(1),
    });
    assert_eq!(
        actions,
        vec![
            Action::Cancel {
                sandbox: SandboxId(1),
                op
            },
            Action::Destroy {
                sandbox: SandboxId(1)
            },
        ]
    );
    assert_eq!(rig.host.in_flight(Step::Restore), 1);
    rig.finish(1, op, Outcome::Cancelled);
    assert_eq!(rig.host.in_flight(Step::Restore), 0);
    assert!(rig.host.is_empty());
}

#[test]
fn a_lost_process_means_booting_from_disk_next_time() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, full_ladder());
    let actions = rig.send(Input::Lost {
        sandbox: SandboxId(1),
    });
    assert!(actions.contains(&Action::Notify {
        sandbox: SandboxId(1),
        notice: Notice::MemoryLost
    }));
    let (step, _) = only_start(&rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    }));
    assert_eq!(step, Step::Boot);
}

#[test]
fn a_process_exit_during_a_successful_save_keeps_the_memory_image() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(
        1,
        Level::Paused,
        false,
        SleepPolicy::new([(Level::Paused, secs(1)), (Level::Saved, secs(2))]).unwrap(),
    );
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Save);
    assert!(
        rig.send(Input::Lost {
            sandbox: SandboxId(1)
        })
        .is_empty()
    );
    let actions = rig.finish(1, op, Outcome::Done);
    assert!(!actions.contains(&Action::Notify {
        sandbox: SandboxId(1),
        notice: Notice::MemoryLost
    }));
    let view = rig.host.sandbox(SandboxId(1)).unwrap();
    assert_eq!((view.level, view.memory_saved), (Level::Saved, true));
}

#[test]
fn a_never_sleeping_sandbox_has_no_deadline() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, Level::Running, false, SleepPolicy::NEVER);
    assert_eq!(rig.host.next_deadline(), None);
}
