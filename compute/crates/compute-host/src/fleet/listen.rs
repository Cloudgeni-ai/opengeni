//! The host API for the fleet service: the agent's own requests, one per
//! connection, over mutual TLS, each in an [`Envelope`] that bounds it.
//!
//! A request goes through only while the host holds the registration it
//! names, its lease has not run out, and it is no more than the request
//! window of renewals old; anything else is answered `unavailable` or
//! `expired` without reaching the agent. One that does is served exactly
//! as on the Unix socket, under the owner epoch it names, through a
//! socket pair: its first reply line is wrapped in an [`Answer`] saying
//! when it was given, and a connection's stream after that is relayed as
//! it is.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use compute_protocol::fleet::{Answer, Envelope, Sent};
use compute_protocol::host::{ErrorCode, Reply, Request};
use tokio::io::{
    AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader,
};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio_rustls::TlsAcceptor;

use super::gate::LeaseGate;
use super::lease::Current;
use crate::agent::Handle;
use crate::server::serve_one;
use crate::store::OwnerEpoch;

/// Requests are small; anything longer is refused.
const MAX_REQUEST: u64 = 64 << 10;
/// How long a caller may take to finish the handshake and send its request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// First and longest pause after accepting a connection fails.
const ACCEPT_BACKOFF: (Duration, Duration) = (Duration::from_millis(10), Duration::from_secs(1));

/// What every connection needs.
#[derive(Clone)]
pub(crate) struct Listening {
    pub(crate) acceptor: TlsAcceptor,
    /// A handle of the host's own origin; each request runs under the
    /// owner epoch it names.
    pub(crate) handle: Handle,
    pub(crate) gate: LeaseGate,
    pub(crate) current: Arc<Current>,
}

