//! A seeded simulation of the host's agent-link core: agents that connect,
//! sleep, restart and subscribe; gateways that open, refuse and end
//! sessions and send messages; links that drop; a host that restarts. Every
//! operation, frame and effect sits in a queue that delivers in order, and
//! a step delivers one item or does one action, so every interleaving the
//! seed picks is one the real hub can see.
//!
//! Each agent holds two connections, as Opengeni's agent does: a control
//! one that subscribes and publishes, and a bulk one that only publishes.
//! Losing one mostly ends the other too, as that agent does, and sometimes
//! does not.
//!
//! Checked throughout:
//! - a message reaches only the instance and subscription it was sent for,
//!   at most once, and in order for its subscription, and never the bulk
//!   connection;
//! - an agent hears `PONG` only once its gateway opened its session;
//! - a gateway hears `sub`, `unsub`, `pub` and `state` only for sessions it
//!   opened, within their scope, and each `open` names a new `s`;
//! - a request for a sandbox (a message with a reply subject) wakes it: at
//!   once if the host last said it sleeps or said nothing, and otherwise
//!   at most once per wake interval; a sandbox the host says went to sleep
//!   while its agent certainly owes an answer to a young request is woken
//!   again; and nothing else wakes one (not a message nobody waits on, a
//!   relay credential, another state change, what the agent sends or a
//!   no-wake request);
//! - a no-wake request the host takes for a sandbox it does not say runs is
//!   answered by the host at once and never reaches the agent; one the
//!   agent got and left unanswered is answered by the host when its
//!   sandbox falls asleep with an open session; the host answers each at
//!   most once, only then or on arrival, never after the agent's answer
//!   reached it, and only with an empty reply, so an agent cannot mark its
//!   own reply as the host's.
//!
//! And at the end, once everything is back, every message sent is
//! delivered, both connections of each agent are up, and each sandbox's
//! open session was last told the state the host last gave for it (the
//! host gives it again after each attach, as its agent does).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use bytes::Bytes;
use compute_link::core::{ConnId, Core, Effect, Input, LinkId, Settings};
use compute_link::nats::{ClientOp, Connect, Delivery, Publish, ServerOp};
use compute_link::saved::Saved;
use compute_protocol::link::{
    AgentLink, Ending, GatewayFrame, HostFrame, NO_WAKE_HEADER, Refusal, Relay, Running,
    UNANSWERED_HEADER, has_header, may_publish, may_subscribe,
};

const SANDBOXES: usize = 3;
const GATEWAYS: usize = 2;
const MAX_PAYLOAD: u32 = 1 << 20;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % n as u64).unwrap()
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

fn scope(sandbox: &str, instance: &str) -> String {
    format!("agent.w.{sandbox}.connection.{instance}")
}

#[derive(Debug)]
enum ToGuest {
    Op(ServerOp),
    Close,
}

#[derive(Debug)]
enum FromGuest {
    Op(ClientOp),
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Down,
    /// Connected, waiting for `INFO`.
    AwaitInfo,
    /// Sent `CONNECT` and `PING`, waiting for `PONG`.
    Handshake,
    Connected,
}

#[derive(Debug)]
struct AgentSub {
    subject: String,
    /// Messages received on this connection.
    received: u64,
    max: Option<u64>,
}

/// One sandbox's agent: an `async-nats` client, as far as the host sees.
#[derive(Debug)]
struct Agent {
    instance: String,
    restarts: u32,
    /// The control connection.
    conn: Option<ConnId>,
    phase: Phase,
    /// The bulk connection, which only publishes.
    bulk: Option<ConnId>,
    bulk_phase: Phase,
    /// What the agent wants subscribed, by its own sid; subscribed again
    /// on each connection, as the client does.
    wanted: BTreeMap<String, String>,
    /// What it subscribed on this connection.
    subs: BTreeMap<String, AgentSub>,
    /// The sids it ended on this connection: a message already on its way
    /// for one is dropped, as the client does.
    retired: HashSet<String>,
    next_sid: u32,
    asleep: bool,
}

#[derive(Debug)]
struct Sandbox {
    id: String,
    gateway: usize,
    ticket: u32,
    attached: bool,
    /// The gateway shut it out until a new ticket.
    shut_out: bool,
    agent: Agent,
    last_wake: Option<u64>,
    /// The state the host last gave for it.
    running: Option<Running>,
    /// The state the core was last told for it, while it was attached.
    told: Option<Running>,
    /// The requests the core took for it, by reply subject, with when.
    taken: HashMap<String, u64>,
    /// Those its agent got and has not sent an answer to, since its agent
    /// process last changed: the core certainly owes them still.
    owes: HashSet<String>,
    /// The no-wake requests its agent got and will not answer, since its
    /// agent process last changed.
    quiet_owes: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum GwState {
    /// The host asked to open it; the gateway has not answered.
    Asked,
    Opened {
        scope: String,
    },
    /// The gateway refused it or ended it; frames still in flight from
    /// before are allowed.
    Ended,
    /// The host closed it.
    Closed,
}

#[derive(Debug)]
struct GwSession {
    sandbox: String,
    instance: String,
    state: GwState,
    was_opened: bool,
    subs: BTreeMap<u32, String>,
    /// The state the last `state` frame for it said.
    told: Option<Running>,
}

#[derive(Debug)]
struct Gateway {
    url: String,
    wanted: bool,
    live: Option<LinkId>,
    last_s: HashMap<LinkId, u32>,
}

#[derive(Debug)]
struct Sent {
    sandbox: String,
    instance: String,
    sid: u32,
    subject: String,
    /// Its reply subject, for a request.
    reply: Option<String>,
    /// Must be delivered, sent once everything was back.
    must: bool,
    /// A no-wake request.
    quiet: bool,
}

struct Sim {
    rng: Rng,
    settings: Settings,
    now: u64,
    core: Core,
    gateways: Vec<Gateway>,
    sandboxes: Vec<Sandbox>,
    sessions: HashMap<(LinkId, u32), GwSession>,
    to_gateway: HashMap<LinkId, VecDeque<(HostFrame, Bytes)>>,
    to_host: HashMap<LinkId, VecDeque<(GatewayFrame, Bytes)>>,
    to_guest: HashMap<ConnId, VecDeque<ToGuest>>,
    from_guest: HashMap<ConnId, VecDeque<FromGuest>>,
    /// Which sandbox each connection is for.
    conn_of: HashMap<ConnId, usize>,
    /// The connections the core holds.
    core_conns: HashSet<ConnId>,
    /// The instance the host last heard from each sandbox's agent.
    host_instance: HashMap<String, String>,
    /// The sessions the host holds, from its frames and the ones it read.
    host_sessions: HashSet<(LinkId, u32)>,
    disk: HashMap<String, Saved>,
    next_link: LinkId,
    next_conn: ConnId,
    next_msg: u64,
    sent: HashMap<u64, Sent>,
    delivered: HashSet<u64>,
    /// The no-wake requests the host answered itself, by reply subject.
    host_answered: HashSet<String>,
    /// The no-wake requests whose agent's answer the core took and sent on.
    agent_answered: HashSet<String>,
    /// The no-wake requests the core delivered: sandbox, when, and whether
    /// the core was told since that the sandbox fell asleep, which ends
    /// what it keeps of them.
    quiet_taken: HashMap<String, (usize, u64, bool)>,
    /// The sessions the host opened, of those it holds.
    host_open: HashSet<(LinkId, u32)>,
    last_delivered: HashMap<(String, String, u32), u64>,
    /// Whether the gateways may refuse or end sessions and links may drop.
    chaos: bool,
}

impl Sim {
    fn new(seed: u64) -> Self {
        let settings = Settings {
            seed,
            ..Settings::default()
        };
        let mut sim = Self {
            rng: Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1),
            core: Core::new(settings.clone()),
            settings,
            now: 0,
            gateways: (0..GATEWAYS)
                .map(|n| Gateway {
                    url: format!("wss://gateway-{n}.example/v1/agent-link"),
                    wanted: false,
                    live: None,
                    last_s: HashMap::new(),
                })
                .collect(),
            sandboxes: (0..SANDBOXES)
                .map(|n| Sandbox {
                    id: format!("sb{n}"),
                    gateway: n % GATEWAYS,
                    ticket: 1,
                    attached: false,
                    shut_out: false,
                    agent: Agent {
                        instance: format!("i{n}x0"),
                        restarts: 0,
                        conn: None,
                        phase: Phase::Down,
                        bulk: None,
                        bulk_phase: Phase::Down,
                        wanted: BTreeMap::new(),
                        subs: BTreeMap::new(),
                        retired: HashSet::new(),
                        next_sid: 1,
                        asleep: false,
                    },
                    last_wake: None,
                    running: None,
                    told: None,
                    taken: HashMap::new(),
                    owes: HashSet::new(),
                    quiet_owes: HashSet::new(),
                })
                .collect(),
            sessions: HashMap::new(),
            to_gateway: HashMap::new(),
            to_host: HashMap::new(),
            to_guest: HashMap::new(),
            from_guest: HashMap::new(),
            conn_of: HashMap::new(),
            core_conns: HashSet::new(),
            host_instance: HashMap::new(),
            host_sessions: HashSet::new(),
            disk: HashMap::new(),
            next_link: 1,
            next_conn: 1,
            next_msg: 1,
            sent: HashMap::new(),
            delivered: HashSet::new(),
            host_answered: HashSet::new(),
            agent_answered: HashSet::new(),
            quiet_taken: HashMap::new(),
            host_open: HashSet::new(),
            last_delivered: HashMap::new(),
            chaos: true,
        };
        for n in 0..SANDBOXES {
            sim.attach(n);
        }
        sim
    }

