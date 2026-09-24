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

/// The dial query (`?ws=&agent=&port=&channel=`). All four coordinates form the
/// routing key. `channel` distinguishes concurrent stream instances on the same
/// machine and logical port.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct DialQuery {
    pub ws: String,
    pub agent: String,
    pub port: u32,
    pub channel: String,
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
    use crate::token::{self, StreamTokenClaims, TokenError};

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
        // The verified token's control claim; the desktop-input rollout flag is
        // applied per-message (it gates only typed desktop input, never PTY).
        control_claim: bool,
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
        let (key, role, resume_from_seq, viewer, control_claim) = match authorize(
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
            control_claim,
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
                Ok(msg) => {
                    if !may_forward_message(
                        &est.key.channel_id,
                        est.key.port,
                        est.role,
                        est.control_claim,
                        state.config.stream_control_enabled,
                        &msg,
                    ) {
                        tracing::debug!(port = est.key.port, role = ?est.role, "relay: dropping unauthorized input");
                        return true;
                    }
                    match msg {
                        RelayMessage::Frame(frame) => {
                            state
                                .registry
                                .forward(&est.key, est.role, frame, Instant::now());
                            true
                        }
                        msg @ RelayMessage::DesktopInput(_) => {
                            // Typed computer-use input → forward verbatim.
                            state.registry.forward_message(&est.key, est.role, msg);
                            true
                        }
                        close @ RelayMessage::Close(_) => {
                            state.registry.close(&est.key, est.role, close);
                            false // channel torn down; this side is done.
                        }
                        // A duplicate Open/OpenAck mid-stream is ignored (already attached).
                        RelayMessage::Open(_) | RelayMessage::OpenAck(_) => true,
                    }
                }
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
                // Assert the workspace and port, then bind newer tokens to the exact
                // agent/channel key returned by the self-hosted stream producer.
                if claims.workspace_id != key.workspace_id {
                    return Err("viewer token workspace does not match the channel key".to_string());
                }
                if claims.port != key.port {
                    return Err("viewer token port does not match the channel key".to_string());
                }
                validate_viewer_channel_binding(&claims, &key)?;
                if claims.mode != "view" && claims.mode != "control" {
                    return Err("viewer token has an unsupported input mode".to_string());
                }
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
                    claims.mode == "control",
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

    fn validate_viewer_channel_binding(
        claims: &StreamTokenClaims,
        key: &ChannelKey,
    ) -> Result<(), String> {
        match (&claims.agent_id, &claims.channel_id) {
            (None, None) => Err("viewer token is missing a channel binding".to_string()),
            (Some(agent_id), Some(channel_id))
                if agent_id == &key.agent_id && channel_id == &key.channel_id =>
            {
                Ok(())
            }
            (Some(_), Some(_)) => {
                Err("viewer token channel does not match the channel key".to_string())
            }
            _ => Err("viewer token has an incomplete channel binding".to_string()),
        }
    }

    /// Classify by the token-bound port, never the peer's unverified kind label.
    /// Client Frames on the PTY port ARE terminal keystrokes gated by the
    /// verified control claim alone; DesktopInput is computer-use input and
    /// additionally requires the desktop-control rollout flag, so a view-mode
    /// token stays strictly read-only either way.
    fn may_forward_message(
        channel_id: &str,
        port: u32,
        role: Role,
        control_claim: bool,
        stream_control_enabled: bool,
        message: &RelayMessage,
    ) -> bool {
        match message {
            RelayMessage::Frame(frame) => {
                frame.channel_id == channel_id
                    && match role {
                        Role::Agent => true,
                        Role::Client => port == PTY_STREAM_PORT && control_claim,
                    }
            }
            RelayMessage::DesktopInput(input) => {
                input.channel_id == channel_id
                    && role == Role::Client
                    && port == DESKTOP_STREAM_PORT
                    && control_claim
                    && stream_control_enabled
            }
            RelayMessage::Close(close) => close.channel_id == channel_id,
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn channel_key() -> ChannelKey {
            ChannelKey {
                workspace_id: "workspace".to_string(),
                agent_id: "agent-a".to_string(),
                port: 6080,
                channel_id: "channel-a".to_string(),
            }
        }

        fn claims(agent_id: Option<&str>, channel_id: Option<&str>) -> StreamTokenClaims {
            StreamTokenClaims {
                workspace_id: "workspace".to_string(),
                session_id: "session".to_string(),
                viewer_id: "viewer".to_string(),
                lease_epoch: 1,
                mode: "view".to_string(),
                port: 6080,
                exp: 9_999_999_999,
                subject_id: None,
                authority_epoch: None,
                agent_id: agent_id.map(str::to_string),
                channel_id: channel_id.map(str::to_string),
            }
        }

        #[test]
        fn viewer_tokens_are_bound_to_their_agent_and_channel() {
            let key = channel_key();
            assert!(validate_viewer_channel_binding(
                &claims(Some("agent-a"), Some("channel-a")),
                &key
            )
            .is_ok());
            assert!(validate_viewer_channel_binding(
                &claims(Some("agent-b"), Some("channel-a")),
                &key
            )
            .is_err());
            assert!(validate_viewer_channel_binding(
                &claims(Some("agent-a"), Some("channel-b")),
                &key
            )
            .is_err());
            assert!(validate_viewer_channel_binding(&claims(Some("agent-a"), None), &key).is_err());
            assert!(validate_viewer_channel_binding(&claims(None, None), &key).is_err());
        }

        #[test]
        fn forwarding_respects_port_role_and_input_control() {
            let channel_id = "channel-a";
            let channel_frame = |channel: &str| {
                RelayMessage::Frame(v1::StreamFrame {
                    channel_id: channel.to_string(),
                    ..Default::default()
                })
            };
            let channel_input = |channel: &str| {
                RelayMessage::DesktopInput(v1::DesktopInput {
                    channel_id: channel.to_string(),
                    ..Default::default()
                })
            };
            let channel_close = |channel: &str| {
                RelayMessage::Close(v1::StreamClose {
                    channel_id: channel.to_string(),
                    ..Default::default()
                })
            };
            let frame = channel_frame(channel_id);
            let wrong_channel_frame = channel_frame("channel-b");
            let desktop_input = channel_input(channel_id);
            let wrong_channel_desktop_input = channel_input("channel-b");
            let lifecycle = [
                channel_close(channel_id),
                RelayMessage::Open(v1::StreamOpen::default()),
                RelayMessage::OpenAck(v1::StreamOpenAck::default()),
            ];
            let wrong_channel_close = channel_close("channel-b");
            for port in [PTY_STREAM_PORT, DESKTOP_STREAM_PORT, 9999] {
                for role in [Role::Client, Role::Agent] {
                    for control_claim in [false, true] {
                        for stream_control_enabled in [false, true] {
                            let forward = |message: &RelayMessage| {
                                may_forward_message(
                                    channel_id,
                                    port,
                                    role,
                                    control_claim,
                                    stream_control_enabled,
                                    message,
                                )
                            };
                            assert_eq!(
                                forward(&frame),
                                role == Role::Agent
                                    || (role == Role::Client
                                        && port == PTY_STREAM_PORT
                                        && control_claim),
                                "Frame on port {port}, role {role:?}, claim {control_claim}, flag {stream_control_enabled}"
                            );
                            assert_eq!(
                                forward(&desktop_input),
                                role == Role::Client
                                    && port == DESKTOP_STREAM_PORT
                                    && control_claim
                                    && stream_control_enabled,
                                "DesktopInput on port {port}, role {role:?}, claim {control_claim}, flag {stream_control_enabled}"
                            );
                            assert!(!forward(&wrong_channel_frame));
                            assert!(!forward(&wrong_channel_desktop_input));
                            for message in &lifecycle {
                                assert!(forward(message));
                            }
                            assert!(!forward(&wrong_channel_close));
                        }
                    }
                }
            }
        }
    }
}
