//! Local relay e2e (NO k8s) — a real `opengeni-relay` process (in-process `serve`
//! on an ephemeral port) + a real PRODUCER (the `opengeni-agent-stream`
//! `RelayChannel`, the agent's own relay client, dialing real wss) + a real
//! CONSUMER (a viewer dialing raw `tokio-tungstenite` wss). It proves, over real
//! sockets through the actual relay code:
//!
//!   1. SPLICE: a frame the producer ships arrives at the viewer, and viewer input
//!      arrives at the producer (bidirectional, end-to-end).
//!   2. RESUME: a producer that drops + reconnects with `resume_from_seq` resumes;
//!      a viewer reconnecting replays the buffered tail.
//!   3. EPOCH FENCE: a stale-epoch viewer token is REJECTED (cannot reach a
//!      swapped-away box).
//!   4. CROSS-CHANNEL ISOLATION: channel A's viewer never sees channel B's frames.
//!   5. RATE LIMIT / BACKPRESSURE: a frame over the per-token byte budget is shed +
//!      observable on the metrics.
//!
//! The tokens are minted with the SAME HMAC envelope the relay verifies (the §10.5
//! contract — the cross-stack agreement with the TS mint is proven separately in
//! `cross_stack_token.rs`).

use std::net::SocketAddr;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use hmac::{Hmac, Mac};
use opengeni_agent_proto::v1;
use opengeni_agent_stream::channel::{ChannelConfig, RelayChannel};
use opengeni_agent_stream::codec::RelayMessage;
use opengeni_agent_stream::{DESKTOP_STREAM_PORT, PTY_STREAM_PORT};
use opengeni_relay::{serve, RelayConfig, RelayMetrics};
use sha2::Sha256;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type HmacSha256 = Hmac<Sha256>;

const SECRET: &str = "relay-e2e-secret";
const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const AGENT: &str = "44444444-4444-4444-8444-444444444444";

fn stream_kind(port: u32) -> v1::StreamKind {
    match port {
        PTY_STREAM_PORT => v1::StreamKind::Pty,
        DESKTOP_STREAM_PORT => v1::StreamKind::Desktop,
        _ => v1::StreamKind::Unspecified,
    }
}

fn desktop_input(channel_id: &str) -> RelayMessage {
    RelayMessage::DesktopInput(v1::DesktopInput {
        channel_id: channel_id.to_string(),
        event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
            key: "hello".to_string(),
            is_text: true,
            action: v1::KeyAction::Press as i32,
        })),
    })
}

/// Mint a token with the `ogs_`/`ogr_` HMAC envelope (the relay's verify mirror).
fn mint(prefix: &str, payload_json: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload_json);
    let mut mac = HmacSha256::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(encoded.as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{prefix}{encoded}.{sig}")
}

