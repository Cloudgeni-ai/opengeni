//! The control-plane driver: one `async-nats` client that speaks the exact
//! prost `ControlRequest`/`ControlResponse` request/reply the real control plane
//! speaks, plus a background collector for the agent's outbound events
//! (heartbeats + going-offline).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_nats::RequestErrorKind;
use futures::StreamExt as _;
use opengeni_agent_proto::v1::{
    self, agent_event::Event, control_request::Op as ReqOp, control_response::Result as RespResult,
    AgentEvent, ControlRequest, ControlResponse, ErrorCode,
};
use prost::bytes::Bytes;
use prost::Message as _;

/// A monotonic source of unique request ids (correlates a reply to its request).
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

/// The abstract operation the driver issues. Each maps to exactly one
/// `ControlRequest` op; the driver owns the wire construction so scenarios read
/// as an op mix, not protobuf.
#[derive(Debug, Clone)]
pub enum Op {
    /// The liveness probe (bypasses the agent's host-work admission).
    Ping,
    /// A tiny exec via the shell `echo` builtin (a stable, fork-light command).
    ExecEcho,
    /// `sleep <secs>` under a wire `timeout_ms` (0 = the agent default).
    ExecSleep { secs: String, timeout_ms: u32 },
    /// An exec that emits exactly `bytes` of stdout (the reply-size wall probe).
    ExecGen { bytes: u64 },
    /// A long marker exec: `sleep <secs>; echo done > <marker_path>`. The unique
    /// `marker_path` doubles as a `pgrep -f` needle to check the child's fate.
    ExecMarker { secs: u64, marker_path: String },
    /// `fs_stat` of a path.
    FsStat { path: String },
    /// `fs_list` of a directory.
    FsList { path: String },
    /// `fs_read` of a file (the reply-size wall probe on the read side).
    FsRead { path: String },
    /// `fs_write` of `bytes` 'a's (the request-size wall probe on the write side).
    FsWrite { path: String, bytes: u64 },
}

impl Op {
    /// A stable label used as the latency-histogram key.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Op::Ping => "ping",
            Op::ExecEcho => "exec_echo",
            Op::ExecSleep { .. } => "exec_sleep",
            Op::ExecGen { .. } => "exec_gen",
            Op::ExecMarker { .. } => "exec_marker",
            Op::FsStat { .. } => "fs_stat",
            Op::FsList { .. } => "fs_list",
            Op::FsRead { .. } => "fs_read",
            Op::FsWrite { .. } => "fs_write",
        }
    }

    /// Builds the wire op (epoch 0 → never fenced; the agent holds epoch 0).
    fn into_wire(self) -> ReqOp {
        match self {
            Op::Ping => ReqOp::Ping(v1::PingRequest {
                nonce: REQUEST_SEQ.load(Ordering::Relaxed),
            }),
            Op::ExecEcho => ReqOp::Exec(v1::ExecRequest {
                command: vec!["echo hx".to_string()],
                shell: true,
                timeout_ms: 0,
                ..Default::default()
            }),
            Op::ExecSleep { secs, timeout_ms } => ReqOp::Exec(v1::ExecRequest {
                command: vec!["sleep".to_string(), secs],
                shell: false,
                timeout_ms,
                ..Default::default()
            }),
            Op::ExecGen { bytes } => ReqOp::Exec(v1::ExecRequest {
                command: vec![format!("head -c {bytes} /dev/zero | tr '\\0' 'a'")],
                shell: true,
                timeout_ms: 0,
                ..Default::default()
            }),
            Op::ExecMarker { secs, marker_path } => ReqOp::Exec(v1::ExecRequest {
                command: vec![format!("sleep {secs}; echo done > {marker_path}")],
                shell: true,
                timeout_ms: 0,
                ..Default::default()
            }),
            Op::FsStat { path } => ReqOp::FsStat(v1::FsStatRequest { path }),
            Op::FsList { path } => ReqOp::FsList(v1::FsListRequest {
                path,
                recursive: false,
            }),
            Op::FsRead { path } => ReqOp::FsRead(v1::FsReadRequest {
                path,
                offset: 0,
                length: 0,
            }),
            Op::FsWrite { path, bytes } => ReqOp::FsWrite(v1::FsWriteRequest {
                path,
                content: Bytes::from(vec![b'a'; usize::try_from(bytes).unwrap_or(usize::MAX)]),
                create_parents: true,
                append: false,
                mode: 0,
            }),
        }
    }
}

/// How an issued op resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpClass {
    /// A typed success `ControlResponse` (the payload matched the op).
    Ok,
    /// A typed `AgentError` reply (the string is the stable error code, e.g.
    /// `DRAINING`, `PAYLOAD_TOO_LARGE`, `TIMEOUT`).
    AgentError(String),
    /// A transport-level failure before/without an agent reply (the string is the
    /// classified client-side reason, e.g. `NO_RESPONDERS`, `REQUEST_TOO_LARGE`,
    /// `CLIENT_TIMEOUT`).
    Transport(String),
}

