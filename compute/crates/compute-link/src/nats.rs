//! The NATS client protocol, from the server's side: the operations a
//! guest's agent sends, parsed incrementally, and the ones the host sends
//! back.
//!
//! This is the subset the agent's client uses
//! (<https://docs.nats.io/reference/reference-protocols/nats-protocol>):
//! `CONNECT`, `PING`, `PONG`, `SUB`, `UNSUB`, `PUB` and `HPUB` in, and
//! `INFO`, `MSG`, `HMSG`, `PING`, `PONG`, `+OK` and `-ERR` out. Operation
//! names are case-insensitive and fields are separated by spaces or tabs.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use compute_protocol::link::Headers;
use serde::{Deserialize, Serialize};

/// The longest control line accepted, as a NATS server's default.
pub const MAX_CONTROL_LINE: usize = 4096;

/// The version line of a header block.
const HEADER_VERSION: &[u8] = b"NATS/1.0";

/// An operation a client sends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientOp {
    Connect(Connect),
    Ping,
    Pong,
    Sub {
        subject: String,
        queue: Option<String>,
        sid: String,
    },
    Unsub {
        sid: String,
        /// Unsubscribe once this many messages were delivered in all.
        max: Option<u64>,
    },
    Pub(Publish),
}

/// A `PUB` or `HPUB`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publish {
    pub subject: String,
    pub reply: Option<String>,
    pub headers: Option<Headers>,
    pub payload: Bytes,
}

impl Publish {
    /// The bytes it carries, headers included, as a server counts them
    /// against its maximum payload.
    #[must_use]
    pub fn size(&self) -> usize {
        self.payload.len() + self.headers.as_ref().map_or(0, header_block_len)
    }
}

/// What a client's `CONNECT` states, of what the host uses.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Connect {
    #[serde(default)]
    pub verbose: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub headers: bool,
}

/// Why a client's bytes are not the protocol. The connection ends.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("a control line is longer than {MAX_CONTROL_LINE} bytes")]
    LineTooLong,
    #[error("unknown protocol operation")]
    UnknownOp,
    #[error("a malformed {0} operation")]
    Malformed(&'static str),
    #[error("a payload of {0} bytes is over the limit")]
    TooLarge(usize),
    #[error("a malformed header block")]
    Headers,
}

impl ProtocolError {
    /// The `-ERR` text a NATS server sends for it.
    #[must_use]
    pub fn server_text(&self) -> &'static str {
        match self {
            Self::LineTooLong => "Maximum Control Line Exceeded",
            Self::TooLarge(_) => "Maximum Payload Violation",
            Self::UnknownOp => "Unknown Protocol Operation",
            Self::Malformed(_) | Self::Headers => "Protocol Error",
        }
    }
}

/// Parses the next operation from the front of `buffer`, removing its
/// bytes, or answers `None` until `buffer` holds a whole one. Empty lines
/// are skipped. A payload larger than `max_payload` is an error before any
/// of it is buffered.
///
/// # Errors
///
/// When the bytes are not the client protocol.
pub fn parse(buffer: &mut BytesMut, max_payload: usize) -> Result<Option<ClientOp>, ProtocolError> {
    loop {
        let Some(end) = line_end(buffer)? else {
            return Ok(None);
        };
        if buffer[..end]
            .iter()
            .all(|byte| *byte == b' ' || *byte == b'\t')
        {
            buffer.advance(end + 2);
            continue;
        }
        return parse_line(buffer, end, max_payload);
    }
}

