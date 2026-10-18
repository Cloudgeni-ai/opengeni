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
            name: Some(format!("{CONNECTION_NAME}{INSTANCE}")),
            ..Connect::default()
        }),
    );
}

/// Answers the session's `open` with `opened`.
fn open(core: &mut Core, now: u64) {
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
