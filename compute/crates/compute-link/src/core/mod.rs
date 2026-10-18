//! The agent link's logic, without input or output: what the host does
//! for each operation a guest's agent sends, each frame a gateway sends and
//! each link that comes or goes. [`crate::hub`] runs it; tests drive it
//! directly.
//!
//! The rules ([`docs/agent-link.md`](../../../docs/agent-link.md),
//! sections 3 and 5):
//!
//! - A guest's connection gets `INFO` once its gateway's link is up, and
//!   the `PONG` for its first `PING` once its session is open, so an agent
//!   that counts itself connected is reachable end to end. A link that
//!   goes ends the connections of its sandboxes, as a server that goes
//!   would.
//! - A session belongs to the sandbox and the agent's connection instance,
//!   not to one connection: it stays open while the sandbox sleeps, and a
//!   connection with the same instance takes up its subscriptions. An agent
//!   holds several connections at once (Opengeni's agent opens a control
//!   and a bulk one), each with subscriptions of its own; a connection of
//!   another instance starts a new session and ends them all.
//! - A message for a subscription no connection holds waits, and wakes the
//!   sandbox, until a connection subscribes to it again or it has waited
//!   [`Settings::hold_ms`]. Every message that arrives counts as activity.
//! - Subscriptions a reconnected agent did not take up within
//!   [`Settings::grace_ms`] end, and so do those of a connection that
//!   ended while others of its agent stay.

mod conns;
mod frames;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use bytes::Bytes;
use compute_protocol::link::{AgentLink, GatewayFrame, Headers, HostFrame, Relay, Running};

use crate::nats::{ClientOp, ServerOp};
use crate::saved::{Saved, SavedSub};

/// A guest connection's number, unique on the host.
pub type ConnId = u64;
/// A link's number, unique on the host: each time a gateway's link comes
/// up it has a new one.
pub type LinkId = u64;

/// The prefix of an agent's `CONNECT` name, before its instance.
pub const CONNECTION_NAME: &str = "opengeni-agent/connection/";

/// How the host keeps sessions.
#[derive(Clone, Debug)]
pub struct Settings {
    /// How long a message waits for a connection to take it.
    pub hold_ms: u64,
    /// How long a reconnected agent has to subscribe again.
    pub grace_ms: u64,
    /// The first wait before opening a session again after a transient
    /// refusal; it doubles up to `retry_max_ms`.
    pub retry_min_ms: u64,
    pub retry_max_ms: u64,
    /// Arriving messages wake a sandbox at most this often.
    pub wake_every_ms: u64,
    /// Bytes a connection may send before its session opens.
    pub pending_bytes: usize,
    /// Seeds the jitter of retries.
    pub seed: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hold_ms: 120_000,
            grace_ms: 10_000,
            retry_min_ms: 1_000,
            retry_max_ms: 30_000,
            wake_every_ms: 250,
            pending_bytes: 4 << 20,
            seed: 0x9e37_79b9_7f4a_7c15,
        }
    }
}

/// Something that happened.
#[derive(Clone, Debug)]
pub enum Input {
    /// A sandbox on the host runs Opengeni's agent behind `link`, with the
    /// session kept on disk, if any. Again for a sandbox already attached,
    /// a new ticket or gateway, as after it was adopted again.
    Attach {
        sandbox: String,
        link: AgentLink,
        saved: Option<Saved>,
    },
    /// The sandbox left the host: its session ends.
    Detach { sandbox: String },
    /// A guest connection for `sandbox` was accepted.
    Accepted { conn: ConnId, sandbox: String },
    /// A guest connection sent an operation.
    Guest { conn: ConnId, op: ClientOp },
    /// A guest connection ended.
    GuestClosed { conn: ConnId },
    /// `gateway`'s link came up and said hello.
    LinkUp {
        gateway: String,
        link: LinkId,
        max_payload: u32,
    },
    /// A frame arrived on a link.
    Gateway {
        link: LinkId,
        frame: GatewayFrame,
        payload: Bytes,
    },
    /// A link went.
    LinkDown { link: LinkId },
    /// Whether a sandbox runs, for its gateway to show.
    Running { sandbox: String, running: Running },
    /// Time passed.
    Tick,
}

