//! The control-RPC dispatch table.
//!
//! A [`ControlRequest`] arrives on the agent's `agent.<ws>.<id>.rpc` subject
//! (§10.1). [`dispatch`] decodes its `op` oneof, calls the matching
//! [`Platform`](opengeni_agent_platform::Platform) method, and builds a
//! [`ControlResponse`] that carries the same `request_id` and either the typed
//! result or a mapped [`AgentError`](opengeni_agent_proto::v1::AgentError) — a
//! handler error is a value on the response, **never a panic** (dossier §10.1).
//!
//! Lifecycle ops (`ping`, `hello`, `resume`, `metrics`, `update_may_proceed`) are
//! answered by the agent itself rather than the platform: they are about the
//! connection/identity, not the host. The platform-backed ops are exec, the
//! filesystem family, git, and the M8 pty/desktop seams (which return a typed
//! `Unsupported` until M8).
//!
//! ## Epoch fencing
//!
//! `ControlRequest.epoch` carries the lease/active epoch the control plane
//! resolved the op against (§10.6). The agent rejects an op whose epoch is
//! *older* than the epoch it currently holds with [`ErrorCode::Fenced`] so a
//! stale in-flight op (issued before a swap/reconnect) is retried against the
//! new generation rather than executed on a swapped-away machine. The dispatcher
//! is handed the agent's current epoch by the supervisor.

use std::sync::Arc;

use opengeni_agent_platform::{Platform, PlatformError};
use opengeni_agent_proto::v1::{
    self, control_request::Op, control_response::Result as RespResult, AgentError, ControlRequest,
    ControlResponse, ErrorCode,
};

/// The agent-side identity + connection state the dispatcher needs to answer the
/// lifecycle ops (`ping`/`metrics`) and fence stale ops. Cheap to clone (small
/// owned strings + counters), so the supervisor can hand a snapshot to each
/// request handler.
#[derive(Debug, Clone)]
pub struct DispatchContext {
    /// This agent's id (echoed in logs; bound to the request for traceability).
    pub agent_id: String,
    /// The current lease epoch the agent holds; ops fenced below this are
    /// rejected with [`ErrorCode::Fenced`].
    pub epoch: u32,
    /// Process start instant, for the ping/heartbeat monotonic clock.
    pub started: std::time::Instant,
}

