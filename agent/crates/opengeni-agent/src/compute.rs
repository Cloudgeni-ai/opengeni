//! Compute mode: this agent inside an Opengeni compute sandbox.
//!
//! The sandbox's guest init starts `opengeni-agent run --compute <link file>`.
//! The agent then holds no credential: it dials NATS on a loopback port that
//! the guest forwards to its host, and the host speaks for it to Opengeni
//! (the contract is `compute/docs/agent-link.md`, section 2). Everything a
//! Connected Machine does to stay enrolled (enrollment, credential renewal,
//! self-update, service installation) is Opengeni compute's job instead; the rest
//! of the agent is the same code.
//!
//! This module holds the parts of that mode with no runtime around them: the
//! link file, the relay credential the host sends, and the activity file the
//! guest counts when its host asks whether the sandbox is in use.

use std::path::{Path, PathBuf};
use std::time::Duration;

use opengeni_agent_stream::RelayEndpoint;
use serde::Deserialize;

use crate::config::StoredCredentials;

/// The subject on which the host sends the agent its relay credential. Only
/// the host answers it; it never reaches Opengeni.
pub const RELAY_SUBJECT: &str = "_compute.relay";

/// Where the guest counts activity unless the link file names another
/// directory.
pub const DEFAULT_ACTIVITY_DIR: &str = "/run/compute/activity";

/// How long a stream may carry nothing before it stops keeping its sandbox
/// awake (compute's stream silence limit), unless the link file says.
pub const DEFAULT_STREAM_SILENCE: Duration = Duration::from_secs(600);

/// How often the activity file is brought up to date.
pub const ACTIVITY_INTERVAL: Duration = Duration::from_secs(1);

