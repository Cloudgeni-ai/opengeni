//! Agent configuration directory + persisted enrollment credentials.
//!
//! After a successful device-flow enrollment the agent persists its scoped
//! credentials (NATS Account creds + URLs, the relay URL, the pinned update
//! public key, and the consent grants) to a per-user config directory with
//! `0600` permissions (dossier §2/§23.1). On `run` the agent loads them back; if
//! none exist it enrolls first ("enroll-if-needed").
//!
//! The on-disk shape is a small JSON document, deliberately decoupled from the
//! proto [`EnrollmentCredentials`](opengeni_agent_proto::v1::EnrollmentCredentials)
//! wire message so the persisted file can carry agent-local fields (the rotating
//! resume token, the install secret-key seed) that never travel on the wire.
//! [`StoredCredentials::from_proto`] is the one conversion point.

use std::path::{Path, PathBuf};

use opengeni_agent_proto::v1::EnrollmentCredentials;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The environment variable overriding the config directory (used by the
/// non-interactive CI harness and tests so they never touch the real user dir).
const CONFIG_DIR_ENV: &str = "OPENGENI_CONFIG_DIR";

/// Errors from loading/persisting agent state.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// The config directory could not be resolved (no `$HOME`/`$OPENGENI_CONFIG_DIR`).
    #[error("could not resolve a config directory: set $OPENGENI_CONFIG_DIR or $HOME")]
    NoConfigDir,
    /// A filesystem operation on the config dir/file failed.
    #[error("config io error at {path}: {source}")]
    Io {
        /// The path the failing op touched.
        path: PathBuf,
        /// The underlying IO error.
        source: std::io::Error,
    },
    /// The persisted credentials file was present but could not be parsed.
    #[error("malformed credentials file at {path}: {source}")]
    Parse {
        /// The credentials file path.
        path: PathBuf,
        /// The deserialization error.
        source: serde_json::Error,
    },
}

impl ConfigError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// Resolves the agent's config directory (`$OPENGENI_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/opengeni/agent`, else `$HOME/.config/opengeni/agent`).
///
/// # Errors
///
/// Returns [`ConfigError::NoConfigDir`] when neither the override nor a home
/// directory can be resolved.
pub fn config_dir() -> Result<PathBuf, ConfigError> {
    if let Some(dir) = std::env::var_os(CONFIG_DIR_ENV) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Ok(PathBuf::from(xdg).join("opengeni").join("agent"));
        }
    }
    let home = home_dir().ok_or(ConfigError::NoConfigDir)?;
    Ok(home.join(".config").join("opengeni").join("agent"))
}

/// Best-effort home-directory resolution without pulling in an extra crate.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            // Windows fallback.
            std::env::var_os("USERPROFILE")
                .filter(|h| !h.is_empty())
                .map(PathBuf::from)
        })
}

/// The credentials file name inside the config dir.
const CREDENTIALS_FILE: &str = "credentials.json";

/// The agent's persisted, scoped enrollment state.
///
/// This is the source of truth the supervisor dials NATS with. It mirrors the
/// proto [`EnrollmentCredentials`] plus the agent-local rotating
/// [`resume_token`](Self::resume_token), which the control plane mints per
/// connection and which never appears in install scripts or logs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCredentials {
    /// This agent's stable id within the workspace.
    pub agent_id: String,
    /// The workspace this agent is scoped to.
    pub workspace_id: String,
    /// The NATS Account creds-file body for the control-plane connection.
    pub nats_credentials: String,
    /// NATS server URL(s) to dial.
    pub nats_urls: Vec<String>,
    /// The relay edge base URL for stream channels (M8).
    pub relay_url: String,
    /// The agent's enrollment-scoped relay PRODUCER token, presented on a
    /// `StreamOpen` when the agent registers a pty/desktop channel (dossier §10.5,
    /// the relay-dial protocol). Distinct from the viewer's control-plane-minted
    /// `ogs_` token — the relay validates each side and pairs by channel key. The
    /// control plane fills this at enrollment; empty until then (a channel open then
    /// presents an empty token the relay rejects, surfacing the gap rather than
    /// silently failing).
    #[serde(default)]
    pub relay_token: String,
    /// The minisign public key pinned for self-update verification (M11).
    pub update_pubkey: String,
    /// Whether the user consented to whole-machine access.
    pub consented_whole_machine: bool,
    /// Whether the user consented to screen capture + synthetic input.
    pub consented_screen_control: bool,
    /// The update channel this agent follows (`stable`|`beta`).
    #[serde(default = "default_channel")]
    pub update_channel: String,
    /// The most recent resume token the control plane minted for this agent,
    /// echoed on the next reconnect so the control plane fences by epoch
    /// (§10.6). Empty until the first successful connect rotates one in.
    #[serde(default)]
    pub resume_token: String,
    /// The last lease epoch the agent observed, for the integer fence.
    #[serde(default)]
    pub last_known_epoch: u32,
}

