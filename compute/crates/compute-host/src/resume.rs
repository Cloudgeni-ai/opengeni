//! The host's side of the guest's resumable agent-link streams (see
//! [`compute_guest::resume`]).
//!
//! Each stream the guest opens gets its own end of an in-memory duplex,
//! whose other end goes to the hub as one guest connection, for as long as
//! the stream lasts: the vsock connections that carry it may end and be
//! replaced, and the hub sees none of that. One task reads the hub's end
//! into the stream and one writes to it; each connection that carries the
//! stream has a task reading its frames and one writing them, so a write
//! that waits on a paused VM holds up nothing else, and a new connection
//! replaces it at once.
//!
//! A stream ends when both directions did and each end was acknowledged,
//! when either side gives it up, and when the guest's counts cannot be put
//! together with the host's: the guest's next hello is then answered
//! `gone`. The host keeps its streams in memory only, so after a restart
//! of the host agent every stream is gone too, as is any after the sandbox
//! moves to another host. A stream that no connection carries, and that
//! the guest does not take up again within [`TAKE_UP`] after taking up
//! another of the sandbox's streams, is one the guest no longer has, as
//! after a restore from a checkpoint older than it: it ends too, so the
//! hub does not keep a connection no agent holds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use compute_guest::resume::stream::Received;
use compute_guest::resume::{Answer, CHUNK, Delivery, Frame, Hello, LINE_MAX, Stream, StreamId};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use tokio::time::Instant;

/// How long a guest has to say hello on a new connection.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// How long after the guest takes up one of a sandbox's streams again a
/// stream no connection carries may still be taken up. The guest connects
/// again within milliseconds of a connection ending, for every stream it
/// has, as soon as it runs.
pub(crate) const TAKE_UP: Duration = Duration::from_secs(10);

/// Bytes buffered between a stream and the hub, each way.
const HUB_BUFFER: usize = 64 << 10;

/// One sandbox's streams.
pub(crate) struct Streams<F> {
    inner: Arc<Inner<F>>,
}

impl<F> Clone for Streams<F> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<F> std::fmt::Debug for Streams<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Streams")
            .field("streams", &self.inner.lock().streams.len())
            .finish_non_exhaustive()
    }
}

struct Inner<F> {
    /// Hands a new stream's hub end to the hub.
    serve: F,
    /// Streams the sandbox may have at once.
    limit: usize,
    take_up: Duration,
    map: Mutex<Map>,
}

#[derive(Default)]
struct Map {
    streams: HashMap<StreamId, Entry>,
    /// Whether a sweep for streams not taken up again is waiting, and the
    /// latest take-up since it began waiting.
    sweeping: bool,
    next_sweep: Option<Instant>,
}

struct Entry {
    shared: Arc<Shared>,
    /// Reading and writing the hub's end.
    _hub: Tasks,
    /// Reading and writing the connection that carries it, if one does.
    carrier: Tasks,
}

/// Tasks that end with their owner.
#[derive(Default)]
struct Tasks(Vec<AbortHandle>);

impl Drop for Tasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

struct Shared {
    state: Mutex<State>,
    /// Bumped whenever the state changes; every task waits on it.
    changed: watch::Sender<()>,
}

