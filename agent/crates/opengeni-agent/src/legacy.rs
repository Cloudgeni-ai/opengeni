//! Request/reply Git adapter served over the op engine
//! (ENGINE-INTEGRATION.md §Supervisor rework).
//!
//! The command runs as an engine job — same registry (duplicate request
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

use opengeni_agent_engine::admission::JobClass;
use opengeni_agent_engine::registry::QueryAnswer;
use opengeni_agent_engine::{Channel, FrameBody, OpId};
use opengeni_agent_platform::{assemble_git_response, Platform};
use opengeni_agent_proto::v1::{
    self, control_response::Result as RespResult, AgentError, ControlResponse, ErrorCode,
};
use prost::Message as _;
use tracing::warn;

use crate::engine::{scoped_op_id, scoped_origin, Engine, StartOutcome, LEGACY_ORIGIN};
use crate::job::{JobCommand, JobExit, JobFailure, JobOutcome};

/// Cancels the op if the adapter future is DROPPED before the terminal
/// record — a legacy op is generation-scoped (the pre-engine semantics: a
/// disconnect/shutdown aborts accepted request/reply work and kills its
/// child), unlike op-stream jobs which deliberately survive generation end
/// (op ⊥ connection). Without this, the engine's routing map keeps the pump's
/// mailbox alive, so a JoinSet abort alone would leave the child running.
struct CancelOnDrop {
    engine: Arc<Engine>,
    op_id: OpId,
    armed: bool,
}

impl CancelOnDrop {
    fn new(engine: Arc<Engine>, op_id: OpId) -> Self {
        Self {
            engine,
            op_id,
            armed: true,
        }
    }

    /// The op reached its terminal record; the guard has nothing to do.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.engine.cancel(&self.op_id);
        }
    }
}

/// The adapter's local consumer attach generation. Nothing else ever attaches
/// to a legacy job (its op id never reaches the op-stream surface), so a
/// constant generation is correct.
const LOCAL_GENERATION: u64 = 1;

/// Serves a legacy `git` request over the op engine — same wire shape as the
/// pre-engine implementation (porcelain status parse included via the shared
/// [`assemble_git_response`]), but the git children now run CONTAINED with a
/// per-op OOM cgroup leaf (a clone's page cache bills to the op, closing the
/// #351 git-boundary hole). Heavy admission; idempotent by request id.
#[cfg(test)]
pub async fn serve_git<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    request_id: String,
    req: v1::GitRequest,
) -> ControlResponse {
    serve_git_scoped(engine, platform, "default", request_id, req).await
}

/// Multi-connection form of [`serve_git`].
#[cfg(test)]
pub async fn serve_git_scoped<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    scope: &str,
    request_id: String,
    req: v1::GitRequest,
) -> ControlResponse {
    serve_git_scoped_with_policy(engine, platform, scope, request_id, req, None).await
}

/// Policy-aware legacy git adapter. Git descendants and page cache share the
/// same per-operation leaf and connection policy as exec.
pub async fn serve_git_scoped_with_policy<P: Platform>(
    engine: &Arc<Engine>,
    platform: &Arc<P>,
    scope: &str,
    request_id: String,
    req: v1::GitRequest,
    resource_policy: Option<v1::OperationResourcePolicy>,
) -> ControlResponse {
    let op_id = scoped_op_id(scope, &request_id);
    let origin = scoped_origin(scope, LEGACY_ORIGIN);
    let ticket = match engine.admit(&op_id, JobClass::Heavy, &origin).await {
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
        || platform.spawn_git_with_policy(&req, resource_policy.as_ref()),
        emit,
        |_exit| Vec::new(),
        move |_exit_seq, exit: &JobExit| {
            let _ = exit_tx.send(exit.clone());
        },
    );

    match outcome {
        StartOutcome::Started(started) => {
            let mut guard = CancelOnDrop::new(engine.clone(), op_id);
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
                guard.disarm();
                return error_reply(
                    request_id,
                    ErrorCode::Os,
                    "the git job ended without producing a terminal record",
                    false,
                );
            };
            guard.disarm();

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

// The tests drive REAL /bin/sh children through the containment primitive —
// they validate POSIX child semantics (exit codes, pipes, process groups)
// and are unix-only by nature. The code under test itself
// compiles and runs on Windows (Job Objects); its Windows behavior is
// covered by the platform crate's cross-platform surface.
#[cfg(all(test, unix))]
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
