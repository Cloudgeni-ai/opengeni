//! The hub against the agent's own NATS client, `async-nats` 0.46, and a
//! gateway that speaks the link protocol over a real WebSocket: what the
//! agent sees end to end, from its handshake to its host restarting.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use compute_link::core::Settings;
use compute_link::saved::Saved;
use compute_link::{HostToken, Hub, HubConfig, Timing, Tokens, Wake};
use compute_protocol::link::{
    AgentLink, Ending, GatewayFrame, HostFrame, RELAY_SUBJECT, Refusal, Relay, SUBPROTOCOL,
    VERSION, decode, encode,
};
use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_util::sync::CancellationToken;

const SANDBOX: &str = "sb-1";
const SCOPE_1: &str = "agent.w1.a1.connection.inst-1";
const SCOPE_2: &str = "agent.w1.a1.connection.inst-2";
const WAIT: Duration = Duration::from_secs(5);

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn relay(token: &str) -> Relay {
    Relay {
        url: "wss://relay.example/v1".into(),
        token: token.into(),
        expires_at_ms: now_ms() + 600_000,
    }
}

// The gateway.

#[derive(Debug)]
enum Event {
    Up { link: usize, bearer: String },
    Frame { frame: HostFrame, payload: Bytes },
    Down,
}

struct Live {
    out: mpsc::UnboundedSender<Message>,
    cut: CancellationToken,
}

/// A gateway on a local port: it says hello to each link and hands the
/// test every frame a host sends.
struct Gateway {
    url: String,
    events: mpsc::UnboundedReceiver<Event>,
    live: Arc<Mutex<Option<Live>>>,
    /// Answers a link's dial with this status instead, while set.
    reject: Arc<AtomicBool>,
    /// Stops reading and writing its links, while set, as a gateway that
    /// hangs.
    stall: Arc<AtomicBool>,
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agent-link", listener.local_addr().unwrap());
        let (events, receiver) = mpsc::unbounded_channel();
        let live = Arc::new(Mutex::new(None));
        let reject = Arc::new(AtomicBool::new(false));
        let stall = Arc::new(AtomicBool::new(false));
        tokio::spawn(accept_links(
            listener,
            events,
            Arc::clone(&live),
            Arc::clone(&reject),
            Arc::clone(&stall),
        ));
        Self {
            url,
            events: receiver,
            live,
            reject,
            stall,
        }
    }

    async fn next(&mut self) -> Event {
        timeout(WAIT, self.events.recv())
            .await
            .expect("the gateway heard nothing")
            .expect("the gateway stopped")
    }

    /// The next link to come up, and the token it presented.
    async fn up(&mut self) -> (usize, String) {
        loop {
            match self.next().await {
                Event::Up { link, bearer } => return (link, bearer),
                Event::Down => {}
                Event::Frame { frame, .. } => panic!("a frame before the link: {frame:?}"),
            }
        }
    }

    async fn down(&mut self) {
        loop {
            match self.next().await {
                Event::Down => return,
                Event::Frame {
                    frame: HostFrame::Close { .. } | HostFrame::State { .. },
                    ..
                } => {}
                other => panic!("expected the link to go, got {other:?}"),
            }
        }
    }

    /// The next frame a host sent, but for `state` frames.
    async fn frame(&mut self) -> (HostFrame, Bytes) {
        loop {
            match self.next().await {
                Event::Frame {
                    frame: HostFrame::State { .. },
                    ..
                } => {}
                Event::Frame { frame, payload } => return (frame, payload),
                other => panic!("expected a frame, got {other:?}"),
            }
        }
    }

    /// That no frame comes within `wait`.
    async fn quiet(&mut self, wait: Duration) {
        if let Ok(Some(event)) = timeout(wait, self.events.recv()).await {
            panic!("expected nothing, got {event:?}");
        }
    }

    fn send(&self, frame: &GatewayFrame, payload: &[u8]) {
        let live = self.live.lock().unwrap();
        let live = live.as_ref().expect("no link is up");
        live.out
            .send(Message::Binary(encode(frame, payload).unwrap().into()))
            .unwrap();
    }

    /// Drops the link that is up, as a gateway that went away.
    fn cut(&self) {
        if let Some(live) = self.live.lock().unwrap().take() {
            live.cut.cancel();
        }
    }

    /// Waits for `open` and answers `opened`, returning its `s`.
    async fn open(&mut self, connection: &str, ticket: &str, scope: &str, token: &str) -> u32 {
        let (frame, _) = self.frame().await;
        let HostFrame::Open {
            s,
            sandbox,
            ticket: sent,
            connection: instance,
        } = frame
        else {
            panic!("expected open, got {frame:?}");
        };
        assert_eq!(sandbox, SANDBOX);
        assert_eq!(sent, ticket);
        assert_eq!(instance, connection);
        self.send(
            &GatewayFrame::Opened {
                s,
                scope: scope.into(),
                relay: relay(token),
            },
            b"",
        );
        s
    }
}

