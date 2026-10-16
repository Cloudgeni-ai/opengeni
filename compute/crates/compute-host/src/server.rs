//! Serves the local API ([`crate::protocol`]) on a Unix socket.

use std::future::Future;
use std::io;
use std::os::fd::AsFd;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, Interest};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;

use crate::agent::{Handle, HostError, Lease};
use crate::protocol::{ErrorCode, Reply, Request, step_name};

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
            return serve_connect(client, acquire, port).await;
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

/// Answers a connect request: waits for `acquire` to wake the sandbox,
/// reaches `port` in it, then joins the client and the guest until either
/// side closes, keeping the sandbox awake meanwhile.
///
/// Whatever the client sends before the reply stays in the socket, or in
/// `client`'s buffer, and reaches the guest once the two are joined.
async fn serve_connect(
    mut client: BufReader<UnixStream>,
    acquire: impl Future<Output = Result<Lease, HostError>>,
    port: u32,
) -> io::Result<()> {
    let mut lease = match unless_hung_up(client.get_ref(), acquire).await {
        Some(Ok(lease)) => lease,
        Some(Err(error)) => return write_reply(&mut client, &error_reply(&error)).await,
        None => return Ok(()),
    };
    let started = Instant::now();
    let connect = lease.connect(port, CONNECT_TIMEOUT);
    let mut guest = match unless_hung_up(client.get_ref(), connect).await {
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
    tokio::io::copy_bidirectional(&mut client, &mut guest).await?;
    drop(lease);
    Ok(())
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
    use super::*;

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
