//! The relay transport seam: a duplex datagram channel to the relay edge.
//!
//! [`RelayTransport`] is the abstraction every channel + pump speaks: send a
//! tagged relay datagram, receive the next one. Two transports implement it:
//!
//! * **`wss`** ([`WssTransport`]) — the CONCRETE day-1 fallback over
//!   `tokio-tungstenite` (TLS WebSocket). Each [`RelayMessage`] is one WebSocket
//!   *binary* message (the framing in [`crate::codec`]).
//! * **QUIC / WebTransport** — the PREFERRED path (lower latency, native
//!   multiplexing). Structured behind this same trait + the `quic` cargo feature;
//!   the agent negotiates QUIC first and falls back to `wss` (dossier §10.1). The
//!   QUIC impl lands with the relay tier; the trait shape is fixed now so the
//!   channel/pump code is transport-agnostic.
//!
//! A [`MockTransport`] (test-only) drives the channel + pumps against an in-process
//! relay double without a socket.

use async_trait::async_trait;

use crate::codec::RelayMessage;
use crate::error::StreamResult;

/// A duplex datagram channel to the relay. Each call sends/receives exactly one
/// [`RelayMessage`]; framing is the transport's concern (a WebSocket binary
/// message, a QUIC datagram). Object-safe so a channel can hold a boxed transport
/// regardless of the concrete kind.
#[async_trait]
pub trait RelayTransport: Send {
    /// Sends one relay message.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] if the underlying socket errored / closed.
    async fn send(&mut self, msg: &RelayMessage) -> StreamResult<()>;

    /// Receives the next relay message, or `Ok(None)` on a clean close.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] on a socket error, [`StreamError::Protocol`] on
    /// an undecodable datagram.
    async fn recv(&mut self) -> StreamResult<Option<RelayMessage>>;

    /// Closes the transport (best-effort).
    async fn close(&mut self) {}
}

/// How to dial a relay: the kind of transport to prefer. The agent tries `Quic`
/// first (when the feature is built) and falls back to `Wss`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// QUIC / WebTransport — preferred (feature-gated).
    Quic,
    /// TLS WebSocket — the always-available fallback.
    Wss,
}

/// Dials the relay, preferring QUIC and falling back to `wss`. Returns the boxed
/// transport for the channel to register on.
///
/// `relay_ws_url` is the `wss://relay.../channel` URL the control plane mints
/// (resolveExposedPort), already carrying the channel-key query the relay routes
/// by. The QUIC dial (when built) derives its endpoint from the same base.
///
/// # Errors
///
/// [`StreamError::Transport`] if neither transport can be established.
pub async fn dial(relay_ws_url: &str) -> StreamResult<Box<dyn RelayTransport>> {
    #[cfg(feature = "quic")]
    {
        match quic::QuicTransport::dial(relay_ws_url).await {
            Ok(t) => return Ok(Box::new(t)),
            Err(e) => {
                tracing::warn!(error = %e, "QUIC relay dial failed; falling back to wss");
            }
        }
    }
    let wss = wss::WssTransport::dial(relay_ws_url).await?;
    Ok(Box::new(wss))
}

/// The TLS-WebSocket relay transport (the concrete fallback).
pub mod wss {
    use async_trait::async_trait;
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    use crate::codec::RelayMessage;
    use crate::error::{StreamError, StreamResult};

    use super::RelayTransport;

    type WsStream = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// A relay transport over a TLS WebSocket. Each [`RelayMessage`] is one binary
    /// WebSocket frame.
    pub struct WssTransport {
        socket: WsStream,
    }

    impl WssTransport {
        /// Dials `wss://…` and completes the WebSocket handshake.
        ///
        /// # Errors
        ///
        /// [`StreamError::Transport`] if the connection / handshake fails.
        pub async fn dial(url: &str) -> StreamResult<Self> {
            let (socket, _resp) = tokio_tungstenite::connect_async(url)
                .await
                .map_err(|e| StreamError::Transport(format!("wss connect {url}: {e}")))?;
            Ok(Self { socket })
        }

        /// Wraps an already-established WebSocket stream (used by the in-process
        /// test relay double, which pairs two ends without a real socket dial).
        #[must_use]
        pub fn from_stream(socket: WsStream) -> Self {
            Self { socket }
        }
    }

    #[async_trait]
    impl RelayTransport for WssTransport {
        async fn send(&mut self, msg: &RelayMessage) -> StreamResult<()> {
            self.socket
                .send(WsMessage::Binary(msg.encode()))
                .await
                .map_err(|e| StreamError::Transport(format!("wss send: {e}")))
        }

