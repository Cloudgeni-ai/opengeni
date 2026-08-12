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
//! [`capture_rgba`] retains the legacy main-display framebuffer contract;
//! [`list_displays`], [`capture_display_rgba`], and [`inject_display_batch`]
//! expose every display independently. Pointer coordinates remain local capture
//! pixels and are mapped through that exact display/window's global logical
//! bounds before CGEvent posting—the same point-vs-pixel care the Linux X11
//! backend takes.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod ffi;

/// A probed display: an opaque id plus its **pixel** dimensions (the size a
/// captured frame will be, so a viewer canvas matches 1:1).
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayInfo {
    /// Opaque platform display id (the `CGDirectDisplayID`, rendered as a string).
    pub id: String,
    /// Display width in pixels.
    pub width: u32,
    /// Display height in pixels.
    pub height: u32,
    /// Display width in logical points.
    pub point_width: f64,
    /// Display height in logical points.
    pub point_height: f64,
    /// Left edge in the global macOS logical-point space.
    pub point_x: f64,
    /// Top edge in the global macOS logical-point space.
    pub point_y: f64,
    /// Whether this is the menu-bar/main display.
    pub is_main: bool,
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

/// Rectangle in the global macOS logical-point coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MacRect {
    /// Left edge in global points.
    pub x: f64,
    /// Top edge in global points.
    pub y: f64,
    /// Width in points.
    pub width: f64,
    /// Height in points.
    pub height: f64,
}

/// A ScreenCaptureKit window capture plus the logical placement that produced it.
#[derive(Debug, Clone, PartialEq)]
pub struct MacWindowFrame {
    /// Exact captured window id.
    pub window_id: u32,
    /// Window placement in global logical points at capture time.
    pub bounds: MacRect,
    /// Pixel-sized captured image.
    pub frame: RgbaFrame,
}

/// One retained, bounded ScreenCaptureKit live-frame producer.
///
/// The native stream owns a dedicated thread and latest-frame slot. Dropping it
/// synchronously stops ScreenCaptureKit and joins that owner thread.
#[cfg(target_os = "macos")]
pub struct MacFrameStream {
    inner: ffi::CaptureStream,
}

/// Non-macOS placeholder preserving the cross-platform public API.
#[cfg(not(target_os = "macos"))]
pub struct MacFrameStream;

impl MacFrameStream {
    /// Waits for and returns the next fresh bounded RGBA frame.
    ///
    /// # Errors
    ///
    /// Returns a typed capture failure when the stream stops or produces no
    /// fresh frame within its bounded deadline.
    pub fn next_frame(&self) -> Result<RgbaFrame, MacFfiError> {
        #[cfg(target_os = "macos")]
        {
            self.inner.next_frame()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(MacFfiError::Unsupported(
                "live display capture is only available on macOS".to_string(),
            ))
        }
    }

    /// Stops the native producer. Idempotent.
    pub fn stop(&self) {
        #[cfg(target_os = "macos")]
        self.inner.stop();
    }
}

/// A macOS Accessibility target class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacTargetKind {
    /// One running GUI application.
    Application,
    /// One application window.
    Window,
}

/// The immutable properties used to verify that a re-resolved AX element is the
/// same one observed previously. Empty/unsupported attributes stay `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxFingerprint {
    /// AX role.
    pub role: String,
    /// AX subrole.
    pub subrole: Option<String>,
    /// Application-provided automation identifier.
    pub identifier: Option<String>,
    /// Element title.
    pub title: Option<String>,
    /// Logical screen bounds when exposed.
    pub bounds: Option<MacRect>,
}

/// One verified step from an AX snapshot root to a descendant.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxPathStep {
    /// Index in the parent's current `AXChildren` array.
    pub child_index: u32,
    /// Fingerprint that must still match after resolving the index.
    pub fingerprint: MacAxFingerprint,
}

/// AX window selector used to re-resolve a window without retaining native
/// handles across requests.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxWindowSelector {
    /// Index in the application's observed `AXWindows` array.
    pub window_index: u32,
    /// Window fingerprint at observation time.
    pub fingerprint: MacAxFingerprint,
}

