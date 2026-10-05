//! Linux-specific platform bits.
//!
//! exec/fs/git themselves are portable and live in [`crate::native`]; this module
//! holds the genuinely Linux-specific pieces folded into the cross-platform
//! [`NativePlatform`](crate::NativePlatform): reporting the OS family, building a
//! shell command via the user's `$SHELL` (falling back to `/bin/sh`), and the
//! **X11 desktop backend** ([`LinuxDesktop`]) that powers screen capture +
//! computer-use input for the M8 desktop stream.
//!
//! # Desktop: X11 via the safe [`x11rb`] binding (no `unsafe`)
//!
//! The workspace forbids `unsafe_code`. [`LinuxDesktop`] therefore uses
//! [`x11rb`] — a pure-Rust, memory-safe X11 client — for everything:
//!
//! * **Capture**: `GetImage` on the root window (ZPixmap), converted to PNG.
//! * **Geometry**: the `RANDR` extension reports the real screen size; we fall
//!   back to the root window geometry when RANDR is absent (common under Xvfb).
//! * **Input**: the `XTEST` extension (`FakeInput`) synthesizes pointer motion,
//!   button press/release, key press/release, and scroll (buttons 4/5) — the same
//!   mechanism `xdotool` drives, but in-process and safe.
//!
//! A headless box opts into a desktop by spawning Xvfb (see
//! [`crate::virtual_desktop`]) and pointing `$DISPLAY` at it; [`LinuxDesktop`]
//! then connects exactly as it would to a real `:0`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux,
    EventMask, ImageFormat, InputFocus, MapState, PropMode, Screen, StackMode, Window, WindowClass,
};
use x11rb::wrapper::ConnectionExt as _;

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

#[path = "linux_input_route.rs"]
mod input_route;

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Linux
}

/// Builds a command that runs `parts` through the user's POSIX shell.
///
/// The joined command is passed to `sh -c` (or `$SHELL -c`). We intentionally do
/// NOT re-quote the parts: when the caller sets `shell = true` they have opted
/// into shell interpretation of the joined string, mirroring how a terminal
/// `sh -c "<line>"` behaves.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(parts.join(" "));
    cmd
}

// =============================================================================
// X11 desktop backend (capture + computer-use input via the safe x11rb binding)
// =============================================================================

/// An X11 desktop backend: screen capture + synthetic input over a connection to
/// the display named by `$DISPLAY` (a real screen or an Xvfb virtual framebuffer).
///
/// All X11 access goes through [`x11rb`] (safe, pure-Rust), so this backend needs
/// no `unsafe`. The connection is opened per operation rather than held, because
/// the backend lives behind an `Arc<dyn DesktopBackend>` shared across the capture
/// pump and the input handler, and an `x11rb` connection is not `Sync` for
/// concurrent request issue; opening per-call keeps the backend trivially
/// shareable and each capture/inject self-contained. Capture is ~30ms on a typical
/// screen, well within the framebuffer pump's frame budget.
#[derive(Debug, Clone)]
pub struct LinuxDesktop {
    /// The `$DISPLAY` value to connect to (e.g. `":0"`, `":99"`).
    display_name: String,
    composite: Option<Arc<Mutex<CompositeState>>>,
}

/// One unencoded X11 capture. Computer live-view encoding consumes this
/// directly so a frame is never PNG-encoded only to be decoded and encoded as
/// JPEG again. The ordinary desktop relay continues to use [`CapturedFrame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxRgbaFrame {
    /// Tightly packed RGBA8 pixels.
    pub rgba: Vec<u8>,
    /// Capture width in pixels.
    pub width: u32,
    /// Capture height in pixels.
    pub height: u32,
}

#[derive(Debug)]
struct CompositeState {
    connection: x11rb::rust_connection::RustConnection,
    redirected: BTreeSet<Window>,
}

const MAX_CLIENT_WINDOWS: u32 = 4_096;
const MAX_WINDOW_TITLE_LONGS: u32 = 4_096;

/// One X11 top-level client window discovered on the desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxWindow {
    /// X11 window id; meaningful only on this display generation.
    pub id: u32,
    /// `_NET_WM_PID` when the client publishes it.
    pub process_id: Option<u32>,
    /// UTF-8/EWMH title, with the legacy WM name as fallback.
    pub title: String,
    /// Root-relative logical pixel bounds.
    pub bounds: LinuxWindowRect,
}

/// Root-relative X11 window rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxWindowRect {
    /// Left edge.
    pub x: i32,
    /// Top edge.
    pub y: i32,
    /// Width.
    pub width: u32,
    /// Height.
    pub height: u32,
}

/// A confirmed activation on this exact display and client identity.
#[derive(Debug, Clone)]
pub struct LinuxWindowActivation {
    display_name: String,
    window: LinuxWindow,
    route: WindowActivationRoute,
}

/// Preserves whether a rejected activation crossed the focus side-effect boundary.
#[derive(Debug)]
pub struct LinuxWindowActivationError {
    /// Exact platform failure, before or after dispatch.
    pub error: PlatformError,
    /// True once activation may have been delivered; callers must not blindly retry.
    pub dispatched: bool,
}

impl LinuxWindowActivationError {
    fn before(error: PlatformError) -> Self {
        Self {
            error,
            dispatched: false,
        }
    }

    fn after(error: PlatformError) -> Self {
        Self {
            error,
            dispatched: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowActivationRoute {
    Managed {
        check_window: Window,
        active_atom: Atom,
        selection_owner: Window,
    },
    Unmanaged,
}

// These are independent server facts, including contradictory states that
// must remain representable so activation can reject them.
#[allow(clippy::struct_excessive_bools)]
struct WindowManagerFacts {
    check_window: Option<Window>,
    check_confirmed: bool,
    check_named: bool,
    selection_owner: Window,
    redirected: bool,
    manager_hints: bool,
    activation_advertised: bool,
}

fn activation_route(
    facts: &WindowManagerFacts,
    active_atom: Option<Atom>,
) -> PlatformResult<WindowActivationRoute> {
    if let Some(check_window) = facts.check_window {
        if facts.check_confirmed
            && facts.check_named
            && facts.activation_advertised
            && facts.selection_owner != x11rb::NONE
            && facts.redirected
        {
            if let Some(active_atom) = active_atom {
                return Ok(WindowActivationRoute::Managed {
                    check_window,
                    active_atom,
                    selection_owner: facts.selection_owner,
                });
            }
        }
        return Err(PlatformError::Unsupported(
            "window manager does not prove EWMH activation support".into(),
        ));
    }
    if facts.selection_owner == x11rb::NONE && !facts.redirected && !facts.manager_hints {
        return Ok(WindowActivationRoute::Unmanaged);
    }
    Err(PlatformError::Unsupported(
        "window manager activation authority is unavailable".into(),
    ))
}

fn same_activation_window(expected: &LinuxWindow, current: &LinuxWindow) -> bool {
    expected.process_id.is_some()
        && expected.id == current.id
        && expected.process_id == current.process_id
        && expected.bounds == current.bounds
}

fn active_window_from_property(
    property_type: Atom,
    format: u8,
    bytes_after: u32,
    values: &[Window],
) -> Option<Window> {
    // Some managers append an update timestamp to the scalar client ID. It
    // carries no window authority; input focus must still belong to the exact
    // first client. Bound the known scalar/one-timestamp representation.
    if property_type != u32::from(AtomEnum::WINDOW)
        || format != 32
        || bytes_after != 0
        || !(1..=2).contains(&values.len())
    {
        return None;
    }
    Some(values[0])
}

fn focus_descends_from(
    mut focus: Window,
    client: Window,
    mut parent: impl FnMut(Window) -> Option<Window>,
) -> bool {
    let mut visited = BTreeSet::new();
    for _ in 0..32 {
        if focus == x11rb::NONE || focus == 1 || !visited.insert(focus) {
            return false;
        }
        if focus == client {
            return true;
        }
        let Some(next) = parent(focus) else {
            return false;
        };
        focus = next;
    }
    false
}

impl LinuxDesktop {
    /// Opens the backend against `$DISPLAY` (or `:0` if unset), verifying a
    /// connection can actually be established and the `XTEST` extension is present.
    ///
    /// # Errors
    ///
    /// Returns a human-readable reason string when no display is reachable (the
    /// caller maps this to `display_unavailable` — a value, never a crash).
    pub fn open_default() -> Result<Self, String> {
        let display_name = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
        if display_name.is_empty() {
            return Err("$DISPLAY is empty".to_string());
        }
        // Probe a real connection so a stale/dead $DISPLAY does not falsely report
        // a desktop. Drop it immediately; subsequent ops reconnect.
        let (conn, _screen) = x11rb::connect(Some(&display_name))
            .map_err(|e| format!("cannot connect to X display {display_name}: {e}"))?;
        // XTEST is required for computer-use input; capture works without it, but a
        // desktop we cannot drive is not the desktop capability we advertise.
        conn.extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)
            .map_err(|e| format!("XTEST query failed: {e}"))?
            .ok_or_else(|| "XTEST extension is not available on this display".to_string())?;
        let composite = conn
            .extension_information(x11rb::protocol::composite::X11_EXTENSION_NAME)
            .map_err(|error| format!("XComposite query failed: {error}"))?
            .map(|_| {
                Arc::new(Mutex::new(CompositeState {
                    connection: conn,
                    redirected: BTreeSet::new(),
                }))
            });
        let desktop = Self {
            display_name,
            composite,
        };
        // Establish backing storage for already-mapped windows before anything
        // can occlude them. Enumeration remains best-effort here; AT-SPI/screen
        // control still works when a hostile window races startup.
        let _ = desktop.windows_blocking();
        Ok(desktop)
    }

    /// Enumerates current EWMH client windows, with a root-tree fallback for
    /// minimal Xvfb seats that have no window manager.
    ///
    /// # Errors
    ///
    /// Returns a typed platform failure when the display cannot be queried.
    pub async fn windows(&self) -> PlatformResult<Vec<LinuxWindow>> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.windows_blocking())
            .await
            .map_err(|error| PlatformError::os(format!("X11 window-list task join: {error}")))?
    }

