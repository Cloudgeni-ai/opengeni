//! The relay listener — the wss server + health/metrics endpoints + the
//! per-connection handshake driver.
//!
//! Routes:
//!
//! * `GET /stream?ws=&agent=&port=&channel=` — the WebSocket dial both ends use.
//!   On upgrade the connection runs the [`handshake`](conn::handshake) → splice
//!   loop against the [`ChannelRegistry`].
//! * `GET /healthz` — liveness/readiness probe (always `200 ok` when serving).
//! * `GET /metrics` — the Prometheus-style operator aggregates.
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
}

/// Build the relay router over a registry + config.
pub fn router(registry: Arc<ChannelRegistry>, config: Arc<RelayConfig>) -> Router {
    let state = RelayState { registry, config };
    Router::new()
        .route("/stream", get(stream_upgrade))
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_handler))
        .with_state(state)
}

/// Serve the relay on `config.bind` until `shutdown` resolves. Spawns a background
/// reaper that bounds half-open channel state. Returns the bound address (useful
/// when binding to port 0 in tests).
///
/// # Errors
///
/// [`RelayError::Server`](crate::error::RelayError::Server) if the listener cannot
/// bind.
pub async fn serve(
    config: RelayConfig,
    metrics: RelayMetrics,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> crate::error::RelayResult<SocketAddr> {
    let registry = Arc::new(ChannelRegistry::new(&config, metrics));
    let config = Arc::new(config);
    let listener = TcpListener::bind(&config.bind)
        .await
        .map_err(|e| crate::error::RelayError::Server(format!("bind {}: {e}", config.bind)))?;
    let addr = listener
        .local_addr()
        .map_err(|e| crate::error::RelayError::Server(format!("local_addr: {e}")))?;
    tracing::info!(%addr, "relay listening");

    // The half-open reaper bounds transient state (a side that dialed but whose peer
    // never arrived). Cheap; runs every few seconds.
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

    let app = router(registry, config);
    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown);
    let result = server
        .await
        .map_err(|e| crate::error::RelayError::Server(format!("serve: {e}")));
    reaper.abort();
    result?;
    Ok(addr)
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

/// The dial query (`?ws=&agent=&port=&channel=`). The relay routes by `{ws, agent,
/// port}` (the [`ChannelKey`](opengeni_agent_stream::ChannelKey)); `channel` is the
/// control-plane channel-id hint (carried for correlation, not routing).
#[derive(Debug, serde::Deserialize)]
pub(crate) struct DialQuery {
    pub ws: String,
    pub agent: String,
    pub port: u32,
    #[serde(default)]
    pub channel: Option<String>,
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
    use opengeni_agent_stream::ChannelKey;

    use crate::registry::{AttachError, Role};
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

        // 2. Resolve + authorize the key (token + channel-key scope).
        let (key, role, resume_from_seq) = match authorize(&open, query, state) {
            Ok(parts) => parts,
            Err(reason) => {
                tracing::warn!(reason = %reason, ws = %query.ws, agent = %query.agent, port = query.port, "relay open rejected");
                state.registry.metrics().record_open_rejected();
                let _ = send_ack(ws_tx, false, 0, &reason).await;
                return None;
            }
        };

        // 3. Attach (the epoch fence is applied for a client), ack, replay.
        let now = Instant::now();
        let viewer_epoch: Option<u64> = match role {
            Role::Client => client_epoch(&open, state),
            Role::Agent => None,
        };
        let (peer_tx, peer_rx) = tokio::sync::mpsc::channel::<RelayMessage>(OUTBOUND_QUEUE);
        let attached =
            match state
                .registry
                .attach(&key, role, viewer_epoch, resume_from_seq, peer_tx, now)
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
            channel = query.channel.as_deref().unwrap_or(""), role = ?role,
            resume_from_seq, "relay channel attached"
        );
        if send_ack(ws_tx, true, attached.resume_from_seq, "")
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
                Ok(RelayMessage::Frame(frame)) => {
                    state
                        .registry
                        .forward(&est.key, est.role, frame, Instant::now());
                    true
                }
                Ok(msg @ RelayMessage::DesktopInput(_)) => {
                    // Typed computer-use input → forward verbatim.
                    state.registry.forward_message(&est.key, est.role, msg);
                    true
                }
                Ok(close @ RelayMessage::Close(_)) => {
                    state.registry.close(&est.key, est.role, close);
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
    ) -> Result<(ChannelKey, Role, u64), String> {
        let channel = open
            .channel
            .as_ref()
            .ok_or_else(|| "StreamOpen carried no channel key".to_string())?;

        // (a) The in-band channel key MUST match the dial query (defense in depth).
        if channel.workspace_id != query.ws
            || channel.agent_id != query.agent
            || channel.port != query.port
        {
            return Err("channel key does not match the dial query".to_string());
        }

        let key = ChannelKey {
            workspace_id: channel.workspace_id.clone(),
            agent_id: channel.agent_id.clone(),
            port: channel.port,
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
                // The epoch fence is applied at attach (the floor); see client_epoch.
            }
        }

        Ok((key, role, open.resume_from_seq))
    }

    /// The viewer epoch (the fence floor source) from the token. Returns None when
    /// the token does not re-verify (already authorized in `authorize`, so this is
    /// the steady-state extraction). Only called for a CLIENT.
    fn client_epoch(open: &v1::StreamOpen, state: &RelayState) -> Option<u64> {
        token::verify_stream_token(&state.config.stream_token_secret, &open.token, unix_now())
            .ok()
            .map(|c| c.lease_epoch)
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
        });
        write_msg(ws_tx, &ack).await
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
}
