//! The guest's side of a resumable stream (see [`super`]), on threads: one
//! reads the agent's connection, one writes to it, and the calling thread
//! keeps a connection to the host under the stream, sending on it while a
//! fourth reads it, and connects again when it ends.
//!
//! The agent's connection ends when the stream does: once both directions
//! ended, when the host has no stream to go on with, and when the host
//! cannot be reached again. A host that cannot be reached at all when the
//! stream begins ends it at once, as a forwarder with no upstream would.
//! The caller hears how it ended just before the agent's connection ends.

use std::io::{self, Read};
use std::net::Shutdown;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::stream::{Delivery, Received, Stream};
use super::wire::{Answer, CHUNK, Frame, LINE_MAX, StreamId};
use crate::relay::Duplex;

/// Connections the guest tries in a row, after one under a stream ended,
/// before it gives the stream up: about half a minute of the guest's own
/// running time with [`pause`]'s back-off. A VM that pauses in between
/// does not use it up. Each try is bounded, so a host that takes the
/// connection and never answers uses it up too: a vsock connect waits at
/// most the guest kernel's connect timeout, two seconds unless set, and
/// the host's answer at most [`ANSWER_WITHIN`].
const RECONNECTS: u32 = 40;

/// How long the guest waits for the host's whole answer to its hello. The
/// host answers as soon as it has read the hello. Shorter in tests.
const ANSWER_WITHIN: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });

/// How a stream ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// Both directions ended and each side acknowledged the other's end.
    Finished,
    /// The host could not be reached when the stream began.
    Unreachable(String),
    /// The host answered with no stream to go on with, or gave it up.
    Gone,
    /// The host could not be reached again after a connection under the
    /// stream ended.
    Lost,
    /// The host did not keep the protocol.
    Broken(String),
}

/// Carries `local`, the agent's connection, as stream `id` on connections
/// to the host that `dial` opens, until the stream ends; then tells
/// `ending` how, and ends `local`.
pub fn relay<L, H, D, E>(local: L, id: StreamId, mut dial: D, ending: E) -> Ended
where
    L: Duplex,
    H: Duplex,
    D: FnMut() -> io::Result<H>,
    E: FnOnce(&Ended),
{
    let shared = Arc::new(Shared::default());
    let (Ok(reading), Ok(writing)) = (local.try_clone(), local.try_clone()) else {
        let ended = Ended::Broken("the agent's connection could not be shared".to_owned());
        ending(&ended);
        return ended;
    };
    let reader = spawn({
        let shared = Arc::clone(&shared);
        move || read_local(reading, &shared)
    });
    let writer = spawn({
        let shared = Arc::clone(&shared);
        move || write_local(writing, &shared)
    });
    let ended = match (&reader, &writer) {
        (Some(_), Some(_)) => carry(id, &mut dial, &shared),
        _ => Ended::Broken("the relay's threads did not start".to_owned()),
    };
    {
        let mut state = shared.lock();
        state.over = true;
        shared.changed.notify_all();
    }
    ending(&ended);
    if ended != Ended::Finished {
        // Ends a read or write still waiting on the agent.
        let _ = local.shutdown(Shutdown::Both);
    }
    for thread in [reader, writer].into_iter().flatten() {
        let _ = thread.join();
    }
    let _ = local.shutdown(Shutdown::Both);
    drop(local);
    ended
}

#[derive(Debug, Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct State {
    stream: Stream,
    /// The stream ended: every thread stops.
    over: bool,
    /// The connection under the stream ended.
    broken: bool,
    /// The host gave the stream up.
    abandoned: bool,
    /// The host did not keep the protocol.
    error: Option<String>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait<'a>(&self, state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.changed
            .wait(state)
            .unwrap_or_else(PoisonError::into_inner)
    }
}

fn spawn(work: impl FnOnce() + Send + 'static) -> Option<JoinHandle<()>> {
    thread::Builder::new()
        .name("agent-link".to_owned())
        .stack_size(128 * 1024)
        .spawn(work)
        .ok()
}

/// The pause before the `attempt`th connection again: from 5 ms, doubling,
/// to a second.
fn pause(attempt: u32) -> Duration {
    let millis = 5_u64 << attempt.saturating_sub(1).min(8);
    Duration::from_millis(millis.min(1000))
}

