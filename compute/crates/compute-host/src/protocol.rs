//! The host agent's local API: one JSON request per line on a Unix socket,
//! answered by one JSON reply line.
//!
//! A `connect` request turns the connection into a byte stream to a port
//! inside the sandbox after its reply line, waking the sandbox first. That
//! single primitive serves commands, terminals, file access and previews.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use compute_core::{Level, Priority, SandboxId, SleepPolicy, Step};
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

/// Sleep one level deeper after this long without activity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SleepRule {
    /// The level to reach.
    pub level: LevelName,
    /// Idle milliseconds before reaching it.
    pub after_ms: u64,
}

/// What a sandbox looks like and how it sleeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxConfig {
    /// Virtual processors.
    pub vcpus: u8,
    /// Guest memory in MiB.
    pub memory_mib: u32,
    /// The sleep ladder; an empty ladder never sleeps.
    pub sleep: Vec<SleepRule>,
}

impl SandboxConfig {
    /// The ladder as a validated core policy.
    pub fn sleep_policy(&self) -> Result<SleepPolicy, String> {
        SleepPolicy::new(
            self.sleep
                .iter()
                .map(|rule| (rule.level.into(), Duration::from_millis(rule.after_ms))),
        )
        .map_err(|error| format!("invalid sleep ladder: {error:?}"))
    }

    /// Checks everything that can be wrong before any work is done.
    pub fn validate(&self) -> Result<SleepPolicy, String> {
        if self.vcpus == 0 || self.vcpus > 32 {
            return Err("vcpus must be between 1 and 32".into());
        }
        if !(128..=65_536).contains(&self.memory_mib) {
            return Err("memory_mib must be between 128 and 65536".into());
        }
        self.sleep_policy()
    }
}

/// One request.
///
/// Requests about an existing sandbox may name the `generation` (the
/// sandbox's execution, from [`SandboxStatus::generation`]) they were issued
/// under. Such a request is refused with [`ErrorCode::Stale`] once a boot or
/// restore has replaced that execution, so a caller relying on programs it
/// started inside the sandbox learns they are gone instead of acting on a
/// different execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Create a sandbox. It costs nothing until first needed: the first
    /// wake boots it.
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
    },
    /// The stream to the guest port follows this line.
    Connected {
        /// Microseconds spent waking.
        waited_us: u64,
        /// Microseconds spent reaching the guest port after waking.
        connect_us: u64,
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
    /// The sandbox already exists.
    Exists,
    /// The sandbox is still being created; try again.
    Busy,
    /// The sandbox cannot run on this host.
    Broken,
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
    /// Its execution: raised by every boot and restore.
    pub generation: u64,
    /// How many times its record has been written.
    pub revision: u64,
    /// Where its state lives.
    pub level: LevelName,
    /// Whether its running programs survive (a memory image or live VM).
    pub memory_saved: bool,
    /// The step in progress.
    pub step: Option<String>,
    /// Reasons it is held awake.
    pub holds: usize,
    /// Host memory it holds, when a VM process exists.
    pub resident_bytes: Option<u64>,
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
        Step::Compress => "compress",
        Step::Save => "save",
        Step::Archive => "archive",
        Step::Evict => "evict",
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
            sleep: vec![
                SleepRule {
                    level: LevelName::Paused,
                    after_ms: 30_000,
                },
                SleepRule {
                    level: LevelName::Saved,
                    after_ms: 600_000,
                },
            ],
        };
        assert!(config.validate().is_ok());
        config.sleep.remove(0);
        assert!(config.validate().is_err(), "saved requires paused");
        config.sleep.clear();
        config.vcpus = 0;
        assert!(config.validate().is_err());
    }
}
