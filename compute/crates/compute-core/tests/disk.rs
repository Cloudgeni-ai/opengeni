//! Disk for saves: every VM whose state is not saved yet books what its
//! next save may write, a wake the disk cannot book is refused at once, and
//! in the background idle sandboxes in object storage give up their local
//! copies while the disk is short.

use std::time::Duration;

use compute_core::{
    Action, At, DiskPolicy, DiskSpace, Durability, HoldId, Host, HostPolicy, Input, Level, Notice,
    OpId, Outcome, Priority, Resource, SandboxId, Size, SleepPolicy, SleepRules, State, Step,
};

const GIB: u64 = 1 << 30;

fn saved() -> State {
    State::new(Level::Saved, Durability::Local, true)
}

fn archived() -> State {
    State::new(Level::Archived, Durability::Remote, true)
}

fn rules() -> SleepPolicy {
    SleepPolicy::new(SleepRules::RECOMMENDED).unwrap()
}

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    /// A host whose disk keeps 1 GiB and 100 inodes back.
    fn new() -> Self {
        let policy = HostPolicy {
            disk: Some(DiskPolicy {
                reserve: GIB,
                reserve_inodes: 100,
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

    fn add(&mut self, id: u128, state: State) {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy: rules(),
            size: Size::whole(GIB),
            last_activity: self.now,
        });
    }

    fn disk(&mut self, bytes: u64, inodes: u64) -> Vec<Action> {
        self.send(Input::Disk {
            available: DiskSpace { bytes, inodes },
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

    fn release(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Release {
            sandbox: SandboxId(id),
            hold: HoldId(1),
        })
    }

    fn finish(&mut self, id: u128, op: OpId) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome: Outcome::Done,
        })
    }

    fn at(&mut self, secs: u64) -> Vec<Action> {
        self.now = At::from_duration(Duration::from_secs(secs));
        self.send(Input::Tick)
    }

    fn level(&self, id: u128) -> Level {
        self.host.sandbox(SandboxId(id)).unwrap().state.level
    }

    fn booked(&self) -> u64 {
        self.host.disk().unwrap().booked.bytes
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

/// Holds `id` awake and finishes its wake.
fn wake(rig: &mut Rig, id: u128) {
    let actions = rig.hold(id);
    let [(woken, Step::Restore, op)] = started(&actions)[..] else {
        panic!("no restore: {actions:?}");
    };
    assert_eq!(woken, id);
    rig.finish(id, op);
    assert_eq!(rig.level(id), Level::Running);
}

#[test]
fn a_wake_the_disk_cannot_book_is_refused_at_once_and_retried_once_it_can() {
    let mut rig = Rig::new();
    for id in 1..=3 {
        rig.add(id, saved());
    }
    // 3 GiB available, 1 GiB of it reserved: room for two saves.
    rig.disk(3 * GIB, 10_000);
    assert_eq!(rig.booked(), 0, "saved sandboxes book nothing");
    wake(&mut rig, 1);
    wake(&mut rig, 2);
    assert_eq!(rig.booked(), 2 * GIB);
    let actions = rig.hold(3);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 3), Some((Resource::Disk, GIB, 0)));
    assert_eq!(rig.level(3), Level::Saved);

    // Sandbox 1 sleeps; once its state is saved it books nothing more, but
    // what the save wrote stays booked until a reading shows it. Only then
    // does the held wake go ahead, if the disk still has room.
    rig.release(1);
    let actions = rig.at(10);
    let [(1, Step::Pause, op)] = started(&actions)[..] else {
        panic!("no pause: {actions:?}");
    };
    rig.finish(1, op);
    assert_eq!(
        rig.booked(),
        2 * GIB,
        "a paused VM not saved yet still books"
    );
    let actions = rig.at(40);
    let [(1, Step::Save, op)] = started(&actions)[..] else {
        panic!("no save: {actions:?}");
    };
    let actions = rig.finish(1, op);
    assert_eq!(started(&actions), []);
    assert_eq!(rig.booked(), 2 * GIB);
    // The save took half a GiB: still short.
    let actions = rig.disk(2 * GIB + GIB / 2, 10_000);
    assert_eq!(started(&actions), []);
    assert_eq!(rig.booked(), GIB);
    // It replaced an older copy as large: the wake goes ahead.
    let actions = rig.disk(3 * GIB, 10_000);
    assert!(
        matches!(started(&actions)[..], [(3, Step::Restore, _)]),
        "{actions:?}"
    );
    assert_eq!(rig.booked(), 2 * GIB);
}

