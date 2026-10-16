//! Serves the local API ([`crate::protocol`]) on a Unix socket.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;

use crate::agent::{Handle, HostError};
use crate::protocol::{ErrorCode, Reply, Request};

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
            let mut guest = match lease.connect(port, CONNECT_TIMEOUT).await {
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
            // The lease keeps the sandbox awake until the stream closes.
            tokio::io::copy_bidirectional(&mut client, &mut guest).await?;
            drop(lease);
            return Ok(());
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