fn default_channel() -> String {
    "stable".to_string()
}

impl StoredCredentials {
    /// Folds a proto [`EnrollmentCredentials`] (just received from the device
    /// flow) plus the selected `update_channel` into the persisted shape. The
    /// resume token starts empty and is filled by the first connect.
    #[must_use]
    pub fn from_proto(proto: EnrollmentCredentials, update_channel: impl Into<String>) -> Self {
        Self {
            agent_id: proto.agent_id,
            workspace_id: proto.workspace_id,
            nats_credentials: proto.nats_credentials,
            nats_urls: proto.nats_urls,
            relay_url: proto.relay_url,
            // The proto EnrollmentCredentials now carries the relay producer token
            // (M8b reconciled the relay-dial seam): thread it straight through so a
            // freshly-enrolled agent presents it on its first channel registration.
            relay_token: proto.relay_token,
            update_pubkey: proto.update_pubkey,
            consented_whole_machine: proto.consented_whole_machine,
            consented_screen_control: proto.consented_screen_control,
            update_channel: update_channel.into(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }

    /// The NATS RPC subject this agent subscribes to: `agent.<ws>.<id>.rpc`
    /// (§10.1). Subscribing to this subject IS the registry.
    #[must_use]
    pub fn rpc_subject(&self) -> String {
        format!("agent.{}.{}.rpc", self.workspace_id, self.agent_id)
    }

    /// The subject the agent publishes outbound events (heartbeats, going-offline)
    /// on: `agent.<ws>.<id>.events`.
    #[must_use]
    pub fn events_subject(&self) -> String {
        format!("agent.{}.{}.events", self.workspace_id, self.agent_id)
    }
}

/// Loads the persisted credentials from the config dir, or `Ok(None)` if the
/// agent has not enrolled yet.
///
/// # Errors
///
/// Returns [`ConfigError`] if the config dir cannot be resolved, the file exists
/// but cannot be read, or it is present but malformed.
pub fn load_credentials() -> Result<Option<StoredCredentials>, ConfigError> {
    let path = config_dir()?.join(CREDENTIALS_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let creds = serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
            Ok(Some(creds))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::io(path, e)),
    }
}

/// Persists the credentials to the config dir with `0600` permissions (the file
/// holds the workspace-scoped NATS Account creds — never world-readable).
///
/// # Errors
///
/// Returns [`ConfigError`] if the directory cannot be created or the file cannot
/// be written.
pub fn save_credentials(creds: &StoredCredentials) -> Result<PathBuf, ConfigError> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| ConfigError::io(&dir, e))?;
    let path = dir.join(CREDENTIALS_FILE);
    let body = serde_json::to_vec_pretty(creds).expect("StoredCredentials serializes");

    // Write then tighten the mode to 0600. We write first (creating the file),
    // then set permissions, so the secret never momentarily exists world-readable
    // on platforms where create honors the umask loosely.
    std::fs::write(&path, &body).map_err(|e| ConfigError::io(&path, e))?;
    restrict_permissions(&path)?;
    Ok(path)
}

