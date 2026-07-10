//! Legacy-op adapters: the monolithic request/reply ops served OVER the op
//! engine (ENGINE-INTEGRATION.md §Supervisor rework).
//!
//! The wire shape is unchanged forever (compatibility contract): one
//! `ControlRequest{exec}` in, one assembled `ControlResponse` out. Underneath,
//! the command now runs as an engine job — same registry (duplicate request
//! ids attach to the stashed reply instead of re-running), same containment,
//! same retention/credit plumbing — with a BUFFERING consumer in place of a
//! remote one: the emit hook assembles the reply and self-acks cumulatively so
//! retention stays trimmed behind the stream.
//!
//! Reply-size posture (LIMITS-DOCTRINE): outputs up to the derived
//! reply-assembly breaker are buffered in full and the existing negotiated-
//! max-payload seam in the supervisor converts an oversized reply into the
//! same typed `PAYLOAD_TOO_LARGE` as today. Beyond the breaker the op KEEPS
//! RUNNING to completion (side effects are the caller's; killing mid-run would
//! change legacy semantics) — bytes are counted, not stored, and the reply is
//! the typed oversize error naming the breaker.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use opengeni_agent_engine::admission::JobClass;
use opengeni_agent_engine::registry::QueryAnswer;
use opengeni_agent_engine::{Channel, FrameBody, OpId};
use opengeni_agent_platform::{assemble_git_response, Platform};
use opengeni_agent_proto::v1::{
    self, control_response::Result as RespResult, AgentError, ControlResponse, ErrorCode,
};
use prost::Message as _;
use tracing::warn;

use crate::engine::{Engine, StartOutcome, LEGACY_ORIGIN};
use crate::job::{JobCommand, JobExit, JobFailure, JobOutcome};

/// The adapter's local consumer attach generation. Nothing else ever attaches
/// to a legacy job (its op id never reaches the op-stream surface), so a
/// constant generation is correct.
const LOCAL_GENERATION: u64 = 1;

