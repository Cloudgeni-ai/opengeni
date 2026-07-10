//! Op-stream driver plumbing (`.agent/ENGINE-SCENARIOS.md` §1): the harness
//! plays the SERVER for the op-stream plane — it issues `OpStart`/`OpCancel`/
//! `OpQuery`/`OpAttach` on the rpc subject, subscribes the per-op frame
//! subject BEFORE `OpStart` (the subscription-before-start invariant),
//! collects `OpFrame`s, and publishes `OpAck`s on the ack subject.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use opengeni_agent_proto::v1::{
    self, control_request::Op as ReqOp, control_response::Result as RespResult, ControlRequest,
    ControlResponse,
};
use prost::bytes::Bytes;
use prost::Message as _;

use crate::agent::WORKSPACE_ID;

/// A typed reply to an op-lifecycle request.
#[derive(Debug)]
pub enum OpReply {
    /// `OpStart` reply.
    Started(v1::OpStarted),
    /// `OpCancel`/`OpQuery`/`OpAttach` reply.
    Status(v1::OpStatus),
    /// A typed `AgentError` (the stable code string, e.g. `UNSUPPORTED`).
    Error(String),
}

impl OpReply {
    /// The status, whichever shape carried it. Panics with context otherwise
    /// (scenario code wants loud, located failures).
    pub fn status(&self) -> &v1::OpStatus {
        match self {
            OpReply::Started(started) => started.status.as_ref().expect("OpStarted carries status"),
            OpReply::Status(status) => status,
            OpReply::Error(code) => panic!("expected a status reply, got error {code}"),
        }
    }
}

/// Issues op-lifecycle requests on one agent's rpc subject and acks on its ack
/// subject. Cheaply cloneable.
#[derive(Clone)]
pub struct OpDriver {
    client: async_nats::Client,
    rpc_subject: String,
    ack_subject: String,
}

impl OpDriver {
    /// Builds the driver for one agent.
    #[must_use]
    pub fn new(client: async_nats::Client, agent_id: &str) -> Self {
        Self {
            client,
            rpc_subject: format!("agent.{WORKSPACE_ID}.{agent_id}.rpc"),
            ack_subject: format!("agent.{WORKSPACE_ID}.{agent_id}.ack"),
        }
    }

    /// `OpStart{exec}` with `request_id == op_id` (ruling B1: the durable id).
    pub async fn start_exec(
        &self,
        op_id: &str,
        command: &str,
        window_bytes: u64,
        deadline_ms: i64,
    ) -> Result<OpReply, String> {
        self.request(
            op_id,
            ReqOp::OpStart(v1::OpStart {
                op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                    command: vec![command.to_string()],
                    shell: true,
                    ..Default::default()
                })),
                window_bytes,
                deadline_ms,
                origin_id: "hx-op-scenarios".to_string(),
            }),
        )
        .await
    }

    /// `OpCancel{op_id}`.
    pub async fn cancel(&self, op_id: &str) -> Result<OpReply, String> {
        let request_id = format!("cancel-{op_id}-{}", nanos());
        self.request(
            &request_id,
            ReqOp::OpCancel(v1::OpCancel {
                op_id: op_id.to_string(),
            }),
        )
        .await
    }

    /// `OpQuery{op_id}`.
    pub async fn query(&self, op_id: &str) -> Result<OpReply, String> {
        let request_id = format!("query-{op_id}-{}", nanos());
        self.request(
            &request_id,
            ReqOp::OpQuery(v1::OpQuery {
                op_id: op_id.to_string(),
            }),
        )
        .await
    }

    /// `OpAttach{op_id, from_seq, generation, window_bytes}` (0 window =
    /// reuse the OpStart grant).
    pub async fn attach(
        &self,
        op_id: &str,
        from_seq: u64,
        generation: u64,
        window_bytes: u64,
    ) -> Result<OpReply, String> {
        let request_id = format!("attach-{op_id}-{generation}-{}", nanos());
        self.request(
            &request_id,
            ReqOp::OpAttach(v1::OpAttach {
                op_id: op_id.to_string(),
                from_seq,
                attach_generation: generation,
                window_bytes,
            }),
        )
        .await
    }

    /// Publishes a cumulative `OpAck` (fire-and-forget, like the real server).
    pub async fn ack(
        &self,
        op_id: &str,
        acked_seq: u64,
        credit_bytes: u64,
        generation: u64,
        is_final: bool,
    ) -> Result<(), String> {
        let ack = v1::OpAck {
            op_id: op_id.to_string(),
            acked_seq,
            credit_bytes,
            r#final: is_final,
            attach_generation: generation,
        };
        self.client
            .publish(self.ack_subject.clone(), ack.encode_to_vec().into())
            .await
            .map_err(|e| format!("ack publish: {e}"))
    }

    /// One rpc request/reply, decoded and classified.
    async fn request(&self, request_id: &str, op: ReqOp) -> Result<OpReply, String> {
        let control = ControlRequest {
            request_id: request_id.to_string(),
            epoch: 0,
            op: Some(op),
        };
        let request = async_nats::Request::new()
            .payload(Bytes::from(control.encode_to_vec()))
            .timeout(Some(Duration::from_secs(10)));
        let message = self
            .client
            .send_request(self.rpc_subject.clone(), request)
            .await
            .map_err(|e| format!("op rpc: {e}"))?;
        let response = ControlResponse::decode(message.payload.as_ref())
            .map_err(|e| format!("decode: {e}"))?;
        if let Some(error) = response.error {
            return Ok(OpReply::Error(format!(
                "{:?}",
                v1::ErrorCode::try_from(error.code).unwrap_or(v1::ErrorCode::Unspecified)
            )));
        }
        match response.result {
            Some(RespResult::OpStart(started)) => Ok(OpReply::Started(started)),
            Some(RespResult::OpStatus(status)) => Ok(OpReply::Status(status)),
            other => Err(format!("unexpected op reply shape: {other:?}")),
        }
    }
}

