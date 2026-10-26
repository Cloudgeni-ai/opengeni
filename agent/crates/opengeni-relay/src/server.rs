//! The relay listener — the wss server + health/metrics endpoints + the
//! per-connection handshake driver.
//!
//! Routes:
//!
//! * `GET /stream?ws=&agent=&port=&channel=` — the WebSocket dial both ends use.
//!   On upgrade the connection runs the [`handshake`](conn::handshake) → splice
//!   loop against the [`ChannelRegistry`].
//! * `GET /healthz` — liveness/readiness probe (always `200 ok` when serving).
//! * `GET /metrics` - the Prometheus-style operator aggregates. When
//!   [`RelayConfig::metrics_bind`] is set it is served ONLY on that dedicated
//!   internal listener ([`metrics_router`]) and the public wss listener answers
//!   `404`, so an ingress forwarding every path of the relay host cannot publish
//!   it. Unset, it stays on the wss listener (the single-listener layout).
//!
//! The wss transport reuses the SAME framing as the agent ([`RelayMessage`]): each
//! relay message is one WebSocket **binary** message (`tag || protobuf-body`). The
//! QUIC/WebTransport path is structured behind the `quic` feature (mirroring the
//! agent's stream crate); the wss listener is the always-on day-1 path.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use tokio::net::TcpListener;

use crate::config::RelayConfig;
use crate::metrics::RelayMetrics;
use crate::registry::ChannelRegistry;

/// The shared server state every handler reads.
#[derive(Clone)]
pub struct RelayState {
    pub(crate) registry: Arc<ChannelRegistry>,
    pub(crate) config: Arc<RelayConfig>,
    pub(crate) routing: Option<Arc<crate::routing::Routing>>,
}

/// Build the public (wss) relay router over a registry + config. It routes
/// `GET /metrics` only when no dedicated metrics listener is configured.
pub fn router(registry: Arc<ChannelRegistry>, config: Arc<RelayConfig>) -> Router {
    routed_router(registry, config, None)
}

fn routed_router(
    registry: Arc<ChannelRegistry>,
    config: Arc<RelayConfig>,
    routing: Option<Arc<crate::routing::Routing>>,
) -> Router {
    let serves_metrics = config.metrics_listener_bind().is_none();
    let state = RelayState {
        registry,
        config,
        routing,
    };
    let router = Router::new()
        .route("/stream", get(stream_upgrade))
        .route("/healthz", get(healthz));
    let router = if serves_metrics {
        router.route("/metrics", get(metrics_handler))
    } else {
        router
    };
    router.with_state(state)
}

/// Build the dedicated internal metrics router: only `GET /metrics`. Nothing else
/// is routed here, so exposing this port to a scraper exposes nothing else.
pub fn metrics_router(registry: Arc<ChannelRegistry>, config: Arc<RelayConfig>) -> Router {
    Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(RelayState {
            registry,
            config,
            routing: None,
        })
}

