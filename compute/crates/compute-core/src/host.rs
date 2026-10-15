//! Every sandbox on one machine, with shared concurrency limits and memory
//! pressure handling.

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};

use crate::ids::{HoldId, OpId, SandboxId};
use crate::level::{Level, Priority, Step};
use crate::policy::{HostPolicy, PolicyError, SleepPolicy};
use crate::sandbox::{InFlight, QueueKey, Retry, Sandbox, Wake};
use crate::time::At;

/// Something that happened, fed to [`Host::handle`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// Start managing a sandbox, either newly created or found on disk after
    /// the host agent restarted. Ignored if the sandbox is already managed.
    Add {
        /// The sandbox.
        sandbox: SandboxId,
        /// Where its state is now.
        level: Level,
        /// Whether a saved memory image exists (only meaningful without a
        /// VM process).
        memory_saved: bool,
        /// When it sleeps deeper.
        policy: SleepPolicy,
    },
    /// Stop managing a sandbox and delete it.
    Remove {
        /// The sandbox.
        sandbox: SandboxId,
    },
    /// The sandbox is needed: wake it if it sleeps, and count it as activity.
    Touch {
        /// The sandbox.
        sandbox: SandboxId,
        /// How urgently.
        priority: Priority,
    },
    /// Keep the sandbox awake for a reason such as a running command, an open
    /// terminal or a declared background job. Counts as activity.
    Hold {
        /// The sandbox.
        sandbox: SandboxId,
        /// The reason; reusing an id refreshes its expiry.
        hold: HoldId,
        /// When the hold lapses on its own; `None` lasts until released.
        until: Option<At>,
        /// How urgently to wake for it.
        priority: Priority,
    },
    /// A hold ended. Counts as activity. Unknown holds are ignored.
    Release {
        /// The sandbox.
        sandbox: SandboxId,
        /// The reason that ended.
        hold: HoldId,
    },
    /// A started step finished.
    Finished {
        /// The sandbox.
        sandbox: SandboxId,
        /// The op from [`Action::Start`].
        op: OpId,
        /// How it went.
        outcome: Outcome,
    },
    /// The VM process ended unexpectedly. Files survive; running programs
    /// do not.
    Lost {
        /// The sandbox.
        sandbox: SandboxId,
    },
    /// Bytes of host memory currently available.
    Memory {
        /// Available bytes.
        available: u64,
    },
    /// Bytes of host memory one sandbox currently holds.
    Resident {
        /// The sandbox.
        sandbox: SandboxId,
        /// Resident bytes.
        bytes: u64,
    },
    /// Time passed. Call at [`Host::next_deadline`].
    Tick,
}

/// How a step ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The sandbox reached the step's target level.
    Done,
    /// The step was cancelled before it took effect; nothing changed.
    Cancelled,
    /// The step failed.
    Failed(Failure),
}

/// Why a step failed, which decides what happens next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing changed and a retry may succeed, after a backoff.
    Transient,
    /// The memory image is unusable but the files are intact. The sandbox
    /// boots fresh from its disk next time it is needed.
    MemoryLost,
    /// The sandbox cannot be recovered on this host. It is left alone until
    /// removed.
    Fatal,
}

/// Something the host agent must do, returned by [`Host::handle`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Start `step` and report back with [`Input::Finished`] for `op`.
    Start {
        /// The sandbox.
        sandbox: SandboxId,
        /// Echo this back when finished.
        op: OpId,
        /// What to do.
        step: Step,
    },
    /// Cancel `op` if that is still possible. The step must still finish with
    /// [`Outcome::Cancelled`], or with its real outcome if it was too late.
    Cancel {
        /// The sandbox.
        sandbox: SandboxId,
        /// The op to cancel.
        op: OpId,
    },
    /// Delete the sandbox's VM and local state, after any step still running
    /// for it has ended.
    Destroy {
        /// The sandbox.
        sandbox: SandboxId,
    },
    /// Report a change to the control plane.
    Notify {
        /// The sandbox.
        sandbox: SandboxId,
        /// What changed.
        notice: Notice,
    },
}

/// A change worth reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// The sandbox settled at a new level.
    Level {
        /// The new level.
        level: Level,
        /// Whether a memory image exists at that level.
        memory_saved: bool,
    },
    /// Running programs were lost; files survive.
    MemoryLost,
    /// A step failed transiently and will be retried.
    Retrying {
        /// The failed step.
        step: Step,
        /// Consecutive failures so far.
        failures: u32,
    },
    /// The sandbox cannot be recovered on this host.
    Broken,
}

