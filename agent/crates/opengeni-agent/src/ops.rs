//! Op-stream wire serving: OpStart/OpCancel/OpQuery/OpAttach handlers and the
//! OpAck sink, mapping the wire messages (PROTOCOL.md v1.1) onto the engine.
//!
//! Transport stance: handlers receive an already-decoded request and a
//! `publish` closure bound to the op's frame subject (the supervisor owns the
//! bulk connection behind it). Frames ride fire-and-forget — a frame the
//! publish path drops (bulk blip, full channel) is healed by gap-detection +
//! `OpAttach` replay, never retried here.
//!
//! Serving rules:
//! * `OpStart` is idempotent by op id (= request id, ruling B1): the engine's
//!   registry is consulted BEFORE the child spawns, so a duplicate has zero
//!   side effects and answers with the op's current status.
//! * The runner-side initial attachment is generation 1 with the (clamped)
//!   `window_bytes` from OpStart — consumer generations are 1-based Temporal
//!   attempt numbers, and an equal-generation re-attach is idempotent.
//! * `window_bytes` is clamped UP to the derived frame size with a warning,
//!   never rejected (a window smaller than one frame can admit no data frame
//!   and would stall the op silently).
//! * `OpCancel`/`OpQuery`/`OpAttach` are op-control, not host work: served
//!   inline without admission (admission gates job STARTS, never byte flow).
//! * A final `OpAck` reaches the registry only THROUGH the pump (it fences
//!   consumer generations); this module only routes.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opengeni_agent_engine::admission::JobClass;
use opengeni_agent_engine::registry::{LostReason, QueryAnswer};
use opengeni_agent_engine::{Channel, Frame, FrameBody, OpId};
use opengeni_agent_platform::Platform;
use opengeni_agent_proto::v1::{
    self, control_response::Result as RespResult, AgentError, ControlResponse, ErrorCode,
};
use prost::Message as _;
use tracing::{debug, warn};

use crate::engine::{Engine, OpHandles, StartOutcome};
use crate::job::{ChannelStats, JobCommand, JobExit, JobFailure, JobOutcome};

/// A publish sink already bound to one op's frame subject. Fire-and-forget:
/// the pump never blocks on it and a dropped frame heals via replay.
pub type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// The initial send-credit window when `OpStart.window_bytes` is 0 — a pacing
/// SETPOINT (rule P), not a limit: the server resizes it freely via OpAck's
/// absolute `credit_bytes`.
const DEFAULT_WINDOW_BYTES: u64 = 4 * 1024 * 1024;

