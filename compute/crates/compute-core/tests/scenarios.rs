//! Hand-written scenarios for the host decision core.

use std::time::Duration;

use compute_core::{
    Action, At, Durability, Failure, HoldId, Host, HostPolicy, Input, Level, MemoryPolicy, Notice,
    OpId, Outcome, Priority, SandboxId, SleepPolicy, SleepRules, State, Step, StepLimits,
};

const GIB: u64 = 1 << 30;
const DAY: u64 = 86_400;

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

fn recommended() -> SleepPolicy {
    SleepPolicy::new(SleepRules::RECOMMENDED).unwrap()
}

fn state(level: Level, durability: Durability, memory_saved: bool) -> State {
    State::new(level, durability, memory_saved)
}

fn paused(durability: Durability) -> State {
    state(Level::Paused, durability, false)
}

fn saved() -> State {
    state(Level::Saved, Durability::Local, true)
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

    fn add(&mut self, id: u128, state: State, policy: SleepPolicy) -> Vec<Action> {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy,
        })
    }

    fn touch(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Touch {
            sandbox: SandboxId(id),
            priority: Priority::Interactive,
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

    fn state(&self, id: u128) -> State {
        self.host.sandbox(SandboxId(id)).unwrap().state
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

fn assert_nothing_started(actions: &[Action]) {
    let nothing: Vec<(u128, Step, OpId)> = Vec::new();
    assert_eq!(started(actions), nothing);
}

fn only_start(actions: &[Action]) -> (Step, OpId) {
    let starts = started(actions);
    assert_eq!(starts.len(), 1, "expected exactly one start in {actions:?}");
    (starts[0].1, starts[0].2)
}

fn notices(actions: &[Action], id: u128) -> Vec<Notice> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Notify { sandbox, notice } if sandbox.0 == id => Some(*notice),
            _ => None,
        })
        .collect()
}

#[test]
fn an_idle_sandbox_pauses_gets_protected_in_memory_and_leaves_disk_after_days() {
    let mut rig = Rig::new(HostPolicy::default());
    assert_eq!(rig.add(1, State::RUNNING, recommended()), []);
    let expected = [
        (Step::Pause, 10, paused(Durability::Volatile)),
        (Step::Save, 30, paused(Durability::Local)),
        (Step::Archive, 120, paused(Durability::Remote)),
        (
            Step::Drop,
            3 * DAY,
            state(Level::Archived, Durability::Remote, true),
        ),
        (
            Step::Evict,
            3 * DAY,
            state(Level::Remote, Durability::Remote, true),
        ),
        (
            Step::Forget,
            30 * DAY,
            state(Level::Remote, Durability::Remote, false),
        ),
    ];
    let mut actions = Vec::new();
    for (step, at, after) in expected {
        // Evicting follows dropping at once; everything else waits for time.
        if started(&actions).is_empty() {
            actions = rig.tick_at_deadline();
        }
        assert_eq!(rig.now, At::from_duration(secs(at)), "{step:?}");
        let (started_step, op) = only_start(&actions);
        assert_eq!(started_step, step);
        actions = rig.finish(1, op, Outcome::Done);
        assert_eq!(notices(&actions, 1), [Notice::State(after)]);
    }
    assert_nothing_started(&actions);
    assert_eq!(rig.host.next_deadline(), None);
    // A month later it still wakes: fetch the files, boot fresh.
    let (step, op) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Fetch);
    let (step, _) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Boot);
}

#[test]
fn waking_a_protected_paused_sandbox_resumes_it_and_the_next_idle_period_saves_again() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Remote), recommended());
    let (step, op) = only_start(&rig.touch(1));
    assert_eq!(
        step,
        Step::Resume,
        "a resident VM resumes instead of restoring"
    );
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1), State::RUNNING);
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Pause);
    rig.finish(1, op, Outcome::Done);
    let (step, _) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Save, "resuming made the saved copy stale");
}

