//! Relay framing codec — the on-the-wire tagging of stream-plane messages.
//!
//! The stream plane carries five logical messages defined in the proto IDL
//! ([`StreamOpen`], [`StreamOpenAck`], [`StreamFrame`], [`StreamClose`],
//! [`DesktopInput`]). The proto deliberately does NOT define how they are
//! delimited on a transport — that is a transport concern (the IDL header says
//! "the transport itself is NOT in this file"). This module defines that framing,
//! shared by the agent and (M8b) the relay so the two never disagree.
//!
//! # Frame format (the relay-dial framing — M8b MUST match)
//!
//! Each relay message is one transport datagram (a WebSocket **binary** message,
//! or a QUIC stream datagram) shaped as:
//!
//! ```text
//!   ┌──────────┬───────────────────────────────┐
//!   │  tag: u8 │  body: protobuf-encoded message│
//!   └──────────┴───────────────────────────────┘
//! ```
//!
//! The single leading `tag` byte ([`MsgTag`]) names which proto message the body
//! is; the body is the standard `prost` encoding of that message. Because each
//! WebSocket/QUIC message already carries its own length, NO extra length prefix
//! is needed — the transport frames the bytes. (If a future transport is a raw
//! byte stream rather than a message stream, prepend a `varint` length; the tag
//! semantics are unchanged.)
//!
//! [`StreamOpen`]: opengeni_agent_proto::v1::StreamOpen
//! [`StreamFrame`]: opengeni_agent_proto::v1::StreamFrame

use opengeni_agent_proto::v1;
use prost::Message as _;

use crate::error::StreamError;

/// The one-byte tag naming a relay message body. Stable wire constants — never
/// renumber (the relay decodes by these exact values).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MsgTag {
    /// A [`StreamOpen`](v1::StreamOpen) — channel registration / attach (first
    /// frame each end sends).
    Open = 1,
    /// A [`StreamOpenAck`](v1::StreamOpenAck) — the relay's accept/reject.
    OpenAck = 2,
    /// A [`StreamFrame`](v1::StreamFrame) — raw stream bytes (pty tty bytes or an
    /// encoded desktop framebuffer chunk).
    Frame = 3,
    /// A [`StreamClose`](v1::StreamClose) — channel teardown.
    Close = 4,
    /// A [`DesktopInput`](v1::DesktopInput) — typed computer-use input (client →
    /// agent on a desktop channel).
    DesktopInput = 5,
}

impl MsgTag {
    /// Decodes a tag byte, or `None` if it is not a known tag.
    #[must_use]
    pub fn from_u8(b: u8) -> Option<Self> {
        match b {
            1 => Some(Self::Open),
            2 => Some(Self::OpenAck),
            3 => Some(Self::Frame),
            4 => Some(Self::Close),
            5 => Some(Self::DesktopInput),
            _ => None,
        }
    }
}

/// A decoded relay message (the body after the [`MsgTag`]).
#[derive(Debug, Clone, PartialEq)]
pub enum RelayMessage {
    /// Channel registration / attach.
    Open(v1::StreamOpen),
    /// The relay's open acknowledgement.
    OpenAck(v1::StreamOpenAck),
    /// A data frame (pty/desktop bytes).
    Frame(v1::StreamFrame),
    /// Channel teardown.
    Close(v1::StreamClose),
    /// Typed computer-use input.
    DesktopInput(v1::DesktopInput),
}

impl RelayMessage {
    /// This message's wire tag.
    #[must_use]
    pub fn tag(&self) -> MsgTag {
        match self {
            Self::Open(_) => MsgTag::Open,
            Self::OpenAck(_) => MsgTag::OpenAck,
            Self::Frame(_) => MsgTag::Frame,
            Self::Close(_) => MsgTag::Close,
            Self::DesktopInput(_) => MsgTag::DesktopInput,
        }
    }

