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
//! 4. On **any disconnect**, sleeps a full-jitter [`Backoff::standard`] delay (a
//!    ~30s FAST phase of ≤3s retries so a rolling-deploy blip recovers in
//!    seconds, then exponential up to a 10s cap for a prolonged outage) before
//!    reconnecting — NEVER a tight loop (the #1 outage cause). A reconnect
//!    re-subscribes the RPC subject (a fresh subscription), which — together with
//!    the ~5s heartbeat on this same connection — is what restores the machine's
//!    `last_seen`/ping liveness the attach gate reads.
//! 5. On a **clean stop** (SIGINT/SIGTERM) sends a [`GoingOffline`] event and
//!    closes cleanly so the lease flips offline IMMEDIATELY (§23.0), rather than
//!    waiting on heartbeat dead-detection.
//!
//! Resiliency here covers TRANSIENT BLIPS WHILE RUNNING (wifi roam, sleep/wake,
//! NAT rebind). A deliberate stop is offline, not a blip (§23.0).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use opengeni_agent_engine::admission::JobClass;
use opengeni_agent_engine::OpId;
use opengeni_agent_platform::Platform;
use opengeni_agent_proto::v1::{
    self, agent_event::Event, AgentEvent, ControlRequest, GoingOffline, GoingOfflineReason,
    Heartbeat, Hello,
};
use prost::Message as _;
use thiserror::Error;
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tracing::{debug, error, info, warn};

use crate::backoff::Backoff;
use crate::config::StoredCredentials;
use crate::dispatch::{self, DispatchContext};
use crate::engine::Engine;

/// The default heartbeat cadence (§10.6: 5s ping — a pacing constant, rule P).
/// The control plane may later override it via the [`HelloAck`](v1::HelloAck)
/// (M-later); the connect path holds this cadence today.
const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(5);
/// Engine housekeeping cadence (registry GC + queue-wait expiry) — pacing.
const HOUSEKEEPING_TICK: Duration = Duration::from_secs(30);
/// Host-capacity resample cadence (budgets track the host over time) — pacing.
const CAPACITY_RESAMPLE: Duration = Duration::from_secs(60);
/// Op frames queued toward the bulk publisher. A pipe diameter for the
/// fire-and-forget lane: a full channel DROPS the frame (allowed — op frames
/// are healed by gap-detection + OpAttach replay), it never blocks a pump.
const BULK_CHANNEL_DEPTH: usize = 1024;

/// The current generation's bulk frame channel: (subject, encoded OpFrame)
/// pairs toward the bulk publisher task. `None` between generations.
type BulkLane = Arc<std::sync::RwLock<Option<tokio::sync::mpsc::Sender<(String, Vec<u8>)>>>>;

/// Errors that abort the supervisor's *current connection* (it then backs off and
/// retries). Both variants are transient — a deliberate stop is a clean shutdown,
/// not an error (dossier §23.0).
#[derive(Debug, Error)]
pub enum SupervisorError {
    /// The NATS connection could not be established or was lost. Transient — the
    /// supervisor backs off and reconnects.
    #[error("nats connection error: {0}")]
    Connect(String),
    /// The control plane REJECTED the enrollment bearer at connect (the auth-callout
    /// responder denied it: a revoked/expired enrollment, or an unconfigured
    /// credential plane). A CLEAR, typed authentication failure — NOT a panic. It is
    /// still treated as a (slow) retry by the supervise loop because a re-enroll can
    /// rotate the bearer in place (dossier M-AUTH: "a rotated bearer on re-enroll
    /// works"); the agent loudly logs the auth denial each attempt so the operator
    /// knows to re-enroll rather than wait on a transient blip.
    #[error("control plane rejected the enrollment bearer (re-enroll may be required): {0}")]
    Authentication(String),
}

/// Heuristically classify a NATS connect error as an AUTHENTICATION denial (the
/// callout rejected the bearer) vs a generic transport disconnect. async-nats
/// surfaces an auth failure as an error whose message names "authorization"
/// /"authentication"; we match on that so the agent can log the auth denial clearly
/// instead of treating a deny as an indistinguishable blip.
fn is_authentication_error(err: &async_nats::ConnectError) -> bool {
    message_is_authentication_denial(&err.to_string())
}

