//! A minimal HTTP/1.1 client for the Firecracker API socket.
//!
//! The API is a handful of small JSON requests on a local Unix socket, so a
//! full HTTP stack would only add weight. Each request uses its own
//! connection, which costs microseconds on a Unix socket.

use std::io;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Responses larger than this are refused; real ones are a few hundred bytes.
const MAX_RESPONSE: usize = 1 << 20;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("API socket I/O: {0}")]
    Io(#[from] io::Error),
    #[error("malformed API response: {0}")]
    Malformed(&'static str),
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
}

impl Api {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Sends one request and returns the response body on a 2xx status.
    pub async fn call(
        &self,
        method: &'static str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<Vec<u8>, ApiError> {
        let body = body.map(serde_json::Value::to_string).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut stream = UnixStream::connect(&self.socket).await?;
        stream.write_all(request.as_bytes()).await?;
        let (status, response) = read_response(&mut stream).await?;
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
        assert!(api.call("PUT", "/actions", None).await.unwrap().is_empty());
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
