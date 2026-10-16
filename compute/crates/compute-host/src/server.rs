//! Serves the local API ([`crate::protocol`]) on a Unix socket.

use std::io;
use std::path::Path;
use std::pin::pin;
use std::sync::PoisonError;
use std::time::Duration;

use compute_core::Priority;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;
use tokio::time::{Instant, sleep_until};

use crate::agent::{Handle, HostError, Lease};
use crate::protocol::{ErrorCode, Id, Reply, Request, step_name};

/// Bytes relayed per read, each way.
const RELAY_BUFFER: usize = 16 << 10;

/// Requests are small; anything longer is refused.
const MAX_REQUEST: u64 = 64 << 10;

/// How long a guest port may take to accept after the sandbox runs. Only a
/// fresh boot needs more than a few milliseconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// Accepts connections on `socket` until the listener fails.
pub async fn serve(handle: Handle, socket: &Path) -> io::Result<()> {
    match std::fs::remove_file(socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    tracing::info!(socket = %socket.display(), "serving");
    loop {
        let (stream, _) = listener.accept().await?;
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
    if (&mut client).take(MAX_REQUEST).read_line(&mut line).await? == 0 {
        return Ok(());
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
            let lease = match handle.acquire(id, generation, priority.into()).await {
                Ok(lease) => lease,
                Err(error) => return write_reply(&mut client, &error_reply(&error)).await,
            };
            let started = Instant::now();
            let guest = match lease.connect(port, CONNECT_TIMEOUT).await {
                Ok(guest) => guest,
                Err(error) => return write_reply(&mut client, &error_reply(&error)).await,
            };
            write_reply(
                &mut client,
                &Reply::Connected {
                    waited_us: micros(lease.waited()),
                    connect_us: micros(started.elapsed()),
                },
            )
            .await?;
            let wake = Wake {
                handle,
                id,
                generation,
                priority: priority.into(),
            };
            return relay(&wake, lease, client, guest).await;
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
        } => match handle.acquire(id, generation, priority.into()).await {
            Ok(lease) => Reply::Woken {
                waited_us: micros(lease.waited()),
                during: lease.during().map(|step| step_name(step).to_owned()),
            },
            Err(error) => error_reply(&error),
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
/// passed on. A stream whose guest end the sandbox's sleep closed ends.
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
    let flow = Flow {
        wake,
        lease: tokio::sync::Mutex::new(Some(lease)),
        last: std::sync::Mutex::new(Instant::now()),
        resumed: Notify::new(),
    };
    let (client_read, client_write) = tokio::io::split(client);
    let (guest_read, guest_write) = guest.into_split();
    let mut up = pin!(flow.pump(client_read, guest_write));
    let mut down = pin!(flow.pump(guest_read, client_write));
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

/// What both directions of a relay share: the lease, and when traffic last
/// moved.
struct Flow<'a> {
    wake: &'a Wake<'a>,
    lease: tokio::sync::Mutex<Option<Lease>>,
    last: std::sync::Mutex<Instant>,
    /// Told when traffic takes a new lease after the stream let go.
    resumed: Notify,
}

impl Flow<'_> {
    /// Copies `from` to `to` until `from` ends, keeping the sandbox awake
    /// for each chunk.
    async fn pump(
        &self,
        mut from: impl AsyncRead + Unpin,
        mut to: impl AsyncWrite + Unpin,
    ) -> io::Result<End> {
        let mut buffer = vec![0; RELAY_BUFFER];
        loop {
            let n = from.read(&mut buffer).await?;
            if n == 0 {
                let slept = self.lease.lock().await.is_none();
                to.shutdown().await?;
                return Ok(if slept { End::Slept } else { End::Finished });
            }
            self.keep_awake().await?;
            let mut sent = 0;
            while sent < n {
                match to.write(&buffer[sent..n]).await? {
                    0 => return Err(io::ErrorKind::WriteZero.into()),
                    written => sent += written,
                }
                self.moved();
            }
        }
    }

    /// Takes a new lease if the stream let its sandbox sleep, waking it.
    async fn keep_awake(&self) -> io::Result<()> {
        let mut lease = self.lease.lock().await;
        self.moved();
        if lease.is_none() {
            let wake = self.wake;
            let woken = wake
                .handle
                .acquire(wake.id, wake.generation, wake.priority)
                .await
                .map_err(|error| io::Error::other(error.to_string()))?;
            *lease = Some(woken);
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

    /// Lets go of the lease once no traffic has moved for `idle`, then
    /// waits for traffic to take a new one. Never returns.
    async fn watch(&self, idle: Duration) {
        loop {
            sleep_until(self.quiet_until(idle)).await;
            let mut lease = self.lease.lock().await;
            if self.quiet_until(idle) <= Instant::now() && lease.take().is_some() {
                drop(lease);
                self.resumed.notified().await;
            }
        }
    }
}

fn done(result: Result<(), HostError>) -> Reply {
    result.map_or_else(|error| error_reply(&error), |()| Reply::Done)
}

fn error_reply(error: &HostError) -> Reply {
    Reply::Error {
        message: error.to_string(),
        code: match error {
            HostError::NotFound(_) => ErrorCode::NotFound,
            HostError::Exists(_) => ErrorCode::Exists,
            HostError::Busy(_) => ErrorCode::Busy,
            HostError::Broken(_) => ErrorCode::Broken,
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
