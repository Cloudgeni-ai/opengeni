//! Sleep levels, how well a sandbox's state is protected, the steps between
//! states, and wake priorities.

/// Where a sandbox's live state is, ordered from awake to most deeply asleep.
///
/// Every level keeps the sandbox's files. Running programs survive every
/// level as long as a memory image survives; see [`State::memory_saved`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    /// The VM runs.
    Running,
    /// The VM's processors are stopped and its memory stays in host RAM.
    Paused,
    /// Paused, with the memory moved into compressed host RAM.
    Compressed,
    /// Memory and device state are on local disk; no VM process exists.
    Saved,
    /// Saved, and copied to object storage. The local copy stays as a cache.
    Archived,
    /// Only the object-storage copy remains.
    Remote,
}

impl Level {
    /// Number of levels.
    pub const COUNT: usize = 6;

    /// Every level, from awake to most deeply asleep.
    pub const ALL: [Self; Self::COUNT] = [
        Self::Running,
        Self::Paused,
        Self::Compressed,
        Self::Saved,
        Self::Archived,
        Self::Remote,
    ];

    /// Position in [`Level::ALL`].
    #[must_use]
    pub const fn index(self) -> usize {
        self as usize
    }

    /// Whether a VM process exists at this level.
    #[must_use]
    pub const fn has_process(self) -> bool {
        matches!(self, Self::Running | Self::Paused | Self::Compressed)
    }
}

/// Where a copy of the sandbox's *current* state is kept, besides the VM
/// itself. Ordered from least to most protected.
///
/// A paused VM can be saved without ending it, so a sandbox can be paused in
/// memory, ready to resume in a fraction of a second, and at the same time be
/// safe against losing its VM process or its whole host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Durability {
    /// Only the VM holds the current state. Always so while it runs, because
    /// a running VM changes its memory constantly.
    Volatile,
    /// A copy is on this host's disk. It survives the VM process ending, but
    /// not losing the host.
    Local,
    /// A copy is also in object storage, so it survives losing the host.
    Remote,
}

/// Everything the core tracks about where a sandbox's state is.
///
/// Only some combinations are possible; [`State::new`] builds the consistent
/// state closest to what it is given, and every [`Step`] keeps a consistent
/// state consistent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct State {
    /// Where the live state is.
    pub level: Level,
    /// Where a copy of the current state is kept.
    pub durability: Durability,
    /// Whether the kept copy includes memory, so waking continues running
    /// programs instead of booting fresh from the files. At a level with a
    /// VM process this is true exactly when a copy exists.
    pub memory_saved: bool,
}

impl State {
    /// A freshly created or just-booted sandbox: running, nothing saved.
    pub const RUNNING: Self = Self {
        level: Level::Running,
        durability: Durability::Volatile,
        memory_saved: false,
    };

    /// The consistent state closest to the given facts.
    ///
    /// A running VM is always [`Durability::Volatile`]. Saved state lives on
    /// local disk, archived and remote state also in object storage. At a
    /// level with a VM process, a copy always includes memory, and without a
    /// copy there is no saved memory.
    #[must_use]
    pub const fn new(level: Level, durability: Durability, memory_saved: bool) -> Self {
        let durability = match level {
            Level::Running => Durability::Volatile,
            Level::Paused | Level::Compressed => durability,
            Level::Saved => Durability::Local,
            Level::Archived | Level::Remote => Durability::Remote,
        };
        let memory_saved = if level.has_process() {
            !matches!(durability, Durability::Volatile)
        } else {
            memory_saved
        };
        Self {
            level,
            durability,
            memory_saved,
        }
    }

    /// Whether this combination can occur; see [`State::new`].
    #[must_use]
    pub fn is_consistent(self) -> bool {
        Self::new(self.level, self.durability, self.memory_saved) == self
    }

    /// Whether running programs survive in this state, either in a VM
    /// process or in a saved memory image.
    #[must_use]
    pub const fn keeps_programs(self) -> bool {
        self.level.has_process() || self.memory_saved
    }

