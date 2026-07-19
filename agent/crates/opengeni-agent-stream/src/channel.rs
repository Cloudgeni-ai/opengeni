//! A relay stream channel: keyed by `{workspaceId, agentId, port}`, authorized by
//! a scoped `ogs_` token, auto-reconnecting + resuming on a relay blip.
//!
//! A [`RelayChannel`] is the agent's end of one logical stream (a PTY or a desktop
//! framebuffer). It owns the [`StreamChannel`] descriptor + the scoped token, and
//! the registration handshake against the relay:
//!
//! 1. **Register**: send a [`StreamOpen`] with `role = AGENT`, the channel key, the
//!    `ogs_` token, and `resume_from_seq` (the next sequence to send). The relay
//!    validates the token's authenticity + the lease/active-epoch fence, then
//!    replies [`StreamOpenAck`] with the sequence the peer will resume from.
//! 2. **Reconnect + resume** (§10.6): on a transport drop the channel re-dials the
//!    relay and re-registers against the SAME key, presenting `resume_from_seq` so
//!    the peer replays from there — a relay pod death is invisible. Re-registration
//!    uses full-jitter backoff (shared with the supervisor) so a relay blip never
//!    triggers a reconnect storm.
//!
//! The channel itself is transport-agnostic ([`RelayTransport`]); the pumps drive
//! the registered transport.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use opengeni_agent_proto::v1::{self, StreamChannel, StreamOpen, StreamRole};

use crate::codec::RelayMessage;
use crate::error::{StreamError, StreamResult};
use crate::transport::{self, RelayTransport};

/// The routing key for a relay channel: `{workspaceId, agentId, port}`. The relay
/// routes a viewer's attach to the agent registration carrying the same key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChannelKey {
    /// The workspace the channel belongs to (NATS Account / token scope).
    pub workspace_id: String,
    /// The agent (machine) producing the stream.
    pub agent_id: String,
    /// The logical port the channel maps to (so `resolveExposedPort` addresses it).
    pub port: u32,
}

impl ChannelKey {
    /// The channel-key query the relay routes by, appended to the relay dial URL
    /// (`ws=<workspace>&agent=<agent>&port=<port>`). M8b's relay parses this to
    /// pair an agent registration with a viewer attach.
    #[must_use]
    pub fn query(&self) -> String {
        format!(
            "ws={}&agent={}&port={}",
            self.workspace_id, self.agent_id, self.port
        )
    }
}

/// The rotatable relay endpoint/token pair. It is always shared through
/// [`SharedRelayCredentials`], whose `Debug` implementation never exposes it.
#[derive(Clone)]
struct RelayCredentials {
    token: String,
    relay_url: String,
}

/// Redacted shared credentials read at every channel registration and
/// re-registration. A short synchronous clone avoids holding a lock across await.
#[derive(Clone)]
pub(crate) struct SharedRelayCredentials {
    inner: Arc<RwLock<RelayCredentials>>,
}

impl SharedRelayCredentials {
    pub(crate) fn new(token: String, relay_url: String) -> Self {
        Self {
            inner: Arc::new(RwLock::new(RelayCredentials { token, relay_url })),
        }
    }

    fn snapshot(&self) -> RelayCredentials {
        self.inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn update(&self, token: String, relay_url: String) {
        *self
            .inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            RelayCredentials { token, relay_url };
    }
}

impl std::fmt::Debug for SharedRelayCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedRelayCredentials")
            .finish_non_exhaustive()
    }
}

/// Configuration to establish + maintain one relay channel.
#[derive(Clone)]
pub struct ChannelConfig {
    /// The channel descriptor (id, key, kind, port) sent in the [`StreamOpen`].
    pub channel: StreamChannel,
    /// The current token + URL source. Every (re)registration snapshots it anew.
    credentials: SharedRelayCredentials,
}

impl ChannelConfig {
    /// Builds a standalone channel configuration over a rotatable credential
    /// source. Tests and non-hub callers use this convenience constructor.
    #[must_use]
    pub fn new(channel: StreamChannel, token: String, relay_url: String) -> Self {
        Self {
            channel,
            credentials: SharedRelayCredentials::new(token, relay_url),
        }
    }

