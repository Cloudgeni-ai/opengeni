//! Local relay e2e (NO k8s) — a real `opengeni-relay` process (an in-process
//! [`BoundRelay`] on an ephemeral port) + a real PRODUCER (the `opengeni-agent-stream`
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

use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use hmac::{Hmac, Mac};
use opengeni_agent_proto::v1;
use opengeni_agent_stream::channel::{ChannelConfig, RelayChannel};
use opengeni_agent_stream::codec::RelayMessage;
use opengeni_relay::{BoundRelay, RelayConfig, RelayMetrics};
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

/// An input-granting (`control`) viewer token bound to this test's `ch-{port}`
/// stream — what the API mints for a terminal viewer holding `terminal:attach`.
fn viewer_token(epoch: u64, port: u32) -> String {
    viewer_token_with_mode(epoch, port, "control")
}

fn viewer_token_with_mode(epoch: u64, port: u32, mode: &str) -> String {
    mint(
        "ogs_",
        &format!(
            r#"{{"workspaceId":"{WORKSPACE}","sessionId":"22222222-2222-4222-8222-222222222222","viewerId":"33333333-3333-4333-8333-333333333333","leaseEpoch":{epoch},"mode":"{mode}","port":{port},"exp":4102444800,"agentId":"{AGENT}","channelId":"ch-{port}"}}"#
        ),
    )
}

/// Reserve an ephemeral localhost port for the relay PROCESS (close the probe
/// listener so the process can bind it). Another socket can take the port in
/// between; [`relay_process`] then fails loudly rather than talking to a stranger.
/// In-process relays use [`start_relay`], which has no such window.
async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

/// Start an in-process relay on an ephemeral port + return (base_ws_url, shutdown,
/// metrics). The relay binds port 0 itself and holds it from then on, so its base
/// URL can only reach this relay (a port probed and released first could be taken
/// by another test's relay in between). Connections queue on the bound listener
/// until it serves, so no readiness wait is needed.
async fn start_relay(
    tune: impl FnOnce(&mut RelayConfig),
) -> (String, tokio::sync::oneshot::Sender<()>, RelayMetrics) {
    let mut config = RelayConfig::for_test(SECRET);
    config.bind = "127.0.0.1:0".to_string();
    tune(&mut config);
    let metrics = RelayMetrics::new();
    let relay = BoundRelay::bind(config, metrics.clone())
        .await
        .expect("bind the relay");
    let base = format!("ws://{}/stream", relay.local_addr());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = relay
            .serve(async {
                let _ = rx.await;
            })
            .await;
    });
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
            relay_route: None,
        },
        credential: opengeni_agent_stream::RelayCredential::fixed(base, agent_token()),
        activity: opengeni_agent_stream::ActivityStamp::untracked(),
    }
}

