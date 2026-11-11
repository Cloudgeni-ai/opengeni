//! The sandboxes' name server.
//!
//! Every guest, on every host, is told one name server: its gateway,
//! 169.254.0.22. The host agent answers there, inside each sandbox's own
//! namespace, so only that sandbox's guest can reach it. A name a
//! `--reach` entry gives ([`super::reach`]), or an offer the sandbox asked
//! for, is answered with the addresses the firewalls open for it, in that
//! sandbox's namespace alone; any other query is passed to the host's
//! upstream name servers (`--dns`, public ones unless set otherwise) and
//! their answer passed back. The name server the host itself uses, which
//! on a private network knows every private name (a cloud's internal names,
//! an overlay network's), is never asked for a guest. Docker gives
//! containers the same arrangement with its embedded name server.
//!
//! Because the address is the same everywhere, a guest restored on another
//! host, from a template or after a move, still has the right name server.
//! The listeners belong to the sandbox's network, not its VM, so they stay
//! while it sleeps at any level; a restarted agent opens them again when it
//! checks each network.
//!
//! Queries take UDP and TCP (for answers too large for UDP), each forwarded
//! the same way it came, trying each upstream in turn. A query no upstream
//! answers in time is answered with a server failure.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::runtime::Handle;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, sleep, timeout, timeout_at};

use super::{GATEWAY_IP, NetError, in_namespace};

/// The port guests send queries to.
pub const PORT: u16 = 53;
/// How long one upstream has to answer one query.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a guest's TCP connection may sit without a query, and how long
/// it may take to accept an answer: a guest that stops reading loses its
/// connection, and with it the connection's place among
/// [`MAX_CONNECTIONS`].
const TCP_IDLE: Duration = Duration::from_secs(10);
/// The largest UDP query read from a guest; queries are a few dozen bytes.
const MAX_QUERY: usize = 4096;
/// UDP queries one sandbox may have waiting on upstreams at once; more are
/// dropped, and the guest's resolver asks again. Each costs the host a
/// socket, shared by every sandbox on it (as guest ports' connections do).
const MAX_IN_FLIGHT: usize = 64;
/// TCP connections one sandbox may hold to its name server at once; more
/// are closed at once. Each ends within [`TCP_IDLE`] of the guest going
/// quiet or ceasing to read.
const MAX_CONNECTIONS: usize = 16;
/// How long guests may keep an answer the host gives itself.
const TTL: u32 = 60;

const TYPE_A: u16 = 1;
const CLASS_IN: u16 = 1;

/// The host's name server for its sandboxes. Its methods block; call them
/// off the async runtime's worker threads.
pub(crate) struct NameServer {
    upstreams: Vec<SocketAddr>,
    runtime: Handle,
    /// Each served namespace by name, with its tasks.
    served: Mutex<HashMap<String, Served>>,
}

impl fmt::Debug for NameServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NameServer")
            .field("upstreams", &self.upstreams)
            .finish_non_exhaustive()
    }
}

/// One namespace's listeners.
struct Served {
    /// The namespace they are in (its device and inode): one deleted and
    /// made again under the same name is another, and needs its own.
    namespace: (u64, u64),
    answers: Arc<Answers>,
    _tasks: [AbortOnDrop; 2],
}