/// Parses the operation whose control line ends at `end`.
fn parse_line(
    buffer: &mut BytesMut,
    end: usize,
    max_payload: usize,
) -> Result<Option<ClientOp>, ProtocolError> {
    let line = &buffer[..end];
    let mut fields = line
        .split(|byte| *byte == b' ' || *byte == b'\t')
        .filter(|field| !field.is_empty());
    let op = fields
        .next()
        .ok_or(ProtocolError::UnknownOp)?
        .to_ascii_uppercase();
    let parsed = match op.as_slice() {
        b"PING" => {
            buffer.advance(end + 2);
            ClientOp::Ping
        }
        b"PONG" => {
            buffer.advance(end + 2);
            ClientOp::Pong
        }
        b"CONNECT" => {
            let json = line
                .get(op.len()..)
                .map(<[u8]>::trim_ascii)
                .ok_or(ProtocolError::Malformed("CONNECT"))?;
            let connect =
                serde_json::from_slice(json).map_err(|_| ProtocolError::Malformed("CONNECT"))?;
            buffer.advance(end + 2);
            ClientOp::Connect(connect)
        }
        b"SUB" => {
            let fields: Vec<&[u8]> = fields.collect();
            let (subject, queue, sid) = match fields.as_slice() {
                [subject, sid] => (*subject, None, *sid),
                [subject, queue, sid] => (*subject, Some(*queue), *sid),
                _ => return Err(ProtocolError::Malformed("SUB")),
            };
            let op = ClientOp::Sub {
                subject: text(subject, "SUB")?,
                queue: queue.map(|queue| text(queue, "SUB")).transpose()?,
                sid: text(sid, "SUB")?,
            };
            buffer.advance(end + 2);
            op
        }
        b"UNSUB" => {
            let fields: Vec<&[u8]> = fields.collect();
            let (sid, max) = match fields.as_slice() {
                [sid] => (*sid, None),
                [sid, max] => (*sid, Some(number(max, "UNSUB")?)),
                _ => return Err(ProtocolError::Malformed("UNSUB")),
            };
            let op = ClientOp::Unsub {
                sid: text(sid, "UNSUB")?,
                max: max.map(|max| max as u64),
            };
            buffer.advance(end + 2);
            op
        }
        b"PUB" => {
            let fields: Vec<&[u8]> = fields.collect();
            let (subject, reply, size) = match fields.as_slice() {
                [subject, size] => (*subject, None, *size),
                [subject, reply, size] => (*subject, Some(*reply), *size),
                _ => return Err(ProtocolError::Malformed("PUB")),
            };
            let size = number(size, "PUB")?;
            let publish = Publish {
                subject: text(subject, "PUB")?,
                reply: reply.map(|reply| text(reply, "PUB")).transpose()?,
                headers: None,
                payload: Bytes::new(),
            };
            return take_payload(buffer, end, publish, 0, size, max_payload);
        }
        b"HPUB" => {
            let fields: Vec<&[u8]> = fields.collect();
            let (subject, reply, header_size, total) = match fields.as_slice() {
                [subject, header_size, total] => (*subject, None, *header_size, *total),
                [subject, reply, header_size, total] => {
                    (*subject, Some(*reply), *header_size, *total)
                }
                _ => return Err(ProtocolError::Malformed("HPUB")),
            };
            let header_size = number(header_size, "HPUB")?;
            let total = number(total, "HPUB")?;
            if header_size > total {
                return Err(ProtocolError::Malformed("HPUB"));
            }
            let publish = Publish {
                subject: text(subject, "HPUB")?,
                reply: reply.map(|reply| text(reply, "HPUB")).transpose()?,
                headers: Some(Headers::new()),
                payload: Bytes::new(),
            };
            return take_payload(buffer, end, publish, header_size, total, max_payload);
        }
        _ => return Err(ProtocolError::UnknownOp),
    };
    Ok(Some(parsed))
}

/// Takes a publication's header block and payload, `total` bytes after
/// its control line ends at `end`, once they are all in `buffer`.
fn take_payload(
    buffer: &mut BytesMut,
    end: usize,
    mut publish: Publish,
    header_size: usize,
    total: usize,
    max_payload: usize,
) -> Result<Option<ClientOp>, ProtocolError> {
    let op = if publish.headers.is_some() {
        "HPUB"
    } else {
        "PUB"
    };
    if total > max_payload {
        return Err(ProtocolError::TooLarge(total));
    }
    let start = end + 2;
    if buffer.len() < start + total + 2 {
        buffer.reserve(start + total + 2 - buffer.len());
        return Ok(None);
    }
    if &buffer[start + total..start + total + 2] != b"\r\n" {
        return Err(ProtocolError::Malformed(op));
    }
    if publish.headers.is_some() {
        publish.headers = Some(parse_headers(&buffer[start..start + header_size])?);
    }
    buffer.advance(start + header_size);
    publish.payload = buffer.split_to(total - header_size).freeze();
    buffer.advance(2);
    Ok(Some(ClientOp::Pub(publish)))
}

/// Where the first control line in `buffer` ends (its `\r`), if it does.
fn line_end(buffer: &[u8]) -> Result<Option<usize>, ProtocolError> {
    let window = &buffer[..buffer.len().min(MAX_CONTROL_LINE + 2)];
    match window.windows(2).position(|pair| pair == b"\r\n") {
        Some(end) if end > MAX_CONTROL_LINE => Err(ProtocolError::LineTooLong),
        Some(end) => Ok(Some(end)),
        None if buffer.len() > MAX_CONTROL_LINE + 1 => Err(ProtocolError::LineTooLong),
        None => Ok(None),
    }
}