#[derive(Default)]
struct State {
    stream: Stream,
    /// The number of the connection that carries the stream, and whether
    /// it still does.
    carrier: u64,
    carried: bool,
    /// Since when no connection carries it.
    uncarried_since: Option<Instant>,
    /// The guest gave the stream up, or did not keep the protocol.
    over: Option<Over>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Over {
    Abandoned,
    Broken,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn changed(&self) {
        self.changed.send_replace(());
    }

    /// Connection `carrier` ended under the stream.
    fn uncarried(&self, carrier: u64) {
        let mut state = self.lock();
        if state.carrier == carrier && state.carried {
            state.carried = false;
            state.uncarried_since = Some(Instant::now());
        }
        drop(state);
        self.changed();
    }
}

impl<F> Inner<F> {
    fn lock(&self) -> MutexGuard<'_, Map> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Ends stream `id`, if `inner` and it are still there: its tasks with it.
fn forget<F>(inner: &Weak<Inner<F>>, id: StreamId) {
    if let Some(inner) = inner.upgrade() {
        let entry = inner.lock().streams.remove(&id);
        drop(entry);
    }
}

impl<F> Streams<F>
where
    F: Fn(DuplexStream) + Send + Sync + 'static,
{
    /// A sandbox's streams, each handed to `serve` when it begins; at most
    /// `limit` at once.
    pub(crate) fn new(serve: F, limit: usize, take_up: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                serve,
                limit,
                take_up,
                map: Mutex::new(Map::default()),
            }),
        }
    }

    /// Takes a new connection from the guest: reads its hello, and either
    /// has it carry its stream or answers `gone` and closes it.
    pub(crate) async fn take<C>(self, mut connection: C)
    where
        C: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_line(&mut connection)).await {
            Ok(Ok(line)) => Hello::parse(&line),
            Ok(Err(_)) | Err(_) => None,
        };
        let Some(hello) = hello else {
            tracing::warn!("an agent-link connection did not say hello; closing it");
            return;
        };
        self.carry(&hello, connection);
    }

    /// Has the connection that said `hello` carry its stream, starting it if
    /// new, or tells the guest on it that the stream is gone.
    fn carry<C>(&self, hello: &Hello, connection: C)
    where
        C: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let now = Instant::now();
        let mut map = self.inner.lock();
        let resumes = map
            .streams
            .get(&hello.id)
            .map(|entry| entry.shared.lock().stream.resumes(hello));
        match resumes {
            Some(true) => {}
            Some(false) => {
                // Restored from before what the host already took, or not
                // keeping count: the hub's end goes with the stream.
                tracing::info!(stream = %hello.id, "an agent-link stream cannot go on; ending it");
                map.streams.remove(&hello.id);
                drop(map);
                tokio::spawn(gone(connection));
                return;
            }
            None if hello.received > 0 || map.streams.len() >= self.inner.limit => {
                tracing::debug!(stream = %hello.id, "an agent-link stream the host does not have");
                drop(map);
                tokio::spawn(gone(connection));
                return;
            }
            None => {
                let entry = self.start(hello.id);
                map.streams.insert(hello.id, entry);
            }
        }
        let Some(entry) = map.streams.get_mut(&hello.id) else {
            return;
        };
        let shared = Arc::clone(&entry.shared);
        let (carrier, answer, cursor) = {
            let mut state = shared.lock();
            state.carrier += 1;
            state.carried = true;
            state.uncarried_since = None;
            let answer = Answer::Resumed {
                received: state.stream.received(),
            };
            let cursor = state
                .stream
                .resume_from(hello.received)
                .unwrap_or(hello.received);
            (state.carrier, answer, cursor)
        };
        let (reading, writing) = tokio::io::split(connection);
        let weak = Arc::downgrade(&self.inner);
        let reader = tokio::spawn(read_frames(
            reading,
            Arc::clone(&shared),
            carrier,
            weak.clone(),
            hello.id,
        ));
        let writer = tokio::spawn(write_frames(
            writing,
            answer.line(),
            cursor,
            Arc::clone(&shared),
            carrier,
            weak,
            hello.id,
        ));
        // Replacing them ends the connection that carried it before.
        entry.carrier = Tasks(vec![reader.abort_handle(), writer.abort_handle()]);
        shared.changed();
        self.sweep_later(&mut map, now);
    }

    /// A new stream, its hub end handed to the hub.
    fn start(&self, id: StreamId) -> Entry {
        let (near, far) = tokio::io::duplex(HUB_BUFFER);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: watch::channel(()).0,
        });
        let (reading, writing) = tokio::io::split(near);
        let reader = tokio::spawn(read_hub(reading, Arc::clone(&shared)));
        let writer = tokio::spawn(write_hub(writing, Arc::clone(&shared)));
        tracing::debug!(stream = %id, "an agent-link stream begins");
        (self.inner.serve)(far);
        Entry {
            shared,
            _hub: Tasks(vec![reader.abort_handle(), writer.abort_handle()]),
            carrier: Tasks::default(),
        }
    }

    /// After a take-up at `now`, ends the streams that were not carried
    /// then and are not taken up within [`TAKE_UP`].
    fn sweep_later(&self, map: &mut Map, now: Instant) {
        if map.sweeping {
            map.next_sweep = Some(now);
            return;
        }
        map.sweeping = true;
        tokio::spawn(sweep(Arc::downgrade(&self.inner), now));
    }
}

