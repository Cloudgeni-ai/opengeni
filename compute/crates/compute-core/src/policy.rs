//! Tunable policy: when idle sandboxes sleep and get saved, how many steps a
//! host runs at once, how failures back off, and when memory pressure frees
//! memory.
//!
//! Sleep follows activity, not a ladder of timers. An idle sandbox pauses
//! almost at once, because resuming a paused VM takes a fraction of a second.
//! Soon after, a background save copies its state to disk and then to object
//! storage while the VM stays paused in memory, so a wake is still instant
//! and losing the process or the host loses nothing. Memory itself is freed
//! only when the host needs it, least recently used first: since a current
//! copy usually exists by then, ending a VM process is instant. Days later
//! the local copy is deleted, and after about a month the memory image too.

use core::fmt;
use core::time::Duration;

use crate::level::{Durability, Level, State, Step};

/// One rule of a [`SleepRules`], used to explain an invalid combination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Rule {
    /// [`SleepRules::pause_after`].
    Pause,
    /// [`SleepRules::save_after`].
    Save,
    /// [`SleepRules::archive_after`].
    Archive,
    /// [`SleepRules::drop_after`].
    Drop,
    /// [`SleepRules::evict_after`].
    Evict,
    /// [`SleepRules::forget_after`].
    Forget,
    /// [`SleepRules::compress_under_pressure`].
    Compress,
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Pause => "pause",
            Self::Save => "save",
            Self::Archive => "archive",
            Self::Drop => "drop",
            Self::Evict => "evict",
            Self::Forget => "forget",
            Self::Compress => "compress",
        })
    }
}

/// How one sandbox sleeps, as plain data. Every duration is idle time,
/// measured from the sandbox's last activity; `None` disables that rule.
///
/// Validate with [`SleepPolicy::new`]. The default never sleeps, which suits
/// a pinned machine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SleepRules {
    /// Pause the VM. Cheap both ways, so this is short: it only has to
    /// bridge the gaps inside one burst of activity.
    pub pause_after: Option<Duration>,
    /// Save memory and device state to local disk while the VM stays paused.
    /// Afterwards, memory pressure can end the VM process instantly, and a
    /// crash of the process loses nothing.
    pub save_after: Option<Duration>,
    /// Copy the saved state to object storage, so losing the host loses
    /// nothing either.
    pub archive_after: Option<Duration>,
    /// End the VM process even without memory pressure. Usually `None`: an
    /// idle VM whose state is saved costs nothing while memory is plentiful,
    /// and memory pressure ends it the moment the memory is needed.
    pub drop_after: Option<Duration>,
    /// Delete the local copy and keep only object storage. Also ends the VM
    /// process if it still exists.
    pub evict_after: Option<Duration>,
    /// Delete the saved memory image and keep the files; the next wake boots
    /// fresh. Also ends the VM process if it still exists.
    pub forget_after: Option<Duration>,
    /// Whether memory pressure may compress the paused VM's memory before
    /// ending its process. Needs ordinary pages: memory backed by huge pages
    /// cannot be compressed.
    pub compress_under_pressure: bool,
}

impl SleepRules {
    /// Never sleeps.
    pub const NEVER: Self = Self {
        pause_after: None,
        save_after: None,
        archive_after: None,
        drop_after: None,
        evict_after: None,
        forget_after: None,
        compress_under_pressure: false,
    };

    /// A starting point for interactive agent sandboxes.
    ///
    /// Pause after 10 seconds without activity, save after 30 seconds and
    /// archive after two minutes, so a typical pause between two replies
    /// already ends protected against losing the host. Free memory only
    /// under pressure, delete the local copy after three idle days and the
    /// memory image after 30.
    pub const RECOMMENDED: Self = Self {
        pause_after: Some(Duration::from_secs(10)),
        save_after: Some(Duration::from_secs(30)),
        archive_after: Some(Duration::from_secs(120)),
        drop_after: None,
        evict_after: Some(Duration::from_secs(3 * 86_400)),
        forget_after: Some(Duration::from_secs(30 * 86_400)),
        compress_under_pressure: true,
    };

    const fn get(&self, rule: Rule) -> Option<Duration> {
        match rule {
            Rule::Pause => self.pause_after,
            Rule::Save => self.save_after,
            Rule::Archive => self.archive_after,
            Rule::Drop => self.drop_after,
            Rule::Evict => self.evict_after,
            Rule::Forget => self.forget_after,
            Rule::Compress => {
                if self.compress_under_pressure {
                    Some(Duration::ZERO)
                } else {
                    None
                }
            }
        }
    }
}

