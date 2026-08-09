//! Agent configuration directory + persisted enrollment credentials.
//!
//! After a successful enrollment the agent persists one owner-only connection
//! document per deployment/workspace (NATS bearer + URLs, relay credentials,
//! update channel, and consent grants). On `run` the agent loads all of them; if
//! none exist it starts the connection flow first.
//!
//! Each on-disk credential shape is deliberately decoupled from the
//! proto [`EnrollmentCredentials`](opengeni_agent_proto::v1::EnrollmentCredentials)
//! wire message so the persisted file can carry agent-local fields (the rotating
//! resume token and deployment-aware local identity) that never travel on the wire.
//! [`StoredCredentials::from_proto`] is the one conversion point.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
    /// A syntactically valid connection document violated its local identity
    /// invariant (unsupported schema, mismatched id/file, or empty authority).
    #[error("invalid connection document at {path}: {detail}")]
    Invalid {
        /// The invalid document.
        path: PathBuf,
        /// Non-secret validation detail.
        detail: String,
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

/// Directory containing one independently replaceable credential document per
/// OpenGeni deployment/workspace connection. Separate files avoid a global
/// read-modify-write race when two `connect` commands run concurrently and let
/// the running agent notice additions/removals without restarting.
const CONNECTIONS_DIR: &str = "connections";

/// Current on-disk connection document version.
const CONNECTION_SCHEMA_VERSION: u32 = 1;

/// Makes same-process concurrent saves use distinct staging paths. Separate
/// processes are already separated by pid.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// One local connection to one workspace on one OpenGeni deployment.
///
/// `api_url` is part of the identity because two independent deployments may
/// legitimately contain the same workspace UUID. The runtime credentials stay
/// workspace-scoped exactly as before; this wrapper only gives the local agent a
/// collision-free routing/configuration identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredConnection {
    /// Schema version for explicit future migrations.
    pub schema_version: u32,
    /// Stable, non-secret local identifier derived from deployment + workspace.
    pub connection_id: String,
    /// Normalized API origin used to create/manage this connection.
    pub api_url: String,
    /// This record came from the old single-connection file, which did not
    /// persist its deployment origin. It remains fully usable for runtime
    /// transport, but its displayed `api_url` is only a migration hint until an
    /// explicit reconnect to that deployment replaces it.
    #[serde(default)]
    pub legacy_origin: bool,
    /// The existing workspace-scoped runtime credentials.
    pub credentials: StoredCredentials,
}

impl StoredConnection {
    /// Wraps newly issued credentials in their deployment-aware local identity.
    #[must_use]
    pub fn new(api_url: &str, credentials: StoredCredentials) -> Self {
        let api_url = normalize_api_url(api_url);
        let connection_id = connection_id(&api_url, &credentials.workspace_id);
        Self {
            schema_version: CONNECTION_SCHEMA_VERSION,
            connection_id,
            api_url,
            legacy_origin: false,
            credentials,
        }
    }

    fn from_legacy(api_url_hint: &str, credentials: StoredCredentials) -> Self {
        let api_url = normalize_api_url(api_url_hint);
        let connection_id = legacy_connection_id(&credentials);
        Self {
            schema_version: CONNECTION_SCHEMA_VERSION,
            connection_id,
            api_url,
            legacy_origin: true,
            credentials,
        }
    }
}

/// Normalizes the deployment URL for stable local identity. Enrollment itself
/// remains the authority that validates/reaches the URL; this only removes
/// whitespace and redundant trailing slashes so equivalent one-liners upsert the
/// same connection.
#[must_use]
pub fn normalize_api_url(api_url: &str) -> String {
    let trimmed = api_url.trim();
    reqwest::Url::parse(trimmed).map_or_else(
        |_| trimmed.trim_end_matches('/').to_string(),
        |mut parsed| {
            parsed.set_fragment(None);
            parsed.set_query(None);
            parsed.as_str().trim_end_matches('/').to_string()
        },
    )
}

/// Stable, filesystem-safe local identity for a deployment/workspace pair.
#[must_use]
pub fn connection_id(api_url: &str, workspace_id: &str) -> String {
    let material = format!("{}\0{}", normalize_api_url(api_url), workspace_id);
    blake3::hash(material.as_bytes()).to_hex()[..20].to_string()
}

