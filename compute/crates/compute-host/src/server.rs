//! Serves the local API ([`crate::protocol`]) on a Unix socket.

use std::future::Future;
use std::io;
use std::os::fd::AsFd;
use std::path::Path;
use std::pin::pin;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::time::Duration;

use compute_core::Priority;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, Interest,
};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;
use tokio::time::{Instant, sleep_until};

use crate::agent::{Handle, HostError, Lease};
use crate::protocol::{ErrorCode, Id, Reply, Request, step_name};

/// Bytes relayed per read, each way.
const RELAY_BUFFER: usize = 16 << 10;

/// Requests are small; anything longer is refused.
const MAX_REQUEST: u64 = 64 << 10;
/// How long a client may take to send its request once connected. Without
/// a bound, clients that connect and say nothing would pile up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a guest port may take to accept after the sandbox runs. Only a
/// fresh boot needs more than a few milliseconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// First and longest pause after accepting a connection fails.
const ACCEPT_BACKOFF: (Duration, Duration) = (Duration::from_millis(10), Duration::from_secs(1));

/// Accepts connections on `socket` for as long as the agent runs. Fails only
/// if it cannot listen.
pub async fn serve(handle: Handle, socket: &Path) -> io::Result<()> {
    match std::fs::remove_file(socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    tracing::info!(socket = %socket.display(), "serving");
    let mut backoff = ACCEPT_BACKOFF.0;
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => {
                backoff = ACCEPT_BACKOFF.0;
                stream
            }
            // Running out of open files or memory passes as connections end.
            // Giving up would take the API away from every sandbox here.
            Err(error) => {
                tracing::warn!(%error, retry_in_ms = backoff.as_millis(), "accepting an API connection failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(ACCEPT_BACKOFF.1);
                continue;
            }
        };
        let handle = handle.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_one(&handle, stream).await {
                tracing::debug!(%error, "client connection ended with an error");
            }
        });
    }
}

async fn serve_one(handle: &Handle, stream: UnixStream) -> io::Result<()> {
    let mut client = BufReader::new(stream);
    let mut line = String::new();
    let mut limited = (&mut client).take(MAX_REQUEST);
    match tokio::time::timeout(REQUEST_TIMEOUT, limited.read_line(&mut line)).await {
        Ok(Ok(0)) | Err(_) => return Ok(()),
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Err(error),
    }
    let request: Request = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(error) => {
            let message = format!("bad request: {error}");
            let code = ErrorCode::Invalid;
            return write_reply(&mut client, &Reply::Error { message, code }).await;
        }
    };
    let reply = match request {
        Request::Connect {
            id,
            generation,
            port,
            priority,
        } => {
            let acquire = handle.acquire(id, generation, priority.into());
            let wake = Wake {
                handle,
                id,
                generation,
                priority: priority.into(),
            };
            return serve_connect(client, acquire, port, &wake).await;
        }
        Request::Create { id, config } => done(handle.create(id, config).await),
        Request::Remove { id, generation } => done(handle.remove(id, generation).await),
        Request::Touch {
            id,
            generation,
            priority,
        } => done(handle.touch(id, generation, priority.into()).await),
        Request::Sleep {
            id,
            generation,
            level,
        } => done(handle.sleep(id, generation, level.into()).await),
        Request::Hold {
            id,
            generation,
            hold,
            ttl_ms,
            priority,
        } => done(
            handle
                .hold(
                    id,
                    generation,
                    &hold,
                    ttl_ms.map(Duration::from_millis),
                    priority.into(),
                )
                .await,
        ),
        Request::Release {
            id,
            generation,
            hold,
        } => done(handle.release(id, generation, &hold).await),
        Request::Wake {
            id,
            generation,
            priority,
        } => match unless_hung_up(
            client.get_ref(),
            handle.acquire(id, generation, priority.into()),
        )
        .await
        {
            Some(Ok(lease)) => Reply::Woken {
                waited_us: micros(lease.waited()),
                during: lease.during().map(|step| step_name(step).to_owned()),
                generation: lease.generation(),
            },
            Some(Err(error)) => error_reply(&error),
            None => return Ok(()),
        },
        Request::Status => match handle.status().await {
            Ok(status) => Reply::Status(Box::new(status)),
            Err(error) => error_reply(&error),
        },
    };
    write_reply(&mut client, &reply).await
}

