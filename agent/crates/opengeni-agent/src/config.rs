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

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use opengeni_agent_proto::v1::EnrollmentCredentials;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The environment variable overriding the config directory (used by the
/// non-interactive CI harness and tests so they never touch the real user dir).
const CONFIG_DIR_ENV: &str = "OPENGENI_CONFIG_DIR";

/// The hosted public origin. The hosted API and download endpoints are served
/// from this origin; callers can still select a deployment with `--api-url` or
/// `$OPENGENI_API_URL`.
pub const DEFAULT_PUBLIC_ORIGIN: &str = "https://app.opengeni.ai";

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

/// A refresh response was valid JSON but did not describe this exact enrolled
/// machine. No token value is ever included in this error.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialRotationError {
    /// The control plane returned a different workspace/agent identity, or no
    /// longer asserted the required whole-machine consent grant.
    #[error("refreshed credentials did not match this enrolled machine")]
    IdentityMismatch,
    /// The response omitted required control-plane material or paired a relay
    /// token with inconsistent endpoint/expiry metadata.
    #[error("refreshed credentials were incomplete")]
    IncompleteMaterial,
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
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCredentials {
    /// The deployment that issued this enrollment. Keeping it makes lifecycle
    /// requests continue to target a private/custom deployment after install.
    #[serde(default = "default_api_base_url")]
    pub api_base_url: String,
    /// This agent's stable id within the workspace.
    pub agent_id: String,
    /// The workspace this agent is scoped to.
    pub workspace_id: String,
    /// The NATS CONNECT AUTH-TOKEN (the signed `oge_` enrollment bearer). The agent
    /// presents this as the connect token; the server's auth-callout responder
    /// validates it and mints a workspace-scoped user JWT (dossier §10.1 / M-AUTH).
    /// There is NO operator creds-file — the bearer IS the credential. NEVER logged.
    ///
    /// (Deserialized from the legacy `nats_credentials` key too, so a credentials
    /// file written by an older agent build still loads — the value is the same
    /// token, only the field's meaning was clarified.)
    #[serde(alias = "nats_credentials")]
    pub nats_bearer: String,
    /// Absolute expiry of the recovery bearer. Zero means the credentials were
    /// written by an older agent/control plane and should be refreshed promptly.
    #[serde(default)]
    pub bearer_expires_at_unix_seconds: u64,
    /// NATS server URL(s) to dial — `wss://` for the relay-symmetric TLS ingress.
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
    /// Absolute expiry of the relay producer token. Zero means either legacy
    /// credentials (when `relay_token` is non-empty) or an intentionally disabled
    /// relay-token plane (when `relay_token` is empty).
    #[serde(default)]
    pub relay_token_expires_at_unix_seconds: u64,
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

impl std::fmt::Debug for StoredCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredentials")
            .field("agent_id", &self.agent_id)
            .field("workspace_id", &self.workspace_id)
            .field(
                "bearer_expires_at_unix_seconds",
                &self.bearer_expires_at_unix_seconds,
            )
            .field(
                "relay_token_expires_at_unix_seconds",
                &self.relay_token_expires_at_unix_seconds,
            )
            .field("consented_whole_machine", &self.consented_whole_machine)
            .field("consented_screen_control", &self.consented_screen_control)
            .field("last_known_epoch", &self.last_known_epoch)
            .finish_non_exhaustive()
    }
}

/// Cloneable, redacted shared access to the current persisted credentials. The
/// inner value is never exposed through `Debug`; callers take a short-lived clone
/// and must not hold a lock across an await.
#[derive(Clone)]
pub struct SharedCredentials {
    inner: Arc<RwLock<StoredCredentials>>,
}

impl SharedCredentials {
    /// Starts a shared credential source from one persisted snapshot.
    #[must_use]
    pub fn new(credentials: StoredCredentials) -> Self {
        Self {
            inner: Arc::new(RwLock::new(credentials)),
        }
    }

    /// Returns the current snapshot, recovering a poisoned lock rather than
    /// terminating the agent. The returned clone contains secrets and must never
    /// be logged with `Debug`.
    #[must_use]
    pub fn snapshot(&self) -> StoredCredentials {
        self.inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Publishes a candidate that has already been durably persisted. Persistence
    /// MUST happen first so a crash cannot leave memory newer than disk.
    pub fn publish_persisted(&self, credentials: StoredCredentials) {
        *self
            .inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = credentials;
    }
}

impl std::fmt::Debug for SharedCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedCredentials").finish_non_exhaustive()
    }
}

