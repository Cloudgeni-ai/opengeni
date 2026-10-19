//! The host API for the control service: the agent's own requests, one per
//! connection, over mutual TLS, each in an [`Envelope`] that bounds it.
//!
//! A request goes through only while the host holds the registration it
//! names, its lease has not run out, and it is no more than the request
//! window of renewals old; anything else is answered `unavailable` or
//! `expired` without reaching the agent. One that does is served exactly
//! as on the Unix socket, under the owner epoch it names and the
//! [`Admission`] it passed, which the agent checks again when it acts,
//! through a socket pair: its first reply line is wrapped in an [`Answer`]
//! saying when it was given, and a connection's stream after that is
//! relayed as it is.
//!
//! When an answer was given orders it against the host's other answers
//! ([`compute_fleet::AnsweredAt`]), and the agent decides somewhere
//! between the request's admission and its reply reaching the relay. A
//! refusal or "not found" is final for the service only if given late
//! enough, so it carries the earliest the agent can have decided it: the
//! time of admission. A success counts against answers given after it, so
//! it carries the latest: the time the relay reads it.
//!
//! A caller keeps its side open until it has its answer: one that ends it
//! before has given the request up, and the agent is told so by the whole
//! socket pair closing, so a wake it waits on lets go. After the answer a
//! caller's end is the end of what it sends on the stream, and is passed
//! on as that.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compute_protocol::fleet::{Answer, Answered, Envelope, Sent};
use compute_protocol::host::{ErrorCode, Reply, Request};
use tokio::io::{
    AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader,
};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsAcceptor;

use super::gate::{Admission, LeaseGate};
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
                return answer(&mut caller, reply, self.gate.answered()).await;
            }
        };
        // Sampled before the check, so no later registration or renewal
        // can be in it.
        let admitted = self.gate.answered();
        if let Some(reply) = refusal(&self.gate, &envelope.sent, &envelope.request) {
            return answer(&mut caller, reply, admitted).await;
        }
        let owner = OwnerEpoch(envelope.sent.owner_epoch.unwrap_or(OwnerEpoch::FIRST.0));
        let admission = Admission {
            host_epoch: envelope.sent.host_epoch,
            stamp: envelope.sent.stamp,
        };
        let (ours, theirs) = UnixStream::pair()?;
        let handle = self.handle.admitted(owner, admission);
        tokio::spawn(async move {
            if let Err(error) = serve_one(&handle, theirs).await {
                tracing::debug!(%error, "fleet request ended with an error");
            }
        });
        relay(&self.gate, caller, ours, &envelope.request, admitted).await
    }
}

/// Writes `reply`, given `answered`, to `caller` as one answer line.
async fn answer(
    caller: &mut (impl AsyncWrite + Unpin),
    reply: Reply,
    answered: Answered,
) -> io::Result<()> {
    let mut line = serde_json::to_vec(&Answer { answered, reply }).map_err(io::Error::other)?;
    line.push(b'\n');
    caller.write_all(&line).await?;
    caller.flush().await
}

/// Passes `request`, admitted when the host had sent `admitted`, to the
/// agent through `ours`, answers its first reply line, then relays both
/// ways until both are done.
async fn relay<C>(
    gate: &LeaseGate,
    caller: C,
    ours: UnixStream,
    request: &Request,
    admitted: Answered,
) -> io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
{
    let (mut from_caller, mut to_caller) = tokio::io::split(caller);
    let (from_agent, mut to_agent) = ours.into_split();
    let mut line = serde_json::to_vec(request).map_err(io::Error::other)?;
    line.push(b'\n');
    to_agent.write_all(&line).await?;
    let answered = AtomicBool::new(false);
    let (abandon, abandoned) = oneshot::channel::<()>();
    let upstream = async {
        let copied = tokio::io::copy(&mut from_caller, &mut to_agent).await;
        if answered.load(Ordering::Acquire) {
            let _ = to_agent.shutdown().await;
        } else {
            // Given up before its answer: the agent's side of the pair
            // closes whole once both halves here are dropped.
            let _ = abandon.send(());
        }
        drop(to_agent);
        copied
    };
    let downstream = async {
        let mut from_agent = BufReader::new(from_agent);
        let mut reply = String::new();
        tokio::select! {
            read = from_agent.read_line(&mut reply) => {
                if read? == 0 {
                    return Ok(0);
                }
            }
            _ = abandoned => return Ok(0),
        }
        answered.store(true, Ordering::Release);
        let reply: Reply = serde_json::from_str(&reply).map_err(io::Error::other)?;
        let at = if matches!(reply, Reply::Error { .. }) {
            admitted
        } else {
            gate.answered()
        };
        answer(&mut to_caller, reply, at).await?;
        let copied = tokio::io::copy_buf(&mut from_agent, &mut to_caller).await;
        let _ = to_caller.shutdown().await;
        copied
    };
    let (up, down) = tokio::join!(upstream, downstream);
    down.and(up).map(drop)
}