/// Serve the relay on `config.bind` until `shutdown` resolves: [`BoundRelay::bind`]
/// then [`BoundRelay::serve`]. Returns the bound wss address.
///
/// # Errors
///
/// [`RelayError::Server`](crate::error::RelayError::Server) if either listener
/// cannot bind, or if the metrics listener would share the wss listener's port.
pub async fn serve(
    config: RelayConfig,
    metrics: RelayMetrics,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> crate::error::RelayResult<SocketAddr> {
    BoundRelay::bind(config, metrics)
        .await?
        .serve(shutdown)
        .await
}

/// A relay whose listeners are bound but which does not serve yet. Binding first
/// gives the caller the bound address (port 0 picks one) while the relay holds the
/// port, so nothing else can take it between choosing and serving.
pub struct BoundRelay {
    registry: Arc<ChannelRegistry>,
    config: Arc<RelayConfig>,
    listener: TcpListener,
    addr: SocketAddr,
    metrics_listener: Option<(TcpListener, SocketAddr)>,
}

impl BoundRelay {
    /// Bind the wss listener on `config.bind`, and the dedicated metrics listener
    /// when [`RelayConfig::metrics_bind`] is set.
    ///
    /// # Errors
    ///
    /// [`RelayError::Server`](crate::error::RelayError::Server) if either listener
    /// cannot bind, or if the metrics listener would share the wss listener's port.
    pub async fn bind(
        config: RelayConfig,
        metrics: RelayMetrics,
    ) -> crate::error::RelayResult<Self> {
        let registry = Arc::new(ChannelRegistry::new(&config, metrics));
        let config = Arc::new(config);
        let listener = TcpListener::bind(&config.bind)
            .await
            .map_err(|e| crate::error::RelayError::Server(format!("bind {}: {e}", config.bind)))?;
        let addr = listener
            .local_addr()
            .map_err(|e| crate::error::RelayError::Server(format!("local_addr: {e}")))?;
        let metrics_listener = bind_metrics_listener(&config, addr).await?;
        Ok(Self {
            registry,
            config,
            listener,
            addr,
            metrics_listener,
        })
    }

    /// The bound wss address.
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Serve until `shutdown` resolves. Spawns a background reaper that bounds
    /// half-open channel state, and serves the dedicated metrics listener when one
    /// is bound. Returns the bound wss address.
    ///
    /// # Errors
    ///
    /// [`RelayError::Server`](crate::error::RelayError::Server) if serving fails.
    pub async fn serve(
        self,
        shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> crate::error::RelayResult<SocketAddr> {
        let Self {
            registry,
            config,
            listener,
            addr,
            metrics_listener,
        } = self;
        let metrics_addr = metrics_listener
            .as_ref()
            .map(|(_, metrics_addr)| *metrics_addr);
        tracing::info!(%addr, metrics_addr = ?metrics_addr, "relay listening");

        // The dedicated metrics listener outlives the wss drain (scrapes keep working
        // while in-flight streams finish) and stops after it.
        let metrics_server = metrics_listener.map(|(metrics_listener, _)| {
            let app = metrics_router(registry.clone(), config.clone());
            tokio::spawn(async move {
                if let Err(e) = axum::serve(metrics_listener, app).await {
                    tracing::error!(error = %e, "relay metrics listener failed");
                }
            })
        });

        // The half-open reaper bounds transient state (a side that dialed but whose
        // peer never arrived). Cheap; runs every few seconds.
        let reaper_registry = registry.clone();
        let reaper = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            loop {
                ticker.tick().await;
                let reaped = reaper_registry.reap_half_open(Instant::now());
                if reaped > 0 {
                    tracing::debug!(reaped, "reaped half-open relay channels");
                }
            }
        });

        let routing = config.advertise_ip.map(|ip| {
            Arc::new(crate::routing::Routing::new(SocketAddr::new(
                ip,
                addr.port(),
            )))
        });
        let app = routed_router(registry, config, routing);
        let server = axum::serve(listener, app).with_graceful_shutdown(shutdown);
        let result = server
            .await
            .map_err(|e| crate::error::RelayError::Server(format!("serve: {e}")));
        reaper.abort();
        if let Some(metrics_server) = metrics_server {
            metrics_server.abort();
        }
        result?;
        Ok(addr)
    }
}

/// Bind the dedicated metrics listener when one is configured. It must not share
/// the wss listener's port: the check runs on the bound addresses, so it also
/// catches a host-specific bind on the same port that the OS would accept.
async fn bind_metrics_listener(
    config: &RelayConfig,
    wss_addr: SocketAddr,
) -> crate::error::RelayResult<Option<(TcpListener, SocketAddr)>> {
    let Some(metrics_bind) = config.metrics_listener_bind() else {
        return Ok(None);
    };
    let listener = TcpListener::bind(metrics_bind).await.map_err(|e| {
        crate::error::RelayError::Server(format!("bind metrics {metrics_bind}: {e}"))
    })?;
    let metrics_addr = listener
        .local_addr()
        .map_err(|e| crate::error::RelayError::Server(format!("metrics local_addr: {e}")))?;
    if metrics_addr.port() == wss_addr.port() {
        return Err(crate::error::RelayError::Server(format!(
            "OPENGENI_RELAY_METRICS_BIND ({metrics_bind}) must use a different port than OPENGENI_RELAY_BIND ({})",
            config.bind
        )));
    }
    Ok(Some((listener, metrics_addr)))
}

/// `GET /healthz`.
async fn healthz() -> impl IntoResponse {
    (axum::http::StatusCode::OK, "ok")
}

/// `GET /metrics` — the Prometheus exposition.
async fn metrics_handler(State(state): State<RelayState>) -> impl IntoResponse {
    (
        axum::http::StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        state.registry.metrics().render_prometheus(),
    )
}

