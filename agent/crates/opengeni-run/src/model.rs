//! Immutable launch binding and byte-oriented journal replies.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// One exact invocation; environment values are hashed but never persisted on disk.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    /// Caller-chosen canonical UUID, retained outside the sandbox before dispatch.
    pub operation_id: String,
    /// Control-plane disk provenance, not an authorization secret.
    pub disk_lineage: String,
    /// Exact observed kernel/PID-1 identity for this physical invocation.
    pub boot_id: String,
    /// Absolute executable path; no shell interpolation in the launcher.
    pub program: String,
    /// Native argument vector.
    pub args: Vec<String>,
    /// Absolute working directory.
    pub cwd: String,
    /// Exact child environment. Stored only in volatile launch material.
    pub environment: BTreeMap<String, String>,
    /// Keep a supervised stdin pipe open; a PTY also requires this flag.
    #[serde(default)]
    pub stdin: bool,
    /// Optional terminal, with stdout/stderr merged into the stdout byte log.
    #[serde(default)]
    pub pty: Option<PtySize>,
}

/// Bounded terminal dimensions.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtySize {
    /// Character columns.
    pub columns: u16,
    /// Character rows.
    pub rows: u16,
}

impl StartRequest {
    /// Canonical digest including environment values and incarnation binding.
    ///
    /// # Errors
    /// Returns an encoding error.
    pub fn digest(&self) -> serde_json::Result<String> {
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(self)?)))
    }
}

/// Journal claim. It deliberately contains no child environment values.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Claim {
    pub version: u8,
    pub operation_id: String,
    pub disk_lineage: String,
    pub boot_id: String,
    pub specification_digest: String,
    pub nonce: String,
    pub control_path: String,
    #[serde(default)]
    pub stdin: bool,
    #[serde(default)]
    pub pty: Option<PtySize>,
}

/// The immutable gate won by cancellation before a command launcher existed.
/// Its provenance cannot be manufactured by a later physical boot.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancellationClaim {
    pub operation_id: String,
    pub boot_id: String,
    pub disk_lineage: String,
}

/// Existing native supervisor's authenticated, immutable kernel quiescence proof.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuiescenceReceipt {
    /// Native protocol version.
    pub protocol: String,
    /// Exact operation UUID.
    pub invocation_id: String,
    /// Supervisor-created receipt UUID.
    pub receipt_id: String,
    /// Leader exit code; 125 means never launched when cancelled idle.
    pub leader_exit_code: i32,
    /// Cumulative input acceptance, present only for optional supervised I/O.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_input_sequence: Option<u64>,
    /// A PTY write was interrupted after a partial delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incomplete_input_sequence: Option<u64>,
}

/// One ordered input action. Raw bytes travel only through volatile IPC.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRequest {
    /// Exact immutable command UUID.
    pub operation_id: String,
    /// Starts at one; identical retries retain this number.
    pub sequence: u64,
    /// Data, pipe EOF, or terminal resize.
    pub input: InputAction,
}

/// Terminal EOF is deliberately not synthesized for a raw PTY.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputAction {
    /// Up to 4096 bytes in canonical base64.
    Data {
        /// Encoded byte chunk; never a UTF-8 cursor.
        base64: String,
    },
    /// Close only a pipe after all earlier accepted bytes.
    Close,
    /// Resize the exact controlling terminal.
    Resize {
        /// Character columns.
        columns: u16,
        /// Character rows.
        rows: u16,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputClaim {
    pub sequence: u64,
    pub digest: String,
}

/// Acceptance means delivery into the OS stream, not application processing.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputStatus {
    /// Fully queued exactly once to the surviving native owner.
    Accepted,
    /// The owner holds a partial/backpressured write and can resume it.
    Pending,
    /// Exact owner rejected this action without full delivery.
    Rejected,
    /// Acceptance cannot be proved; never replay through a new supervisor.
    Unknown,
}

/// Bounded input evidence, with no data or digest disclosure.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputObservation {
    /// Exact command UUID.
    pub operation_id: String,
    /// Caller-retained input sequence.
    pub sequence: u64,
    /// Honest acceptance state.
    pub status: InputStatus,
    /// Cumulative positive acceptance, if the exact owner is readable.
    pub accepted_through: Option<u64>,
    /// Generic reason; contains no command or input bytes.
    pub reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeInputReply {
    pub state: String,
    pub sequence: u64,
    pub accepted_through: u64,
    pub pending_sequence: u64,
    pub status: InputStatus,
    pub reason: String,
}

/// Persisted terminal tombstone, never erased to permit reusing an operation ID.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Terminal {
    pub specification_digest: String,
    pub disk_lineage: String,
    pub receipt: QuiescenceReceipt,
}

/// Observation state. Missing/crashed supervision is never a launch permission.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// The operation directory does not exist; control-plane dispatch history matters.
    NotFound,
    /// Cancellation won the immutable directory gate; no child was admitted.
    Cancelled,
    /// Authenticated native supervisor is idle and has not launched its child.
    Prepared,
    /// Authenticated native supervisor owns this running invocation.
    Running,
    /// Native quiescence and final output are durably recorded.
    Exited,
    /// Kernel/PID-1 identity changed without a retained terminal receipt.
    Lost,
    /// Claim/control is incomplete or unavailable; do not start again.
    Unknown,
}

/// One exact byte page. Decoding UTF-8 belongs to the control plane's byte cursor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPage {
    /// Requested byte offset.
    pub offset: u64,
    /// Next offset; retries with the old offset replay identical persisted bytes.
    pub next_offset: u64,
    /// Raw bytes in base64.
    pub data: String,
    /// True only after durable quiescence and the final byte of this stream.
    pub eof: bool,
}

/// Bounded reply, with no command/environment or control nonce disclosure.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// Caller-chosen invocation UUID.
    pub operation_id: String,
    /// Honest current evidence state.
    pub state: State,
    /// Immutable binding, when the claim is readable.
    pub specification_digest: Option<String>,
    /// Trusted native proof, when complete.
    pub receipt: Option<QuiescenceReceipt>,
    /// Durable stdout byte page.
    pub stdout: OutputPage,
    /// Durable stderr byte page.
    pub stderr: OutputPage,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum NativeReply {
    Idle,
    Running,
    Quiescent { receipt: QuiescenceReceipt },
}
