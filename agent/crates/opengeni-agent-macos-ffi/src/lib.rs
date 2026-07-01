//! macOS desktop FFI, wrapped behind a small **safe** API.
//!
//! This is the leaf crate that lets the OpenGeni agent's desktop backend drive a
//! real Mac: ScreenCaptureKit screenshots, CGEvent synthetic input, and the TCC
//! (Screen Recording + Accessibility) preflight/grant calls. All of that is Apple
//! FFI — `objc2` message sends, C functions, ARC/pointer handoff — which is
//! inherently `unsafe`.
//!
//! # Why this crate exists (the `unsafe_code` boundary)
//!
//! The agent workspace pins `unsafe_code = "forbid"` (`agent/Cargo.toml`). A
//! scoped `#[allow(unsafe_code)]` inside a crate that inherits that `forbid` does
//! not compile (`E0453`). So this one leaf crate lowers *itself* to
//! `unsafe_code = "deny"` (see its `Cargo.toml`) and confines **every** `unsafe`
//! to the single [`ffi`] module (declared with `#[allow(unsafe_code)]`). The rest
//! of the crate — and every *other* crate in the workspace, including
//! `opengeni-agent-platform` which calls this crate — keeps `forbid`/`deny`
//! intact and only ever touches the safe wrappers below.
//!
//! # Portability
//!
//! Everything native is `#[cfg(target_os = "macos")]`. On any other target the
//! public functions are honest stubs (`None` / [`MacFfiError::Unsupported`]) so
//! the crate is a warning-clean skeleton that the workspace still compiles for
//! Linux/Windows — the objc2 dependencies are themselves cfg-gated to macOS and
//! are pulled in on no other platform.
//!
//! # Coordinates
//!
//! [`capture_rgba`] returns pixel-sized RGBA (already BGRA→RGBA swapped);
//! [`probe_display`] reports the same *pixel* dimensions. [`inject`] receives
//! pointer coordinates in that pixel space and converts them to the global
//! display **points** CGEvent expects, using the display's backing scale — the
//! same point-vs-pixel care the Linux X11 backend takes.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod ffi;

/// A probed display: an opaque id plus its **pixel** dimensions (the size a
/// captured frame will be, so a viewer canvas matches 1:1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    /// Opaque platform display id (the `CGDirectDisplayID`, rendered as a string).
    pub id: String,
    /// Display width in pixels.
    pub width: u32,
    /// Display height in pixels.
    pub height: u32,
}

/// A captured frame: tightly-packed RGBA8 pixels plus their geometry. The caller
/// (the platform crate) PNG-encodes this; encoding deliberately does not live
/// here so this crate stays a thin FFI leaf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaFrame {
    /// Tightly-packed RGBA8 bytes (`width * height * 4`), already BGRA→RGBA swapped.
    pub rgba: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
}

/// A pointer button. Small crate-local mirror of the wire `PointerButton` so this
/// leaf crate has no proto dependency; the platform crate does the mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    /// Primary (left) button.
    Left,
    /// Secondary (right) button.
    Right,
    /// Tertiary (middle) button.
    Middle,
}

/// A pointer action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerAction {
    /// Move the cursor only.
    Move,
    /// Press the button (no release).
    Down,
    /// Release the button.
    Up,
    /// Press then release once.
    Click,
    /// Press/release twice.
    DoubleClick,
}

/// A key action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    /// Key down only.
    Down,
    /// Key up only.
    Up,
    /// Down then up.
    Press,
}

/// One computer-use input event. A small, plain, proto-free mirror the platform
/// crate maps `v1::DesktopInput` onto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// A pointer move/press/release/click at a pixel coordinate.
    Pointer {
        /// X in captured-frame pixels.
        x: i32,
        /// Y in captured-frame pixels.
        y: i32,
        /// Which button the action applies to.
        button: PointerButton,
        /// What to do.
        action: PointerAction,
    },
    /// A key event. Exactly one of `text` (verbatim text to type via the Unicode
    /// path) or `named` (a named key such as `"Enter"`/`"ArrowLeft"`) is set.
    Key {
        /// Verbatim text to type (Unicode string path); `None` for named keys.
        text: Option<String>,
        /// A named key (`"Enter"`, `"Tab"`, `"ArrowUp"`, …); `None` for text.
        named: Option<String>,
        /// Down / up / press.
        action: KeyAction,
    },
    /// A scroll gesture by line deltas at the current cursor position.
    Scroll {
        /// Horizontal delta (lines).
        dx: i32,
        /// Vertical delta (lines).
        dy: i32,
    },
}

/// Errors from the macOS FFI leaf.
#[derive(Debug, thiserror::Error)]
pub enum MacFfiError {
    /// The macOS desktop backend is not available in this build/target (non-macOS,
    /// or the objc2 path is compiled out).
    #[error("macOS desktop backend unsupported: {0}")]
    Unsupported(String),
    /// A native ScreenCaptureKit / CGEvent / CoreGraphics call failed.
    #[error("macOS desktop FFI error: {0}")]
    Ffi(String),
}

/// Probes the main display, returning its id + **pixel** geometry, or `None` when
/// Screen Recording has not been granted (non-prompting preflight) or there is no
/// GUI session. `None` is the honest "no display" the control plane degrades to
/// `display_unavailable`.
#[must_use]
pub fn probe_display() -> Option<DisplayInfo> {
    #[cfg(target_os = "macos")]
    {
        ffi::probe_display()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Captures the main display as pixel-sized RGBA (BGRA→RGBA already swapped).
///
/// # Errors
///
/// Returns [`MacFfiError`] if Screen Recording is not granted, ScreenCaptureKit
/// returns no image, or the pixel copy fails.
pub fn capture_rgba() -> Result<RgbaFrame, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::capture_rgba()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(MacFfiError::Unsupported(
            "screen capture is only available on macOS".to_string(),
        ))
    }
}

/// Injects one computer-use input event via CGEvent.
///
/// The caller is responsible for gating on the Accessibility grant
/// ([`accessibility_trusted`]); without it macOS silently drops posted events.
///
/// # Errors
///
/// Returns [`MacFfiError`] if the event could not be constructed/posted.
pub fn inject(input: &InputEvent) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::inject(input)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = input;
        Err(MacFfiError::Unsupported(
            "input injection is only available on macOS".to_string(),
        ))
    }
}

/// Whether Screen Recording (`kTCCServiceScreenCapture`) is granted, via the
/// non-prompting `CGPreflightScreenCaptureAccess`. `false` on non-macOS.
#[must_use]
pub fn screen_capture_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        ffi::screen_capture_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Whether this process is Accessibility-trusted (`AXIsProcessTrusted`), required
/// for `CGEventPost` to be delivered to other apps. `false` on non-macOS.
#[must_use]
pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        ffi::accessibility_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Fires the two TCC system prompts once (Screen Recording via
/// `CGRequestScreenCaptureAccess`, Accessibility via `AXIsProcessTrustedWithOptions`
/// with the prompt option). Only the on-machine process can trigger these; the
/// user still flips the toggles in System Settings. No-op on non-macOS.
pub fn request_grants() {
    #[cfg(target_os = "macos")]
    {
        ffi::request_grants();
    }
}