    fn ticket(&self, n: usize) -> String {
        format!(
            "ticket-{}-{}",
            self.sandboxes[n].id, self.sandboxes[n].ticket
        )
    }

    fn attach(&mut self, n: usize) {
        let sandbox = &mut self.sandboxes[n];
        sandbox.attached = true;
        sandbox.shut_out = false;
        let id = sandbox.id.clone();
        let link = AgentLink {
            gateway: self.gateways[sandbox.gateway].url.clone(),
            ticket: self.ticket(n),
        };
        let saved = self.disk.get(&id).cloned();
        if let Some(saved) = &saved {
            self.host_instance
                .entry(id.clone())
                .or_insert_with(|| saved.instance.clone());
        }
        self.input(Input::Attach {
            sandbox: id,
            link,
            saved,
        });
        if let Some(running) = self.sandboxes[n].running {
            self.input(Input::Running {
                sandbox: self.sandboxes[n].id.clone(),
                running,
            });
        }
    }

    /// Feeds the core, then queues what it asks.
    fn input(&mut self, input: Input) {
        let request_for = self.request_for(&input);
        // Whether the core must wake it: always unless the core was told it
        // runs and woke it within the interval.
        let must_wake = request_for.as_ref().map(|(n, _)| {
            let sandbox = &self.sandboxes[*n];
            sandbox.told != Some(Running::Awake)
                || sandbox
                    .last_wake
                    .is_none_or(|at| self.now >= at + self.settings.wake_every_ms)
        });
        let fell_asleep = self.fell_asleep(&input);
        let quiet_for = self.quiet_for(&input);
        let quiet_due = fell_asleep.map(|(n, _, _)| self.quiet_due(n));
        let opened = match &input {
            Input::Gateway {
                link,
                frame: GatewayFrame::Opened { s, .. },
                ..
            } => Some((*link, *s)),
            _ => None,
        };
        if let Input::Running { sandbox, running } = &input {
            let n = self.index(sandbox);
            if self.sandboxes[n].attached {
                self.sandboxes[n].told = Some(*running);
            }
        }
        match &input {
            Input::Gateway {
                link,
                frame: GatewayFrame::Refused { s, .. } | GatewayFrame::Closed { s, .. },
                ..
            } => {
                self.host_sessions.remove(&(*link, *s));
            }
            Input::LinkDown { link } => self.host_sessions.retain(|(l, _)| l != link),
            _ => {}
        }
        let tick = matches!(input, Input::Tick);
        self.core.on(self.now, input);
        let effects = self.core.take();
        let woke = |n: usize| {
            effects.iter().any(
                |effect| matches!(effect, Effect::Wake { sandbox } if *sandbox == self.sandboxes[n].id),
            )
        };
        // Only a request, or falling asleep owing an answer, wakes a
        // sandbox: a message nobody waits on, a relay credential, a tick or
        // anything the agent sends never does.
        for effect in &effects {
            if let Effect::Wake { sandbox } = effect {
                let n = self.index(sandbox);
                assert!(
                    !tick
                        && (request_for.as_ref().is_some_and(|(r, _)| *r == n)
                            || fell_asleep.is_some_and(|(a, may, _)| a == n && may)),
                    "{sandbox} was woken by something other than a request it owes an answer to"
                );
            }
        }
        let request_woke = request_for.as_ref().map(|(n, _)| woke(*n));
        let asleep_woke = fell_asleep.map(|(n, _, _)| woke(n));
        if let (Some((n, reply)), Some(must), Some(woke)) = (request_for, must_wake, request_woke) {
            assert_eq!(
                woke, must,
                "a request for {} at {} (told {:?}, last woken {:?})",
                self.sandboxes[n].id, self.now, self.sandboxes[n].told, self.sandboxes[n].last_wake
            );
            self.sandboxes[n].taken.insert(reply.clone(), self.now);
        }
        if let (Some((n, _, must)), Some(woke)) = (fell_asleep, asleep_woke) {
            assert!(
                !must || woke,
                "{} fell asleep owing an answer and was not woken",
                self.sandboxes[n].id
            );
        }
        self.check_unanswered(&effects, quiet_for.as_ref(), fell_asleep, quiet_due);
        for effect in effects {
            self.effect(effect);
        }
        if let Some(session) = opened
            && self.host_sessions.contains(&session)
        {
            self.host_open.insert(session);
        }
    }

    /// The no-wake request the host takes, for a session it still holds:
    /// its sandbox, reply subject, message and whether the host must
    /// answer it at once (it does not say the sandbox runs, and the
    /// session is open).
    fn quiet_for(&self, input: &Input) -> Option<(usize, String, u64, bool)> {
        match input {
            Input::Gateway {
                link,
                frame:
                    GatewayFrame::Msg {
                        s,
                        reply: Some(reply),
                        headers,
                        ..
                    },
                payload,
            } if self.host_sessions.contains(&(*link, *s))
                && has_header(headers.as_ref(), NO_WAKE_HEADER) =>
            {
                let session = self.sessions.get(&(*link, *s))?;
                let n = self.index(&session.sandbox);
                let id = u64::from_be_bytes(payload.as_ref().try_into().unwrap());
                let must = self.sandboxes[n].told != Some(Running::Awake)
                    && self.host_open.contains(&(*link, *s));
                Some((n, reply.clone(), id, must))
            }
            _ => None,
        }
    }

