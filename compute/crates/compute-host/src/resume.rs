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
//! hub does not keep a connection no agent holds. [`TAKE_UP`] counts only
//! time in which the guest could run ([`RunClock`]): a guest paused just
//! after taking one stream up has all of it, once it runs again, for the
//! others.
//!
//! A new connection takes the stream over at once, under the stream's
//! lock, from the one before: what the connection before still reads goes
//! nowhere, so it can neither add to the stream nor end it.

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
/// has, as soon as it runs; the time counts on the sandbox's [`RunClock`].
pub(crate) const TAKE_UP: Duration = Duration::from_secs(10);

/// Bytes buffered between a stream and the hub, each way.
const HUB_BUFFER: usize = 64 << 10;

/// Time in which a sandbox's guest could run, which the host agent counts
/// by telling it when the guest can and cannot (see [`RunClock::set`]):
/// the guest takes its streams up again only while it runs, so time it
/// spends paused, saved or frozen proves nothing about which it has.
#[derive(Clone, Debug, Default)]
pub(crate) struct RunClock {
    inner: Arc<ClockInner>,
}

#[derive(Debug, Default)]
struct ClockInner {
    state: Mutex<Ran>,
    changed: tokio::sync::Notify,
}

/// What the clock counted before the guest last began to run, and since
/// when it runs, if it does.
#[derive(Debug, Default, Clone, Copy)]
struct Ran {
    before: Duration,
    since: Option<Instant>,
}

impl Ran {
    fn now(self) -> Duration {
        self.before + self.since.map_or(Duration::ZERO, |since| since.elapsed())
    }
}

impl RunClock {
    /// A clock of a guest that runs from now on, as tests use.
    #[cfg(test)]
    fn running() -> Self {
        let clock = Self::default();
        clock.set(true);
        clock
    }

    fn lock(&self) -> MutexGuard<'_, Ran> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the guest can run from now on.
    pub(crate) fn set(&self, runs: bool) {
        let mut ran = self.lock();
        match (runs, ran.since) {
            (true, None) => ran.since = Some(Instant::now()),
            (false, Some(_)) => {
                *ran = Ran {
                    before: ran.now(),
                    since: None,
                }
            }
            _ => return,
        }
        drop(ran);
        self.inner.changed.notify_waiters();
    }

    /// The time the guest could run so far.
    fn now(&self) -> Duration {
        self.lock().now()
    }

    /// Returns once the guest could run for `at` in all.
    async fn reaches(&self, at: Duration) {
        loop {
            let changed = self.inner.changed.notified();
            let ran = *self.lock();
            let now = ran.now();
            if now >= at {
                return;
            }
            match ran.since {
                Some(_) => {
                    tokio::select! {
                        () = tokio::time::sleep(at.saturating_sub(now)) => {}
                        () = changed => {}
                    }
                }
                None => changed.await,
            }
        }
    }
}

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
    clock: RunClock,
    map: Mutex<Map>,
}

#[derive(Default)]
struct Map {
    streams: HashMap<StreamId, Entry>,
    /// Whether a sweep for streams not taken up again is waiting, and the
    /// latest take-up since it began waiting, on the sandbox's clock.
    sweeping: bool,
    next_sweep: Option<Duration>,
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
    /// Since when, on the sandbox's clock, no connection carries it.
    uncarried_since: Option<Duration>,
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

