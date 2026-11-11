//! What the host agent reads of one sandbox: [`SandboxView`].

#[cfg(doc)]
use super::{Failure, Input};
use super::{Host, Squeeze};
use crate::ids::SandboxId;
use crate::level::{Level, State, Step};
use crate::sandbox::Health;
use crate::time::At;

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
    /// Bytes of host memory its VM held when an earlier release paused it,
    /// or began pausing and saving it, for memory while it was in use
    /// above its request; it wakes again by itself once there is room.
    pub paused_for_memory: Option<u64>,
    /// Bytes its VM's balloon takes back from its guest for the host.
    pub balloon: u64,
    /// Bytes its running VM's compressed pages take in host memory, part
    /// of its resident size (see [`Input::MemoryUse`]).
    pub compressed: u64,
    /// Bytes of its running VM's memory out of RAM at their original size.
    pub swapped: u64,
    /// Thousandths of the last ten seconds all its VM's threads were
    /// stalled on memory.
    pub stall: u16,
    /// The `memory.high` last asked of its running VM, if any (ADR 24).
    pub memory_high: Option<u64>,
    /// Bytes of host memory it requested.
    pub request: u64,
    /// Bytes its running VM holds uncompressed above its request: what it
    /// borrowed. None for a sandbox whose request is its whole size.
    pub borrowed: u64,
    /// How many times in a row its steps failed for now (see
    /// [`Failure::Transient`]) since one last succeeded.
    pub failures: u32,
}

impl SandboxView {
    /// Whether its VM runs with nothing stopping it: no step in flight, or
    /// a checkpoint, which pauses it only while its state is captured.
    #[must_use]
    pub fn runs(&self) -> bool {
        self.state.level == Level::Running && self.step.is_none_or(|step| step == Step::Checkpoint)
    }
}

impl Host {
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
                Squeeze::Waiting { bytes } => Some(bytes),
            },
            balloon: sandbox.balloon_sent.unwrap_or(0),
            compressed: sandbox.paging.compressed,
            swapped: sandbox.paging.swapped,
            stall: sandbox.paging.stall,
            memory_high: sandbox.bound.and_then(|bound| bound.high),
            request: sandbox.size.request,
            borrowed: if sandbox.state.level == Level::Running {
                sandbox.borrowed()
            } else {
                0
            },
            failures: sandbox.retry.map_or(0, |retry| retry.failures),
        })
    }

    /// Whether a restart of `id` is under way (see [`Input::Restart`]): its
    /// VM has yet to end, or its memory image to be forgotten.
    #[must_use]
    pub fn restarting(&self, id: SandboxId) -> bool {
        self.sandboxes
            .get(&id)
            .is_some_and(|sandbox| sandbox.restart.is_some())
    }
}
