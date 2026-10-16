//! One sandbox's state and the decisions that depend only on it.

use std::collections::BTreeMap;

use crate::host::{Failure, Notice, Outcome};
use crate::ids::{HoldId, OpId, SandboxId};
use crate::level::{Durability, Level, Priority, State, Step};
use crate::policy::{Backoff, SleepPolicy};
use crate::time::At;

/// A step the host has started and not yet heard back about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InFlight {
    pub op: OpId,
    pub step: Step,
    pub cancel_sent: bool,
    /// Whether it still counts against its kind's concurrency limit; see
    /// [`crate::Input::Unthrottled`].
    pub throttled: bool,
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

/// What a finished step did to its sandbox beyond changing its state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Settled {
    /// Running programs were lost.
    pub lost: bool,
    /// What to tell the host agent about a failure, if anything.
    pub notice: Option<Notice>,
}

/// Position in a step queue. Lower sorts first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct QueueKey {
    pub rank: u8,
    pub since: At,
    pub sandbox: SandboxId,
}

#[derive(Debug)]
pub(crate) struct Sandbox {
    pub state: State,
    pub policy: SleepPolicy,
    pub last_activity: At,
    pub wake: Option<Wake>,
    /// Hold ids and their expiry; `None` lasts until released.
    pub holds: BTreeMap<HoldId, Option<At>>,
    /// Minimum depth demanded by memory pressure. [`Level::Running`] means none.
    pub floor: Level,
    /// Bytes the host expects to regain once the floor is reached.
    pub floor_relief: u64,
    /// Minimum depth asked for by [`crate::Input::Sleep`]. [`Level::Running`]
    /// means none.
    pub requested: Level,
    /// Latest reported resident memory in bytes.
    pub resident: u64,
    pub in_flight: Option<InFlight>,
    /// The VM process died while a step was in flight.
    pub process_lost: bool,
    pub retry: Option<Retry>,
    pub queued: Option<(Step, QueueKey)>,
    pub timer: Option<At>,
    pub dirty: bool,
    pub health: Health,
}

/// What can still be done with a sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Health {
    Sound,
    /// No copy of the current VM process can be trusted; see
    /// [`Failure::Unsavable`]. Ends when the process is gone or replaced.
    Unsavable,
    /// Beyond recovery on this host.
    Broken,
}

impl Sandbox {
    pub fn new(now: At, state: State, policy: SleepPolicy) -> Self {
        Self {
            state: State::new(state.level, state.durability, state.memory_saved),
            policy,
            last_activity: now,
            wake: None,
            holds: BTreeMap::new(),
            floor: Level::Running,
            floor_relief: 0,
            requested: Level::Running,
            resident: 0,
            in_flight: None,
            process_lost: false,
            retry: None,
            queued: None,
            timer: None,
            dirty: false,
            health: Health::Sound,
        }
    }

    /// Records activity at `at`; activity never moves backwards.
    pub fn touch(&mut self, at: At) {
        self.last_activity = self.last_activity.max(at);
    }

    /// Applies how `step` ended to the state and the retry bookkeeping.
    /// `backoff` spaces out retries after transient failures.
    pub fn settle_step(
        &mut self,
        step: Step,
        outcome: Outcome,
        now: At,
        backoff: &Backoff,
    ) -> Settled {
        let mut settled = Settled {
            lost: false,
            notice: None,
        };
        if matches!(step, Step::Resume | Step::Restore)
            && matches!(
                outcome,
                Outcome::Failed(Failure::MemoryLost | Failure::Fatal)
            )
        {
            // The guest may have run before the step broke down, so no saved
            // copy, here or in object storage, may match the disk any more.
            // The host agent stops trusting them before letting the guest
            // run and trusts them again only when it was refused, which is a
            // transient failure.
            settled.lost = self.lose(State::without_saved_copies);
        }
        match outcome {
            Outcome::Done => {
                debug_assert!(step.can_start(self.state), "{step:?} from {:?}", self.state);
                self.state = step.apply(self.state);
                if matches!(step, Step::Boot | Step::Restore) {
                    self.renew();
                }
                if step.wakes() && self.state.level == Level::Running {
                    self.touch(now);
                }
                self.retry = None;
            }
            // Nothing changed; the host is told why the sandbox will not
            // sleep deeper.
            Outcome::Cancelled | Outcome::Failed(Failure::Unsavable) => {}
            Outcome::Failed(
                failure @ (Failure::Transient | Failure::Untrusted | Failure::RemoteUntrusted),
            ) => {
                match failure {
                    Failure::Untrusted => settled.lost |= self.lose(State::without_saved_copies),
                    Failure::RemoteUntrusted => self.state = self.state.without_remote_copy(),
                    _ => {}
                }
                // With the programs lost there is nothing to retry: the next
                // wake boots fresh from the files.
                if !settled.lost {
                    let failures = self
                        .retry
                        .map_or(1, |retry| retry.failures.saturating_add(1));
                    self.retry = Some(Retry {
                        failures,
                        not_before: now + backoff.delay(failures),
                    });
                    settled.notice = Some(Notice::Retrying { step, failures });
                }
            }
            Outcome::Failed(Failure::MemoryLost) => {
                settled.lost |= self.lose(State::without_memory_image);
            }
            Outcome::Failed(Failure::Fatal) => {
                self.health = Health::Broken;
                settled.notice = Some(Notice::Broken);
            }
        }
        settled
    }

