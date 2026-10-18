//! Runs the [`Core`]: one task owns it and does what it asks, while each
//! link and each guest connection has tasks of its own that only move
//! bytes.

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use compute_protocol::link::{AgentLink, Running, encode};
use futures::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::core::{ConnId, Core, Effect, Input, LinkId, Settings};
use crate::guest::{self, Out};
use crate::link;
use crate::saved::Saved;

/// A host token for one gateway, from the fleet.
#[derive(Clone)]
pub struct HostToken {
    pub token: String,
    pub expires_at_ms: u64,
}

impl fmt::Debug for HostToken {
    /// Never shows the token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostToken")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

/// Where the host gets its tokens.
pub trait Tokens: Send + Sync + 'static {
    /// A fresh token for `gateway`.
    fn token(&self, gateway: &str) -> BoxFuture<'static, Result<HostToken, String>>;
}

/// Wakes one sandbox.
pub trait Wake: Send + Sync + 'static {
    /// Wake it if it sleeps, and count it as active.
    fn wake(&self);
}

/// How links are kept.
#[derive(Clone, Debug)]
pub struct Timing {
    /// The host pings a link this often.
    pub ping_every: Duration,
    /// A link silent this long is closed.
    pub silence: Duration,
    /// Back-off between dials: full jitter, doubling from `backoff_min`
    /// up to `backoff_max`.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// How long connecting, the handshake and the gateway's hello may take.
    pub connect_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ping_every: Duration::from_secs(20),
            silence: Duration::from_secs(60),
            backoff_min: Duration::from_millis(100),
            backoff_max: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(10),
        }
    }
}

/// What a [`Hub`] needs.
pub struct HubConfig {
    pub tokens: Arc<dyn Tokens>,
    /// For `wss://` gateways.
    pub tls: Arc<rustls::ClientConfig>,
    pub settings: Settings,
    pub timing: Timing,
}

impl fmt::Debug for HubConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HubConfig")
            .field("settings", &self.settings)
            .field("timing", &self.timing)
            .finish_non_exhaustive()
    }
}

/// The host's agent links. Cheap to clone; the hub runs while a clone
/// lives, and when the last goes its links close and its guest
/// connections end.
#[derive(Clone, Debug)]
pub struct Hub {
    commands: mpsc::UnboundedSender<Command>,
    next_conn: Arc<AtomicU64>,
    /// Stops the hub when the last clone goes: its links and guest
    /// connections hold senders too, so the channel alone would not.
    _running: Arc<DropGuard>,
}

pub(crate) enum Command {
    Input(Input),
    Attach {
        sandbox: String,
        link: AgentLink,
        saved: Option<Saved>,
        save_at: PathBuf,
        wake: Arc<dyn Wake>,
    },
    Detach {
        sandbox: String,
    },
    Conn {
        conn: ConnId,
        sandbox: String,
        writer: mpsc::UnboundedSender<Out>,
    },
    LinkUp {
        gateway: String,
        link: LinkId,
        max_payload: u32,
        writer: mpsc::UnboundedSender<Vec<u8>>,
    },
}

impl Hub {
    /// Starts the hub. Must run inside a Tokio runtime.
    #[must_use]
    pub fn start(config: HubConfig) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let (saves, to_save) = mpsc::unbounded_channel();
        tokio::spawn(save_all(to_save));
        let stop = CancellationToken::new();
        let actor = Actor {
            core: Core::new(config.settings),
            started: Instant::now(),
            tokens: config.tokens,
            tls: config.tls,
            timing: config.timing,
            commands: commands.downgrade(),
            wakers: HashMap::new(),
            save_paths: HashMap::new(),
            conns: HashMap::new(),
            links: HashMap::new(),
            writers: HashMap::new(),
            saves,
            link_ids: Arc::new(AtomicU64::new(1)),
        };
        tokio::spawn(actor.run(receiver, stop.clone()));
        Self {
            commands,
            next_conn: Arc::new(AtomicU64::new(1)),
            _running: Arc::new(stop.drop_guard()),
        }
    }

    /// Attaches a sandbox whose agent is reached through `link`, keeping
    /// its session at `save_at`. Again for an attached sandbox, it takes a
    /// new ticket or gateway.
    pub fn attach(&self, sandbox: String, link: AgentLink, save_at: PathBuf, wake: Arc<dyn Wake>) {
        let saved = Saved::load(&save_at).unwrap_or_else(|error| {
            tracing::warn!(%sandbox, %error, "could not read an agent-link session");
            None
        });
        let _ = self.commands.send(Command::Attach {
            sandbox,
            link,
            saved,
            save_at,
            wake,
        });
    }

    /// The sandbox left the host: its session ends and its kept copy goes.
    pub fn detach(&self, sandbox: &str) {
        let _ = self.commands.send(Command::Detach {
            sandbox: sandbox.to_owned(),
        });
    }

    /// Tells the sandbox's gateway whether it runs, when that changed, and
    /// every session that opens for it later. An attached sandbox's state
    /// is unknown until the first call.
    pub fn running(&self, sandbox: &str, running: Running) {
        let _ = self.commands.send(Command::Input(Input::Running {
            sandbox: sandbox.to_owned(),
            running,
        }));
    }

    /// Serves one connection the sandbox's guest opened to its link port.
    pub fn serve<S>(&self, sandbox: String, stream: S)
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        guest::serve(&self.commands, conn, sandbox, stream);
    }
}

