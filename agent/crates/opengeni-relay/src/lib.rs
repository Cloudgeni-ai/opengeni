//! `opengeni-relay` — the stateless stream-relay edge (dossier §10.1/§10.5).
//!
//! The relay is a **dumb byte-pump** on its own fate-isolated tier: it pairs a
//! self-hosted agent (the PRODUCER of pty/desktop frames) with a browser viewer
//! (the CONSUMER, who also sends input back) and splices frames between them. It
//! holds NO state beyond live channels — a relay pod death drops live streams which
//! BOTH ends auto-reconnect + resume against the same channel key (the headline
//! resiliency property). Lease ownership stays in Postgres; the relay only routes
//! and rate-limits bytes.
//!
//! # The relay-dial wire protocol (the M8a contract this crate implements)
//!
//! Both ends DIAL OUT to the relay (no inbound ports on the agent's machine). The
//! framing, message tags, and handshake are defined ONCE in
//! [`opengeni_agent_stream`] and shared verbatim — this crate depends on that
//! crate's [`codec`](opengeni_agent_stream::codec) and
//! [`ChannelKey`](opengeni_agent_stream::ChannelKey) so the two ends can never
//! drift.
//!
//! 1. **Dial**: `wss://<relay-host>/stream?ws=<workspaceId>&agent=<agentId>&port=<port>`
//!    (+ a `channel=<channelId>` hint from the control plane's `resolveExposedPort`).
//!    The query is the routing [`ChannelKey`](opengeni_agent_stream::ChannelKey).
//! 2. **Handshake**: the first datagram each end sends is a
//!    [`StreamOpen`](opengeni_agent_proto::v1::StreamOpen) carrying the channel key,
//!    a scoped token, the role (AGENT|CLIENT), and `resume_from_seq`.
//! 3. **The relay** ([`server`] + [`registry`]) then, for each connection:
//!
//! * parses the channel-key query and requires the in-band `StreamOpen.channel`
//!   to match it (defense in depth);
//! * VALIDATES the token on its own merits — the AGENT's enrollment-scoped `ogr_`
//!   producer token ([`token::verify_relay_token`]) or the VIEWER's
//!   control-plane-minted `ogs_` token ([`token::verify_stream_token`]) INCLUDING
//!   the lease/active-epoch fence (a stale-epoch viewer is rejected so it can never
//!   reach a swapped-away box — [`registry`]);
//! * replies [`StreamOpenAck`](opengeni_agent_proto::v1::StreamOpenAck);
//! * PAIRS the producer with the consumer by the channel key;
//! * SPLICES frames bidirectionally with bounded ring buffers ([`ring`]),
//!   backpressure, and per-token leaky-bucket rate limits ([`rate_limit`]) —
//!   fate-isolated so stream load can never starve anything;
//! * RESUMEs from `resume_from_seq` on a reconnect (replays the bounded ring);
//! * tears the channel down on
//!   [`StreamClose`](opengeni_agent_proto::v1::StreamClose) and notifies the peer;
//!   an epoch-fence swap-away is `reason = FENCED`.
//!
//! # The two-token, one-key seam (the §10.5 contract)
//!
//! The agent and the viewer dial INDEPENDENTLY and present DIFFERENT tokens (the
//! agent's `ogr_` producer token vs. the viewer's `ogs_` stream token) but the SAME
//! channel key. The relay validates each side on its own merits and pairs by key.
//! The token verify ([`token`]) is the single place the Rust relay and the
//! TypeScript control plane must agree on the HMAC envelope; it mirrors
//! `packages/contracts`'s `signStreamToken`/`signRelayToken` byte-for-byte (proven
//! by the cross-stack fixture in `tests/cross_stack_token.rs`).

#![doc(html_root_url = "https://docs.rs/opengeni-relay")]

pub mod config;
pub mod error;
pub mod metrics;
pub mod rate_limit;
pub mod registry;
pub mod ring;
pub mod server;
pub mod token;

pub use config::RelayConfig;
pub use error::{RelayError, RelayResult};
pub use metrics::RelayMetrics;
pub use registry::ChannelRegistry;
pub use server::serve;