/// Something the host is to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Keep a link to `gateway` up.
    Dial { gateway: String },
    /// No sandbox needs `gateway` any more.
    Hangup { gateway: String },
    /// Send a frame on a link.
    Frame {
        link: LinkId,
        frame: HostFrame,
        payload: Bytes,
    },
    /// Send an operation to a guest connection.
    ToGuest { conn: ConnId, op: ServerOp },
    /// End a guest connection, after what was sent to it.
    CloseGuest { conn: ConnId },
    /// Wake the sandbox, if it sleeps, and count it as active.
    Wake { sandbox: String },
    /// Keep the sandbox's session on disk, or remove it for `None`.
    Save {
        sandbox: String,
        saved: Option<Saved>,
    },
}

/// The host's sessions.
#[derive(Debug)]
pub struct Core {
    settings: Settings,
    rng: u64,
    sandboxes: HashMap<String, Sandbox>,
    conns: HashMap<ConnId, Conn>,
    links: HashMap<String, Link>,
    /// The gateway of each link that is up.
    link_ids: HashMap<LinkId, String>,
    effects: Vec<Effect>,
}

#[derive(Debug)]
struct Sandbox {
    gateway: String,
    ticket: String,
    /// The agent's connection instance, once one connected.
    instance: Option<String>,
    session: Session,
    /// By the host's sid.
    subs: BTreeMap<u32, Sub>,
    next_sid: u32,
    /// Messages for subscriptions no connection holds, oldest first.
    queued: VecDeque<Queued>,
    relay: Option<Relay>,
    /// The connections of its instance that said `CONNECT`.
    conns: BTreeSet<ConnId>,
    /// The gateway refused it for good, until a new ticket.
    refused: bool,
    retry_at: Option<u64>,
    retry_delay: u64,
    /// When the subscriptions no connection took up end.
    grace_until: Option<u64>,
    woke_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Session {
    Idle,
    Opening { link: LinkId, s: u32 },
    Open { link: LinkId, s: u32, scope: String },
}

impl Session {
    fn on(&self) -> Option<(LinkId, u32)> {
        match self {
            Self::Idle => None,
            Self::Opening { link, s } | Self::Open { link, s, .. } => Some((*link, *s)),
        }
    }
}

#[derive(Debug)]
struct Sub {
    subject: String,
    queue: Option<String>,
    /// The connection that holds it, and its sid there.
    guest: Option<(ConnId, String)>,
    /// Messages delivered since that connection subscribed.
    delivered: u64,
    /// Unsubscribe once that many were delivered.
    max: Option<u64>,
}

#[derive(Debug)]
struct Queued {
    sid: u32,
    at: u64,
    subject: String,
    reply: Option<String>,
    headers: Option<Headers>,
    payload: Bytes,
}

#[derive(Debug)]
struct Conn {
    sandbox: String,
    stage: Stage,
    verbose: bool,
    /// What it sent before its session opened, in order.
    pending: Vec<ClientOp>,
    pending_bytes: usize,
    /// Its sids.
    sids: HashMap<String, Target>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Waits for its gateway's link, to send `INFO`.
    AwaitInfo,
    AwaitConnect,
    Connected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Host(u32),
    Relay,
}

#[derive(Debug)]
struct Link {
    id: Option<LinkId>,
    max_payload: u32,
    next_s: u32,
    /// The sandbox of each session on the link that is up.
    sessions: HashMap<u32, String>,
}

impl Core {
    #[must_use]
    pub fn new(settings: Settings) -> Self {
        Self {
            rng: settings.seed | 1,
            settings,
            sandboxes: HashMap::new(),
            conns: HashMap::new(),
            links: HashMap::new(),
            link_ids: HashMap::new(),
            effects: Vec::new(),
        }
    }

    /// Takes what is to be done, in order.
    pub fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// When [`Input::Tick`] next has something to do, if ever.
    #[must_use]
    pub fn deadline(&self) -> Option<u64> {
        self.sandboxes
            .values()
            .flat_map(|sandbox| {
                [
                    sandbox
                        .queued
                        .front()
                        .map(|queued| queued.at + self.settings.hold_ms),
                    sandbox.grace_until,
                    sandbox.retry_at,
                ]
            })
            .flatten()
            .min()
    }