/// Serves `OpStart`: admission (fair ordering + breakers), idempotent begin,
/// contained spawn, pump launch with the frame-publishing hook, and the
/// runner-side initial attachment. Replies `OpStarted{accepted, status}`.
pub async fn serve_op_start<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    publish: FrameSink,
    request_id: String,
    start: v1::OpStart,
) -> ControlResponse {
    use v1::op_start::Op;
    let exec = match start.op {
        Some(Op::Exec(exec)) => exec,
        Some(Op::FsRead(_) | Op::FsWrite(_)) => {
            return error_reply(
                request_id,
                ErrorCode::Unsupported,
                "op-stream fs_read/fs_write land with the M7 chunked-write milestone; \
                 use the legacy fs ops",
                false,
            );
        }
        None => {
            return error_reply(
                request_id,
                ErrorCode::Protocol,
                "OpStart carried no op",
                false,
            );
        }
    };

    let op_id = OpId::new(request_id.clone());
    let origin = if start.origin_id.is_empty() {
        "unknown"
    } else {
        &start.origin_id
    };
    let ticket = match engine.admit(&op_id, JobClass::Heavy, origin).await {
        Ok(ticket) => ticket,
        Err(reason) => return crate::dispatch::breaker_reply_error(request_id, "op_start", reason),
    };

    let window = clamp_window(engine, &op_id, start.window_bytes);
    let deadline = deadline_instant(start.deadline_ms);
    let stdin = exec.stdin.to_vec();
    let outcome = engine.start_job(
        &op_id,
        ticket,
        stdin,
        deadline,
        || platform.spawn_exec(&exec),
        frame_publisher(publish, request_id.clone()),
        |exit| wire_exit(exit).encode_to_vec(),
        |_, _| {},
    );

    match outcome {
        StartOutcome::Started(started) => {
            started
                .handles
                .window_bytes
                .store(window, Ordering::Relaxed);
            // The server subscribed before sending OpStart (protocol
            // invariant), so it is attached from the first frame.
            let _ = started
                .mailbox
                .send(JobCommand::Attach {
                    generation: 1,
                    from_seq: 0,
                    window_bytes: window,
                })
                .await;
            started_reply(
                request_id.clone(),
                true,
                op_status(
                    &request_id,
                    QueryAnswer::Running {
                        cancel_requested: false,
                    },
                    Some(&started.handles),
                ),
            )
        }
        StartOutcome::Known { answer, handles } => {
            debug!(op = %op_id, ?answer, "duplicate OpStart attaches to the known op");
            let status = op_status(&request_id, answer, handles.as_ref());
            started_reply(request_id, true, status)
        }
        StartOutcome::SpawnFailed { error, handles } => {
            // Stash a typed terminal record so late duplicates and queries see
            // a settled failure instead of an empty Complete.
            let _ = handles.exit.set(JobExit {
                outcome: JobOutcome::Failed(JobFailure::PipeIo {
                    detail: format!("spawn failed: {error}"),
                }),
                duration_ms: 0,
                stdout: empty_channel(),
                stderr: empty_channel(),
            });
            ControlResponse {
                request_id,
                error: Some(error.to_agent_error()),
                result: None,
            }
        }
        StartOutcome::BornCancelled => {
            // Ruling M5: an OpCancel that raced ahead wins — zero spawns, an
            // immediate cancelled terminal status.
            let status = cancelled_status(&request_id);
            started_reply(request_id, false, status)
        }
    }
}

/// The send window for a job: the OpStart grant (or the setpoint default),
/// clamped UP so at least one data frame fits — a sub-frame window would
/// stall the stream silently. Never rejected (LIMITS-DOCTRINE).
fn clamp_window(engine: &Arc<Engine>, op_id: &OpId, requested: u64) -> u64 {
    let window = if requested == 0 {
        DEFAULT_WINDOW_BYTES
    } else {
        requested
    };
    let frame_floor = u64::try_from(engine.max_frame_bytes()).unwrap_or(u64::MAX);
    if window < frame_floor {
        warn!(
            op = %op_id,
            requested,
            clamped_to = frame_floor,
            "OpStart window below one data frame; clamped up"
        );
        return frame_floor;
    }
    window
}

/// A terminal cancelled `OpStatus` (born-cancelled ops and tombstone queries).
fn cancelled_status(op_id: &str) -> v1::OpStatus {
    v1::OpStatus {
        op_id: op_id.to_string(),
        state: v1::OpState::Complete as i32,
        next_seq: 0,
        exit: Some(v1::OpExit {
            cancelled: true,
            exit_code: -1,
            ..Default::default()
        }),
        lost_reason: v1::OpLostReason::Unspecified as i32,
    }
}

/// Serves `OpCancel`: registry flag/tombstone + kill delivery. Idempotent;
/// replies the op's current status (the terminal frame follows on the op
/// subject for a running op).
pub fn serve_op_cancel(
    engine: &Arc<Engine>,
    request_id: String,
    cancel: &v1::OpCancel,
) -> ControlResponse {
    let op_id = OpId::new(cancel.op_id.clone());
    let outcome = engine.cancel(&op_id);
    debug!(op = %op_id, ?outcome, "op cancel");
    status_reply(engine, request_id, &op_id)
}

/// Serves `OpQuery`: the op's phase, watermark, and terminal record.
pub fn serve_op_query(
    engine: &Arc<Engine>,
    request_id: String,
    query: &v1::OpQuery,
) -> ControlResponse {
    let op_id = OpId::new(query.op_id.clone());
    status_reply(engine, request_id, &op_id)
}