impl DispatchContext {
    /// Milliseconds since the agent process started (the monotonic clock the
    /// ping/heartbeat reports for skew estimation).
    #[must_use]
    pub fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Decodes a raw `ControlRequest` payload, dispatches it, and returns the encoded
/// `ControlResponse` bytes ready to publish on the reply inbox. A decode failure
/// is itself answered with a [`ErrorCode::Protocol`] response (with an empty
/// `request_id` since we could not read one) rather than dropped, so the caller
/// never times out silently.
#[must_use]
pub fn dispatch_bytes<P: Platform>(
    payload: &[u8],
    platform: &Arc<P>,
    ctx: &DispatchContext,
) -> Vec<u8> {
    use prost::Message as _;
    let request = match ControlRequest::decode(payload) {
        Ok(req) => req,
        Err(err) => {
            let resp = ControlResponse {
                request_id: String::new(),
                error: Some(AgentError {
                    code: ErrorCode::Protocol as i32,
                    message: format!("undecodable ControlRequest: {err}"),
                    retryable: false,
                    detail: std::collections::HashMap::new(),
                }),
                result: None,
            };
            return resp.encode_to_vec();
        }
    };
    let resp = dispatch_future(request, platform, ctx);
    futures::executor::block_on(resp).encode_to_vec()
}

/// Async dispatch of a decoded request. Pulled out so the NATS handler can
/// `.await` it directly (the byte entrypoint above is for sync contexts/tests).
pub async fn dispatch<P: Platform>(
    request: ControlRequest,
    platform: &Arc<P>,
    ctx: &DispatchContext,
) -> ControlResponse {
    dispatch_future(request, platform, ctx).await
}

/// The actual oneof match. Separate from [`dispatch`] only to share the body with
/// the sync [`dispatch_bytes`] entrypoint.
async fn dispatch_future<P: Platform>(
    request: ControlRequest,
    platform: &Arc<P>,
    ctx: &DispatchContext,
) -> ControlResponse {
    let request_id = request.request_id.clone();
    tracing::trace!(
        agent_id = %ctx.agent_id,
        request_id = %request_id,
        epoch = request.epoch,
        "dispatching control request"
    );

    // Epoch fence: reject ops the control plane resolved against an OLDER epoch
    // than the agent currently holds (a stale, pre-swap/pre-reconnect op). An
    // epoch of 0 means "unset" (e.g. the connect hello) and is never fenced.
    if request.epoch != 0 && request.epoch < ctx.epoch {
        return err_response(
            request_id,
            &PlatformError::Unsupported(String::new()),
            fenced_error(request.epoch, ctx.epoch),
        );
    }

    let Some(op) = request.op else {
        return protocol_error(request_id, "ControlRequest carried no op");
    };

    match op {
        // --- lifecycle ops answered by the agent itself ----------------------
        Op::Ping(req) => ok(
            request_id,
            RespResult::Ping(v1::PingResponse {
                nonce: req.nonce,
                agent_monotonic_ms: ctx.monotonic_ms(),
            }),
        ),
        Op::Metrics(_) => {
            // The sample briefly blocks (a /proc/stat CPU delta) → the blocking
            // pool, so the dispatch loop is never stalled. A join failure degrades
            // to a default sample (a metrics gap is never fatal, §10.7).
            let metrics = tokio::task::spawn_blocking(crate::metrics::sample)
                .await
                .unwrap_or_default();
            ok(request_id, RespResult::Metrics(metrics))
        }
        Op::Hello(_) | Op::Resume(_) | Op::UpdateMayProceed(_) => {
            // These are control-plane→agent acknowledgements the agent ORIGINATES
            // (it sends a Hello and receives a HelloAck); receiving one as an
            // inbound op is a protocol misuse. Answer with a clear protocol error
            // rather than fabricate state.
            protocol_error(
                request_id,
                "hello/resume/update_may_proceed are agent-initiated, not inbound ops",
            )
        }

        // --- platform-backed Channel-A ops -----------------------------------
        Op::Exec(req) => result(request_id, platform.exec(&req).await, RespResult::Exec),
        Op::FsRead(req) => result(request_id, platform.fs_read(&req).await, RespResult::FsRead),
        Op::FsWrite(req) => result(
            request_id,
            platform.fs_write(&req).await,
            RespResult::FsWrite,
        ),
        Op::FsList(req) => result(request_id, platform.fs_list(&req).await, RespResult::FsList),
        Op::FsMkdir(req) => result(
            request_id,
            platform.fs_mkdir(&req).await,
            RespResult::FsMkdir,
        ),
        Op::FsMove(req) => result(request_id, platform.fs_move(&req).await, RespResult::FsMove),
        Op::FsStat(req) => result(request_id, platform.fs_stat(&req).await, RespResult::FsStat),
        Op::FsRemove(req) => result(
            request_id,
            platform.fs_remove(&req).await,
            RespResult::FsRemove,
        ),
        Op::Git(req) => result(request_id, platform.git(&req).await, RespResult::Git),

        // --- M8 stream ops: pty + desktop over the relay --------------------
        Op::PtyOpen(req) => result(
            request_id,
            platform.pty_open(&req).await,
            RespResult::PtyOpen,
        ),
        Op::DesktopEnsure(req) => result(
            request_id,
            platform.desktop_ensure(&req).await,
            RespResult::DesktopEnsure,
        ),
        Op::PtyWrite(req) => result(
            request_id,
            platform.pty_write(&req).await,
            RespResult::PtyWrite,
        ),
        Op::PtyResize(req) => result(
            request_id,
            platform.pty_resize(&req).await,
            RespResult::PtyResize,
        ),
        Op::PtyClose(req) => result(
            request_id,
            platform.pty_close(&req).await,
            RespResult::PtyClose,
        ),
    }
}

/// Wraps a successful typed result into a `ControlResponse`.
fn ok(request_id: String, result: RespResult) -> ControlResponse {
    ControlResponse {
        request_id,
        error: None,
        result: Some(result),
    }
}

/// Folds a `PlatformResult` into a `ControlResponse`: the `Ok` value is wrapped
/// by `wrap`, an `Err` is mapped to the proto `AgentError`.
fn result<T>(
    request_id: String,
    outcome: Result<T, PlatformError>,
    wrap: impl FnOnce(T) -> RespResult,
) -> ControlResponse {
    match outcome {
        Ok(value) => ok(request_id, wrap(value)),
        Err(err) => {
            let agent_error = err.to_agent_error();
            err_response(request_id, &err, agent_error)
        }
    }
}

/// Builds an error `ControlResponse` (no `result`, just the `error`).
fn err_response(
    request_id: String,
    _err: &PlatformError,
    agent_error: AgentError,
) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(agent_error),
        result: None,
    }
}