/// The measured outcome of one issued op.
#[derive(Debug, Clone)]
pub struct OpOutcome {
    /// The op's histogram label.
    pub label: &'static str,
    /// End-to-end request/reply latency in microseconds.
    pub latency_us: u64,
    /// How the op resolved.
    pub class: OpClass,
    /// For a successful exec, whether the agent reported a wall-clock timeout.
    pub exec_timed_out: bool,
    /// A size the op surfaced (exec stdout len, fs_read content len, fs_write
    /// bytes_written) — used by the `large` scenario's per-size table.
    pub payload_len: Option<u64>,
}

/// The driver over a single connected NATS client. Cheaply cloneable (the client
/// is an `Arc` internally), so an in-flight op can be issued from a spawned task.
#[derive(Clone)]
pub struct Driver {
    client: async_nats::Client,
}

impl Driver {
    /// Connects to the local server. Uses the client defaults (auto-reconnect),
    /// which is what recovers the request path + subscriptions after a chaos
    /// restart of the server.
    ///
    /// # Errors
    ///
    /// Returns the connect error.
    pub async fn connect(url: &str) -> Result<Self, String> {
        let client = async_nats::connect(url)
            .await
            .map_err(|e| format!("driver connect: {e}"))?;
        Ok(Self { client })
    }

    /// The server's negotiated max payload (the reply/request size wall).
    #[must_use]
    pub fn max_payload(&self) -> usize {
        self.client.max_payload()
    }

    /// The underlying NATS client (the op-stream plumbing shares it).
    #[must_use]
    pub fn raw_client(&self) -> async_nats::Client {
        self.client.clone()
    }

    /// Subscribes to the fleet events subject and starts the background collector.
    ///
    /// # Errors
    ///
    /// Returns a subscribe error.
    pub async fn start_event_collector(
        &self,
        workspace_id: &str,
    ) -> Result<HeartbeatCollector, String> {
        let subject = format!("agent.{workspace_id}.*.events");
        let subscriber = self
            .client
            .subscribe(subject)
            .await
            .map_err(|e| format!("subscribe events: {e}"))?;
        Ok(HeartbeatCollector::spawn(subscriber))
    }

    /// Like [`execute`](Self::execute) but takes an OWNED subject, so a fleet of
    /// per-agent futures can be collected into one `join_all` without borrowing a
    /// per-iteration local.
    pub async fn execute_owned(&self, subject: String, op: Op, timeout: Duration) -> OpOutcome {
        self.execute(&subject, op, timeout).await
    }

    /// Issues one op on `subject` with an explicit request timeout, returning its
    /// measured outcome. Never panics: every failure mode is a classified
    /// `OpOutcome`.
    pub async fn execute(&self, subject: &str, op: Op, timeout: Duration) -> OpOutcome {
        let label = op.label();
        let request_id = format!("hx-{}", REQUEST_SEQ.fetch_add(1, Ordering::Relaxed));
        let control = ControlRequest {
            request_id,
            epoch: 0,
            op: Some(op.into_wire()),
        };
        let payload = Bytes::from(control.encode_to_vec());
        let request = async_nats::Request::new()
            .payload(payload)
            .timeout(Some(timeout));

        // `send_request` requires an owned (`'static`) subject, so hand it a
        // `String` rather than the borrowed `&str`.
        let started = Instant::now();
        let result = self.client.send_request(subject.to_string(), request).await;
        let latency_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);

        match result {
            Err(err) => OpOutcome {
                label,
                latency_us,
                class: OpClass::Transport(transport_label(err.kind()).to_string()),
                exec_timed_out: false,
                payload_len: None,
            },
            Ok(message) => classify_reply(label, latency_us, &message.payload),
        }
    }
}

/// Maps a decoded reply into an outcome.
fn classify_reply(label: &'static str, latency_us: u64, payload: &[u8]) -> OpOutcome {
    let Ok(response) = ControlResponse::decode(payload) else {
        return OpOutcome {
            label,
            latency_us,
            class: OpClass::Transport("DECODE_ERROR".to_string()),
            exec_timed_out: false,
            payload_len: None,
        };
    };
    if let Some(err) = response.error {
        return OpOutcome {
            label,
            latency_us,
            class: OpClass::AgentError(error_code_label(err.code)),
            exec_timed_out: false,
            payload_len: None,
        };
    }
    let (exec_timed_out, payload_len) = match response.result {
        Some(RespResult::Exec(e)) => (e.timed_out, Some(e.stdout.len() as u64)),
        Some(RespResult::FsRead(r)) => (false, Some(r.content.len() as u64)),
        Some(RespResult::FsWrite(w)) => (false, Some(w.bytes_written)),
        _ => (false, None),
    };
    OpOutcome {
        label,
        latency_us,
        class: OpClass::Ok,
        exec_timed_out,
        payload_len,
    }
}

