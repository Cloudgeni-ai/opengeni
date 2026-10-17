//! The gateway port's one header line.
//!
//! A stream to [`crate::GATEWAY_PORT`] starts with a line that says what it
//! is for:
//!
//! - `tcp <port>`: the guest connects to that TCP port on its loopback,
//!   answers `ok`, and from then on relays bytes both ways until either
//!   side closes. A caller may send its first bytes right after the header
//!   without waiting for the answer.
//! - `init <json>`: the sandbox's own environment, access token, default
//!   user and directory ([`crate::envd::InitData`]), as a create gives
//!   them. The guest passes them to envd's `/init` and answers `ok` once
//!   envd took them; from then on it sends them again after every restore.
//!
//! Any failure is answered `error <reason>` and the stream is closed.

use crate::envd::InitData;

/// The longest header line the guest reads: room for an `init` with a
/// sizeable environment.
pub const MAX_HEADER: usize = 256 * 1024;

/// What a header asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Header {
    Tcp(u16),
    Init(Box<InitData>),
}

impl Header {
    /// Parses a header line, without its newline.
    pub fn parse(line: &str) -> Result<Self, String> {
        let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
        match verb {
            "tcp" => match rest.parse::<u16>() {
                Ok(port) if port != 0 => Ok(Self::Tcp(port)),
                _ => Err(format!("bad port {rest:?}")),
            },
            "init" => serde_json::from_str(rest)
                .map(|data| Self::Init(Box::new(data)))
                .map_err(|error| format!("bad init: {error}")),
            _ => Err("unknown request".into()),
        }
    }
}

/// The answer to a header that succeeded.
pub const OK: &[u8] = b"ok\n";

/// The answer to one that failed. The reason is kept to one line.
#[must_use]
pub fn error(reason: &str) -> Vec<u8> {
    let reason: String = reason
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    format!("error {reason}\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_names_a_port() {
        assert_eq!(Header::parse("tcp 49983"), Ok(Header::Tcp(49983)));
        for bad in ["tcp", "tcp 0", "tcp 65536", "tcp -1", "tcp 80 81", "tcp x"] {
            assert!(Header::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn init_carries_init_data() {
        let Ok(Header::Init(data)) =
            Header::parse(r#"init {"envVars":{"A":"1"},"accessToken":"t"}"#)
        else {
            panic!()
        };
        assert_eq!(data.env_vars["A"], "1");
        assert_eq!(data.access_token.as_deref(), Some("t"));
        assert!(Header::parse("init").is_err());
        assert!(Header::parse("init {").is_err());
        assert!(Header::parse(r#"init {"unknown":1}"#).is_err());
    }

    #[test]
    fn other_words_are_refused() {
        assert!(Header::parse("").is_err());
        assert!(Header::parse("TCP 80").is_err());
        assert!(Header::parse("restored 1 order=1.1").is_err());
    }

    #[test]
    fn errors_are_one_line() {
        assert_eq!(error("no\nway"), b"error no way\n");
        assert_eq!(error(&"x".repeat(500)).len(), "error \n".len() + 200);
    }
}
