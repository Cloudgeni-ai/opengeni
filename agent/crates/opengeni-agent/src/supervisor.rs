//! The resiliency supervisor: dial → serve → reconnect, forever, with full-jitter
//! backoff, fast heartbeats, and a clean SIGINT/SIGTERM going-offline.
//!
//! This is the runtime heart of the FOREGROUND run model (dossier §23.0) and the
//! headline resiliency pillar (§10.6). The supervisor:
//!
//! 1. **Dials** the control plane over NATS with the enrollment Account creds and
//!    sends a [`Hello`] (carrying the resume token so the control plane fences by
//!    epoch and recognizes a reconnect vs a fresh enrollment).
//! 2. **Subscribes** to `agent.<ws>.<id>.rpc` — that subscription IS the registry
//!    (§10.1) — and serves each [`ControlRequest`] by dispatching it to the
//!    [`Platform`] and replying on the message's reply inbox.
//! 3. **Heartbeats** every 5s on the events subject with a metrics sample so the
//!    control plane can dead-detect a vanished agent (§10.6 cadence).
//! 4. On **any disconnect**, sleeps a full-jitter [`Backoff`] delay (base 1s, cap
//!    60s) before reconnecting — NEVER a tight loop (the #1 outage cause). A
//!    reconnect re-subscribes the RPC subject (a fresh subscription).
//! 5. On a **clean stop** (SIGINT/SIGTERM) sends a [`GoingOffline`] event and
//!    closes cleanly so the lease flips offline IMMEDIATELY (§23.0), rather than
//!    waiting on heartbeat dead-detection.
//!
//! Resiliency here covers TRANSIENT BLIPS WHILE RUNNING (wifi roam, sleep/wake,
//! NAT rebind). A deliberate stop is offline, not a blip (§23.0).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use opengeni_agent_platform::Platform;
use opengeni_agent_proto::v1::{
    self, agent_event::Event, AgentEvent, ControlRequest, GoingOffline, GoingOfflineReason,
    Heartbeat, Hello,
};
use prost::Message as _;
use thiserror::Error;
use tokio::sync::Notify;
use tracing::{debug, error, info, warn};

use crate::backoff::Backoff;
use crate::config::StoredCredentials;
use crate::dispatch::{self, DispatchContext};

/// The default heartbeat cadence (§10.6: 5s ping). The control plane may later
/// override it via the [`HelloAck`](v1::HelloAck) (M-later); the connect path
/// holds this cadence today.
const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(5);
/// How long a single dispatched request may run before we log a slow-op warning.
/// (The op itself is bounded by its own `timeout_ms`; this is purely for logs.)
const SLOW_OP_WARN: Duration = Duration::from_secs(30);

/// Errors that abort the supervisor's *current connection* (it then backs off and
/// retries) or, for [`SupervisorError::Fatal`], the whole run.
#[derive(Debug, Error)]
pub enum SupervisorError {
    /// The NATS connection could not be established or was lost. Transient — the
    /// supervisor backs off and reconnects.
    #[error("nats connection error: {0}")]
    Connect(String),
    /// A non-recoverable error (e.g. malformed persisted creds) that should stop
    /// the run rather than spin reconnecting.
    #[error("fatal: {0}")]
    Fatal(String),
}

/// A shared, atomically-updated epoch the dispatcher reads to fence stale ops.
/// The supervisor bumps it whenever the control plane assigns a new epoch (on
/// connect/resume), so an in-flight op resolved against an older generation is
/// rejected with [`ErrorCode::Fenced`](v1::ErrorCode::Fenced).
#[derive(Debug, Default)]
struct EpochCell(AtomicU32);

impl EpochCell {
    fn load(&self) -> u32 {
        self.0.load(Ordering::Acquire)
    }
    fn store(&self, epoch: u32) {
        self.0.store(epoch, Ordering::Release);
    }
}

