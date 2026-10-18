//! Keeps one gateway's link: dials it with the host's token, waits for its
//! hello, then moves frames between it and the hub, pinging, until it goes;
//! then dials again after a back-off.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use compute_protocol::link::{GatewayFrame, SUBPROTOCOL, VERSION, decode};
use futures::{SinkExt as _, StreamExt as _};
use http::HeaderValue;
use http::header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL};
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::CancellationToken;

use crate::core::{Input, LinkId};
use crate::hub::{Command, HostToken, Timing, Tokens};

/// The largest message accepted from a gateway.
const MAX_MESSAGE: usize = 64 << 20;
/// A link up this long starts its next back-off from the shortest.
const STEADY: Duration = Duration::from_secs(30);

pub(crate) struct Keep {
    pub gateway: String,
    pub tokens: Arc<dyn Tokens>,
    pub tls: Arc<rustls::ClientConfig>,
    pub timing: Timing,
    pub hub: mpsc::WeakUnboundedSender<Command>,
    pub ids: Arc<AtomicU64>,
    pub cancel: CancellationToken,
}

#[derive(Debug, thiserror::Error)]
enum LinkError {
    #[error("no token: {0}")]
    Token(String),
    #[error("{0} is not a ws:// or wss:// URL")]
    Url(String),
    #[error("connecting timed out")]
    Timeout,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("the gateway chose no `{SUBPROTOCOL}` subprotocol")]
    Subprotocol,
    #[error("the gateway broke the protocol: {0}")]
    Protocol(String),
    #[error("the gateway was silent too long")]
    Silent,
    #[error("the gateway closed the link")]
    Closed,
}

/// Keeps the link until cancelled.
pub(crate) async fn keep(keep: Keep) {
    let mut backoff = keep.timing.backoff_min;
    let mut token: Option<(HostToken, u64)> = None;
    let mut seed = u64::from(std::process::id()) ^ now_ms();
    loop {
        if keep.cancel.is_cancelled() {
            return;
        }
        let started = Instant::now();
        // `once` ends by itself when cancelled, a link that is up closing
        // after the frames the hub sent before.
        match once(&keep, &mut token).await {
            Ok(()) => {}
            Err(LinkError::Closed) => {
                tracing::info!(gateway = %keep.gateway, "an agent link closed");
            }
            Err(error) => {
                tracing::warn!(gateway = %keep.gateway, %error, "an agent link failed");
            }
        }
        if started.elapsed() >= STEADY {
            backoff = keep.timing.backoff_min;
        }
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let ceiling = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX);
        let wait = Duration::from_millis(seed % (ceiling + 1));
        tokio::select! {
            () = keep.cancel.cancelled() => return,
            () = tokio::time::sleep(wait) => {}
        }
        backoff = (backoff * 2).min(keep.timing.backoff_max);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// A token with more than a third of its life left, fetching one if need
/// be. `cached` holds the token and when it was fetched.
async fn token(keep: &Keep, cached: &mut Option<(HostToken, u64)>) -> Result<String, LinkError> {
    let now = now_ms();
    if let Some((token, fetched)) = cached.as_ref() {
        let life = token.expires_at_ms.saturating_sub(*fetched);
        if token.expires_at_ms.saturating_sub(now) > life / 3 {
            return Ok(token.token.clone());
        }
    }
    let token = keep
        .tokens
        .token(&keep.gateway)
        .await
        .map_err(LinkError::Token)?;
    let value = token.token.clone();
    *cached = Some((token, now));
    Ok(value)
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Dials the gateway, then serves the link until it goes.
async fn once(keep: &Keep, cached: &mut Option<(HostToken, u64)>) -> Result<(), LinkError> {
    let opening = async {
        let token = token(keep, cached).await?;
        let mut socket = tokio::time::timeout(keep.timing.connect_timeout, dial(keep, &token))
            .await
            .map_err(|_| LinkError::Timeout)??;
        let hello = tokio::time::timeout(keep.timing.connect_timeout, socket.next())
            .await
            .map_err(|_| LinkError::Timeout)?
            .ok_or(LinkError::Closed)??;
        Ok::<_, LinkError>((socket, hello))
    };
    let (socket, hello) = tokio::select! {
        () = keep.cancel.cancelled() => return Ok(()),
        opened = opening => opened?,
    };
    let max_payload = match hello {
        Message::Binary(bytes) => match decode::<GatewayFrame>(&bytes) {
            Ok((
                GatewayFrame::Hello {
                    version,
                    max_payload,
                },
                _,
            )) if version == VERSION => max_payload,
            Ok((GatewayFrame::Hello { version, .. }, _)) => {
                return Err(LinkError::Protocol(format!("version {version}")));
            }
            Ok(_) => return Err(LinkError::Protocol("no hello first".into())),
            Err(error) => return Err(LinkError::Protocol(error.to_string())),
        },
        _ => return Err(LinkError::Protocol("no hello first".into())),
    };
    let Some(hub) = keep.hub.upgrade() else {
        return Ok(());
    };
    let link = keep.ids.fetch_add(1, Ordering::Relaxed);
    let (writer, outgoing) = mpsc::unbounded_channel();
    if hub
        .send(Command::LinkUp {
            gateway: keep.gateway.clone(),
            link,
            max_payload,
            writer,
        })
        .is_err()
    {
        return Ok(());
    }
    tracing::info!(gateway = %keep.gateway, link, "an agent link is up");
    let result = serve(keep, socket, outgoing, &hub, link).await;
    let _ = hub.send(Command::Input(Input::LinkDown { link }));
    result
}

async fn dial(keep: &Keep, token: &str) -> Result<WebSocketStream<Box<dyn Io>>, LinkError> {
    let url = keep.gateway.as_str();
    let mut request = url.into_client_request()?;
    let uri = request.uri().clone();
    let secure = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err(LinkError::Url(url.to_owned())),
    };
    let host = uri.host().ok_or_else(|| LinkError::Url(url.to_owned()))?;
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let headers = request.headers_mut();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| LinkError::Token("not a header value".into()))?,
    );
    headers.insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(SUBPROTOCOL),
    );
    // An IPv6 literal comes bracketed in the URL's host.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let tcp = TcpStream::connect((bare, port)).await?;
    tcp.set_nodelay(true)?;
    let stream: Box<dyn Io> = if secure {
        let name =
            ServerName::try_from(bare.to_owned()).map_err(|_| LinkError::Url(url.to_owned()))?;
        let connector = tokio_rustls::TlsConnector::from(Arc::clone(&keep.tls));
        Box::new(connector.connect(name, tcp).await?)
    } else {
        Box::new(tcp)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (socket, response) =
        tokio_tungstenite::client_async_with_config(request, stream, Some(config)).await?;
    let chosen = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if chosen != Some(SUBPROTOCOL) {
        return Err(LinkError::Subprotocol);
    }
    Ok(socket)
}