/// Serves a legacy `exec` request over the op engine and returns the assembled
/// wire reply. Admission, idempotent begin, containment, deadline enforcement
/// (`timeout_ms` — caller-owned, rule C), and typed failures all ride the
/// engine; the reply is byte-compatible with the pre-engine implementation.
pub async fn serve_exec<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    request_id: String,
    req: v1::ExecRequest,
) -> ControlResponse {
    let op_id = OpId::new(request_id.clone());
    let ticket = match engine.admit(&op_id, JobClass::Heavy, LEGACY_ORIGIN).await {
        Ok(ticket) => ticket,
        Err(reason) => return crate::dispatch::breaker_reply_error(request_id, "exec", reason),
    };

    let breaker = engine.budgets().legacy_buffer_max_bytes;
    let buffers = Arc::new(Mutex::new(ReplyBuffers::default()));
    // The emit hook needs the job's own mailbox for self-acks, but the mailbox
    // only exists once the job starts — a cell closes the loop. No frame can
    // be emitted before the Attach we send after filling it.
    let mailbox_cell: Arc<OnceLock<tokio::sync::mpsc::Sender<JobCommand>>> =
        Arc::new(OnceLock::new());
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    let emit = buffering_emit(buffers.clone(), mailbox_cell.clone(), breaker);

    // The caller's deadline (rule C) starts at execution, not while queued.
    let deadline = (req.timeout_ms > 0)
        .then(|| tokio::time::Instant::now() + Duration::from_millis(u64::from(req.timeout_ms)));
    let stdin = req.stdin.to_vec();

    let outcome = engine.start_job(
        &op_id,
        ticket,
        stdin,
        deadline,
        || platform.spawn_exec(&req),
        emit,
        // The legacy consumer never replays the Exit frame; its record flows
        // through the on_exit oneshot. An empty retained payload is enough.
        |_exit| Vec::new(),
        move |_exit_seq, exit: &JobExit| {
            let _ = exit_tx.send(exit.clone());
        },
    );

    match outcome {
        StartOutcome::Started(started) => {
            let _ = mailbox_cell.set(started.mailbox.clone());
            let _ = started
                .mailbox
                .send(JobCommand::Attach {
                    generation: LOCAL_GENERATION,
                    from_seq: 0,
                    window_bytes: breaker,
                })
                .await;

            let Ok(record) = exit_rx.await else {
                // The pump task died without a terminal record — a runner bug,
                // reported typed rather than a caller timeout.
                return error_reply(
                    request_id,
                    ErrorCode::Os,
                    "the exec job ended without producing a terminal record",
                    false,
                );
            };

            // Release the job for fast GC: local consumption IS the final ack.
            let acked = started.handles.watermark.load(Ordering::Relaxed);
            let _ = started
                .mailbox
                .send(JobCommand::Ack {
                    generation: LOCAL_GENERATION,
                    acked_seq: acked,
                    credit_bytes: breaker,
                    final_ack: true,
                })
                .await;

            let taken = std::mem::take(&mut *buffers.lock().expect("reply buffer lock"));
            let response = build_reply(request_id, &record, taken, breaker);
            // Stash the encoded reply so a duplicate delivery of the same
            // request id answers from here instead of re-running (bounded by
            // registry GC — ruling M6).
            let _ = started.handles.legacy_reply.set(response.encode_to_vec());
            response
        }
        StartOutcome::SpawnFailed { error, handles } => {
            let response = ControlResponse {
                request_id,
                error: Some(error.to_agent_error()),
                result: None,
            };
            let _ = handles.legacy_reply.set(response.encode_to_vec());
            response
        }
        StartOutcome::Known { answer, handles } => {
            duplicate_reply(request_id, answer, handles.as_ref())
        }
        StartOutcome::BornCancelled => error_reply(
            request_id,
            ErrorCode::Os,
            "the op was cancelled before it began (cancel tombstone)",
            false,
        ),
    }
}

/// Serves a legacy `git` request over the op engine — same wire shape as the
/// pre-engine implementation (porcelain status parse included via the shared
/// [`assemble_git_response`]), but the git children now run CONTAINED with a
/// per-op OOM cgroup leaf (a clone's page cache bills to the op, closing the
/// #351 git-boundary hole). Heavy admission; idempotent by request id.
pub async fn serve_git<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    request_id: String,
    req: v1::GitRequest,
) -> ControlResponse {
    let op_id = OpId::new(request_id.clone());
    let ticket = match engine.admit(&op_id, JobClass::Heavy, LEGACY_ORIGIN).await {
        Ok(ticket) => ticket,
        Err(reason) => return crate::dispatch::breaker_reply_error(request_id, "git", reason),
    };

    let breaker = engine.budgets().legacy_buffer_max_bytes;
    let buffers = Arc::new(Mutex::new(ReplyBuffers::default()));
    let mailbox_cell: Arc<OnceLock<tokio::sync::mpsc::Sender<JobCommand>>> =
        Arc::new(OnceLock::new());
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    let emit = buffering_emit(buffers.clone(), mailbox_cell.clone(), breaker);

    let outcome = engine.start_job(
        &op_id,
        ticket,
        Vec::new(),
        // Rule C: git carries no caller deadline field; none is imposed.
        None,
        || platform.spawn_git(&req),
        emit,
        |_exit| Vec::new(),
        move |_exit_seq, exit: &JobExit| {
            let _ = exit_tx.send(exit.clone());
        },
    );

    match outcome {
        StartOutcome::Started(started) => {
            let _ = mailbox_cell.set(started.mailbox.clone());
            let _ = started
                .mailbox
                .send(JobCommand::Attach {
                    generation: LOCAL_GENERATION,
                    from_seq: 0,
                    window_bytes: breaker,
                })
                .await;

            let Ok(record) = exit_rx.await else {
                return error_reply(
                    request_id,
                    ErrorCode::Os,
                    "the git job ended without producing a terminal record",
                    false,
                );
            };

            let acked = started.handles.watermark.load(Ordering::Relaxed);
            let _ = started
                .mailbox
                .send(JobCommand::Ack {
                    generation: LOCAL_GENERATION,
                    acked_seq: acked,
                    credit_bytes: breaker,
                    final_ack: true,
                })
                .await;

            let taken = std::mem::take(&mut *buffers.lock().expect("reply buffer lock"));
            let response = build_git_reply(request_id, &record, taken, breaker, req.op());
            let _ = started.handles.legacy_reply.set(response.encode_to_vec());
            response
        }
        StartOutcome::SpawnFailed { error, handles } => {
            let response = ControlResponse {
                request_id,
                error: Some(error.to_agent_error()),
                result: None,
            };
            let _ = handles.legacy_reply.set(response.encode_to_vec());
            response
        }
        StartOutcome::Known { answer, handles } => {
            duplicate_reply(request_id, answer, handles.as_ref())
        }
        StartOutcome::BornCancelled => error_reply(
            request_id,
            ErrorCode::Os,
            "the op was cancelled before it began (cancel tombstone)",
            false,
        ),
    }
}

