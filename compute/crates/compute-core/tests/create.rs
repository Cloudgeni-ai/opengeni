//! Creates book their sandbox's first wake: a host takes a new sandbox
//! only while it could wake it at once, and keeps that room booked, memory,
//! processor time and disk, until the sandbox runs, so a burst of creates
//! never leaves sandboxes their host cannot run.

use std::time::Duration;

use compute_core::{
    Action, Admission, At, Capacity, CreateRoom, DiskPolicy, DiskSpace, Durability, Host,
    HostPolicy, Input, Level, OpId, Outcome, Priority, Resource, SandboxId, Size, SleepPolicy,
    SleepRules, State, Step,
};

/// The resource a create found short, if any.
trait ShortOf {
    fn short_of(self) -> Option<Resource>;
}

impl ShortOf for CreateRoom {
    fn short_of(self) -> Option<Resource> {
        match self {
            CreateRoom::Short(resource, ..) => Some(resource),
            CreateRoom::Fits | CreateRoom::AwaitsReading(..) => None,
        }
    }
}

const GIB: u64 = 1 << 30;
/// How long a create's booking lasts in these tests.
const BOOKED_FOR: Duration = Duration::from_secs(60);

fn saved() -> State {
    State::new(Level::Saved, Durability::Local, true)
}

