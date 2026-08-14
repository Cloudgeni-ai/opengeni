//! Browser-native frame pump: loopback browserd WebSocket → relay channel.

use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use opengeni_agent_proto::v1;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest as _,
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue},
        protocol::{Message, WebSocketConfig},
    },
    MaybeTlsStream, WebSocketStream,
};

use crate::{
    backoff::ChannelBackoff, channel::RelayChannel, codec::RelayMessage, error::StreamError,
};

const BROWSER_PROTOCOL: &str = "opengeni.browser.v1";
const COMPUTER_PROTOCOL: &str = "opengeni.computer.v1";
const BROWSER_AUTH_PREFIX: &str = "opengeni.auth.";
const MAX_BROWSER_FRAME_BYTES: usize = 24 * 1024 * 1024 + 64 * 1024 + 4;

type BrowserSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Opens a fenced browserd frame subscription. No browserd authority leaves the
/// machine: the short-lived view grant is presented only on this loopback socket.
///
/// # Errors
///
/// Returns a typed protocol error for invalid grants or negotiation, and a
/// transport error when the loopback browser controller cannot be reached.
pub async fn connect(
    browserd_port: u16,
    req: &v1::BrowserFramesOpenRequest,
) -> Result<BrowserSocket, StreamError> {
    connect_source(browserd_port, FrameSource::browser(req)).await
}

/// Opens the identical frame transport for a ComputerSession resource.
///
/// # Errors
///
/// Returns a typed protocol error for invalid grants or negotiation, and a
/// transport error when the loopback computer controller cannot be reached.
pub async fn connect_computer(
    browserd_port: u16,
    req: &v1::ComputerFramesOpenRequest,
) -> Result<BrowserSocket, StreamError> {
    connect_source(browserd_port, FrameSource::computer(req)).await
}

async fn connect_source(
    browserd_port: u16,
    source: FrameSource<'_>,
) -> Result<BrowserSocket, StreamError> {
    validate(&source)?;
    let url = interaction_frame_url(browserd_port, &source);
    let mut request = url
        .into_client_request()
        .map_err(|error| StreamError::Protocol(format!("browser frame URL: {error}")))?;
    let protocols = format!(
        "{}, {BROWSER_AUTH_PREFIX}{}",
        source.protocol, source.view_token
    );
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(&protocols)
            .map_err(|_| StreamError::Protocol("interaction view grant is invalid".to_string()))?,
    );
    let config = WebSocketConfig {
        max_message_size: Some(MAX_BROWSER_FRAME_BYTES),
        max_frame_size: Some(MAX_BROWSER_FRAME_BYTES),
        ..WebSocketConfig::default()
    };
    let (socket, response) =
        tokio_tungstenite::connect_async_with_config(request, Some(config), false)
            .await
            .map_err(|error| StreamError::Transport(format!("browser frame socket: {error}")))?;
    let negotiated = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if negotiated != Some(source.protocol) {
        return Err(StreamError::Protocol(
            "browser frame socket negotiated an incompatible protocol".to_string(),
        ));
    }
    Ok(socket)
}