fn legacy_connection_id(credentials: &StoredCredentials) -> String {
    let material = format!(
        "legacy\0{}\0{}",
        credentials.workspace_id, credentials.agent_id
    );
    blake3::hash(material.as_bytes()).to_hex()[..20].to_string()
}

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
    /// The NATS CONNECT AUTH-TOKEN (the signed `oge_` enrollment bearer). The agent
    /// presents this as the connect token; the server's auth-callout responder
    /// validates it and mints a workspace-scoped user JWT (M-AUTH).
    /// There is NO operator creds-file — the bearer IS the credential. NEVER logged.
    ///
    /// (Deserialized from the legacy `nats_credentials` key too, so a credentials
    /// file written by an older agent build still loads — the value is the same
    /// token, only the field's meaning was clarified.)
    #[serde(alias = "nats_credentials")]
    pub nats_bearer: String,
    /// NATS server URL(s) to dial — `wss://` for the relay-symmetric TLS ingress.
    pub nats_urls: Vec<String>,
    /// The relay edge base URL for stream channels (M8).
    pub relay_url: String,
    /// The agent's enrollment-scoped relay PRODUCER token, presented on a
    /// `StreamOpen` when the agent registers a pty/desktop channel under the
    /// relay-dial protocol. Distinct from the viewer's control-plane-minted
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
            // The proto `nats_credentials` field now carries the connect bearer.
            nats_bearer: proto.nats_credentials,
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
#[cfg(test)]
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

/// Loads every configured OpenGeni connection, ordered by local connection id.
///
/// A pre-multi-connection `credentials.json` is migrated exactly once into the
/// new per-connection directory using `legacy_api_url` as its deployment origin.
/// The legacy file is removed only after the new owner-only document is safely
/// persisted.
///
/// # Errors
///
/// Returns [`ConfigError`] when the directory cannot be read or any connection
/// document is malformed. A malformed credential is never silently skipped.
pub fn load_connections(legacy_api_url: &str) -> Result<Vec<StoredConnection>, ConfigError> {
    migrate_legacy_credentials(legacy_api_url)?;
    let dir = connections_dir()?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ConfigError::io(&dir, error)),
    };

    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| ConfigError::io(&dir, error))?;
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            paths.push(path);
        }
    }
    paths.sort();

    let mut connections = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = std::fs::read(&path).map_err(|error| ConfigError::io(&path, error))?;
        let connection: StoredConnection =
            serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
        validate_connection(&path, &connection)?;
        connections.push(connection);
    }
    Ok(connections)
}

fn validate_connection(path: &Path, connection: &StoredConnection) -> Result<(), ConfigError> {
    if connection.schema_version != CONNECTION_SCHEMA_VERSION {
        return Err(ConfigError::Invalid {
            path: path.to_path_buf(),
            detail: format!(
                "unsupported schema version {} (expected {CONNECTION_SCHEMA_VERSION})",
                connection.schema_version
            ),
        });
    }
    if connection.api_url.is_empty() || connection.credentials.workspace_id.is_empty() {
        return Err(ConfigError::Invalid {
            path: path.to_path_buf(),
            detail: "api_url and workspace_id must be non-empty".to_string(),
        });
    }
    let expected = if connection.legacy_origin {
        legacy_connection_id(&connection.credentials)
    } else {
        connection_id(&connection.api_url, &connection.credentials.workspace_id)
    };
    let file_id = path.file_stem().and_then(std::ffi::OsStr::to_str);
    if connection.connection_id != expected || file_id != Some(expected.as_str()) {
        return Err(ConfigError::Invalid {
            path: path.to_path_buf(),
            detail: "connection id does not match deployment/workspace identity".to_string(),
        });
    }
    Ok(())
}

/// Finds one configured deployment/workspace connection.
pub fn find_connection(
    api_url: &str,
    workspace_id: &str,
) -> Result<Option<StoredConnection>, ConfigError> {
    let wanted = connection_id(api_url, workspace_id);
    Ok(load_connections(api_url)?
        .into_iter()
        .find(|connection| connection.connection_id == wanted))
}