fn remote() -> State {
    State::new(Level::Remote, Durability::Remote, true)
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
    /// A host that can hold `budget` bytes of guest memory and guarantees
    /// `millis` of processor time.
    fn new(budget: u64, millis: u64) -> Self {
        Self::with(HostPolicy {
            admission: Some(Admission {
                budget,
                buffer: 0,
                busy_grace: Duration::from_secs(2),
            }),
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

    /// Creates `id` as the host agent does: refused if its first wake
    /// does not fit, booked otherwise.
    fn create(&mut self, id: u128, size: Size) -> CreateRoom {
        self.create_as(id, size, false)
    }

    fn create_as(&mut self, id: u128, size: Size, remote: bool) -> CreateRoom {
        let room =
            self.host
                .create_room(self.now, SandboxId(id), size, remote, DiskSpace::default());
        if room == CreateRoom::Fits {
            self.send(Input::Creating {
                sandbox: SandboxId(id),
                size,
                remote,
                until: self.now + BOOKED_FOR,
            });
        }
        room
    }

    /// Ends `id`'s booking, as for a create that failed.
    fn failed(&mut self, id: u128) {
        self.send(Input::Creating {
            sandbox: SandboxId(id),
            size: Size::default(),
            remote: false,
            until: self.now,
        });
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

    fn capacity(&self) -> Capacity {
        self.host.capacity().unwrap()
    }

    fn cpu_reserved(&self) -> u64 {
        self.host.cpu_capacity().unwrap().reserved
    }

    /// Wakes `id` and finishes its wake; fails unless it starts at once.
    fn wake(&mut self, id: u128) {
        let actions = self.touch(id);
        let (step, op) = started(&actions)
            .into_iter()
            .find_map(|(sandbox, step, op)| (sandbox == id).then_some((step, op)))
            .unwrap_or_else(|| panic!("{id}'s wake did not start: {actions:?}"));
        assert!(
            matches!(step, Step::Restore | Step::Boot | Step::Fetch),
            "{step:?}"
        );
        self.finish(id, op);
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

#[test]
fn a_create_books_its_first_wake_from_before_its_sandbox_exists() {
    let mut rig = Rig::new(2 * GIB, 2000);
    assert_eq!(rig.create(1, size(500)), CreateRoom::Fits);
    let capacity = rig.capacity();
    assert_eq!(
        (capacity.reserved, capacity.occupied, capacity.awake),
        (GIB, GIB, 0),
        "booked, not awake"
    );
    assert_eq!(rig.cpu_reserved(), 500);
    // Added, it keeps the booking, and its first wake takes nothing more.
    rig.add(1, saved(), size(500));
    assert_eq!(rig.capacity().occupied, GIB);
    assert!(rig.host.reserves(SandboxId(1)));
    rig.wake(1);
    let level = rig.host.sandbox(SandboxId(1)).unwrap().state.level;
    assert_eq!(level, Level::Running);
    let capacity = rig.capacity();
    assert_eq!((capacity.occupied, capacity.awake), (GIB, 1));
    assert_eq!(rig.cpu_reserved(), 500);
}

#[test]
fn a_burst_of_creates_takes_only_what_the_host_can_run() {
    let mut rig = Rig::new(2 * GIB, 8000);
    let taken: Vec<u128> = (1..=8)
        .filter(|id| rig.create(*id, size(100)) == CreateRoom::Fits)
        .collect();
    assert_eq!(taken, [1, 2]);
    assert_eq!(
        rig.create(9, size(100)),
        CreateRoom::Short(Resource::Memory, GIB, 0),
        "what it needs and what is free"
    );
    // Every sandbox taken wakes at once.
    rig.add(1, saved(), size(100));
    rig.add(2, saved(), size(100));
    rig.wake(1);
    rig.wake(2);
    assert_eq!(rig.capacity().awake, 2);
    // An older sandbox's wake finds the booked room taken.
    rig.add(3, saved(), size(100));
    let actions = rig.touch(3);
    assert_eq!(started(&actions), []);
}

#[test]
fn a_create_beyond_the_processor_budget_is_refused() {
    let mut rig = Rig::new(8 * GIB, 1000);
    assert_eq!(rig.create(1, size(600)), CreateRoom::Fits);
    assert_eq!(
        rig.create(2, size(600)),
        CreateRoom::Short(Resource::Cpu, 600, 400)
    );
    assert_eq!(rig.create(3, size(400)), CreateRoom::Fits);
}

#[test]
fn a_create_counts_the_wakes_let_in_before_it() {
    let mut rig = Rig::new(2 * GIB, 8000);
    rig.add(1, saved(), size(100));
    rig.add(2, saved(), size(100));
    rig.wake(1);
    // Its wake is admitted and owns its room.
    let actions = rig.touch(2);
    assert_eq!(started(&actions).len(), 1);
    assert_eq!(
        rig.create(3, size(100)),
        CreateRoom::Short(Resource::Memory, GIB, 0)
    );
}

#[test]
fn a_booking_ends_with_a_failed_create_or_a_removal_and_lapses_unused() {
    let mut rig = Rig::new(2 * GIB, 8000);
    assert_eq!(rig.create(1, size(100)), CreateRoom::Fits);
    rig.failed(1);
    assert_eq!(rig.capacity().occupied, 0);
    assert_eq!(rig.cpu_reserved(), 0);

    // Removed before or after it was added, it leaves nothing booked: a
    // sandbox never woken has no VM to wait for.
    assert_eq!(rig.create(2, size(100)), CreateRoom::Fits);
    rig.send(Input::Remove {
        sandbox: SandboxId(2),
    });
    assert_eq!(rig.capacity().occupied, 0);
    assert_eq!(rig.create(3, size(100)), CreateRoom::Fits);
    rig.add(3, saved(), size(100));
    let actions = rig.send(Input::Remove {
        sandbox: SandboxId(3),
    });
    assert!(actions.iter().any(|action| matches!(
        action,
        Action::Destroy { sandbox } if *sandbox == SandboxId(3)
    )));
    assert_eq!(rig.capacity().occupied, 0);
    assert_eq!(rig.cpu_reserved(), 0);

    // Booked and never woken, it lapses, added or not.
    assert_eq!(rig.create(4, size(100)), CreateRoom::Fits);
    assert_eq!(rig.create(5, size(100)), CreateRoom::Fits);
    rig.add(5, saved(), size(100));
    assert_eq!(rig.host.next_deadline(), Some(rig.now + BOOKED_FOR));
    rig.at(BOOKED_FOR.as_secs());
    rig.send(Input::Tick);
    assert_eq!(rig.capacity().occupied, 0);
    assert_eq!(rig.cpu_reserved(), 0);
    assert!(!rig.host.reserves(SandboxId(5)));
    // Added after it lapsed, it books nothing; its wake is a wake like
    // any other.
    rig.add(4, saved(), size(100));
    assert_eq!(rig.capacity().occupied, 0);
    rig.wake(4);
    assert_eq!(rig.capacity().occupied, GIB);
}

/// A paused sandbox whose state is saved, idle since it was added.
fn paused_saved() -> State {
    State::new(Level::Paused, Durability::Local, true)
}

#[test]
fn free_and_reclaimable_memory_are_what_a_create_could_take_and_no_more() {
    let mut rig = Rig::new(8 * GIB, 8000);
    for id in 1..=2 {
        rig.add(id, paused_saved(), Size::whole(2 * GIB));
        rig.send(Input::Resident {
            sandbox: SandboxId(id),
            bytes: GIB,
        });
    }
    // Idle past the busy grace: ending either VM loses nothing.
    rig.at(5);
    assert_eq!(rig.capacity().free(), 6 * GIB);
    assert_eq!(rig.host.reclaimable_memory(rig.now), 2 * GIB);
    assert_eq!(
        rig.host
            .create_room(rig.now, SandboxId(9), size(0), false, DiskSpace::default()),
        CreateRoom::Fits
    );
    let more = Size::whole(8 * GIB + (1 << 20));
    assert_eq!(
        rig.host
            .create_room(rig.now, SandboxId(9), more, false, DiskSpace::default())
            .short_of(),
        Some(Resource::Memory)
    );
    assert_eq!(rig.create(3, Size::whole(8 * GIB)), CreateRoom::Fits);

    // Booked, that create takes the relief too: nothing is left to count,
    // though the idle VMs still run.
    assert_eq!(rig.capacity().free(), 0);
    assert_eq!(rig.host.reclaimable_memory(rig.now), 0);
    assert_eq!(rig.create(4, size(0)).short_of(), Some(Resource::Memory));
}

#[test]
fn an_overdrawn_budget_takes_the_relief_before_reclaimable_memory_counts_it() {
    // One idle saved VM fills the budget; two first wakes are booked on
    // the strength of ending it, which leaves the budget overdrawn.
    let mut rig = Rig::new(2 * GIB, 8000);
    rig.add(1, paused_saved(), Size::whole(2 * GIB));
    rig.send(Input::Resident {
        sandbox: SandboxId(1),
        bytes: 2 * GIB,
    });
    rig.at(5);
    assert_eq!(rig.host.reclaimable_memory(rig.now), 2 * GIB);
    assert_eq!(rig.create(2, size(0)), CreateRoom::Fits);
    assert_eq!(rig.create(3, size(0)), CreateRoom::Fits);
    assert_eq!(rig.capacity().free(), 0);
    assert_eq!(rig.host.reclaimable_memory(rig.now), 0);
    assert_eq!(rig.create(4, size(0)).short_of(), Some(Resource::Memory));
}

#[test]
fn a_create_asked_again_does_not_count_its_own_booking() {
    let mut rig = Rig::new(GIB, 8000);
    assert_eq!(rig.create(1, size(100)), CreateRoom::Fits);
    assert_eq!(
        rig.create(1, size(100)),
        CreateRoom::Fits,
        "its own room is free for it"
    );
    assert_eq!(rig.capacity().occupied, GIB);
    assert_eq!(
        rig.create(2, size(100)),
        CreateRoom::Short(Resource::Memory, GIB, 0)
    );
}

#[test]
fn a_new_sandbox_is_not_pushed_deeper_while_booked() {
    let mut rig = Rig::with(HostPolicy {
        admission: Some(Admission {
            budget: 2 * GIB,
            buffer: 2 * GIB,
            busy_grace: Duration::from_secs(2),
        }),
        ..HostPolicy::default()
    });
    assert_eq!(rig.create(1, size(100)), CreateRoom::Fits);
    // A claimed ready sandbox: a paused VM with nothing saved yet.
    rig.add(
        1,
        State::new(Level::Paused, Durability::Volatile, false),
        size(100),
    );
    // Idle past the busy grace, short of its own sleep rules, while the
    // buffer wants all the room it books.
    rig.at(20);
    let actions = rig.send(Input::Tick);
    assert_eq!(started(&actions), [], "it waits for its wake");
}

#[test]
fn a_create_books_the_disk_its_first_wake_needs() {
    let mut rig = Rig::with(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: GIB,
            reserve_inodes: 100,
        }),
        ..HostPolicy::default()
    });
    // Room for the reserve and two saves of 1 GiB, with nothing to grow.
    rig.send(Input::Disk {
        available: DiskSpace {
            bytes: 3 * GIB,
            inodes: 1000,
        },
    });
    let size = Size::whole(GIB);
    assert_eq!(rig.create(1, size), CreateRoom::Fits);
    assert_eq!(rig.create(2, size), CreateRoom::Fits);
    let short = rig.create(3, size).short_of();
    assert_eq!(short, Some(Resource::Disk));
    // An adopted sandbox's first wake fetches it too.
    rig.failed(2);
    let mut adopted = size;
    adopted.fetch = GIB;
    let short = rig.create_as(4, adopted, true).short_of();
    assert_eq!(short, Some(Resource::Disk));
    adopted.fetch = 0;
    assert_eq!(rig.create_as(4, adopted, true), CreateRoom::Fits);
    rig.add(4, remote(), adopted);
    let short = rig.create(5, size).short_of();
    assert_eq!(short, Some(Resource::Disk), "kept once it is added");
}

/// A create short of disk by no more than what a booking that ended
/// since the last reading stood for waits for the next reading, with what
/// is written for it before it joins counted together with its first
/// wake; one short by more is short whatever that reading shows.
#[test]
fn a_create_that_may_fit_once_the_disk_is_read_awaits_the_reading() {
    let mut rig = Rig::with(HostPolicy {
        disk: Some(DiskPolicy {
            reserve: 0,
            reserve_inodes: 0,
        }),
        ..HostPolicy::default()
    });
    rig.send(Input::Disk {
        available: DiskSpace {
            bytes: 3 * GIB,
            inodes: 1000,
        },
    });
    let whole = Size::whole(GIB);
    let files = DiskSpace {
        bytes: GIB,
        inodes: 10,
    };
    let room = |rig: &Rig, id: u128| {
        rig.host
            .create_room(rig.now, SandboxId(id), whole, false, files)
    };
    // Its first files and its first wake's save, 2 GiB, fit.
    assert_eq!(room(&rig, 1), CreateRoom::Fits);
    rig.send(Input::Writes {
        key: SandboxId(1),
        disk: files,
    });
    assert_eq!(rig.create(1, whole), CreateRoom::Fits);
    // 1 GiB is left: the files' booking ended, but only a reading shows
    // what they took.
    rig.send(Input::Writes {
        key: SandboxId(1),
        disk: DiskSpace::default(),
    });
    assert!(
        matches!(room(&rig, 2), CreateRoom::AwaitsReading(Resource::Disk, ..)),
        "{:?}",
        room(&rig, 2)
    );
    // A reading showing they took all of it leaves nothing to wait for.
    rig.send(Input::Disk {
        available: DiskSpace {
            bytes: 2 * GIB,
            inodes: 990,
        },
    });
    assert_eq!(room(&rig, 2).short_of(), Some(Resource::Disk));
    // Memory or processor time short is short at once, whatever the disk.
    let mut rig = Rig::new(GIB, 8000);
    assert_eq!(rig.create(1, size(100)), CreateRoom::Fits);
    assert_eq!(
        rig.host
            .create_room(rig.now, SandboxId(2), size(100), false, files),
        CreateRoom::Short(Resource::Memory, GIB, 0)
    );
}