/// Why the host refuses a request sent under `sent`, if it does: it does
/// not hold the registration named, its lease has run out, the request is
/// too many renewals old, or it names two owner epochs.
fn refusal(gate: &LeaseGate, sent: &Sent, request: &Request) -> Option<Reply> {
    let held = gate.answered();
    if held.host_epoch != Some(sent.host_epoch) || !gate.is_open() {
        return Some(refused(
            ErrorCode::Unavailable,
            "this host does not hold that registration, or its lease has run out".to_owned(),
        ));
    }
    if !gate.admits_stamp(sent.stamp) {
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

    use tokio::io::{AsyncBufReadExt, DuplexStream};

    use super::*;
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
        let gate = registered(10);
        let status = Request::Status;
        let check = |sent: Sent, request: &Request| code(refusal(&gate, &sent, request));
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
        let unregistered = LeaseGate::new(boot_now() + Duration::from_secs(60));
        assert_eq!(
            code(refusal(&unregistered, &sent(0, 0, None), &status)),
            Some(ErrorCode::Unavailable),
            "a host that never registered serves nothing"
        );
    }

    /// Registration 3, last renewal `seq`, open for a minute.
    fn registered(seq: u64) -> LeaseGate {
        LeaseGate::holding(
            boot_now() + Duration::from_secs(60),
            Answered {
                host_epoch: Some(3),
                seq,
            },
            2,
        )
    }

    /// A relay of `request` admitted at renewal 10, between a caller and an
    /// agent this test plays.
    fn relayed(
        gate: &LeaseGate,
        request: Request,
    ) -> (
        DuplexStream,
        UnixStream,
        tokio::task::JoinHandle<io::Result<()>>,
    ) {
        let (caller, ours) = tokio::io::duplex(1 << 16);
        let (agent, theirs) = UnixStream::pair().unwrap();
        let gate = gate.clone();
        let relay = tokio::spawn(async move {
            let admitted = Answered {
                host_epoch: Some(3),
                seq: 10,
            };
            relay(&gate, ours, agent, &request, admitted).await
        });
        (caller, theirs, relay)
    }

    async fn line(reader: &mut (impl AsyncBufReadExt + Unpin)) -> String {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("a line")
            .unwrap();
        line
    }

    async fn answered(caller: &mut BufReader<DuplexStream>) -> Answer {
        serde_json::from_str(&line(caller).await).unwrap()
    }

    /// A refusal or "not found" carries the time of admission, however
    /// late it reaches the relay; a success the time it does.
    #[tokio::test]
    async fn an_answer_carries_the_bound_on_when_the_agent_decided_it() {
        for (reply, seq) in [
            (refused(ErrorCode::NotFound, "gone".to_owned()), 10),
            (Reply::Done, 15),
        ] {
            let gate = registered(10);
            let (caller, theirs, relay) = relayed(&gate, Request::Status);
            let mut agent = BufReader::new(theirs);
            assert!(line(&mut agent).await.contains("status"));
            // Renewals go out while the agent decides.
            gate.hold(
                Answered {
                    host_epoch: Some(3),
                    seq: 15,
                },
                boot_now() + Duration::from_secs(60),
            );
            let mut sent = serde_json::to_vec(&reply).unwrap();
            sent.push(b'\n');
            agent.get_mut().write_all(&sent).await.unwrap();
            let mut caller = BufReader::new(caller);
            let answer = answered(&mut caller).await;
            assert_eq!(answer.reply, reply);
            assert_eq!(
                answer.answered,
                Answered {
                    host_epoch: Some(3),
                    seq
                },
                "{reply:?}"
            );
            drop((caller, agent));
            relay.await.unwrap().unwrap();
        }
    }

    /// A caller that goes away before its answer closes the agent's side
    /// whole, so a wake it waited on lets go; the relay ends.
    #[tokio::test]
    async fn a_caller_gone_before_its_answer_closes_the_agents_side() {
        let gate = registered(10);
        let (caller, theirs, relay) = relayed(&gate, Request::Status);
        let mut agent = BufReader::new(theirs);
        line(&mut agent).await;
        drop(caller);
        tokio::time::timeout(Duration::from_secs(5), relay)
            .await
            .expect("the relay ends")
            .unwrap()
            .unwrap();
        let mut rest = Vec::new();
        assert_eq!(agent.read_to_end(&mut rest).await.unwrap(), 0);
        let mut agent = agent.into_inner();
        let mut write = Ok(());
        for _ in 0..8 {
            write = agent.write_all(&[0; 4096]).await;
            if write.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(write.is_err(), "nobody is left to read the reply");
    }

    /// After the answer, a caller's end is the end of what it sends: the
    /// agent reads it as such and can still send the rest of the stream.
    #[tokio::test]
    async fn after_its_answer_a_callers_end_is_a_half_close() {
        let gate = registered(10);
        let (caller, theirs, relay) = relayed(&gate, Request::Status);
        let mut agent = BufReader::new(theirs);
        line(&mut agent).await;
        agent
            .get_mut()
            .write_all(b"{\"result\":\"done\"}\n")
            .await
            .unwrap();
        let (from, mut to) = tokio::io::split(caller);
        let mut from = BufReader::new(from);
        let mut answer = String::new();
        from.read_line(&mut answer).await.unwrap();
        assert!(answer.contains("done"), "{answer}");
        to.write_all(b"last words").await.unwrap();
        to.shutdown().await.unwrap();
        let mut heard = Vec::new();
        agent.read_to_end(&mut heard).await.unwrap();
        assert_eq!(heard, b"last words");
        agent.get_mut().write_all(b"the rest").await.unwrap();
        drop(agent);
        let mut rest = Vec::new();
        from.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"the rest");
        relay.await.unwrap().unwrap();
    }
}
