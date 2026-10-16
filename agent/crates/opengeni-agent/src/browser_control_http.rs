//! In-process loopback requests to the agent-owned browser/computer controller.
//!
//! The control plane names an authority scope, never a local port: the sidecar
//! manager resolves the exact scope and generation to its own browserd endpoint
//! and this module sends one HTTP request there over a pooled keep-alive
//! client. That replaces the legacy transport, which started a shell, curl and
//! base64 on the machine for every click, key and observation.
//!
//! A reply must fit the transport's negotiated payload. A larger body is
//! returned in part and the remainder is kept in a short-lived, bounded spool
//! that the control plane drains with `BrowserControlHttpRead`; the controller
//! request itself is never sent twice, so a mutation's result is never lost to
//! the reply size.

use std::{collections::HashMap, time::Duration};

use opengeni_agent_platform::{
    PlatformError, PlatformResult, BROWSER_CONTROL_HTTP_MAX_HEADER_BYTES,
};
use opengeni_agent_proto::v1;
use tokio::time::Instant;

const MAX_PATH_BYTES: usize = 8 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_RESPONSE_HEADERS: usize = 128;
const SPOOL_TTL: Duration = Duration::from_secs(120);
const SPOOL_MAX_BYTES: usize = 256 * 1024 * 1024;
const SPOOL_MAX_ENTRIES: usize = 64;

/// One pooled loopback client per manager: no proxy, no redirects, and
/// keep-alive so a request does not pay a TCP handshake.
pub(crate) fn client() -> PlatformResult<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| PlatformError::os("browser controller request client is unavailable"))
}

/// A request whose method, path, size and deadline were checked before any
/// local endpoint is touched.
#[derive(Debug)]
pub(crate) struct CheckedRequest {
    method: reqwest::Method,
    path: String,
    timeout: Duration,
    max_response_bytes: u64,
}

fn invalid(message: &str) -> PlatformError {
    let mut error = PlatformError::os(format!("invalid browser controller request: {message}"));
    if let PlatformError::Os { detail, .. } = &mut error {
        detail.insert("reason".to_string(), "invalid_request".to_string());
    }
    error
}

pub(crate) fn check(req: &v1::BrowserControlHttpRequest) -> PlatformResult<CheckedRequest> {
    let method = match req.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(invalid("unsupported method")),
    };
    let path = req.path.as_str();
    // An origin-form path only: no scheme, authority, fragment, whitespace or
    // control characters, so the request cannot leave the resolved endpoint.
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || !path.starts_with('/')
        || path.starts_with("//")
        || path
            .bytes()
            .any(|byte| byte <= b' ' || byte == 0x7f || byte == b'#' || byte == b'\\')
    {
        return Err(invalid("path must be an absolute controller path"));
    }
    if req.bearer_token.is_empty()
        || req.bearer_token.len() > 4 * 1024
        || req
            .bearer_token
            .bytes()
            .any(|byte| !(0x21..=0x7e).contains(&byte))
    {
        return Err(invalid("bearer token is malformed"));
    }
    if !req.has_body && !req.body.is_empty() {
        return Err(invalid("body was supplied without has_body"));
    }
    if req.body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(invalid("body is too large"));
    }
    let timeout = match req.timeout_ms {
        0 => DEFAULT_TIMEOUT,
        millis => Duration::from_millis(u64::from(millis)).min(MAX_TIMEOUT),
    };
    let max_response_bytes = match req.max_response_bytes {
        0 => MAX_RESPONSE_BYTES,
        bytes => bytes.min(MAX_RESPONSE_BYTES),
    };
    Ok(CheckedRequest {
        method,
        path: path.to_string(),
        timeout,
        max_response_bytes,
    })
}

/// Sends the checked request to `127.0.0.1:port` and returns the reply,
/// spooling any body beyond `inline_limit`.
pub(crate) async fn send(
    client: &reqwest::Client,
    port: u16,
    req: &v1::BrowserControlHttpRequest,
    checked: CheckedRequest,
    inline_limit: Option<usize>,
    spool: &std::sync::Mutex<ResponseSpool>,
) -> PlatformResult<v1::BrowserControlHttpResponse> {
    let CheckedRequest {
        method,
        path,
        timeout,
        max_response_bytes,
    } = checked;
    let mut request = client
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .bearer_auth(&req.bearer_token);
    if req.has_body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(req.body.clone());
    }
    let exchange = async {
        let mut response = request.send().await.map_err(|error| {
            if error.is_connect() {
                // Nothing reached the controller; the caller may ensure it and
                // send again regardless of method.
                PlatformError::NotFound(
                    "browser controller is not accepting connections".to_string(),
                )
            } else {
                PlatformError::os("browser controller request failed")
            }
        })?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers())?;
        if response
            .content_length()
            .is_some_and(|length| length > max_response_bytes)
        {
            return Err(too_large());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PlatformError::os("browser controller response was interrupted"))?
        {
            if (body.len() + chunk.len()) as u64 > max_response_bytes {
                return Err(too_large());
            }
            body.extend_from_slice(&chunk);
        }
        Ok((status, headers, body))
    };
    let (status, headers, mut body) =
        tokio::time::timeout(timeout, exchange)
            .await
            .map_err(|_| {
                PlatformError::Timeout(
                    "browser controller request exceeded its deadline".to_string(),
                )
            })??;
    let total_bytes = body.len() as u64;
    let spool_id = match inline_limit {
        Some(limit) if body.len() > limit => {
            let rest = body.split_off(limit);
            spool
                .lock()
                .map_err(|_| PlatformError::os("browser controller response spool is unavailable"))?
                .insert(rest, limit as u64)?
        }
        _ => String::new(),
    };
    Ok(v1::BrowserControlHttpResponse {
        status: u32::from(status),
        headers,
        body: body.into(),
        total_bytes,
        spool_id,
    })
}