    /// Encodes the message into a tagged transport datagram (`tag || body`).
    ///
    /// # Panics
    ///
    /// Never in practice: encoding a `prost` message into a growable `Vec` cannot
    /// fail (the only `EncodeError` is a buffer-capacity error, impossible for a
    /// `Vec`). The `.expect` documents that invariant.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(self.tag() as u8);
        match self {
            Self::Open(m) => m.encode(&mut out),
            Self::OpenAck(m) => m.encode(&mut out),
            Self::Frame(m) => m.encode(&mut out),
            Self::Close(m) => m.encode(&mut out),
            Self::DesktopInput(m) => m.encode(&mut out),
        }
        .expect("encoding into a Vec never fails");
        out
    }

    /// Decodes a tagged transport datagram back into a [`RelayMessage`].
    ///
    /// # Errors
    ///
    /// Returns [`StreamError::Protocol`] for an empty datagram, an unknown tag, or
    /// a body that does not decode as the tagged message.
    pub fn decode(bytes: &[u8]) -> Result<Self, StreamError> {
        let (&tag_byte, body) = bytes
            .split_first()
            .ok_or_else(|| StreamError::Protocol("empty relay datagram".to_string()))?;
        let tag = MsgTag::from_u8(tag_byte)
            .ok_or_else(|| StreamError::Protocol(format!("unknown relay tag {tag_byte}")))?;
        let msg = match tag {
            MsgTag::Open => Self::Open(decode_body(body)?),
            MsgTag::OpenAck => Self::OpenAck(decode_body(body)?),
            MsgTag::Frame => Self::Frame(decode_body(body)?),
            MsgTag::Close => Self::Close(decode_body(body)?),
            MsgTag::DesktopInput => Self::DesktopInput(decode_body(body)?),
        };
        Ok(msg)
    }
}

/// Decodes a proto message body, mapping a decode failure to a protocol error.
fn decode_body<M: prost::Message + Default>(body: &[u8]) -> Result<M, StreamError> {
    M::decode(body).map_err(|e| StreamError::Protocol(format!("relay body decode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tag_round_trips() {
        let cases = [
            RelayMessage::Open(v1::StreamOpen {
                token: "ogs_abc".to_string(),
                role: v1::StreamRole::Agent as i32,
                resume_from_seq: 7,
                channel: Some(v1::StreamChannel {
                    channel_id: "ch-1".to_string(),
                    workspace_id: "ws".to_string(),
                    agent_id: "ag".to_string(),
                    kind: v1::StreamKind::Pty as i32,
                    port: 7681,
                }),
            }),
            RelayMessage::OpenAck(v1::StreamOpenAck {
                accepted: true,
                error: None,
                resume_from_seq: 7,
            }),
            RelayMessage::Frame(v1::StreamFrame {
                channel_id: "ch-1".to_string(),
                seq: 42,
                data: prost::bytes::Bytes::from_static(b"tty-bytes"),
                produced_at_ms: 1_700_000_000_000,
            }),
            RelayMessage::Close(v1::StreamClose {
                channel_id: "ch-1".to_string(),
                reason: v1::StreamCloseReason::Normal as i32,
                message: "bye".to_string(),
            }),
            RelayMessage::DesktopInput(v1::DesktopInput {
                channel_id: "ch-1".to_string(),
                event: Some(v1::desktop_input::Event::Pointer(v1::PointerEvent {
                    x: 10,
                    y: 20,
                    action: v1::PointerAction::Click as i32,
                    button: v1::PointerButton::Left as i32,
                })),
            }),
        ];
        for msg in cases {
            let bytes = msg.encode();
            let decoded = RelayMessage::decode(&bytes).expect("decode");
            assert_eq!(decoded, msg, "round-trip mismatch for {:?}", msg.tag());
        }
    }

    #[test]
    fn empty_and_unknown_tag_are_protocol_errors() {
        assert!(matches!(
            RelayMessage::decode(&[]),
            Err(StreamError::Protocol(_))
        ));
        assert!(matches!(
            RelayMessage::decode(&[0xfe, 0x00]),
            Err(StreamError::Protocol(_))
        ));
    }

    #[test]
    fn tag_byte_is_stable() {
        // Guard against an accidental renumber that would desync the relay.
        assert_eq!(MsgTag::Open as u8, 1);
        assert_eq!(MsgTag::OpenAck as u8, 2);
        assert_eq!(MsgTag::Frame as u8, 3);
        assert_eq!(MsgTag::Close as u8, 4);
        assert_eq!(MsgTag::DesktopInput as u8, 5);
    }
}
