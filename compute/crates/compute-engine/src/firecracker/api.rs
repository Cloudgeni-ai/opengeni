//! A minimal HTTP/1.1 client for the Firecracker API socket.
//!
//! The API is a handful of small JSON requests on a local Unix socket, so a
//! full HTTP stack would only add weight. Each request uses its own
//! connection, which costs microseconds on a Unix socket.
//!
//! Every request has a deadline. The VMM answers one request at a time, so a
//! VMM that stops answering would otherwise hold up every step on its VM for
//! good, including the one that would notice and end it.
//!
//! A client made for one VMM process sends nothing to any other: a request
//! still on its way when that VMM ends can never reach a later one behind
//! the same socket path.
//!
//! A deadline counts only time the VMM can run. While its group is held
//! frozen (the host's guard freezes every VM once the host's lease runs
//! out, until it is renewed) the VMM cannot answer, and a request that
//! failed for that would end a VM that was only paused with the rest.

use std::io;
use std::path::{Path, PathBuf};
use std::pin::{Pin, pin};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::{Instant, timeout_at};

use crate::cgroup::Cgroup;

/// Responses larger than this are refused; real ones are a few hundred bytes.
const MAX_RESPONSE: usize = 1 << 20;

/// How long a quick control request may take. The VMM answers these in
/// milliseconds, even on a loaded host; one that takes this long is stuck.
const CONTROL_LIMIT: Duration = Duration::from_secs(10);

/// How long a snapshot request may take. It moves a VM's memory to or from
/// disk, which can take minutes when many VMs save at once.
const SNAPSHOT_LIMIT: Duration = Duration::from_secs(600);