/// Assembles the git wire reply from the terminal record + captured output
/// via the shared porcelain-aware builder.
fn build_git_reply(
    request_id: String,
    record: &JobExit,
    buffers: ReplyBuffers,
    breaker: u64,
    op: v1::GitOp,
) -> ControlResponse {
    match &record.outcome {
        JobOutcome::Exited { exit_code } => {
            if buffers.overflowed {
                return overflow_reply(request_id, buffers.total_bytes, breaker);
            }
            ControlResponse {
                request_id,
                error: None,
                result: Some(RespResult::Git(assemble_git_response(
                    op,
                    *exit_code,
                    buffers.stdout,
                    buffers.stderr,
                ))),
            }
        }
        // No deadline is ever set on git jobs; total for the enum.
        JobOutcome::TimedOut | JobOutcome::Cancelled => error_reply(
            request_id,
            ErrorCode::Os,
            "the git command was cancelled before completion",
            false,
        ),
        JobOutcome::Failed(failure) => failed_reply(request_id, record, failure),
    }
}

/// The legacy adapter's frame consumer: buffers Data payloads for the reply
/// (counting past the breaker without storing) and self-acks cumulatively so
/// retention stays trimmed behind the stream. A full mailbox skips one ack;
/// cumulative repetition heals it.
fn buffering_emit(
    buffers: Arc<Mutex<ReplyBuffers>>,
    mailbox_cell: Arc<OnceLock<tokio::sync::mpsc::Sender<JobCommand>>>,
    breaker: u64,
) -> impl Fn(opengeni_agent_engine::Frame) + Send + 'static {
    move |frame| {
        if let FrameBody::Data { channel, bytes } = &frame.body {
            buffers
                .lock()
                .expect("reply buffer lock")
                .absorb(*channel, bytes, breaker);
        }
        if let Some(mailbox) = mailbox_cell.get() {
            let _ = mailbox.try_send(JobCommand::Ack {
                generation: LOCAL_GENERATION,
                acked_seq: frame.seq,
                credit_bytes: breaker,
                final_ack: false,
            });
        }
    }
}

/// Answers a duplicate delivery of a known request id: the stashed reply when
/// the first run settled, else a typed retryable in-flight signal. NEVER
/// re-runs (ruling B1).
fn duplicate_reply(
    request_id: String,
    answer: QueryAnswer,
    handles: Option<&crate::engine::OpHandles>,
) -> ControlResponse {
    if let Some(bytes) = handles.and_then(|h| h.legacy_reply.get()) {
        match ControlResponse::decode(bytes.as_slice()) {
            // The stash was encoded under the SAME request id (that is what
            // made this a duplicate), so it replays verbatim.
            Ok(stashed) => return stashed,
            Err(error) => {
                warn!(%error, "stashed duplicate reply undecodable; answering retryable");
            }
        }
    }
    warn!(
        request_id = %request_id,
        ?answer,
        "duplicate legacy request for an unsettled op; answering retryable"
    );
    let mut detail = std::collections::HashMap::new();
    detail.insert(
        "backpressure".to_string(),
        "duplicate_in_flight".to_string(),
    );
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::Draining as i32,
            message: "a request with this id is still executing; retry for its result".to_string(),
            retryable: true,
            detail,
        }),
        result: None,
    }
}