fn default_channel() -> String {
    "stable".to_string()
}

fn default_api_base_url() -> String {
    DEFAULT_PUBLIC_ORIGIN.to_string()
}

impl StoredCredentials {
    /// Folds a proto [`EnrollmentCredentials`] (just received from the device
    /// flow) plus the selected `update_channel` into the persisted shape. The
    /// resume token starts empty and is filled by the first connect.
    #[must_use]
    pub fn from_proto(
        proto: EnrollmentCredentials,
        update_channel: impl Into<String>,
        api_base_url: impl Into<String>,
    ) -> Self {
        Self {
            api_base_url: api_base_url.into(),
            agent_id: proto.agent_id,
            workspace_id: proto.workspace_id,
            // The proto `nats_credentials` field now carries the connect bearer.
            nats_bearer: proto.nats_credentials,
            bearer_expires_at_unix_seconds: proto.bearer_expires_at_unix_seconds,
            nats_urls: proto.nats_urls,
            relay_url: proto.relay_url,
            // The proto EnrollmentCredentials now carries the relay producer token
            // (M8b reconciled the relay-dial seam): thread it straight through so a
            // freshly-enrolled agent presents it on its first channel registration.
            relay_token: proto.relay_token,
            relay_token_expires_at_unix_seconds: proto.relay_token_expires_at_unix_seconds,
            update_pubkey: proto.update_pubkey,
            consented_whole_machine: proto.consented_whole_machine,
            consented_screen_control: proto.consented_screen_control,
            update_channel: update_channel.into(),
            resume_token: String::new(),
            last_known_epoch: 0,
        }
    }

    /// Builds the candidate persisted after a successful self-refresh. Exact
    /// machine identity and the loud whole-machine consent grant are immutable;
    /// agent-local channel/resume state is preserved while server-issued connect
    /// material and consent details rotate.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialRotationError::IdentityMismatch`] before any write if
    /// the response is scoped to another machine/workspace or drops the mandatory
    /// whole-machine consent assertion.
    pub fn refreshed_candidate(
        &self,
        refreshed: EnrollmentCredentials,
    ) -> Result<Self, CredentialRotationError> {
        if refreshed.agent_id != self.agent_id
            || refreshed.workspace_id != self.workspace_id
            || !refreshed.consented_whole_machine
        {
            return Err(CredentialRotationError::IdentityMismatch);
        }
        let relay_is_disabled =
            refreshed.relay_token.is_empty() && refreshed.relay_token_expires_at_unix_seconds == 0;
        let relay_is_complete = !refreshed.relay_token.is_empty()
            && !refreshed.relay_url.is_empty()
            && refreshed.relay_token_expires_at_unix_seconds > 0;
        if refreshed.nats_credentials.is_empty()
            || refreshed.bearer_expires_at_unix_seconds == 0
            || refreshed.nats_urls.is_empty()
            || refreshed.nats_urls.iter().any(String::is_empty)
            || (!relay_is_disabled && !relay_is_complete)
        {
            return Err(CredentialRotationError::IncompleteMaterial);
        }
        let mut candidate = Self::from_proto(
            refreshed,
            self.update_channel.clone(),
            self.api_base_url.clone(),
        );
        candidate.resume_token.clone_from(&self.resume_token);
        candidate.last_known_epoch = self.last_known_epoch;
        Ok(candidate)
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

    /// The op-stream subject the runner publishes an op's frames on:
    /// `agent.<ws>.<id>.op.<op_id>` (PROTOCOL.md §Subjects). Fire-and-forget; the
    /// server subscribes before it sends `OpStart`. Per-op so one subscription
    /// consumes exactly one op (never a wildcard). The `agent.` wire prefix is kept
    /// for compatibility even though the daemon is the "runner".
    // Wire-contract helper for the op-stream plane; the op engine wiring (a later
    // step) is its first caller, so it is unused by the binary today.
    #[allow(dead_code)]
    #[must_use]
    pub fn op_subject(&self, op_id: &str) -> String {
        format!("agent.{}.{}.op.{}", self.workspace_id, self.agent_id, op_id)
    }

    /// The op-stream ack subject the runner subscribes to for server acks + credit:
    /// `agent.<ws>.<id>.ack` (PROTOCOL.md §Subjects). Subscribed alongside the rpc
    /// subject at connection establishment.
    #[allow(dead_code)]
    #[must_use]
    pub fn ack_subject(&self) -> String {
        format!("agent.{}.{}.ack", self.workspace_id, self.agent_id)
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

    // Stage in the SAME directory, owner-only, sync the bytes, then atomically
    // replace the destination. `tempfile::persist` uses the platform's replace
    // primitive, so a failed refresh leaves the prior credentials file intact.
    // Persist before publishing to SharedCredentials: disk is always authoritative
    // across a crash/restart.
    let mut staged = tempfile::Builder::new()
        .prefix(".credentials-")
        .suffix(".tmp")
        .tempfile_in(&dir)
        .map_err(|e| ConfigError::io(&dir, e))?;
    restrict_permissions(staged.path())?;
    staged
        .write_all(&body)
        .map_err(|e| ConfigError::io(staged.path(), e))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|e| ConfigError::io(staged.path(), e))?;
    staged
        .persist(&path)
        .map_err(|e| ConfigError::io(&path, e.error))?;
    sync_parent_directory(&dir)?;
    Ok(path)
}

/// Syncs the parent directory after the atomic rename on Unix so the replacement
/// itself is durable. Directory fsync is not portable to Windows; there the file
/// sync + atomic replacement are the strongest standard contract available.
#[cfg(unix)]
fn sync_parent_directory(dir: &Path) -> Result<(), ConfigError> {
    std::fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| ConfigError::io(dir, e))
}