    pub(crate) fn with_shared_credentials(
        channel: StreamChannel,
        credentials: SharedRelayCredentials,
    ) -> Self {
        Self {
            channel,
            credentials,
        }
    }

    /// The channel key derived from the descriptor.
    #[must_use]
    pub fn key(&self) -> ChannelKey {
        ChannelKey {
            workspace_id: self.channel.workspace_id.clone(),
            agent_id: self.channel.agent_id.clone(),
            port: self.channel.port,
        }
    }

    /// The full relay dial URL for this channel (`relay_url` + the routing query).
    #[must_use]
    pub fn dial_url(&self) -> String {
        let endpoint = self.credentials.snapshot();
        self.dial_url_for(&endpoint)
    }

    fn dial_url_for(&self, endpoint: &RelayCredentials) -> String {
        let sep = if endpoint.relay_url.contains('?') {
            '&'
        } else {
            '?'
        };
        format!("{}{}{}", endpoint.relay_url, sep, self.key().query())
    }
}

impl std::fmt::Debug for ChannelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelConfig")
            .field("channel", &self.channel)
            .field("credentials", &self.credentials)
            .finish()
    }
}

/// A registered relay channel: the live transport plus the channel config and the
/// resume cursor. The pumps borrow `transport` to send/receive frames; on a drop
/// the owner calls [`RelayChannel::reconnect`] to re-establish + resume.
pub struct RelayChannel {
    config: ChannelConfig,
    transport: Box<dyn RelayTransport>,
    /// The next per-direction sequence the agent will send (its resume cursor).
    next_seq: u64,
}

impl std::fmt::Debug for RelayChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The boxed transport is not Debug; surface the key + cursor (never the
        // token).
        f.debug_struct("RelayChannel")
            .field("channel_id", &self.config.channel.channel_id)
            .field("key", &self.config.key())
            .field("kind", &self.config.channel.kind())
            .field("next_seq", &self.next_seq)
            .finish_non_exhaustive()
    }
}

impl RelayChannel {
    /// Dials the relay and registers this channel (the agent end), returning once
    /// the relay accepts the [`StreamOpen`]. `resume_from_seq` is 0 for a fresh
    /// channel.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] if the relay cannot be dialed,
    /// [`StreamError::OpenRejected`] if the relay rejects the open (bad token /
    /// failed fence).
    pub async fn register(config: ChannelConfig) -> StreamResult<Self> {
        Self::register_from(config, 0).await
    }

    /// Registers (or re-registers) presenting an explicit `resume_from_seq`.
    async fn register_from(config: ChannelConfig, resume_from_seq: u64) -> StreamResult<Self> {
        let endpoint = config.credentials.snapshot();
        let transport = transport::dial(&config.dial_url_for(&endpoint)).await?;
        Self::open_on_with_credentials(transport, config, endpoint, resume_from_seq).await
    }

    /// Performs the registration handshake over an already-dialed `transport`:
    /// sends the [`StreamOpen`] (role AGENT, the channel key, the token,
    /// `resume_from_seq`), then awaits the relay's [`StreamOpenAck`]. Factored out
    /// of [`register_from`] so the handshake — the M8b relay contract — is testable
    /// against an in-process mock relay double.
    #[cfg(any(test, feature = "test-support"))]
    async fn open_on(
        transport: Box<dyn RelayTransport>,
        config: ChannelConfig,
        resume_from_seq: u64,
    ) -> StreamResult<Self> {
        let endpoint = config.credentials.snapshot();
        Self::open_on_with_credentials(transport, config, endpoint, resume_from_seq).await
    }