fn too_large() -> PlatformError {
    PlatformError::os("browser controller response exceeds its byte bound")
}

fn response_headers(
    headers: &reqwest::header::HeaderMap,
) -> PlatformResult<Vec<v1::BrowserControlHttpHeader>> {
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for (name, value) in headers {
        let Ok(value) = value.to_str() else {
            continue;
        };
        bytes += name.as_str().len() + value.len() + 4;
        if out.len() >= MAX_RESPONSE_HEADERS || bytes > BROWSER_CONTROL_HTTP_MAX_HEADER_BYTES {
            return Err(PlatformError::os(
                "browser controller response headers exceed their bound",
            ));
        }
        out.push(v1::BrowserControlHttpHeader {
            // `HeaderName` is already lowercase.
            name: name.as_str().to_string(),
            value: value.to_string(),
        });
    }
    Ok(out)
}

#[derive(Debug)]
struct SpooledBody {
    /// Body bytes after the inline part.
    rest: Vec<u8>,
    /// Absolute offset of `rest[0]` in the complete body.
    start: u64,
    expires: Instant,
}

/// Remainders of controller bodies too large for one reply, bounded in count,
/// bytes and age. Reading the last part releases an entry.
#[derive(Debug, Default)]
pub(crate) struct ResponseSpool {
    entries: HashMap<String, SpooledBody>,
    bytes: usize,
}

impl ResponseSpool {
    fn prune(&mut self, now: Instant) {
        let mut released = 0usize;
        self.entries.retain(|_, entry| {
            let keep = entry.expires > now;
            if !keep {
                released += entry.rest.len();
            }
            keep
        });
        self.bytes -= released;
    }