#[expect(
    clippy::result_large_err,
    reason = "the WebSocket handshake's callback type"
)]
async fn accept_links(
    listener: TcpListener,
    events: mpsc::UnboundedSender<Event>,
    live: Arc<Mutex<Option<Live>>>,
    reject: Arc<AtomicBool>,
    stall: Arc<AtomicBool>,
) {
    let mut links = 0;
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        links += 1;
        let bearer = Arc::new(Mutex::new(String::new()));
        let seen = Arc::clone(&bearer);
        let refuse = reject.load(Ordering::SeqCst);
        let callback = move |request: &Request, mut response: Response| {
            let offered = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok());
            if refuse || offered != Some(SUBPROTOCOL) {
                let mut refusal = ErrorResponse::new(Some("refused".into()));
                *refusal.status_mut() = StatusCode::UNAUTHORIZED;
                return Err(refusal);
            }
            request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .clone_into(&mut seen.lock().unwrap());
            response.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static(SUBPROTOCOL),
            );
            Ok(response)
        };
        let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
            continue;
        };
        let hello = GatewayFrame::Hello {
            version: VERSION,
            max_payload: 1 << 20,
        };
        socket
            .send(Message::Binary(encode(&hello, b"").unwrap().into()))
            .await
            .unwrap();
        let (out, mut outgoing) = mpsc::unbounded_channel();
        let cut = CancellationToken::new();
        *live.lock().unwrap() = Some(Live {
            out,
            cut: cut.clone(),
        });
        let bearer = bearer.lock().unwrap().clone();
        let _ = events.send(Event::Up {
            link: links,
            bearer,
        });
        let events = events.clone();
        let stall = Arc::clone(&stall);
        tokio::spawn(async move {
            loop {
                if stall.load(Ordering::SeqCst) {
                    // Holds the socket, reading nothing.
                    cut.cancelled().await;
                    break;
                }
                tokio::select! {
                    () = cut.cancelled() => break,
                    message = outgoing.recv() => match message {
                        Some(message) => {
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                    message = socket.next() => match message {
                        Some(Ok(Message::Binary(bytes))) => {
                            let (frame, payload) = decode::<HostFrame>(&bytes).unwrap();
                            let payload = Bytes::copy_from_slice(payload);
                            let _ = events.send(Event::Frame { frame, payload });
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        _ => break,
                    },
                }
            }
            let _ = events.send(Event::Down);
        });
    }
}

// The host's side.

#[derive(Default)]
struct Fleet {
    issued: AtomicUsize,
}

impl Tokens for Fleet {
    fn token(&self, _gateway: &str) -> BoxFuture<'static, Result<HostToken, String>> {
        let n = self.issued.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move {
            Ok(HostToken {
                token: format!("host-token-{n}"),
                expires_at_ms: now_ms() + 3_600_000,
            })
        })
    }
}

#[derive(Default)]
struct Wakes(AtomicUsize);