/// How a stream wakes its sandbox again.
struct Wake<'a> {
    handle: &'a Handle,
    id: Id,
    generation: Option<u64>,
    priority: Priority,
}

/// Relays bytes both ways between a client and a guest until both sides
/// have finished. The stream keeps its sandbox awake while it carries
/// traffic: once it has been silent both ways for the handle's
/// `stream_idle`, it lets go of `lease`, so the sandbox may sleep, and the
/// next byte either way takes a new lease, waking the sandbox, before it is
/// passed on. A write to a client that stopped reading does not count as
/// traffic while it waits, but once it moves bytes the stream takes a new
/// lease, waking the sandbox to handle them, before it moves any more. A
/// write to the guest holds the lease while it waits: only a guest that
/// runs takes those bytes, and while the relay waits on it, it reads
/// nothing more from the client that could wake it. A stream whose guest
/// end the sandbox's sleep closed ends.
///
/// Each direction runs on its own, so one side that is slow to read never
/// stops the other from draining (a guest echoing an upload back while the
/// client is still sending it), and the idle clock runs beside both.
async fn relay(
    wake: &Wake<'_>,
    lease: Lease,
    client: impl AsyncRead + AsyncWrite,
    guest: UnixStream,
) -> io::Result<()> {
    let flow = Flow::new(wake, lease);
    let (client_read, client_write) = tokio::io::split(client);
    let (guest_read, guest_write) = guest.into_split();
    let mut up = pin!(flow.pump(client_read, guest_write, Hold::WhileWriting));
    let mut down = pin!(flow.pump(guest_read, client_write, Hold::WhenMoved));
    let mut watch = pin!(flow.watch(wake.handle.stream_idle()));
    let (mut up_done, mut down_done) = (false, false);
    while !(up_done && down_done) {
        tokio::select! {
            end = &mut up, if !up_done => {
                end?;
                up_done = true;
            }
            end = &mut down, if !down_done => {
                // Ended with the VM the sandbox's sleep ended: nothing
                // the client sends could reach it.
                if end? == End::Slept {
                    return Ok(());
                }
                down_done = true;
            }
            () = &mut watch => {}
        }
    }
    Ok(())
}

/// How one direction of a relay ended.
#[derive(Debug, PartialEq, Eq)]
enum End {
    /// Its source finished; the other end was told.
    Finished,
    /// Its source closed while the stream had let its sandbox sleep.
    Slept,
}

/// How a direction of a relay keeps the sandbox awake while it writes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Hold {
    /// For each write that moves bytes: a write the reader keeps waiting
    /// is silence. Toward the client, whose reading needs no sandbox.
    WhenMoved,
    /// For the whole of each write as well. Toward the guest, which reads
    /// only while it runs.
    WhileWriting,
}

/// Takes the lease a stream holds on its sandbox while it carries traffic.
trait Keeper {
    type Lease: Send;
    /// Wakes the sandbox and holds it awake until the lease is dropped.
    fn acquire(&self) -> impl Future<Output = io::Result<Self::Lease>> + Send;
}

impl Keeper for Wake<'_> {
    type Lease = Lease;
    async fn acquire(&self) -> io::Result<Lease> {
        self.handle
            .acquire(self.id, self.generation, self.priority)
            .await
            .map_err(|error| io::Error::other(error.to_string()))
    }
}

/// What both directions of a relay share: the lease, and when traffic last
/// moved.
struct Flow<'a, K: Keeper> {
    keeper: &'a K,
    lease: tokio::sync::Mutex<Option<K::Lease>>,
    last: std::sync::Mutex<Instant>,
    /// Told when traffic takes a new lease after the stream let go.
    resumed: Notify,
    /// Bytes for the guest wait on it to read them.
    delivering: AtomicBool,
    /// Told when they are delivered.
    delivered: Notify,
}

impl<'a, K: Keeper + Sync> Flow<'a, K> {
    fn new(keeper: &'a K, lease: K::Lease) -> Self {
        Self {
            keeper,
            lease: tokio::sync::Mutex::new(Some(lease)),
            last: std::sync::Mutex::new(Instant::now()),
            resumed: Notify::new(),
            delivering: AtomicBool::new(false),
            delivered: Notify::new(),
        }
    }

