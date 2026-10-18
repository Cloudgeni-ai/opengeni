//! What a guest can make the host keep is bounded, and each subscription a
//! connection leaves has its whole grace period: the core driven directly,
//! one rule at a time.

use bytes::Bytes;
use compute_link::core::{CONNECTION_NAME, ConnId, Core, Effect, Input, LinkId, Settings};
use compute_link::nats::{ClientOp, Connect, Publish, ServerOp};
use compute_protocol::link::{AgentLink, GatewayFrame, HostFrame, Relay, Running};

const SANDBOX: &str = "sb";
const GATEWAY: &str = "wss://gateway.example/v1/agent-link";
const INSTANCE: &str = "i1";
const LINK: LinkId = 1;

fn scope() -> String {
    format!("agent.w.a.connection.{INSTANCE}")
}

/// A core with the sandbox attached and its gateway's link up.
fn core(settings: Settings) -> Core {
    let mut core = Core::new(settings);
    core.on(
        0,
        Input::Attach {
            sandbox: SANDBOX.into(),
            link: AgentLink {
                gateway: GATEWAY.into(),
                ticket: "ticket".into(),
            },
            saved: None,
        },
    );
    core.on(
        0,
        Input::LinkUp {
            gateway: GATEWAY.into(),
            link: LINK,
            max_payload: 1 << 20,
        },
    );
    core.take();
    core
}

fn guest(core: &mut Core, now: u64, conn: ConnId, op: ClientOp) {
    core.on(now, Input::Guest { conn, op });
}

/// Accepts `conn` and has it say `CONNECT`.
fn connect(core: &mut Core, now: u64, conn: ConnId) {
    connect_as(core, now, conn, INSTANCE);
}

/// Accepts `conn` and has it say `CONNECT` as agent process `instance`.
fn connect_as(core: &mut Core, now: u64, conn: ConnId, instance: &str) {
    core.on(
        now,
        Input::Accepted {
            conn,
            sandbox: SANDBOX.into(),
        },
    );
    guest(
        core,
        now,
        conn,
        ClientOp::Connect(Connect {
            name: Some(format!("{CONNECTION_NAME}{instance}")),
            ..Connect::default()
        }),
    );
}

/// Answers the session's `open` with `opened`.
fn open(core: &mut Core, now: u64) -> u32 {
    let s = core
        .take()
        .into_iter()
        .find_map(|effect| match effect {
            Effect::Frame {
                frame: HostFrame::Open { s, .. },
                ..
            } => Some(s),
            _ => None,
        })
        .expect("the host opened a session");
    core.on(
        now,
        Input::Gateway {
            link: LINK,
            frame: GatewayFrame::Opened {
                s,
                scope: scope(),
                relay: Relay {
                    url: "wss://relay.example/v1".into(),
                    token: "relay".into(),
                    expires_at_ms: u64::MAX,
                },
            },
            payload: Bytes::new(),
        },
    );
    core.take();
    s
}

fn sub(core: &mut Core, now: u64, conn: ConnId, name: &str, sid: &str) {
    guest(
        core,
        now,
        conn,
        ClientOp::Sub {
            subject: format!("{}.{name}", scope()),
            queue: None,
            sid: sid.into(),
        },
    );
}

/// The gateway sends a request for the host's `sid`.
fn msg(core: &mut Core, now: u64, s: u32, sid: u32, payload: Bytes) {
    send(core, now, (s, sid), Some("_INBOX.r"), payload);
}

/// The gateway sends a message for the host's `sid` of session `s`: a
/// request to be answered on `reply`, or with none a message nobody waits
/// on.
fn send(core: &mut Core, now: u64, (s, sid): (u32, u32), reply: Option<&str>, payload: Bytes) {
    core.on(
        now,
        Input::Gateway {
            link: LINK,
            frame: GatewayFrame::Msg {
                s,
                sid,
                subject: format!("{}.rpc", scope()),
                reply: reply.map(Into::into),
                headers: None,
            },
            payload,
        },
    );
}

/// The agent answers on `reply`.
fn answer(core: &mut Core, now: u64, conn: ConnId, reply: &str) {
    guest(
        core,
        now,
        conn,
        ClientOp::Pub(Publish {
            subject: reply.into(),
            reply: None,
            headers: None,
            payload: Bytes::from_static(b"done"),
        }),
    );
}