fn text(field: &[u8], op: &'static str) -> Result<String, ProtocolError> {
    std::str::from_utf8(field)
        .map(str::to_owned)
        .map_err(|_| ProtocolError::Malformed(op))
}

fn number(field: &[u8], op: &'static str) -> Result<usize, ProtocolError> {
    std::str::from_utf8(field)
        .ok()
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|digits| digits.parse().ok())
        .ok_or(ProtocolError::Malformed(op))
}

/// Parses a header block: `NATS/1.0`, an optional status, then
/// `Name: value` lines, then an empty line. A status line's code is not
/// kept: clients state none.
///
/// # Errors
///
/// When the block is not one.
pub fn parse_headers(block: &[u8]) -> Result<Headers, ProtocolError> {
    let block = std::str::from_utf8(block).map_err(|_| ProtocolError::Headers)?;
    let body = block
        .strip_suffix("\r\n\r\n")
        .ok_or(ProtocolError::Headers)?;
    let mut lines = body.split("\r\n");
    let version = lines.next().ok_or(ProtocolError::Headers)?;
    if !version.as_bytes().starts_with(HEADER_VERSION) {
        return Err(ProtocolError::Headers);
    }
    let mut headers = Headers::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(ProtocolError::Headers)?;
        if name.is_empty() || name.contains([' ', '\t']) {
            return Err(ProtocolError::Headers);
        }
        headers.push((name.to_owned(), value.trim_start().to_owned()));
    }
    Ok(headers)
}

/// The length of `headers` as a header block.
fn header_block_len(headers: &Headers) -> usize {
    HEADER_VERSION.len()
        + 2
        + headers
            .iter()
            .map(|(name, value)| name.len() + 2 + value.len() + 2)
            .sum::<usize>()
        + 2
}

fn put_headers(out: &mut BytesMut, headers: &Headers) {
    out.put_slice(HEADER_VERSION);
    out.put_slice(b"\r\n");
    for (name, value) in headers {
        out.put_slice(name.as_bytes());
        out.put_slice(b": ");
        out.put_slice(value.as_bytes());
        out.put_slice(b"\r\n");
    }
    out.put_slice(b"\r\n");
}

/// What the host tells a client about itself in `INFO`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Info {
    pub server_id: &'static str,
    pub server_name: &'static str,
    pub version: &'static str,
    pub proto: u8,
    pub host: &'static str,
    pub port: u16,
    pub headers: bool,
    pub auth_required: bool,
    pub max_payload: u32,
    pub client_id: u64,
}

impl Info {
    /// The host's `INFO` for client `client_id`, under the gateway's
    /// maximum payload.
    #[must_use]
    pub fn new(max_payload: u32, client_id: u64) -> Self {
        Self {
            server_id: "compute-host",
            server_name: "compute-host",
            version: "2.10.0",
            proto: 1,
            host: "127.0.0.1",
            port: 4222,
            headers: true,
            auth_required: false,
            max_payload,
            client_id,
        }
    }
}

/// An operation the host sends a client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerOp {
    Info(Info),
    Ping,
    Pong,
    Ok,
    /// `-ERR '<text>'`.
    Err(String),
    Msg(Delivery),
}

/// A message for one of a client's subscriptions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub subject: String,
    pub sid: String,
    pub reply: Option<String>,
    pub headers: Option<Headers>,
    pub payload: Bytes,
}

impl ServerOp {
    /// Appends its bytes to `out`.
    pub fn write(&self, out: &mut BytesMut) {
        match self {
            Self::Info(info) => {
                out.put_slice(b"INFO ");
                // An `Info` always encodes.
                out.put_slice(&serde_json::to_vec(info).unwrap_or_default());
                out.put_slice(b"\r\n");
            }
            Self::Ping => out.put_slice(b"PING\r\n"),
            Self::Pong => out.put_slice(b"PONG\r\n"),
            Self::Ok => out.put_slice(b"+OK\r\n"),
            Self::Err(text) => {
                out.put_slice(b"-ERR '");
                out.put_slice(text.replace(['\r', '\n', '\''], " ").as_bytes());
                out.put_slice(b"'\r\n");
            }
            Self::Msg(delivery) => delivery.write(out),
        }
    }
}

