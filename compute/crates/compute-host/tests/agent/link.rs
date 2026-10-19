//! Sandboxes that run Opengeni's agent, reached through the host's agent
//! link (ADR 21): the guest's connection to its link port reaches a gateway
//! over the host's one WebSocket, as a stream that outlives the vsock
//! connections under it; a sleeping sandbox wakes for a message, the
//! gateway hears when it sleeps and wakes, a new ticket opens the session
//! again, and the session outlives the host agent's restart and ends when
//! the sandbox goes.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_core::HostPolicy;
use compute_guest::resume::StreamId;
use compute_host::protocol::{Id, LevelName, Reply, Request, SandboxConfig};
use compute_link::{HostToken, Hub, HubConfig, Timing, Tokens};
use compute_protocol::fleet::{Ruling, Verdict};
use compute_protocol::link::{
    AGENT_LINK_PORT, AgentLink, GatewayFrame, HostFrame, Relay, Running, SUBPROTOCOL, VERSION,
    decode, encode,
};
use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, UnixStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request as Upgrade, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;

use super::{Delays, Lab, NEVER, id};

const WAIT: Duration = Duration::from_secs(5);
const SCOPE: &str = "agent.w1.a1.connection.inst-1";

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// Hands out tokens as the control service would.
struct Fleet;

impl Tokens for Fleet {
    fn token(&self, _gateway: &str) -> BoxFuture<'static, Result<HostToken, String>> {
        Box::pin(async {
            Ok(HostToken {
                token: "host-token".into(),
                expires_at_ms: now_ms() + 3_600_000,
            })
        })
    }
}

fn hub() -> Hub {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    Hub::start(HubConfig {
        tokens: Arc::new(Fleet),
        tls: Arc::new(tls),
        settings: compute_link::core::Settings::default(),
        timing: Timing::default(),
    })
}

async fn linked_lab(root: PathBuf, world: Arc<super::World>) -> Lab {
    linked_lab_with(root, world, hub()).await
}

async fn linked_lab_with(root: PathBuf, world: Arc<super::World>, hub: Hub) -> Lab {
    Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        |config| config.agent_link = Some(hub),
    )
    .await
}

fn config(gateway: &Gateway, ticket: &str) -> SandboxConfig {
    SandboxConfig {
        image: None,
        vcpus: 1,
        memory_mib: 256,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: NEVER,
        link: Some(AgentLink {
            gateway: gateway.url.clone(),
            ticket: ticket.into(),
        }),
    }
}

async fn create(lab: &Lab, sandbox: Id, config: SandboxConfig) {
    let reply = lab
        .client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Done), "{reply:?}");
}

/// The socket the sandbox's guest reaches its agent link through.
fn link_socket(dir: &Path) -> PathBuf {
    let name = format!("vsock.sock_{AGENT_LINK_PORT}");
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|found| *found == *name) {
                return path;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(path);
            }
        }
    }
    panic!("no agent-link socket under {}", dir.display());
}

// The gateway.

#[derive(Debug)]
enum Event {
    Up,
    Frame(HostFrame),
    Down,
}

