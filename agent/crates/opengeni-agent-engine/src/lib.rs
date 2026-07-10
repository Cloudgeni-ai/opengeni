//! The transport-agnostic op engine for the Connected-Machine RUNNER (the machine-resident daemon; "agent" is reserved for the AI in a session — naming ruling 2026-07-10).
//!
//! This crate is the durable heart of the runner's op-stream protocol
//! (`.agent/PROTOCOL.md`): every host operation is a *journaled job* whose
//! state — identity, sequenced output frames, replay retention, credit flow,
//! lifecycle — lives HERE, at supervisor scope, decoupled from any connection
//! generation. The NATS (or future) transport binds to this engine through
//! plain function calls; nothing in this crate knows about subjects, sockets,
//! tokio, or protobuf encodings.
//!
//! Design rules enforced by construction:
//!
//! * **Op lifetime ⊥ connection lifetime.** Nothing in this crate is dropped
//!   or cancelled because a transport reconnected; the integration layer kills
//!   work only on cancel, deadline, or agent shutdown.
//! * **No unbounded buffering.** Retention is byte- and frame-bounded in
//!   memory ([`retention::RetentionConfig::memory_max_bytes`]) and quota-bounded on
//!   disk; exhaustion is a *typed* terminal outcome, never silent truncation.
//! * **Everything is deterministic and clock-injected.** No wall-clock reads,
//!   no randomness — callers pass `now_ms`, tests own time.
//!
//! Modules:
//! * [`retention`] — the seq-addressed retention log (memory ring → disk
//!   spool) that backs replay-after-reattach.
//! * [`flow`] — the credit window (send-side flow control + attach-generation
//!   fencing + monotonic cumulative acks).
//! * [`registry`] — op lifecycle: idempotent begin, cancel tombstones,
//!   bounded completed-op retention with loud eviction.

pub mod flow;
pub mod registry;
pub mod retention;

/// The durable operation identity — minted ABOVE the transport at the semantic
/// layer (`{tool_call_id}:{ordinal}`, see PROTOCOL.md ruling B1) and stable
/// across turn re-dispatch and activity retry. Never a per-attempt UUID.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OpId(String);

impl OpId {
    /// Wraps a durable op identity string.
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// The identity as a string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OpId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for OpId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// Which logical byte stream a data frame belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    /// Child process standard output.
    Stdout,
    /// Child process standard error.
    Stderr,
    /// Non-exec content (fs read bodies and similar).
    Content,
}

/// One retained frame body. `Exit` payloads are opaque to the engine (the
/// integration layer encodes/decodes the wire form); the engine only needs to
/// know a frame's kind and payload size for bounding and replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameBody {
    /// A chunk of op output on a channel.
    Data {
        /// The stream this chunk belongs to.
        channel: Channel,
        /// The chunk payload (≤ the configured frame size at the wire layer).
        bytes: Vec<u8>,
    },
    /// A liveness tick: the op is alive but produced no data. Progress frames
    /// consume sequence numbers (uniform gap detection) and are retained like
    /// any frame; their payload size is zero.
    Progress,
    /// The terminal frame: exit status, digests, totals — encoded by the
    /// integration layer, opaque here.
    Exit {
        /// Encoded terminal payload (wire form; opaque to the engine).
        payload: Vec<u8>,
    },
}

impl FrameBody {
    /// Payload bytes this frame counts against retention/credit budgets.
    /// Progress is free; Exit counts (it is retained and replayed).
    #[must_use]
    pub fn payload_len(&self) -> usize {
        match self {
            FrameBody::Data { bytes, .. } => bytes.len(),
            FrameBody::Progress => 0,
            FrameBody::Exit { payload } => payload.len(),
        }
    }

    /// Whether this is the terminal frame.
    #[must_use]
    pub fn is_exit(&self) -> bool {
        matches!(self, FrameBody::Exit { .. })
    }
}

/// A sequenced, retained frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// The op-scoped monotonic sequence number (u64 — wraps never; ruling
    /// MINORs pin wire widths to 64-bit).
    pub seq: u64,
    /// The frame body.
    pub body: FrameBody,
}
