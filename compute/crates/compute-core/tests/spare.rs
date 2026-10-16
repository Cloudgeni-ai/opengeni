//! Spare VMs, such as ready sandboxes and template builds, share one
//! memory book with sandboxes: they count against the admission budget, a
//! new one takes only room no wake wants, and ready ones are the first
//! memory given back.

use std::time::Duration;

use compute_core::{
    Action, Admission, At, Durability, Host, HostPolicy, Input, Level, MemoryPolicy, Priority,
    SandboxId, Size, SleepPolicy, SleepRules, State, Step,
};

const GIB: u64 = 1 << 30;
const SPARE: SandboxId = SandboxId(900);

fn no_compress() -> SleepPolicy {
    SleepPolicy::new(SleepRules {
        compress_under_pressure: false,
        ..SleepRules::RECOMMENDED
    })
    .unwrap()
}

fn admission(budget: u64, buffer: u64) -> Admission {
    Admission {
        budget,
        buffer,
        busy_grace: Duration::from_secs(2),
    }
}

fn watermarks() -> MemoryPolicy {
    MemoryPolicy {
        low_watermark: 4 * GIB,
        high_watermark: 5 * GIB,
        compressed_percent: 30,
        balloon_grace: Duration::from_secs(2),
    }
}

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    fn new(admission: Option<Admission>, memory: Option<MemoryPolicy>) -> Self {
        let policy = HostPolicy {
            admission,
            memory,
            ..HostPolicy::default()
        };
        Self {
            host: Host::new(policy).unwrap(),
            now: At::ZERO,
        }
    }

    fn send_all(&mut self, inputs: impl IntoIterator<Item = Input>) -> Vec<Action> {
        let mut out = Vec::new();
        self.host.handle_all(self.now, inputs, &mut out);
        out
    }

    fn send(&mut self, input: Input) -> Vec<Action> {
        self.send_all([input])
    }

    fn add(&mut self, id: u128, level: Level, bytes: u64) -> Vec<Action> {
        let state = State::new(level, Durability::Local, level != Level::Running);
        let mut out = self.send(Input::Add {
            sandbox: SandboxId(id),
            state,
            policy: no_compress(),
            size: Size::whole(bytes),
            last_activity: self.now,
        });
        if level != Level::Saved {
            out.extend(self.send(Input::Resident {
                sandbox: SandboxId(id),
                bytes,
            }));
        }
        out
    }

    fn spare(&mut self, bytes: u64, filling: bool) -> Vec<Action> {
        self.send(Input::Spare {
            sandbox: SPARE,
            bytes,
            filling,
        })
    }

    fn touch(&mut self, id: u128) -> Vec<Action> {
        self.send(Input::Touch {
            sandbox: SandboxId(id),
            priority: Priority::Interactive,
        })
    }

    fn later(&mut self, secs: u64) {
        self.now = self.now + Duration::from_secs(secs);
    }
}

fn discards(actions: &[Action]) -> Vec<SandboxId> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Discard { sandbox } => Some(*sandbox),
            _ => None,
        })
        .collect()
}