/// Reads the agent's connection into the stream, within its window.
fn read_local(mut local: impl Read, shared: &Shared) {
    let mut buffer = vec![0; CHUNK];
    loop {
        let room = {
            let mut state = shared.lock();
            loop {
                if state.over {
                    return;
                }
                let room = state.stream.room();
                if room > 0 {
                    break room;
                }
                state = shared.wait(state);
            }
        };
        let read = match local.read(&mut buffer[..room.min(CHUNK)]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => None,
            Ok(read) => Some(read),
        };
        let mut state = shared.lock();
        match read {
            Some(read) => state.stream.push(&buffer[..read]),
            None => state.stream.end(),
        }
        shared.changed.notify_all();
        if read.is_none() {
            return;
        }
    }
}

/// Writes what the stream received to the agent's connection, and ends
/// its writing when the host's direction ends. What an agent that went
/// away cannot take is dropped.
fn write_local(mut local: impl Duplex, shared: &Shared) {
    let mut gone = false;
    loop {
        let delivery = {
            let mut state = shared.lock();
            loop {
                if state.over {
                    return;
                }
                if let Some(delivery) = state.stream.take(CHUNK) {
                    // Taken is acknowledged: the writer sends it.
                    shared.changed.notify_all();
                    break delivery;
                }
                state = shared.wait(state);
            }
        };
        match delivery {
            Delivery::Bytes(bytes) => {
                gone = gone || local.write_all(&bytes).is_err();
            }
            Delivery::End => {
                let _ = local.shutdown(Shutdown::Write);
                return;
            }
        }
    }
}

/// Keeps a connection to the host under the stream until it ends.
fn carry<H: Duplex>(
    id: StreamId,
    dial: &mut impl FnMut() -> io::Result<H>,
    shared: &Arc<Shared>,
) -> Ended {
    let mut began = false;
    let mut attempts = 0;
    loop {
        match attach(id, dial, shared) {
            Ok((connection, cursor)) => {
                began = true;
                attempts = 0;
                match send(connection, cursor, shared) {
                    Carried::Broken => {}
                    Carried::Over(ended) => return ended,
                }
            }
            Err(Refused::Gone) => return Ended::Gone,
            Err(Refused::Failed(error)) if !began => return Ended::Unreachable(error.to_string()),
            Err(Refused::Failed(_)) => {
                attempts += 1;
                if attempts > RECONNECTS {
                    return Ended::Lost;
                }
                thread::sleep(pause(attempts));
            }
        }
    }
}

enum Refused {
    /// The host has no stream to go on with.
    Gone,
    /// The connection, or what was said on it, failed.
    Failed(io::Error),
}

/// Connects to the host and says hello: the connection and where to send
/// from on it.
fn attach<H: Duplex>(
    id: StreamId,
    dial: &mut impl FnMut() -> io::Result<H>,
    shared: &Shared,
) -> Result<(H, u64), Refused> {
    let mut connection = dial().map_err(Refused::Failed)?;
    let hello = shared.lock().stream.hello(id);
    connection
        .write_all(hello.line().as_bytes())
        .map_err(Refused::Failed)?;
    // Only the answer is bounded: once the stream goes on, the connection
    // waits for as long as the stream is quiet.
    let line = read_answer(&mut connection, ANSWER_WITHIN).map_err(Refused::Failed)?;
    connection.set_read_timeout(None).map_err(Refused::Failed)?;
    let Some(answer) = Answer::parse(&line) else {
        return Err(Refused::Gone);
    };
    let Answer::Resumed { received } = answer else {
        return Err(Refused::Gone);
    };
    let Some(cursor) = shared.lock().stream.resume_from(received) else {
        let mut abandon = Vec::new();
        Frame::Abandon.encode(&mut abandon);
        let _ = connection.write_all(&abandon);
        return Err(Refused::Gone);
    };
    Ok((connection, cursor))
}