/// Serves `OpAttach`: routes the (generation-fenced, pump-side) attach +
/// replay trigger, and replies the current status so the consumer can gap-
/// check its floor against `next_seq`. An attach with `window_bytes: 0`
/// resumes under the window granted at OpStart.
pub fn serve_op_attach(
    engine: &Arc<Engine>,
    request_id: String,
    attach: &v1::OpAttach,
) -> ControlResponse {
    let op_id = OpId::new(attach.op_id.clone());
    let window = if attach.window_bytes > 0 {
        attach.window_bytes
    } else {
        engine.handles(&op_id).map_or(DEFAULT_WINDOW_BYTES, |h| {
            h.window_bytes.load(Ordering::Relaxed)
        })
    };
    let routed = engine.route_command(
        &op_id,
        JobCommand::Attach {
            generation: attach.attach_generation,
            from_seq: attach.from_seq,
            window_bytes: window,
        },
    );
    if !routed {
        debug!(op = %op_id, "attach for an op with no live pump (lost/gone); status answers");
    }
    status_reply(engine, request_id, &op_id)
}

/// Sinks one `OpAck` from the ack subject into the op's pump. The pump owns
/// generation fencing AND final-ack acceptance (the registry flips final-acked
/// only when the pump ends `FinalAcked`), so this is pure routing.
pub fn handle_op_ack(engine: &Arc<Engine>, ack: &v1::OpAck) {
    let op_id = OpId::new(ack.op_id.clone());
    let routed = engine.route_command(
        &op_id,
        JobCommand::Ack {
            generation: ack.attach_generation,
            acked_seq: ack.acked_seq,
            credit_bytes: ack.credit_bytes,
            final_ack: ack.r#final,
        },
    );
    if !routed {
        debug!(op = %op_id, "ack for an op with no live pump (already collected or gone)");
    }
}

/// Builds the frame-publishing emit hook: engine [`Frame`]s become encoded
/// `OpFrame`s on the sink. The retained Exit payload IS the encoded `OpExit`,
/// decoded back for the typed oneof (uniform for live emission and replay).
fn frame_publisher(publish: FrameSink, op_id: String) -> impl Fn(Frame) + Send + 'static {
    move |frame| {
        let body = match frame.body {
            FrameBody::Data { channel, bytes } => v1::op_frame::Body::Data(v1::OpData {
                channel: wire_channel(channel) as i32,
                bytes: bytes.into(),
            }),
            FrameBody::Progress => v1::op_frame::Body::Progress(v1::OpProgress {}),
            FrameBody::Exit { payload } => match v1::OpExit::decode(payload.as_slice()) {
                Ok(exit) => v1::op_frame::Body::Exit(exit),
                Err(error) => {
                    warn!(%error, "retained exit payload undecodable; frame not published");
                    return;
                }
            },
        };
        let wire = v1::OpFrame {
            op_id: op_id.clone(),
            seq: frame.seq,
            body: Some(body),
        };
        publish(wire.encode_to_vec());
    }
}

/// The engine→wire channel mapping.
fn wire_channel(channel: Channel) -> v1::OpChannel {
    match channel {
        Channel::Stdout => v1::OpChannel::Stdout,
        Channel::Stderr => v1::OpChannel::Stderr,
        Channel::Content => v1::OpChannel::Content,
    }
}

/// Maps the pump's terminal record to the wire `OpExit` — runner-decided
/// deaths carry a typed `failure_code` + exact counters, NEVER an ambiguous
/// exit-code sentinel (FAILURE-VISIBILITY.md).
pub fn wire_exit(exit: &JobExit) -> v1::OpExit {
    let mut wire = v1::OpExit {
        exit_code: -1,
        timed_out: false,
        cancelled: false,
        duration_ms: exit.duration_ms,
        digests: [
            (
                "stdout".to_string(),
                exit.stdout.digest.to_hex().to_string(),
            ),
            (
                "stderr".to_string(),
                exit.stderr.digest.to_hex().to_string(),
            ),
        ]
        .into(),
        totals: [
            ("stdout".to_string(), exit.stdout.total_bytes),
            ("stderr".to_string(), exit.stderr.total_bytes),
        ]
        .into(),
        failure_code: String::new(),
        failure_detail: std::collections::HashMap::new(),
    };
    match &exit.outcome {
        JobOutcome::Exited { exit_code } => wire.exit_code = *exit_code,
        JobOutcome::TimedOut => wire.timed_out = true,
        JobOutcome::Cancelled => wire.cancelled = true,
        JobOutcome::Failed(failure) => {
            let (code, detail) = failure_fields(failure);
            wire.failure_code = code.to_string();
            wire.failure_detail = detail;
        }
    }
    wire
}