struct Actor {
    core: Core,
    started: Instant,
    tokens: Arc<dyn Tokens>,
    tls: Arc<rustls::ClientConfig>,
    timing: Timing,
    commands: mpsc::WeakUnboundedSender<Command>,
    wakers: HashMap<String, Arc<dyn Wake>>,
    save_paths: HashMap<String, PathBuf>,
    conns: HashMap<ConnId, mpsc::UnboundedSender<Out>>,
    /// The task keeping each gateway's link.
    links: HashMap<String, CancellationToken>,
    writers: HashMap<LinkId, mpsc::UnboundedSender<Vec<u8>>>,
    saves: mpsc::UnboundedSender<(PathBuf, Option<Saved>)>,
    link_ids: Arc<AtomicU64>,
}

impl Actor {
    fn now(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    async fn run(
        mut self,
        mut commands: mpsc::UnboundedReceiver<Command>,
        stop: CancellationToken,
    ) {
        loop {
            let deadline = self
                .core
                .deadline()
                .map(|ms| self.started + Duration::from_millis(ms));
            tokio::select! {
                () = stop.cancelled() => break,
                command = commands.recv() => match command {
                    Some(command) => self.command(command),
                    None => break,
                },
                () = sleep_until(deadline), if deadline.is_some() => {
                    let now = self.now();
                    self.core.on(now, Input::Tick);
                    self.apply();
                }
            }
        }
        for cancel in self.links.values() {
            cancel.cancel();
        }
        // Dropping their writers ends the guest connections.
        self.conns.clear();
    }

    fn command(&mut self, command: Command) {
        let now = self.now();
        match command {
            Command::Input(input) => {
                match &input {
                    Input::LinkDown { link } => {
                        self.writers.remove(link);
                    }
                    Input::GuestClosed { conn } => {
                        self.conns.remove(conn);
                    }
                    _ => {}
                }
                self.core.on(now, input);
            }
            Command::Attach {
                sandbox,
                link,
                saved,
                save_at,
                wake,
            } => {
                self.wakers.insert(sandbox.clone(), wake);
                self.save_paths.insert(sandbox.clone(), save_at);
                self.core.on(
                    now,
                    Input::Attach {
                        sandbox,
                        link,
                        saved,
                    },
                );
            }
            Command::Detach { sandbox } => {
                self.core.on(
                    now,
                    Input::Detach {
                        sandbox: sandbox.clone(),
                    },
                );
                self.apply();
                self.wakers.remove(&sandbox);
                self.save_paths.remove(&sandbox);
                return;
            }
            Command::Conn {
                conn,
                sandbox,
                writer,
            } => {
                self.conns.insert(conn, writer);
                self.core.on(now, Input::Accepted { conn, sandbox });
            }
            Command::LinkUp {
                gateway,
                link,
                max_payload,
                writer,
            } => {
                self.writers.insert(link, writer);
                self.core.on(
                    now,
                    Input::LinkUp {
                        gateway,
                        link,
                        max_payload,
                    },
                );
            }
        }
        self.apply();
    }

    fn apply(&mut self) {
        for effect in self.core.take() {
            match effect {
                Effect::Dial { gateway } => self.dial(gateway),
                Effect::Hangup { gateway } => {
                    if let Some(cancel) = self.links.remove(&gateway) {
                        cancel.cancel();
                    }
                }
                Effect::Frame {
                    link,
                    frame,
                    payload,
                } => {
                    if let Some(writer) = self.writers.get(&link) {
                        match encode(&frame, &payload) {
                            Ok(bytes) => {
                                let _ = writer.send(bytes);
                            }
                            Err(error) => tracing::error!(%error, "a frame did not encode"),
                        }
                    }
                }
                Effect::ToGuest { conn, op } => {
                    if let Some(writer) = self.conns.get(&conn) {
                        let _ = writer.send(Out::Op(op));
                    }
                }
                Effect::CloseGuest { conn } => {
                    if let Some(writer) = self.conns.remove(&conn) {
                        let _ = writer.send(Out::Close);
                    }
                }
                Effect::Wake { sandbox } => {
                    if let Some(wake) = self.wakers.get(&sandbox) {
                        wake.wake();
                    }
                }
                Effect::Save { sandbox, saved } => {
                    if let Some(path) = self.save_paths.get(&sandbox) {
                        let _ = self.saves.send((path.clone(), saved));
                    }
                }
            }
        }
    }

    fn dial(&mut self, gateway: String) {
        let Some(commands) = self.commands.upgrade() else {
            return;
        };
        let cancel = CancellationToken::new();
        self.links.insert(gateway.clone(), cancel.clone());
        tokio::spawn(link::keep(link::Keep {
            gateway,
            tokens: Arc::clone(&self.tokens),
            tls: Arc::clone(&self.tls),
            timing: self.timing.clone(),
            hub: commands.downgrade(),
            ids: Arc::clone(&self.link_ids),
            cancel,
        }));
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Writes kept sessions one at a time, so the last one written for a
/// sandbox is the last one asked for.
async fn save_all(mut saves: mpsc::UnboundedReceiver<(PathBuf, Option<Saved>)>) {
    while let Some((path, saved)) = saves.recv().await {
        if let Err(error) = Saved::store(&path, saved.as_ref()).await {
            tracing::warn!(path = %path.display(), %error, "could not keep an agent-link session");
        }
    }
}