/// The dial query (`?ws=&agent=&port=&channel=`). All four coordinates form the
/// routing key. `channel` distinguishes concurrent stream instances on the same
/// machine and logical port.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct DialQuery {
    pub ws: String,
    pub agent: String,
    pub port: u32,
    pub channel: String,
    pub route: Option<String>,
    #[serde(default)]
    pub forwarded: bool,
}

/// `GET /stream` — upgrade to a WebSocket then run the per-connection handshake +
/// splice loop. The query carries the channel key.
async fn stream_upgrade(
    ws: WebSocketUpgrade,
    Query(query): Query<DialQuery>,
    State(state): State<RelayState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| conn::run(socket, query, state))
}

/// The per-connection handshake + splice driver.
pub(crate) mod conn {
    use super::{DialQuery, RelayState, WebSocket, WsMessage};
    use std::time::Instant;

    use futures_util::{SinkExt as _, StreamExt as _};
    use opengeni_agent_proto::v1;
    use opengeni_agent_stream::codec::RelayMessage;
    use opengeni_agent_stream::{ChannelKey, DESKTOP_STREAM_PORT, PTY_STREAM_PORT};

    use crate::registry::{AttachError, Role, ViewerEpochs};
    use crate::token::{self, TokenError};

    /// The bound on the per-connection outbound queue (the peer-sink). A slow socket
    /// fills this; the registry then sheds toward this side (backpressure point).
    const OUTBOUND_QUEUE: usize = 256;

    /// Run one relay connection: handshake (read open + authorize + attach + ack +
    /// replay) then splice until the socket closes.
    pub(crate) async fn run(socket: WebSocket, query: DialQuery, state: RelayState) {
        let (mut ws_tx, mut ws_rx) = socket.split();
        let Some(established) = handshake(&mut ws_tx, &mut ws_rx, &query, &state).await else {
            return; // the handshake already ack'd the rejection / closed.
        };
        let (key, role, conn_gen) = (
            established.key.clone(),
            established.role,
            established.conn_gen,
        );
        splice(&mut ws_tx, &mut ws_rx, established, &state).await;
        // The socket dropped: detach (keep the channel alive for the peer +
        // reconnect-resume; remove it only when both sides are gone).
        state.registry.detach(&key, role, conn_gen);
    }

    /// A successfully-attached connection's identity + its outbound (peer→this side)
    /// receiver, carried into the splice loop.
    struct Established {
        key: ChannelKey,
        role: Role,
        conn_gen: crate::registry::ConnGen,
        /// Whether the verified viewer token granted input (`mode: "control"`).
        /// Always false for the agent side, whose sends are never viewer input.
        input_granted: bool,
        peer_rx: tokio::sync::mpsc::Receiver<RelayMessage>,
    }