impl Wake for Wakes {
    fn wake(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn hub() -> Hub {
    hub_with(Timing {
        ping_every: Duration::from_millis(500),
        silence: Duration::from_secs(5),
        backoff_min: Duration::from_millis(10),
        backoff_max: Duration::from_millis(200),
        connect_timeout: Duration::from_secs(2),
    })
}

fn hub_with(timing: Timing) -> Hub {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    Hub::start(HubConfig {
        tokens: Arc::new(Fleet::default()),
        tls: Arc::new(tls),
        settings: Settings::default(),
        timing,
    })
}

/// The sandbox's link port: each connection to it goes to the hub through
/// a pipe the test can cut, as a sandbox that sleeps or a host that stops.
struct Port {
    addr: SocketAddr,
    serving: Arc<AtomicBool>,
    pipes: Arc<Mutex<Vec<AbortHandle>>>,
    accept: AbortHandle,
}

impl Port {
    async fn start(hub: Hub) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let serving = Arc::new(AtomicBool::new(true));
        let pipes = Arc::new(Mutex::new(Vec::new()));
        let accept = tokio::spawn(serve_port(
            listener,
            hub,
            Arc::clone(&serving),
            Arc::clone(&pipes),
        ))
        .abort_handle();
        Self {
            addr,
            serving,
            pipes,
            accept,
        }
    }

    /// Cuts every connection and refuses new ones, as a sandbox asleep.
    fn sleep(&self) {
        self.serving.store(false, Ordering::SeqCst);
        for pipe in self.pipes.lock().unwrap().drain(..) {
            pipe.abort();
        }
    }

    fn wake(&self) {
        self.serving.store(true, Ordering::SeqCst);
    }

    /// Stops it for good, letting go of its hub.
    fn stop(&self) {
        self.sleep();
        self.accept.abort();
    }
}

async fn serve_port(
    listener: TcpListener,
    hub: Hub,
    serving: Arc<AtomicBool>,
    pipes: Arc<Mutex<Vec<AbortHandle>>>,
) {
    loop {
        let Ok((mut tcp, _)) = listener.accept().await else {
            return;
        };
        if !serving.load(Ordering::SeqCst) {
            drop(tcp);
            continue;
        }
        let (host, mut pipe) = tokio::io::duplex(1 << 16);
        hub.serve(SANDBOX.into(), host);
        let handle = tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut pipe).await;
        })
        .abort_handle();
        pipes.lock().unwrap().push(handle);
    }
}

/// An agent's NATS client, as the agent connects it.
struct Agent {
    client: async_nats::Client,
    events: mpsc::UnboundedReceiver<async_nats::Event>,
}

async fn connect(addr: SocketAddr, instance: &str) -> Agent {
    let (sender, events) = mpsc::unbounded_channel();
    let client = async_nats::ConnectOptions::new()
        .name(format!("opengeni-agent/connection/{instance}"))
        .max_reconnects(Some(1))
        .event_callback(move |event| {
            let sender = sender.clone();
            async move {
                let _ = sender.send(event);
            }
        })
        .connect(format!("nats://{addr}"))
        .await
        .expect("the agent connects");
    Agent { client, events }
}

impl Agent {
    /// The next server error the client heard.
    async fn server_error(&mut self) -> String {
        loop {
            if let async_nats::Event::ServerError(error) =
                timeout(WAIT, self.events.recv()).await.unwrap().unwrap()
            {
                return error.to_string();
            }
        }
    }

    /// Waits for the client to lose its connection.
    async fn disconnected(&mut self) {
        loop {
            if let async_nats::Event::Disconnected =
                timeout(WAIT, self.events.recv()).await.unwrap().unwrap()
            {
                return;
            }
        }
    }

    /// Waits for the client to stop trying, as an agent process that ended.
    async fn gave_up(&mut self) {
        loop {
            if let async_nats::Event::ClientError(async_nats::ClientError::MaxReconnects) =
                timeout(WAIT, self.events.recv()).await.unwrap().unwrap()
            {
                return;
            }
        }
    }

    /// That the client has not lost its connection so far.
    fn still_connected(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            assert!(
                !matches!(event, async_nats::Event::Disconnected),
                "the client lost its connection"
            );
        }
        assert_eq!(
            self.client.connection_state(),
            async_nats::connection::State::Connected
        );
    }
}

async fn message(subscriber: &mut async_nats::Subscriber) -> async_nats::Message {
    timeout(WAIT, subscriber.next())
        .await
        .expect("no message came")
        .expect("the subscription ended")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "compute-link-client-{}-{name}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("link.json")
}