/// Assembles the wire reply from the terminal record + captured output —
/// byte-compatible with the pre-engine exec (timeouts discard output and
/// report `stderr = "timed out"`, exactly as before).
fn build_reply(
    request_id: String,
    exit: &JobExit,
    buffers: ReplyBuffers,
    breaker: u64,
) -> ControlResponse {
    match &exit.outcome {
        JobOutcome::Exited { exit_code } => {
            if buffers.overflowed {
                return overflow_reply(request_id, buffers.total_bytes, breaker);
            }
            ControlResponse {
                request_id,
                error: None,
                result: Some(RespResult::Exec(v1::ExecResponse {
                    exit_code: *exit_code,
                    stdout: prost::bytes::Bytes::from(buffers.stdout),
                    stderr: prost::bytes::Bytes::from(buffers.stderr),
                    timed_out: false,
                    duration_ms: exit.duration_ms,
                })),
            }
        }
        JobOutcome::TimedOut => ControlResponse {
            request_id,
            error: None,
            result: Some(RespResult::Exec(v1::ExecResponse {
                exit_code: -1,
                stdout: prost::bytes::Bytes::new(),
                stderr: prost::bytes::Bytes::from_static(b"timed out"),
                timed_out: true,
                duration_ms: exit.duration_ms,
            })),
        },
        JobOutcome::Cancelled => error_reply(
            request_id,
            ErrorCode::Os,
            "the command was cancelled before completion",
            false,
        ),
        JobOutcome::Failed(failure) => failed_reply(request_id, exit, failure),
    }
}

/// The typed oversize error for output past the reply-assembly breaker. The
/// four in-band fields (FAILURE-VISIBILITY.md): what happened, what was
/// preserved, whose fault, what to try.
fn overflow_reply(request_id: String, total_bytes: u64, breaker: u64) -> ControlResponse {
    let mut detail = std::collections::HashMap::new();
    detail.insert("total_output_bytes".to_string(), total_bytes.to_string());
    detail.insert("reply_breaker_bytes".to_string(), breaker.to_string());
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::PayloadTooLarge as i32,
            message: format!(
                "the command completed but produced {total_bytes} bytes of output — past the \
                 runner's reply-assembly breaker of {breaker} bytes, so the output was not \
                 kept. The command itself ran to completion (its side effects stand). Re-run \
                 with output redirected to a file, or use the streaming op path for output \
                 of this size."
            ),
            retryable: false,
            detail,
        }),
        result: None,
    }
}

/// The typed reply for a runner-side mid-stream failure (retention overflow,
/// spool IO, pipe IO). Names the layer and what was preserved (in-band plane,
/// FAILURE-VISIBILITY.md).
fn failed_reply(request_id: String, exit: &JobExit, failure: &JobFailure) -> ControlResponse {
    let (kind, what) = match failure {
        JobFailure::Overflow { retained_bytes } => (
            "OP_OVERFLOW",
            format!("the runner's output-retention quota was exhausted at {retained_bytes} bytes"),
        ),
        JobFailure::SpoolIo { detail } => (
            "OP_SPOOL_IO",
            format!("the runner's disk spool failed: {detail}"),
        ),
        JobFailure::PipeIo { detail } => (
            "OP_PIPE_IO",
            format!("reading the command's output failed: {detail}"),
        ),
    };
    let mut detail = std::collections::HashMap::new();
    detail.insert("failure".to_string(), kind.to_string());
    detail.insert(
        "captured_stdout_bytes".to_string(),
        exit.stdout.total_bytes.to_string(),
    );
    detail.insert(
        "captured_stderr_bytes".to_string(),
        exit.stderr.total_bytes.to_string(),
    );
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::Os as i32,
            message: format!(
                "{what}; the command was killed by the runner ({kind}, a runner/host \
                 condition — not a command failure). Output up to the failure point was \
                 counted but the assembled reply was discarded. Retry, or reduce the \
                 command's output volume."
            ),
            retryable: true,
            detail,
        }),
        result: None,
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