    /// The state after the VM process ends unexpectedly. A current saved
    /// copy takes over; without one only the files on local disk remain.
    /// Returns the new state and whether running programs were lost.
    #[must_use]
    pub const fn without_process(self) -> (Self, bool) {
        if !self.level.has_process() {
            return (self, false);
        }
        match self.durability {
            Durability::Volatile => (Self::new(Level::Saved, Durability::Local, false), true),
            Durability::Local => (Self::new(Level::Saved, Durability::Local, true), false),
            Durability::Remote => (Self::new(Level::Archived, Durability::Remote, true), false),
        }
    }

    /// The state after the saved memory image turns out to be unusable. The
    /// files survive. Returns the new state and whether running programs were
    /// lost.
    #[must_use]
    pub const fn without_memory_image(self) -> (Self, bool) {
        if self.level.has_process() {
            return self.without_process();
        }
        let lost = self.memory_saved;
        (
            Self {
                memory_saved: false,
                ..self
            },
            lost,
        )
    }
}

/// One operation that changes a sandbox's [`State`].
///
/// Wake steps come first. A host admits queued steps in [`Step::ALL`] order,
/// so waking always takes precedence over putting sandboxes to sleep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Step {
    /// Restart the processors: Paused or Compressed to Running. A resume
    /// that does not finish still leaves the sandbox without a saved copy
    /// of its current state: the guest may have run before it failed.
    Resume,
    /// Start a VM from the saved memory image: Saved or Archived to Running.
    Restore,
    /// Boot a fresh VM from the disk because no memory image exists: Saved
    /// or Archived to Running. Files survive; running programs do not.
    Boot,
    /// Download the object-storage copy: Remote to Archived.
    Fetch,
    /// Stop the processors: Running to Paused.
    Pause,
    /// End the VM process, which frees all its memory at once. Needs a
    /// current saved copy, which takes its place: Paused or Compressed to
    /// Saved, or to Archived when the copy is also in object storage.
    Drop,
    /// Move memory into compressed host RAM: Paused to Compressed.
    Compress,
    /// Write memory and device state to local disk while the VM stays
    /// paused, so it can still resume instantly: Volatile to Local.
    Save,
    /// Copy the current saved state to object storage: Local to Remote, and
    /// Saved to Archived. A paused VM is left as it is.
    Archive,
    /// Delete the local copy: Archived to Remote.
    Evict,
    /// Delete the saved memory image and keep the files. The next wake boots
    /// fresh.
    Forget,
}

impl Step {
    /// Number of steps.
    pub const COUNT: usize = 11;

    /// Every step in admission order: wake steps first.
    pub const ALL: [Self; Self::COUNT] = [
        Self::Resume,
        Self::Restore,
        Self::Boot,
        Self::Fetch,
        Self::Pause,
        Self::Drop,
        Self::Compress,
        Self::Save,
        Self::Archive,
        Self::Evict,
        Self::Forget,
    ];

    /// Position in [`Step::ALL`].
    #[must_use]
    pub const fn index(self) -> usize {
        self as usize
    }

    /// Whether this step moves toward [`Level::Running`].
    #[must_use]
    pub const fn wakes(self) -> bool {
        matches!(
            self,
            Self::Resume | Self::Restore | Self::Boot | Self::Fetch
        )
    }

    /// Whether the step can start from `state`.
    #[must_use]
    pub const fn can_start(self, state: State) -> bool {
        let level = state.level;
        match self {
            Self::Resume => matches!(level, Level::Paused | Level::Compressed),
            Self::Restore => matches!(level, Level::Saved | Level::Archived) && state.memory_saved,
            Self::Boot => matches!(level, Level::Saved | Level::Archived) && !state.memory_saved,
            Self::Fetch => matches!(level, Level::Remote),
            Self::Pause => matches!(level, Level::Running),
            Self::Drop => {
                matches!(level, Level::Paused | Level::Compressed)
                    && !matches!(state.durability, Durability::Volatile)
            }
            Self::Compress => matches!(level, Level::Paused),
            Self::Save => {
                matches!(level, Level::Paused | Level::Compressed)
                    && matches!(state.durability, Durability::Volatile)
            }
            Self::Archive => match level {
                Level::Paused | Level::Compressed => {
                    matches!(state.durability, Durability::Local)
                }
                Level::Saved => true,
                Level::Running | Level::Archived | Level::Remote => false,
            },
            Self::Evict => matches!(level, Level::Archived),
            Self::Forget => !level.has_process() && state.memory_saved,
        }
    }