/// Accepts the service's connections for as long as the agent runs.
pub(crate) async fn listen(listener: TcpListener, listening: Listening) -> io::Result<()> {
    let mut backoff = ACCEPT_BACKOFF.0;
    loop {
        let tcp = match listener.accept().await {
            Ok((tcp, _)) => {
                backoff = ACCEPT_BACKOFF.0;
                tcp
            }
            Err(error) => {
                tracing::warn!(%error, "accepting a fleet connection failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(ACCEPT_BACKOFF.1);
                continue;
            }
        };
        let listening = listening.clone();
        tokio::spawn(async move {
            if let Err(error) = listening.serve(tcp).await {
                tracing::debug!(%error, "fleet connection ended with an error");
            }
        });
    }
}

impl Listening {
    async fn serve(&self, tcp: TcpStream) -> io::Result<()> {
        let _ = tcp.set_nodelay(true);
        let Ok(tls) = tokio::time::timeout(REQUEST_TIMEOUT, self.acceptor.accept(tcp)).await else {
            return Ok(());
        };
        let mut caller = BufReader::new(tls?);
        let mut line = String::new();
        let mut limited = (&mut caller).take(MAX_REQUEST);
        match tokio::time::timeout(REQUEST_TIMEOUT, limited.read_line(&mut line)).await {
            Ok(Ok(0)) | Err(_) => return Ok(()),
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(error),
        }
        let envelope: Envelope = match serde_json::from_str(&line) {
            Ok(envelope) => envelope,
            Err(error) => {
                let reply = refused(ErrorCode::Invalid, format!("bad request: {error}"));
                return self.answer(&mut caller, reply).await;
            }
        };
        if let Some(reply) = refusal(&self.current, &self.gate, &envelope.sent, &envelope.request) {
            return self.answer(&mut caller, reply).await;
        }
        let owner = OwnerEpoch(envelope.sent.owner_epoch.unwrap_or(OwnerEpoch::FIRST.0));
        let (ours, theirs) = UnixStream::pair()?;
        let handle = self.handle.owned(owner);
        tokio::spawn(async move {
            if let Err(error) = serve_one(&handle, theirs).await {
                tracing::debug!(%error, "fleet request ended with an error");
            }
        });
        self.relay(caller, ours, &envelope.request).await
    }

    async fn answer(&self, caller: &mut (impl AsyncWrite + Unpin), reply: Reply) -> io::Result<()> {
        let answer = Answer {
            answered: self.current.answered(),
            reply,
        };
        let mut line = serde_json::to_vec(&answer).map_err(io::Error::other)?;
        line.push(b'\n');
        caller.write_all(&line).await?;
        caller.flush().await
    }

    /// Passes `request` to the agent through `ours`, answers its first
    /// reply line, then relays both ways until both are done.
    async fn relay<C>(&self, caller: C, ours: UnixStream, request: &Request) -> io::Result<()>
    where
        C: AsyncRead + AsyncWrite + Unpin,
    {
        let (mut from_caller, mut to_caller) = tokio::io::split(caller);
        let (from_agent, mut to_agent) = ours.into_split();
        let mut line = serde_json::to_vec(request).map_err(io::Error::other)?;
        line.push(b'\n');
        to_agent.write_all(&line).await?;
        let upstream = async move {
            let copied = tokio::io::copy(&mut from_caller, &mut to_agent).await;
            let _ = to_agent.shutdown().await;
            copied
        };
        let downstream = async move {
            let mut from_agent = BufReader::new(from_agent);
            let mut reply = String::new();
            if from_agent.read_line(&mut reply).await? == 0 {
                return Ok(0);
            }
            let reply: Reply = serde_json::from_str(&reply).map_err(io::Error::other)?;
            self.answer(&mut to_caller, reply).await?;
            let copied = tokio::io::copy_buf(&mut from_agent, &mut to_caller).await;
            let _ = to_caller.shutdown().await;
            copied
        };
        // A caller gone both ways ends the stream: dropping the socket pair
        // tells the agent it hung up, so a wake it waited on is given up.
        let (up, down) = tokio::join!(upstream, downstream);
        down.and(up).map(drop)
    }
}

/// Why the host refuses a request sent under `sent`, if it does: it does
/// not hold the registration named, its lease has run out, the request is
/// too many renewals old, or it names two owner epochs.
fn refusal(current: &Current, gate: &LeaseGate, sent: &Sent, request: &Request) -> Option<Reply> {
    let held = current.answered();
    if held.host_epoch != Some(sent.host_epoch) || !gate.is_open() {
        return Some(refused(
            ErrorCode::Unavailable,
            "this host does not hold that registration, or its lease has run out".to_owned(),
        ));
    }
    if !current.admits(sent.stamp) {
        return Some(refused(
            ErrorCode::Expired,
            format!(
                "sent after renewal {}, too long before this host's renewal {}",
                sent.stamp, held.seq
            ),
        ));
    }
    match request {
        Request::Adopt { owner_epoch, .. } | Request::HandOff { owner_epoch, .. }
            if sent.owner_epoch != Some(*owner_epoch) =>
        {
            Some(refused(
                ErrorCode::Invalid,
                "the request and its envelope name different owner epochs".to_owned(),
            ))
        }
        _ => None,
    }
}

fn refused(code: ErrorCode, message: String) -> Reply {
    Reply::Error { message, code }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use compute_protocol::host::Id;

    use super::*;
    use crate::fleet::LeaseFile;
    use crate::fleet::gate::boot_now;

    fn sent(host_epoch: u64, stamp: u64, owner_epoch: Option<u64>) -> Sent {
        Sent {
            host_epoch,
            stamp,
            owner_epoch,
        }
    }

    fn code(reply: Option<Reply>) -> Option<ErrorCode> {
        reply.map(|reply| match reply {
            Reply::Error { code, .. } => code,
            other => panic!("{other:?}"),
        })
    }

    #[test]
    fn a_request_passes_only_under_the_registration_held_while_the_lease_runs() {
        let current = Current::new(
            LeaseFile {
                host: Some(7),
                epoch: Some(3),
                deadline_ns: 0,
                seq: 10,
            },
            2,
        );
        let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
        let status = Request::Status;
        let check = |sent: Sent, request: &Request| code(refusal(&current, &gate, &sent, request));
        assert_eq!(check(sent(3, 10, None), &status), None);
        assert_eq!(check(sent(3, 8, None), &status), None, "within the window");
        assert_eq!(
            check(sent(3, 11, None), &status),
            None,
            "a renewal the host has not heard back about"
        );
        assert_eq!(check(sent(3, 7, None), &status), Some(ErrorCode::Expired));
        assert_eq!(
            check(sent(2, 10, None), &status),
            Some(ErrorCode::Unavailable),
            "an earlier registration"
        );
        let id = Id(compute_core::SandboxId(1));
        let hand_off = Request::HandOff { id, owner_epoch: 4 };
        assert_eq!(check(sent(3, 10, Some(4)), &hand_off), None);
        assert_eq!(
            check(sent(3, 10, Some(5)), &hand_off),
            Some(ErrorCode::Invalid)
        );
        assert_eq!(
            check(sent(3, 10, None), &hand_off),
            Some(ErrorCode::Invalid)
        );

        gate.set(boot_now());
        assert_eq!(
            check(sent(3, 10, None), &status),
            Some(ErrorCode::Unavailable)
        );
        let unregistered = Current::new(LeaseFile::NONE, 2);
        let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
        assert_eq!(
            code(refusal(&unregistered, &gate, &sent(0, 0, None), &status)),
            Some(ErrorCode::Unavailable),
            "a host that never registered serves nothing"
        );
    }
}