    /// Connection `carrier` ended under the stream at `now` on the
    /// sandbox's clock.
    fn uncarried(&self, carrier: u64, now: Duration) {
        let mut state = self.lock();
        if state.carrier == carrier && state.carried {
            state.carried = false;
            state.uncarried_since = Some(now);
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

/// Connection `carrier` ended under the stream `shared`, if `inner` is
/// still there.
fn uncarried<F>(inner: &Weak<Inner<F>>, shared: &Shared, carrier: u64) {
    if let Some(inner) = inner.upgrade() {
        shared.uncarried(carrier, inner.clock.now());
    }
}

/// Ends stream `id` as connection `carrier` saw it end, if `inner` and it
/// are still there, it is still `shared`, not another under the same id,
/// and no connection took it over since: one that did sees the end
/// itself, and tells the guest. Its tasks end with it.
fn forget<F>(inner: &Weak<Inner<F>>, id: StreamId, shared: &Arc<Shared>, carrier: u64) {
    if let Some(inner) = inner.upgrade() {
        let mut map = inner.lock();
        let entry = map
            .streams
            .get(&id)
            .is_some_and(|entry| {
                Arc::ptr_eq(&entry.shared, shared) && shared.lock().carrier == carrier
            })
            .then(|| map.streams.remove(&id));
        drop(map);
        drop(entry);
    }
}

impl<F> Streams<F>
where
    F: Fn(DuplexStream) + Send + Sync + 'static,
{
    /// A sandbox's streams, each handed to `serve` when it begins; at most
    /// `limit` at once. `clock` counts the time its guest could run.
    pub(crate) fn new(serve: F, limit: usize, take_up: Duration, clock: RunClock) -> Self {
        Self {
            inner: Arc::new(Inner {
                serve,
                limit,
                take_up,
                clock,
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
    /// new, or tells the guest on it that the stream is gone. A guest that
    /// connects runs, so a take-up's sweep starts either way: the streams
    /// it no longer has end even with the sandbox at its limit, and a new
    /// stream is let in once they have.
    fn carry<C>(&self, hello: &Hello, connection: C)
    where
        C: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let now = self.inner.clock.now();
        let mut map = self.inner.lock();
        if !map.streams.contains_key(&hello.id) {
            if hello.received > 0 || map.streams.len() >= self.inner.limit {
                tracing::debug!(stream = %hello.id, "an agent-link stream the host does not have");
                self.sweep_later(&mut map, now);
                drop(map);
                tokio::spawn(gone(connection));
                return;
            }
            let entry = self.start(hello.id);
            map.streams.insert(hello.id, entry);
        }
        let Some(entry) = map.streams.get_mut(&hello.id) else {
            return;
        };
        let shared = Arc::clone(&entry.shared);
        // Checked and taken over in one step: from here on the connection
        // before reads nothing into the stream (see `read_frames`).
        let taken = {
            let mut state = shared.lock();
            match state.stream.resume_from(hello.received) {
                Some(cursor) if state.over.is_none() && state.stream.resumes(hello) => {
                    state.carrier += 1;
                    state.carried = true;
                    state.uncarried_since = None;
                    state.stream.carried_anew();
                    let answer = Answer::Resumed {
                        received: state.stream.received(),
                    };
                    Some((state.carrier, answer, cursor))
                }
                _ => None,
            }
        };
        let Some((carrier, answer, cursor)) = taken else {
            // Restored from before what the host already took, not keeping
            // count, or already ending: the hub's end goes with the stream.
            tracing::info!(stream = %hello.id, "an agent-link stream cannot go on; ending it");
            map.streams.remove(&hello.id);
            drop(map);
            tokio::spawn(gone(connection));
            return;
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
    /// then and are not taken up within [`TAKE_UP`] of the guest's running.
    fn sweep_later(&self, map: &mut Map, now: Duration) {
        if map.sweeping {
            map.next_sweep = Some(now);
            return;
        }
        map.sweeping = true;
        tokio::spawn(sweep(Arc::downgrade(&self.inner), now));
    }
}

async fn sweep<F>(inner: Weak<Inner<F>>, mut since: Duration) {
    loop {
        let Some((take_up, clock)) = inner
            .upgrade()
            .map(|inner| (inner.take_up, inner.clock.clone()))
        else {
            return;
        };
        clock.reaches(since + take_up).await;
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
/// the connection ends, or another takes the stream over: what it reads
/// after that goes nowhere.
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
                uncarried(&inner, &shared, carrier);
                return;
            }
        };
        pending.extend_from_slice(&buffer[..read]);
        let mut used = 0;
        let mut state = shared.lock();
        if state.carrier != carrier {
            return;
        }
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
            forget(&inner, id, &shared, carrier);
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
        uncarried(&inner, &shared, carrier);
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
            uncarried(&inner, &shared, carrier);
            return;
        }
        if over.is_some() || finished {
            let _ = connection.shutdown().await;
            if finished {
                tracing::debug!(stream = %id, "an agent-link stream ended");
            }
            forget(&inner, id, &shared, carrier);
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

    type Serve = Box<dyn Fn(DuplexStream) + Send + Sync>;

    /// A sandbox's streams behind a socket, and the hub ends they begin.
    struct Rig {
        socket: PathBuf,
        hub: mpsc::UnboundedReceiver<DuplexStream>,
        streams: Streams<Serve>,
        clock: RunClock,
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
        let clock = RunClock::running();
        let streams = Streams::new(
            Box::new(move |end| {
                let _ = began.send(end);
            }) as Serve,
            limit,
            take_up,
            clock.clone(),
        );
        let serving = streams.clone();
        let accept = tokio::spawn(async move {
            let mut hellos = JoinSet::new();
            loop {
                let (connection, _) = listener.accept().await.unwrap();
                hellos.spawn(serving.clone().take(connection));
            }
        });
        Rig {
            socket,
            hub,
            streams,
            clock,
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

    /// The next frame on a raw guest connection.
    fn next_frame(connection: &mut Socket) -> Vec<u8> {
        let mut pending = Vec::new();
        let mut buffer = vec![0; CHUNK + 16];
        loop {
            if let Some((_, length)) = Frame::decode(&pending).unwrap() {
                pending.truncate(length);
                return pending;
            }
            let read = connection.read(&mut buffer).unwrap();
            assert!(read > 0, "the host ended the connection");
            pending.extend_from_slice(&buffer[..read]);
        }
    }

    fn ack(through: u64) -> Vec<u8> {
        let mut out = Vec::new();
        Frame::Ack(through).encode(&mut out);
        out
    }

    /// A guest whose window is full sends nothing more until it hears an
    /// acknowledgement, so the host repeats on a new connection the one
    /// it may have lost with the connection before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_acknowledgement_lost_with_its_connection_is_repeated_on_the_next() {
        const WINDOW: u64 = compute_guest::resume::stream::WINDOW as u64;
        let mut rig = rig(4, TAKE_UP);
        let (mut connection, answer) = raw_hello(&rig, 9, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        let writing = tokio::task::spawn_blocking(move || {
            let mut offset = 0;
            while offset < WINDOW {
                let length = CHUNK.min(usize::try_from(WINDOW - offset).unwrap());
                connection
                    .write_all(&data(offset, &vec![7; length]))
                    .unwrap();
                offset += length as u64;
            }
            connection
        });
        let mut end = rig.next_stream().await;
        let window = usize::try_from(WINDOW).unwrap();
        assert_eq!(read_exactly(&mut end, window).await, vec![7; window]);
        // The connection ends before the guest reads the acknowledgement.
        writing.await.unwrap().shutdown(Shutdown::Both).unwrap();

        let (mut connection, answer) = raw_hello(&rig, 9, 0, WINDOW).await;
        assert_eq!(answer, format!("ok {WINDOW}\n"));
        let frame = blocking(move || next_frame(&mut connection)).await;
        assert_eq!(frame, ack(WINDOW));
    }

    /// A connection another took the stream over from reads nothing more
    /// into it, whatever it still has: aborting its task is no fence, as
    /// the task may be past its last wait.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_connection_taken_over_reads_nothing_more_into_the_stream() {
        let mut rig = rig(4, TAKE_UP);
        let (first, answer) = raw_hello(&rig, 10, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        let mut end = rig.next_stream().await;
        let shared = Arc::clone(&rig.streams.inner.lock().streams[&StreamId(10)].shared);
        let old = shared.lock().carrier;
        // A restored guest says hello again, having sent nothing.
        let (mut second, answer) = raw_hello(&rig, 10, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        drop(first);
        // What the connection before still had, read after the take-over.
        let (mut late, reader) = tokio::io::duplex(1024);
        late.write_all(&data(0, b"OLD")).await.unwrap();
        drop(late);
        read_frames(
            reader,
            Arc::clone(&shared),
            old,
            Arc::downgrade(&rig.streams.inner),
            StreamId(10),
        )
        .await;
        assert_eq!(shared.lock().stream.received(), 0);
        blocking(move || second.write_all(&data(0, b"NEW")).unwrap()).await;
        assert_eq!(read_exactly(&mut end, 3).await, b"NEW");
    }

    /// A sandbox at its limit whose streams no connection carries, none
    /// taken up since, still ends those its guest no longer has: the next
    /// fresh connection is refused, but starts the sweep, and one after
    /// it is let in.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sandbox_at_its_limit_still_ends_streams_its_guest_no_longer_has() {
        let take_up = Duration::from_millis(300);
        let mut rig = rig(2, take_up);
        let mut held = Vec::new();
        for id in [1, 2] {
            let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
            assert_eq!(answer, "ok 0\n");
            held.push((connection, rig.next_stream().await));
        }
        let mut ends = Vec::new();
        for (connection, end) in held {
            drop(connection);
            ends.push(end);
        }
        // Past the sweeps their own take-ups began.
        tokio::time::sleep(take_up * 2).await;
        let (_, answer) = raw_hello(&rig, 3, 0, 0).await;
        assert_eq!(answer, "gone\n");
        for end in &mut ends {
            assert!(ends_within(end, take_up * 10).await);
        }
        let (_, answer) = raw_hello(&rig, 4, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
    }

    /// Time the guest cannot run does not count against the streams it
    /// has yet to take up: paused just after taking one up, it takes the
    /// other up once it runs again, however long the pause.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_guest_paused_mid_take_up_keeps_the_streams_it_has_yet_to_take_up() {
        let take_up = Duration::from_millis(300);
        let mut rig = rig(4, take_up);
        let mut held = Vec::new();
        for id in [1, 2] {
            let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
            assert_eq!(answer, "ok 0\n");
            held.push((connection, rig.next_stream().await));
        }
        tokio::time::sleep(take_up * 2).await;
        let mut ends = Vec::new();
        for (connection, end) in held {
            drop(connection);
            ends.push(end);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (_kept, answer) = raw_hello(&rig, 1, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        rig.clock.set(false);
        assert!(
            !ends_within(&mut ends[1], take_up * 4).await,
            "a paused guest's stream is kept"
        );
        rig.clock.set(true);
        let (_resumed, answer) = raw_hello(&rig, 2, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
    }
}
