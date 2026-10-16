//! The host agent's local API: one JSON request per line on a Unix socket,
//! answered by one JSON reply line.
//!
//! A `connect` request turns the connection into a byte stream to a port
//! inside the sandbox after its reply line, waking the sandbox first. That
//! single primitive serves commands, terminals, file access and previews.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use compute_core::{Durability, Level, Priority, SandboxId, SleepPolicy, SleepRules, Step};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A sandbox id on the wire: 32 lowercase hex digits (a UUID without dashes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id(pub SandboxId);

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:032x}", self.0.0)
    }
}

impl FromStr for Id {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let digits: String = text.chars().filter(|c| *c != '-').collect();
        if digits.len() != 32 {
            return Err(format!("sandbox id must have 32 hex digits: {text}"));
        }
        u128::from_str_radix(&digits, 16)
            .map(|value| Self(SandboxId(value)))
            .map_err(|error| format!("bad sandbox id {text}: {error}"))
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// [`Level`] on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum LevelName {
    Running,
    Paused,
    Compressed,
    Saved,
    Archived,
    Remote,
}

impl From<Level> for LevelName {
    fn from(level: Level) -> Self {
        match level {
            Level::Running => Self::Running,
            Level::Paused => Self::Paused,
            Level::Compressed => Self::Compressed,
            Level::Saved => Self::Saved,
            Level::Archived => Self::Archived,
            Level::Remote => Self::Remote,
        }
    }
}

impl From<LevelName> for Level {
    fn from(level: LevelName) -> Self {
        match level {
            LevelName::Running => Self::Running,
            LevelName::Paused => Self::Paused,
            LevelName::Compressed => Self::Compressed,
            LevelName::Saved => Self::Saved,
            LevelName::Archived => Self::Archived,
            LevelName::Remote => Self::Remote,
        }
    }
}

/// [`Priority`] on the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum PriorityName {
    #[default]
    Interactive,
    Proactive,
    Background,
}

impl From<PriorityName> for Priority {
    fn from(priority: PriorityName) -> Self {
        match priority {
            PriorityName::Interactive => Self::Interactive,
            PriorityName::Proactive => Self::Proactive,
            PriorityName::Background => Self::Background,
        }
    }
}

/// [`Durability`] on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum DurabilityName {
    Volatile,
    Local,
    Remote,
}

impl From<Durability> for DurabilityName {
    fn from(durability: Durability) -> Self {
        match durability {
            Durability::Volatile => Self::Volatile,
            Durability::Local => Self::Local,
            Durability::Remote => Self::Remote,
        }
    }
}

/// How a sandbox sleeps: idle milliseconds before each rule applies, and an
/// omitted rule never applies. The default never sleeps. See
/// [`SleepRules`] for what each rule does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SleepConfig {
    /// Pause the VM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after_ms: Option<u64>,
    /// Save to local disk while the VM stays paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_after_ms: Option<u64>,
    /// Copy the saved state to object storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_after_ms: Option<u64>,
    /// End the VM process even without memory pressure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drop_after_ms: Option<u64>,
    /// Delete the local copy, keeping object storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evict_after_ms: Option<u64>,
    /// Delete the memory image, keeping the files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forget_after_ms: Option<u64>,
    /// Let memory pressure compress the paused VM's memory, on hosts that
    /// can.
    #[serde(default)]
    pub compress: bool,
}

impl SleepConfig {
    /// [`SleepRules::RECOMMENDED`] on the wire.
    pub const RECOMMENDED: Self = Self::from_rules(SleepRules::RECOMMENDED);

    /// The rules on the wire. Durations round down to whole milliseconds.
    #[must_use]
    pub const fn from_rules(rules: SleepRules) -> Self {
        const fn ms(duration: Option<Duration>) -> Option<u64> {
            match duration {
                // Saturates far beyond any useful idle time.
                #[allow(clippy::cast_possible_truncation)]
                Some(duration) => Some(duration.as_millis() as u64),
                None => None,
            }
        }
        Self {
            pause_after_ms: ms(rules.pause_after),
            save_after_ms: ms(rules.save_after),
            archive_after_ms: ms(rules.archive_after),
            drop_after_ms: ms(rules.drop_after),
            evict_after_ms: ms(rules.evict_after),
            forget_after_ms: ms(rules.forget_after),
            compress: rules.compress_under_pressure,
        }
    }