/// A complete observation-backed AX selector. The root fingerprint and every
/// child step are verified immediately before a semantic mutation.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxElementSelector {
    /// Opaque FFI-worker snapshot generation that owns the retained AX object.
    pub snapshot_id: String,
    /// Snapshot-local element key used for the retained-object lookup.
    pub element_key: String,
    /// Window root for window-scoped trees; `None` means the application root.
    pub window: Option<MacAxWindowSelector>,
    /// Snapshot root fingerprint.
    pub root: MacAxFingerprint,
    /// Semantic state observed for this exact retained element. This is checked
    /// again immediately before mutation so missed AX notifications cannot turn
    /// an old observation into a blind action.
    pub observed_state: MacAxObservedState,
    /// Verified child path from the root.
    pub path: Vec<MacAxPathStep>,
}

/// Observation-time state checked immediately before an AX mutation. Identity
/// remains in [`MacAxFingerprint`]; this separately fences mutable semantics.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxObservedState {
    /// Accessible description/help.
    pub description: Option<String>,
    /// Visible or redacted value.
    pub value: Option<MacAxValue>,
    /// Enabled state when exposed.
    pub enabled: Option<bool>,
    /// Focus state when exposed.
    pub focused: Option<bool>,
    /// Busy state when exposed.
    pub busy: Option<bool>,
    /// Minimized state when exposed.
    pub minimized: Option<bool>,
    /// Selection state when exposed.
    pub selected: Option<bool>,
    /// Expansion state when exposed.
    pub expanded: Option<bool>,
}

/// One currently available macOS app/window target. This contains no native
/// object handles and is safe to retain only as an observation fence.
#[derive(Debug, Clone, PartialEq)]
pub struct MacTargetInfo {
    /// Target class.
    pub kind: MacTargetKind,
    /// Running process id.
    pub process_id: u32,
    /// Exact process-launch generation (derived from AppKit's launch date).
    pub process_generation: String,
    /// Bundle identifier when available.
    pub application_id: Option<String>,
    /// Localized application name.
    pub application_name: String,
    /// Human-readable target title.
    pub title: String,
    /// Logical target bounds when known.
    pub bounds: Option<MacRect>,
    /// Whether the app/window owns focus.
    pub focused: bool,
    /// Exact ScreenCaptureKit window id when unambiguously correlated.
    pub window_id: Option<u32>,
    /// Exact AX window selector when Accessibility is available.
    pub ax_window: Option<MacAxWindowSelector>,
}

/// Plain AX value emitted by a bounded snapshot.
#[derive(Debug, Clone, PartialEq)]
pub enum MacAxValue {
    /// Visible string value.
    Text(String),
    /// Finite numeric value.
    Number(f64),
    /// Boolean value.
    Boolean(bool),
    /// Password/protected content; the real value is never read.
    Password,
}

/// One bounded, plain AX snapshot node.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxNode {
    /// Snapshot-local path key.
    pub key: String,
    /// Parent path key.
    pub parent_key: Option<String>,
    /// Deterministic sibling index.
    pub index_in_parent: i32,
    /// AX role.
    pub role: String,
    /// AX subrole.
    pub subrole: Option<String>,
    /// Application automation identifier.
    pub identifier: Option<String>,
    /// Accessible name/title.
    pub name: Option<String>,
    /// Accessible description/help.
    pub description: Option<String>,
    /// Visible or explicitly redacted value.
    pub value: Option<MacAxValue>,
    /// Normalized states.
    pub states: Vec<String>,
    /// Global logical bounds.
    pub bounds: Option<MacRect>,
    /// Normalized supported actions.
    pub actions: Vec<String>,
    /// Raw AX action names for diagnostics.
    pub raw_actions: Vec<String>,
    /// Exact observation-backed selector.
    pub selector: MacAxElementSelector,
    /// Whether children were intentionally omitted by the traversal envelope.
    pub children_truncated: bool,
}