    /// Captures one exact X11 client window from its Composite backing pixmap,
    /// including when another window occludes it.
    ///
    /// # Errors
    ///
    /// Returns a typed platform failure if the window disappeared, Composite is
    /// unavailable, or the backing pixmap cannot be read.
    pub async fn capture_window(&self, window_id: u32) -> PlatformResult<CapturedFrame> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.capture_window_blocking(window_id))
            .await
            .map_err(|error| PlatformError::os(format!("X11 window capture task join: {error}")))?
    }

    /// Captures the complete screen as tightly packed RGBA8 without an
    /// intermediate image encode. Intended for a placement-local live encoder.
    ///
    /// # Errors
    ///
    /// Returns a typed platform failure when the display cannot be queried or
    /// the X11 capture task cannot complete.
    pub async fn capture_rgba(&self) -> PlatformResult<LinuxRgbaFrame> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.capture_rgba_blocking())
            .await
            .map_err(|error| PlatformError::os(format!("X11 RGBA capture task join: {error}")))?
    }

    /// Captures one XComposite-backed window as RGBA8, including while it is
    /// occluded, without an intermediate PNG encode.
    ///
    /// # Errors
    ///
    /// Returns a typed platform failure if the window disappeared, Composite
    /// capture fails, or the X11 capture task cannot complete.
    pub async fn capture_window_rgba(&self, window_id: u32) -> PlatformResult<LinuxRgbaFrame> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.capture_window_rgba_blocking(window_id))
            .await
            .map_err(|error| {
                PlatformError::os(format!("X11 window RGBA capture task join: {error}"))
            })?
    }

    /// Raises one exact client window and injects a bounded input batch against
    /// the root-relative geometry that was correlated before dispatch.
    ///
    /// # Errors
    ///
    /// Returns a typed failure when the window moved/disappeared or XTEST did
    /// not accept the batch. The geometry check and input share one X connection.
    pub async fn inject_window(
        &self,
        window_id: u32,
        expected_bounds: LinuxWindowRect,
        inputs: Vec<v1::DesktopInput>,
    ) -> PlatformResult<()> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || {
            this.inject_window_blocking(window_id, expected_bounds, &inputs)
        })
        .await
        .map_err(|error| PlatformError::os(format!("X11 window input task join: {error}")))?
    }

    /// Gives keyboard focus to one exact client window without changing its
    /// stacking order. Semantic accessibility focus is scoped to the focused
    /// X11 client; AT-SPI alone may report success while Chromium immediately
    /// discards element focus when its client is not the keyboard focus owner.
    ///
    /// # Errors
    ///
    /// Returns a typed failure when the correlated window disappeared, moved,
    /// resized, or rejected X11 keyboard focus before semantic dispatch.
    pub async fn focus_window(
        &self,
        window_id: u32,
        expected_bounds: LinuxWindowRect,
    ) -> PlatformResult<()> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || {
            this.focus_window_blocking(window_id, expected_bounds)
        })
        .await
        .map_err(|error| PlatformError::os(format!("X11 window focus task join: {error}")))?
    }

    /// Activates an exact observed client through its proven window manager,
    /// or through input focus only on a positively unmanaged display.
    ///
    /// # Errors
    ///
    /// Identity/geometry or unsupported manager failures refuse before input.
    /// Failed settlement after the one activation request preserves uncertainty.
    pub async fn activate_window(
        &self,
        expected: LinuxWindow,
    ) -> Result<LinuxWindowActivation, LinuxWindowActivationError> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.activate_window_blocking(expected))
            .await
            .map_err(|error| {
                LinuxWindowActivationError::after(PlatformError::os(format!(
                    "X11 window activation task join: {error}"
                )))
            })?
    }

    /// Rechecks one prior activation on the same display without posting input.
    ///
    /// # Errors
    ///
    /// Rejects changed identity, manager or active/input-focus ownership.
    pub async fn verify_window_activation(
        &self,
        activation: LinuxWindowActivation,
    ) -> PlatformResult<()> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || {
            if this.display_name != activation.display_name {
                return Err(PlatformError::NotFound(
                    "window activation belongs to another display".into(),
                ));
            }
            let (conn, screen) = this.connect()?;
            verify_activation_state(&conn, &screen, &activation.window, activation.route)
        })
        .await
        .map_err(|error| {
            PlatformError::os(format!("X11 window activation verification join: {error}"))
        })?
    }

    /// Reads exact client identity and current keyboard ownership without
    /// requesting activation or replacing the caller's window authority.
    ///
    /// # Errors
    /// Refuses a changed client, manager, geometry, or focus owner before input.
    pub async fn current_window_activation(
        &self,
        expected: LinuxWindow,
    ) -> PlatformResult<LinuxWindowActivation> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || {
            let (conn, screen) = this.connect()?;
            let route = read_activation_route(&conn, &screen)?;
            verify_activation_state(&conn, &screen, &expected, route)?;
            Ok(LinuxWindowActivation {
                display_name: this.display_name.clone(),
                window: expected,
                route,
            })
        })
        .await
        .map_err(|error| {
            PlatformError::os(format!("X11 exact window ownership task join: {error}"))
        })?
    }

    /// Delivers a bounded batch only while the original activated client still
    /// owns focus. Identity and ownership checks share the delivery connection.
    ///
    /// # Errors
    /// Refuses changed ownership before delivery; failures after input retain
    /// an ambiguous outcome and must never be blindly replayed.
    pub async fn inject_activated_window(
        &self,
        activation: LinuxWindowActivation,
        inputs: Vec<v1::DesktopInput>,
    ) -> Result<(), LinuxWindowActivationError> {
        let this = self.clone();
        crate::spawn_blocking_reserved(move || {
            if this.display_name != activation.display_name {
                return Err(LinuxWindowActivationError::before(PlatformError::NotFound(
                    "window input belongs to another display".into(),
                )));
            }
            input_route::validate_input_size(&inputs)
                .map_err(LinuxWindowActivationError::before)?;
            let (conn, screen) = this.connect().map_err(LinuxWindowActivationError::before)?;
            // The fresh delivery connection owns every temporary grab. Closing
            // its socket on a hard deadline releases them even if an X reply
            // stops arriving; an async timeout alone cannot stop blocking I/O.
            let deadline = input_route::DeliveryDeadline::start(&conn)
                .map_err(LinuxWindowActivationError::before)?;
            let guard =
                X11ServerGuard::acquire(&conn).map_err(LinuxWindowActivationError::before)?;
            let prepared =
                prepare_inputs(&conn, &inputs).map_err(LinuxWindowActivationError::before)?;
            verify_activation_state(&conn, &screen, &activation.window, activation.route)
                .map_err(LinuxWindowActivationError::before)?;
            verify_window_input_owners(&conn, screen.root, activation.window.id, &prepared)
                .map_err(LinuxWindowActivationError::before)?;
            let routing =
                input_route::preflight(&conn, screen.root, activation.window.id, &prepared)
                    .map_err(LinuxWindowActivationError::before)?;
            // A grab probe can emit focus/crossing notifications. Check the
            // original authority again with only the empty XI1 slave keeper
            // retained. The master route remains owned by the original client.
            verify_activation_state(&conn, &screen, &activation.window, activation.route)
                .map_err(LinuxWindowActivationError::before)?;
            verify_window_input_owners(&conn, screen.root, activation.window.id, &prepared)
                .map_err(LinuxWindowActivationError::before)?;
            inject_prepared_inputs(&conn, screen.root, &prepared)
                .map_err(LinuxWindowActivationError::after)?;
            verify_activation_state(&conn, &screen, &activation.window, activation.route)
                .map_err(LinuxWindowActivationError::after)?;
            verify_window_input_owners(&conn, screen.root, activation.window.id, &prepared)
                .map_err(LinuxWindowActivationError::after)?;
            routing
                .verify(&conn, screen.root)
                .map_err(LinuxWindowActivationError::after)?;
            routing
                .release(&conn)
                .map_err(LinuxWindowActivationError::after)?;
            guard.release().map_err(LinuxWindowActivationError::after)?;
            deadline.finish().map_err(LinuxWindowActivationError::after)
        })
        .await
        .map_err(|error| {
            LinuxWindowActivationError::after(PlatformError::os(format!(
                "X11 exact window delivery task join: {error}"
            )))
        })?
    }

    /// Whether the connected display exposes the Composite extension required
    /// for occlusion-independent client-window capture.
    #[must_use]
    pub fn supports_window_capture(&self) -> bool {
        self.composite.is_some()
    }

    /// Establishes a fresh X11 connection plus the default screen for one op.
    fn connect(&self) -> PlatformResult<(x11rb::rust_connection::RustConnection, Screen)> {
        let (conn, screen_num) = x11rb::connect(Some(&self.display_name)).map_err(|e| {
            PlatformError::os(format!("connect X display {}: {e}", self.display_name))
        })?;
        let screen = conn.setup().roots[screen_num].clone();
        Ok((conn, screen))
    }

    fn composite(&self) -> PlatformResult<MutexGuard<'_, CompositeState>> {
        self.composite
            .as_ref()
            .ok_or_else(|| {
                PlatformError::Unsupported("XComposite is unavailable on this display".to_string())
            })?
            .lock()
            .map_err(|_| PlatformError::os("XComposite connection lock was poisoned"))
    }
}

#[async_trait]
impl DesktopBackend for LinuxDesktop {
    fn probe(&self) -> Option<v1::Display> {
        let (conn, screen) = self.connect().ok()?;
        let (width, height) = screen_geometry(&conn, &screen);
        let virtual_fb = is_virtual_display(&self.display_name);
        Some(v1::Display {
            id: self.display_name.clone(),
            width,
            height,
            r#virtual: virtual_fb,
        })
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        // x11rb is blocking; run the capture on the blocking pool so the async
        // runtime is never stalled by a slow GetImage.
        let this = self.clone();
        crate::spawn_blocking_reserved(move || this.capture_blocking())
            .await
            .map_err(|e| PlatformError::os(format!("capture task join: {e}")))?
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let this = self.clone();
        let input = input.clone();
        crate::spawn_blocking_reserved(move || this.inject_blocking(std::slice::from_ref(&input)))
            .await
            .map_err(|e| PlatformError::os(format!("inject task join: {e}")))?
    }
}

impl LinuxDesktop {
    /// Captures the root window via `GetImage` and PNG-encodes it. Runs on the
    /// blocking pool (x11rb is synchronous).
    fn capture_blocking(&self) -> PlatformResult<CapturedFrame> {
        let frame = self.capture_rgba_blocking()?;
        encode_captured_png(&frame)
    }