/// Tightens a file to owner-only read/write (`0600`) on unix; a no-op elsewhere
/// (Windows ACL tightening is handled by the install path, dossier §23.1).
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| ConfigError::io(path, e))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// `$OPENGENI_CONFIG_DIR` is process-global, so the config tests (which each
    /// point it at their own temp dir) must not run concurrently or they clobber
    /// each other. This mutex serializes them; each test holds the guard for its
    /// whole body. We tolerate a poisoned lock (a prior panic) by recovering the
    /// guard, since the env state is reset per test anyway.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Points the config dir at a fresh temp dir for the duration of the test,
    /// returning both the env-serialization guard and the temp-dir guard so they
    /// outlive the test body.
    fn with_temp_config() -> (MutexGuard<'static, ()>, tempfile::TempDir) {
        let lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::tempdir().expect("tempdir");
        std::env::set_var(CONFIG_DIR_ENV, dir.path());
        (lock, dir)
    }

    fn sample() -> StoredCredentials {
        StoredCredentials {
            agent_id: "agent-123".to_string(),
            workspace_id: "ws-abc".to_string(),
            nats_credentials: "-----BEGIN NATS USER JWT-----\nx\n------END------".to_string(),
            nats_urls: vec!["tls://nats.example:4222".to_string()],
            relay_url: "https://relay.example".to_string(),
            relay_token: "agent-relay-token".to_string(),
            update_pubkey: "RWQ...".to_string(),
            consented_whole_machine: true,
            consented_screen_control: false,
            update_channel: "stable".to_string(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }

    #[test]
    fn save_then_load_roundtrips() {
        let _guard = with_temp_config(); // (lock, tempdir) held for the test body
        let creds = sample();
        let path = save_credentials(&creds).expect("save");
        assert!(path.exists());
        let loaded = load_credentials().expect("load").expect("present");
        assert_eq!(loaded, creds);
    }

    #[test]
    fn load_absent_is_none() {
        let _guard = with_temp_config(); // (lock, tempdir) held for the test body
        assert!(load_credentials().expect("load").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = with_temp_config(); // (lock, tempdir) held for the test body
        let path = save_credentials(&sample()).expect("save");
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "credentials must be owner-only");
    }

    #[test]
    fn resume_token_round_trips_through_persistence() {
        // The resume-token round-trip the supervisor relies on (§10.6): persist a
        // rotated token + epoch, reload, and confirm they survive.
        let _guard = with_temp_config(); // (lock, tempdir) held for the test body
        let mut creds = sample();
        creds.resume_token = "resume-deadbeef".to_string();
        creds.last_known_epoch = 7;
        save_credentials(&creds).expect("save");
        let loaded = load_credentials().expect("load").expect("present");
        assert_eq!(loaded.resume_token, "resume-deadbeef");
        assert_eq!(loaded.last_known_epoch, 7);
    }

    #[test]
    fn subjects_are_workspace_and_agent_scoped() {
        let creds = sample();
        assert_eq!(creds.rpc_subject(), "agent.ws-abc.agent-123.rpc");
        assert_eq!(creds.events_subject(), "agent.ws-abc.agent-123.events");
    }

    #[test]
    fn from_proto_carries_consent_and_starts_with_empty_resume_token() {
        let proto = EnrollmentCredentials {
            agent_id: "a".to_string(),
            workspace_id: "w".to_string(),
            nats_credentials: "creds".to_string(),
            nats_urls: vec!["tls://x:4222".to_string()],
            relay_url: "https://r".to_string(),
            relay_token: "ogr_producer".to_string(),
            update_pubkey: "k".to_string(),
            consented_whole_machine: true,
            consented_screen_control: true,
        };
        let stored = StoredCredentials::from_proto(proto, "beta");
        assert_eq!(stored.update_channel, "beta");
        assert!(stored.resume_token.is_empty());
        assert!(stored.consented_screen_control);
        // The proto relay producer token now threads straight through (M8b).
        assert_eq!(stored.relay_token, "ogr_producer");
    }
}