async fn sweep<F>(inner: Weak<Inner<F>>, mut since: Instant) {
    loop {
        let Some(take_up) = inner.upgrade().map(|inner| inner.take_up) else {
            return;
        };
        tokio::time::sleep_until(since + take_up).await;
        let Some(strong) = inner.upgrade() else {
            return;
        };
        let mut map = strong.lock();
        let before = map.streams.len();
        map.streams.retain(|_, entry| {
            entry
                .shared
                .lock()
                .uncarried_since
                .is_none_or(|uncarried| uncarried > since)
        });
        let ended = before - map.streams.len();
        if ended > 0 {
            tracing::info!(ended, "agent-link streams the guest no longer has ended");
        }
        let Some(next) = map.next_sweep.take() else {
            map.sweeping = false;
            return;
        };
        since = next;
    }
}

/// Answers `gone` on `connection` and closes it.
async fn gone<C: AsyncWrite + Unpin>(mut connection: C) {
    let _ = connection.write_all(Answer::Gone.line().as_bytes()).await;
    let _ = connection.shutdown().await;
}

/// One line, read a byte at a time so nothing after it is taken.
async fn read_line<C: AsyncRead + Unpin>(connection: &mut C) -> std::io::Result<String> {
    let mut line = Vec::with_capacity(64);
    while line.len() < LINE_MAX {
        let byte = connection.read_u8().await?;
        line.push(byte);
        if byte == b'\n' {
            return String::from_utf8(line).map_err(|_| std::io::ErrorKind::InvalidData.into());
        }
    }
    Err(std::io::ErrorKind::InvalidData.into())
}

/// Reads the hub's end into the stream, within its window.
async fn read_hub(mut hub: impl AsyncRead + Unpin, shared: Arc<Shared>) {
    let mut buffer = vec![0; CHUNK];
    let mut changes = shared.changed.subscribe();
    loop {
        changes.borrow_and_update();
        let room = shared.lock().stream.room();
        if room == 0 {
            if changes.changed().await.is_err() {
                return;
            }
            continue;
        }
        let read = hub.read(&mut buffer[..room.min(CHUNK)]).await;
        let mut state = shared.lock();
        match read {
            Ok(read) if read > 0 => state.stream.push(&buffer[..read]),
            _ => {
                state.stream.end();
                drop(state);
                shared.changed();
                return;
            }
        }
        drop(state);
        shared.changed();
    }
}

/// Writes what the stream received to the hub's end, and ends its writing
/// when the guest's direction ends.
async fn write_hub(mut hub: impl AsyncWrite + Unpin, shared: Arc<Shared>) {
    let mut changes = shared.changed.subscribe();
    let mut gone = false;
    loop {
        changes.borrow_and_update();
        let delivery = shared.lock().stream.take(CHUNK);
        match delivery {
            None => {
                if changes.changed().await.is_err() {
                    return;
                }
            }
            Some(Delivery::Bytes(bytes)) => {
                // Taken is acknowledged: the writer sends it.
                shared.changed();
                gone = gone || hub.write_all(&bytes).await.is_err();
            }
            Some(Delivery::End) => {
                shared.changed();
                let _ = hub.shutdown().await;
                return;
            }
        }
    }
}