/// [`SleepRules`] that have been checked for consistency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SleepPolicy {
    rules: SleepRules,
    /// Earliest idle time at which the VM process must end on its own.
    end_after: Option<Duration>,
}

impl SleepPolicy {
    /// Never sleeps.
    pub const NEVER: Self = Self {
        rules: SleepRules::NEVER,
        end_after: None,
    };

    /// Checks `rules`.
    ///
    /// Each rule needs the one it builds on, and must not come earlier:
    /// saving and compressing need pausing; archiving, ending the process
    /// and forgetting memory need a saved copy; evicting needs an archived
    /// one.
    pub fn new(rules: SleepRules) -> Result<Self, PolicyError> {
        const NEEDS: [(Rule, Rule); 6] = [
            (Rule::Save, Rule::Pause),
            (Rule::Compress, Rule::Pause),
            (Rule::Archive, Rule::Save),
            (Rule::Drop, Rule::Save),
            (Rule::Forget, Rule::Save),
            (Rule::Evict, Rule::Archive),
        ];
        for (rule, required) in NEEDS {
            let Some(after) = rules.get(rule) else {
                continue;
            };
            let Some(earliest) = rules.get(required) else {
                return Err(PolicyError::Requires { rule, required });
            };
            if rule != Rule::Compress && after < earliest {
                return Err(PolicyError::OutOfOrder {
                    rule,
                    before: required,
                });
            }
        }
        let end_after = [rules.drop_after, rules.evict_after, rules.forget_after]
            .into_iter()
            .flatten()
            .min();
        Ok(Self { rules, end_after })
    }

    /// This policy for a VM process that cannot be saved: it may pause and
    /// compress, but never save or end, since ending it would lose its
    /// programs.
    #[must_use]
    pub(crate) const fn without_saving(&self) -> Self {
        Self {
            rules: SleepRules {
                save_after: None,
                ..self.rules
            },
            end_after: None,
        }
    }

    /// The rules this policy was built from.
    #[must_use]
    pub const fn rules(&self) -> SleepRules {
        self.rules
    }

    /// Whether the sandbox ever sleeps.
    #[must_use]
    pub const fn sleeps(&self) -> bool {
        self.rules.pause_after.is_some()
    }

    /// The next step that moves an unneeded sandbox in `state`, idle for
    /// `idle`, toward where its rules want it. `floor` is the least depth
    /// demanded regardless of the rules, by memory pressure or an explicit
    /// request; [`Level::Running`] demands nothing. Reaching
    /// [`Level::Saved`] means ending the VM process, saving first if needed.
    ///
    /// The floor comes first, then saving, then archiving. An unneeded
    /// sandbox only ever moves deeper or becomes better protected.
    #[must_use]
    pub fn next_step(&self, state: State, idle: Duration, floor: Level) -> Option<Step> {
        let due = |rule: Option<Duration>| rule.is_some_and(|after| idle >= after);
        let rules = &self.rules;
        match state.level {
            Level::Running => {
                (floor > Level::Running || due(rules.pause_after)).then_some(Step::Pause)
            }
            Level::Paused | Level::Compressed => {
                let volatile = state.durability == Durability::Volatile;
                if floor >= Level::Saved || due(self.end_after) {
                    Some(if volatile { Step::Save } else { Step::Drop })
                } else if floor == Level::Compressed && state.level == Level::Paused {
                    Some(Step::Compress)
                } else if volatile && due(rules.save_after) {
                    Some(Step::Save)
                } else if state.durability == Durability::Local && due(rules.archive_after) {
                    Some(Step::Archive)
                } else {
                    None
                }
            }
            Level::Saved | Level::Archived | Level::Remote => {
                if state.level == Level::Saved
                    && (floor >= Level::Archived || due(rules.archive_after))
                {
                    Some(Step::Archive)
                } else if state.memory_saved && due(rules.forget_after) {
                    Some(Step::Forget)
                } else if state.level == Level::Archived
                    && (floor >= Level::Remote || due(rules.evict_after))
                {
                    Some(Step::Evict)
                } else {
                    None
                }
            }
        }
    }