/// The host says whether the sandbox runs.
fn told(core: &mut Core, now: u64, running: Running) {
    core.on(
        now,
        Input::Running {
            sandbox: SANDBOX.into(),
            running,
        },
    );
}

/// The payloads delivered to `to`, in order.
fn delivered(effects: &[Effect], to: ConnId) -> Vec<Bytes> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::ToGuest {
                conn,
                op: ServerOp::Msg(delivery),
            } if *conn == to => Some(delivery.payload.clone()),
            _ => None,
        })
        .collect()
}

/// A sandbox whose agent subscribed to `rpc` (the host's sid 1) and then
/// went, as one that sleeps; returns its session.
fn asleep(settings: Settings) -> (Core, u32) {
    let mut core = core(settings);
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    core.on(0, Input::GuestClosed { conn: 1 });
    core.take();
    (core, s)
}

#[test]
fn messages_waiting_for_an_agent_are_bounded_in_number_and_the_oldest_are_kept() {
    let (mut core, s) = asleep(Settings {
        max_waiting: 4,
        ..Settings::default()
    });
    // Tiny ones too: each one kept costs the host, whatever it carries.
    for n in 0..10_000u32 {
        msg(&mut core, 0, s, 1, Bytes::from(n.to_string()));
    }
    core.take();
    connect(&mut core, 1, 2);
    sub(&mut core, 1, 2, "rpc", "9");
    assert_eq!(delivered(&core.take(), 2), ["0", "1", "2", "3"]);
    // Delivered, they make room again.
    core.on(2, Input::GuestClosed { conn: 2 });
    for n in 0..6u32 {
        msg(&mut core, 2, s, 1, Bytes::from(format!("again {n}")));
    }
    connect(&mut core, 3, 3);
    sub(&mut core, 3, 3, "rpc", "9");
    assert_eq!(
        delivered(&core.take(), 3),
        ["again 0", "again 1", "again 2", "again 3"]
    );
}

#[test]
fn messages_waiting_for_an_agent_are_bounded_in_bytes_counting_what_each_holds() {
    let chunk = 64 << 10;
    let (mut core, s) = asleep(Settings {
        waiting_bytes: 1 << 20,
        ..Settings::default()
    });
    for n in 0..80u8 {
        msg(&mut core, 0, s, 1, Bytes::from(vec![n; chunk]));
    }
    core.take();
    connect(&mut core, 1, 2);
    sub(&mut core, 1, 2, "rpc", "9");
    let payloads = delivered(&core.take(), 2);
    // Sixteen chunks are a mebibyte of payload alone; with their subjects
    // and overhead only fifteen fit.
    assert_eq!(payloads.len(), 15);
    for (n, payload) in payloads.iter().enumerate() {
        assert_eq!(payload[0] as usize, n, "kept in order, oldest first");
    }
}

#[test]
fn messages_that_waited_too_long_go_and_make_room() {
    let hold = 120_000;
    let (mut core, s) = asleep(Settings {
        max_waiting: 2,
        hold_ms: hold,
        ..Settings::default()
    });
    msg(&mut core, 0, s, 1, Bytes::from_static(b"old"));
    msg(&mut core, 10, s, 1, Bytes::from_static(b"older"));
    msg(&mut core, 20, s, 1, Bytes::from_static(b"dropped"));
    // The host never said it runs: each request wakes it.
    assert_eq!(wakes(&core.take()), 3);
    assert_eq!(core.deadline(), Some(hold));
    core.on(hold, Input::Tick);
    msg(&mut core, hold, s, 1, Bytes::from_static(b"new"));
    connect(&mut core, hold + 1, 2);
    sub(&mut core, hold + 1, 2, "rpc", "9");
    assert_eq!(delivered(&core.take(), 2), ["older", "new"]);
    assert_eq!(core.deadline(), None);
}

fn wakes(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|effect| matches!(effect, Effect::Wake { .. }))
        .count()
}