    /// Steps 1-3: read the StreamOpen, authorize it, attach to the registry, ack, and
    /// replay the buffered tail. Returns `None` (having ack'd the rejection) on any
    /// failure so [`run`] can simply drop the connection.
    async fn handshake(
        ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
        ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
        query: &DialQuery,
        state: &RelayState,
    ) -> Option<Established> {
        // 1. The first datagram MUST be a StreamOpen.
        let open = match read_open(ws_rx).await {
            Ok(open) => open,
            Err(reason) => {
                tracing::warn!(reason = %reason, "relay handshake: no valid StreamOpen");
                let _ = send_ack(ws_tx, false, 0, &reason).await;
                return None;
            }
        };

        // 2. Resolve + authorize the key (token + channel-key scope). A client's
        // fence claims come from this exact token verification.
        let (key, role, resume_from_seq, viewer, input_granted) = match authorize(
            &open, query, state,
        ) {
            Ok(parts) => parts,
            Err(reason) => {
                tracing::warn!(reason = %reason, ws = %query.ws, agent = %query.agent, port = query.port, "relay open rejected");
                state.registry.metrics().record_open_rejected();
                let _ = send_ack(ws_tx, false, 0, &reason).await;
                return None;
            }
        };

        // 3. Attach (the epoch fences are applied for a client), ack, replay.
        // Authenticate before opening ANY private connection. A route is not a
        // stream credential and cannot be used as an unauthenticated proxy.
        if let Some(route) = query.route.as_deref() {
            let Ok(owner) =
                crate::routing::verify(route, &key, state.config.effective_relay_token_secret())
            else {
                let _ = send_ack(ws_tx, false, 0, "invalid relay owner route").await;
                return None;
            };
            if !state
                .routing
                .as_ref()
                .is_some_and(|routing| routing.owns(&owner))
            {
                // Exactly one hop. A recycled pod address must reject an old
                // incarnation, not recursively forward back to itself.
                if query.forwarded
                    || state
                        .routing
                        .as_ref()
                        .is_some_and(|routing| routing.addr == owner.addr)
                {
                    owner_unavailable(ws_tx).await;
                } else {
                    proxy(ws_tx, ws_rx, &open, query, &owner).await;
                }
                return None;
            }
        }
        let now = Instant::now();
        let (peer_tx, peer_rx) = tokio::sync::mpsc::channel::<RelayMessage>(OUTBOUND_QUEUE);
        let attached =
            match state
                .registry
                .attach(&key, role, viewer, resume_from_seq, peer_tx, now)
            {
                Ok(a) => a,
                Err(AttachError::StaleEpoch) => {
                    let _ = send_ack(ws_tx, false, 0, &AttachError::StaleEpoch.to_string()).await;
                    return None;
                }
            };
        let conn_gen = attached.gen;
        tracing::debug!(
            ws = %query.ws, agent = %query.agent, port = query.port,
            channel = %query.channel, role = ?role,
            resume_from_seq, "relay channel attached"
        );
        let relay_route = state.routing.as_ref().and_then(|routing| {
            routing
                .mint(&key, state.config.effective_relay_token_secret())
                .ok()
        });
        if write_msg(
            ws_tx,
            &RelayMessage::OpenAck(v1::StreamOpenAck {
                accepted: true,
                error: None,
                resume_from_seq: attached.resume_from_seq,
                relay_route,
            }),
        )
        .await
        .is_err()
        {
            state.registry.detach(&key, role, conn_gen);
            return None;
        }
        // Replay the buffered tail toward this side (resume-from-seq).
        for frame in attached.replay {
            if write_msg(ws_tx, &RelayMessage::Frame(frame)).await.is_err() {
                state.registry.detach(&key, role, conn_gen);
                return None;
            }
        }
        Some(Established {
            key,
            role,
            conn_gen,
            input_granted,
            peer_rx,
        })
    }

    /// Step 4: splice until the socket closes — outbound (peer → this side) drained
    /// from the registry sink, inbound (this side → peer) forwarded to the registry.
    /// Takes `est` by value so it owns the `peer_rx` receiver for the loop's life.
    async fn splice(
        ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
        ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
        mut est: Established,
        state: &RelayState,
    ) {
        loop {
            tokio::select! {
                outbound = est.peer_rx.recv() => {
                    match outbound {
                        Some(msg) => {
                            if write_msg(ws_tx, &msg).await.is_err() {
                                break;
                            }
                            if matches!(msg, RelayMessage::Close(_)) {
                                break; // a close forwarded to us ends this side too.
                            }
                        }
                        None => break, // the registry dropped our sink (channel closed).
                    }
                }
                inbound = ws_rx.next() => {
                    if !handle_inbound(inbound, &est, state) {
                        break;
                    }
                }
            }
        }
    }

    /// Process one inbound socket item. Returns `false` when the splice loop should
    /// end (socket closed/errored or the channel was torn down by a Close).
    fn handle_inbound(
        inbound: Option<Result<WsMessage, axum::Error>>,
        est: &Established,
        state: &RelayState,
    ) -> bool {
        match inbound {
            Some(Ok(WsMessage::Binary(bytes))) => match RelayMessage::decode(&bytes) {
                Ok(msg) if !may_forward(est, &msg) => {
                    tracing::debug!(port = est.key.port, role = ?est.role, kind = ?msg.tag(), "relay: dropping unauthorized message");
                    true
                }
                Ok(RelayMessage::Frame(frame)) => {
                    state
                        .registry
                        .forward(&est.key, est.role, est.conn_gen, frame, Instant::now());
                    true
                }
                Ok(msg @ RelayMessage::DesktopInput(_)) => {
                    // Typed computer-use input → forward verbatim.
                    state
                        .registry
                        .forward_message(&est.key, est.role, est.conn_gen, msg);
                    true
                }
                Ok(close @ RelayMessage::Close(_)) => {
                    state
                        .registry
                        .close(&est.key, est.role, est.conn_gen, close);
                    false // channel torn down; this side is done.
                }
                // A duplicate Open/OpenAck mid-stream is ignored (already attached).
                Ok(RelayMessage::Open(_) | RelayMessage::OpenAck(_)) => true,
                Err(e) => {
                    tracing::warn!(error = %e, "relay: undecodable inbound datagram; ignoring");
                    true
                }
            },
            Some(Ok(WsMessage::Close(_))) | None => false,
            Some(Ok(_)) => true, // ping/pong/text handled by axum / ignored.
            Some(Err(e)) => {
                tracing::debug!(error = %e, "relay: socket recv error; detaching");
                false
            }
        }
    }