/// A gateway on a local port: it says hello to each link, hands the test
/// every frame a host sends but `state`, which it keeps in order, and sends
/// what the test asks on the latest link.
struct Gateway {
    url: String,
    events: mpsc::UnboundedReceiver<Event>,
    out: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<Message>>>>,
    states: Arc<std::sync::Mutex<Vec<Running>>>,
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agent-link", listener.local_addr().unwrap());
        let (events, receiver) = mpsc::unbounded_channel();
        let out = Arc::new(std::sync::Mutex::new(None));
        let states = Arc::default();
        tokio::spawn(accept(
            listener,
            events,
            Arc::clone(&out),
            Arc::clone(&states),
        ));
        Self {
            url,
            events: receiver,
            out,
            states,
        }
    }

    /// Waits until the latest `state` frame says `want`, and returns every
    /// one heard so far.
    async fn told(&self, want: Running) -> Vec<Running> {
        timeout(WAIT, async {
            loop {
                let states = self.states.lock().unwrap().clone();
                if states.last() == Some(&want) {
                    return states;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "the gateway was not told {want:?}: {:?}",
                self.states.lock().unwrap()
            )
        })
    }

    async fn next(&mut self) -> Event {
        timeout(WAIT, self.events.recv())
            .await
            .expect("the gateway heard nothing")
            .expect("the gateway stopped")
    }

    async fn up(&mut self) {
        loop {
            match self.next().await {
                Event::Up => return,
                Event::Down => {}
                Event::Frame(frame) => panic!("a frame before the link: {frame:?}"),
            }
        }
    }

    async fn frame(&mut self) -> HostFrame {
        match self.next().await {
            Event::Frame(frame) => frame,
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    fn send(&self, frame: &GatewayFrame) {
        let out = self.out.lock().unwrap();
        out.as_ref()
            .expect("no link is up")
            .send(Message::Binary(encode(frame, b"").unwrap().into()))
            .unwrap();
    }

    /// Waits for `open` for `sandbox` under `ticket` and answers `opened`.
    async fn open(&mut self, sandbox: Id, ticket: &str) -> u32 {
        let HostFrame::Open {
            s,
            sandbox: named,
            ticket: sent,
            connection,
        } = self.frame().await
        else {
            panic!("expected open");
        };
        assert_eq!(named, sandbox.to_string());
        assert_eq!(sent, ticket);
        assert_eq!(connection, "inst-1");
        self.send(&GatewayFrame::Opened {
            s,
            scope: SCOPE.into(),
            relay: Relay {
                url: "wss://relay.example/v1".into(),
                token: "relay-token".into(),
                expires_at_ms: now_ms() + 600_000,
            },
        });
        s
    }
}

#[expect(
    clippy::result_large_err,
    reason = "the WebSocket handshake's callback type"
)]
async fn accept(
    listener: TcpListener,
    events: mpsc::UnboundedSender<Event>,
    out: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<Message>>>>,
    states: Arc<std::sync::Mutex<Vec<Running>>>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let callback = |_: &Upgrade, mut response: Response| {
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
        let hello = Message::Binary(encode(&hello, b"").unwrap().into());
        if socket.send(hello).await.is_err() {
            continue;
        }
        let (sender, mut outgoing) = mpsc::unbounded_channel();
        *out.lock().unwrap() = Some(sender);
        let _ = events.send(Event::Up);
        let events = events.clone();
        let states = Arc::clone(&states);
        tokio::spawn(async move {
            loop {
                tokio::select! {
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
                            let (frame, _) = decode::<HostFrame>(&bytes).unwrap();
                            match frame {
                                HostFrame::State { state, .. } => {
                                    states.lock().unwrap().push(state);
                                }
                                frame => {
                                    let _ = events.send(Event::Frame(frame));
                                }
                            }
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

// The guest's agent, speaking NATS through the guest's forwarder to its
// link socket.

/// The connections the guest's forwarder holds to the host under an
/// agent's stream, and whether its VM runs to open more.
#[derive(Default)]
struct Vm {
    connections: Mutex<Vec<std::os::unix::net::UnixStream>>,
    down: AtomicBool,
}

impl Vm {
    /// The VM stops, as it does when it is saved: the connections under
    /// the stream end with it, and no more open until it runs.
    fn stop(&self) {
        self.down.store(true, Ordering::SeqCst);
        for connection in self.connections.lock().unwrap().drain(..) {
            let _ = connection.shutdown(std::net::Shutdown::Both);
        }
    }

    fn run(&self) {
        self.down.store(false, Ordering::SeqCst);
    }

    fn dial(&self, socket: &Path) -> io::Result<std::os::unix::net::UnixStream> {
        if self.down.load(Ordering::SeqCst) {
            return Err(io::ErrorKind::ConnectionRefused.into());
        }
        let connection = std::os::unix::net::UnixStream::connect(socket)?;
        self.connections
            .lock()
            .unwrap()
            .push(connection.try_clone()?);
        Ok(connection)
    }
}

struct Agent {
    lines: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    vm: Arc<Vm>,
}

impl Agent {
    /// Connects as instance `inst-1` through the guest's forwarder, which
    /// carries the connection as a new stream, once the host has said
    /// `INFO`, and pings; [`Self::connected`] waits for the answer.
    async fn connect(socket: &Path) -> Self {
        static STREAMS: AtomicU64 = AtomicU64::new(1);
        let id = StreamId(u128::from(STREAMS.fetch_add(1, Ordering::Relaxed)));
        let (local, forwarded) = std::os::unix::net::UnixStream::pair().unwrap();
        let vm = Arc::new(Vm::default());
        let socket = socket.to_path_buf();
        let dialer = Arc::clone(&vm);
        std::thread::spawn(move || {
            compute_guest::resume::relay::relay(forwarded, id, || dialer.dial(&socket), |_| {})
        });
        local.set_nonblocking(true).unwrap();
        let stream = UnixStream::from_std(local).unwrap();
        let (reader, writer) = stream.into_split();
        let mut agent = Self {
            lines: BufReader::new(reader),
            writer,
            vm,
        };
        let info = agent.line().await;
        assert!(info.starts_with("INFO "), "{info}");
        agent
            .send(
                "CONNECT {\"verbose\":false,\"headers\":true,\
                 \"name\":\"opengeni-agent/connection/inst-1\"}\r\nPING\r\n",
            )
            .await;
        agent
    }

    async fn connected(&mut self) {
        assert_eq!(self.line().await, "PONG\r\n");
    }

    async fn send(&mut self, text: &str) {
        self.writer.write_all(text.as_bytes()).await.unwrap();
    }

    async fn line(&mut self) -> String {
        let mut line = String::new();
        timeout(WAIT, self.lines.read_line(&mut line))
            .await
            .expect("the host said nothing")
            .unwrap();
        line
    }

    /// Whether the host ended the connection.
    async fn ended(&mut self) -> bool {
        let mut line = String::new();
        matches!(
            timeout(WAIT, self.lines.read_line(&mut line)).await,
            Ok(Ok(0))
        )
    }
}

/// Connects the sandbox's agent through `socket`, answering the gateway's
/// side as it opens the session under `ticket`.
async fn connect(gateway: &mut Gateway, socket: &Path, sandbox: Id, ticket: &str) -> (Agent, u32) {
    let socket = socket.to_path_buf();
    let agent = tokio::spawn(async move { Agent::connect(&socket).await });
    let s = gateway.open(sandbox, ticket).await;
    let mut agent = agent.await.unwrap();
    agent.connected().await;
    (agent, s)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_agent_reaches_its_gateway_and_only_a_request_wakes_its_sleeping_sandbox() {
    let mut gateway = Gateway::start().await;
    let lab = linked_lab(Lab::root(), Arc::default()).await;
    let sandbox = id(1);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    lab.wake(sandbox).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, s) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;
    // It runs, and its session is told so when it opens.
    gateway.told(Running::Awake).await;

    let subject = format!("{SCOPE}.rpc");
    agent.send(&format!("SUB {subject} 1\r\n")).await;
    let HostFrame::Sub {
        sid, subject: sent, ..
    } = gateway.frame().await
    else {
        panic!("expected sub");
    };
    assert_eq!(sent, subject);

    // Saved, its VM is gone, and so are the connections under the agent's
    // stream with it; the agent's own connection, inside the VM, stays.
    lab.sleep_to(sandbox, LevelName::Saved).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    gateway.told(Running::Asleep).await;
    agent.vm.stop();
    // An acknowledgement of what the agent sent before it slept waits for
    // it, and the sandbox stays asleep.
    gateway.send(&GatewayFrame::Msg {
        s,
        sid,
        subject: subject.clone(),
        reply: None,
        headers: None,
    });
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let status = lab.status().await;
        let held = status.sandboxes.iter().find(|held| held.id == sandbox);
        assert!(
            held.is_some_and(|held| held.level == LevelName::Saved && held.step.is_none()),
            "an acknowledgement woke it: {held:?}"
        );
    }
    // A request wakes it.
    gateway.send(&GatewayFrame::Msg {
        s,
        sid,
        subject: subject.clone(),
        reply: Some("_INBOX.gw.1".into()),
        headers: None,
    });
    lab.wait_level(sandbox, LevelName::Running).await;

    // The woken guest takes the stream up again, and the messages the host
    // kept on it reach the agent, in order, on the connection it
    // subscribed on.
    agent.vm.run();
    let message = agent.line().await;
    assert!(
        message.starts_with(&format!("MSG {subject} 1 0")),
        "{message}"
    );
    assert_eq!(agent.line().await, "\r\n", "its empty payload");
    let message = agent.line().await;
    assert!(
        message.starts_with(&format!("MSG {subject} 1 _INBOX.gw.1 0")),
        "{message}"
    );
    assert_eq!(agent.line().await, "\r\n", "its empty payload");
    // The agent's connection never ended: it still answers, over the one
    // vsock connection the woken guest opened.
    agent.send("PING\r\n").await;
    assert_eq!(agent.line().await, "PONG\r\n");
    assert_eq!(agent.vm.connections.lock().unwrap().len(), 1);
    // Told once of each change: going to sleep, through every level on
    // the way down, is one change.
    assert_eq!(
        gateway.told(Running::Awake).await,
        [Running::Awake, Running::Asleep, Running::Awake]
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_ticket_opens_the_session_again_and_removing_the_sandbox_closes_it() {
    let mut gateway = Gateway::start().await;
    let lab = linked_lab(Lab::root(), Arc::default()).await;
    let sandbox = id(2);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, first) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;

    // The same create, sent again with the link changed, takes it up: the
    // session closes, the agent is let go and is let in again by the new
    // ticket.
    create(&lab, sandbox, config(&gateway, "ticket-2")).await;
    assert_eq!(gateway.frame().await, HostFrame::Close { s: first });
    assert!(
        agent.ended().await,
        "the agent's connection outlived its ticket"
    );
    let record = lab.record(sandbox);
    assert_eq!(record["config"]["link"]["ticket"], "ticket-2");
    let (_agent, second) = connect(&mut gateway, &socket, sandbox, "ticket-2").await;

    // Other settings are another sandbox's.
    let mut other = config(&gateway, "ticket-2");
    other.memory_mib = 512;
    let reply = lab
        .client
        .call(&Request::Create {
            id: sandbox,
            config: other,
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");

    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Done), "{reply:?}");
    assert_eq!(gateway.frame().await, HostFrame::Close { s: second });
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_host_opens_its_sandboxes_sessions_again_before_their_agents_connect() {
    let mut gateway = Gateway::start().await;
    let links = hub();
    let lab = linked_lab_with(Lab::root(), Arc::default(), links.clone()).await;
    let sandbox = id(3);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, _) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;
    let subject = format!("{SCOPE}.rpc");
    agent.send(&format!("SUB {subject} 1\r\n")).await;
    assert!(matches!(gateway.frame().await, HostFrame::Sub { .. }));

    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    // Stopped, the hub has written the session it was asked to keep as
    // the subscription was taken.
    links.shutdown().await;
    let kept = std::fs::read_to_string(dir.join("agent-link.json"))
        .expect("the session is kept in the sandbox's directory");
    assert!(kept.contains(&subject), "{kept}");
    let lab = linked_lab(root, world).await;
    gateway.up().await;
    // The session opens again under the kept instance before the agent
    // connects, and once it is open the kept subscription is taken again,
    // with the sid the gateway knew.
    gateway.open(sandbox, "ticket-1").await;
    let HostFrame::Sub {
        sid, subject: kept, ..
    } = gateway.frame().await
    else {
        panic!("expected the kept subscription");
    };
    assert_eq!(kept, subject);
    assert_eq!(sid, 1);
    // The restarted host knows no stream of the guest's: the agent's
    // connection ends, as one to a NATS server that went away does, and
    // the agent connects again.
    assert!(
        agent.ended().await,
        "a stream outlived the host agent that carried it"
    );
    lab.assert_clean();
}

/// The control service's rulings carry each kept sandbox's link: a new owner
/// epoch's ticket opens the session again under it, and a ruling with no
/// link ends the session even at the epoch the sandbox already had.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ruling_gives_a_kept_sandbox_the_link_for_its_new_epoch() {
    let mut gateway = Gateway::start().await;
    let lab = linked_lab(Lab::root(), Arc::default()).await;
    let sandbox = id(4);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, first) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;

    let url = gateway.url.clone();
    let link = |ticket: &str| AgentLink {
        gateway: url.clone(),
        ticket: ticket.into(),
    };
    let keep = |link: Option<AgentLink>| {
        vec![Ruling {
            id: sandbox,
            verdict: Verdict::Keep { owner_epoch: 5 },
            link,
        }]
    };
    lab.handle
        .reconcile(keep(Some(link("ticket-5"))))
        .await
        .unwrap();
    assert_eq!(gateway.frame().await, HostFrame::Close { s: first });
    assert!(agent.ended().await, "the old ticket's agent was let go");
    let record = lab.record(sandbox);
    assert_eq!(record["config"]["link"]["ticket"], "ticket-5");
    let (_agent, second) = connect(&mut gateway, &socket, sandbox, "ticket-5").await;

    // Kept again under the same epoch: nothing changes while the link is
    // the same, and the session ends once the service names none.
    lab.handle
        .reconcile(keep(Some(link("ticket-5"))))
        .await
        .unwrap();
    lab.handle.reconcile(keep(None)).await.unwrap();
    assert_eq!(gateway.frame().await, HostFrame::Close { s: second });
    assert!(lab.record(sandbox)["config"].get("link").is_none());
    lab.assert_clean();
}
