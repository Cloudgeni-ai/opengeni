//! Talking to envd: its `/init` call and the little HTTP the guest needs.
//!
//! envd replaces its user environment on every `/init`, and once it holds
//! an access token it refuses an `/init` that does not carry the same one.
//! So the guest keeps the whole of what the sandbox was last given
//! ([`InitData`]) and sends all of it every time: after its first boot,
//! when a create gives the sandbox its own environment and token, after
//! every restore, and after envd itself restarts.
//!
//! The guest sends no `timestamp`. envd applies an `/init` with one only
//! when it is later than the latest it applied, and answers success either
//! way. The guest's clock can step back (a retried restore notice the
//! guest got to late carries the host's time from when it was sent), and
//! envd would then drop the next `/init` without a word: a create's access
//! token with it, leaving envd open to requests without one. The guest
//! already makes its calls one at a time, each with everything it keeps,
//! and sets its clock itself from the host's notices, so envd has nothing
//! to order and no time to set.

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
    /// The Opengeni agent the guest runs, never sent to envd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentInit>,
}

/// What the guest needs to run Opengeni's agent
/// ([`docs/agent-link.md`](../../../docs/agent-link.md) section 2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInit {
    pub workspace_id: String,
    pub agent_id: String,
    /// Where the agent's workspace is, which it serves files under.
    pub workspace_root: String,
    /// Whether it starts a virtual desktop.
    #[serde(default)]
    pub desktop: bool,
}

impl fmt::Debug for InitData {
    /// Never shows the token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InitData")
            .field("env_vars", &self.env_vars.keys().collect::<Vec<_>>())
            .field("access_token", &self.access_token.as_ref().map(|_| "<set>"))
            .field("default_user", &self.default_user)
            .field("default_workdir", &self.default_workdir)
            .field("agent", &self.agent)
            .finish()
    }
}

impl InitData {
    /// The `/init` body: all of `self` but the agent, and no `timestamp`
    /// (see the module documentation).
    #[must_use]
    pub fn body(&self) -> String {
        let mut body = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        body.remove("agent");
        Value::Object(body).to_string()
    }
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
    fn bodies_carry_everything_kept_and_never_a_time() {
        let data = InitData {
            env_vars: BTreeMap::from([("A".into(), "1".into())]),
            access_token: Some("secret".into()),
            default_user: Some("user".into()),
            default_workdir: None,
            agent: Some(AgentInit {
                workspace_id: "w".into(),
                agent_id: "a".into(),
                workspace_root: "/workspace".into(),
                desktop: true,
            }),
        };
        let body: Value = serde_json::from_str(&data.body()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "envVars": {"A": "1"},
                "accessToken": "secret",
                "defaultUser": "user",
            })
        );
        let bare: Value = serde_json::from_str(&InitData::default().body()).unwrap();
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