#[test]
fn touch_cancels_a_sleep_step_in_flight() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Pause);
    rig.at(secs(11));
    let actions = rig.touch(1);
    assert_eq!(
        actions,
        vec![Action::Cancel {
            sandbox: SandboxId(1),
            op
        }]
    );
    // Cancelled in time: still running, nothing more to do.
    assert_eq!(rig.finish(1, op, Outcome::Cancelled), []);
    let view = rig.host.sandbox(SandboxId(1)).unwrap();
    assert_eq!(view.state, State::RUNNING);
    assert!(!view.wants_awake);
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(21))));
}

#[test]
fn a_wake_during_a_safety_copy_cancels_it_and_resumes() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Local), recommended());
    rig.at(secs(120));
    let (step, op) = only_start(&rig.send(Input::Tick));
    assert_eq!(step, Step::Archive);
    let actions = rig.touch(1);
    assert_eq!(
        actions,
        vec![Action::Cancel {
            sandbox: SandboxId(1),
            op
        }]
    );
    let (step, _) = only_start(&rig.finish(1, op, Outcome::Cancelled));
    assert_eq!(step, Step::Resume);
}

#[test]
fn a_sleep_step_that_finishes_despite_cancel_is_undone() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    let (_, op) = only_start(&rig.tick_at_deadline());
    rig.at(secs(11));
    rig.touch(1);
    let (step, resume) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Resume);
    rig.finish(1, resume, Outcome::Done);
    assert_eq!(rig.state(1), State::RUNNING);
}

#[test]
fn restore_falls_back_to_boot_when_the_memory_image_is_lost() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, saved(), recommended());
    let (step, op) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Restore);
    let actions = rig.finish(1, op, Outcome::Failed(Failure::MemoryLost));
    assert!(notices(&actions, 1).contains(&Notice::MemoryLost));
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
        rig.add(id, saved(), recommended());
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
    rig.add(1, State::RUNNING, recommended());
    rig.send(Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(7),
        until: Some(At::from_duration(secs(100))),
        priority: Priority::Background,
    });
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(100))));
    assert_eq!(rig.tick_at_deadline(), []);
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(110))));
    assert_eq!(only_start(&rig.tick_at_deadline()).0, Step::Pause);
}

#[test]
fn releasing_the_last_hold_starts_the_idle_clock() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    rig.send(Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    assert_eq!(rig.host.next_deadline(), None);
    rig.at(secs(500));
    rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    });
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(510))));
}

#[test]
fn transient_failures_back_off_exponentially() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, saved(), recommended());
    let (_, op) = only_start(&rig.touch(1));
    let actions = rig.finish(1, op, Outcome::Failed(Failure::Transient));
    assert!(notices(&actions, 1).contains(&Notice::Retrying {
        step: Step::Restore,
        failures: 1
    }));
    assert_eq!(rig.host.next_deadline(), Some(At::from_millis(200)));
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Restore);
    rig.finish(1, op, Outcome::Failed(Failure::Transient));
    assert_eq!(rig.host.next_deadline(), Some(At::from_millis(600)));
}

fn pressured_rig() -> Rig {
    Rig::new(HostPolicy {
        memory: Some(MemoryPolicy {
            low_watermark: 8 * GIB,
            high_watermark: 9 * GIB,
            compressed_percent: 30,
        }),
        ..HostPolicy::default()
    })
}