    /// Copies `from` to `to` until `from` ends, keeping the sandbox awake
    /// for every write as `hold` says.
    async fn pump(
        &self,
        mut from: impl AsyncRead + Unpin,
        mut to: impl AsyncWrite + Unpin,
        hold: Hold,
    ) -> io::Result<End> {
        let mut buffer = vec![0; RELAY_BUFFER];
        loop {
            let n = from.read(&mut buffer).await?;
            if n == 0 {
                let slept = self.lease.lock().await.is_none();
                to.shutdown().await?;
                return Ok(if slept { End::Slept } else { End::Finished });
            }
            if hold == Hold::WhileWriting {
                self.delivering.store(true, SeqCst);
            }
            self.keep_awake().await?;
            let mut sent = 0;
            while sent < n {
                match to.write(&buffer[sent..n]).await? {
                    0 => return Err(io::ErrorKind::WriteZero.into()),
                    written => sent += written,
                }
                // The write may have waited out the idle time and let the
                // lease go; the bytes it moved take it back before any more
                // move, and wake the sandbox to handle them.
                self.keep_awake().await?;
            }
            if hold == Hold::WhileWriting {
                self.delivering.store(false, SeqCst);
                self.delivered.notify_one();
            }
        }
    }

    /// Takes a new lease if the stream let its sandbox sleep, waking it.
    async fn keep_awake(&self) -> io::Result<()> {
        let mut lease = self.lease.lock().await;
        self.moved();
        if lease.is_none() {
            *lease = Some(self.keeper.acquire().await?);
            self.moved();
            self.resumed.notify_one();
        }
        Ok(())
    }

    fn moved(&self) {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn quiet_until(&self, idle: Duration) -> Instant {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) + idle
    }

    /// Lets go of the lease once no traffic has moved for `idle` and no
    /// bytes wait on the guest, then waits for traffic to take a new one.
    /// Never returns.
    async fn watch(&self, idle: Duration) {
        loop {
            sleep_until(self.quiet_until(idle)).await;
            if self.delivering.load(SeqCst) {
                self.delivered.notified().await;
                continue;
            }
            let mut lease = self.lease.lock().await;
            // A write to the guest that began meanwhile took the lease
            // before it wrote, and keeps it.
            if self.quiet_until(idle) <= Instant::now()
                && !self.delivering.load(SeqCst)
                && lease.take().is_some()
            {
                drop(lease);
                self.resumed.notified().await;
            }
        }
    }
}

/// Answers a connect request: waits for `acquire` to wake the sandbox,
/// reaches `port` in it, then relays between the client and the guest (see
/// [`relay`]), waking the sandbox again through `wake`.
///
/// Whatever the client sends before the reply stays in the socket, or in
/// `client`'s buffer, and reaches the guest once the two are joined.
async fn serve_connect(
    mut client: BufReader<UnixStream>,
    acquire: impl Future<Output = Result<Lease, HostError>>,
    port: u32,
    wake: &Wake<'_>,
) -> io::Result<()> {
    let mut lease = match unless_hung_up(client.get_ref(), acquire).await {
        Some(Ok(lease)) => lease,
        Some(Err(error)) => return write_reply(&mut client, &error_reply(&error)).await,
        None => return Ok(()),
    };
    let started = Instant::now();
    let connect = lease.connect(port, CONNECT_TIMEOUT);
    let guest = match unless_hung_up(client.get_ref(), connect).await {
        Some(Ok(guest)) => guest,
        Some(Err(error)) => return write_reply(&mut client, &error_reply(&error)).await,
        None => return Ok(()),
    };
    write_reply(
        &mut client,
        &Reply::Connected {
            waited_us: micros(lease.waited()),
            connect_us: micros(started.elapsed()),
            generation: lease.generation(),
        },
    )
    .await?;
    relay(wake, lease, client, guest).await
}

fn done(result: Result<(), HostError>) -> Reply {
    result.map_or_else(|error| error_reply(&error), |()| Reply::Done)
}