async fn serve(
    keep: &Keep,
    socket: WebSocketStream<Box<dyn Io>>,
    mut outgoing: mpsc::UnboundedReceiver<Vec<u8>>,
    hub: &mpsc::UnboundedSender<Command>,
    link: LinkId,
) -> Result<(), LinkError> {
    let (mut sink, mut stream) = socket.split();
    let mut heard = Instant::now();
    let mut ping = tokio::time::interval_at(
        Instant::now() + keep.timing.ping_every,
        keep.timing.ping_every,
    );
    loop {
        tokio::select! {
            () = keep.cancel.cancelled() => {
                // What the hub sent before it hung up still goes, ahead of
                // the close: a session's `close` is the last thing its
                // gateway hears.
                while let Ok(frame) = outgoing.try_recv() {
                    sink.feed(Message::Binary(frame.into())).await?;
                }
                let _ = sink.send(Message::Close(None)).await;
                return Ok(());
            }
            frame = outgoing.recv() => match frame {
                Some(frame) => {
                    // Everything already waiting goes in one flush.
                    sink.feed(Message::Binary(frame.into())).await?;
                    while let Ok(frame) = outgoing.try_recv() {
                        sink.feed(Message::Binary(frame.into())).await?;
                    }
                    sink.flush().await?;
                }
                None => return Ok(()),
            },
            message = stream.next() => {
                heard = Instant::now();
                match message.ok_or(LinkError::Closed)?? {
                    Message::Binary(bytes) => received(hub, link, &bytes)?,
                    Message::Text(_) => return Err(LinkError::Protocol("a text message".into())),
                    Message::Close(_) => return Err(LinkError::Closed),
                    Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() >= keep.timing.silence {
                    return Err(LinkError::Silent);
                }
                sink.send(Message::Ping(Bytes::new())).await?;
            }
        }
    }
}

fn received(
    hub: &mpsc::UnboundedSender<Command>,
    link: LinkId,
    bytes: &Bytes,
) -> Result<(), LinkError> {
    let (frame, payload) =
        decode::<GatewayFrame>(bytes).map_err(|error| LinkError::Protocol(error.to_string()))?;
    if matches!(frame, GatewayFrame::Hello { .. }) {
        return Err(LinkError::Protocol("a second hello".into()));
    }
    let start = bytes.len() - payload.len();
    let _ = hub.send(Command::Input(Input::Gateway {
        link,
        frame,
        payload: bytes.slice(start..),
    }));
    Ok(())
}