    fn capture_rgba_blocking(&self) -> PlatformResult<LinuxRgbaFrame> {
        let (conn, screen) = self.connect()?;
        let (width, height) = screen_geometry(&conn, &screen);
        capture_drawable_rgba(&conn, screen.root, width, height)
    }

    fn windows_blocking(&self) -> PlatformResult<Vec<LinuxWindow>> {
        let (conn, screen) = self.connect()?;
        let stacking = intern_existing_atom(&conn, b"_NET_CLIENT_LIST_STACKING")?;
        let clients = intern_existing_atom(&conn, b"_NET_CLIENT_LIST")?;
        let net_wm_pid = intern_existing_atom(&conn, b"_NET_WM_PID")?;
        let net_wm_name = intern_existing_atom(&conn, b"_NET_WM_NAME")?;
        let utf8_string = intern_existing_atom(&conn, b"UTF8_STRING")?;

        let mut ids = stacking
            .and_then(|atom| window_property(&conn, screen.root, atom).ok())
            .filter(|ids| !ids.is_empty())
            .or_else(|| {
                clients
                    .and_then(|atom| window_property(&conn, screen.root, atom).ok())
                    .filter(|ids| !ids.is_empty())
            })
            .unwrap_or_else(|| {
                conn.query_tree(screen.root)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .map_or_else(Vec::new, |reply| reply.children)
            });
        ids.truncate(MAX_CLIENT_WINDOWS as usize);
        let mut seen = BTreeSet::new();
        ids.retain(|id| seen.insert(*id));

        let mut windows = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(window) =
                inspect_window(&conn, &screen, id, net_wm_pid, net_wm_name, utf8_string)
            {
                windows.push(window);
            }
        }
        self.sync_redirected_windows(&windows)?;
        Ok(windows)
    }

    fn capture_window_blocking(&self, window_id: u32) -> PlatformResult<CapturedFrame> {
        let frame = self.capture_window_rgba_blocking(window_id)?;
        encode_captured_png(&frame)
    }

    fn capture_window_rgba_blocking(&self, window_id: u32) -> PlatformResult<LinuxRgbaFrame> {
        let mut composite = self.composite()?;
        ensure_redirected(&mut composite, window_id)?;
        let geometry = composite
            .connection
            .get_geometry(window_id)
            .map_err(|error| {
                PlatformError::os(format!(
                    "request geometry for X11 window {window_id:#x}: {error}"
                ))
            })?
            .reply()
            .map_err(|error| {
                PlatformError::NotFound(format!(
                    "X11 window {window_id:#x} disappeared before capture: {error}"
                ))
            })?;
        if geometry.width == 0 || geometry.height == 0 {
            return Err(PlatformError::Unsupported(format!(
                "X11 window {window_id:#x} has empty geometry"
            )));
        }

        let pixmap = composite.connection.generate_id().map_err(|error| {
            PlatformError::os(format!("allocate XComposite pixmap id: {error}"))
        })?;
        let result = (|| {
            name_window_pixmap(&mut composite, window_id, pixmap)?;
            capture_drawable_rgba(
                &composite.connection,
                pixmap,
                u32::from(geometry.width),
                u32::from(geometry.height),
            )
        })();

        // The named pixmap is per-capture; the redirect deliberately remains
        // owned by the dedicated connection so obscured contents stay complete.
        if let Ok(cookie) = composite.connection.free_pixmap(pixmap) {
            let _ = cookie.check();
        }
        result
    }

    fn sync_redirected_windows(&self, windows: &[LinuxWindow]) -> PlatformResult<()> {
        use x11rb::protocol::composite::{ConnectionExt as _, Redirect};

        let Some(state) = &self.composite else {
            return Ok(());
        };
        let mut state = state
            .lock()
            .map_err(|_| PlatformError::os("XComposite connection lock was poisoned"))?;
        let current: BTreeSet<Window> = windows.iter().map(|window| window.id).collect();
        let departed_windows: Vec<Window> =
            state.redirected.difference(&current).copied().collect();
        for window in departed_windows {
            if let Ok(cookie) = state
                .connection
                .composite_unredirect_window(window, Redirect::AUTOMATIC)
            {
                let _ = cookie.check();
            }
            state.redirected.remove(&window);
        }
        for window in current {
            // Input-only/helper windows may reject Composite redirection. One
            // such client must not erase every otherwise usable window from
            // discovery; capture of that exact target will return its own error.
            let _ = ensure_redirected(&mut state, window);
        }
        Ok(())
    }

    /// Synthesizes one input event via the `XTEST` `FakeInput` request.
    fn inject_blocking(&self, inputs: &[v1::DesktopInput]) -> PlatformResult<()> {
        let (conn, screen) = self.connect()?;
        inject_inputs(&conn, screen.root, inputs)
    }

    fn inject_window_blocking(
        &self,
        window_id: Window,
        expected_bounds: LinuxWindowRect,
        inputs: &[v1::DesktopInput],
    ) -> PlatformResult<()> {
        let (conn, screen) = self.connect()?;
        let current = window_bounds(&conn, &screen, window_id).ok_or_else(|| {
            PlatformError::NotFound(format!(
                "X11 window {window_id:#x} disappeared before input"
            ))
        })?;
        if current != expected_bounds {
            return Err(PlatformError::NotFound(format!(
                "X11 window {window_id:#x} moved or resized before input"
            )));
        }
        conn.configure_window(
            window_id,
            &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
        )
        .map_err(|error| {
            PlatformError::os(format!(
                "request raise for X11 window {window_id:#x}: {error}"
            ))
        })?
        .check()
        .map_err(|error| PlatformError::os(format!("raise X11 window {window_id:#x}: {error}")))?;
        conn.set_input_focus(InputFocus::PARENT, window_id, x11rb::CURRENT_TIME)
            .map_err(|error| {
                PlatformError::os(format!(
                    "request focus for X11 window {window_id:#x}: {error}"
                ))
            })?
            .check()
            .map_err(|error| {
                PlatformError::os(format!("focus X11 window {window_id:#x}: {error}"))
            })?;
        inject_inputs(&conn, screen.root, inputs)
    }

    fn focus_window_blocking(
        &self,
        window_id: Window,
        expected_bounds: LinuxWindowRect,
    ) -> PlatformResult<()> {
        let (conn, screen) = self.connect()?;
        let current = window_bounds(&conn, &screen, window_id).ok_or_else(|| {
            PlatformError::NotFound(format!(
                "X11 window {window_id:#x} disappeared before focus"
            ))
        })?;
        if current != expected_bounds {
            return Err(PlatformError::NotFound(format!(
                "X11 window {window_id:#x} moved or resized before focus"
            )));
        }
        conn.set_input_focus(InputFocus::PARENT, window_id, x11rb::CURRENT_TIME)
            .map_err(|error| {
                PlatformError::os(format!(
                    "request focus for X11 window {window_id:#x}: {error}"
                ))
            })?
            .check()
            .map_err(|error| {
                PlatformError::os(format!("focus X11 window {window_id:#x}: {error}"))
            })?;
        conn.flush()
            .map_err(|error| PlatformError::os(format!("flush X11 window focus: {error}")))
    }

    fn activate_window_blocking(
        &self,
        expected: LinuxWindow,
    ) -> Result<LinuxWindowActivation, LinuxWindowActivationError> {
        let (conn, screen) = self.connect().map_err(LinuxWindowActivationError::before)?;
        validate_activation_window(&conn, &screen, &expected)
            .map_err(LinuxWindowActivationError::before)?;
        let route =
            read_activation_route(&conn, &screen).map_err(LinuxWindowActivationError::before)?;
        let timestamp =
            server_timestamp(&conn, &screen).map_err(LinuxWindowActivationError::before)?;
        validate_activation_window(&conn, &screen, &expected)
            .map_err(LinuxWindowActivationError::before)?;
        if read_activation_route(&conn, &screen).map_err(LinuxWindowActivationError::before)?
            != route
        {
            return Err(LinuxWindowActivationError::before(PlatformError::NotFound(
                "window manager changed before activation".into(),
            )));
        }
        match route {
            WindowActivationRoute::Managed { active_atom, .. } => {
                // This external desktop controller acts as a pager. It never
                // impersonates the target application's own active window.
                let event =
                    ClientMessageEvent::new(32, expected.id, active_atom, [2, timestamp, 0, 0, 0]);
                conn.send_event(
                    false,
                    screen.root,
                    EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                    event,
                )
                .map_err(|error| {
                    LinuxWindowActivationError::after(PlatformError::os(format!(
                        "request exact X11 activation: {error}"
                    )))
                })?
                .check()
                .map_err(|error| {
                    LinuxWindowActivationError::after(PlatformError::os(format!(
                        "send exact X11 activation: {error}"
                    )))
                })?;
            }
            WindowActivationRoute::Unmanaged => {
                conn.set_input_focus(InputFocus::PARENT, expected.id, timestamp)
                    .map_err(|error| {
                        LinuxWindowActivationError::after(PlatformError::os(format!(
                            "request unmanaged X11 focus: {error}"
                        )))
                    })?
                    .check()
                    .map_err(|error| {
                        LinuxWindowActivationError::after(PlatformError::os(format!(
                            "set unmanaged X11 focus: {error}"
                        )))
                    })?;
            }
        }
        conn.flush().map_err(|error| {
            LinuxWindowActivationError::after(PlatformError::os(format!(
                "flush X11 activation: {error}"
            )))
        })?;
        let mut consecutive = 0;
        for attempt in 0..12 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            validate_activation_window(&conn, &screen, &expected)
                .map_err(LinuxWindowActivationError::after)?;
            if read_activation_route(&conn, &screen).map_err(LinuxWindowActivationError::after)?
                != route
            {
                return Err(LinuxWindowActivationError::after(PlatformError::NotFound(
                    "window manager changed during activation".into(),
                )));
            }
            if activation_owns_focus(&conn, &screen, &expected, route)
                .map_err(LinuxWindowActivationError::after)?
            {
                consecutive += 1;
                if consecutive == 2 {
                    return Ok(LinuxWindowActivation {
                        display_name: self.display_name.clone(),
                        window: expected,
                        route,
                    });
                }
            } else {
                consecutive = 0;
            }
        }
        // A manager may deliberately ignore/refuse its one request. Never force
        // SetInputFocus or repeat activation after that refusal.
        Err(LinuxWindowActivationError::after(PlatformError::Timeout(
            "exact X11 window activation did not settle".into(),
        )))
    }
}