    /// Read + decode the first binary datagram as a `StreamOpen`.
    async fn read_open(
        ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
    ) -> Result<v1::StreamOpen, String> {
        loop {
            match ws_rx.next().await {
                Some(Ok(WsMessage::Binary(bytes))) => match RelayMessage::decode(&bytes) {
                    Ok(RelayMessage::Open(open)) => return Ok(open),
                    Ok(other) => return Err(format!("expected StreamOpen, got {:?}", other.tag())),
                    Err(e) => return Err(format!("undecodable StreamOpen: {e}")),
                },
                // Tolerate a leading ping/text; keep waiting for the binary open.
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(format!("socket error before open: {e}")),
                None => return Err("socket closed before StreamOpen".to_string()),
            }
        }
    }

    /// Validate the open against the dial query + the token, returning the routing
    /// key + the sender role + the resume cursor.
    fn authorize(
        open: &v1::StreamOpen,
        query: &DialQuery,
        state: &RelayState,
    ) -> Result<(ChannelKey, Role, u64, ViewerEpochs, bool), String> {
        let channel = open
            .channel
            .as_ref()
            .ok_or_else(|| "StreamOpen carried no channel key".to_string())?;

        // (a) The in-band channel key MUST match the dial query (defense in depth).
        if channel.workspace_id != query.ws
            || channel.agent_id != query.agent
            || channel.port != query.port
            || channel.channel_id != query.channel
        {
            return Err("channel key does not match the dial query".to_string());
        }

        let key = ChannelKey {
            workspace_id: channel.workspace_id.clone(),
            agent_id: channel.agent_id.clone(),
            port: channel.port,
            channel_id: channel.channel_id.clone(),
        };

        let role = match v1::StreamRole::try_from(open.role).unwrap_or(v1::StreamRole::Unspecified)
        {
            v1::StreamRole::Agent => Role::Agent,
            v1::StreamRole::Client => Role::Client,
            v1::StreamRole::Unspecified => {
                return Err("StreamOpen had an unspecified role".to_string())
            }
        };

        // (b) Validate the token on its own merits + assert it claims THIS key.
        let now = unix_now();
        match role {
            Role::Agent => {
                let secret = state.config.effective_relay_token_secret();
                if secret.is_empty() {
                    return Err("relay producer-token secret not configured".to_string());
                }
                let claims = token::verify_relay_token(secret, &open.token, now)
                    .map_err(|e: TokenError| format!("agent token: {e}"))?;
                if claims.workspace_id != key.workspace_id || claims.agent_id != key.agent_id {
                    return Err("agent token scope does not match the channel key".to_string());
                }
            }
            Role::Client => {
                let secret = &state.config.stream_token_secret;
                if secret.is_empty() {
                    return Err("viewer stream-token secret not configured".to_string());
                }
                let claims = token::verify_stream_token(secret, &open.token, now)
                    .map_err(|e: TokenError| format!("viewer token: {e}"))?;
                // The viewer token is workspace+port scoped; the agent is identified
                // by the channel key (the token does not carry the agentId — it is
                // minted per session, not per machine). Assert workspace + port.
                if claims.workspace_id != key.workspace_id {
                    return Err("viewer token workspace does not match the channel key".to_string());
                }
                if claims.port != key.port {
                    return Err("viewer token port does not match the channel key".to_string());
                }
                // A token bound to one machine's exact stream only opens that one.
                // Every relay mint carries the binding, so an unbound token is
                // never a valid relay viewer.
                match (&claims.agent_id, &claims.channel_id) {
                    (Some(agent), _) if *agent != key.agent_id => {
                        return Err(
                            "viewer token machine does not match the channel key".to_string()
                        );
                    }
                    (_, Some(channel)) if *channel != key.channel_id => {
                        return Err(
                            "viewer token stream does not match the channel key".to_string()
                        );
                    }
                    (Some(_), Some(_)) => {}
                    _ => return Err("viewer token is not bound to a relay stream".to_string()),
                }
                let input_granted = match claims.mode.as_str() {
                    "view" => false,
                    "control" => true,
                    _ => return Err("viewer token has an unsupported mode".to_string()),
                };
                // The epoch fences are applied at attach (the floors), from the
                // claims of THIS exact verification — no re-verify, no window
                // where an expiring token attaches unfenced.
                return Ok((
                    key,
                    role,
                    open.resume_from_seq,
                    ViewerEpochs {
                        lease: Some(claims.lease_epoch),
                        authority: claims.authority_epoch,
                    },
                    input_granted,
                ));
            }
        }

        Ok((
            key,
            role,
            open.resume_from_seq,
            ViewerEpochs::default(),
            false,
        ))
    }