/// One line, all of it within `within`: a host that answers a byte at a
/// time is held to the same bound as one that never answers.
fn read_answer<H: Duplex>(connection: &mut H, within: Duration) -> io::Result<String> {
    let deadline = Instant::now() + within;
    let mut line = Vec::with_capacity(32);
    let mut byte = [0];
    while line.len() < LINE_MAX {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        connection.set_read_timeout(Some(left))?;
        match connection.read(&mut byte) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(_) => {
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    return String::from_utf8(line).map_err(|_| io::ErrorKind::InvalidData.into());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::ErrorKind::InvalidData.into())
}

/// One line, read a byte at a time so nothing after it is taken.
#[cfg(test)]
fn read_line(connection: &mut impl Read) -> io::Result<String> {
    let mut line = Vec::with_capacity(32);
    let mut byte = [0];
    while line.len() < LINE_MAX {
        match connection.read(&mut byte) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(_) => {
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    return String::from_utf8(line).map_err(|_| io::ErrorKind::InvalidData.into());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::ErrorKind::InvalidData.into())
}

enum Carried {
    /// The connection ended under the stream: connect again.
    Broken,
    Over(Ended),
}

/// Sends what the host lacks on `connection` from `cursor` on, while
/// another thread reads it, until either ends.
fn send<H: Duplex>(mut connection: H, mut cursor: u64, shared: &Arc<Shared>) -> Carried {
    let Ok(reading) = connection.try_clone() else {
        return Carried::Broken;
    };
    {
        let mut state = shared.lock();
        state.broken = false;
        state.stream.carried_anew();
    }
    let Some(reader) = spawn({
        let shared = Arc::clone(shared);
        move || read_host(reading, &shared)
    }) else {
        return Carried::Broken;
    };
    let mut out = Vec::with_capacity(2 * CHUNK);
    let carried = loop {
        out.clear();
        let mut state = shared.lock();
        let over = loop {
            while out.len() < CHUNK {
                match state.stream.next_frame(cursor, &mut out) {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
            state.stream.acknowledge(&mut out);
            let over = if let Some(error) = state.error.take() {
                Some(Carried::Over(Ended::Broken(error)))
            } else if state.abandoned {
                Some(Carried::Over(Ended::Gone))
            } else if state.broken {
                Some(Carried::Broken)
            } else if state.stream.finished() {
                Some(Carried::Over(Ended::Finished))
            } else {
                None
            };
            if over.is_some() || !out.is_empty() {
                break over;
            }
            state = shared.wait(state);
        };
        drop(state);
        if let Some(Carried::Over(Ended::Broken(_))) = &over {
            Frame::Abandon.encode(&mut out);
        }
        if !out.is_empty() && connection.write_all(&out).is_err() {
            break over.unwrap_or(Carried::Broken);
        }
        if let Some(over) = over {
            break over;
        }
    };
    // Ends the reader's wait too.
    let _ = connection.shutdown(Shutdown::Both);
    let _ = reader.join();
    carried
}

/// Reads the host's frames into the stream until the connection ends.
fn read_host(mut connection: impl Read, shared: &Shared) {
    let mut pending: Vec<u8> = Vec::with_capacity(2 * CHUNK);
    let mut buffer = vec![0; CHUNK + 16];
    loop {
        let read = match connection.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => 0,
            Ok(read) => read,
        };
        let mut state = shared.lock();
        if read == 0 {
            state.broken = true;
            shared.changed.notify_all();
            return;
        }
        pending.extend_from_slice(&buffer[..read]);
        let mut used = 0;
        let mut stop = false;
        loop {
            match Frame::decode(&pending[used..]) {
                Ok(Some((frame, length))) => {
                    used += length;
                    match state.stream.receive(&frame) {
                        Ok(Received::Taken) => {}
                        Ok(Received::Abandoned) => {
                            state.abandoned = true;
                            stop = true;
                            break;
                        }
                        Err(error) => {
                            state.error = Some(error.to_string());
                            stop = true;
                            break;
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    state.error = Some(error.to_string());
                    stop = true;
                    break;
                }
            }
        }
        shared.changed.notify_all();
        drop(state);
        if stop {
            return;
        }
        pending.drain(..used);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::mpsc;

    use super::super::wire::Hello;
    use super::*;

    const WAIT: Duration = Duration::from_secs(10);

    /// Both ends of a loopback connection: the agent's, and the relay's.
    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let near = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (far, _) = listener.accept().unwrap();
        (near, far)
    }

    /// Relays a new agent connection to the host at `host` on a thread:
    /// the agent's end, and how the relay ended.
    fn relaying(host: SocketAddr) -> (TcpStream, mpsc::Receiver<Ended>) {
        let (agent, local) = pair();
        agent.set_read_timeout(Some(WAIT)).unwrap();
        let (done, ended) = mpsc::channel();
        thread::spawn(move || {
            let ended = relay(local, StreamId(42), || TcpStream::connect(host), |_| {});
            let _ = done.send(ended);
        });
        (agent, ended)
    }

    /// The host's side of one connection, on [`Stream`].
    struct Host {
        connection: TcpStream,
        pending: Vec<u8>,
        cursor: u64,
    }

    impl Host {
        /// Takes the next connection, checks its hello and answers it. The
        /// guest may not yet have read all the agent wrote, so it may say
        /// it sent less than `want` does.
        fn accept(listener: &TcpListener, stream: &Stream, want: Hello) -> Self {
            let (connection, _) = listener.accept().unwrap();
            Self::answer(connection, stream, want)
        }

        /// Checks the hello on `connection` and answers it, as
        /// [`Host::accept`] does.
        fn answer(mut connection: TcpStream, stream: &Stream, want: Hello) -> Self {
            connection.set_nonblocking(false).unwrap();
            connection.set_read_timeout(Some(WAIT)).unwrap();
            let hello = Hello::parse(&read_line(&mut connection).unwrap()).unwrap();
            assert_eq!((hello.id, hello.received), (want.id, want.received));
            assert!(hello.sent <= want.sent, "{hello:?}, {want:?}");
            assert!(stream.resumes(&hello));
            let answer = Answer::Resumed {
                received: stream.received(),
            };
            connection.write_all(answer.line().as_bytes()).unwrap();
            Self {
                connection,
                pending: Vec::new(),
                cursor: stream.resume_from(hello.received).unwrap(),
            }
        }

        /// Reads frames into `stream` until `done` holds of it.
        fn read_until(&mut self, stream: &mut Stream, done: impl Fn(&Stream) -> bool) {
            let mut buffer = vec![0; CHUNK];
            while !done(stream) {
                let read = self.connection.read(&mut buffer).unwrap();
                assert!(read > 0, "the guest ended the connection");
                self.pending.extend_from_slice(&buffer[..read]);
                let mut used = 0;
                while let Some((frame, length)) = Frame::decode(&self.pending[used..]).unwrap() {
                    used += length;
                    assert_eq!(stream.receive(&frame), Ok(Received::Taken));
                }
                self.pending.drain(..used);
            }
        }

        /// Sends what `stream` has from the cursor on, and acknowledges
        /// what it handed on.
        fn send(&mut self, stream: &mut Stream) {
            let mut out = Vec::new();
            while let Some(next) = stream.next_frame(self.cursor, &mut out) {
                self.cursor = next;
            }
            stream.acknowledge(&mut out);
            self.connection.write_all(&out).unwrap();
        }
    }

    fn handed_on(stream: &mut Stream) -> Vec<u8> {
        let mut bytes = Vec::new();
        while let Some(Delivery::Bytes(more)) = stream.take(usize::MAX) {
            bytes.extend(more);
        }
        bytes
    }

    fn read_exactly(agent: &mut TcpStream, length: usize) -> Vec<u8> {
        let mut bytes = vec![0; length];
        agent.read_exact(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_stream_goes_on_over_another_connection_when_one_ends() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut agent, ended) = relaying(listener.local_addr().unwrap());
        let mut stream = Stream::new();
        let id = StreamId(42);

        agent.write_all(b"hello ").unwrap();
        let mut host = Host::accept(
            &listener,
            &stream,
            Hello {
                id,
                received: 0,
                sent: 6,
            },
        );
        host.read_until(&mut stream, |stream| stream.received() == 6);
        assert_eq!(handed_on(&mut stream), b"hello ");
        stream.push(b"reply-1");
        host.send(&mut stream);
        assert_eq!(read_exactly(&mut agent, 7), b"reply-1");

        // The connection ends under the stream, as at a snapshot; what the
        // agent sends meanwhile waits for the next.
        host.connection.shutdown(Shutdown::Both).unwrap();
        drop(host);
        agent.write_all(b"world").unwrap();
        let mut host = Host::accept(
            &listener,
            &stream,
            Hello {
                id,
                received: 7,
                sent: 11,
            },
        );
        host.read_until(&mut stream, |stream| stream.received() == 11);
        assert_eq!(handed_on(&mut stream), b"world", "each byte once");
        stream.push(b"reply-2");
        host.send(&mut stream);
        assert_eq!(read_exactly(&mut agent, 7), b"reply-2");

        // The agent hangs up; the host ends its direction too.
        drop(agent);
        host.read_until(&mut stream, |stream| stream.received() == 12);
        assert_eq!(stream.take(usize::MAX), Some(Delivery::End));
        stream.end();
        host.send(&mut stream);
        host.read_until(&mut stream, Stream::finished);
        assert_eq!(ended.recv_timeout(WAIT), Ok(Ended::Finished));
    }

    /// A host that takes a connection and never answers the hello holds
    /// the stream up only for [`ANSWER_WITHIN`]: the guest tries again,
    /// and the stream goes on.
    #[test]
    fn a_host_that_never_answers_is_tried_again() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut agent, _ended) = relaying(listener.local_addr().unwrap());
        let mut stream = Stream::new();
        let id = StreamId(42);
        agent.write_all(b"hello").unwrap();
        let want = Hello {
            id,
            received: 0,
            sent: 5,
        };
        let mut host = Host::accept(&listener, &stream, want);
        host.read_until(&mut stream, |stream| stream.received() == 5);
        assert_eq!(handed_on(&mut stream), b"hello");
        host.connection.shutdown(Shutdown::Both).unwrap();
        drop(host);

        let (silent, _) = listener.accept().unwrap();
        let taken = std::time::Instant::now();
        let mut host = Host::accept(&listener, &stream, want);
        assert!(
            taken.elapsed() >= ANSWER_WITHIN / 2,
            "it waited for an answer"
        );
        drop(silent);
        stream.push(b"reply");
        host.send(&mut stream);
        assert_eq!(read_exactly(&mut agent, 5), b"reply");
    }

    /// A host that answers a byte at a time, each in less than
    /// [`ANSWER_WITHIN`] but all of it in more, is held to the same bound:
    /// the guest tries again rather than taking its slow `gone`, and the
    /// stream goes on.
    #[test]
    fn a_host_that_answers_too_slowly_is_tried_again() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut agent, ended) = relaying(listener.local_addr().unwrap());
        let mut stream = Stream::new();
        let id = StreamId(42);
        agent.write_all(b"hello").unwrap();
        let want = Hello {
            id,
            received: 0,
            sent: 5,
        };
        let mut host = Host::accept(&listener, &stream, want);
        host.read_until(&mut stream, |stream| stream.received() == 5);
        assert_eq!(handed_on(&mut stream), b"hello");
        host.connection.shutdown(Shutdown::Both).unwrap();
        drop(host);

        let (mut slow, _) = listener.accept().unwrap();
        slow.set_read_timeout(Some(WAIT)).unwrap();
        read_line(&mut slow).unwrap();
        let trickle = thread::spawn(move || {
            for byte in Answer::Gone.line().bytes() {
                thread::sleep(ANSWER_WITHIN / 3);
                if slow.write_all(&[byte]).is_err() {
                    return;
                }
            }
        });
        // Were the slow `gone` taken, the stream would end and nothing
        // would connect again.
        listener.set_nonblocking(true).unwrap();
        let started = Instant::now();
        let connection = loop {
            assert_ne!(
                ended.try_recv(),
                Ok(Ended::Gone),
                "the guest took an answer that came too slowly"
            );
            assert!(started.elapsed() < WAIT, "the guest did not connect again");
            match listener.accept() {
                Ok((connection, _)) => break connection,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("{error}"),
            }
            thread::sleep(Duration::from_millis(20));
        };
        let mut host = Host::answer(connection, &stream, want);
        stream.push(b"reply");
        host.send(&mut stream);
        assert_eq!(read_exactly(&mut agent, 5), b"reply");
        trickle.join().unwrap();
    }

    #[test]
    fn a_host_with_no_such_stream_ends_the_agents_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut agent, ended) = relaying(listener.local_addr().unwrap());
        let (mut connection, _) = listener.accept().unwrap();
        read_line(&mut connection).unwrap();
        connection
            .write_all(Answer::Gone.line().as_bytes())
            .unwrap();
        assert_eq!(ended.recv_timeout(WAIT), Ok(Ended::Gone));
        let mut rest = Vec::new();
        assert_eq!(agent.read_to_end(&mut rest).unwrap(), 0);
    }

    #[test]
    fn a_host_out_of_reach_when_the_stream_begins_ends_it_at_once() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = listener.local_addr().unwrap();
        drop(listener);
        let (mut agent, ended) = relaying(host);
        assert!(matches!(
            ended.recv_timeout(WAIT),
            Ok(Ended::Unreachable(_))
        ));
        let mut rest = Vec::new();
        assert_eq!(agent.read_to_end(&mut rest).unwrap(), 0);
    }

    #[test]
    fn a_host_that_breaks_the_protocol_has_the_stream_given_up() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut agent, ended) = relaying(listener.local_addr().unwrap());
        let (mut connection, _) = listener.accept().unwrap();
        read_line(&mut connection).unwrap();
        connection.write_all(b"ok 0\n").unwrap();
        let mut gap = Vec::new();
        Frame::Data {
            offset: 5,
            bytes: b"x",
        }
        .encode(&mut gap);
        connection.write_all(&gap).unwrap();
        assert!(matches!(ended.recv_timeout(WAIT), Ok(Ended::Broken(_))));
        let mut said = Vec::new();
        connection.read_to_end(&mut said).unwrap();
        assert_eq!(said.last(), Some(&b'X'), "told the host it gave up");
        let mut rest = Vec::new();
        assert_eq!(agent.read_to_end(&mut rest).unwrap(), 0);
    }
}