#[test]
fn memory_pressure_compresses_the_least_recently_used_idle_sandboxes_first() {
    let mut rig = pressured_rig();
    for id in 1..=4_u128 {
        rig.at(secs(u64::try_from(id).unwrap()));
        rig.add(id, paused(Durability::Local), recommended());
        rig.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes: GIB,
        });
    }
    rig.send(Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    rig.at(secs(10));
    let actions = rig.send(Input::Memory {
        available: 8 * GIB + 8 * GIB / 10 - 1,
    });
    assert!(
        started(&actions).is_empty(),
        "above the low watermark nothing happens"
    );
    // 1.4 GiB short of the high watermark; compressing frees 0.7 GiB each,
    // so the two oldest idle ones are compressed. Sandbox 1 is held.
    let actions = rig.send(Input::Memory {
        available: 7 * GIB + 6 * GIB / 10,
    });
    let starts = started(&actions);
    assert_eq!(
        starts.iter().map(|s| (s.0, s.1)).collect::<Vec<_>>(),
        [(2, Step::Compress), (3, Step::Compress)]
    );
    for (id, _, op) in starts {
        assert_nothing_started(&rig.finish(id, op, Outcome::Done));
        rig.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes: 3 * GIB / 10,
        });
    }
    // Until a new reading arrives, the freed memory is assumed to be on its
    // way, so nothing more happens.
    assert_nothing_started(&rig.send(Input::Tick));
    // A larger shortfall than compression can cover ends processes outright,
    // oldest first; their saved copies make that instant.
    let actions = rig.send(Input::Memory {
        available: 7 * GIB + GIB / 2,
    });
    assert_eq!(
        started(&actions)
            .iter()
            .map(|start| (start.0, start.1))
            .collect::<Vec<_>>(),
        vec![(2, Step::Drop), (3, Step::Drop), (4, Step::Drop)]
    );
}

#[test]
fn memory_pressure_saves_an_unprotected_sandbox_before_ending_its_process() {
    let mut rig = pressured_rig();
    let rules = SleepRules {
        compress_under_pressure: false,
        ..SleepRules::RECOMMENDED
    };
    rig.add(
        1,
        paused(Durability::Volatile),
        SleepPolicy::new(rules).unwrap(),
    );
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    let (step, op) = only_start(&rig.send(Input::Memory { available: GIB }));
    assert_eq!(step, Step::Save);
    let (step, op_drop) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Drop);
    rig.finish(1, op_drop, Outcome::Done);
    assert_eq!(rig.state(1), saved());
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().floor,
        Level::Running
    );
}

#[test]
fn reclaimable_memory_counts_only_idle_paused_sandboxes_with_a_current_copy() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Local), recommended());
    rig.add(2, paused(Durability::Volatile), recommended());
    rig.add(3, State::RUNNING, recommended());
    rig.add(4, paused(Durability::Remote), recommended());
    for id in 1..=4 {
        rig.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes: GIB << id,
        });
    }
    assert_eq!(rig.host.reclaimable_memory(), (GIB << 1) + (GIB << 4));
    rig.send(Input::Hold {
        sandbox: SandboxId(4),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    assert_eq!(rig.host.reclaimable_memory(), GIB << 1);
}

#[test]
fn removing_a_sandbox_cancels_its_step_and_frees_the_slot_when_it_ends() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, saved(), recommended());
    let (_, op) = only_start(&rig.touch(1));
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
fn a_lost_process_without_a_copy_means_booting_from_disk_next_time() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    let actions = rig.send(Input::Lost {
        sandbox: SandboxId(1),
    });
    assert!(notices(&actions, 1).contains(&Notice::MemoryLost));
    let (step, _) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Boot);
}

#[test]
fn a_lost_process_with_a_current_copy_loses_nothing() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Remote), recommended());
    let actions = rig.send(Input::Lost {
        sandbox: SandboxId(1),
    });
    assert_eq!(
        notices(&actions, 1),
        [Notice::State(state(
            Level::Archived,
            Durability::Remote,
            true
        ))]
    );
    let (step, _) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Restore);
}

#[test]
fn a_process_exit_during_a_successful_save_keeps_the_memory_image() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Volatile), recommended());
    let (step, op) = only_start(&rig.at(secs(30)).send(Input::Tick));
    assert_eq!(step, Step::Save);
    assert_eq!(
        rig.send(Input::Lost {
            sandbox: SandboxId(1)
        }),
        []
    );
    let actions = rig.finish(1, op, Outcome::Done);
    assert!(!notices(&actions, 1).contains(&Notice::MemoryLost));
    assert_eq!(rig.state(1), saved());
}

#[test]
fn a_process_exit_during_a_failed_save_loses_the_programs() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Volatile), recommended());
    let (_, op) = only_start(&rig.at(secs(30)).send(Input::Tick));
    rig.send(Input::Lost {
        sandbox: SandboxId(1),
    });
    let actions = rig.finish(1, op, Outcome::Failed(Failure::Transient));
    assert!(notices(&actions, 1).contains(&Notice::MemoryLost));
    assert_eq!(rig.state(1), state(Level::Saved, Durability::Local, false));
}