/// The string predicate behind [`is_authentication_error`], split out so it is
/// unit-testable without constructing an `async_nats::ConnectError`.
fn message_is_authentication_denial(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("authorization")
        || lower.contains("authentication")
        || lower.contains("auth violation")
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

/// A LEVEL-triggered clean-shutdown signal shared between the signal handler and
/// the supervise loop.
///
/// A bare [`Notify`] is edge-triggered: `notify_waiters()` wakes only the waiters
/// registered *at that instant* and stores no permit, so a stop signal that lands
/// while the loop is between `.notified()` registrations — mid-connect, mid-hello,
/// or in the sync gap before a select re-arms — is lost, and the agent never stops
/// (or, worse, the loser of a race exits WITHOUT announcing going-offline). This
/// pairs the notify with a latched flag: callers `await` [`notified`](Self::notified)
/// to wake promptly AND check [`is_requested`](Self::is_requested) at each decision
/// point, so a request is never missed and the clean-shutdown path (which publishes
/// [`GoingOffline`]) is always reached while a client is live (§23.0).
#[derive(Clone, Default)]
pub struct ShutdownSignal {
    requested: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl ShutdownSignal {
    /// Requests a clean shutdown: latch the flag FIRST (so any subsequent
    /// [`is_requested`](Self::is_requested) sees it), then wake current waiters.
    pub fn request(&self) {
        self.requested.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    /// Whether a clean shutdown has been requested (level-triggered — true forever
    /// once requested, regardless of waiter timing).
    #[must_use]
    pub fn is_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }

    /// Resolves when a shutdown is requested via a waiter wake. Because
    /// `notify_waiters` does not latch a permit, ALWAYS pair this with an
    /// [`is_requested`](Self::is_requested) check at the enclosing loop top so a
    /// request that fired before this future registered is still observed.
    pub async fn notified(&self) {
        self.notify.notified().await;
    }
}

/// One workspace enrollment served by the supervisor: its credentials and the
/// per-link epoch fence. v1 constructs exactly one link from the single
/// credentials file; the structure (a `Vec`, per-link subjects/epochs) is
/// multi-enrollment-ready (task #9). Links SHARE the one [`Engine`].
struct WorkspaceLink {
    creds: StoredCredentials,
    epoch: Arc<EpochCell>,
    /// The CURRENT generation's bulk frame channel (op-frame publishes ride a
    /// second NATS connection so saturated op flow cannot head-of-line-block
    /// control liveness — invariant #4). Job emit hooks read this per frame;
    /// `None` between generations (frames drop; replay heals — fire-and-forget
    /// by protocol design).
    bulk_tx: BulkLane,
}

/// The supervisor owns the platform, the shared op engine, the workspace
/// links, and a shutdown signal.
pub struct Supervisor<P: Platform> {
    platform: Arc<P>,
    engine: Arc<Engine>,
    links: Vec<WorkspaceLink>,
    agent_version: String,
    started: Instant,
    /// Latched once a clean shutdown (SIGINT/SIGTERM) is requested.
    shutdown: ShutdownSignal,
}

impl<P: Platform + 'static> Supervisor<P> {
    /// Builds a supervisor over a platform + persisted credentials. The op
    /// engine's budgets and breakers are derived from a live host-capacity
    /// sample (LIMITS-DOCTRINE) against the default spool root; callers that
    /// know a better disk (the config dir) override it via
    /// [`with_spool_root`](Self::with_spool_root) BEFORE running.
    #[must_use]
    pub fn new(
        platform: Arc<P>,
        creds: StoredCredentials,
        agent_version: impl Into<String>,
    ) -> Self {
        let spool_root = std::env::temp_dir().join(format!("opengeni-runner-{}", creds.agent_id));
        let capacity = crate::capacity::sample(&spool_root);
        let engine = Engine::new(spool_root, capacity);
        Self {
            platform,
            engine,
            links: vec![WorkspaceLink {
                creds,
                epoch: Arc::new(EpochCell::default()),
                bulk_tx: Arc::new(std::sync::RwLock::new(None)),
            }],
            agent_version: agent_version.into(),
            started: Instant::now(),
            shutdown: ShutdownSignal::default(),
        }
    }

    /// Rebuilds the engine against an explicit spool root (the config dir's
    /// filesystem — a real disk, unlike a tmpfs temp dir). Call before
    /// [`run`](Self::run); jobs never span the swap.
    #[must_use]
    pub fn with_spool_root(mut self, spool_root: std::path::PathBuf) -> Self {
        let capacity = crate::capacity::sample(&spool_root);
        self.engine = Engine::new(spool_root, capacity);
        self
    }

    /// A handle that, when [`request`](ShutdownSignal::request)ed, drives a clean
    /// shutdown of the run loop. Wired to SIGINT/SIGTERM by [`crate::run`].
    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownSignal {
        self.shutdown.clone()
    }

    /// Runs the supervise loop until a clean shutdown is requested. Each iteration
    /// is one connection generation; on any connection error it backs off
    /// (full-jitter) and retries. A clean shutdown breaks the loop after sending
    /// [`GoingOffline`].
    ///
    /// # Errors
    ///
    /// Never returns an error in practice: every connection failure (transport drop
    /// or an auth denial) is handled internally by backing off + retrying, and a
    /// clean shutdown returns `Ok(())`. The `Result` is kept so a future
    /// non-recoverable condition can surface without a signature change.
    pub async fn run(&self) -> Result<(), SupervisorError> {
        // Engine housekeeping rides its own task for the run's lifetime:
        // registry GC + queue-wait expiry every tick, a fresh host-capacity
        // sample (budgets track the host) on the slower cadence.
        let housekeeping = tokio::spawn(housekeeping_loop(self.engine.clone()));
        // v1: exactly one link; the loop shape is multi-enrollment-ready.
        let serves = self.links.iter().map(|link| self.run_link(link));
        futures::future::join_all(serves).await;
        housekeeping.abort();
        Ok(())
    }

    /// Runs one workspace link's dial → serve → reconnect loop until a clean
    /// shutdown is requested.
    async fn run_link(&self, link: &WorkspaceLink) {
        let mut backoff = Backoff::standard();
        info!(
            agent_id = %link.creds.agent_id,
            subject = %link.creds.rpc_subject(),
            "agent supervisor starting (foreground run model)"
        );

        loop {
            // A shutdown requested before a connection or between connections (e.g.
            // during the previous backoff sleep) has no live client to announce on,
            // so exit promptly. This is checked at the loop top — NOT raced against
            // `serve_one_connection` — because a `notified()` branch here would win
            // the biased select and return BEFORE `serve_connection_generation`
            // could publish going-offline, which is exactly the bug this fixes. The
            // shutdown is now owned by whichever phase holds the live client.
            if self.shutdown.is_requested() {
                info!("clean shutdown requested before/between connections");
                return;
            }

            match self.serve_one_connection(link, &mut backoff).await {
                ConnectionOutcome::CleanShutdown => return,
                ConnectionOutcome::Disconnected(reason) => {
                    let delay = backoff.next_delay();
                    warn!(
                        attempt = backoff.attempt(),
                        delay_ms = millis_u64(delay),
                        reason = %reason,
                        "connection lost; backing off before reconnect"
                    );
                    // Sleep the jittered delay, but wake early on shutdown. There is
                    // no live client during the sleep, so waking straight to the
                    // return (no announce) is correct; the loop-top check re-confirms.
                    tokio::select! {
                        biased;
                        () = self.shutdown.notified() => return,
                        () = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    /// Establishes one connection, sends the hello, then serves RPCs + heartbeats
    /// until the connection drops or shutdown is requested. Resets the backoff on
    /// a successful connect so the NEXT blip starts from the base again.
    async fn serve_one_connection(
        &self,
        link: &WorkspaceLink,
        backoff: &mut Backoff,
    ) -> ConnectionOutcome {
        // The dial has no client yet, so a shutdown here just exits (nothing to
        // announce) — but race it so a hung/slow dial cannot delay a clean stop.
        let connect = tokio::select! {
            biased;
            () = self.shutdown.notified() => return ConnectionOutcome::CleanShutdown,
            result = self.connect(link) => result,
        };
        let client = match connect {
            Ok(client) => client,
            Err(e @ SupervisorError::Authentication(_)) => {
                // A CLEAR auth denial (not a panic): log it loudly so the operator
                // knows a re-enroll may be needed, then treat it as a (slow) retry —
                // a re-enroll can rotate the bearer in place and the next attempt
                // re-presents it (dossier M-AUTH).
                error!(error = %e, "control plane rejected the enrollment bearer; will keep retrying — re-enroll if this persists");
                return ConnectionOutcome::Disconnected(e.to_string());
            }
            Err(e) => return ConnectionOutcome::Disconnected(e.to_string()),
        };
        info!(agent_id = %link.creds.agent_id, "connected to control plane");

        // T-derived sizing: the negotiated max_payload drives the engine's
        // per-frame data size (LIMITS-DOCTRINE rule T — query, never assume).
        self.engine
            .set_negotiated_max_payload(client.server_info().max_payload);

        // A shutdown latched during the dial select — before any hello established a
        // lease — has nothing meaningful to announce; close cleanly without a hello.
        if self.shutdown.is_requested() {
            return ConnectionOutcome::CleanShutdown;
        }

        // Send the connect hello. A failure here is just a disconnect (retry).
        if let Err(e) = self.send_hello(link, &client).await {
            return ConnectionOutcome::Disconnected(format!("hello failed: {e}"));
        }

        // A successful connect + hello resets the backoff window.
        backoff.reset();

        // Subscribe to the RPC subject — this IS the registry.
        let subscription = match client.subscribe(link.creds.rpc_subject()).await {
            Ok(sub) => sub,
            Err(e) => return ConnectionOutcome::Disconnected(format!("subscribe failed: {e}")),
        };
        debug!(subject = %link.creds.rpc_subject(), "subscribed to rpc subject");

        // The ack subject rides the SAME control connection (PROTOCOL.md
        // §Subjects: subscribed alongside rpc at establishment).
        let ack_subscription = match client.subscribe(link.creds.ack_subject()).await {
            Ok(sub) => sub,
            Err(e) => return ConnectionOutcome::Disconnected(format!("ack subscribe failed: {e}")),
        };

        // The BULK connection: op frames publish here so a saturated stream
        // can never head-of-line-block control liveness (invariant #4). Its
        // loss is a generation loss (conservative: detach + reconnect).
        let bulk_client = match self.connect(link).await {
            Ok(client) => client,
            Err(e) => return ConnectionOutcome::Disconnected(format!("bulk dial failed: {e}")),
        };
        let (bulk_tx, mut bulk_rx) =
            tokio::sync::mpsc::channel::<(String, Vec<u8>)>(BULK_CHANNEL_DEPTH);
        let publisher = tokio::spawn(async move {
            while let Some((subject, bytes)) = bulk_rx.recv().await {
                if let Err(error) = bulk_client.publish(subject, bytes.into()).await {
                    // Fire-and-forget: a lost frame is healed by gap-detect +
                    // OpAttach replay; never a reason to fail the op.
                    warn!(%error, "op frame publish failed (replay heals)");
                }
            }
        });
        *link.bulk_tx.write().expect("bulk lock") = Some(bulk_tx);

        let outcome = self
            .serve_connection_generation(link, &client, subscription, ack_subscription)
            .await;

        // Tear the bulk lane down with the generation: hooks see None and
        // drop frames until the next generation re-attaches consumers.
        *link.bulk_tx.write().expect("bulk lock") = None;
        publisher.abort();
        outcome
    }

    /// Serves one subscribed NATS generation until shutdown or disconnect. Host
    /// work lives in `rpc_tasks`; this loop owns only control liveness and
    /// dispatch, so platform latency cannot delay a heartbeat.
    async fn serve_connection_generation(
        &self,
        link: &WorkspaceLink,
        client: &async_nats::Client,
        mut subscription: async_nats::Subscriber,
        mut ack_subscription: async_nats::Subscriber,
    ) -> ConnectionOutcome {
        let mut heartbeat = tokio::time::interval(DEFAULT_HEARTBEAT);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut hb_seq: u64 = 0;
        let mut rpc_tasks = JoinSet::new();

        let outcome = loop {
            // Level-triggered catch: a shutdown latched between selects — during the
            // hello/subscribe just completed, or while a heartbeat/admission awaited
            // — would be missed by the edge-triggered `notified()` branch below (its
            // wake fired with no waiter registered). Checking the flag at the loop
            // top guarantees this live generation still reaches the announce path.
            if self.shutdown.is_requested() {
                break ConnectionOutcome::CleanShutdown;
            }
            tokio::select! {
                biased;
                // Stop accepting work immediately. Accepted work is cancelled below
                // before we announce going-offline and return.
                () = self.shutdown.notified() => {
                    break ConnectionOutcome::CleanShutdown;
                }
                // Heartbeat is deliberately ahead of inbound work in this biased
                // select. A ready subscription can never starve the liveness tick.
                _ = heartbeat.tick() => {
                    hb_seq = hb_seq.wrapping_add(1);
                    if let Err(e) = self.send_heartbeat(link, client, hb_seq).await {
                        break ConnectionOutcome::Disconnected(format!("heartbeat failed: {e}"));
                    }
                }
                // Reap completed host work so panics are visible and the JoinSet
                // does not grow for the lifetime of the connection.
                joined = rpc_tasks.join_next(), if !rpc_tasks.is_empty() => {
                    if let Some(Err(join_error)) = joined {
                        warn!(error = %join_error, "control rpc task failed");
                    }
                }
                // Ack/credit frames: pure routing into the op pumps (the pump
                // owns generation fencing and final-ack acceptance) — cheap,
                // served inline.
                ack = ack_subscription.next() => match ack {
                    Some(message) => {
                        match v1::OpAck::decode(message.payload.as_ref()) {
                            Ok(ack) => crate::ops::handle_op_ack(&self.engine, &ack),
                            Err(error) => warn!(%error, "undecodable OpAck dropped"),
                        }
                    }
                    None => {
                        break ConnectionOutcome::Disconnected(
                            "ack subscription ended".to_string(),
                        );
                    }
                },
                // Decode + route inbound control work. Only `ping` executes
                // inline; everything else runs on its own task through engine
                // admission (fair ordering + derived breakers — never a cap).
                msg = subscription.next() => match msg {
                    Some(message) => self.route_message(link, client, message, &mut rpc_tasks).await,
                    None => {
                        break ConnectionOutcome::Disconnected(
                            "rpc subscription ended".to_string(),
                        );
                    }
                }
            }
        };

        // A request/reply inbox belongs to this connection generation. Once the
        // generation ends, accepted work cannot produce a useful reply and must
        // not survive invisibly into the next generation. Aborting the JoinSet
        // drops the legacy adapters; each orphaned job pump then cancels its
        // child (mailbox-drop = cancel), releasing admission slots typed.
        let snapshot = self.engine.admission_snapshot();
        if snapshot.heavy_running + snapshot.light_running > 0 {
            let reason = match &outcome {
                ConnectionOutcome::CleanShutdown => "shutdown",
                ConnectionOutcome::Disconnected(_) => "disconnect",
            };
            warn!(
                reason = reason,
                heavy_running = snapshot.heavy_running,
                light_running = snapshot.light_running,
                "cancelling accepted control rpc work at connection-generation end"
            );
        }
        rpc_tasks.shutdown().await;

        // The transport is gone: every live op detaches and keeps running
        // (op ⊥ connection — the server re-attaches per op after reconnect).
        self.engine.detach_all();

        if matches!(&outcome, ConnectionOutcome::CleanShutdown) {
            self.announce_going_offline(link, client).await;
        }
        outcome
    }

    /// Decodes one request and routes it: `ping` is answered inline (liveness
    /// never enters admission), `exec` runs as an engine job through the
    /// legacy adapter, and every other op runs on its own task behind an
    /// engine admission ticket (fair ordering + derived breakers; the runner
    /// holds no concurrency policy — LIMITS-DOCTRINE).
    async fn route_message(
        &self,
        link: &WorkspaceLink,
        client: &async_nats::Client,
        message: async_nats::Message,
        rpc_tasks: &mut JoinSet<()>,
    ) {
        let Some(reply) = message.reply.clone() else {
            warn!("dropping rpc with no reply inbox");
            return;
        };
        let max_payload = client.server_info().max_payload;
        let request = match ControlRequest::decode(message.payload.as_ref()) {
            Ok(request) => request,
            Err(decode_error) => {
                error!(error = %decode_error, "undecodable ControlRequest");
                let payload = dispatch::dispatch_bytes(
                    message.payload.as_ref(),
                    &self.platform,
                    &self.ctx(link, max_payload),
                );
                if let Err(publish_error) = client.publish(reply, payload.into()).await {
                    warn!(error = %publish_error, "failed to publish protocol error reply");
                }
                return;
            }
        };
        let request_id = request.request_id.clone();
        let label = op_label(&request);
        match classify(&request) {
            Route::Liveness => {
                debug!(request_id = %request_id, op = label, "serving liveness rpc outside admission");
                serve_request(
                    client,
                    reply,
                    request,
                    &self.platform,
                    &self.ctx(link, max_payload),
                    max_payload,
                )
                .await;
            }
            Route::OpStart(start) => {
                self.spawn_op_start(link, client, &request, start, reply, label, rpc_tasks);
            }
            Route::OpControl => {
                use v1::control_request::Op;
                let response = match &request.op {
                    Some(Op::OpCancel(cancel)) => {
                        crate::ops::serve_op_cancel(&self.engine, request_id, cancel)
                    }
                    Some(Op::OpQuery(query)) => {
                        crate::ops::serve_op_query(&self.engine, request_id, query)
                    }
                    Some(Op::OpAttach(attach)) => {
                        crate::ops::serve_op_attach(&self.engine, request_id, attach)
                    }
                    _ => unreachable!("classified OpControl"),
                };
                publish_response(client, reply, response, label, max_payload).await;
            }
            Route::LegacyExec(exec) => {
                self.spawn_adapter(
                    link,
                    client,
                    &request,
                    AdapterWork::Exec(exec),
                    reply,
                    label,
                    rpc_tasks,
                );
            }
            Route::LegacyGit(git) => {
                self.spawn_adapter(
                    link,
                    client,
                    &request,
                    AdapterWork::Git(git),
                    reply,
                    label,
                    rpc_tasks,
                );
            }
            Route::Work(class) => {
                let client = client.clone();
                let platform = self.platform.clone();
                let engine = self.engine.clone();
                let ctx = self.ctx(link, max_payload);
                rpc_tasks.spawn(async move {
                    let op = OpId::new(request_id.clone());
                    let ticket = match engine.admit(&op, class, crate::engine::LEGACY_ORIGIN).await
                    {
                        Ok(ticket) => ticket,
                        Err(reason) => {
                            let response = dispatch::breaker_reply_error(request_id, label, reason);
                            publish_response(&client, reply, response, label, max_payload).await;
                            return;
                        }
                    };
                    serve_request(&client, reply, request, &platform, &ctx, max_payload).await;
                    drop(ticket);
                });
            }
        }
    }

    /// Spawns a legacy-adapter op (exec/git as an engine job) onto its own
    /// task. The adapter path fences epochs BEFORE the engine, exactly like
    /// the dispatch table does for every other op.
    #[allow(clippy::too_many_arguments)] // a routing seam; bundling would just rename the parts
    fn spawn_adapter(
        &self,
        link: &WorkspaceLink,
        client: &async_nats::Client,
        request: &ControlRequest,
        work: AdapterWork,
        reply: async_nats::Subject,
        label: &'static str,
        rpc_tasks: &mut JoinSet<()>,
    ) {
        let max_payload = client.server_info().max_payload;
        let client = client.clone();
        let platform = self.platform.clone();
        let engine = self.engine.clone();
        let (request_epoch, held_epoch) = (request.epoch, self.ctx(link, max_payload).epoch);
        let request_id = request.request_id.clone();
        rpc_tasks.spawn(async move {
            let response = if request_epoch != 0 && request_epoch < held_epoch {
                dispatch::fenced_reply(request_id, request_epoch, held_epoch)
            } else {
                match work {
                    AdapterWork::Exec(exec) => {
                        crate::legacy::serve_exec(&engine, &platform, request_id, exec).await
                    }
                    AdapterWork::Git(git) => {
                        crate::legacy::serve_git(&engine, &platform, request_id, git).await
                    }
                }
            };
            publish_response(&client, reply, response, label, max_payload).await;
        });
    }

    /// Spawns an `OpStart` onto its own task (admission may park) with the
    /// frame sink bound to the op's subject on the link's CURRENT bulk lane
    /// (`None` between generations — frames drop and OpAttach replay heals;
    /// fire-and-forget by protocol design).
    #[allow(clippy::too_many_arguments)] // a routing seam; bundling would just rename the parts
    fn spawn_op_start(
        &self,
        link: &WorkspaceLink,
        client: &async_nats::Client,
        request: &ControlRequest,
        start: v1::OpStart,
        reply: async_nats::Subject,
        label: &'static str,
        rpc_tasks: &mut JoinSet<()>,
    ) {
        let max_payload = client.server_info().max_payload;
        let client = client.clone();
        let engine = self.engine.clone();
        let platform = self.platform.clone();
        let ctx = self.ctx(link, max_payload);
        let request_id = request.request_id.clone();
        let (request_epoch, held_epoch) = (request.epoch, ctx.epoch);
        let subject = link.creds.op_subject(&request_id);
        let bulk = link.bulk_tx.clone();
        let sink: crate::ops::FrameSink = Arc::new(move |bytes: Vec<u8>| {
            if let Some(tx) = bulk.read().expect("bulk lock").as_ref() {
                if tx.try_send((subject.clone(), bytes)).is_err() {
                    debug!("bulk lane full/closed; op frame dropped (replay heals)");
                }
            }
        });
        rpc_tasks.spawn(async move {
            let response = if request_epoch != 0 && request_epoch < held_epoch {
                dispatch::fenced_reply(request_id, request_epoch, held_epoch)
            } else {
                crate::ops::serve_op_start(&engine, &platform, sink, request_id, start).await
            };
            publish_response(&client, reply, response, label, max_payload).await;
        });
    }

    /// Dials NATS presenting the enrollment BEARER as the connect auth-token (the
    /// AUTH-CALLOUT model, dossier §10.1 / M-AUTH): the server delegates to the
    /// control-plane callout responder, which validates the bearer and returns a
    /// workspace-scoped user JWT — so this connection can pub/sub ONLY
    /// `agent.<ws>.>` (+ `_INBOX.>`). The URL(s) are `wss://` (the relay-symmetric
    /// TLS ingress); async-nats's default features include the websocket transport,
    /// so a `wss://` server URL rides the same TLS endpoint as the relay with no
    /// separate TCP load balancer.
    ///
    /// Per §10.6 we run our OWN supervised reconnect (full-jitter), so we minimize
    /// the client's internal retry and treat a drop as a return to the outer loop
    /// where the backoff lives. NOTE: async-nats treats `max_reconnects(Some(0))` as
    /// `None` (= UNLIMITED internal retry, the opposite of what we want), so we pass
    /// `Some(1)` — the minimal value that still surfaces a sustained outage to our
    /// supervised loop rather than letting the client silently retry forever.
    ///
    /// A rejected bearer (revoked/expired enrollment, or a callout denial) surfaces
    /// as a connect error → [`SupervisorError::Connect`], which the supervise loop
    /// treats as a transient disconnect and backs off + retries with the SAME
    /// (possibly rotated, on re-enroll) bearer — never a panic.
    async fn connect(&self, link: &WorkspaceLink) -> Result<async_nats::Client, SupervisorError> {
        if link.creds.nats_bearer.is_empty() {
            // No bearer means the control plane never minted one (an enrollment from
            // before the credential plane was configured). Surface a clear, typed
            // disconnect rather than dial with an empty token the callout will deny.
            return Err(SupervisorError::Connect(
                "no enrollment bearer; re-enroll to obtain a control-plane credential".to_string(),
            ));
        }
        let opts = async_nats::ConnectOptions::new()
            .token(link.creds.nats_bearer.clone())
            .name(format!("opengeni-agent/{}", link.creds.agent_id))
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

        async_nats::connect_with_options(link.creds.nats_urls.clone(), opts)
            .await
            .map_err(|e| {
                if is_authentication_error(&e) {
                    SupervisorError::Authentication(e.to_string())
                } else {
                    SupervisorError::Connect(e.to_string())
                }
            })
    }

    /// Publishes the connect [`Hello`] on the events subject and folds the
    /// assigned epoch into the shared cell. The hello carries the resume token so
    /// the control plane recognizes a reconnect and fences by epoch.
    async fn send_hello(
        &self,
        link: &WorkspaceLink,
        client: &async_nats::Client,
    ) -> Result<(), async_nats::PublishError> {
        let identity = self.platform.host_identity();
        let hello = Hello {
            agent_id: link.creds.agent_id.clone(),
            workspace_id: link.creds.workspace_id.clone(),
            agent_version: self.agent_version.clone(),
            os: identity.os as i32,
            arch: identity.arch as i32,
            machine_name: hostname_or_default(),
            workspace_root: self.platform.workspace_root(),
            capabilities: Some(self.capabilities(link).await),
            update_channel: link.creds.update_channel.clone(),
            resume_token: link.creds.resume_token.clone(),
        };
        // The hello is its own message (not an AgentEvent oneof member): it is
        // published on the dedicated hello subject the control plane listens on,
        // which replies (out of band) with a HelloAck whose epoch we adopt. Until
        // that arrives we hold the last persisted epoch so dispatch can fence.
        link.epoch.store(link.creds.last_known_epoch);
        client
            .publish(hello_subject(link), hello.encode_to_vec().into())
            .await?;
        client.flush().await.ok();
        debug!(epoch = link.epoch.load(), "sent hello");
        Ok(())
    }

    /// The agent's advertised capabilities. Channel-A (exec/fs/git) is always
    /// available on a connected agent. The M8 stream surfaces are now served: `pty`
    /// is true whenever a relay stream registrar is wired (the supervisor always
    /// wires one); `desktop` is true when the host has a probeable display (a real
    /// screen or an Xvfb virtual framebuffer) — otherwise the control plane degrades
    /// the desktop cell to `display_unavailable`. The probed [`Display`] detail
    /// rides along so the UI can size the viewer + show the virtual flag.
    async fn capabilities(&self, link: &WorkspaceLink) -> v1::Capabilities {
        // `probe()` does a synchronous x11rb connect; run it on the blocking pool so
        // a wedged X server cannot stall this async connect task (mirrors
        // `Platform::desktop_ensure`).
        let desktop = self.platform.desktop();
        // Probe the display AND the CAPTURE PREFLIGHT together on the blocking pool
        // (both are synchronous OS calls): a display can physically exist while the OS
        // withholds the screen-capture grant (macOS Screen Recording / TCC), in which
        // case capture would yield nothing and the model would see a blank.
        let (display, capture_blocked) = tokio::task::spawn_blocking(move || {
            (desktop.probe(), desktop.capture_blocked_reason())
        })
        .await
        .unwrap_or((None, None));
        let has_relay = self.platform.stream_registry().is_some();
        // A desktop is available only when a display probes, we can stream it, AND the
        // OS actually permits capture. Advertising `desktop: true` on a machine that
        // cannot capture is exactly how the 0.1.3 incident hid — the capability was
        // claimed, the capture then failed, and the model saw a blank. When capture is
        // blocked we report `desktop: false` and carry the actionable reason so the
        // control plane degrades the cell with a legible hint.
        let can_capture = display.is_some() && capture_blocked.is_none();
        v1::Capabilities {
            exec: true,
            filesystem: true,
            git: true,
            // A PTY can be opened whenever the relay registrar is wired.
            pty: has_relay,
            desktop: has_relay && can_capture,
            consented_whole_machine: link.creds.consented_whole_machine,
            consented_screen_control: link.creds.consented_screen_control,
            display,
            desktop_unavailable_reason: capture_blocked.unwrap_or_default(),
            // The op engine is wired: OpStart/OpCancel/OpQuery/OpAttach are
            // served, frames publish on the bulk lane, acks route to pumps.
            // The server uses this path iff its own feature flag is also on
            // (PROTOCOL.md §Compatibility — no flag day, rollback safe).
            op_stream: true,
        }
    }

    /// Builds the dispatch context snapshot for a request. `max_reply_bytes` is the
    /// connection's NEGOTIATED max payload (from `server_info()`), threaded so an op
    /// that produces a large reply (the screenshot) can fit it under the budget
    /// agent-side rather than emit an un-publishable reply the caller waits out.
    fn ctx(&self, link: &WorkspaceLink, max_reply_bytes: usize) -> DispatchContext {
        DispatchContext {
            agent_id: link.creds.agent_id.clone(),
            epoch: link.epoch.load(),
            started: self.started,
            // The computer-use input consent gate reads the SAME enrollment grant
            // the relay pump's `allow_input` uses.
            consented_screen_control: link.creds.consented_screen_control,
            max_reply_bytes,
        }
    }

    /// Publishes a heartbeat AgentEvent carrying a metrics sample (§10.7).
    async fn send_heartbeat(
        &self,
        link: &WorkspaceLink,
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
        // The upward capacity report (LIMITS-DOCTRINE: the runner holds no
        // concurrency policy — the server paces against these figures).
        let capacity = self.engine.capacity();
        let admission = self.engine.admission_snapshot();
        let event = AgentEvent {
            agent_id: link.creds.agent_id.clone(),
            event: Some(Event::Heartbeat(Heartbeat {
                seq,
                uptime_ms: millis_u64(self.started.elapsed()),
                active_sessions: 0,
                metrics: Some(metrics),
                draining: false,
                capacity: Some(v1::HostCapacitySample {
                    mem_available_bytes: capacity.mem_available_bytes,
                    disk_free_bytes: capacity.disk_free_bytes,
                    fd_headroom: capacity.fd_headroom,
                    pid_headroom: capacity.pid_headroom,
                    nproc: capacity.nproc,
                }),
                admission: Some(v1::AdmissionTelemetry {
                    light_running: admission.light_running as u64,
                    light_queued: admission.light_queued as u64,
                    heavy_running: admission.heavy_running as u64,
                    heavy_queued: admission.heavy_queued as u64,
                    live_ops: self.engine.live_ops() as u64,
                }),
            })),
        };
        client
            .publish(link.creds.events_subject(), event.encode_to_vec().into())
            .await
    }

    /// Publishes a clean [`GoingOffline`] event so the lease flips offline
    /// immediately (§23.0), then flushes so the message leaves before we close.
    async fn announce_going_offline(&self, link: &WorkspaceLink, client: &async_nats::Client) {
        let event = AgentEvent {
            agent_id: link.creds.agent_id.clone(),
            event: Some(Event::GoingOffline(GoingOffline {
                reason: GoingOfflineReason::UserStop as i32,
                message: "agent stopped (foreground run ended)".to_string(),
            })),
        };
        if let Err(e) = client
            .publish(link.creds.events_subject(), event.encode_to_vec().into())
            .await
        {
            warn!(error = %e, "failed to publish going-offline");
        }
        // Best-effort flush so the offline signal is on the wire before we drop.
        let _ = client.flush().await;
        info!("announced going-offline; closing cleanly");
    }
}

/// The subject the control plane listens on for an agent's connect hello.
fn hello_subject(link: &WorkspaceLink) -> String {
    format!(
        "agent.{}.{}.hello",
        link.creds.workspace_id, link.creds.agent_id
    )
}

/// A legacy op the adapter serves as an engine job.
enum AdapterWork {
    /// A monolithic exec request.
    Exec(v1::ExecRequest),
    /// A monolithic git request.
    Git(v1::GitRequest),
}

/// How a decoded control RPC is served.
enum Route {
    /// Answered inline on the serve loop — liveness never enters admission.
    Liveness,
    /// Runs as an engine job through the legacy exec adapter.
    LegacyExec(v1::ExecRequest),
    /// Runs as an engine job through the legacy git adapter.
    LegacyGit(v1::GitRequest),
    /// Starts an op-stream job (admission may park; runs on its own task).
    OpStart(v1::OpStart),
    /// Op-control (cancel/query/attach): engine state + routing only — served
    /// inline like liveness (admission gates job STARTS, never byte flow).
    OpControl,
    /// Runs on its own task behind an engine admission ticket of this class.
    Work(JobClass),
}

/// Classifies a decoded RPC. `exec`/`git` are heavy (long-running, resource-
/// owning); everything else platform-backed is light; `ping` bypasses
/// admission entirely (liveness ⊥ work — invariant #4).
fn classify(request: &ControlRequest) -> Route {
    use v1::control_request::Op;
    match &request.op {
        Some(Op::Ping(_)) => Route::Liveness,
        Some(Op::Exec(req)) => Route::LegacyExec(req.clone()),
        Some(Op::Git(req)) => Route::LegacyGit(req.clone()),
        Some(Op::OpStart(start)) => Route::OpStart(start.clone()),
        Some(Op::OpCancel(_) | Op::OpQuery(_) | Op::OpAttach(_)) => Route::OpControl,
        _ => Route::Work(JobClass::Light),
    }
}

/// The engine's periodic housekeeping, for the run's lifetime: registry GC +
/// queue-wait expiry every tick; a fresh host-capacity sample (budgets track
/// the host — rule R's "periodically refreshed") on the slower cadence.
async fn housekeeping_loop(engine: Arc<Engine>) {
    let mut ticker = tokio::time::interval(HOUSEKEEPING_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_sample = Instant::now();
    loop {
        ticker.tick().await;
        engine.gc_tick();
        if last_sample.elapsed() >= CAPACITY_RESAMPLE {
            last_sample = Instant::now();
            let spool_root = engine.spool_root().to_path_buf();
            if let Ok(capacity) =
                tokio::task::spawn_blocking(move || crate::capacity::sample(&spool_root)).await
            {
                engine.refresh_capacity(capacity);
            }
        }
    }
}

/// Dispatch one already-decoded request and publish its typed response. This
/// function owns no connection-generation state, so the generation's `JoinSet`
/// can cancel it deterministically on disconnect or shutdown. (No duration
/// policing here: an op producing output is healthy at any age — the
/// LIMITS-DOCTRINE health rule; liveness is the op-stream progress cadence.)
async fn serve_request<P: Platform>(
    client: &async_nats::Client,
    reply: async_nats::Subject,
    request: ControlRequest,
    platform: &Arc<P>,
    ctx: &DispatchContext,
    max_payload: usize,
) {
    let label = op_label(&request);
    let request_id = request.request_id.clone();
    let started = Instant::now();
    let response = dispatch::dispatch(request, platform, ctx).await;
    debug!(
        request_id = %request_id,
        op = label,
        elapsed_ms = millis_u64(started.elapsed()),
        "served control rpc"
    );
    publish_response(client, reply, response, label, max_payload).await;
}

/// Encode and publish a response with the generic negotiated-payload guard. A
/// payload failure remains an operation-level typed outcome and never changes
/// heartbeat or machine-liveness state.
async fn publish_response(
    client: &async_nats::Client,
    reply: async_nats::Subject,
    response: v1::ControlResponse,
    label: &'static str,
    max_payload: usize,
) {
    let request_id = response.request_id.clone();
    let encoded = response.encode_to_vec();
    let payload = if max_payload > 0 && encoded.len() > max_payload {
        warn!(
            request_id = %request_id,
            op = label,
            encoded_bytes = encoded.len(),
            max_payload,
            liveness_affected = false,
            "reply exceeds negotiated max payload; replacing it with typed error"
        );
        dispatch::oversized_reply_error(request_id, label, encoded.len(), max_payload)
            .encode_to_vec()
    } else {
        encoded
    };

    if let Err(publish_error) = client.publish(reply, payload.into()).await {
        warn!(
            error = %publish_error,
            op = label,
            "failed to publish control rpc reply"
        );
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
        Some(Op::DesktopInput(_)) => "desktop_input",
        Some(Op::DesktopScreenshot(_)) => "desktop_screenshot",
        Some(Op::Metrics(_)) => "metrics",
        Some(Op::UpdateMayProceed(_)) => "update_may_proceed",
        // Op-stream (v1.1) — wire types present; no runtime serves them yet.
        Some(Op::OpStart(_)) => "op_start",
        Some(Op::OpCancel(_)) => "op_cancel",
        Some(Op::OpQuery(_)) => "op_query",
        Some(Op::OpAttach(_)) => "op_attach",
        Some(Op::WriteChunk(_)) => "write_chunk",
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
    fn classifies_auth_denials_vs_transport_blips() {
        // The callout-deny messages async-nats surfaces are classified as auth
        // denials (the agent then logs "re-enroll" rather than a generic blip).
        assert!(message_is_authentication_denial("Authorization Violation"));
        assert!(message_is_authentication_denial(
            "user authentication expired"
        ));
        assert!(message_is_authentication_denial("AUTH VIOLATION"));
        // A plain transport drop is NOT an auth denial.
        assert!(!message_is_authentication_denial("connection refused"));
        assert!(!message_is_authentication_denial("broken pipe"));
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

    #[test]
    fn classify_routes_liveness_exec_and_classed_work() {
        use v1::control_request::Op;

        let request = |op| ControlRequest {
            request_id: "r".to_string(),
            epoch: 0,
            op: Some(op),
        };
        // Liveness never enters admission.
        assert!(matches!(
            classify(&request(Op::Ping(v1::PingRequest { nonce: 1 }))),
            Route::Liveness
        ));
        // Exec runs as an engine job through the legacy adapter.
        assert!(matches!(
            classify(&request(Op::Exec(v1::ExecRequest::default()))),
            Route::LegacyExec(_)
        ));
        // Git runs as an engine job through its adapter; fs ops are light.
        assert!(matches!(
            classify(&request(Op::Git(v1::GitRequest::default()))),
            Route::LegacyGit(_)
        ));
        assert!(matches!(
            classify(&request(Op::FsRead(v1::FsReadRequest::default()))),
            Route::Work(JobClass::Light)
        ));
        assert!(matches!(
            classify(&ControlRequest::default()),
            Route::Work(JobClass::Light)
        ));
    }

    #[tokio::test]
    async fn shutdown_signal_latches_and_wakes_registered_waiters() {
        let signal = ShutdownSignal::default();
        assert!(!signal.is_requested(), "not requested initially");

        // A waiter already awaiting when the request lands is woken.
        let waiter = {
            let s = signal.clone();
            tokio::spawn(async move { s.notified().await })
        };
        // Let the spawned waiter register before we request.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        signal.request();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("a registered waiter wakes on request")
            .expect("waiter task did not panic");

        // And the flag stays latched for any LATER checker even though
        // `notify_waiters` stored no permit — this level-triggering is exactly what
        // the run loop's `is_requested` checks rely on to never miss a stop that
        // raced a select (the missed-signal half the fix closes).
        assert!(signal.is_requested(), "request latches permanently");
    }

    /// End-to-end regression test for the going-offline-on-clean-shutdown bug: a
    /// real supervisor over a real local nats-server must publish a `GoingOffline`
    /// event when a clean shutdown is requested DURING an active connection.
    ///
    /// Before the fix, the outer supervise loop's biased `shutdown.notified()`
    /// branch returned before `serve_connection_generation` could announce, so this
    /// test would time out waiting for the event.
    ///
    /// Self-contained (no harness crate). Skips gracefully when no `nats-server`
    /// binary is available so a dev's `cargo test` never fails for that reason; CI
    /// that provides `nats-server` (as the load harness already requires) catches
    /// the regression.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clean_shutdown_publishes_going_offline_during_active_connection() {
        use opengeni_agent_platform::NativePlatform;

        let Some(nats_bin) = it::find_nats_server() else {
            eprintln!(
                "SKIP clean_shutdown_publishes_going_offline: no nats-server on PATH or /nix/store"
            );
            return;
        };
        let port = it::free_local_port();
        let _server = it::NatsServerGuard::spawn(&nats_bin, port);
        let url = format!("nats://127.0.0.1:{port}");

        // A watcher on the agent's outbound events subject.
        let client = it::connect_with_retry(&url, Duration::from_secs(5)).await;
        let mut events = client
            .subscribe("agent.hx-test-ws.hx-test-agent.events".to_string())
            .await
            .expect("subscribe to events subject");

        // A disposable supervisor over the real native platform, dialing the local
        // no-auth server (which accepts the throwaway bearer).
        let supervisor = Supervisor::new(
            Arc::new(NativePlatform::new()),
            it::test_credentials(&url),
            "test-0.0.0",
        );
        let shutdown = supervisor.shutdown_handle();
        let run = tokio::spawn(async move { supervisor.run().await });

        // Only meaningful once a connection is LIVE (the bug races an active
        // connection), so wait for the first heartbeat before stopping.
        assert!(
            it::wait_for_event(&mut events, Duration::from_secs(10), |e| matches!(
                e.event,
                Some(Event::Heartbeat(_))
            ))
            .await,
            "agent should heartbeat once connected"
        );

        // Clean shutdown during the active connection.
        shutdown.request();

        assert!(
            it::wait_for_event(&mut events, Duration::from_secs(5), |e| matches!(
                e.event,
                Some(Event::GoingOffline(_))
            ))
            .await,
            "a clean shutdown during an active connection must publish GoingOffline"
        );

        // And the run loop returns cleanly.
        assert!(
            tokio::time::timeout(Duration::from_secs(5), run)
                .await
                .is_ok(),
            "supervisor.run should return after a clean shutdown"
        );
    }

    /// The op-stream wire round trip against a REAL nats-server + real
    /// supervisor: OpStart over rpc → OpFrames on the op subject (via the bulk
    /// connection) → cumulative + final OpAck on the ack subject → OpQuery.
    /// This is the end-to-end proof of the served protocol (invariant #1's
    /// delivery half: every byte arrives, digest-verified).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::too_many_lines)] // one linear wire scenario; splitting would hide the story
    async fn op_stream_full_wire_round_trip() {
        use opengeni_agent_platform::NativePlatform;

        let Some(nats_bin) = it::find_nats_server() else {
            eprintln!("SKIP op_stream_full_wire_round_trip: no nats-server on PATH or /nix/store");
            return;
        };
        let port = it::free_local_port();
        let _server = it::NatsServerGuard::spawn(&nats_bin, port);
        let url = format!("nats://127.0.0.1:{port}");
        let client = it::connect_with_retry(&url, Duration::from_secs(5)).await;

        let op_id = "wire-op-1";
        // Subscription-before-start (protocol invariant).
        let mut op_frames = client
            .subscribe(format!("agent.hx-test-ws.hx-test-agent.op.{op_id}"))
            .await
            .expect("subscribe op subject");
        let mut events = client
            .subscribe("agent.hx-test-ws.hx-test-agent.events".to_string())
            .await
            .expect("subscribe events");

        let supervisor = Supervisor::new(
            Arc::new(NativePlatform::with_root(std::env::temp_dir())),
            it::test_credentials(&url),
            "test-0.0.0",
        );
        let shutdown = supervisor.shutdown_handle();
        let run = tokio::spawn(async move { supervisor.run().await });
        assert!(
            it::wait_for_event(&mut events, Duration::from_secs(10), |e| matches!(
                e.event,
                Some(Event::Heartbeat(_))
            ))
            .await,
            "agent online"
        );

        // OpStart{exec} over the rpc subject.
        let start = ControlRequest {
            request_id: op_id.to_string(),
            epoch: 0,
            op: Some(v1::control_request::Op::OpStart(v1::OpStart {
                op: Some(v1::op_start::Op::Exec(v1::ExecRequest {
                    command: vec!["printf over-the-wire".to_string()],
                    shell: true,
                    ..Default::default()
                })),
                window_bytes: 0,
                deadline_ms: 0,
                origin_id: "session-e2e".to_string(),
            })),
        };
        let reply = tokio::time::timeout(
            Duration::from_secs(10),
            client.request(
                "agent.hx-test-ws.hx-test-agent.rpc".to_string(),
                start.encode_to_vec().into(),
            ),
        )
        .await
        .expect("OpStarted within timeout")
        .expect("request ok");
        let started = v1::ControlResponse::decode(reply.payload.as_ref()).expect("decodes");
        match started.result {
            Some(v1::control_response::Result::OpStart(s)) => {
                assert!(s.accepted, "fresh op accepted");
            }
            other => panic!("expected OpStarted, got {other:?} / {:?}", started.error),
        }

        // Collect frames off the op subject until the Exit frame.
        let mut stdout = Vec::new();
        let (exit, exit_seq) = loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), op_frames.next())
                .await
                .expect("frame within timeout")
                .expect("op subject open");
            let frame = v1::OpFrame::decode(msg.payload.as_ref()).expect("frame decodes");
            assert_eq!(frame.op_id, op_id);
            match frame.body {
                Some(v1::op_frame::Body::Data(d)) if d.channel == v1::OpChannel::Stdout as i32 => {
                    stdout.extend_from_slice(&d.bytes);
                }
                Some(v1::op_frame::Body::Exit(e)) => {
                    break (e, frame.seq);
                }
                _ => {}
            }
        };
        assert_eq!(stdout, b"over-the-wire");
        assert_eq!(exit.exit_code, 0);
        assert_eq!(
            exit.digests.get("stdout").map(String::as_str),
            Some(blake3::hash(b"over-the-wire").to_hex().as_str()),
            "digest proves byte-exact wire assembly"
        );

        // Final cumulative ack on the ack subject (generation 1 = the
        // runner-side initial attachment).
        client
            .publish(
                "agent.hx-test-ws.hx-test-agent.ack".to_string(),
                v1::OpAck {
                    op_id: op_id.to_string(),
                    acked_seq: exit_seq,
                    credit_bytes: 1 << 20,
                    r#final: true,
                    attach_generation: 1,
                }
                .encode_to_vec()
                .into(),
            )
            .await
            .expect("ack publish");

        // OpQuery answers COMPLETE with the terminal record.
        let query = ControlRequest {
            request_id: "q-wire-1".to_string(),
            epoch: 0,
            op: Some(v1::control_request::Op::OpQuery(v1::OpQuery {
                op_id: op_id.to_string(),
            })),
        };
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            client.request(
                "agent.hx-test-ws.hx-test-agent.rpc".to_string(),
                query.encode_to_vec().into(),
            ),
        )
        .await
        .expect("status within timeout")
        .expect("request ok");
        let status = v1::ControlResponse::decode(reply.payload.as_ref()).expect("decodes");
        match status.result {
            Some(v1::control_response::Result::OpStatus(s)) => {
                assert_eq!(s.state, v1::OpState::Complete as i32);
                assert_eq!(s.exit.expect("terminal record").exit_code, 0);
                assert_eq!(s.next_seq, exit_seq + 1);
            }
            other => panic!("expected OpStatus, got {other:?} / {:?}", status.error),
        }

        shutdown.request();
        let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
    }

    /// Test-only integration helpers (a throwaway local nats-server + event
    /// waiting), kept out of the unit tests above so they stay pure.
    mod it {
        use std::path::{Path, PathBuf};
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        use futures::StreamExt as _;
        use opengeni_agent_proto::v1::AgentEvent;
        use prost::Message as _;

        use crate::config::StoredCredentials;

        /// Locates a `nats-server` binary on `$PATH`, else scans `/nix/store`
        /// (this project's dev/CI hosts are NixOS). `None` → the caller skips.
        pub fn find_nats_server() -> Option<PathBuf> {
            if let Some(path) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&path) {
                    let candidate = dir.join("nats-server");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
            for entry in std::fs::read_dir("/nix/store").ok()?.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.contains("nats-server") && !name.ends_with(".drv") {
                    let candidate = entry.path().join("bin").join("nats-server");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
            None
        }

        /// A free localhost TCP port (bind `:0`, read it back).
        pub fn free_local_port() -> u16 {
            std::net::TcpListener::bind("127.0.0.1:0")
                .expect("bind ephemeral port")
                .local_addr()
                .expect("local addr")
                .port()
        }

        /// A no-auth `nats-server` child, killed on drop.
        pub struct NatsServerGuard(Child);

        impl NatsServerGuard {
            pub fn spawn(bin: &Path, port: u16) -> Self {
                let child = Command::new(bin)
                    .args(["-a", "127.0.0.1", "-p", &port.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn nats-server");
                Self(child)
            }
        }

        impl Drop for NatsServerGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        /// Connects, retrying until the just-spawned server is ready.
        pub async fn connect_with_retry(url: &str, timeout: Duration) -> async_nats::Client {
            let deadline = Instant::now() + timeout;
            loop {
                match async_nats::connect(url).await {
                    Ok(client) => return client,
                    Err(e) if Instant::now() < deadline => {
                        let _ = e;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => panic!("could not connect to test nats-server: {e}"),
                }
            }
        }

        /// Waits until an `AgentEvent` matching `pred` arrives, or `timeout` elapses.
        pub async fn wait_for_event(
            sub: &mut async_nats::Subscriber,
            timeout: Duration,
            pred: impl Fn(&AgentEvent) -> bool,
        ) -> bool {
            let deadline = Instant::now() + timeout;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return false;
                }
                match tokio::time::timeout(remaining, sub.next()).await {
                    Ok(Some(msg)) => {
                        if AgentEvent::decode(msg.payload.as_ref())
                            .ok()
                            .is_some_and(|e| pred(&e))
                        {
                            return true;
                        }
                    }
                    Ok(None) | Err(_) => return false,
                }
            }
        }

        /// Throwaway credentials pointing at the local server.
        pub fn test_credentials(url: &str) -> StoredCredentials {
            StoredCredentials {
                agent_id: "hx-test-agent".to_string(),
                workspace_id: "hx-test-ws".to_string(),
                nats_bearer: "test-bearer".to_string(),
                nats_urls: vec![url.to_string()],
                relay_url: "http://127.0.0.1:9".to_string(),
                relay_token: String::new(),
                update_pubkey: String::new(),
                consented_whole_machine: true,
                consented_screen_control: false,
                update_channel: "stable".to_string(),
                resume_token: String::new(),
                last_known_epoch: 0,
            }
        }
    }
}
