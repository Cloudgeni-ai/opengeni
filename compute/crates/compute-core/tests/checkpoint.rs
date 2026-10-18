//! Checkpoints: a copy of a sandbox in use in object storage, taken while
//! it runs, so losing the host costs it only what changed since.

use std::time::Duration;

use compute_core::{
    Action, At, DiskPolicy, DiskSpace, Durability, FIRST_CHECKPOINT, HoldId, Host, HostPolicy,
    Input, Level, MemoryPolicy, OpId, Outcome, Priority, SandboxId, Size, SleepPolicy, SleepRules,
    State, Step,
};

const GIB: u64 = 1 << 30;
const EVERY: Duration = Duration::from_secs(600);

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

/// Never sleeps, and is checkpointed every ten minutes.
fn checkpointed() -> SleepPolicy {
    SleepPolicy::new(SleepRules {
        checkpoint_every: Some(EVERY),
        ..SleepRules::NEVER
    })
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

    fn at(&mut self, at: Duration) -> Vec<Action> {
        self.now = At::from_duration(at);
        self.send(Input::Tick)
    }

    fn add(&mut self, id: u128, state: State, policy: SleepPolicy, size: Size) -> Vec<Action> {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy,
            size,
            last_activity: self.now,
        })
    }

    fn finish(&mut self, id: u128, op: OpId, outcome: Outcome) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome,
            wrote: true,
        })
    }

    /// Finishes `op`, which the host agent is certain wrote nothing.
    fn finish_untouched(&mut self, id: u128, op: OpId, outcome: Outcome) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome,
            wrote: false,
        })
    }

    fn hold(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Hold {
            sandbox: SandboxId(id),
            hold: HoldId(1),
            until: None,
            priority: Priority::Interactive,
        })
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

fn only_start(actions: &[Action]) -> (Step, OpId) {
    let starts = started(actions);
    assert_eq!(starts.len(), 1, "expected exactly one start in {actions:?}");
    (starts[0].1, starts[0].2)
}

fn cancelled(actions: &[Action]) -> Vec<OpId> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Cancel { op, .. } => Some(*op),
            _ => None,
        })
        .collect()
}

#[test]
fn a_running_sandbox_is_checkpointed_within_a_minute_then_every_interval() {
    let mut rig = Rig::new(HostPolicy::default());
    assert_eq!(
        started(&rig.add(1, State::RUNNING, checkpointed(), Size::whole(GIB))),
        Vec::new()
    );
    // With no copy in object storage yet, the first comes after a minute,
    // not the whole interval.
    assert_eq!(
        rig.host.next_deadline(),
        Some(At::from_duration(FIRST_CHECKPOINT))
    );
    assert_eq!(
        started(&rig.at(FIRST_CHECKPOINT.checked_sub(secs(1)).unwrap())),
        Vec::new()
    );
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    rig.now = At::from_duration(secs(65));
    assert_eq!(started(&rig.finish(1, op, Outcome::Done)), Vec::new());
    assert_eq!(
        rig.state(1),
        State::RUNNING,
        "a checkpoint changes no state"
    );
    // From then on, the interval counts from the copy.
    assert_eq!(
        rig.host.next_deadline(),
        Some(At::from_duration(secs(65) + EVERY))
    );
    let (step, op) = only_start(&rig.at(secs(65) + EVERY));
    assert_eq!(step, Step::Checkpoint);
    // A failed one is tried again with backoff, not after the interval.
    rig.finish(1, op, Outcome::Failed(compute_core::Failure::Transient));
    let retry = rig.host.next_deadline().unwrap();
    assert!(
        retry < At::from_duration(secs(65) + EVERY + secs(60)),
        "{retry:?}"
    );
    let (step, _) = only_start(&rig.at(retry.saturating_since(At::ZERO)));
    assert_eq!(step, Step::Checkpoint);
}