/// A nanosecond suffix for per-request-unique ids.
fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// Collects one op's frames off its subject: ordered log, per-channel
/// reassembly (seq-deduped, byte-identity asserted on dups — the server-side
/// idempotent-reassembly contract), gap detection, and await helpers.
pub struct OpCollector {
    state: Arc<Mutex<CollectorState>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct CollectorState {
    /// Deduped frames by seq (dups must be byte-identical).
    by_seq: BTreeMap<u64, (Instant, v1::OpFrame)>,
    /// Raw arrival count (incl. dups) for fan-out assertions.
    arrivals: usize,
}

impl OpCollector {
    /// Subscribes the per-op frame subject. MUST be called before `OpStart`
    /// (the subscription-before-start invariant).
    pub async fn attach(
        client: &async_nats::Client,
        agent_id: &str,
        op_id: &str,
    ) -> Result<Self, String> {
        let subject = format!("agent.{WORKSPACE_ID}.{agent_id}.op.{op_id}");
        let mut subscriber = client
            .subscribe(subject)
            .await
            .map_err(|e| format!("op subject subscribe: {e}"))?;
        let state = Arc::new(Mutex::new(CollectorState::default()));
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            while let Some(message) = subscriber.next().await {
                let Ok(frame) = v1::OpFrame::decode(message.payload.as_ref()) else {
                    continue;
                };
                let mut guard = task_state.lock().unwrap();
                guard.arrivals += 1;
                match guard.by_seq.entry(frame.seq) {
                    std::collections::btree_map::Entry::Vacant(slot) => {
                        slot.insert((Instant::now(), frame));
                    }
                    std::collections::btree_map::Entry::Occupied(existing) => {
                        // A replayed frame must be byte-identical (protocol:
                        // frames are never regenerated).
                        assert_eq!(
                            existing.get().1.body,
                            frame.body,
                            "replayed frame differs from the original at seq {}",
                            frame.seq
                        );
                    }
                }
            }
        });
        Ok(Self { state, task })
    }

    /// Gaps in the contiguous range `1..=highest` (empty = no loss).
    #[must_use]
    pub fn missing_seqs(&self) -> Vec<u64> {
        let guard = self.state.lock().unwrap();
        let Some(highest) = guard.by_seq.keys().next_back().copied() else {
            return Vec::new();
        };
        (1..=highest)
            .filter(|seq| !guard.by_seq.contains_key(seq))
            .collect()
    }

    /// The reassembled byte stream of one channel (seq order, deduped).
    #[must_use]
    pub fn channel_bytes(&self, channel: v1::OpChannel) -> Vec<u8> {
        let guard = self.state.lock().unwrap();
        let mut out = Vec::new();
        for (_, frame) in guard.by_seq.values() {
            if let Some(v1::op_frame::Body::Data(data)) = &frame.body {
                if data.channel == channel as i32 {
                    out.extend_from_slice(&data.bytes);
                }
            }
        }
        out
    }

    /// blake3 hex of a channel's reassembled stream (compare to Exit digests).
    #[must_use]
    pub fn channel_digest(&self, channel: v1::OpChannel) -> String {
        blake3::hash(&self.channel_bytes(channel))
            .to_hex()
            .to_string()
    }

    /// Deduped Data payload bytes with `seq > after` (the unacked figure).
    #[must_use]
    pub fn data_payload_above(&self, after: u64) -> u64 {
        let guard = self.state.lock().unwrap();
        guard
            .by_seq
            .range(after + 1..)
            .filter_map(|(_, (_, f))| match &f.body {
                Some(v1::op_frame::Body::Data(d)) => Some(d.bytes.len() as u64),
                _ => None,
            })
            .sum()
    }

    /// Total deduped Data payload bytes (all channels).
    #[must_use]
    pub fn data_payload_total(&self) -> u64 {
        let guard = self.state.lock().unwrap();
        guard
            .by_seq
            .values()
            .filter_map(|(_, f)| match &f.body {
                Some(v1::op_frame::Body::Data(d)) => Some(d.bytes.len() as u64),
                _ => None,
            })
            .sum()
    }

    /// Progress frames seen (deduped).
    #[must_use]
    pub fn progress_count(&self) -> usize {
        let guard = self.state.lock().unwrap();
        guard
            .by_seq
            .values()
            .filter(|(_, f)| matches!(f.body, Some(v1::op_frame::Body::Progress(_))))
            .count()
    }

    /// The terminal frame, if seen: `(seq, OpExit)`.
    #[must_use]
    pub fn exit(&self) -> Option<(u64, v1::OpExit)> {
        let guard = self.state.lock().unwrap();
        guard.by_seq.iter().find_map(|(seq, (_, f))| match &f.body {
            Some(v1::op_frame::Body::Exit(exit)) => Some((*seq, exit.clone())),
            _ => None,
        })
    }

    /// The highest deduped seq seen (0 = none).
    #[must_use]
    pub fn highest_seq(&self) -> u64 {
        self.state
            .lock()
            .unwrap()
            .by_seq
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0)
    }

    /// The highest DATA seq seen (0 = none) — the cumulative-ack watermark.
    #[must_use]
    pub fn highest_data_seq(&self) -> u64 {
        let guard = self.state.lock().unwrap();
        guard
            .by_seq
            .iter()
            .rev()
            .find_map(|(seq, (_, f))| {
                matches!(f.body, Some(v1::op_frame::Body::Data(_))).then_some(*seq)
            })
            .unwrap_or(0)
    }

    /// Raw frame arrivals including duplicates (fan-out probes).
    #[must_use]
    pub fn arrivals(&self) -> usize {
        self.state.lock().unwrap().arrivals
    }

    /// The arrival instant of the first frame with `seq > after_seq`, if any.
    #[must_use]
    pub fn first_arrival_above(&self, after_seq: u64) -> Option<Instant> {
        let guard = self.state.lock().unwrap();
        guard
            .by_seq
            .range(after_seq + 1..)
            .map(|(_, (at, _))| *at)
            .next()
    }

    /// Waits until the terminal frame arrives (or times out).
    pub async fn wait_for_exit(&self, timeout: Duration) -> Option<(u64, v1::OpExit)> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(exit) = self.exit() {
                return Some(exit);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits until a predicate over the collector holds (or times out).
    pub async fn wait_until(&self, timeout: Duration, pred: impl Fn(&Self) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if pred(self) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for OpCollector {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Spawns a background GrantAll ack policy: acks every newly seen frame
/// cumulatively at `generation` with `credit_bytes`, until aborted. The
/// returned handle must be kept (dropping it stops the policy).
pub fn grant_all_acks(
    driver: OpDriver,
    collector: Arc<OpCollector>,
    op_id: String,
    generation: u64,
    credit_bytes: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut acked = 0u64;
        loop {
            let hi = collector.highest_seq();
            if hi > acked {
                acked = hi;
                let _ = driver
                    .ack(&op_id, acked, credit_bytes, generation, false)
                    .await;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
}