fn agent_token() -> String {
    mint(
        "ogr_",
        &format!(r#"{{"workspaceId":"{WORKSPACE}","agentId":"{AGENT}","exp":4102444800}}"#),
    )
}

fn viewer_token(epoch: u64, port: u32, mode: &str, agent_id: &str, channel_id: &str) -> String {
    mint(
        "ogs_",
        &format!(
            r#"{{"workspaceId":"{WORKSPACE}","sessionId":"22222222-2222-4222-8222-222222222222","viewerId":"33333333-3333-4333-8333-333333333333","leaseEpoch":{epoch},"mode":"{mode}","port":{port},"exp":4102444800,"agentId":"{agent_id}","channelId":"{channel_id}"}}"#
        ),
    )
}

/// Reserve an ephemeral localhost port (close the probe listener so `serve` can
/// rebind it — a tiny race window that is fine for a test).
async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

/// Start the relay on an explicit port + return (base_ws_url, shutdown, metrics).
async fn start_relay_on(
    port: u16,
    tune: impl FnOnce(&mut RelayConfig),
) -> (String, tokio::sync::oneshot::Sender<()>, RelayMetrics) {
    let mut config = RelayConfig::for_test(SECRET);
    config.bind = format!("127.0.0.1:{port}");
    tune(&mut config);
    let metrics = RelayMetrics::new();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let m = metrics.clone();
    tokio::spawn(async move {
        let _ = serve(config, m, async {
            let _ = rx.await;
        })
        .await;
    });
    // Wait for the listener to accept connections.
    let base = format!("ws://127.0.0.1:{port}/stream");
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    (base, tx, metrics)
}

/// Build the producer's channel config (the agent's RelayChannel dials this).
fn producer_config(base: &str, port: u32) -> ChannelConfig {
    ChannelConfig {
        channel: v1::StreamChannel {
            channel_id: format!("ch-{port}"),
            workspace_id: WORKSPACE.to_string(),
            agent_id: AGENT.to_string(),
            kind: stream_kind(port) as i32,
            port,
        },
        token: agent_token(),
        relay_url: base.to_string(),
    }
}

/// A raw peer, normally a viewer, with explicit agent role for adversarial tests.
struct Viewer {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    channel_id: String,
}

impl Viewer {
    async fn connect(
        base: &str,
        port: u32,
        epoch: u64,
        resume_from_seq: u64,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        let channel_id = format!("ch-{port}");
        let token = viewer_token(epoch, port, "view", AGENT, &channel_id);
        Self::connect_with_channel_and_token(base, port, resume_from_seq, channel_id, token).await
    }

    async fn connect_with_mode(
        base: &str,
        port: u32,
        epoch: u64,
        resume_from_seq: u64,
        mode: &str,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        let channel_id = format!("ch-{port}");
        let token = viewer_token(epoch, port, mode, AGENT, &channel_id);
        Self::connect_with_channel_and_token(base, port, resume_from_seq, channel_id, token).await
    }

    async fn connect_with_channel_and_token(
        base: &str,
        port: u32,
        resume_from_seq: u64,
        channel_id: String,
        token: String,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        Self::connect_with_role(
            base,
            port,
            resume_from_seq,
            channel_id,
            token,
            v1::StreamRole::Client,
        )
        .await
    }

    async fn connect_with_role(
        base: &str,
        port: u32,
        resume_from_seq: u64,
        channel_id: String,
        token: String,
        role: v1::StreamRole,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        let url = format!("{base}?ws={WORKSPACE}&agent={AGENT}&port={port}&channel={channel_id}");
        let (mut socket, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("dial: {e}"))?;
        let open = RelayMessage::Open(v1::StreamOpen {
            channel: Some(v1::StreamChannel {
                channel_id: channel_id.clone(),
                workspace_id: WORKSPACE.to_string(),
                agent_id: AGENT.to_string(),
                kind: stream_kind(port) as i32,
                port,
            }),
            token,
            role: role as i32,
            resume_from_seq,
        });
        socket
            .send(WsMessage::Binary(open.encode()))
            .await
            .map_err(|e| format!("send open: {e}"))?;
        // Await the ack.
        match next_msg(&mut socket).await {
            Some(RelayMessage::OpenAck(ack)) => Ok((Self { socket, channel_id }, ack)),
            other => Err(format!("expected OpenAck, got {other:?}")),
        }
    }

    async fn recv_frame(&mut self) -> Option<v1::StreamFrame> {
        loop {
            match next_msg(&mut self.socket).await {
                Some(RelayMessage::Frame(f)) => return Some(f),
                Some(_) => {}
                None => return None,
            }
        }
    }

    async fn send_frame(&mut self, seq: u64, data: &[u8]) {
        let frame = RelayMessage::Frame(v1::StreamFrame {
            channel_id: self.channel_id.clone(),
            seq,
            data: prost::bytes::Bytes::copy_from_slice(data),
            produced_at_ms: 0,
        });
        self.socket
            .send(WsMessage::Binary(frame.encode()))
            .await
            .unwrap();
    }
}

/// Read + decode the next binary relay message from a raw socket.
async fn next_msg(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Option<RelayMessage> {
    loop {
        match socket.next().await {
            Some(Ok(WsMessage::Binary(bytes))) => return RelayMessage::decode(&bytes).ok(),
            Some(Ok(WsMessage::Close(_)) | Err(_)) | None => return None,
            // A ping/pong/text/other frame: keep reading for the next binary.
            Some(Ok(_)) => {}
        }
    }
}

// ===========================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn view_mode_pty_frames_reach_the_viewer_but_viewer_input_is_dropped() {
    let port = free_port().await;
    let (base, _shutdown, _m) = start_relay_on(port, |config| {
        config.stream_control_enabled = false;
    })
    .await;

    // Producer (agent) registers.
    let mut producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .expect("producer register");
    // A view-mode viewer still attaches and receives the terminal output tail.
    let (mut viewer, ack) = Viewer::connect(&base, PTY_STREAM_PORT, 0, 0)
        .await
        .expect("viewer connect");
    assert!(ack.accepted, "viewer open must be accepted");

    // Producer → viewer.
    producer
        .send_frame(prost::bytes::Bytes::from_static(b"hello-tty"))
        .await
        .expect("producer send");
    let got = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("viewer recv timed out")
        .expect("viewer frame");
    assert_eq!(&got.data[..], b"hello-tty");

    // Viewer → producer: PTY frames ARE keystrokes, so a view-mode token's
    // input must never reach the tty.
    viewer.send_frame(0, b"keystroke").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "a view token must not forward terminal input"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn control_mode_pty_frames_reach_the_producer_with_desktop_flag_off() {
    let port = free_port().await;
    // Terminal keystrokes ride on the control claim alone: the desktop-control
    // rollout flag must never mute an authorized PTY client.
    let (base, _shutdown, _m) = start_relay_on(port, |config| {
        config.stream_control_enabled = false;
    })
    .await;

    let mut producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .expect("producer register");
    let (mut viewer, ack) = Viewer::connect_with_mode(&base, PTY_STREAM_PORT, 0, 0, "control")
        .await
        .expect("control viewer connect");
    assert!(ack.accepted);

    viewer.send_frame(0, b"keystroke").await;
    let inbound = tokio::time::timeout(Duration::from_secs(5), producer.recv())
        .await
        .expect("producer recv timed out")
        .expect("producer recv ok");
    match inbound {
        Some(RelayMessage::Frame(f)) => assert_eq!(&f.data[..], b"keystroke"),
        other => panic!("expected an input frame, got {other:?}"),
    }

    producer
        .send_frame(prost::bytes::Bytes::from_static(b"tty-out"))
        .await
        .expect("producer send");
    let got = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("viewer recv timed out")
        .expect("viewer frame");
    assert_eq!(&got.data[..], b"tty-out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_view_tokens_reject_input_preserve_output_and_enforce_channel_binding() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = true;
    })
    .await;
    let mut producer = RelayChannel::register(producer_config(&base, DESKTOP_STREAM_PORT))
        .await
        .expect("producer register");

    let (mut viewer, view_ack) = Viewer::connect(&base, DESKTOP_STREAM_PORT, 0, 0)
        .await
        .expect("view-only viewer connect");
    assert!(view_ack.accepted);
    viewer.send_frame(0, b"unauthorized input").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "a view token must not forward viewer input"
    );
    viewer
        .socket
        .send(WsMessage::Binary(
            desktop_input(&viewer.channel_id).encode(),
        ))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "a view token must not forward desktop input"
    );

    producer
        .send_frame(prost::bytes::Bytes::from_static(b"view output"))
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("view output timed out")
        .expect("view output frame");
    assert_eq!(&output.data[..], b"view output");

    let channel_mismatch = viewer_token(0, DESKTOP_STREAM_PORT, "view", AGENT, "another-channel");
    let (_viewer, mismatch_ack) = Viewer::connect_with_channel_and_token(
        &base,
        DESKTOP_STREAM_PORT,
        0,
        format!("ch-{DESKTOP_STREAM_PORT}"),
        channel_mismatch,
    )
    .await
    .expect("the relay returns a rejected open ack");
    assert!(!mismatch_ack.accepted);

    let agent_mismatch = viewer_token(
        0,
        DESKTOP_STREAM_PORT,
        "view",
        "55555555-5555-4555-8555-555555555555",
        &format!("ch-{DESKTOP_STREAM_PORT}"),
    );
    let (_viewer, mismatch_ack) = Viewer::connect_with_channel_and_token(
        &base,
        DESKTOP_STREAM_PORT,
        0,
        format!("ch-{DESKTOP_STREAM_PORT}"),
        agent_mismatch,
    )
    .await
    .expect("the relay returns a rejected open ack");
    assert!(!mismatch_ack.accepted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_control_flag_off_blocks_desktop_control_claim_but_preserves_output() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = false;
    })
    .await;

    let mut producer = RelayChannel::register(producer_config(&base, DESKTOP_STREAM_PORT))
        .await
        .expect("producer register");
    let (mut viewer, ack) = Viewer::connect_with_mode(&base, DESKTOP_STREAM_PORT, 0, 0, "control")
        .await
        .expect("control-claim viewer connect");
    assert!(ack.accepted);

    viewer.send_frame(0, b"disabled input").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "raw desktop Frame input is forbidden even with a control claim"
    );
    viewer
        .socket
        .send(WsMessage::Binary(
            desktop_input(&viewer.channel_id).encode(),
        ))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "the relay feature flag must block DesktopInput even with a control claim"
    );

    producer
        .send_frame(prost::bytes::Bytes::from_static(b"view output"))
        .await
        .expect("producer output remains available");
    let output = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("view output timed out")
        .expect("view output frame");
    assert_eq!(&output.data[..], b"view output");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authorized_desktop_control_forwards_only_typed_input() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = true;
    })
    .await;
    let mut producer = RelayChannel::register(producer_config(&base, DESKTOP_STREAM_PORT))
        .await
        .expect("producer register");
    let (mut viewer, ack) = Viewer::connect_with_mode(&base, DESKTOP_STREAM_PORT, 0, 0, "control")
        .await
        .expect("control viewer connect");
    assert!(ack.accepted);

    // A control claim never permits the untyped desktop input path.
    viewer.send_frame(0, b"forged raw desktop input").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "raw desktop frames must not reach the producer"
    );
    let input = desktop_input(&viewer.channel_id);
    viewer
        .socket
        .send(WsMessage::Binary(input.encode()))
        .await
        .unwrap();
    let received = tokio::time::timeout(Duration::from_secs(5), producer.recv())
        .await
        .expect("typed desktop input timed out")
        .expect("producer recv ok")
        .expect("typed desktop input");
    assert_eq!(received.encode(), input.encode());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_input_with_a_different_channel_id_is_dropped() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = true;
    })
    .await;
    let mut producer = RelayChannel::register(producer_config(&base, DESKTOP_STREAM_PORT))
        .await
        .expect("producer register");
    let (mut viewer, ack) = Viewer::connect_with_mode(&base, DESKTOP_STREAM_PORT, 0, 0, "control")
        .await
        .expect("control viewer connect");
    assert!(ack.accepted);

    viewer
        .socket
        .send(WsMessage::Binary(desktop_input("another-channel").encode()))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), producer.recv())
            .await
            .is_err(),
        "desktop input bound to a different channel must not reach the agent"
    );

    let input = desktop_input(&viewer.channel_id);
    viewer
        .socket
        .send(WsMessage::Binary(input.encode()))
        .await
        .unwrap();
    let received = tokio::time::timeout(Duration::from_secs(5), producer.recv())
        .await
        .expect("authorized desktop input timed out")
        .expect("producer recv ok")
        .expect("authorized desktop input");
    assert_eq!(received.encode(), input.encode());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_input_is_rejected_on_pty_and_unknown_ports_even_with_control() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = true;
    })
    .await;
    for channel_port in [PTY_STREAM_PORT, 9999] {
        let mut producer = RelayChannel::register(producer_config(&base, channel_port))
            .await
            .expect("producer register");
        let (mut viewer, ack) = Viewer::connect_with_mode(&base, channel_port, 0, 0, "control")
            .await
            .expect("viewer connect");
        assert!(ack.accepted);
        viewer
            .socket
            .send(WsMessage::Binary(
                desktop_input(&viewer.channel_id).encode(),
            ))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), producer.recv())
                .await
                .is_err(),
            "DesktopInput must be rejected on port {channel_port}"
        );
        if channel_port != PTY_STREAM_PORT {
            viewer.send_frame(0, b"unknown channel input").await;
            assert!(
                tokio::time::timeout(Duration::from_millis(250), producer.recv())
                    .await
                    .is_err(),
                "unknown ports must reject raw client frames"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn agent_desktop_input_is_rejected_but_frames_and_close_are_forwarded() {
    let port = free_port().await;
    let (base, _shutdown, _metrics) = start_relay_on(port, |config| {
        config.stream_control_enabled = true;
    })
    .await;
    for channel_port in [PTY_STREAM_PORT, DESKTOP_STREAM_PORT, 9999] {
        let (mut producer, ack) = Viewer::connect_with_role(
            &base,
            channel_port,
            0,
            format!("ch-{channel_port}"),
            agent_token(),
            v1::StreamRole::Agent,
        )
        .await
        .expect("raw agent connect");
        assert!(ack.accepted);
        let (mut viewer, ack) = Viewer::connect(&base, channel_port, 0, 0).await.unwrap();
        assert!(ack.accepted);
        producer
            .socket
            .send(WsMessage::Binary(
                desktop_input(&producer.channel_id).encode(),
            ))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), next_msg(&mut viewer.socket))
                .await
                .is_err(),
            "agent DesktopInput must be rejected on port {channel_port}"
        );
        let wrong_channel_frame = RelayMessage::Frame(v1::StreamFrame {
            channel_id: format!("forged-channel-{channel_port}"),
            seq: 0,
            data: b"forged channel frame".to_vec().into(),
            ..Default::default()
        });
        producer
            .socket
            .send(WsMessage::Binary(wrong_channel_frame.encode()))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), next_msg(&mut viewer.socket))
                .await
                .is_err(),
            "frames bound to another channel must not reach the viewer"
        );
        producer.send_frame(0, b"agent output").await;
        let output = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
            .await
            .expect("agent output timed out")
            .expect("agent output frame");
        assert_eq!(&output.data[..], b"agent output");

        // A view-mode peer can still close even when input is forbidden.
        let close = RelayMessage::Close(v1::StreamClose {
            channel_id: viewer.channel_id.clone(),
            ..Default::default()
        });
        let wrong_channel_close = RelayMessage::Close(v1::StreamClose {
            channel_id: format!("forged-channel-{channel_port}"),
            ..Default::default()
        });
        viewer
            .socket
            .send(WsMessage::Binary(wrong_channel_close.encode()))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), next_msg(&mut producer.socket))
                .await
                .is_err(),
            "a close bound to another channel must not tear down the attached channel"
        );
        viewer
            .socket
            .send(WsMessage::Binary(close.encode()))
            .await
            .unwrap();
        let received = tokio::time::timeout(Duration::from_secs(5), next_msg(&mut producer.socket))
            .await
            .expect("close timed out")
            .expect("close message");
        assert_eq!(received.encode(), close.encode());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_epoch_viewer_is_rejected() {
    let port = free_port().await;
    let (base, _shutdown, metrics) = start_relay_on(port, |_| {}).await;

    let _producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .expect("producer register");

    // A viewer at epoch 5 advances the floor.
    let (_v5, ack5) = Viewer::connect(&base, PTY_STREAM_PORT, 5, 0)
        .await
        .expect("epoch5");
    assert!(ack5.accepted);

    // A viewer at epoch 4 (a swapped-away generation) is REJECTED.
    let (_stale, stale_ack) = Viewer::connect(&base, PTY_STREAM_PORT, 4, 0)
        .await
        .expect("connect (the dial succeeds; the ACK rejects)");
    assert!(!stale_ack.accepted, "a stale-epoch viewer must be rejected");
    assert!(metrics.opens_rejected() >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cross_channel_isolation() {
    let port = free_port().await;
    let (base, _shutdown, _m) = start_relay_on(port, |_| {}).await;

    // Channel A (port 7681) + channel B (port 6080), each its own producer + viewer.
    let mut prod_a = RelayChannel::register(producer_config(&base, 7681))
        .await
        .unwrap();
    let _prod_b = RelayChannel::register(producer_config(&base, 6080))
        .await
        .unwrap();
    let (mut viewer_a, _) = Viewer::connect(&base, 7681, 0, 0).await.unwrap();
    let (mut viewer_b, _) = Viewer::connect(&base, 6080, 0, 0).await.unwrap();

    // A frame on channel A reaches A's viewer.
    prod_a
        .send_frame(prost::bytes::Bytes::from_static(b"secretA"))
        .await
        .unwrap();
    let got_a = tokio::time::timeout(Duration::from_secs(5), viewer_a.recv_frame())
        .await
        .expect("A timed out")
        .unwrap();
    assert_eq!(&got_a.data[..], b"secretA");

    // B's viewer sees NOTHING from A (within a short window).
    let leak = tokio::time::timeout(Duration::from_millis(400), viewer_b.recv_frame()).await;
    assert!(
        leak.is_err(),
        "channel B's viewer must not receive channel A's frames"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn viewer_reconnect_replays_the_buffered_tail() {
    let port = free_port().await;
    let (base, _shutdown, _m) = start_relay_on(port, |_| {}).await;

    let mut producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_STREAM_PORT, 0, 0).await.unwrap();

    // Producer ships 3 frames; the viewer consumes the first.
    for s in 0..3u64 {
        producer
            .send_frame(prost::bytes::Bytes::from(format!("f{s}")))
            .await
            .unwrap();
    }
    let first = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("first")
        .unwrap();
    assert_eq!(first.seq, 0);

    // The viewer drops + reconnects resuming from seq 1 → the relay replays f1, f2
    // from the ring (a relay/viewer blip is invisible).
    drop(viewer);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut viewer2, ack) = Viewer::connect(&base, PTY_STREAM_PORT, 0, 1).await.unwrap();
    assert!(ack.accepted);
    let replay1 = tokio::time::timeout(Duration::from_secs(5), viewer2.recv_frame())
        .await
        .expect("replay1")
        .unwrap();
    let replay2 = tokio::time::timeout(Duration::from_secs(5), viewer2.recv_frame())
        .await
        .expect("replay2")
        .unwrap();
    let mut seqs = [replay1.seq, replay2.seq];
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        [1, 2],
        "reconnect replays the buffered tail from resume_from_seq"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limit_sheds_oversized_traffic_and_is_observable() {
    let port = free_port().await;
    // A tiny per-token byte budget so a couple of frames exhaust it.
    let (base, _shutdown, metrics) = start_relay_on(port, |c| {
        c.rate_burst_bytes = 8; // 8 bytes burst
        c.rate_bytes_per_sec = 0; // no refill within the test
    })
    .await;

    let mut producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_STREAM_PORT, 0, 0).await.unwrap();

    // First small frame (4 bytes) fits the 8-byte burst.
    producer
        .send_frame(prost::bytes::Bytes::from_static(b"abcd"))
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame()).await;

    // Now blast several frames that exceed the remaining budget → shed + counted.
    for _ in 0..5 {
        producer
            .send_frame(prost::bytes::Bytes::from_static(b"too-much-traffic"))
            .await
            .unwrap();
    }
    // Give the relay a moment to process the inbound frames.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        metrics.rate_limit_drops() >= 1,
        "the per-token rate limit must shed traffic over budget (drops={})",
        metrics.rate_limit_drops()
    );
}