/// Atomically adds or replaces one deployment/workspace connection.
///
/// Each connection owns its own file, so adding workspace B can never overwrite
/// workspace A—even when their UUIDs happen to match on different deployments.
pub fn save_connection(connection: &StoredConnection) -> Result<PathBuf, ConfigError> {
    let dir = connections_dir()?;
    let path = dir.join(format!("{}.json", connection.connection_id));
    validate_connection(&path, connection)?;
    let temporary = dir.join(format!(
        ".{}.{}.{}.tmp",
        connection.connection_id,
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let body = serde_json::to_vec_pretty(connection).expect("StoredConnection serializes");
    write_private_staging_file(&temporary, &body)?;
    if let Err(error) = replace_file(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if !connection.legacy_origin {
        remove_replaced_legacy_connection(connection)?;
    }
    Ok(path)
}

fn write_private_staging_file(path: &Path, body: &[u8]) -> Result<(), ConfigError> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| ConfigError::io(path, error))?;
    if let Err(error) = file.write_all(body).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(ConfigError::io(path, error));
    }
    #[cfg(not(unix))]
    restrict_permissions(path)?;
    Ok(())
}

fn remove_replaced_legacy_connection(connection: &StoredConnection) -> Result<(), ConfigError> {
    let dir = connections_dir()?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ConfigError::io(&dir, error)),
    };
    for entry in entries {
        let entry = entry.map_err(|error| ConfigError::io(&dir, error))?;
        let candidate_path = entry.path();
        if candidate_path == dir.join(format!("{}.json", connection.connection_id))
            || candidate_path.extension().and_then(std::ffi::OsStr::to_str) != Some("json")
        {
            continue;
        }
        let bytes = std::fs::read(&candidate_path)
            .map_err(|error| ConfigError::io(&candidate_path, error))?;
        let candidate: StoredConnection =
            serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
                path: candidate_path.clone(),
                source,
            })?;
        validate_connection(&candidate_path, &candidate)?;
        if candidate.legacy_origin
            && candidate.credentials.workspace_id == connection.credentials.workspace_id
            && candidate.credentials.agent_id == connection.credentials.agent_id
        {
            match std::fs::remove_file(&candidate_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(ConfigError::io(candidate_path, error)),
            }
        }
    }
    Ok(())
}

/// Removes one local connection by its exact id or an unambiguous id prefix.
/// Returns the removed record, or `Ok(None)` when no connection matched.
pub fn remove_connection(
    query: &str,
    legacy_api_url: &str,
) -> Result<Option<StoredConnection>, ConfigError> {
    let matches: Vec<_> = load_connections(legacy_api_url)?
        .into_iter()
        .filter(|connection| connection.connection_id.starts_with(query))
        .collect();
    if matches.len() != 1 {
        return Ok(None);
    }
    let connection = matches.into_iter().next().expect("one match");
    let path = config_dir()?
        .join(CONNECTIONS_DIR)
        .join(format!("{}.json", connection.connection_id));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(Some(connection)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ConfigError::io(path, error)),
    }
}

fn migrate_legacy_credentials(api_url: &str) -> Result<(), ConfigError> {
    let legacy_path = config_dir()?.join(CREDENTIALS_FILE);
    let Some(credentials) = load_credentials()? else {
        return Ok(());
    };
    // The legacy document never stored its deployment origin. Keep it under a
    // dedicated identity rather than pretending the caller's/default URL is
    // authoritative: otherwise adding a real connection whose workspace UUID
    // happens to match could overwrite the still-live legacy link.
    let connection = StoredConnection::from_legacy(api_url, credentials);
    let path = connections_dir()?.join(format!("{}.json", connection.connection_id));
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|error| ConfigError::io(&path, error))?;
        let persisted: StoredConnection =
            serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
        validate_connection(&path, &persisted)?;
        if persisted != connection {
            return Err(ConfigError::Invalid {
                path,
                detail: "existing legacy migration does not match credentials.json".to_string(),
            });
        }
    } else {
        save_connection(&connection)?;
    }
    match std::fs::remove_file(&legacy_path) {
        Ok(()) => Ok(()),
        // Another updated agent process may have completed the same idempotent
        // migration between our read and remove.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigError::io(legacy_path, error)),
    }
}

fn connections_dir() -> Result<PathBuf, ConfigError> {
    let dir = config_dir()?.join(CONNECTIONS_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| ConfigError::io(&dir, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| ConfigError::io(&dir, error))?;
    }
    Ok(dir)
}

fn replace_file(temporary: &Path, destination: &Path) -> Result<(), ConfigError> {
    match std::fs::rename(temporary, destination) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
            ) && destination.exists() =>
        {
            std::fs::remove_file(destination)
                .map_err(|remove_error| ConfigError::io(destination, remove_error))?;
            std::fs::rename(temporary, destination)
                .map_err(|rename_error| ConfigError::io(destination, rename_error))
        }
        Err(error) => Err(ConfigError::io(destination, error)),
    }
}