    /// The rules these settings describe.
    #[must_use]
    pub fn rules(&self) -> SleepRules {
        let after = |ms: Option<u64>| ms.map(Duration::from_millis);
        SleepRules {
            pause_after: after(self.pause_after_ms),
            save_after: after(self.save_after_ms),
            archive_after: after(self.archive_after_ms),
            drop_after: after(self.drop_after_ms),
            evict_after: after(self.evict_after_ms),
            forget_after: after(self.forget_after_ms),
            compress_under_pressure: self.compress,
        }
    }
}

/// The most guest memory a sandbox may have, in MiB.
pub const MAX_MEMORY_MIB: u32 = 65_536;

/// What a sandbox looks like and how it sleeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxConfig {
    /// Virtual processors.
    pub vcpus: u8,
    /// Guest memory in MiB.
    pub memory_mib: u32,
    /// How it sleeps; omitted, it never sleeps.
    #[serde(default)]
    pub sleep: SleepConfig,
}

impl SandboxConfig {
    /// The sleep settings as a validated core policy.
    pub fn sleep_policy(&self) -> Result<SleepPolicy, String> {
        SleepPolicy::new(self.sleep.rules())
            .map_err(|error| format!("invalid sleep settings: {error}"))
    }

    /// Checks everything that can be wrong before any work is done.
    pub fn validate(&self) -> Result<SleepPolicy, String> {
        if self.vcpus == 0 || self.vcpus > 32 {
            return Err("vcpus must be between 1 and 32".into());
        }
        if !(128..=MAX_MEMORY_MIB).contains(&self.memory_mib) {
            return Err(format!(
                "memory_mib must be between 128 and {MAX_MEMORY_MIB}"
            ));
        }
        self.sleep_policy()
    }
}

/// One request.
///
/// Requests about an existing sandbox may name the `generation` (the
/// sandbox's execution, from [`SandboxStatus::generation`]) they were issued
/// under. Such a request is refused with [`ErrorCode::Stale`] once a boot has
/// replaced that execution (memory was lost), so a caller relying on programs
/// it started inside the sandbox learns they are gone instead of acting on a
/// different execution. Pausing, saving and restoring continue the same
/// execution and keep the generation.
///
/// Every request may be retried after a lost reply. Create is idempotent:
/// repeating it with the same settings succeeds, with other settings it is
/// refused with [`ErrorCode::Exists`], and while the first attempt is still
/// under way with [`ErrorCode::Busy`]. Remove reports
/// [`ErrorCode::NotFound`] once the sandbox is gone, which a retrying
/// caller takes as done. Waking, holding and connecting change nothing a
/// repeat would undo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Create a sandbox, or confirm one made with the same settings. It
    /// costs nothing until first needed: the first wake boots it.
    Create {
        /// Its id.
        id: Id,
        /// Its shape and sleep ladder.
        config: SandboxConfig,
    },
    /// Delete a sandbox and everything it stores.
    Remove {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
    },
    /// Note that a sandbox will probably be needed soon and start waking it,
    /// without waiting.
    Touch {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// How urgently.
        #[serde(default)]
        priority: PriorityName,
    },
    /// Wake a sandbox and reply once it runs.
    Wake {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// How urgently.
        #[serde(default)]
        priority: PriorityName,
    },
    /// Wake a sandbox, then turn this connection into a byte stream to
    /// `port` inside it. The sandbox stays awake while the stream is open.
    Connect {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// The guest vsock port.
        port: u32,
        /// How urgently.
        #[serde(default)]
        priority: PriorityName,
    },
    /// Put a sandbox at least as deep as `level` now, whatever its sleep
    /// settings say, for example to drain the host. Replies at once; the
    /// sandbox waits while something holds it awake, and a later wake
    /// cancels the request.
    Sleep {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// The least depth to reach.
        level: LevelName,
    },
    /// Keep a sandbox awake for a named reason, such as an agent turn in
    /// progress, waking it if it sleeps. Replies once the hold is on disk,
    /// without waiting for the wake: it outlasts a restart of the host
    /// agent. Holding again under the same name refreshes the hold, and
    /// with `ttl_ms` it lapses on its own unless refreshed in time, so a
    /// caller that disappears cannot keep a sandbox awake forever.
    Hold {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// The reason, unique within the sandbox.
        hold: String,
        /// Milliseconds until the hold lapses; omitted, it lasts until
        /// released.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_ms: Option<u64>,
        /// How urgently to wake for it.
        #[serde(default)]
        priority: PriorityName,
    },
    /// End a named hold. Ending one that does not exist does nothing.
    Release {
        /// Its id.
        id: Id,
        /// Only while the sandbox is at this generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<u64>,
        /// The reason that ended.
        hold: String,
    },
    /// Report every sandbox and host counters.
    Status,
}

