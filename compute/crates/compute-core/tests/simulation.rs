//! Randomized simulation: a fake engine with random delays, failures, crashes,
//! removals and memory pressure. After every input it checks the core's
//! invariants against an independent model of the true state, and at the end
//! it checks that every sandbox settles where its policy says and wakes when
//! asked.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use compute_core::{
    Action, At, Failure, HoldId, Host, HostPolicy, Input, Level, MemoryPolicy, Notice, OpId,
    Outcome, Priority, SandboxId, SleepPolicy, Step, StepLimits,
};

const GIB: u64 = 1 << 30;

/// `SplitMix64`: tiny, fast and good enough for test randomness.
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
        self.next() % n
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[usize::try_from(self.below(items.len() as u64)).unwrap()]
    }
}

fn policies() -> [SleepPolicy; 4] {
    let s = Duration::from_secs;
    [
        SleepPolicy::new([
            (Level::Paused, s(30)),
            (Level::Compressed, s(120)),
            (Level::Saved, s(900)),
            (Level::Archived, s(3600)),
            (Level::Remote, s(86_400)),
        ])
        .unwrap(),
        SleepPolicy::new([(Level::Paused, s(5)), (Level::Saved, s(60))]).unwrap(),
        SleepPolicy::new([(Level::Paused, s(10))]).unwrap(),
        SleepPolicy::NEVER,
    ]
}

/// What is really true about a sandbox, maintained independently of the core.
#[expect(
    clippy::struct_excessive_bools,
    reason = "a flat test model is easiest to audit"
)]
struct Truth {
    level: Level,
    memory_saved: bool,
    policy: SleepPolicy,
    op: Option<(OpId, Step)>,
    holds: BTreeMap<HoldId, Option<At>>,
    wake_pending: bool,
    process_lost: bool,
    broken: bool,
    woke: bool,
}

impl Truth {
    fn held(&self, now: At) -> bool {
        self.holds
            .values()
            .any(|until| until.is_none_or(|until| until > now))
    }

    fn lose_memory(&mut self) {
        if self.level.has_process() {
            self.level = Level::Saved;
        }
        self.memory_saved = false;
    }
}

#[derive(Clone, Copy)]
struct Pending {
    at: At,
    sandbox: SandboxId,
    op: OpId,
    step: Step,
    cancel: bool,
}

struct World {
    host: Host,
    limits: StepLimits,
    now: At,
    rng: Rng,
    live: BTreeMap<SandboxId, Truth>,
    pending: Vec<Pending>,
    failures: bool,
    next_id: u128,
    next_hold: u64,
}

