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
//! hub does not keep a connection no agent holds. A take-up is what
//! proves the guest runs well enough to connect: a guest just restored
//! may take a while, as its memory comes in, and a window that started
//! before it connected could run out first. So a stream whose connection's
//! end the host sees only after a take-up (a reset that reaches the host
//! after the guest's new hello) gets a window of its own from that end,
//! if its guest took a stream up since it was last launched: that guest
//! takes up every stream it has within moments of the stream's
//! connection ending. A window lapses when the guest is launched again
//! (a restore or a boot, [`RunClock::launched`]) before it runs out: the
//! new guest has yet to prove it runs, and its first take-up's window
//! covers every stream not carried by then. [`TAKE_UP`] counts only time in
//! which the guest could run ([`RunClock`]): a guest paused just after
//! taking one stream up has all of it, once it runs again, for the
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
/// when it runs, if it does; and how many times its VM was launched.
#[derive(Debug, Default, Clone, Copy)]
struct Ran {
    before: Duration,
    since: Option<Instant>,
    launch: u64,
}

impl Ran {
    fn now(self) -> Duration {
        self.before + self.since.map_or(Duration::ZERO, |since| since.elapsed())
    }
}

/// Time on a sandbox's [`RunClock`], and the launch of its VM then.
#[derive(Debug, Clone, Copy)]
struct At {
    time: Duration,
    launch: u64,
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
                    launch: ran.launch,
                }
            }
            _ => return,
        }
        drop(ran);
        self.inner.changed.notify_waiters();
    }

    /// A VM process for the sandbox is about to start, restored or booted:
    /// its guest is a new one, which has yet to prove it runs by taking a
    /// stream up. Told before the process starts, so before that guest
    /// can connect.
    pub(crate) fn launched(&self) {
        self.lock().launch += 1;
    }

    /// The launches it was told of.
    #[cfg(test)]
    pub(crate) fn launches(&self) -> u64 {
        self.lock().launch
    }

    /// The time the guest could run so far, and the launch it runs in.
    fn at(&self) -> At {
        let ran = *self.lock();
        At {
            time: ran.now(),
            launch: ran.launch,
        }
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
    /// The sandbox, named on every line logged about its streams.
    sandbox: Arc<str>,
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
    /// latest one asked for since it began waiting.
    sweeping: bool,
    next_sweep: Option<At>,
    /// The sweep's task, which ends with the sandbox's streams: it may wait
    /// on a clock that never runs again.
    sweeper: Option<Tasks>,
    /// The launch in which the guest last took a stream up, which proves
    /// that guest runs: it takes up every stream it has at once.
    proven: Option<u64>,
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
    /// The sandbox whose stream this is.
    sandbox: Arc<str>,
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
    /// sandbox's clock. Whether that left the stream without one: an
    /// ended connection that another had replaced did not.
    fn uncarried(&self, carrier: u64, now: Duration) -> bool {
        let mut state = self.lock();
        let left = state.carrier == carrier && state.carried;
        if left {
            state.carried = false;
            state.uncarried_since = Some(now);
        }
        drop(state);
        self.changed();
        left
    }
}

