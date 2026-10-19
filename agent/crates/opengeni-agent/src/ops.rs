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

use crate::engine::{scoped_op_id, scoped_origin, Engine, OpHandles, StartOutcome};
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
#[cfg(test)]
pub async fn serve_op_start<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    publish: FrameSink,
    request_id: String,
    start: v1::OpStart,
) -> ControlResponse {
    serve_op_start_scoped(engine, platform, "default", publish, request_id, start).await
}

/// Multi-connection form of [`serve_op_start`]. `scope` is local-only and never
/// changes the wire op id or frame subject.
#[cfg(test)]
pub async fn serve_op_start_scoped<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    scope: &str,
    publish: FrameSink,
    request_id: String,
    start: v1::OpStart,
) -> ControlResponse {
    serve_op_start_scoped_with_policy(
        engine, platform, scope, publish, request_id, start, None, None, None,
    )
    .await
}

/// Policy-aware multi-connection form. The policy snapshot is part of the
/// idempotent OpStart request; the first accepted start owns it and later
/// duplicates attach to that same operation without re-spawning.
/// `frame_subject` is where `publish` sends frames; when given, an in-place
/// agent update may hand the job to its successor instead of waiting for it.
#[allow(clippy::too_many_arguments)] // a routing seam; bundling would just rename the parts
#[allow(clippy::too_many_lines)] // one admission-to-start sequence
pub async fn serve_op_start_scoped_with_policy<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    scope: &str,
    publish: FrameSink,
    request_id: String,
    start: v1::OpStart,
    resource_policy: Option<v1::OperationResourcePolicy>,
    frame_subject: Option<String>,
    completion_sink: Option<FrameSink>,
) -> ControlResponse {
    let mut exec = match extract_exec(&request_id, start.op) {
        Ok(exec) => exec,
        Err(reply) => return *reply,
    };
    if crate::uploads::is_upload_id(&request_id) {
        return error_reply(
            request_id,
            ErrorCode::Protocol,
            "fsw- operation IDs are reserved for transactional uploads",
            false,
        );
    }
    crate::codemode::expose_native_client(&mut exec);

    // The op id is interpolated into the frame subject
    // (`agent.<ws>.<id>.op.<op_id>`): a NATS-illegal token (empty,
    // whitespace, '.', '*', '>') would make every frame publish fail and the
    // op present as HUNG — reject it loud + typed instead (design-review
    // fold-in).
    if let Err(reason) = validate_subject_token(&request_id) {
        return error_reply(
            request_id,
            ErrorCode::Protocol,
            &format!("op_id is not a legal frame-subject token ({reason})"),
            false,
        );
    }
    let op_id = scoped_op_id(scope, &request_id);
    let origin = if start.origin_id.is_empty() {
        "unknown"
    } else {
        &start.origin_id
    };
    let origin = scoped_origin(scope, origin);
    let ticket = match engine.admit(&op_id, JobClass::Heavy, &origin).await {
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
        || platform.spawn_exec_with_policy(&exec, resource_policy.as_ref()),
        frame_publisher(publish, request_id.clone()),
        |exit| wire_exit(exit).encode_to_vec(),
        completion_publisher(completion_sink, request_id.clone()),
    );

    match outcome {
        StartOutcome::Started(started) => {
            started
                .handles
                .window_bytes
                .store(window, Ordering::Relaxed);
            if let Some(subject) = frame_subject {
                // The job's own reservation must not hold an update back:
                // the update hands the job over instead of waiting for it.
                if let Some(reservation) = opengeni_agent_platform::current_work_reservation() {
                    reservation.mark_handover();
                }
                engine.mark_handover_capable(
                    &op_id,
                    &started.handles,
                    crate::engine::OpHandoverTag {
                        scope: scope.to_string(),
                        request_id: request_id.clone(),
                        subject,
                        window_bytes: window,
                        connection_generation: 0,
                    },
                );
            }
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
                background_children_stopped: false,
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
        write_offset: 0,
    }
}

/// Serves `OpCancel`: registry flag/tombstone + kill delivery. Idempotent;
/// replies the op's current status (the terminal frame follows on the op
/// subject for a running op).
#[cfg(test)]
pub fn serve_op_cancel(
    engine: &Arc<Engine>,
    request_id: String,
    cancel: &v1::OpCancel,
) -> ControlResponse {
    serve_op_cancel_scoped(engine, "default", request_id, cancel)
}

/// Multi-connection form of [`serve_op_cancel`].
pub fn serve_op_cancel_scoped(
    engine: &Arc<Engine>,
    scope: &str,
    request_id: String,
    cancel: &v1::OpCancel,
) -> ControlResponse {
    let op_id = scoped_op_id(scope, &cancel.op_id);
    let outcome = engine.cancel(&op_id);
    debug!(op = %op_id, ?outcome, "op cancel");
    status_reply(engine, request_id, &op_id, &cancel.op_id)
}

/// Serves `OpQuery`: the op's phase, watermark, and terminal record.
#[cfg(test)]
pub fn serve_op_query(
    engine: &Arc<Engine>,
    request_id: String,
    query: &v1::OpQuery,
) -> ControlResponse {
    serve_op_query_scoped(engine, "default", request_id, query)
}

/// Multi-connection form of [`serve_op_query`].
pub fn serve_op_query_scoped(
    engine: &Arc<Engine>,
    scope: &str,
    request_id: String,
    query: &v1::OpQuery,
) -> ControlResponse {
    let op_id = scoped_op_id(scope, &query.op_id);
    status_reply(engine, request_id, &op_id, &query.op_id)
}

/// Serves `OpAttach`: routes the (generation-fenced, pump-side) attach +
/// replay trigger, and replies the current status so the consumer can gap-
/// check its floor against `next_seq`. An attach with `window_bytes: 0`
/// resumes under the window granted at OpStart.
#[cfg(test)]
pub fn serve_op_attach(
    engine: &Arc<Engine>,
    request_id: String,
    attach: &v1::OpAttach,
) -> ControlResponse {
    serve_op_attach_scoped(engine, "default", request_id, attach)
}

/// Multi-connection form of [`serve_op_attach`].
pub fn serve_op_attach_scoped(
    engine: &Arc<Engine>,
    scope: &str,
    request_id: String,
    attach: &v1::OpAttach,
) -> ControlResponse {
    let op_id = scoped_op_id(scope, &attach.op_id);
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
    status_reply(engine, request_id, &op_id, &attach.op_id)
}

/// Serves `OpRelease`: the server stored the op's output through its terminal
/// frame, so the runner drops the op now and confirms in the reply (LOST,
/// RELEASED). A duplicate release, attach or query answers the same. An op
/// still running, or completed with another terminal frame, answers its
/// actual status and is left untouched.
#[cfg(test)]
pub fn serve_op_release(
    engine: &Arc<Engine>,
    request_id: String,
    release: &v1::OpRelease,
) -> ControlResponse {
    serve_op_release_scoped(engine, "default", request_id, release)
}

/// Multi-connection form of [`serve_op_release`].
pub fn serve_op_release_scoped(
    engine: &Arc<Engine>,
    scope: &str,
    request_id: String,
    release: &v1::OpRelease,
) -> ControlResponse {
    let op_id = scoped_op_id(scope, &release.op_id);
    let outcome = engine.release(&op_id, release.exit_seq);
    debug!(op = %op_id, ?outcome, "op release");
    status_reply(engine, request_id, &op_id, &release.op_id)
}

/// Sinks one `OpAck` from the ack subject into the op's pump. The pump owns
/// generation fencing AND final-ack acceptance (the registry flips final-acked
/// only when the pump ends `FinalAcked`), so this is pure routing.
#[cfg(test)]
pub fn handle_op_ack(engine: &Arc<Engine>, ack: &v1::OpAck) {
    handle_op_ack_scoped(engine, "default", ack);
}

/// Decode a notification-only receipt, never an output credit or final ACK.
pub fn handle_completion_ack_scoped(engine: &Engine, scope: &str, payload: &[u8]) -> bool {
    if let Ok(v1::AgentEventAck {
        ack: Some(v1::agent_event_ack::Ack::OperationCompleted(ack)),
    }) = v1::AgentEventAck::decode(payload)
    {
        engine.acknowledge_completion(scope, &ack.op_id);
        true
    } else {
        false
    }
}

/// Handle an `AgentEventAck` on a link's ack subject: a completion receipt or
/// an inventory answer. `false` when the payload is neither (an `OpAck`).
pub fn handle_event_ack_scoped(engine: &Engine, scope: &str, payload: &[u8]) -> bool {
    handle_completion_ack_scoped(engine, scope, payload)
        || handle_inventory_ack_scoped(engine, scope, payload)
}

/// Decode Opengeni's answer to one page of a link's operation inventory and
/// stop what it no longer recognises. `true` when the payload was such an
/// answer (applied or stale).
pub fn handle_inventory_ack_scoped(engine: &Engine, scope: &str, payload: &[u8]) -> bool {
    if let Ok(v1::AgentEventAck {
        ack: Some(v1::agent_event_ack::Ack::OperationInventory(ack)),
    }) = v1::AgentEventAck::decode(payload)
    {
        if engine.apply_inventory_answer(scope, &ack).is_none() {
            debug!(
                scope,
                report = ack.report_id,
                page = ack.page,
                "stale inventory answer ignored"
            );
        }
        true
    } else {
        false
    }
}

/// One page of a link's operation inventory, as the event that carries it.
pub(crate) fn inventory_event(page: v1::OperationInventory) -> v1::AgentEvent {
    v1::AgentEvent {
        agent_id: String::new(),
        event: Some(v1::agent_event::Event::OperationInventory(page)),
    }
}

/// Multi-connection output acknowledgement, independent of notification receipts.
pub fn handle_op_ack_scoped(engine: &Arc<Engine>, scope: &str, ack: &v1::OpAck) {
    let op_id = scoped_op_id(scope, &ack.op_id);
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
pub(crate) fn frame_publisher(
    publish: FrameSink,
    op_id: String,
) -> impl Fn(Frame) + Send + 'static {
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

/// Publish terminal proof even when there is no output consumer or send credit.
/// The bulk publisher retries retained, unacknowledged completions independently
/// of frame credit; this immediate hook never acknowledges output.
pub(crate) fn completion_publisher(
    publish: Option<FrameSink>,
    op_id: String,
) -> impl FnOnce(Option<u64>, &JobExit) + Send + 'static {
    move |_, exit| {
        if let Some(publish) = publish {
            publish(completion_event(op_id, exit).encode_to_vec());
        }
    }
}

pub(crate) fn completion_event(op_id: String, exit: &JobExit) -> v1::AgentEvent {
    v1::AgentEvent {
        agent_id: String::new(),
        event: Some(v1::agent_event::Event::OperationCompleted(
            v1::OperationCompleted {
                op_id,
                exit: Some(wire_exit(exit)),
            },
        )),
    }
}

/// Extracts the exec op from the OpStart oneof. Transactional fs_write is served
/// separately by the supervisor's upload route and independent capability gate;
/// op_stream alone does not implement filesystem streaming.
fn extract_exec(
    request_id: &str,
    op: Option<v1::op_start::Op>,
) -> Result<v1::ExecRequest, Box<ControlResponse>> {
    use v1::op_start::Op;
    match op {
        Some(Op::Exec(exec)) => Ok(exec),
        Some(Op::FsRead(_) | Op::FsWrite(_)) => Err(Box::new(error_reply(
            request_id.to_string(),
            ErrorCode::Unsupported,
            "filesystem operations do not use the exec stream pump; transactional \
             writes require the separately advertised upload capability and route",
            false,
        ))),
        None => Err(Box::new(error_reply(
            request_id.to_string(),
            ErrorCode::Protocol,
            "OpStart carried no op",
            false,
        ))),
    }
}

/// Validates a string as a single NATS subject TOKEN: non-empty, no
/// whitespace/control characters, and none of the subject-structure
/// characters (`.` separator, `*`/`>` wildcards). An illegal op id would
/// poison the frame subject — every publish fails and the op presents as
/// hung.
fn validate_subject_token(token: &str) -> Result<(), &'static str> {
    if token.is_empty() {
        return Err("empty");
    }
    for c in token.chars() {
        if c.is_whitespace() || c.is_control() {
            return Err("contains whitespace/control characters");
        }
        if matches!(c, '.' | '*' | '>') {
            return Err("contains subject-structure characters ('.', '*', '>')");
        }
    }
    Ok(())
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
        background_children_stopped: exit.background_children_stopped,
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
                LostReason::Released => v1::OpLostReason::Released,
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
        // Pre-journal rule (PROTOCOL §Op lifecycle): an id this runner does
        // not know was lost to a restart (or its lost-marker aged out) — a
        // compliant server only asks about ops it issued, so the honest typed
        // answer is LOST{agent_restarted}, never a silent UNSPECIFIED. The
        // PR-7 journal upgrades this to a precise answer.
        QueryAnswer::Unknown => (
            v1::OpState::Lost,
            None,
            Some(v1::OpLostReason::AgentRestarted),
        ),
    };
    v1::OpStatus {
        op_id: op_id.to_string(),
        state: state as i32,
        next_seq,
        exit,
        lost_reason: lost.unwrap_or(v1::OpLostReason::Unspecified) as i32,
        write_offset: 0,
    }
}