/// The adapter's reply-assembly buffers. Bytes past the breaker are counted,
/// never stored (the op keeps running; the reply becomes a typed oversize).
#[derive(Debug, Default)]
struct ReplyBuffers {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    total_bytes: u64,
    overflowed: bool,
}

impl ReplyBuffers {
    fn absorb(&mut self, channel: Channel, bytes: &[u8], breaker: u64) {
        let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if self.total_bytes.saturating_add(len) <= breaker {
            match channel {
                Channel::Stdout => self.stdout.extend_from_slice(bytes),
                Channel::Stderr => self.stderr.extend_from_slice(bytes),
                Channel::Content => {}
            }
        } else {
            self.overflowed = true;
        }
        self.total_bytes = self.total_bytes.saturating_add(len);
    }
}

#[cfg(test)]
mod tests {
    use opengeni_agent_engine::admission::AdmissionConfig;
    use opengeni_agent_engine::HostCapacity;
    use opengeni_agent_platform::NativePlatform;

    use super::*;

    fn test_engine() -> (Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = Engine::with_admission(
            dir.path().join("spool"),
            HostCapacity::default(),
            AdmissionConfig::default(),
        );
        (engine, dir)
    }

    fn native() -> Arc<NativePlatform> {
        Arc::new(NativePlatform::with_root(std::env::temp_dir()))
    }

