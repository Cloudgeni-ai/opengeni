//! The agent link: frames between a host and an Opengeni agent gateway
//! ([`docs/agent-link.md`](../../docs/agent-link.md),
//! [ADR 21](../../docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)).
//!
//! One WebSocket binary message is one frame: a JSON header ([`HostFrame`]
//! or [`GatewayFrame`]), one `\n`, then the payload bytes. Only `pub` and
//! `msg` frames carry a payload; for every other frame it is empty.

use serde::{Deserialize, Serialize};

/// The vsock port a guest's agent reaches its host's NATS endpoint on.
pub const AGENT_LINK_PORT: u32 = 58;

/// The WebSocket subprotocol of this version.
pub const SUBPROTOCOL: &str = "opengeni.agent-link.v1";

/// The version a gateway's `hello` names.
pub const VERSION: u32 = 1;

/// The subject a guest's agent subscribes to for its relay credential. The
/// host answers it itself; it never reaches the gateway.
pub const RELAY_SUBJECT: &str = "_compute.relay";

/// NATS message headers, in order, as `[name, value]` pairs.
pub type Headers = Vec<(String, String)>;

/// A frame a host sends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostFrame {
    /// Open session `s` for a sandbox. `s` is never reused on one link.
    Open {
        s: u32,
        sandbox: String,
        ticket: String,
        /// The agent's connection instance id.
        connection: String,
    },
    /// Subscribe; `sid` is the host's, stable for the session.
    Sub {
        s: u32,
        sid: u32,
        subject: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue: Option<String>,
    },
    /// End a subscription.
    Unsub { s: u32, sid: u32 },
    /// Publish the frame's payload.
    Pub {
        s: u32,
        subject: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<Headers>,
    },
    /// Whether the sandbox runs, for display only.
    State { s: u32, state: Running },
    /// End the session.
    Close { s: u32 },
}

/// Whether a sandbox runs, as a `state` frame reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Running {
    Awake,
    Asleep,
}

/// A frame a gateway sends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum GatewayFrame {
    /// The first frame on a link.
    Hello { version: u32, max_payload: u32 },
    /// The session is open.
    Opened {
        s: u32,
        /// `agent.<workspace>.<agent>.connection.<instance>`.
        scope: String,
        relay: Relay,
    },
    /// The session was not opened.
    Refused {
        s: u32,
        code: Refusal,
        message: String,
    },
    /// A message for a subscription, with the frame's payload.
    Msg {
        s: u32,
        sid: u32,
        subject: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<Headers>,
    },
    /// A fresh relay credential.
    Relay {
        s: u32,
        #[serde(flatten)]
        relay: Relay,
    },
    /// The gateway ended the session.
    Closed {
        s: u32,
        code: Ending,
        message: String,
    },
    /// An operation was refused; the session stays open.
    Error {
        s: u32,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sid: Option<u32>,
    },
}

/// Where and how an agent registers its streams with Opengeni's relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relay {
    pub url: String,
    pub token: String,
    pub expires_at_ms: u64,
}

/// Why a gateway did not open a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    InvalidTicket,
    StaleEpoch,
    UnknownAgent,
    Revoked,
    /// Another live instance holds the agent.
    Duplicate,
    /// Try again later.
    Unavailable,
    /// A code this host does not know, taken as final.
    #[serde(other)]
    Other,
}

impl Refusal {
    /// Whether opening again later may succeed without anything else
    /// changing.
    #[must_use]
    pub fn transient(self) -> bool {
        matches!(self, Self::Unavailable | Self::Duplicate)
    }
}

/// Why a gateway ended a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ending {
    Revoked,
    /// A later owner epoch opened a session for the sandbox.
    Superseded,
    /// The gateway's claim on the agent's connection lapsed.
    Lost,
    /// A code this host does not know.
    #[serde(other)]
    Other,
}

/// A frame as one WebSocket message: the header, `\n`, the payload.
///
/// # Errors
///
/// When the header cannot be encoded, which a well-formed frame never
/// causes.
pub fn encode<F: Serialize>(frame: &F, payload: &[u8]) -> serde_json::Result<Vec<u8>> {
    let mut message = serde_json::to_vec(frame)?;
    message.reserve(1 + payload.len());
    message.push(b'\n');
    message.extend_from_slice(payload);
    Ok(message)
}

/// What is wrong with a received message.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("a frame has no header end")]
    NoHeaderEnd,
    #[error("a frame's header is not valid: {0}")]
    Header(#[from] serde_json::Error),
    #[error("a `{0}` frame carries a payload")]
    UnexpectedPayload(&'static str),
}

/// Splits one WebSocket message into its header and payload.
///
/// # Errors
///
/// When the message has no `\n`, its header is not a frame `F`, or a frame
/// that carries none has a payload.
pub fn decode<'a, F: Deserialize<'a> + Carries>(
    message: &'a [u8],
) -> Result<(F, &'a [u8]), FrameError> {
    let end = message
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or(FrameError::NoHeaderEnd)?;
    let frame: F = serde_json::from_slice(&message[..end])?;
    let payload = &message[end + 1..];
    if !payload.is_empty() && !frame.carries_payload() {
        return Err(FrameError::UnexpectedPayload(frame.name()));
    }
    Ok((frame, payload))
}

/// Which frames carry a payload.
pub trait Carries {
    /// Whether this frame carries a payload.
    fn carries_payload(&self) -> bool;
    /// Its `t`.
    fn name(&self) -> &'static str;
}

impl Carries for HostFrame {
    fn carries_payload(&self) -> bool {
        matches!(self, Self::Pub { .. })
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::Sub { .. } => "sub",
            Self::Unsub { .. } => "unsub",
            Self::Pub { .. } => "pub",
            Self::State { .. } => "state",
            Self::Close { .. } => "close",
        }
    }
}

