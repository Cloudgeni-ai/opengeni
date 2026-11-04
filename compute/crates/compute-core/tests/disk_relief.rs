//! Disk relief: what the host can free without losing anything, idle
//! sandboxes' archived local copies and caches nothing uses, counts as
//! room for a create or a wake. One that fits only with it waits, booking
//! what it needs, while relief frees it least recently used first across
//! every kind; one short even with it is refused at once; and what cannot
//! be freed is never counted (ADR 30).

use std::time::Duration;

use compute_core::{
    Action, At, CacheId, CreateRoom, DiskPolicy, DiskSpace, Durability, HoldId, Host, HostPolicy,
    Input, Level, Notice, OpId, Outcome, Priority, Resource, SandboxId, Size, SleepPolicy,
    SleepRules, State, Step,
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

fn space(bytes: u64) -> DiskSpace {
    DiskSpace { bytes, inodes: 4 }
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

    fn at(&mut self, secs: u64) -> Vec<Action> {
        self.now = At::from_duration(Duration::from_secs(secs));
        self.send(Input::Tick)
    }

    /// Adds sandbox `id` now, with `copy` as what its local copy holds.
    fn add(&mut self, id: u128, state: State, policy: SleepPolicy, copy: u64) {
        self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy,
            size: Size::whole(GIB),
            last_activity: self.now,
        });
        self.send(Input::LocalCopy {
            sandbox: SandboxId(id),
            disk: space(copy),
        });
    }

    /// Reports cache `id`, holding `bytes`, as last used now.
    fn cache(&mut self, id: u64, bytes: u64) -> Vec<Action> {
        self.send(Input::Cache {
            cache: CacheId(id),
            disk: space(bytes),
            last_used: self.now,
        })
    }

    fn disk(&mut self, bytes: u64) -> Vec<Action> {
        self.send(Input::Disk {
            available: DiskSpace {
                bytes,
                inodes: 10_000,
            },
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

    fn finish(&mut self, id: u128, op: OpId) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: SandboxId(id),
            op,
            outcome: Outcome::Done,
            wrote: true,
        })
    }

    /// Whether a create of sandbox `id` whose first files take `files`
    /// fits; its first wake books a save of 1 GiB.
    fn create_room(&self, id: u128, files: u64) -> CreateRoom {
        self.host.create_room(
            self.now,
            SandboxId(id),
            Size::whole(GIB),
            rules(),
            false,
            space(files),
        )
    }

    /// What a create of `id` whose first files take `files` books while it
    /// waits for relief.
    fn wants(&mut self, id: u128, files: u64) -> Vec<Action> {
        let disk = Host::first_wake_disk(Size::whole(GIB), rules(), false).add(space(files));
        self.send(Input::Wants {
            key: SandboxId(id),
            disk,
        })
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

fn removed(actions: &[Action]) -> Vec<u64> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::RemoveCache { cache } => Some(cache.0),
            _ => None,
        })
        .collect()
}

fn refused(actions: &[Action], id: u128) -> bool {
    actions.iter().any(|action| {
        matches!(action, Action::Notify { sandbox, notice: Notice::HostFull { .. } } if sandbox.0 == id)
    })
}

/// A host with 1 GiB free beyond its reserve, an idle sandbox archived at
/// 0 s whose local copy holds 3 GiB, a cache last used at 1 s holding
/// 2 GiB, and another sandbox archived at 2 s holding 3 GiB: 8 GiB of
/// relief.
fn relievable() -> Rig {
    let mut rig = Rig::new();
    rig.add(1, archived(), rules(), 3 * GIB);
    rig.at(1);
    rig.cache(7, 2 * GIB);
    rig.at(2);
    rig.add(2, archived(), rules(), 3 * GIB);
    rig.at(3);
    rig.disk(2 * GIB);
    rig
}