/// The typed wire fields for a runner-decided failure.
fn failure_fields(
    failure: &JobFailure,
) -> (&'static str, std::collections::HashMap<String, String>) {
    let mut detail = std::collections::HashMap::new();
    match failure {
        JobFailure::Overflow { retained_bytes } => {
            detail.insert("retained_bytes".to_string(), retained_bytes.to_string());
            ("OP_OVERFLOW", detail)
        }
        JobFailure::SpoolIo { detail: text } => {
            detail.insert("io_error".to_string(), text.clone());
            ("OP_SPOOL_IO", detail)
        }
        JobFailure::PipeIo { detail: text } => {
            detail.insert("io_error".to_string(), text.clone());
            ("OP_PIPE_IO", detail)
        }
    }
}

/// Builds the `OpStatus` for a phase + (optional) live handles. A recorded
/// COLLECTION failure (post-exit replay unrecoverable) rides the embedded
/// `OpExit`'s failure fields with `phase: post_exit_replay`, so a consumer
/// re-attaching for frames learns from the status reply to stop waiting —
/// the terminal record (digests, totals, code) is still authoritative.
fn op_status(op_id: &str, answer: QueryAnswer, handles: Option<&OpHandles>) -> v1::OpStatus {
    let next_seq = handles.map_or(0, |h| h.watermark.load(Ordering::Relaxed) + 1);
    let (state, exit, lost) = match answer {
        QueryAnswer::Running { .. } => (v1::OpState::Running, None, None),
        QueryAnswer::Complete { .. } => (
            v1::OpState::Complete,
            handles.and_then(|h| h.exit.get()).map(|record| {
                let mut exit = wire_exit(record);
                if let Some(failure) = handles.and_then(|h| h.collection_failure.get()) {
                    let (code, mut detail) = failure_fields(failure);
                    detail.insert("phase".to_string(), "post_exit_replay".to_string());
                    if exit.failure_code.is_empty() {
                        exit.failure_code = code.to_string();
                        exit.failure_detail = detail;
                    } else {
                        // The op ALSO died typed in its own right; keep that
                        // primary and annotate the collection loss.
                        exit.failure_detail
                            .insert("collection_failure".to_string(), code.to_string());
                        exit.failure_detail.extend(detail);
                    }
                }
                exit
            }),
            None,
        ),
        QueryAnswer::Lost(reason) => (
            v1::OpState::Lost,
            None,
            Some(match reason {
                LostReason::Evicted => v1::OpLostReason::Evicted,
                LostReason::RunnerRestarted => v1::OpLostReason::AgentRestarted,
            }),
        ),
        // A tombstone is "cancelled before it ever began": terminal, typed.
        QueryAnswer::Tombstoned => (
            v1::OpState::Complete,
            Some(v1::OpExit {
                cancelled: true,
                exit_code: -1,
                ..Default::default()
            }),
            None,
        ),
        QueryAnswer::Unknown => (v1::OpState::Unspecified, None, None),
    };
    v1::OpStatus {
        op_id: op_id.to_string(),
        state: state as i32,
        next_seq,
        exit,
        lost_reason: lost.unwrap_or(v1::OpLostReason::Unspecified) as i32,
    }
}