/// The stable code string for a proto `ErrorCode` discriminant.
fn error_code_label(code: i32) -> String {
    let label = match ErrorCode::try_from(code) {
        Ok(ErrorCode::Unsupported) => "UNSUPPORTED",
        Ok(ErrorCode::Os) => "OS",
        Ok(ErrorCode::NotFound) => "NOT_FOUND",
        Ok(ErrorCode::ConsentRequired) => "CONSENT_REQUIRED",
        Ok(ErrorCode::Timeout) => "TIMEOUT",
        Ok(ErrorCode::Draining) => "DRAINING",
        Ok(ErrorCode::Protocol) => "PROTOCOL",
        Ok(ErrorCode::Stream) => "STREAM",
        Ok(ErrorCode::AgentOffline) => "AGENT_OFFLINE",
        Ok(ErrorCode::Fenced) => "FENCED",
        Ok(ErrorCode::PayloadTooLarge) => "PAYLOAD_TOO_LARGE",
        Ok(ErrorCode::Unspecified) => "UNSPECIFIED",
        Err(_) => "UNKNOWN",
    };
    label.to_string()
}

/// The stable client-side label for a transport failure kind.
fn transport_label(kind: RequestErrorKind) -> &'static str {
    match kind {
        RequestErrorKind::TimedOut => "CLIENT_TIMEOUT",
        RequestErrorKind::NoResponders => "NO_RESPONDERS",
        RequestErrorKind::InvalidSubject => "CLIENT_INVALID_SUBJECT",
        RequestErrorKind::MaxPayloadExceeded => "REQUEST_TOO_LARGE",
        RequestErrorKind::Other => "CLIENT_OTHER",
    }
}

/// Shared state for the events collector.
#[derive(Default)]
struct EventState {
    /// Per-agent heartbeat arrival instants.
    beats: BTreeMap<String, Vec<Instant>>,
    /// Per-agent going-offline arrival instants.
    offline: BTreeMap<String, Vec<Instant>>,
    /// Per-agent LATEST heartbeat payload (capacity/admission telemetry).
    latest: BTreeMap<String, v1::Heartbeat>,
}

/// Collects agent-originated events (heartbeats + going-offline) off the fleet
/// events subject on a background task, so a scenario can assert liveness and
/// measure reconnect convergence.
pub struct HeartbeatCollector {
    state: Arc<Mutex<EventState>>,
    task: tokio::task::JoinHandle<()>,
}

impl HeartbeatCollector {
    /// Spawns the collector task over an events subscription.
    fn spawn(mut subscriber: async_nats::Subscriber) -> Self {
        let state = Arc::new(Mutex::new(EventState::default()));
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            while let Some(message) = subscriber.next().await {
                let Ok(event) = AgentEvent::decode(message.payload.as_ref()) else {
                    continue;
                };
                let now = Instant::now();
                let mut guard = task_state.lock().unwrap();
                match event.event {
                    Some(Event::Heartbeat(hb)) => {
                        guard
                            .beats
                            .entry(event.agent_id.clone())
                            .or_default()
                            .push(now);
                        guard.latest.insert(event.agent_id, hb);
                    }
                    Some(Event::GoingOffline(_)) => {
                        guard.offline.entry(event.agent_id).or_default().push(now);
                    }
                    None => {}
                }
            }
        });
        Self { state, task }
    }

    /// The latest heartbeat payload seen for an agent (telemetry assertions).
    #[must_use]
    pub fn latest_heartbeat(&self, agent_id: &str) -> Option<v1::Heartbeat> {
        self.state.lock().unwrap().latest.get(agent_id).cloned()
    }

    /// The number of heartbeats seen for an agent so far.
    #[must_use]
    pub fn beat_count(&self, agent_id: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .beats
            .get(agent_id)
            .map_or(0, Vec::len)
    }

    /// Per-agent inter-arrival gaps (ms) between consecutive heartbeats.
    #[must_use]
    pub fn gaps_ms(&self) -> BTreeMap<String, Vec<u64>> {
        let guard = self.state.lock().unwrap();
        let mut out = BTreeMap::new();
        for (agent, beats) in &guard.beats {
            let gaps: Vec<u64> = beats
                .windows(2)
                .map(|w| u64::try_from(w[1].duration_since(w[0]).as_millis()).unwrap_or(u64::MAX))
                .collect();
            out.insert(agent.clone(), gaps);
        }
        out
    }

    /// The delay from `after` to the FIRST heartbeat that arrives strictly later
    /// (reconnect convergence). `None` if none has arrived yet.
    #[must_use]
    pub fn first_beat_after(&self, agent_id: &str, after: Instant) -> Option<Duration> {
        let guard = self.state.lock().unwrap();
        guard
            .beats
            .get(agent_id)?
            .iter()
            .find(|t| **t > after)
            .map(|t| t.duration_since(after))
    }

    /// Whether a clean going-offline event was seen for an agent.
    #[must_use]
    pub fn going_offline_seen(&self, agent_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .offline
            .get(agent_id)
            .is_some_and(|v| !v.is_empty())
    }

    /// Waits until `agent_id` has produced at least `n` heartbeats, or the
    /// timeout elapses. Returns whether the count was reached.
    pub async fn wait_for_beats(&self, agent_id: &str, n: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.beat_count(agent_id) >= n {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

impl Drop for HeartbeatCollector {
    fn drop(&mut self) {
        self.task.abort();
    }
}