/// Ends its task when dropped; the task's sockets close with it.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl NameServer {
    /// A name server that asks `upstreams` for what it does not answer
    /// itself, running its listeners on `runtime`.
    pub fn new(upstreams: &[Ipv4Addr], runtime: Handle) -> Self {
        Self {
            upstreams: upstreams
                .iter()
                .map(|address| SocketAddr::from((*address, PORT)))
                .collect(),
            runtime,
            served: Mutex::new(HashMap::new()),
        }
    }

    /// Serves the namespace `name` at `path`, answering `names` itself,
    /// or, where it is already served, answers `names` from now on. Its
    /// tap must hold the gateway's address.
    pub fn serve(
        &self,
        name: &str,
        path: &Path,
        names: &BTreeMap<String, Vec<Ipv4Addr>>,
    ) -> Result<(), NetError> {
        let metadata =
            std::fs::metadata(path).map_err(|error| NetError::new("look at namespace", error))?;
        let namespace = (metadata.dev(), metadata.ino());
        let mut served = self.served.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(served) = served
            .get(name)
            .filter(|served| served.namespace == namespace)
        {
            served.answers.set(names);
            return Ok(());
        }
        let (udp, tcp) = in_namespace(path, || {
            let address = SocketAddr::from((GATEWAY_IP, PORT));
            let bind = |error| NetError::new("open the sandbox's name server", error);
            let udp = std::net::UdpSocket::bind(address).map_err(bind)?;
            let tcp = std::net::TcpListener::bind(address).map_err(bind)?;
            udp.set_nonblocking(true).map_err(bind)?;
            tcp.set_nonblocking(true).map_err(bind)?;
            Ok((udp, tcp))
        })?;
        let _entered = self.runtime.enter();
        let register = |error| NetError::new("serve the sandbox's name server", error);
        let udp = UdpSocket::from_std(udp).map_err(register)?;
        let tcp = TcpListener::from_std(tcp).map_err(register)?;
        let answers = Arc::new(Answers {
            names: RwLock::new(names.clone()),
            upstreams: self.upstreams.clone(),
        });
        let tasks = [
            AbortOnDrop(self.runtime.spawn(serve_udp(udp, Arc::clone(&answers)))),
            AbortOnDrop(
                self.runtime
                    .spawn(serve_tcp(tcp, Arc::clone(&answers), TCP_IDLE)),
            ),
        ];
        served.insert(
            name.to_owned(),
            Served {
                namespace,
                answers,
                _tasks: tasks,
            },
        );
        Ok(())
    }

    /// Stops serving the namespace `name`, if it is served.
    pub fn stop(&self, name: &str) {
        self.served
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(name);
    }
}

/// What the name server answers itself, and whom it asks for the rest.
#[derive(Debug)]
struct Answers {
    names: RwLock<BTreeMap<String, Vec<Ipv4Addr>>>,
    upstreams: Vec<SocketAddr>,
}

impl Answers {
    /// Answers `names` from now on.
    fn set(&self, names: &BTreeMap<String, Vec<Ipv4Addr>>) {
        let mut known = self.names.write().unwrap_or_else(PoisonError::into_inner);
        if *known != *names {
            known.clone_from(names);
        }
    }

    /// The addresses it answers `name` with itself, if it does.
    fn known(&self, name: &str) -> Option<Vec<Ipv4Addr>> {
        self.names
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }

    /// The answer to `query`, which came over TCP if `tcp`; `None` for
    /// bytes that are not a query.
    async fn answer(&self, query: &[u8], tcp: bool) -> Option<Vec<u8>> {
        if let Some(question) = Question::parse(query)
            && let Some(addresses) = self.known(&question.name)
        {
            return Some(question.answer(query, &addresses));
        }
        let forwarded = if tcp {
            forward_tcp(query, &self.upstreams).await
        } else {
            forward_udp(query, &self.upstreams).await
        };
        forwarded.or_else(|| server_failure(query))
    }
}

/// A standard query's one question.
#[derive(Debug, PartialEq, Eq)]
struct Question {
    /// Where the question ends in the query.
    end: usize,
    /// The name asked about, in lower case without a final dot; empty for
    /// one no `--reach` name can be (a label holding a dot, say).
    name: String,
    kind: u16,
    class: u16,
}

impl Question {
    /// The question of `query`, if it is a standard query with one.
    fn parse(query: &[u8]) -> Option<Self> {
        let header = query.get(..12)?;
        let is_query = header[2] & 0x80 == 0;
        let opcode = (header[2] >> 3) & 0x0f;
        let questions = u16::from_be_bytes([header[4], header[5]]);
        if !is_query || opcode != 0 || questions != 1 {
            return None;
        }
        let mut at = 12;
        let mut labels = Vec::new();
        let mut plain = true;
        loop {
            let length = usize::from(*query.get(at)?);
            at += 1;
            if length == 0 {
                break;
            }
            // Larger lengths are compression pointers, never in a question.
            if length > 63 || at + length - 12 > 255 {
                return None;
            }
            let label = query.get(at..at + length)?;
            plain &= label
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_');
            labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
            at += length;
        }
        let field = |at: usize| Some(u16::from_be_bytes([*query.get(at)?, *query.get(at + 1)?]));
        Some(Self {
            end: at + 4,
            name: if plain {
                labels.join(".")
            } else {
                String::new()
            },
            kind: field(at)?,
            class: field(at + 2)?,
        })
    }