#[test]
fn a_checkpoint_counts_from_the_wake_after_a_sleep() {
    let mut rig = Rig::new(HostPolicy::default());
    let paused = State::new(Level::Paused, Durability::Remote, true);
    rig.add(1, paused, checkpointed(), Size::whole(GIB));
    rig.at(secs(3600));
    let (step, op) = only_start(&rig.hold(1));
    assert_eq!(step, Step::Resume);
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1).level, Level::Running);
    // Its copy is an hour old, but it ran only from now: nothing it did
    // before needs a checkpoint.
    assert_eq!(
        rig.host.next_deadline(),
        Some(At::from_duration(secs(3600) + EVERY))
    );
}

#[test]
fn use_does_not_cancel_a_checkpoint_but_memory_pressure_does() {
    let mut rig = Rig::new(HostPolicy {
        memory: Some(MemoryPolicy {
            low_watermark: 8 * GIB,
            high_watermark: 9 * GIB,
            compressed_percent: 30,
            balloon_grace: Duration::from_secs(2),
        }),
        ..HostPolicy::default()
    });
    rig.send(Input::Memory {
        available: 64 * GIB,
    });
    let policy = SleepPolicy::new(SleepRules {
        checkpoint_every: Some(EVERY),
        ..SleepRules::RECOMMENDED
    })
    .unwrap();
    rig.add(1, State::RUNNING, policy, Size::whole(GIB));
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    rig.hold(1);
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint, "it is in use, and checkpointed");
    // More use: the checkpoint goes on, since the VM runs again as soon
    // as its state is captured.
    let actions = rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    assert!(cancelled(&actions).is_empty(), "{actions:?}");
    let actions = rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    });
    assert!(cancelled(&actions).is_empty(), "{actions:?}");
    // Memory runs short and this idle sandbox is the one to give: the
    // checkpoint frees nothing, so it gives way.
    rig.now = rig.now + secs(5);
    let actions = rig.send(Input::Memory { available: GIB });
    assert_eq!(cancelled(&actions), [op], "{actions:?}");
    let actions = rig.finish(1, op, Outcome::Cancelled);
    let steps: Vec<Step> = started(&actions).iter().map(|start| start.1).collect();
    assert_eq!(steps, [Step::Pause], "it sleeps for memory instead");
}

#[test]
fn a_sleep_asked_for_cancels_a_checkpoint_once_nothing_holds_its_sandbox() {
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(1, State::RUNNING, checkpointed(), Size::whole(GIB));
    rig.hold(1);
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    let sleep = Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Saved,
    };
    // Asked while held, the sleep waits for the hold, and so the
    // checkpoint goes on.
    let actions = rig.send(sleep);
    assert!(cancelled(&actions).is_empty(), "{actions:?}");
    // Let go, the sandbox sleeps as asked: a slow upload must not keep it
    // running, as one would keep an E2B pause waiting.
    let actions = rig.send(Input::Release {
        sandbox: SandboxId(1),
        hold: HoldId(1),
    });
    assert_eq!(cancelled(&actions), [op], "{actions:?}");
    let (step, _) = only_start(&rig.finish(1, op, Outcome::Cancelled));
    assert_eq!(step, Step::Pause, "it sleeps instead");

    // Asked with nothing holding it, the sleep cancels a checkpoint at once.
    let mut rig = Rig::new(HostPolicy::default());
    rig.add(2, State::RUNNING, checkpointed(), Size::whole(GIB));
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    let actions = rig.send(Input::Sleep {
        sandbox: SandboxId(2),
        level: Level::Paused,
    });
    assert_eq!(cancelled(&actions), [op], "{actions:?}");
    let (step, _) = only_start(&rig.finish(2, op, Outcome::Cancelled));
    assert_eq!(step, Step::Pause);
}