#[cfg(not(unix))]
fn sync_parent_directory(_dir: &Path) -> Result<(), ConfigError> {
    Ok(())
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
            api_base_url: DEFAULT_PUBLIC_ORIGIN.to_string(),
            agent_id: "agent-123".to_string(),
            workspace_id: "ws-abc".to_string(),
            nats_bearer: "oge_example.bearer".to_string(),
            bearer_expires_at_unix_seconds: 4_102_444_800,
            nats_urls: vec!["wss://nats.example:443".to_string()],
            relay_url: "https://relay.example".to_string(),
            relay_token: "agent-relay-token".to_string(),
            relay_token_expires_at_unix_seconds: 4_102_444_500,
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
    fn legacy_nats_credentials_key_still_deserializes_as_the_bearer() {
        // A credentials file written by an older agent build used the field name
        // `nats_credentials`; the `#[serde(alias)]` keeps it loadable as the bearer
        // (the value is the same connect token, only the meaning was clarified).
        let legacy = r#"{
            "agent_id": "a", "workspace_id": "w",
            "nats_credentials": "oge_legacy.bearer",
            "nats_urls": ["wss://nats.example:443"],
            "relay_url": "", "update_pubkey": "",
            "consented_whole_machine": true, "consented_screen_control": false
        }"#;
        let creds: StoredCredentials = serde_json::from_str(legacy).expect("parse legacy");
        assert_eq!(creds.nats_bearer, "oge_legacy.bearer");
        assert_eq!(creds.bearer_expires_at_unix_seconds, 0);
        assert_eq!(creds.relay_token_expires_at_unix_seconds, 0);
    }

    #[test]
    fn subjects_are_workspace_and_agent_scoped() {
        let creds = sample();
        assert_eq!(creds.rpc_subject(), "agent.ws-abc.agent-123.rpc");
        assert_eq!(creds.events_subject(), "agent.ws-abc.agent-123.events");
        // Op-stream subjects keep the `agent.` wire prefix (compatibility) and are
        // per-op on the frame side, single on the ack side (PROTOCOL.md §Subjects).
        assert_eq!(
            creds.op_subject("read:0"),
            "agent.ws-abc.agent-123.op.read:0"
        );
        assert_eq!(creds.ack_subject(), "agent.ws-abc.agent-123.ack");
    }

    #[test]
    fn from_proto_carries_consent_and_starts_with_empty_resume_token() {
        let proto = EnrollmentCredentials {
            agent_id: "a".to_string(),
            workspace_id: "w".to_string(),
            nats_credentials: "creds".to_string(),
            bearer_expires_at_unix_seconds: 4_102_444_800,
            nats_urls: vec!["tls://x:4222".to_string()],
            relay_url: "https://r".to_string(),
            relay_token: "ogr_producer".to_string(),
            relay_token_expires_at_unix_seconds: 4_102_444_500,
            update_pubkey: "k".to_string(),
            consented_whole_machine: true,
            consented_screen_control: true,
        };
        let stored = StoredCredentials::from_proto(proto, "beta", "https://private.example");
        assert_eq!(stored.update_channel, "beta");
        assert_eq!(stored.api_base_url, "https://private.example");
        assert!(stored.resume_token.is_empty());
        assert!(stored.consented_screen_control);
        // The proto relay producer token now threads straight through (M8b).
        assert_eq!(stored.relay_token, "ogr_producer");
        assert_eq!(stored.bearer_expires_at_unix_seconds, 4_102_444_800);
        assert_eq!(stored.relay_token_expires_at_unix_seconds, 4_102_444_500);
    }

    #[test]
    fn refreshed_candidate_preserves_local_state_and_rejects_identity_changes() {
        let mut current = sample();
        current.resume_token = "resume-7".to_string();
        current.last_known_epoch = 7;
        let refreshed = EnrollmentCredentials {
            agent_id: current.agent_id.clone(),
            workspace_id: current.workspace_id.clone(),
            nats_credentials: "oge_rotated".to_string(),
            bearer_expires_at_unix_seconds: 4_202_444_800,
            nats_urls: vec!["wss://nats-new.example:443".to_string()],
            relay_url: "https://relay-new.example".to_string(),
            relay_token: "ogr_rotated".to_string(),
            relay_token_expires_at_unix_seconds: 4_202_444_500,
            update_pubkey: "RWNEW".to_string(),
            consented_whole_machine: true,
            consented_screen_control: true,
        };
        let candidate = current
            .refreshed_candidate(refreshed.clone())
            .expect("same identity");
        assert_eq!(candidate.nats_bearer, "oge_rotated");
        assert_eq!(candidate.relay_token, "ogr_rotated");
        assert_eq!(candidate.resume_token, "resume-7");
        assert_eq!(candidate.last_known_epoch, 7);
        assert_eq!(candidate.update_channel, current.update_channel);
        assert_eq!(candidate.api_base_url, current.api_base_url);

        let mut wrong_agent = refreshed;
        wrong_agent.agent_id = "some-other-agent".to_string();
        assert_eq!(
            current.refreshed_candidate(wrong_agent),
            Err(CredentialRotationError::IdentityMismatch)
        );
    }

    #[test]
    fn refreshed_candidate_rejects_incomplete_connect_material() {
        let current = sample();
        let valid = EnrollmentCredentials {
            agent_id: current.agent_id.clone(),
            workspace_id: current.workspace_id.clone(),
            nats_credentials: "oge_rotated".to_string(),
            bearer_expires_at_unix_seconds: 4_202_444_800,
            nats_urls: vec!["wss://nats-new.example:443".to_string()],
            relay_url: "https://relay-new.example/stream".to_string(),
            relay_token: "ogr_rotated".to_string(),
            relay_token_expires_at_unix_seconds: 4_202_444_500,
            update_pubkey: String::new(),
            consented_whole_machine: true,
            consented_screen_control: false,
        };

        let mut cases = Vec::new();
        let mut empty_bearer = valid.clone();
        empty_bearer.nats_credentials.clear();
        cases.push(empty_bearer);
        let mut no_bearer_expiry = valid.clone();
        no_bearer_expiry.bearer_expires_at_unix_seconds = 0;
        cases.push(no_bearer_expiry);
        let mut no_nats_urls = valid.clone();
        no_nats_urls.nats_urls.clear();
        cases.push(no_nats_urls);
        let mut relay_without_expiry = valid.clone();
        relay_without_expiry.relay_token_expires_at_unix_seconds = 0;
        cases.push(relay_without_expiry);
        let mut relay_expiry_without_token = valid;
        relay_expiry_without_token.relay_token.clear();
        cases.push(relay_expiry_without_token);

        for malformed in cases {
            assert_eq!(
                current.refreshed_candidate(malformed),
                Err(CredentialRotationError::IncompleteMaterial)
            );
        }
    }

    #[test]
    fn shared_credentials_publish_only_changes_future_snapshots() {
        let initial = sample();
        let shared = SharedCredentials::new(initial.clone());
        let before = shared.snapshot();
        let mut rotated = initial;
        rotated.nats_bearer = "oge_rotated".to_string();
        shared.publish_persisted(rotated);
        assert_eq!(before.nats_bearer, "oge_example.bearer");
        assert_eq!(shared.snapshot().nats_bearer, "oge_rotated");
    }

    #[test]
    fn credential_debug_output_is_redacted() {
        let credentials = sample();
        let debug = format!("{credentials:?}");
        assert!(!debug.contains(&credentials.nats_bearer));
        assert!(!debug.contains(&credentials.relay_token));
        assert!(!debug.contains(&credentials.api_base_url));
        assert!(!debug.contains("wss://nats.example"));
    }
}
