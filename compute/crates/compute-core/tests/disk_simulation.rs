//! Seeded random histories of sandboxes that write to local disk: guests
//! growing their disks while they run, saves, and wakes from object
//! storage that write their local copy before and after the guest runs;
//! and work outside any sandbox that writes too: new sandboxes' first
//! files, booked as writes, and spare VMs filling. After every decision
//! the core's disk bookings must cover what an independent model says may
//! still be written, plus what was written since the last reading.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use compute_core::{
    Action, At, DiskPolicy, DiskSpace, Durability, Failure, HoldId, Host, HostPolicy, Input, Level,
    OpId, Outcome, Priority, SandboxId, Size, SleepPolicy, SleepRules, State, Step, StepLimits,
};

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

/// A `SplitMix64` generator: small, seeded and good enough for test histories.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
}

/// What the model knows of one sandbox's local writes.
#[derive(Debug)]
struct Model {
    size: Size,
    /// What its disk may still grow by.
    headroom: u64,
    /// A wake from object storage writes its local copy.
    hydrating: bool,
    /// What that wake wrote so far.
    fetched: u64,
}

/// Work outside any sandbox that writes to local disk.
#[derive(Clone, Copy, Debug)]
struct Outside {
    /// Booked as [`Input::Writes`], or as a filling [`Input::Spare`].
    spare: bool,
    /// What it may still write.
    remaining: u64,
}

struct Sim {
    host: Host,
    now: At,
    rng: Rng,
    total: u64,
    used: u64,
    /// Written since the last reading.
    unread: u64,
    models: BTreeMap<SandboxId, Model>,
    outside: BTreeMap<SandboxId, Outside>,
    running: BTreeMap<OpId, (SandboxId, Step)>,
    removed: BTreeSet<SandboxId>,
    wakes: u64,
}