    /// The authoritative answer to `query`, this question's: `addresses`
    /// for an IPv4 address question, and no records (but no error) for any
    /// other, as guests have no IPv6.
    fn answer(&self, query: &[u8], addresses: &[Ipv4Addr]) -> Vec<u8> {
        let records = if self.kind == TYPE_A && self.class == CLASS_IN {
            addresses
        } else {
            &[]
        };
        let mut answer = Vec::with_capacity(self.end + 16 * records.len());
        answer.extend_from_slice(&query[..2]);
        // A response, authoritative, recursion asked for as the query did
        // and available; no error.
        answer.extend_from_slice(&[0x84 | (query[2] & 0x01), 0x80]);
        answer.extend_from_slice(&1_u16.to_be_bytes());
        let count = u16::try_from(records.len()).unwrap_or(u16::MAX);
        answer.extend_from_slice(&count.to_be_bytes());
        answer.extend_from_slice(&[0, 0, 0, 0]);
        answer.extend_from_slice(&query[12..self.end]);
        for address in records {
            // The name is the question's, at offset 12.
            answer.extend_from_slice(&[0xc0, 0x0c]);
            answer.extend_from_slice(&TYPE_A.to_be_bytes());
            answer.extend_from_slice(&CLASS_IN.to_be_bytes());
            answer.extend_from_slice(&TTL.to_be_bytes());
            answer.extend_from_slice(&4_u16.to_be_bytes());
            answer.extend_from_slice(&address.octets());
        }
        answer
    }
}

/// A server failure answering `query`, keeping its id, operation, question
/// and whether it asked for recursion; `None` unless it is a query.
fn server_failure(query: &[u8]) -> Option<Vec<u8>> {
    let header = query.get(..12)?;
    if header[2] & 0x80 != 0 {
        return None;
    }
    let mut answer = header[..2].to_vec();
    answer.extend_from_slice(&[0x80 | (header[2] & 0x79), 0x82]);
    match Question::parse(query) {
        Some(question) => {
            answer.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
            answer.extend_from_slice(&query[12..question.end]);
        }
        None => answer.extend_from_slice(&[0; 8]),
    }
    Some(answer)
}

/// Whether `answer` is a response to `query`.
fn is_answer_to(answer: &[u8], query: &[u8]) -> bool {
    answer.len() >= 12 && query.len() >= 2 && answer[..2] == query[..2] && answer[2] & 0x80 != 0
}

/// Asks each upstream in turn over UDP until one answers.
async fn forward_udp(query: &[u8], upstreams: &[SocketAddr]) -> Option<Vec<u8>> {
    let mut buffer = vec![0; usize::from(u16::MAX)];
    for upstream in upstreams {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await else {
            continue;
        };
        if socket.connect(upstream).await.is_err() || socket.send(query).await.is_err() {
            continue;
        }
        let deadline = Instant::now() + UPSTREAM_TIMEOUT;
        while let Ok(Ok(length)) = timeout_at(deadline, socket.recv(&mut buffer)).await {
            if is_answer_to(&buffer[..length], query) {
                buffer.truncate(length);
                return Some(buffer);
            }
        }
        tracing::debug!(%upstream, "an upstream name server did not answer");
    }
    None
}

/// Asks each upstream in turn over TCP until one answers.
async fn forward_tcp(query: &[u8], upstreams: &[SocketAddr]) -> Option<Vec<u8>> {
    for upstream in upstreams {
        let asked = timeout(UPSTREAM_TIMEOUT, async {
            let mut stream = TcpStream::connect(upstream).await?;
            write_message(&mut stream, query).await?;
            read_message(&mut stream).await
        })
        .await;
        match asked {
            Ok(Ok(Some(answer))) if is_answer_to(&answer, query) => return Some(answer),
            _ => tracing::debug!(%upstream, "an upstream name server did not answer"),
        }
    }
    None
}

