//! Every sandbox on one machine, with shared concurrency limits and memory
//! pressure handling.

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap, VecDeque};

use crate::ids::{BalloonRequest, HoldId, LoanId, OpId, SandboxId};
use crate::level::{Level, Priority, State, Step};
use crate::policy::{HostPolicy, PolicyError, SleepPolicy};
use crate::sandbox::{Health, InFlight, QueueKey, Sandbox, Wake};
use crate::time::At;

mod admission;
mod disk;
mod spare;
mod squeeze;

pub(crate) use admission::WakeRoom;
pub use admission::{Capacity, Size};
pub use disk::{DiskCapacity, DiskSpace, Resource};
pub(crate) use squeeze::{Balloon, Squeeze};

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
        /// What it may take of host memory.
        size: Size,
        /// Its last activity: now for a new sandbox, or as recorded for one
        /// found on disk, so a restart does not reset how long it has been
        /// idle. A time after now counts as now.
        last_activity: At,
    },
    /// Stop managing a sandbox and delete it. What its VM occupied stays
    /// counted against the admission budget, as with [`Input::Unmanaged`],
    /// until the host agent reports that VM ended.
    Remove {
        /// The sandbox.
        sandbox: SandboxId,
    },
    /// A VM this core does not manage holds `bytes` of host memory: the VM
    /// of a removed sandbox not yet ended, or one the host agent found
    /// running but could not take back. Counted against the admission
    /// budget until reported again with 0 once it has ended.
    Unmanaged {
        /// The sandbox whose VM it is.
        sandbox: SandboxId,
        /// Bytes it holds; 0 once it has ended.
        bytes: u64,
    },
    /// Work outside any step, named `key`, may still write `disk` to local
    /// disk, such as a new sandbox's first files: booked like a save until
    /// reported again with nothing once it is done, and what it booked
    /// then stays booked until a disk reading taken after that. Check
    /// that it fits first with [`Host::disk_shortage`].
    Writes {
        /// Names the work; any id no other work uses.
        key: SandboxId,
        /// What it may still write.
        disk: DiskSpace,
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
    /// A hold ended. Counts as activity even when the hold is not known
    /// here, such as one taken before the host agent restarted: whoever
    /// held it used the sandbox until now.
    Release {
        /// The sandbox.
        sandbox: SandboxId,
        /// The reason that ended.
        hold: HoldId,
    },
    /// The sandbox did work on its own while running, such as a build using
    /// its processors or a download moving data. Counts as activity only
    /// while it runs with no step in progress: it never wakes the sandbox,
    /// never cancels an [`Input::Sleep`] request, and a step already putting
    /// the sandbox to sleep goes ahead.
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
    /// A started step no longer does the work its kind's concurrency limit
    /// protects, such as a wake whose VM already runs and only waits for
    /// its guest to answer. It stops counting against the limit, so another
    /// step of its kind may start, but stays the sandbox's step until
    /// [`Input::Finished`]. Unknown or repeated reports are ignored.
    Unthrottled {
        /// The sandbox.
        sandbox: SandboxId,
        /// The op from [`Action::Start`].
        op: OpId,
    },
    /// Work outside any sandbox, such as building a template, asks for a
    /// place under `step`'s concurrency limit, so it never runs beside more
    /// steps of that kind than the limit allows. It gets one after every
    /// step of that kind queued for a sandbox, in the order asked, and is
    /// told with [`Action::Lend`]. Asking again with a loan id already in
    /// use is ignored.
    Borrow {
        /// Names this loan in [`Action::Lend`] and [`Input::Return`].
        loan: LoanId,
        /// Whose limit it counts against.
        step: Step,
    },
    /// The work of `loan` is done, or no longer wants its place: the place
    /// is given back, or the request withdrawn. Unknown loans are ignored.
    Return {
        /// The loan.
        loan: LoanId,
    },
    /// A spare VM, one the host runs outside sandbox management that
    /// nobody uses yet such as a ready sandbox or a template build, holds
    /// `bytes` of host memory; 0 once it has ended, or is no longer spare.
    /// Book one before it starts, within [`Host::spare_fits`], as
    /// `filling`: until reported otherwise its memory is claimed above the
    /// high watermark, since no reading shows it. Spare VMs count against
    /// the admission budget, and ready ones (not `filling`) are the first
    /// memory given back, with [`Action::Discard`]. What one may still
    /// write to local disk is booked like a save's, and what it wrote
    /// stays booked until a disk reading taken after it ended.
    Spare {
        /// Names the VM.
        sandbox: SandboxId,
        /// Bytes it holds, or will once filled.
        bytes: u64,
        /// Local disk it may still write, such as a template build's
        /// snapshot; nothing for a ready sandbox.
        disk: DiskSpace,
        /// Whether it is still coming up.
        filling: bool,
    },
    /// No copy of the sandbox's current VM process can be trusted, as with
    /// [`Failure::Unsavable`]: found out other than by a step, such as when
    /// the host agent takes back a running VM. Ignored without a process.
    Unsavable {
        /// The sandbox.
        sandbox: SandboxId,
    },
    /// The sandbox's VM did not take the [`Action::Balloon`] of `request`,
    /// or it was not asked, as when the VM had paused or ended: what its
    /// balloon takes is not known. It is asked again after a backoff.
    BalloonFailed {
        /// The sandbox.
        sandbox: SandboxId,
        /// The request.
        request: BalloonRequest,
    },
    /// The sandbox's VM took the [`Action::Balloon`] of `request`: for a
    /// balloon let go, its guest has taken back every page it gave.
    BalloonSet {
        /// The sandbox.
        sandbox: SandboxId,
        /// The request.
        request: BalloonRequest,
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
    /// What the local disk holding sandboxes' copies has available; see
    /// [`crate::DiskPolicy`].
    Disk {
        /// Available bytes and inodes.
        available: DiskSpace,
    },
    /// Bytes the sandbox's disk may still grow by, measured: what its
    /// awake VM books for its disk from now on instead of its size's
    /// `disk`. Send it before the [`Input::Disk`] reading taken after it,
    /// in the same batch, since that reading shows what the disk grew by.
    DiskGrowth {
        /// The sandbox.
        sandbox: SandboxId,
        /// Bytes it may still grow by.
        bytes: u64,
    },
    /// Whether the sandbox's local copy may still be written by a wake
    /// from object storage, such as the memory image a pager fills while
    /// its guest runs: what such a wake books on local disk (its size's
    /// `fetch`) is kept until this says `false`. A wake that starts from
    /// [`Level::Remote`] books it by itself; the host agent says `true`
    /// for a copy it finds still being filled after a restart.
    Hydrating {
        /// The sandbox.
        sandbox: SandboxId,
        /// Whether it may still be written.
        hydrating: bool,
    },
    /// The sandbox was paused and saved for host memory while in use
    /// before the host agent restarted, holding `bytes` (see
    /// [`Notice::PausedForMemory`]): it waits again, wanted awake, until
    /// they fit above the high watermark, and then wakes by itself.
    /// Ignored for a sandbox with a VM process or a step in flight.
    PausedForMemory {
        /// The sandbox.
        sandbox: SandboxId,
        /// Host memory its VM held.
        bytes: u64,
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
    /// For a step that saves a VM process: no copy of this process can be
    /// trusted, such as when its disk may have lost writes nobody can now
    /// rule out. Nothing changed and the VM still runs, resumes and pauses,
    /// but it is never saved, so it sleeps no deeper than its process
    /// allows until a new process replaces it. See [`Input::Unsavable`].
    Unsavable,
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
    /// The work that asked with [`Input::Borrow`] for `loan` may start: it
    /// now counts against its step kind's limit until [`Input::Return`].
    Lend {
        /// The loan.
        loan: LoanId,
    },
    /// End the spare VM named `sandbox` for memory; report it with
    /// [`Input::Spare`] and 0 once it has ended. Comes once per VM.
    Discard {
        /// Names the VM.
        sandbox: SandboxId,
    },
    /// Report a change to the control plane.
    Notify {
        /// The sandbox.
        sandbox: SandboxId,
        /// What changed.
        notice: Notice,
    },
    /// Ask the guest of the sandbox's running VM to give `bytes` of its
    /// memory back to the host through its balloon, or none for 0. Comes
    /// only while the VM runs and no step holds it; the engine lets the
    /// balloon go before any pause, so a VM never sleeps with it set. The
    /// answer, [`Input::BalloonSet`] or [`Input::BalloonFailed`], names
    /// `request`.
    Balloon {
        /// The sandbox.
        sandbox: SandboxId,
        /// Bytes the balloon takes.
        bytes: u64,
        /// Which request this is.
        request: BalloonRequest,
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
    /// No copy of the sandbox's VM process can be trusted: it keeps running
    /// from memory, and sleeps no deeper than its process allows, until it
    /// is replaced. See [`Failure::Unsavable`].
    Unsavable,
    /// The sandbox cannot be recovered on this host.
    Broken,
    /// A wake was refused because the host cannot make room for it at
    /// once: it needs `needed` of `resource` and only `free` are left even
    /// after ending every idle VM already saved. The wake request is
    /// dropped; a new one tries again, and so does a hold once there is
    /// room. See [`crate::Admission`] and [`crate::DiskPolicy`].
    HostFull {
        /// What the host is short of.
        resource: Resource,
        /// Bytes, or inodes, the wake needs.
        needed: u64,
        /// Bytes, or inodes, free.
        free: u64,
    },
    /// Whether the sandbox waits, saved, for room after a pause for host
    /// memory, and how much its VM held: `Some` once it waits, `None` once
    /// it no longer does, because it was let through to wake or nothing
    /// wants it awake any more. Keep it across restarts and give it back
    /// with [`Input::PausedForMemory`], so the sandbox still wakes by
    /// itself.
    PausedForMemory(Option<u64>),
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
    /// Whether no copy of its VM process can be trusted; see
    /// [`Failure::Unsavable`].
    pub unsavable: bool,
    /// Whether it is beyond recovery on this host.
    pub broken: bool,
    /// Bytes of host memory its VM held when the host paused it, or began
    /// pausing and saving it, for memory while it was in use above its
    /// request; it wakes again by itself once there is room.
    pub paused_for_memory: Option<u64>,
    /// Bytes its VM's balloon takes back from its guest for the host.
    pub balloon: u64,
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
    /// Steps still running for sandboxes that were removed and still
    /// counted against their limits.
    orphans: HashMap<OpId, Step>,
    /// Loans waiting for a place, by step kind, in the order asked.
    borrowers: [VecDeque<LoanId>; Step::COUNT],
    /// Loans holding a place, with the kind it counts against.
    lent: HashMap<LoanId, Step>,
    dirty: Vec<SandboxId>,
    next_op: u64,
    next_balloon: u64,
    available_memory: Option<u64>,
    /// Memory expected back from pressure floors not yet reached.
    pending_relief: u64,
    /// Memory expected back from pressure floors reached since the last
    /// [`Input::Memory`] reading, which may not show it yet. Counting it
    /// prevents freeing the same shortfall twice.
    settled_relief: u64,
    /// Sandboxes whose wake was refused for want of memory and that are
    /// still held awake.
    refused: BTreeSet<SandboxId>,
    /// Bytes held by VMs not managed here; see [`Input::Unmanaged`].
    unmanaged: HashMap<SandboxId, u64>,
    /// Room claims (see [`Squeeze::Returning`]) that ended since the last
    /// [`Input::Memory`] reading: their guests may have taken that room
    /// before it, which only a reading taken since shows.
    unread_claims: u64,
    /// Room claims of removed sandboxes whose VMs may still run, until the
    /// host agent reports them ended.
    removed_claims: HashMap<SandboxId, u64>,
    /// Spare VMs; see [`Input::Spare`].
    spares: spare::Spares,
    /// The last [`Input::Disk`] reading.
    disk: Option<DiskSpace>,
    /// Whether that reading was taken after local copies last went, so it
    /// shows what they freed.
    disk_fresh: bool,
    /// Bookings that steps finished since that reading gave up: what they
    /// wrote shows only in the next one.
    disk_spent: DiskSpace,
    /// Local disk that work outside any step may still write; see
    /// [`Input::Writes`].
    writes: HashMap<SandboxId, DiskSpace>,
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
            borrowers: Default::default(),
            lent: HashMap::new(),
            dirty: Vec::new(),
            next_op: 0,
            next_balloon: 0,
            available_memory: None,
            pending_relief: 0,
            settled_relief: 0,
            refused: BTreeSet::new(),
            unmanaged: HashMap::new(),
            unread_claims: 0,
            removed_claims: HashMap::new(),
            spares: spare::Spares::default(),
            disk: None,
            disk_fresh: false,
            disk_spent: DiskSpace::default(),
            writes: HashMap::new(),
        })
    }

    /// Applies `input` at time `now` and appends the resulting actions.
    pub fn handle(&mut self, now: At, input: Input, out: &mut Vec<Action>) {
        self.handle_all(now, [input], out);
    }

    /// Applies several inputs observed together at time `now`, then decides
    /// once. Use it for readings taken in one sweep, such as [`Input::Busy`]
    /// for every sandbox that did work of its own: deciding after each one
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
        // Room is made ahead of wakes, never inside one.
        if self.relieve_pressure(now) | self.keep_buffer(now) | self.keep_disk(now) {
            self.reconcile_dirty(now, out);
        }
        // Refused wakes still held try again once per decision, never inside
        // the loop below, so a retry and a refusal cannot alternate.
        if self.retry_refused(now) {
            self.reconcile_dirty(now, out);
        }
        // Ending idle saved VMs for a wake or refusing it changes other
        // sandboxes' next steps; each round only deepens floors or refuses
        // wakes, so it settles.
        while self.admit(now, out) {
            self.reconcile_dirty(now, out);
        }
        self.discard_spares(out);
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
            unsavable: sandbox.health == Health::Unsavable,
            broken: sandbox.is_broken(),
            paused_for_memory: match sandbox.squeeze {
                Squeeze::None | Squeeze::Returning { .. } => None,
                Squeeze::Leaving { bytes, .. } | Squeeze::Waiting { bytes } => Some(bytes),
            },
            balloon: sandbox.balloon_sent.unwrap_or(0),
        })
    }

    /// Bytes of host memory that ending VM processes could free at once,
    /// without losing anything or keeping anyone waiting: idle, paused
    /// sandboxes whose current state is already saved, and ready spare
    /// VMs. Placement can count this memory as free.
    #[must_use]
    pub fn reclaimable_memory(&self) -> u64 {
        self.sandboxes
            .values()
            .filter(|sandbox| sandbox.reclaimable())
            .map(Sandbox::resident_bytes)
            .sum::<u64>()
            + self.spares.endable()
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
                size,
                last_activity,
            } => {
                if let Entry::Vacant(entry) = self.sandboxes.entry(sandbox) {
                    entry.insert(Sandbox::new(last_activity.min(now), state, policy, size));
                    self.mark(sandbox);
                }
            }
            Input::Remove { sandbox } => self.remove(sandbox, out),
            Input::Spare {
                sandbox,
                bytes,
                disk,
                filling,
            } => self.spare(sandbox, bytes, disk, filling),
            Input::Unmanaged { sandbox, bytes } => self.unmanaged(sandbox, bytes),
            Input::Writes { key, disk } => self.writes(key, disk),
            Input::Touch { sandbox, priority } => {
                self.ask_awake(sandbox, out);
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
            } => self.hold(now, sandbox, (hold, until), priority, out),
            Input::Release { sandbox, hold } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.holds.remove(&hold);
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
            Input::Unthrottled { sandbox, op } => self.unthrottle(sandbox, op),
            Input::Borrow { loan, step } => self.borrow(loan, step),
            Input::Return { loan } => self.give_back(loan),
            Input::Lost { sandbox } => self.lost(sandbox, out),
            Input::BalloonFailed { sandbox, request } => {
                self.balloon_failed(now, sandbox, request);
            }
            Input::BalloonSet { sandbox, request } => self.balloon_set(sandbox, request),
            Input::Unsavable { sandbox } => {
                if self
                    .sandboxes
                    .get(&sandbox)
                    .is_some_and(|slot| slot.state.level.has_process())
                {
                    self.unsavable(sandbox, out);
                }
            }
            Input::Memory { available } => self.memory_read(available),
            Input::Disk { available } => self.disk_read(available),
            Input::DiskGrowth { sandbox, bytes } => self.disk_growth(sandbox, bytes),
            Input::Hydrating { sandbox, hydrating } => self.hydrating(sandbox, hydrating),
            Input::PausedForMemory { sandbox, bytes } => {
                self.paused_for_memory(now, sandbox, bytes);
            }
            Input::Resident { sandbox, bytes } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox)
                    && slot.state.level.has_process()
                {
                    slot.resident = Some(bytes);
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

    fn hold(
        &mut self,
        now: At,
        sandbox: SandboxId,
        (hold, until): (HoldId, Option<At>),
        priority: Priority,
        out: &mut Vec<Action>,
    ) {
        self.ask_awake(sandbox, out);
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

    fn borrow(&mut self, loan: LoanId, step: Step) {
        let waiting = self.borrowers.iter().any(|queue| queue.contains(&loan));
        if !waiting && !self.lent.contains_key(&loan) {
            self.borrowers[step.index()].push_back(loan);
        }
    }

    fn give_back(&mut self, loan: LoanId) {
        if let Some(step) = self.lent.remove(&loan) {
            self.in_flight[step.index()] -= 1;
        } else {
            for queue in &mut self.borrowers {
                queue.retain(|waiting| *waiting != loan);
            }
        }
    }

    fn unthrottle(&mut self, id: SandboxId, op: OpId) {
        if let Some(step) = self.orphans.remove(&op) {
            self.in_flight[step.index()] -= 1;
            return;
        }
        if let Some(flight) = self
            .sandboxes
            .get_mut(&id)
            .and_then(|slot| slot.in_flight.as_mut())
            .filter(|flight| flight.op == op && flight.throttled)
        {
            flight.throttled = false;
            self.in_flight[flight.step.index()] -= 1;
        }
    }

    fn lost(&mut self, sandbox: SandboxId, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get_mut(&sandbox) else {
            return;
        };
        if slot.in_flight.is_some() {
            slot.process_lost = true;
        } else if slot.state.level.has_process() {
            let (state, lost) = slot.state.without_process();
            slot.state = state;
            slot.renew();
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

    /// Stops counting on a copy of `sandbox`'s VM process: a floor or a
    /// request that only a saved copy could meet is given up, since its
    /// process cannot end without losing its programs.
    fn unsavable(&mut self, sandbox: SandboxId, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get_mut(&sandbox) else {
            return;
        };
        match slot.health {
            Health::Broken | Health::Unsavable => {}
            Health::Sound => {
                slot.health = Health::Unsavable;
                out.push(Action::Notify {
                    sandbox,
                    notice: Notice::Unsavable,
                });
            }
        }
        if slot.cannot_save() {
            if let Squeeze::Leaving { claim, .. } = slot.squeeze {
                // It stays awake, and its guest may still take back what
                // its balloon held.
                slot.squeeze = if claim > 0 {
                    Squeeze::Returning { bytes: claim }
                } else {
                    Squeeze::None
                };
            }
            if slot.floor >= Level::Saved {
                self.pending_relief = self.pending_relief.saturating_sub(slot.floor_relief);
                slot.floor = Level::Running;
                slot.floor_relief = 0;
            }
            if slot.requested >= Level::Saved {
                slot.requested = Level::Running;
            }
        }
        self.mark(sandbox);
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
        if flight.throttled {
            self.in_flight[flight.step.index()] -= 1;
        }
        // What deleting local files freed shows only in a later reading.
        self.disk_fresh &= !matches!(flight.step, Step::Evict | Step::Forget);
        // What a failed save or fetch wrote may stay, such as a failed
        // copy kept in quarantine, while a retry books its writes afresh:
        // it stays booked until a reading shows it.
        if matches!(outcome, Outcome::Failed(_)) {
            let wrote = match flight.step {
                Step::Save => slot.save_space(),
                Step::Fetch => DiskSpace::save(slot.size.fetch),
                _ => DiskSpace::default(),
            };
            self.disk_spent = self.disk_spent.add(wrote);
        }
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
        if outcome == Outcome::Failed(Failure::Unsavable) {
            self.unsavable(id, out);
        }
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        let mut lost = settled.lost;
        if std::mem::take(&mut slot.process_lost) {
            let (state, lost_now) = slot.state.without_process();
            slot.state = state;
            lost |= lost_now;
        }
        if !slot.state.level.has_process() {
            slot.renew();
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
        let percent = self.compressed_percent();
        let Some(slot) = self.sandboxes.remove(&id) else {
            return;
        };
        // Its VM, if any, holds its memory until the host agent has ended
        // it, after any step still running for it.
        let held = slot.occupies(percent);
        let claim = slot.squeeze.claim();
        if held > 0 {
            *self.unmanaged.entry(id).or_default() += held;
            if claim > 0 {
                *self.removed_claims.entry(id).or_default() += claim;
            }
        } else {
            self.unread_claims += claim;
        }
        if let Some(flight) = slot.in_flight {
            // Only a step still counted against its limit has a place to
            // give back when it finishes.
            if flight.throttled {
                self.orphans.insert(flight.op, flight.step);
            }
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
        self.refused.remove(&id);
        self.pending_relief = self.pending_relief.saturating_sub(slot.floor_relief);
        // What it booked on disk, as of its last reconcile or since, may
        // have been written; the next reading shows it.
        self.disk_spent = self
            .disk_spent
            .add(slot.local_disk.booked.max(slot.disk_booking()));
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
        self.settle_squeeze(id, now, out);
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        slot.settle_room();
        if slot.state.level == Level::Running && slot.in_flight.is_none() {
            slot.wake = None;
        } else if slot.wake.is_none() && !slot.holds.is_empty() && slot.room != WakeRoom::Refused {
            slot.wake = Some(Wake {
                priority: Priority::Interactive,
                since: now,
            });
        }
        if slot.wants_awake() && !slot.leaving() {
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
        if let Some(bytes) = slot.balloon_due(now) {
            let request = BalloonRequest(self.next_balloon);
            self.next_balloon += 1;
            slot.balloon_request = request;
            out.push(Action::Balloon {
                sandbox: id,
                bytes,
                request,
            });
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
        self.rebook_disk(id);
    }

    /// Starts queued steps while their limits allow, wake steps first,
    /// and wakes that need memory only while it fits; see
    /// [`crate::Admission`]. Returns whether other sandboxes must be
    /// reconciled because of it.
    fn admit(&mut self, now: At, out: &mut Vec<Action>) -> bool {
        let mut left = self.left();
        let mut changed = false;
        for step in Step::ALL {
            if let Some(left) = left.as_mut().filter(|_| admission::needs_memory(step)) {
                changed |= self.admit_measured(now, step, left, out);
            } else {
                let index = step.index();
                let limit = self.policy.limits.get(step);
                while self.in_flight[index] < limit {
                    let Some(key) = self.queues[index].pop_first() else {
                        break;
                    };
                    self.start(step, key, out);
                }
            }
            self.lend(step, out);
        }
        changed
    }

    /// Lends places under `step`'s limit to work outside sandboxes, after
    /// every sandbox's step of its kind, in the order asked.
    fn lend(&mut self, step: Step, out: &mut Vec<Action>) {
        let index = step.index();
        let limit = self.policy.limits.get(step);
        while self.in_flight[index] < limit && self.queues[index].is_empty() {
            let Some(loan) = self.borrowers[index].pop_front() else {
                break;
            };
            self.in_flight[index] += 1;
            self.lent.insert(loan, step);
            out.push(Action::Lend { loan });
        }
    }

    /// Starts `step` for the sandbox of `key`, already taken off its queue.
    fn start(&mut self, step: Step, key: QueueKey, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get_mut(&key.sandbox) else {
            return;
        };
        debug_assert_eq!(slot.queued, Some((step, key)));
        slot.queued = None;
        // The engine lets the balloon go before the VM pauses, but may not
        // manage to, and a restored VM has the balloon its image had: it
        // is set again once the VM runs.
        slot.balloon = None;
        slot.balloon_sent = None;
        slot.balloon_taken = None;
        if admission::needs_memory(step) {
            slot.room = WakeRoom::Admitted;
            // A wake from object storage writes its local copy from now
            // on, as booked when it was admitted.
            slot.local_disk.hydrating |= slot.state.level == Level::Remote;
        }
        let op = OpId(self.next_op);
        self.next_op += 1;
        slot.in_flight = Some(InFlight {
            op,
            step,
            cancel_sent: false,
            throttled: true,
        });
        self.in_flight[step.index()] += 1;
        out.push(Action::Start {
            sandbox: key.sandbox,
            op,
            step,
        });
        // A wake books more from now on: record it, so what it later stops
        // booking is counted from there.
        self.rebook_disk(key.sandbox);
    }
}

fn state_notice(sandbox: SandboxId, slot: &Sandbox) -> Action {
    Action::Notify {
        sandbox,
        notice: Notice::State(slot.state),
    }
}