/// One bounded semantic snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct MacAxSnapshot {
    /// Opaque worker-local generation owning the retained AX handles.
    pub snapshot_id: String,
    /// Exact target used for the snapshot.
    pub target: MacTargetInfo,
    /// Tree root keys (normally exactly one).
    pub root_keys: Vec<String>,
    /// Flat path-keyed nodes.
    pub nodes: Vec<MacAxNode>,
    /// Focused element key when present in the bounded tree.
    pub focused_key: Option<String>,
}

/// Stateful safe owner for retained macOS Accessibility observations.
///
/// Internally this owns one dedicated AX worker/run loop per observed process,
/// allowing independent applications to proceed concurrently while native
/// handles and AXObserver callbacks never leave the audited FFI boundary.
pub struct MacAxController {
    #[cfg(target_os = "macos")]
    inner: ffi::MacAxControllerImpl,
}

impl MacAxController {
    /// Opens the controller without prompting for TCC grants.
    ///
    /// # Errors
    ///
    /// Returns [`MacFfiError::PermissionDenied`] when Accessibility is absent.
    pub fn open() -> Result<Self, MacFfiError> {
        #[cfg(target_os = "macos")]
        {
            Ok(Self {
                inner: ffi::MacAxControllerImpl::open()?,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(MacFfiError::Unsupported(
                "macOS Accessibility is only available on macOS".to_string(),
            ))
        }
    }

    /// Builds a bounded snapshot and retains its AX objects until the target is
    /// observed again or an AX notification invalidates it.
    ///
    /// # Errors
    ///
    /// Returns a typed permission/stale/driver failure.
    pub fn snapshot(&self, target: &MacTargetInfo) -> Result<MacAxSnapshot, MacFfiError> {
        #[cfg(target_os = "macos")]
        {
            self.inner.snapshot(target)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(MacFfiError::Unsupported(
                "macOS Accessibility is only available on macOS".to_string(),
            ))
        }
    }

    /// Performs one action against the exact retained observation object,
    /// falling back to fully verified path re-resolution only if necessary.
    ///
    /// # Errors
    ///
    /// Returns stale if the observation was invalidated, unsupported if the
    /// object lacks the action, or outcome-unknown after an ambiguous mutation.
    pub fn perform_action(
        &self,
        target: &MacTargetInfo,
        selector: &MacAxElementSelector,
        action: &MacAxAction,
    ) -> Result<(), MacFfiError> {
        #[cfg(target_os = "macos")]
        {
            self.inner.perform_action(target, selector, action)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (target, selector, action);
            Err(MacFfiError::Unsupported(
                "macOS Accessibility is only available on macOS".to_string(),
            ))
        }
    }
}

/// Typed AX set-value payload.
#[derive(Debug, Clone, PartialEq)]
pub enum MacAxActionValue {
    /// String value.
    String(String),
    /// Finite number.
    Number(f64),
    /// Boolean value.
    Boolean(bool),
}

/// Semantic AX mutation.
#[derive(Debug, Clone, PartialEq)]
pub enum MacAxAction {
    /// Perform the default press/confirm action.
    Invoke,
    /// Focus the exact element.
    Focus,
    /// Replace its value.
    SetValue(MacAxActionValue),
    /// Increment numeric value.
    Increment,
    /// Decrement numeric value.
    Decrement,
    /// Select the element.
    Select,
    /// Deselect the element.
    Deselect,
    /// Expand the element.
    Expand,
    /// Collapse the element.
    Collapse,
    /// Open its context/menu action.
    ShowMenu,
    /// Ask Accessibility to reveal it.
    ScrollIntoView,
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
    /// Required TCC grant is absent.
    #[error("macOS permission denied: {0}")]
    PermissionDenied(String),
    /// The app/window target no longer matches its observed identity.
    #[error("macOS target stale: {0}")]
    TargetStale(String),
    /// The AX element path/fingerprint no longer matches its observation.
    #[error("macOS Accessibility selector stale: {0}")]
    SelectorStale(String),
    /// The exact element does not expose the requested semantic operation.
    #[error("macOS Accessibility action unsupported: {0}")]
    ActionUnsupported(String),
    /// The request was invalid before dispatch.
    #[error("invalid macOS computer action: {0}")]
    Invalid(String),
    /// A bounded native operation timed out.
    #[error("macOS computer operation timed out: {0}")]
    TimedOut(String),
    /// A native mutation was attempted but its exact outcome is unknowable.
    #[error("macOS computer action outcome unknown: {0}")]
    OutcomeUnknown(String),
    /// Physical input won the shared macOS input seat before dispatch.
    #[error("macOS computer action interrupted by physical input: {0}")]
    InputInterrupted(String),
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

/// Enumerates all active macOS displays with pixel capture size and global
/// logical-point placement. This does not prompt for Screen Recording access.
///
/// # Errors
///
/// Returns [`MacFfiError`] if CoreGraphics cannot enumerate a usable GUI seat.
pub fn list_displays() -> Result<Vec<DisplayInfo>, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::list_displays()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(MacFfiError::Unsupported(
            "display enumeration is only available on macOS".to_string(),
        ))
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

/// Captures one exact active display by its opaque [`DisplayInfo::id`].
///
/// # Errors
///
/// Returns permission denied when Screen Recording is absent, target stale when
/// the display disappeared, or a typed native capture failure.
pub fn capture_display_rgba(display_id: &str) -> Result<RgbaFrame, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        let display_id = display_id.parse::<u32>().map_err(|_| {
            MacFfiError::Invalid("macOS display id is not a CGDirectDisplayID".to_string())
        })?;
        ffi::capture_display_rgba(display_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display_id;
        Err(MacFfiError::Unsupported(
            "display capture is only available on macOS".to_string(),
        ))
    }
}

/// Captures one display while asking ScreenCaptureKit to scale directly into a
/// bounded live-view surface instead of copying a full Retina framebuffer.
///
/// # Errors
///
/// Returns the same typed failures as [`capture_display_rgba`].
pub fn capture_display_rgba_sized(
    display_id: &str,
    max_width: u32,
    max_height: u32,
) -> Result<RgbaFrame, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        let display_id = display_id.parse::<u32>().map_err(|_| {
            MacFfiError::Invalid("macOS display id is not a CGDirectDisplayID".to_string())
        })?;
        ffi::capture_display_rgba_sized(display_id, Some((max_width, max_height)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (display_id, max_width, max_height);
        Err(MacFfiError::Unsupported(
            "display capture is only available on macOS".to_string(),
        ))
    }
}

/// Starts one retained ScreenCaptureKit stream for an exact display.
///
/// # Errors
///
/// Returns permission denied, target stale, timeout, or a native stream failure.
pub fn start_display_frame_stream(
    display_id: &str,
    max_width: u32,
    max_height: u32,
) -> Result<MacFrameStream, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        let display_id = display_id.parse::<u32>().map_err(|_| {
            MacFfiError::Invalid("macOS display id is not a CGDirectDisplayID".to_string())
        })?;
        if !ffi::screen_capture_granted() {
            return Err(MacFfiError::PermissionDenied(
                "Screen Recording permission is required for live display capture".to_string(),
            ));
        }
        Ok(MacFrameStream {
            inner: ffi::CaptureStream::start_display(display_id, (max_width, max_height))?,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (display_id, max_width, max_height);
        Err(MacFfiError::Unsupported(
            "live display capture is only available on macOS".to_string(),
        ))
    }
}

/// Enumerates running GUI applications and their AX/SCK windows without
/// retaining native handles.
///
/// # Errors
///
/// Returns [`MacFfiError`] when AppKit cannot enumerate the current GUI seat.
pub fn list_targets() -> Result<Vec<MacTargetInfo>, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::list_targets()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(MacFfiError::Unsupported(
            "macOS app discovery is only available on macOS".to_string(),
        ))
    }
}