#[test]
fn adding_corrects_an_impossible_state() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(
        1,
        state(Level::Running, Durability::Remote, true),
        recommended(),
    );
    rig.add(
        2,
        State {
            level: Level::Saved,
            durability: Durability::Volatile,
            memory_saved: true,
        },
        recommended(),
    );
    assert_eq!(rig.state(1), State::RUNNING);
    assert_eq!(rig.state(2), saved());
}

#[test]
fn a_never_sleeping_sandbox_has_no_deadline() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, SleepPolicy::NEVER);
    assert_eq!(rig.host.next_deadline(), None);
}

#[test]
fn a_sleep_request_drains_a_sandbox_to_object_storage_and_it_still_wakes() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Volatile), SleepPolicy::NEVER);
    let mut actions = rig.send(Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Remote,
    });
    let mut steps = Vec::new();
    while let [(_, step, op)] = started(&actions)[..] {
        steps.push(step);
        actions = rig.finish(1, op, Outcome::Done);
    }
    assert_eq!(steps, [Step::Save, Step::Drop, Step::Archive, Step::Evict]);
    let view = rig.host.sandbox(SandboxId(1)).unwrap();
    assert_eq!(view.state, state(Level::Remote, Durability::Remote, true));
    assert_eq!(
        view.requested,
        Level::Running,
        "reaching the level ends the request"
    );
    let (step, op) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Fetch);
    assert_eq!(
        only_start(&rig.finish(1, op, Outcome::Done)).0,
        Step::Restore
    );
}

#[test]
fn a_sleep_request_waits_for_holds_and_a_touch_cancels_it() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, SleepPolicy::NEVER);
    rig.send(Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    });
    let sleep = Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Saved,
    };
    assert_eq!(rig.send(sleep), [], "held: nothing yet");
    let (step, op) = only_start(&rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    }));
    assert_eq!(step, Step::Pause);
    let (step, save) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Save);
    // A touch now cancels the rest of the request and wakes it again.
    assert_eq!(
        rig.touch(1),
        [Action::Cancel {
            sandbox: SandboxId(1),
            op: save
        }]
    );
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().requested,
        Level::Running
    );
    let (step, _) = only_start(&rig.finish(1, save, Outcome::Cancelled));
    assert_eq!(step, Step::Resume);
}

#[test]
fn work_inside_a_running_sandbox_keeps_it_awake_but_never_wakes_it() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    let busy = Input::Busy {
        sandbox: SandboxId(1),
    };
    // A build keeps running past the pause threshold.
    rig.at(secs(8));
    assert_eq!(rig.send(busy), []);
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(18))));
    let (step, pause) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Pause);

    // Work reported after the pause started changes nothing: the step goes
    // ahead, and once paused the sandbox does no work of its own.
    assert_eq!(rig.send(busy), []);
    rig.finish(1, pause, Outcome::Done);
    assert_eq!(rig.state(1).level, Level::Paused);
    assert_eq!(rig.send(busy), []);
    assert!(!rig.host.sandbox(SandboxId(1)).unwrap().wants_awake);

    // It does not cancel a sleep request either.
    let (_, resume) = only_start(&rig.touch(1));
    rig.finish(1, resume, Outcome::Done);
    let decided = rig.send(Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Saved,
    });
    assert_eq!(only_start(&decided).0, Step::Pause, "{decided:?}");
    assert_eq!(rig.send(busy), []);
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().requested,
        Level::Saved
    );
}

#[test]
fn readings_taken_together_are_all_applied_before_any_timer_fires() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, recommended());
    rig.add(2, State::RUNNING, recommended());
    // Both reach their pause threshold just as one sweep finds both busy.
    rig.at(secs(10));
    let busy = |id| Input::Busy {
        sandbox: SandboxId(id),
    };
    let mut out = Vec::new();
    rig.host.handle_all(rig.now, [busy(1), busy(2)], &mut out);
    assert_eq!(out, [], "neither busy sandbox may pause");
    assert_eq!(rig.host.next_deadline(), Some(At::from_duration(secs(20))));
}