/// The supervisor owns the platform, the persisted creds, and a shutdown signal.
pub struct Supervisor<P: Platform> {
    platform: Arc<P>,
    creds: StoredCredentials,
    agent_version: String,
    started: Instant,
    epoch: Arc<EpochCell>,
    /// Notified once a clean shutdown (SIGINT/SIGTERM) is requested.
    shutdown: Arc<Notify>,
}

impl<P: Platform + 'static> Supervisor<P> {
    /// Builds a supervisor over a platform + persisted credentials.
    #[must_use]
    pub fn new(
        platform: Arc<P>,
        creds: StoredCredentials,
        agent_version: impl Into<String>,
    ) -> Self {
        Self {
            platform,
            creds,
            agent_version: agent_version.into(),
            started: Instant::now(),
            epoch: Arc::new(EpochCell::default()),
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// A handle that, when triggered, requests a clean shutdown of the run loop.
    /// Wired to SIGINT/SIGTERM by [`crate::run`].
    #[must_use]
    pub fn shutdown_handle(&self) -> Arc<Notify> {
        self.shutdown.clone()
    }

    /// Runs the supervise loop until a clean shutdown is requested. Each iteration
    /// is one connection generation; on any connection error it backs off
    /// (full-jitter) and retries. A clean shutdown breaks the loop after sending
    /// [`GoingOffline`].
    ///
    /// # Errors
    ///
    /// Returns [`SupervisorError::Fatal`] only for non-recoverable conditions;
    /// transient connection errors are handled internally by backing off.
    pub async fn run(&self) -> Result<(), SupervisorError> {
        let mut backoff = Backoff::standard();
        info!(
            agent_id = %self.creds.agent_id,
            subject = %self.creds.rpc_subject(),
            "agent supervisor starting (foreground run model)"
        );

        loop {
            // Race a connection generation against the shutdown signal.
            tokio::select! {
                biased;
                () = self.shutdown.notified() => {
                    info!("clean shutdown requested before/between connections");
                    return Ok(());
                }
                outcome = self.serve_one_connection(&mut backoff) => {
                    match outcome {
                        ConnectionOutcome::CleanShutdown => return Ok(()),
                        ConnectionOutcome::Disconnected(reason) => {
                            let delay = backoff.next_delay();
                            warn!(
                                attempt = backoff.attempt(),
                                delay_ms = millis_u64(delay),
                                reason = %reason,
                                "connection lost; backing off before reconnect"
                            );
                            // Sleep the jittered delay, but wake early on shutdown.
                            tokio::select! {
                                () = self.shutdown.notified() => return Ok(()),
                                () = tokio::time::sleep(delay) => {}
                            }
                        }
                    }
                }
            }
        }
    }

    /// Establishes one connection, sends the hello, then serves RPCs + heartbeats
    /// until the connection drops or shutdown is requested. Resets the backoff on
    /// a successful connect so the NEXT blip starts from the base again.
    async fn serve_one_connection(&self, backoff: &mut Backoff) -> ConnectionOutcome {
        let client = match self.connect().await {
            Ok(client) => client,
            Err(e) => return ConnectionOutcome::Disconnected(e.to_string()),
        };
        info!(agent_id = %self.creds.agent_id, "connected to control plane");

        // Send the connect hello. A failure here is just a disconnect (retry).
        if let Err(e) = self.send_hello(&client).await {
            return ConnectionOutcome::Disconnected(format!("hello failed: {e}"));
        }

        // A successful connect + hello resets the backoff window.
        backoff.reset();

        // Subscribe to the RPC subject — this IS the registry.
        let mut subscription = match client.subscribe(self.creds.rpc_subject()).await {
            Ok(sub) => sub,
            Err(e) => return ConnectionOutcome::Disconnected(format!("subscribe failed: {e}")),
        };
        debug!(subject = %self.creds.rpc_subject(), "subscribed to rpc subject");

        let mut heartbeat = tokio::time::interval(DEFAULT_HEARTBEAT);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut hb_seq: u64 = 0;

        loop {
            tokio::select! {
                biased;
                // Clean shutdown: announce going-offline, then break to the caller.
                () = self.shutdown.notified() => {
                    self.announce_going_offline(&client).await;
                    return ConnectionOutcome::CleanShutdown;
                }
                // An inbound control RPC.
                msg = subscription.next() => {
                    match msg {
                        Some(message) => self.handle_message(&client, message).await,
                        None => {
                            // The subscription stream ended => the connection is gone.
                            return ConnectionOutcome::Disconnected(
                                "rpc subscription ended".to_string(),
                            );
                        }
                    }
                }
                // Heartbeat tick.
                _ = heartbeat.tick() => {
                    hb_seq = hb_seq.wrapping_add(1);
                    if let Err(e) = self.send_heartbeat(&client, hb_seq).await {
                        // A heartbeat publish failure means the connection is down.
                        return ConnectionOutcome::Disconnected(format!("heartbeat failed: {e}"));
                    }
                }
            }
        }
    }

    /// Dials NATS with the workspace-scoped Account credentials. Per §10.6 we run
    /// our OWN supervised reconnect (full-jitter), so we minimize the client's
    /// internal retry and treat a drop as a return to the outer loop where the
    /// backoff lives. NOTE: async-nats treats `max_reconnects(Some(0))` as `None`
    /// (= UNLIMITED internal retry, the opposite of what we want), so we pass
    /// `Some(1)` — the minimal value that still surfaces a sustained outage to our
    /// supervised loop rather than letting the client silently retry forever.
    async fn connect(&self) -> Result<async_nats::Client, SupervisorError> {
        let opts = async_nats::ConnectOptions::with_credentials(&self.creds.nats_credentials)
            .map_err(|e| SupervisorError::Fatal(format!("invalid nats credentials: {e}")))?
            .name(format!("opengeni-agent/{}", self.creds.agent_id))
            // See the note above: Some(1), NOT 0 (which means unlimited).
            .max_reconnects(Some(1))
            .event_callback(|event| async move {
                match event {
                    async_nats::Event::Disconnected => warn!("nats event: disconnected"),
                    async_nats::Event::Connected => info!("nats event: connected"),
                    async_nats::Event::ClientError(e) => warn!(error = %e, "nats client error"),
                    async_nats::Event::ServerError(e) => warn!(error = %e, "nats server error"),
                    other => debug!(?other, "nats event"),
                }
            });

        async_nats::connect_with_options(self.creds.nats_urls.clone(), opts)
            .await
            .map_err(|e| SupervisorError::Connect(e.to_string()))
    }

    /// Publishes the connect [`Hello`] on the events subject and folds the
    /// assigned epoch into the shared cell. The hello carries the resume token so
    /// the control plane recognizes a reconnect and fences by epoch.
    async fn send_hello(
        &self,
        client: &async_nats::Client,
    ) -> Result<(), async_nats::PublishError> {
        let identity = self.platform.host_identity();
        let hello = Hello {
            agent_id: self.creds.agent_id.clone(),
            workspace_id: self.creds.workspace_id.clone(),
            agent_version: self.agent_version.clone(),
            os: identity.os as i32,
            arch: identity.arch as i32,
            machine_name: hostname_or_default(),
            workspace_root: self.platform.workspace_root(),
            capabilities: Some(self.capabilities()),
            update_channel: self.creds.update_channel.clone(),
            resume_token: self.creds.resume_token.clone(),
        };
        // The hello is its own message (not an AgentEvent oneof member): it is
        // published on the dedicated hello subject the control plane listens on,
        // which replies (out of band) with a HelloAck whose epoch we adopt. Until
        // that arrives we hold the last persisted epoch so dispatch can fence.
        self.epoch.store(self.creds.last_known_epoch);
        client
            .publish(self.hello_subject(), hello.encode_to_vec().into())
            .await?;
        client.flush().await.ok();
        debug!(epoch = self.epoch.load(), "sent hello");
        Ok(())
    }

    /// The subject the control plane listens on for an agent's connect hello.
    fn hello_subject(&self) -> String {
        format!(
            "agent.{}.{}.hello",
            self.creds.workspace_id, self.creds.agent_id
        )
    }

    /// The agent's advertised capabilities. Channel-A (exec/fs/git) is always
    /// available on a connected agent. The M8 stream surfaces are now served: `pty`
    /// is true whenever a relay stream registrar is wired (the supervisor always
    /// wires one); `desktop` is true when the host has a probeable display (a real
    /// screen or an Xvfb virtual framebuffer) — otherwise the control plane degrades
    /// the desktop cell to `display_unavailable`. The probed [`Display`] detail
    /// rides along so the UI can size the viewer + show the virtual flag.
    fn capabilities(&self) -> v1::Capabilities {
        let display = self.platform.desktop().probe();
        let has_relay = self.platform.stream_registry().is_some();
        v1::Capabilities {
            exec: true,
            filesystem: true,
            git: true,
            // A PTY can be opened whenever the relay registrar is wired.
            pty: has_relay,
            // A desktop is available when a display probes AND we can stream it.
            desktop: has_relay && display.is_some(),
            consented_whole_machine: self.creds.consented_whole_machine,
            consented_screen_control: self.creds.consented_screen_control,
            display,
        }
    }

    /// Handles one inbound RPC message: dispatch it to the platform and reply on
    /// the message's reply inbox. A request with no reply inbox is logged and
    /// dropped (the control plane always sets one for request/reply).
    async fn handle_message(&self, client: &async_nats::Client, message: async_nats::Message) {
        let Some(reply) = message.reply.clone() else {
            warn!("dropping rpc with no reply inbox");
            return;
        };

        let request = match ControlRequest::decode(message.payload.as_ref()) {
            Ok(req) => req,
            Err(e) => {
                // Reply with a protocol error rather than drop — the caller waits
                // on the reply and would otherwise time out.
                error!(error = %e, "undecodable ControlRequest");
                let resp =
                    dispatch::dispatch_bytes(message.payload.as_ref(), &self.platform, &self.ctx());
                let _ = client.publish(reply, resp.into()).await;
                return;
            }
        };

        let ctx = self.ctx();
        let op_label = op_label(&request);
        let started = Instant::now();
        let response = dispatch::dispatch(request, &self.platform, &ctx).await;
        let elapsed = started.elapsed();
        if elapsed > SLOW_OP_WARN {
            warn!(op = op_label, elapsed_ms = millis_u64(elapsed), "slow rpc");
        } else {
            debug!(
                op = op_label,
                elapsed_ms = millis_u64(elapsed),
                "served rpc"
            );
        }

        if let Err(e) = client.publish(reply, response.encode_to_vec().into()).await {
            warn!(error = %e, "failed to publish rpc reply");
        }
    }

    /// Builds the dispatch context snapshot for a request.
    fn ctx(&self) -> DispatchContext {
        DispatchContext {
            agent_id: self.creds.agent_id.clone(),
            epoch: self.epoch.load(),
            started: self.started,
        }
    }

    /// Publishes a heartbeat AgentEvent carrying a metrics sample (§10.7).
    async fn send_heartbeat(
        &self,
        client: &async_nats::Client,
        seq: u64,
    ) -> Result<(), async_nats::PublishError> {
        // The metrics sample briefly blocks (a /proc/stat CPU delta), so it runs on
        // the blocking pool — it must never stall the async heartbeat/RPC loop. A
        // join failure degrades to a default sample rather than failing the
        // heartbeat (a metrics gap is never fatal, dossier §10.7).
        let metrics = tokio::task::spawn_blocking(crate::metrics::sample)
            .await
            .unwrap_or_default();
        let event = AgentEvent {
            agent_id: self.creds.agent_id.clone(),
            event: Some(Event::Heartbeat(Heartbeat {
                seq,
                uptime_ms: millis_u64(self.started.elapsed()),
                active_sessions: 0,
                metrics: Some(metrics),
                draining: false,
            })),
        };
        client
            .publish(self.creds.events_subject(), event.encode_to_vec().into())
            .await
    }

    /// Publishes a clean [`GoingOffline`] event so the lease flips offline
    /// immediately (§23.0), then flushes so the message leaves before we close.
    async fn announce_going_offline(&self, client: &async_nats::Client) {
        let event = AgentEvent {
            agent_id: self.creds.agent_id.clone(),
            event: Some(Event::GoingOffline(GoingOffline {
                reason: GoingOfflineReason::UserStop as i32,
                message: "agent stopped (foreground run ended)".to_string(),
            })),
        };
        if let Err(e) = client
            .publish(self.creds.events_subject(), event.encode_to_vec().into())
            .await
        {
            warn!(error = %e, "failed to publish going-offline");
        }
        // Best-effort flush so the offline signal is on the wire before we drop.
        let _ = client.flush().await;
        info!("announced going-offline; closing cleanly");
    }
}

/// The outcome of one connection generation.
enum ConnectionOutcome {
    /// The connection dropped (transient); the supervisor backs off + reconnects.
    Disconnected(String),
    /// A clean shutdown was requested; the run loop should exit.
    CleanShutdown,
}

/// A short label for the op in a `ControlRequest`, for structured logs. Never
/// logs payload contents (no secret leakage, §10.6).
fn op_label(req: &ControlRequest) -> &'static str {
    use v1::control_request::Op;
    match &req.op {
        Some(Op::Ping(_)) => "ping",
        Some(Op::Hello(_)) => "hello",
        Some(Op::Resume(_)) => "resume",
        Some(Op::Exec(_)) => "exec",
        Some(Op::FsRead(_)) => "fs_read",
        Some(Op::FsWrite(_)) => "fs_write",
        Some(Op::FsList(_)) => "fs_list",
        Some(Op::FsMkdir(_)) => "fs_mkdir",
        Some(Op::FsMove(_)) => "fs_move",
        Some(Op::FsStat(_)) => "fs_stat",
        Some(Op::FsRemove(_)) => "fs_remove",
        Some(Op::Git(_)) => "git",
        Some(Op::PtyOpen(_)) => "pty_open",
        Some(Op::PtyWrite(_)) => "pty_write",
        Some(Op::PtyResize(_)) => "pty_resize",
        Some(Op::PtyClose(_)) => "pty_close",
        Some(Op::DesktopEnsure(_)) => "desktop_ensure",
        Some(Op::Metrics(_)) => "metrics",
        Some(Op::UpdateMayProceed(_)) => "update_may_proceed",
        None => "none",
    }
}