#[test]
fn a_sandbox_that_never_ran_is_archived_at_once_and_a_wake_comes_first() {
    let mut rig = Rig::new(HostPolicy::default());
    let created = State::new(Level::Saved, Durability::Local, false);
    let (step, op) = only_start(&rig.add(1, created, checkpointed(), Size::whole(GIB)));
    assert_eq!(step, Step::Archive, "its only copy is on this host");
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1).durability, Durability::Remote);

    // Woken while its first archive runs, it boots at once instead.
    let (step, op) = only_start(&rig.add(2, created, checkpointed(), Size::whole(GIB)));
    assert_eq!(step, Step::Archive);
    assert_eq!(cancelled(&rig.hold(2)), [op]);
    let (step, op) = only_start(&rig.finish(2, op, Outcome::Cancelled));
    assert_eq!(step, Step::Boot);
    rig.finish(2, op, Outcome::Done);
    // With no copy, its first checkpoint comes within a minute of booting.
    assert_eq!(rig.host.next_deadline(), Some(rig.now + FIRST_CHECKPOINT));

    // Without checkpoints, a new sandbox waits for its sleep rules.
    let never = SleepPolicy::new(SleepRules::NEVER).unwrap();
    assert_eq!(
        started(&rig.add(3, created, never, Size::whole(GIB))),
        Vec::new()
    );
}

#[test]
fn work_during_a_checkpoint_keeps_its_sandbox_awake_after_it() {
    let mut rig = Rig::new(HostPolicy::default());
    let policy = SleepPolicy::new(SleepRules {
        checkpoint_every: Some(EVERY),
        ..SleepRules::RECOMMENDED
    })
    .unwrap();
    rig.add(1, State::RUNNING, policy, Size::whole(GIB));
    let busy = Input::Busy {
        sandbox: SandboxId(1),
    };
    // The guest works throughout: a build, say, with nobody holding it.
    let mut op = None;
    for second in (5..=FIRST_CHECKPOINT.as_secs()).step_by(5) {
        rig.now = At::from_duration(secs(second));
        let mut actions = rig.send(busy);
        actions.extend(rig.send(Input::Tick));
        for (_, step, started) in started(&actions) {
            assert_eq!(step, Step::Checkpoint, "{actions:?}");
            op = Some(started);
        }
    }
    let op = op.expect("no checkpoint started");
    // A slow upload: the guest goes on working, and that counts.
    for second in (65..=300).step_by(5) {
        rig.now = At::from_duration(secs(second));
        assert_eq!(started(&rig.send(busy)), Vec::new());
    }
    assert_eq!(
        started(&rig.finish(1, op, Outcome::Done)),
        Vec::new(),
        "a working guest was put to sleep as its checkpoint ended"
    );
    assert_eq!(
        rig.host.next_deadline(),
        Some(At::from_duration(secs(300 + 10))),
        "it sleeps once idle for its pause delay"
    );
}

