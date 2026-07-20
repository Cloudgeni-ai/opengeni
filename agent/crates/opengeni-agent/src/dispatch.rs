//! The control-RPC dispatch table.
//!
//! A [`ControlRequest`] arrives on the agent's `agent.<ws>.<id>.rpc` subject
//! (§10.1). [`dispatch`] decodes its `op` oneof, calls the matching
//! [`Platform`](opengeni_agent_platform::Platform) method, and builds a
//! [`ControlResponse`] that carries the same `request_id` and either the typed
//! result or a mapped [`AgentError`](opengeni_agent_proto::v1::AgentError) — a
//! handler error is a value on the response, **never a panic**.
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
    /// Whether the operator consented to SCREEN CONTROL at enrollment (the same
    /// grant the relay framebuffer pump's `allow_input` gates on). The
    /// [`Op::DesktopInput`] arm refuses synthetic input with
    /// [`ErrorCode::ConsentRequired`] when this is `false`, BEFORE touching the OS.
    pub consented_screen_control: bool,
    /// The connection's NEGOTIATED max reply payload in bytes (the NATS
    /// `server_info().max_payload`, deployment-agnostic — never a hardcoded 1 MiB).
    /// A reply larger than this cannot be published, so an op that produces a large
    /// reply (a full-res screenshot) fits it under this budget agent-side. `0` means
    /// "no known bound" (a test/sync context) → ops pass their reply through
    /// untouched and the wire-seam backstop is the only guard.
    pub max_reply_bytes: usize,
}

/// Headroom subtracted from [`DispatchContext::max_reply_bytes`] when an op bounds
/// its own reply body (the screenshot), covering the `ControlResponse` envelope the
/// body is wrapped in (`request_id`, field tags, the width/height varints) so the
/// FULLY-encoded reply — not just the body — stays under the negotiated max. The
/// generic wire-seam backstop checks the true encoded size regardless, so this is a
/// best-effort first cut, not the sole guard.
pub const REPLY_ENVELOPE_MARGIN: usize = 4 * 1024;

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

        // --- op-stream (v1.1): wire types exist, no runtime serves them yet ----
        // The runner does not advertise `Capabilities.op_stream`, so a compliant
        // server never sends these; answer any that arrive with a typed Unsupported
        // rather than a silent drop, until the op engine is wired.
        Op::OpStart(_) | Op::OpCancel(_) | Op::OpQuery(_) | Op::OpAttach(_) | Op::WriteChunk(_) => {
            op_stream_unsupported(request_id)
        }

        // --- platform-backed Channel-A ops -----------------------------------
        // NOTE: `exec` (large stdout/stderr) and `fs_read` (a big file) produce
        // UNBOUNDED replies that can exceed the transport's max payload — the same
        // latent wall the screenshot hit. They are NOT bounded here; the generic
        // wire-seam backstop in `supervisor::handle_message` converts any such
        // oversized reply into a structured `PayloadTooLarge` error rather than a
        // silent publish failure + caller timeout. If a future need arises to stream
        // or chunk these bodies, bound them at the op like the screenshot does.
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

        // --- computer-use control ops: the AGENT drives its own desktop --------
        // Extracted to helpers so this dispatch match stays compact + readable.
        Op::DesktopInput(req) => desktop_input(request_id, req, platform, ctx).await,
        Op::DesktopScreenshot(_req) => desktop_screenshot(request_id, platform, ctx).await,
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

/// Handles [`Op::DesktopInput`] — the computer-use INJECT op the agent runs
/// against its own desktop.
///
/// SECURITY: synthetic input REQUIRES the operator to have consented to screen
/// control at enrollment. When consent was not granted, this returns
/// [`ErrorCode::ConsentRequired`] and DOES NOT inject — the platform is never
/// touched.
async fn desktop_input<P: Platform>(
    request_id: String,
    req: v1::DesktopInputRequest,
    platform: &Arc<P>,
    ctx: &DispatchContext,
) -> ControlResponse {
    if ctx.consented_screen_control {
        // The event oneof types (Pointer/Key/Scroll) are SHARED with the relay
        // `DesktopInput`, so the map is a 1:1 rename of the wrapper. A control-plane
        // input has no relay channel, so `channel_id` is empty (it goes straight to
        // the display).
        let input = v1::DesktopInput {
            channel_id: String::new(),
            event: req.event.map(|event| match event {
                v1::desktop_input_request::Event::Pointer(p) => {
                    v1::desktop_input::Event::Pointer(p)
                }
                v1::desktop_input_request::Event::Key(k) => v1::desktop_input::Event::Key(k),
                v1::desktop_input_request::Event::Scroll(s) => v1::desktop_input::Event::Scroll(s),
            }),
        };
        result(
            request_id,
            platform
                .desktop_input(&input)
                .await
                .map(|()| v1::DesktopInputResponse {}),
            RespResult::DesktopInput,
        )
    } else {
        consent_required_error(request_id, "screen control not consented")
    }
}

