//! Randomized simulation: a fake engine with random delays, failures, crashes,
//! removals and memory pressure. After every input it checks the core's
//! invariants against an independent model of the true state, including that
//! running programs are lost only when a failure leaves no saved copy. At the
//! end it checks that every sandbox settles where its policy says and wakes
//! when asked.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use compute_core::{
    Action, At, Durability, Failure, HoldId, Host, HostPolicy, Input, Level, MemoryPolicy, Notice,
    OpId, Outcome, Priority, SandboxId, SleepPolicy, SleepRules, State, Step, StepLimits,
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

fn policies() -> [SleepPolicy; 5] {
    let s = Duration::from_secs;
    let policy = |rules| SleepPolicy::new(rules).unwrap();
    [
        policy(SleepRules::RECOMMENDED),
        // A nested host: huge pages cannot be compressed.
        policy(SleepRules {
            compress_under_pressure: false,
            ..SleepRules::RECOMMENDED
        }),
        // Ends processes on a timer, without object storage.
        policy(SleepRules {
            pause_after: Some(s(5)),
            save_after: Some(s(20)),
            drop_after: Some(s(60)),
            forget_after: Some(s(3600)),
            ..SleepRules::NEVER
        }),
        // Pauses only; pressure may compress it.
        policy(SleepRules {
            pause_after: Some(s(10)),
            compress_under_pressure: true,
            ..SleepRules::NEVER
        }),
        SleepPolicy::NEVER,
    ]
}

/// Every consistent state.
fn states() -> Vec<State> {
    let mut states = Vec::new();
    for level in Level::ALL {
        for durability in [Durability::Volatile, Durability::Local, Durability::Remote] {
            for memory_saved in [false, true] {
                let state = State::new(level, durability, memory_saved);
                if !states.contains(&state) {
                    states.push(state);
                }
            }
        }
    }
    states
}

/// What is really true about a sandbox, maintained independently of the core.
#[expect(
    clippy::struct_excessive_bools,
    reason = "a flat test model is easiest to audit"
)]
struct Truth {
    state: State,
    policy: SleepPolicy,
    op: Option<(OpId, Step)>,
    holds: BTreeMap<HoldId, Option<At>>,
    wake_pending: bool,
    process_lost: bool,
    broken: bool,
    woke: bool,
    /// Losses of running programs the core has yet to report.
    unreported_losses: u32,
    /// Latest resident memory reported to the core.
    resident: u64,
}

impl Truth {
    fn held(&self, now: At) -> bool {
        self.holds
            .values()
            .any(|until| until.is_none_or(|until| until > now))
    }