/// Reads one length-prefixed message; `None` at a clean end.
async fn read_message(stream: &mut TcpStream) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0; 2];
    match stream.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut message = vec![0; usize::from(u16::from_be_bytes(length))];
    stream.read_exact(&mut message).await?;
    Ok(Some(message))
}

/// Writes one message with its length before it.
async fn write_message(stream: &mut TcpStream, message: &[u8]) -> io::Result<()> {
    let length = u16::try_from(message.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "message too long"))?;
    let mut framed = Vec::with_capacity(message.len() + 2);
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(message);
    stream.write_all(&framed).await
}

/// Answers one namespace's UDP queries.
async fn serve_udp(socket: UdpSocket, answers: Arc<Answers>) {
    let socket = Arc::new(socket);
    let mut queries = JoinSet::new();
    let mut buffer = vec![0; MAX_QUERY];
    loop {
        tokio::select! {
            received = socket.recv_from(&mut buffer) => {
                let Ok((length, guest)) = received else {
                    sleep(Duration::from_millis(10)).await;
                    continue;
                };
                if queries.len() >= MAX_IN_FLIGHT {
                    continue;
                }
                let query = buffer[..length].to_vec();
                let (socket, answers) = (Arc::clone(&socket), Arc::clone(&answers));
                queries.spawn(async move {
                    if let Some(answer) = answers.answer(&query, false).await {
                        let _ = socket.send_to(&answer, guest).await;
                    }
                });
            }
            Some(_) = queries.join_next(), if !queries.is_empty() => {}
        }
    }
}