        async fn recv(&mut self) -> StreamResult<Option<RelayMessage>> {
            loop {
                match self.socket.next().await {
                    Some(Ok(WsMessage::Binary(bytes))) => {
                        return RelayMessage::decode(&bytes).map(Some);
                    }
                    Some(Ok(WsMessage::Close(_))) | None => return Ok(None),
                    // Ignore control/non-binary frames (ping/pong/text/raw); tungstenite
                    // answers pings itself, so we continue reading for the next binary.
                    Some(Ok(
                        WsMessage::Ping(_)
                        | WsMessage::Pong(_)
                        | WsMessage::Text(_)
                        | WsMessage::Frame(_),
                    )) => {}
                    Some(Err(e)) => {
                        return Err(StreamError::Transport(format!("wss recv: {e}")));
                    }
                }
            }
        }

        async fn close(&mut self) {
            let _ = self.socket.close(None).await;
        }
    }
}

/// The QUIC / WebTransport relay transport (preferred path). Structured behind the
/// `quic` feature; the dial + impl land with the relay tier (M8b). Kept compiled
/// out by default so the day-1 build needs only the `wss` dependency.
#[cfg(feature = "quic")]
pub mod quic {
    // Feature-gated QUIC stub: `dial` + the `RelayTransport` impl return errors until
    // the QUIC endpoint is wired. They are intentionally `async fn -> Result` for
    // signature parity with the `wss` path and the `async_trait` `RelayTransport`
    // contract, so they trip `unused_async` / `missing_errors_doc` until the real
    // implementation (with real awaits + failure modes) lands.
    #![allow(clippy::unused_async, clippy::missing_errors_doc)]
    use async_trait::async_trait;

    use crate::codec::RelayMessage;
    use crate::error::{StreamError, StreamResult};

    use super::RelayTransport;

    /// A relay transport over QUIC / WebTransport. Implemented in M8b alongside the
    /// relay tier; the shape mirrors [`super::wss::WssTransport`] so the channel +
    /// pumps are transport-agnostic.
    pub struct QuicTransport {
        _private: (),
    }

    impl QuicTransport {
        /// Dials the relay over QUIC. Returns an error today so [`super::dial`]
        /// falls back to `wss` until M8b wires the QUIC endpoint.
        #[allow(clippy::unused_async)] // stub: async for parity with WssTransport::dial; real impl awaits
        pub async fn dial(_url: &str) -> StreamResult<Self> {
            Err(StreamError::Transport(
                "QUIC relay transport is not yet implemented (M8b)".to_string(),
            ))
        }
    }

    #[async_trait]
    impl RelayTransport for QuicTransport {
        #[allow(clippy::unused_async)] // stub: async required by the trait; real impl awaits
        async fn send(&mut self, _msg: &RelayMessage) -> StreamResult<()> {
            Err(StreamError::Transport("QUIC transport stub".to_string()))
        }
        #[allow(clippy::unused_async)] // stub: async required by the trait; real impl awaits
        async fn recv(&mut self) -> StreamResult<Option<RelayMessage>> {
            Err(StreamError::Transport("QUIC transport stub".to_string()))
        }
    }
}

/// An in-process mock transport for tests: a pair of channels standing in for the
/// relay socket. Sends go to `tx`; receives come from `rx`. Pairing two
/// `MockTransport`s with crossed channels models the agent↔relay link without a
/// socket.
#[cfg(any(test, feature = "test-support"))]
pub mod mock {
    use async_trait::async_trait;
    use tokio::sync::mpsc;

    use crate::codec::RelayMessage;
    use crate::error::{StreamError, StreamResult};

    use super::RelayTransport;

    /// A mock relay transport over tokio mpsc channels.
    pub struct MockTransport {
        tx: mpsc::UnboundedSender<RelayMessage>,
        rx: mpsc::UnboundedReceiver<RelayMessage>,
    }

    impl MockTransport {
        /// Builds a connected pair `(a, b)` where `a.send` is `b.recv` and vice
        /// versa — an in-process duplex link modelling agent ↔ relay.
        #[must_use]
        pub fn pair() -> (Self, Self) {
            let (a_tx, b_rx) = mpsc::unbounded_channel();
            let (b_tx, a_rx) = mpsc::unbounded_channel();
            (Self { tx: a_tx, rx: a_rx }, Self { tx: b_tx, rx: b_rx })
        }
    }

    #[async_trait]
    impl RelayTransport for MockTransport {
        async fn send(&mut self, msg: &RelayMessage) -> StreamResult<()> {
            self.tx
                .send(msg.clone())
                .map_err(|_| StreamError::Transport("mock peer dropped".to_string()))
        }

        async fn recv(&mut self) -> StreamResult<Option<RelayMessage>> {
            Ok(self.rx.recv().await)
        }
    }
}