    async fn open_on_with_credentials(
        mut transport: Box<dyn RelayTransport>,
        config: ChannelConfig,
        endpoint: RelayCredentials,
        resume_from_seq: u64,
    ) -> StreamResult<Self> {
        let open = RelayMessage::Open(StreamOpen {
            channel: Some(config.channel.clone()),
            token: endpoint.token,
            role: StreamRole::Agent as i32,
            resume_from_seq,
        });
        transport.send(&open).await?;

        // Await the relay's ack (the first inbound message).
        match transport.recv().await? {
            Some(RelayMessage::OpenAck(ack)) if ack.accepted => Ok(Self {
                config,
                transport,
                next_seq: ack.resume_from_seq.max(resume_from_seq),
            }),
            Some(RelayMessage::OpenAck(ack)) => Err(StreamError::OpenRejected(
                ack.error
                    .map_or_else(|| "rejected".to_string(), |e| e.message),
            )),
            Some(other) => Err(StreamError::Protocol(format!(
                "expected StreamOpenAck, got {:?}",
                other.tag()
            ))),
            None => Err(StreamError::Transport(
                "relay closed before ack".to_string(),
            )),
        }
    }

    /// Test/relay-double seam: run the registration handshake over an injected
    /// transport (e.g. a [`MockTransport`](crate::transport::mock::MockTransport))
    /// rather than dialing a real relay URL.
    ///
    /// # Errors
    ///
    /// Same as [`register`](Self::register): [`StreamError::OpenRejected`] /
    /// [`StreamError::Protocol`] / [`StreamError::Transport`] from the handshake.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn register_on(
        transport: Box<dyn RelayTransport>,
        config: ChannelConfig,
        resume_from_seq: u64,
    ) -> StreamResult<Self> {
        Self::open_on(transport, config, resume_from_seq).await
    }

    /// Re-establishes the channel after a transport drop, resuming from the current
    /// send cursor. Applies a full-jitter backoff delay BEFORE redialing so a relay
    /// blip never triggers a reconnect storm (§10.6/§19).
    ///
    /// # Errors
    ///
    /// Propagates the registration error; a transport error is retryable (the
    /// caller loops), a rejected open is terminal.
    pub async fn reconnect(&mut self, backoff_delay: Duration) -> StreamResult<()> {
        tokio::time::sleep(backoff_delay).await;
        let resumed = Self::register_from(self.config.clone(), self.next_seq).await?;
        self.transport = resumed.transport;
        // Adopt the relay's resume point but never rewind below what we have sent.
        self.next_seq = resumed.next_seq.max(self.next_seq);
        Ok(())
    }

    /// The channel descriptor.
    #[must_use]
    pub fn channel(&self) -> &StreamChannel {
        &self.config.channel
    }

    /// The channel id (for frame addressing).
    #[must_use]
    pub fn channel_id(&self) -> &str {
        &self.config.channel.channel_id
    }

    /// The channel's stream kind (PTY or DESKTOP).
    #[must_use]
    pub fn kind(&self) -> v1::StreamKind {
        self.config.channel.kind()
    }

    /// The next per-direction sequence the agent will send — its resume cursor. A
    /// reconnect presents this as `resume_from_seq` so the relay replays from here.
    #[must_use]
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Sends a data frame, stamping the next sequence + a produced-at time. Advances
    /// the resume cursor on success.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] on a send failure (the caller reconnects).
    pub async fn send_frame(&mut self, data: bytes::Bytes) -> StreamResult<u64> {
        let seq = self.next_seq;
        let frame = RelayMessage::Frame(v1::StreamFrame {
            channel_id: self.config.channel.channel_id.clone(),
            seq,
            // `bytes::Bytes` and prost's re-exported `bytes::Bytes` are the same type.
            data,
            produced_at_ms: now_ms(),
        });
        self.transport.send(&frame).await?;
        self.next_seq = self.next_seq.wrapping_add(1);
        Ok(seq)
    }

    /// Receives the next inbound relay message (a client→agent frame or input).
    /// `Ok(None)` on a clean close.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] on a drop, [`StreamError::Protocol`] on a bad
    /// datagram.
    pub async fn recv(&mut self) -> StreamResult<Option<RelayMessage>> {
        self.transport.recv().await
    }

    /// Sends a [`StreamClose`] then closes the transport (a clean channel teardown).
    pub async fn close(&mut self, reason: v1::StreamCloseReason, message: &str) {
        let close = RelayMessage::Close(v1::StreamClose {
            channel_id: self.config.channel.channel_id.clone(),
            reason: reason as i32,
            message: message.to_string(),
        });
        let _ = self.transport.send(&close).await;
        self.transport.close().await;
    }

    /// Replaces the transport (test seam: inject a [`MockTransport`] without a real
    /// relay dial).
    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn with_transport(config: ChannelConfig, transport: Box<dyn RelayTransport>) -> Self {
        Self {
            config,
            transport,
            next_seq: 0,
        }
    }
}

