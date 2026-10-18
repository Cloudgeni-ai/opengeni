//! A relay stream channel: keyed by `{workspaceId, agentId, port, channelId}`, authorized by
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

use std::time::Duration;

use opengeni_agent_proto::v1::{self, StreamChannel, StreamOpen, StreamRole};

use crate::activity::ActivityStamp;
use crate::codec::RelayMessage;
use crate::credential::RelayCredential;
use crate::error::{StreamError, StreamResult};
use crate::transport::{self, RelayTransport};

/// The routing key for a relay channel: `{workspaceId, agentId, port, channelId}`. The relay
/// routes a viewer's attach to the agent registration carrying the same key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChannelKey {
    /// The workspace the channel belongs to (NATS Account / token scope).
    pub workspace_id: String,
    /// The agent (machine) producing the stream.
    pub agent_id: String,
    /// The logical port the channel maps to (so `resolveExposedPort` addresses it).
    pub port: u32,
    /// The logical stream instance. Multiple PTYs/desktops may share one machine
    /// and logical port without replacing each other.
    pub channel_id: String,
}

impl ChannelKey {
    /// The channel-key query the relay routes by, appended to the relay dial URL
    /// (`ws=<workspace>&agent=<agent>&port=<port>&channel=<channel>`). The relay parses this to
    /// pair an agent registration with a viewer attach.
    #[must_use]
    pub fn query(&self) -> String {
        format!(
            "ws={}&agent={}&port={}&channel={}",
            self.workspace_id, self.agent_id, self.port, self.channel_id
        )
    }
}

/// Configuration to establish + maintain one relay channel.
#[derive(Debug, Clone)]
pub struct ChannelConfig {
    /// The channel descriptor (id, key, kind, port) sent in the [`StreamOpen`].
    pub channel: StreamChannel,
    /// The relay address and producer token. Every (re)registration presents
    /// the credential current at that moment; the relay validates it. Its
    /// token is never logged.
    pub credential: RelayCredential,
    /// Where the channel records its traffic for the agent's idle report.
    pub activity: ActivityStamp,
}

impl ChannelConfig {
    /// The channel key derived from the descriptor.
    #[must_use]
    pub fn key(&self) -> ChannelKey {
        ChannelKey {
            workspace_id: self.channel.workspace_id.clone(),
            agent_id: self.channel.agent_id.clone(),
            port: self.channel.port,
            channel_id: self.channel.channel_id.clone(),
        }
    }

    /// The full relay dial URL for this channel: the relay base URL
    /// (`wss://relay…`) and the routing query.
    #[must_use]
    pub fn dial_url(&self, relay_url: &str) -> String {
        let sep = if relay_url.contains('?') { '&' } else { '?' };
        format!("{relay_url}{sep}{}", self.key().query())
    }
}

/// A registered relay channel: the live transport plus the channel config and the
/// resume cursor. The pumps borrow `transport` to send/receive frames; on a drop
/// the owner calls [`RelayChannel::reconnect`] to re-establish + resume.
pub struct RelayChannel {
    config: ChannelConfig,
    transport: Box<dyn RelayTransport>,
    /// The next sequence the agent will stamp on an outbound frame.
    send_next_seq: u64,
    /// The next peer frame sequence the agent has not processed yet. This is the
    /// cursor presented on reconnect so the relay replays the opposite direction.
    recv_next_seq: u64,
    #[cfg(any(test, feature = "test-support"))]
    reconnect_transports: std::collections::VecDeque<Box<dyn RelayTransport>>,
}

