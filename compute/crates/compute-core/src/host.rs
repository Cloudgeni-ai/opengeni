//! Every sandbox on one machine, with shared concurrency limits and memory
//! pressure handling.

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};

use crate::ids::{HoldId, OpId, SandboxId};
use crate::level::{Level, Priority, State, Step};
use crate::policy::{HostPolicy, PolicyError, SleepPolicy};
use crate::sandbox::{InFlight, QueueKey, Sandbox, Wake};
use crate::time::At;

/// Something that happened, fed to [`Host::handle`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// Start managing a sandbox, either newly created or found on disk after
    /// the host agent restarted. Ignored if the sandbox is already managed.
    Add {
        /// The sandbox.
        sandbox: SandboxId,
        /// Where its state is now. Inconsistent combinations are corrected
        /// as [`State::new`] does.
        state: State,
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
    /// The sandbox did work on its own while running, such as a build using
    /// its processors. Counts as activity only while it runs with no step in
    /// progress: it never wakes the sandbox, never cancels an
    /// [`Input::Sleep`] request, and a step already putting the sandbox to
    /// sleep goes ahead.
    Busy {
        /// The sandbox.
        sandbox: SandboxId,
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
    /// The VM process ended unexpectedly. Files survive, and so do running
    /// programs if a current copy was saved.
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
    /// Put the sandbox at least as deep as `level` now, whatever its sleep
    /// rules say, for example to drain the host or to benchmark a level.
    /// It waits while something holds the sandbox awake; a later
    /// [`Input::Touch`] or [`Input::Hold`] cancels it, and so does reaching
    /// the level. A request made while the sandbox is waking applies once
    /// that wake is done. [`Level::Running`] cancels an earlier request.
    Sleep {
        /// The sandbox.
        sandbox: SandboxId,
        /// The least depth to reach.
        level: Level,
    },
    /// Time passed. Call at [`Host::next_deadline`].
    Tick,
}

/// How a step ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The sandbox reached the step's target level.
    Done,
    /// The step was cancelled before it took effect; nothing changed. The
    /// host agent reports this only when that is certain.
    Cancelled,
    /// The step failed.
    Failed(Failure),
}