/// Tightens a file to owner-only read/write (`0600`) on unix; a no-op elsewhere
/// (Windows ACL tightening is handled by the install path).
#[cfg(all(unix, test))]
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
            nats_bearer: "oge_example.bearer".to_string(),
            nats_urls: vec!["wss://nats.example:443".to_string()],
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
    fn connection_store_keeps_multiple_deployments_with_the_same_workspace_id() {
        let _guard = with_temp_config();
        let first = StoredConnection::new("https://one.example/", sample());
        let mut second_creds = sample();
        second_creds.agent_id = "agent-other".to_string();
        let second = StoredConnection::new("https://two.example", second_creds);
        assert_ne!(first.connection_id, second.connection_id);

        save_connection(&first).expect("save first");
        save_connection(&second).expect("save second");
        let loaded = load_connections("https://unused.example").expect("load");
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains(&first));
        assert!(loaded.contains(&second));
    }

    #[test]
    fn saving_same_deployment_workspace_replaces_only_that_connection() {
        let _guard = with_temp_config();
        let first = StoredConnection::new("https://one.example", sample());
        save_connection(&first).expect("save first");
        let mut rotated = first.clone();
        rotated.credentials.nats_bearer = "oge_rotated".to_string();
        save_connection(&rotated).expect("rotate");
        let loaded = load_connections("https://unused.example").expect("load");
        assert_eq!(loaded, vec![rotated]);
    }

    #[test]
    fn legacy_single_credentials_migrate_without_losing_the_secret() {
        let _guard = with_temp_config();
        save_credentials(&sample()).expect("legacy save");
        let loaded = load_connections("https://legacy.example/").expect("migrate");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].api_url, "https://legacy.example");
        assert!(loaded[0].legacy_origin);
        assert_eq!(loaded[0].credentials, sample());
        assert!(!config_dir().expect("dir").join(CREDENTIALS_FILE).exists());
    }

    #[test]
    fn invalid_existing_migration_never_deletes_legacy_credentials() {
        let _guard = with_temp_config();
        save_credentials(&sample()).expect("legacy save");
        let connection = StoredConnection::from_legacy("https://legacy.example", sample());
        let destination = connections_dir()
            .expect("connections dir")
            .join(format!("{}.json", connection.connection_id));
        std::fs::write(&destination, b"{}").expect("write invalid destination");

        assert!(load_connections("https://legacy.example").is_err());
        assert!(config_dir().expect("dir").join(CREDENTIALS_FILE).exists());
    }

    #[test]
    fn explicit_connection_replaces_only_its_matching_legacy_record() {
        let _guard = with_temp_config();
        save_credentials(&sample()).expect("legacy save");
        let legacy = load_connections("https://possibly-wrong.example")
            .expect("migrate")
            .into_iter()
            .next()
            .expect("legacy record");

        let explicit = StoredConnection::new("https://actual.example", sample());
        assert_ne!(legacy.connection_id, explicit.connection_id);
        save_connection(&explicit).expect("save explicit");

        assert_eq!(
            load_connections("https://unused.example").expect("load"),
            vec![explicit]
        );
    }

    #[test]
    fn legacy_identity_cannot_collide_with_an_explicit_deployment_workspace() {
        let _guard = with_temp_config();
        let legacy = StoredConnection::from_legacy("https://api.opengeni.ai", sample());
        let explicit = StoredConnection::new("https://api.opengeni.ai", sample());
        assert_ne!(legacy.connection_id, explicit.connection_id);
    }

    #[test]
    fn remove_accepts_an_unambiguous_prefix() {
        let _guard = with_temp_config();
        let connection = StoredConnection::new("https://one.example", sample());
        save_connection(&connection).expect("save");
        let removed = remove_connection(&connection.connection_id[..8], "https://unused.example")
            .expect("remove")
            .expect("present");
        assert_eq!(removed, connection);
        assert!(load_connections("https://unused.example")
            .expect("load")
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn connection_documents_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = with_temp_config();
        let path =
            save_connection(&StoredConnection::new("https://one.example", sample())).expect("save");
        let mode = std::fs::metadata(path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = std::fs::metadata(connections_dir().expect("connections dir"))
            .expect("dir meta")
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);
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
