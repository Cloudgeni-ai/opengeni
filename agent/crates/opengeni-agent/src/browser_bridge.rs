//! Local Chrome-extension bridge for attached, already-running browser profiles.
//!
//! Chrome starts one Native Messaging host process per extension connection. The
//! host is deliberately only a bounded stdio↔loopback proxy; this long-running
//! agent process owns authentication, profile/tab inventory, connection fencing,
//! and eventually command routing. A browser profile is a live endpoint, never a
//! reusable [`BrowserIdentity`](https://docs.opengeni.ai/) state snapshot.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io::Write as _,
    net::Shutdown,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant, SystemTime},
};

use crate::uploads::update_drain::{UpdateDrain, WorkReservation};
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
use tracing::{debug, info, warn};

const BRIDGE_PROTOCOL_VERSION: u32 = 1;
const AUTHORITY_FILE: &str = "browser-bridge-authority.json";
const NATIVE_HOST_NAME: &str = "ai.opengeni.browser";
const EXTENSION_ID: &str = "imdmcebcclhibdfolbokjbiibpcnpbel";
const STORE_EXTENSION_ID: &str = "phpmmcbeelfkcinjfbbggegjdcdmnnch";
/// Comma-separated IDs of a product's own Chrome extensions (its branded build
/// of the attached-browser extension), set by the desktop app or installer
/// that registers this agent. Chrome lets them reach the agent too.
pub const EXTENSION_IDS_ENV: &str = "OPENGENI_AGENT_BROWSER_EXTENSION_IDS";
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
/// Ended extension connections a bridge remembers and reports.
const MAX_RECORDED_CONNECTION_ENDS: usize = 32;
const MAX_CONNECTION_END_DETAIL_BYTES: usize = 512;
/// Chrome-supplied page metadata is bounded rather than trusted to fit.
const MAX_TAB_TITLE_BYTES: usize = 8_192;
const MAX_TAB_URL_BYTES: usize = 65_536;
const TAB_URL_TOO_LONG: &str = "This tab's address is too long for Opengeni to control";

/// Reading buffered debugger events changes nothing in the browser. Every live
/// attached connection polls continuously, so treating a poll as accepted work
/// would keep a self-update waiting for as long as any connection exists, and
/// refusing one during an idle probe would break every event stream.
fn is_passive_request(payload: &serde_json::Value) -> bool {
    payload.get("type").and_then(serde_json::Value::as_str) == Some("debugger.poll")
}

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
    /// The process has fenced new work for a verified self-update.
    #[error("attached browser work is draining for update")]
    Draining,
}

/// Chrome passes the calling extension's origin as argv[1]. Native Messaging
/// manifests cannot append a subcommand, so the agent recognizes an extension
/// origin before ordinary CLI parsing. Which extensions may start the host is
/// decided by Chrome from the manifest's `allowed_origins`, which the agent
/// writes, so any well-formed extension origin is a host invocation here.
#[must_use]
pub fn is_native_host_invocation() -> bool {
    std::env::args()
        .nth(1)
        .is_some_and(|origin| is_extension_origin(&origin))
}

fn is_extension_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'))
        .is_some_and(is_extension_id)
}

/// Chrome extension IDs are 32 letters from `a` to `p`.
fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// The extension IDs named in [`EXTENSION_IDS_ENV`]. Malformed entries are
/// logged and skipped, so a typo cannot widen the manifest to something Chrome
/// rejects as a whole.
#[must_use]
pub fn extension_ids_from_env() -> Vec<String> {
    std::env::var(EXTENSION_IDS_ENV)
        .map(|value| parse_extension_ids(&value))
        .unwrap_or_default()
}

