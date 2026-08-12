use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Platform-neutral ComputerSession capabilities discovered at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct NativeCapabilities {
    /// Semantic accessibility tree is available.
    pub semantic_observation: bool,
    /// Applications can be discovered.
    pub app_discovery: bool,
    /// Applications can be launched by platform identifier.
    pub app_launch: bool,
    /// Individual windows can be captured.
    pub window_capture: bool,
    /// Whole-seat capture is available.
    pub screen_capture: bool,
    /// Accessibility actions are available.
    pub semantic_actions: bool,
    /// Pointer input is available.
    pub pointer_input: bool,
    /// Keyboard input is available.
    pub keyboard_input: bool,
    /// The graphical seat's native text clipboard is available.
    pub clipboard: bool,
    /// Semantic actions can operate without foregrounding the target.
    pub background_actions: bool,
    /// Independent applications can receive semantic actions concurrently.
    pub parallel_apps: bool,
}

/// One bounded read of the graphical seat's native text clipboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeClipboard {
    /// UTF-8 text, or `None` when the clipboard is empty/non-text.
    pub text: Option<String>,
    /// Whether an oversized ambient value was truncated to the public envelope.
    pub truncated: bool,
}

/// Rectangle in logical screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRect {
    /// Left coordinate.
    pub x: f64,
    /// Top coordinate.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// Native target class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTargetKind {
    /// Application root.
    App,
    /// One application window.
    Window,
    /// Whole graphical seat/display.
    Screen,
}

/// Current native app/window/screen target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTarget {
    /// Opaque adapter-local target id.
    pub id: String,
    /// Changes whenever the OS object identity is replaced.
    pub target_generation: String,
    /// Target class.
    pub kind: NativeTargetKind,
    /// Bundle/Desktop application id when known.
    pub application_id: Option<String>,
    /// OS process id when known.
    pub process_id: Option<u32>,
    /// Human-readable title.
    pub title: String,
    /// Logical screen bounds when known.
    pub bounds: Option<NativeRect>,
    /// Whether this target currently owns keyboard focus.
    pub focused: bool,
}

/// Redacted accessibility value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRedactedValue {
    /// Always true; keeps the JSON union explicit.
    pub redacted: bool,
    /// Redaction class.
    pub reason: NativeRedactionReason,
}

/// Native value redaction classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRedactionReason {
    /// Password/protected text.
    Password,
    /// Payment field.
    Payment,
    /// Application-declared private value.
    Private,
    /// Workspace policy.
    Policy,
}

/// Accessibility value projected into the provider-neutral tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NativeNodeValue {
    /// Visible textual value.
    Text(String),
    /// Explicit redaction marker.
    Redacted(NativeRedactedValue),
}

/// One bounded semantic node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSemanticNode {
    /// Short observation-backed reference.
    pub r#ref: String,
    /// Normalized role.
    pub role: String,
    /// Platform automation identifier when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    /// Accessible name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Accessible description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Current value or explicit redaction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<NativeNodeValue>,
    /// Normalized states.
    pub states: Vec<String>,
    /// Logical screen bounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<NativeRect>,
    /// Normalized supported actions.
    pub actions: Vec<String>,
    /// Child nodes.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<Self>,
    /// Small platform metadata; never includes native object handles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeNodeMetadata>,
}

/// Safe platform metadata attached to a semantic node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNodeMetadata {
    /// Native accessibility stack.
    pub platform: NativeSemanticPlatform,
    /// Bounded JSON metadata.
    pub data: Value,
}

/// Native semantic provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSemanticPlatform {
    /// macOS Accessibility API.
    MacAx,
    /// Linux AT-SPI2.
    AtSpi,
    /// Windows UI Automation.
    Uia,
}

/// Fresh target observation. Screenshot bytes use the separate media plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeObservation {
    /// Monotonic adapter-incarnation observation id.
    pub observation_id: String,
    /// Current target.
    pub target: NativeTarget,
    /// Current capture geometry generation, if capturable.
    pub frame_id: Option<String>,
    /// Full semantic roots. Diffs are computed by computerd.
    pub roots: Vec<NativeSemanticNode>,
    /// Total node count.
    pub node_count: usize,
    /// Focused semantic ref when known.
    pub focused_ref: Option<String>,
    /// Changed logical regions since the prior observation, if known.
    pub changed_regions: Vec<NativeRect>,
}

/// One exact captured frame. Bytes remain a binary attachment on the helper
/// protocol rather than being expanded into JSON/base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCapturedFrame {
    /// Unique frame fence in this adapter incarnation.
    pub frame_id: String,
    /// Exact target captured.
    pub target_id: String,
    /// Target generation at capture time.
    pub target_generation: String,
    /// Encoded width.
    pub width: u32,
    /// Encoded height.
    pub height: u32,
    /// Media type (currently `image/png`).
    pub mime_type: String,
    /// SHA-256 of `bytes` for local boundary integrity.
    pub sha256: String,
    /// Encoded frame bytes.
    pub bytes: Vec<u8>,
}