impl<F> Inner<F> {
    fn lock(&self) -> MutexGuard<'_, Map> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Connection `carrier` ended under the stream `shared`, if `inner` is
/// still there. If that leaves the stream without one, and its guest took
/// a stream up since it was launched, the stream gets a window of its own
/// from now: that guest takes up every stream it has at once.
fn uncarried<F>(inner: &Weak<Inner<F>>, shared: &Shared, carrier: u64)
where
    F: Send + Sync + 'static,
{
    let Some(inner) = inner.upgrade() else {
        return;
    };
    let now = inner.clock.at();
    if !shared.uncarried(carrier, now.time) {
        return;
    }
    let mut map = inner.lock();
    if map.proven == Some(now.launch) {
        sweep_later(&inner, &mut map, now);
    }
}

/// Ends the streams not carried at `at` that are not taken up within
/// [`TAKE_UP`] of the guest's running after it, unless the guest is
/// launched again before then.
fn sweep_later<F>(inner: &Arc<Inner<F>>, map: &mut Map, at: At)
where
    F: Send + Sync + 'static,
{
    if map.sweeping {
        map.next_sweep = Some(at);
        return;
    }
    map.sweeping = true;
    let task = tokio::spawn(sweep(Arc::downgrade(inner), at));
    map.sweeper = Some(Tasks(vec![task.abort_handle()]));
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
    /// Sandbox `sandbox`'s streams, each handed to `serve` when it begins;
    /// at most `limit` at once. `clock` counts the time its guest could run.
    pub(crate) fn new(
        sandbox: Arc<str>,
        serve: F,
        limit: usize,
        take_up: Duration,
        clock: RunClock,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                sandbox,
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
            tracing::warn!(
                sandbox = %self.inner.sandbox,
                "an agent-link connection did not say hello; closing it",
            );
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
        let now = self.inner.clock.at();
        let mut map = self.inner.lock();
        map.proven = Some(now.launch);
        if !map.streams.contains_key(&hello.id) {
            if hello.received > 0 || map.streams.len() >= self.inner.limit {
                tracing::debug!(
                    sandbox = %self.inner.sandbox,
                    stream = %hello.id,
                    "an agent-link stream the host does not have",
                );
                sweep_later(&self.inner, &mut map, now);
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
            tracing::info!(
                sandbox = %self.inner.sandbox,
                stream = %hello.id,
                "an agent-link stream cannot go on; ending it",
            );
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
        sweep_later(&self.inner, &mut map, now);
    }

    /// A new stream, its hub end handed to the hub.
    fn start(&self, id: StreamId) -> Entry {
        let (near, far) = tokio::io::duplex(HUB_BUFFER);
        let shared = Arc::new(Shared {
            sandbox: Arc::clone(&self.inner.sandbox),
            state: Mutex::new(State::default()),
            changed: watch::channel(()).0,
        });
        let (reading, writing) = tokio::io::split(near);
        let reader = tokio::spawn(read_hub(reading, Arc::clone(&shared)));
        let writer = tokio::spawn(write_hub(writing, Arc::clone(&shared)));
        tracing::debug!(sandbox = %self.inner.sandbox, stream = %id, "an agent-link stream begins");
        (self.inner.serve)(far);
        Entry {
            shared,
            _hub: Tasks(vec![reader.abort_handle(), writer.abort_handle()]),
            carrier: Tasks::default(),
        }
    }
}

async fn sweep<F>(inner: Weak<Inner<F>>, mut since: At) {
    loop {
        let Some((take_up, clock)) = inner
            .upgrade()
            .map(|inner| (inner.take_up, inner.clock.clone()))
        else {
            return;
        };
        clock.reaches(since.time + take_up).await;
        let Some(strong) = inner.upgrade() else {
            return;
        };
        let mut map = strong.lock();
        let before = map.streams.len();
        // A guest launched since is a new one, which has yet to prove it
        // runs: its first take-up's window covers these streams instead.
        if clock.at().launch == since.launch {
            map.streams.retain(|_, entry| {
                entry
                    .shared
                    .lock()
                    .uncarried_since
                    .is_none_or(|uncarried| uncarried > since.time)
            });
        }
        let ended = before - map.streams.len();
        if ended > 0 {
            tracing::info!(
                sandbox = %strong.sandbox,
                ended,
                "agent-link streams the guest no longer has ended",
            );
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
    F: Send + Sync + 'static,
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
                            tracing::warn!(
                                sandbox = %shared.sandbox,
                                stream = %id,
                                %error,
                                "an agent-link stream broke the protocol; ending it",
                            );
                            break Some(Over::Broken);
                        }
                    }
                }
                Ok(None) => break None,
                Err(error) => {
                    tracing::warn!(
                        sandbox = %shared.sandbox,
                        stream = %id,
                        %error,
                        "an agent-link stream broke the protocol; ending it",
                    );
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
    F: Send + Sync + 'static,
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
                tracing::debug!(sandbox = %shared.sandbox, stream = %id, "an agent-link stream ended");
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
mod tests;