/// A status-carrying reply for cancel/query/attach.
fn status_reply(engine: &Arc<Engine>, request_id: String, op_id: &OpId) -> ControlResponse {
    let answer = engine.query(op_id);
    let handles = engine.handles(op_id);
    ControlResponse {
        request_id,
        error: None,
        result: Some(RespResult::OpStatus(op_status(
            op_id.as_str(),
            answer,
            handles.as_ref(),
        ))),
    }
}

/// The `OpStarted` reply.
fn started_reply(request_id: String, accepted: bool, status: v1::OpStatus) -> ControlResponse {
    ControlResponse {
        request_id,
        error: None,
        result: Some(RespResult::OpStart(v1::OpStarted {
            accepted,
            status: Some(status),
        })),
    }
}

/// Converts the wire's absolute unix-epoch deadline to a runtime instant. A
/// deadline already in the past fires immediately (the runner's enforcement is
/// authoritative; the server's clock is advisory but its intent is clear).
fn deadline_instant(deadline_epoch_ms: i64) -> Option<tokio::time::Instant> {
    if deadline_epoch_ms <= 0 {
        return None;
    }
    let now_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let remaining_ms = u64::try_from(deadline_epoch_ms.saturating_sub(now_epoch_ms)).unwrap_or(0);
    Some(tokio::time::Instant::now() + Duration::from_millis(remaining_ms))
}

/// An empty channel record (spawn-failure exits have no streams).
fn empty_channel() -> ChannelStats {
    ChannelStats {
        total_bytes: 0,
        digest: blake3::hash(b""),
    }
}