    /// Whether `sandbox` is attached.
    #[must_use]
    pub fn attached(&self, sandbox: &str) -> bool {
        self.sandboxes.contains_key(sandbox)
    }

    /// Handles `input`, at `now` in milliseconds.
    pub fn on(&mut self, now: u64, input: Input) {
        match input {
            Input::Attach {
                sandbox,
                link,
                saved,
            } => self.attach(now, &sandbox, link, saved),
            Input::Detach { sandbox } => self.detach(now, &sandbox),
            Input::Accepted { conn, sandbox } => self.accepted(conn, sandbox),
            Input::Guest { conn, op } => self.guest(now, conn, op),
            Input::GuestClosed { conn } => self.drop_conn(now, conn),
            Input::LinkUp {
                gateway,
                link,
                max_payload,
            } => self.link_up(now, &gateway, link, max_payload),
            Input::Gateway {
                link,
                frame,
                payload,
            } => self.gateway(now, link, frame, payload),
            Input::LinkDown { link } => self.link_down(now, link),
            Input::Running { sandbox, running } => self.running(&sandbox, running),
            Input::Tick => self.tick(now),
        }
    }

    fn attach(&mut self, now: u64, id: &str, link: AgentLink, saved: Option<Saved>) {
        if let Some(sandbox) = self.sandboxes.get(id) {
            if sandbox.gateway == link.gateway && sandbox.ticket == link.ticket {
                return;
            }
            // A new placement: its session opens again under the new
            // ticket, and its agent connects again to be let in by it.
            self.end_session(id);
            self.close_sandbox_conns(now, id, None);
            let sandbox = self.sandboxes.get_mut(id).expect("checked above");
            let old = std::mem::replace(&mut sandbox.gateway, link.gateway.clone());
            sandbox.ticket = link.ticket;
            sandbox.refused = false;
            sandbox.retry_at = None;
            sandbox.retry_delay = self.settings.retry_min_ms;
            if old != link.gateway {
                self.use_gateway(&link.gateway);
                self.release_gateway(&old);
            }
            self.try_open(now, id);
            return;
        }
        let (instance, subs, next_sid) = match saved {
            Some(saved) => (
                Some(saved.instance),
                saved
                    .subs
                    .into_iter()
                    .map(|sub| {
                        (
                            sub.sid,
                            Sub {
                                subject: sub.subject,
                                queue: sub.queue,
                                guest: None,
                                delivered: 0,
                                max: None,
                            },
                        )
                    })
                    .collect(),
                saved.next_sid.max(1),
            ),
            None => (None, BTreeMap::new(), 1),
        };
        self.use_gateway(&link.gateway);
        self.sandboxes.insert(
            id.to_owned(),
            Sandbox {
                gateway: link.gateway,
                ticket: link.ticket,
                instance,
                session: Session::Idle,
                subs,
                next_sid,
                queued: VecDeque::new(),
                relay: None,
                conns: BTreeSet::new(),
                refused: false,
                retry_at: None,
                retry_delay: self.settings.retry_min_ms,
                grace_until: None,
                woke_at: None,
            },
        );
        self.try_open(now, id);
    }