fn validate_activation_window(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
    expected: &LinuxWindow,
) -> PlatformResult<()> {
    if expected.process_id.is_none() {
        return Err(PlatformError::Unsupported(
            "window activation requires an observed client process identity".into(),
        ));
    }
    let attrs = conn
        .get_window_attributes(expected.id)
        .map_err(|error| {
            PlatformError::os(format!("request exact X11 window attributes: {error}"))
        })?
        .reply()
        .map_err(|error| {
            PlatformError::NotFound(format!("exact X11 window disappeared: {error}"))
        })?;
    if attrs.map_state != MapState::VIEWABLE {
        return Err(PlatformError::NotFound(
            "exact X11 client is not viewable".into(),
        ));
    }
    let current = inspect_window(
        conn,
        screen,
        expected.id,
        intern_existing_atom(conn, b"_NET_WM_PID")?,
        intern_existing_atom(conn, b"_NET_WM_NAME")?,
        intern_existing_atom(conn, b"UTF8_STRING")?,
    )
    .ok_or_else(|| {
        PlatformError::NotFound("exact X11 client disappeared before activation".into())
    })?;
    if !same_activation_window(expected, &current) {
        return Err(PlatformError::NotFound(
            "exact X11 client identity or geometry changed".into(),
        ));
    }
    Ok(())
}

fn read_activation_route(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
) -> PlatformResult<WindowActivationRoute> {
    let check_atom = intern_existing_atom(conn, b"_NET_SUPPORTING_WM_CHECK")?;
    let check_present = check_atom
        .map(|property| property_present(conn, screen.root, property))
        .transpose()?
        .unwrap_or(false);
    let check_window = check_atom
        .map(|property| window_property(conn, screen.root, property))
        .transpose()?
        .and_then(|values| (values.len() == 1).then(|| values[0]));
    let check_confirmed = check_window
        .zip(check_atom)
        .is_some_and(|(window, property)| {
            window_property(conn, window, property).is_ok_and(|values| values == [window])
        });
    let check_named = check_window
        .zip(intern_existing_atom(conn, b"_NET_WM_NAME")?)
        .zip(intern_existing_atom(conn, b"UTF8_STRING")?)
        .is_some_and(|((window, property), kind)| {
            string_property(conn, window, property, kind).is_some_and(|name| !name.is_empty())
        });
    let supported_atom = intern_existing_atom(conn, b"_NET_SUPPORTED")?;
    let supported_present = supported_atom
        .map(|property| property_present(conn, screen.root, property))
        .transpose()?
        .unwrap_or(false);
    let supported = supported_atom
        .map(|property| {
            let reply = conn
                .get_property(
                    false,
                    screen.root,
                    property,
                    AtomEnum::ATOM,
                    0,
                    MAX_CLIENT_WINDOWS,
                )
                .map_err(|error| {
                    PlatformError::os(format!("request X11 manager support: {error}"))
                })?
                .reply()
                .map_err(|error| PlatformError::os(format!("read X11 manager support: {error}")))?;
            Ok::<_, PlatformError>(reply.value32().map_or_else(Vec::new, Iterator::collect))
        })
        .transpose()?
        .unwrap_or_default();
    let active_atom = intern_existing_atom(conn, b"_NET_ACTIVE_WINDOW")?;
    let index = conn
        .setup()
        .roots
        .iter()
        .position(|candidate| candidate.root == screen.root)
        .ok_or_else(|| PlatformError::NotFound("X11 screen root changed".into()))?;
    let selection = intern_existing_atom(conn, format!("WM_S{index}").as_bytes())?;
    let selection_owner = if let Some(selection) = selection {
        conn.get_selection_owner(selection)
            .map_err(|error| PlatformError::os(format!("request X11 manager selection: {error}")))?
            .reply()
            .map_err(|error| PlatformError::os(format!("read X11 manager selection: {error}")))?
            .owner
    } else {
        x11rb::NONE
    };
    let attrs = conn
        .get_window_attributes(screen.root)
        .map_err(|error| PlatformError::os(format!("request X11 root attributes: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read X11 root attributes: {error}")))?;
    let active_hint = active_atom
        .map(|property| property_present(conn, screen.root, property))
        .transpose()?
        .unwrap_or(false);
    activation_route(
        &WindowManagerFacts {
            check_window,
            check_confirmed,
            check_named,
            selection_owner,
            redirected: attrs
                .all_event_masks
                .contains(EventMask::SUBSTRUCTURE_REDIRECT),
            manager_hints: check_present || supported_present || active_hint,
            activation_advertised: active_atom.is_some_and(|atom| supported.contains(&atom)),
        },
        active_atom,
    )
}

fn property_present(
    conn: &x11rb::rust_connection::RustConnection,
    window: Window,
    property: Atom,
) -> PlatformResult<bool> {
    let reply = conn
        .get_property(false, window, property, AtomEnum::ANY, 0, 1)
        .map_err(|error| PlatformError::os(format!("request X11 property presence: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read X11 property presence: {error}")))?;
    Ok(reply.type_ != x11rb::NONE)
}