async fn saved(path: &Path, check: impl Fn(Option<&Saved>) -> bool) -> Option<Saved> {
    for _ in 0..200 {
        let saved = Saved::load(path).unwrap();
        if check(saved.as_ref()) {
            return saved;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the kept session never matched: {:?}", Saved::load(path));
}

fn link(gateway: &Gateway, ticket: &str) -> AgentLink {
    AgentLink {
        gateway: gateway.url.clone(),
        ticket: ticket.into(),
    }
}

/// The agent's subjects, under its scope.
fn rpc(scope: &str) -> String {
    format!("{scope}.rpc")
}

// The tests.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn an_agent_is_connected_only_once_its_session_opens_and_then_round_trips() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    let wakes = Arc::new(Wakes::default());
    let path = scratch("round-trip");
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        path.clone(),
        wakes.clone(),
    );
    let (_, bearer) = gateway.up().await;
    assert_eq!(bearer, "Bearer host-token-1");
    // No agent connected yet, so there is no instance to open a session
    // for.
    gateway.quiet(Duration::from_millis(200)).await;

    let port = Port::start(hub.clone()).await;
    let addr = port.addr;
    let connecting = tokio::spawn(async move { connect(addr, "inst-1").await });
    let (frame, _) = gateway.frame().await;
    let HostFrame::Open { s, connection, .. } = frame else {
        panic!("expected open, got {frame:?}");
    };
    assert_eq!(connection, "inst-1");
    // The agent's handshake waits for the session.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !connecting.is_finished(),
        "connected before its session opened"
    );
    gateway.send(
        &GatewayFrame::Opened {
            s,
            scope: SCOPE_1.into(),
            relay: relay("relay-1"),
        },
        b"",
    );
    let mut agent = timeout(WAIT, connecting).await.unwrap().unwrap();

    // Subscribing reaches the gateway under the host's own sid.
    let mut rpc_sub = agent.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    agent.client.flush().await.unwrap();
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            queue: None
        }
    );

    // A message with headers and a reply comes through, and counts as
    // activity.
    gateway.send(
        &GatewayFrame::Msg {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            reply: Some("_INBOX.gw.1".into()),
            headers: Some(vec![("Opengeni-Request".into(), "r-1".into())]),
        },
        b"ping?",
    );
    let request = message(&mut rpc_sub).await;
    assert_eq!(request.subject.as_str(), rpc(SCOPE_1));
    assert_eq!(request.payload.as_ref(), b"ping?");
    assert_eq!(
        request.reply.as_ref().map(async_nats::Subject::as_str),
        Some("_INBOX.gw.1")
    );
    let headers = request.headers.as_ref().unwrap();
    assert_eq!(
        headers
            .get("Opengeni-Request")
            .map(async_nats::HeaderValue::as_str),
        Some("r-1")
    );
    assert_eq!(wakes.0.load(Ordering::SeqCst), 1);

    // The reply, and a publication with headers, reach the gateway.
    agent
        .client
        .publish("_INBOX.gw.1", Bytes::from_static(b"pong!"))
        .await
        .unwrap();
    let mut sent = async_nats::HeaderMap::new();
    sent.insert("Nats-Msg-Id", "e-1");
    agent
        .client
        .publish_with_headers(
            format!("{SCOPE_1}.events"),
            sent,
            Bytes::from_static(b"hello"),
        )
        .await
        .unwrap();
    agent.client.flush().await.unwrap();
    let (frame, payload) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Pub {
            s,
            subject: "_INBOX.gw.1".into(),
            reply: None,
            headers: None
        }
    );
    assert_eq!(payload.as_ref(), b"pong!");
    let (frame, payload) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Pub {
            s,
            subject: format!("{SCOPE_1}.events"),
            reply: None,
            headers: Some(vec![("Nats-Msg-Id".into(), "e-1".into())])
        }
    );
    assert_eq!(payload.as_ref(), b"hello");
    // What the agent sends is not activity.
    assert_eq!(wakes.0.load(Ordering::SeqCst), 1);

    // Outside its scope the agent may neither publish nor subscribe, and
    // nothing reaches the gateway.
    agent
        .client
        .publish("agent.w1.a1.connection.other.rpc", Bytes::new())
        .await
        .unwrap();
    let error = agent.server_error().await;
    assert!(
        error.contains("Permissions Violation for Publish"),
        "{error}"
    );
    let _other = agent.client.subscribe("agent.w2.>").await.unwrap();
    let error = agent.server_error().await;
    assert!(
        error.contains("Permissions Violation for Subscription"),
        "{error}"
    );
    gateway.quiet(Duration::from_millis(200)).await;

    // The relay credential is the host's to give, at once and when it
    // changes; the gateway never hears of the subscription.
    let mut relay_sub = agent.client.subscribe(RELAY_SUBJECT).await.unwrap();
    let first: Relay = serde_json::from_slice(&message(&mut relay_sub).await.payload).unwrap();
    assert_eq!(first.token, "relay-1");
    gateway.send(
        &GatewayFrame::Relay {
            s,
            relay: relay("relay-2"),
        },
        b"",
    );
    let second: Relay = serde_json::from_slice(&message(&mut relay_sub).await.payload).unwrap();
    assert_eq!(second.token, "relay-2");
    gateway.quiet(Duration::from_millis(200)).await;

    // The session is kept on disk, under the agent's instance.
    let kept = saved(&path, |saved| {
        saved.is_some_and(|saved| saved.subs.len() == 1)
    })
    .await
    .unwrap();
    assert_eq!(kept.instance, "inst-1");
    assert_eq!(kept.subs[0].subject, rpc(SCOPE_1));

    // A gateway's refusal of one subscription ends it for the agent.
    gateway.send(
        &GatewayFrame::Error {
            s,
            code: "permission".into(),
            message: "no".into(),
            sid: Some(1),
        },
        b"",
    );
    let error = agent.server_error().await;
    assert!(
        error.contains("Permissions Violation for Subscription"),
        "{error}"
    );
    saved(&path, |saved| {
        saved.is_some_and(|saved| saved.subs.is_empty())
    })
    .await;

    // Leaving the host ends the session and its kept copy.
    hub.detach(SANDBOX);
    let (frame, _) = gateway.frame().await;
    assert_eq!(frame, HostFrame::Close { s });
    agent.disconnected().await;
    saved(&path, |saved| saved.is_none()).await;
    gateway.down().await;
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn a_message_for_a_sleeping_agent_waits_wakes_it_and_reaches_it_once_it_is_back() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    let wakes = Arc::new(Wakes::default());
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        scratch("sleep"),
        wakes.clone(),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let addr = port.addr;
    let connecting = tokio::spawn(async move { connect(addr, "inst-1").await });
    let s = gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-1").await;
    let mut agent = connecting.await.unwrap();
    let _sub = agent.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    agent.client.flush().await.unwrap();
    assert!(matches!(
        gateway.frame().await.0,
        HostFrame::Sub { sid: 1, .. }
    ));

    // The sandbox sleeps: its connection goes, its session stays.
    port.sleep();
    agent.gave_up().await;
    gateway.quiet(Duration::from_millis(300)).await;

    // A request arrives meanwhile: it waits, and wakes the sandbox.
    gateway.send(
        &GatewayFrame::Msg {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            reply: Some("_INBOX.gw.2".into()),
            headers: None,
        },
        b"while asleep",
    );
    for _ in 0..100 {
        if wakes.0.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(wakes.0.load(Ordering::SeqCst), 1);

    // Awake again, the same agent process connects at once, the session
    // being open, and takes up its subscription without the gateway
    // hearing of it.
    port.wake();
    let mut again = connect(port.addr, "inst-1").await;
    let mut sub = again.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    let waited = message(&mut sub).await;
    assert_eq!(waited.payload.as_ref(), b"while asleep");
    assert_eq!(
        waited.reply.as_ref().map(async_nats::Subject::as_str),
        Some("_INBOX.gw.2")
    );
    gateway.quiet(Duration::from_millis(300)).await;

    // Later messages come straight through.
    gateway.send(
        &GatewayFrame::Msg {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            reply: None,
            headers: None,
        },
        b"awake",
    );
    assert_eq!(message(&mut sub).await.payload.as_ref(), b"awake");

    // The agent process ends, and a new one, with a new instance, starts:
    // the old session closes and a new one opens. Another live instance
    // holding the agent is a refusal to try again.
    port.sleep();
    again.gave_up().await;
    port.wake();
    let connecting = tokio::spawn(async move { connect(addr, "inst-2").await });
    let (frame, _) = gateway.frame().await;
    assert_eq!(frame, HostFrame::Close { s });
    let (frame, _) = gateway.frame().await;
    let HostFrame::Open {
        s: refused,
        connection,
        ..
    } = frame
    else {
        panic!("expected open, got {frame:?}");
    };
    assert_eq!(connection, "inst-2");
    gateway.send(
        &GatewayFrame::Refused {
            s: refused,
            code: Refusal::Duplicate,
            message: "another instance holds the agent".into(),
        },
        b"",
    );
    let s2 = gateway.open("inst-2", "ticket-1", SCOPE_2, "relay-3").await;
    assert!(s2 > refused);
    let new = timeout(Duration::from_secs(10), connecting)
        .await
        .unwrap()
        .unwrap();
    let _sub = new.client.subscribe(rpc(SCOPE_2)).await.unwrap();
    new.client.flush().await.unwrap();
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s: s2,
            sid: 1,
            subject: rpc(SCOPE_2),
            queue: None
        }
    );
    drop(sub);
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_link_ends_the_agents_connection_and_its_session_opens_again() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    let path = scratch("link");
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        path.clone(),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let addr = port.addr;
    let connecting = tokio::spawn(async move { connect(addr, "inst-1").await });
    gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-1").await;
    let mut agent = connecting.await.unwrap();
    let mut sub = agent.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    agent.client.flush().await.unwrap();
    assert!(matches!(
        gateway.frame().await.0,
        HostFrame::Sub { sid: 1, .. }
    ));

    // While its gateway's link is down, the agent must not count itself
    // connected, as when a NATS server went.
    gateway.reject.store(true, Ordering::SeqCst);
    gateway.cut();
    gateway.down().await;
    agent.disconnected().await;

    gateway.reject.store(false, Ordering::SeqCst);
    let (_, bearer) = gateway.up().await;
    // The token is still fresh, so the host presents it again.
    assert_eq!(bearer, "Bearer host-token-1");
    // The session opens again under the same instance on the new link and
    // the host subscribes again for the agent.
    let s = gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-2").await;
    assert_eq!(s, 1, "a new link numbers its sessions afresh");
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            queue: None
        }
    );
    // The agent's client connects again by itself and takes it up, without
    // the gateway hearing of it again.
    gateway.send(
        &GatewayFrame::Msg {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            reply: None,
            headers: None,
        },
        b"after the link came back",
    );
    assert_eq!(
        message(&mut sub).await.payload.as_ref(),
        b"after the link came back"
    );
    gateway.quiet(Duration::from_millis(300)).await;

    // A session the gateway ends for good stays ended: the agent is shut
    // out until a new ticket.
    gateway.send(
        &GatewayFrame::Closed {
            s,
            code: Ending::Superseded,
            message: "a later owner".into(),
        },
        b"",
    );
    agent.gave_up().await;
    gateway.quiet(Duration::from_millis(300)).await;
    // A new ticket, as after the sandbox was adopted again, lets it in.
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-2"),
        path,
        Arc::new(Wakes::default()),
    );
    gateway.open("inst-1", "ticket-2", SCOPE_1, "relay-3").await;
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn a_restarted_host_opens_the_kept_session_so_messages_wait_for_the_agent() {
    let mut gateway = Gateway::start().await;
    let path = scratch("restart");
    let first = hub();
    first.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        path.clone(),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(first.clone()).await;
    let addr = port.addr;
    let connecting = tokio::spawn(async move { connect(addr, "inst-1").await });
    gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-1").await;
    let mut agent = connecting.await.unwrap();
    let _rpc = agent.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    let _queued = agent
        .client
        .queue_subscribe(format!("{SCOPE_1}.work"), "workers".into())
        .await
        .unwrap();
    agent.client.flush().await.unwrap();
    assert!(matches!(
        gateway.frame().await.0,
        HostFrame::Sub { sid: 1, .. }
    ));
    assert!(matches!(
        gateway.frame().await.0,
        HostFrame::Sub {
            sid: 2,
            queue: Some(_),
            ..
        }
    ));
    saved(&path, |saved| {
        saved.is_some_and(|saved| saved.subs.len() == 2)
    })
    .await;

    // The host agent stops: its link and the agent's connection go.
    port.stop();
    drop(first);
    gateway.down().await;
    agent.disconnected().await;

    // It starts again, with the sandbox still asleep.
    let second = hub();
    let wakes = Arc::new(Wakes::default());
    second.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        path.clone(),
        wakes.clone(),
    );
    gateway.up().await;
    // The kept instance and subscriptions open at once, before the agent
    // is back.
    let s = gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-2").await;
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            queue: None
        }
    );
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s,
            sid: 2,
            subject: format!("{SCOPE_1}.work"),
            queue: Some("workers".into())
        }
    );
    gateway.send(
        &GatewayFrame::Msg {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            reply: None,
            headers: None,
        },
        b"kept",
    );
    for _ in 0..100 {
        if wakes.0.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(wakes.0.load(Ordering::SeqCst), 1);

    let port = Port::start(second.clone()).await;
    let back = connect(port.addr, "inst-1").await;
    let mut sub = back.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    assert_eq!(message(&mut sub).await.payload.as_ref(), b"kept");
    let _work = back
        .client
        .queue_subscribe(format!("{SCOPE_1}.work"), "workers".into())
        .await
        .unwrap();
    back.client.flush().await.unwrap();
    // Both were taken up: the gateway hears of neither again.
    gateway.quiet(Duration::from_millis(300)).await;
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gateway_that_refuses_a_ticket_shuts_the_agent_out() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-bad"),
        scratch("refused"),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let addr = port.addr;
    let connecting = tokio::spawn(async move {
        async_nats::ConnectOptions::new()
            .name("opengeni-agent/connection/inst-1")
            .max_reconnects(Some(1))
            .connect(format!("nats://{addr}"))
            .await
    });
    let (frame, _) = gateway.frame().await;
    let HostFrame::Open { s, .. } = frame else {
        panic!("expected open, got {frame:?}");
    };
    gateway.send(
        &GatewayFrame::Refused {
            s,
            code: Refusal::StaleEpoch,
            message: "a later owner holds it".into(),
        },
        b"",
    );
    let result = timeout(WAIT, connecting).await.unwrap().unwrap();
    assert!(result.is_err(), "connected with a refused ticket");
    // The refusal is final: the host does not try again.
    gateway.quiet(Duration::from_millis(1_500)).await;
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_that_is_not_an_agent_is_refused() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        scratch("not-agent"),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let result = async_nats::ConnectOptions::new()
        .name("something else")
        .max_reconnects(Some(1))
        .connect(format!("nats://{}", port.addr))
        .await;
    assert!(result.is_err());
    // And one that sends nothing the protocol knows is told so.
    let mut raw = TcpStream::connect(port.addr).await.unwrap();
    let mut info = vec![0; 1024];
    let n = tokio::io::AsyncReadExt::read(&mut raw, &mut info)
        .await
        .unwrap();
    assert!(info[..n].starts_with(b"INFO {"));
    tokio::io::AsyncWriteExt::write_all(&mut raw, b"HELLO there\r\n")
        .await
        .unwrap();
    let mut answer = Vec::new();
    timeout(
        WAIT,
        tokio::io::AsyncReadExt::read_to_end(&mut raw, &mut answer),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(answer, b"-ERR 'Unknown Protocol Operation'\r\n");
    gateway.quiet(Duration::from_millis(200)).await;
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agents_control_and_bulk_connections_share_its_session() {
    let mut gateway = Gateway::start().await;
    let hub = hub();
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "ticket-1"),
        scratch("two-connections"),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let addr = port.addr;

    // Opengeni's agent dials its control connection, subscribes on it,
    // then dials its bulk connection under the same name.
    let connecting = tokio::spawn(async move { connect(addr, "inst-1").await });
    let s = gateway.open("inst-1", "ticket-1", SCOPE_1, "relay-1").await;
    let mut control = timeout(WAIT, connecting).await.unwrap().unwrap();
    let mut rpc_sub = control.client.subscribe(rpc(SCOPE_1)).await.unwrap();
    control.client.flush().await.unwrap();
    let (frame, _) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Sub {
            s,
            sid: 1,
            subject: rpc(SCOPE_1),
            queue: None
        }
    );
    let mut bulk = timeout(WAIT, connect(addr, "inst-1")).await.unwrap();
    // It joins the open session: the gateway hears of no new one.
    gateway.quiet(Duration::from_millis(200)).await;

    // Both work at once: the bulk one publishes and the control one gets
    // its requests, and neither is ended.
    bulk.client
        .publish(format!("{SCOPE_1}.events"), Bytes::from_static(b"frame"))
        .await
        .unwrap();
    bulk.client.flush().await.unwrap();
    let (frame, payload) = gateway.frame().await;
    assert_eq!(
        frame,
        HostFrame::Pub {
            s,
            subject: format!("{SCOPE_1}.events"),
            reply: None,
            headers: None
        }
    );
    assert_eq!(payload.as_ref(), b"frame");
    let request = GatewayFrame::Msg {
        s,
        sid: 1,
        subject: rpc(SCOPE_1),
        reply: None,
        headers: None,
    };
    gateway.send(&request, b"one");
    assert_eq!(message(&mut rpc_sub).await.payload.as_ref(), b"one");
    tokio::time::sleep(Duration::from_millis(300)).await;
    control.still_connected();
    bulk.still_connected();

    // The bulk one going leaves the control one and its subscription.
    drop(bulk);
    tokio::time::sleep(Duration::from_millis(200)).await;
    gateway.send(&request, b"two");
    assert_eq!(message(&mut rpc_sub).await.payload.as_ref(), b"two");
    gateway.quiet(Duration::from_millis(200)).await;
    control.still_connected();

    // Another agent process ends the session and its connections.
    let connecting = tokio::spawn(async move { connect(addr, "inst-2").await });
    let (frame, _) = gateway.frame().await;
    assert_eq!(frame, HostFrame::Close { s });
    control.disconnected().await;
    gateway.open("inst-2", "ticket-1", SCOPE_2, "relay-2").await;
    let _second = timeout(WAIT, connecting).await.unwrap().unwrap();
    port.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gateway_that_stops_reading_loses_its_link_by_the_silence_deadline() {
    let mut gateway = Gateway::start().await;
    let hub = hub_with(Timing {
        ping_every: Duration::from_millis(100),
        silence: Duration::from_secs(1),
        backoff_min: Duration::from_millis(10),
        backoff_max: Duration::from_millis(200),
        connect_timeout: Duration::from_secs(2),
    });
    hub.attach(
        SANDBOX.into(),
        link(&gateway, "t1"),
        scratch("stalled"),
        Arc::new(Wakes::default()),
    );
    gateway.up().await;
    let port = Port::start(hub.clone()).await;
    let connecting = tokio::spawn(connect(port.addr, "inst-1"));
    gateway.open("inst-1", "t1", SCOPE_1, "r1").await;
    let mut agent = connecting.await.unwrap();
    gateway.stall.store(true, Ordering::SeqCst);
    // Far more than the link's socket buffers and the agent's credit
    // hold, so the host's writes to the gateway block.
    let started = tokio::time::Instant::now();
    let client = agent.client.clone();
    let flood = tokio::spawn(async move {
        let payload = Bytes::from(vec![0; 512 << 10]);
        for _ in 0..256 {
            if client
                .publish(format!("{SCOPE_1}.out"), payload.clone())
                .await
                .is_err()
            {
                return;
            }
        }
    });
    agent.disconnected().await;
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the link outlived its silence deadline by {:?}",
        started.elapsed()
    );
    flood.abort();
    port.stop();
}