/// Current unix-epoch milliseconds, saturated.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ChannelConfig {
        ChannelConfig::new(
            StreamChannel {
                channel_id: "ch-1".to_string(),
                workspace_id: "ws-1".to_string(),
                agent_id: "ag-1".to_string(),
                kind: v1::StreamKind::Pty as i32,
                port: 7681,
            },
            "ogs_secret".to_string(),
            "wss://relay.example/stream".to_string(),
        )
    }

    #[test]
    fn channel_key_query_is_routable() {
        let key = config().key();
        assert_eq!(key.query(), "ws=ws-1&agent=ag-1&port=7681");
        assert_eq!(key.workspace_id, "ws-1");
        assert_eq!(key.port, 7681);
    }

    #[test]
    fn dial_url_appends_the_routing_query() {
        assert_eq!(
            config().dial_url(),
            "wss://relay.example/stream?ws=ws-1&agent=ag-1&port=7681"
        );
        // A relay_url that already has a query gets an `&` separator.
        let c = ChannelConfig::new(
            config().channel,
            "ogs_secret".to_string(),
            "wss://relay.example/stream?x=1".to_string(),
        );
        assert_eq!(
            c.dial_url(),
            "wss://relay.example/stream?x=1&ws=ws-1&agent=ag-1&port=7681"
        );
    }

    #[test]
    fn shared_credentials_are_resolved_for_every_registration() {
        let credentials = SharedRelayCredentials::new(
            "old-token".to_string(),
            "wss://old.example/stream".to_string(),
        );
        let config = ChannelConfig::with_shared_credentials(config().channel, credentials.clone());

        let first = config.credentials.snapshot();
        assert_eq!(first.token, "old-token");
        assert_eq!(
            config.dial_url_for(&first),
            "wss://old.example/stream?ws=ws-1&agent=ag-1&port=7681"
        );

        credentials.update(
            "rotated-token".to_string(),
            "wss://new.example/stream".to_string(),
        );
        let rotated = config.credentials.snapshot();
        assert_eq!(rotated.token, "rotated-token");
        assert_eq!(
            config.dial_url_for(&rotated),
            "wss://new.example/stream?ws=ws-1&agent=ag-1&port=7681"
        );
    }

    use crate::transport::mock::MockTransport;
    // `RelayTransport` (for `.send`/`.recv` on the mock) is in scope via `super::*`.

    /// The result of one relay-double handshake: the observed channel id +
    /// resume cursor, plus the still-open relay transport so the caller can keep it
    /// alive (sending frames after the handshake needs the relay end to outlive it).
    struct DoubleResult {
        channel_id: String,
        resume_from_seq: u64,
        relay_side: MockTransport,
    }

    /// A minimal in-process relay double: it accepts the agent's StreamOpen
    /// (asserting the key/token/role match the M8b contract) and replies a
    /// StreamOpenAck resuming from `resume_from_seq`. Returns the still-open relay
    /// transport so the caller controls its lifetime.
    async fn relay_double(mut relay_side: MockTransport, accept: bool) -> Option<DoubleResult> {
        // First message MUST be a StreamOpen from the AGENT role.
        match relay_side.recv().await {
            Ok(Some(RelayMessage::Open(open))) => {
                let channel = open.channel.expect("open carries a channel key");
                // The relay validates the channel key + the token presence + role.
                assert_eq!(open.role, StreamRole::Agent as i32);
                assert!(!open.token.is_empty(), "agent must present a token");
                let ack = if accept {
                    RelayMessage::OpenAck(v1::StreamOpenAck {
                        accepted: true,
                        error: None,
                        // The relay tells the agent the seq to resume sending from.
                        resume_from_seq: open.resume_from_seq,
                    })
                } else {
                    RelayMessage::OpenAck(v1::StreamOpenAck {
                        accepted: false,
                        error: Some(v1::AgentError {
                            code: v1::ErrorCode::AgentOffline as i32,
                            message: "bad token".to_string(),
                            retryable: false,
                            detail: std::collections::HashMap::new(),
                        }),
                        resume_from_seq: 0,
                    })
                };
                relay_side.send(&ack).await.expect("ack");
                Some(DoubleResult {
                    channel_id: channel.channel_id,
                    resume_from_seq: open.resume_from_seq,
                    relay_side,
                })
            }
            other => panic!("expected a StreamOpen first, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_handshake_accepts_against_the_relay_double() {
        // The agent registers; the relay double validates the open + acks. The
        // channel comes back live and addressing the right id.
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));

        let channel = RelayChannel::register_on(Box::new(agent_side), config(), 0)
            .await
            .expect("register accepted");
        assert_eq!(channel.channel_id(), "ch-1");
        assert_eq!(channel.kind(), v1::StreamKind::Pty);

        let result = relay.await.expect("relay task").expect("open seen");
        assert_eq!(result.channel_id, "ch-1");
        assert_eq!(
            result.resume_from_seq, 0,
            "a fresh registration resumes from 0"
        );
    }

    #[tokio::test]
    async fn register_handshake_surfaces_a_rejected_open() {
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, false));

        let err = RelayChannel::register_on(Box::new(agent_side), config(), 0)
            .await
            .expect_err("a rejected open must error");
        assert!(matches!(err, StreamError::OpenRejected(_)));
        assert!(
            !err.retryable(),
            "a rejected open is terminal, not retryable"
        );
        let _ = relay.await;
    }

    #[tokio::test]
    async fn frames_advance_the_resume_cursor_and_reconnect_resumes_from_it() {
        // Register, send two frames (seq 0,1), then simulate a relay blip by
        // re-registering on a fresh transport presenting the resume cursor. The
        // relay double sees the resume_from_seq the agent had reached — proving the
        // resume-from-seq contract (§10.6).
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));
        let mut channel = RelayChannel::register_on(Box::new(agent_side), config(), 0)
            .await
            .expect("register");
        // Keep the relay end ALIVE (held in `_relay1`) so the agent's frame sends
        // have a live peer — dropping it would surface as a transport error.
        let mut first = relay.await.expect("relay task").expect("open seen");

        // Send two frames; the cursor advances 0 -> 1 -> 2. Drain them on the relay
        // side so the unbounded mock channel does not grow unbounded.
        assert_eq!(
            channel
                .send_frame(bytes::Bytes::from_static(b"a"))
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            channel
                .send_frame(bytes::Bytes::from_static(b"b"))
                .await
                .unwrap(),
            1
        );
        // The relay observes both frames in order.
        assert!(matches!(
            first.relay_side.recv().await,
            Ok(Some(RelayMessage::Frame(f))) if f.seq == 0
        ));
        assert!(matches!(
            first.relay_side.recv().await,
            Ok(Some(RelayMessage::Frame(f))) if f.seq == 1
        ));

        // Simulate a relay blip: re-register on a NEW transport. The relay double on
        // the new link must observe resume_from_seq == 2 (the next seq to send).
        let (new_agent, new_relay) = MockTransport::pair();
        let relay2 = tokio::spawn(relay_double(new_relay, true));
        let resumed = RelayChannel::register_on(Box::new(new_agent), config(), channel.next_seq())
            .await
            .expect("resume register");
        let second = relay2.await.expect("relay2").expect("open");
        assert_eq!(
            second.resume_from_seq, 2,
            "reconnect must resume from the send cursor"
        );
        // The resumed channel continues from the cursor, not from 0.
        assert_eq!(resumed.next_seq(), 2);
        // Keep both relay ends alive to end-of-test (explicit, documents intent).
        drop(first.relay_side);
        drop(second.relay_side);
    }
}