/// Milliseconds in a [`Duration`], saturated into a `u64` for the wire/log
/// fields (an absurdly long span can never overflow or panic).
fn millis_u64(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// The host name, falling back to `"unknown"` if it cannot be read. Shared with
/// the enrollment path (the machine-name default) via `pub(crate)`.
pub(crate) fn hostname_or_default() -> String {
    hostname::get().map_or_else(
        |_| "unknown".to_string(),
        |h| h.to_string_lossy().into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_cell_round_trips() {
        let cell = EpochCell::default();
        assert_eq!(cell.load(), 0);
        cell.store(42);
        assert_eq!(cell.load(), 42);
    }

    #[test]
    fn op_label_covers_every_oneof_variant() {
        use v1::control_request::Op;
        let cases = [
            Op::Ping(v1::PingRequest::default()),
            Op::Exec(v1::ExecRequest::default()),
            Op::FsRead(v1::FsReadRequest::default()),
            Op::Git(v1::GitRequest::default()),
            Op::Metrics(v1::MetricsRequest::default()),
        ];
        for op in cases {
            let req = ControlRequest {
                request_id: "r".to_string(),
                epoch: 0,
                op: Some(op),
            };
            assert_ne!(op_label(&req), "none");
        }
        let empty = ControlRequest::default();
        assert_eq!(op_label(&empty), "none");
    }
}