fn server_timestamp(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
) -> PlatformResult<u32> {
    let window = conn
        .generate_id()
        .map_err(|error| PlatformError::os(format!("allocate timestamp resource: {error}")))?;
    let property = conn
        .intern_atom(false, b"_OPENGENI_ACTIVATION_TIME")
        .map_err(|error| PlatformError::os(format!("request timestamp atom: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read timestamp atom: {error}")))?
        .atom;
    conn.create_window(
        0,
        window,
        screen.root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(|error| PlatformError::os(format!("create timestamp resource: {error}")))?
    .check()
    .map_err(|error| PlatformError::os(format!("confirm timestamp resource: {error}")))?;
    let result = (|| {
        conn.change_property8(PropMode::REPLACE, window, property, AtomEnum::INTEGER, &[1])
            .map_err(|error| PlatformError::os(format!("request server timestamp: {error}")))?
            .check()
            .map_err(|error| {
                PlatformError::os(format!("confirm server timestamp request: {error}"))
            })?;
        conn.flush()
            .map_err(|error| PlatformError::os(format!("flush timestamp request: {error}")))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if let Some(x11rb::protocol::Event::PropertyNotify(event)) =
                conn.poll_for_event().map_err(|error| {
                    PlatformError::os(format!("read server timestamp event: {error}"))
                })?
            {
                if event.window == window && event.atom == property && event.time != 0 {
                    return Ok(event.time);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        Err(PlatformError::Timeout(
            "X11 server timestamp did not arrive".into(),
        ))
    })();
    if let Ok(cookie) = conn.destroy_window(window) {
        let _ = cookie.check();
    }
    result
}

fn activation_owns_focus(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
    window: &LinuxWindow,
    route: WindowActivationRoute,
) -> PlatformResult<bool> {
    if let WindowActivationRoute::Managed { active_atom, .. } = route {
        let reply = conn
            .get_property(false, screen.root, active_atom, AtomEnum::WINDOW, 0, 2)
            .map_err(|error| PlatformError::os(format!("request active X11 client: {error}")))?
            .reply()
            .map_err(|error| PlatformError::os(format!("read active X11 client: {error}")))?;
        let values = reply.value32().map_or_else(Vec::new, Iterator::collect);
        if active_window_from_property(reply.type_, reply.format, reply.bytes_after, &values)
            != Some(window.id)
        {
            return Ok(false);
        }
    }
    let focus = conn
        .get_input_focus()
        .map_err(|error| PlatformError::os(format!("request X11 input focus: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read X11 input focus: {error}")))?
        .focus;
    Ok(focus_descends_from(focus, window.id, |current| {
        conn.query_tree(current)
            .ok()?
            .reply()
            .ok()
            .map(|reply| reply.parent)
    }))
}

fn verify_activation_state(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
    window: &LinuxWindow,
    route: WindowActivationRoute,
) -> PlatformResult<()> {
    validate_activation_window(conn, screen, window)?;
    if read_activation_route(conn, screen)? != route
        || !activation_owns_focus(conn, screen, window, route)?
    {
        return Err(PlatformError::NotFound(
            "exact window no longer owns active/input focus".into(),
        ));
    }
    Ok(())
}

fn ensure_redirected(state: &mut CompositeState, window: Window) -> PlatformResult<()> {
    use x11rb::protocol::composite::{ConnectionExt as _, Redirect};

    if state.redirected.contains(&window) {
        return Ok(());
    }
    state
        .connection
        .composite_redirect_window(window, Redirect::AUTOMATIC)
        .map_err(|error| {
            PlatformError::os(format!(
                "request redirect for X11 window {window:#x}: {error}"
            ))
        })?
        .check()
        .map_err(|error| PlatformError::os(format!("redirect X11 window {window:#x}: {error}")))?;
    state.redirected.insert(window);
    Ok(())
}

fn name_window_pixmap(
    state: &mut CompositeState,
    window: Window,
    pixmap: u32,
) -> PlatformResult<()> {
    fn attempt(state: &CompositeState, window: Window, pixmap: u32) -> Result<(), String> {
        use x11rb::protocol::composite::ConnectionExt as _;

        state
            .connection
            .composite_name_window_pixmap(window, pixmap)
            .map_err(|error| format!("request failed: {error}"))?
            .check()
            .map_err(|error| format!("server rejected request: {error}"))
    }

    match attempt(state, window, pixmap) {
        Ok(()) => Ok(()),
        Err(first) => {
            // An XID can be destroyed and reused between discovery snapshots.
            // Re-establish this connection's redirect ownership once rather
            // than trusting the local set forever; never retry a mutation.
            state.redirected.remove(&window);
            ensure_redirected(state, window)?;
            attempt(state, window, pixmap).map_err(|second| {
                PlatformError::os(format!(
                    "name backing pixmap for X11 window {window:#x}: {second} (first attempt: {first})"
                ))
            })
        }
    }
}

enum PreparedInput {
    Pointer(v1::PointerEvent),
    Key {
        request: v1::KeyEvent,
        events: Vec<(u8, u8)>,
    },
    Scroll(v1::ScrollEvent),
}

// Blocks ordinary client topology/focus changes across preflight and delivery.
// This is not a device grab: hardware input and impervious XTEST clients remain
// possible, so a failed postcheck still has an unknown physical outcome.
struct X11ServerGuard<'a> {
    conn: &'a x11rb::rust_connection::RustConnection,
    released: bool,
}

impl<'a> X11ServerGuard<'a> {
    fn acquire(conn: &'a x11rb::rust_connection::RustConnection) -> PlatformResult<Self> {
        conn.grab_server()
            .map_err(|error| PlatformError::os(format!("request X11 delivery guard: {error}")))?
            .check()
            .map_err(|error| PlatformError::os(format!("confirm X11 delivery guard: {error}")))?;
        Ok(Self {
            conn,
            released: false,
        })
    }

    fn release(mut self) -> PlatformResult<()> {
        self.conn
            .ungrab_server()
            .map_err(|error| PlatformError::os(format!("release X11 delivery guard: {error}")))?
            .check()
            .map_err(|error| {
                PlatformError::os(format!("confirm X11 delivery guard release: {error}"))
            })?;
        self.released = true;
        Ok(())
    }
}

impl Drop for X11ServerGuard<'_> {
    fn drop(&mut self) {
        if !self.released {
            // One server-side disconnect cleanup releases the guard/grabs and
            // registered XKB restoration. Do not reopen ordinary clients with
            // temporary controls still armed on this fresh delivery connection.
            let _ = rustix::net::shutdown(self.conn.stream(), rustix::net::Shutdown::Both);
        }
    }
}

fn verify_window_input_owners(
    conn: &x11rb::rust_connection::RustConnection,
    root: Window,
    window: Window,
    inputs: &[PreparedInput],
) -> PlatformResult<()> {
    use x11rb::protocol::res::ConnectionExt as _;
    let points = inputs
        .iter()
        .filter_map(|input| match input {
            PreparedInput::Pointer(pointer) => Some((pointer.x, pointer.y)),
            PreparedInput::Scroll(scroll) => Some((scroll.x, scroll.y)),
            PreparedInput::Key { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    let keyboard = inputs
        .iter()
        .any(|input| matches!(input, PreparedInput::Key { .. }));
    if points.is_empty() && !keyboard {
        return Ok(());
    }
    // Window/PID properties alone cannot identify a foreign embedded child.
    // XRes maps every resource to its actual owning client connection.
    let clients = conn
        .res_query_clients()
        .map_err(|error| {
            PlatformError::Unsupported(format!(
                "X11 window client ownership is unavailable: {error}"
            ))
        })?
        .reply()
        .map_err(|error| {
            PlatformError::Unsupported(format!(
                "X11 window client ownership is unavailable: {error}"
            ))
        })?
        .clients;
    if keyboard {
        let focused = conn
            .get_input_focus()
            .map_err(|error| PlatformError::os(format!("request X11 keyboard owner: {error}")))?
            .reply()
            .map_err(|error| PlatformError::os(format!("read X11 keyboard owner: {error}")))?
            .focus;
        // An XEmbed child can be a descendant of the intended window while
        // belonging to an entirely different client. Ancestry is insufficient.
        if !same_x11_client(window, focused, &clients) {
            return Err(PlatformError::NotFound(
                "window keyboard focus belongs to another client".into(),
            ));
        }
    }
    for (x, y) in points {
        let mut current = root;
        let mut visited = BTreeSet::new();
        let mut original_seen = false;
        let mut confirmed = false;
        for _ in 0..64 {
            if !visited.insert(current) {
                break;
            }
            original_seen |= current == window;
            let translated = conn
                .translate_coordinates(
                    root,
                    current,
                    i16::try_from(x).expect("point was preflighted"),
                    i16::try_from(y).expect("point was preflighted"),
                )
                .map_err(|error| {
                    PlatformError::os(format!("request X11 input point owner: {error}"))
                })?
                .reply()
                .map_err(|error| {
                    PlatformError::os(format!("read X11 input point owner: {error}"))
                })?;
            if !translated.same_screen {
                break;
            }
            if translated.child == x11rb::NONE {
                confirmed = original_seen && same_x11_client(window, current, &clients);
                break;
            }
            current = translated.child;
        }
        if !confirmed {
            return Err(PlatformError::NotFound(
                "window input point is covered or belongs to another client".into(),
            ));
        }
    }
    Ok(())
}

fn same_x11_client(
    window: Window,
    child: Window,
    clients: &[x11rb::protocol::res::Client],
) -> bool {
    let owner = |resource| {
        clients
            .iter()
            .find(|client| resource & !client.resource_mask == client.resource_base)
            .map(|client| client.resource_base)
    };
    let expected = owner(window);
    expected.is_some() && owner(child) == expected
}

// Resolve the entire batch on its delivery connection before any XTEST input.
// A later unsupported glyph/chord must not turn an earlier emitted prefix into
// a supposedly definite failure.
fn prepare_inputs(
    conn: &x11rb::rust_connection::RustConnection,
    inputs: &[v1::DesktopInput],
) -> PlatformResult<Vec<PreparedInput>> {
    let mut mapping = None;
    inputs
        .iter()
        .map(|input| match input.event.as_ref() {
            Some(v1::desktop_input::Event::Pointer(pointer)) => {
                validate_x11_point(pointer.x, pointer.y)?;
                Ok(PreparedInput::Pointer(*pointer))
            }
            Some(v1::desktop_input::Event::Scroll(scroll)) => {
                validate_x11_point(scroll.x, scroll.y)?;
                Ok(PreparedInput::Scroll(*scroll))
            }
            Some(v1::desktop_input::Event::Key(key)) => {
                if mapping.is_none() {
                    mapping = Some(keyboard_mapping(conn).ok_or_else(|| {
                        PlatformError::Unsupported("X11 keyboard mapping is unavailable".into())
                    })?);
                }
                Ok(PreparedInput::Key {
                    request: key.clone(),
                    events: prepare_key(mapping.as_ref().expect("keymap was loaded"), key)?,
                })
            }
            None => Err(PlatformError::os("DesktopInput carried no event")),
        })
        .collect()
}

fn validate_x11_point(x: i32, y: i32) -> PlatformResult<()> {
    if i16::try_from(x).is_err() || i16::try_from(y).is_err() {
        return Err(PlatformError::Unsupported(
            "input point is outside X11 coordinate range".into(),
        ));
    }
    Ok(())
}

fn inject_inputs(
    conn: &x11rb::rust_connection::RustConnection,
    root: Window,
    inputs: &[v1::DesktopInput],
) -> PlatformResult<()> {
    let prepared = prepare_inputs(conn, inputs)?;
    inject_prepared_inputs(conn, root, &prepared)
}

fn inject_prepared_inputs(
    conn: &x11rb::rust_connection::RustConnection,
    root: Window,
    inputs: &[PreparedInput],
) -> PlatformResult<()> {
    for input in inputs {
        match input {
            PreparedInput::Pointer(pointer) => inject_pointer(conn, root, pointer)?,
            PreparedInput::Key { events, .. } => {
                for &(event, keycode) in events {
                    if event == KEY_PRESS {
                        key_press(conn, keycode)?;
                    } else {
                        key_release(conn, keycode)?;
                    }
                }
            }
            PreparedInput::Scroll(scroll) => inject_scroll(conn, root, scroll)?,
        }
    }
    conn.flush()
        .map_err(|error| PlatformError::os(format!("XTEST flush: {error}")))?;
    conn.get_input_focus()
        .map_err(|error| PlatformError::os(format!("X11 input sync request: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("X11 input sync reply: {error}")))?;
    Ok(())
}

/// Maps a [`PointerEvent`](v1::PointerEvent) to one or more XTEST `FakeInput`
/// motion/button events.
fn inject_pointer(
    conn: &x11rb::rust_connection::RustConnection,
    root: x11rb::protocol::xproto::Window,
    p: &v1::PointerEvent,
) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let x = i16::try_from(p.x).unwrap_or(0);
    let y = i16::try_from(p.y).unwrap_or(0);
    let button = x_button_code(p.button());

    // Every pointer event first moves to the target coordinate (XTEST motion uses
    // detail 0, the absolute root-relative position).
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x, y, 0)
        .map_err(|e| PlatformError::os(format!("XTEST motion: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST motion result: {e}")))?;

    match p.action() {
        v1::PointerAction::Move | v1::PointerAction::Unspecified => {}
        v1::PointerAction::Down => press(conn, button)?,
        v1::PointerAction::Up => release(conn, button)?,
        v1::PointerAction::Click => {
            press(conn, button)?;
            release(conn, button)?;
        }
        v1::PointerAction::DoubleClick => {
            press(conn, button)?;
            release(conn, button)?;
            press(conn, button)?;
            release(conn, button)?;
        }
    }
    Ok(())
}

/// Prepares key events from one complete immutable delivery keymap.
fn prepare_key(mapping: &X11KeyboardMapping, key: &v1::KeyEvent) -> PlatformResult<Vec<(u8, u8)>> {
    let mut events = Vec::new();
    if key.is_text {
        let strokes = key
            .key
            .chars()
            .map(|character| {
                let keysym = match character {
                    '\n' | '\r' => 0xff0d,
                    '\t' => 0xff09,
                    character => character as u32,
                };
                mapping.resolve(keysym).ok_or_else(|| {
                    PlatformError::Unsupported(format!(
                        "X11 keymap cannot type Unicode scalar U+{:04X}; use clipboard paste",
                        character as u32
                    ))
                })
            })
            .collect::<PlatformResult<Vec<_>>>()?;
        let shift = if strokes.iter().any(|stroke| stroke.shift) {
            Some(
                mapping
                    .resolve(0xffe1)
                    .map(|stroke| stroke.keycode)
                    .ok_or_else(|| {
                        PlatformError::Unsupported(
                            "X11 keymap has shifted glyphs but no Shift key".into(),
                        )
                    })?,
            )
        } else {
            None
        };
        for stroke in strokes {
            if stroke.shift {
                events.push((KEY_PRESS, shift.expect("shift was preflighted")));
            }
            match key.action() {
                v1::KeyAction::Down => events.push((KEY_PRESS, stroke.keycode)),
                v1::KeyAction::Up => events.push((KEY_RELEASE, stroke.keycode)),
                v1::KeyAction::Press | v1::KeyAction::Unspecified => {
                    events.push((KEY_PRESS, stroke.keycode));
                    events.push((KEY_RELEASE, stroke.keycode));
                }
            }
            if stroke.shift {
                events.push((KEY_RELEASE, shift.expect("shift was preflighted")));
            }
        }
        return Ok(events);
    }
    let keycodes = parse_named_key_chord(&key.key)?
        .into_iter()
        .map(|keysym| {
            mapping
                .resolve(keysym)
                .map(|stroke| stroke.keycode)
                .ok_or_else(|| {
                    PlatformError::Unsupported(format!(
                        "X11 keymap does not expose named key/chord component {keysym:#x}"
                    ))
                })
        })
        .collect::<PlatformResult<Vec<_>>>()?;
    match key.action() {
        v1::KeyAction::Down => events.extend(keycodes.iter().map(|&code| (KEY_PRESS, code))),
        v1::KeyAction::Up => events.extend(keycodes.iter().rev().map(|&code| (KEY_RELEASE, code))),
        v1::KeyAction::Press | v1::KeyAction::Unspecified => {
            let (last, modifiers) = keycodes
                .split_last()
                .expect("validated chord contains a key");
            events.extend(modifiers.iter().map(|&code| (KEY_PRESS, code)));
            events.push((KEY_PRESS, *last));
            events.push((KEY_RELEASE, *last));
            events.extend(modifiers.iter().rev().map(|&code| (KEY_RELEASE, code)));
        }
    }
    Ok(events)
}

/// The maximum number of synthetic wheel clicks one scroll event may emit per
/// axis. A real wheel gesture is a handful of clicks; this bound only exists to
/// keep a malformed/hostile delta (e.g. `i32::MIN`) from spinning the blocking
/// inject for ~2^31 round-tripped `FakeInput` events.
const MAX_SCROLL_CLICKS: u32 = 32;

/// Maps a [`ScrollEvent`](v1::ScrollEvent) to XTEST button 4/5 (vertical) and 6/7
/// (horizontal) clicks — the X11 convention for wheel scrolling.
fn inject_scroll(
    conn: &x11rb::rust_connection::RustConnection,
    root: x11rb::protocol::xproto::Window,
    s: &v1::ScrollEvent,
) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let x = i16::try_from(s.x).unwrap_or(0);
    let y = i16::try_from(s.y).unwrap_or(0);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x, y, 0)
        .map_err(|e| PlatformError::os(format!("XTEST scroll motion: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST scroll motion result: {e}")))?;

    // Vertical: button 4 = up, 5 = down. Horizontal: 6 = left, 7 = right.
    let v_button = if s.delta_y < 0 { 4 } else { 5 };
    let h_button = if s.delta_x < 0 { 6 } else { 7 };
    // Each unit of delta is one synthetic wheel click. Clamp the per-axis repeat
    // so a hostile/huge magnitude (up to i32::MIN.unsigned_abs() == 2^31) cannot
    // spin the inject for billions of round-tripped FakeInput events and wedge the
    // blocking pool. MAX_SCROLL_CLICKS is well past any real wheel gesture.
    let v_clicks = s.delta_y.unsigned_abs().min(MAX_SCROLL_CLICKS);
    let h_clicks = s.delta_x.unsigned_abs().min(MAX_SCROLL_CLICKS);
    for _ in 0..v_clicks {
        press(conn, v_button)?;
        release(conn, v_button)?;
    }
    for _ in 0..h_clicks {
        press(conn, h_button)?;
        release(conn, h_button)?;
    }
    Ok(())
}

// --- XTEST low-level helpers -------------------------------------------------

/// X11 event-type constants for XTEST `FakeInput` (from the core protocol).
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;

fn press(conn: &x11rb::rust_connection::RustConnection, button: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(BUTTON_PRESS, button, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST button press: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST button press result: {e}")))?;
    Ok(())
}

fn release(conn: &x11rb::rust_connection::RustConnection, button: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(BUTTON_RELEASE, button, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST button release: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST button release result: {e}")))?;
    Ok(())
}

fn key_press(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_PRESS, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key press: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST key press result: {e}")))?;
    Ok(())
}

fn key_release(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_RELEASE, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key release: {e}")))?
        .check()
        .map_err(|e| PlatformError::os(format!("XTEST key release result: {e}")))?;
    Ok(())
}

/// Maps the proto [`PointerButton`](v1::PointerButton) to the X11 button number
/// (1 = left, 2 = middle, 3 = right).
fn x_button_code(button: v1::PointerButton) -> u8 {
    match button {
        v1::PointerButton::Right => 3,
        v1::PointerButton::Middle => 2,
        // Left + unspecified default to the primary button.
        v1::PointerButton::Left | v1::PointerButton::Unspecified => 1,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct X11KeyStroke {
    keycode: u8,
    shift: bool,
}

struct X11KeyboardMapping {
    min_keycode: u8,
    keysyms_per_keycode: usize,
    keysyms: Vec<u32>,
}

impl X11KeyboardMapping {
    fn resolve(&self, keysym: u32) -> Option<X11KeyStroke> {
        resolve_keysym(
            self.min_keycode,
            self.keysyms_per_keycode,
            &self.keysyms,
            keysym,
        )
    }
}

fn keyboard_mapping(conn: &x11rb::rust_connection::RustConnection) -> Option<X11KeyboardMapping> {
    let setup = conn.setup();
    let min = setup.min_keycode;
    let max = setup.max_keycode;
    let count = max - min + 1;
    let mapping = conn.get_keyboard_mapping(min, count).ok()?.reply().ok()?;
    Some(X11KeyboardMapping {
        min_keycode: min,
        keysyms_per_keycode: mapping.keysyms_per_keycode as usize,
        keysyms: mapping.keysyms,
    })
}

/// Resolve the base or Shift level of a core X11 keyboard mapping. Higher XKB
/// groups require AltGr/level modifiers and are intentionally rejected; the
/// clipboard path provides lossless arbitrary UTF-8 input without guessing the
/// active layout.
fn resolve_keysym(
    min_keycode: u8,
    keysyms_per_keycode: usize,
    keysyms: &[u32],
    keysym: u32,
) -> Option<X11KeyStroke> {
    if keysyms_per_keycode == 0 {
        return None;
    }
    for (key_index, chunk) in keysyms.chunks(keysyms_per_keycode).enumerate() {
        for (level, candidate) in chunk.iter().take(2).enumerate() {
            if *candidate == keysym {
                return Some(X11KeyStroke {
                    keycode: min_keycode.checked_add(u8::try_from(key_index).ok()?)?,
                    shift: level == 1,
                });
            }
        }
    }
    None
}

/// Maps a small set of named keys to X11 keysyms (the keys the computer-use tool
/// commonly emits). Printable single characters fall through to their ASCII
/// codepoint, which equals the Latin-1 keysym for the printable range.
fn named_key_to_keysym(name: &str) -> Option<u32> {
    // X11 keysym constants (from keysymdef.h). Only the common control keys are
    // named; everything else is treated as literal text by the caller.
    let sym = match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "space" | " " => 0x0020,
        "arrowleft" | "left" => 0xff51,
        "arrowup" | "up" => 0xff52,
        "arrowright" | "right" => 0xff53,
        "arrowdown" | "down" => 0xff54,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        _ => {
            // A single printable char maps to its codepoint (Latin-1 keysym range).
            // Use the original spelling here: `A` intentionally resolves to the
            // shifted glyph, while named controls are case-insensitive.
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_none() && (c as u32) < 0x100 {
                c as u32
            } else {
                return None;
            }
        }
    };
    Some(sym)
}

/// Preflights one X11 named key or chord before an operation is durably marked
/// dispatched. This is the same parser used by injection, so invalid input is a
/// definite client failure rather than an ambiguous post-dispatch outcome.
///
/// # Errors
///
/// Returns an unsupported-input failure when the key or chord is empty,
/// ambiguous, repeated, or unavailable through the X11 mapping.
pub fn validate_linux_named_key_chord(name: &str) -> PlatformResult<()> {
    parse_named_key_chord(name).map(|_| ())
}

fn parse_named_key_chord(name: &str) -> PlatformResult<Vec<u32>> {
    let parts: Vec<&str> = name.split('+').map(str::trim).collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(PlatformError::Unsupported(
            "X11 named key/chord contains an empty component".to_string(),
        ));
    }
    let mut result = Vec::with_capacity(parts.len());
    let mut seen_modifiers = BTreeSet::new();
    for (index, part) in parts.iter().enumerate() {
        if let Some(modifier) = modifier_keysym(part) {
            if index + 1 == parts.len() || !seen_modifiers.insert(modifier) {
                return Err(PlatformError::Unsupported(format!(
                    "invalid or repeated X11 modifier in key chord `{name}`"
                )));
            }
            result.push(modifier);
            continue;
        }
        if index + 1 != parts.len() {
            return Err(PlatformError::Unsupported(format!(
                "X11 key chord `{name}` must end with exactly one non-modifier key"
            )));
        }
        result.push(named_key_to_keysym(part).ok_or_else(|| {
            PlatformError::Unsupported(format!("unknown X11 named key `{part}`"))
        })?);
    }
    if result.is_empty() || result.len() == seen_modifiers.len() {
        return Err(PlatformError::Unsupported(format!(
            "X11 key chord `{name}` has modifiers but no key"
        )));
    }
    Ok(result)
}

fn modifier_keysym(name: &str) -> Option<u32> {
    match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Some(0xffe3),
        "shift" => Some(0xffe1),
        "alt" | "option" => Some(0xffe9),
        "meta" | "super" | "command" | "cmd" => Some(0xffeb),
        _ => None,
    }
}

// --- Window discovery + geometry + image conversion -------------------------

fn intern_existing_atom(
    conn: &x11rb::rust_connection::RustConnection,
    name: &[u8],
) -> PlatformResult<Option<Atom>> {
    let reply = conn
        .intern_atom(true, name)
        .map_err(|error| {
            PlatformError::os(format!(
                "request X11 atom {}: {error}",
                String::from_utf8_lossy(name)
            ))
        })?
        .reply()
        .map_err(|error| {
            PlatformError::os(format!(
                "resolve X11 atom {}: {error}",
                String::from_utf8_lossy(name)
            ))
        })?;
    Ok((reply.atom != x11rb::NONE).then_some(reply.atom))
}

fn window_property(
    conn: &x11rb::rust_connection::RustConnection,
    window: Window,
    property: Atom,
) -> PlatformResult<Vec<Window>> {
    let reply = conn
        .get_property(
            false,
            window,
            property,
            AtomEnum::WINDOW,
            0,
            MAX_CLIENT_WINDOWS,
        )
        .map_err(|error| PlatformError::os(format!("request X11 client list: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read X11 client list: {error}")))?;
    Ok(reply.value32().map_or_else(Vec::new, Iterator::collect))
}

fn inspect_window(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
    id: Window,
    net_wm_pid: Option<Atom>,
    net_wm_name: Option<Atom>,
    utf8_string: Option<Atom>,
) -> Option<LinuxWindow> {
    let attributes = conn.get_window_attributes(id).ok()?.reply().ok()?;
    if attributes.map_state == MapState::UNMAPPED {
        return None;
    }
    let bounds = window_bounds(conn, screen, id)?;

    let process_id = net_wm_pid.and_then(|atom| u32_property(conn, id, atom));
    let title = net_wm_name
        .zip(utf8_string)
        .and_then(|(property, kind)| string_property(conn, id, property, kind))
        .filter(|title| !title.is_empty())
        .or_else(|| string_property(conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
        .unwrap_or_default();
    Some(LinuxWindow {
        id,
        process_id,
        title,
        bounds,
    })
}

fn window_bounds(
    conn: &x11rb::rust_connection::RustConnection,
    screen: &Screen,
    id: Window,
) -> Option<LinuxWindowRect> {
    let geometry = conn.get_geometry(id).ok()?.reply().ok()?;
    if geometry.width == 0 || geometry.height == 0 {
        return None;
    }
    let translated = conn
        .translate_coordinates(id, screen.root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    if !translated.same_screen {
        return None;
    }
    Some(LinuxWindowRect {
        x: i32::from(translated.dst_x),
        y: i32::from(translated.dst_y),
        width: u32::from(geometry.width),
        height: u32::from(geometry.height),
    })
}

fn u32_property(
    conn: &x11rb::rust_connection::RustConnection,
    window: Window,
    property: Atom,
) -> Option<u32> {
    conn.get_property(false, window, property, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()
}

fn string_property(
    conn: &x11rb::rust_connection::RustConnection,
    window: Window,
    property: Atom,
    kind: Atom,
) -> Option<String> {
    let reply = conn
        .get_property(false, window, property, kind, 0, MAX_WINDOW_TITLE_LONGS)
        .ok()?
        .reply()
        .ok()?;
    let bytes: Vec<u8> = reply.value8()?.take(16 * 1024).collect();
    let value = String::from_utf8_lossy(&bytes)
        .trim_matches(char::from(0))
        .trim()
        .to_string();
    Some(value)
}

fn capture_drawable_rgba(
    conn: &x11rb::rust_connection::RustConnection,
    drawable: u32,
    width: u32,
    height: u32,
) -> PlatformResult<LinuxRgbaFrame> {
    let w = u16::try_from(width).unwrap_or(u16::MAX);
    let h = u16::try_from(height).unwrap_or(u16::MAX);
    let image = conn
        .get_image(ImageFormat::Z_PIXMAP, drawable, 0, 0, w, h, u32::MAX)
        .map_err(|error| PlatformError::os(format!("request X11 drawable image: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("read X11 drawable image: {error}")))?;
    let rgba = zpixmap_to_rgba(&image.data, width, height, image.depth);
    Ok(LinuxRgbaFrame {
        rgba,
        width,
        height,
    })
}

fn encode_captured_png(frame: &LinuxRgbaFrame) -> PlatformResult<CapturedFrame> {
    let png = encode_png(&frame.rgba, frame.width, frame.height)?;
    Ok(CapturedFrame {
        png,
        width: frame.width,
        height: frame.height,
    })
}

/// Reports the screen geometry, preferring `RANDR`'s current mode (accurate under
/// a resized real screen) and falling back to the root window's `width/height`
/// (which is what Xvfb reports). Always returns a sane non-zero pair.
fn screen_geometry(conn: &x11rb::rust_connection::RustConnection, screen: &Screen) -> (u32, u32) {
    use x11rb::protocol::randr::ConnectionExt as _;
    if let Ok(cookie) = conn.randr_get_screen_resources_current(screen.root) {
        if let Ok(res) = cookie.reply() {
            if let Some(crtc) = res.crtcs.first() {
                if let Ok(info) = conn.randr_get_crtc_info(*crtc, 0) {
                    if let Ok(info) = info.reply() {
                        if info.width > 0 && info.height > 0 {
                            return (u32::from(info.width), u32::from(info.height));
                        }
                    }
                }
            }
        }
    }
    (
        u32::from(screen.width_in_pixels),
        u32::from(screen.height_in_pixels),
    )
}

/// Whether a `$DISPLAY` name indicates a virtual framebuffer. Xvfb has no reliable
/// protocol marker, so we use the heuristic that high display numbers (>= 99, the
/// conventional Xvfb range used by `--virtual-desktop`) are virtual. A false
/// negative is harmless (it only affects the `virtual` flag the UI shows).
fn is_virtual_display(display_name: &str) -> bool {
    display_name
        .trim_start_matches(':')
        .split('.')
        .next()
        .and_then(|n| n.parse::<u32>().ok())
        .is_some_and(|n| n >= 99)
}

/// Converts a server `ZPixmap` image buffer to tightly-packed RGBA8.
///
/// X servers commonly deliver 24/32-bit pixels as little-endian BGRX; we read each
/// 4-byte (or 3-byte) pixel and emit `R,G,B,255`.
///
/// # Row padding (stride)
///
/// A `ZPixmap` scanline is padded up to the server's `bitmap_format_scanline_pad`
/// (commonly 32 bits), so a row occupies `bytes_per_line >= width * bpp` bytes —
/// the padding bytes at the end of each row must be SKIPPED, not consumed as
/// pixels, or every row after the first is shifted and the frame shears. The
/// `GetImage` reply does not carry `bytes_per_line`, but `data.len()` is exactly
/// `bytes_per_line * height`, so we recover the true stride as `data.len() /
/// height` and walk each pixel at `row * stride + col * bpp`. A short/garbled
/// buffer falls back to the tight `width * bpp` stride and is clamped so a read
/// never panics.
fn zpixmap_to_rgba(data: &[u8], width: u32, height: u32, depth: u8) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let bpp = zpixmap_bytes_per_pixel(data.len(), width, height, depth);
    let tight = w * bpp;
    // True (possibly padded) bytes-per-line, recovered from the buffer length.
    // Fall back to the tight row when height is 0 or the buffer is shorter than a
    // single un-padded frame (we then clamp per-pixel below).
    let stride = if h > 0 && data.len() >= tight * h {
        data.len() / h
    } else {
        tight
    };
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let row_start = row * stride;
        for col in 0..w {
            let off = row_start + col * bpp;
            if off + 2 < data.len() {
                // BGRX byte order: byte0=B, byte1=G, byte2=R.
                rgba.push(data[off + 2]);
                rgba.push(data[off + 1]);
                rgba.push(data[off]);
                rgba.push(0xff);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0xff]);
            }
        }
    }
    rgba
}

/// Picks the bytes-per-pixel for a `ZPixmap` buffer of `depth`. A depth <= 24
/// image whose buffer is exactly `width*height*3` is tightly-packed 24bpp;
/// otherwise the server delivered 4 bytes per pixel (the common 32bpp BGRX case),
/// possibly with row padding the caller accounts for via the stride.
fn zpixmap_bytes_per_pixel(data_len: usize, width: u32, height: u32, depth: u8) -> usize {
    if depth <= 24 && data_len == (width as usize * height as usize * 3) {
        3
    } else {
        4
    }
}

/// PNG-encodes a tightly-packed RGBA8 buffer.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> PlatformResult<Vec<u8>> {
    use image::ImageEncoder as _;
    let mut out = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| {
            let mut detail = BTreeMap::new();
            detail.insert("stage".to_string(), "png-encode".to_string());
            PlatformError::Os {
                message: format!("png encode failed: {e}"),
                detail,
            }
        })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_keymap() -> X11KeyboardMapping {
        X11KeyboardMapping {
            min_keycode: 10,
            keysyms_per_keycode: 2,
            keysyms: vec![
                u32::from('a'),
                u32::from('A'),
                0xffe1,
                0,
                0xffe3,
                0,
                0xff0d,
                0,
            ],
        }
    }

    #[test]
    fn key_preflight_rejects_unmappable_text_and_complete_chords() {
        let mapping = fixture_keymap();
        let mut key = v1::KeyEvent {
            key: "a🙂".into(),
            is_text: true,
            action: v1::KeyAction::Press.into(),
        };
        assert!(matches!(
            prepare_key(&mapping, &key),
            Err(PlatformError::Unsupported(_))
        ));
        key.is_text = false;
        key.key = "Control+Escape".into();
        assert!(matches!(
            prepare_key(&mapping, &key),
            Err(PlatformError::Unsupported(_))
        ));
        key.key = "Control+Enter".into();
        assert_eq!(
            prepare_key(&mapping, &key).unwrap(),
            [
                (KEY_PRESS, 12),
                (KEY_PRESS, 13),
                (KEY_RELEASE, 13),
                (KEY_RELEASE, 12)
            ]
        );
        key.is_text = true;
        key.key = "aA".into();
        assert_eq!(
            prepare_key(&mapping, &key).unwrap(),
            [
                (KEY_PRESS, 10),
                (KEY_RELEASE, 10),
                (KEY_PRESS, 11),
                (KEY_PRESS, 10),
                (KEY_RELEASE, 10),
                (KEY_RELEASE, 11)
            ]
        );
    }

    #[test]
    fn input_point_requires_the_original_resource_owner_even_for_embedded_children() {
        let clients = [
            x11rb::protocol::res::Client {
                resource_base: 0x0010_0000,
                resource_mask: 0xfffff,
            },
            x11rb::protocol::res::Client {
                resource_base: 0x0020_0000,
                resource_mask: 0xfffff,
            },
        ];
        assert!(same_x11_client(0x0010_0001, 0x0010_0020, &clients));
        assert!(!same_x11_client(0x0010_0001, 0x0020_0020, &clients));
        assert!(!same_x11_client(0x0010_0001, 0x0030_0020, &clients));
        assert!(!same_x11_client(0x0030_0001, 0x0030_0020, &clients));
        assert!(!same_x11_client(0x0010_0001, 0x0010_0020, &[]));
    }

    #[test]
    fn out_of_range_input_is_refused_instead_of_moving_to_zero() {
        assert!(validate_x11_point(32767, -32768).is_ok());
        assert!(validate_x11_point(32768, 0).is_err());
        assert!(validate_x11_point(0, -32769).is_err());
    }

    fn managed_activation_facts() -> WindowManagerFacts {
        WindowManagerFacts {
            check_window: Some(22),
            check_confirmed: true,
            check_named: true,
            selection_owner: 23,
            redirected: true,
            manager_hints: true,
            activation_advertised: true,
        }
    }

    #[test]
    fn activation_uses_only_verified_advertised_manager_authority() {
        let facts = managed_activation_facts();
        assert_eq!(
            activation_route(&facts, Some(24)).unwrap(),
            WindowActivationRoute::Managed {
                check_window: 22,
                active_atom: 24,
                selection_owner: 23,
            }
        );
        for defect in 0..6 {
            let mut facts = managed_activation_facts();
            let mut active_atom = Some(24);
            match defect {
                0 => facts.check_confirmed = false,
                1 => facts.check_named = false,
                2 => facts.activation_advertised = false,
                3 => facts.selection_owner = x11rb::NONE,
                4 => facts.redirected = false,
                _ => active_atom = None,
            }
            assert!(matches!(
                activation_route(&facts, active_atom),
                Err(PlatformError::Unsupported(_))
            ));
        }
    }

    #[test]
    fn activation_never_forces_focus_when_manager_authority_is_ambiguous() {
        let unmanaged = || WindowManagerFacts {
            check_window: None,
            check_confirmed: false,
            check_named: false,
            selection_owner: x11rb::NONE,
            redirected: false,
            manager_hints: false,
            activation_advertised: false,
        };
        assert_eq!(
            activation_route(&unmanaged(), None).unwrap(),
            WindowActivationRoute::Unmanaged
        );
        for defect in 0..3 {
            let mut facts = unmanaged();
            match defect {
                0 => facts.selection_owner = 23,
                1 => facts.redirected = true,
                _ => facts.manager_hints = true,
            }
            assert!(matches!(
                activation_route(&facts, None),
                Err(PlatformError::Unsupported(_))
            ));
        }
    }

    #[test]
    fn activation_identity_requires_known_client_process_and_exact_geometry() {
        let expected = LinuxWindow {
            id: 50,
            process_id: Some(42),
            title: "Example editor".into(),
            bounds: LinuxWindowRect {
                x: 10,
                y: 20,
                width: 420,
                height: 180,
            },
        };
        let mut current = expected.clone();
        current.title = "Unsaved example editor".into();
        assert!(same_activation_window(&expected, &current));
        current.id += 1;
        assert!(!same_activation_window(&expected, &current));
        current = expected.clone();
        current.process_id = Some(43);
        assert!(!same_activation_window(&expected, &current));
        current = expected.clone();
        current.bounds.x += 1;
        assert!(!same_activation_window(&expected, &current));
        current = expected.clone();
        current.process_id = None;
        assert!(!same_activation_window(&current, &current));
    }

    #[test]
    fn active_window_property_accepts_one_client_with_optional_timestamp() {
        let kind = AtomEnum::WINDOW.into();
        assert_eq!(active_window_from_property(kind, 32, 0, &[50]), Some(50));
        assert_eq!(active_window_from_property(kind, 32, 0, &[50, 0]), Some(50));
        assert_eq!(
            active_window_from_property(kind, 32, 0, &[50, 123_456]),
            Some(50)
        );
        assert_ne!(
            active_window_from_property(kind, 32, 0, &[51, 50]),
            Some(50)
        );
    }

    #[test]
    fn active_window_property_refuses_malformed_or_unbounded_values() {
        let kind = AtomEnum::WINDOW.into();
        assert_eq!(active_window_from_property(kind, 32, 0, &[]), None);
        assert_eq!(active_window_from_property(kind, 32, 0, &[50, 0, 0]), None);
        assert_eq!(active_window_from_property(kind, 32, 4, &[50, 0]), None);
        assert_eq!(active_window_from_property(kind, 16, 0, &[50]), None);
        assert_eq!(
            active_window_from_property(AtomEnum::CARDINAL.into(), 32, 0, &[50]),
            None
        );
        assert_eq!(active_window_from_property(x11rb::NONE, 32, 0, &[50]), None);
    }

    #[test]
    fn settled_focus_must_be_exact_client_or_bounded_descendant() {
        assert!(focus_descends_from(50, 50, |_| None));
        assert!(focus_descends_from(52, 50, |id| match id {
            52 => Some(51),
            51 => Some(50),
            _ => None,
        }));
        assert!(!focus_descends_from(51, 50, |_| Some(51)));
        assert!(!focus_descends_from(51, 50, |_| None));
        assert!(!focus_descends_from(x11rb::NONE, 50, |_| Some(50)));
        assert!(!focus_descends_from(1, 50, |_| Some(50)));
        assert!(!focus_descends_from(100, 50, |id| Some(id - 1)));
    }

    #[test]
    fn activation_failure_keeps_dispatch_uncertainty() {
        assert!(
            !LinuxWindowActivationError::before(PlatformError::Unsupported("fixture".into()))
                .dispatched
        );
        assert!(
            LinuxWindowActivationError::after(PlatformError::Timeout("fixture".into())).dispatched
        );
    }

    #[test]
    fn button_codes_map_to_x11_numbers() {
        assert_eq!(x_button_code(v1::PointerButton::Left), 1);
        assert_eq!(x_button_code(v1::PointerButton::Middle), 2);
        assert_eq!(x_button_code(v1::PointerButton::Right), 3);
        assert_eq!(x_button_code(v1::PointerButton::Unspecified), 1);
    }

    #[test]
    fn named_keys_resolve_and_text_falls_through() {
        assert_eq!(named_key_to_keysym("Enter"), Some(0xff0d));
        assert_eq!(named_key_to_keysym("ENTER"), Some(0xff0d));
        assert_eq!(named_key_to_keysym("Tab"), Some(0xff09));
        // A single printable char maps to its codepoint.
        assert_eq!(named_key_to_keysym("a"), Some(0x61));
        // A multi-char non-named string is not a single keysym.
        assert_eq!(named_key_to_keysym("hello"), None);
        assert_eq!(
            parse_named_key_chord("Control+c").unwrap(),
            vec![0xffe3, 0x63]
        );
        assert_eq!(
            parse_named_key_chord("CTRL+ENTER").unwrap(),
            vec![0xffe3, 0xff0d]
        );
        assert!(validate_linux_named_key_chord("NotARealKey").is_err());
        assert!(parse_named_key_chord("Control+Control+c").is_err());
        assert!(parse_named_key_chord("Control+").is_err());
    }

    #[test]
    fn core_keymap_preserves_shifted_text_glyphs() {
        // keycode 8: a/A; keycode 9: -/_; later XKB groups are not guessed.
        let keysyms = [0x61, 0x41, 0, 0, 0x2d, 0x5f, 0, 0];
        assert_eq!(
            resolve_keysym(8, 4, &keysyms, 0x61),
            Some(X11KeyStroke {
                keycode: 8,
                shift: false,
            })
        );
        assert_eq!(
            resolve_keysym(8, 4, &keysyms, 0x41),
            Some(X11KeyStroke {
                keycode: 8,
                shift: true,
            })
        );
        assert_eq!(
            resolve_keysym(8, 4, &keysyms, 0x5f),
            Some(X11KeyStroke {
                keycode: 9,
                shift: true,
            })
        );
        assert_eq!(resolve_keysym(8, 4, &keysyms, 0x100), None);
    }

    #[test]
    fn virtual_display_heuristic() {
        assert!(is_virtual_display(":99"));
        assert!(is_virtual_display(":100.0"));
        assert!(!is_virtual_display(":0"));
        assert!(!is_virtual_display(":1"));
    }

    #[test]
    fn zpixmap_bgrx_to_rgba_swaps_channels() {
        // One 2x1 image, BGRX: pixel0 = (B=1,G=2,R=3,X=0), pixel1 = (B=4,G=5,R=6,X=0).
        let data = [1u8, 2, 3, 0, 4, 5, 6, 0];
        let rgba = zpixmap_to_rgba(&data, 2, 1, 24);
        assert_eq!(rgba, vec![3, 2, 1, 0xff, 6, 5, 4, 0xff]);
    }

    #[test]
    fn zpixmap_honors_row_padding_stride() {
        // A 1px-wide, 2-row image where each scanline is padded from the tight
        // 4 bytes (1px * 4bpp) to an 8-byte stride. If the converter ignored the
        // padding it would read row 1 from the padding bytes of row 0 and shear.
        //   row0: pixel (B=1,G=2,R=3,X) + 4 pad bytes
        //   row1: pixel (B=4,G=5,R=6,X) + 4 pad bytes
        let data = [
            1u8, 2, 3, 0, 0xAA, 0xBB, 0xCC, 0xDD, // row 0: pixel + padding
            4, 5, 6, 0, 0xAA, 0xBB, 0xCC, 0xDD, // row 1: pixel + padding
        ];
        let rgba = zpixmap_to_rgba(&data, 1, 2, 32);
        // Expect the two REAL pixels (RGBA), not the padding.
        assert_eq!(rgba, vec![3, 2, 1, 0xff, 6, 5, 4, 0xff]);
    }

    #[test]
    fn zpixmap_tight_32bpp_has_no_padding() {
        // A 2x2 tight 32bpp buffer: stride == width*bpp, so no rows are skipped.
        let data = [
            1u8, 2, 3, 0, 4, 5, 6, 0, // row 0: px(B1G2R3) px(B4G5R6)
            7, 8, 9, 0, 10, 11, 12, 0, // row 1: px(B7G8R9) px(B10G11R12)
        ];
        let rgba = zpixmap_to_rgba(&data, 2, 2, 24);
        assert_eq!(
            rgba,
            vec![
                3, 2, 1, 0xff, 6, 5, 4, 0xff, // row 0
                9, 8, 7, 0xff, 12, 11, 10, 0xff, // row 1
            ]
        );
    }

    #[test]
    fn encode_png_produces_a_valid_signature() {
        // 1x1 white pixel → a decodable PNG (magic bytes present).
        let rgba = [0xff, 0xff, 0xff, 0xff];
        let png = encode_png(&rgba, 1, 1).expect("encode");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