    /// The no-wake requests the host must answer if sandbox `n` falls
    /// asleep now: those its agent got and left unanswered, still young,
    /// when it holds an open session.
    fn quiet_due(&self, n: usize) -> HashSet<String> {
        let open = self.host_open.iter().any(|session| {
            self.host_sessions.contains(session)
                && self
                    .sessions
                    .get(session)
                    .is_some_and(|gw| gw.sandbox == self.sandboxes[n].id)
        });
        if !open {
            return HashSet::new();
        }
        self.sandboxes[n]
            .quiet_owes
            .iter()
            .filter(|reply| {
                self.quiet_taken
                    .get(*reply)
                    .is_some_and(|(_, at, slept)| !slept && self.now < at + self.settings.hold_ms)
            })
            .cloned()
            .collect()
    }

    /// The host's own replies to no-wake requests in `effects`, for the
    /// request just taken (`quiet_for`) or a sandbox that fell asleep.
    fn check_unanswered(
        &mut self,
        effects: &[Effect],
        quiet_for: Option<&(usize, String, u64, bool)>,
        fell_asleep: Option<(usize, bool, bool)>,
        quiet_due: Option<HashSet<String>>,
    ) {
        let mut answered = HashSet::new();
        for effect in effects {
            let Effect::Frame {
                frame: HostFrame::Pub {
                    subject, headers, ..
                },
                payload,
                ..
            } = effect
            else {
                continue;
            };
            if !payload.is_empty() {
                // The agent's answer, which the core took.
                if self.quiet_taken.contains_key(subject) {
                    self.agent_answered.insert(subject.clone());
                }
                continue;
            }
            let Some((_, why)) = headers.as_ref().and_then(|headers| {
                headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(UNANSWERED_HEADER))
            }) else {
                continue;
            };
            assert!(
                self.host_answered.insert(subject.clone()),
                "the host answered {subject} twice"
            );
            assert!(
                !self.agent_answered.contains(subject),
                "the host answered {subject} after its agent's answer"
            );
            match quiet_for {
                Some((_, reply, _, must)) if reply == subject => {
                    assert!(
                        !must || why == "asleep",
                        "{subject} answered {why} for a sandbox not said to run"
                    );
                }
                _ => {
                    let (n, _, _) = self
                        .quiet_taken
                        .get(subject)
                        .unwrap_or_else(|| panic!("the host answered {subject}, never delivered"));
                    assert!(
                        fell_asleep.is_some_and(|(asleep, _, _)| asleep == *n),
                        "the host answered {subject} other than when its sandbox fell asleep"
                    );
                    assert_eq!(why, "asleep");
                }
            }
            answered.insert(subject.clone());
        }
        if let Some((n, reply, id, must)) = quiet_for {
            let delivered = effects.iter().any(|effect| {
                matches!(effect, Effect::ToGuest { op: ServerOp::Msg(delivery), .. }
                    if delivery.payload.as_ref() == id.to_be_bytes())
            });
            if *must {
                assert!(
                    answered.contains(reply),
                    "{reply} for a sandbox not said to run was not answered at once"
                );
            }
            assert!(
                !(delivered && answered.contains(reply)),
                "{reply} was answered and delivered"
            );
            if delivered {
                self.quiet_taken
                    .insert(reply.clone(), (*n, self.now, false));
            }
        }
        if let (Some((n, _, _)), Some(due)) = (fell_asleep, quiet_due) {
            for reply in due {
                assert!(
                    answered.contains(&reply),
                    "{} fell asleep and {reply} its agent left was not answered",
                    self.sandboxes[n].id
                );
            }
            for (asleep, _, slept) in self.quiet_taken.values_mut() {
                *slept |= *asleep == n;
            }
        }
    }

    /// A request the host takes, for a session it still holds, wakes its
    /// sandbox; one for a session it ended is stale.
    fn request_for(&self, input: &Input) -> Option<(usize, String)> {
        match input {
            Input::Gateway {
                link,
                frame:
                    GatewayFrame::Msg {
                        s,
                        reply: Some(reply),
                        headers,
                        ..
                    },
                ..
            } if self.host_sessions.contains(&(*link, *s))
                && !has_header(headers.as_ref(), NO_WAKE_HEADER) =>
            {
                self.sessions
                    .get(&(*link, *s))
                    .map(|session| (self.index(&session.sandbox), reply.clone()))
            }
            _ => None,
        }
    }

    /// A sandbox the core is told went to sleep: whether its agent may owe
    /// answers (any young request taken) and whether it certainly does (one
    /// it never sent an answer to).
    fn fell_asleep(&mut self, input: &Input) -> Option<(usize, bool, bool)> {
        let Input::Running {
            sandbox,
            running: Running::Asleep,
        } = input
        else {
            return None;
        };
        let n = self.index(sandbox);
        let (hold, now) = (self.settings.hold_ms, self.now);
        let sandbox = &mut self.sandboxes[n];
        (sandbox.attached && sandbox.told != Some(Running::Asleep)).then(|| {
            sandbox.taken.retain(|_, at| now < *at + hold);
            let may = !sandbox.taken.is_empty();
            let must = sandbox
                .owes
                .iter()
                .any(|reply| sandbox.taken.contains_key(reply));
            (n, may, must)
        })
    }

    fn index(&self, sandbox: &str) -> usize {
        self.sandboxes
            .iter()
            .position(|candidate| candidate.id == sandbox)
            .unwrap()
    }

    fn effect(&mut self, effect: Effect) {
        match effect {
            Effect::Dial { gateway } => {
                let g = self.gateway(&gateway);
                self.gateways[g].wanted = true;
            }
            Effect::Hangup { gateway } => {
                let g = self.gateway(&gateway);
                self.gateways[g].wanted = false;
                if let Some(link) = self.gateways[g].live {
                    // Hanging up sends what was queued first.
                    while self.deliver_to_gateway(link) {}
                    self.drop_link(g, false);
                }
            }
            Effect::Frame {
                link,
                frame,
                payload,
            } => {
                match &frame {
                    HostFrame::Open {
                        s, sandbox, ticket, ..
                    } => {
                        let n = self.index(sandbox);
                        assert_eq!(
                            *ticket,
                            self.ticket(n),
                            "{sandbox} opened with a stale ticket"
                        );
                        self.host_sessions.insert((link, *s));
                    }
                    HostFrame::Close { s } => {
                        self.host_sessions.remove(&(link, *s));
                    }
                    _ => {}
                }
                if self.gateways.iter().any(|g| g.live == Some(link)) {
                    self.check_pong_free_frame(link, &frame);
                    self.to_gateway
                        .entry(link)
                        .or_default()
                        .push_back((frame, payload));
                }
            }
            Effect::ToGuest { conn, op } => {
                if matches!(op, ServerOp::Pong) {
                    self.check_pong(conn);
                }
                if let Some(queue) = self.to_guest.get_mut(&conn) {
                    queue.push_back(ToGuest::Op(op));
                }
            }
            Effect::CloseGuest { conn } => {
                self.core_conns.remove(&conn);
                if let Some(queue) = self.to_guest.get_mut(&conn) {
                    queue.push_back(ToGuest::Close);
                }
            }
            Effect::Wake { sandbox } => {
                let n = self.index(&sandbox);
                self.sandboxes[n].last_wake = Some(self.now);
                self.sandboxes[n].agent.asleep = false;
            }
            Effect::Save { sandbox, saved } => {
                if let Some(saved) = saved {
                    assert_eq!(
                        Some(&saved.instance),
                        self.host_instance.get(&sandbox),
                        "{sandbox} kept another instance's session"
                    );
                    self.disk.insert(sandbox, saved);
                } else {
                    self.host_instance.remove(&sandbox);
                    self.disk.remove(&sandbox);
                }
            }
        }
    }

    fn gateway(&self, url: &str) -> usize {
        self.gateways.iter().position(|g| g.url == url).unwrap()
    }

    /// Opening frames are checked when the gateway reads them; this checks
    /// the `s` of an `open` is new on its link.
    fn check_pong_free_frame(&mut self, link: LinkId, frame: &HostFrame) {
        if let HostFrame::Open { s, .. } = frame {
            let g = self
                .gateways
                .iter()
                .position(|g| g.live == Some(link))
                .unwrap();
            let last = self.gateways[g].last_s.entry(link).or_insert(0);
            assert!(*s > *last, "an open reused s {s} on link {link}");
            *last = *s;
        }
    }

    /// An agent hears `PONG` only once its session is open: the host asked
    /// to open a session for its sandbox and instance on a link that is up,
    /// the gateway opened it, and the host has not closed it.
    fn check_pong(&self, conn: ConnId) {
        let Some(&n) = self.conn_of.get(&conn) else {
            return;
        };
        let sandbox = &self.sandboxes[n];
        if sandbox.agent.conn != Some(conn) && sandbox.agent.bulk != Some(conn) {
            return;
        }
        let live = self.gateways[sandbox.gateway].live;
        let open = self.sessions.iter().any(|((link, _), session)| {
            Some(*link) == live
                && session.sandbox == sandbox.id
                && session.instance == sandbox.agent.instance
                && session.was_opened
                && session.state != GwState::Closed
        });
        assert!(
            open,
            "{} heard PONG with no open session at {}",
            sandbox.id, self.now
        );
    }

    fn drop_link(&mut self, g: usize, tell: bool) {
        let Some(link) = self.gateways[g].live.take() else {
            return;
        };
        self.to_gateway.remove(&link);
        self.to_host.remove(&link);
        self.sessions.retain(|(l, _), _| *l != link);
        if !tell {
            self.host_sessions.retain(|(l, _)| *l != link);
        }
        if tell {
            self.input(Input::LinkDown { link });
        }
    }

    // Delivering.

    fn deliver_to_gateway(&mut self, link: LinkId) -> bool {
        let Some((frame, payload)) = self.to_gateway.get_mut(&link).and_then(VecDeque::pop_front)
        else {
            return false;
        };
        self.gateway_reads(link, frame, &payload);
        true
    }

    fn gateway_reads(&mut self, link: LinkId, frame: HostFrame, payload: &Bytes) {
        match frame {
            HostFrame::Open {
                s,
                sandbox,
                ticket: _,
                connection,
            } => self.gateway_opens(link, s, &sandbox, &connection),
            HostFrame::Close { s } => {
                let session = self
                    .sessions
                    .get_mut(&(link, s))
                    .unwrap_or_else(|| panic!("close for an unknown s {s}"));
                session.state = GwState::Closed;
            }
            HostFrame::Sub {
                s, sid, subject, ..
            } => {
                let scope = self.opened_scope(link, s, "sub");
                assert!(
                    may_subscribe(&scope, &subject),
                    "a sub outside {scope}: {subject}"
                );
                self.sessions
                    .get_mut(&(link, s))
                    .unwrap()
                    .subs
                    .insert(sid, subject);
            }
            HostFrame::Unsub { s, sid } => {
                self.opened_scope(link, s, "unsub");
                self.sessions.get_mut(&(link, s)).unwrap().subs.remove(&sid);
            }
            HostFrame::Pub {
                s,
                subject,
                headers,
                ..
            } => {
                let scope = self.opened_scope(link, s, "pub");
                assert!(
                    may_publish(&scope, &subject),
                    "a pub outside {scope}: {subject}"
                );
                assert!(
                    payload.is_empty() || !has_header(headers.as_ref(), UNANSWERED_HEADER),
                    "an agent's reply on {subject} reached its gateway marked as the host's"
                );
            }
            HostFrame::State { s, state } => {
                self.opened_scope(link, s, "state");
                self.sessions.get_mut(&(link, s)).unwrap().told = Some(state);
            }
        }
    }

    /// The gateway answers an `open`: it opens the session, or refuses it
    /// as a duplicate, as unavailable or, for good, as stale.
    fn gateway_opens(&mut self, link: LinkId, s: u32, sandbox: &str, connection: &str) {
        let n = self.index(sandbox);
        let duplicate = self.sessions.iter().any(|((l, _), session)| {
            *l == link
                && session.sandbox == sandbox
                && session.instance != connection
                && matches!(session.state, GwState::Opened { .. })
        });
        self.sessions.insert(
            (link, s),
            GwSession {
                sandbox: sandbox.to_owned(),
                instance: connection.to_owned(),
                state: GwState::Asked,
                was_opened: false,
                subs: BTreeMap::new(),
                told: None,
            },
        );
        let answer = if duplicate || (self.chaos && self.rng.chance(10)) {
            let code = if duplicate {
                Refusal::Duplicate
            } else {
                Refusal::Unavailable
            };
            self.sessions.get_mut(&(link, s)).unwrap().state = GwState::Ended;
            GatewayFrame::Refused {
                s,
                code,
                message: String::new(),
            }
        } else if self.chaos && self.rng.chance(2) {
            self.sessions.get_mut(&(link, s)).unwrap().state = GwState::Ended;
            self.sandboxes[n].shut_out = true;
            GatewayFrame::Refused {
                s,
                code: Refusal::StaleEpoch,
                message: String::new(),
            }
        } else {
            let scope = scope(sandbox, connection);
            let session = self.sessions.get_mut(&(link, s)).unwrap();
            session.state = GwState::Opened {
                scope: scope.clone(),
            };
            session.was_opened = true;
            GatewayFrame::Opened {
                s,
                scope,
                relay: Relay {
                    url: "wss://relay.example".into(),
                    token: format!("relay-{s}"),
                    expires_at_ms: self.now + 600_000,
                },
            }
        };
        self.send_host(link, answer, Bytes::new());
    }

    /// The scope of a session the gateway opened, for a frame that needs
    /// one; a session it ended since may still get frames sent before.
    fn opened_scope(&self, link: LinkId, s: u32, what: &str) -> String {
        let session = self
            .sessions
            .get(&(link, s))
            .unwrap_or_else(|| panic!("a {what} for an unknown s {s}"));
        assert!(
            session.was_opened && session.state != GwState::Closed,
            "a {what} for s {s} in {:?}",
            session.state
        );
        scope(&session.sandbox, &session.instance)
    }

    fn send_host(&mut self, link: LinkId, frame: GatewayFrame, payload: Bytes) {
        self.to_host
            .entry(link)
            .or_default()
            .push_back((frame, payload));
    }

    fn deliver_to_host(&mut self, link: LinkId) {
        if let Some((frame, payload)) = self.to_host.get_mut(&link).and_then(VecDeque::pop_front) {
            self.input(Input::Gateway {
                link,
                frame,
                payload,
            });
        }
    }

    fn deliver_to_agent(&mut self, conn: ConnId) {
        let Some(out) = self.to_guest.get_mut(&conn).and_then(VecDeque::pop_front) else {
            return;
        };
        let n = self.conn_of[&conn];
        match out {
            ToGuest::Close => self.agent_lost(n, conn),
            ToGuest::Op(op) => self.agent_reads(n, conn, op),
        }
    }

    fn deliver_from_agent(&mut self, conn: ConnId) {
        let Some(item) = self.from_guest.get_mut(&conn).and_then(VecDeque::pop_front) else {
            return;
        };
        match item {
            FromGuest::Op(op) => {
                if let ClientOp::Connect(connect) = &op
                    && self.core_conns.contains(&conn)
                    && let Some(instance) = connect
                        .name
                        .as_deref()
                        .and_then(|name| name.strip_prefix("opengeni-agent/connection/"))
                {
                    let sandbox = self.sandboxes[self.conn_of[&conn]].id.clone();
                    let n = self.conn_of[&conn];
                    // Another agent process owes nothing the one before got.
                    if self
                        .host_instance
                        .insert(sandbox, instance.to_owned())
                        .as_deref()
                        != Some(instance)
                    {
                        self.sandboxes[n].owes.clear();
                        self.sandboxes[n].quiet_owes.clear();
                    }
                }
                self.input(Input::Guest { conn, op });
            }
            FromGuest::Closed => {
                self.from_guest.remove(&conn);
                self.core_conns.remove(&conn);
                self.input(Input::GuestClosed { conn });
            }
        }
    }

    // The agent.

    fn agent_sends(&mut self, conn: ConnId, op: ClientOp) {
        if let Some(queue) = self.from_guest.get_mut(&conn) {
            queue.push_back(FromGuest::Op(op));
        }
    }

    fn agent_reads(&mut self, n: usize, conn: ConnId, op: ServerOp) {
        if self.sandboxes[n].agent.bulk == Some(conn) {
            self.bulk_reads(n, conn, op);
            return;
        }
        if self.sandboxes[n].agent.conn != Some(conn) {
            return;
        }
        match op {
            ServerOp::Info(_) => {
                assert_eq!(self.sandboxes[n].agent.phase, Phase::AwaitInfo);
                self.handshake(n, conn);
                self.sandboxes[n].agent.phase = Phase::Handshake;
                // Some clients send before the handshake is done.
                if self.rng.chance(30) {
                    self.resubscribe(n, conn);
                }
            }
            ServerOp::Pong => {
                if self.sandboxes[n].agent.phase == Phase::Handshake {
                    self.sandboxes[n].agent.phase = Phase::Connected;
                    self.resubscribe(n, conn);
                }
            }
            ServerOp::Ping => self.agent_sends(conn, ClientOp::Pong),
            ServerOp::Ok => {}
            ServerOp::Err(text) => self.agent_refused(n, &text),
            ServerOp::Msg(delivery) => self.agent_receives(n, conn, &delivery),
        }
    }

    /// A subscription the server refused is gone.
    fn agent_refused(&mut self, n: usize, text: &str) {
        let Some(subject) = text
            .strip_prefix("Permissions Violation for Subscription to \"")
            .and_then(|rest| rest.strip_suffix('"'))
        else {
            return;
        };
        let agent = &mut self.sandboxes[n].agent;
        let gone: Vec<String> = agent
            .subs
            .iter()
            .filter(|(_, sub)| sub.subject == subject)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in gone {
            agent.subs.remove(&sid);
            agent.retired.insert(sid);
        }
        agent.wanted.retain(|_, wanted| wanted != subject);
    }

    fn agent_receives(&mut self, n: usize, conn: ConnId, delivery: &Delivery) {
        let id = u64::from_be_bytes(delivery.payload.as_ref().try_into().unwrap());
        let sent = self
            .sent
            .get(&id)
            .unwrap_or_else(|| panic!("an unknown message {id}"));
        let sandbox = &self.sandboxes[n];
        assert!(self.delivered.insert(id), "message {id} delivered twice");
        assert_eq!(sent.sandbox, sandbox.id, "message {id} to another sandbox");
        assert_eq!(
            sent.instance, sandbox.agent.instance,
            "message {id} to another instance"
        );
        assert_eq!(delivery.subject, sent.subject);
        assert_eq!(
            delivery.reply, sent.reply,
            "message {id} with another reply"
        );
        let reply = sent.reply.clone();
        let quiet = sent.quiet;
        let agent = &mut self.sandboxes[n].agent;
        let Some(sub) = agent.subs.get_mut(&delivery.sid) else {
            assert!(
                agent.retired.contains(&delivery.sid),
                "message {id} for an unknown sid {}",
                delivery.sid
            );
            return;
        };
        assert_eq!(sub.subject, sent.subject, "message {id} to another sid");
        sub.received += 1;
        assert!(
            sub.max.is_none_or(|max| sub.received <= max),
            "message {id} past its subscription's maximum"
        );
        if sub.max == Some(sub.received) {
            agent.subs.remove(&delivery.sid);
            agent.retired.insert(delivery.sid.clone());
        }
        let key = (sent.sandbox.clone(), sent.instance.clone(), sent.sid);
        let last = self.last_delivered.insert(key, id);
        assert!(
            last.is_none_or(|last| last < id),
            "message {id} after {last:?} for one subscription"
        );
        // Most requests are answered; an agent may leave one, as a stale or
        // unknown one.
        if let Some(reply) = reply {
            if !self.rng.chance(70) {
                if quiet {
                    self.sandboxes[n].quiet_owes.insert(reply);
                } else {
                    self.sandboxes[n].owes.insert(reply);
                }
                return;
            }
            self.sandboxes[n].owes.remove(&reply);
            // Now and then an agent marks its answer as the host's.
            let forged = self
                .rng
                .chance(20)
                .then(|| vec![(UNANSWERED_HEADER.to_lowercase(), "asleep".to_owned())]);
            self.agent_sends(
                conn,
                ClientOp::Pub(Publish {
                    subject: reply,
                    reply: None,
                    headers: forged,
                    payload: Bytes::from_static(b"answer"),
                }),
            );
        }
    }

    /// Says `CONNECT` and `PING`, under the agent's instance.
    fn handshake(&mut self, n: usize, conn: ConnId) {
        let name = format!(
            "opengeni-agent/connection/{}",
            self.sandboxes[n].agent.instance
        );
        self.agent_sends(
            conn,
            ClientOp::Connect(Connect {
                verbose: false,
                name: Some(name),
                headers: true,
            }),
        );
        self.agent_sends(conn, ClientOp::Ping);
    }

    fn bulk_reads(&mut self, n: usize, conn: ConnId, op: ServerOp) {
        match op {
            ServerOp::Info(_) => {
                assert_eq!(self.sandboxes[n].agent.bulk_phase, Phase::AwaitInfo);
                self.handshake(n, conn);
                self.sandboxes[n].agent.bulk_phase = Phase::Handshake;
            }
            ServerOp::Pong => {
                if self.sandboxes[n].agent.bulk_phase == Phase::Handshake {
                    self.sandboxes[n].agent.bulk_phase = Phase::Connected;
                }
            }
            ServerOp::Ping => self.agent_sends(conn, ClientOp::Pong),
            ServerOp::Ok | ServerOp::Err(_) => {}
            ServerOp::Msg(delivery) => panic!(
                "{} got a message on its bulk connection, for sid {}",
                self.sandboxes[n].id, delivery.sid
            ),
        }
    }

    fn resubscribe(&mut self, n: usize, conn: ConnId) {
        let wanted: Vec<(String, String)> = self.sandboxes[n]
            .agent
            .wanted
            .iter()
            .map(|(sid, subject)| (sid.clone(), subject.clone()))
            .collect();
        for (sid, subject) in wanted {
            if self.sandboxes[n].agent.subs.contains_key(&sid) {
                continue;
            }
            self.sandboxes[n].agent.subs.insert(
                sid.clone(),
                AgentSub {
                    subject: subject.clone(),
                    received: 0,
                    max: None,
                },
            );
            self.agent_sends(
                conn,
                ClientOp::Sub {
                    subject,
                    queue: None,
                    sid,
                },
            );
        }
    }

    /// One of the agent's connections ended, by the host or the agent.
    /// Opengeni's agent then ends the other too, as most times here.
    fn agent_lost(&mut self, n: usize, conn: ConnId) {
        let agent = &self.sandboxes[n].agent;
        let other = if agent.conn == Some(conn) {
            agent.bulk
        } else if agent.bulk == Some(conn) {
            agent.conn
        } else {
            return;
        };
        self.lose(n, conn);
        if let Some(other) = other
            && self.rng.chance(70)
        {
            self.lose(n, other);
        }
    }

    fn lose(&mut self, n: usize, conn: ConnId) {
        let agent = &mut self.sandboxes[n].agent;
        if agent.conn == Some(conn) {
            agent.conn = None;
            agent.phase = Phase::Down;
            agent.subs.clear();
            agent.retired.clear();
        } else if agent.bulk == Some(conn) {
            agent.bulk = None;
            agent.bulk_phase = Phase::Down;
        } else {
            return;
        }
        self.to_guest.remove(&conn);
        if let Some(queue) = self.from_guest.get_mut(&conn) {
            queue.push_back(FromGuest::Closed);
        }
    }

    /// The agent opens its control connection, or, once it has one, its
    /// bulk one.
    fn agent_connects(&mut self, n: usize) {
        let agent = &self.sandboxes[n].agent;
        if agent.conn.is_some() && agent.bulk.is_some() {
            return;
        }
        let control = agent.conn.is_none();
        let conn = self.next_conn;
        self.next_conn += 1;
        self.conn_of.insert(conn, n);
        self.to_guest.insert(conn, VecDeque::new());
        self.from_guest.insert(conn, VecDeque::new());
        let agent = &mut self.sandboxes[n].agent;
        if control {
            agent.conn = Some(conn);
            agent.phase = Phase::AwaitInfo;
            agent.subs.clear();
            agent.retired.clear();
        } else {
            agent.bulk = Some(conn);
            agent.bulk_phase = Phase::AwaitInfo;
        }
        let id = self.sandboxes[n].id.clone();
        self.core_conns.insert(conn);
        self.input(Input::Accepted { conn, sandbox: id });
    }

    /// The agent's side ends its connections, as a sandbox that sleeps.
    fn agent_hangs_up(&mut self, n: usize) {
        if let Some(conn) = self.sandboxes[n].agent.conn {
            self.lose(n, conn);
        }
        if let Some(conn) = self.sandboxes[n].agent.bulk {
            self.lose(n, conn);
        }
    }

    fn agent_restarts(&mut self, n: usize) {
        self.agent_hangs_up(n);
        let agent = &mut self.sandboxes[n].agent;
        agent.restarts += 1;
        agent.instance = format!("i{n}x{}", agent.restarts);
        agent.wanted.clear();
        agent.next_sid = 1;
    }

    fn agent_acts(&mut self, n: usize) {
        let bulk = self.sandboxes[n]
            .agent
            .bulk
            .filter(|_| self.sandboxes[n].agent.bulk_phase == Phase::Connected);
        let Some(conn) = self.sandboxes[n].agent.conn else {
            return;
        };
        if self.sandboxes[n].agent.phase != Phase::Connected {
            return;
        }
        let scope = scope(&self.sandboxes[n].id, &self.sandboxes[n].agent.instance);
        match self.rng.below(10) {
            0..=3 => {
                let agent = &mut self.sandboxes[n].agent;
                let sid = agent.next_sid.to_string();
                agent.next_sid += 1;
                let subject = if self.rng.chance(5) {
                    "agent.elsewhere.rpc".to_owned()
                } else {
                    format!("{scope}.s{}", self.rng.below(4))
                };
                let agent = &mut self.sandboxes[n].agent;
                agent.wanted.insert(sid.clone(), subject.clone());
                agent.subs.insert(
                    sid.clone(),
                    AgentSub {
                        subject: subject.clone(),
                        received: 0,
                        max: None,
                    },
                );
                self.agent_sends(
                    conn,
                    ClientOp::Sub {
                        subject,
                        queue: None,
                        sid,
                    },
                );
            }
            4 => {
                let agent = &mut self.sandboxes[n].agent;
                let Some(sid) = agent
                    .subs
                    .keys()
                    .nth(self.rng.below(agent.subs.len().max(1)))
                    .cloned()
                else {
                    return;
                };
                let max = self
                    .rng
                    .chance(50)
                    .then(|| agent.subs[&sid].received + 1 + self.rng.next() % 3);
                let agent = &mut self.sandboxes[n].agent;
                agent.wanted.remove(&sid);
                if let Some(max) = max {
                    agent.subs.get_mut(&sid).unwrap().max = Some(max);
                } else {
                    agent.subs.remove(&sid);
                    agent.retired.insert(sid.clone());
                }
                self.agent_sends(conn, ClientOp::Unsub { sid, max });
            }
            5..=7 => {
                let subject = match self.rng.below(10) {
                    0 => "elsewhere.events".to_owned(),
                    1..=4 => format!("_INBOX.r{}", self.rng.below(100)),
                    _ => format!("{scope}.events"),
                };
                // Events go out on the bulk connection, when it is up.
                let conn = bulk.filter(|_| self.rng.chance(70)).unwrap_or(conn);
                self.agent_sends(
                    conn,
                    ClientOp::Pub(Publish {
                        subject,
                        reply: None,
                        headers: None,
                        payload: Bytes::from_static(b"event"),
                    }),
                );
            }
            _ => self.agent_sends(conn, ClientOp::Ping),
        }
    }

    // The gateway.

    /// Sends a message for a subscription of a session it opened.
    fn gateway_sends_msg(&mut self, must: bool) -> Option<u64> {
        let candidates: Vec<(LinkId, u32, u32, String)> = self
            .sessions
            .iter()
            .filter(|((link, _), session)| {
                matches!(session.state, GwState::Opened { .. })
                    && self.gateways.iter().any(|g| g.live == Some(*link))
            })
            .flat_map(|((link, s), session)| {
                session
                    .subs
                    .iter()
                    .map(move |(sid, subject)| (*link, *s, *sid, subject.clone()))
            })
            .collect();
        if candidates.is_empty() {
            return None;
        }
        let (link, s, sid, subject) = candidates[self.rng.below(candidates.len())].clone();
        Some(self.send_msg(link, s, sid, subject, must))
    }

    fn send_msg(&mut self, link: LinkId, s: u32, sid: u32, subject: String, must: bool) -> u64 {
        let session = &self.sessions[&(link, s)];
        let id = self.next_msg;
        self.next_msg += 1;
        // Half are requests, answered on an inbox of their own; the rest
        // are acknowledgements and notices nobody waits on.
        let reply = self.rng.chance(50).then(|| format!("_INBOX.q{id}"));
        // A third of the requests not certain to be delivered are no-wake
        // ones, as housekeeping is.
        let quiet = reply.is_some() && !must && self.rng.chance(33);
        self.sent.insert(
            id,
            Sent {
                sandbox: session.sandbox.clone(),
                instance: session.instance.clone(),
                sid,
                subject: subject.clone(),
                reply: reply.clone(),
                must,
                quiet,
            },
        );
        self.send_host(
            link,
            GatewayFrame::Msg {
                s,
                sid,
                subject,
                reply,
                headers: quiet.then(|| vec![(NO_WAKE_HEADER.to_owned(), "1".to_owned())]),
            },
            Bytes::copy_from_slice(&id.to_be_bytes()),
        );
        id
    }

    fn gateway_ends_session(&mut self) {
        let opened: Vec<(LinkId, u32)> = self
            .sessions
            .iter()
            .filter(|(_, session)| matches!(session.state, GwState::Opened { .. }))
            .map(|(key, _)| *key)
            .collect();
        if opened.is_empty() {
            return;
        }
        let (link, s) = opened[self.rng.below(opened.len())];
        let code = if self.rng.chance(15) {
            Ending::Superseded
        } else {
            Ending::Lost
        };
        let session = self.sessions.get_mut(&(link, s)).unwrap();
        session.state = GwState::Ended;
        let sandbox = session.sandbox.clone();
        if code == Ending::Superseded {
            let n = self.index(&sandbox);
            self.sandboxes[n].shut_out = true;
        }
        self.send_host(
            link,
            GatewayFrame::Closed {
                s,
                code,
                message: String::new(),
            },
            Bytes::new(),
        );
    }

    fn gateway_refuses_a_sub(&mut self) {
        let subs: Vec<(LinkId, u32, u32)> = self
            .sessions
            .iter()
            .filter(|(_, session)| matches!(session.state, GwState::Opened { .. }))
            .flat_map(|((link, s), session)| session.subs.keys().map(move |sid| (*link, *s, *sid)))
            .collect();
        if subs.is_empty() {
            return;
        }
        let (link, s, sid) = subs[self.rng.below(subs.len())];
        self.sessions.get_mut(&(link, s)).unwrap().subs.remove(&sid);
        self.send_host(
            link,
            GatewayFrame::Error {
                s,
                code: "permission".into(),
                message: "no".into(),
                sid: Some(sid),
            },
            Bytes::new(),
        );
    }

    fn link_comes_up(&mut self, g: usize) {
        if !self.gateways[g].wanted || self.gateways[g].live.is_some() {
            return;
        }
        let link = self.next_link;
        self.next_link += 1;
        self.gateways[g].live = Some(link);
        let gateway = self.gateways[g].url.clone();
        self.input(Input::LinkUp {
            gateway,
            link,
            max_payload: MAX_PAYLOAD,
        });
    }

    fn host_restarts(&mut self) {
        for g in 0..GATEWAYS {
            self.drop_link(g, false);
            self.gateways[g].wanted = false;
        }
        for n in 0..SANDBOXES {
            self.agent_hangs_up(n);
        }
        self.to_guest.clear();
        self.from_guest.clear();
        self.core_conns.clear();
        self.host_instance.clear();
        for sandbox in &mut self.sandboxes {
            sandbox.last_wake = None;
            sandbox.told = None;
            sandbox.taken.clear();
            sandbox.owes.clear();
            sandbox.quiet_owes.clear();
        }
        // A new host keeps nothing of what the one before delivered.
        self.quiet_taken.clear();
        self.core = Core::new(self.settings.clone());
        for n in 0..SANDBOXES {
            if self.sandboxes[n].attached {
                self.attach(n);
            }
        }
    }

    // Running.

    fn step(&mut self) {
        let pick = self.rng.below(100);
        match pick {
            0..=17 => {
                let links: Vec<LinkId> = self
                    .to_gateway
                    .iter()
                    .filter(|(_, queue)| !queue.is_empty())
                    .map(|(link, _)| *link)
                    .collect();
                if !links.is_empty() {
                    let link = links[self.rng.below(links.len())];
                    self.deliver_to_gateway(link);
                }
            }
            18..=35 => {
                let links: Vec<LinkId> = self
                    .to_host
                    .iter()
                    .filter(|(_, queue)| !queue.is_empty())
                    .map(|(link, _)| *link)
                    .collect();
                if !links.is_empty() {
                    let link = links[self.rng.below(links.len())];
                    self.deliver_to_host(link);
                }
            }
            36..=50 => {
                let conns: Vec<ConnId> = self
                    .to_guest
                    .iter()
                    .filter(|(_, queue)| !queue.is_empty())
                    .map(|(conn, _)| *conn)
                    .collect();
                if !conns.is_empty() {
                    let conn = conns[self.rng.below(conns.len())];
                    self.deliver_to_agent(conn);
                }
            }
            51..=65 => {
                let conns: Vec<ConnId> = self
                    .from_guest
                    .iter()
                    .filter(|(_, queue)| !queue.is_empty())
                    .map(|(conn, _)| *conn)
                    .collect();
                if !conns.is_empty() {
                    let conn = conns[self.rng.below(conns.len())];
                    self.deliver_from_agent(conn);
                }
            }
            66..=69 => {
                self.now += self.rng.next() % 3_000;
                self.input(Input::Tick);
            }
            70..=72 => {
                let g = self.rng.below(GATEWAYS);
                self.link_comes_up(g);
            }
            73..=77 => {
                let n = self.rng.below(SANDBOXES);
                // A sleeping sandbox wakes for its own reasons too.
                if self.sandboxes[n].agent.asleep && self.rng.chance(25) {
                    self.sandboxes[n].agent.asleep = false;
                }
                if !self.sandboxes[n].agent.asleep {
                    // Its host says it runs, now and then only later.
                    if self.sandboxes[n].attached
                        && self.sandboxes[n].running != Some(Running::Awake)
                        && self.rng.chance(50)
                    {
                        self.sandboxes[n].running = Some(Running::Awake);
                        let id = self.sandboxes[n].id.clone();
                        self.input(Input::Running {
                            sandbox: id,
                            running: Running::Awake,
                        });
                    }
                    self.agent_connects(n);
                }
            }
            78..=86 => {
                let n = self.rng.below(SANDBOXES);
                self.agent_acts(n);
            }
            87..=95 => {
                self.gateway_sends_msg(false);
            }
            _ => self.chaos_step(),
        }
    }

    fn chaos_step(&mut self) {
        if !self.chaos {
            return;
        }
        match self.rng.below(100) {
            0..=19 => {
                let n = self.rng.below(SANDBOXES);
                self.agent_hangs_up(n);
                self.sandboxes[n].agent.asleep = true;
            }
            20..=29 => {
                let n = self.rng.below(SANDBOXES);
                self.agent_restarts(n);
            }
            30..=44 => {
                let g = self.rng.below(GATEWAYS);
                self.drop_link(g, true);
            }
            45..=59 => self.gateway_ends_session(),
            60..=64 => self.gateway_refuses_a_sub(),
            65..=74 => {
                // A shut-out sandbox gets a new ticket, as after it was
                // adopted again.
                let n = self.rng.below(SANDBOXES);
                if self.sandboxes[n].attached && self.sandboxes[n].shut_out {
                    self.sandboxes[n].ticket += 1;
                    self.attach(n);
                }
            }
            75..=79 => {
                // It leaves and comes back, as a sandbox moved away and
                // back again.
                let n = self.rng.below(SANDBOXES);
                if self.sandboxes[n].attached {
                    self.sandboxes[n].attached = false;
                    self.sandboxes[n].last_wake = None;
                    let id = self.sandboxes[n].id.clone();
                    self.input(Input::Detach { sandbox: id });
                    // The core forgets it, with what its agent owed.
                    self.sandboxes[n].told = None;
                    self.sandboxes[n].taken.clear();
                    self.sandboxes[n].owes.clear();
                    self.agent_hangs_up(n);
                } else {
                    self.sandboxes[n].ticket += 1;
                    self.attach(n);
                }
            }
            80..=82 => self.host_restarts(),
            83..=89 => {
                for (link, s) in self
                    .sessions
                    .iter()
                    .filter(|(_, session)| matches!(session.state, GwState::Opened { .. }))
                    .map(|(key, _)| *key)
                    .collect::<Vec<_>>()
                {
                    if self.rng.chance(30) {
                        self.send_host(
                            link,
                            GatewayFrame::Relay {
                                s,
                                relay: Relay {
                                    url: "wss://relay.example".into(),
                                    token: format!("relay-{s}-{}", self.now),
                                    expires_at_ms: self.now + 600_000,
                                },
                            },
                            Bytes::new(),
                        );
                    }
                }
            }
            _ => {
                let running = if self.rng.chance(50) {
                    Running::Asleep
                } else {
                    Running::Awake
                };
                let n = self.rng.below(SANDBOXES);
                let id = self.sandboxes[n].id.clone();
                self.sandboxes[n].running = Some(running);
                self.input(Input::Running {
                    sandbox: id,
                    running,
                });
            }
        }
    }

    /// Delivers everything in flight, with links up and agents connected,
    /// until nothing moves.
    fn settle(&mut self) {
        for _ in 0..10_000 {
            let mut moved = false;
            for g in 0..GATEWAYS {
                if self.gateways[g].wanted && self.gateways[g].live.is_none() {
                    self.link_comes_up(g);
                    moved = true;
                }
            }
            for n in 0..SANDBOXES {
                let agent = &self.sandboxes[n].agent;
                if self.sandboxes[n].attached && (agent.conn.is_none() || agent.bulk.is_none()) {
                    self.agent_connects(n);
                    moved = true;
                }
            }
            let links: Vec<LinkId> = self.to_gateway.keys().copied().collect();
            for link in links {
                while self.deliver_to_gateway(link) {
                    moved = true;
                }
            }
            let links: Vec<LinkId> = self.to_host.keys().copied().collect();
            for link in links {
                while self
                    .to_host
                    .get(&link)
                    .is_some_and(|queue| !queue.is_empty())
                {
                    self.deliver_to_host(link);
                    moved = true;
                }
            }
            let conns: Vec<ConnId> = self.to_guest.keys().copied().collect();
            for conn in conns {
                while self
                    .to_guest
                    .get(&conn)
                    .is_some_and(|queue| !queue.is_empty())
                {
                    self.deliver_to_agent(conn);
                    moved = true;
                }
            }
            let conns: Vec<ConnId> = self.from_guest.keys().copied().collect();
            for conn in conns {
                while self
                    .from_guest
                    .get(&conn)
                    .is_some_and(|queue| !queue.is_empty())
                {
                    self.deliver_from_agent(conn);
                    moved = true;
                }
            }
            if !moved {
                // Retries wait for their time.
                match self.core.deadline() {
                    Some(at) if at > self.now && at < self.now + 60_000 => {
                        self.now = at;
                        self.input(Input::Tick);
                    }
                    _ => return,
                }
            }
        }
        panic!("the simulation never settled");
    }

    /// Once everything is back, every subscription each agent holds gets a
    /// message, and each arrives.
    fn check_delivery(&mut self) {
        self.chaos = false;
        for n in 0..SANDBOXES {
            if !self.sandboxes[n].attached || self.sandboxes[n].shut_out {
                self.sandboxes[n].ticket += 1;
                self.attach(n);
            }
            self.sandboxes[n].agent.asleep = false;
        }
        self.settle();
        // Each agent subscribes once more, so each has something to get.
        for n in 0..SANDBOXES {
            let conn = self.sandboxes[n].agent.conn.unwrap();
            assert_eq!(
                self.sandboxes[n].agent.phase,
                Phase::Connected,
                "{} is not connected once everything is back",
                self.sandboxes[n].id
            );
            assert_eq!(
                self.sandboxes[n].agent.bulk_phase,
                Phase::Connected,
                "{}'s bulk connection is not connected once everything is back",
                self.sandboxes[n].id
            );
            let scope = scope(&self.sandboxes[n].id, &self.sandboxes[n].agent.instance);
            let agent = &mut self.sandboxes[n].agent;
            let sid = agent.next_sid.to_string();
            agent.next_sid += 1;
            let subject = format!("{scope}.last");
            agent.wanted.insert(sid.clone(), subject.clone());
            agent.subs.insert(
                sid.clone(),
                AgentSub {
                    subject: subject.clone(),
                    received: 0,
                    max: None,
                },
            );
            self.agent_sends(
                conn,
                ClientOp::Sub {
                    subject,
                    queue: None,
                    sid,
                },
            );
        }
        self.settle();
        let targets: Vec<(LinkId, u32, u32, String)> = self
            .sessions
            .iter()
            .filter(|((link, _), session)| {
                matches!(session.state, GwState::Opened { .. })
                    && self.gateways.iter().any(|g| g.live == Some(*link))
            })
            .flat_map(|((link, s), session)| {
                session
                    .subs
                    .iter()
                    .map(move |(sid, subject)| (*link, *s, *sid, subject.clone()))
            })
            .collect();
        for n in 0..SANDBOXES {
            let id = &self.sandboxes[n].id;
            assert!(
                targets
                    .iter()
                    .any(|(link, s, _, _)| self.sessions[&(*link, *s)].sandbox == *id),
                "{id} has no open session with subscriptions once everything is back"
            );
        }
        self.check_told();
        let ids: Vec<u64> = targets
            .into_iter()
            .map(|(link, s, sid, subject)| self.send_msg(link, s, sid, subject, true))
            .collect();
        self.settle();
        for id in ids {
            let sent = &self.sent[&id];
            let n = self.index(&sent.sandbox);
            let held = self.sandboxes[n]
                .agent
                .subs
                .values()
                .any(|sub| sub.subject == sent.subject && sub.max.is_none());
            if held {
                assert!(
                    self.delivered.contains(&id),
                    "message {id} ({sent:?}) never arrived"
                );
            }
        }
        assert!(
            self.sent
                .iter()
                .filter(|(_, sent)| sent.must)
                .any(|(id, _)| self.delivered.contains(id)),
            "nothing was delivered at the end"
        );
    }

    /// Each sandbox's open sessions were last told the state the host last
    /// gave for it.
    fn check_told(&self) {
        for sandbox in &self.sandboxes {
            let Some(running) = sandbox.running else {
                continue;
            };
            for ((link, s), session) in &self.sessions {
                if session.sandbox == sandbox.id
                    && matches!(session.state, GwState::Opened { .. })
                    && self.gateways.iter().any(|g| g.live == Some(*link))
                {
                    assert_eq!(
                        session.told,
                        Some(running),
                        "{}'s session {s} on link {link} was not told its state",
                        sandbox.id
                    );
                }
            }
        }
    }
}