#[test]
fn nothing_is_booked_before_the_first_reading() {
    let mut rig = Rig::new();
    rig.add(1, saved());
    rig.add(2, State::new(Level::Paused, Durability::Volatile, false));
    let actions = rig.hold(1);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 1), Some((Resource::Disk, GIB, 0)));
    // Resuming a VM that books already needs nothing more.
    let actions = rig.hold(2);
    assert!(matches!(started(&actions)[..], [(2, Step::Resume, _)]));
    let actions = rig.disk(10 * GIB, 10_000);
    assert!(matches!(started(&actions)[..], [(1, Step::Restore, _)]));
}

#[test]
fn inodes_are_booked_too() {
    let mut rig = Rig::new();
    rig.add(1, saved());
    // Plenty of bytes, but only the reserve's inodes.
    let actions = rig.disk(100 * GIB, 100);
    assert_eq!(started(&actions), []);
    let actions = rig.hold(1);
    assert_eq!(started(&actions), []);
    assert_eq!(host_full(&actions, 1), Some((Resource::Inodes, 16, 0)));
    // More inodes free up; the held wake goes ahead.
    let actions = rig.disk(100 * GIB, 1000);
    assert!(matches!(started(&actions)[..], [(1, Step::Restore, _)]));
}

#[test]
fn bookings_are_rebuilt_from_states_after_a_restart() {
    let mut rig = Rig::new();
    rig.add(1, State::RUNNING);
    rig.add(2, State::new(Level::Paused, Durability::Volatile, false));
    rig.add(3, State::new(Level::Paused, Durability::Local, true));
    rig.add(4, saved());
    rig.disk(10 * GIB, 10_000);
    let disk = rig.host.disk().unwrap();
    assert_eq!((disk.booked.bytes, disk.booked.inodes), (2 * GIB, 32));
    assert_eq!(disk.free().bytes, 7 * GIB);
}

#[test]
fn a_short_disk_evicts_idle_archived_copies_and_waits_for_a_fresh_reading() {
    let mut rig = Rig::new();
    for id in 1..=20 {
        rig.add(id, archived());
    }
    rig.add(21, State::RUNNING);
    // The running VM books 1 GiB more than the disk has beyond its reserve.
    rig.at(1);
    let actions = rig.disk(GIB, 10_000);
    let evicts: Vec<u128> = started(&actions)
        .into_iter()
        .filter(|(_, step, _)| *step == Step::Evict)
        .map(|(id, _, _)| id)
        .collect();
    // As many as may be evicted at once, least recently used first.
    assert_eq!(evicts.len(), 16, "{actions:?}");
    // Nothing more while they run, nor on a reading taken before they end.
    assert_eq!(started(&rig.disk(GIB, 10_000)), []);
    let ops: Vec<(u128, OpId)> = started(&actions)
        .into_iter()
        .map(|(id, _, op)| (id, op))
        .collect();
    for (id, op) in ops {
        assert_eq!(started(&rig.finish(id, op)), []);
        assert_eq!(rig.level(id), Level::Remote);
    }
    // A reading after them still short: the rest go.
    let actions = rig.disk(GIB + GIB / 2, 10_000);
    assert_eq!(started(&actions).len(), 4);
    // Enough room: nothing more.
    let actions = rig.disk(3 * GIB, 10_000);
    assert_eq!(started(&actions), []);
    assert_eq!(rig.level(21), Level::Running);
}

#[test]
fn copies_that_cannot_live_in_object_storage_are_kept() {
    let mut rig = Rig::new();
    let local_only = SleepPolicy::new(SleepRules {
        archive_after: None,
        evict_after: None,
        ..SleepRules::RECOMMENDED
    })
    .unwrap();
    rig.send(Input::Add {
        sandbox: SandboxId(1),
        state: saved(),
        policy: local_only,
        size: Size::whole(GIB),
        last_activity: rig.now,
    });
    rig.add(2, State::RUNNING);
    rig.at(1);
    assert_eq!(started(&rig.disk(GIB, 10_000)), []);
    assert_eq!(rig.level(1), Level::Saved);
}

#[test]
fn a_saved_copy_not_yet_archived_is_archived_first() {
    let mut rig = Rig::new();
    rig.add(1, saved());
    rig.add(2, State::RUNNING);
    rig.at(1);
    let actions = rig.disk(GIB, 10_000);
    let [(1, Step::Archive, op)] = started(&actions)[..] else {
        panic!("no archive: {actions:?}");
    };
    let actions = rig.finish(1, op);
    assert!(matches!(started(&actions)[..], [(1, Step::Evict, _)]));
}