impl Carries for GatewayFrame {
    fn carries_payload(&self) -> bool {
        matches!(self, Self::Msg { .. })
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::Opened { .. } => "opened",
            Self::Refused { .. } => "refused",
            Self::Msg { .. } => "msg",
            Self::Relay { .. } => "relay",
            Self::Closed { .. } => "closed",
            Self::Error { .. } => "error",
        }
    }
}

/// How the host reaches a sandbox's agent: the gateway of the sandbox's
/// team and the fleet's ticket for this host and owner epoch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentLink {
    /// The gateway's `wss://` (or, in tests, `ws://`) URL.
    pub gateway: String,
    /// The fleet's signed ticket.
    pub ticket: String,
}

/// The subject permissions of a session whose scope is `scope`, as the
/// NATS callout grants an agent: subscribe within `<scope>.>`, publish
/// within it or to `_INBOX.>`.
#[must_use]
pub fn may_subscribe(scope: &str, subject: &str) -> bool {
    within(scope, subject)
}

/// See [`may_subscribe`].
#[must_use]
pub fn may_publish(scope: &str, subject: &str) -> bool {
    within(scope, subject) || within("_INBOX", subject)
}

/// Whether `subject` is a valid subject strictly below `prefix`, with no
/// wildcards in `prefix`'s part.
fn within(prefix: &str, subject: &str) -> bool {
    subject
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .split('.')
                    .all(|token| !token.is_empty() && !token.contains([' ', '\t', '\r', '\n']))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_with_their_payload() {
        let frame = HostFrame::Pub {
            s: 3,
            subject: "agent.w.a.connection.c.events".into(),
            reply: None,
            headers: Some(vec![("Nats-Msg-Id".into(), "1".into())]),
        };
        let message = encode(&frame, b"\x00binary\n").unwrap();
        let (back, payload): (HostFrame, _) = decode(&message).unwrap();
        assert_eq!(back, frame);
        assert_eq!(payload, b"\x00binary\n");
        let header =
            std::str::from_utf8(&message[..message.iter().position(|b| *b == b'\n').unwrap()])
                .unwrap();
        assert_eq!(
            header,
            r#"{"t":"pub","s":3,"subject":"agent.w.a.connection.c.events","headers":[["Nats-Msg-Id","1"]]}"#
        );
    }

    #[test]
    fn gateway_frames_parse_as_the_protocol_writes_them() {
        let (frame, payload): (GatewayFrame, _) = decode(
            br#"{"t":"relay","s":1,"url":"wss://relay","token":"ogr_x","expires_at_ms":5}
"#,
        )
        .unwrap();
        assert_eq!(payload, b"");
        assert_eq!(
            frame,
            GatewayFrame::Relay {
                s: 1,
                relay: Relay {
                    url: "wss://relay".into(),
                    token: "ogr_x".into(),
                    expires_at_ms: 5
                }
            }
        );
        let (frame, _): (GatewayFrame, _) =
            decode(b"{\"t\":\"refused\",\"s\":2,\"code\":\"something_new\",\"message\":\"m\"}\n")
                .unwrap();
        assert!(matches!(
            frame,
            GatewayFrame::Refused {
                code: Refusal::Other,
                ..
            }
        ));
        assert!(!Refusal::Other.transient());
        assert!(Refusal::Unavailable.transient());
    }

    #[test]
    fn malformed_messages_are_refused() {
        assert!(matches!(
            decode::<HostFrame>(b"{\"t\":\"close\",\"s\":1}"),
            Err(FrameError::NoHeaderEnd)
        ));
        assert!(matches!(
            decode::<HostFrame>(b"{\"t\":\"close\",\"s\":1}\nx"),
            Err(FrameError::UnexpectedPayload("close"))
        ));
        assert!(matches!(
            decode::<HostFrame>(b"{\"t\":\"close\",\"s\":1,\"extra\":2}\n"),
            Err(FrameError::Header(_))
        ));
        assert!(matches!(
            decode::<GatewayFrame>(b"{\"t\":\"nope\"}\n"),
            Err(FrameError::Header(_))
        ));
    }

    #[test]
    fn permissions_match_the_callout() {
        let scope = "agent.w.a.connection.c";
        assert!(may_subscribe(scope, "agent.w.a.connection.c.rpc"));
        assert!(may_subscribe(scope, "agent.w.a.connection.c.replay.>"));
        assert!(!may_subscribe(scope, "agent.w.a.connection.c"));
        assert!(!may_subscribe(scope, "agent.w.a.connection.cx.rpc"));
        assert!(!may_subscribe(scope, "agent.w.a.connection.d.rpc"));
        assert!(!may_subscribe(scope, "_INBOX.abc"));
        assert!(!may_subscribe(scope, "agent.w.a.connection.c..rpc"));
        assert!(may_publish(scope, "_INBOX.abc.def"));
        assert!(may_publish(scope, "agent.w.a.connection.c.events"));
        assert!(!may_publish(scope, "agent.w.b.connection.c.events"));
        assert!(!may_publish(scope, "_INBOX"));
        assert!(!may_publish(scope, "agent.w.a.connection.c.a b"));
    }
}
