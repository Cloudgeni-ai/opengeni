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

/// Directory containing one independently replaceable credential document per
/// Opengeni deployment/workspace connection. Separate files avoid a global
/// read-modify-write race when two `connect` commands run concurrently and let
/// the running agent notice additions/removals without restarting.
const CONNECTIONS_DIR: &str = "connections";

/// Current on-disk connection document version.
const CONNECTION_SCHEMA_VERSION: u32 = 1;

/// Makes same-process concurrent saves use distinct staging paths. Separate
/// processes are already separated by pid.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// One local connection to one workspace on one Opengeni deployment.
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
    /// A refused transport is suspended until renewal or explicit reconnect.
    /// This belongs to this credential document, never the shared host engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication_state: Option<AuthenticationState>,
    /// The existing workspace-scoped runtime credentials.
    pub credentials: StoredCredentials,
}

/// Persisted recovery state for one connection's exact credentials.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationState {
    /// The transport refused these credentials; the renewal loop checks authority.
    RenewalRequired,
    /// Renewal refused the grant or cannot recover the rejected transport.
    ReconnectRequired,
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
            authentication_state: None,
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
}

/// Loads every configured Opengeni connection, ordered by local connection id.
///
/// # Errors
///
/// Returns [`ConfigError`] when the directory cannot be read or any connection
/// document is malformed. A malformed credential is never silently skipped.
pub fn load_connections() -> Result<Vec<StoredConnection>, ConfigError> {
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
    let expected = connection_id(&connection.api_url, &connection.credentials.workspace_id);
    let file_id = path.file_stem().and_then(std::ffi::OsStr::to_str);
    if connection.connection_id != expected || file_id != Some(expected.as_str()) {
        return Err(ConfigError::Invalid {
            path: path.to_path_buf(),
            detail: "connection id does not match deployment/workspace identity".to_string(),
        });
    }
    Ok(())
}

/// Reads one connection file by its id. `None` when
/// that connection no longer exists (disconnected or replaced).
pub fn load_connection(connection_id: &str) -> Result<Option<StoredConnection>, ConfigError> {
    if connection_id.is_empty()
        || !connection_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Ok(None);
    }
    let path = connections_dir()?.join(format!("{connection_id}.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ConfigError::io(&path, error)),
    };
    let connection: StoredConnection =
        serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
            path: path.clone(),
            source,
        })?;
    validate_connection(&path, &connection)?;
    Ok(Some(connection))
}

/// Finds one configured deployment/workspace connection.
pub fn find_connection(
    api_url: &str,
    workspace_id: &str,
) -> Result<Option<StoredConnection>, ConfigError> {
    let wanted = connection_id(api_url, workspace_id);
    Ok(load_connections()?
        .into_iter()
        .find(|connection| connection.connection_id == wanted))
}

/// Atomically adds or replaces one deployment/workspace connection.
///
/// Each connection owns its own file, so adding workspace B can never overwrite
/// workspace A—even when their UUIDs happen to match on different deployments.
pub fn save_connection(connection: &StoredConnection) -> Result<PathBuf, ConfigError> {
    let _lock = connection_store_lock()?;
    save_connection_unlocked(connection)
}

fn connection_store_lock() -> Result<std::fs::File, ConfigError> {
    let path = connections_dir()?.join(".write.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|e| ConfigError::io(&path, e))?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| ConfigError::io(&path, e))?;
    Ok(file)
}

/// A renewal response must never resurrect a disconnected machine or overwrite
/// a concurrent, explicitly authorized re-enrollment. All connection writers use
/// the same OS lock; network I/O happens before acquiring it.
pub fn save_renewed_connection(
    expected: &StoredConnection,
    renewed: &StoredConnection,
) -> Result<bool, ConfigError> {
    let _lock = connection_store_lock()?;
    let path = connections_dir()?.join(format!("{}.json", expected.connection_id));
    if expected.connection_id != renewed.connection_id {
        return Ok(false);
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(ConfigError::io(&path, e)),
    };
    let current: StoredConnection =
        serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse { path, source })?;
    if &current != expected {
        return Ok(false);
    }
    save_connection_unlocked(renewed)?;
    Ok(true)
}

fn save_connection_unlocked(connection: &StoredConnection) -> Result<PathBuf, ConfigError> {
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

/// Removes one local connection by its exact id or an unambiguous id prefix.
/// Returns the removed record, or `Ok(None)` when no connection matched.
pub fn remove_connection(query: &str) -> Result<Option<StoredConnection>, ConfigError> {
    let matches: Vec<_> = load_connections()?
        .into_iter()
        .filter(|connection| connection.connection_id.starts_with(query))
        .collect();
    if matches.len() != 1 {
        return Ok(None);
    }
    let connection = matches.into_iter().next().expect("one match");
    let _lock = connection_store_lock()?;
    let path = config_dir()?
        .join(CONNECTIONS_DIR)
        .join(format!("{}.json", connection.connection_id));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(Some(connection)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ConfigError::io(path, error)),
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

/// Non-unix files are created without a mode; Windows ACL tightening is handled
/// by the install path.
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
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
    pub(crate) fn with_temp_config() -> (MutexGuard<'static, ()>, tempfile::TempDir) {
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
    fn resume_token_round_trips_through_persistence() {
        // The resume-token round-trip the supervisor relies on (§10.6): persist a
        // rotated token + epoch, reload, and confirm they survive.
        let _guard = with_temp_config(); // (lock, tempdir) held for the test body
        let mut creds = sample();
        creds.resume_token = "resume-deadbeef".to_string();
        creds.last_known_epoch = 7;
        save_connection(&StoredConnection::new("https://one.example", creds)).expect("save");
        let loaded = load_connections().expect("load").remove(0).credentials;
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
        let loaded = load_connections().expect("load");
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
        let loaded = load_connections().expect("load");
        assert_eq!(loaded, vec![rotated]);
    }

    #[test]
    fn late_renewal_cannot_overwrite_reconnect_or_resurrect_disconnect() {
        let _guard = with_temp_config();
        let original = StoredConnection::new("https://one.example", sample());
        save_connection(&original).expect("initial connection");
        let mut renewed = original.clone();
        renewed.credentials.nats_bearer = "oge_renewed".into();
        assert!(save_renewed_connection(&original, &renewed).expect("renew"));
        assert!(!save_renewed_connection(&original, &renewed).expect("stale response"));
        let mut reconnected = renewed.clone();
        reconnected.credentials.nats_bearer = "oge_reconnected".into();
        save_connection(&reconnected).expect("explicit reconnect");
        assert!(!save_renewed_connection(&renewed, &original).expect("reconnect wins"));
        assert_eq!(load_connections().unwrap(), vec![reconnected.clone()]);
        remove_connection(&reconnected.connection_id).expect("disconnect");
        assert!(!save_renewed_connection(&reconnected, &renewed).expect("disconnect wins"));
        assert_eq!(load_connections().unwrap(), Vec::<StoredConnection>::new());
    }

    #[test]
    fn remove_accepts_an_unambiguous_prefix() {
        let _guard = with_temp_config();
        let connection = StoredConnection::new("https://one.example", sample());
        save_connection(&connection).expect("save");
        let removed = remove_connection(&connection.connection_id[..8])
            .expect("remove")
            .expect("present");
        assert_eq!(removed, connection);
        assert_eq!(
            load_connections().expect("load"),
            Vec::<StoredConnection>::new()
        );
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
        assert_eq!(stored.resume_token, "");
        assert!(stored.consented_screen_control);
        // The proto relay producer token now threads straight through (M8b).
        assert_eq!(stored.relay_token, "ogr_producer");
    }
}