/// A read-only snapshot of one sandbox's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxView {
    /// Where its state is.
    pub level: Level,
    /// Whether a saved memory image exists (levels without a VM process).
    pub memory_saved: bool,
    /// The step in flight, if any.
    pub step: Option<Step>,
    /// Whether something currently needs it awake.
    pub wants_awake: bool,
    /// Number of active holds.
    pub holds: usize,
    /// The depth memory pressure demands; [`Level::Running`] means none.
    pub floor: Level,
    /// Whether it is beyond recovery on this host.
    pub broken: bool,
}

/// The decision core for one host.
///
/// Feed it every [`Input`] with the current time; execute the [`Action`]s it
/// appends; call it again with [`Input::Tick`] at [`Host::next_deadline`].
/// At most one step runs per sandbox, each step kind respects its
/// concurrency limit, and wake steps are always admitted before sleep steps.
#[derive(Debug)]
pub struct Host {
    policy: HostPolicy,
    sandboxes: HashMap<SandboxId, Sandbox>,
    timers: BTreeSet<(At, SandboxId)>,
    queues: [BTreeSet<QueueKey>; Step::COUNT],
    in_flight: [u32; Step::COUNT],
    /// Steps still running for sandboxes that were removed.
    orphans: HashMap<OpId, Step>,
    dirty: Vec<SandboxId>,
    next_op: u64,
    available_memory: Option<u64>,
    /// Memory expected back from pressure floors not yet reached.
    pending_relief: u64,
}

impl Host {
    /// A host with no sandboxes.
    pub fn new(policy: HostPolicy) -> Result<Self, PolicyError> {
        policy.validate()?;
        Ok(Self {
            policy,
            sandboxes: HashMap::new(),
            timers: BTreeSet::new(),
            queues: Default::default(),
            in_flight: [0; Step::COUNT],
            orphans: HashMap::new(),
            dirty: Vec::new(),
            next_op: 0,
            available_memory: None,
            pending_relief: 0,
        })
    }

    /// Applies `input` at time `now` and appends the resulting actions.
    pub fn handle(&mut self, now: At, input: Input, out: &mut Vec<Action>) {
        self.apply(now, input, out);
        self.fire_timers(now);
        self.reconcile_dirty(now, out);
        if self.relieve_pressure() {
            self.reconcile_dirty(now, out);
        }
        self.admit(out);
    }

    /// When to call [`Host::handle`] with [`Input::Tick`] next.
    #[must_use]
    pub fn next_deadline(&self) -> Option<At> {
        self.timers.first().map(|(at, _)| *at)
    }

    /// The state of one sandbox.
    #[must_use]
    pub fn sandbox(&self, id: SandboxId) -> Option<SandboxView> {
        self.sandboxes.get(&id).map(|sandbox| SandboxView {
            level: sandbox.level,
            memory_saved: sandbox.memory_saved,
            step: sandbox.in_flight.map(|flight| flight.step),
            wants_awake: sandbox.wants_awake(),
            holds: sandbox.holds.len(),
            floor: sandbox.floor,
            broken: sandbox.broken,
        })
    }