/// A status-carrying reply for cancel/query/attach.
fn status_reply(
    engine: &Arc<Engine>,
    request_id: String,
    internal_op_id: &OpId,
    wire_op_id: &str,
) -> ControlResponse {
    let answer = engine.query(internal_op_id);
    let handles = engine.handles(internal_op_id);
    ControlResponse {
        request_id,
        error: None,
        result: Some(RespResult::OpStatus(op_status(
            wire_op_id,
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

// The tests drive REAL /bin/sh children through the containment primitive —
// they validate POSIX child semantics (exit codes, pipes, process groups)
// and are unix-only by nature. The code under test itself
// compiles and runs on Windows (Job Objects); its Windows behavior is
// covered by the platform crate's cross-platform surface.
#[cfg(all(test, unix))]
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

        async fn start_exec_scoped(
            &self,
            scope: &str,
            op_id: &str,
            script: &str,
        ) -> ControlResponse {
            serve_op_start_scoped(
                &self.engine,
                &self.platform,
                scope,
                self.sink(),
                op_id.to_string(),
                v1::OpStart {
                    op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                        command: vec![script.to_string()],
                        shell: true,
                        ..Default::default()
                    })),
                    window_bytes: 1 << 20,
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

    #[tokio::test]
    async fn same_wire_op_id_runs_independently_for_two_connections() {
        let rig = rig();
        let first = rig
            .start_exec_scoped("deployment-a", "same-op", "sleep 30")
            .await;
        let second = rig
            .start_exec_scoped("deployment-b", "same-op", "sleep 30")
            .await;
        assert!(started_status(&first).0);
        assert!(started_status(&second).0);
        assert_eq!(rig.engine.live_ops(), 2);

        for scope in ["deployment-a", "deployment-b"] {
            let response = serve_op_cancel_scoped(
                &rig.engine,
                scope,
                format!("cancel-{scope}"),
                &v1::OpCancel {
                    op_id: "same-op".to_string(),
                },
            );
            assert!(response.error.is_none());
            match response.result {
                Some(RespResult::OpStatus(status)) => {
                    assert_eq!(status.op_id, "same-op", "scope must remain local-only");
                }
                other => panic!("expected OpStatus, got {other:?}"),
            }
        }
        for scope in ["deployment-a", "deployment-b"] {
            let internal = scoped_op_id(scope, "same-op");
            let mut cancelled = false;
            for _ in 0..500 {
                if rig.engine.handles(&internal).is_some_and(|handles| {
                    handles
                        .exit
                        .get()
                        .is_some_and(|exit| exit.outcome == JobOutcome::Cancelled)
                }) {
                    cancelled = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(cancelled, "scoped child {scope} stopped independently");
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
        assert_eq!(exit.failure_code, "");
        assert_eq!(rig.stdout_bytes(), b"wire");
        assert_eq!(
            exit.digests.get("stdout").map(String::as_str),
            Some(blake3::hash(b"wire").to_hex().as_str()),
            "wire digest proves byte-exact assembly"
        );
        assert_eq!(exit.totals.get("stdout"), Some(&4));
        // No completion sink was supplied: even a completely lost immediate
        // notification remains recoverable from this connection's retained truth.
        let retry = rig.engine.retained_completions("default");
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].0, "op-1");
        assert_eq!(wire_exit(&retry[0].1).exit_code, 3);
        assert_eq!(
            rig.engine.retained_completions("another-connection"),
            vec![]
        );

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
    async fn terminal_record_carries_native_child_cleanup_evidence() {
        let rig = rig();
        let response = rig
            .start_exec("cleanup", "sleep 60 >/dev/null 2>&1 & printf done", 1 << 20)
            .await;
        assert!(started_status(&response).0);
        let exit = rig.wait_for_exit_frame().await;
        assert_eq!(exit.exit_code, 0);
        assert!(exit.background_children_stopped);
        assert_eq!(rig.stdout_bytes(), b"done");
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

    /// The server tells a cancel-before-start tombstone from a real exit by its
    /// shape alone, as the wire has no marker for it: COMPLETE, cancelled,
    /// `next_seq` 0 and no output totals or digests. Pin that shape from both
    /// sides: the tombstone has it on start, query and attach, and an op
    /// cancelled after it began never has it.
    #[tokio::test]
    async fn a_tombstone_and_a_cancelled_exit_are_told_apart_by_shape() {
        fn tombstone_shaped(status: &v1::OpStatus) -> bool {
            let Some(exit) = status.exit.as_ref() else {
                return false;
            };
            status.state == v1::OpState::Complete as i32
                && exit.cancelled
                && status.next_seq == 0
                && exit.totals.is_empty()
                && exit.digests.is_empty()
        }
        fn status_of(resp: &ControlResponse) -> v1::OpStatus {
            match &resp.result {
                Some(RespResult::OpStatus(status)) => status.clone(),
                other => panic!("expected OpStatus, got {other:?} / {:?}", resp.error),
            }
        }
        let rig = rig();
        let query = |op_id: &str| {
            status_of(&serve_op_query(
                &rig.engine,
                "q".to_string(),
                &v1::OpQuery {
                    op_id: op_id.to_string(),
                },
            ))
        };

        let cancel = serve_op_cancel(
            &rig.engine,
            "c-tomb".to_string(),
            &v1::OpCancel {
                op_id: "op-tomb".to_string(),
            },
        );
        assert!(cancel.error.is_none());
        let (accepted, refused) =
            started_status(&rig.start_exec("op-tomb", "echo never", 1 << 20).await);
        assert!(!accepted, "a tombstoned op is refused");
        let attached = status_of(&serve_op_attach(
            &rig.engine,
            "a-tomb".to_string(),
            &v1::OpAttach {
                op_id: "op-tomb".to_string(),
                from_seq: 0,
                attach_generation: 1,
                window_bytes: 0,
            },
        ));
        for status in [&refused, &query("op-tomb"), &attached] {
            assert!(tombstone_shaped(status), "tombstone: {status:?}");
            assert_eq!(status.exit.as_ref().map(|exit| exit.exit_code), Some(-1));
        }

        let started = rig.start_exec("op-began", "sleep 30", 1 << 20).await;
        assert!(started_status(&started).0);
        let cancel = serve_op_cancel(
            &rig.engine,
            "c-began".to_string(),
            &v1::OpCancel {
                op_id: "op-began".to_string(),
            },
        );
        assert!(cancel.error.is_none());
        let exit = rig.wait_for_exit_frame().await;
        assert!(exit.cancelled);
        assert!(!exit.totals.is_empty() && !exit.digests.is_empty());
        let mut complete = None;
        for _ in 0..500 {
            let status = query("op-began");
            if status.state == v1::OpState::Complete as i32 {
                complete = Some(status);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let complete = complete.expect("the cancelled op completes");
        assert!(complete.exit.as_ref().is_some_and(|exit| exit.cancelled));
        assert!(!tombstone_shaped(&complete), "a real exit: {complete:?}");
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
        let op = scoped_op_id("default", "op-replay");
        for _ in 0..500 {
            if !rig
                .engine
                .route_command(&op, JobCommand::Detach { completed: None })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !rig.engine
                .route_command(&op, JobCommand::Detach { completed: None }),
            "pump ended after the final ack"
        );
        assert_eq!(rig.engine.retained_completions("default"), vec![]);
        assert!(matches!(
            rig.engine.query(&op),
            QueryAnswer::Complete {
                final_acked: true,
                ..
            }
        ));
    }

    /// One exchange releases a stored result: the reply confirms it, the op
    /// is dropped at once (no housekeeping pass needed), and every later
    /// release, attach, query or start answers released without re-running.
    #[tokio::test]
    #[allow(clippy::too_many_lines)] // One release story, read top to bottom.
    async fn release_confirms_in_its_answer_and_a_duplicate_attach_answers_released() {
        fn status_of(resp: &ControlResponse) -> v1::OpStatus {
            match &resp.result {
                Some(RespResult::OpStatus(status)) => status.clone(),
                other => panic!("expected OpStatus, got {other:?} / {:?}", resp.error),
            }
        }
        fn released(status: &v1::OpStatus) -> bool {
            status.state == v1::OpState::Lost as i32
                && status.lost_reason == v1::OpLostReason::Released as i32
        }
        let rig = rig();
        let release = |op_id: &str, exit_seq: u64| {
            status_of(&serve_op_release(
                &rig.engine,
                "r".to_string(),
                &v1::OpRelease {
                    op_id: op_id.to_string(),
                    exit_seq,
                },
            ))
        };

        // A running op is never released.
        assert!(started_status(&rig.start_exec("op-live", "sleep 30", 1 << 20).await).0);
        let live = release("op-live", 1);
        assert_eq!(live.state, v1::OpState::Running as i32, "running: {live:?}");

        assert!(started_status(&rig.start_exec("op-rel", "printf payload", 1 << 20).await).0);
        rig.wait_for_exit_frame().await;
        let op = scoped_op_id("default", "op-rel");
        let mut exit_seq = None;
        for _ in 0..500 {
            if let QueryAnswer::Complete { exit_seq: seq, .. } = rig.engine.query(&op) {
                exit_seq = Some(seq);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let exit_seq = exit_seq.expect("the op completes");
        assert_eq!(rig.engine.retained_completions("default").len(), 1);

        // Another terminal frame releases nothing.
        let mismatch = release("op-rel", exit_seq + 1);
        assert_eq!(mismatch.state, v1::OpState::Complete as i32, "{mismatch:?}");
        assert!(matches!(
            rig.engine.query(&op),
            QueryAnswer::Complete { .. }
        ));

        // The release itself: confirmed in the answer, dropped at once.
        let confirmed = release("op-rel", exit_seq);
        assert!(released(&confirmed), "confirmed: {confirmed:?}");
        assert_eq!(
            rig.engine.query(&op),
            QueryAnswer::Lost(LostReason::Released)
        );
        assert!(
            !rig.engine
                .route_command(&op, JobCommand::Detach { completed: None }),
            "the lingering pump is gone"
        );
        assert!(rig.engine.handles(&op).is_none(), "retained state dropped");
        assert_eq!(
            rig.engine.retained_completions("default"),
            vec![],
            "no completion notice is retried for a released op"
        );

        // Duplicates: release, attach, query and start all answer released.
        assert!(released(&release("op-rel", exit_seq)));
        let frames_before = rig.frames.lock().expect("frames").len();
        let attached = status_of(&serve_op_attach(
            &rig.engine,
            "a".to_string(),
            &v1::OpAttach {
                op_id: "op-rel".to_string(),
                from_seq: 0,
                attach_generation: 9,
                window_bytes: 0,
            },
        ));
        assert!(released(&attached), "attach: {attached:?}");
        assert!(released(&status_of(&serve_op_query(
            &rig.engine,
            "q".to_string(),
            &v1::OpQuery {
                op_id: "op-rel".to_string(),
            },
        ))));
        // A duplicate start attaches to the known op (accepted, as for any
        // duplicate) and reports it released; it never runs again.
        let (_, restarted) =
            started_status(&rig.start_exec("op-rel", "printf again", 1 << 20).await);
        assert!(
            released(&restarted),
            "a released op never re-runs: {restarted:?}"
        );
        assert_eq!(
            rig.engine.query(&op),
            QueryAnswer::Lost(LostReason::Released)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            rig.frames.lock().expect("frames").len(),
            frames_before,
            "nothing is replayed or re-run"
        );

        // An op this runner never had is not released, just not retained.
        let unknown = release("op-never", 1);
        assert_eq!(unknown.state, v1::OpState::Lost as i32);
        assert_eq!(unknown.lost_reason, v1::OpLostReason::AgentRestarted as i32);

        let _ = serve_op_cancel(
            &rig.engine,
            "c".to_string(),
            &v1::OpCancel {
                op_id: "op-live".to_string(),
            },
        );
    }

    /// A released op's id survives an in-place update: the successor image
    /// answers a late start for it as released and never runs it again.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_released_op_never_runs_again_after_an_update_handover() {
        use crate::handover::{CarriedMarker, CarriedReason};
        let rig = rig();
        assert!(started_status(&rig.start_exec("op-once", "printf once", 1 << 20).await).0);
        rig.wait_for_exit_frame().await;
        let op = scoped_op_id("default", "op-once");
        let mut exit_seq = None;
        for _ in 0..500 {
            if let QueryAnswer::Complete { exit_seq: seq, .. } = rig.engine.query(&op) {
                exit_seq = Some(seq);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let released = serve_op_release(
            &rig.engine,
            "r".to_string(),
            &v1::OpRelease {
                op_id: "op-once".to_string(),
                exit_seq: exit_seq.expect("the op completes"),
            },
        );
        assert!(matches!(
            released.result,
            Some(RespResult::OpStatus(ref s)) if s.lost_reason == v1::OpLostReason::Released as i32
        ));

        // What the predecessor writes into its manifest, through JSON.
        let carried: Vec<CarriedMarker> = rig
            .engine
            .carried_markers()
            .into_iter()
            .map(CarriedMarker::from)
            .collect();
        assert!(carried
            .iter()
            .any(|m| m.op_id == op.as_str() && m.reason == CarriedReason::Released));
        let carried: Vec<CarriedMarker> =
            serde_json::from_slice(&serde_json::to_vec(&carried).unwrap()).unwrap();

        let successor = self::rig();
        successor
            .engine
            .restore_markers(carried.into_iter().map(CarriedMarker::into_parts));
        let (_, again) = started_status(
            &successor
                .start_exec("op-once", "printf again", 1 << 20)
                .await,
        );
        assert_eq!(again.state, v1::OpState::Lost as i32, "{again:?}");
        assert_eq!(again.lost_reason, v1::OpLostReason::Released as i32);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            successor.frames.lock().expect("frames").is_empty(),
            "the successor never runs it"
        );

        // Negative control: a successor that was not handed the markers runs it.
        let forgetful = self::rig();
        let (accepted, fresh) = started_status(
            &forgetful
                .start_exec("op-once", "printf again", 1 << 20)
                .await,
        );
        assert!(accepted);
        assert_ne!(fresh.state, v1::OpState::Lost as i32, "{fresh:?}");
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

    #[tokio::test]
    async fn illegal_op_ids_are_refused_typed_before_anything_starts() {
        // A NATS-illegal op id would poison the frame subject (every publish
        // fails; the op presents as hung) — refused loud + typed instead,
        // before admission or spawn.
        let rig = rig();
        for bad in [
            "",
            "has space",
            "dotted.id",
            "wild*card",
            "tail>",
            "tab\tid",
            "fsw-reserved",
        ] {
            let resp = rig.start_exec(bad, "echo never", 1 << 20).await;
            let err = resp
                .error
                .unwrap_or_else(|| panic!("op_id {bad:?} must be refused"));
            assert_eq!(err.code, v1::ErrorCode::Protocol as i32, "{bad:?}");
            assert!(
                matches!(
                    rig.engine.query(&OpId::new(bad)),
                    opengeni_agent_engine::registry::QueryAnswer::Unknown
                        | opengeni_agent_engine::registry::QueryAnswer::Lost(_)
                ),
                "nothing may begin for {bad:?}"
            );
        }
        assert!(rig.frames.lock().expect("frames").is_empty(), "zero spawns");
    }

    #[test]
    fn wire_exit_carries_typed_failures_without_sentinels() {
        let exit = JobExit {
            outcome: JobOutcome::Failed(JobFailure::Overflow {
                retained_bytes: 12345,
            }),
            duration_ms: 7,
            background_children_stopped: false,
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

    #[tokio::test]
    async fn detached_operation_pushes_completion_without_output_attachment() {
        let rig = rig();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let completion_sink: FrameSink = Arc::new(move |bytes| {
            tx.send(v1::AgentEvent::decode(bytes.as_slice()).expect("completion event"))
                .expect("completion receiver");
        });
        let response = serve_op_start_scoped_with_policy(
            &rig.engine,
            &rig.platform,
            "default",
            rig.sink(),
            "detached-exit".into(),
            v1::OpStart {
                op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                    command: vec!["sleep 30".into()],
                    shell: true,
                    ..Default::default()
                })),
                ..Default::default()
            },
            None,
            None,
            Some(completion_sink),
        )
        .await;
        assert!(started_status(&response).0);
        let id = scoped_op_id("default", "detached-exit");
        assert!(rig
            .engine
            .route_command(&id, JobCommand::Detach { completed: None }));
        serve_op_cancel_scoped(
            &rig.engine,
            "default",
            "cancel".into(),
            &v1::OpCancel {
                op_id: "detached-exit".into(),
            },
        );
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("completion is pushed promptly")
            .expect("event");
        let Some(v1::agent_event::Event::OperationCompleted(completed)) = event.event else {
            panic!("not a completion event");
        };
        assert_eq!(completed.op_id, "detached-exit");
        assert!(completed.exit.expect("terminal proof").cancelled);
        assert!(rx.try_recv().is_err(), "one terminal event only");
        // Lifecycle publication does not release retained output.
        assert!(rig.engine.handles(&id).is_some());
    }

    #[test]
    fn completion_publication_does_not_require_a_retained_exit_frame() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: FrameSink = Arc::new(move |bytes| captured.lock().unwrap().push(bytes));
        completion_publisher(Some(sink), "overflow".into())(
            None,
            &JobExit {
                outcome: JobOutcome::Failed(JobFailure::Overflow {
                    retained_bytes: 12345,
                }),
                duration_ms: 7,
                background_children_stopped: false,
                stdout: empty_channel(),
                stderr: empty_channel(),
            },
        );
        let events = events.lock().unwrap();
        let event = v1::AgentEvent::decode(events[0].as_slice()).unwrap();
        let Some(v1::agent_event::Event::OperationCompleted(completed)) = event.event else {
            panic!("not a completion event");
        };
        assert_eq!(completed.exit.unwrap().failure_code, "OP_OVERFLOW");
    }

    /// A returning process reports what it holds; Opengeni's answer names
    /// what it no longer recognises, and only that is stopped: a running op
    /// is cancelled and released when it exits, a retained one is released at
    /// once, neither ever runs again, and the next report holds only what is
    /// left, with the generation each op started on.
    #[tokio::test]
    #[allow(clippy::too_many_lines)] // One takeover story, read top to bottom.
    async fn an_inventory_answer_stops_what_opengeni_no_longer_recognises() {
        fn answer(report_id: u64, generation: u64, stop: &[&str]) -> Vec<u8> {
            v1::AgentEventAck {
                ack: Some(v1::agent_event_ack::Ack::OperationInventory(
                    v1::OperationInventoryAck {
                        report_id,
                        page: 0,
                        connection_generation: generation,
                        stop_op_ids: stop.iter().map(ToString::to_string).collect(),
                    },
                )),
            }
            .encode_to_vec()
        }
        fn reported(pages: &[v1::OperationInventory]) -> Vec<(String, u64)> {
            let mut ops: Vec<(String, u64)> = pages
                .iter()
                .flat_map(|page| page.operations.iter())
                .map(|op| (op.op_id.clone(), op.connection_generation))
                .collect();
            ops.sort();
            ops
        }
        async fn settle(engine: &Engine, op: &OpId, want: impl Fn(&QueryAnswer) -> bool) {
            for _ in 0..500 {
                if want(&engine.query(op)) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("{op:?} never settled: {:?}", engine.query(op));
        }
        let released = |answer: &QueryAnswer| *answer == QueryAnswer::Lost(LostReason::Released);
        let rig = rig();
        let engine = &rig.engine;

        // Connection 1 (generation 1): one op keeps running, one completes
        // and retains its output.
        let first = engine.begin_link_connection("default");
        assert!(started_status(&rig.start_exec("op-run", "sleep 30", 1 << 20).await).0);
        assert!(started_status(&rig.start_exec("op-done", "printf out", 1 << 20).await).0);
        let run = scoped_op_id("default", "op-run");
        let done = scoped_op_id("default", "op-done");
        settle(engine, &done, |a| matches!(a, QueryAnswer::Complete { .. })).await;
        let pages = engine.inventory_pages("default");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].report_id, first);
        assert_eq!(
            reported(&pages),
            vec![("op-done".to_string(), 0), ("op-run".to_string(), 0)],
            "generations are unknown until the first answer"
        );
        assert!(handle_event_ack_scoped(
            engine,
            "default",
            &answer(first, 1, &[])
        ));
        assert!(
            engine.inventory_pages("default").is_empty(),
            "an answered report is not repeated"
        );

        // Another process held the connection meanwhile; this one is back on
        // generation 3 and starts a new op there.
        let third = engine.begin_link_connection("default");
        assert!(started_status(&rig.start_exec("op-new", "sleep 30", 1 << 20).await).0);
        let new = scoped_op_id("default", "op-new");
        let pages = engine.inventory_pages("default");
        assert_eq!(pages[0].report_id, third);
        assert_eq!(
            reported(&pages),
            vec![
                ("op-done".to_string(), 1),
                ("op-new".to_string(), 0),
                ("op-run".to_string(), 1)
            ]
        );

        // An answer to the previous connection's report stops nothing.
        assert!(handle_event_ack_scoped(
            engine,
            "default",
            &answer(first, 3, &["op-run", "op-done", "op-new"])
        ));
        assert!(matches!(engine.query(&run), QueryAnswer::Running { .. }));
        assert!(matches!(engine.query(&done), QueryAnswer::Complete { .. }));
        assert!(matches!(engine.query(&new), QueryAnswer::Running { .. }));

        // The answer: the two generation-1 ops are no longer recognised; an
        // id this report never held is ignored.
        assert_eq!(
            engine.apply_inventory_answer(
                "default",
                &v1::OperationInventoryAck {
                    report_id: third,
                    page: 0,
                    connection_generation: 3,
                    stop_op_ids: vec!["op-run".into(), "op-done".into(), "op-other".into()],
                },
            ),
            Some(2)
        );
        assert!(
            released(&engine.query(&done)),
            "retained output dropped at once"
        );
        assert!(engine.handles(&done).is_none());
        settle(engine, &run, released).await;
        assert!(
            engine.handles(&run).is_none(),
            "the cancelled op left nothing"
        );
        assert!(
            rig.frames
                .lock()
                .expect("frames")
                .iter()
                .any(|frame| matches!(
                    &frame.body,
                    Some(v1::op_frame::Body::Exit(exit)) if exit.cancelled
                )),
            "the running op was cancelled"
        );
        assert_eq!(
            engine.retained_completions("default"),
            vec![],
            "nothing stopped is reported as a completion again"
        );
        assert!(matches!(engine.query(&new), QueryAnswer::Running { .. }));

        // A stopped op never runs again: a duplicate start answers released.
        let (_, restarted) = started_status(&rig.start_exec("op-run", "sleep 30", 1 << 20).await);
        assert_eq!(restarted.state, v1::OpState::Lost as i32);
        assert_eq!(restarted.lost_reason, v1::OpLostReason::Released as i32);
        assert!(released(&engine.query(&run)));

        // The next connection reports only what is left, with generation 3.
        let fourth = engine.begin_link_connection("default");
        let pages = engine.inventory_pages("default");
        assert_eq!(pages[0].report_id, fourth);
        assert_eq!(reported(&pages), vec![("op-new".to_string(), 3)]);

        let _ = serve_op_cancel(
            engine,
            "c".to_string(),
            &v1::OpCancel {
                op_id: "op-new".to_string(),
            },
        );
    }

    /// An op carried to a successor process image keeps the connection
    /// generation it started on, so the successor's report still lets
    /// Opengeni tell it from an op of the current connection.
    #[tokio::test]
    async fn a_handed_over_op_keeps_the_generation_it_started_on() {
        let rig = rig();
        let report = rig.engine.begin_link_connection("link");
        let started = serve_op_start_scoped_with_policy(
            &rig.engine,
            &rig.platform,
            "link",
            rig.sink(),
            "carried".to_string(),
            v1::OpStart {
                op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                    command: vec!["sleep 30".to_string()],
                    shell: true,
                    ..Default::default()
                })),
                window_bytes: 1 << 20,
                deadline_ms: 0,
                origin_id: "session-1".to_string(),
            },
            None,
            Some("agent.w.a.connection.i.op.carried".to_string()),
            None,
        )
        .await;
        assert!(started_status(&started).0);
        assert_eq!(rig.engine.inventory_pages("link").len(), 1);
        assert_eq!(
            rig.engine.apply_inventory_answer(
                "link",
                &v1::OperationInventoryAck {
                    report_id: report,
                    page: 0,
                    connection_generation: 4,
                    stop_op_ids: Vec::new(),
                },
            ),
            Some(0)
        );

        let handed = rig.engine.handover_all().await.expect("handed over");
        assert_eq!(handed.len(), 1);
        assert_eq!(handed[0].tag.connection_generation, 4);

        // The successor (its process could not be adopted here, so the op
        // ends typed and retains its record) reports it with generation 4.
        let successor = self::rig();
        successor.engine.begin_link_connection("link");
        for op in handed {
            successor.engine.adopt_job(
                op,
                Err("not adopted in this test".to_string()),
                |_| {},
                |_| Vec::new(),
                |_, _| {},
            );
        }
        let pages = successor.engine.inventory_pages("link");
        let reported: Vec<(String, u64)> = pages
            .iter()
            .flat_map(|page| page.operations.iter())
            .map(|op| (op.op_id.clone(), op.connection_generation))
            .collect();
        assert_eq!(reported, vec![("carried".to_string(), 4)]);
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
