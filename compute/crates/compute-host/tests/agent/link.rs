//! Sandboxes that run Opengeni's agent, reached through the host's agent
//! link (ADR 21): the guest's connection to its link port reaches a gateway
//! over the host's one WebSocket, a sleeping sandbox wakes for a message,
//! a new ticket opens the session again, and the session outlives the host
//! agent's restart and ends when the sandbox goes.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_core::HostPolicy;
use compute_host::protocol::{Id, LevelName, Reply, Request, SandboxConfig};
use compute_link::{HostToken, Hub, HubConfig, Timing, Tokens};
use compute_protocol::link::{
    AGENT_LINK_PORT, AgentLink, GatewayFrame, HostFrame, Relay, SUBPROTOCOL, VERSION, decode,
    encode,
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

/// Hands out tokens as the fleet service would.
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
    Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        |config| config.agent_link = Some(hub()),
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
/// every frame a host sends but `state`, and sends what the test asks on
/// the latest link.
struct Gateway {
    url: String,
    events: mpsc::UnboundedReceiver<Event>,
    out: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<Message>>>>,
}

impl Gateway {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agent-link", listener.local_addr().unwrap());
        let (events, receiver) = mpsc::unbounded_channel();
        let out = Arc::new(std::sync::Mutex::new(None));
        tokio::spawn(accept(listener, events, Arc::clone(&out)));
        Self {
            url,
            events: receiver,
            out,
        }
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
                            if !matches!(frame, HostFrame::State { .. }) {
                                let _ = events.send(Event::Frame(frame));
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

// The guest's agent, speaking NATS on its link socket.

struct Agent {
    lines: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Agent {
    /// Connects as instance `inst-1`, once the host has said `INFO`, and
    /// pings; [`Self::connected`] waits for the answer.
    async fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).await.unwrap();
        let (reader, writer) = stream.into_split();
        let mut agent = Self {
            lines: BufReader::new(reader),
            writer,
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
async fn a_sandbox_agent_reaches_its_gateway_and_a_message_wakes_its_sleeping_sandbox() {
    let mut gateway = Gateway::start().await;
    let lab = linked_lab(Lab::root(), Arc::default()).await;
    let sandbox = id(1);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    lab.wake(sandbox).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, s) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;

    let subject = format!("{SCOPE}.rpc");
    agent.send(&format!("SUB {subject} 1\r\n")).await;
    let HostFrame::Sub {
        sid, subject: sent, ..
    } = gateway.frame().await
    else {
        panic!("expected sub");
    };
    assert_eq!(sent, subject);

    // Saved, its VM is gone, and so is the guest's connection with it.
    lab.sleep_to(sandbox, LevelName::Saved).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    drop(agent);
    gateway.send(&GatewayFrame::Msg {
        s,
        sid,
        subject: subject.clone(),
        reply: None,
        headers: None,
    });
    lab.wait_level(sandbox, LevelName::Running).await;

    // The woken agent connects again with the same instance and takes up
    // the same session; the message waits for its subscription.
    let socket_path = socket.clone();
    let mut agent = Agent::connect(&socket_path).await;
    agent.connected().await;
    agent.send(&format!("SUB {subject} 1\r\n")).await;
    let message = agent.line().await;
    assert!(
        message.starts_with(&format!("MSG {subject} 1 0")),
        "{message}"
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
    let lab = linked_lab(Lab::root(), Arc::default()).await;
    let sandbox = id(3);
    create(&lab, sandbox, config(&gateway, "ticket-1")).await;
    gateway.up().await;
    let socket = link_socket(&lab.sandbox_dir(sandbox));
    let (mut agent, _) = connect(&mut gateway, &socket, sandbox, "ticket-1").await;
    let subject = format!("{SCOPE}.rpc");
    agent.send(&format!("SUB {subject} 1\r\n")).await;
    assert!(matches!(gateway.frame().await, HostFrame::Sub { .. }));
    // The session is kept on disk as the subscription is taken.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    drop(agent);
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
    lab.assert_clean();
}