    /// The smallest idle time beyond `idle` at which a rule that matters in
    /// `state` becomes due. Without new input or memory pressure,
    /// [`SleepPolicy::next_step`] gives nothing new before then, and nothing
    /// at all if there is no such time.
    #[must_use]
    pub fn next_threshold(&self, state: State, idle: Duration) -> Option<Duration> {
        let rules = &self.rules;
        let forget = rules.forget_after.filter(|_| state.memory_saved);
        let relevant = match (state.level, state.durability) {
            (Level::Running, _) => [rules.pause_after, None, None],
            (Level::Paused | Level::Compressed, Durability::Volatile) => {
                [rules.save_after, self.end_after, None]
            }
            (Level::Paused | Level::Compressed, Durability::Local) => {
                [rules.archive_after, self.end_after, None]
            }
            (Level::Paused | Level::Compressed, Durability::Remote) => [self.end_after, None, None],
            (Level::Saved, _) => [rules.archive_after, forget, rules.evict_after],
            (Level::Archived, _) => [forget, rules.evict_after, None],
            (Level::Remote, _) => [forget, None, None],
        };
        relevant
            .into_iter()
            .flatten()
            .filter(|after| *after > idle)
            .min()
    }

    /// The next depth memory pressure may push a sandbox to from `reached`,
    /// the deeper of its level and its current floor: compressed if allowed,
    /// otherwise the end of the VM process if a copy can be saved.
    #[must_use]
    pub const fn relief_target(&self, reached: Level) -> Option<Level> {
        let compress = self.rules.compress_under_pressure;
        let save = self.rules.save_after.is_some();
        match reached {
            Level::Running | Level::Paused if compress => Some(Level::Compressed),
            Level::Running | Level::Paused | Level::Compressed if save => Some(Level::Saved),
            _ => None,
        }
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
    /// Sized for one large host. Pausing, resuming and ending processes are
    /// nearly free. Restores, saves and transfers compete for memory
    /// bandwidth, disk and network; incremental saves write little, so many
    /// can run at once.
    ///
    /// Fetch stays at 8 because more concurrent fetches do not make the
    /// host fetch faster. Measured on a 32-vCPU cloud host with 100 wakes
    /// at once from object storage (each fetching about 85 MB compressed:
    /// its working-set pack and the disk blocks the base image lacks), the
    /// fetches together moved about 250 MB/s whether 8, 32 or 100 ran at
    /// once, well below the host's network, disk and CPU limits, so
    /// something shared inside the fetch path sets the pace. More at once
    /// only spread that rate over more wakes: first byte p50 about 30 s at
    /// 8, 37 s at 32, 36 to 53 s at 100, and no wake finished earlier. A
    /// narrow limit serves wakes nearly first come first served, the best
    /// median for a shared bottleneck. A single wake takes about 0.9 s to
    /// first byte. Restore at 32 still fits: a remote restore waits only
    /// for its pack, and its mean stayed below 2 s at 100 wide.
    fn default() -> Self {
        Self::uniform(8)
            .with(Step::Resume, 64)
            .with(Step::Pause, 64)
            .with(Step::Drop, 64)
            .with(Step::Restore, 32)
            .with(Step::Boot, 16)
            .with(Step::Save, 16)
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

/// When the host frees memory held by idle sandboxes.
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
    /// A rule is enabled without the rule it builds on.
    Requires {
        /// The enabled rule.
        rule: Rule,
        /// The rule it needs.
        required: Rule,
    },
    /// A rule comes earlier than the rule it builds on.
    OutOfOrder {
        /// The rule that comes too early.
        rule: Rule,
        /// The rule that must come first.
        before: Rule,
    },
    /// The low memory watermark is above the high one.
    Watermarks,
    /// The compressed share is above 100 percent.
    CompressedPercent,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Requires { rule, required } => {
                write!(f, "the {rule} rule needs the {required} rule")
            }
            Self::OutOfOrder { rule, before } => {
                write!(f, "the {rule} rule comes before the {before} rule it needs")
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

    fn recommended() -> SleepPolicy {
        SleepPolicy::new(SleepRules::RECOMMENDED).unwrap()
    }

    fn state(level: Level, durability: Durability, memory_saved: bool) -> State {
        State::new(level, durability, memory_saved)
    }

    #[test]
    fn an_idle_sandbox_pauses_then_gets_protected_while_staying_in_memory() {
        let policy = recommended();
        let running = State::RUNNING;
        let paused = |durability| state(Level::Paused, durability, false);
        let none = Level::Running;
        assert_eq!(policy.next_step(running, secs(9), none), None);
        assert_eq!(policy.next_step(running, secs(10), none), Some(Step::Pause));
        assert_eq!(
            policy.next_step(paused(Durability::Volatile), secs(29), none),
            None
        );
        assert_eq!(
            policy.next_step(paused(Durability::Volatile), secs(30), none),
            Some(Step::Save)
        );
        assert_eq!(
            policy.next_step(paused(Durability::Local), secs(119), none),
            None
        );
        assert_eq!(
            policy.next_step(paused(Durability::Local), secs(120), none),
            Some(Step::Archive)
        );
        // Without memory pressure, a protected VM stays in memory for days.
        assert_eq!(
            policy.next_step(paused(Durability::Remote), secs(2 * 86_400), none),
            None
        );
        // On the third day the process ends and the local copy goes.
        let day3 = secs(3 * 86_400);
        assert_eq!(
            policy.next_step(paused(Durability::Remote), day3, none),
            Some(Step::Drop)
        );
        let archived = state(Level::Archived, Durability::Remote, true);
        assert_eq!(policy.next_step(archived, day3, none), Some(Step::Evict));
        let remote = state(Level::Remote, Durability::Remote, true);
        assert_eq!(policy.next_step(remote, day3, none), None);
        assert_eq!(
            policy.next_step(remote, secs(30 * 86_400), none),
            Some(Step::Forget)
        );
        assert_eq!(
            policy.next_step(Step::Forget.apply(remote), secs(400 * 86_400), none),
            None
        );
    }

    #[test]
    fn memory_pressure_compresses_then_ends_the_process_saving_first_if_needed() {
        let policy = recommended();
        let paused = state(Level::Paused, Durability::Volatile, false);
        assert_eq!(policy.relief_target(Level::Paused), Some(Level::Compressed));
        assert_eq!(policy.relief_target(Level::Compressed), Some(Level::Saved));
        assert_eq!(policy.relief_target(Level::Saved), None);
        assert_eq!(
            policy.next_step(State::RUNNING, secs(0), Level::Compressed),
            Some(Step::Pause)
        );
        assert_eq!(
            policy.next_step(paused, secs(0), Level::Compressed),
            Some(Step::Compress)
        );
        let compressed = Step::Compress.apply(paused);
        assert_eq!(
            policy.next_step(compressed, secs(0), Level::Saved),
            Some(Step::Save)
        );
        let saved = Step::Save.apply(compressed);
        assert_eq!(saved.level, Level::Compressed);
        assert_eq!(
            policy.next_step(saved, secs(0), Level::Saved),
            Some(Step::Drop)
        );
        assert_eq!(
            Step::Drop.apply(saved),
            state(Level::Saved, Durability::Local, true)
        );
    }

    #[test]
    fn pressure_skips_compression_when_it_is_not_allowed() {
        let policy = SleepPolicy::new(SleepRules {
            compress_under_pressure: false,
            ..SleepRules::RECOMMENDED
        })
        .unwrap();
        assert_eq!(policy.relief_target(Level::Running), Some(Level::Saved));
        assert_eq!(policy.relief_target(Level::Paused), Some(Level::Saved));
        let paused = state(Level::Paused, Durability::Local, true);
        assert_eq!(
            policy.next_step(paused, secs(0), Level::Saved),
            Some(Step::Drop)
        );
    }

    #[test]
    fn a_policy_without_saving_can_only_compress() {
        let policy = SleepPolicy::new(SleepRules {
            pause_after: Some(secs(5)),
            compress_under_pressure: true,
            ..SleepRules::NEVER
        })
        .unwrap();
        assert_eq!(policy.relief_target(Level::Paused), Some(Level::Compressed));
        assert_eq!(policy.relief_target(Level::Compressed), None);
        assert_eq!(
            policy.next_threshold(State::RUNNING, secs(0)),
            Some(secs(5))
        );
        let paused = Step::Pause.apply(State::RUNNING);
        assert_eq!(policy.next_threshold(paused, secs(5)), None);
    }

    #[test]
    fn never_policy_never_moves() {
        let policy = SleepPolicy::NEVER;
        assert!(!policy.sleeps());
        assert_eq!(
            policy.next_step(State::RUNNING, Duration::MAX, Level::Running),
            None
        );
        assert_eq!(policy.next_threshold(State::RUNNING, Duration::ZERO), None);
        assert_eq!(policy.relief_target(Level::Running), None);
    }

    #[test]
    fn an_untouched_sandbox_walks_through_every_rule_in_order() {
        let policy = recommended();
        let mut state = State::RUNNING;
        let mut idle = Duration::ZERO;
        let mut walk = Vec::new();
        loop {
            if let Some(step) = policy.next_step(state, idle, Level::Running) {
                state = step.apply(state);
                walk.push((step, idle.as_secs()));
            } else if let Some(next) = policy.next_threshold(state, idle) {
                idle = next;
            } else {
                break;
            }
        }
        let day = 86_400;
        assert_eq!(
            walk,
            [
                (Step::Pause, 10),
                (Step::Save, 30),
                (Step::Archive, 120),
                (Step::Drop, 3 * day),
                (Step::Evict, 3 * day),
                (Step::Forget, 30 * day),
            ]
        );
        assert_eq!(state, State::new(Level::Remote, Durability::Remote, false));
    }

    /// For every consistent state and a range of policies, floors and idle
    /// times: the chosen step can start and never wakes; nothing becomes due
    /// between two thresholds; and with no threshold left, nothing is ever
    /// due again.
    #[test]
    fn thresholds_never_miss_a_due_step() {
        let ms = Duration::from_millis;
        let policies = [
            recommended(),
            SleepPolicy::NEVER,
            SleepPolicy::new(SleepRules {
                pause_after: Some(secs(1)),
                save_after: Some(secs(2)),
                drop_after: Some(secs(3)),
                ..SleepRules::NEVER
            })
            .unwrap(),
            SleepPolicy::new(SleepRules {
                pause_after: Some(secs(0)),
                save_after: Some(secs(0)),
                archive_after: Some(secs(5)),
                evict_after: Some(secs(5)),
                forget_after: Some(secs(4)),
                compress_under_pressure: true,
                ..SleepRules::NEVER
            })
            .unwrap(),
        ];
        let mut states = Vec::new();
        for level in Level::ALL {
            for durability in [Durability::Volatile, Durability::Local, Durability::Remote] {
                for memory_saved in [false, true] {
                    states.push(State::new(level, durability, memory_saved));
                }
            }
        }
        for policy in policies {
            let rules = policy.rules();
            let mut points: Vec<Duration> = [
                rules.pause_after,
                rules.save_after,
                rules.archive_after,
                rules.drop_after,
                rules.evict_after,
                rules.forget_after,
            ]
            .into_iter()
            .flatten()
            .flat_map(|at| [at.saturating_sub(ms(1)), at, at + ms(1)])
            .chain([Duration::ZERO, secs(100 * 86_400)])
            .collect();
            points.sort_unstable();
            for state in &states {
                for floor in Level::ALL {
                    for idle in &points {
                        if let Some(step) = policy.next_step(*state, *idle, floor) {
                            assert!(step.can_start(*state), "{step:?} from {state:?}");
                            assert!(!step.wakes());
                        }
                    }
                    // A floor is always reached within a few steps, whatever
                    // the rules allow, and the steps then come to rest.
                    let mut reached = *state;
                    let mut steps = 0;
                    while let Some(step) = policy.next_step(reached, Duration::ZERO, floor) {
                        reached = step.apply(reached);
                        steps += 1;
                        assert!(steps <= 8, "{state:?} toward {floor:?} never rests");
                    }
                    assert!(
                        reached.level >= floor,
                        "{floor:?} not reached from {state:?}: stuck at {reached:?}"
                    );
                }
                for (index, idle) in points.iter().enumerate() {
                    if policy.next_step(*state, *idle, Level::Running).is_some() {
                        continue;
                    }
                    let next = policy.next_threshold(*state, *idle);
                    for later in &points[index..] {
                        if next.is_none_or(|next| *later < next) {
                            assert_eq!(
                                policy.next_step(*state, *later, Level::Running),
                                None,
                                "{state:?} is due at {later:?}, but the next threshold \
                                 after {idle:?} is {next:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_inconsistent_rules() {
        let rules = |f: fn(&mut SleepRules)| {
            let mut rules = SleepRules::RECOMMENDED;
            f(&mut rules);
            SleepPolicy::new(rules)
        };
        assert_eq!(
            rules(|r| r.pause_after = None),
            Err(PolicyError::Requires {
                rule: Rule::Save,
                required: Rule::Pause
            })
        );
        assert_eq!(
            rules(|r| r.archive_after = None),
            Err(PolicyError::Requires {
                rule: Rule::Evict,
                required: Rule::Archive
            })
        );
        assert_eq!(
            rules(|r| r.save_after = Some(secs(1))),
            Err(PolicyError::OutOfOrder {
                rule: Rule::Save,
                before: Rule::Pause
            })
        );
        assert_eq!(
            rules(|r| r.evict_after = Some(secs(60))),
            Err(PolicyError::OutOfOrder {
                rule: Rule::Evict,
                before: Rule::Archive
            })
        );
        assert_eq!(
            SleepPolicy::new(SleepRules {
                compress_under_pressure: true,
                ..SleepRules::NEVER
            }),
            Err(PolicyError::Requires {
                rule: Rule::Compress,
                required: Rule::Pause
            })
        );
        assert_eq!(
            SleepPolicy::new(SleepRules {
                pause_after: Some(secs(5)),
                save_after: Some(secs(10)),
                drop_after: Some(secs(7)),
                ..SleepRules::NEVER
            }),
            Err(PolicyError::OutOfOrder {
                rule: Rule::Drop,
                before: Rule::Save
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
