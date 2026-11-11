//! Which sandbox and port a request to the front door is for.
//!
//! E2B names them two ways, and the SDK uses both: by host name,
//! `<port>-<id>.<domain>` (signed file URLs and `getHost` use it), and by
//! the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers it adds to every
//! envd request, which work whatever host the request went to. A request
//! that names neither is for the REST API.

use axum::http::HeaderMap;
use axum::http::header::CONTENT_TYPE;
use compute_protocol::host::Id;

/// The header naming the sandbox.
pub const SANDBOX_ID: &str = "e2b-sandbox-id";
/// The header naming the port.
pub const SANDBOX_PORT: &str = "e2b-sandbox-port";
/// The header carrying the traffic token, as E2B names it.
pub const TRAFFIC_TOKEN: &str = "e2b-traffic-access-token";

/// A sandbox's port, as a request names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Target {
    pub id: Id,
    pub port: u16,
}

fn parse(id: &str, port: &str) -> Result<Target, String> {
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("bad sandbox port {port:?}"))?;
    let id = id
        .parse::<Id>()
        .map_err(|_| format!("no sandbox {id:?} here"))?;
    Ok(Target { id, port })
}

/// The sandbox and port a request names, by its headers or else by its
/// host name under `domain`; `None` when it names neither.
///
/// # Errors
///
/// When it names them badly: a port that is not one, or an id that names
/// no sandbox here.
#[must_use]
pub fn target(headers: &HeaderMap, domain: &str) -> Option<Result<Target, String>> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    if let (Some(id), Some(port)) = (header(SANDBOX_ID), header(SANDBOX_PORT)) {
        return Some(parse(id, port));
    }
    let host = header("host")?;
    // Without a port: `host:port`, or `[v6]:port`, is never a sandbox name.
    let host = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.bytes().all(|byte| byte.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    let name = host
        .len()
        .checked_sub(domain.len() + 1)
        .filter(|&end| host.as_bytes()[end] == b'.' && host[end + 1..].eq_ignore_ascii_case(domain))
        .map(|end| &host[..end])?;
    let (port, id) = name.split_once('-')?;
    Some(parse(id, port))
}

/// Whether a request opens a stream: Connect RPC's streaming calls (a
/// command's output, a PTY, a directory watch) use the `application/connect+`
/// content types, unary calls and plain HTTP never do. While one is open the
/// sandbox counts as someone connected.
#[must_use]
pub fn is_stream(headers: &HeaderMap) -> bool {
    const PREFIX: &str = "application/connect+";
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.len() > PREFIX.len()
                && value
                    .get(..PREFIX.len())
                    .is_some_and(|start| start.eq_ignore_ascii_case(PREFIX))
        })
}

/// Headers that belong to one connection, which a proxy does not pass on.
pub const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
];

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    const ID: &str = "0192a1b2c3d47e5f8a9b0c1d2e3f4a5b";

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn id() -> Id {
        ID.parse().unwrap()
    }

    #[test]
    fn headers_name_the_sandbox_whatever_the_host() {
        let found = target(
            &headers(&[
                ("host", "localhost:3000"),
                ("E2b-Sandbox-Id", ID),
                ("E2b-Sandbox-Port", "49983"),
            ]),
            "sbx.test",
        );
        assert_eq!(
            found,
            Some(Ok(Target {
                id: id(),
                port: 49983
            }))
        );
    }

    #[test]
    fn a_host_name_under_the_domain_names_it_with_or_without_a_port() {
        for host in [
            format!("8080-{ID}.sbx.test"),
            format!("8080-{ID}.SBX.test:443"),
        ] {
            assert_eq!(
                target(&headers(&[("host", &host)]), "sbx.test"),
                Some(Ok(Target {
                    id: id(),
                    port: 8080
                })),
                "{host}"
            );
        }
    }

    #[test]
    fn other_hosts_are_the_api() {
        for host in [
            "api.sbx.test",
            "sbx.test",
            "localhost:3000",
            "8080-x.other.test",
            "x8080-abc.sbx.testing",
            "[::1]:3000",
        ] {
            let found = target(&headers(&[("host", host)]), "sbx.test");
            assert!(
                found.is_none() || found.as_ref().is_some_and(Result::is_err),
                "{host}: {found:?}"
            );
        }
        assert_eq!(
            target(&headers(&[("host", "api.sbx.test")]), "sbx.test"),
            None
        );
        assert_eq!(target(&HeaderMap::new(), "sbx.test"), None);
    }

    #[test]
    fn bad_names_are_errors_not_the_api() {
        for (id, port) in [(ID, "0"), (ID, "65536"), (ID, "x"), ("not-an-id", "80")] {
            let found = target(
                &headers(&[("e2b-sandbox-id", id), ("e2b-sandbox-port", port)]),
                "sbx.test",
            );
            assert!(matches!(found, Some(Err(_))), "{id} {port}: {found:?}");
        }
        let found = target(&headers(&[("host", "80-nothing.sbx.test")]), "sbx.test");
        assert!(matches!(found, Some(Err(_))));
    }

    #[test]
    fn only_connect_streaming_content_types_open_streams() {
        for streaming in ["application/connect+json", "application/connect+proto"] {
            assert!(
                is_stream(&headers(&[("content-type", streaming)])),
                "{streaming}"
            );
        }
        for unary in [
            "application/json",
            "application/proto",
            "application/connect+",
            "text/plain",
        ] {
            assert!(!is_stream(&headers(&[("content-type", unary)])), "{unary}");
        }
        assert!(!is_stream(&HeaderMap::new()));
    }
}