/// Copies complete canonical browser frame messages to the relay. A relay blip
/// reconnects and retries the unsent frame; the browserd subscription stays live.
///
/// # Errors
///
/// Returns a typed protocol error for malformed browser frames, or a transport
/// error when either the local frame socket or relay cannot recover.
pub async fn run(
    mut socket: BrowserSocket,
    channel: &mut RelayChannel,
    mut ready: Option<oneshot::Sender<()>>,
) -> Result<(), StreamError> {
    let mut backoff = ChannelBackoff::standard();
    let mut receive_relay = true;
    loop {
        enum Event {
            Source(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
            Relay(Result<Option<RelayMessage>, StreamError>),
        }
        let event = if receive_relay {
            tokio::select! {
                source = socket.next() => Event::Source(source),
                relay = channel.recv() => Event::Relay(relay),
            }
        } else {
            Event::Source(socket.next().await)
        };
        let message = match event {
            Event::Relay(Ok(Some(RelayMessage::Close(_)))) | Event::Source(None) => return Ok(()),
            Event::Relay(Ok(Some(_))) => continue,
            // A transport drop is still recovered by the established outbound
            // reconnect path on the next local frame. Avoid polling the dead
            // inbound half until that send succeeds.
            Event::Relay(Ok(None) | Err(_)) => {
                receive_relay = false;
                continue;
            }
            Event::Source(Some(message)) => message.map_err(|error| {
                StreamError::Transport(format!("browser frame socket: {error}"))
            })?,
        };
        match message {
            Message::Binary(frame) => {
                if frame.is_empty() || frame.len() > MAX_BROWSER_FRAME_BYTES {
                    return Err(StreamError::Protocol(
                        "browserd emitted an invalid browser frame size".to_string(),
                    ));
                }
                send_with_reconnect(channel, Bytes::from(frame), &mut backoff).await?;
                receive_relay = true;
                if let Some(sender) = ready.take() {
                    let _ = sender.send(());
                }
            }
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .map_err(|error| StreamError::Transport(format!("browser frame pong: {error}")))?,
            Message::Close(frame) => {
                if ready.is_some() {
                    let reason = frame
                        .as_ref()
                        .map_or("without a reason", |frame| frame.reason.as_ref());
                    return Err(StreamError::Protocol(format!(
                        "browserd frame source closed before its first frame: {reason}"
                    )));
                }
                return Ok(());
            }
            Message::Pong(_) => {}
            Message::Text(_) | Message::Frame(_) => {
                return Err(StreamError::Protocol(
                    "browserd emitted a non-binary browser frame".to_string(),
                ));
            }
        }
    }
}

async fn send_with_reconnect(
    channel: &mut RelayChannel,
    frame: Bytes,
    backoff: &mut ChannelBackoff,
) -> Result<(), StreamError> {
    loop {
        match channel.send_frame(frame.clone()).await {
            Ok(_) => {
                backoff.reset();
                return Ok(());
            }
            Err(error) if error.retryable() => {
                tracing::warn!(%error, "browser relay channel dropped; reconnecting");
                loop {
                    match channel.reconnect(backoff.next_delay()).await {
                        Ok(()) => break,
                        Err(reconnect) if reconnect.retryable() => {
                            tracing::warn!(error = %reconnect, "browser relay reconnect failed");
                        }
                        Err(reconnect) => return Err(reconnect),
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
}

#[derive(Clone, Copy)]
struct FrameSource<'a> {
    resource_segment: &'static str,
    resource_label: &'static str,
    protocol: &'static str,
    session_id: &'a str,
    controller_generation: &'a str,
    target_id: &'a str,
    view_token: &'a str,
    expires_at_ms: i64,
    format: &'a str,
    quality: u32,
    max_width: u32,
    max_height: u32,
    every_nth_frame: u32,
}

impl<'a> FrameSource<'a> {
    fn browser(req: &'a v1::BrowserFramesOpenRequest) -> Self {
        Self {
            resource_segment: "browser-sessions",
            resource_label: "browser",
            protocol: BROWSER_PROTOCOL,
            session_id: &req.browser_session_id,
            controller_generation: &req.controller_generation,
            target_id: &req.target_id,
            view_token: &req.view_token,
            expires_at_ms: req.expires_at_ms,
            format: &req.format,
            quality: req.quality,
            max_width: req.max_width,
            max_height: req.max_height,
            every_nth_frame: req.every_nth_frame,
        }
    }

    fn computer(req: &'a v1::ComputerFramesOpenRequest) -> Self {
        Self {
            resource_segment: "computer-sessions",
            resource_label: "computer",
            protocol: COMPUTER_PROTOCOL,
            session_id: &req.computer_session_id,
            controller_generation: &req.controller_generation,
            target_id: &req.target_id,
            view_token: &req.view_token,
            expires_at_ms: req.expires_at_ms,
            format: &req.format,
            quality: req.quality,
            max_width: req.max_width,
            max_height: req.max_height,
            every_nth_frame: req.every_nth_frame,
        }
    }
}

#[cfg(test)]
fn frame_url(port: u16, req: &v1::BrowserFramesOpenRequest) -> String {
    interaction_frame_url(port, &FrameSource::browser(req))
}

fn interaction_frame_url(port: u16, source: &FrameSource<'_>) -> String {
    let mut url = format!(
        "ws://127.0.0.1:{port}/v1/{}/{}/targets/{}/frames?format={}&quality={}&maxWidth={}&maxHeight={}&everyNthFrame={}",
        source.resource_segment,
        percent_encode(source.session_id),
        percent_encode(source.target_id),
        percent_encode(source.format),
        source.quality,
        source.max_width,
        source.max_height,
        source.every_nth_frame,
    );
    // The controller generation is part of the browserd URL authority fence.
    url.push_str("&controllerGeneration=");
    url.push_str(&percent_encode(source.controller_generation));
    url
}

fn validate(source: &FrameSource<'_>) -> Result<(), StreamError> {
    for (value, label, maximum) in [
        (
            source.session_id,
            if source.resource_label == "browser" {
                "browser session id"
            } else {
                "computer session id"
            },
            128_usize,
        ),
        (
            source.controller_generation,
            "interaction controller generation",
            512,
        ),
        (source.target_id, "interaction target id", 512),
    ] {
        if value.is_empty()
            || value.len() > maximum
            || value.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(StreamError::Protocol(format!("{label} is invalid")));
        }
    }
    if source.view_token.len() < 32
        || source.view_token.len() > 2_048
        || !source
            .view_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err(StreamError::Protocol(
            "interaction view grant is invalid".to_string(),
        ));
    }
    if !matches!(source.format, "jpeg" | "png")
        || !(1..=100).contains(&source.quality)
        || !(1..=4_096).contains(&source.max_width)
        || !(1..=4_096).contains(&source.max_height)
        || !(1..=60).contains(&source.every_nth_frame)
    {
        return Err(StreamError::Protocol(
            "interaction frame options are invalid".to_string(),
        ));
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        });
    if source.expires_at_ms <= now_ms || source.expires_at_ms > now_ms.saturating_add(10 * 60_000) {
        return Err(StreamError::Protocol(
            "interaction view grant expiry is invalid".to_string(),
        ));
    }
    Ok(())
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        channel::{ChannelConfig, RelayChannel},
        codec::RelayMessage,
        transport::{mock::MockTransport, RelayTransport as _},
    };
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    #[test]
    fn frame_url_encodes_every_untrusted_path_and_query_value() {
        let req = v1::BrowserFramesOpenRequest {
            browser_session_id: "session/id".to_string(),
            controller_generation: "generation value".to_string(),
            target_id: "target?x".to_string(),
            view_token: "a".repeat(32),
            expires_at_ms: i64::MAX,
            format: "jpeg".to_string(),
            quality: 70,
            max_width: 1_440,
            max_height: 900,
            every_nth_frame: 2,
            ..Default::default()
        };
        let url = frame_url(1234, &req);
        assert!(url.contains("session%2Fid"));
        assert!(url.contains("target%3Fx"));
        assert!(url.contains("generation%20value"));

        let computer = v1::ComputerFramesOpenRequest {
            computer_session_id: "computer/session".to_string(),
            controller_generation: "computer generation".to_string(),
            target_id: "window?one".to_string(),
            view_token: "c".repeat(32),
            expires_at_ms: i64::MAX,
            format: "png".to_string(),
            quality: 80,
            max_width: 1_200,
            max_height: 800,
            every_nth_frame: 1,
            ..Default::default()
        };
        let url = interaction_frame_url(4321, &FrameSource::computer(&computer));
        assert!(
            url.contains("/v1/computer-sessions/computer%2Fsession/targets/window%3Fone/frames")
        );
        assert!(url.contains("computer%20generation"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::result_large_err)] // tungstenite's test handshake callback owns this type.
    async fn loopback_browser_frames_are_authenticated_and_forwarded_byte_exact() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind browserd double");
        let port = listener.local_addr().expect("browserd address").port();
        let expected_frame = Bytes::from_static(b"canonical-browser-frame");
        let server_frame = expected_frame.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept browserd client");
            let mut socket = accept_hdr_async(tcp, |request: &Request, mut response: Response| {
                let protocols = request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                assert!(protocols.contains(BROWSER_PROTOCOL));
                assert!(protocols.contains(&format!("{BROWSER_AUTH_PREFIX}{}", "v".repeat(32))));
                assert!(request
                    .uri()
                    .path()
                    .contains("/session%2Fone/targets/target%3Fone/frames"));
                response.headers_mut().insert(
                    SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_static(BROWSER_PROTOCOL),
                );
                Ok(response)
            })
            .await
            .expect("browserd websocket handshake");
            socket
                .send(Message::Binary(server_frame.to_vec()))
                .await
                .expect("send browser frame");
            socket
                .close(None)
                .await
                .expect("close browser frame source");
        });

        let req = v1::BrowserFramesOpenRequest {
            browser_session_id: "session/one".to_string(),
            controller_generation: "controller-one".to_string(),
            target_id: "target?one".to_string(),
            view_token: "v".repeat(32),
            expires_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_millis()
                .saturating_add(60_000)
                .try_into()
                .expect("expiry"),
            format: "jpeg".to_string(),
            quality: 70,
            max_width: 1_440,
            max_height: 900,
            every_nth_frame: 1,
            ..Default::default()
        };
        let socket = connect(port, &req)
            .await
            .expect("connect browser frame source");
        let (agent_side, mut relay_side) = MockTransport::pair();
        let config = ChannelConfig {
            channel: v1::StreamChannel {
                channel_id: "browser-channel".to_string(),
                workspace_id: "workspace".to_string(),
                agent_id: "agent".to_string(),
                kind: v1::StreamKind::Browser as i32,
                port: 20_001,
            },
            token: "producer-token".to_string(),
            relay_url: "wss://relay.invalid/stream".to_string(),
        };
        let mut channel = RelayChannel::with_transport(config, Box::new(agent_side));
        let (ready_tx, ready_rx) = oneshot::channel();
        let pump = tokio::spawn(async move { run(socket, &mut channel, Some(ready_tx)).await });

        let relayed = tokio::time::timeout(Duration::from_secs(2), relay_side.recv())
            .await
            .expect("relay receive timeout")
            .expect("relay receive")
            .expect("relay message");
        let RelayMessage::Frame(frame) = relayed else {
            panic!("expected relay frame");
        };
        assert_eq!(frame.channel_id, "browser-channel");
        assert_eq!(frame.seq, 0);
        assert_eq!(frame.data, expected_frame);
        ready_rx.await.expect("pump readiness");
        pump.await.expect("pump task").expect("browser pump");
        server.await.expect("browserd double");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::result_large_err)]
    async fn loopback_computer_frames_use_computer_protocol_and_resource_path() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind browserd computer double");
        let port = listener.local_addr().expect("browserd address").port();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept browserd client");
            let mut socket = accept_hdr_async(tcp, |request: &Request, mut response: Response| {
                let protocols = request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                assert!(protocols.contains(COMPUTER_PROTOCOL));
                assert!(protocols.contains(&format!("{BROWSER_AUTH_PREFIX}{}", "c".repeat(32))));
                assert!(request
                    .uri()
                    .path()
                    .contains("/v1/computer-sessions/computer%2Fone/targets/window%3Fone/frames"));
                response.headers_mut().insert(
                    SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_static(COMPUTER_PROTOCOL),
                );
                Ok(response)
            })
            .await
            .expect("browserd computer websocket handshake");
            socket
                .send(Message::Binary(b"canonical-computer-frame".to_vec()))
                .await
                .expect("send computer frame");
            socket
                .close(None)
                .await
                .expect("close computer frame source");
        });

        let req = v1::ComputerFramesOpenRequest {
            computer_session_id: "computer/one".to_string(),
            controller_generation: "controller-one".to_string(),
            target_id: "window?one".to_string(),
            view_token: "c".repeat(32),
            expires_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_millis()
                .saturating_add(60_000)
                .try_into()
                .expect("expiry"),
            format: "png".to_string(),
            quality: 80,
            max_width: 1_200,
            max_height: 800,
            every_nth_frame: 1,
            ..Default::default()
        };
        let mut socket = connect_computer(port, &req)
            .await
            .expect("connect computer frame source");
        let message = socket
            .next()
            .await
            .expect("computer frame")
            .expect("computer frame socket");
        assert_eq!(message.into_data(), b"canonical-computer-frame");
        server.await.expect("browserd computer double");
    }
}