    fn detach(&mut self, now: u64, id: &str) {
        if !self.sandboxes.contains_key(id) {
            return;
        }
        self.end_session(id);
        self.close_sandbox_conns(now, id, None);
        let sandbox = self.sandboxes.remove(id).expect("checked above");
        // Connections still waiting for their first operation.
        let waiting: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, conn)| conn.sandbox == id)
            .map(|(conn, _)| *conn)
            .collect();
        for conn in waiting {
            self.close_conn(now, conn, None);
        }
        self.effects.push(Effect::Save {
            sandbox: id.to_owned(),
            saved: None,
        });
        self.release_gateway(&sandbox.gateway);
    }

    fn use_gateway(&mut self, gateway: &str) {
        if !self.links.contains_key(gateway) {
            self.links.insert(
                gateway.to_owned(),
                Link {
                    id: None,
                    max_payload: 0,
                    next_s: 1,
                    sessions: HashMap::new(),
                },
            );
            self.effects.push(Effect::Dial {
                gateway: gateway.to_owned(),
            });
        }
    }

    fn release_gateway(&mut self, gateway: &str) {
        if self
            .sandboxes
            .values()
            .any(|sandbox| sandbox.gateway == gateway)
        {
            return;
        }
        if let Some(link) = self.links.remove(gateway) {
            if let Some(id) = link.id {
                self.link_ids.remove(&id);
            }
            self.effects.push(Effect::Hangup {
                gateway: gateway.to_owned(),
            });
        }
    }

    /// Opens the sandbox's session if it can be: it has an instance, no
    /// session, no refusal or wait, and its link is up.
    fn try_open(&mut self, now: u64, id: &str) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        if sandbox.refused
            || sandbox.session != Session::Idle
            || sandbox.retry_at.is_some_and(|at| at > now)
        {
            return;
        }
        let Some(instance) = sandbox.instance.clone() else {
            return;
        };
        let Some(link) = self.links.get_mut(&sandbox.gateway) else {
            return;
        };
        let Some(link_id) = link.id else {
            return;
        };
        let s = link.next_s;
        link.next_s += 1;
        link.sessions.insert(s, id.to_owned());
        sandbox.session = Session::Opening { link: link_id, s };
        sandbox.retry_at = None;
        self.effects.push(Effect::Frame {
            link: link_id,
            frame: HostFrame::Open {
                s,
                sandbox: id.to_owned(),
                ticket: sandbox.ticket.clone(),
                connection: instance,
            },
            payload: Bytes::new(),
        });
    }

    /// Ends the sandbox's session, if it has one, telling its gateway.
    fn end_session(&mut self, id: &str) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let Some((link_id, s)) = std::mem::replace(&mut sandbox.session, Session::Idle).on() else {
            return;
        };
        let gateway = &sandbox.gateway;
        if let Some(link) = self.links.get_mut(gateway)
            && link.id == Some(link_id)
        {
            link.sessions.remove(&s);
            self.effects.push(Effect::Frame {
                link: link_id,
                frame: HostFrame::Close { s },
                payload: Bytes::new(),
            });
        }
    }

    fn schedule_retry(&mut self, now: u64, id: &str) {
        let jitter = self.random();
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let delay = sandbox.retry_delay;
        // Between half the delay and all of it.
        let wait = delay / 2 + jitter % (delay / 2 + 1);
        sandbox.retry_at = Some(now + wait);
        sandbox.retry_delay = (delay * 2).min(self.settings.retry_max_ms);
    }

    fn random(&mut self) -> u64 {
        // xorshift64*
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        self.rng.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn link_up(&mut self, now: u64, gateway: &str, link_id: LinkId, max_payload: u32) {
        let Some(link) = self.links.get_mut(gateway) else {
            return;
        };
        if let Some(old) = link.id.replace(link_id) {
            self.link_ids.remove(&old);
        }
        link.max_payload = max_payload;
        link.next_s = 1;
        link.sessions.clear();
        self.link_ids.insert(link_id, gateway.to_owned());
        let waiting: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, conn)| {
                conn.stage == Stage::AwaitInfo
                    && self
                        .sandboxes
                        .get(&conn.sandbox)
                        .is_some_and(|sandbox| sandbox.gateway == gateway)
            })
            .map(|(conn, _)| *conn)
            .collect();
        for conn in waiting {
            self.send_info(conn, max_payload);
        }
        let ids: Vec<String> = self
            .sandboxes
            .iter()
            .filter(|(_, sandbox)| sandbox.gateway == gateway)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            // Sessions on the link that went are gone with it.
            if let Some(sandbox) = self.sandboxes.get_mut(&id) {
                sandbox.session = Session::Idle;
            }
            self.try_open(now, &id);
        }
    }

    fn link_down(&mut self, now: u64, link_id: LinkId) {
        let Some(gateway) = self.link_ids.remove(&link_id) else {
            return;
        };
        if let Some(link) = self.links.get_mut(&gateway) {
            link.id = None;
            link.sessions.clear();
        }
        let ids: Vec<String> = self
            .sandboxes
            .iter()
            .filter(|(_, sandbox)| sandbox.gateway == gateway)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(sandbox) = self.sandboxes.get_mut(id) {
                sandbox.session = Session::Idle;
                sandbox.retry_at = None;
            }
        }
        let conns: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, conn)| ids.contains(&conn.sandbox))
            .map(|(conn, _)| *conn)
            .collect();
        for conn in conns {
            self.close_conn(now, conn, None);
        }
    }

    fn running(&mut self, id: &str, running: Running) {
        if let Some(Session::Open { link, s, .. }) =
            self.sandboxes.get(id).map(|sandbox| &sandbox.session)
        {
            self.effects.push(Effect::Frame {
                link: *link,
                frame: HostFrame::State {
                    s: *s,
                    state: running,
                },
                payload: Bytes::new(),
            });
        }
    }

    fn tick(&mut self, now: u64) {
        let hold = self.settings.hold_ms;
        let mut retry = Vec::new();
        let mut graced = Vec::new();
        for (id, sandbox) in &mut self.sandboxes {
            while sandbox
                .queued
                .front()
                .is_some_and(|queued| queued.at + hold <= now)
            {
                sandbox.queued.pop_front();
            }
            if sandbox.grace_until.is_some_and(|at| at <= now) {
                sandbox.grace_until = None;
                graced.push(id.clone());
            }
            if sandbox.retry_at.is_some_and(|at| at <= now) {
                sandbox.retry_at = None;
                retry.push(id.clone());
            }
        }
        for id in graced {
            self.end_unclaimed(&id);
        }
        for id in retry {
            self.try_open(now, &id);
        }
    }

    /// Ends the subscriptions no connection of the session took up.
    fn end_unclaimed(&mut self, id: &str) {
        let Some(sandbox) = self.sandboxes.get(id) else {
            return;
        };
        if sandbox.conns.is_empty() || !matches!(sandbox.session, Session::Open { .. }) {
            return;
        }
        let unclaimed: Vec<u32> = sandbox
            .subs
            .iter()
            .filter(|(_, sub)| sub.guest.is_none())
            .map(|(sid, _)| *sid)
            .collect();
        if unclaimed.is_empty() {
            return;
        }
        for sid in unclaimed {
            self.remove_sub(id, sid, true);
        }
        self.save(id);
    }

    /// Removes a subscription and what waits for it, telling the gateway
    /// when `tell`.
    fn remove_sub(&mut self, id: &str, sid: u32, tell: bool) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let Some(sub) = sandbox.subs.remove(&sid) else {
            return;
        };
        sandbox.queued.retain(|queued| queued.sid != sid);
        if let Some((conn, guest)) = sub.guest
            && let Some(conn) = self.conns.get_mut(&conn)
        {
            conn.sids.remove(&guest);
        }
        if tell && let Some((link, s)) = sandbox.session.on() {
            self.effects.push(Effect::Frame {
                link,
                frame: HostFrame::Unsub { s, sid },
                payload: Bytes::new(),
            });
        }
    }

    fn save(&mut self, id: &str) {
        let Some(sandbox) = self.sandboxes.get(id) else {
            return;
        };
        let saved = sandbox.instance.as_ref().map(|instance| Saved {
            instance: instance.clone(),
            subs: sandbox
                .subs
                .iter()
                .map(|(sid, sub)| SavedSub {
                    sid: *sid,
                    subject: sub.subject.clone(),
                    queue: sub.queue.clone(),
                })
                .collect(),
            next_sid: sandbox.next_sid,
        });
        self.effects.push(Effect::Save {
            sandbox: id.to_owned(),
            saved,
        });
    }

    fn wake(&mut self, now: u64, id: &str) {
        let every = self.settings.wake_every_ms;
        if let Some(sandbox) = self.sandboxes.get_mut(id)
            && sandbox.woke_at.is_none_or(|at| now >= at + every)
        {
            sandbox.woke_at = Some(now);
            self.effects.push(Effect::Wake {
                sandbox: id.to_owned(),
            });
        }
    }
}