#[test]
fn a_resume_that_fails_stops_trusting_the_saved_copy() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Local), recommended());
    let (step, op) = only_start(&rig.touch(1));
    assert_eq!(step, Step::Resume);
    let actions = rig.finish(1, op, Outcome::Failed(Failure::Transient));
    // The guest may have run before the failure, so the copy may be stale.
    assert_eq!(rig.state(1), paused(Durability::Volatile));
    assert!(notices(&actions, 1).contains(&Notice::State(paused(Durability::Volatile))));
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Resume, "the retry resumes the same VM");
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1), State::RUNNING);
    let (step, op) = only_start(&rig.tick_at_deadline());
    assert_eq!(step, Step::Pause);
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1), paused(Durability::Volatile));
    let (step, _) = only_start(&rig.tick_at_deadline());
    assert_eq!(
        step,
        Step::Save,
        "nothing to fall back on until saved again"
    );
}

#[test]
fn a_resume_that_fails_with_its_process_gone_boots_from_the_files() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, paused(Durability::Remote), recommended());
    rig.add(2, paused(Durability::Local), recommended());
    let (_, first) = only_start(&rig.touch(1));
    let (_, second) = only_start(&rig.touch(2));

    // The process ends as the resume fails.
    let actions = rig.finish(1, first, Outcome::Failed(Failure::MemoryLost));
    assert!(notices(&actions, 1).contains(&Notice::MemoryLost));
    assert_eq!(rig.state(1), state(Level::Saved, Durability::Local, false));
    assert_eq!(only_start(&actions).0, Step::Boot);

    // The process exit is noticed first, then the resume fails.
    assert_nothing_started(&rig.send(Input::Lost {
        sandbox: SandboxId(2),
    }));
    let actions = rig.finish(2, second, Outcome::Failed(Failure::Transient));
    assert!(notices(&actions, 2).contains(&Notice::MemoryLost));
    assert_eq!(rig.state(2), state(Level::Saved, Durability::Local, false));
}

#[test]
fn a_sleep_request_made_during_a_wake_applies_after_it() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, saved(), SleepPolicy::NEVER);
    let hold = Input::Hold {
        sandbox: SandboxId(1),
        hold: HoldId(1),
        until: None,
        priority: Priority::Interactive,
    };
    let (step, restore) = only_start(&rig.send(hold));
    assert_eq!(step, Step::Restore);
    assert_nothing_started(&rig.send(Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Saved,
    }));
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().requested,
        Level::Saved
    );
    assert_nothing_started(&rig.finish(1, restore, Outcome::Done));
    assert_eq!(rig.state(1), State::RUNNING, "the wake is served first");

    let (step, op) = only_start(&rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    }));
    assert_eq!(step, Step::Pause);
    let (step, op) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Save);
    let (step, op) = only_start(&rig.finish(1, op, Outcome::Done));
    assert_eq!(step, Step::Drop);
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1), saved());
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().requested,
        Level::Running
    );
}

#[test]
fn memory_pressure_cancels_an_archive_that_would_hold_it_up() {
    let mut rig = pressured_rig();
    let rules = SleepRules {
        compress_under_pressure: false,
        ..SleepRules::RECOMMENDED
    };
    rig.add(
        1,
        paused(Durability::Local),
        SleepPolicy::new(rules).unwrap(),
    );
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    rig.at(secs(120));
    let (step, archive) = only_start(&rig.send(Input::Tick));
    assert_eq!(step, Step::Archive);
    assert_eq!(
        rig.send(Input::Memory { available: GIB }),
        [Action::Cancel {
            sandbox: SandboxId(1),
            op: archive
        }]
    );
    let (step, drop) = only_start(&rig.finish(1, archive, Outcome::Cancelled));
    assert_eq!(step, Step::Drop, "the saved copy is enough to free memory");
    let (step, _) = only_start(&rig.finish(1, drop, Outcome::Done));
    assert_eq!(rig.state(1), saved());
    assert_eq!(step, Step::Archive, "archiving starts again from the copy");
}
