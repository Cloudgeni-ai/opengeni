//! One sandbox's state and the decisions that depend only on it.

use std::collections::BTreeMap;

use crate::ids::{HoldId, OpId, SandboxId};
use crate::level::{Level, Priority, Step};
use crate::policy::SleepPolicy;
use crate::time::At;

/// A step the host has started and not yet heard back about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InFlight {
    pub op: OpId,
    pub step: Step,
    pub cancel_sent: bool,
}

/// Backoff state after consecutive transient failures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Retry {
    pub failures: u32,
    pub not_before: At,
}

/// An outstanding request to be awake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Wake {
    pub priority: Priority,
    pub since: At,
}

/// Position in a step queue. Lower sorts first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct QueueKey {
    pub rank: u8,
    pub since: At,
    pub sandbox: SandboxId,
}

#[derive(Debug)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent facts about one sandbox, not a hidden state machine"
)]
pub(crate) struct Sandbox {
    pub level: Level,
    /// Whether a saved memory image exists. Only meaningful at levels without
    /// a VM process; without it, waking means booting from the disk.
    pub memory_saved: bool,
    pub policy: SleepPolicy,
    pub last_activity: At,
    pub wake: Option<Wake>,
    /// Hold ids and their expiry; `None` lasts until released.
    pub holds: BTreeMap<HoldId, Option<At>>,
    /// Minimum depth demanded by memory pressure. [`Level::Running`] means none.
    pub floor: Level,
    /// Bytes the host expects to regain once the floor is reached.
    pub floor_relief: u64,
    /// Latest reported resident memory in bytes.
    pub resident: u64,
    pub in_flight: Option<InFlight>,
    /// The VM process died while a step was in flight.
    pub process_lost: bool,
    pub retry: Option<Retry>,
    pub queued: Option<(Step, QueueKey)>,
    pub timer: Option<At>,
    pub dirty: bool,
    pub broken: bool,
}

impl Sandbox {
    pub fn new(now: At, level: Level, memory_saved: bool, policy: SleepPolicy) -> Self {
        Self {
            level,
            memory_saved: memory_saved && !level.has_process(),
            policy,
            last_activity: now,
            wake: None,
            holds: BTreeMap::new(),
            floor: Level::Running,
            floor_relief: 0,
            resident: 0,
            in_flight: None,
            process_lost: false,
            retry: None,
            queued: None,
            timer: None,
            dirty: false,
            broken: false,
        }
    }

    /// Records activity at `at`; activity never moves backwards.
    pub fn touch(&mut self, at: At) {
        self.last_activity = self.last_activity.max(at);
    }

    /// Asks for the sandbox to be awake, keeping the most urgent priority and
    /// the earliest request time.
    pub fn request_wake(&mut self, priority: Priority, now: At) {
        match &mut self.wake {
            Some(wake) => wake.priority = wake.priority.min(priority),
            None => {
                self.wake = Some(Wake {
                    priority,
                    since: now,
                });
            }
        }
    }

    /// Drops expired holds. A hold means the sandbox was in use, so its
    /// expiry counts as activity.
    pub fn expire_holds(&mut self, now: At) {
        let mut latest = None;
        self.holds.retain(|_, until| match until {
            Some(expiry) if *expiry <= now => {
                latest = latest.max(Some(*expiry));
                false
            }
            _ => true,
        });
        if let Some(expiry) = latest {
            self.touch(expiry);
        }
    }

    pub fn wants_awake(&self) -> bool {
        self.wake.is_some() || !self.holds.is_empty()
    }

    /// How deep an unneeded sandbox should be by now: the policy's level for
    /// its idle time, or deeper if memory pressure demands it.
    pub fn sleep_target(&self, now: At) -> Level {
        let idle = now.saturating_since(self.last_activity);
        self.policy.deepest_after(idle).max(self.floor)
    }

    /// The next step to start now, if any.
    ///
    /// A needed sandbox moves straight up to [`Level::Running`]. An unneeded
    /// one only ever moves deeper: once memory has been compressed or written
    /// out, there is nothing to gain from moving partway back.
    pub fn next_step(&self, now: At) -> Option<Step> {
        if self.broken || self.in_flight.is_some() {
            return None;
        }
        if self.retry.is_some_and(|retry| retry.not_before > now) {
            return None;
        }
        if self.wants_awake() {
            return match self.level {
                Level::Running => None,
                Level::Paused | Level::Compressed => Some(Step::Resume),
                Level::Saved | Level::Archived if self.memory_saved => Some(Step::Restore),
                Level::Saved | Level::Archived => Some(Step::Boot),
                Level::Remote => Some(Step::Fetch),
            };
        }
        let target = self.sleep_target(now);
        if target <= self.level {
            return None;
        }
        match self.level {
            Level::Running => Some(Step::Pause),
            Level::Paused if target == Level::Compressed => Some(Step::Compress),
            Level::Paused | Level::Compressed => Some(Step::Save),
            Level::Saved => Some(Step::Archive),
            Level::Archived => Some(Step::Evict),
            Level::Remote => None,
        }
    }

    /// Queue position for `step`: wakes by urgency then age, sleep steps
    /// driven by memory pressure first, then the longest idle.
    pub fn queue_key(&self, id: SandboxId, step: Step, now: At) -> QueueKey {
        if step.wakes() {
            let wake = self.wake.unwrap_or(Wake {
                priority: Priority::Interactive,
                since: now,
            });
            QueueKey {
                rank: wake.priority as u8,
                since: wake.since,
                sandbox: id,
            }
        } else {
            let unpressured = u8::from(self.floor == Level::Running);
            QueueKey {
                rank: unpressured,
                since: self.last_activity,
                sandbox: id,
            }
        }
    }

    /// The next moment this sandbox's decision can change without new input.
    pub fn next_deadline(&self, now: At) -> Option<At> {
        let retry = self.retry.map(|retry| retry.not_before);
        let lease = self.holds.values().flatten().copied().min();
        let idle = if self.wants_awake() {
            None
        } else {
            let reached = self.sleep_target(now).max(self.level);
            self.policy
                .next_threshold_beyond(reached)
                .map(|idle| self.last_activity + idle)
        };
        [retry, lease, idle]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min()
    }

    /// The memory image is gone: files remain, running programs do not.
    /// Returns whether anything was lost.
    pub fn lose_memory(&mut self) -> bool {
        let had_memory = self.level.has_process() || self.memory_saved;
        if self.level.has_process() {
            self.level = Level::Saved;
        }
        self.memory_saved = false;
        had_memory
    }

    /// Bytes expected to be freed by moving from `from` to `to`, given the
    /// actual level and the latest resident size.
    pub fn relief_between(&self, from: Level, to: Level, compressed_percent: u8) -> u64 {
        let remaining = |at: Level| -> u64 {
            if at >= Level::Saved {
                0
            } else if at == Level::Compressed && self.level < Level::Compressed {
                self.resident / 100 * u64::from(compressed_percent)
            } else {
                self.resident
            }
        };
        remaining(from).saturating_sub(remaining(to))
    }
}
