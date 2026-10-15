//! Tunable policy: when idle sandboxes sleep deeper, how many steps a host
//! runs at once, how failures back off, and when memory pressure kicks in.

use core::fmt;
use core::time::Duration;

use crate::level::{Level, Step};

/// When an idle sandbox moves to each deeper level, measured from its last
/// activity.
///
/// Levels can be skipped. A policy that enables nothing beyond
/// [`Level::Running`] never sleeps, which suits a pinned machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SleepPolicy {
    after: [Option<Duration>; Level::COUNT],
}

impl SleepPolicy {
    /// Never sleeps.
    pub const NEVER: Self = Self {
        after: [Some(Duration::ZERO), None, None, None, None, None],
    };

    /// Builds a policy from `(level, idle time)` pairs.
    ///
    /// Deeper levels need longer or equal idle times, and each level needs the
    /// one it builds on: compressing or saving needs pausing, archiving needs
    /// saving, evicting needs archiving.
    pub fn new(ladder: impl IntoIterator<Item = (Level, Duration)>) -> Result<Self, PolicyError> {
        let mut after = Self::NEVER.after;
        for (level, idle) in ladder {
            if level == Level::Running {
                return Err(PolicyError::RunningHasNoThreshold);
            }
            let slot = &mut after[level.index()];
            if slot.is_some() {
                return Err(PolicyError::Duplicate(level));
            }
            *slot = Some(idle);
        }
        let mut previous: Option<(Level, Duration)> = None;
        for level in Level::ALL {
            let Some(idle) = after[level.index()] else {
                continue;
            };
            if let Some(required) = level.requires()
                && after[required.index()].is_none()
            {
                return Err(PolicyError::Requires { level, required });
            }
            if let Some((shallower, earlier)) = previous
                && idle < earlier
            {
                return Err(PolicyError::OutOfOrder { level, shallower });
            }
            previous = Some((level, idle));
        }
        Ok(Self { after })
    }

    /// Idle time after which a sandbox moves to `level`, if enabled.
    #[must_use]
    pub const fn after(&self, level: Level) -> Option<Duration> {
        self.after[level.index()]
    }

    /// Whether this policy ever lets the sandbox reach `level`.
    #[must_use]
    pub const fn enables(&self, level: Level) -> bool {
        self.after[level.index()].is_some()
    }

    /// The deepest level this policy allows after being idle for `idle`.
    #[must_use]
    pub fn deepest_after(&self, idle: Duration) -> Level {
        Level::ALL
            .into_iter()
            .rev()
            .find(|level| self.after(*level).is_some_and(|after| idle >= after))
            .unwrap_or(Level::Running)
    }

    /// Idle time at which the policy next allows a level deeper than `level`.
    #[must_use]
    pub fn next_threshold_beyond(&self, level: Level) -> Option<Duration> {
        Level::ALL[level.index() + 1..]
            .iter()
            .find_map(|deeper| self.after(*deeper))
    }

    /// The first enabled level deeper than `level` that actually frees host
    /// memory, which is what memory pressure asks for.
    #[must_use]
    pub fn relief_target(&self, level: Level) -> Option<Level> {
        [Level::Compressed, Level::Saved]
            .into_iter()
            .find(|target| *target > level && self.enables(*target))
    }
}

/// The most steps of each kind a host runs at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepLimits([u32; Step::COUNT]);

impl StepLimits {
    /// The same limit for every step.
    #[must_use]
    pub const fn uniform(limit: u32) -> Self {
        Self([limit; Step::COUNT])
    }

    /// The limit for `step`.
    #[must_use]
    pub const fn get(&self, step: Step) -> u32 {
        self.0[step.index()]
    }

    /// Returns these limits with `step` limited to `limit`.
    #[must_use]
    pub const fn with(mut self, step: Step, limit: u32) -> Self {
        self.0[step.index()] = limit;
        self
    }
}

impl Default for StepLimits {
    /// Sized for one large host: pausing and resuming are nearly free, while
    /// restores, saves and transfers compete for memory bandwidth, disk and
    /// network.
    fn default() -> Self {
        Self::uniform(8)
            .with(Step::Resume, 64)
            .with(Step::Pause, 64)
            .with(Step::Restore, 32)
            .with(Step::Boot, 16)
            .with(Step::Archive, 4)
            .with(Step::Evict, 16)
    }
}

/// Exponential backoff after transient failures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    /// Delay after the first failure.
    pub first: Duration,
    /// Upper bound on any delay.
    pub max: Duration,
}

impl Backoff {
    /// Delay before the next attempt after `failures` consecutive failures.
    #[must_use]
    pub fn delay(&self, failures: u32) -> Duration {
        let doublings = failures.saturating_sub(1).min(31);
        self.first.saturating_mul(1 << doublings).min(self.max)
    }
}

/// When the host pushes idle sandboxes deeper to free memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryPolicy {
    /// Below this many available bytes, idle sandboxes are pushed deeper,
    /// least recently used first.
    pub low_watermark: u64,
    /// Pushing continues until the expected available memory reaches this.
    pub high_watermark: u64,
    /// Share of a sandbox's memory that remains after compression, in percent.
    pub compressed_percent: u8,
}

/// Host-wide policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostPolicy {
    /// Concurrency limits per step kind.
    pub limits: StepLimits,
    /// Backoff for failed wake steps. Someone may be waiting, so keep it short.
    pub wake_backoff: Backoff,
    /// Backoff for failed sleep steps.
    pub sleep_backoff: Backoff,
    /// Memory-pressure handling; `None` disables it.
    pub memory: Option<MemoryPolicy>,
}