fn parse_extension_ids(value: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for id in value.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        if !is_extension_id(id) {
            warn!(id, "ignoring a malformed Chrome extension ID");
        } else if !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// The origins allowed to start the host: the Opengeni Browser extension's
/// development and store builds, then `extra_ids` in order.
fn extension_origins(extra_ids: &[String]) -> Vec<String> {
    let mut origins = vec![
        extension_origin(),
        format!("chrome-extension://{STORE_EXTENSION_ID}/"),
    ];
    for id in extra_ids {
        let origin = format!("chrome-extension://{id}/");
        if is_extension_id(id) && !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

fn extension_origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

/// Run the Chrome-spawned Native Messaging host. It owns no browser or cloud
/// authority: after reading the owner-only local authority file it authenticates
/// to the already-running agent and copies bounded native-message frames.
///
/// Chrome discards a host's stderr, so when the host cannot reach the agent it
/// first tells the extension why in one `unavailable` frame on stdout. The
/// extension shows that to the person instead of a bare disconnect.
pub fn run_native_host() -> Result<(), BrowserBridgeError> {
    let mut browser_output = std::io::stdout().lock();
    let connected = crate::config::config_dir()
        .map_err(|error| {
            (
                AgentUnavailableReason::AgentError,
                BrowserBridgeError::Protocol(error.to_string()),
            )
        })
        .and_then(|config_dir| connect_native_host(&config_dir));
    match connected {
        Ok(socket) => relay_native_host(socket, std::io::stdin(), browser_output),
        Err((reason, error)) => {
            write_agent_unavailable_sync(&mut browser_output, reason, &error.to_string());
            Err(error)
        }
    }
}

/// Opens the authenticated agent connection for this host, or says which
/// [`AgentUnavailableReason`] keeps it from doing so.
fn connect_native_host(
    config_dir: &Path,
) -> Result<std::net::TcpStream, (AgentUnavailableReason, BrowserBridgeError)> {
    use AgentUnavailableReason::{AgentError, AgentNotRunning, AgentOutdated};
    // The running agent writes this file when it starts its bridge.
    let authority = match read_authority(&authority_path(config_dir)) {
        Ok(authority) => authority,
        Err(BrowserBridgeError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err((AgentNotRunning, error.into()));
        }
        Err(error) => return Err((AgentError, error)),
    };
    if authority.protocol_version != BRIDGE_PROTOCOL_VERSION {
        // This host is the agent's installed program. A running agent with an
        // older bridge is a previous version that has not restarted yet.
        let reason = if authority.protocol_version < BRIDGE_PROTOCOL_VERSION {
            AgentOutdated
        } else {
            AgentError
        };
        return Err((
            reason,
            BrowserBridgeError::Protocol(
                "the running agent and its installed program use different browser bridge versions; restart the agent"
                    .to_string(),
            ),
        ));
    }
    let mut socket = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
        .map_err(|error| {
            // A file left behind by an agent that exited without removing it.
            let reason = if error.kind() == std::io::ErrorKind::ConnectionRefused {
                AgentNotRunning
            } else {
                AgentError
            };
            (reason, error.into())
        })?;
    authenticate_native_host(&mut socket, &authority.token).map_err(|error| (AgentError, error))?;
    Ok(socket)
}

fn authenticate_native_host(
    socket: &mut std::net::TcpStream,
    token: &str,
) -> Result<(), BrowserBridgeError> {
    socket.set_nodelay(true)?;
    let authentication = serde_json::to_vec(&serde_json::json!({
        "type": "authenticate",
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "role": "extension",
        "token": token,
    }))?;
    write_native_frame_sync_bounded(socket, &authentication, MAX_AUTH_MESSAGE_BYTES)
}

/// Copy frames between Chrome (`browser_input`/`browser_output`) and the
/// authenticated agent socket until either side ends.
fn relay_native_host<I, O>(
    mut socket: std::net::TcpStream,
    mut browser_input: I,
    mut browser_output: O,
) -> Result<(), BrowserBridgeError>
where
    I: std::io::Read + Send + 'static,
    O: std::io::Write,
{
    // Keep the agent -> Chrome direction on the main thread. If the agent
    // rejects a hello or shuts down, EOF now terminates this disposable native
    // host immediately instead of leaving it blocked forever on Chrome stdin.
    // Conversely, Chrome EOF shuts down the socket write half, which makes the
    // agent close its read half and releases the main loop below.
    // Before closing, the host tells the agent why in one final frame, so the
    // agent can tell a browser-side close from a host that simply vanished.
    let agent_writer = Arc::new(Mutex::new(socket.try_clone()?));
    let browser_writer = Arc::clone(&agent_writer);
    let _browser_input = std::thread::spawn(move || {
        let closing = loop {
            let message = match read_native_frame_sync_bounded(
                &mut browser_input,
                MAX_RESPONSE_MESSAGE_BYTES,
            ) {
                Ok(Some(message)) => message,
                Ok(None) => break Some((NativeHostClosingReason::ClosedPort, None)),
                Err(error) => {
                    break Some((
                        NativeHostClosingReason::MessageInvalid,
                        Some(error.to_string()),
                    ))
                }
            };
            let mut writer = browser_writer.lock().expect("native host agent writer");
            if write_native_frame_sync_bounded(&mut *writer, &message, MAX_RESPONSE_MESSAGE_BYTES)
                .is_err()
            {
                // The agent side is gone; nobody is left to tell.
                break None;
            }
        };
        let mut writer = browser_writer.lock().expect("native host agent writer");
        if let Some((reason, detail)) = closing {
            send_native_host_closing(&mut writer, reason, detail.as_deref());
        }
        let _ = writer.shutdown(Shutdown::Write);
    });

    let mut answered = false;
    let ended = loop {
        let message = match read_native_frame_sync_bounded(&mut socket, MAX_COMMAND_MESSAGE_BYTES) {
            Ok(Some(message)) => message,
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        };
        answered = true;
        if let Err(error) = write_native_frame_sync_bounded(
            &mut browser_output,
            &message,
            MAX_COMMAND_MESSAGE_BYTES,
        ) {
            let mut writer = agent_writer.lock().expect("native host agent writer");
            send_native_host_closing(
                &mut writer,
                NativeHostClosingReason::OutputFailed,
                Some(&error.to_string()),
            );
            let _ = writer.shutdown(Shutdown::Write);
            return Err(error);
        }
    };
    if !answered {
        // The agent explains every hello it refuses. Closing without a word
        // means it stopped, or did not accept this host's authentication.
        let detail = match &ended {
            Ok(()) => "the agent closed the browser connection without answering".to_string(),
            Err(error) => format!("the agent connection failed before answering: {error}"),
        };
        write_agent_unavailable_sync(
            &mut browser_output,
            AgentUnavailableReason::AgentError,
            &detail,
        );
    }
    ended
}

/// Why this computer's agent cannot take an extension connection. The agent
/// side sends it in one `unavailable` frame before closing, so the extension
/// can tell the person which side to start or update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AgentUnavailableReason {
    /// No agent is running for this user.
    AgentNotRunning,
    /// The running agent is older than the extension (or than its own
    /// installed program, until it restarts).
    AgentOutdated,
    /// The extension is older than the running agent.
    ExtensionOutdated,
    /// Anything else; the frame's detail says what.
    AgentError,
}

/// The frame an extension of any version can read: it exists to explain a
/// version difference, so its shape never depends on the protocol version.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUnavailable<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    reason: AgentUnavailableReason,
    /// The running agent's version. Only the running agent sends it: a native
    /// host is the installed program, which may already be newer.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_version: Option<&'static str>,
    detail: &'a str,
}

fn agent_unavailable_frame(
    reason: AgentUnavailableReason,
    agent_version: Option<&'static str>,
    detail: &str,
) -> Vec<u8> {
    serde_json::to_vec(&AgentUnavailable {
        kind: "unavailable",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        reason,
        agent_version,
        detail: truncate_utf8(detail, MAX_CONNECTION_END_DETAIL_BYTES),
    })
    .expect("agent unavailable frame serializes")
}

/// The native host's own report. Best effort: Chrome may already have closed
/// the port.
fn write_agent_unavailable_sync<W: std::io::Write>(
    browser_output: &mut W,
    reason: AgentUnavailableReason,
    detail: &str,
) {
    let frame = agent_unavailable_frame(reason, None, detail);
    let _ = write_native_frame_sync_bounded(browser_output, &frame, MAX_COMMAND_MESSAGE_BYTES);
}

/// Which side is outdated when a hello names another bridge protocol version.
/// Read before the full hello, whose shape belongs to that version.
fn hello_version_refusal(bytes: &[u8]) -> Option<AgentUnavailableReason> {
    #[derive(Deserialize)]
    struct HelloVersion {
        #[serde(rename = "type")]
        kind: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<u32>,
    }
    let hello = serde_json::from_slice::<HelloVersion>(bytes).ok()?;
    let version = hello.protocol_version.filter(|_| hello.kind == "hello")?;
    match version.cmp(&BRIDGE_PROTOCOL_VERSION) {
        std::cmp::Ordering::Less => Some(AgentUnavailableReason::ExtensionOutdated),
        std::cmp::Ordering::Equal => None,
        std::cmp::Ordering::Greater => Some(AgentUnavailableReason::AgentOutdated),
    }
}

fn send_native_host_closing(
    writer: &mut std::net::TcpStream,
    reason: NativeHostClosingReason,
    detail: Option<&str>,
) {
    let detail = detail.map(|detail| truncate_utf8(detail, MAX_CONNECTION_END_DETAIL_BYTES));
    if let Ok(frame) = serde_json::to_vec(&NativeHostClosing {
        kind: "native_host_closing",
        reason,
        detail,
    }) {
        let _ = write_native_frame_sync_bounded(writer, &frame, MAX_RESPONSE_MESSAGE_BYTES);
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Install the user-scoped Native Messaging manifest for Google Chrome and for
/// any already-present compatible Chromium channels. The manifest points at the
/// exact running agent binary and allows the Opengeni Browser extension plus
/// `extra_extension_ids`, a product's own branded extensions.
///
/// On Windows the browsers find the manifest through the per-user registry, so
/// the one manifest file is written under `%LOCALAPPDATA%` and each browser's
/// `NativeMessagingHosts` key names it.
pub fn install_native_host_manifests(
    binary_path: &Path,
    home: &Path,
    extra_extension_ids: &[String],
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    #[cfg(windows)]
    return install_registered_native_host(
        binary_path,
        &browser_data_home(home),
        extra_extension_ids,
        &CurrentUserRegistry,
    );
    #[cfg(not(windows))]
    install_native_host_manifests_in(binary_path, &browser_data_home(home), extra_extension_ids)
}

fn native_host_manifest_body(
    binary_path: &Path,
    extra_extension_ids: &[String],
) -> Result<Vec<u8>, BrowserBridgeError> {
    let binary = launchable_program_path(binary_path);
    let binary = binary.to_str().ok_or_else(|| {
        BrowserBridgeError::Protocol("agent binary path is not valid UTF-8".to_string())
    })?;
    Ok(serde_json::to_vec_pretty(&NativeHostManifest {
        name: NATIVE_HOST_NAME,
        description: "Opengeni attached-browser bridge",
        path: binary,
        kind: "stdio",
        allowed_origins: extension_origins(extra_extension_ids),
    })?)
}

/// The path a manifest names for the agent binary. Chrome on Windows starts a
/// Native Messaging host through `cmd.exe`, which cannot run a program named by
/// a verbatim path (`\\?\C:\…`, the form `canonicalize` returns there): the host
/// never starts and the extension reports a broken connection. The manifest
/// therefore names the ordinary form of the same path.
fn launchable_program_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(ordinary) = path.to_str().and_then(ordinary_windows_path) {
        return PathBuf::from(ordinary);
    }
    path.to_path_buf()
}

/// `\\?\C:\dir\file` as `C:\dir\file` and `\\?\UNC\server\share\file` as
/// `\\server\share\file`; `None` when `path` is not such a verbatim path.
#[cfg_attr(not(windows), allow(dead_code))]
fn ordinary_windows_path(path: &str) -> Option<String> {
    if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{share}"));
    }
    let rest = path.strip_prefix(r"\\?\")?;
    let drive = rest.as_bytes();
    (drive.len() >= 3 && drive[0].is_ascii_alphabetic() && drive[1] == b':' && drive[2] == b'\\')
        .then(|| rest.to_string())
}

/// Whether a manifest naming `target` belongs to the agent at `binary_path`:
/// it names this binary, or a program that no longer exists in this agent's
/// own directory (a leftover from before the agent was renamed).
fn manifest_points_here(body: &[u8], binary_path: &Path) -> bool {
    let binary_path = launchable_program_path(binary_path);
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|manifest| {
            let target = manifest.get("path")?.as_str()?;
            Some(launchable_program_path(Path::new(target)))
        })
        .is_some_and(|target| {
            target == binary_path || (target.parent() == binary_path.parent() && !target.exists())
        })
}

#[cfg_attr(windows, allow(dead_code))]
fn install_native_host_manifests_in(
    binary_path: &Path,
    data_home: &Path,
    extra_extension_ids: &[String],
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    let body = native_host_manifest_body(binary_path, extra_extension_ids)?;
    let mut installed = Vec::new();
    for (browser_root, primary) in native_host_browser_roots(data_home) {
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
    #[cfg(windows)]
    return remove_registered_native_host(&browser_data_home(home), &CurrentUserRegistry);
    #[cfg(not(windows))]
    remove_native_host_manifests_in(&browser_data_home(home))
}

#[cfg_attr(windows, allow(dead_code))]
fn remove_native_host_manifests_in(data_home: &Path) -> Result<(), BrowserBridgeError> {
    for (browser_root, _) in native_host_browser_roots(data_home) {
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

/// Remove the manifests that point at `binary_path`, leaving those another agent
/// on this computer wrote. A manifest that points at a program which no longer
/// exists in this agent's own directory is a leftover from before the agent was
/// renamed, so it is removed too. Returns the removed paths.
pub fn remove_native_host_manifests_for(
    binary_path: &Path,
    home: &Path,
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    #[cfg(windows)]
    return remove_registered_native_host_for(
        binary_path,
        &browser_data_home(home),
        &CurrentUserRegistry,
    );
    #[cfg(not(windows))]
    remove_native_host_manifests_for_in(binary_path, &browser_data_home(home))
}

#[cfg_attr(windows, allow(dead_code))]
fn remove_native_host_manifests_for_in(
    binary_path: &Path,
    data_home: &Path,
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    let mut removed = Vec::new();
    for (browser_root, _) in native_host_browser_roots(data_home) {
        let path = browser_root
            .join("NativeMessagingHosts")
            .join(format!("{NATIVE_HOST_NAME}.json"));
        let body = match std::fs::read(&path) {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if manifest_points_here(&body, binary_path) {
            match std::fs::remove_file(&path) {
                Ok(()) => removed.push(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(removed)
}

/// Where a Chromium-family browser on Windows looks up a Native Messaging host:
/// the default value of a per-user registry key, naming the manifest file.
trait NativeHostRegistry {
    fn key_exists(&self, key: &str) -> std::io::Result<bool>;
    fn default_value(&self, key: &str) -> std::io::Result<Option<String>>;
    fn set_default_value(&self, key: &str, value: &str) -> std::io::Result<()>;
    fn delete_key(&self, key: &str) -> std::io::Result<()>;
}

#[cfg(windows)]
struct CurrentUserRegistry;

#[cfg(windows)]
impl NativeHostRegistry for CurrentUserRegistry {
    fn key_exists(&self, key: &str) -> std::io::Result<bool> {
        opengeni_agent_windows_ffi::current_user_registry::key_exists(key)
    }
    fn default_value(&self, key: &str) -> std::io::Result<Option<String>> {
        opengeni_agent_windows_ffi::current_user_registry::default_value(key)
    }
    fn set_default_value(&self, key: &str, value: &str) -> std::io::Result<()> {
        opengeni_agent_windows_ffi::current_user_registry::set_default_value(key, value)
    }
    fn delete_key(&self, key: &str) -> std::io::Result<()> {
        opengeni_agent_windows_ffi::current_user_registry::delete_key(key)
    }
}

/// The per-user registry roots of the Chromium-family browsers on Windows.
/// Google Chrome (all channels share its key) is always registered, so the
/// bridge works for a Chrome installed later; the others only when present.
const WINDOWS_BROWSER_KEYS: [(&str, bool); 4] = [
    (r"Software\Google\Chrome", true),
    (r"Software\Chromium", false),
    (r"Software\Microsoft\Edge", false),
    (r"Software\BraveSoftware\Brave-Browser", false),
];

fn windows_host_key(browser_key: &str) -> String {
    format!(r"{browser_key}\NativeMessagingHosts\{NATIVE_HOST_NAME}")
}

fn windows_manifest_path(manifest_directory: &Path) -> PathBuf {
    manifest_directory.join(format!("{NATIVE_HOST_NAME}.json"))
}

/// Writes the manifest into `manifest_directory` and points each browser's
/// host key at it. Returns the manifest path.
#[cfg_attr(not(windows), allow(dead_code))]
fn install_registered_native_host(
    binary_path: &Path,
    manifest_directory: &Path,
    extra_extension_ids: &[String],
    registry: &dyn NativeHostRegistry,
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    let body = native_host_manifest_body(binary_path, extra_extension_ids)?;
    std::fs::create_dir_all(manifest_directory)?;
    let manifest = windows_manifest_path(manifest_directory);
    write_public_atomic(&manifest, &body)?;
    let value = manifest.to_str().ok_or_else(|| {
        BrowserBridgeError::Protocol("manifest path is not valid UTF-8".to_string())
    })?;
    for (browser_key, primary) in WINDOWS_BROWSER_KEYS {
        if !primary && !registry.key_exists(browser_key)? {
            continue;
        }
        registry.set_default_value(&windows_host_key(browser_key), value)?;
    }
    Ok(vec![manifest])
}

/// Removes this build's manifest and every browser host key that names it.
/// A key naming another manifest belongs to someone else and stays.
#[cfg_attr(not(windows), allow(dead_code))]
fn remove_registered_native_host(
    manifest_directory: &Path,
    registry: &dyn NativeHostRegistry,
) -> Result<(), BrowserBridgeError> {
    let manifest = windows_manifest_path(manifest_directory);
    unregister_windows_manifest(&manifest, registry)?;
    match std::fs::remove_file(&manifest) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Removes the registration when its manifest points at `binary_path` (or at a
/// renamed predecessor in the same directory), leaving another agent's.
#[cfg_attr(not(windows), allow(dead_code))]
fn remove_registered_native_host_for(
    binary_path: &Path,
    manifest_directory: &Path,
    registry: &dyn NativeHostRegistry,
) -> Result<Vec<PathBuf>, BrowserBridgeError> {
    let manifest = windows_manifest_path(manifest_directory);
    let body = match std::fs::read(&manifest) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !manifest_points_here(&body, binary_path) {
        return Ok(Vec::new());
    }
    remove_registered_native_host(manifest_directory, registry)?;
    Ok(vec![manifest])
}

fn unregister_windows_manifest(
    manifest: &Path,
    registry: &dyn NativeHostRegistry,
) -> Result<(), BrowserBridgeError> {
    for (browser_key, _) in WINDOWS_BROWSER_KEYS {
        let key = windows_host_key(browser_key);
        let names_this = registry
            .default_value(&key)?
            .is_some_and(|value| Path::new(&value) == manifest);
        if names_this {
            registry.delete_key(&key)?;
        }
    }
    Ok(())
}

/// The directory under which Chromium-family browsers keep their per-user data
/// for `home`.
#[cfg(target_os = "macos")]
fn browser_data_home(home: &Path) -> PathBuf {
    home.join("Library").join("Application Support")
}

/// The directory under which Chromium-family browsers keep their per-user data
/// for `home`: `$XDG_CONFIG_HOME` when set, as the browsers themselves resolve it.
#[cfg(target_os = "linux")]
fn browser_data_home(home: &Path) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map_or_else(|| home.join(".config"), PathBuf::from)
}

/// Where this agent keeps its Native Messaging manifest for `home`:
/// `%LOCALAPPDATA%\Opengeni\NativeMessagingHosts`, beside the agent's install
/// directory (`%LOCALAPPDATA%\Opengeni\bin`).
#[cfg(windows)]
fn browser_data_home(home: &Path) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map_or_else(|| home.join("AppData").join("Local"), PathBuf::from)
        .join("Opengeni")
        .join("NativeMessagingHosts")
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn browser_data_home(home: &Path) -> PathBuf {
    home.to_path_buf()
}

#[cfg(target_os = "macos")]
fn native_host_browser_roots(applications: &Path) -> Vec<(PathBuf, bool)> {
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
fn native_host_browser_roots(config: &Path) -> Vec<(PathBuf, bool)> {
    vec![
        (config.join("google-chrome"), true),
        (config.join("google-chrome-beta"), false),
        (config.join("chromium"), false),
        (config.join("BraveSoftware").join("Brave-Browser"), false),
        (config.join("microsoft-edge"), false),
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn native_host_browser_roots(_data_home: &Path) -> Vec<(PathBuf, bool)> {
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
    allowed_origins: Vec<String>,
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

// Extension messages ignore fields this agent does not know. The extension
// updates from its store independently of the agent; a newer extension adding
// a field must never be locked out by an older agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
    /// The extension's live-state generation: one value for the lifetime of
    /// its background worker, reused by every native reconnect. Chrome keeps
    /// tab ids and debugger attachments across those reconnects, so the
    /// control plane's placement stays the same while the per-port
    /// `connection_generation` keeps fencing this transport. Older extensions
    /// omit it; their placement then changes with every connection.
    #[serde(default)]
    state_generation: Option<String>,
    inventory_revision: u64,
    capabilities: ExtensionCapabilities,
}

impl ExtensionDevice {
    /// The generation the control plane binds sessions to.
    fn placement_generation(&self) -> &str {
        self.state_generation
            .as_deref()
            .unwrap_or(&self.connection_generation)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionProfileMetadata {
    profile_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
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
        #[serde(default)]
        profile: Option<ExtensionProfileMetadata>,
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
    /// The native host's last frame before it closes the connection. A frame
    /// relayed from Chrome could claim this type too; it only labels why the
    /// connection is about to end and grants nothing.
    NativeHostClosing {
        reason: NativeHostClosingReason,
        #[serde(default)]
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
enum NativeHostClosingReason {
    #[serde(rename = "browser_closed_port")]
    ClosedPort,
    #[serde(rename = "browser_message_invalid")]
    MessageInvalid,
    #[serde(rename = "browser_output_failed")]
    OutputFailed,
}

#[derive(Serialize)]
struct NativeHostClosing<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    reason: NativeHostClosingReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
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
    settle: Option<oneshot::Sender<Result<ExtensionCommandResult, BrowserBridgeRequestFailure>>>,
    _reservation: Option<WorkReservation>,
}

struct ControllerReply {
    bytes: Vec<u8>,
    // PendingCommand independently retains physical work through a late result.
    // An undeliverable reply must not permanently poison update admission.
    _reservation: Option<WorkReservation>,
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
    connected_at: Instant,
}

struct InventoryState {
    bridge_generation: String,
    revision: u64,
    profiles: BTreeMap<String, ConnectedProfile>,
    pending: HashMap<String, PendingCommand>,
    connection_ends: VecDeque<v1::AttachedBrowserConnectionEnd>,
}

impl InventoryState {
    fn new(bridge_generation: String) -> Self {
        Self {
            bridge_generation,
            revision: 0,
            profiles: BTreeMap::new(),
            pending: HashMap::new(),
            connection_ends: VecDeque::new(),
        }
    }
}

/// Why this bridge saw one extension connection end.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConnectionEnd {
    reason: v1::AttachedBrowserConnectionEndReason,
    detail: Option<String>,
}

impl ConnectionEnd {
    /// Classify the end of one native-host connection from the host's own
    /// closing report (if it sent one) and how the agent's read loop ended.
    fn observe(
        result: &Result<(), BrowserBridgeError>,
        closing: Option<(NativeHostClosingReason, Option<String>)>,
    ) -> Self {
        use v1::AttachedBrowserConnectionEndReason as Reason;
        if let Err(error @ (BrowserBridgeError::Protocol(_) | BrowserBridgeError::Authority(_))) =
            result
        {
            return Self {
                reason: Reason::AgentRejected,
                detail: Some(error.to_string()),
            };
        }
        if let Some((reason, detail)) = closing {
            return Self {
                reason: match reason {
                    NativeHostClosingReason::ClosedPort => Reason::BrowserClosedPort,
                    NativeHostClosingReason::MessageInvalid => Reason::BrowserMessageInvalid,
                    NativeHostClosingReason::OutputFailed => Reason::BrowserOutputFailed,
                },
                detail,
            };
        }
        Self {
            reason: Reason::NativeHostLost,
            detail: match result {
                Ok(()) => None,
                Err(error) => Some(error.to_string()),
            },
        }
    }
}

/// Cheap clone held by the connection supervisor. Snapshotting never awaits the
/// extension and therefore cannot delay heartbeat/control RPCs.
#[derive(Clone)]
pub struct BrowserBridgeInventory {
    state: Arc<RwLock<InventoryState>>,
    update_drain: Arc<UpdateDrain>,
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
            connection_ends: state.connection_ends.iter().cloned().collect(),
        }
    }
}

impl std::fmt::Debug for BrowserBridgeInventory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BrowserBridgeInventory")
            .finish_non_exhaustive()
    }
}

impl BrowserBridgeInventory {
    /// Whether `placement` belongs to a connected profile whose extension
    /// reports no live-state generation: its next native connection, such as
    /// after this process restarts, gets a new placement and ends its sessions.
    #[must_use]
    pub fn placement_ends_on_reconnect(&self, placement: &str) -> bool {
        let state = self.state.read().expect("browser bridge inventory lock");
        state.profiles.values().any(|profile| {
            profile.device.state_generation.is_none()
                && profile.device.connection_generation == placement
        })
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

        let (outbound, bytes, receiver, transport_generation) = {
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
            if profile.device.placement_generation() != expected_connection_generation {
                return Err(BrowserBridgeError::Fenced);
            }
            let outbound = profile.outbound.clone();
            // The placement generation may outlive one native port; the
            // extension and every result fence use the exact live port.
            let transport_generation = profile.device.connection_generation.clone();
            let bytes = serde_json::to_vec(&ExtensionCommand {
                kind: "command",
                protocol_version: BRIDGE_PROTOCOL_VERSION,
                request_id,
                device_id,
                connection_generation: &transport_generation,
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
                    connection_generation: transport_generation.clone(),
                    settle: Some(settle),
                    _reservation: opengeni_agent_platform::current_work_reservation(),
                },
            );
            (outbound, bytes, receiver, transport_generation)
        };

        if outbound.send(bytes).await.is_err() {
            self.cancel_request(
                request_id,
                device_id,
                &transport_generation,
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
                // Timeout ends only the caller's wait. The extension may still
                // execute; a matching late result is the physical settlement.
                Err(BrowserBridgeError::Timeout)
            }
        }
    }

    fn register(
        &self,
        device: ExtensionDevice,
        mut tabs: Vec<AttachedTab>,
        outbound: mpsc::Sender<Vec<u8>>,
    ) -> Result<(), BrowserBridgeError> {
        validate_device(&device, &mut tabs)?;
        let mut state = self.state.write().expect("browser bridge inventory lock");
        if state.profiles.len() >= MAX_ATTACHED_PROFILES && !state.profiles.contains_key(&device.id)
        {
            return Err(BrowserBridgeError::Protocol(
                "too many attached browser profiles".to_string(),
            ));
        }
        notify_pending_for_profile(
            &mut state,
            &device.id,
            None,
            BrowserBridgeRequestFailure::Fenced,
        );
        state.profiles.insert(
            device.id.clone(),
            ConnectedProfile {
                device,
                tabs,
                outbound,
                connected_at: Instant::now(),
            },
        );
        state.revision = state.revision.saturating_add(1);
        drop(state);
        Ok(())
    }

    fn update(
        &self,
        device_id: &str,
        connection_generation: &str,
        inventory_revision: u64,
        metadata: Option<ExtensionProfileMetadata>,
        mut tabs: Vec<AttachedTab>,
    ) -> Result<(), BrowserBridgeError> {
        validate_tabs(&mut tabs)?;
        if let Some(label) = metadata
            .as_ref()
            .and_then(|metadata| metadata.profile_label.as_ref())
        {
            bounded_string(label, 1, 200, "browser profile label")?;
        }
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
        if inventory_revision == profile.device.inventory_revision
            && tabs == profile.tabs
            && metadata
                .as_ref()
                .is_none_or(|metadata| metadata.profile_label == profile.device.profile_label)
        {
            return Ok(());
        }
        profile.device.inventory_revision = inventory_revision;
        if let Some(metadata) = metadata {
            profile.device.name = metadata
                .profile_label
                .clone()
                .unwrap_or_else(|| "Chrome profile".to_string());
            profile.device.profile_label = metadata.profile_label;
        }
        profile.tabs = tabs;
        state.revision = state.revision.saturating_add(1);
        Ok(())
    }

    fn disconnect(&self, device_id: &str, connection_generation: &str, end: ConnectionEnd) {
        let mut state = self.state.write().expect("browser bridge inventory lock");
        let connected = state
            .profiles
            .get(device_id)
            .filter(|profile| profile.device.connection_generation == connection_generation)
            .map(|profile| profile.connected_at.elapsed());
        info!(
            %device_id,
            %connection_generation,
            reason = end.reason.as_str_name(),
            detail = end.detail.as_deref().unwrap_or(""),
            connected_ms = connected.map_or(0, |duration| duration.as_millis()),
            "attached browser connection ended"
        );
        if state.connection_ends.len() >= MAX_RECORDED_CONNECTION_ENDS {
            state.connection_ends.pop_front();
        }
        state
            .connection_ends
            .push_back(v1::AttachedBrowserConnectionEnd {
                device_id: device_id.to_string(),
                connection_generation: connection_generation.to_string(),
                reason: end.reason as i32,
                detail: end
                    .detail
                    .map(|mut detail| {
                        let length = truncate_utf8(&detail, MAX_CONNECTION_END_DETAIL_BYTES).len();
                        detail.truncate(length);
                        detail
                    })
                    .unwrap_or_default(),
                ended_at_unix_ms: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |elapsed| {
                        i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
                    }),
                connected_ms: connected.map_or(0, |duration| {
                    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
                }),
            });
        state.revision = state.revision.saturating_add(1);
        if state
            .profiles
            .get(device_id)
            .is_some_and(|profile| profile.device.connection_generation == connection_generation)
        {
            state.profiles.remove(device_id);
            notify_pending_for_profile(
                &mut state,
                device_id,
                Some(connection_generation),
                BrowserBridgeRequestFailure::Unavailable,
            );
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
        if let Some(settle) = pending.settle {
            let _ = settle.send(Ok(ExtensionCommandResult { payload, error }));
        }
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
            if let Some(settle) = pending.settle {
                let _ = settle.send(Err(reason));
            }
        }
    }
}

/// Fail and forget every command sent on a native port that has ended or been
/// replaced. Its result can only come back on that port, so nothing can settle
/// it any more; keeping it would hold its work reservation, and with it every
/// self-update, for as long as the agent runs.
fn notify_pending_for_profile(
    state: &mut InventoryState,
    device_id: &str,
    connection_generation: Option<&str>,
    reason: BrowserBridgeRequestFailure,
) {
    state.pending.retain(|_, command| {
        let ended = command.device_id == device_id
            && connection_generation
                .is_none_or(|generation| command.connection_generation == generation);
        if ended {
            if let Some(settle) = command.settle.take() {
                let _ = settle.send(Err(reason));
            }
        }
        !ended
    });
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
    #[cfg(test)]
    pub async fn start(config_dir: &Path) -> Result<Self, BrowserBridgeError> {
        Self::start_with_update_drain(config_dir, Arc::new(UpdateDrain::default())).await
    }

    /// Shares the same host-wide admission boundary as every workspace RPC.
    pub async fn start_with_update_drain(
        config_dir: &Path,
        update_drain: Arc<UpdateDrain>,
    ) -> Result<Self, BrowserBridgeError> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let token = random_opaque(32);
        let inventory = BrowserBridgeInventory {
            update_drain,
            state: Arc::new(RwLock::new(InventoryState::new(random_opaque(24)))),
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

async fn serve_extension<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut reader: R,
    mut writer: W,
    inventory: BrowserBridgeInventory,
) -> Result<(), BrowserBridgeError> {
    let (outbound, mut outbound_rx) = mpsc::channel::<Vec<u8>>(128);
    let mut claim: Option<(String, String)> = None;
    let mut closing: Option<(NativeHostClosingReason, Option<String>)> = None;
    // Until `ready` is written, a failure is a refused hello: the extension is
    // told why before the connection closes.
    let mut ready_sent = false;
    let mut refusal: Option<AgentUnavailableReason> = None;
    let result = async {
        loop {
            // read_exact may already have consumed part of the header or body.
            // Keep that same read alive while outbound commands are serviced.
            let incoming = read_native_frame_bounded(&mut reader, MAX_RESPONSE_MESSAGE_BYTES);
            tokio::pin!(incoming);
            loop {
                tokio::select! {
                    frame = &mut incoming => {
                        let Some(bytes) = frame? else { return Ok(()); };
                        if !ready_sent {
                            refusal = hello_version_refusal(&bytes);
                            if refusal.is_some() {
                                return Err(BrowserBridgeError::Protocol("extension protocol version is unsupported".to_string()));
                            }
                        }
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
                                // Claimed before validation so a rejected hello is
                                // still recorded as this generation's end.
                                claim = Some((device_id.clone(), generation.clone()));
                                inventory.register(device, tabs, outbound.clone())?;
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
                                ready_sent = true;
                                debug!(%device_id, connection_generation = %generation, tab_count, "attached browser profile registered");
                            }
                            ExtensionMessage::Inventory { device_id, connection_generation, inventory_revision, profile, tabs } => {
                                if claim.as_ref() != Some(&(device_id.clone(), connection_generation.clone())) {
                                    return Err(BrowserBridgeError::Protocol("inventory does not belong to this native-host connection".to_string()));
                                }
                                inventory.update(&device_id, &connection_generation, inventory_revision, profile, tabs)?;
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
                            ExtensionMessage::NativeHostClosing { reason, detail } => {
                                closing = Some((reason, detail));
                            }
                        }
                        break;
                    }
                    outbound_message = outbound_rx.recv() => {
                        let Some(bytes) = outbound_message else { return Ok(()); };
                        write_native_frame_bounded(&mut writer, &bytes, MAX_COMMAND_MESSAGE_BYTES).await?;
                    }
                }
            }
        }
    }
    .await;
    if let (false, Err(error)) = (ready_sent, &result) {
        let frame = agent_unavailable_frame(
            refusal.unwrap_or(AgentUnavailableReason::AgentError),
            Some(env!("CARGO_PKG_VERSION")),
            &error.to_string(),
        );
        let _ = write_native_frame_bounded(&mut writer, &frame, MAX_COMMAND_MESSAGE_BYTES).await;
    }
    if let Some((device_id, generation)) = claim {
        inventory.disconnect(
            &device_id,
            &generation,
            ConnectionEnd::observe(&result, closing),
        );
    }
    result
}

async fn serve_controller(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    mut writer: tokio::net::tcp::OwnedWriteHalf,
    inventory: BrowserBridgeInventory,
) -> Result<(), BrowserBridgeError> {
    let (responses, mut response_rx) = mpsc::channel::<ControllerReply>(128);
    let writer_task = tokio::spawn(async move {
        while let Some(response) = response_rx.recv().await {
            write_native_frame_bounded(&mut writer, &response.bytes, MAX_RESPONSE_MESSAGE_BYTES)
                .await?;
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
        // Reserve before spawn/first await. A controller peer's disappearing
        // waiter cannot cancel an accepted extension command or its publisher.
        // A passive event poll is neither reserved nor refused: losing one in
        // a swap only makes the controller resynchronize its event cursor.
        let passive = is_passive_request(&payload);
        let reservation = if passive {
            None
        } else {
            inventory.update_drain.reserve_work(None)
        };
        if let Some(reservation) = &reservation {
            reservation.describe(format!("attached-browser request {request_id}"));
        }
        let accepted = passive || reservation.is_some();
        let reply_reservation = reservation.clone();
        let actual = tokio::spawn(opengeni_agent_platform::with_work_reservation(
            reservation,
            async move {
                let result = if accepted {
                    request_inventory
                        .request(
                            &request_id,
                            &device_id,
                            &expected_connection_generation,
                            payload,
                        )
                        .await
                } else {
                    Err(BrowserBridgeError::Draining)
                };
                let response = controller_response(
                    &request_id,
                    &device_id,
                    &expected_connection_generation,
                    result,
                );
                if let Ok(bytes) = serde_json::to_vec(&response) {
                    let _ = request_responses
                        .send(ControllerReply {
                            bytes,
                            _reservation: reply_reservation,
                        })
                        .await;
                } else {
                    tracing::warn!(%request_id, "attached-browser controller reply could not be encoded");
                }
            },
        ));
        requests.spawn(async move {
            let _ = actual.await;
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
        BrowserBridgeError::Draining => ("update_draining", true),
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
        connection_generation: profile.device.placement_generation().to_string(),
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
    tabs: &mut [AttachedTab],
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
    if let Some(state_generation) = &device.state_generation {
        bounded_string(state_generation, 1, 512, "browser state generation")?;
    }
    validate_tabs(tabs)
}

/// Validate the extension's own fields and bound the page-supplied ones. A
/// page title or address is chosen by whatever site a tab shows, so an
/// oversized one is clamped (or makes that one tab uncontrollable) instead of
/// failing the whole profile connection, which would also fail every
/// reconnect for as long as the tab stays open.
fn validate_tabs(tabs: &mut [AttachedTab]) -> Result<(), BrowserBridgeError> {
    if tabs.len() > MAX_TABS_PER_PROFILE {
        return Err(BrowserBridgeError::Protocol(
            "attached browser tab inventory is too large".to_string(),
        ));
    }
    for tab in tabs {
        bounded_string(&tab.id, 1, 512, "browser tab id")?;
        if tab.controllable == tab.unavailable_reason.is_some() {
            return Err(BrowserBridgeError::Protocol(
                "unavailable reason must exist exactly when a tab is not controllable".to_string(),
            ));
        }
        if tab.title.len() > MAX_TAB_TITLE_BYTES {
            let length = truncate_utf8(&tab.title, MAX_TAB_TITLE_BYTES).len();
            tab.title.truncate(length);
        }
        if tab
            .url
            .as_ref()
            .is_some_and(|url| url.len() > MAX_TAB_URL_BYTES)
        {
            tab.url = None;
            tab.controllable = false;
            tab.unavailable_reason = Some(TAB_URL_TOO_LONG.to_string());
        }
        if tab.url.as_ref().is_some_and(String::is_empty) {
            tab.url = None;
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
pub(crate) mod test_support {
    use super::{authority_path, read_authority, read_native_frame, write_native_frame};
    use std::path::Path;
    use tokio::net::TcpStream;

    /// Connects one authenticated extension to the bridge in `config_dir` and
    /// waits for its ready frame. `state_generation` is omitted for an older
    /// extension.
    pub(crate) async fn connect_extension(
        config_dir: &Path,
        device_id: &str,
        connection_generation: &str,
        state_generation: Option<&str>,
    ) -> TcpStream {
        let authority = read_authority(&authority_path(config_dir)).expect("authority");
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("connect");
        let auth = serde_json::json!({
            "type": "authenticate", "protocolVersion": 1, "role": "extension",
            "token": authority.token
        });
        write_native_frame(&mut socket, &serde_json::to_vec(&auth).expect("auth"))
            .await
            .expect("write auth");
        let mut device = serde_json::json!({
            "id": device_id, "name": "Chrome profile", "profileLabel": null,
            "browserName": "Chrome", "browserVersion": "151.0.0.0", "extensionVersion": "1.0.0",
            "platform": "linux", "architecture": "x64",
            "connectionGeneration": connection_generation, "inventoryRevision": 1,
            "capabilities": {
                "tabInventory": true, "debuggerAttachment": true, "semanticObservation": true,
                "screenshots": true, "liveFrames": true, "humanInput": true, "diagnostics": true,
                "rawCdp": false, "linkedComputer": true
            }
        });
        if let Some(state) = state_generation {
            device["stateGeneration"] = serde_json::json!(state);
        }
        let hello = serde_json::json!({
            "type": "hello", "protocolVersion": 1, "device": device, "tabs": []
        });
        write_native_frame(&mut socket, &serde_json::to_vec(&hello).expect("hello"))
            .await
            .expect("write hello");
        let ready = read_native_frame(&mut socket)
            .await
            .expect("ready")
            .expect("ready frame");
        let ready: serde_json::Value = serde_json::from_slice(&ready).expect("ready json");
        assert_eq!(ready["type"], "ready");
        socket
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn lost_controller_reply_keeps_physical_work_but_does_not_poison_updates() {
        use crate::uploads::update_drain::{UpdateDrain, UpdateReservation};
        let drain = std::sync::Arc::new(UpdateDrain::default());
        let physical = drain.reserve_work(None).unwrap();
        drop(ControllerReply {
            bytes: b"reply".to_vec(),
            _reservation: Some(physical.clone()),
        });
        assert_eq!(drain.reserve_update("update"), UpdateReservation::Started);
        assert!(!drain.seal_update("update"));
        drop(physical);
        assert!(drain.seal_update("update"));
    }

    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;
    use sha2::{Digest as _, Sha256};
    use std::io::Cursor;

    struct SignalledReader<R> {
        inner: R,
        remaining: usize,
        consumed: Option<oneshot::Sender<()>>,
    }

    impl<R: AsyncRead + Unpin> AsyncRead for SignalledReader<R> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let before = buf.filled().len();
            let result = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
            self.remaining = self.remaining.saturating_sub(buf.filled().len() - before);
            if self.remaining == 0 {
                if let Some(consumed) = self.consumed.take() {
                    let _ = consumed.send(());
                }
            }
            result
        }
    }

    #[tokio::test]
    async fn outbound_command_preserves_partial_incoming_header() {
        assert_partial_extension_frame_survives_command(2).await;
    }

    #[tokio::test]
    async fn outbound_command_preserves_partial_incoming_payload() {
        assert_partial_extension_frame_survives_command(40).await;
    }

    async fn assert_partial_extension_frame_survives_command(prefix_length: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            let device_id = "11111111-1111-4111-8111-111111111111";
            let request_id = "22222222-2222-4222-8222-222222222222";
            let generation = "connection-1";
            let inventory = BrowserBridgeInventory {
                state: Arc::new(RwLock::new(InventoryState::new("test-bridge".to_string()))),
                update_drain: Arc::new(UpdateDrain::default()),
            };
            let greeting = hello(device_id, generation, 1);
            let update = serde_json::to_vec(&json!({
                "type": "inventory", "deviceId": device_id,
                "connectionGeneration": generation, "inventoryRevision": 2,
                "profile": { "profileLabel": "Work browser" },
                "tabs": [tab("11")]
            }))
            .expect("inventory");
            let mut frame = u32::try_from(update.len())
                .expect("length")
                .to_ne_bytes()
                .to_vec();
            frame.extend_from_slice(&update);
            let (client, server) = tokio::io::duplex(4096);
            let (reader, writer) = tokio::io::split(server);
            let (consumed, prefix_consumed) = oneshot::channel();
            let reader = SignalledReader {
                inner: reader,
                remaining: 4 + greeting.len() + prefix_length,
                consumed: Some(consumed),
            };
            let connection = tokio::spawn(serve_extension(reader, writer, inventory.clone()));
            let mut client = client;
            write_native_frame(&mut client, &greeting)
                .await
                .expect("hello");
            let ready = read_native_frame(&mut client)
                .await
                .expect("ready")
                .expect("open");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&ready).unwrap()["type"],
                "ready"
            );

            client
                .write_all(&frame[..prefix_length])
                .await
                .expect("prefix");
            // The receiver has consumed the prefix before an outbound command
            // becomes ready. No timing or TCP packet-boundary assumption.
            prefix_consumed.await.expect("prefix consumed");
            let request_inventory = inventory.clone();
            let pending = tokio::spawn(async move {
                request_inventory
                    .request(request_id, device_id, generation, json!({ "type": "ping" }))
                    .await
            });
            let command = read_native_frame(&mut client)
                .await
                .expect("command")
                .expect("open");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&command).unwrap()["requestId"],
                request_id
            );
            client
                .write_all(&frame[prefix_length..])
                .await
                .expect("rest of frame");
            write_native_frame(
                &mut client,
                &serde_json::to_vec(&json!({
                    "type": "command_result", "requestId": request_id,
                    "deviceId": device_id, "connectionGeneration": generation,
                    "ok": true, "payload": { "pong": true }, "error": null
                }))
                .expect("result"),
            )
            .await
            .expect("write result");
            let result = pending
                .await
                .expect("request task")
                .expect("command settled");
            assert_eq!(result.payload, Some(json!({ "pong": true })));
            assert!(result.error.is_none());
            assert_renamed_profile(&inventory.snapshot(), generation);
            drop(client);
            connection
                .await
                .expect("connection task")
                .expect("clean EOF");
        })
        .await
        .expect("bounded partial-frame regression");
    }

    fn assert_renamed_profile(snapshot: &v1::AttachedBrowserInventorySnapshot, generation: &str) {
        assert_eq!(snapshot.devices.len(), 1);
        assert_eq!(snapshot.devices[0].connection_generation, generation);
        assert_eq!(snapshot.devices[0].inventory_revision, 2);
        assert_eq!(snapshot.devices[0].name, "Work browser");
        assert_eq!(snapshot.devices[0].profile_label, "Work browser");
    }

    #[test]
    fn inventory_metadata_is_optional_and_can_clear_a_profile_label() {
        let inventory = BrowserBridgeInventory {
            state: Arc::new(RwLock::new(InventoryState::new("test-bridge".to_string()))),
            update_drain: Arc::new(UpdateDrain::default()),
        };
        let id = "11111111-1111-4111-8111-111111111111";
        let generation = "connection-1";
        let ExtensionMessage::Hello { device, tabs, .. } =
            serde_json::from_slice(&hello(id, generation, 1)).unwrap()
        else {
            panic!("hello fixture");
        };
        let (outbound, _receiver) = mpsc::channel(1);
        inventory.register(device, tabs.clone(), outbound).unwrap();
        inventory
            .update(id, generation, 2, None, tabs.clone())
            .unwrap();
        assert_eq!(
            inventory.snapshot().devices[0].profile_label,
            "example.test"
        );
        inventory
            .update(
                id,
                generation,
                3,
                Some(ExtensionProfileMetadata {
                    profile_label: None,
                }),
                tabs.clone(),
            )
            .unwrap();
        let snapshot = inventory.snapshot();
        assert_eq!(snapshot.devices[0].name, "Chrome profile");
        assert_eq!(snapshot.devices[0].profile_label, "");
        assert_eq!(snapshot.devices[0].connection_generation, generation);
        inventory
            .update(
                id,
                generation,
                2,
                Some(ExtensionProfileMetadata {
                    profile_label: Some("Stale name".to_string()),
                }),
                tabs.clone(),
            )
            .unwrap();
        assert_eq!(inventory.snapshot().devices[0].profile_label, "");
        assert!(inventory
            .update(
                id,
                "old-connection",
                4,
                Some(ExtensionProfileMetadata {
                    profile_label: Some("Stale connection".to_string())
                }),
                tabs.clone()
            )
            .is_err());
        assert_eq!(inventory.snapshot().devices[0].profile_label, "");
        assert!(inventory
            .update(
                id,
                generation,
                4,
                Some(ExtensionProfileMetadata {
                    profile_label: Some("x".repeat(201))
                }),
                tabs
            )
            .is_err());
        assert_eq!(inventory.snapshot().devices[0].inventory_revision, 3);
    }

    #[test]
    fn native_host_accepts_only_well_formed_extension_origins() {
        for origin in extension_origins(&[]) {
            assert!(is_extension_origin(&origin));
            assert!(!is_extension_origin(origin.trim_end_matches('/')));
            assert!(!is_extension_origin(&format!("{origin}extra")));
        }
        // A product's own extension: Chrome only starts the host for origins the
        // manifest allows, so the agent recognizes any extension origin.
        assert!(is_extension_origin(
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
        ));
        for malformed in [
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension://qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension://Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension:///",
            "--help",
            "run",
        ] {
            assert!(!is_extension_origin(malformed), "{malformed}");
        }
        assert!(!is_extension_origin(
            "https://phpmmcbeelfkcinjfbbggegjdcdmnnch/"
        ));
    }

    #[test]
    fn extra_extension_ids_are_validated_deduplicated_and_kept_in_order() {
        let ids = parse_extension_ids(&format!(
            " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, not-an-id,,{EXTENSION_ID},cccccccccccccccccccccccccccccccc,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "
        ));
        assert_eq!(
            ids,
            vec!["b".repeat(32), EXTENSION_ID.to_string(), "c".repeat(32)]
        );
        assert_eq!(
            extension_origins(&ids),
            vec![
                extension_origin(),
                format!("chrome-extension://{STORE_EXTENSION_ID}/"),
                format!("chrome-extension://{}/", "b".repeat(32)),
                format!("chrome-extension://{}/", "c".repeat(32)),
            ]
        );
        assert_eq!(parse_extension_ids(""), Vec::<String>::new());
    }

    #[test]
    fn installs_a_manifest_that_also_allows_a_products_own_extension() {
        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("opengeni-agent");
        std::fs::write(&binary, b"fixture").expect("binary");
        let own = "d".repeat(32);
        let manifests =
            install_native_host_manifests_in(&binary, directory.path(), std::slice::from_ref(&own))
                .expect("install");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_ne!(manifests, [] as [std::path::PathBuf; 0]);
        for path in &manifests {
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).expect("manifest")).expect("json");
            assert_eq!(manifest["name"], NATIVE_HOST_NAME);
            assert_eq!(
                manifest["allowed_origins"],
                json!([
                    extension_origin(),
                    format!("chrome-extension://{STORE_EXTENSION_ID}/"),
                    format!("chrome-extension://{own}/"),
                ])
            );
        }
        remove_native_host_manifests_in(directory.path()).expect("remove");
    }

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
            "title": "Example",
            "url": "https://example.test/",
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
                "profileLabel": "example.test",
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
        assert_eq!(
            server.inventory().snapshot().devices,
            Vec::<opengeni_agent_proto::v1::AttachedBrowserDeviceAnnouncement>::new()
        );
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
        assert_eq!(
            server.inventory().snapshot().devices,
            Vec::<opengeni_agent_proto::v1::AttachedBrowserDeviceAnnouncement>::new()
        );
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)] // authenticated transport, cancellation, late result, and new-work refusal
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

        // The actual extension still owns a command after its caller stops
        // waiting. New routed work is refused without erasing that obligation.
        let inventory = server.inventory();
        let drain = inventory.update_drain.clone();
        let late_id = "33333333-3333-4333-8333-333333333333";
        let reservation = drain.reserve_work(None).unwrap();
        let waiter = tokio::spawn(opengeni_agent_platform::with_work_reservation(
            Some(reservation),
            async move {
                inventory
                    .request(late_id, device_id, generation, json!({"type":"ping"}))
                    .await
            },
        ));
        let late_command = read_json(&mut extension).await;
        assert_eq!(late_command["requestId"], late_id);
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        assert_eq!(
            drain.reserve_update("other-link-update"),
            crate::uploads::update_drain::UpdateReservation::Started
        );
        assert!(!drain.seal_update("other-link-update"));
        let refused_id = "44444444-4444-4444-8444-444444444444";
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type":"request", "protocolVersion":1, "requestId":refused_id, "deviceId":device_id,
                "expectedConnectionGeneration":generation, "payload":{"type":"ping"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let refused = read_json(&mut controller).await;
        assert_eq!(refused["requestId"], refused_id);
        assert_eq!(refused["error"]["code"], "update_draining");
        assert_eq!(drain.snapshot().unwrap().routed, 1);

        // An event poll behind the same fence is still served and is not
        // counted as work that holds the update back.
        let poll_id = "55555555-5555-4555-8555-555555555555";
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type":"request", "protocolVersion":1, "requestId":poll_id, "deviceId":device_id,
                "expectedConnectionGeneration":generation,
                "payload":{"type":"debugger.poll", "afterSequence":0, "limit":100}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let poll_command = read_json(&mut extension).await;
        assert_eq!(poll_command["requestId"], poll_id);
        assert_eq!(poll_command["payload"]["type"], "debugger.poll");
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        write_native_frame(
            &mut extension,
            &serde_json::to_vec(&json!({
                "type":"command_result", "requestId":poll_id, "deviceId":device_id,
                "connectionGeneration":generation, "ok":true,
                "payload":{"events":[], "cursor":0, "truncated":false}, "error":null
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let polled = read_json(&mut controller).await;
        assert_eq!(polled["requestId"], poll_id);
        assert_eq!(polled["ok"], true);
        assert_eq!(drain.snapshot().unwrap().routed, 1);

        write_native_frame(
            &mut extension,
            &serde_json::to_vec(&json!({
                "type":"command_result", "requestId":late_id, "deviceId":device_id,
                "connectionGeneration":generation, "ok":true, "payload":{"pong":true}, "error":null
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while drain.snapshot().unwrap().routed != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(drain.seal_update("other-link-update"));
        drain.release_update("other-link-update");

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

    // The manifest tests pass a temporary browser data directory directly. Going
    // through the public functions would resolve `$XDG_CONFIG_HOME`, which CI
    // runners and many desktops set, so parallel tests would share, and remove,
    // the real user's manifests.
    #[test]
    fn installs_a_pinned_origin_manifest_and_removes_it_cleanly() {
        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("opengeni-agent");
        std::fs::write(&binary, b"fixture").expect("binary");
        let manifests =
            install_native_host_manifests_in(&binary, directory.path(), &[]).expect("install");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_ne!(manifests, Vec::<std::path::PathBuf>::new());
        for path in &manifests {
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).expect("manifest")).expect("json");
            assert_eq!(manifest["name"], NATIVE_HOST_NAME);
            assert_eq!(manifest["path"], binary.to_str().expect("path"));
            assert_eq!(manifest["allowed_origins"][0], extension_origin());
            assert_eq!(manifest["allowed_origins"], json!(extension_origins(&[])));
        }
        remove_native_host_manifests_in(directory.path()).expect("remove");
        assert!(manifests.iter().all(|path| !path.exists()));
    }

    #[test]
    fn removes_only_the_manifests_that_point_at_this_agent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let other = directory.path().join("other-agent");
        let this = directory.path().join("this-agent");
        std::fs::write(&other, b"fixture").expect("other binary");
        let manifests =
            install_native_host_manifests_in(&other, directory.path(), &[]).expect("install");
        assert_eq!(
            remove_native_host_manifests_for_in(&this, directory.path()).expect("keep"),
            Vec::<std::path::PathBuf>::new()
        );
        assert!(manifests.iter().all(|path| path.exists()));
        install_native_host_manifests_in(&this, directory.path(), &[]).expect("overwrite");
        assert_eq!(
            remove_native_host_manifests_for_in(&this, directory.path()).expect("remove"),
            manifests
        );
        assert!(manifests.iter().all(|path| !path.exists()));
    }

    #[test]
    fn removes_a_leftover_manifest_from_before_this_agent_was_renamed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let install = directory.path().join("install");
        std::fs::create_dir_all(&install).expect("install dir");
        let old_name = install.join("old-agent");
        let this = install.join("This Agent");
        let manifests =
            install_native_host_manifests_in(&old_name, directory.path(), &[]).expect("install");
        assert_eq!(
            remove_native_host_manifests_for_in(&this, directory.path()).expect("remove"),
            manifests
        );
        assert!(manifests.iter().all(|path| !path.exists()));
    }

    /// An in-memory `HKEY_CURRENT_USER`: key path to its default value (`None`
    /// for a key without one).
    #[derive(Default)]
    struct FakeRegistry(std::sync::Mutex<std::collections::BTreeMap<String, Option<String>>>);

    impl FakeRegistry {
        fn with_keys(keys: &[&str]) -> Self {
            let registry = Self::default();
            for key in keys {
                registry
                    .0
                    .lock()
                    .expect("registry")
                    .insert((*key).to_string(), None);
            }
            registry
        }
        fn value(&self, key: &str) -> Option<String> {
            self.0.lock().expect("registry").get(key).cloned().flatten()
        }
    }

    impl NativeHostRegistry for FakeRegistry {
        fn key_exists(&self, key: &str) -> std::io::Result<bool> {
            Ok(self.0.lock().expect("registry").contains_key(key))
        }
        fn default_value(&self, key: &str) -> std::io::Result<Option<String>> {
            Ok(self.value(key))
        }
        fn set_default_value(&self, key: &str, value: &str) -> std::io::Result<()> {
            self.0
                .lock()
                .expect("registry")
                .insert(key.to_string(), Some(value.to_string()));
            Ok(())
        }
        fn delete_key(&self, key: &str) -> std::io::Result<()> {
            self.0.lock().expect("registry").remove(key);
            Ok(())
        }
    }

    const CHROME_HOST_KEY: &str =
        r"Software\Google\Chrome\NativeMessagingHosts\ai.opengeni.browser";
    const EDGE_HOST_KEY: &str = r"Software\Microsoft\Edge\NativeMessagingHosts\ai.opengeni.browser";
    const BRAVE_HOST_KEY: &str =
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\ai.opengeni.browser";

    #[test]
    fn windows_registers_chrome_and_present_browsers_through_the_registry() {
        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("opengeni-agent.exe");
        std::fs::write(&binary, b"fixture").expect("binary");
        let manifests_dir = directory.path().join("NativeMessagingHosts");
        // Edge is installed; Chrome has never run (its key is absent).
        let registry = FakeRegistry::with_keys(&[r"Software\Microsoft\Edge"]);

        let installed = install_registered_native_host(&binary, &manifests_dir, &[], &registry)
            .expect("install");

        let manifest = manifests_dir.join("ai.opengeni.browser.json");
        assert_eq!(installed, vec![manifest.clone()]);
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).expect("manifest")).expect("json");
        assert_eq!(body["name"], NATIVE_HOST_NAME);
        assert_eq!(body["path"], binary.to_str().expect("path"));
        assert_eq!(body["type"], "stdio");
        assert_eq!(body["allowed_origins"], json!(extension_origins(&[])));
        let named = Some(manifest.to_str().expect("path").to_string());
        assert_eq!(registry.value(CHROME_HOST_KEY), named);
        assert_eq!(registry.value(EDGE_HOST_KEY), named);
        assert!(!registry.key_exists(BRAVE_HOST_KEY).expect("query"));

        remove_registered_native_host(&manifests_dir, &registry).expect("remove");
        assert!(!manifest.exists());
        assert!(!registry.key_exists(CHROME_HOST_KEY).expect("query"));
        assert!(!registry.key_exists(EDGE_HOST_KEY).expect("query"));
        assert!(registry
            .key_exists(r"Software\Microsoft\Edge")
            .expect("query"));
    }

    #[test]
    fn windows_removes_only_its_own_registration() {
        let directory = tempfile::tempdir().expect("tempdir");
        let other = directory.path().join("other").join("opengeni-agent.exe");
        let this = directory.path().join("this").join("opengeni-agent.exe");
        for binary in [&other, &this] {
            std::fs::create_dir_all(binary.parent().expect("parent")).expect("dir");
            std::fs::write(binary, b"fixture").expect("binary");
        }
        let manifests_dir = directory.path().join("NativeMessagingHosts");
        let registry = FakeRegistry::default();
        // Another product's host under the same name stays untouched.
        registry
            .set_default_value(EDGE_HOST_KEY, r"C:\Elsewhere\host.json")
            .expect("seed");

        install_registered_native_host(&other, &manifests_dir, &[], &registry).expect("install");
        assert_eq!(
            remove_registered_native_host_for(&this, &manifests_dir, &registry).expect("keep"),
            Vec::<PathBuf>::new()
        );
        assert!(registry.value(CHROME_HOST_KEY).is_some());

        install_registered_native_host(&this, &manifests_dir, &[], &registry).expect("overwrite");
        let manifest = manifests_dir.join("ai.opengeni.browser.json");
        assert_eq!(
            remove_registered_native_host_for(&this, &manifests_dir, &registry).expect("remove"),
            vec![manifest.clone()]
        );
        assert!(!manifest.exists());
        assert!(!registry.key_exists(CHROME_HOST_KEY).expect("query"));
        assert_eq!(
            registry.value(EDGE_HOST_KEY).as_deref(),
            Some(r"C:\Elsewhere\host.json")
        );
    }

    #[test]
    fn windows_verbatim_paths_have_an_ordinary_form() {
        assert_eq!(
            ordinary_windows_path(r"\\?\C:\Users\person\AppData\Local\Opengeni\bin\agent.exe")
                .as_deref(),
            Some(r"C:\Users\person\AppData\Local\Opengeni\bin\agent.exe")
        );
        assert_eq!(
            ordinary_windows_path(r"\\?\UNC\server\share\agent.exe").as_deref(),
            Some(r"\\server\share\agent.exe")
        );
        assert_eq!(ordinary_windows_path(r"C:\bin\agent.exe"), None);
        assert_eq!(ordinary_windows_path(r"\\server\share\agent.exe"), None);
        assert_eq!(ordinary_windows_path(r"\\?\Volume{0}\agent.exe"), None);
    }

    /// Chrome starts the host through `cmd.exe`, which cannot run a verbatim
    /// path, so a manifest written from the canonical binary path names the
    /// ordinary form, and still counts as this agent's when removing it.
    #[cfg(windows)]
    #[test]
    fn windows_manifest_names_a_program_cmd_can_start() {
        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("opengeni-agent.exe");
        std::fs::write(&binary, b"fixture").expect("binary");
        let canonical = binary.canonicalize().expect("canonical");
        assert!(canonical.to_str().expect("path").starts_with(r"\\?\"));
        let manifests_dir = directory.path().join("NativeMessagingHosts");
        let registry = FakeRegistry::default();

        install_registered_native_host(&canonical, &manifests_dir, &[], &registry)
            .expect("install");

        let manifest = manifests_dir.join("ai.opengeni.browser.json");
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).expect("manifest")).expect("json");
        let named = body["path"].as_str().expect("path");
        assert!(!named.starts_with(r"\\?\"), "{named}");
        assert_eq!(Path::new(named).canonicalize().expect("named"), canonical);
        assert_eq!(
            remove_registered_native_host_for(&canonical, &manifests_dir, &registry)
                .expect("remove"),
            vec![manifest]
        );
    }

    fn authentication(token: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "authenticate",
            "protocolVersion": 1,
            "role": "extension",
            "token": token
        }))
        .expect("auth")
    }

    async fn extension_socket(config_dir: &Path) -> TcpStream {
        let authority = read_authority(&authority_path(config_dir)).expect("authority");
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("connect");
        write_native_frame(&mut socket, &authentication(&authority.token))
            .await
            .expect("write auth");
        socket
    }

    async fn connection_end(server: &BrowserBridgeServer) -> v1::AttachedBrowserConnectionEnd {
        for _ in 0..400 {
            if let Some(end) = server.inventory().snapshot().connection_ends.pop() {
                return end;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the bridge recorded no connection end");
    }

    fn hello_with(
        device_id: &str,
        generation: &str,
        edit: impl FnOnce(&mut serde_json::Value),
    ) -> Vec<u8> {
        let mut value: serde_json::Value =
            serde_json::from_slice(&hello(device_id, generation, 1)).expect("hello");
        edit(&mut value);
        serde_json::to_vec(&value).expect("hello")
    }

    async fn wait_until_no_routed_work(drain: &crate::uploads::update_drain::UpdateDrain) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while drain.snapshot().unwrap().routed != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the ended port's command no longer holds work");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_command_on_an_ended_port_does_not_hold_self_updates() {
        use super::test_support::connect_extension;
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let inventory = server.inventory();
        let drain = inventory.update_drain.clone();

        // A command whose caller stopped waiting (a timeout) is still owned by
        // the extension while its port lives.
        let mut first = connect_extension(directory.path(), device_id, "connection-1", None).await;
        let sent = |request_id: &'static str, generation: &'static str| {
            let inventory = inventory.clone();
            let reservation = drain.reserve_work(None).unwrap();
            tokio::spawn(opengeni_agent_platform::with_work_reservation(
                Some(reservation),
                async move {
                    inventory
                        .request(request_id, device_id, generation, json!({"type":"ping"}))
                        .await
                },
            ))
        };
        let waiter = sent("22222222-2222-4222-8222-222222222222", "connection-1");
        assert_eq!(read_json(&mut first).await["type"], "command");
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(drain.snapshot().unwrap().routed, 1);

        // The profile reconnects on a new port: the old port's result can
        // never arrive, so its command must stop holding updates.
        let mut second = connect_extension(directory.path(), device_id, "connection-2", None).await;
        wait_until_no_routed_work(&drain).await;

        // The same when the live port closes with a command outstanding.
        let waiter = sent("33333333-3333-4333-8333-333333333333", "connection-2");
        assert_eq!(read_json(&mut second).await["type"], "command");
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        drop(second);
        wait_until_no_routed_work(&drain).await;
        assert_eq!(
            drain.reserve_update("update"),
            crate::uploads::update_drain::UpdateReservation::Started
        );
        assert!(drain.seal_update("update"));
        drain.release_update("update");

        drop(first);
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_native_host_reports_when_chrome_closes_its_port() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let authority = read_authority(&authority_path(directory.path())).expect("authority");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let mut chrome_output = Vec::new();
        write_native_frame_sync(&mut chrome_output, &hello(device_id, "connection-1", 1))
            .expect("hello");
        let relay = std::thread::spawn(move || {
            let mut socket =
                std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
                    .expect("connect");
            write_native_frame_sync(&mut socket, &authentication(&authority.token)).expect("auth");
            // Chrome sends the hello, then closes the port (EOF).
            relay_native_host(socket, Cursor::new(chrome_output), std::io::sink())
        });

        let end = connection_end(&server).await;
        assert_eq!(end.device_id, device_id);
        assert_eq!(end.connection_generation, "connection-1");
        assert_eq!(
            end.reason,
            v1::AttachedBrowserConnectionEndReason::BrowserClosedPort as i32
        );
        assert!(end.ended_at_unix_ms > 0);
        relay.join().expect("relay thread").expect("relay");
        assert_eq!(server.inventory().snapshot().devices.len(), 0);
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn a_native_host_that_vanishes_is_reported_lost() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let mut socket = extension_socket(directory.path()).await;
        write_native_frame(&mut socket, &hello(device_id, "connection-1", 1))
            .await
            .expect("hello");
        for _ in 0..200 {
            if !server.inventory().snapshot().devices.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // No closing report: the host process crashed or was killed.
        drop(socket);

        let end = connection_end(&server).await;
        assert_eq!(end.connection_generation, "connection-1");
        assert_eq!(
            end.reason,
            v1::AttachedBrowserConnectionEndReason::NativeHostLost as i32
        );
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn a_rejected_hello_is_reported_with_the_agents_reason() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let mut socket = extension_socket(directory.path()).await;
        let invalid = hello_with(
            "11111111-1111-4111-8111-111111111111",
            "connection-1",
            |hello| {
                hello["tabs"][0]["unavailableReason"] = json!("contradicts controllable");
            },
        );
        write_native_frame(&mut socket, &invalid)
            .await
            .expect("hello");

        let end = connection_end(&server).await;
        assert_eq!(
            end.reason,
            v1::AttachedBrowserConnectionEndReason::AgentRejected as i32
        );
        assert!(end.detail.contains("unavailable reason"), "{}", end.detail);
        // The extension is told why before the connection closes.
        let refusal = read_json(&mut socket).await;
        assert_eq!(refusal["type"], "unavailable");
        assert_eq!(refusal["reason"], "agent_error");
        assert_eq!(refusal["agentVersion"], env!("CARGO_PKG_VERSION"));
        assert!(
            refusal["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("unavailable reason")),
            "{refusal}"
        );
        assert_eq!(server.inventory().snapshot().devices.len(), 0);
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn a_hello_from_another_bridge_version_says_which_side_is_outdated() {
        for (version, reason) in [(0, "extension_outdated"), (2, "agent_outdated")] {
            let directory = tempfile::tempdir().expect("tempdir");
            let server = BrowserBridgeServer::start(directory.path())
                .await
                .expect("start");
            let mut socket = extension_socket(directory.path()).await;
            let other_version = hello_with(
                "11111111-1111-4111-8111-111111111111",
                "connection-1",
                |hello| {
                    hello["protocolVersion"] = json!(version);
                    // Another version's hello need not parse as this one's.
                    hello.as_object_mut().expect("hello").remove("device");
                },
            );
            write_native_frame(&mut socket, &other_version)
                .await
                .expect("hello");

            let refusal = read_json(&mut socket).await;
            assert_eq!(refusal["type"], "unavailable", "{refusal}");
            assert_eq!(refusal["reason"], reason, "{refusal}");
            assert_eq!(refusal["agentVersion"], env!("CARGO_PKG_VERSION"));
            assert_eq!(server.inventory().snapshot().devices.len(), 0);
            server.shutdown().await.expect("shutdown");
        }
    }

    #[test]
    fn the_native_host_tells_chrome_when_the_agent_closes_without_answering() {
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("address").port();
        let agent = std::thread::spawn(move || drop(listener.accept().expect("accept")));
        let socket =
            std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).expect("connect");
        agent.join().expect("agent thread");

        let mut chrome_input = Vec::new();
        // Ignore the result: a reset connection is as silent as a closed one.
        let _ = relay_native_host(socket, std::io::empty(), &mut chrome_input);

        let frame = read_native_frame_sync_bounded(
            &mut Cursor::new(chrome_input),
            MAX_COMMAND_MESSAGE_BYTES,
        )
        .expect("frame")
        .expect("an unavailable frame for Chrome");
        let refusal: serde_json::Value = serde_json::from_slice(&frame).expect("json");
        assert_eq!(refusal["type"], "unavailable");
        assert_eq!(refusal["reason"], "agent_error");
        // The host is the installed program, not the running agent.
        assert!(refusal.get("agentVersion").is_none(), "{refusal}");
    }

    #[test]
    fn a_hello_version_probe_reads_only_hellos() {
        assert_eq!(
            hello_version_refusal(br#"{"type":"hello","protocolVersion":0}"#),
            Some(AgentUnavailableReason::ExtensionOutdated)
        );
        assert_eq!(
            hello_version_refusal(br#"{"type":"hello","protocolVersion":7,"device":"new shape"}"#),
            Some(AgentUnavailableReason::AgentOutdated)
        );
        assert_eq!(
            hello_version_refusal(&hello("11111111-1111-4111-8111-111111111111", "c", 1)),
            None
        );
        assert_eq!(
            hello_version_refusal(br#"{"type":"native_host_closing","protocolVersion":7}"#),
            None
        );
    }

    #[test]
    fn a_native_host_says_when_no_agent_is_running() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reason, _) = connect_native_host(directory.path()).expect_err("no authority");
        assert_eq!(reason, AgentUnavailableReason::AgentNotRunning);

        // An agent that exited without removing its authority file.
        let port = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("bind")
            .local_addr()
            .expect("address")
            .port();
        let authority = |protocol_version| BridgeAuthority {
            protocol_version,
            port,
            token: "token".to_string(),
            pid: 1,
        };
        write_authority(directory.path(), &authority(BRIDGE_PROTOCOL_VERSION)).expect("write");
        let (reason, _) = connect_native_host(directory.path()).expect_err("stale authority");
        assert_eq!(reason, AgentUnavailableReason::AgentNotRunning);

        // A running agent from before its installed program was updated.
        write_authority(directory.path(), &authority(BRIDGE_PROTOCOL_VERSION - 1)).expect("write");
        let (reason, _) = connect_native_host(directory.path()).expect_err("older agent");
        assert_eq!(reason, AgentUnavailableReason::AgentOutdated);
    }

    #[tokio::test]
    async fn oversized_page_metadata_cannot_disconnect_a_profile() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let mut socket = extension_socket(directory.path()).await;
        let oversized = hello_with(device_id, "connection-1", |hello| {
            hello["tabs"][0]["title"] = json!("é".repeat(5_000));
            hello["tabs"][0]["url"] = json!(format!("https://example.test/{}", "a".repeat(70_000)));
        });
        write_native_frame(&mut socket, &oversized)
            .await
            .expect("hello");
        let ready = read_native_frame(&mut socket)
            .await
            .expect("ready")
            .expect("ready frame");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&ready).expect("ready")["type"],
            "ready"
        );
        let state = server.inventory().state;
        let tab = state.read().expect("state").profiles[device_id].tabs[0].clone();
        assert!(tab.title.len() <= MAX_TAB_TITLE_BYTES);
        assert!(tab.title.chars().all(|character| character == 'é'));
        assert_eq!(tab.url, None);
        assert!(!tab.controllable);
        assert_eq!(tab.unavailable_reason.as_deref(), Some(TAB_URL_TOO_LONG));
        drop(socket);
        server.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn a_newer_extensions_extra_fields_are_ignored() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let mut socket = extension_socket(directory.path()).await;
        let newer = hello_with(
            "11111111-1111-4111-8111-111111111111",
            "connection-1",
            |hello| {
                hello["device"]["previousConnection"] =
                    json!({ "reason": "service_worker_restart" });
                hello["device"]["capabilities"]["futureCapability"] = json!(true);
                hello["tabs"][0]["groupId"] = json!(4);
            },
        );
        write_native_frame(&mut socket, &newer)
            .await
            .expect("hello");
        let ready = read_native_frame(&mut socket)
            .await
            .expect("ready")
            .expect("ready frame");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&ready).expect("ready")["type"],
            "ready"
        );
        assert_eq!(server.inventory().snapshot().devices.len(), 1);
        drop(socket);
        server.shutdown().await.expect("shutdown");
    }

    async fn wait_for_placement(server: &BrowserBridgeServer, expected: Option<&str>) {
        for _ in 0..400 {
            let snapshot = server.inventory().snapshot();
            let current = snapshot
                .devices
                .first()
                .map(|device| device.connection_generation.clone());
            if current.as_deref() == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!(
            "placement never became {expected:?}: {:?}",
            server.inventory().snapshot().devices
        );
    }

    async fn controller_ping(
        controller: &mut TcpStream,
        request_id: &str,
        device_id: &str,
        placement: &str,
    ) {
        write_native_frame(
            controller,
            &serde_json::to_vec(&json!({
                "type": "request",
                "protocolVersion": 1,
                "requestId": request_id,
                "deviceId": device_id,
                "expectedConnectionGeneration": placement,
                "payload": { "type": "ping" }
            }))
            .expect("request"),
        )
        .await
        .expect("write request");
    }

    async fn answer_ping(extension: &mut TcpStream, device_id: &str, transport: &str) -> String {
        let command = read_json(extension).await;
        assert_eq!(command["type"], "command");
        // The extension fences on its exact live port, never on the placement.
        assert_eq!(command["connectionGeneration"], transport);
        let request_id = command["requestId"]
            .as_str()
            .expect("request id")
            .to_string();
        write_native_frame(
            extension,
            &serde_json::to_vec(&json!({
                "type": "command_result",
                "requestId": request_id,
                "deviceId": device_id,
                "connectionGeneration": transport,
                "ok": true,
                "payload": { "pong": true },
                "error": null
            }))
            .expect("result"),
        )
        .await
        .expect("write result");
        request_id
    }

    async fn wait_for_device(
        server: &BrowserBridgeServer,
    ) -> v1::AttachedBrowserDeviceAnnouncement {
        for _ in 0..600 {
            if let Some(device) = server.inventory().snapshot().devices.pop() {
                return device;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("Chromium's extension never connected to the bridge");
    }

    async fn controller_tab_count(config_dir: &Path, device_id: &str, placement: &str) -> usize {
        let authority = read_authority(&authority_path(config_dir)).expect("authority");
        let mut controller = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, authority.port))
            .await
            .expect("controller connect");
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type": "authenticate", "protocolVersion": 1, "role": "controller",
                "token": authority.token
            }))
            .expect("auth"),
        )
        .await
        .expect("auth");
        write_native_frame(
            &mut controller,
            &serde_json::to_vec(&json!({
                "type": "request", "protocolVersion": 1,
                "requestId": uuid::Uuid::new_v4().to_string(), "deviceId": device_id,
                "expectedConnectionGeneration": placement, "payload": { "type": "tabs.list" }
            }))
            .expect("request"),
        )
        .await
        .expect("request");
        let frame =
            tokio::time::timeout(Duration::from_secs(10), read_native_frame(&mut controller))
                .await
                .expect("controller response timeout")
                .expect("controller response")
                .expect("controller frame");
        let response: serde_json::Value = serde_json::from_slice(&frame).expect("response");
        assert_eq!(response["ok"], true, "{response}");
        response["payload"]["tabs"].as_array().expect("tabs").len()
    }

    struct RealChromium {
        root: tempfile::TempDir,
        config_dir: PathBuf,
        process: tokio::process::Child,
    }

    /// Real Chromium with the unpacked extension, and this agent binary
    /// installed as its native messaging host.
    fn launch_real_chromium() -> RealChromium {
        let binary = std::env::var("OPENGENI_REAL_CHROME_AGENT_BINARY").expect("agent binary");
        let extension = std::env::var("OPENGENI_REAL_CHROME_EXTENSION").expect("extension");
        let root = tempfile::tempdir().expect("tempdir");
        let config_dir = root.path().join("agent");
        let xdg = root.path().join("config");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        std::fs::create_dir_all(xdg.join("chromium")).expect("xdg");
        // These ignored tests run alone; the variable only steers where the
        // manifest installer writes.
        std::env::set_var("XDG_CONFIG_HOME", &xdg);
        install_native_host_manifests(Path::new(&binary), root.path(), &[]).expect("manifest");
        let process = tokio::process::Command::new(
            std::env::var("CHROMIUM").unwrap_or_else(|_| "chromium".to_string()),
        )
        // Chromium reads user-level native-host manifests from its user-data
        // directory; the installer writes the default one.
        .arg(format!(
            "--user-data-dir={}",
            xdg.join("chromium").display()
        ))
        .arg(format!("--load-extension={extension}"))
        // Chromium 137+ ignores --load-extension unless this is disabled.
        .arg("--disable-features=DisableLoadExtensionCommandLineSwitch")
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
        ])
        .arg("data:text/html,<title>user page</title>")
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", &xdg)
        .env("OPENGENI_CONFIG_DIR", &config_dir)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("chromium");
        RealChromium {
            root,
            config_dir,
            process,
        }
    }

    /// Real Chromium + the unpacked extension + this agent binary as its native
    /// host. The bridge is restarted, as an agent restart or update does, and
    /// the profile must keep its placement so live sessions stay bound.
    ///
    /// OPENGENI_REAL_CHROME_AGENT_BINARY=<built opengeni-agent>
    /// OPENGENI_REAL_CHROME_EXTENSION=<apps/browser-extension/dist> DISPLAY=:N
    /// cargo test ... attached_chrome_keeps_its_placement_across_a_bridge_restart -- --ignored
    #[tokio::test]
    #[ignore = "needs Chromium, a display, a built agent binary and the unpacked extension"]
    async fn attached_chrome_keeps_its_placement_across_a_bridge_restart() {
        let RealChromium {
            root: _root,
            config_dir,
            process: mut chromium,
        } = launch_real_chromium();
        let server = BrowserBridgeServer::start(&config_dir)
            .await
            .expect("bridge");

        let before = wait_for_device(&server).await;
        let tabs =
            controller_tab_count(&config_dir, &before.id, &before.connection_generation).await;
        assert!(tabs >= 1);

        // Agent restart: the listener, its token and every native host go away;
        // the extension reconnects to the successor's bridge on its own.
        server.shutdown().await.expect("shutdown");
        let server = BrowserBridgeServer::start(&config_dir)
            .await
            .expect("successor bridge");
        let after = wait_for_device(&server).await;
        assert_eq!(after.id, before.id);
        assert_eq!(
            after.connection_generation, before.connection_generation,
            "the restart must not move the profile to a new placement"
        );
        // A re-created controller still drives the same live profile.
        assert_eq!(
            controller_tab_count(&config_dir, &before.id, &before.connection_generation).await,
            tabs
        );
        let _ = chromium.kill().await;
        server.shutdown().await.expect("shutdown");
    }

    /// Browserd refuses pages Chrome will not let the extension control,
    /// without leaving tabs behind, against real Chromium, the real extension,
    /// this agent binary as native host and this bridge.
    ///
    /// As above, plus OPENGENI_REAL_BROWSERD_PACKAGE=<packages/browserd>
    /// cargo test ... attached_chrome_refuses_restricted_pages -- --ignored
    #[tokio::test]
    #[ignore = "needs Chromium, a display, bun, a built agent binary and the unpacked extension"]
    async fn attached_chrome_refuses_restricted_pages() {
        let package = std::env::var("OPENGENI_REAL_BROWSERD_PACKAGE").expect("browserd package");
        let RealChromium {
            root: _root,
            config_dir,
            process: mut chromium,
        } = launch_real_chromium();
        let server = BrowserBridgeServer::start(&config_dir)
            .await
            .expect("bridge");
        let device = wait_for_device(&server).await;
        let status = tokio::process::Command::new("bun")
            .args([
                "test",
                "test/attached-chrome.e2e.test.ts",
                "--test-name-pattern",
                "refuses pages Chrome will not let the extension control",
            ])
            .current_dir(package)
            .env("OPENGENI_ATTACHED_CHROME_E2E", "1")
            .env("OPENGENI_ATTACHED_BROWSER_DEVICE_ID", &device.id)
            .env(
                "OPENGENI_ATTACHED_BROWSER_CONNECTION_GENERATION",
                &device.connection_generation,
            )
            .env("OPENGENI_CONFIG_DIR", &config_dir)
            .status()
            .await
            .expect("bun test");
        let _ = chromium.kill().await;
        server.shutdown().await.expect("shutdown");
        assert!(status.success(), "browserd's restricted-page suite failed");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)] // One reconnect story, read top to bottom.
    async fn a_reconnected_extension_keeps_its_placement_for_live_controllers() {
        let directory = tempfile::tempdir().expect("tempdir");
        let server = BrowserBridgeServer::start(directory.path())
            .await
            .expect("start");
        let authority = read_authority(&authority_path(directory.path())).expect("authority");
        let device_id = "11111111-1111-4111-8111-111111111111";
        let with_state = |state: &'static str| {
            move |hello: &mut serde_json::Value| {
                hello["device"]["stateGeneration"] = json!(state);
            }
        };

        let mut first = extension_socket(directory.path()).await;
        write_native_frame(
            &mut first,
            &hello_with(device_id, "connection-1", with_state("state-1")),
        )
        .await
        .expect("hello");
        assert_eq!(
            read_json(&mut first).await["connectionGeneration"],
            "connection-1"
        );
        wait_for_placement(&server, Some("state-1")).await;
        assert!(!server.inventory().placement_ends_on_reconnect("state-1"));
        assert!(!server
            .inventory()
            .placement_ends_on_reconnect("connection-1"));

        // One long-lived controller, as a browser controller keeps for its
        // whole session.
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
        let first_request = "22222222-2222-4222-8222-222222222222";
        controller_ping(&mut controller, first_request, device_id, "state-1").await;
        assert_eq!(
            answer_ping(&mut first, device_id, "connection-1").await,
            first_request
        );
        let response = read_json(&mut controller).await;
        assert_eq!(response["ok"], true);
        assert_eq!(response["connectionGeneration"], "state-1");

        // The native host goes away (agent or host restart, port reconnect)
        // while Chrome and the extension's worker stay alive.
        drop(first);
        wait_for_placement(&server, None).await;
        let mut second = extension_socket(directory.path()).await;
        write_native_frame(
            &mut second,
            &hello_with(device_id, "connection-2", with_state("state-1")),
        )
        .await
        .expect("hello");
        assert_eq!(
            read_json(&mut second).await["connectionGeneration"],
            "connection-2"
        );
        wait_for_placement(&server, Some("state-1")).await;

        let second_request = "33333333-3333-4333-8333-333333333333";
        controller_ping(&mut controller, second_request, device_id, "state-1").await;
        assert_eq!(
            answer_ping(&mut second, device_id, "connection-2").await,
            second_request
        );
        let response = read_json(&mut controller).await;
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["connectionGeneration"], "state-1");

        // A restarted worker lost its live state: that is a new placement and
        // the old one is fenced.
        drop(second);
        wait_for_placement(&server, None).await;
        let mut third = extension_socket(directory.path()).await;
        write_native_frame(
            &mut third,
            &hello_with(device_id, "connection-3", with_state("state-2")),
        )
        .await
        .expect("hello");
        assert_eq!(read_json(&mut third).await["type"], "ready");
        wait_for_placement(&server, Some("state-2")).await;
        controller_ping(
            &mut controller,
            "44444444-4444-4444-8444-444444444444",
            device_id,
            "state-1",
        )
        .await;
        let response = read_json(&mut controller).await;
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "fenced");

        // An older extension's placement is its port: a restart would end it.
        let mut legacy = extension_socket(directory.path()).await;
        write_native_frame(
            &mut legacy,
            &hello("55555555-5555-4555-8555-555555555555", "legacy-1", 1),
        )
        .await
        .expect("legacy hello");
        assert_eq!(read_json(&mut legacy).await["type"], "ready");
        for _ in 0..400 {
            if server.inventory().snapshot().devices.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(server.inventory().placement_ends_on_reconnect("legacy-1"));
        assert!(!server.inventory().placement_ends_on_reconnect("state-2"));

        drop((third, legacy, controller));
        server.shutdown().await.expect("shutdown");
    }
}