    /// Whether one inbound message may reach the registry. Every channel-addressed
    /// message must name this connection's own channel. Viewer input is classified
    /// by the token-bound port: terminal keystrokes (client `Frame`s on the PTY
    /// port) and a PTY `Close` (which ends the shell) need a `control` token, and
    /// typed desktop input needs a `control` token on the desktop port. A `view`
    /// token can only watch and close its own non-PTY stream. The agent still
    /// applies its own screen-control consent to desktop input.
    fn may_forward(est: &Established, message: &RelayMessage) -> bool {
        may_forward_message(
            &est.key.channel_id,
            est.key.port,
            est.role,
            est.input_granted,
            message,
        )
    }

    fn may_forward_message(
        channel_id: &str,
        port: u32,
        role: Role,
        input_granted: bool,
        message: &RelayMessage,
    ) -> bool {
        match message {
            RelayMessage::Frame(frame) => {
                frame.channel_id == channel_id
                    && match role {
                        Role::Agent => true,
                        Role::Client => port == PTY_STREAM_PORT && input_granted,
                    }
            }
            RelayMessage::DesktopInput(input) => {
                input.channel_id == channel_id
                    && role == Role::Client
                    && port == DESKTOP_STREAM_PORT
                    && input_granted
            }
            RelayMessage::Close(close) => {
                close.channel_id == channel_id
                    && (role == Role::Agent || port != PTY_STREAM_PORT || input_granted)
            }
            RelayMessage::Open(_) | RelayMessage::OpenAck(_) => true,
        }
    }

    /// Write a `StreamOpenAck` over the socket.
    async fn send_ack(
        ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
        accepted: bool,
        resume_from_seq: u64,
        error: &str,
    ) -> Result<(), ()> {
        let ack = RelayMessage::OpenAck(v1::StreamOpenAck {
            accepted,
            error: if accepted {
                None
            } else {
                Some(v1::AgentError {
                    code: v1::ErrorCode::Stream as i32,
                    message: error.to_string(),
                    retryable: false,
                    detail: std::collections::HashMap::new(),
                })
            },
            resume_from_seq,
            relay_route: None,
        });
        write_msg(ws_tx, &ack).await
    }

    async fn owner_unavailable(ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>) {
        let _ = write_msg(
            ws_tx,
            &RelayMessage::OpenAck(v1::StreamOpenAck {
                accepted: false,
                error: Some(v1::AgentError {
                    code: v1::ErrorCode::Stream as i32,
                    message: "relay owner unavailable".into(),
                    retryable: true,
                    detail: [("relay_owner_unavailable".into(), "true".into())].into(),
                }),
                resume_from_seq: 0,
                relay_route: None,
            }),
        )
        .await;
    }