impl HostPolicy {
    /// Checks the parts that can be inconsistent.
    pub fn validate(&self) -> Result<(), PolicyError> {
        if let Some(memory) = self.memory {
            if memory.low_watermark > memory.high_watermark {
                return Err(PolicyError::Watermarks);
            }
            if memory.compressed_percent > 100 {
                return Err(PolicyError::CompressedPercent);
            }
        }
        Ok(())
    }
}

impl Default for HostPolicy {
    fn default() -> Self {
        Self {
            limits: StepLimits::default(),
            wake_backoff: Backoff {
                first: Duration::from_millis(200),
                max: Duration::from_secs(10),
            },
            sleep_backoff: Backoff {
                first: Duration::from_secs(5),
                max: Duration::from_secs(600),
            },
            memory: None,
        }
    }
}

/// An inconsistent policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    /// [`Level::Running`] has no idle threshold; it is where sandboxes start.
    RunningHasNoThreshold,
    /// A level appears twice.
    Duplicate(Level),
    /// A level is enabled without the level it builds on.
    Requires {
        /// The enabled level.
        level: Level,
        /// The level it needs.
        required: Level,
    },
    /// A deeper level has a shorter idle time than a shallower one.
    OutOfOrder {
        /// The deeper level.
        level: Level,
        /// The shallower level with the longer idle time.
        shallower: Level,
    },
    /// The low memory watermark is above the high one.
    Watermarks,
    /// The compressed share is above 100 percent.
    CompressedPercent,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RunningHasNoThreshold => f.write_str("the running level takes no idle threshold"),
            Self::Duplicate(level) => write!(f, "{level:?} appears more than once"),
            Self::Requires { level, required } => {
                write!(f, "{level:?} is enabled but {required:?} is not")
            }
            Self::OutOfOrder { level, shallower } => {
                write!(f, "{level:?} has a shorter idle time than {shallower:?}")
            }
            Self::Watermarks => f.write_str("the low memory watermark is above the high one"),
            Self::CompressedPercent => f.write_str("the compressed share is above 100 percent"),
        }
    }
}

impl std::error::Error for PolicyError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn full_ladder_orders_levels_by_idle_time() {
        let policy = SleepPolicy::new([
            (Level::Paused, secs(30)),
            (Level::Compressed, secs(120)),
            (Level::Saved, secs(900)),
            (Level::Archived, secs(3600)),
            (Level::Remote, secs(86_400)),
        ])
        .unwrap();
        assert_eq!(policy.deepest_after(secs(0)), Level::Running);
        assert_eq!(policy.deepest_after(secs(29)), Level::Running);
        assert_eq!(policy.deepest_after(secs(30)), Level::Paused);
        assert_eq!(policy.deepest_after(secs(1000)), Level::Saved);
        assert_eq!(policy.deepest_after(secs(1_000_000)), Level::Remote);
        assert_eq!(policy.next_threshold_beyond(Level::Running), Some(secs(30)));
        assert_eq!(policy.next_threshold_beyond(Level::Saved), Some(secs(3600)));
        assert_eq!(policy.next_threshold_beyond(Level::Remote), None);
    }

    #[test]
    fn skipped_levels_are_never_chosen() {
        let policy =
            SleepPolicy::new([(Level::Paused, secs(10)), (Level::Saved, secs(60))]).unwrap();
        assert_eq!(policy.deepest_after(secs(30)), Level::Paused);
        assert_eq!(policy.next_threshold_beyond(Level::Paused), Some(secs(60)));
        assert_eq!(policy.relief_target(Level::Running), Some(Level::Saved));
    }

    #[test]
    fn never_policy_stays_running() {
        assert_eq!(
            SleepPolicy::NEVER.deepest_after(secs(u64::MAX)),
            Level::Running
        );
        assert_eq!(
            SleepPolicy::NEVER.next_threshold_beyond(Level::Running),
            None
        );
        assert_eq!(SleepPolicy::NEVER.relief_target(Level::Running), None);
    }

    #[test]
    fn rejects_inconsistent_ladders() {
        assert_eq!(
            SleepPolicy::new([(Level::Running, secs(1))]),
            Err(PolicyError::RunningHasNoThreshold)
        );
        assert_eq!(
            SleepPolicy::new([(Level::Paused, secs(1)), (Level::Paused, secs(2))]),
            Err(PolicyError::Duplicate(Level::Paused))
        );
        assert_eq!(
            SleepPolicy::new([(Level::Saved, secs(1))]),
            Err(PolicyError::Requires {
                level: Level::Saved,
                required: Level::Paused
            })
        );
        assert_eq!(
            SleepPolicy::new([(Level::Paused, secs(1)), (Level::Remote, secs(5))]),
            Err(PolicyError::Requires {
                level: Level::Remote,
                required: Level::Archived
            })
        );
        assert_eq!(
            SleepPolicy::new([(Level::Paused, secs(60)), (Level::Compressed, secs(30))]),
            Err(PolicyError::OutOfOrder {
                level: Level::Compressed,
                shallower: Level::Paused
            })
        );
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let backoff = Backoff {
            first: Duration::from_millis(100),
            max: secs(1),
        };
        assert_eq!(backoff.delay(1), Duration::from_millis(100));
        assert_eq!(backoff.delay(2), Duration::from_millis(200));
        assert_eq!(backoff.delay(4), Duration::from_millis(800));
        assert_eq!(backoff.delay(5), secs(1));
        assert_eq!(backoff.delay(u32::MAX), secs(1));
    }
}