/// A small typed error reply.
fn error_reply(
    request_id: String,
    code: ErrorCode,
    message: &str,
    retryable: bool,
) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: code as i32,
            message: message.to_string(),
            retryable,
            detail: std::collections::HashMap::new(),
        }),
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use opengeni_agent_engine::admission::AdmissionConfig;
    use opengeni_agent_engine::HostCapacity;
    use opengeni_agent_platform::NativePlatform;

    use super::*;

    struct Rig {
        engine: Arc<Engine>,
        platform: Arc<NativePlatform>,
        frames: Arc<Mutex<Vec<v1::OpFrame>>>,
        _dir: tempfile::TempDir,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("tempdir");
        Rig {
            engine: Engine::with_admission(
                dir.path().join("spool"),
                HostCapacity::default(),
                AdmissionConfig::default(),
            ),
            platform: Arc::new(NativePlatform::with_root(std::env::temp_dir())),
            frames: Arc::new(Mutex::new(Vec::new())),
            _dir: dir,
        }
    }

    impl Rig {
        fn sink(&self) -> FrameSink {
            let frames = self.frames.clone();
            Arc::new(move |bytes: Vec<u8>| {
                let frame = v1::OpFrame::decode(bytes.as_slice()).expect("wire frame decodes");
                frames.lock().expect("frames").push(frame);
            })
        }

        async fn start_exec(&self, op_id: &str, script: &str, window: u64) -> ControlResponse {
            serve_op_start(
                &self.engine,
                &self.platform,
                self.sink(),
                op_id.to_string(),
                v1::OpStart {
                    op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                        command: vec![script.to_string()],
                        shell: true,
                        ..Default::default()
                    })),
                    window_bytes: window,
                    deadline_ms: 0,
                    origin_id: "session-1".to_string(),
                },
            )
            .await
        }

        async fn wait_for_exit_frame(&self) -> v1::OpExit {
            for _ in 0..500 {
                if let Some(exit) =
                    self.frames
                        .lock()
                        .expect("frames")
                        .iter()
                        .find_map(|f| match &f.body {
                            Some(v1::op_frame::Body::Exit(e)) => Some(e.clone()),
                            _ => None,
                        })
                {
                    return exit;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no exit frame arrived");
        }

        fn stdout_bytes(&self) -> Vec<u8> {
            let mut chunks: Vec<(u64, Vec<u8>)> = self
                .frames
                .lock()
                .expect("frames")
                .iter()
                .filter_map(|f| match &f.body {
                    Some(v1::op_frame::Body::Data(d))
                        if d.channel == v1::OpChannel::Stdout as i32 =>
                    {
                        Some((f.seq, d.bytes.to_vec()))
                    }
                    _ => None,
                })
                .collect();
            chunks.sort_by_key(|(seq, _)| *seq);
            chunks.dedup_by_key(|(seq, _)| *seq);
            chunks.into_iter().flat_map(|(_, b)| b).collect()
        }
    }

    fn started_status(resp: &ControlResponse) -> (bool, v1::OpStatus) {
        match &resp.result {
            Some(RespResult::OpStart(started)) => (
                started.accepted,
                started.status.clone().expect("status present"),
            ),
            other => panic!("expected OpStarted, got {other:?} / {:?}", resp.error),
        }
    }

    #[tokio::test]
    async fn op_start_streams_frames_and_a_typed_exit() {
        let rig = rig();
        let resp = rig.start_exec("op-1", "printf wire; exit 3", 1 << 20).await;
        let (accepted, status) = started_status(&resp);
        assert!(accepted);
        assert_eq!(status.state, v1::OpState::Running as i32);

        let exit = rig.wait_for_exit_frame().await;
        assert_eq!(exit.exit_code, 3);
        assert!(exit.failure_code.is_empty());
        assert_eq!(rig.stdout_bytes(), b"wire");
        assert_eq!(
            exit.digests.get("stdout").map(String::as_str),
            Some(blake3::hash(b"wire").to_hex().as_str()),
            "wire digest proves byte-exact assembly"
        );
        assert_eq!(exit.totals.get("stdout"), Some(&4));

        // Query answers COMPLETE with the same record.
        let q = serve_op_query(
            &rig.engine,
            "q-1".to_string(),
            &v1::OpQuery {
                op_id: "op-1".to_string(),
            },
        );
        match q.result {
            Some(RespResult::OpStatus(s)) => {
                assert_eq!(s.state, v1::OpState::Complete as i32);
                assert_eq!(s.exit.expect("exit present").exit_code, 3);
                assert!(s.next_seq > 1);
            }
            other => panic!("expected OpStatus, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn duplicate_op_start_attaches_and_never_reruns() {
        let rig = rig();
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("ran");
        let script = format!("echo x >> {}; printf done", marker.display());

        let first = rig.start_exec("op-dup", &script, 1 << 20).await;
        assert!(started_status(&first).0);
        rig.wait_for_exit_frame().await;

        let second = rig.start_exec("op-dup", &script, 1 << 20).await;
        let (accepted, status) = started_status(&second);
        assert!(accepted, "a known op is acknowledged, not re-run");
        assert_eq!(status.state, v1::OpState::Complete as i32);
        assert_eq!(
            std::fs::read_to_string(&marker)
                .expect("marker written")
                .lines()
                .count(),
            1,
            "the command ran exactly once"
        );
    }

    #[tokio::test]
    async fn cancel_before_start_wins_and_spawns_nothing() {
        let rig = rig();
        let cancel = serve_op_cancel(
            &rig.engine,
            "c-1".to_string(),
            &v1::OpCancel {
                op_id: "op-early".to_string(),
            },
        );
        assert!(cancel.error.is_none());

        let resp = rig
            .start_exec("op-early", "echo should-not-run", 1 << 20)
            .await;
        let (accepted, status) = started_status(&resp);
        assert!(!accepted, "a tombstoned op is refused");
        assert_eq!(status.state, v1::OpState::Complete as i32);
        assert!(status.exit.expect("terminal").cancelled);
        assert!(rig.frames.lock().expect("frames").is_empty(), "zero spawns");
    }

    #[tokio::test]
    async fn cancel_kills_a_running_op_and_the_exit_frame_says_cancelled() {
        let rig = rig();
        let resp = rig.start_exec("op-kill", "sleep 30", 1 << 20).await;
        assert!(started_status(&resp).0);

        let c = serve_op_cancel(
            &rig.engine,
            "c-2".to_string(),
            &v1::OpCancel {
                op_id: "op-kill".to_string(),
            },
        );
        assert!(c.error.is_none());
        let exit = rig.wait_for_exit_frame().await;
        assert!(exit.cancelled);
    }

    #[tokio::test]
    async fn post_exit_attach_replays_and_final_ack_releases_the_op() {
        let rig = rig();
        let resp = rig.start_exec("op-replay", "printf payload", 1 << 20).await;
        assert!(started_status(&resp).0);
        rig.wait_for_exit_frame().await;

        let seen_before = rig.frames.lock().expect("frames").len();
        // A reconnecting consumer (generation 2) re-collects from seq 0 under
        // the OpStart window (wire window_bytes: 0 = reuse).
        let attach = serve_op_attach(
            &rig.engine,
            "a-1".to_string(),
            &v1::OpAttach {
                op_id: "op-replay".to_string(),
                from_seq: 0,
                attach_generation: 2,
                window_bytes: 0,
            },
        );
        match attach.result {
            Some(RespResult::OpStatus(s)) => assert_eq!(s.state, v1::OpState::Complete as i32),
            other => panic!("expected OpStatus, got {other:?}"),
        }
        // Replay lands: at least data+exit re-published.
        for _ in 0..500 {
            if rig.frames.lock().expect("frames").len() >= seen_before + 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(rig.stdout_bytes(), b"payload", "seq-deduped reassembly");

        // Final ack (current generation) → the pump ends → route disappears →
        // the registry entry is final-acked (GC-quiet).
        let exit_seq = rig
            .frames
            .lock()
            .expect("frames")
            .iter()
            .filter(|f| matches!(f.body, Some(v1::op_frame::Body::Exit(_))))
            .map(|f| f.seq)
            .max()
            .expect("exit frame seen");
        handle_op_ack(
            &rig.engine,
            &v1::OpAck {
                op_id: "op-replay".to_string(),
                acked_seq: exit_seq,
                credit_bytes: 1 << 20,
                r#final: true,
                attach_generation: 2,
            },
        );
        let op = OpId::from("op-replay");
        for _ in 0..500 {
            if !rig.engine.route_command(&op, JobCommand::Detach) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !rig.engine.route_command(&op, JobCommand::Detach),
            "pump ended after the final ack"
        );
        assert!(matches!(
            rig.engine.query(&op),
            QueryAnswer::Complete {
                final_acked: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn tiny_window_is_clamped_up_never_rejected() {
        let rig = rig();
        // window_bytes: 1 would stall (no data frame fits); the runner clamps.
        let resp = rig.start_exec("op-clamp", "printf clamped", 1).await;
        assert!(started_status(&resp).0);
        let exit = rig.wait_for_exit_frame().await;
        assert_eq!(exit.exit_code, 0);
        assert_eq!(
            rig.stdout_bytes(),
            b"clamped",
            "data flowed despite the tiny request"
        );
    }

    #[test]
    fn wire_exit_carries_typed_failures_without_sentinels() {
        let exit = JobExit {
            outcome: JobOutcome::Failed(JobFailure::Overflow {
                retained_bytes: 12345,
            }),
            duration_ms: 7,
            stdout: empty_channel(),
            stderr: empty_channel(),
        };
        let wire = wire_exit(&exit);
        assert_eq!(wire.failure_code, "OP_OVERFLOW");
        assert_eq!(
            wire.failure_detail
                .get("retained_bytes")
                .map(String::as_str),
            Some("12345")
        );
        assert!(!wire.timed_out);
        assert!(!wire.cancelled);
    }

    #[test]
    fn deadlines_convert_from_epoch_ms() {
        assert!(deadline_instant(0).is_none());
        assert!(deadline_instant(-5).is_none());
        let now_epoch_ms = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("epoch")
                .as_millis(),
        )
        .expect("fits");
        let soon = deadline_instant(now_epoch_ms + 60_000).expect("deadline");
        let remaining = soon.saturating_duration_since(tokio::time::Instant::now());
        assert!(remaining > Duration::from_secs(50) && remaining < Duration::from_secs(70));
        // A past deadline fires immediately rather than being dropped.
        let past = deadline_instant(now_epoch_ms - 60_000).expect("deadline");
        assert!(past <= tokio::time::Instant::now());
    }
}
