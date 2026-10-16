//! Serves the local API ([`crate::protocol`]) on a Unix socket.

use std::future::Future;
use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;

use crate::agent::{Handle, HostError, Lease};
use crate::protocol::{ErrorCode, Reply, Request, step_name};

/// Requests are small; anything longer is refused.
const MAX_REQUEST: u64 = 64 << 10;
/// How long a client may take to send its request once connected. Without
/// a bound, clients that connect and say nothing would pile up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The most a connecting client may send for the guest before its
/// connection is ready; it is passed on once it is.
const MAX_EARLY: usize = 64 << 10;

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
        } => match unless_abandoned(
            &mut client,
            &mut Vec::new(),
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
async fn serve_connect(
    mut client: BufReader<UnixStream>,
    acquire: impl Future<Output = Result<Lease, HostError>>,
    port: u32,
) -> io::Result<()> {
    // Bytes the client sends ahead of its reply, meant for the guest.
    let mut early = Vec::new();
    let mut lease = match unless_abandoned(&mut client, &mut early, acquire).await {
        Some(Ok(lease)) => lease,
        Some(Err(error)) => return write_reply(&mut client, &error_reply(&error)).await,
        None => return Ok(()),
    };
    let started = Instant::now();
    let connect = lease.connect(port, CONNECT_TIMEOUT);
    let mut guest = match unless_abandoned(&mut client, &mut early, connect).await {
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
    guest.write_all(&early).await?;
    tokio::io::copy_bidirectional(&mut client, &mut guest).await?;
    drop(lease);
    Ok(())
}

fn done(result: Result<(), HostError>) -> Reply {
    result.map_or_else(|error| error_reply(&error), |()| Reply::Done)
}

/// Runs `work` unless the client hangs up first, closing its connection or
/// its sending side: then `work` is dropped, which gives up what it waited
/// for (a wake's hold on the sandbox), and the result is `None`. What the
/// client sends meanwhile is kept in `early`, up to [`MAX_EARLY`] bytes;
/// past that, the client is no longer watched.
async fn unless_abandoned<T>(
    client: &mut BufReader<UnixStream>,
    early: &mut Vec<u8>,
    work: impl Future<Output = T>,
) -> Option<T> {
    tokio::pin!(work);
    let mut buffer = [0_u8; 4096];
    loop {
        tokio::select! {
            biased;
            output = &mut work => return Some(output),
            read = client.read(&mut buffer), if early.len() < MAX_EARLY => match read {
                Ok(0) | Err(_) => return None,
                Ok(read) => early.extend_from_slice(&buffer[..read]),
            },
        }
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