// Re-export `serve` returns the bound addr on shutdown — unused here because the
// tests reserve an explicit port; reference it so the import is not flagged.
#[allow(dead_code)]
fn _serve_returns_addr() -> Option<SocketAddr> {
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn producer_reconnect_resumes_from_its_cursor() {
    let port = free_port().await;
    let (base, _shutdown, _m) = start_relay_on(port, |_| {}).await;

    let mut producer = RelayChannel::register(producer_config(&base, PTY_STREAM_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_STREAM_PORT, 0, 0).await.unwrap();
    producer
        .send_frame(prost::bytes::Bytes::from_static(b"a"))
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame()).await;

    // The producer reconnects (a relay blip) presenting its send cursor; the relay
    // re-accepts the open and the stream continues — the agent's RelayChannel models
    // exactly this in `reconnect`. Here we drive it directly to prove the relay
    // accepts a resume open on a known key.
    producer
        .reconnect(Duration::from_millis(0))
        .await
        .expect("producer reconnect resumes");
    // After reconnect the producer keeps shipping; the (still-connected) viewer
    // receives the next frame.
    producer
        .send_frame(prost::bytes::Bytes::from_static(b"b"))
        .await
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("post-reconnect frame")
        .unwrap();
    assert_eq!(&got.data[..], b"b");
}
