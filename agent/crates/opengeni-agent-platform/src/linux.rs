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
    Atom, AtomEnum, ConfigureWindowAux, ConnectionExt as _, ImageFormat, InputFocus, MapState,
    Screen, StackMode, Window,
};

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

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
        tokio::task::spawn_blocking(move || this.windows_blocking())
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
        tokio::task::spawn_blocking(move || this.capture_window_blocking(window_id))
            .await
            .map_err(|error| PlatformError::os(format!("X11 window capture task join: {error}")))?
    }

    /// Captures the complete screen as tightly packed RGBA8 without an
    /// intermediate image encode. Intended for a placement-local live encoder.
    pub async fn capture_rgba(&self) -> PlatformResult<LinuxRgbaFrame> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.capture_rgba_blocking())
            .await
            .map_err(|error| PlatformError::os(format!("X11 RGBA capture task join: {error}")))?
    }

    /// Captures one XComposite-backed window as RGBA8, including while it is
    /// occluded, without an intermediate PNG encode.
    pub async fn capture_window_rgba(
        &self,
        window_id: u32,
    ) -> PlatformResult<LinuxRgbaFrame> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.capture_window_rgba_blocking(window_id))
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
        tokio::task::spawn_blocking(move || {
            this.inject_window_blocking(window_id, expected_bounds, &inputs)
        })
        .await
        .map_err(|error| PlatformError::os(format!("X11 window input task join: {error}")))?
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
        tokio::task::spawn_blocking(move || this.capture_blocking())
            .await
            .map_err(|e| PlatformError::os(format!("capture task join: {e}")))?
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let this = self.clone();
        let input = input.clone();
        tokio::task::spawn_blocking(move || this.inject_blocking(std::slice::from_ref(&input)))
            .await
            .map_err(|e| PlatformError::os(format!("inject task join: {e}")))?
    }
}

