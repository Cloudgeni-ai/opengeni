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
use opengeni_relay::{serve, RelayConfig, RelayMetrics};
use sha2::Sha256;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type HmacSha256 = Hmac<Sha256>;

const SECRET: &str = "relay-e2e-secret";
const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const AGENT: &str = "44444444-4444-4444-8444-444444444444";
const PTY_PORT: u32 = 7681;

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

fn viewer_token(epoch: u64, port: u32) -> String {
    mint(
        "ogs_",
        &format!(
            r#"{{"workspaceId":"{WORKSPACE}","sessionId":"22222222-2222-4222-8222-222222222222","viewerId":"33333333-3333-4333-8333-333333333333","leaseEpoch":{epoch},"mode":"view","port":{port},"exp":4102444800}}"#
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
            kind: v1::StreamKind::Pty as i32,
            port,
        },
        token: agent_token(),
        relay_url: base.to_string(),
    }
}

/// A raw viewer: dial wss, send the StreamOpen (role CLIENT), await the ack.
struct Viewer {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl Viewer {
    async fn connect(
        base: &str,
        port: u32,
        epoch: u64,
        resume_from_seq: u64,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        let url = format!("{base}?ws={WORKSPACE}&agent={AGENT}&port={port}");
        let (mut socket, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("dial: {e}"))?;
        let open = RelayMessage::Open(v1::StreamOpen {
            channel: Some(v1::StreamChannel {
                channel_id: format!("ch-{port}"),
                workspace_id: WORKSPACE.to_string(),
                agent_id: AGENT.to_string(),
                kind: v1::StreamKind::Pty as i32,
                port,
            }),
            token: viewer_token(epoch, port),
            role: v1::StreamRole::Client as i32,
            resume_from_seq,
        });
        socket
            .send(WsMessage::Binary(open.encode()))
            .await
            .map_err(|e| format!("send open: {e}"))?;
        // Await the ack.
        match next_msg(&mut socket).await {
            Some(RelayMessage::OpenAck(ack)) => Ok((Self { socket }, ack)),
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
            channel_id: "ch-viewer".to_string(),
            seq,
            data: prost::bytes::Bytes::copy_from_slice(data),
            produced_at_ms: 0,
        });
        let _ = self.socket.send(WsMessage::Binary(frame.encode())).await;
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
async fn frames_splice_end_to_end_bidirectionally() {
    let port = free_port().await;
    let (base, _shutdown, _m) = start_relay_on(port, |_| {}).await;

    // Producer (agent) registers.
    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");
    // Viewer connects (epoch 0).
    let (mut viewer, ack) = Viewer::connect(&base, PTY_PORT, 0, 0)
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

    // Viewer → producer (input).
    viewer.send_frame(0, b"keystroke").await;
    let inbound = tokio::time::timeout(Duration::from_secs(5), producer.recv())
        .await
        .expect("producer recv timed out")
        .expect("producer recv ok");
    match inbound {
        Some(RelayMessage::Frame(f)) => assert_eq!(&f.data[..], b"keystroke"),
        other => panic!("expected an input frame, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_epoch_viewer_is_rejected() {
    let port = free_port().await;
    let (base, _shutdown, metrics) = start_relay_on(port, |_| {}).await;

    let _producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");

    // A viewer at epoch 5 advances the floor.
    let (_v5, ack5) = Viewer::connect(&base, PTY_PORT, 5, 0)
        .await
        .expect("epoch5");
    assert!(ack5.accepted);

    // A viewer at epoch 4 (a swapped-away generation) is REJECTED.
    let (_stale, stale_ack) = Viewer::connect(&base, PTY_PORT, 4, 0)
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

    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_PORT, 0, 0).await.unwrap();

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
    let (mut viewer2, ack) = Viewer::connect(&base, PTY_PORT, 0, 1).await.unwrap();
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

    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_PORT, 0, 0).await.unwrap();

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

    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .unwrap();
    let (mut viewer, _) = Viewer::connect(&base, PTY_PORT, 0, 0).await.unwrap();
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