#[test]
fn a_create_that_fits_only_with_relief_books_it_and_relief_frees_what_it_needs() {
    let mut rig = relievable();
    assert_eq!(rig.host.disk().unwrap().free().bytes, GIB);
    assert_eq!(rig.host.reclaimable_disk(rig.now), 8 * GIB);
    // Its files and its save take 5 GiB: 4 GiB short, within the relief.
    assert!(matches!(
        rig.create_room(100, 4 * GIB),
        CreateRoom::AwaitsReading(Resource::Disk, _, _)
    ));
    // Booking what it waits for frees the oldest first, across kinds, until
    // what they hold covers it: the first copy and the cache, not the
    // newer copy.
    let actions = rig.wants(100, 4 * GIB);
    assert!(
        matches!(started(&actions)[..], [(1, Step::Evict, _)]),
        "{actions:?}"
    );
    assert_eq!(removed(&actions), [7]);
    assert_eq!(
        rig.host.sandbox(SandboxId(2)).unwrap().floor,
        Level::Running
    );
    // Nothing more is freed while that is under way, and the create still
    // waits for it.
    let evict = started(&actions)[0].2;
    let actions = rig.at(4);
    assert_eq!(started(&actions), []);
    assert_eq!(removed(&actions), Vec::<u64>::new());
    assert!(matches!(
        rig.create_room(100, 4 * GIB),
        CreateRoom::AwaitsReading(..)
    ));
    // Gone, but not yet read: what they freed still counts.
    rig.finish(1, evict);
    rig.send(Input::CacheRemoved { cache: CacheId(7) });
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().state.level,
        Level::Remote
    );
    assert!(matches!(
        rig.create_room(100, 4 * GIB),
        CreateRoom::AwaitsReading(..)
    ));
    // The reading shows it: the create fits, its own booking counting as
    // free for it, and the newer copy stays.
    let actions = rig.disk(7 * GIB);
    assert_eq!(started(&actions), []);
    assert_eq!(rig.create_room(100, 4 * GIB), CreateRoom::Fits);
    assert_eq!(rig.host.disk().unwrap().free().bytes, GIB);
    assert_eq!(rig.host.reclaimable_disk(rig.now), 3 * GIB);
    // Once it goes on, it books its files and first wake instead.
    rig.send(Input::Wants {
        key: SandboxId(100),
        disk: DiskSpace::default(),
    });
    assert_eq!(rig.host.disk().unwrap().free().bytes, 6 * GIB);
}

#[test]
fn a_create_short_even_with_relief_is_refused_and_frees_nothing() {
    let mut rig = relievable();
    // 9 GiB of files and a save of 1 GiB: 9 GiB short, 8 GiB of relief.
    assert_eq!(
        rig.create_room(100, 9 * GIB),
        CreateRoom::Short(Resource::Disk, 10 * GIB, GIB)
    );
    let actions = rig.at(4);
    assert_eq!(started(&actions), []);
    assert_eq!(removed(&actions), Vec::<u64>::new());
}

#[test]
fn what_cannot_be_freed_is_never_counted() {
    let mut rig = Rig::new();
    // Saved but not archived: freeing it needs an upload first.
    rig.add(1, saved(), rules(), 3 * GIB);
    // Archived, but kept on local disk by its policy.
    let local = SleepPolicy::new(SleepRules {
        archive_after: None,
        evict_after: None,
        ..SleepRules::RECOMMENDED
    })
    .unwrap();
    rig.add(2, archived(), local, 3 * GIB);
    // Archived, but held awake: it is waking.
    rig.add(3, archived(), rules(), 3 * GIB);
    // Archived, but never measured.
    rig.send(Input::Add {
        sandbox: SandboxId(4),
        state: archived(),
        policy: rules(),
        size: Size::whole(GIB),
        last_activity: rig.now,
    });
    // A cache in use again, reported with nothing.
    rig.cache(7, 2 * GIB);
    rig.send(Input::Cache {
        cache: CacheId(7),
        disk: DiskSpace::default(),
        last_used: rig.now,
    });
    rig.at(1);
    rig.disk(2 * GIB);
    rig.hold(3);
    assert_eq!(rig.host.reclaimable_disk(rig.now), 0);
    assert!(matches!(
        rig.create_room(100, 4 * GIB),
        CreateRoom::Short(Resource::Disk, ..)
    ));
}

#[test]
fn a_wake_that_fits_only_with_relief_waits_queued_while_relief_frees_room() {
    let mut rig = Rig::new();
    rig.add(1, archived(), rules(), 3 * GIB);
    rig.at(1);
    rig.add(2, saved(), rules(), 0);
    rig.at(2);
    // Nothing free beyond the reserve: its wake books a save of 1 GiB.
    rig.disk(GIB);
    let actions = rig.hold(2);
    assert!(!refused(&actions, 2), "{actions:?}");
    let [(1, Step::Evict, evict)] = started(&actions)[..] else {
        panic!("no evict: {actions:?}");
    };
    assert_eq!(
        rig.host.sandbox(SandboxId(2)).unwrap().state.level,
        Level::Saved
    );
    rig.finish(1, evict);
    let actions = rig.disk(4 * GIB);
    assert!(
        matches!(started(&actions)[..], [(2, Step::Restore, _)]),
        "{actions:?}"
    );
}

#[test]
fn a_wake_short_even_with_relief_is_refused_at_once() {
    let mut rig = Rig::new();
    rig.add(2, saved(), rules(), 0);
    rig.at(1);
    rig.cache(7, GIB / 2);
    rig.disk(GIB);
    let actions = rig.hold(2);
    assert!(refused(&actions, 2), "{actions:?}");
    assert_eq!(removed(&actions), Vec::<u64>::new());
}