/// Encoding and output bounds requested only for a live-view frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureOptions {
    /// Encoded image format.
    pub format: NativeFrameFormat,
    /// Lossy encoder quality in `1..=100`; ignored for PNG.
    pub quality: u8,
    /// Maximum encoded width.
    pub max_width: u32,
    /// Maximum encoded height.
    pub max_height: u32,
}

/// Native live-frame encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeFrameFormat {
    /// Lossy JPEG for interactive live viewing.
    Jpeg,
    /// Lossless PNG for exact screenshots and fixtures.
    Png,
}

/// Provider-neutral native locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeLocator {
    /// Exact short ref from an observation.
    Ref {
        /// Short ref.
        r#ref: String,
    },
    /// Role and optional name.
    Role {
        /// Normalized role.
        role: String,
        /// Optional accessible name.
        name: Option<String>,
        /// Exact versus case-insensitive substring name matching.
        exact: Option<bool>,
    },
    /// Accessible label/name text.
    Label {
        /// Query.
        text: String,
        /// Exact versus case-insensitive substring matching.
        exact: Option<bool>,
    },
    /// Any visible accessible text.
    Text {
        /// Query.
        text: String,
        /// Exact versus case-insensitive substring matching.
        exact: Option<bool>,
    },
    /// Platform automation identifier.
    Identifier {
        /// Exact identifier.
        value: String,
    },
}

/// Normalized semantic action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSemanticAction {
    /// Invoke the default action.
    Invoke,
    /// Focus the element.
    Focus,
    /// Replace its value.
    SetValue,
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
    /// Open context/menu action.
    ShowMenu,
    /// Scroll the element into view.
    ScrollIntoView,
}

/// Set-value payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NativeActionValue {
    /// String value.
    String(String),
    /// Finite number.
    Number(f64),
    /// Boolean value.
    Boolean(bool),
}

/// Pointer action kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePointerAction {
    /// Single click.
    Click,
    /// Double click.
    DoubleClick,
    /// Pointer motion only.
    Move,
    /// Wheel/trackpad scroll.
    Scroll,
    /// Drag.
    Drag,
}

/// Pointer button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePointerButton {
    /// Primary button.
    Left,
    /// Secondary button.
    Right,
    /// Middle button.
    Middle,
}

/// Keyboard action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeKeyboardAction {
    /// Type text.
    Type,
    /// Press a named key/chord.
    Press,
}

/// Native clipboard operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeClipboardAction {
    /// Replace the seat clipboard with supplied text.
    Write,
    /// Clear the seat clipboard.
    Clear,
    /// Send the platform-standard copy command to the target.
    Copy,
    /// Send the platform-standard paste command to the target.
    Paste,
}

/// Native action union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeAction {
    /// Semantic accessibility operation.
    Semantic {
        /// Element locator.
        locator: NativeLocator,
        /// Normalized operation.
        action: NativeSemanticAction,
        /// Required only for set-value.
        value: Option<NativeActionValue>,
    },
    /// Pixel fallback against an exact captured frame.
    Pointer {
        /// Frame generation that defined these coordinates.
        frame_id: String,
        /// Operation.
        action: NativePointerAction,
        /// Start X.
        x: f64,
        /// Start Y.
        y: f64,
        /// Drag end X.
        end_x: Option<f64>,
        /// Drag end Y.
        end_y: Option<f64>,
        /// Scroll delta X.
        delta_x: Option<f64>,
        /// Scroll delta Y.
        delta_y: Option<f64>,
        /// Button.
        button: Option<NativePointerButton>,
    },
    /// Seat keyboard fallback.
    Keyboard {
        /// Type or press.
        action: NativeKeyboardAction,
        /// Text or key/chord.
        value: String,
    },
    /// Read/write support is seat-scoped; copy/paste additionally target focus.
    Clipboard {
        /// Clipboard operation.
        operation: NativeClipboardAction,
        /// Required exactly for `write`.
        text: Option<String>,
    },
    /// Focus another app/window target.
    Focus {
        /// Exact target id.
        target_id: String,
    },
    /// Launch an installed application.
    Launch {
        /// Bundle/Desktop application id.
        application_id: String,
    },
}

/// Fenced command received from computerd after durable preparation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActionCommand {
    /// Target id.
    pub target_id: String,
    /// Exact current target generation.
    pub expected_target_generation: String,
    /// Exact semantic observation for ref actions.
    pub expected_observation_id: Option<String>,
    /// Exact capture frame for pointer actions.
    pub expected_frame_id: Option<String>,
    /// Operation.
    pub action: NativeAction,
}