/// Captures one exact ScreenCaptureKit window independently of occlusion.
///
/// # Errors
///
/// Returns [`MacFfiError`] if Screen Recording is absent, the window vanished,
/// or ScreenCaptureKit could not return a bounded image.
pub fn capture_window_rgba(
    window_id: u32,
    expected_process_id: u32,
) -> Result<MacWindowFrame, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::capture_window_rgba(window_id, expected_process_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window_id, expected_process_id);
        Err(MacFfiError::Unsupported(
            "macOS window capture is only available on macOS".to_string(),
        ))
    }
}

/// Captures one exact window into a bounded live-view surface.
///
/// # Errors
///
/// Returns the same typed failures as [`capture_window_rgba`].
pub fn capture_window_rgba_sized(
    window_id: u32,
    expected_process_id: u32,
    max_width: u32,
    max_height: u32,
) -> Result<MacWindowFrame, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::capture_window_rgba_sized(
            window_id,
            expected_process_id,
            Some((max_width, max_height)),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window_id, expected_process_id, max_width, max_height);
        Err(MacFfiError::Unsupported(
            "macOS window capture is only available on macOS".to_string(),
        ))
    }
}

/// Starts one retained ScreenCaptureKit stream for an exact window.
///
/// # Errors
///
/// Returns permission denied, target stale, timeout, or a native stream failure.
pub fn start_window_frame_stream(
    window_id: u32,
    expected_process_id: u32,
    max_width: u32,
    max_height: u32,
) -> Result<MacFrameStream, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        if !ffi::screen_capture_granted() {
            return Err(MacFfiError::PermissionDenied(
                "Screen Recording permission is required for live window capture".to_string(),
            ));
        }
        Ok(MacFrameStream {
            inner: ffi::CaptureStream::start_window(
                window_id,
                expected_process_id,
                (max_width, max_height),
            )?,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window_id, expected_process_id, max_width, max_height);
        Err(MacFfiError::Unsupported(
            "live window capture is only available on macOS".to_string(),
        ))
    }
}