impl std::fmt::Debug for RelayChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The boxed transport is not Debug; surface the key + cursor (never the
        // token).
        f.debug_struct("RelayChannel")
            .field("channel_id", &self.config.channel.channel_id)
            .field("key", &self.config.key())
            .field("kind", &self.config.channel.kind())
            .field("send_next_seq", &self.send_next_seq)
            .field("recv_next_seq", &self.recv_next_seq)
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
        Self::register_through(config, resume_from_seq, |url| async move {
            transport::dial(&url).await
        })
        .await
    }

    /// Dials through `dial` and registers. The relay checks the token when
    /// the open arrives, and a slow dial can outlast the credential chosen
    /// for it, so the open presents the credential current once the dial is
    /// up; it dials again only if the relay's address changed meanwhile.
    async fn register_through<F, D>(
        config: ChannelConfig,
        resume_from_seq: u64,
        mut dial: F,
    ) -> StreamResult<Self>
    where
        F: FnMut(String) -> D,
        D: std::future::Future<Output = StreamResult<Box<dyn RelayTransport>>>,
    {
        let mut url = config.credential.current().await?.url;
        loop {
            let transport = dial(config.dial_url(&url)).await?;
            let endpoint = config.credential.current().await?;
            if endpoint.url == url {
                return Self::open_on(transport, config, endpoint.token, resume_from_seq).await;
            }
            url = endpoint.url;
        }
    }

    /// Performs the registration handshake over an already-dialed `transport`:
    /// sends the [`StreamOpen`] (role AGENT, the channel key, the token,
    /// `resume_from_seq`), then awaits the relay's [`StreamOpenAck`]. Factored out
    /// of [`register_from`] so the handshake — the M8b relay contract — is testable
    /// against an in-process mock relay double.
    async fn open_on(
        mut transport: Box<dyn RelayTransport>,
        config: ChannelConfig,
        token: String,
        resume_from_seq: u64,
    ) -> StreamResult<Self> {
        let open = RelayMessage::Open(StreamOpen {
            channel: Some(config.channel.clone()),
            token,
            role: StreamRole::Agent as i32,
            resume_from_seq,
        });
        transport.send(&open).await?;

        // Await the relay's ack (the first inbound message).
        match transport.recv().await? {
            Some(RelayMessage::OpenAck(ack)) if ack.accepted => Ok(Self {
                config,
                transport,
                send_next_seq: 0,
                recv_next_seq: ack.resume_from_seq.max(resume_from_seq),
                #[cfg(any(test, feature = "test-support"))]
                reconnect_transports: std::collections::VecDeque::new(),
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
        let token = config.credential.current().await?.token;
        Self::open_on(transport, config, token, resume_from_seq).await
    }

    /// Re-establishes the channel after a transport drop, asking the relay to replay
    /// peer frames from the current receive cursor. The independent outbound cursor
    /// is preserved locally. Applies a full-jitter backoff delay BEFORE redialing so a relay
    /// blip never triggers a reconnect storm (§10.6/§19).
    ///
    /// # Errors
    ///
    /// Propagates the registration error; a transport error is retryable (the
    /// caller loops), a rejected open is terminal.
    pub async fn reconnect(&mut self, backoff_delay: Duration) -> StreamResult<()> {
        tokio::time::sleep(backoff_delay).await;
        #[cfg(any(test, feature = "test-support"))]
        if let Some(transport) = self.reconnect_transports.pop_front() {
            return self.reconnect_on(transport).await;
        }
        let resumed = Self::register_from(self.config.clone(), self.recv_next_seq).await?;
        self.transport = resumed.transport;
        // The ack is the peer replay cursor, never the agent's outbound sequence.
        self.recv_next_seq = resumed.recv_next_seq.max(self.recv_next_seq);
        Ok(())
    }

    /// Test seam for the same reconnect/adoption logic over an injected transport.
    ///
    /// # Errors
    ///
    /// Returns the typed registration, protocol, or transport error produced by
    /// opening the replacement channel.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn reconnect_on(&mut self, transport: Box<dyn RelayTransport>) -> StreamResult<()> {
        let token = self.config.credential.current().await?.token;
        let resumed =
            Self::open_on(transport, self.config.clone(), token, self.recv_next_seq).await?;
        self.transport = resumed.transport;
        self.recv_next_seq = resumed.recv_next_seq.max(self.recv_next_seq);
        Ok(())
    }

    /// Queues an injected transport for the next reconnect (test-only).
    #[cfg(any(test, feature = "test-support"))]
    pub fn queue_reconnect_transport(&mut self, transport: Box<dyn RelayTransport>) {
        self.reconnect_transports.push_back(transport);
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

    /// The next sequence the agent will stamp on an outbound frame.
    #[must_use]
    pub fn next_seq(&self) -> u64 {
        self.send_next_seq
    }

    /// The next peer sequence not yet processed. This is the reconnect replay cursor.
    #[must_use]
    pub fn resume_from_seq(&self) -> u64 {
        self.recv_next_seq
    }

    /// Sends a data frame, stamping the next sequence + a produced-at time. Advances
    /// the resume cursor on success.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] on a send failure (the caller reconnects).
    pub async fn send_frame(&mut self, data: bytes::Bytes) -> StreamResult<u64> {
        let seq = self.send_next_seq;
        let frame = RelayMessage::Frame(v1::StreamFrame {
            channel_id: self.config.channel.channel_id.clone(),
            seq,
            // `bytes::Bytes` and prost's re-exported `bytes::Bytes` are the same type.
            data,
            produced_at_ms: now_ms(),
        });
        self.transport.send(&frame).await?;
        self.send_next_seq = self.send_next_seq.wrapping_add(1);
        // A desktop pump captures at a fixed rate whatever happens on screen,
        // so only what its viewer sends counts as use (see `activity`).
        if self.kind() != v1::StreamKind::Desktop {
            self.config.activity.touch();
        }
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
        loop {
            let message = self.transport.recv().await?;
            match message {
                Some(RelayMessage::Frame(frame)) if frame.seq < self.recv_next_seq => {
                    // A reconnect replay can overlap the last delivered frame. Never
                    // execute duplicate PTY input merely because transport recovered.
                }
                Some(RelayMessage::Frame(frame)) => {
                    self.recv_next_seq = frame.seq.wrapping_add(1);
                    self.config.activity.touch();
                    return Ok(Some(RelayMessage::Frame(frame)));
                }
                Some(RelayMessage::DesktopInput(input)) => {
                    self.config.activity.touch();
                    return Ok(Some(RelayMessage::DesktopInput(input)));
                }
                other => return Ok(other),
            }
        }
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
            send_next_seq: 0,
            recv_next_seq: 0,
            reconnect_transports: std::collections::VecDeque::new(),
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
        ChannelConfig {
            channel: StreamChannel {
                channel_id: "ch-1".to_string(),
                workspace_id: "ws-1".to_string(),
                agent_id: "ag-1".to_string(),
                kind: v1::StreamKind::Pty as i32,
                port: 7681,
            },
            credential: RelayCredential::fixed("wss://relay.example/stream", "ogs_secret"),
            activity: ActivityStamp::untracked(),
        }
    }

    #[test]
    fn channel_key_query_is_routable() {
        let key = config().key();
        assert_eq!(key.query(), "ws=ws-1&agent=ag-1&port=7681&channel=ch-1");
        assert_eq!(key.workspace_id, "ws-1");
        assert_eq!(key.port, 7681);
    }

    #[test]
    fn dial_url_appends_the_routing_query() {
        assert_eq!(
            config().dial_url("wss://relay.example/stream"),
            "wss://relay.example/stream?ws=ws-1&agent=ag-1&port=7681&channel=ch-1"
        );
        // A relay URL that already has a query gets an `&` separator.
        assert_eq!(
            config().dial_url("wss://relay.example/stream?x=1"),
            "wss://relay.example/stream?x=1&ws=ws-1&agent=ag-1&port=7681&channel=ch-1"
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
        token: String,
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
                    token: open.token,
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
    async fn directional_cursors_survive_reconnect_without_duplicate_input() {
        // Outbound PTY output and inbound PTY keystrokes have independent sequence
        // spaces. A reconnect must preserve the former while presenting the latter
        // as the relay replay cursor.
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

        let inbound = |seq, data: &'static [u8]| {
            RelayMessage::Frame(v1::StreamFrame {
                channel_id: "ch-1".to_string(),
                seq,
                data: bytes::Bytes::from_static(data),
                produced_at_ms: 0,
            })
        };
        first.relay_side.send(&inbound(0, b"x")).await.unwrap();
        assert!(matches!(
            channel.recv().await,
            Ok(Some(RelayMessage::Frame(f))) if f.seq == 0 && f.data == bytes::Bytes::from_static(b"x")
        ));
        // An overlapping replay is discarded; the next unseen input is delivered.
        first
            .relay_side
            .send(&inbound(0, b"duplicate"))
            .await
            .unwrap();
        first.relay_side.send(&inbound(1, b"y")).await.unwrap();
        assert!(matches!(
            channel.recv().await,
            Ok(Some(RelayMessage::Frame(f))) if f.seq == 1 && f.data == bytes::Bytes::from_static(b"y")
        ));
        assert_eq!(channel.resume_from_seq(), 2);

        // Simulate a relay blip on a NEW transport. The new open presents the
        // inbound cursor (2), while outbound output also independently remains 2.
        let (new_agent, new_relay) = MockTransport::pair();
        let relay2 = tokio::spawn(relay_double(new_relay, true));
        channel
            .reconnect_on(Box::new(new_agent))
            .await
            .expect("resume register");
        let second = relay2.await.expect("relay2").expect("open");
        assert_eq!(
            second.resume_from_seq, 2,
            "reconnect must resume peer input from the receive cursor"
        );
        assert_eq!(channel.next_seq(), 2);
        assert_eq!(
            channel
                .send_frame(bytes::Bytes::from_static(b"c"))
                .await
                .unwrap(),
            2,
            "outbound cursor must not rewind during inbound replay negotiation"
        );
        // Keep both relay ends alive to end-of-test (explicit, documents intent).
        drop(first.relay_side);
        drop(second.relay_side);
    }

    #[tokio::test]
    async fn a_reconnect_presents_the_credential_current_then() {
        // A fabric agent's producer token is replaced before it expires; a
        // stream registered with the old one must present the new one when it
        // reconnects.
        let credential = RelayCredential::fixed("wss://relay.example/stream", "ogr_first");
        let channel_config = ChannelConfig {
            credential: credential.clone(),
            ..config()
        };
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));
        let mut channel = RelayChannel::register_on(Box::new(agent_side), channel_config, 0)
            .await
            .expect("register");
        let first = relay.await.expect("relay").expect("open");
        assert_eq!(first.token, "ogr_first");

        credential.set(crate::credential::RelayEndpoint {
            url: "wss://relay.example/stream".to_string(),
            token: "ogr_second".to_string(),
            expires_at_ms: None,
        });
        let (new_agent, new_relay) = MockTransport::pair();
        let relay2 = tokio::spawn(relay_double(new_relay, true));
        channel
            .reconnect_on(Box::new(new_agent))
            .await
            .expect("reconnect");
        let second = relay2.await.expect("relay2").expect("open");
        assert_eq!(second.token, "ogr_second");
        drop(first.relay_side);
        drop(second.relay_side);
    }

    fn relay_endpoint(
        url: &str,
        token: &str,
        expires_at_ms: Option<u64>,
    ) -> crate::credential::RelayEndpoint {
        crate::credential::RelayEndpoint {
            url: url.to_string(),
            token: token.to_string(),
            expires_at_ms,
        }
    }

    /// A registration presents the credential current once its dial is up:
    /// one replaced during the dial, and one that expired during it and was
    /// renewed after.
    #[tokio::test]
    async fn a_registration_presents_the_credential_current_once_its_dial_is_up() {
        const RELAY: &str = "wss://relay.example/stream";

        let credential = RelayCredential::fixed(RELAY, "ogr_first");
        let channel_config = ChannelConfig {
            credential: credential.clone(),
            ..config()
        };
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));
        let mut agent_side = Some(agent_side);
        let channel = RelayChannel::register_through(channel_config, 0, |_url| {
            credential.set(relay_endpoint(RELAY, "ogr_second", None));
            let transport: Box<dyn RelayTransport> = Box::new(agent_side.take().expect("one dial"));
            async move { Ok(transport) }
        })
        .await
        .expect("register");
        let opened = relay.await.expect("relay").expect("open");
        assert_eq!(
            opened.token, "ogr_second",
            "the credential replaced during the dial"
        );
        drop(channel);
        drop(opened.relay_side);

        let now_ms = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        // Usable for 300 ms, past the expiry margin: it lapses mid-dial.
        let credential = RelayCredential::pending();
        credential.set(relay_endpoint(RELAY, "ogr_first", Some(now_ms + 2_300)));
        let channel_config = ChannelConfig {
            credential: credential.clone(),
            ..config()
        };
        let renew = credential.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            renew.set(relay_endpoint(RELAY, "ogr_renewed", Some(now_ms + 600_000)));
        });
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));
        let mut agent_side = Some(agent_side);
        let channel = RelayChannel::register_through(channel_config, 0, |_url| {
            let transport: Box<dyn RelayTransport> = Box::new(agent_side.take().expect("one dial"));
            async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                Ok(transport)
            }
        })
        .await
        .expect("a credential that lapses during the dial is not fatal");
        let opened = relay.await.expect("relay").expect("open");
        assert_eq!(opened.token, "ogr_renewed");
        drop(channel);
        drop(opened.relay_side);
    }

    /// A relay address that changes during a dial is dialed afresh.
    #[tokio::test]
    async fn a_registration_redials_when_the_relay_moves_during_its_dial() {
        let credential = RelayCredential::fixed("wss://relay-1.example/stream", "ogr_first");
        let channel_config = ChannelConfig {
            credential: credential.clone(),
            ..config()
        };
        let (stale_agent, _stale_relay) = MockTransport::pair();
        let (agent_side, relay_side) = MockTransport::pair();
        let relay = tokio::spawn(relay_double(relay_side, true));
        let mut sides = vec![agent_side, stale_agent];
        let mut dialed = Vec::new();
        let channel = RelayChannel::register_through(channel_config.clone(), 0, |url| {
            if dialed.is_empty() {
                credential.set(relay_endpoint(
                    "wss://relay-2.example/stream",
                    "ogr_moved",
                    None,
                ));
            }
            dialed.push(url);
            let transport: Box<dyn RelayTransport> = Box::new(sides.pop().expect("a side"));
            async move { Ok(transport) }
        })
        .await
        .expect("register");
        assert_eq!(
            dialed,
            [
                channel_config.dial_url("wss://relay-1.example/stream"),
                channel_config.dial_url("wss://relay-2.example/stream"),
            ]
        );
        let opened = relay.await.expect("relay").expect("open");
        assert_eq!(opened.token, "ogr_moved");
        drop(channel);
        drop(opened.relay_side);
    }

    #[tokio::test]
    async fn traffic_marks_the_stream_moving_except_desktop_frames() {
        use crate::activity::StreamActivity;
        const SILENCE: Duration = Duration::from_secs(600);

        for (kind, output_counts) in [
            (v1::StreamKind::Pty, true),
            (v1::StreamKind::Browser, true),
            (v1::StreamKind::Desktop, false),
        ] {
            let activity = StreamActivity::new();
            let stamp = activity.track();
            let mut channel_config = config();
            channel_config.channel.kind = kind as i32;
            channel_config.activity = stamp.clone();
            let (agent_side, mut relay_side) = MockTransport::pair();
            let mut channel = RelayChannel::with_transport(channel_config, Box::new(agent_side));

            // Silence the stream, then let the agent send.
            stamp.set_silent_for_test();
            assert_eq!(activity.moving(SILENCE), 0);
            channel
                .send_frame(bytes::Bytes::from_static(b"out"))
                .await
                .expect("send");
            assert_eq!(
                activity.moving(SILENCE),
                usize::from(output_counts),
                "{kind:?} output"
            );

            // What a viewer sends always counts.
            stamp.set_silent_for_test();
            relay_side
                .send(&RelayMessage::Frame(v1::StreamFrame {
                    channel_id: "ch-1".to_string(),
                    seq: 0,
                    data: bytes::Bytes::from_static(b"in"),
                    produced_at_ms: 0,
                }))
                .await
                .expect("inbound");
            assert!(channel.recv().await.expect("recv").is_some());
            assert_eq!(activity.moving(SILENCE), 1, "{kind:?} input");

            stamp.set_silent_for_test();
            relay_side
                .send(&RelayMessage::DesktopInput(v1::DesktopInput::default()))
                .await
                .expect("input");
            assert!(channel.recv().await.expect("recv").is_some());
            assert_eq!(activity.moving(SILENCE), 1, "{kind:?} desktop input");
            drop(channel);
            drop(stamp);
            assert_eq!(activity.moving(SILENCE), 0, "{kind:?} closed");
        }
    }
}