#[test]
fn the_agent_link_core_keeps_its_rules_under_any_interleaving() {
    let seeds: u64 = std::env::var("COMPUTE_LINK_SIM_SEEDS")
        .ok()
        .and_then(|seeds| seeds.parse().ok())
        .unwrap_or(300);
    let (mut sent, mut delivered, mut connects, mut restarts) = (0, 0, 0, 0);
    let (mut quiet, mut quiet_delivered, mut host_answered) = (0, 0, 0);
    for seed in 1..=seeds {
        let mut sim = Sim::new(seed);
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for _ in 0..3_000 {
                sim.step();
            }
            sim.check_delivery();
        }));
        if let Err(panic) = run {
            eprintln!("seed {seed} failed");
            std::panic::resume_unwind(panic);
        }
        sent += sim.sent.len();
        delivered += sim.delivered.len();
        quiet += sim.sent.values().filter(|sent| sent.quiet).count();
        quiet_delivered += sim.quiet_taken.len();
        host_answered += sim.host_answered.len();
        connects += sim.next_conn - 1;
        restarts += sim
            .sandboxes
            .iter()
            .map(|sandbox| sandbox.agent.restarts)
            .sum::<u32>();
    }
    eprintln!(
        "{seeds} seeds: {sent} messages sent, {delivered} delivered, {connects} connections, {restarts} agent restarts; {quiet} no-wake requests, {quiet_delivered} delivered, {host_answered} answered by the host"
    );
    // The interleavings did the work they are meant to check.
    let seeds = usize::try_from(seeds).unwrap();
    assert!(delivered > seeds * 20, "too few deliveries: {delivered}");
    assert!(connects > u64::try_from(seeds).unwrap() * 20);
    assert!(
        quiet_delivered > seeds && host_answered > seeds,
        "too few no-wake requests delivered ({quiet_delivered}) or answered by the host ({host_answered})"
    );
}