/// Activates and raises one exact app/window target.
///
/// # Errors
///
/// Returns [`MacFfiError`] if the process/window is stale or activation fails.
pub fn focus_target(target: &MacTargetInfo) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::focus_target(target)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(MacFfiError::Unsupported(
            "macOS application focus is only available on macOS".to_string(),
        ))
    }
}

/// Launches an installed macOS application by bundle identifier.
///
/// # Errors
///
/// Returns [`MacFfiError`] if no installed application matches or LaunchServices
/// rejects the launch.
pub fn launch_application(application_id: &str) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::launch_application(application_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = application_id;
        Err(MacFfiError::Unsupported(
            "macOS application launch is only available on macOS".to_string(),
        ))
    }
}

/// Runs one new macOS application instance without allowing its startup to
/// steal the user's foreground application.
///
/// The call remains blocked for the launched application's lifetime. This is
/// intentional: browser supervisors use the helper process as their exact
/// lifecycle fence. The new application is hidden during its bounded startup
/// window, while a later explicit [`focus_target`] remains free to reveal it.
///
/// # Errors
///
/// Returns [`MacFfiError`] if the bundle path or arguments are invalid,
/// LaunchServices rejects the launch, or the launched process cannot be
/// resolved.
pub fn run_background_application(
    application_bundle: &std::path::Path,
    arguments: &[String],
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        let bundle = application_bundle.to_str().ok_or_else(|| {
            MacFfiError::Invalid("application bundle path is not valid UTF-8".to_string())
        })?;
        ffi::run_background_application(bundle, arguments)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (application_bundle, arguments);
        Err(MacFfiError::Unsupported(
            "background application launch is only available on macOS".to_string(),
        ))
    }
}

/// Injects one computer-use input event via CGEvent.
///
/// The caller is responsible for gating on Accessibility and Input Monitoring;
/// without them macOS cannot deliver input safely around a local user.
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

/// Injects one bounded input operation after validating and constructing every
/// CGEvent, so event construction cannot fail midway through native posting.
///
/// # Errors
///
/// Returns [`MacFfiError`] before dispatch if the batch is invalid, too large,
/// unknown, or cannot be fully constructed.
pub fn inject_batch(inputs: &[InputEvent]) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::inject_batch(inputs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = inputs;
        Err(MacFfiError::Unsupported(
            "input injection is only available on macOS".to_string(),
        ))
    }
}