#[test]
fn a_checkpoint_books_its_disks_whole_growth_while_it_runs() {
    let mut rig = Rig::new(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: GIB,
            reserve_inodes: 100,
        }),
        ..HostPolicy::default()
    });
    rig.send(Input::Disk {
        available: DiskSpace {
            bytes: 100 * GIB,
            inodes: 1_000_000,
        },
    });
    let size = Size {
        disk: 8 * GIB,
        ..Size::whole(GIB)
    };
    rig.add(1, State::RUNNING, checkpointed(), size);
    // The disk grew by 7 GiB of its 8: 1 GiB more may come, and a reading
    // shows what it took.
    rig.send(Input::DiskGrowth {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    let reading = Input::Disk {
        available: DiskSpace {
            bytes: 93 * GIB,
            inodes: 1_000_000,
        },
    };
    rig.send(reading);
    let booked = || rig.host.disk().unwrap().booked.bytes;
    let before = booked();
    assert_eq!(
        before,
        2 * GIB,
        "its next save and what its disk may grow by"
    );
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    // The clone shares every block the disk has: any of them may now be
    // written anew.
    assert_eq!(rig.host.disk().unwrap().booked.bytes, before + 7 * GIB);
    rig.finish(1, op, Outcome::Done);
    // What the clone held stays booked until a reading shows it gone, and
    // so does the memory image the checkpoint wrote, beside the next save
    // the sandbox goes on booking.
    assert_eq!(rig.host.disk().unwrap().booked.bytes, before + 8 * GIB);
    rig.send(reading);
    assert_eq!(rig.host.disk().unwrap().booked.bytes, before);
}

/// A checkpoint leaves its sandbox running and booking its next save, so
/// the memory image it wrote is booked on its own until a reading shows
/// it, whether the checkpoint was done or cancelled while it uploaded:
/// nothing else is admitted to the space it took meanwhile.
#[test]
fn the_image_a_checkpoint_wrote_stays_booked_until_a_reading() {
    let mut rig = Rig::new(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: GIB,
            reserve_inodes: 100,
        }),
        ..HostPolicy::default()
    });
    let reading = |gib: u64| Input::Disk {
        available: DiskSpace {
            bytes: gib * GIB,
            inodes: 1_000_000,
        },
    };
    rig.send(reading(3));
    // Sandbox 1 books its next save, 1 GiB; sandbox 2, saved, needs as
    // much to wake, which fits only while sandbox 1 has written nothing.
    rig.add(1, State::RUNNING, checkpointed(), Size::whole(GIB));
    let saved = State::new(Level::Saved, Durability::Local, true);
    let rules = SleepPolicy::new(SleepRules::RECOMMENDED).unwrap();
    rig.add(2, saved, rules, Size::whole(GIB));
    let booked = |rig: &Rig| rig.host.disk().unwrap().booked.bytes;
    assert_eq!(booked(&rig), GIB);

    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    rig.finish(1, op, Outcome::Done);
    assert_eq!(rig.state(1), State::RUNNING);
    assert_eq!(
        booked(&rig),
        2 * GIB,
        "its next save and the image it wrote"
    );
    assert_eq!(
        started(&rig.hold(2)),
        Vec::new(),
        "a wake was admitted to the space the checkpoint took"
    );
    // The reading shows the image: 2 GiB left, of which sandbox 1's next
    // save and the reserve take all.
    assert_eq!(started(&rig.send(reading(2))), Vec::new());
    assert_eq!(booked(&rig), GIB);

    // One cancelled while it uploaded has written its image too.
    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT + EVERY));
    assert_eq!(step, Step::Checkpoint);
    rig.finish(1, op, Outcome::Cancelled);
    assert_eq!(booked(&rig), 2 * GIB);
    // Once a reading shows room, the wake goes ahead, and so does the
    // checkpoint that was cancelled.
    let mut starts: Vec<_> = started(&rig.send(reading(4)))
        .into_iter()
        .map(|(id, step, _)| (id, step))
        .collect();
    starts.sort_unstable();
    assert_eq!(starts, [(1, Step::Checkpoint), (2, Step::Restore)]);
}