/// Handles [`Op::DesktopScreenshot`] — a one-shot desktop capture.
///
/// NO consent gate: a screenshot is a VIEW op — it needs a DISPLAY, not
/// screen-control consent (the view/control decoupling). A headless host surfaces
/// `Unsupported` from the backend, mapped like any other error.
async fn desktop_screenshot<P: Platform>(
    request_id: String,
    platform: &Arc<P>,
    ctx: &DispatchContext,
) -> ControlResponse {
    // Fit the captured PNG under the connection's negotiated reply budget so the
    // reply can actually be published. A full-res capture of a busy or Retina
    // display can exceed the transport's max payload (NATS defaults to 1 MiB); the
    // reply publish then fails agent-side and the caller times out with no cause.
    // `fit_frame_to_budget` downscales (lossless PNG kept) to the largest geometry
    // that fits, reporting BOTH the encoded and the native geometry so the
    // control-plane coordinate mapping can scale model clicks back to native pixels.
    // A `budget` of 0 (no known bound) passes the frame through untouched. The
    // envelope margin leaves room for the `ControlResponse` wrapper; the wire-seam
    // backstop still catches any residual that even the minimum size cannot fit.
    let budget = ctx.max_reply_bytes.saturating_sub(REPLY_ENVELOPE_MARGIN);
    result(
        request_id,
        platform.desktop().capture().await.map(|frame| {
            let fitted = opengeni_agent_platform::fit_frame_to_budget(frame, budget);
            v1::DesktopScreenshotResponse {
                png: fitted.png.into(),
                width: fitted.width,
                height: fitted.height,
                native_width: fitted.native_width,
                native_height: fitted.native_height,
            }
        }),
        RespResult::DesktopScreenshot,
    )
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

/// Builds the structured [`ErrorCode::PayloadTooLarge`] `ControlResponse` the
/// supervisor's wire-seam backstop publishes IN PLACE OF an oversized reply — the
/// reply the op produced could not be published (it exceeds the connection's
/// negotiated max payload), so rather than let the publish fail with only a WARN and
/// leave the caller to time out opaquely, we replace it with a small, diagnosable
/// error carrying the offending/negotiated sizes. Not retryable: the same op would
/// produce the same oversized reply.
#[must_use]
pub fn oversized_reply_error(
    request_id: String,
    op_label: &str,
    encoded_len: usize,
    max_payload: usize,
) -> ControlResponse {
    let mut detail = std::collections::HashMap::new();
    detail.insert("op".to_string(), op_label.to_string());
    detail.insert("encoded_bytes".to_string(), encoded_len.to_string());
    detail.insert("max_payload".to_string(), max_payload.to_string());
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::PayloadTooLarge as i32,
            message: format!(
                "reply for op '{op_label}' is {encoded_len} bytes, over the transport's \
                 negotiated max payload of {max_payload} bytes; it could not be published"
            ),
            retryable: false,
            detail,
        }),
        result: None,
    }
}

/// Builds the retryable [`ErrorCode::Draining`] response returned when an
/// admission CIRCUIT BREAKER trips (LIMITS-DOCTRINE: the runner holds no
/// concurrency policy — a refusal means pathology, not load, and it names the
/// tripped breaker). The machine remains online, heartbeats continue, and
/// `ping` never enters admission.
#[must_use]
pub fn breaker_reply_error(
    request_id: String,
    op_label: &str,
    reason: opengeni_agent_engine::admission::RefusalReason,
) -> ControlResponse {
    use opengeni_agent_engine::admission::RefusalReason;
    let breaker = match reason {
        RefusalReason::QueueFull => "queue_breaker",
        RefusalReason::WaitDeadline => "wait_breaker",
    };
    let mut detail = std::collections::HashMap::new();
    detail.insert("op".to_string(), op_label.to_string());
    detail.insert("backpressure".to_string(), breaker.to_string());
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::Draining as i32,
            message: format!(
                "the runner's admission breaker '{breaker}' tripped for op '{op_label}' — \
                 this signals a pathological backlog, not normal load; retry, and expect \
                 host-capacity telemetry to explain the pressure"
            ),
            retryable: true,
            detail,
        }),
        result: None,
    }
}

