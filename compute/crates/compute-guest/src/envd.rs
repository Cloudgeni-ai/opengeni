//! Talking to envd: its `/init` call and the little HTTP the guest needs.
//!
//! envd replaces its user environment on every `/init`, and once it holds
//! an access token it refuses an `/init` that does not carry the same one.
//! So the guest keeps the whole of what the sandbox was last given
//! ([`InitData`]) and sends all of it every time: after its first boot,
//! when a create gives the sandbox its own environment and token, after
//! every restore with the time, and after envd itself restarts.

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// What the sandbox was last given, and what a create's `init` carries.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitData {
    #[serde(default)]
    pub env_vars: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workdir: Option<String>,
}

impl fmt::Debug for InitData {
    /// Never shows the token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InitData")
            .field("env_vars", &self.env_vars.keys().collect::<Vec<_>>())
            .field("access_token", &self.access_token.as_ref().map(|_| "<set>"))
            .field("default_user", &self.default_user)
            .field("default_workdir", &self.default_workdir)
            .finish()
    }
}

impl InitData {
    /// The `/init` body: all of `self`, and the time `nanos` (Unix
    /// nanoseconds) when given.
    #[must_use]
    pub fn body(&self, nanos: Option<u64>) -> String {
        let mut body = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        if let Some(nanos) = nanos {
            body.insert("timestamp".into(), Value::String(rfc3339(nanos)));
        }
        Value::Object(body).to_string()
    }
}

/// `nanos` since the Unix epoch as RFC 3339 in UTC, with nanoseconds.
#[must_use]
pub fn rfc3339(nanos: u64) -> String {
    let seconds = nanos / 1_000_000_000;
    let fraction = nanos % 1_000_000_000;
    let days = seconds / 86_400;
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{fraction:09}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60
    )
}

/// The calendar date `days` after 1970-01-01 (Howard Hinnant's
/// `civil_from_days`, for days on or after the epoch).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

/// An HTTP/1.1 request to envd on the loopback, closing the connection
/// after the answer.
#[must_use]
pub fn request(method: &str, path: &str, json_body: Option<&str>) -> Vec<u8> {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    if let Some(body) = json_body {
        head.push_str("Content-Type: application/json\r\n");
        let _ = write!(head, "Content-Length: {}\r\n", body.len());
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    if let Some(body) = json_body {
        bytes.extend_from_slice(body.as_bytes());
    }
    bytes
}

/// The status code on an HTTP response's first line, once that line is
/// complete.
#[must_use]
pub fn status(response: &[u8]) -> Option<u16> {
    let end = response.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&response[..end]).ok()?;
    let mut words = line.split(' ');
    if !words.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let code = words.next()?;
    (code.len() == 3).then(|| code.parse().ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_rfc3339_with_nanoseconds() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000000000Z");
        // date -u -d @1760000000 → Thu Oct  9 08:53:20 UTC 2025
        assert_eq!(
            rfc3339(1_760_000_000_000_000_007),
            "2025-10-09T08:53:20.000000007Z"
        );
        // A leap day, and the last second of a year.
        assert_eq!(
            rfc3339(951_782_400 * 1_000_000_000),
            "2000-02-29T00:00:00.000000000Z"
        );
        assert_eq!(
            rfc3339(1_798_761_599 * 1_000_000_000 + 999_999_999),
            "2026-12-31T23:59:59.999999999Z"
        );
    }

    #[test]
    fn bodies_carry_everything_kept_and_the_time() {
        let data = InitData {
            env_vars: BTreeMap::from([("A".into(), "1".into())]),
            access_token: Some("secret".into()),
            default_user: Some("user".into()),
            default_workdir: None,
        };
        let body: Value = serde_json::from_str(&data.body(Some(0))).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "envVars": {"A": "1"},
                "accessToken": "secret",
                "defaultUser": "user",
                "timestamp": "1970-01-01T00:00:00.000000000Z",
            })
        );
        let bare: Value = serde_json::from_str(&InitData::default().body(None)).unwrap();
        assert_eq!(bare, serde_json::json!({"envVars": {}}));
    }

    #[test]
    fn init_commands_parse_strictly_and_never_print_the_token() {
        let data: InitData = serde_json::from_str(
            r#"{"envVars":{"X":"y"},"accessToken":"t0ken","defaultWorkdir":"/w"}"#,
        )
        .unwrap();
        assert_eq!(data.access_token.as_deref(), Some("t0ken"));
        assert!(!format!("{data:?}").contains("t0ken"));
        assert!(serde_json::from_str::<InitData>(r#"{"envvars":{}}"#).is_err());
        assert_eq!(
            serde_json::from_str::<InitData>("{}").unwrap(),
            InitData::default()
        );
    }

    #[test]
    fn requests_are_complete_http() {
        assert_eq!(
            request("GET", "/health", None),
            b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        );
        let post = String::from_utf8(request("POST", "/init", Some("{}"))).unwrap();
        assert!(post.starts_with("POST /init HTTP/1.1\r\n"));
        assert!(post.contains("Content-Length: 2\r\n"));
        assert!(post.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn reads_the_status_once_its_line_is_complete() {
        assert_eq!(
            status(b"HTTP/1.1 204 No Content\r\nX: y\r\n\r\n"),
            Some(204)
        );
        assert_eq!(status(b"HTTP/1.0 401 Unauthorized\r\n"), Some(401));
        assert_eq!(status(b"HTTP/1.1 204 No Con"), None);
        assert_eq!(status(b"HTTP/1.1 20 x\r\n"), None);
        assert_eq!(status(b"SSH-2.0 204\r\n"), None);
        assert_eq!(status(b"HTTP/1.1 abc x\r\n"), None);
    }
}