/// Reads the guest's frames on connection `carrier` into the stream until
/// the connection ends.
async fn read_frames<C, F>(
    mut connection: C,
    shared: Arc<Shared>,
    carrier: u64,
    inner: Weak<Inner<F>>,
    id: StreamId,
) where
    C: AsyncRead + Unpin,
{
    let mut pending: Vec<u8> = Vec::with_capacity(2 * CHUNK);
    let mut buffer = vec![0; CHUNK + 16];
    loop {
        let read = match connection.read(&mut buffer).await {
            Ok(read) if read > 0 => read,
            _ => {
                shared.uncarried(carrier);
                return;
            }
        };
        pending.extend_from_slice(&buffer[..read]);
        let mut used = 0;
        let mut state = shared.lock();
        let over = loop {
            match Frame::decode(&pending[used..]) {
                Ok(Some((frame, length))) => {
                    used += length;
                    match state.stream.receive(&frame) {
                        Ok(Received::Taken) => {}
                        Ok(Received::Abandoned) => break Some(Over::Abandoned),
                        Err(error) => {
                            tracing::warn!(stream = %id, %error, "an agent-link stream broke the protocol; ending it");
                            break Some(Over::Broken);
                        }
                    }
                }
                Ok(None) => break None,
                Err(error) => {
                    tracing::warn!(stream = %id, %error, "an agent-link stream broke the protocol; ending it");
                    break Some(Over::Broken);
                }
            }
        };
        state.over = state.over.or(over);
        drop(state);
        shared.changed();
        if over == Some(Over::Abandoned) {
            forget(&inner, id);
            return;
        }
        if over.is_some() {
            // The writer tells the guest, then ends the stream.
            return;
        }
        pending.drain(..used);
    }
}