impl Delivery {
    fn write(&self, out: &mut BytesMut) {
        let header_len = self.headers.as_ref().map(header_block_len);
        out.put_slice(if header_len.is_some() {
            b"HMSG "
        } else {
            b"MSG "
        });
        out.put_slice(self.subject.as_bytes());
        out.put_u8(b' ');
        out.put_slice(self.sid.as_bytes());
        if let Some(reply) = &self.reply {
            out.put_u8(b' ');
            out.put_slice(reply.as_bytes());
        }
        if let Some(header_len) = header_len {
            out.put_slice(
                format!(" {header_len} {}\r\n", header_len + self.payload.len()).as_bytes(),
            );
        } else {
            out.put_slice(format!(" {}\r\n", self.payload.len()).as_bytes());
        }
        if let Some(headers) = &self.headers {
            put_headers(out, headers);
        }
        out.put_slice(&self.payload);
        out.put_slice(b"\r\n");
    }
}

/// Whether `token` may be one token of a subject: not empty, and free of
/// separators, wildcards and whitespace.
#[must_use]
pub fn is_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|byte| !matches!(byte, b'.' | b'*' | b'>' | b' ' | b'\t' | b'\r' | b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(bytes: &[u8]) -> Result<Vec<ClientOp>, ProtocolError> {
        let mut buffer = BytesMut::from(bytes);
        let mut ops = Vec::new();
        while let Some(op) = parse(&mut buffer, 1 << 20)? {
            ops.push(op);
        }
        assert!(buffer.is_empty(), "incomplete input {buffer:?}");
        Ok(ops)
    }

    #[test]
    fn parses_every_client_operation() {
        let input = b"CONNECT {\"verbose\":true,\"name\":\"opengeni-agent/connection/i1\",\"headers\":true,\"lang\":\"rust\"}\r\n\
            ping\r\n\r\nPONG\r\n\
            SUB agent.w.a.connection.i1.rpc 1\r\n\
            SUB agent.w.a.connection.i1.ops q 2\r\n\
            UNSUB 1\r\nUNSUB 2 5\r\n\
            PUB _INBOX.x.1 5\r\nhello\r\n\
            PUB\tagent.w.a.connection.i1.ev  r.1 0\r\n\r\n\
            HPUB agent.w.a.connection.i1.ev 27 30\r\nNATS/1.0\r\nA: 1\r\nB:  two\r\n\r\nabc\r\n";
        let ops = all(input).unwrap();
        assert_eq!(
            ops,
            vec![
                ClientOp::Connect(Connect {
                    verbose: true,
                    name: Some("opengeni-agent/connection/i1".into()),
                    headers: true,
                }),
                ClientOp::Ping,
                ClientOp::Pong,
                ClientOp::Sub {
                    subject: "agent.w.a.connection.i1.rpc".into(),
                    queue: None,
                    sid: "1".into()
                },
                ClientOp::Sub {
                    subject: "agent.w.a.connection.i1.ops".into(),
                    queue: Some("q".into()),
                    sid: "2".into()
                },
                ClientOp::Unsub {
                    sid: "1".into(),
                    max: None
                },
                ClientOp::Unsub {
                    sid: "2".into(),
                    max: Some(5)
                },
                ClientOp::Pub(Publish {
                    subject: "_INBOX.x.1".into(),
                    reply: None,
                    headers: None,
                    payload: Bytes::from_static(b"hello"),
                }),
                ClientOp::Pub(Publish {
                    subject: "agent.w.a.connection.i1.ev".into(),
                    reply: Some("r.1".into()),
                    headers: None,
                    payload: Bytes::new(),
                }),
                ClientOp::Pub(Publish {
                    subject: "agent.w.a.connection.i1.ev".into(),
                    reply: None,
                    headers: Some(vec![("A".into(), "1".into()), ("B".into(), "two".into())]),
                    payload: Bytes::from_static(b"abc"),
                }),
            ]
        );
    }

    #[test]
    fn waits_for_whole_operations_however_the_bytes_arrive() {
        let input: &[u8] =
            b"PUB a.b 11\r\nhello world\r\nHPUB c 12 14\r\nNATS/1.0\r\n\r\nhi\r\nPING\r\n";
        let whole = all(input).unwrap();
        for split in 0..input.len() {
            let mut buffer = BytesMut::new();
            let mut ops = Vec::new();
            for chunk in [&input[..split], &input[split..]] {
                buffer.extend_from_slice(chunk);
                while let Some(op) = parse(&mut buffer, 1 << 20).unwrap() {
                    ops.push(op);
                }
            }
            assert_eq!(ops, whole, "split at {split}");
            assert!(buffer.is_empty());
        }
    }

    #[test]
    fn refuses_what_is_not_the_protocol() {
        let error = |bytes: &[u8]| parse(&mut BytesMut::from(bytes), 16).unwrap_err();
        assert_eq!(error(b"NOPE\r\n"), ProtocolError::UnknownOp);
        assert_eq!(error(b"SUB a\r\n"), ProtocolError::Malformed("SUB"));
        assert_eq!(error(b"PUB a x\r\n"), ProtocolError::Malformed("PUB"));
        assert_eq!(error(b"PUB a 17\r\n"), ProtocolError::TooLarge(17));
        assert_eq!(
            error(b"PUB a 2\r\nabc\r\n"),
            ProtocolError::Malformed("PUB")
        );
        assert_eq!(error(b"HPUB a 5 4\r\n"), ProtocolError::Malformed("HPUB"));
        assert_eq!(error(b"HPUB a 4 4\r\nXXXX\r\n"), ProtocolError::Headers);
        assert_eq!(error(b"CONNECT {\r\n"), ProtocolError::Malformed("CONNECT"));
        assert_eq!(
            error(&[b'x'; MAX_CONTROL_LINE + 2]),
            ProtocolError::LineTooLong
        );
        let mut long = vec![b'x'; MAX_CONTROL_LINE + 1];
        long.extend_from_slice(b"\r\n");
        assert_eq!(error(&long), ProtocolError::LineTooLong);
        // A control line at the limit is still read.
        let mut at_limit = b"SUB ".to_vec();
        at_limit.extend(std::iter::repeat_n(b'a', MAX_CONTROL_LINE - 6));
        at_limit.extend_from_slice(b" 1\r\n");
        assert!(matches!(
            parse(&mut BytesMut::from(&at_limit[..]), 16),
            Ok(Some(ClientOp::Sub { .. }))
        ));
    }

    #[test]
    fn writes_server_operations() {
        let mut out = BytesMut::new();
        ServerOp::Msg(Delivery {
            subject: "a.b".into(),
            sid: "7".into(),
            reply: Some("_INBOX.1".into()),
            headers: None,
            payload: Bytes::from_static(b"hi"),
        })
        .write(&mut out);
        ServerOp::Msg(Delivery {
            subject: "a.b".into(),
            sid: "7".into(),
            reply: None,
            headers: Some(vec![("A".into(), "1".into())]),
            payload: Bytes::from_static(b"hi"),
        })
        .write(&mut out);
        ServerOp::Err("Permissions Violation for Publish to \"x\"".into()).write(&mut out);
        ServerOp::Pong.write(&mut out);
        ServerOp::Ok.write(&mut out);
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            "MSG a.b 7 _INBOX.1 2\r\nhi\r\n\
             HMSG a.b 7 18 20\r\nNATS/1.0\r\nA: 1\r\n\r\nhi\r\n\
             -ERR 'Permissions Violation for Publish to \"x\"'\r\n\
             PONG\r\n+OK\r\n"
        );
        let mut info = BytesMut::new();
        ServerOp::Info(Info::new(1 << 20, 9)).write(&mut info);
        let line = std::str::from_utf8(&info).unwrap();
        assert!(line.starts_with("INFO {") && line.ends_with("}\r\n"));
        let json: serde_json::Value = serde_json::from_str(&line[5..line.len() - 2]).unwrap();
        assert_eq!(json["max_payload"], 1 << 20);
        assert_eq!(json["headers"], true);
    }

    #[test]
    fn a_header_block_parses_to_what_it_was_written_from() {
        let headers: Headers = vec![
            ("Nats-Msg-Id".into(), "abc".into()),
            ("X".into(), "a: b".into()),
        ];
        let mut block = BytesMut::new();
        put_headers(&mut block, &headers);
        assert_eq!(block.len(), header_block_len(&headers));
        assert_eq!(parse_headers(&block).unwrap(), headers);
        assert_eq!(
            parse_headers(b"NATS/1.0 503\r\n\r\n").unwrap(),
            Headers::new()
        );
    }

    #[test]
    fn tokens_hold_no_separator_or_wildcard() {
        assert!(is_token("0b1c-d_e"));
        for bad in ["", "a.b", "*", ">", "a b"] {
            assert!(!is_token(bad), "{bad:?}");
        }
    }
}