/// The fenced-epoch reply, shared with the supervisor's adapter route (which
/// fences BEFORE reaching this dispatch table, mirroring the check above).
#[must_use]
pub fn fenced_reply(request_id: String, op_epoch: u32, held_epoch: u32) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(fenced_error(op_epoch, held_epoch)),
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

/// A `ERROR_CODE_CONSENT_REQUIRED` response for a screen-control op the operator
/// did not consent to at enrollment. Built here (not via the platform) because the
/// gate is enforced BEFORE the platform is reached — no input is injected.
fn consent_required_error(request_id: String, message: &str) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::ConsentRequired as i32,
            message: message.to_string(),
            retryable: false,
            detail: std::collections::HashMap::new(),
        }),
        result: None,
    }
}

/// A `ERROR_CODE_UNSUPPORTED` response for an op-stream request received before the
/// op engine is wired. The runner does not advertise `Capabilities.op_stream`, so
/// this path should not be hit in practice; it exists so an early/forced op-stream
/// request gets a typed answer instead of a silent drop.
fn op_stream_unsupported(request_id: String) -> ControlResponse {
    ControlResponse {
        request_id,
        error: Some(AgentError {
            code: ErrorCode::Unsupported as i32,
            message: "op-stream is not yet served by this runner".to_string(),
            retryable: false,
            detail: std::collections::HashMap::new(),
        }),
        result: None,
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

    /// A fake desktop backend that records every injected input and hands back a
    /// canned screenshot, so the computer-use control ops can be exercised without
    /// a real display.
    #[derive(Default)]
    struct FakeDesktop {
        injected: std::sync::Mutex<Vec<v1::DesktopInput>>,
    }

    impl FakeDesktop {
        /// The canned screenshot bytes/geometry the `capture()` fake returns.
        const PNG: &'static [u8] = b"fake-png-bytes";
        const WIDTH: u32 = 320;
        const HEIGHT: u32 = 240;
    }

    #[async_trait]
    impl opengeni_agent_platform::DesktopBackend for FakeDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":0".to_string(),
                width: Self::WIDTH,
                height: Self::HEIGHT,
                r#virtual: false,
            })
        }
        async fn capture(&self) -> PlatformResult<opengeni_agent_platform::CapturedFrame> {
            Ok(opengeni_agent_platform::CapturedFrame {
                png: Self::PNG.to_vec(),
                width: Self::WIDTH,
                height: Self::HEIGHT,
            })
        }
        async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
            self.injected.lock().unwrap().push(input.clone());
            Ok(())
        }
    }

    /// A fake platform recording the last op it saw and returning canned results,
    /// so the dispatch table can be exercised without touching the real host.
    #[derive(Default)]
    struct FakePlatform {
        fail_exec: bool,
        desktop: Arc<FakeDesktop>,
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
            self.desktop.clone()
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
        ctx_with_consent(false)
    }

    fn ctx_with_consent(consented_screen_control: bool) -> DispatchContext {
        DispatchContext {
            agent_id: "a1".to_string(),
            epoch: 5,
            started: std::time::Instant::now(),
            consented_screen_control,
            // Tests exercise the dispatch logic, not the wire budget; 0 = unbounded
            // (frames pass through untouched, matching pre-backstop behavior).
            max_reply_bytes: 0,
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
        let platform = Arc::new(FakePlatform {
            fail_exec: true,
            ..Default::default()
        });
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

    #[test]
    fn breaker_reply_is_retryable_backpressure_naming_the_breaker() {
        use opengeni_agent_engine::admission::RefusalReason;
        let response =
            breaker_reply_error("req-breaker".to_string(), "exec", RefusalReason::QueueFull);
        assert_eq!(response.request_id, "req-breaker");
        assert!(response.result.is_none());
        let err = response.error.expect("breaker error");
        assert_eq!(err.code, ErrorCode::Draining as i32);
        assert!(err.retryable);
        assert_eq!(err.detail.get("op").map(String::as_str), Some("exec"));
        assert_eq!(
            err.detail.get("backpressure").map(String::as_str),
            Some("queue_breaker")
        );
    }

    #[test]
    fn oversized_reply_is_typed_and_does_not_claim_liveness_loss() {
        let response = oversized_reply_error("req-large".to_string(), "fs_read", 2048, 1024);
        assert_eq!(response.request_id, "req-large");
        assert!(response.result.is_none());
        let err = response.error.expect("payload error");
        assert_eq!(err.code, ErrorCode::PayloadTooLarge as i32);
        assert!(!err.retryable);
        assert_eq!(
            err.detail.get("encoded_bytes").map(String::as_str),
            Some("2048")
        );
        assert_eq!(
            err.detail.get("max_payload").map(String::as_str),
            Some("1024")
        );
    }

    #[tokio::test]
    async fn desktop_input_without_consent_is_refused_and_never_injects() {
        let platform = Arc::new(FakePlatform::default());
        let req = request(
            5,
            Op::DesktopInput(v1::DesktopInputRequest {
                event: Some(v1::desktop_input_request::Event::Pointer(
                    v1::PointerEvent {
                        x: 10,
                        y: 20,
                        action: v1::PointerAction::Click as i32,
                        button: v1::PointerButton::Left as i32,
                    },
                )),
            }),
        );
        // ctx() defaults consented_screen_control = false.
        let resp = dispatch(req, &platform, &ctx()).await;
        assert!(resp.result.is_none(), "no result on a refused input");
        let err = resp.error.expect("consent error present");
        assert_eq!(err.code, ErrorCode::ConsentRequired as i32);
        // The security-critical assertion: the platform was NEVER touched.
        assert!(
            platform.desktop.injected.lock().unwrap().is_empty(),
            "an unconsented input must NOT reach inject"
        );
    }

    #[tokio::test]
    async fn desktop_input_with_consent_injects_the_event() {
        let platform = Arc::new(FakePlatform::default());
        let pointer = v1::PointerEvent {
            x: 42,
            y: 99,
            action: v1::PointerAction::Down as i32,
            button: v1::PointerButton::Right as i32,
        };
        let req = request(
            5,
            Op::DesktopInput(v1::DesktopInputRequest {
                // `PointerEvent` is `Copy`, so this does not move `pointer`.
                event: Some(v1::desktop_input_request::Event::Pointer(pointer)),
            }),
        );
        let resp = dispatch(req, &platform, &ctx_with_consent(true)).await;
        assert!(resp.error.is_none(), "a consented input has no error");
        assert!(matches!(resp.result, Some(RespResult::DesktopInput(_))));
        let seen = platform.desktop.injected.lock().unwrap();
        assert_eq!(seen.len(), 1, "exactly one inject reached the backend");
        // The control-plane input maps to a relay DesktopInput with an EMPTY
        // channel_id (it goes straight to the display) and the same event.
        assert_eq!(seen[0].channel_id, "");
        assert_eq!(
            seen[0].event,
            Some(v1::desktop_input::Event::Pointer(pointer)),
            "the event must reach inject unchanged"
        );
    }

    #[tokio::test]
    async fn desktop_screenshot_returns_the_captured_frame_without_consent() {
        let platform = Arc::new(FakePlatform::default());
        // No consent needed: a screenshot is a VIEW op; ctx() is UNCONSENTED.
        let req = request(5, Op::DesktopScreenshot(v1::DesktopScreenshotRequest {}));
        let resp = dispatch(req, &platform, &ctx()).await;
        assert!(resp.error.is_none(), "a screenshot needs no consent");
        match resp.result {
            Some(RespResult::DesktopScreenshot(s)) => {
                assert_eq!(&s.png[..], FakeDesktop::PNG);
                assert_eq!(s.width, FakeDesktop::WIDTH);
                assert_eq!(s.height, FakeDesktop::HEIGHT);
                // With no budget (max_reply_bytes = 0) the frame passes through
                // untouched: native geometry equals the encoded geometry (no
                // downscale), the byte-identical current behavior.
                assert_eq!(s.native_width, FakeDesktop::WIDTH);
                assert_eq!(s.native_height, FakeDesktop::HEIGHT);
            }
            other => panic!("expected DesktopScreenshot, got {other:?}"),
        }
    }
}
