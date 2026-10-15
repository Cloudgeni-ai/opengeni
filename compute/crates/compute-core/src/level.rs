//! Sleep levels, the steps between them, and wake priorities.

/// Where a sandbox's state lives, ordered from awake to most deeply asleep.
///
/// Every level keeps the sandbox's files. Running programs survive every
/// level as long as the memory image survives; see
/// [`crate::SandboxView::memory_saved`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    /// The VM runs.
    Running,
    /// The VM's processors are stopped and its memory stays in host RAM.
    Paused,
    /// Paused, with the memory moved into compressed host RAM.
    Compressed,
    /// Memory and device state are saved on local disk; no VM process exists.
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

    /// The shallower level a sleep policy must also enable for this one to be
    /// reachable.
    #[must_use]
    pub const fn requires(self) -> Option<Self> {
        match self {
            Self::Running | Self::Paused => None,
            Self::Compressed | Self::Saved => Some(Self::Paused),
            Self::Archived => Some(Self::Saved),
            Self::Remote => Some(Self::Archived),
        }
    }
}

/// One operation that moves a sandbox to an adjacent level.
///
/// Wake steps come first; a host admits queued steps in [`Step::ALL`] order,
/// so waking always takes precedence over putting sandboxes to sleep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Step {
    /// Restart the processors: Paused or Compressed to Running.
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
    /// Move memory into compressed host RAM: Paused to Compressed.
    Compress,
    /// Write memory and device state to local disk, then end the VM
    /// process: Paused or Compressed to Saved.
    Save,
    /// Copy the saved state to object storage: Saved to Archived.
    Archive,
    /// Delete the local copy: Archived to Remote.
    Evict,
}

impl Step {
    /// Number of steps.
    pub const COUNT: usize = 9;

    /// Every step in admission order: wake steps first.
    pub const ALL: [Self; Self::COUNT] = [
        Self::Resume,
        Self::Restore,
        Self::Boot,
        Self::Fetch,
        Self::Pause,
        Self::Compress,
        Self::Save,
        Self::Archive,
        Self::Evict,
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

    /// The level reached when the step succeeds.
    #[must_use]
    pub const fn target(self) -> Level {
        match self {
            Self::Resume | Self::Restore | Self::Boot => Level::Running,
            Self::Fetch | Self::Archive => Level::Archived,
            Self::Pause => Level::Paused,
            Self::Compress => Level::Compressed,
            Self::Save => Level::Saved,
            Self::Evict => Level::Remote,
        }
    }

    /// Whether the step can start from `level`. `memory_saved` says whether
    /// a saved memory image exists, which decides between restore and boot.
    #[must_use]
    pub const fn can_start(self, level: Level, memory_saved: bool) -> bool {
        match self {
            Self::Resume => matches!(level, Level::Paused | Level::Compressed),
            Self::Restore => matches!(level, Level::Saved | Level::Archived) && memory_saved,
            Self::Boot => matches!(level, Level::Saved | Level::Archived) && !memory_saved,
            Self::Fetch => matches!(level, Level::Remote),
            Self::Pause => matches!(level, Level::Running),
            Self::Compress => matches!(level, Level::Paused),
            Self::Save => matches!(level, Level::Paused | Level::Compressed),
            Self::Archive => matches!(level, Level::Saved),
            Self::Evict => matches!(level, Level::Archived),
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