/// Why a step failed, which decides what happens next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing changed and a retry may succeed, after a backoff. The host
    /// agent reports this only when that is certain; a failure whose effect
    /// on the VM is unknown is [`Failure::MemoryLost`].
    Transient,
    /// Like [`Failure::Transient`], except that the host could not keep the
    /// records vouching for the sandbox's saved copies, so they are no
    /// longer trusted. This happens when a step takes those records away
    /// before letting the guest run, as a resume or restore does, is refused,
    /// and then cannot put them back. A VM process is unaffected; without
    /// one, the files on local disk remain. See
    /// [`State::without_saved_copies`](crate::State::without_saved_copies).
    Untrusted,
    /// Like [`Failure::Untrusted`], except that the host did put back the
    /// record vouching for the copy on local disk, so only the copy in
    /// object storage is no longer trusted. Nothing is lost and the step can
    /// be retried from the local copy. See
    /// [`State::without_remote_copy`](crate::State::without_remote_copy).
    RemoteUntrusted,
    /// For a step on a VM process: the process is gone. A current saved
    /// copy takes its place; without one, only the files survive. For any
    /// other step: the memory image is unusable but the files are intact,
    /// so the sandbox boots fresh from its disk next time it is needed.
    /// The host agent reports this only once the process has ended, so a
    /// replacement never runs beside it.
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
    /// The sandbox's state changed: its level, its saved copies, or both.
    State(State),
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
    pub state: State,
    /// The step in flight, if any.
    pub step: Option<Step>,
    /// Whether something currently needs it awake.
    pub wants_awake: bool,
    /// Number of active holds.
    pub holds: usize,
    /// Its last activity.
    pub last_activity: At,
    /// The depth memory pressure demands; [`Level::Running`] means none.
    pub floor: Level,
    /// The depth asked for by [`Input::Sleep`]; [`Level::Running`] means
    /// none.
    pub requested: Level,
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
    /// Memory expected back from pressure floors reached since the last
    /// [`Input::Memory`] reading, which may not show it yet. Counting it
    /// prevents freeing the same shortfall twice.
    settled_relief: u64,
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
            settled_relief: 0,
        })
    }

    /// Applies `input` at time `now` and appends the resulting actions.
    pub fn handle(&mut self, now: At, input: Input, out: &mut Vec<Action>) {
        self.handle_all(now, [input], out);
    }

    /// Applies several inputs observed together at time `now`, then decides
    /// once. Use it for readings taken in one sweep, such as [`Input::Busy`]
    /// for every sandbox that used its processors: deciding after each one
    /// would let a sleep timer fire for a sandbox whose own reading has not
    /// been applied yet.
    pub fn handle_all(
        &mut self,
        now: At,
        inputs: impl IntoIterator<Item = Input>,
        out: &mut Vec<Action>,
    ) {
        for input in inputs {
            self.apply(now, input, out);
        }
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
            state: sandbox.state,
            step: sandbox.in_flight.map(|flight| flight.step),
            wants_awake: sandbox.wants_awake(),
            holds: sandbox.holds.len(),
            last_activity: sandbox.last_activity,
            floor: sandbox.floor,
            requested: sandbox.requested,
            broken: sandbox.broken,
        })
    }

    /// Bytes of host memory that ending VM processes could free at once,
    /// without losing anything or keeping anyone waiting: idle, paused
    /// sandboxes whose current state is already saved. Placement can count
    /// this memory as free.
    #[must_use]
    pub fn reclaimable_memory(&self) -> u64 {
        self.sandboxes
            .values()
            .filter(|sandbox| sandbox.reclaimable())
            .map(|sandbox| sandbox.resident)
            .sum()
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
                state,
                policy,
            } => {
                if let Entry::Vacant(entry) = self.sandboxes.entry(sandbox) {
                    entry.insert(Sandbox::new(now, state, policy));
                    self.mark(sandbox);
                }
            }
            Input::Remove { sandbox } => self.remove(sandbox, out),
            Input::Touch { sandbox, priority } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.touch(now);
                    slot.requested = Level::Running;
                    slot.request_wake(priority, now);
                    self.mark(sandbox);
                }
            }
            Input::Hold {
                sandbox,
                hold,
                until,
                priority,
            } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.holds.insert(hold, until);
                    slot.touch(now);
                    slot.requested = Level::Running;
                    if slot.state.level != Level::Running || slot.in_flight.is_some() {
                        slot.request_wake(priority, now);
                    }
                    self.mark(sandbox);
                }
            }
            Input::Release { sandbox, hold } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox)
                    && slot.holds.remove(&hold).is_some()
                {
                    slot.touch(now);
                    self.mark(sandbox);
                }
            }
            Input::Busy { sandbox } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox)
                    && slot.state.level == Level::Running
                    && slot.in_flight.is_none()
                {
                    slot.touch(now);
                    self.mark(sandbox);
                }
            }
            Input::Finished {
                sandbox,
                op,
                outcome,
            } => self.finish(now, sandbox, op, outcome, out),
            Input::Lost { sandbox } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    if slot.in_flight.is_some() {
                        slot.process_lost = true;
                    } else if slot.state.level.has_process() {
                        let (state, lost) = slot.state.without_process();
                        slot.state = state;
                        if lost {
                            out.push(Action::Notify {
                                sandbox,
                                notice: Notice::MemoryLost,
                            });
                        }
                        out.push(state_notice(sandbox, slot));
                    }
                    self.mark(sandbox);
                }
            }
            Input::Memory { available } => {
                self.available_memory = Some(available);
                self.settled_relief = 0;
            }
            Input::Resident { sandbox, bytes } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.resident = bytes;
                }
            }
            Input::Sleep { sandbox, level } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.request_sleep(level);
                    self.mark(sandbox);
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
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        let Some(flight) = slot.in_flight.filter(|flight| flight.op == op) else {
            return;
        };
        slot.in_flight = None;
        self.in_flight[flight.step.index()] -= 1;
        let before = slot.state;
        let backoff = if flight.step.wakes() {
            &self.policy.wake_backoff
        } else {
            &self.policy.sleep_backoff
        };
        let settled = slot.settle_step(flight.step, outcome, now, backoff);
        if let Some(notice) = settled.notice {
            out.push(Action::Notify {
                sandbox: id,
                notice,
            });
        }
        let mut lost = settled.lost;
        if std::mem::take(&mut slot.process_lost) {
            let (state, lost_now) = slot.state.without_process();
            slot.state = state;
            lost |= lost_now;
        }
        if lost {
            slot.retry = None;
            out.push(Action::Notify {
                sandbox: id,
                notice: Notice::MemoryLost,
            });
        }
        if slot.floor != Level::Running && slot.state.level >= slot.floor {
            self.pending_relief = self.pending_relief.saturating_sub(slot.floor_relief);
            self.settled_relief = self.settled_relief.saturating_add(slot.floor_relief);
            slot.floor = Level::Running;
            slot.floor_relief = 0;
        }
        // A request to sleep made while the sandbox is wanted awake applies
        // once it is awake again. A wake passes through deeper levels on its
        // way up, such as Archived after a fetch, and a sleep step asked to
        // stop for a wake may still finish, so only a sleep step that leaves
        // nobody waiting settles the request.
        slot.expire_holds(now);
        if !flight.step.wakes() && !slot.wants_awake() && slot.state.level >= slot.requested {
            slot.requested = Level::Running;
        }
        if slot.state != before {
            out.push(state_notice(id, slot));
        }
        self.mark(id);
    }

    fn remove(&mut self, id: SandboxId, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.remove(&id) else {
            return;
        };
        if let Some(flight) = slot.in_flight {
            self.orphans.insert(flight.op, flight.step);
            if !flight.cancel_sent {
                out.push(Action::Cancel {
                    sandbox: id,
                    op: flight.op,
                });
            }
        }
        if let Some((step, key)) = slot.queued {
            self.queues[step.index()].remove(&key);
        }
        if let Some(at) = slot.timer {
            self.timers.remove(&(at, id));
        }
        self.pending_relief = self.pending_relief.saturating_sub(slot.floor_relief);
        out.push(Action::Destroy { sandbox: id });
    }

    fn mark(&mut self, id: SandboxId) {
        if let Some(slot) = self.sandboxes.get_mut(&id)
            && !slot.dirty
        {
            slot.dirty = true;
            self.dirty.push(id);
        }
    }

    fn fire_timers(&mut self, now: At) {
        while let Some(&(at, id)) = self.timers.first() {
            if at > now {
                break;
            }
            self.timers.pop_first();
            if let Some(slot) = self.sandboxes.get_mut(&id) {
                slot.timer = None;
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
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        slot.dirty = false;
        slot.expire_holds(now);
        if slot.state.level == Level::Running && slot.in_flight.is_none() {
            slot.wake = None;
        } else if slot.wake.is_none() && !slot.holds.is_empty() {
            slot.wake = Some(Wake {
                priority: Priority::Interactive,
                since: now,
            });
        }
        if slot.wants_awake() {
            if slot.floor != Level::Running {
                self.pending_relief = self.pending_relief.saturating_sub(slot.floor_relief);
                slot.floor = Level::Running;
                slot.floor_relief = 0;
            }
            if let Some(flight) = &mut slot.in_flight
                && !flight.step.wakes()
                && !flight.cancel_sent
            {
                flight.cancel_sent = true;
                out.push(Action::Cancel {
                    sandbox: id,
                    op: flight.op,
                });
            }
        } else if slot.floor != Level::Running
            && let Some(flight) = &mut slot.in_flight
            && flight.step == Step::Archive
            && !flight.cancel_sent
        {
            // Archiving frees no memory and is not needed to free it, so it
            // must not hold up the memory pressure demands. It starts again
            // from the saved copy once the pressure is relieved.
            flight.cancel_sent = true;
            out.push(Action::Cancel {
                sandbox: id,
                op: flight.op,
            });
        }
        let wanted = slot
            .next_step(now)
            .map(|step| (step, slot.queue_key(id, step, now)));
        if wanted != slot.queued {
            if let Some((step, key)) = slot.queued {
                self.queues[step.index()].remove(&key);
            }
            if let Some((step, key)) = wanted {
                self.queues[step.index()].insert(key);
            }
            slot.queued = wanted;
        }
        let deadline = slot.next_deadline(now);
        if deadline != slot.timer {
            if let Some(at) = slot.timer {
                self.timers.remove(&(at, id));
            }
            if let Some(at) = deadline {
                self.timers.insert((at, id));
            }
            slot.timer = deadline;
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
                let Some(slot) = self.sandboxes.get_mut(&key.sandbox) else {
                    continue;
                };
                debug_assert_eq!(slot.queued, Some((step, key)));
                slot.queued = None;
                let op = OpId(self.next_op);
                self.next_op += 1;
                slot.in_flight = Some(InFlight {
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
    ///
    /// Each pass moves every candidate at most one level deeper, oldest
    /// first. When even that is not enough, the next pass goes deeper, so
    /// a large shortfall ends processes directly instead of compressing
    /// memory that is about to be freed anyway.
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
            .saturating_sub(self.pending_relief)
            .saturating_sub(self.settled_relief);
        if needed == 0 {
            return false;
        }
        let mut changed = false;
        let mut candidates: Vec<(At, SandboxId, Level, u64)> = Vec::new();
        while needed > 0 {
            candidates.clear();
            candidates.extend(
                self.sandboxes
                    .iter()
                    .filter(|(_, slot)| !slot.broken && !slot.wants_awake() && slot.resident > 0)
                    .filter_map(|(id, slot)| {
                        let reached = slot.state.level.max(slot.floor);
                        let target = slot.policy.relief_target(reached)?;
                        let relief =
                            slot.relief_between(reached, target, memory.compressed_percent);
                        (relief > 0).then_some((slot.last_activity, *id, target, relief))
                    }),
            );
            if candidates.is_empty() {
                break;
            }
            candidates.sort_unstable();
            for &(_, id, target, relief) in &candidates {
                if needed == 0 {
                    break;
                }
                let Some(slot) = self.sandboxes.get_mut(&id) else {
                    continue;
                };
                slot.floor = target;
                slot.floor_relief += relief;
                self.pending_relief += relief;
                needed = needed.saturating_sub(relief);
                changed = true;
                self.mark(id);
            }
        }
        changed
    }
}

fn state_notice(sandbox: SandboxId, slot: &Sandbox) -> Action {
    Action::Notify {
        sandbox,
        notice: Notice::State(slot.state),
    }
}