/// One reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Reply {
    /// The request succeeded.
    Done,
    /// The sandbox runs. `waited_us` is how long the host waited for it.
    Woken {
        /// Microseconds spent waking.
        waited_us: u64,
        /// The step under way when the wake arrived, if any; a wake during
        /// a sleep step such as `pause` or `save` cancels it or waits for
        /// it to finish.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        during: Option<String>,
        /// The execution that is running. It changes only when the sandbox
        /// boots afresh, which ends every program in it; pass it to later
        /// requests that rely on programs started now.
        #[serde(default)]
        generation: u64,
    },
    /// The stream to the guest port follows this line.
    Connected {
        /// Microseconds spent waking.
        waited_us: u64,
        /// Microseconds spent reaching the guest port after waking.
        connect_us: u64,
        /// The execution the stream reached, as in [`Reply::Woken`].
        #[serde(default)]
        generation: u64,
    },
    /// The host's state.
    Status(Box<HostStatus>),
    /// The request failed.
    Error {
        /// What went wrong.
        message: String,
        /// What kind of failure, for callers that act on it.
        #[serde(default)]
        code: ErrorCode,
    },
}

/// What kind of failure a [`Reply::Error`] reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request is malformed or not allowed.
    Invalid,
    /// No such sandbox.
    NotFound,
    /// A sandbox of that id exists with other settings, or is being
    /// removed.
    Exists,
    /// The sandbox is still being created; try again.
    Busy,
    /// The sandbox failed in a way this host cannot retry: it can be
    /// removed, or restored elsewhere from a stored copy. Retrying here
    /// does not help.
    Broken,
    /// The host does not manage the sandbox until someone resolves why
    /// (status lists it under `blocked`, with the reason). Its files and
    /// any VM are kept as they are, and it can still be removed. Retrying
    /// does not help until then.
    Blocked,
    /// The sandbox was removed while the request waited.
    Removed,
    /// The request names a generation the sandbox has moved past.
    Stale,
    /// A guest port did not answer.
    Unreachable,
    /// The host failed; the request may succeed if retried.
    #[default]
    Internal,
}

/// One sandbox's state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxStatus {
    /// Its id.
    pub id: Id,
    /// Its execution: raised by every boot; pausing, saving and restoring
    /// keep it.
    pub generation: u64,
    /// How many times its record has been written.
    pub revision: u64,
    /// Where its state lives.
    pub level: LevelName,
    /// Where a copy of its current state is kept besides the VM.
    pub durability: DurabilityName,
    /// Whether its running programs survive (a memory image or live VM).
    pub memory_saved: bool,
    /// The step in progress.
    pub step: Option<String>,
    /// Reasons it is held awake.
    pub holds: usize,
    /// VM processes started for it, boots and restores alike, since the
    /// host agent started: every one the engine saw running, including
    /// those that then failed to boot or restore.
    #[serde(default)]
    pub launches: u64,
    /// Host memory it holds, when a VM process exists.
    pub resident_bytes: Option<u64>,
    /// Whether no copy of its VM process can be trusted, such as when its
    /// disk may have lost writes: it keeps running and pausing, but sleeps
    /// no deeper than compressed until its VM process is replaced.
    #[serde(default)]
    pub unsavable: bool,
    /// Whether it is beyond recovery on this host.
    pub broken: bool,
}

/// Counters for one kind of step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepStats {
    /// Steps started.
    pub started: u64,
    /// Steps that reached their target.
    pub done: u64,
    /// Steps cancelled before taking effect.
    pub cancelled: u64,
    /// Steps that failed.
    pub failed: u64,
    /// Running now.
    pub in_flight: u32,
    /// Total microseconds of finished steps.
    pub total_us: u64,
    /// Slowest finished step in microseconds.
    pub max_us: u64,
}