impl Sim {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed);
        let host = Host::new(HostPolicy {
            limits: StepLimits::uniform(1 + u32::try_from(rng.below(3)).unwrap()),
            disk: Some(DiskPolicy {
                reserve: GIB,
                reserve_inodes: 100,
            }),
            ..HostPolicy::default()
        })
        .unwrap();
        let total = (10 + rng.below(40)) * GIB;
        let mut sim = Self {
            host,
            now: At::ZERO,
            rng,
            total,
            used: 0,
            unread: 0,
            models: BTreeMap::new(),
            outside: BTreeMap::new(),
            running: BTreeMap::new(),
            removed: BTreeSet::new(),
            wakes: 0,
        };
        for id in 0..10 {
            let limit = (1 + sim.rng.below(2)) * GIB;
            let disk = (1 + sim.rng.below(4)) * GIB;
            let size = Size {
                request: limit,
                limit,
                save: limit + 64 * MIB,
                disk,
                fetch: limit + disk + 64 * MIB,
            };
            let state = if sim.rng.below(2) == 0 {
                State::new(Level::Saved, Durability::Local, true)
            } else {
                State::new(Level::Remote, Durability::Remote, true)
            };
            let sandbox = SandboxId(id);
            sim.models.insert(
                sandbox,
                Model {
                    size,
                    headroom: disk,
                    hydrating: false,
                    fetched: 0,
                },
            );
            sim.send(vec![Input::Add {
                sandbox,
                state,
                policy: SleepPolicy::new(SleepRules::RECOMMENDED).unwrap(),
                size,
                last_activity: At::ZERO,
            }]);
        }
        sim.sample();
        sim
    }

    fn send(&mut self, inputs: Vec<Input>) {
        let mut out = Vec::new();
        self.host.handle_all(self.now, inputs, &mut out);
        for action in out {
            if let Action::Start { sandbox, op, step } = action {
                self.running.insert(op, (sandbox, step));
                if step.wakes() {
                    self.wakes += 1;
                }
                if step == Step::Fetch
                    && let Some(model) = self.models.get_mut(&sandbox)
                {
                    model.hydrating = true;
                    model.fetched = 0;
                }
            }
        }
        self.check();
        // A local copy gone back to object storage is written no more.
        for (id, model) in &mut self.models {
            if self
                .host
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Remote && view.step.is_none())
            {
                model.hydrating = false;
            }
        }
    }

    /// The core books at least what may still be written, and what was
    /// written since the last reading.
    fn check(&self) {
        let Some(disk) = self.host.disk() else {
            return;
        };
        let mut owed = self.unread;
        let mut detail = Vec::new();
        for (key, work) in &self.outside {
            owed += work.remaining;
            detail.push(format!(
                "outside {}: spare {} owes {} MiB",
                key.0,
                work.spare,
                work.remaining / MIB
            ));
        }
        for (id, model) in &self.models {
            let Some(view) = self.host.sandbox(*id) else {
                continue;
            };
            let before = owed;
            if view.state.level.has_process() && view.state.durability == Durability::Volatile {
                owed += model.size.save;
            }
            if view.state.level == Level::Running || view.step.is_some_and(Step::wakes) {
                owed += model.headroom;
            }
            if model.hydrating {
                owed += model.size.fetch - model.fetched;
            }
            detail.push(format!(
                "{}: {:?} {:?} {:?} hydrating {} owes {} MiB",
                id.0,
                view.state.level,
                view.state.durability,
                view.step,
                model.hydrating,
                (owed - before) / MIB
            ));
        }
        assert!(
            disk.booked.bytes >= owed,
            "booked {} MiB, but {} MiB may be written or were unread ({} MiB unread):\n{}",
            disk.booked.bytes / MIB,
            owed / MIB,
            self.unread / MIB,
            detail.join("\n")
        );
    }

    fn write(&mut self, bytes: u64) {
        self.used += bytes;
        self.unread += bytes;
    }

    /// A sample: measured disk growth, then the disk, in one batch.
    fn sample(&mut self) {
        let mut inputs: Vec<Input> = self
            .models
            .iter()
            .map(|(id, model)| Input::DiskGrowth {
                sandbox: *id,
                bytes: model.headroom,
            })
            .collect();
        inputs.push(Input::Disk {
            available: DiskSpace {
                bytes: self.total.saturating_sub(self.used),
                inodes: 100_000,
            },
        });
        self.unread = 0;
        self.send(inputs);
    }

    fn pick(&mut self) -> SandboxId {
        SandboxId(u128::from(self.rng.below(10)))
    }

    fn step(&mut self) {
        let id = self.pick();
        let gone = self.removed.contains(&id);
        match self.rng.below(100) {
            0..15 if !gone => self.send(vec![Input::Hold {
                sandbox: id,
                hold: HoldId(1),
                until: None,
                priority: Priority::Interactive,
            }]),
            15..30 if !gone => self.send(vec![Input::Release {
                sandbox: id,
                hold: HoldId(1),
            }]),
            30..50 if !gone => {
                // A running guest writes to its disk.
                let running = self
                    .host
                    .sandbox(id)
                    .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
                if running {
                    let headroom = self.models[&id].headroom;
                    let bytes = self.rng.below(headroom + 1);
                    self.models.get_mut(&id).unwrap().headroom -= bytes;
                    self.write(bytes);
                }
            }
            50..60 => self.sample(),
            60..64
                if !gone
                    && self.models[&id].hydrating
                    && self
                        .host
                        .sandbox(id)
                        .is_some_and(|view| view.state.level.has_process()) =>
            {
                // The pager of its VM filled the rest of the memory image.
                let model = self.models.get_mut(&id).unwrap();
                let rest = model.size.fetch - model.fetched;
                model.hydrating = false;
                self.write(rest);
                self.send(vec![Input::Hydrating {
                    sandbox: id,
                    hydrating: false,
                }]);
            }
            64..65 if !gone => {
                self.models.remove(&id);
                self.removed.insert(id);
                self.send(vec![Input::Remove { sandbox: id }]);
            }
            65..75 => self.outside_step(),
            _ => self.finish_one(),
        }
        self.now = self.now + Duration::from_millis(self.rng.below(3000));
        self.send(vec![Input::Tick]);
    }

    /// Work outside any sandbox starts if its booking fits, writes part of
    /// what it booked, or ends having written part or all of the rest.
    fn outside_step(&mut self) {
        let key = SandboxId(100 + u128::from(self.rng.below(4)));
        let Some(work) = self.outside.get(&key).copied() else {
            let bound = (1 + self.rng.below(4)) * 256 * MIB;
            let disk = DiskSpace {
                bytes: bound,
                inodes: 32,
            };
            if self.host.disk_shortage(disk).is_some() {
                return;
            }
            let spare = self.rng.below(2) == 0;
            self.outside.insert(
                key,
                Outside {
                    spare,
                    remaining: bound,
                },
            );
            self.send(vec![booking(key, spare, disk)]);
            return;
        };
        let bytes = self.rng.below(work.remaining + 1);
        self.write(bytes);
        if self.rng.below(3) == 0 {
            self.outside.remove(&key);
            self.send(vec![booking(key, work.spare, DiskSpace::default())]);
        } else {
            self.outside.get_mut(&key).unwrap().remaining -= bytes;
        }
    }

    fn finish_one(&mut self) {
        let ops: Vec<OpId> = self.running.keys().copied().collect();
        if ops.is_empty() {
            return;
        }
        let op = ops[usize::try_from(self.rng.below(ops.len() as u64)).unwrap()];
        let (sandbox, step) = self.running.remove(&op).unwrap();
        let failed = self.rng.below(8) == 0 && matches!(step, Step::Fetch | Step::Save);
        if let Some(model) = self.models.get_mut(&sandbox) {
            match step {
                Step::Save => {
                    let bytes = self.rng.below(model.size.save + 1);
                    self.used += bytes;
                    self.unread += bytes;
                }
                Step::Fetch => {
                    let bytes = self.rng.below(model.size.fetch / 2);
                    model.fetched += bytes;
                    self.used += bytes;
                    self.unread += bytes;
                    if failed {
                        // Nothing more is written for this fetch.
                        model.hydrating = false;
                    }
                }
                _ => {}
            }
        }
        let outcome = if failed {
            Outcome::Failed(Failure::Transient)
        } else {
            Outcome::Done
        };
        self.send(vec![Input::Finished {
            sandbox,
            op,
            outcome,
        }]);
    }
}

/// Books `disk` for the work `key`: nothing once it is done. A spare that
/// is done is ready, holding memory and booking no disk.
fn booking(key: SandboxId, spare: bool, disk: DiskSpace) -> Input {
    if spare {
        Input::Spare {
            sandbox: key,
            bytes: MIB,
            disk,
            filling: disk != DiskSpace::default(),
        }
    } else {
        Input::Writes { key, disk }
    }
}

#[test]
fn bookings_cover_every_write_still_to_come() {
    let mut wakes = 0;
    for seed in 0..300 {
        let mut sim = Sim::new(seed);
        for _ in 0..1_500 {
            sim.step();
        }
        wakes += sim.wakes;
    }
    assert!(wakes > 3_000, "only {wakes} wakes");
}