/// Injects one preconstructed bounded operation whose pointer coordinates are
/// local pixels in an exact display capture.
///
/// # Errors
///
/// Returns [`MacFfiError`] if the display/frame geometry or any input is invalid
/// before native posting.
pub fn inject_display_batch(
    display: &DisplayInfo,
    frame_width: u32,
    frame_height: u32,
    inputs: &[InputEvent],
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::inject_display_batch(display, frame_width, frame_height, inputs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (display, frame_width, frame_height, inputs);
        Err(MacFfiError::Unsupported(
            "display input is only available on macOS".to_string(),
        ))
    }
}

/// Injects an event whose pointer coordinates are local pixels in an exact
/// captured window. The FFI maps those pixels to current global logical points;
/// keyboard/scroll events are unchanged.
///
/// # Errors
///
/// Returns [`MacFfiError`] if geometry is invalid or the event cannot be posted.
pub fn inject_window(
    input: &InputEvent,
    logical_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::inject_window(input, logical_bounds, frame_width, frame_height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (input, logical_bounds, frame_width, frame_height);
        Err(MacFfiError::Unsupported(
            "macOS window input is only available on macOS".to_string(),
        ))
    }
}

/// Injects one atomic batch of frame-local events into an already-frontmost
/// window. This function never activates or focuses an application.
///
/// # Errors
///
/// Returns [`MacFfiError`] if geometry is invalid or the batch cannot be posted.
pub fn inject_window_batch(
    inputs: &[InputEvent],
    logical_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::inject_window_batch(inputs, logical_bounds, frame_width, frame_height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (inputs, logical_bounds, frame_width, frame_height);
        Err(MacFfiError::Unsupported(
            "macOS window input is only available on macOS".to_string(),
        ))
    }
}

/// Focuses one exact AX window, rechecks its current logical placement, then
/// posts a bounded batch of frame-local events without yielding to caller code.
///
/// # Errors
///
/// Returns stale before focus when the window identity changed. Any failure
/// after focus is [`MacFfiError::OutcomeUnknown`] and must never be replayed.
pub fn focus_and_inject_window(
    target: &MacTargetInfo,
    expected_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
    inputs: &[InputEvent],
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::focus_and_inject_window(target, expected_bounds, frame_width, frame_height, inputs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (target, expected_bounds, frame_width, frame_height, inputs);
        Err(MacFfiError::Unsupported(
            "macOS window input is only available on macOS".to_string(),
        ))
    }
}

/// Focuses one exact app/window target, then posts a preconstructed bounded
/// keyboard/input operation without yielding to caller code.
///
/// # Errors
///
/// Returns a definite error when preparation or target validation fails before
/// focus. Any failure after focus is [`MacFfiError::OutcomeUnknown`].
pub fn focus_and_inject_target(
    target: &MacTargetInfo,
    inputs: &[InputEvent],
) -> Result<(), MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::focus_and_inject_target(target, inputs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (target, inputs);
        Err(MacFfiError::Unsupported(
            "macOS targeted input is only available on macOS".to_string(),
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

/// Returns whether macOS Input Monitoring allows the passive event tap used to
/// make synthetic keyboard/pointer fallback yield to physical user input.
#[must_use]
pub fn input_monitoring_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        ffi::input_monitoring_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Returns whether the current macOS login session is screen-locked.
///
/// This is a read-only CoreGraphics session query. It does not attempt any
/// privileged unlock mechanism.
///
/// # Errors
///
/// Returns [`MacFfiError`] when CoreGraphics exposes no current GUI-session
/// dictionary, so callers can fail closed instead of assuming an unlocked Mac.
pub fn machine_locked() -> Result<bool, MacFfiError> {
    #[cfg(target_os = "macos")]
    {
        ffi::machine_locked()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(MacFfiError::Unsupported(
            "macOS lock state is only available on macOS".to_string(),
        ))
    }
}

/// Fires the three TCC system prompts once (Screen Recording, Input Monitoring,
/// and Accessibility). Only the on-machine process can trigger these; the user
/// still flips the toggles in System Settings. No-op on non-macOS.
pub fn request_grants() {
    #[cfg(target_os = "macos")]
    {
        ffi::request_grants();
    }
}