    fn exec_req(command: &[&str], shell: bool) -> v1::ExecRequest {
        v1::ExecRequest {
            command: command.iter().map(ToString::to_string).collect(),
            shell,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn exec_round_trips_output_and_exit_code() {
        let (engine, _dir) = test_engine();
        let platform = native();
        let req = exec_req(&["printf hi; printf err >&2; exit 3"], true);
        let resp = serve_exec(&engine, &platform, "r-1".to_string(), req).await;
        assert_eq!(resp.request_id, "r-1");
        assert!(resp.error.is_none(), "clean run: {:?}", resp.error);
        match resp.result {
            Some(RespResult::Exec(e)) => {
                assert_eq!(e.exit_code, 3);
                assert_eq!(&e.stdout[..], b"hi");
                assert_eq!(&e.stderr[..], b"err");
                assert!(!e.timed_out);
            }
            other => panic!("expected Exec result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn exec_stdin_is_fed() {
        let (engine, _dir) = test_engine();
        let platform = native();
        let mut req = exec_req(&["cat"], true);
        req.stdin = prost::bytes::Bytes::from_static(b"fed-bytes");
        let resp = serve_exec(&engine, &platform, "r-stdin".to_string(), req).await;
        match resp.result {
            Some(RespResult::Exec(e)) => assert_eq!(&e.stdout[..], b"fed-bytes"),
            other => panic!("expected Exec result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn exec_timeout_matches_the_legacy_shape() {
        let (engine, _dir) = test_engine();
        let platform = native();
        let mut req = exec_req(&["printf early; sleep 30"], true);
        req.timeout_ms = 300;
        let resp = serve_exec(&engine, &platform, "r-timeout".to_string(), req).await;
        match resp.result {
            Some(RespResult::Exec(e)) => {
                // The legacy contract: a timeout DISCARDS captured output and
                // reports the sentinel stderr.
                assert_eq!(e.exit_code, -1);
                assert!(e.timed_out);
                assert!(e.stdout.is_empty());
                assert_eq!(&e.stderr[..], b"timed out");
            }
            other => panic!("expected Exec result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn exec_spawn_failure_maps_to_the_typed_platform_error() {
        let (engine, _dir) = test_engine();
        let platform = native();
        // Non-shell exec of a program that does not exist.
        let req = exec_req(&["/nonexistent/definitely-not-a-program"], false);
        let resp = serve_exec(&engine, &platform, "r-nf".to_string(), req).await;
        let err = resp.error.expect("typed spawn error");
        assert_eq!(err.code, ErrorCode::NotFound as i32, "{err:?}");
    }

    #[tokio::test]
    async fn duplicate_request_id_replays_the_settled_reply_without_rerunning() {
        let (engine, _dir) = test_engine();
        let platform = native();
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("ran");
        let script = format!("echo x >> {}; printf done", marker.display());

        let first = serve_exec(
            &engine,
            &platform,
            "r-dup".to_string(),
            exec_req(&[script.as_str()], true),
        )
        .await;
        assert!(first.error.is_none());

        let second = serve_exec(
            &engine,
            &platform,
            "r-dup".to_string(),
            exec_req(&[script.as_str()], true),
        )
        .await;
        assert_eq!(
            first, second,
            "a duplicate request id replays the stashed reply"
        );
        let runs = std::fs::read_to_string(&marker).expect("marker written");
        assert_eq!(runs.lines().count(), 1, "the command ran exactly once");
    }

    /// Whether a usable `git` exists on this host (tests skip cleanly if not).
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[tokio::test]
    async fn git_raw_round_trips_through_the_engine() {
        if !git_available() {
            eprintln!("SKIP git_raw_round_trips_through_the_engine: no git on this host");
            return;
        }
        let (engine, _dir) = test_engine();
        let platform = native();
        let req = v1::GitRequest {
            op: v1::GitOp::Raw as i32,
            args: vec!["--version".to_string()],
            ..Default::default()
        };
        let resp = serve_git(&engine, &platform, "g-1".to_string(), req).await;
        assert!(resp.error.is_none(), "clean run: {:?}", resp.error);
        match resp.result {
            Some(RespResult::Git(g)) => {
                assert_eq!(g.exit_code, 0);
                assert!(String::from_utf8_lossy(&g.stdout).contains("git version"));
            }
            other => panic!("expected Git result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_status_stays_structured_through_the_engine() {
        if !git_available() {
            eprintln!("SKIP git_status_stays_structured_through_the_engine: no git on this host");
            return;
        }
        let (engine, _dir) = test_engine();
        let platform = native();
        let repo = tempfile::tempdir().expect("tempdir");
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .output()
            .expect("git init");
        assert!(init.status.success());

        let req = v1::GitRequest {
            op: v1::GitOp::Status as i32,
            cwd: repo.path().to_string_lossy().into_owned(),
            ..Default::default()
        };
        let resp = serve_git(&engine, &platform, "g-status".to_string(), req).await;
        assert!(resp.error.is_none(), "clean run: {:?}", resp.error);
        match resp.result {
            Some(RespResult::Git(g)) => {
                assert_eq!(g.exit_code, 0);
                let status = g.status.expect("porcelain parse survives the adapter");
                assert!(status.clean, "a fresh repo is clean");
            }
            other => panic!("expected Git result, got {other:?}"),
        }
    }

    #[test]
    fn buffers_count_past_the_breaker_without_storing() {
        let mut buffers = ReplyBuffers::default();
        buffers.absorb(Channel::Stdout, &[1u8; 8], 10);
        buffers.absorb(Channel::Stdout, &[2u8; 8], 10);
        assert!(buffers.overflowed);
        assert_eq!(buffers.total_bytes, 16);
        assert_eq!(buffers.stdout.len(), 8, "only the in-budget bytes stored");
    }
}
