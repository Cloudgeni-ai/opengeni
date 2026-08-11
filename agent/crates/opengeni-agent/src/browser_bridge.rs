//! Local Chrome-extension bridge for attached, already-running browser profiles.
//!
//! Chrome starts one Native Messaging host process per extension connection. The
//! host is deliberately only a bounded stdio↔loopback proxy; this long-running
//! agent process owns authentication, profile/tab inventory, connection fencing,
//! and eventually command routing. A browser profile is a live endpoint, never a
//! reusable [`BrowserIdentity`](https://docs.opengeni.ai/) state snapshot.

use std::{
    collections::{BTreeMap, HashMap},
    io::Write as _,
    net::Shutdown,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use opengeni_agent_proto::v1;
use rand::{rngs::OsRng, RngCore as _};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tracing::{debug, warn};

const BRIDGE_PROTOCOL_VERSION: u32 = 1;
const AUTHORITY_FILE: &str = "browser-bridge-authority.json";
const NATIVE_HOST_NAME: &str = "ai.opengeni.browser";
const EXTENSION_ID: &str = "imdmcebcclhibdfolbokjbiibpcnpbel";
// Chrome Native Messaging is intentionally asymmetric: browser -> host may be
// 64 MiB, while host -> browser is limited to 1 MiB. CDP screenshots travel in
// browser -> host responses, so flattening both directions to 1 MiB breaks
// otherwise-valid observations.
const MAX_COMMAND_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_AUTH_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_ATTACHED_PROFILES: usize = 1_000;
const MAX_TABS_PER_PROFILE: usize = 100_000;
const MAX_PENDING_COMMANDS: usize = 4_096;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Failures at the trusted local browser-bridge boundary.
#[derive(Debug, thiserror::Error)]
pub enum BrowserBridgeError {
    /// Local IO failed.
    #[error("browser bridge io error: {0}")]
    Io(#[from] std::io::Error),
    /// Authority JSON could not be encoded or decoded.
    #[error("browser bridge authority is invalid: {0}")]
    Authority(#[from] serde_json::Error),
    /// A native/extension message violated the bounded protocol.
    #[error("browser bridge protocol error: {0}")]
    Protocol(String),
    /// The bridge server task ended unexpectedly.
    #[error("browser bridge task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    /// The requested live browser profile is not connected.
    #[error("attached browser is unavailable")]
    Unavailable,
    /// The profile reconnected after the caller resolved its transport fence.
    #[error("attached browser connection changed")]
    Fenced,
    /// The extension did not settle a bounded command in time.
    #[error("attached browser command timed out")]
    Timeout,
}

/// Chrome passes the allowed extension origin as argv[1]. Native Messaging
/// manifests cannot append a subcommand, so the agent recognizes that exact
/// pinned origin before ordinary CLI parsing.
#[must_use]
pub fn is_native_host_invocation() -> bool {
    std::env::args().nth(1).as_deref() == Some(extension_origin().as_str())
}

fn extension_origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

/// Run the Chrome-spawned Native Messaging host. It owns no browser or cloud
/// authority: after reading the owner-only local authority file it authenticates
/// to the already-running agent and copies bounded native-message frames.
pub fn run_native_host() -> Result<(), BrowserBridgeError> {
    let config_dir = crate::config::config_dir()
        .map_err(|error| BrowserBridgeError::Protocol(error.to_string()))?;
    let authority = read_authority(&authority_path(&config_dir))?;
    if authority.protocol_version != BRIDGE_PROTOCOL_VERSION {
        return Err(BrowserBridgeError::Protocol(
            "running agent uses an incompatible browser bridge".to_string(),
        ));
    }
    let mut socket = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))?;
    socket.set_nodelay(true)?;
    let authentication = serde_json::to_vec(&serde_json::json!({
        "type": "authenticate",
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "role": "extension",
        "token": authority.token,
    }))?;
    write_native_frame_sync_bounded(&mut socket, &authentication, MAX_AUTH_MESSAGE_BYTES)?;

    // Keep the agent -> Chrome direction on the main thread. If the agent
    // rejects a hello or shuts down, EOF now terminates this disposable native
    // host immediately instead of leaving it blocked forever on Chrome stdin.
    // Conversely, Chrome EOF shuts down the socket write half, which makes the
    // agent close its read half and releases the main loop below.
    let mut browser_writer = socket.try_clone()?;
    let _browser_input = std::thread::spawn(move || {
        let result = (|| -> Result<(), BrowserBridgeError> {
            let stdin = std::io::stdin();
            let mut stdin = stdin.lock();
            while let Some(message) =
                read_native_frame_sync_bounded(&mut stdin, MAX_RESPONSE_MESSAGE_BYTES)?
            {
                write_native_frame_sync_bounded(
                    &mut browser_writer,
                    &message,
                    MAX_RESPONSE_MESSAGE_BYTES,
                )?;
            }
            Ok(())
        })();
        let _ = browser_writer.shutdown(Shutdown::Write);
        result
    });

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    while let Some(message) =
        read_native_frame_sync_bounded(&mut socket, MAX_COMMAND_MESSAGE_BYTES)?
    {
        write_native_frame_sync_bounded(&mut stdout, &message, MAX_COMMAND_MESSAGE_BYTES)?;
    }
    Ok(())
}

/// Install the user-scoped Native Messaging manifest for Google Chrome and for
/// any already-present compatible Chromium channels. The manifest points at the
/// exact running agent binary; Chrome supplies the pinned extension origin.
pub fn install_native_host_manifests(
    binary_path: &Path,
    home: &Path,
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    let binary = binary_path.to_str().ok_or_else(|| {
        BrowserBridgeError::Protocol("agent binary path is not valid UTF-8".to_string())
    })?;
    let body = serde_json::to_vec_pretty(&NativeHostManifest {
        name: NATIVE_HOST_NAME,
        description: "OpenGeni attached-browser bridge",
        path: binary,
        kind: "stdio",
        allowed_origins: [extension_origin()],
    })?;
    let mut installed = Vec::new();
    for (browser_root, primary) in native_host_browser_roots(home) {
        if !primary && !browser_root.exists() {
            continue;
        }
        let directory = browser_root.join("NativeMessagingHosts");
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{NATIVE_HOST_NAME}.json"));
        write_public_atomic(&path, &body)?;
        installed.push(path);
    }
    Ok(installed)
}

/// Remove every user-scoped manifest location this build owns. Missing files are
/// already clean and ignored.
pub fn remove_native_host_manifests(home: &Path) -> Result<(), BrowserBridgeError> {
    for (browser_root, _) in native_host_browser_roots(home) {
        let path = browser_root
            .join("NativeMessagingHosts")
            .join(format!("{NATIVE_HOST_NAME}.json"));
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn native_host_browser_roots(home: &Path) -> Vec<(PathBuf, bool)> {
    let applications = home.join("Library").join("Application Support");
    vec![
        (applications.join("Google").join("Chrome"), true),
        (applications.join("Google").join("Chrome Beta"), false),
        (applications.join("Chromium"), false),
        (
            applications.join("BraveSoftware").join("Brave-Browser"),
            false,
        ),
        (applications.join("Microsoft Edge"), false),
    ]
}

#[cfg(target_os = "linux")]
fn native_host_browser_roots(home: &Path) -> Vec<(PathBuf, bool)> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map_or_else(|| home.join(".config"), PathBuf::from);
    vec![
        (config.join("google-chrome"), true),
        (config.join("google-chrome-beta"), false),
        (config.join("chromium"), false),
        (config.join("BraveSoftware").join("Brave-Browser"), false),
        (config.join("microsoft-edge"), false),
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn native_host_browser_roots(_home: &Path) -> Vec<(PathBuf, bool)> {
    Vec::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeAuthority {
    protocol_version: u32,
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Serialize)]
struct NativeHostManifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    allowed_origins: [String; 1],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authenticate {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    role: BridgeRole,
    token: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BridgeRole {
    Extension,
    Controller,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // Mirrors the public capability bitmap exactly.
struct ExtensionCapabilities {
    tab_inventory: bool,
    debugger_attachment: bool,
    semantic_observation: bool,
    screenshots: bool,
    live_frames: bool,
    human_input: bool,
    diagnostics: bool,
    raw_cdp: bool,
    linked_computer: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExtensionPlatform {
    Linux,
    Macos,
    Windows,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExtensionArchitecture {
    X64,
    Arm64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionDevice {
    id: String,
    name: String,
    profile_label: Option<String>,
    browser_name: String,
    browser_version: String,
    extension_version: String,
    platform: ExtensionPlatform,
    architecture: ExtensionArchitecture,
    connection_generation: String,
    inventory_revision: u64,
    capabilities: ExtensionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // Chrome's tab observation is a boolean field set.
pub(crate) struct AttachedTab {
    pub(crate) id: String,
    pub(crate) window_id: u32,
    pub(crate) index: u32,
    pub(crate) title: String,
    pub(crate) url: Option<String>,
    pub(crate) active: bool,
    pub(crate) pinned: bool,
    pub(crate) incognito: bool,
    pub(crate) audible: bool,
    pub(crate) discarded: bool,
    pub(crate) controllable: bool,
    pub(crate) unavailable_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ExtensionMessage {
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        device: ExtensionDevice,
        tabs: Vec<AttachedTab>,
    },
    Inventory {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "connectionGeneration")]
        connection_generation: String,
        #[serde(rename = "inventoryRevision")]
        inventory_revision: u64,
        tabs: Vec<AttachedTab>,
    },
    CommandResult {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "connectionGeneration")]
        connection_generation: String,
        ok: bool,
        payload: Option<serde_json::Value>,
        error: Option<BridgeWireError>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeWireError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ControllerMessage {
    Request {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "expectedConnectionGeneration")]
        expected_connection_generation: String,
        payload: serde_json::Value,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionCommand<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    request_id: &'a str,
    device_id: &'a str,
    connection_generation: &'a str,
    payload: &'a serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionReady<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    device_id: &'a str,
    connection_generation: &'a str,
}

#[derive(Debug)]
struct ExtensionCommandResult {
    payload: Option<serde_json::Value>,
    error: Option<BridgeWireError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerResponse<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    request_id: &'a str,
    device_id: &'a str,
    connection_generation: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<BridgeWireError>,
}

struct PendingCommand {
    device_id: String,
    connection_generation: String,
    settle: oneshot::Sender<Result<ExtensionCommandResult, BrowserBridgeRequestFailure>>,
}

#[derive(Debug, Clone, Copy)]
enum BrowserBridgeRequestFailure {
    Unavailable,
    Fenced,
}

#[derive(Clone)]
struct ConnectedProfile {
    device: ExtensionDevice,
    tabs: Vec<AttachedTab>,
    outbound: mpsc::Sender<Vec<u8>>,
}

struct InventoryState {
    bridge_generation: String,
    revision: u64,
    profiles: BTreeMap<String, ConnectedProfile>,
    pending: HashMap<String, PendingCommand>,
}

/// Cheap clone held by the connection supervisor. Snapshotting never awaits the
/// extension and therefore cannot delay heartbeat/control RPCs.
#[derive(Clone)]
pub struct BrowserBridgeInventory {
    state: Arc<RwLock<InventoryState>>,
}

impl BrowserBridgeInventory {
    /// One complete authoritative snapshot for the heartbeat.
    #[must_use]
    pub fn snapshot(&self) -> v1::AttachedBrowserInventorySnapshot {
        let state = self.state.read().expect("browser bridge inventory lock");
        v1::AttachedBrowserInventorySnapshot {
            bridge_generation: state.bridge_generation.clone(),
            revision: state.revision,
            devices: state.profiles.values().map(announcement).collect(),
        }
    }

    async fn request(
        &self,
        request_id: &str,
        device_id: &str,
        expected_connection_generation: &str,
        payload: serde_json::Value,
    ) -> Result<ExtensionCommandResult, BrowserBridgeError> {
        uuid::Uuid::parse_str(request_id).map_err(|_| {
            BrowserBridgeError::Protocol("browser bridge request id must be a UUID".to_string())
        })?;
        uuid::Uuid::parse_str(device_id).map_err(|_| {
            BrowserBridgeError::Protocol("attached browser id must be a UUID".to_string())
        })?;
        bounded_string(
            expected_connection_generation,
            1,
            512,
            "browser connection generation",
        )?;
        if !payload.is_object() {
            return Err(BrowserBridgeError::Protocol(
                "browser bridge command payload must be an object".to_string(),
            ));
        }

        let (outbound, bytes, receiver) = {
            let mut state = self.state.write().expect("browser bridge inventory lock");
            if state.pending.len() >= MAX_PENDING_COMMANDS {
                return Err(BrowserBridgeError::Unavailable);
            }
            if state.pending.contains_key(request_id) {
                return Err(BrowserBridgeError::Protocol(
                    "browser bridge request id is already pending".to_string(),
                ));
            }
            let profile = state
                .profiles
                .get(device_id)
                .ok_or(BrowserBridgeError::Unavailable)?;
            if profile.device.connection_generation != expected_connection_generation {
                return Err(BrowserBridgeError::Fenced);
            }
            let outbound = profile.outbound.clone();
            let bytes = serde_json::to_vec(&ExtensionCommand {
                kind: "command",
                protocol_version: BRIDGE_PROTOCOL_VERSION,
                request_id,
                device_id,
                connection_generation: expected_connection_generation,
                payload: &payload,
            })?;
            if bytes.len() > MAX_COMMAND_MESSAGE_BYTES {
                return Err(BrowserBridgeError::Protocol(
                    "browser bridge command is too large".to_string(),
                ));
            }
            let (settle, receiver) = oneshot::channel();
            state.pending.insert(
                request_id.to_string(),
                PendingCommand {
                    device_id: device_id.to_string(),
                    connection_generation: expected_connection_generation.to_string(),
                    settle,
                },
            );
            (outbound, bytes, receiver)
        };

        if outbound.send(bytes).await.is_err() {
            self.cancel_request(
                request_id,
                device_id,
                expected_connection_generation,
                BrowserBridgeRequestFailure::Unavailable,
            );
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(BrowserBridgeRequestFailure::Fenced))) => Err(BrowserBridgeError::Fenced),
            Ok(Ok(Err(BrowserBridgeRequestFailure::Unavailable)) | Err(_)) => {
                Err(BrowserBridgeError::Unavailable)
            }
            Err(_) => {
                self.remove_pending(request_id, device_id, expected_connection_generation);
                Err(BrowserBridgeError::Timeout)
            }
        }
    }

    fn register(
        &self,
        device: ExtensionDevice,
        tabs: Vec<AttachedTab>,
        outbound: mpsc::Sender<Vec<u8>>,
    ) -> Result<(), BrowserBridgeError> {
        validate_device(&device, &tabs)?;
        let mut state = self.state.write().expect("browser bridge inventory lock");
        if state.profiles.len() >= MAX_ATTACHED_PROFILES && !state.profiles.contains_key(&device.id)
        {
            return Err(BrowserBridgeError::Protocol(
                "too many attached browser profiles".to_string(),
            ));
        }
        let pending_to_fence = take_pending_for_profile(&mut state, &device.id, None);
        state.profiles.insert(
            device.id.clone(),
            ConnectedProfile {
                device,
                tabs,
                outbound,
            },
        );
        state.revision = state.revision.saturating_add(1);
        drop(state);
        settle_pending(pending_to_fence, BrowserBridgeRequestFailure::Fenced);
        Ok(())
    }

    fn update(
        &self,
        device_id: &str,
        connection_generation: &str,
        inventory_revision: u64,
        tabs: Vec<AttachedTab>,
    ) -> Result<(), BrowserBridgeError> {
        validate_tabs(&tabs)?;
        let mut state = self.state.write().expect("browser bridge inventory lock");
        let profile = state.profiles.get_mut(device_id).ok_or_else(|| {
            BrowserBridgeError::Protocol("inventory arrived before profile hello".to_string())
        })?;
        if profile.device.connection_generation != connection_generation {
            return Err(BrowserBridgeError::Protocol(
                "inventory connection generation is stale".to_string(),
            ));
        }
        if inventory_revision < profile.device.inventory_revision {
            return Ok(());
        }
        if inventory_revision == profile.device.inventory_revision && tabs == profile.tabs {
            return Ok(());
        }
        profile.device.inventory_revision = inventory_revision;
        profile.tabs = tabs;
        state.revision = state.revision.saturating_add(1);
        Ok(())
    }

    fn disconnect(&self, device_id: &str, connection_generation: &str) {
        let mut state = self.state.write().expect("browser bridge inventory lock");
        if state
            .profiles
            .get(device_id)
            .is_some_and(|profile| profile.device.connection_generation == connection_generation)
        {
            state.profiles.remove(device_id);
            state.revision = state.revision.saturating_add(1);
            let pending =
                take_pending_for_profile(&mut state, device_id, Some(connection_generation));
            drop(state);
            settle_pending(pending, BrowserBridgeRequestFailure::Unavailable);
        }
    }

    fn settle_command(
        &self,
        request_id: &str,
        device_id: &str,
        connection_generation: &str,
        ok: bool,
        payload: Option<serde_json::Value>,
        error: Option<BridgeWireError>,
    ) -> Result<(), BrowserBridgeError> {
        uuid::Uuid::parse_str(request_id).map_err(|_| {
            BrowserBridgeError::Protocol("browser bridge result id must be a UUID".to_string())
        })?;
        if ok != (payload.is_some() && error.is_none()) {
            return Err(BrowserBridgeError::Protocol(
                "browser bridge result payload/error invariant failed".to_string(),
            ));
        }
        if let Some(error) = &error {
            bounded_string(&error.code, 1, 128, "browser bridge error code")?;
            bounded_string(&error.message, 1, 8_192, "browser bridge error message")?;
        }
        let pending = {
            let mut state = self.state.write().expect("browser bridge inventory lock");
            let Some(pending) = state.pending.get(request_id) else {
                return Ok(());
            };
            if pending.device_id != device_id
                || pending.connection_generation != connection_generation
            {
                return Err(BrowserBridgeError::Protocol(
                    "browser bridge result belongs to another request fence".to_string(),
                ));
            }
            state.pending.remove(request_id).expect("pending command")
        };
        let _ = pending
            .settle
            .send(Ok(ExtensionCommandResult { payload, error }));
        Ok(())
    }

    fn cancel_request(
        &self,
        request_id: &str,
        device_id: &str,
        connection_generation: &str,
        reason: BrowserBridgeRequestFailure,
    ) {
        let pending = {
            let mut state = self.state.write().expect("browser bridge inventory lock");
            match state.pending.get(request_id) {
                Some(pending)
                    if pending.device_id == device_id
                        && pending.connection_generation == connection_generation =>
                {
                    state.pending.remove(request_id)
                }
                _ => None,
            }
        };
        if let Some(pending) = pending {
            let _ = pending.settle.send(Err(reason));
        }
    }

    fn remove_pending(&self, request_id: &str, device_id: &str, connection_generation: &str) {
        let mut state = self.state.write().expect("browser bridge inventory lock");
        if state.pending.get(request_id).is_some_and(|pending| {
            pending.device_id == device_id && pending.connection_generation == connection_generation
        }) {
            state.pending.remove(request_id);
        }
    }
}

fn take_pending_for_profile(
    state: &mut InventoryState,
    device_id: &str,
    connection_generation: Option<&str>,
) -> Vec<PendingCommand> {
    let ids = state
        .pending
        .iter()
        .filter(|(_, pending)| {
            pending.device_id == device_id
                && connection_generation
                    .is_none_or(|generation| pending.connection_generation == generation)
        })
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    ids.into_iter()
        .filter_map(|request_id| state.pending.remove(&request_id))
        .collect()
}

fn settle_pending(pending: Vec<PendingCommand>, reason: BrowserBridgeRequestFailure) {
    for command in pending {
        let _ = command.settle.send(Err(reason));
    }
}

/// Long-running loopback server owned by the main agent process.
pub struct BrowserBridgeServer {
    inventory: BrowserBridgeInventory,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<Result<(), BrowserBridgeError>>,
    authority_path: PathBuf,
}

impl BrowserBridgeServer {
    /// Bind loopback, persist owner-only authority, and start accepting native
    /// hosts. The authority file contains no workspace credential.
    pub async fn start(config_dir: &Path) -> Result<Self, BrowserBridgeError> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let token = random_opaque(32);
        let inventory = BrowserBridgeInventory {
            state: Arc::new(RwLock::new(InventoryState {
                bridge_generation: random_opaque(24),
                revision: 0,
                profiles: BTreeMap::new(),
                pending: HashMap::new(),
            })),
        };
        let authority_path = write_authority(
            config_dir,
            &BridgeAuthority {
                protocol_version: BRIDGE_PROTOCOL_VERSION,
                port,
                token: token.clone(),
                pid: std::process::id(),
            },
        )?;
        let (shutdown, shutdown_rx) = watch::channel(false);
        let server_inventory = inventory.clone();
        let task = tokio::spawn(async move {
            accept_loop(listener, token, server_inventory, shutdown_rx).await
        });
        Ok(Self {
            inventory,
            shutdown,
            task,
            authority_path,
        })
    }

    /// Handle used by every workspace connection's Hello/heartbeat.
    #[must_use]
    pub fn inventory(&self) -> BrowserBridgeInventory {
        self.inventory.clone()
    }

    /// Stop accepting, wait for connection tasks, and remove only this process's
    /// authority file.
    pub async fn shutdown(self) -> Result<(), BrowserBridgeError> {
        let _ = self.shutdown.send(true);
        self.task.await??;
        if let Ok(authority) = read_authority(&self.authority_path) {
            if authority.pid == std::process::id() {
                let _ = std::fs::remove_file(&self.authority_path);
            }
        }
        Ok(())
    }
}

async fn accept_loop(
    listener: TcpListener,
    token: String,
    inventory: BrowserBridgeInventory,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), BrowserBridgeError> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let (socket, peer) = accepted?;
                if !peer.ip().is_loopback() {
                    continue;
                }
                let expected_token = token.clone();
                let connection_inventory = inventory.clone();
                connections.spawn(async move {
                    if let Err(error) = serve_bridge_connection(socket, &expected_token, connection_inventory).await {
                        match &error {
                            BrowserBridgeError::Protocol(_) | BrowserBridgeError::Authority(_) => {
                                warn!(%error, "attached browser bridge rejected a local peer");
                            }
                            _ => debug!(%error, "attached browser bridge peer ended"),
                        }
                    }
                });
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = result {
                    warn!(%error, "attached browser native-host task panicked");
                }
            }
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

async fn serve_bridge_connection(
    socket: TcpStream,
    expected_token: &str,
    inventory: BrowserBridgeInventory,
) -> Result<(), BrowserBridgeError> {
    socket.set_nodelay(true)?;
    let (mut reader, writer) = socket.into_split();
    let authentication =
        read_json_frame::<_, Authenticate>(&mut reader, MAX_AUTH_MESSAGE_BYTES).await?;
    if authentication.protocol_version != BRIDGE_PROTOCOL_VERSION
        || authentication.kind != "authenticate"
        || authentication.token != expected_token
    {
        return Err(BrowserBridgeError::Protocol(
            "browser bridge authentication failed".to_string(),
        ));
    }

    match authentication.role {
        BridgeRole::Extension => serve_extension(reader, writer, inventory).await,
        BridgeRole::Controller => serve_controller(reader, writer, inventory).await,
    }
}

async fn serve_extension(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    mut writer: tokio::net::tcp::OwnedWriteHalf,
    inventory: BrowserBridgeInventory,
) -> Result<(), BrowserBridgeError> {
    let (outbound, mut outbound_rx) = mpsc::channel::<Vec<u8>>(128);
    let mut claim: Option<(String, String)> = None;
    let result = async {
        loop {
            tokio::select! {
                incoming = read_native_frame_bounded(&mut reader, MAX_RESPONSE_MESSAGE_BYTES) => {
                    let Some(bytes) = incoming? else { break; };
                    let message: ExtensionMessage = serde_json::from_slice(&bytes)?;
                    match message {
                        ExtensionMessage::Hello { protocol_version, device, tabs } => {
                            if protocol_version != BRIDGE_PROTOCOL_VERSION {
                                return Err(BrowserBridgeError::Protocol("extension protocol version is unsupported".to_string()));
                            }
                            if claim.is_some() {
                                return Err(BrowserBridgeError::Protocol("one native-host connection sent multiple hellos".to_string()));
                            }
                            let device_id = device.id.clone();
                            let generation = device.connection_generation.clone();
                            let tab_count = tabs.len();
                            inventory.register(device, tabs, outbound.clone())?;
                            claim = Some((device_id.clone(), generation.clone()));
                            let ready = serde_json::to_vec(&ExtensionReady {
                                kind: "ready",
                                protocol_version: BRIDGE_PROTOCOL_VERSION,
                                device_id: &device_id,
                                connection_generation: &generation,
                            })?;
                            // Write readiness before servicing the outbound queue.
                            // A controller therefore cannot race its first command
                            // ahead of the extension's accepted-handshake signal.
                            write_native_frame_bounded(
                                &mut writer,
                                &ready,
                                MAX_COMMAND_MESSAGE_BYTES,
                            )
                            .await?;
                            debug!(%device_id, connection_generation = %generation, tab_count, "attached browser profile registered");
                        }
                        ExtensionMessage::Inventory { device_id, connection_generation, inventory_revision, tabs } => {
                            if claim.as_ref() != Some(&(device_id.clone(), connection_generation.clone())) {
                                return Err(BrowserBridgeError::Protocol("inventory does not belong to this native-host connection".to_string()));
                            }
                            inventory.update(&device_id, &connection_generation, inventory_revision, tabs)?;
                        }
                        ExtensionMessage::CommandResult { request_id, device_id, connection_generation, ok, payload, error } => {
                            if claim.as_ref() != Some(&(device_id.clone(), connection_generation.clone())) {
                                return Err(BrowserBridgeError::Protocol("command result does not belong to this native-host connection".to_string()));
                            }
                            inventory.settle_command(
                                &request_id,
                                &device_id,
                                &connection_generation,
                                ok,
                                payload,
                                error,
                            )?;
                        }
                    }
                }
                outbound_message = outbound_rx.recv() => {
                    let Some(bytes) = outbound_message else { break; };
                    write_native_frame_bounded(&mut writer, &bytes, MAX_COMMAND_MESSAGE_BYTES).await?;
                }
            }
        }
        Ok(())
    }
    .await;
    if let Some((device_id, generation)) = claim {
        inventory.disconnect(&device_id, &generation);
        debug!(%device_id, connection_generation = %generation, "attached browser profile disconnected");
    }
    result
}

async fn serve_controller(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    mut writer: tokio::net::tcp::OwnedWriteHalf,
    inventory: BrowserBridgeInventory,
) -> Result<(), BrowserBridgeError> {
    let (responses, mut response_rx) = mpsc::channel::<Vec<u8>>(128);
    let writer_task = tokio::spawn(async move {
        while let Some(response) = response_rx.recv().await {
            write_native_frame_bounded(&mut writer, &response, MAX_RESPONSE_MESSAGE_BYTES).await?;
        }
        Ok::<(), BrowserBridgeError>(())
    });
    let mut requests = tokio::task::JoinSet::new();
    while let Some(bytes) =
        read_native_frame_bounded(&mut reader, MAX_COMMAND_MESSAGE_BYTES).await?
    {
        let message: ControllerMessage = serde_json::from_slice(&bytes)?;
        let ControllerMessage::Request {
            protocol_version,
            request_id,
            device_id,
            expected_connection_generation,
            payload,
        } = message;
        if protocol_version != BRIDGE_PROTOCOL_VERSION {
            return Err(BrowserBridgeError::Protocol(
                "controller protocol version is unsupported".to_string(),
            ));
        }
        let request_inventory = inventory.clone();
        let request_responses = responses.clone();
        requests.spawn(async move {
            let result = request_inventory
                .request(
                    &request_id,
                    &device_id,
                    &expected_connection_generation,
                    payload,
                )
                .await;
            let response = controller_response(
                &request_id,
                &device_id,
                &expected_connection_generation,
                result,
            );
            if let Ok(bytes) = serde_json::to_vec(&response) {
                let _ = request_responses.send(bytes).await;
            }
        });
    }
    drop(responses);
    while requests.join_next().await.is_some() {}
    writer_task.await??;
    Ok(())
}

fn controller_response<'a>(
    request_id: &'a str,
    device_id: &'a str,
    connection_generation: &'a str,
    result: Result<ExtensionCommandResult, BrowserBridgeError>,
) -> ControllerResponse<'a> {
    let (payload, error) = match result {
        Ok(result) => (result.payload, result.error),
        Err(error) => (None, Some(bridge_wire_error(&error))),
    };
    ControllerResponse {
        kind: "response",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        request_id,
        device_id,
        connection_generation,
        ok: error.is_none(),
        payload,
        error,
    }
}

fn bridge_wire_error(error: &BrowserBridgeError) -> BridgeWireError {
    let (code, retryable) = match error {
        BrowserBridgeError::Unavailable => ("resource_unavailable", true),
        BrowserBridgeError::Fenced => ("fenced", true),
        BrowserBridgeError::Timeout => ("timeout", true),
        BrowserBridgeError::Protocol(_) | BrowserBridgeError::Authority(_) => ("protocol", false),
        BrowserBridgeError::Io(_) | BrowserBridgeError::Task(_) => ("bridge_failed", true),
    };
    BridgeWireError {
        code: code.to_string(),
        message: error.to_string(),
        retryable,
    }
}

fn announcement(profile: &ConnectedProfile) -> v1::AttachedBrowserDeviceAnnouncement {
    let capabilities = &profile.device.capabilities;
    v1::AttachedBrowserDeviceAnnouncement {
        id: profile.device.id.clone(),
        name: profile.device.name.clone(),
        profile_label: profile.device.profile_label.clone().unwrap_or_default(),
        browser_name: profile.device.browser_name.clone(),
        browser_version: profile.device.browser_version.clone(),
        extension_version: profile.device.extension_version.clone(),
        platform: match profile.device.platform {
            ExtensionPlatform::Linux => v1::Os::Linux as i32,
            ExtensionPlatform::Macos => v1::Os::Macos as i32,
            ExtensionPlatform::Windows => v1::Os::Windows as i32,
        },
        arch: match profile.device.architecture {
            ExtensionArchitecture::X64 => v1::Arch::X8664 as i32,
            ExtensionArchitecture::Arm64 => v1::Arch::Aarch64 as i32,
        },
        connection_generation: profile.device.connection_generation.clone(),
        inventory_revision: profile.device.inventory_revision,
        tab_count: u32::try_from(profile.tabs.len()).unwrap_or(u32::MAX),
        capabilities: Some(v1::AttachedBrowserDeviceCapabilities {
            tab_inventory: capabilities.tab_inventory,
            debugger_attachment: capabilities.debugger_attachment,
            semantic_observation: capabilities.semantic_observation,
            screenshots: capabilities.screenshots,
            live_frames: capabilities.live_frames,
            human_input: capabilities.human_input,
            diagnostics: capabilities.diagnostics,
            raw_cdp: capabilities.raw_cdp,
            linked_computer: capabilities.linked_computer,
        }),
    }
}

fn validate_device(
    device: &ExtensionDevice,
    tabs: &[AttachedTab],
) -> Result<(), BrowserBridgeError> {
    uuid::Uuid::parse_str(&device.id).map_err(|_| {
        BrowserBridgeError::Protocol("attached browser id must be a UUID".to_string())
    })?;
    bounded_string(&device.name, 1, 200, "browser name")?;
    if let Some(label) = &device.profile_label {
        bounded_string(label, 1, 200, "browser profile label")?;
    }
    bounded_string(&device.browser_name, 1, 100, "browser product name")?;
    bounded_string(&device.browser_version, 1, 256, "browser version")?;
    bounded_string(&device.extension_version, 1, 256, "extension version")?;
    bounded_string(
        &device.connection_generation,
        1,
        512,
        "browser connection generation",
    )?;
    validate_tabs(tabs)
}

fn validate_tabs(tabs: &[AttachedTab]) -> Result<(), BrowserBridgeError> {
    if tabs.len() > MAX_TABS_PER_PROFILE {
        return Err(BrowserBridgeError::Protocol(
            "attached browser tab inventory is too large".to_string(),
        ));
    }
    for tab in tabs {
        bounded_string(&tab.id, 1, 512, "browser tab id")?;
        bounded_string(&tab.title, 0, 8_192, "browser tab title")?;
        if let Some(url) = &tab.url {
            bounded_string(url, 1, 65_536, "browser tab url")?;
        }
        if tab.controllable == tab.unavailable_reason.is_some() {
            return Err(BrowserBridgeError::Protocol(
                "unavailable reason must exist exactly when a tab is not controllable".to_string(),
            ));
        }
    }
    Ok(())
}

fn bounded_string(
    value: &str,
    min: usize,
    max: usize,
    label: &str,
) -> Result<(), BrowserBridgeError> {
    if value.len() < min || value.len() > max {
        return Err(BrowserBridgeError::Protocol(format!(
            "{label} length is outside {min}..={max}"
        )));
    }
    Ok(())
}

async fn read_json_frame<R, T>(reader: &mut R, max_bytes: usize) -> Result<T, BrowserBridgeError>
where
    R: AsyncRead + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let bytes = read_native_frame_bounded(reader, max_bytes)
        .await?
        .ok_or_else(|| {
            BrowserBridgeError::Protocol("native host closed before auth".to_string())
        })?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
async fn read_native_frame<R>(reader: &mut R) -> Result<Option<Vec<u8>>, BrowserBridgeError>
where
    R: AsyncRead + Unpin,
{
    read_native_frame_bounded(reader, MAX_RESPONSE_MESSAGE_BYTES).await
}

async fn read_native_frame_bounded<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, BrowserBridgeError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > max_bytes {
        return Err(BrowserBridgeError::Protocol(format!(
            "native message length {length} is invalid"
        )));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
}

#[cfg(test)]
async fn write_native_frame<W>(writer: &mut W, bytes: &[u8]) -> Result<(), BrowserBridgeError>
where
    W: AsyncWrite + Unpin,
{
    write_native_frame_bounded(writer, bytes, MAX_RESPONSE_MESSAGE_BYTES).await
}

async fn write_native_frame_bounded<W>(
    writer: &mut W,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<(), BrowserBridgeError>
where
    W: AsyncWrite + Unpin,
{
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(BrowserBridgeError::Protocol(
            "outbound native message length is invalid".to_string(),
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| BrowserBridgeError::Protocol("native message is too large".to_string()))?;
    writer.write_all(&length.to_ne_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
fn read_native_frame_sync<R>(reader: &mut R) -> Result<Option<Vec<u8>>, BrowserBridgeError>
where
    R: std::io::Read,
{
    read_native_frame_sync_bounded(reader, MAX_RESPONSE_MESSAGE_BYTES)
}

fn read_native_frame_sync_bounded<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, BrowserBridgeError>
where
    R: std::io::Read,
{
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        let count = reader.read(&mut header[read..])?;
        if count == 0 {
            if read == 0 {
                return Ok(None);
            }
            return Err(BrowserBridgeError::Protocol(
                "native message ended inside its length header".to_string(),
            ));
        }
        read += count;
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > max_bytes {
        return Err(BrowserBridgeError::Protocol(format!(
            "native message length {length} is invalid"
        )));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

#[cfg(test)]
fn write_native_frame_sync<W>(writer: &mut W, bytes: &[u8]) -> Result<(), BrowserBridgeError>
where
    W: std::io::Write,
{
    write_native_frame_sync_bounded(writer, bytes, MAX_RESPONSE_MESSAGE_BYTES)
}

fn write_native_frame_sync_bounded<W>(
    writer: &mut W,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<(), BrowserBridgeError>
where
    W: std::io::Write,
{
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(BrowserBridgeError::Protocol(
            "outbound native message length is invalid".to_string(),
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| BrowserBridgeError::Protocol("native message is too large".to_string()))?;
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()?;
    Ok(())
}

fn random_opaque(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn authority_path(config_dir: &Path) -> PathBuf {
    config_dir.join(AUTHORITY_FILE)
}

fn write_authority(
    config_dir: &Path,
    authority: &BridgeAuthority,
) -> Result<PathBuf, BrowserBridgeError> {
    std::fs::create_dir_all(config_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(config_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let destination = authority_path(config_dir);
    let temporary = config_dir.join(format!(".{AUTHORITY_FILE}.{}.tmp", random_opaque(8)));
    let body = serde_json::to_vec(authority)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&body)?;
    file.sync_all()?;
    #[cfg(windows)]
    if destination.exists() {
        std::fs::remove_file(&destination)?;
    }
    std::fs::rename(&temporary, &destination)?;
    Ok(destination)
}

fn write_public_atomic(destination: &Path, body: &[u8]) -> Result<(), BrowserBridgeError> {
    let parent = destination.parent().ok_or_else(|| {
        BrowserBridgeError::Protocol("native-host manifest has no parent directory".to_string())
    })?;
    let temporary = parent.join(format!(".{NATIVE_HOST_NAME}.{}.tmp", random_opaque(8)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o644);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(body)?;
    file.sync_all()?;
    #[cfg(windows)]
    if destination.exists() {
        std::fs::remove_file(destination)?;
    }
    std::fs::rename(&temporary, destination)?;
    Ok(())
}

fn read_authority(path: &Path) -> Result<BridgeAuthority, BrowserBridgeError> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;
    use sha2::{Digest as _, Sha256};
    use std::io::Cursor;

    #[test]
    fn native_host_origin_matches_the_extension_manifest_key() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../apps/browser-extension/manifest.json"
        )))
        .expect("extension manifest");
        let public_key = manifest
            .get("key")
            .and_then(serde_json::Value::as_str)
            .expect("extension manifest key");
        let digest = Sha256::digest(STANDARD.decode(public_key).expect("extension public key"));
        let id = digest[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0x0f])
            .map(|nibble| char::from(b'a' + nibble))
            .collect::<String>();
        assert_eq!(id, EXTENSION_ID);
        assert_eq!(extension_origin(), format!("chrome-extension://{id}/"));
    }

    fn tab(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "windowId": 1,
            "index": 0,
            "title": "OpenGeni",
            "url": "https://opengeni.ai/",
            "active": true,
            "pinned": false,
            "incognito": false,
            "audible": false,
            "discarded": false,
            "controllable": true,
            "unavailableReason": null
        })
    }

    fn hello(device_id: &str, generation: &str, revision: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "hello",
            "protocolVersion": 1,
            "device": {
                "id": device_id,
                "name": "Primary Chrome",
                "profileLabel": "cloudgeni.ai",
                "browserName": "Chrome",
                "browserVersion": "151.0.0.0",
                "extensionVersion": "1.0.0",
                "platform": "macos",
                "architecture": "arm64",
                "connectionGeneration": generation,
                "inventoryRevision": revision,
                "capabilities": {
                    "tabInventory": true,
                    "debuggerAttachment": true,
                    "semanticObservation": true,
                    "screenshots": true,
                    "liveFrames": true,
                    "humanInput": true,
                    "diagnostics": true,
                    "rawCdp": false,
                    "linkedComputer": true
                }
            },
            "tabs": [tab("11")]
        }))
        .expect("hello json")
    }

    async fn read_json(socket: &mut TcpStream) -> serde_json::Value {
        let frame = tokio::time::timeout(Duration::from_secs(1), read_native_frame(socket))
            .await
            .expect("native frame timeout")
            .expect("native frame read")
            .expect("native frame missing");
        serde_json::from_slice(&frame).expect("native frame json")
    }

    #[tokio::test]
    async fn authenticates_and_fences_complete_profile_inventories() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let authority = read_authority(&authority_path(directory.path())).expect("authority");
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("connect");
        write_native_frame(
            &mut socket,
            &serde_json::to_vec(&json!({
                "type": "authenticate",
                "protocolVersion": 1,
                "role": "extension",
                "token": authority.token
            }))
            .expect("auth"),
        )
        .await
        .expect("write auth");
        let device_id = "11111111-1111-4111-8111-111111111111";
        write_native_frame(&mut socket, &hello(device_id, "connection-1", 1))
            .await
            .expect("write hello");
        for _ in 0..20 {
            if server.inventory().snapshot().devices.len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let snapshot = server.inventory().snapshot();
        assert_eq!(snapshot.devices.len(), 1);
        assert_eq!(snapshot.devices[0].id, device_id);
        assert_eq!(snapshot.devices[0].tab_count, 1);
        write_native_frame(
            &mut socket,
            &serde_json::to_vec(&json!({
                "type": "inventory",
                "deviceId": device_id,
                "connectionGeneration": "connection-1",
                "inventoryRevision": 2,
                "tabs": [tab("11"), tab("12")]
            }))
            .expect("inventory"),
        )
        .await
        .expect("write inventory");
        for _ in 0..20 {
            if server.inventory().snapshot().devices[0].tab_count == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(server.inventory().snapshot().devices[0].tab_count, 2);

        drop(socket);
        for _ in 0..20 {
            if server.inventory().snapshot().devices.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(server.inventory().snapshot().devices.is_empty());
        server.shutdown().await.expect("shutdown");
        assert!(!authority_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn rejects_a_native_host_without_the_local_authority() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let authority = read_authority(&authority_path(directory.path())).expect("authority");
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("connect");
        write_native_frame(
            &mut socket,
            &serde_json::to_vec(&json!({
                "type": "authenticate",
                "protocolVersion": 1,
                "role": "extension",
                "token": "wrong"
            }))
            .expect("auth"),
        )
        .await
        .expect("write auth");
        write_native_frame(
            &mut socket,
            &hello("11111111-1111-4111-8111-111111111111", "connection-1", 1),
        )
        .await
        .ok();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(server.inventory().snapshot().devices.is_empty());
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn routes_controller_commands_through_one_exact_extension_generation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let authority = read_authority(&authority_path(directory.path())).expect("authority");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let generation = "connection-1";

        let mut extension = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("extension connect");
        write_native_frame(
            &mut extension,
            &serde_json::to_vec(&json!({
                "type": "authenticate",
                "protocolVersion": 1,
                "role": "extension",
                "token": authority.token
            }))
            .expect("extension auth"),
        )
        .await
        .expect("write extension auth");
        write_native_frame(&mut extension, &hello(device_id, generation, 1))
            .await
            .expect("write hello");
        let ready = read_json(&mut extension).await;
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["deviceId"], device_id);
        assert_eq!(ready["connectionGeneration"], generation);
        for _ in 0..20 {
            if server.inventory().snapshot().devices.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let mut controller = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("controller connect");
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type": "authenticate",
                "protocolVersion": 1,
                "role": "controller",
                "token": authority.token
            }))
            .expect("controller auth"),
        )
        .await
        .expect("write controller auth");
        let request_id = "22222222-2222-4222-8222-222222222222";
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type": "request",
                "protocolVersion": 1,
                "requestId": request_id,
                "deviceId": device_id,
                "expectedConnectionGeneration": generation,
                "payload": { "type": "ping" }
            }))
            .expect("request"),
        )
        .await
        .expect("write request");

        let command = read_json(&mut extension).await;
        assert_eq!(command["type"], "command");
        assert_eq!(command["requestId"], request_id);
        assert_eq!(command["payload"]["type"], "ping");
        write_native_frame(
            &mut extension,
            &serde_json::to_vec(&json!({
                "type": "command_result",
                "requestId": request_id,
                "deviceId": device_id,
                "connectionGeneration": generation,
                "ok": true,
                "payload": { "pong": true },
                "error": null
            }))
            .expect("result"),
        )
        .await
        .expect("write result");

        let response = read_json(&mut controller).await;
        assert_eq!(response["type"], "response");
        assert_eq!(response["ok"], true);
        assert_eq!(response["payload"]["pong"], true);

        drop(controller);
        drop(extension);
        server.shutdown().await.expect("shutdown");
    }

    #[test]
    fn native_frames_are_bounded_and_byte_exact() {
        let message = br#"{"type":"hello"}"#;
        let mut encoded = Vec::new();
        write_native_frame_sync(&mut encoded, message).expect("write");
        assert_eq!(
            read_native_frame_sync(&mut Cursor::new(encoded)).expect("read"),
            Some(message.to_vec())
        );

        let oversized = vec![0_u8; MAX_RESPONSE_MESSAGE_BYTES + 1];
        assert!(write_native_frame_sync(&mut Vec::new(), &oversized).is_err());
        let screenshot_response = vec![0_u8; MAX_COMMAND_MESSAGE_BYTES + 1];
        assert!(write_native_frame_sync(&mut Vec::new(), &screenshot_response).is_ok());
        assert!(write_native_frame_sync_bounded(
            &mut Vec::new(),
            &screenshot_response,
            MAX_COMMAND_MESSAGE_BYTES,
        )
        .is_err());
    }

    #[test]
    fn installs_a_pinned_origin_manifest_and_removes_it_cleanly() {
        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("opengeni-agent");
        std::fs::write(&binary, b"fixture").expect("binary");
        let manifests = install_native_host_manifests(&binary, directory.path()).expect("install");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(!manifests.is_empty());
        for path in &manifests {
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).expect("manifest")).expect("json");
            assert_eq!(manifest["name"], NATIVE_HOST_NAME);
            assert_eq!(manifest["path"], binary.to_str().expect("path"));
            assert_eq!(manifest["allowed_origins"][0], extension_origin());
        }
        remove_native_host_manifests(directory.path()).expect("remove");
        assert!(manifests.iter().all(|path| !path.exists()));
    }
}