/// A raw viewer: dial wss, send the StreamOpen (role CLIENT), await the ack.
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
        Self::connect_routed(base, port, epoch, resume_from_seq, None).await
    }

    async fn connect_routed(
        base: &str,
        port: u32,
        epoch: u64,
        resume_from_seq: u64,
        route: Option<&str>,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        Self::connect_with_token(
            base,
            port,
            viewer_token(epoch, port),
            resume_from_seq,
            route,
        )
        .await
    }

    async fn connect_with_token(
        base: &str,
        port: u32,
        token: String,
        resume_from_seq: u64,
        route: Option<&str>,
    ) -> Result<(Self, v1::StreamOpenAck), String> {
        let channel_id = format!("ch-{port}");
        let mut url =
            format!("{base}?ws={WORKSPACE}&agent={AGENT}&port={port}&channel={channel_id}");
        if let Some(route) = route {
            url.push_str("&route=");
            url.push_str(route);
        }
        let (mut socket, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("dial: {e}"))?;
        let open = RelayMessage::Open(v1::StreamOpen {
            channel: Some(v1::StreamChannel {
                channel_id: channel_id.clone(),
                workspace_id: WORKSPACE.to_string(),
                agent_id: AGENT.to_string(),
                kind: v1::StreamKind::Pty as i32,
                port,
                relay_route: None,
            }),
            token,
            role: v1::StreamRole::Client as i32,
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
        self.send(&frame).await;
    }

    async fn send(&mut self, message: &RelayMessage) {
        let _ = self.socket.send(WsMessage::Binary(message.encode())).await;
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
#[allow(clippy::too_many_lines)] // One channel's replay/fence history must span all reconnects.
async fn different_replicas_share_pairing_replay_and_epoch_fences_without_affinity() {
    let (owner, _owner_shutdown, owner_metrics) = start_relay(|c| {
        c.advertise_ip = Some("127.0.0.1".parse().unwrap());
    })
    .await;
    let (edge, _edge_shutdown, edge_metrics) = start_relay(|c| {
        c.advertise_ip = Some("127.0.0.1".parse().unwrap());
    })
    .await;
    let mut producer = RelayChannel::register(producer_config(&owner, PTY_PORT))
        .await
        .unwrap();
    let route = producer
        .channel()
        .relay_route
        .clone()
        .expect("producer receives owner route");
    producer
        .send_frame(bytes::Bytes::from_static(b"before-viewer"))
        .await
        .unwrap();
    let (mut viewer, ack) = Viewer::connect_routed(&edge, PTY_PORT, 5, 0, Some(&route))
        .await
        .unwrap();
    assert!(ack.accepted);
    assert_eq!(ack.relay_route.as_deref(), Some(route.as_str()));
    assert_eq!(
        edge_metrics.live_channels(),
        0,
        "proxy does not create a second registry"
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), viewer.recv_frame())
            .await
            .unwrap()
            .unwrap()
            .data
            .as_ref(),
        b"before-viewer"
    );
    viewer.send_frame(0, b"input-across-replicas").await;
    let incoming = tokio::time::timeout(Duration::from_secs(2), producer.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(incoming, RelayMessage::Frame(f) if f.data.as_ref() == b"input-across-replicas")
    );
    let (_, stale) = Viewer::connect_routed(&edge, PTY_PORT, 4, 0, Some(&route))
        .await
        .unwrap();
    assert!(
        !stale.accepted,
        "the owner's epoch floor also fences a different ingress replica"
    );
    drop(viewer);
    producer
        .send_frame(bytes::Bytes::from_static(b"after-drop"))
        .await
        .unwrap();
    let (mut resumed, ack) = Viewer::connect_routed(&edge, PTY_PORT, 5, 1, Some(&route))
        .await
        .unwrap();
    assert!(ack.accepted);
    let frame = tokio::time::timeout(Duration::from_secs(2), resumed.recv_frame())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.seq, 1);
    assert_eq!(frame.data.as_ref(), b"after-drop");
    let (_, wrong_channel) = Viewer::connect_routed(&edge, 6080, 5, 0, Some(&route))
        .await
        .unwrap();
    assert!(
        !wrong_channel.accepted,
        "route is bound to the full channel identity"
    );
    let (_, tampered) = Viewer::connect_routed(&edge, PTY_PORT, 5, 0, Some(&format!("{route}x")))
        .await
        .unwrap();
    assert!(!tampered.accepted);

    // Even a correctly signed route cannot cause an unauthenticated private
    // dial: the ingress edge rejects the ordinary viewer token first.
    let rejected_before = owner_metrics.opens_rejected();
    let url = format!(
        "{edge}?ws={WORKSPACE}&agent={AGENT}&port={PTY_PORT}&channel=ch-{PTY_PORT}&route={route}"
    );
    let (mut unauthorized, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    unauthorized
        .send(WsMessage::Binary(
            RelayMessage::Open(v1::StreamOpen {
                channel: Some(producer.channel().clone()),
                token: "invalid".into(),
                role: v1::StreamRole::Client as i32,
                resume_from_seq: 0,
            })
            .encode(),
        ))
        .await
        .unwrap();
    assert!(
        matches!(next_msg(&mut unauthorized).await, Some(RelayMessage::OpenAck(ack)) if !ack.accepted)
    );
    assert_eq!(owner_metrics.opens_rejected(), rejected_before);
    assert_eq!(edge_metrics.opens_rejected(), 1);

    // The producer can itself re-enter through the other edge while retaining
    // the original owner and its viewer. Replacing the producer generation must
    // not let the old socket teardown detach the replacement.
    let mut config = producer_config(&edge, PTY_PORT);
    config.channel.relay_route = Some(route.clone());
    let mut replacement = RelayChannel::register(config).await.unwrap();
    drop(producer);
    resumed.send_frame(1, b"after-producer-reconnect").await;
    let incoming = tokio::time::timeout(Duration::from_secs(2), replacement.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(incoming, RelayMessage::Frame(f) if f.data.as_ref() == b"input-across-replicas")
    );
    let incoming = tokio::time::timeout(Duration::from_secs(2), replacement.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(incoming, RelayMessage::Frame(f) if f.data.as_ref() == b"after-producer-reconnect")
    );
}

struct RelayProcess(std::process::Child);

impl Drop for RelayProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start the relay binary on `port` and wait until IT reports listening there.
/// Readiness comes from the child's own "relay listening" log line, not from a TCP
/// probe, which any other listener on the port would answer too; a child that ends
/// first (its bind failed) fails the test.
async fn relay_process(port: u16) -> RelayProcess {
    use std::io::BufRead as _;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_opengeni-relay"))
        .args([
            "--bind",
            &format!("127.0.0.1:{port}"),
            "--advertise-ip",
            "127.0.0.1",
            "--stream-token-secret",
            SECRET,
        ])
        .env_remove("OPENGENI_RELAY_TOKEN_SECRET")
        .env_remove("RUST_LOG")
        .env("NO_COLOR", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().expect("piped stdout");
    let process = RelayProcess(child);
    let listening = format!("addr=127.0.0.1:{port} ");
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<bool>();
    // Reads the child's log until it ends, so the child never blocks on a full pipe.
    std::thread::spawn(move || {
        let mut ready_tx = Some(ready_tx);
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.contains("relay listening") && line.contains(&listening) {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(true);
                }
            }
        }
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(false);
        }
    });
    let ready = tokio::time::timeout(Duration::from_secs(10), ready_rx)
        .await
        .unwrap_or_else(|_| panic!("the relay process for port {port} did not report listening"));
    assert!(
        matches!(ready, Ok(true)),
        "the relay process for port {port} ended before listening"
    );
    process
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dead_owner_and_reused_pod_address_refresh_route_without_restarting_producer() {
    let owner_port = free_port().await;
    let owner_process = relay_process(owner_port).await;
    let owner_base = format!("ws://127.0.0.1:{owner_port}/stream");
    let (edge, _edge_shutdown, _) = start_relay(|c| {
        c.advertise_ip = Some("127.0.0.1".parse().unwrap());
    })
    .await;
    let initial = RelayChannel::register(producer_config(&owner_base, PTY_PORT))
        .await
        .unwrap();
    let old_route = initial.channel().relay_route.clone().unwrap();
    let mut config = producer_config(&edge, PTY_PORT);
    config.channel.relay_route = Some(old_route.clone());
    let mut producer = RelayChannel::register(config).await.unwrap();
    let descriptor = producer.descriptor_updates();
    drop(initial);
    drop(owner_process);

    let (_, unavailable) = Viewer::connect_routed(&edge, PTY_PORT, 0, 0, Some(&old_route))
        .await
        .unwrap();
    assert!(!unavailable.accepted);
    assert!(unavailable.error.unwrap().retryable);

    // An endpoint that accepts WebSocket but never acknowledges StreamOpen is
    // also unavailable; the edge must reject in bounded time rather than hang.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", owner_port))
        .await
        .unwrap();
    let stalled = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let _ = socket.next().await;
        std::future::pending::<()>().await;
    });
    let (_, unavailable) = tokio::time::timeout(
        Duration::from_secs(7),
        Viewer::connect_routed(&edge, PTY_PORT, 0, 0, Some(&old_route)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!unavailable.accepted);
    assert!(unavailable.error.unwrap().retryable);
    stalled.abort();
    let _ = stalled.await;

    // A process on the same IP:port is not the previous channel owner. It must
    // reject the stale incarnation, not form a forwarding loop or false pair.
    let _reused_address = relay_process(owner_port).await;
    let (_, rejected) = Viewer::connect_routed(&edge, PTY_PORT, 0, 0, Some(&old_route))
        .await
        .unwrap();
    assert!(!rejected.accepted);
    assert_eq!(
        rejected
            .error
            .unwrap()
            .detail
            .get("relay_owner_unavailable")
            .map(String::as_str),
        Some("true")
    );
    tokio::time::timeout(Duration::from_secs(3), producer.reconnect(Duration::ZERO))
        .await
        .unwrap()
        .unwrap();
    let new_route = descriptor
        .borrow()
        .as_ref()
        .unwrap()
        .relay_route
        .clone()
        .unwrap();
    assert_ne!(new_route, old_route);
    let (mut viewer, ack) = Viewer::connect_routed(&edge, PTY_PORT, 0, 0, Some(&new_route))
        .await
        .unwrap();
    assert!(ack.accepted);
    producer
        .send_frame(bytes::Bytes::from_static(b"same-producer-new-owner"))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), viewer.recv_frame())
            .await
            .unwrap()
            .unwrap()
            .data
            .as_ref(),
        b"same-producer-new-owner"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn frames_splice_end_to_end_bidirectionally() {
    let (base, _shutdown, _m) = start_relay(|_| {}).await;

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
    let (base, _shutdown, metrics) = start_relay(|_| {}).await;

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

/// A viewer token bound to one machine's exact stream (the claims a Connected
/// Machine mint carries; its workspace is where the machine is enrolled).
fn bound_viewer_token(port: u32, agent: &str, channel: &str) -> String {
    mint(
        "ogs_",
        &format!(
            r#"{{"workspaceId":"{WORKSPACE}","sessionId":"22222222-2222-4222-8222-222222222222","viewerId":"33333333-3333-4333-8333-333333333333","leaseEpoch":0,"mode":"view","port":{port},"exp":4102444800,"agentId":"{agent}","channelId":"{channel}"}}"#
        ),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_viewer_token_bound_to_a_stream_opens_only_that_stream() {
    let (base, _shutdown, _m) = start_relay(|_| {}).await;
    let _producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");
    let channel = format!("ch-{PTY_PORT}");

    let (_viewer, ack) = Viewer::connect_with_token(
        &base,
        PTY_PORT,
        bound_viewer_token(PTY_PORT, AGENT, &channel),
        0,
        None,
    )
    .await
    .expect("bound viewer");
    assert!(ack.accepted, "a token bound to this exact stream opens it");

    let other_machine = "55555555-5555-4555-8555-555555555555";
    let (_v, ack) = Viewer::connect_with_token(
        &base,
        PTY_PORT,
        bound_viewer_token(PTY_PORT, other_machine, &channel),
        0,
        None,
    )
    .await
    .expect("dial");
    assert!(!ack.accepted, "a token for another machine is rejected");

    let (_v, ack) = Viewer::connect_with_token(
        &base,
        PTY_PORT,
        bound_viewer_token(PTY_PORT, AGENT, "ch-another-stream"),
        0,
        None,
    )
    .await
    .expect("dial");
    assert!(
        !ack.accepted,
        "a token for another stream of the same machine is rejected"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cross_channel_isolation() {
    let (base, _shutdown, _m) = start_relay(|_| {}).await;

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
    let (base, _shutdown, _m) = start_relay(|_| {}).await;

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
    // A tiny per-token byte budget so a couple of frames exhaust it.
    let (base, _shutdown, metrics) = start_relay(|c| {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn producer_reconnect_resumes_from_its_cursor() {
    let (base, _shutdown, _m) = start_relay(|_| {}).await;

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

/// The next message the producer receives, or `None` when nothing arrives within
/// a short window (the relay dropped the viewer's message).
async fn producer_next(producer: &mut RelayChannel, wait: Duration) -> Option<RelayMessage> {
    match tokio::time::timeout(wait, producer.recv()).await {
        Ok(Ok(message)) => message,
        Ok(Err(e)) => panic!("producer recv failed: {e}"),
        Err(_) => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_viewer_token_without_a_stream_binding_is_rejected() {
    let (base, _shutdown, metrics) = start_relay(|_| {}).await;
    let _producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");
    // No binding at all, only the agent, or only the channel: each is rejected.
    let partial_bindings = [
        ("unbound", String::new()),
        ("agent-only", format!(r#","agentId":"{AGENT}""#)),
        ("channel-only", format!(r#","channelId":"ch-{PTY_PORT}""#)),
    ];
    for (case, binding) in partial_bindings {
        let before = metrics.opens_rejected();
        let token = mint(
            "ogs_",
            &format!(
                r#"{{"workspaceId":"{WORKSPACE}","sessionId":"22222222-2222-4222-8222-222222222222","viewerId":"33333333-3333-4333-8333-333333333333","leaseEpoch":0,"mode":"control","port":{PTY_PORT},"exp":4102444800{binding}}}"#
            ),
        );
        let (_v, ack) = Viewer::connect_with_token(&base, PTY_PORT, token, 0, None)
            .await
            .expect("dial");
        assert!(
            !ack.accepted,
            "a {case} viewer token cannot open a relay stream"
        );
        assert!(
            metrics.opens_rejected() > before,
            "{case} counted as rejected"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_view_token_watches_a_terminal_but_cannot_type_into_or_close_it() {
    let (base, _shutdown, metrics) = start_relay(|_| {}).await;
    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");
    let (mut viewer, ack) = Viewer::connect_with_token(
        &base,
        PTY_PORT,
        viewer_token_with_mode(0, PTY_PORT, "view"),
        0,
        None,
    )
    .await
    .expect("view viewer");
    assert!(ack.accepted, "a view token may watch the terminal");

    producer
        .send_frame(prost::bytes::Bytes::from_static(b"prompt$ "))
        .await
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("view viewer recv timed out")
        .expect("view viewer frame");
    assert_eq!(&got.data[..], b"prompt$ ");

    // Keystrokes and a Close from the view token never reach the shell.
    viewer.send_frame(0, b"rm -rf ~\n").await;
    let close = RelayMessage::Close(v1::StreamClose {
        channel_id: format!("ch-{PTY_PORT}"),
        reason: v1::StreamCloseReason::Normal as i32,
        message: "viewer close".to_string(),
    });
    viewer.send(&close).await;
    assert!(
        producer_next(&mut producer, Duration::from_millis(500))
            .await
            .is_none(),
        "view-mode keystrokes and Close must be dropped"
    );
    assert_eq!(
        metrics.unauthorized_drops(),
        2,
        "both dropped messages are visible to operators"
    );

    // The channel is still alive: output keeps flowing to the viewer.
    producer
        .send_frame(prost::bytes::Bytes::from_static(b"still-here"))
        .await
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), viewer.recv_frame())
        .await
        .expect("channel survived")
        .expect("frame");
    assert_eq!(&got.data[..], b"still-here");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_input_needs_a_control_token_and_the_established_channel() {
    const DESKTOP_PORT: u32 = 6080;
    let (base, _shutdown, _m) = start_relay(|_| {}).await;
    let mut producer = RelayChannel::register(producer_config(&base, DESKTOP_PORT))
        .await
        .expect("producer register");
    let input = |channel: &str| {
        RelayMessage::DesktopInput(v1::DesktopInput {
            channel_id: channel.to_string(),
            ..Default::default()
        })
    };
    let channel = format!("ch-{DESKTOP_PORT}");

    // A view-only desktop viewer cannot inject input.
    let (mut watcher, ack) = Viewer::connect_with_token(
        &base,
        DESKTOP_PORT,
        viewer_token_with_mode(0, DESKTOP_PORT, "view"),
        0,
        None,
    )
    .await
    .expect("view viewer");
    assert!(ack.accepted);
    watcher.send(&input(&channel)).await;
    assert!(
        producer_next(&mut producer, Duration::from_millis(500))
            .await
            .is_none(),
        "view-mode desktop input must be dropped"
    );
    // A desktop Frame (opaque bytes) is not input either.
    watcher.send_frame(0, b"not-input").await;
    assert!(producer_next(&mut producer, Duration::from_millis(300))
        .await
        .is_none());

    // A control viewer's input reaches the producer only on its own channel.
    let (mut controller, ack) = Viewer::connect(&base, DESKTOP_PORT, 0, 0)
        .await
        .expect("control viewer");
    assert!(ack.accepted);
    controller.send(&input("ch-someone-else")).await;
    assert!(
        producer_next(&mut producer, Duration::from_millis(500))
            .await
            .is_none(),
        "input naming another channel must be dropped"
    );
    controller.send(&input(&channel)).await;
    match producer_next(&mut producer, Duration::from_secs(5)).await {
        Some(RelayMessage::DesktopInput(got)) => assert_eq!(got.channel_id, channel),
        other => panic!("expected the controller's desktop input, got {other:?}"),
    }
}

/// Regression guard for a reconnect: a replaced viewer socket must not reach the
/// producer. This also holds on the pre-fence relay (the old socket's splice ends
/// once its sink is replaced); the generation fence itself is proven at the
/// registry level by
/// `registry::tests::a_replaced_connection_cannot_forward_or_close_on_its_successor`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reconnect_leaves_only_the_live_viewer_driving_the_terminal() {
    let (base, _shutdown, _m) = start_relay(|_| {}).await;
    let mut producer = RelayChannel::register(producer_config(&base, PTY_PORT))
        .await
        .expect("producer register");
    let (mut old, _) = Viewer::connect(&base, PTY_PORT, 0, 0).await.expect("old");
    // A reconnect on the same channel replaces the old connection.
    let (mut new, ack) = Viewer::connect(&base, PTY_PORT, 0, 0).await.expect("new");
    assert!(ack.accepted);

    old.send_frame(0, b"stale-keystroke").await;
    old.send(&RelayMessage::Close(v1::StreamClose {
        channel_id: format!("ch-{PTY_PORT}"),
        reason: v1::StreamCloseReason::Normal as i32,
        message: "stale close".to_string(),
    }))
    .await;
    assert!(
        producer_next(&mut producer, Duration::from_millis(500))
            .await
            .is_none(),
        "a replaced socket's input and Close must be dropped"
    );

    new.send_frame(0, b"live-keystroke").await;
    match producer_next(&mut producer, Duration::from_secs(5)).await {
        Some(RelayMessage::Frame(f)) => assert_eq!(&f.data[..], b"live-keystroke"),
        other => panic!("expected the live viewer's keystroke, got {other:?}"),
    }
}