    /// Ids of all managed sandboxes, in no particular order.
    pub fn sandbox_ids(&self) -> impl Iterator<Item = SandboxId> + '_ {
        self.sandboxes.keys().copied()
    }

    /// Number of managed sandboxes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.sandboxes.len()
    }

    /// Whether no sandboxes are managed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sandboxes.is_empty()
    }

    /// Steps of kind `step` currently running, including those of removed
    /// sandboxes that have not finished yet.
    #[must_use]
    pub fn in_flight(&self, step: Step) -> u32 {
        self.in_flight[step.index()]
    }

    fn apply(&mut self, now: At, input: Input, out: &mut Vec<Action>) {
        match input {
            Input::Add {
                sandbox,
                level,
                memory_saved,
                policy,
            } => {
                if let Entry::Vacant(entry) = self.sandboxes.entry(sandbox) {
                    entry.insert(Sandbox::new(now, level, memory_saved, policy));
                    self.mark(sandbox);
                }
            }
            Input::Remove { sandbox } => self.remove(sandbox, out),
            Input::Touch { sandbox, priority } => {
                if let Some(state) = self.sandboxes.get_mut(&sandbox) {
                    state.touch(now);
                    state.request_wake(priority, now);
                    self.mark(sandbox);
                }
            }
            Input::Hold {
                sandbox,
                hold,
                until,
                priority,
            } => {
                if let Some(state) = self.sandboxes.get_mut(&sandbox) {
                    state.holds.insert(hold, until);
                    state.touch(now);
                    if state.level != Level::Running || state.in_flight.is_some() {
                        state.request_wake(priority, now);
                    }
                    self.mark(sandbox);
                }
            }
            Input::Release { sandbox, hold } => {
                if let Some(state) = self.sandboxes.get_mut(&sandbox)
                    && state.holds.remove(&hold).is_some()
                {
                    state.touch(now);
                    self.mark(sandbox);
                }
            }
            Input::Finished {
                sandbox,
                op,
                outcome,
            } => self.finish(now, sandbox, op, outcome, out),
            Input::Lost { sandbox } => {
                if let Some(state) = self.sandboxes.get_mut(&sandbox) {
                    if state.in_flight.is_some() {
                        state.process_lost = true;
                    } else if state.level.has_process() {
                        state.lose_memory();
                        out.push(Action::Notify {
                            sandbox,
                            notice: Notice::MemoryLost,
                        });
                        out.push(level_notice(sandbox, state));
                    }
                    self.mark(sandbox);
                }
            }
            Input::Memory { available } => self.available_memory = Some(available),
            Input::Resident { sandbox, bytes } => {
                if let Some(state) = self.sandboxes.get_mut(&sandbox) {
                    state.resident = bytes;
                }
            }
            Input::Tick => {}
        }
    }

    fn finish(
        &mut self,
        now: At,
        id: SandboxId,
        op: OpId,
        outcome: Outcome,
        out: &mut Vec<Action>,
    ) {
        if let Some(step) = self.orphans.remove(&op) {
            self.in_flight[step.index()] -= 1;
            return;
        }
        let Some(state) = self.sandboxes.get_mut(&id) else {
            return;
        };
        let Some(flight) = state.in_flight.filter(|flight| flight.op == op) else {
            return;
        };
        state.in_flight = None;
        self.in_flight[flight.step.index()] -= 1;
        let before = (state.level, state.memory_saved);
        let mut lost = false;
        match outcome {
            Outcome::Done => {
                state.level = flight.step.target();
                if flight.step == Step::Save {
                    state.memory_saved = true;
                }
                if flight.step.wakes() && state.level == Level::Running {
                    state.touch(now);
                }
                state.retry = None;
            }
            Outcome::Cancelled => {}
            Outcome::Failed(Failure::Transient) => {
                let failures = state
                    .retry
                    .map_or(1, |retry| retry.failures.saturating_add(1));
                let backoff = if flight.step.wakes() {
                    self.policy.wake_backoff
                } else {
                    self.policy.sleep_backoff
                };
                state.retry = Some(Retry {
                    failures,
                    not_before: now + backoff.delay(failures),
                });
                out.push(Action::Notify {
                    sandbox: id,
                    notice: Notice::Retrying {
                        step: flight.step,
                        failures,
                    },
                });
            }
            Outcome::Failed(Failure::MemoryLost) => lost |= state.lose_memory(),
            Outcome::Failed(Failure::Fatal) => {
                state.broken = true;
                out.push(Action::Notify {
                    sandbox: id,
                    notice: Notice::Broken,
                });
            }
        }
        if std::mem::take(&mut state.process_lost) && state.level.has_process() {
            lost |= state.lose_memory();
        }
        if lost {
            state.retry = None;
            out.push(Action::Notify {
                sandbox: id,
                notice: Notice::MemoryLost,
            });
        }
        if state.floor != Level::Running && state.level >= state.floor {
            self.pending_relief = self.pending_relief.saturating_sub(state.floor_relief);
            state.floor = Level::Running;
            state.floor_relief = 0;
        }
        if (state.level, state.memory_saved) != before {
            out.push(level_notice(id, state));
        }
        self.mark(id);
    }

    fn remove(&mut self, id: SandboxId, out: &mut Vec<Action>) {
        let Some(state) = self.sandboxes.remove(&id) else {
            return;
        };
        if let Some(flight) = state.in_flight {
            self.orphans.insert(flight.op, flight.step);
            if !flight.cancel_sent {
                out.push(Action::Cancel {
                    sandbox: id,
                    op: flight.op,
                });
            }
        }
        if let Some((step, key)) = state.queued {
            self.queues[step.index()].remove(&key);
        }
        if let Some(at) = state.timer {
            self.timers.remove(&(at, id));
        }
        self.pending_relief = self.pending_relief.saturating_sub(state.floor_relief);
        out.push(Action::Destroy { sandbox: id });
    }

    fn mark(&mut self, id: SandboxId) {
        if let Some(state) = self.sandboxes.get_mut(&id)
            && !state.dirty
        {
            state.dirty = true;
            self.dirty.push(id);
        }
    }

    fn fire_timers(&mut self, now: At) {
        while let Some(&(at, id)) = self.timers.first() {
            if at > now {
                break;
            }
            self.timers.pop_first();
            if let Some(state) = self.sandboxes.get_mut(&id) {
                state.timer = None;
            }
            self.mark(id);
        }
    }

    fn reconcile_dirty(&mut self, now: At, out: &mut Vec<Action>) {
        let mut dirty = std::mem::take(&mut self.dirty);
        for id in dirty.drain(..) {
            self.reconcile(id, now, out);
        }
        self.dirty = dirty;
    }

    /// Brings one sandbox's derived state up to date: wake bookkeeping,
    /// cancellation, its queue entry and its timer.
    fn reconcile(&mut self, id: SandboxId, now: At, out: &mut Vec<Action>) {
        let Some(state) = self.sandboxes.get_mut(&id) else {
            return;
        };
        state.dirty = false;
        state.expire_holds(now);
        if state.level == Level::Running && state.in_flight.is_none() {
            state.wake = None;
        } else if state.wake.is_none() && !state.holds.is_empty() {
            state.wake = Some(Wake {
                priority: Priority::Interactive,
                since: now,
            });
        }
        if state.wants_awake() {
            if state.floor != Level::Running {
                self.pending_relief = self.pending_relief.saturating_sub(state.floor_relief);
                state.floor = Level::Running;
                state.floor_relief = 0;
            }
            if let Some(flight) = &mut state.in_flight
                && !flight.step.wakes()
                && !flight.cancel_sent
            {
                flight.cancel_sent = true;
                out.push(Action::Cancel {
                    sandbox: id,
                    op: flight.op,
                });
            }
        }
        let wanted = state
            .next_step(now)
            .map(|step| (step, state.queue_key(id, step, now)));
        if wanted != state.queued {
            if let Some((step, key)) = state.queued {
                self.queues[step.index()].remove(&key);
            }
            if let Some((step, key)) = wanted {
                self.queues[step.index()].insert(key);
            }
            state.queued = wanted;
        }
        let deadline = state.next_deadline(now);
        if deadline != state.timer {
            if let Some(at) = state.timer {
                self.timers.remove(&(at, id));
            }
            if let Some(at) = deadline {
                self.timers.insert((at, id));
            }
            state.timer = deadline;
        }
    }

    /// Starts queued steps while their limits allow, wake steps first.
    fn admit(&mut self, out: &mut Vec<Action>) {
        for step in Step::ALL {
            let index = step.index();
            let limit = self.policy.limits.get(step);
            while self.in_flight[index] < limit {
                let Some(key) = self.queues[index].pop_first() else {
                    break;
                };
                let Some(state) = self.sandboxes.get_mut(&key.sandbox) else {
                    continue;
                };
                debug_assert_eq!(state.queued, Some((step, key)));
                state.queued = None;
                let op = OpId(self.next_op);
                self.next_op += 1;
                state.in_flight = Some(InFlight {
                    op,
                    step,
                    cancel_sent: false,
                });
                self.in_flight[index] += 1;
                out.push(Action::Start {
                    sandbox: key.sandbox,
                    op,
                    step,
                });
            }
        }
    }

    /// When available memory drops below the low watermark, pushes the least
    /// recently used idle sandboxes deeper until the expected available
    /// memory reaches the high watermark. Returns whether any floor changed.
    fn relieve_pressure(&mut self) -> bool {
        let (Some(memory), Some(available)) = (self.policy.memory, self.available_memory) else {
            return false;
        };
        if available >= memory.low_watermark {
            return false;
        }
        let mut needed = memory
            .high_watermark
            .saturating_sub(available)
            .saturating_sub(self.pending_relief);
        if needed == 0 {
            return false;
        }
        let mut candidates: Vec<(At, SandboxId, Level, u64)> = self
            .sandboxes
            .iter()
            .filter(|(_, state)| !state.broken && !state.wants_awake() && state.resident > 0)
            .filter_map(|(id, state)| {
                let reached = state.level.max(state.floor);
                let target = state.policy.relief_target(reached)?;
                let relief = state.relief_between(reached, target, memory.compressed_percent);
                (relief > 0).then_some((state.last_activity, *id, target, relief))
            })
            .collect();
        candidates.sort_unstable();
        let mut changed = false;
        for (_, id, target, relief) in candidates {
            if needed == 0 {
                break;
            }
            let Some(state) = self.sandboxes.get_mut(&id) else {
                continue;
            };
            state.floor = target;
            state.floor_relief += relief;
            self.pending_relief += relief;
            needed = needed.saturating_sub(relief);
            changed = true;
            self.mark(id);
        }
        changed
    }
}

fn level_notice(sandbox: SandboxId, state: &Sandbox) -> Action {
    Action::Notify {
        sandbox,
        notice: Notice::Level {
            level: state.level,
            memory_saved: state.memory_saved,
        },
    }
}