/// A `ERROR_CODE_FENCED` AgentError for a stale-epoch op.
fn fenced_error(op_epoch: u32, held_epoch: u32) -> AgentError {
    let mut detail = std::collections::HashMap::new();
    detail.insert("op_epoch".to_string(), op_epoch.to_string());
    detail.insert("held_epoch".to_string(), held_epoch.to_string());
    AgentError {
        code: ErrorCode::Fenced as i32,
        message: format!("op epoch {op_epoch} is older than held epoch {held_epoch}; re-resolve"),
        retryable: true,
        detail,
    }
}

/// A `ERROR_CODE_PROTOCOL` error response for a malformed/misused request.
fn protocol_error(request_id: String, message: &str) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::Protocol as i32,
            message: message.to_string(),
            retryable: false,
            detail: std::collections::HashMap::new(),
        }),
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use opengeni_agent_platform::{HostIdentity, PlatformResult};
    use prost::Message as _;

    /// A fake platform recording the last op it saw and returning canned results,
    /// so the dispatch table can be exercised without touching the real host.
    #[derive(Default)]
    struct FakePlatform {
        fail_exec: bool,
    }

    #[async_trait]
    impl Platform for FakePlatform {
        fn host_identity(&self) -> HostIdentity {
            HostIdentity {
                os: v1::Os::Linux,
                arch: v1::Arch::X8664,
            }
        }
        fn workspace_root(&self) -> String {
            "/work".to_string()
        }
        fn desktop(&self) -> std::sync::Arc<dyn opengeni_agent_platform::DesktopBackend> {
            std::sync::Arc::new(opengeni_agent_platform::NoDesktop)
        }
        fn default_shell(&self) -> Vec<String> {
            vec!["/bin/sh".to_string()]
        }
        fn stream_registry(
            &self,
        ) -> Option<std::sync::Arc<dyn opengeni_agent_platform::StreamRegistry>> {
            None
        }
        async fn exec(&self, req: &v1::ExecRequest) -> PlatformResult<v1::ExecResponse> {
            if self.fail_exec {
                return Err(PlatformError::NotFound(format!(
                    "no such program: {:?}",
                    req.command
                )));
            }
            Ok(v1::ExecResponse {
                exit_code: 0,
                stdout: prost::bytes::Bytes::from(format!("ran {:?}", req.command).into_bytes()),
                stderr: prost::bytes::Bytes::new(),
                timed_out: false,
                duration_ms: 1,
            })
        }
        async fn fs_read(&self, _req: &v1::FsReadRequest) -> PlatformResult<v1::FsReadResponse> {
            Ok(v1::FsReadResponse {
                content: prost::bytes::Bytes::from_static(b"file-bytes"),
                total_size: 10,
            })
        }
        async fn fs_write(&self, req: &v1::FsWriteRequest) -> PlatformResult<v1::FsWriteResponse> {
            Ok(v1::FsWriteResponse {
                bytes_written: req.content.len() as u64,
            })
        }
        async fn fs_list(&self, _req: &v1::FsListRequest) -> PlatformResult<v1::FsListResponse> {
            Ok(v1::FsListResponse::default())
        }
        async fn fs_mkdir(&self, _req: &v1::FsMkdirRequest) -> PlatformResult<v1::FsMkdirResponse> {
            Ok(v1::FsMkdirResponse::default())
        }
        async fn fs_move(&self, _req: &v1::FsMoveRequest) -> PlatformResult<v1::FsMoveResponse> {
            Ok(v1::FsMoveResponse::default())
        }
        async fn fs_stat(&self, _req: &v1::FsStatRequest) -> PlatformResult<v1::FsStatResponse> {
            Ok(v1::FsStatResponse {
                exists: false,
                entry: None,
            })
        }
        async fn fs_remove(
            &self,
            _req: &v1::FsRemoveRequest,
        ) -> PlatformResult<v1::FsRemoveResponse> {
            Ok(v1::FsRemoveResponse::default())
        }
        async fn git(&self, _req: &v1::GitRequest) -> PlatformResult<v1::GitResponse> {
            Ok(v1::GitResponse {
                exit_code: 0,
                stdout: prost::bytes::Bytes::from_static(b"On branch main"),
                stderr: prost::bytes::Bytes::new(),
                status: None,
            })
        }
    }

    fn ctx() -> DispatchContext {
        DispatchContext {
            agent_id: "a1".to_string(),
            epoch: 5,
            started: std::time::Instant::now(),
        }
    }

    fn request(epoch: u32, op: Op) -> ControlRequest {
        ControlRequest {
            request_id: "req-1".to_string(),
            epoch,
            op: Some(op),
        }
    }

    #[tokio::test]
    async fn exec_request_round_trips_to_exec_response() {
        let platform = Arc::new(FakePlatform::default());
        let req = request(
            5,
            Op::Exec(v1::ExecRequest {
                command: vec!["ls".to_string()],
                ..Default::default()
            }),
        );
        let resp = dispatch(req, &platform, &ctx()).await;
        assert_eq!(resp.request_id, "req-1");
        assert!(resp.error.is_none());
        match resp.result {
            Some(RespResult::Exec(e)) => {
                assert_eq!(e.exit_code, 0);
                assert!(String::from_utf8_lossy(&e.stdout).contains("ls"));
            }
            other => panic!("expected Exec result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handler_error_maps_to_agent_error_not_panic() {
        let platform = Arc::new(FakePlatform { fail_exec: true });
        let req = request(
            5,
            Op::Exec(v1::ExecRequest {
                command: vec!["nope".to_string()],
                ..Default::default()
            }),
        );
        let resp = dispatch(req, &platform, &ctx()).await;
        assert!(resp.result.is_none());
        let err = resp.error.expect("error present");
        assert_eq!(err.code, ErrorCode::NotFound as i32);
        assert_eq!(resp.request_id, "req-1");
    }

    #[tokio::test]
    async fn ping_is_answered_by_the_agent() {
        let platform = Arc::new(FakePlatform::default());
        let req = request(5, Op::Ping(v1::PingRequest { nonce: 99 }));
        let resp = dispatch(req, &platform, &ctx()).await;
        match resp.result {
            Some(RespResult::Ping(p)) => assert_eq!(p.nonce, 99),
            other => panic!("expected Ping, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stale_epoch_is_fenced() {
        let platform = Arc::new(FakePlatform::default());
        // ctx epoch is 5; an op resolved against epoch 4 is stale.
        let req = request(
            4,
            Op::Exec(v1::ExecRequest {
                command: vec!["ls".to_string()],
                ..Default::default()
            }),
        );
        let resp = dispatch(req, &platform, &ctx()).await;
        let err = resp.error.expect("fenced error");
        assert_eq!(err.code, ErrorCode::Fenced as i32);
        assert!(err.retryable, "a fenced op must be retryable");
    }

    #[tokio::test]
    async fn equal_or_newer_epoch_is_accepted() {
        let platform = Arc::new(FakePlatform::default());
        for epoch in [5, 6, 0] {
            let req = request(epoch, Op::FsList(v1::FsListRequest::default()));
            let resp = dispatch(req, &platform, &ctx()).await;
            assert!(resp.error.is_none(), "epoch {epoch} should be accepted");
        }
    }

    #[tokio::test]
    async fn pty_open_surfaces_unsupported_seam() {
        let platform = Arc::new(FakePlatform::default());
        let req = request(5, Op::PtyOpen(v1::PtyOpenRequest::default()));
        let resp = dispatch(req, &platform, &ctx()).await;
        let err = resp.error.expect("unsupported");
        assert_eq!(err.code, ErrorCode::Unsupported as i32);
    }

    #[test]
    fn undecodable_payload_yields_protocol_error() {
        let platform = Arc::new(FakePlatform::default());
        // 0xFF is not a valid protobuf field header for ControlRequest's shape in
        // a way that decodes cleanly; feed clearly malformed bytes.
        let bytes = dispatch_bytes(&[0xff, 0xff, 0xff, 0xff], &platform, &ctx());
        let resp = ControlResponse::decode(bytes.as_slice()).expect("response decodes");
        assert_eq!(resp.error.expect("err").code, ErrorCode::Protocol as i32);
    }

    #[test]
    fn dispatch_bytes_round_trips_a_real_request() {
        let platform = Arc::new(FakePlatform::default());
        let req = request(
            5,
            Op::FsRead(v1::FsReadRequest {
                path: "x".to_string(),
                ..Default::default()
            }),
        );
        let bytes = dispatch_bytes(&req.encode_to_vec(), &platform, &ctx());
        let resp = ControlResponse::decode(bytes.as_slice()).expect("decode");
        assert_eq!(resp.request_id, "req-1");
        match resp.result {
            Some(RespResult::FsRead(r)) => assert_eq!(&r.content[..], b"file-bytes"),
            other => panic!("expected FsRead, got {other:?}"),
        }
    }
}