impl World {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed);
        let limits = StepLimits::uniform(1 + u32::try_from(rng.below(6)).unwrap())
            .with(Step::Resume, 1 + u32::try_from(rng.below(10)).unwrap());
        let policy = HostPolicy {
            limits,
            memory: Some(MemoryPolicy {
                low_watermark: 8 * GIB,
                high_watermark: 10 * GIB,
                compressed_percent: 30,
            }),
            ..HostPolicy::default()
        };
        Self {
            host: Host::new(policy).unwrap(),
            limits,
            now: At::ZERO,
            rng,
            live: BTreeMap::new(),
            pending: Vec::new(),
            failures: true,
            next_id: 0,
            next_hold: 0,
        }
    }

    fn send(&mut self, input: Input) {
        let mut out = Vec::new();
        self.host.handle(self.now, input, &mut out);
        for action in out {
            self.act(action);
        }
        self.check();
    }

    fn act(&mut self, action: Action) {
        match action {
            Action::Start { sandbox, op, step } => {
                let now = self.now;
                let truth = self
                    .live
                    .get_mut(&sandbox)
                    .expect("start for a live sandbox");
                assert!(truth.op.is_none(), "two steps at once for {sandbox:?}");
                assert!(!truth.broken, "step for a broken sandbox");
                assert!(
                    step.can_start(truth.level, truth.memory_saved),
                    "{step:?} cannot start from {:?} (memory saved: {})",
                    truth.level,
                    truth.memory_saved
                );
                if !step.wakes() {
                    assert!(!truth.held(now), "sleep step {step:?} while held");
                    assert!(
                        !truth.wake_pending,
                        "sleep step {step:?} while a wake is pending"
                    );
                }
                truth.op = Some((op, step));
                let delay = Duration::from_millis(1 + self.rng.below(3000));
                self.pending.push(Pending {
                    at: now + delay,
                    sandbox,
                    op,
                    step,
                    cancel: false,
                });
            }
            Action::Cancel { op, .. } => {
                if let Some(pending) = self.pending.iter_mut().find(|p| p.op == op) {
                    pending.cancel = true;
                }
            }
            Action::Destroy { sandbox } => assert!(!self.live.contains_key(&sandbox)),
            Action::Notify { sandbox, notice } => {
                if let (
                    Notice::Level {
                        level,
                        memory_saved,
                    },
                    Some(truth),
                ) = (notice, self.live.get_mut(&sandbox))
                {
                    assert_eq!((level, memory_saved), (truth.level, truth.memory_saved));
                    truth.woke |= level == Level::Running;
                }
            }
        }
    }

    fn complete(&mut self, pending: Pending) {
        let outcome = if pending.cancel && self.rng.chance(60) {
            Outcome::Cancelled
        } else if !self.failures {
            Outcome::Done
        } else {
            match self.rng.below(1000) {
                0..900 => Outcome::Done,
                900..960 => Outcome::Failed(Failure::Transient),
                960..995 => Outcome::Failed(Failure::MemoryLost),
                _ => Outcome::Failed(Failure::Fatal),
            }
        };
        if let Some(truth) = self.live.get_mut(&pending.sandbox)
            && truth.op.is_some_and(|(op, _)| op == pending.op)
        {
            truth.op = None;
            match outcome {
                Outcome::Done => {
                    truth.level = pending.step.target();
                    if pending.step == Step::Save {
                        truth.memory_saved = true;
                    }
                }
                Outcome::Cancelled | Outcome::Failed(Failure::Transient) => {}
                Outcome::Failed(Failure::MemoryLost) => truth.lose_memory(),
                Outcome::Failed(Failure::Fatal) => truth.broken = true,
            }
            if std::mem::take(&mut truth.process_lost) && truth.level.has_process() {
                truth.lose_memory();
            }
            if truth.level == Level::Running {
                truth.wake_pending = false;
            }
        }
        self.send(Input::Finished {
            sandbox: pending.sandbox,
            op: pending.op,
            outcome,
        });
    }

    /// Processes completions and timers in time order up to `to`.
    fn advance(&mut self, to: At) {
        loop {
            let next_completion = self.pending.iter().map(|p| p.at).min();
            let next = [next_completion, self.host.next_deadline()]
                .into_iter()
                .flatten()
                .min();
            let Some(next) = next.filter(|at| *at <= to) else {
                break;
            };
            self.now = self.now.max(next);
            if next_completion == Some(next) {
                let index = self.pending.iter().position(|p| p.at == next).unwrap();
                let pending = self.pending.swap_remove(index);
                self.complete(pending);
            } else {
                self.send(Input::Tick);
            }
        }
        self.now = self.now.max(to);
        let now = self.now;
        for truth in self.live.values_mut() {
            truth
                .holds
                .retain(|_, until| until.is_none_or(|until| until > now));
        }
    }

    fn check(&self) {
        for step in Step::ALL {
            let running = self.pending.iter().filter(|p| p.step == step).count();
            assert_eq!(
                u32::try_from(running).unwrap(),
                self.host.in_flight(step),
                "{step:?} count"
            );
            assert!(
                self.host.in_flight(step) <= self.limits.get(step),
                "{step:?} over its limit"
            );
        }
        assert_eq!(self.host.len(), self.live.len());
        for (id, truth) in &self.live {
            let view = self.host.sandbox(*id).expect("live sandbox is managed");
            assert_eq!(view.level, truth.level, "{id:?} level");
            if !truth.level.has_process() {
                assert_eq!(view.memory_saved, truth.memory_saved, "{id:?} memory image");
            }
            assert_eq!(view.step, truth.op.map(|(_, step)| step), "{id:?} step");
            assert_eq!(view.broken, truth.broken, "{id:?} broken");
        }
    }

    fn add(&mut self) {
        self.next_id += 1;
        let id = SandboxId(self.next_id);
        let policy = self.rng.pick(&policies());
        let level = self.rng.pick(&Level::ALL);
        let memory_saved = !level.has_process() && self.rng.chance(70);
        self.live.insert(
            id,
            Truth {
                level,
                memory_saved,
                policy,
                op: None,
                holds: BTreeMap::new(),
                wake_pending: false,
                process_lost: false,
                broken: false,
                woke: false,
            },
        );
        self.send(Input::Add {
            sandbox: id,
            level,
            memory_saved,
            policy,
        });
    }

    fn random_sandbox(&mut self) -> Option<SandboxId> {
        let ids: Vec<SandboxId> = self.live.keys().copied().collect();
        (!ids.is_empty()).then(|| self.rng.pick(&ids))
    }

    fn random_input(&mut self) {
        let Some(id) = self.random_sandbox() else {
            self.add();
            return;
        };
        let priority = self.rng.pick(&[
            Priority::Interactive,
            Priority::Proactive,
            Priority::Background,
        ]);
        match self.rng.below(100) {
            0..30 => {
                let truth = self.live.get_mut(&id).unwrap();
                if truth.level != Level::Running || truth.op.is_some() {
                    truth.wake_pending = true;
                }
                self.send(Input::Touch {
                    sandbox: id,
                    priority,
                });
            }
            30..45 => {
                self.next_hold += 1;
                let hold = HoldId(self.next_hold);
                let until = self
                    .rng
                    .chance(50)
                    .then(|| self.now + Duration::from_millis(1 + self.rng.below(120_000)));
                let truth = self.live.get_mut(&id).unwrap();
                truth.holds.insert(hold, until);
                if truth.level != Level::Running || truth.op.is_some() {
                    truth.wake_pending = true;
                }
                self.send(Input::Hold {
                    sandbox: id,
                    hold,
                    until,
                    priority,
                });
            }
            45..60 => {
                let truth = self.live.get_mut(&id).unwrap();
                if let Some(hold) = truth.holds.keys().next().copied() {
                    truth.holds.remove(&hold);
                    self.send(Input::Release { sandbox: id, hold });
                }
            }
            60..65 => {
                let truth = self.live.get_mut(&id).unwrap();
                if truth.level.has_process() {
                    if truth.op.is_some() {
                        truth.process_lost = true;
                    } else {
                        truth.lose_memory();
                    }
                    self.send(Input::Lost { sandbox: id });
                }
            }
            65..75 => {
                let available = 4 * GIB + self.rng.below(12 * GIB);
                self.send(Input::Memory { available });
            }
            75..85 => {
                let bytes = 100 << 20 | self.rng.below(2 * GIB);
                self.send(Input::Resident { sandbox: id, bytes });
            }
            85..90 => {
                self.live.remove(&id);
                self.send(Input::Remove { sandbox: id });
            }
            90..95 => self.add(),
            _ => {}
        }
    }
}