    /// A transparent, backpressured WebSocket hop. The owner still performs the
    /// original authorization, epoch checks, replay and rate accounting. Bytes
    /// never traverse the database or control-plane broker.
    #[allow(clippy::collapsible_match)] // Move owned frame buffers into send; guards cannot move them.
    async fn proxy(
        ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
        ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
        open: &v1::StreamOpen,
        query: &DialQuery,
        owner: &crate::routing::Owner,
    ) {
        use tokio_tungstenite::tungstenite::Message;
        let Ok(query) = serde_urlencoded::to_string(DialQuery {
            forwarded: true,
            ..query.clone()
        }) else {
            return;
        };
        let url = format!("ws://{}/stream?{query}", owner.addr);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let socket = tokio::time::timeout_at(deadline, tokio_tungstenite::connect_async(url)).await;
        let Ok(Ok((socket, _))) = socket else {
            owner_unavailable(ws_tx).await;
            return;
        };
        let (mut peer_tx, mut peer_rx) = socket.split();
        if !matches!(
            tokio::time::timeout_at(
                deadline,
                peer_tx.send(Message::Binary(RelayMessage::Open(open.clone()).encode()))
            )
            .await,
            Ok(Ok(()))
        ) {
            owner_unavailable(ws_tx).await;
            return;
        }
        // Reachability includes the authenticated stream handshake, not merely
        // a TCP/HTTP upgrade. A stalled/replaced endpoint cannot pin a producer
        // forever to a dead owner route.
        let first = tokio::time::timeout_at(deadline, async {
            loop {
                match peer_rx.next().await {
                    Some(Ok(Message::Binary(bytes))) => return Some(bytes),
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return None,
                    _ => {}
                }
            }
        })
        .await;
        let Ok(Some(bytes)) = first else {
            owner_unavailable(ws_tx).await;
            return;
        };
        let Ok(RelayMessage::OpenAck(ack)) = RelayMessage::decode(&bytes) else {
            owner_unavailable(ws_tx).await;
            return;
        };
        if ws_tx.send(WsMessage::Binary(bytes)).await.is_err() || !ack.accepted {
            return;
        }
        loop {
            tokio::select! {
                inbound = ws_rx.next() => match inbound {
                    Some(Ok(WsMessage::Binary(bytes))) => {
                        if peer_tx.send(Message::Binary(bytes)).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Close(_)) | Err(_)) | None => break,
                    _ => {}
                },
                outbound = peer_rx.next() => match outbound {
                    Some(Ok(Message::Binary(bytes))) => {
                        if ws_tx.send(WsMessage::Binary(bytes)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    _ => {}
                },
            }
        }
        let _ = peer_tx.close().await;
    }

    /// Encode + write one relay message as a binary WebSocket frame.
    async fn write_msg(
        ws_tx: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
        msg: &RelayMessage,
    ) -> Result<(), ()> {
        ws_tx
            .send(WsMessage::Binary(msg.encode()))
            .await
            .map_err(|_| ())
    }

    /// Current unix seconds.
    fn unix_now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const CHANNEL: &str = "channel-a";

        fn frame(channel: &str) -> RelayMessage {
            RelayMessage::Frame(v1::StreamFrame {
                channel_id: channel.to_string(),
                ..Default::default()
            })
        }

        fn desktop_input(channel: &str) -> RelayMessage {
            RelayMessage::DesktopInput(v1::DesktopInput {
                channel_id: channel.to_string(),
                ..Default::default()
            })
        }

        fn close(channel: &str) -> RelayMessage {
            RelayMessage::Close(v1::StreamClose {
                channel_id: channel.to_string(),
                ..Default::default()
            })
        }

        #[test]
        fn forwarding_respects_port_role_mode_and_channel() {
            for port in [PTY_STREAM_PORT, DESKTOP_STREAM_PORT, 40_001] {
                for role in [Role::Client, Role::Agent] {
                    for granted in [false, true] {
                        let allowed = |message: &RelayMessage| {
                            may_forward_message(CHANNEL, port, role, granted, message)
                        };
                        let case = format!("port {port}, role {role:?}, control {granted}");
                        assert_eq!(
                            allowed(&frame(CHANNEL)),
                            role == Role::Agent || (port == PTY_STREAM_PORT && granted),
                            "Frame on {case}"
                        );
                        assert_eq!(
                            allowed(&desktop_input(CHANNEL)),
                            role == Role::Client && port == DESKTOP_STREAM_PORT && granted,
                            "DesktopInput on {case}"
                        );
                        assert_eq!(
                            allowed(&close(CHANNEL)),
                            role == Role::Agent || port != PTY_STREAM_PORT || granted,
                            "Close on {case}"
                        );
                        // A message naming another channel is never forwarded.
                        assert!(!allowed(&frame("channel-b")), "foreign Frame on {case}");
                        assert!(
                            !allowed(&desktop_input("channel-b")),
                            "foreign DesktopInput on {case}"
                        );
                        assert!(!allowed(&close("channel-b")), "foreign Close on {case}");
                        assert!(allowed(&RelayMessage::Open(v1::StreamOpen::default())));
                        assert!(allowed(
                            &RelayMessage::OpenAck(v1::StreamOpenAck::default())
                        ));
                    }
                }
            }
        }
    }
}