/// A checkpoint cancelled before it wrote anything, such as by a sleep
/// that use then withdrew, books nothing: it is due again at once, and
/// booking an image each time would refuse other wakes for space nothing
/// took.
#[test]
fn a_checkpoint_cancelled_before_it_wrote_anything_books_nothing() {
    let mut rig = Rig::new(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: GIB,
            reserve_inodes: 100,
        }),
        ..HostPolicy::default()
    });
    rig.send(Input::Disk {
        available: DiskSpace {
            bytes: 3 * GIB,
            inodes: 1_000_000,
        },
    });
    // Sandbox 1 books its next save, 1 GiB; sandbox 2, saved, needs as
    // much to wake, which fits while sandbox 1 has written nothing.
    rig.add(1, State::RUNNING, checkpointed(), Size::whole(GIB));
    let saved = State::new(Level::Saved, Durability::Local, true);
    let rules = SleepPolicy::new(SleepRules::RECOMMENDED).unwrap();
    rig.add(2, saved, rules, Size::whole(GIB));
    let booked = |rig: &Rig| rig.host.disk().unwrap().booked.bytes;

    let (step, op) = only_start(&rig.at(FIRST_CHECKPOINT));
    assert_eq!(step, Step::Checkpoint);
    let actions = rig.send(Input::Sleep {
        sandbox: SandboxId(1),
        level: Level::Paused,
    });
    assert_eq!(cancelled(&actions), [op], "{actions:?}");
    // Used before the cancellation took effect: the sleep is withdrawn,
    // and the checkpoint, still due, starts again once this one ends.
    rig.send(Input::Touch {
        sandbox: SandboxId(1),
        priority: Priority::Interactive,
    });
    let (step, _) = only_start(&rig.finish_untouched(1, op, Outcome::Cancelled));
    assert_eq!(step, Step::Checkpoint);
    assert_eq!(rig.state(1), State::RUNNING);
    assert_eq!(booked(&rig), GIB, "only its next save");
    // With the disk as it was, sandbox 2 still fits.
    let (step, _) = only_start(&rig.hold(2));
    assert_eq!(step, Step::Restore);
}

#[test]
fn a_checkpoint_waits_for_disk_its_growth_can_book_and_room_is_made_for_it() {
    let mut rig = Rig::new(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: GIB,
            reserve_inodes: 100,
        }),
        ..HostPolicy::default()
    });
    let reading = |gib: u64| Input::Disk {
        available: DiskSpace {
            bytes: gib * GIB,
            inodes: 1_000_000,
        },
    };
    // Sandbox 1's disk grew by 7 GiB of its 8, so a checkpoint of it books
    // 7 GiB more; sandbox 2's disk has nothing left to grow by, so one of
    // it books nothing more. Each books 2 GiB now.
    let big = Size {
        disk: 8 * GIB,
        ..Size::whole(GIB)
    };
    rig.add(1, State::RUNNING, checkpointed(), big);
    rig.send(Input::DiskGrowth {
        sandbox: SandboxId(1),
        bytes: GIB,
    });
    let small = Size {
        disk: GIB,
        ..Size::whole(GIB)
    };
    rig.add(2, State::RUNNING, checkpointed(), small);
    // A reading after what sandbox 1's disk took, then an idle sandbox
    // whose copy is in object storage too.
    rig.send(reading(6));
    let archived = State::new(Level::Archived, Durability::Remote, true);
    let rules = SleepPolicy::new(SleepRules::RECOMMENDED).unwrap();
    rig.add(3, archived, rules, Size::whole(GIB));
    assert_eq!(rig.host.disk().unwrap().free().bytes, GIB);
    assert_eq!(rig.host.sandbox(SandboxId(3)).unwrap().step, None);

    // Both are due: 1 does not fit and waits, without holding up 2, and
    // the idle copy is given up to make room for it.
    let mut starts = started(&rig.at(FIRST_CHECKPOINT));
    starts.sort_unstable_by_key(|start| start.0);
    let [(2, Step::Checkpoint, checkpoint), (3, Step::Evict, evict)] = starts[..] else {
        panic!("unexpected starts: {starts:?}");
    };
    assert_eq!(rig.host.sandbox(SandboxId(1)).unwrap().step, None);
    assert_eq!(started(&rig.finish(3, evict, Outcome::Done)), Vec::new());
    assert_eq!(
        started(&rig.finish(2, checkpoint, Outcome::Done)),
        Vec::new()
    );
    // Only a reading shows the room it made, and it must fit the whole 7 GiB.
    assert_eq!(started(&rig.send(reading(11))), Vec::new());
    let (step, _) = only_start(&rig.send(reading(12)));
    assert_eq!(step, Step::Checkpoint);
    assert_eq!(rig.host.disk().unwrap().booked.bytes, 4 * GIB + 7 * GIB);
}