fn run(seed: u64, events: usize) {
    let mut world = World::new(seed);
    for _ in 0..8 {
        world.add();
    }
    for _ in 0..events {
        world.random_input();
        let step = Duration::from_millis(world.rng.below(20_000));
        world.advance(world.now + step);
    }

    // Quiet phase: no failures, no holds, plenty of memory, a long time.
    world.failures = false;
    world.send(Input::Memory {
        available: 64 * GIB,
    });
    let holds: Vec<(SandboxId, HoldId)> = world
        .live
        .iter()
        .flat_map(|(id, truth)| truth.holds.keys().map(move |hold| (*id, *hold)))
        .collect();
    for (sandbox, hold) in holds {
        world.live.get_mut(&sandbox).unwrap().holds.remove(&hold);
        world.send(Input::Release { sandbox, hold });
    }
    world.advance(world.now + Duration::from_secs(400 * 86_400));
    assert!(
        world.pending.is_empty(),
        "seed {seed}: steps still running when idle"
    );
    for (id, truth) in &world.live {
        if !truth.broken {
            let deepest = truth.policy.deepest_after(Duration::MAX);
            assert!(
                truth.level >= deepest,
                "seed {seed}: {id:?} at {:?}, expected {deepest:?}",
                truth.level
            );
        }
    }

    // Wake phase: everything that is not broken wakes when touched.
    let ids: BTreeSet<SandboxId> = world.live.keys().copied().collect();
    for id in &ids {
        let truth = world.live.get_mut(id).unwrap();
        truth.woke = truth.level == Level::Running;
        if truth.level != Level::Running {
            truth.wake_pending = true;
        }
        world.send(Input::Touch {
            sandbox: *id,
            priority: Priority::Interactive,
        });
    }
    world.advance(world.now + Duration::from_secs(3600));
    for (id, truth) in &world.live {
        assert!(
            truth.broken || truth.woke,
            "seed {seed}: {id:?} never woke, stuck at {:?}",
            truth.level
        );
    }
}

#[test]
fn random_interleavings_keep_every_invariant() {
    for seed in 0..400 {
        run(seed, 600);
    }
}