    /// The state once the step has succeeded from `state`. Only meaningful
    /// when [`Step::can_start`] holds.
    #[must_use]
    pub const fn apply(self, state: State) -> State {
        let State {
            level,
            durability,
            memory_saved,
        } = state;
        match self {
            Self::Resume | Self::Restore | Self::Boot => State::RUNNING,
            Self::Fetch => State::new(Level::Archived, Durability::Remote, memory_saved),
            Self::Pause => State::new(Level::Paused, Durability::Volatile, false),
            Self::Drop => match durability {
                Durability::Remote => State::new(Level::Archived, Durability::Remote, true),
                Durability::Volatile | Durability::Local => {
                    State::new(Level::Saved, Durability::Local, true)
                }
            },
            Self::Compress => State::new(Level::Compressed, durability, memory_saved),
            Self::Save => State::new(level, Durability::Local, true),
            Self::Archive => match level {
                Level::Saved => State::new(Level::Archived, Durability::Remote, memory_saved),
                _ => State::new(level, Durability::Remote, memory_saved),
            },
            Self::Evict => State::new(Level::Remote, Durability::Remote, memory_saved),
            Self::Forget => State::new(level, durability, false),
        }
    }
}

/// How urgently a sandbox is needed. Earlier variants are more urgent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    /// A person or agent is waiting on this sandbox right now.
    Interactive,
    /// The sandbox will probably be needed soon, for example when a turn
    /// starts. Waking now hides the wake behind the model's own latency.
    Proactive,
    /// Scheduled or maintenance work with no one waiting.
    Background,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_state() -> Vec<State> {
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

    #[test]
    fn there_are_exactly_twelve_consistent_states() {
        // Running; Paused and Compressed at three durabilities; Saved,
        // Archived and Remote with and without memory.
        assert_eq!(every_state().len(), 1 + 2 * 3 + 3 * 2);
        assert!(every_state().into_iter().all(State::is_consistent));
    }

    #[test]
    fn every_step_keeps_states_consistent_and_moves_them() {
        for state in every_state() {
            for step in Step::ALL {
                if step.can_start(state) {
                    let after = step.apply(state);
                    assert!(
                        after.is_consistent(),
                        "{step:?} from {state:?} gives {after:?}"
                    );
                    assert_ne!(after, state, "{step:?} from {state:?} changes nothing");
                }
            }
        }
    }

    #[test]
    fn only_wake_steps_reach_running_and_every_sleeping_state_can_wake() {
        for state in every_state() {
            for step in Step::ALL {
                if step.can_start(state) {
                    let after = step.apply(state).level;
                    // Fetching wakes in two steps: download, then restore.
                    assert_eq!(after == Level::Running, step.wakes() && step != Step::Fetch);
                    assert!(!step.wakes() || after < state.level);
                }
            }
            if state.level != Level::Running {
                assert!(
                    Step::ALL
                        .into_iter()
                        .any(|step| step.wakes() && step.can_start(state)),
                    "{state:?} cannot wake"
                );
            }
        }
    }

    #[test]
    fn sleep_steps_never_lose_programs_or_protection() {
        for state in every_state() {
            for step in Step::ALL {
                if step.can_start(state) && !step.wakes() && step != Step::Forget {
                    let after = step.apply(state);
                    assert!(after.keeps_programs() || !state.keeps_programs());
                    assert!(after.durability >= state.durability);
                }
            }
        }
    }

    #[test]
    fn a_lost_process_falls_back_to_a_current_copy() {
        let paused = |durability| State::new(Level::Paused, durability, false);
        assert_eq!(
            paused(Durability::Volatile).without_process(),
            (State::new(Level::Saved, Durability::Local, false), true)
        );
        assert_eq!(
            paused(Durability::Local).without_process(),
            (State::new(Level::Saved, Durability::Local, true), false)
        );
        assert_eq!(
            paused(Durability::Remote).without_process(),
            (State::new(Level::Archived, Durability::Remote, true), false)
        );
        let archived = State::new(Level::Archived, Durability::Remote, true);
        assert_eq!(archived.without_process(), (archived, false));
        assert_eq!(
            archived.without_memory_image(),
            (State::new(Level::Archived, Durability::Remote, false), true)
        );
    }
}