    /// Moves to the state `change` gives and returns whether running programs
    /// were lost on the way.
    fn lose(&mut self, change: impl FnOnce(State) -> (State, bool)) -> bool {
        let (state, lost) = change(self.state);
        self.state = state;
        lost
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

    /// Whether the sandbox needs a copy of its VM process to sleep deeper
    /// but none can be made.
    pub fn cannot_save(&self) -> bool {
        self.health == Health::Unsavable && self.state.durability == Durability::Volatile
    }

    /// The policy as it applies now: one that never saves while no copy of
    /// the process can be trusted.
    pub fn policy(&self) -> SleepPolicy {
        if self.cannot_save() {
            self.policy.without_saving()
        } else {
            self.policy
        }
    }

    /// A new VM process, or none, starts with a clean slate.
    pub fn renew(&mut self) {
        if self.health == Health::Unsavable {
            self.health = Health::Sound;
        }
    }

    pub fn is_broken(&self) -> bool {
        self.health == Health::Broken
    }

    pub fn wants_awake(&self) -> bool {
        self.wake.is_some() || !self.holds.is_empty()
    }

    /// Whether the sandbox is needed awake or a step is already waking it.
    pub fn waking(&self) -> bool {
        self.wants_awake() || self.in_flight.is_some_and(|flight| flight.step.wakes())
    }

    /// Asks for at least `level` of depth; [`Level::Running`] or a level
    /// already reached withdraws the request. A sandbox on its way up counts
    /// as running, so the request applies once the wake it serves is done.
    pub fn request_sleep(&mut self, level: Level) {
        // A process that cannot be saved sleeps no deeper than compressed.
        let level = if self.cannot_save() {
            level.min(Level::Compressed)
        } else {
            level
        };
        let current = if self.waking() {
            Level::Running
        } else {
            self.state.level
        };
        self.requested = if level > current {
            level
        } else {
            Level::Running
        };
    }

    /// Whether ending the VM process right now would free its memory without
    /// losing anything or keeping anyone waiting.
    pub fn reclaimable(&self) -> bool {
        self.state.level.has_process()
            && self.state.level != Level::Running
            && self.state.durability != Durability::Volatile
            && !self.wants_awake()
            && !self.is_broken()
    }

    /// The next step to start now, if any.
    ///
    /// A needed sandbox moves straight up to [`Level::Running`]. An unneeded
    /// one only ever moves deeper or gets better protected; see
    /// [`SleepPolicy::next_step`].
    pub fn next_step(&self, now: At) -> Option<Step> {
        if self.is_broken() || self.in_flight.is_some() {
            return None;
        }
        if self.retry.is_some_and(|retry| retry.not_before > now) {
            return None;
        }
        if self.wants_awake() {
            return match self.state.level {
                Level::Running => None,
                Level::Paused | Level::Compressed => Some(Step::Resume),
                Level::Saved | Level::Archived if self.state.memory_saved => Some(Step::Restore),
                Level::Saved | Level::Archived => Some(Step::Boot),
                Level::Remote => Some(Step::Fetch),
            };
        }
        let idle = now.saturating_since(self.last_activity);
        self.policy()
            .next_step(self.state, idle, self.floor.max(self.requested))
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
            let idle = now.saturating_since(self.last_activity);
            self.policy()
                .next_threshold(self.state, idle)
                .map(|after| self.last_activity + after)
        };
        [retry, lease, idle]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min()
    }

    /// Bytes expected to be freed by moving from `from` to `to`, given the
    /// actual level and the latest resident size.
    pub fn relief_between(&self, from: Level, to: Level, compressed_percent: u8) -> u64 {
        let remaining = |at: Level| -> u64 {
            if at >= Level::Saved {
                0
            } else if at == Level::Compressed && self.state.level < Level::Compressed {
                self.resident / 100 * u64::from(compressed_percent)
            } else {
                self.resident
            }
        };
        remaining(from).saturating_sub(remaining(to))
    }
}