/// Answers one namespace's TCP connections, each until it sits `idle`
/// ([`TCP_IDLE`]); see [`serve_connection`].
async fn serve_tcp(listener: TcpListener, answers: Arc<Answers>, idle: Duration) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    sleep(Duration::from_millis(10)).await;
                    continue;
                };
                if connections.len() >= MAX_CONNECTIONS {
                    continue;
                }
                let answers = Arc::clone(&answers);
                connections.spawn(async move {
                    let _ = serve_connection(stream, &answers, idle).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// Answers each query on one TCP connection until the guest ends it,
/// sends nothing for `idle`, or takes longer than `idle` to accept an
/// answer.
async fn serve_connection(
    mut stream: TcpStream,
    answers: &Answers,
    idle: Duration,
) -> io::Result<()> {
    while let Ok(read) = timeout(idle, read_message(&mut stream)).await {
        let Some(query) = read? else {
            break;
        };
        let Some(answer) = answers.answer(&query, true).await else {
            break;
        };
        let Ok(written) = timeout(idle, write_message(&mut stream, &answer)).await else {
            tracing::debug!("a guest stopped reading its name server's answers");
            break;
        };
        written?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A query for `name` of `kind`, asking for recursion.
    fn query(id: u16, name: &str, kind: u16) -> Vec<u8> {
        let mut query = id.to_be_bytes().to_vec();
        query.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
        for label in name.split('.') {
            query.push(u8::try_from(label.len()).unwrap());
            query.extend_from_slice(label.as_bytes());
        }
        query.push(0);
        query.extend_from_slice(&kind.to_be_bytes());
        query.extend_from_slice(&CLASS_IN.to_be_bytes());
        query
    }

    fn server_of(names: &[(&str, &[Ipv4Addr])], upstreams: Vec<SocketAddr>) -> Answers {
        Answers {
            names: RwLock::new(
                names
                    .iter()
                    .map(|(name, addresses)| ((*name).to_owned(), addresses.to_vec()))
                    .collect(),
            ),
            upstreams,
        }
    }

    const API: Ipv4Addr = Ipv4Addr::new(100, 70, 0, 1);

    #[test]
    fn questions_parse_in_lower_case_and_nonsense_does_not() {
        let asked = query(7, "API.Example", TYPE_A);
        let question = Question::parse(&asked).unwrap();
        assert_eq!(question.name, "api.example");
        assert_eq!((question.kind, question.class), (TYPE_A, CLASS_IN));
        assert_eq!(question.end, asked.len());
        // A dot inside a label cannot match a name.
        let mut dotted = query(7, "x", TYPE_A);
        dotted.splice(12..14, [3, b'a', b'.', b'b']);
        assert_eq!(Question::parse(&dotted).unwrap().name, "");
        // A response, another operation, two questions, a pointer, a cut.
        let mut response = asked.clone();
        response[2] |= 0x80;
        let mut status = asked.clone();
        status[2] |= 2 << 3;
        let mut two = asked.clone();
        two[5] = 2;
        let mut pointer = asked.clone();
        pointer[12] = 0xc0;
        for bad in [
            &response[..],
            &status,
            &two,
            &pointer,
            &asked[..asked.len() - 1],
            &asked[..11],
            &[],
        ] {
            assert_eq!(Question::parse(bad), None);
        }
    }

    #[tokio::test]
    async fn reached_names_are_answered_with_their_addresses() {
        let server = server_of(
            &[("api.example", &[API, Ipv4Addr::new(100, 70, 0, 2)])],
            Vec::new(),
        );
        let asked = query(0x1234, "Api.Example", TYPE_A);
        let answer = server.answer(&asked, false).await.unwrap();
        assert_eq!(&answer[..2], &[0x12, 0x34]);
        assert_eq!(
            answer[2], 0x85,
            "a response, authoritative, recursion desired"
        );
        assert_eq!(answer[3], 0x80, "recursion available, no error");
        assert_eq!(&answer[4..12], &[0, 1, 0, 2, 0, 0, 0, 0]);
        assert_eq!(&answer[12..asked.len()], &asked[12..]);
        let records = &answer[asked.len()..];
        assert_eq!(records.len(), 32);
        assert_eq!(&records[..12], &[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
        assert_eq!(&records[12..16], &[100, 70, 0, 1]);
        assert_eq!(&records[28..32], &[100, 70, 0, 2]);
        // An IPv6 question about the name has no records and no error.
        let six = server
            .answer(&query(9, "api.example", 28), false)
            .await
            .unwrap();
        assert_eq!((six[3], &six[6..8]), (0x80, &[0_u8, 0][..]));
    }

    /// A sandbox given an offer once it is served, as a claimed ready
    /// sandbox is, answers the offer's names from then on.
    #[tokio::test]
    async fn names_set_later_are_answered_from_then_on() {
        let server = server_of(&[("api.example", &[API])], Vec::new());
        let asked = query(7, "k3s.internal", TYPE_A);
        let failed = server.answer(&asked, false).await.unwrap();
        assert_eq!((failed[2], failed[3]), (0x81, 0x82), "not known yet");
        let names = BTreeMap::from([
            ("api.example".to_owned(), vec![API]),
            (
                "k3s.internal".to_owned(),
                vec![Ipv4Addr::new(10, 20, 0, 10)],
            ),
        ]);
        server.set(&names);
        let answer = server.answer(&asked, false).await.unwrap();
        assert_eq!(answer[3], 0x80, "{answer:?}");
        assert_eq!(&answer[answer.len() - 4..], &[10, 20, 0, 10]);
        server.set(&BTreeMap::new());
        let failed = server.answer(&asked, false).await.unwrap();
        assert_eq!((failed[2], failed[3]), (0x81, 0x82), "taken away");
    }

    #[tokio::test]
    async fn other_names_are_forwarded_and_failures_answered() {
        // An upstream that answers every query with its id and a marker.
        let upstream = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let at = upstream.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buffer = [0; 512];
            loop {
                let (length, from) = upstream.recv_from(&mut buffer).await.unwrap();
                // A stray datagram first, which must not be taken as the
                // answer.
                upstream.send_to(&[0xff; 12], from).await.unwrap();
                let mut answer = buffer[..length].to_vec();
                answer[2] |= 0x80;
                answer.extend_from_slice(b"upstream");
                upstream.send_to(&answer, from).await.unwrap();
            }
        });
        // The first upstream never answers; the second does.
        let silent = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let server = server_of(
            &[("api.example", &[API])],
            vec![silent.local_addr().unwrap(), at],
        );
        let asked = query(42, "example.com", TYPE_A);
        let answer = server.answer(&asked, false).await.unwrap();
        assert!(answer.ends_with(b"upstream"));
        assert_eq!(&answer[..2], &[0, 42]);

        let nobody = server_of(&[], vec![silent.local_addr().unwrap()]);
        let failed = nobody.answer(&asked, false).await.unwrap();
        assert_eq!(&failed[..2], &[0, 42]);
        assert_eq!((failed[2], failed[3]), (0x81, 0x82), "a server failure");
        assert_eq!(&failed[12..], &asked[12..]);
        // What is not a query gets no answer at all.
        let mut response = asked.clone();
        response[2] |= 0x80;
        assert_eq!(nobody.answer(&response, false).await, None);
    }

    #[tokio::test]
    async fn queries_over_tcp_are_answered_and_forwarded_over_tcp() {
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let at = upstream.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = upstream.accept().await.unwrap();
                let mut query = read_message(&mut stream).await.unwrap().unwrap();
                query[2] |= 0x80;
                query.extend_from_slice(b"over tcp");
                write_message(&mut stream, &query).await.unwrap();
            }
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let name_server = listener.local_addr().unwrap();
        let serving = tokio::spawn(serve_tcp(
            listener,
            Arc::new(server_of(&[("api.example", &[API])], vec![at])),
            TCP_IDLE,
        ));
        let mut guest = TcpStream::connect(name_server).await.unwrap();
        write_message(&mut guest, &query(1, "example.com", TYPE_A))
            .await
            .unwrap();
        let forwarded = read_message(&mut guest).await.unwrap().unwrap();
        assert!(forwarded.ends_with(b"over tcp"));
        // The same connection takes the next query.
        write_message(&mut guest, &query(2, "api.example", TYPE_A))
            .await
            .unwrap();
        let local = read_message(&mut guest).await.unwrap().unwrap();
        assert!(local.ends_with(&API.octets()));
        serving.abort();
    }

    #[tokio::test]
    async fn guests_that_stop_reading_answers_lose_their_connections() {
        // Small buffers on both sides, so that a guest that never reads
        // blocks the name server's writes after a few hundred answers.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_send_buffer_size(4096).unwrap();
        socket.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
        let listener = socket.listen(64).unwrap();
        let name_server = listener.local_addr().unwrap();
        let idle = Duration::from_millis(300);
        let serving = tokio::spawn(serve_tcp(
            listener,
            Arc::new(server_of(&[("api.example", &[API])], Vec::new())),
            idle,
        ));
        let mut batch = Vec::new();
        for id in 0..4000 {
            let asked = query(id, "api.example", TYPE_A);
            batch.extend_from_slice(&u16::try_from(asked.len()).unwrap().to_be_bytes());
            batch.extend_from_slice(&asked);
        }
        let batch = Arc::new(batch);
        // Every connection a sandbox may hold, each sending queries
        // without ever reading an answer, and kept open.
        let mut stalled = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let socket = tokio::net::TcpSocket::new_v4().unwrap();
            socket.set_recv_buffer_size(4096).unwrap();
            let mut guest = socket.connect(name_server).await.unwrap();
            let batch = Arc::clone(&batch);
            stalled.push(tokio::spawn(async move {
                let _ = guest.write_all(&batch).await;
                sleep(Duration::from_secs(60)).await;
                drop(guest);
            }));
        }
        // Once their writes have stalled for `idle`, their places are free
        // again, and a guest that reads is answered.
        let answered = timeout(Duration::from_secs(5), async {
            loop {
                sleep(idle).await;
                let Ok(mut guest) = TcpStream::connect(name_server).await else {
                    continue;
                };
                if write_message(&mut guest, &query(1, "api.example", TYPE_A))
                    .await
                    .is_err()
                {
                    continue;
                }
                if let Ok(Ok(Some(answer))) = timeout(idle, read_message(&mut guest)).await {
                    return answer;
                }
            }
        })
        .await
        .expect("a stalled guest kept its connection");
        assert!(answered.ends_with(&API.octets()));
        for guest in stalled {
            guest.abort();
        }
        serving.abort();
    }
}