/// Runs `work` unless the client hangs up first, so that it could no
/// longer read an answer: then `work` is dropped, which gives up what it
/// waited for (a wake's hold on the sandbox), and the result is `None`.
///
/// A client that only closes its sending side has not hung up: it may send
/// everything first and then wait for the answer. Nothing the client sends
/// is read meanwhile, so however much it sends, it stays watched.
async fn unless_hung_up<T>(client: &UnixStream, work: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        output = work => Some(output),
        () = hung_up(client) => None,
    }
}

/// Resolves once `client` has closed both directions.
async fn hung_up(client: &UnixStream) {
    // Watched through a second descriptor of the same socket, with its own
    // readiness: what the watch clears must not leave the connection's own
    // reads and writes waiting for an event that never comes. Without one,
    // the work simply goes on.
    let watch = client.as_fd().try_clone_to_owned().and_then(|fd| {
        let watch = std::os::unix::net::UnixStream::from(fd);
        watch.set_nonblocking(true)?;
        UnixStream::from_std(watch)
    });
    let Ok(watch) = watch else {
        return std::future::pending().await;
    };
    loop {
        let Ok(seen) = watch.ready(Interest::WRITABLE).await else {
            return std::future::pending().await;
        };
        // A Unix socket shows its peer's full close as a hang-up.
        if seen.is_write_closed() {
            return;
        }
        // Writable is the usual state: forget it, so the next wait lasts
        // until the socket's state changes.
        let _ = watch.try_io(Interest::WRITABLE, || {
            Err::<(), _>(io::ErrorKind::WouldBlock.into())
        });
    }
}

fn error_reply(error: &HostError) -> Reply {
    Reply::Error {
        message: error.to_string(),
        code: match error {
            HostError::NotFound(_) => ErrorCode::NotFound,
            HostError::Exists(_) => ErrorCode::Exists,
            HostError::Busy(_) => ErrorCode::Busy,
            HostError::Broken(_) => ErrorCode::Broken,
            HostError::Blocked { .. } => ErrorCode::Blocked,
            HostError::Removed(_) => ErrorCode::Removed,
            HostError::Invalid(_) => ErrorCode::Invalid,
            HostError::Stale { .. } => ErrorCode::Stale,
            HostError::Unreachable { .. } => ErrorCode::Unreachable,
            HostError::Io(_) | HostError::Stopped => ErrorCode::Internal,
        },
    }
}

fn micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