    fn insert(&mut self, rest: Vec<u8>, start: u64) -> PlatformResult<String> {
        let now = Instant::now();
        self.prune(now);
        if self.entries.len() >= SPOOL_MAX_ENTRIES || self.bytes + rest.len() > SPOOL_MAX_BYTES {
            return Err(PlatformError::os(
                "browser controller response spool is full; the response was not retained",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.bytes += rest.len();
        self.entries.insert(
            id.clone(),
            SpooledBody {
                rest,
                start,
                expires: now + SPOOL_TTL,
            },
        );
        Ok(id)
    }

    /// Returns up to `max_bytes` from `offset` and whether that ends the body.
    pub(crate) fn read(
        &mut self,
        req: &v1::BrowserControlHttpReadRequest,
        max_bytes: Option<usize>,
    ) -> PlatformResult<v1::BrowserControlHttpReadResponse> {
        self.prune(Instant::now());
        let entry = self.entries.get(&req.spool_id).ok_or_else(|| {
            PlatformError::NotFound("browser controller response is no longer retained".to_string())
        })?;
        let relative = req
            .offset
            .checked_sub(entry.start)
            .and_then(|offset| usize::try_from(offset).ok())
            .filter(|offset| *offset <= entry.rest.len())
            .ok_or_else(|| invalid("spool offset is out of range"))?;
        let end = max_bytes.map_or(entry.rest.len(), |max| {
            relative.saturating_add(max).min(entry.rest.len())
        });
        let data = entry.rest[relative..end].to_vec();
        let done = end == entry.rest.len();
        if done {
            if let Some(entry) = self.entries.remove(&req.spool_id) {
                self.bytes -= entry.rest.len();
            }
        }
        Ok(v1::BrowserControlHttpReadResponse {
            data: data.into(),
            done,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str) -> v1::BrowserControlHttpRequest {
        v1::BrowserControlHttpRequest {
            scope_id: "scope".to_string(),
            scope_generation: "generation".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            bearer_token: "t".repeat(40),
            body: prost::bytes::Bytes::new(),
            has_body: false,
            timeout_ms: 0,
            max_response_bytes: 0,
        }
    }

    #[test]
    fn check_accepts_controller_paths_and_rejects_escapes() {
        assert!(check(&request("GET", "/v1/sessions/a/targets?x=1")).is_ok());
        for path in [
            "",
            "v1/sessions",
            "//evil.example/v1",
            "/v1/a b",
            "/v1/a\r\nHost: x",
            "/v1/a#frag",
            "/v1\\a",
        ] {
            assert!(check(&request("GET", path)).is_err(), "{path:?}");
        }
        assert!(check(&request("PATCH", "/v1/a")).is_err());
        let mut token = request("GET", "/v1/a");
        token.bearer_token = "a b".to_string();
        assert!(check(&token).is_err());
        let mut body = request("POST", "/v1/a");
        body.body = b"{}".to_vec().into();
        assert!(check(&body).is_err(), "a body needs has_body");
    }

    #[test]
    fn check_bounds_deadline_and_response_size() {
        let mut req = request("GET", "/v1/a");
        req.timeout_ms = u32::MAX;
        req.max_response_bytes = u64::MAX;
        let checked = check(&req).expect("valid");
        assert_eq!(checked.timeout, MAX_TIMEOUT);
        assert_eq!(checked.max_response_bytes, MAX_RESPONSE_BYTES);
    }

    #[test]
    fn spool_reads_in_order_and_releases_on_the_last_part() {
        let mut spool = ResponseSpool::default();
        let id = spool.insert(b"0123456789".to_vec(), 4).expect("insert");
        let read = |spool: &mut ResponseSpool, offset| {
            spool.read(
                &v1::BrowserControlHttpReadRequest {
                    spool_id: id.clone(),
                    offset,
                },
                Some(4),
            )
        };
        let first = read(&mut spool, 4).expect("first");
        assert_eq!((&first.data[..], first.done), (&b"0123"[..], false));
        let second = read(&mut spool, 8).expect("second");
        assert_eq!((&second.data[..], second.done), (&b"4567"[..], false));
        assert!(read(&mut spool, 3).is_err(), "before the spooled start");
        let last = read(&mut spool, 12).expect("last");
        assert_eq!((&last.data[..], last.done), (&b"89"[..], true));
        assert_eq!(spool.bytes, 0);
        assert!(matches!(
            read(&mut spool, 14),
            Err(PlatformError::NotFound(_))
        ));
    }

    #[test]
    fn spool_refuses_beyond_its_bounds() {
        let mut spool = ResponseSpool::default();
        for _ in 0..SPOOL_MAX_ENTRIES {
            spool.insert(vec![0; 1], 0).expect("insert");
        }
        assert!(spool.insert(vec![0; 1], 0).is_err());
    }

    #[tokio::test]
    async fn send_round_trips_and_spools_large_bodies() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let read = socket.read(&mut buf).await.expect("read");
                seen.extend_from_slice(&buf[..read]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(end) = text.find("\r\n\r\n") {
                    if seen.len() >= end + 4 + 2 {
                        break;
                    }
                }
            }
            let body = "x".repeat(10);
            let reply = format!(
                "HTTP/1.1 201 Created\r\nX-Opengeni-Frame: 7\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.expect("write");
            String::from_utf8_lossy(&seen).into_owned()
        });
        let mut req = request("POST", "/v1/act?y=2");
        req.has_body = true;
        req.body = b"{}".to_vec().into();
        let spool = std::sync::Mutex::new(ResponseSpool::default());
        let checked = check(&req).expect("valid");
        let response = send(
            &client().expect("client"),
            port,
            &req,
            checked,
            Some(4),
            &spool,
        )
        .await
        .expect("send");
        let seen = server.await.expect("server");
        assert!(seen.starts_with("POST /v1/act?y=2 HTTP/1.1\r\n"), "{seen}");
        assert!(seen.contains(&format!("authorization: Bearer {}", "t".repeat(40))));
        assert!(seen.contains("content-type: application/json"));
        assert_eq!(response.status, 201);
        assert_eq!(response.total_bytes, 10);
        assert_eq!(&response.body[..], b"xxxx");
        assert!(response
            .headers
            .iter()
            .any(|header| header.name == "x-opengeni-frame" && header.value == "7"));
        let rest = spool
            .lock()
            .expect("spool")
            .read(
                &v1::BrowserControlHttpReadRequest {
                    spool_id: response.spool_id,
                    offset: 4,
                },
                None,
            )
            .expect("rest");
        assert_eq!((&rest.data[..], rest.done), (&b"xxxxxx"[..], true));
    }

    #[tokio::test]
    async fn send_reports_an_absent_controller_as_not_found() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let req = request("POST", "/v1/act");
        let spool = std::sync::Mutex::new(ResponseSpool::default());
        let error = send(
            &client().expect("client"),
            port,
            &req,
            check(&req).expect("valid"),
            None,
            &spool,
        )
        .await
        .expect_err("closed port");
        assert!(matches!(error, PlatformError::NotFound(_)), "{error:?}");
    }
}
