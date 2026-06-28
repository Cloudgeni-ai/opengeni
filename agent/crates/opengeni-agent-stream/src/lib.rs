//! Relay-edge stream transport for the OpenGeni self-hosted agent.
//!
//! The agent dials OUT to a stateless relay edge and pumps interactive PTY bytes
//! and desktop framebuffer frames over it, fate-isolated from the NATS control
//! plane (dossier §10.1/§10.5). This crate is the agent's end of that plane:
//!
//! * [`transport`] — the [`RelayTransport`](transport::RelayTransport) seam: a
//!   duplex datagram channel. The CONCRETE day-1 path is `wss`
//!   ([`transport::wss::WssTransport`], via `tokio-tungstenite`); the PREFERRED
//!   QUIC/WebTransport path is structured behind the same trait + the `quic`
//!   feature.
//! * [`codec`] — the relay framing ([`MsgTag`](codec::MsgTag) + a protobuf body).
//! * [`channel`] — a [`RelayChannel`](channel::RelayChannel) keyed by
//!   `{workspaceId, agentId, port}`, authorized by a scoped token, AUTO-RECONNECTING
//!   + RESUMING on a relay blip (§10.6).
//! * [`pty_pump`] / [`framebuffer_pump`] — the byte/frame pumps bridging a
//!   platform PTY / desktop backend to a channel.
//! * [`hub`] — [`RelayHub`](hub::RelayHub), the agent's
//!   [`StreamRegistry`](opengeni_agent_platform::StreamRegistry): the platform hands
//!   it a PTY/desktop, it opens the channel + spawns the supervised pump and returns
//!   the channel descriptor.
//! * [`backoff`] — full-jitter backoff for channel re-registration.
//!
//! # THE RELAY-DIAL WIRE PROTOCOL (the M8b contract)
//!
//! This is the precise contract the relay tier (M8b) MUST implement so the agent's
//! producer side and the browser's consumer side splice correctly. It is defined
//! here once.
//!
//! ## 1. Dial
//!
//! Both the agent (producer) and the viewer (consumer) DIAL OUT to the relay — no
//! inbound ports. The dial URL is `wss://<relay-host>/<path>?<channel-key>` where
//! the channel-key query is `ws=<workspaceId>&agent=<agentId>&port=<port>`
//! ([`ChannelKey::query`](channel::ChannelKey::query)). For the agent the base
//! `wss://…` comes from its enrollment (`relay_url`); for the viewer the control
//! plane mints the URL via `resolveExposedPort(port)` →
//! `{host: relay, port, tls, query: channel-key}`. The QUIC path derives its
//! endpoint from the same base + key.
//!
//! ## 2. Registration handshake
//!
//! The FIRST datagram each end sends is a [`StreamOpen`](opengeni_agent_proto::v1::StreamOpen):
//!
//! ```text
//!   StreamOpen {
//!     channel: { channel_id, workspace_id, agent_id, kind, port },  // the key
//!     token:   "<scoped token>",   // agent: enrollment relay token;
//!                                  // viewer: control-plane `ogs_` mint
//!     role:    AGENT | CLIENT,
//!     resume_from_seq: <u64>,      // 0 fresh; >0 on a reconnect (resume point)
//!   }
//! ```
//!
//! Framing: each message is `tag:u8 || protobuf-body` ([`codec`]), carried as ONE
//! WebSocket **binary** message (or QUIC datagram). The tags are stable wire
//! constants ([`MsgTag`](codec::MsgTag)): Open=1, OpenAck=2, Frame=3, Close=4,
//! DesktopInput=5.
//!
//! ## 3. What the relay MUST do
//!
//! 1. Parse the channel-key query; require the in-band `StreamOpen.channel` key to
//!    match it (defense in depth).
//! 2. **Validate the token**: the AGENT's token is its enrollment-scoped relay
//!    token; the VIEWER's token is the control-plane-minted scoped `ogs_` token
//!    (`verifyStreamToken`, `packages/runtime/src/sandbox/stream-token.ts`) — the
//!    relay validates authenticity + the lease/active-epoch fence. A bad/expired
//!    token ⇒ reply `StreamOpenAck { accepted:false, error }` then close.
//! 3. **Pair** a producer (`role=AGENT`) with a consumer (`role=CLIENT`) by the
//!    channel key. Reply each accepted side `StreamOpenAck { accepted:true,
//!    resume_from_seq }` (the sequence the peer will resume sending from — `0`, or
//!    the consumer's last-acked seq on a resume so the producer replays).
//! 4. **Splice**: forward [`StreamFrame`](opengeni_agent_proto::v1::StreamFrame)
//!    agent→viewer (pty output / desktop frames) and
//!    [`DesktopInput`](opengeni_agent_proto::v1::DesktopInput) /
//!    [`StreamFrame`](opengeni_agent_proto::v1::StreamFrame) viewer→agent (pty
//!    keystrokes / computer-use input). The relay is a DUMB byte pump: bounded
//!    per-channel ring buffers, backpressure, per-token leaky-bucket rate limits —
//!    fate-isolated so stream load can never starve the control plane.
//! 5. **Resume** (§10.6): on a producer/consumer reconnect with `resume_from_seq`,
//!    replay buffered frames from that seq (within the ring buffer) so a relay-pod
//!    death is invisible. A relay pod death drops live channels which BOTH ends
//!    auto-reconnect + resume against the same key.
//! 6. [`StreamClose`](opengeni_agent_proto::v1::StreamClose) from either end tears
//!    the channel down and notifies the peer; an epoch-fence invalidation (a
//!    swap-away) is `reason = FENCED`.
//!
//! ## 4. Two tokens, one key (the seam to honor)
//!
//! Because the agent and the viewer dial INDEPENDENTLY, they present DIFFERENT
//! tokens (the agent's enrollment relay token vs. the viewer's `ogs_` mint) but the
//! SAME channel key. The relay validates each side's token on its own merits and
//! pairs by key. This is the one place the two stacks must agree; it is documented
//! here and in [`hub`]. The agent NEVER mints the viewer token (that is the control
//! plane's job, `mintStreamToken`).

#![doc(html_root_url = "https://docs.rs/opengeni-agent-stream")]

pub mod backoff;
pub mod channel;
pub mod codec;
pub mod error;
pub mod framebuffer_pump;
pub mod hub;
pub mod pty_pump;
pub mod transport;

pub use channel::{ChannelConfig, ChannelKey, RelayChannel};
pub use codec::{MsgTag, RelayMessage};
pub use error::{StreamError, StreamResult};
pub use hub::{RelayHub, RelayHubConfig, DESKTOP_STREAM_PORT, PTY_STREAM_PORT};
pub use transport::{RelayTransport, TransportKind};