/// The host's state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostStatus {
    /// Every sandbox.
    pub sandboxes: Vec<SandboxStatus>,
    /// Counters per step kind, by name.
    pub steps: Vec<(String, StepStats)>,
    /// Host memory available, as last sampled.
    pub available_memory: Option<u64>,
    /// Host memory that ending idle, saved VM processes would free at once
    /// without losing anything. Placement can count it as available.
    #[serde(default)]
    pub reclaimable_memory: u64,
    /// Sandboxes the host cannot manage: their record could not be read,
    /// their recovery or removal failed. Their ids are refused for new
    /// sandboxes and their files and any VM left alone; removing one retries
    /// when its record is readable.
    #[serde(default)]
    pub blocked: Vec<BlockedSandbox>,
    /// How long, in milliseconds, memory has been failing to arrive from an
    /// object store that does not answer, if it is. Sandboxes waking from
    /// the store stall meanwhile; they lose nothing and carry on once it
    /// answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_stalled_ms: Option<u64>,
    /// Running sandboxes whose processor use and traffic could not be read
    /// lately. They count as busy, so none falls asleep unseen; a number
    /// above zero means the host's sensing is failing.
    #[serde(default)]
    pub unseen_activity: usize,
    /// What the host runs.
    #[serde(default)]
    pub about: About,
}

/// What a host agent runs, so a measurement can say what it measured.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct About {
    /// The agent's build: the start of a hash of its executable.
    #[serde(default)]
    pub build: String,
    /// What memory images made here depend on, such as the VMM's version
    /// and the processor.
    #[serde(default)]
    pub runtime: String,
    /// How guest memory is backed.
    #[serde(default)]
    pub memory_profile: String,
    /// The disk image new sandboxes start from: its path, size and last
    /// change.
    #[serde(default)]
    pub base_image: String,
}

/// A sandbox the host cannot manage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedSandbox {
    /// Its id, which the host refuses to reuse.
    pub id: Id,
    /// What went wrong.
    pub problem: String,
}

/// A step's name on the wire.
#[must_use]
pub fn step_name(step: Step) -> &'static str {
    match step {
        Step::Resume => "resume",
        Step::Restore => "restore",
        Step::Boot => "boot",
        Step::Fetch => "fetch",
        Step::Pause => "pause",
        Step::Drop => "drop",
        Step::Compress => "compress",
        Step::Save => "save",
        Step::Archive => "archive",
        Step::Evict => "evict",
        Step::Forget => "forget",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_with_or_without_dashes() {
        let id: Id = "0193f3c2-7a1b-7cde-8f00-112233445566".parse().unwrap();
        assert_eq!(id.to_string(), "0193f3c27a1b7cde8f00112233445566");
        assert_eq!(id.to_string().parse::<Id>().unwrap(), id);
        assert!("abc".parse::<Id>().is_err());
    }

    #[test]
    fn requests_parse_from_compact_json() {
        let request: Request = serde_json::from_str(
            r#"{"op":"connect","id":"0193f3c27a1b7cde8f00112233445566","port":52}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            Request::Connect {
                port: 52,
                priority: PriorityName::Interactive,
                ..
            }
        ));
    }

    #[test]
    fn configs_are_validated() {
        let mut config = SandboxConfig {
            vcpus: 2,
            memory_mib: 1024,
            sleep: SleepConfig::RECOMMENDED,
        };
        assert!(config.validate().is_ok());
        config.sleep.pause_after_ms = None;
        assert!(config.validate().is_err(), "saving requires pausing");
        config.sleep = SleepConfig::default();
        assert!(config.validate().is_ok(), "never sleeping is valid");
        config.vcpus = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn sleep_settings_round_trip_and_omit_disabled_rules() {
        assert_eq!(
            SleepConfig::RECOMMENDED.rules(),
            compute_core::SleepRules::RECOMMENDED
        );
        let json = serde_json::to_string(&SleepConfig {
            pause_after_ms: Some(10_000),
            ..SleepConfig::default()
        })
        .unwrap();
        assert_eq!(json, r#"{"pause_after_ms":10000,"compress":false}"#);
        let parsed: SleepConfig = serde_json::from_str(r#"{"pause_after_ms":5}"#).unwrap();
        assert_eq!(parsed.rules().pause_after, Some(Duration::from_millis(5)));
        assert!(serde_json::from_str::<SleepConfig>(r#"{"pause":5}"#).is_err());
    }
}