/// How often a request still waiting looks at whether its VMM is frozen:
/// the time since the last look counts toward its deadline only if
/// neither look found it so.
const FROZEN_LOOK: Duration = Duration::from_millis(100);

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The request was never sent, so it cannot have taken effect.
    #[error("API socket connect: {0}")]
    Connect(io::Error),
    /// The request may have been sent and its answer lost.
    #[error("API socket I/O: {0}")]
    Io(#[from] io::Error),
    /// The request was sent and no answer came in time. It may have taken
    /// effect, or may still.
    #[error("no answer from the VMM within {0:?}")]
    Timeout(Duration),
    #[error("malformed API response: {0}")]
    Malformed(&'static str),
    /// The VMM answered and refused the request.
    #[error("{method} {path} returned {status}: {body}")]
    Status {
        method: &'static str,
        path: String,
        status: u16,
        body: String,
    },
}

#[derive(Clone, Debug)]
pub struct Api {
    socket: PathBuf,
    /// The process that must serve the socket, in the host's PID namespace.
    server: Option<i32>,
    /// The group whose freezer holds that process; time it spends frozen
    /// does not count toward a deadline.
    group: Option<Cgroup>,
    control_limit: Duration,
    snapshot_limit: Duration,
}

impl Api {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
            server: None,
            group: None,
            control_limit: CONTROL_LIMIT,
            snapshot_limit: SNAPSHOT_LIMIT,
        }
    }

    /// The same client, sending only to the socket's server `pid`.
    pub fn served_by(self, pid: i32) -> Self {
        Self {
            server: Some(pid),
            ..self
        }
    }

    /// The same client, not counting toward a deadline the time `group`,
    /// the VMM's cgroup, is held frozen.
    pub fn held_by(self, group: Cgroup) -> Self {
        Self {
            group: Some(group),
            ..self
        }
    }

    /// The same client with other deadlines, for tests.
    #[cfg(test)]
    pub fn with_limits(self, control: Duration, snapshot: Duration) -> Self {
        Self {
            control_limit: control,
            snapshot_limit: snapshot,
            ..self
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// How long a request to `path` may take.
    fn limit(&self, path: &str) -> Duration {
        if path.starts_with("/snapshot/") {
            self.snapshot_limit
        } else {
            self.control_limit
        }
    }

    /// Sends one request and returns the response body on a 2xx status,
    /// within the deadline for its kind of request.
    pub async fn call(
        &self,
        method: &'static str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<Vec<u8>, ApiError> {
        let limit = self.limit(path);
        // The time the VMM may run before the request fails, over both
        // the connect and the exchange.
        let mut left = limit;
        let body = body.map(serde_json::Value::to_string).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let connect = pin!(crate::confined::connect(&self.socket));
        let mut stream = self
            .until(&mut left, connect)
            .await
            .ok_or_else(|| ApiError::Connect(io::ErrorKind::TimedOut.into()))?
            .map_err(ApiError::Connect)?;
        if let Some(server) = self.server {
            let peer = stream.peer_cred().map_err(ApiError::Connect)?.pid();
            if peer != Some(server) {
                return Err(ApiError::Connect(io::Error::other(format!(
                    "the API socket is served by process {peer:?}, not the VMM {server}"
                ))));
            }
        }
        let exchange = pin!(async {
            stream.write_all(request.as_bytes()).await?;
            read_response(&mut stream).await
        });
        let (status, response) = self
            .until(&mut left, exchange)
            .await
            .ok_or(ApiError::Timeout(limit))??;
        if (200..300).contains(&status) {
            Ok(response)
        } else {
            Err(ApiError::Status {
                method,
                path: path.to_owned(),
                status,
                body: String::from_utf8_lossy(&response).into_owned(),
            })
        }
    }

    /// Runs `work` for at most `left` of the time the VMM can run, taking
    /// what it uses off `left`; `None` once that is spent first. Time
    /// counts unless the VMM's group is found held frozen at either end of
    /// it, however late a look comes (the executor may be busy), and the
    /// time is only found spent by a look that finds the group not held.
    /// The caller pins `work`, so it is held once, not again in here.
    async fn until<T>(
        &self,
        left: &mut Duration,
        mut work: Pin<&mut impl Future<Output = T>>,
    ) -> Option<T> {
        // A freezer it cannot read is not known to hold the VMM.
        let held = |group: &Cgroup| group.is_held_frozen().unwrap_or(false);
        let Some(group) = &self.group else {
            let started = Instant::now();
            let done = timeout_at(started + *left, work).await.ok();
            *left = left.saturating_sub(started.elapsed());
            return done;
        };
        let (mut looked, mut was_held) = (Instant::now(), held(group));
        loop {
            // While held, nothing is spent before the next look.
            let wait = if was_held {
                FROZEN_LOOK
            } else {
                (*left).min(FROZEN_LOOK)
            };
            let done = tokio::select! {
                biased;
                done = work.as_mut() => Some(done),
                () = tokio::time::sleep_until(looked + wait) => None,
            };
            let (now, is_held) = (Instant::now(), held(group));
            if !(was_held || is_held) {
                *left = left.saturating_sub(now - looked);
            }
            // Work that finished is charged its last stretch too, for the
            // part of the request still to come.
            if done.is_some() || (left.is_zero() && !is_held) {
                return done;
            }
            (looked, was_held) = (now, is_held);
        }
    }
}

/// Reads one response: the status code and the body, sized by
/// `Content-Length`.
async fn read_response(stream: &mut UnixStream) -> Result<(u16, Vec<u8>), ApiError> {
    let mut buffer = Vec::with_capacity(512);
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        if let Some(end) = find(&buffer, b"\r\n\r\n") {
            break end + 4;
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(ApiError::Malformed(
                "connection closed before the headers ended",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_RESPONSE {
            return Err(ApiError::Malformed("headers too large"));
        }
    };
    let head = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| ApiError::Malformed("headers are not UTF-8"))?;
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or(ApiError::Malformed("no status code"))?;
    let length = head
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>())
        .transpose()
        .map_err(|_| ApiError::Malformed("bad content length"))?
        .unwrap_or(0);
    if length > MAX_RESPONSE {
        return Err(ApiError::Malformed("body too large"));
    }
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(ApiError::Malformed(
                "connection closed before the body ended",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    buffer.truncate(header_end + length);
    Ok((status, buffer.split_off(header_end)))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn serve_once(reply: &'static [u8]) -> (tempdir::Dir, Api) {
        let dir = tempdir::Dir::new();
        let socket = dir.path().join("api.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            // Split the reply to exercise reassembly.
            let (first, rest) = reply.split_at(reply.len() / 2);
            stream.write_all(first).await.unwrap();
            tokio::task::yield_now().await;
            stream.write_all(rest).await.unwrap();
        });
        (dir, Api::new(socket))
    }

    #[tokio::test]
    async fn parses_no_content() {
        let (_dir, api) = serve_once(b"HTTP/1.1 204 \r\nServer: Firecracker API\r\n\r\n");
        assert_eq!(api.call("PUT", "/actions", None).await.unwrap(), b"");
    }

    #[tokio::test]
    async fn reads_a_body_by_content_length() {
        let (_dir, api) =
            serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"state\":\"x\"}");
        assert_eq!(
            api.call("GET", "/", None).await.unwrap(),
            b"{\"state\":\"x\"}"
        );
    }

    #[tokio::test]
    async fn reports_errors_with_their_body() {
        let (_dir, api) = serve_once(
            b"HTTP/1.1 400 Bad Request\r\ncontent-length: 26\r\n\r\n{\"fault_message\":\"nope\"}  ",
        );
        let error = api.call("PUT", "/vm", None).await.unwrap_err();
        assert!(
            matches!(error, ApiError::Status { status: 400, .. }),
            "{error}"
        );
    }

    /// The connect and the exchange share one limit: what the first uses
    /// is gone for the second, whether or not the client watches a group.
    #[tokio::test]
    async fn the_parts_of_a_request_share_its_time() {
        let dir = tempdir::Dir::new();
        let own = dir.path().join("vm");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("cgroup.freeze"), "0").unwrap();
        std::fs::write(own.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        for api in [
            Api::new("unused"),
            Api::new("unused").held_by(Cgroup::at(&own)),
        ] {
            let mut left = Duration::from_millis(200);
            let first = pin!(tokio::time::sleep(Duration::from_millis(80)));
            assert_eq!(api.until(&mut left, first).await, Some(()));
            assert!(
                left <= Duration::from_millis(125),
                "{left:?} left after 80 ms of 200"
            );
            let second = pin!(std::future::pending::<()>());
            assert_eq!(api.until(&mut left, second).await, None);
            assert_eq!(left, Duration::ZERO);
        }
    }

    /// A self-deleting temporary directory, to avoid a dependency for tests.
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                let unique = format!(
                    "compute-engine-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                );
                // Unix socket paths are short (104 bytes on macOS), so stay in /tmp.
                let path = PathBuf::from("/tmp").join(unique);
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