/// Writes `answer`, then what the guest lacks from `cursor` on, on
/// connection `carrier`, until it ends, another replaces it, or the stream
/// ends.
async fn write_frames<C, F>(
    mut connection: C,
    answer: String,
    mut cursor: u64,
    shared: Arc<Shared>,
    carrier: u64,
    inner: Weak<Inner<F>>,
    id: StreamId,
) where
    C: AsyncWrite + Unpin,
{
    if connection.write_all(answer.as_bytes()).await.is_err() {
        shared.uncarried(carrier);
        return;
    }
    let mut changes = shared.changed.subscribe();
    let mut out = Vec::with_capacity(2 * CHUNK);
    loop {
        changes.borrow_and_update();
        out.clear();
        let (over, finished) = {
            let mut state = shared.lock();
            if state.carrier != carrier || !state.carried {
                return;
            }
            while out.len() < CHUNK {
                match state.stream.next_frame(cursor, &mut out) {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
            state.stream.acknowledge(&mut out);
            (state.over, state.stream.finished())
        };
        if over == Some(Over::Broken) {
            Frame::Abandon.encode(&mut out);
        }
        if !out.is_empty() && connection.write_all(&out).await.is_err() {
            shared.uncarried(carrier);
            return;
        }
        if over.is_some() || finished {
            let _ = connection.shutdown().await;
            if finished {
                tracing::debug!(stream = %id, "an agent-link stream ended");
            }
            forget(&inner, id);
            return;
        }
        if out.is_empty() && changes.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream as Socket;
    use std::path::{Path, PathBuf};

    use compute_guest::resume::relay::{Ended, relay};
    use tokio::net::UnixListener;
    use tokio::sync::mpsc;
    use tokio::task::{JoinHandle, JoinSet};

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);

    /// A sandbox's streams behind a socket, and the hub ends they begin.
    struct Rig {
        socket: PathBuf,
        hub: mpsc::UnboundedReceiver<DuplexStream>,
        _dir: tempfile::TempDir,
        accept: JoinHandle<()>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.accept.abort();
        }
    }

    fn rig(limit: usize, take_up: Duration) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("link.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (began, hub) = mpsc::unbounded_channel();
        let streams = Streams::new(
            move |end| {
                let _ = began.send(end);
            },
            limit,
            take_up,
        );
        let accept = tokio::spawn(async move {
            let mut hellos = JoinSet::new();
            loop {
                let (connection, _) = listener.accept().await.unwrap();
                hellos.spawn(streams.clone().take(connection));
            }
        });
        Rig {
            socket,
            hub,
            _dir: dir,
            accept,
        }
    }

    impl Rig {
        async fn next_stream(&mut self) -> DuplexStream {
            tokio::time::timeout(WAIT, self.hub.recv())
                .await
                .expect("no stream began")
                .unwrap()
        }
    }

    /// The guest's relay of an agent connection on a thread, its dialed
    /// connections kept so a test can end them as a snapshot does.
    struct Guest {
        agent: Socket,
        dialed: Arc<Mutex<Vec<Socket>>>,
        ended: std::sync::mpsc::Receiver<Ended>,
    }

    impl Guest {
        fn start(socket: &Path, id: u128) -> Self {
            let (agent, local) = Socket::pair().unwrap();
            agent.set_read_timeout(Some(WAIT)).unwrap();
            let dialed = Arc::new(Mutex::new(Vec::new()));
            let (done, ended) = std::sync::mpsc::channel();
            let (socket, kept) = (socket.to_path_buf(), Arc::clone(&dialed));
            std::thread::spawn(move || {
                let ended = relay(
                    local,
                    StreamId(id),
                    || {
                        let connection = Socket::connect(&socket)?;
                        kept.lock().unwrap().push(connection.try_clone()?);
                        Ok(connection)
                    },
                    |_| {},
                );
                let _ = done.send(ended);
            });
            Self {
                agent,
                dialed,
                ended,
            }
        }

        /// Ends every connection under the stream, as a snapshot does.
        fn reset(&self) {
            for connection in self.dialed.lock().unwrap().drain(..) {
                let _ = connection.shutdown(Shutdown::Both);
            }
        }
    }

    async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
        tokio::task::spawn_blocking(work).await.unwrap()
    }

    async fn read_exactly(end: &mut DuplexStream, length: usize) -> Vec<u8> {
        let mut bytes = vec![0; length];
        tokio::time::timeout(WAIT, end.read_exact(&mut bytes))
            .await
            .expect("the hub end got nothing")
            .unwrap();
        bytes
    }

    async fn ends_within(end: &mut DuplexStream, limit: Duration) -> bool {
        let mut rest = Vec::new();
        matches!(
            tokio::time::timeout(limit, end.read_to_end(&mut rest)).await,
            Ok(Ok(_))
        )
    }

    /// A guest connection that speaks the protocol by hand, and the answer
    /// to its hello.
    fn raw(socket: &Path, hello: &Hello) -> (Socket, String) {
        let mut connection = Socket::connect(socket).unwrap();
        connection.set_read_timeout(Some(WAIT)).unwrap();
        connection.write_all(hello.line().as_bytes()).unwrap();
        let mut line = Vec::new();
        let mut byte = [0];
        while connection.read(&mut byte).unwrap() == 1 {
            line.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        (connection, String::from_utf8(line).unwrap())
    }

    async fn raw_hello(rig: &Rig, id: u128, received: u64, sent: u64) -> (Socket, String) {
        let socket = rig.socket.clone();
        let hello = Hello {
            id: StreamId(id),
            received,
            sent,
        };
        blocking(move || raw(&socket, &hello)).await
    }

    fn data(offset: u64, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        Frame::Data { offset, bytes }.encode(&mut out);
        out
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stream_outlives_the_connections_under_it_and_the_hub_sees_one() {
        let mut rig = rig(4, TAKE_UP);
        let guest = Guest::start(&rig.socket, 1);
        let mut agent = guest.agent.try_clone().unwrap();
        blocking(move || agent.write_all(b"CONNECT {}\r\nPING\r\n").unwrap()).await;
        let mut end = rig.next_stream().await;
        assert_eq!(read_exactly(&mut end, 18).await, b"CONNECT {}\r\nPING\r\n");

        // A snapshot ends the connection; what the agent and the hub send
        // crosses on the next one, each byte once, and no stream begins.
        for round in 0..3_u8 {
            guest.reset();
            let mut agent = guest.agent.try_clone().unwrap();
            let sent = vec![b'a' + round; 300_000];
            let expected = sent.clone();
            blocking(move || agent.write_all(&sent).unwrap()).await;
            assert_eq!(read_exactly(&mut end, 300_000).await, expected);
            let reply = vec![b'z' - round; 70_000];
            end.write_all(&reply).await.unwrap();
            let mut agent = guest.agent.try_clone().unwrap();
            let got = blocking(move || {
                let mut got = vec![0; 70_000];
                agent.read_exact(&mut got).unwrap();
                got
            })
            .await;
            assert_eq!(got, reply);
        }
        assert!(rig.hub.try_recv().is_err(), "one stream throughout");

        // The agent hangs up, then the hub: the stream finishes.
        guest.agent.shutdown(Shutdown::Write).unwrap();
        assert!(ends_within(&mut end, WAIT).await);
        drop(end);
        let ended = blocking(move || guest.ended.recv_timeout(WAIT)).await;
        assert_eq!(ended, Ok(Ended::Finished));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_guest_the_host_cannot_go_on_with_is_told_gone_and_the_hub_end_closes() {
        let mut rig = rig(4, TAKE_UP);
        let (mut connection, answer) = raw_hello(&rig, 7, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        connection.write_all(&data(0, b"abc")).unwrap();
        let mut end = rig.next_stream().await;
        assert_eq!(read_exactly(&mut end, 3).await, b"abc");

        // Restored from before it sent "abc": the host cannot take it back.
        let (_, answer) = raw_hello(&rig, 7, 0, 1).await;
        assert_eq!(answer, "gone\n");
        assert!(ends_within(&mut end, WAIT).await, "the hub's end went too");

        // A stream the host never had, with something received, is gone.
        let (_, answer) = raw_hello(&rig, 8, 5, 5).await;
        assert_eq!(answer, "gone\n");
        assert!(rig.hub.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn streams_not_taken_up_again_end_and_those_taken_up_go_on() {
        let take_up = Duration::from_millis(300);
        let mut rig = rig(4, take_up);
        let mut ends = Vec::new();
        for id in [1, 2] {
            let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
            assert_eq!(answer, "ok 0\n");
            ends.push(rig.next_stream().await);
            drop(connection);
        }
        let (mut kept, answer) = raw_hello(&rig, 1, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        let mut not_taken_up = ends.pop().unwrap();
        let mut resumed = ends.pop().unwrap();
        assert!(ends_within(&mut not_taken_up, take_up * 10).await);
        resumed.write_all(b"still").await.unwrap();
        let frame = blocking(move || {
            let mut frame = vec![0; 13 + 5];
            kept.read_exact(&mut frame).unwrap();
            frame
        })
        .await;
        assert_eq!(frame, data(0, b"still"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sandbox_may_hold_only_so_many_streams() {
        let mut rig = rig(2, TAKE_UP);
        let mut held = Vec::new();
        for id in 1..=3 {
            let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
            assert_eq!(answer, if id <= 2 { "ok 0\n" } else { "gone\n" });
            held.push(connection);
        }
        rig.next_stream().await;
        rig.next_stream().await;
        assert!(rig.hub.try_recv().is_err());
    }
}