/// Why a link file or a relay credential was refused.
#[derive(Debug, thiserror::Error)]
pub enum ComputeError {
    /// The link file could not be read.
    #[error("cannot read the compute link file {path}: {source}")]
    Read {
        /// The file.
        path: PathBuf,
        /// The OS error.
        source: std::io::Error,
    },
    /// The link file or a relay credential is not what the contract says.
    #[error("invalid {what}: {reason}")]
    Invalid {
        /// What was refused.
        what: &'static str,
        /// Why.
        reason: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkFile {
    workspace_id: String,
    agent_id: String,
    workspace_root: PathBuf,
    nats_url: String,
    #[serde(default)]
    activity_dir: Option<PathBuf>,
    #[serde(default)]
    stream_silence_secs: Option<u64>,
}

/// What the guest's link file tells the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputeConfig {
    /// The enrollment's workspace.
    pub workspace_id: String,
    /// The enrollment's agent id.
    pub agent_id: String,
    /// The directory the agent works in, created when missing.
    pub workspace_root: PathBuf,
    /// The loopback NATS address the guest forwards to the host.
    pub nats_url: String,
    /// Where the agent registers its activity file.
    pub activity_dir: PathBuf,
    /// How long a silent stream still counts as in use.
    pub stream_silence: Duration,
}

impl ComputeConfig {
    /// Reads and checks the link file at `path`.
    ///
    /// # Errors
    ///
    /// [`ComputeError::Read`] when it cannot be read, [`ComputeError::Invalid`]
    /// when it is not a link file.
    pub fn load(path: &Path) -> Result<Self, ComputeError> {
        let text = std::fs::read_to_string(path).map_err(|source| ComputeError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        Self::parse(&text)
    }

    fn parse(text: &str) -> Result<Self, ComputeError> {
        let invalid = |reason: String| ComputeError::Invalid {
            what: "compute link file",
            reason,
        };
        let file: LinkFile =
            serde_json::from_str(text).map_err(|error| invalid(error.to_string()))?;
        for (name, value) in [
            ("workspace_id", &file.workspace_id),
            ("agent_id", &file.agent_id),
        ] {
            if !is_identifier(value) {
                return Err(invalid(format!("{name} must be 1 to 64 of [A-Za-z0-9_-]")));
            }
        }
        if !file.workspace_root.is_absolute() {
            return Err(invalid("workspace_root must be absolute".to_string()));
        }
        if !file.nats_url.starts_with("nats://") {
            return Err(invalid("nats_url must be a nats:// address".to_string()));
        }
        let activity_dir = file
            .activity_dir
            .unwrap_or_else(|| PathBuf::from(DEFAULT_ACTIVITY_DIR));
        if !activity_dir.is_absolute() {
            return Err(invalid("activity_dir must be absolute".to_string()));
        }
        let stream_silence = match file.stream_silence_secs {
            None => DEFAULT_STREAM_SILENCE,
            Some(0) => return Err(invalid("stream_silence_secs must be positive".to_string())),
            Some(seconds) => Duration::from_secs(seconds),
        };
        Ok(Self {
            workspace_id: file.workspace_id,
            agent_id: file.agent_id,
            workspace_root: file.workspace_root,
            nats_url: file.nats_url,
            activity_dir,
            stream_silence,
        })
    }

    /// The local name of the agent's one connection.
    #[must_use]
    pub fn connection_id(&self) -> String {
        format!("compute-{}", self.agent_id)
    }

    /// The credentials the supervisor serves the connection with. They hold
    /// no secret: the host's link authenticates the sandbox, and the relay
    /// token arrives on [`RELAY_SUBJECT`]. A sandbox is its own machine, so
    /// the agent may use all of it and its screen.
    #[must_use]
    pub fn credentials(&self) -> StoredCredentials {
        StoredCredentials {
            agent_id: self.agent_id.clone(),
            workspace_id: self.workspace_id.clone(),
            nats_bearer: String::new(),
            nats_urls: vec![self.nats_url.clone()],
            relay_url: String::new(),
            relay_token: String::new(),
            update_pubkey: String::new(),
            consented_whole_machine: true,
            consented_screen_control: true,
            update_channel: "stable".to_string(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }
}

fn is_identifier(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayMessage {
    url: String,
    token: String,
    expires_at_ms: u64,
}

/// Reads a relay credential the host sent on [`RELAY_SUBJECT`]:
/// `{"url", "token", "expires_at_ms"}`.
///
/// # Errors
///
/// [`ComputeError::Invalid`] for anything else. The message never contains the
/// token.
pub fn parse_relay_credential(payload: &[u8]) -> Result<RelayEndpoint, ComputeError> {
    let invalid = |reason: &str| ComputeError::Invalid {
        what: "relay credential",
        reason: reason.to_string(),
    };
    // serde's message could quote the token; report only the kind of failure.
    let message: RelayMessage =
        serde_json::from_slice(payload).map_err(|_| invalid("not {url, token, expires_at_ms}"))?;
    if message.url.is_empty() || message.token.is_empty() {
        return Err(invalid("empty url or token"));
    }
    Ok(RelayEndpoint {
        url: message.url,
        token: message.token,
        expires_at_ms: Some(message.expires_at_ms),
    })
}

/// The agent's activity file, `<dir>/agent.<pid>`: a decimal count of what
/// it has in use. The guest adds it to its answer while the process lives.
#[derive(Debug)]
pub struct ActivityFile {
    dir: PathBuf,
    path: PathBuf,
    scratch: PathBuf,
    written: Option<usize>,
}

impl ActivityFile {
    /// The file for process `pid` in `dir`. Nothing is written yet.
    #[must_use]
    pub fn new(dir: &Path, pid: u32) -> Self {
        Self {
            dir: dir.to_path_buf(),
            path: dir.join(format!("agent.{pid}")),
            // The guest counts only `<label>.<decimal pid>`, so it never reads
            // the half-written scratch file.
            scratch: dir.join(format!("agent.{pid}.next")),
            written: None,
        }
    }

    /// Records `count`, replacing the file in one step, when it differs from
    /// what the file holds.
    ///
    /// # Errors
    ///
    /// The OS error; the next call tries again.
    pub fn record(&mut self, count: usize) -> std::io::Result<()> {
        if self.written == Some(count) {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        std::fs::write(&self.scratch, format!("{count}\n"))?;
        std::fs::rename(&self.scratch, &self.path)?;
        self.written = Some(count);
        Ok(())
    }

    /// Removes the file: the agent no longer holds anything.
    pub fn remove(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(&self.scratch);
        self.written = None;
    }

    /// The file's path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ActivityFile {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Keeps `file` current with `count()` every [`ACTIVITY_INTERVAL`] until the
/// task is dropped.
pub async fn report_activity(mut file: ActivityFile, count: impl Fn() -> usize) {
    let mut tick = tokio::time::interval(ACTIVITY_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut failing = false;
    loop {
        tick.tick().await;
        match file.record(count()) {
            Ok(()) => failing = false,
            Err(error) if !failing => {
                failing = true;
                tracing::warn!(%error, path = %file.path().display(), "could not record the agent's activity; retrying");
            }
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = r#"{"workspace_id": "w-1", "agent_id": "a_1", "workspace_root": "/workspace", "nats_url": "nats://127.0.0.1:3958"}"#;

    #[test]
    fn the_link_file_the_guest_writes_is_read() {
        let config = ComputeConfig::parse(LINK).expect("link file");
        assert_eq!(
            config,
            ComputeConfig {
                workspace_id: "w-1".to_string(),
                agent_id: "a_1".to_string(),
                workspace_root: PathBuf::from("/workspace"),
                nats_url: "nats://127.0.0.1:3958".to_string(),
                activity_dir: PathBuf::from(DEFAULT_ACTIVITY_DIR),
                stream_silence: DEFAULT_STREAM_SILENCE,
            }
        );
        assert_eq!(config.connection_id(), "compute-a_1");
        let credentials = config.credentials();
        assert_eq!(credentials.nats_bearer, "");
        assert_eq!(credentials.relay_token, "");
        assert_eq!(credentials.nats_urls, ["nats://127.0.0.1:3958"]);
        assert!(credentials.consented_whole_machine && credentials.consented_screen_control);
    }

    #[test]
    fn optional_settings_are_read() {
        let config = ComputeConfig::parse(
            r#"{"workspace_id": "w", "agent_id": "a", "workspace_root": "/w", "nats_url": "nats://127.0.0.1:1",
                "activity_dir": "/tmp/activity", "stream_silence_secs": 30}"#,
        )
        .expect("link file");
        assert_eq!(config.activity_dir, PathBuf::from("/tmp/activity"));
        assert_eq!(config.stream_silence, Duration::from_secs(30));
    }

    #[test]
    fn anything_else_is_refused() {
        let with = |key: &str, value: &str| {
            let mut file: serde_json::Value = serde_json::from_str(LINK).unwrap();
            file[key] = serde_json::from_str(value).unwrap();
            file.to_string()
        };
        for bad in [
            String::new(),
            "[]".to_string(),
            with("workspace_id", r#""""#),
            with("agent_id", r#""a/b""#),
            with("agent_id", &format!("\"{}\"", "a".repeat(65))),
            with("workspace_root", r#""workspace""#),
            with("nats_url", r#""tls://127.0.0.1:3958""#),
            with("activity_dir", r#""activity""#),
            with("stream_silence_secs", "0"),
            with("bearer", r#""x""#),
        ] {
            assert!(
                matches!(ComputeConfig::parse(&bad), Err(ComputeError::Invalid { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_relay_credential_is_read_and_its_token_never_reported() {
        let endpoint = parse_relay_credential(
            br#"{"url": "wss://relay.example/stream", "token": "ogr_t", "expires_at_ms": 1700000000000}"#,
        )
        .expect("credential");
        assert_eq!(endpoint.url, "wss://relay.example/stream");
        assert_eq!(endpoint.token, "ogr_t");
        assert_eq!(endpoint.expires_at_ms, Some(1_700_000_000_000));
        for bad in [
            &br#"{"url": "", "token": "ogr_secret", "expires_at_ms": 1}"#[..],
            br#"{"url": "wss://r", "token": "", "expires_at_ms": 1}"#,
            br#"{"url": "wss://r", "token": "ogr_secret"}"#,
            br#"{"url": "wss://r", "token": "ogr_secret", "expires_at_ms": "soon"}"#,
            b"ogr_secret",
        ] {
            let error = parse_relay_credential(bad).expect_err("refused");
            assert!(!error.to_string().contains("ogr_secret"), "{error}");
        }
    }

    #[test]
    fn the_activity_file_holds_the_latest_count_under_the_guests_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let activity_dir = dir.path().join("activity");
        let mut file = ActivityFile::new(&activity_dir, 4242);
        assert_eq!(file.path(), activity_dir.join("agent.4242"));
        file.record(0).expect("record");
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "0\n");
        file.record(3).expect("record");
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "3\n");
        let names: Vec<_> = std::fs::read_dir(&activity_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["agent.4242"], "no scratch file is left behind");

        // An unchanged count is not rewritten.
        std::fs::write(file.path(), "7\n").unwrap();
        file.record(3).expect("record");
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "7\n");

        let path = file.path().to_path_buf();
        drop(file);
        assert!(!path.exists(), "the file goes with the agent");
    }

    #[tokio::test(start_paused = true)]
    async fn activity_is_reported_each_interval() {
        let dir = tempfile::tempdir().expect("tempdir");
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(2));
        let file = ActivityFile::new(dir.path(), 7);
        let path = file.path().to_path_buf();
        let reporter = tokio::spawn({
            let count = count.clone();
            report_activity(file, move || {
                count.load(std::sync::atomic::Ordering::Relaxed)
            })
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "2\n");
        count.store(0, std::sync::atomic::Ordering::Relaxed);
        tokio::time::sleep(ACTIVITY_INTERVAL).await;
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0\n");
        reporter.abort();
        let _ = reporter.await;
        assert!(!path.exists(), "an ended reporter removes its file");
    }
}