    /// Applies a loss computed by the model and expects it to be reported.
    fn settle(&mut self, (state, lost): (State, bool)) {
        self.state = state;
        self.unreported_losses += u32::from(lost);
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
    /// Steps started, by kind, so the test can prove it reached every path.
    started: [u64; Step::COUNT],
    /// Losses of running programs, to prove failures were exercised.
    losses: u64,
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
            started: [0; Step::COUNT],
            losses: 0,
        }
    }

    fn send(&mut self, input: Input) {
        self.send_all(vec![input]);
    }

    fn send_all(&mut self, inputs: Vec<Input>) {
        let mut out = Vec::new();
        self.host.handle_all(self.now, inputs, &mut out);
        for action in out {
            self.act(action);
        }
        self.check();
    }

    fn act(&mut self, action: Action) {
        match action {
            Action::Start { sandbox, op, step } => {
                let now = self.now;
                self.started[step.index()] += 1;
                let truth = self
                    .live
                    .get_mut(&sandbox)
                    .expect("start for a live sandbox");
                assert!(truth.op.is_none(), "two steps at once for {sandbox:?}");
                assert!(!truth.broken, "step for a broken sandbox");
                assert!(
                    step.can_start(truth.state),
                    "{step:?} cannot start from {:?}",
                    truth.state
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
                let Some(truth) = self.live.get_mut(&sandbox) else {
                    return;
                };
                match notice {
                    Notice::State(state) => {
                        assert_eq!(state, truth.state, "{sandbox:?}");
                        truth.woke |= state.level == Level::Running;
                    }
                    Notice::MemoryLost => {
                        assert!(
                            truth.unreported_losses > 0,
                            "{sandbox:?} reported a loss that did not happen"
                        );
                        truth.unreported_losses -= 1;
                        self.losses += 1;
                    }
                    Notice::Retrying { .. } | Notice::Broken => {}
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
            if pending.step == Step::Resume
                && matches!(
                    outcome,
                    Outcome::Failed(Failure::MemoryLost | Failure::Fatal)
                )
            {
                // The guest may have run, so the saved copy is stale. A
                // refused or cancelled resume changed nothing.
                truth.state = State::new(truth.state.level, Durability::Volatile, false);
            }
            match outcome {
                Outcome::Done => truth.state = pending.step.apply(truth.state),
                Outcome::Cancelled | Outcome::Failed(Failure::Transient) => {}
                Outcome::Failed(Failure::MemoryLost) => {
                    truth.settle(truth.state.without_memory_image());
                }
                Outcome::Failed(Failure::Fatal) => truth.broken = true,
            }
            if std::mem::take(&mut truth.process_lost) {
                truth.settle(truth.state.without_process());
            }
            if truth.state.level == Level::Running {
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
        let mut protected_resident = 0;
        for (id, truth) in &self.live {
            let view = self.host.sandbox(*id).expect("live sandbox is managed");
            assert_eq!(view.state, truth.state, "{id:?} state");
            assert!(view.state.is_consistent(), "{id:?} {:?}", view.state);
            assert_eq!(view.step, truth.op.map(|(_, step)| step), "{id:?} step");
            assert_eq!(view.broken, truth.broken, "{id:?} broken");
            assert_eq!(truth.unreported_losses, 0, "{id:?} lost programs silently");
            if matches!(truth.state.level, Level::Paused | Level::Compressed)
                && truth.state.durability != Durability::Volatile
            {
                protected_resident += truth.resident;
            }
        }
        assert!(self.host.reclaimable_memory() <= protected_resident);
    }

    fn add(&mut self) {
        self.next_id += 1;
        let id = SandboxId(self.next_id);
        let policy = self.rng.pick(&policies());
        let state = self.rng.pick(&states());
        self.live.insert(
            id,
            Truth {
                state,
                policy,
                op: None,
                holds: BTreeMap::new(),
                wake_pending: false,
                process_lost: false,
                broken: false,
                woke: false,
                unreported_losses: 0,
                resident: 0,
            },
        );
        self.send(Input::Add {
            sandbox: id,
            state,
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
                if truth.state.level != Level::Running || truth.op.is_some() {
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
                if truth.state.level != Level::Running || truth.op.is_some() {
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
                if truth.state.level.has_process() {
                    if truth.op.is_some() {
                        truth.process_lost = true;
                    } else {
                        truth.settle(truth.state.without_process());
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
                self.live.get_mut(&id).unwrap().resident = bytes;
                self.send(Input::Resident { sandbox: id, bytes });
            }
            85..90 => {
                self.live.remove(&id);
                self.send(Input::Remove { sandbox: id });
            }
            90..95 => self.add(),
            95..98 => {
                let level = self.rng.pick(&Level::ALL);
                self.send(Input::Sleep { sandbox: id, level });
            }
            98..100 => {
                // One sweep of processor readings arrives as one batch.
                let mut batch = vec![Input::Busy { sandbox: id }];
                for _ in 0..self.rng.below(3) {
                    if let Some(sandbox) = self.random_sandbox() {
                        batch.push(Input::Busy { sandbox });
                    }
                }
                self.send_all(batch);
            }
            _ => {}
        }
    }
}

/// Runs one seeded simulation and returns how often each step started and
/// how many times running programs were lost.
fn run(seed: u64, events: usize) -> ([u64; Step::COUNT], u64) {
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
            let settled = Duration::from_secs(300 * 86_400);
            assert_eq!(
                truth.policy.next_step(truth.state, settled, Level::Running),
                None,
                "seed {seed}: {id:?} has not settled at {:?}",
                truth.state
            );
        }
    }

    // Wake phase: everything that is not broken wakes when touched.
    let ids: BTreeSet<SandboxId> = world.live.keys().copied().collect();
    for id in &ids {
        let truth = world.live.get_mut(id).unwrap();
        truth.woke = truth.state.level == Level::Running;
        if truth.state.level != Level::Running {
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
            truth.state
        );
    }
    (world.started, world.losses)
}

#[test]
fn random_interleavings_keep_every_invariant() {
    let mut started = [0; Step::COUNT];
    let mut losses = 0;
    for seed in 0..400 {
        let (counts, lost) = run(seed, 600);
        for (total, count) in started.iter_mut().zip(counts) {
            *total += count;
        }
        losses += lost;
    }
    // The simulation proves little unless it reaches every path.
    for step in Step::ALL {
        assert!(
            started[step.index()] >= 100,
            "{step:?} started only {} times",
            started[step.index()]
        );
    }
    assert!(losses >= 100, "only {losses} losses");
}