impl LinuxDesktop {
    /// Captures the root window via `GetImage` and PNG-encodes it. Runs on the
    /// blocking pool (x11rb is synchronous).
    fn capture_blocking(&self) -> PlatformResult<CapturedFrame> {
        encode_captured_png(self.capture_rgba_blocking()?)
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
        encode_captured_png(self.capture_window_rgba_blocking(window_id)?)
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

fn inject_inputs(
    conn: &x11rb::rust_connection::RustConnection,
    root: Window,
    inputs: &[v1::DesktopInput],
) -> PlatformResult<()> {
    for input in inputs {
        let Some(event) = &input.event else {
            return Err(PlatformError::os("DesktopInput carried no event"));
        };
        match event {
            v1::desktop_input::Event::Pointer(p) => inject_pointer(conn, root, p)?,
            v1::desktop_input::Event::Key(k) => inject_key(conn, root, k)?,
            v1::desktop_input::Event::Scroll(s) => inject_scroll(conn, root, s)?,
        }
    }
    conn.flush()
        .map_err(|e| PlatformError::os(format!("XTEST flush: {e}")))?;
    // A reply round-trip surfaces an asynchronous X error rather than only
    // confirming that bytes entered the local socket buffer.
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
        .map_err(|e| PlatformError::os(format!("XTEST motion: {e}")))?;

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

/// Maps a [`KeyEvent`](v1::KeyEvent) to XTEST key press/release. A keysym is
/// resolved to a keycode via the connection's keymap; text typing presses each
/// character's keysym in turn.
fn inject_key(
    conn: &x11rb::rust_connection::RustConnection,
    _root: x11rb::protocol::xproto::Window,
    k: &v1::KeyEvent,
) -> PlatformResult<()> {
    if k.is_text {
        // Text remains best-effort for the legacy X11 fallback. Reliable
        // arbitrary UTF-8 entry uses the native clipboard write + paste path.
        for keysym in k.key.chars().map(|character| character as u32) {
            let Some(keycode) = keysym_to_keycode(conn, keysym) else {
                continue;
            };
            match k.action() {
                v1::KeyAction::Down => key_press(conn, keycode)?,
                v1::KeyAction::Up => key_release(conn, keycode)?,
                v1::KeyAction::Press | v1::KeyAction::Unspecified => {
                    key_press(conn, keycode)?;
                    key_release(conn, keycode)?;
                }
            }
        }
        return Ok(());
    }

    let keysyms = parse_named_key_chord(&k.key)?;
    let keycodes = keysyms
        .iter()
        .map(|keysym| {
            keysym_to_keycode(conn, *keysym).ok_or_else(|| {
                PlatformError::Unsupported(format!(
                    "X11 keymap does not expose named key/chord component {keysym:#x}"
                ))
            })
        })
        .collect::<PlatformResult<Vec<_>>>()?;
    match k.action() {
        v1::KeyAction::Down => {
            for keycode in &keycodes {
                key_press(conn, *keycode)?;
            }
        }
        v1::KeyAction::Up => {
            for keycode in keycodes.iter().rev() {
                key_release(conn, *keycode)?;
            }
        }
        v1::KeyAction::Press | v1::KeyAction::Unspecified => {
            let (key, modifiers) = keycodes
                .split_last()
                .expect("validated named chord always contains one key");
            for modifier in modifiers {
                key_press(conn, *modifier)?;
            }
            key_press(conn, *key)?;
            key_release(conn, *key)?;
            for modifier in modifiers.iter().rev() {
                key_release(conn, *modifier)?;
            }
        }
    }
    Ok(())
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
        .map_err(|e| PlatformError::os(format!("XTEST scroll motion: {e}")))?;

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
        .map_err(|e| PlatformError::os(format!("XTEST button press: {e}")))?;
    Ok(())
}

fn release(conn: &x11rb::rust_connection::RustConnection, button: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(BUTTON_RELEASE, button, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST button release: {e}")))?;
    Ok(())
}

fn key_press(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_PRESS, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key press: {e}")))?;
    Ok(())
}

fn key_release(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_RELEASE, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key release: {e}")))?;
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

/// Resolves an X11 keysym to a keycode by scanning the server keymap. Returns
/// `None` if the keysym is not bound, so a best-effort type skips it.
fn keysym_to_keycode(conn: &x11rb::rust_connection::RustConnection, keysym: u32) -> Option<u8> {
    let setup = conn.setup();
    let min = setup.min_keycode;
    let max = setup.max_keycode;
    let count = max - min + 1;
    let mapping = conn.get_keyboard_mapping(min, count).ok()?.reply().ok()?;
    let per = mapping.keysyms_per_keycode as usize;
    for (i, chunk) in mapping.keysyms.chunks(per).enumerate() {
        if chunk.contains(&keysym) {
            let code = min as usize + i;
            return u8::try_from(code).ok();
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
    let sym = match name {
        "Enter" | "Return" => 0xff0d,
        "Tab" => 0xff09,
        "Escape" | "Esc" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "Space" | " " => 0x0020,
        "ArrowLeft" | "Left" => 0xff51,
        "ArrowUp" | "Up" => 0xff52,
        "ArrowRight" | "Right" => 0xff53,
        "ArrowDown" | "Down" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        other => {
            // A single printable char maps to its codepoint (Latin-1 keysym range).
            let mut chars = other.chars();
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

fn encode_captured_png(frame: LinuxRgbaFrame) -> PlatformResult<CapturedFrame> {
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
        assert_eq!(named_key_to_keysym("Tab"), Some(0xff09));
        // A single printable char maps to its codepoint.
        assert_eq!(named_key_to_keysym("a"), Some(0x61));
        // A multi-char non-named string is not a single keysym.
        assert_eq!(named_key_to_keysym("hello"), None);
        assert_eq!(
            parse_named_key_chord("Control+c").unwrap(),
            vec![0xffe3, 0x63]
        );
        assert!(parse_named_key_chord("Control+Control+c").is_err());
        assert!(parse_named_key_chord("Control+").is_err());
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