#[test]
fn a_request_wakes_a_sleeping_sandbox_and_one_that_falls_asleep_before_it_answers() {
    // The agent is connected and holds its subscription, as in a VM that
    // was paused: the host delivers to it, and only a wake runs it.
    let every = 250;
    let mut core = core(Settings {
        wake_every_ms: every,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Awake);
    core.take();
    send(
        &mut core,
        0,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"write"),
    );
    assert_eq!(wakes(&core.take()), 1);
    // Answered, then put to sleep at once: an explicit sleep right after a
    // request stays.
    answer(&mut core, 2, 1, "_INBOX.1");
    told(&mut core, 5, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
    // A request for it asleep wakes it at once, however soon.
    send(
        &mut core,
        10,
        (s, 1),
        Some("_INBOX.2"),
        Bytes::from_static(b"exec"),
    );
    let effects = core.take();
    assert_eq!(wakes(&effects), 1);
    assert_eq!(delivered(&effects, 1), ["exec"]);
    // Running again, a request that soon after needs no wake of its own...
    told(&mut core, 12, Running::Awake);
    send(
        &mut core,
        20,
        (s, 1),
        Some("_INBOX.3"),
        Bytes::from_static(b"again"),
    );
    let effects = core.take();
    assert_eq!(wakes(&effects), 0);
    assert_eq!(delivered(&effects, 1), ["again"]);
    // ...until it falls asleep with both unanswered: it is woken for them.
    told(&mut core, 30, Running::Asleep);
    assert_eq!(wakes(&core.take()), 1, "woken once for both");
    told(&mut core, 31, Running::Awake);
    answer(&mut core, 32, 1, "_INBOX.2");
    told(&mut core, 33, Running::Asleep);
    assert_eq!(wakes(&core.take()), 1, "it still owes one");
    told(&mut core, 34, Running::Awake);
    answer(&mut core, 35, 1, "_INBOX.3");
    told(&mut core, 36, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0, "it owes nothing");
    // Nothing of this needs a timer.
    assert_eq!(core.deadline(), None);
    // Awake, a request after a quiet interval wakes it at once.
    told(&mut core, 40, Running::Awake);
    send(
        &mut core,
        2 * every,
        (s, 1),
        Some("_INBOX.4"),
        Bytes::from_static(b"later"),
    );
    assert_eq!(wakes(&core.take()), 1);
    assert_eq!(core.deadline(), None);
}

#[test]
fn a_message_nobody_waits_on_reaches_a_sleeping_agent_without_waking_it() {
    let mut core = core(Settings::default());
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Asleep);
    core.take();
    // Acknowledgements of what the agent sent before it slept.
    for n in 0..10u8 {
        send(&mut core, u64::from(n), (s, 1), None, Bytes::from(vec![n]));
    }
    let effects = core.take();
    assert_eq!(wakes(&effects), 0);
    assert_eq!(
        delivered(&effects, 1).len(),
        10,
        "delivered for when it runs"
    );
    // Nor when it sleeps again.
    told(&mut core, 20, Running::Awake);
    told(&mut core, 21, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
    assert_eq!(core.deadline(), None);
}

#[test]
fn a_request_left_unanswered_is_woken_for_only_while_it_is_young() {
    let hold = 120_000;
    let mut core = core(Settings {
        hold_ms: hold,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Awake);
    core.take();
    send(
        &mut core,
        0,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"never answered"),
    );
    core.take();
    told(&mut core, hold - 1, Running::Asleep);
    assert_eq!(wakes(&core.take()), 1);
    // Its sender gave up on it by now.
    told(&mut core, hold - 1, Running::Awake);
    told(&mut core, hold, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
    // An answer to nothing it owes changes nothing.
    answer(&mut core, hold + 1, 1, "_INBOX.1");
    told(&mut core, hold + 2, Running::Awake);
    told(&mut core, hold + 3, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
}

#[test]
fn the_requests_an_agent_owes_answers_to_are_bounded() {
    let hold = 120_000;
    let mut core = core(Settings {
        max_waiting: 2,
        hold_ms: hold,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Asleep);
    core.take();
    for n in 1..=3u8 {
        let reply = format!("_INBOX.{n}");
        send(&mut core, 1, (s, 1), Some(&reply), Bytes::from(vec![n]));
    }
    // One past the bound wakes it like the others...
    assert_eq!(wakes(&core.take()), 3);
    told(&mut core, 2, Running::Awake);
    answer(&mut core, 3, 1, "_INBOX.1");
    answer(&mut core, 3, 1, "_INBOX.2");
    // ...and, its answer not told apart, is owed one until it is old.
    told(&mut core, 4, Running::Asleep);
    assert_eq!(wakes(&core.take()), 1);
    answer(&mut core, 5, 1, "_INBOX.3");
    told(&mut core, hold, Running::Awake);
    told(&mut core, hold + 1, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
}

/// Past the bound, a request soon after a wake has no wake of its own
/// either: it is owed an answer all the same, so a sandbox that goes to
/// sleep before it answers is woken for it.
#[test]
fn a_request_past_the_bound_soon_after_a_wake_is_woken_for_when_its_sandbox_sleeps() {
    let mut core = core(Settings {
        max_waiting: 1,
        wake_every_ms: 250,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Awake);
    core.take();
    send(
        &mut core,
        10,
        (s, 1),
        Some("_INBOX.A"),
        Bytes::from_static(b"a"),
    );
    assert_eq!(wakes(&core.take()), 1);
    send(
        &mut core,
        20,
        (s, 1),
        Some("_INBOX.B"),
        Bytes::from_static(b"b"),
    );
    let effects = core.take();
    assert_eq!(wakes(&effects), 0, "within the wake interval");
    assert_eq!(delivered(&effects, 1), ["b"]);
    answer(&mut core, 30, 1, "_INBOX.A");
    told(&mut core, 40, Running::Asleep);
    assert_eq!(wakes(&core.take()), 1, "it still owes B an answer");
}

/// A request dropped because as many wait as the host keeps never
/// reaches the agent, which owes it nothing: it wakes the sandbox once,
/// as any request does, and the sandbox may sleep again.
#[test]
fn a_request_dropped_unread_is_owed_nothing() {
    let (mut core, s) = asleep(Settings {
        max_waiting: 1,
        ..Settings::default()
    });
    told(&mut core, 0, Running::Asleep);
    core.take();
    // A receipt fills what may wait; the request after it is dropped.
    send(&mut core, 1, (s, 1), None, Bytes::from_static(b"receipt"));
    send(
        &mut core,
        2,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"request"),
    );
    assert_eq!(wakes(&core.take()), 1);
    told(&mut core, 3, Running::Awake);
    told(&mut core, 4, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
}

/// Requests that waited for a subscription its agent then gave up never
/// reach it, and are owed nothing.
#[test]
fn requests_dropped_with_their_subscription_are_owed_nothing() {
    let grace = 10_000;
    let (mut core, s) = asleep(Settings {
        grace_ms: grace,
        ..Settings::default()
    });
    told(&mut core, 0, Running::Asleep);
    send(
        &mut core,
        1,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"request"),
    );
    // The agent comes back and does not take the subscription up again.
    connect(&mut core, 2, 2);
    core.on(2 + grace, Input::Tick);
    let effects = core.take();
    assert_eq!(unsubs(&effects), [1], "the subscription ended");
    assert_eq!(delivered(&effects, 2), Vec::<Bytes>::new());
    told(&mut core, 3 + grace, Running::Awake);
    told(&mut core, 4 + grace, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
}

/// Another agent process holds the sandbox's session from scratch: what
/// the one before was asked, it will never answer.
#[test]
fn another_agent_process_owes_nothing_the_one_before_was_asked() {
    let mut core = core(Settings::default());
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    told(&mut core, 0, Running::Awake);
    send(
        &mut core,
        1,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"request"),
    );
    core.on(2, Input::GuestClosed { conn: 1 });
    connect_as(&mut core, 3, 2, "i2");
    core.take();
    told(&mut core, 4, Running::Asleep);
    assert_eq!(wakes(&core.take()), 0);
}

/// A session ended for good drops what waits for its agent, which is owed
/// nothing; a request its agent already got it may still answer. That holds
/// as well when what its agent got fills every tracked answer, so the one
/// that waits is past the bound.
#[test]
fn a_session_ended_for_good_owes_only_what_its_agent_got() {
    for max_waiting in [Settings::default().max_waiting, 1] {
        a_session_ended_for_good_owes_only_what_its_agent_got_with(max_waiting);
    }
}

fn a_session_ended_for_good_owes_only_what_its_agent_got_with(max_waiting: usize) {
    let hold = 120_000;
    let mut core = core(Settings {
        hold_ms: hold,
        max_waiting,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    let s = open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    sub(&mut core, 0, 1, "later", "2");
    told(&mut core, 0, Running::Awake);
    send(
        &mut core,
        1,
        (s, 1),
        Some("_INBOX.1"),
        Bytes::from_static(b"got"),
    );
    core.on(2, Input::GuestClosed { conn: 1 });
    send(
        &mut core,
        3,
        (s, 2),
        Some("_INBOX.2"),
        Bytes::from_static(b"waits"),
    );
    core.on(
        4,
        Input::Gateway {
            link: LINK,
            frame: GatewayFrame::Closed {
                s,
                code: compute_protocol::link::Ending::Superseded,
                message: String::new(),
            },
            payload: Bytes::new(),
        },
    );
    core.take();
    told(&mut core, 5, Running::Asleep);
    assert_eq!(
        wakes(&core.take()),
        1,
        "it still owes the one it got (max_waiting {max_waiting})"
    );
    // Once the one it got is old, the one dropped, younger, is owed
    // nothing either.
    told(&mut core, hold, Running::Awake);
    told(&mut core, hold + 1, Running::Asleep);
    assert_eq!(
        wakes(&core.take()),
        0,
        "and nothing for the one dropped (max_waiting {max_waiting})"
    );
}

fn errors(effects: &[Effect], to: ConnId) -> Vec<String> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::ToGuest {
                conn,
                op: ServerOp::Err(text),
            } if *conn == to => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn closed(effects: &[Effect], to: ConnId) -> bool {
    effects
        .iter()
        .any(|effect| matches!(effect, Effect::CloseGuest { conn } if *conn == to))
}

/// The host sids the gateway was told to stop, in order.
fn unsubs(effects: &[Effect]) -> Vec<u32> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Frame {
                frame: HostFrame::Unsub { sid, .. },
                ..
            } => Some(*sid),
            _ => None,
        })
        .collect()
}

#[test]
fn empty_operations_held_before_the_session_opens_count_against_the_limit() {
    let mut core = core(Settings {
        pending_bytes: 64 << 10,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    core.take();
    // The session is not open yet, so all this waits; none of it carries
    // a byte of payload.
    let mut ended_after = None;
    for n in 0..10_000 {
        guest(
            &mut core,
            0,
            1,
            ClientOp::Pub(Publish {
                subject: format!("{}.out", scope()),
                reply: None,
                headers: None,
                payload: Bytes::new(),
            }),
        );
        let effects = core.take();
        if closed(&effects, 1) {
            assert_eq!(errors(&effects, 1), ["Slow Consumer"]);
            ended_after = Some(n + 1);
            break;
        }
    }
    let ended_after = ended_after.expect("ten thousand empty publications were all kept");
    assert!(ended_after < 1_000, "kept {ended_after} empty publications");
}

#[test]
fn subscriptions_past_the_limit_are_refused_and_the_session_goes_on() {
    let mut core = core(Settings {
        max_subs: 3,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    open(&mut core, 0);
    for n in 0..3 {
        sub(&mut core, 0, 1, &format!("s{n}"), &n.to_string());
    }
    let effects = core.take();
    assert_eq!(errors(&effects, 1), Vec::<String>::new());
    sub(&mut core, 0, 1, "s3", "3");
    let effects = core.take();
    assert_eq!(errors(&effects, 1), ["Maximum Subscriptions Exceeded"]);
    assert!(!closed(&effects, 1), "a refused subscription ends nothing");
    assert!(
        !effects.iter().any(|effect| matches!(
            effect,
            Effect::Frame {
                frame: HostFrame::Sub { .. },
                ..
            } | Effect::Save { .. }
        )),
        "a refused subscription reaches neither the gateway nor the disk: {effects:?}"
    );
    // Its relay subscriptions count too, per connection.
    guest(
        &mut core,
        0,
        1,
        ClientOp::Sub {
            subject: compute_protocol::link::RELAY_SUBJECT.into(),
            queue: None,
            sid: "relay".into(),
        },
    );
    assert_eq!(errors(&core.take(), 1), ["Maximum Subscriptions Exceeded"]);
    // One ends, and another takes its place.
    guest(
        &mut core,
        0,
        1,
        ClientOp::Unsub {
            sid: "0".into(),
            max: None,
        },
    );
    sub(&mut core, 0, 1, "s3", "3");
    let effects = core.take();
    assert_eq!(errors(&effects, 1), Vec::<String>::new(), "{effects:?}");
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::Frame {
            frame: HostFrame::Sub { .. },
            ..
        }
    )));
}

#[test]
fn connections_past_the_limit_are_refused() {
    let mut core = core(Settings {
        max_conns: 2,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    connect(&mut core, 0, 2);
    let effects = core.take();
    assert!(!closed(&effects, 1) && !closed(&effects, 2));
    core.on(
        0,
        Input::Accepted {
            conn: 3,
            sandbox: SANDBOX.into(),
        },
    );
    let effects = core.take();
    assert_eq!(errors(&effects, 3), ["maximum connections exceeded"]);
    assert!(closed(&effects, 3));
    // One that ends makes room.
    core.on(0, Input::GuestClosed { conn: 2 });
    core.on(
        0,
        Input::Accepted {
            conn: 4,
            sandbox: SANDBOX.into(),
        },
    );
    assert!(!closed(&core.take(), 4));
}

#[test]
fn each_subscription_a_connection_leaves_has_its_whole_grace_period() {
    let grace = 10_000;
    let mut core = core(Settings {
        grace_ms: grace,
        ..Settings::default()
    });
    // Three connections of one agent, two with a subscription each.
    connect(&mut core, 0, 1);
    open(&mut core, 0);
    connect(&mut core, 0, 2);
    connect(&mut core, 0, 3);
    sub(&mut core, 0, 1, "first", "1");
    sub(&mut core, 0, 2, "second", "1");
    core.take();
    // The first leaves at 1 s and the second at 9 s, while the third
    // stays.
    core.on(1_000, Input::GuestClosed { conn: 1 });
    core.on(9_000, Input::GuestClosed { conn: 2 });
    core.take();
    assert_eq!(core.deadline(), Some(1_000 + grace));
    core.on(1_000 + grace, Input::Tick);
    assert_eq!(unsubs(&core.take()), [1], "only the first one's time is up");
    assert_eq!(core.deadline(), Some(9_000 + grace));
    core.on(9_000 + grace - 1, Input::Tick);
    assert_eq!(unsubs(&core.take()), Vec::<u32>::new());
    core.on(9_000 + grace, Input::Tick);
    assert_eq!(unsubs(&core.take()), [2]);
    assert_eq!(core.deadline(), None);
}

#[test]
fn a_subscription_taken_up_in_time_stays_and_a_gone_agent_keeps_them_all() {
    let grace = 10_000;
    let mut core = core(Settings {
        grace_ms: grace,
        ..Settings::default()
    });
    connect(&mut core, 0, 1);
    open(&mut core, 0);
    connect(&mut core, 0, 2);
    sub(&mut core, 0, 1, "rpc", "1");
    core.on(1_000, Input::GuestClosed { conn: 1 });
    // Taken up again by the other connection, before its time is up.
    sub(&mut core, 5_000, 2, "rpc", "7");
    core.take();
    assert_eq!(core.deadline(), None);
    core.on(1_000 + grace, Input::Tick);
    assert_eq!(unsubs(&core.take()), Vec::<u32>::new());
    // The whole agent goes, as one that sleeps: its subscriptions wait for
    // it however long that takes.
    core.on(20_000, Input::GuestClosed { conn: 2 });
    core.take();
    assert_eq!(core.deadline(), None);
    // Back, it has the grace period from when it is connected again.
    connect(&mut core, 1_000_000, 3);
    core.take();
    assert_eq!(core.deadline(), Some(1_000_000 + grace));
}

#[test]
fn a_sandbox_that_falls_asleep_has_its_session_kept_again() {
    let mut core = core(Settings::default());
    connect(&mut core, 0, 1);
    open(&mut core, 0);
    sub(&mut core, 0, 1, "rpc", "1");
    core.take();
    core.on(
        0,
        Input::Running {
            sandbox: SANDBOX.into(),
            running: Running::Awake,
        },
    );
    assert!(
        !core
            .take()
            .iter()
            .any(|effect| matches!(effect, Effect::Save { .. }))
    );
    core.on(
        0,
        Input::Running {
            sandbox: SANDBOX.into(),
            running: Running::Asleep,
        },
    );
    let saved = core
        .take()
        .into_iter()
        .find_map(|effect| match effect {
            Effect::Save { saved, .. } => Some(saved),
            _ => None,
        })
        .expect("kept again as it fell asleep")
        .expect("with its session");
    assert_eq!(saved.instance, INSTANCE);
    assert_eq!(saved.subs.len(), 1);
}