fn starts(actions: &[Action]) -> Vec<(SandboxId, Step)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Start { sandbox, step, .. } => Some((*sandbox, *step)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_spare_vm_takes_only_room_above_the_buffer_that_no_wake_wants() {
    let mut rig = Rig::new(Some(admission(4 * GIB, GIB)), None);
    assert_eq!(rig.host.spare_room(), Some(3 * GIB));
    rig.spare(2 * GIB, true);
    assert_eq!(rig.host.capacity().unwrap().occupied, 2 * GIB);
    assert_eq!(rig.host.spare_room(), Some(GIB));
    // A wake that waits for room leaves none to spares.
    rig.add(1, Level::Running, 2 * GIB);
    rig.add(2, Level::Saved, GIB);
    let out = rig.touch(2);
    assert!(starts(&out).is_empty(), "{out:?}");
    assert_eq!(rig.host.spare_room(), Some(0));
    // Without any limit there is nothing to book against.
    assert_eq!(Rig::new(None, None).host.spare_room(), None);
}

#[test]
fn a_wake_ends_a_ready_spare_before_any_saved_sandbox() {
    let mut rig = Rig::new(Some(admission(4 * GIB, 0)), None);
    rig.add(1, Level::Running, 2 * GIB);
    rig.add(2, Level::Paused, GIB);
    rig.spare(GIB, true);
    rig.spare(GIB, false);
    rig.add(3, Level::Saved, GIB);
    rig.later(5);
    let out = rig.touch(3);
    assert_eq!(discards(&out), [SPARE], "{out:?}");
    assert!(
        starts(&out).is_empty(),
        "the idle saved sandbox stays: {out:?}"
    );
    assert_eq!(
        rig.host.sandbox(SandboxId(2)).unwrap().floor,
        Level::Running
    );
    // Asked once only.
    assert_eq!(discards(&rig.send(Input::Tick)), []);
    let out = rig.spare(0, false);
    assert_eq!(starts(&out), [(SandboxId(3), Step::Restore)], "{out:?}");
}

#[test]
fn a_spare_still_filling_is_not_ended_for_a_wake() {
    let mut rig = Rig::new(Some(admission(4 * GIB, 0)), None);
    rig.add(1, Level::Running, 2 * GIB);
    rig.spare(2 * GIB, true);
    rig.add(3, Level::Saved, GIB);
    let out = rig.touch(3);
    assert!(discards(&out).is_empty(), "{out:?}");
    assert!(
        rig.host.sandbox(SandboxId(3)).unwrap().state.level == Level::Saved,
        "refused, nothing to end at once: {out:?}"
    );
}

#[test]
fn a_filling_spare_claims_room_above_the_watermark_until_memory_is_read_again() {
    let mut rig = Rig::new(None, Some(watermarks()));
    assert_eq!(rig.host.spare_room(), None, "no reading yet");
    rig.send(Input::Memory { available: 8 * GIB });
    assert_eq!(rig.host.spare_room(), Some(3 * GIB));
    rig.spare(2 * GIB, true);
    assert_eq!(rig.host.spare_room(), Some(GIB));
    // Filled: what it took shows only in the next reading.
    rig.spare(2 * GIB, false);
    assert_eq!(rig.host.spare_room(), Some(GIB));
    rig.send(Input::Memory { available: 6 * GIB });
    assert_eq!(rig.host.spare_room(), Some(GIB));
    // A fill that ends without a ready VM still counts until a reading.
    rig.send(Input::Spare {
        sandbox: SandboxId(901),
        bytes: GIB,
        filling: true,
    });
    rig.send(Input::Spare {
        sandbox: SandboxId(901),
        bytes: 0,
        filling: true,
    });
    assert_eq!(rig.host.spare_room(), Some(0));
}

#[test]
fn ready_spares_are_the_first_memory_given_back_under_pressure() {
    let mut rig = Rig::new(None, Some(watermarks()));
    rig.add(1, Level::Paused, GIB);
    rig.spare(2 * GIB, false);
    rig.later(5);
    let out = rig.send(Input::Memory {
        available: 4 * GIB - 1,
    });
    assert_eq!(discards(&out), [SPARE], "{out:?}");
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().floor,
        Level::Running,
        "what the spare frees is enough: {out:?}"
    );
    // Once it ended, nothing more is freed before memory is read again.
    rig.spare(0, false);
    let out = rig.send(Input::Tick);
    assert!(starts(&out).is_empty(), "{out:?}");
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().floor,
        Level::Running
    );
}

/// A ready spare whose removal failed is counted as unmanaged and freed
/// nothing: relief goes on at once, without waiting for a reading.
#[test]
fn a_spare_that_could_not_be_ended_is_no_relief() {
    let mut rig = Rig::new(None, Some(watermarks()));
    rig.add(1, Level::Paused, GIB);
    rig.spare(2 * GIB, false);
    rig.later(5);
    let out = rig.send(Input::Memory {
        available: 4 * GIB - 1,
    });
    assert_eq!(discards(&out), [SPARE], "{out:?}");
    // Its removal stopped part way: the agent keeps it counted.
    rig.send_all([
        Input::Unmanaged {
            sandbox: SPARE,
            bytes: 2 * GIB,
        },
        Input::Spare {
            sandbox: SPARE,
            bytes: 0,
            filling: false,
        },
    ]);
    rig.send(Input::Tick);
    assert_ne!(
        rig.host.sandbox(SandboxId(1)).unwrap().floor,
        Level::Running,
        "the idle sandbox gives way instead"
    );
}

#[test]
fn the_buffer_is_kept_by_ending_ready_spares_first() {
    let mut rig = Rig::new(Some(admission(4 * GIB, GIB)), None);
    rig.add(1, Level::Paused, GIB);
    rig.spare(GIB, false);
    rig.later(5);
    let out = rig.add(2, Level::Running, 2 * GIB);
    assert_eq!(discards(&out), [SPARE], "{out:?}");
    assert_eq!(
        rig.host.sandbox(SandboxId(1)).unwrap().floor,
        Level::Running
    );
}

#[test]
fn a_claimed_ready_sandbox_is_counted_once() {
    let mut rig = Rig::new(Some(admission(8 * GIB, 0)), None);
    rig.spare(2 * GIB, false);
    let occupied = |rig: &Rig| rig.host.capacity().unwrap().occupied;
    assert_eq!(occupied(&rig), 2 * GIB);
    // Claimed: no longer spare, but its VM still holds its memory.
    rig.send_all([
        Input::Spare {
            sandbox: SPARE,
            bytes: 0,
            filling: false,
        },
        Input::Unmanaged {
            sandbox: SPARE,
            bytes: 2 * GIB,
        },
    ]);
    assert_eq!(occupied(&rig), 2 * GIB);
    rig.send_all([
        Input::Add {
            sandbox: SandboxId(7),
            state: State::new(Level::Paused, Durability::Local, false),
            policy: no_compress(),
            size: Size::whole(2 * GIB),
            last_activity: rig.now,
        },
        Input::Unmanaged {
            sandbox: SPARE,
            bytes: 0,
        },
    ]);
    assert_eq!(occupied(&rig), 2 * GIB);
}