async fn write_reply(stream: &mut (impl AsyncWrite + Unpin), reply: &Reply) -> io::Result<()> {
    let mut line = serde_json::to_vec(reply).map_err(io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Leases that count themselves, noting how much the reader had read
    /// when each was taken.
    #[derive(Default)]
    struct Counting {
        held: Arc<AtomicUsize>,
        read: AtomicUsize,
        taken_at: Mutex<Vec<usize>>,
    }

    struct Held(Arc<AtomicUsize>);

    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, SeqCst);
        }
    }

    impl Counting {
        fn hold(&self) -> Held {
            self.held.fetch_add(1, SeqCst);
            Held(Arc::clone(&self.held))
        }
    }

    impl Keeper for Counting {
        type Lease = Held;
        fn acquire(&self) -> impl Future<Output = io::Result<Held>> + Send {
            self.taken_at.lock().unwrap().push(self.read.load(SeqCst));
            std::future::ready(Ok(self.hold()))
        }
    }

    /// A client that stops reading for longer than the idle time lets the
    /// lease go while the relay's write waits on it; once it reads again,
    /// the bytes that move take a new lease before more than the waiting
    /// write's share has passed.
    #[tokio::test]
    async fn a_write_to_a_client_that_waited_out_the_idle_time_takes_a_lease_when_it_moves() {
        const IDLE: Duration = Duration::from_millis(200);
        const SIZE: usize = 4 << 10;
        let keeper = Counting::default();
        let flow = Flow::new(&keeper, keeper.hold());
        let data = vec![7_u8; SIZE];
        // The reader's side buffers 1 KiB.
        let (to, mut reader) = tokio::io::duplex(1 << 10);
        let pump = flow.pump(&data[..], to, Hold::WhenMoved);
        let reading = async {
            tokio::time::sleep(IDLE * 3).await;
            assert_eq!(keeper.held.load(SeqCst), 0, "the stalled stream let go");
            let (mut got, mut buffer) = (0, [0_u8; 256]);
            loop {
                let n = reader.read(&mut buffer).await.unwrap();
                if n == 0 {
                    return got;
                }
                got += n;
                keeper.read.store(got, SeqCst);
            }
        };
        let mut watch = pin!(flow.watch(IDLE));
        let (end, got) = tokio::select! {
            both = async { tokio::join!(pump, reading) } => both,
            () = &mut watch => unreachable!("the watch never ends"),
        };
        assert_eq!(end.unwrap(), End::Finished, "it ended holding a lease");
        assert_eq!(got, SIZE);
        let taken_at = keeper.taken_at.lock().unwrap().clone();
        assert_eq!(taken_at.len(), 1, "one lease taken when traffic resumed");
        assert!(
            taken_at[0] <= 2 << 10,
            "taken after {} bytes reached the reader",
            taken_at[0]
        );
        assert_eq!(keeper.held.load(SeqCst), 1);
    }

    /// A guest takes bytes only while it runs, and behind a write waiting
    /// on it the relay reads nothing that could wake it: so the write holds
    /// the lease however long it waits, and the stream lets go only once it
    /// is silent with nothing waiting.
    #[tokio::test]
    async fn a_write_to_the_guest_holds_the_lease_while_it_waits() {
        const IDLE: Duration = Duration::from_millis(200);
        const SIZE: usize = 4 << 10;
        let keeper = Counting::default();
        let flow = Flow::new(&keeper, keeper.hold());
        let data = vec![7_u8; SIZE];
        let (to, mut guest) = tokio::io::duplex(1 << 10);
        let pump = flow.pump(&data[..], to, Hold::WhileWriting);
        let reading = async {
            // Busy for longer than the idle time, then reads only while it
            // is kept awake.
            tokio::time::sleep(IDLE * 3).await;
            let (mut got, mut buffer) = (0, [0_u8; 256]);
            loop {
                let untaken = SIZE - got;
                assert_eq!(
                    keeper.held.load(SeqCst),
                    1,
                    "asleep, {untaken} bytes untaken"
                );
                let n = guest.read(&mut buffer).await.unwrap();
                if n == 0 {
                    return got;
                }
                got += n;
            }
        };
        let mut watch = pin!(flow.watch(IDLE));
        let (end, got) = tokio::select! {
            both = async { tokio::join!(pump, reading) } => both,
            () = &mut watch => unreachable!("the watch never ends"),
        };
        assert_eq!(end.unwrap(), End::Finished);
        assert_eq!(got, SIZE);
        assert!(
            keeper.taken_at.lock().unwrap().is_empty(),
            "it never let go"
        );
        // Silent with nothing waiting, it lets go.
        tokio::select! {
            () = tokio::time::sleep(IDLE * 3) => {}
            () = &mut watch => unreachable!("the watch never ends"),
        }
        assert_eq!(keeper.held.load(SeqCst), 0);
    }

    const SOON: Duration = Duration::from_millis(200);

    async fn resolves(client: &UnixStream) -> bool {
        tokio::time::timeout(SOON, hung_up(client)).await.is_ok()
    }

    /// Sending, and then closing only the sending side, is not hanging up;
    /// closing the connection is, however much was sent and left unread.
    /// Watching never holds up the connection's own replies.
    #[tokio::test]
    async fn only_a_closed_connection_is_a_hang_up() {
        let (mut caller, mut server) = UnixStream::pair().unwrap();
        assert!(!resolves(&server).await, "an open connection hung up");
        tokio::time::timeout(SOON, server.write_all(b"reply\n"))
            .await
            .expect("watching held up a reply")
            .unwrap();
        caller.write_all(&vec![b'x'; 64 << 10]).await.unwrap();
        assert!(!resolves(&server).await, "sending is not hanging up");
        caller.shutdown().await.unwrap();
        assert!(!resolves(&server).await, "a closed sending side hung up");
        tokio::time::timeout(SOON, server.write_all(b"reply\n"))
            .await
            .expect("watching held up a reply")
            .unwrap();
        drop(caller);
        assert!(resolves(&server).await, "a closed connection went unseen");
    }
}
