//! The bytes of a resumable stream: the guest's hello line, the host's
//! answer line and the binary frames both sides send after them.
//!
//! ```text
//! guest: resume <id: 32 hex digits> <received> <sent>\n
//! host:  ok <received>\n    or    gone\n
//! frame: 'D' offset:u64 length:u32 bytes    data at offset
//!        'A' count:u64                      handed on up to count
//!        'E' offset:u64                     this direction ends at offset
//!        'X'                                the stream is abandoned
//! ```
//!
//! Integers are big-endian. Counts and offsets are positions in one
//! direction of the stream: its bytes, and then one more for its end, as
//! TCP counts a FIN.

use std::fmt;
use std::str::FromStr;

/// The longest hello or answer line, its newline included.
pub const LINE_MAX: usize = 128;

/// The most bytes one data frame carries.
pub const CHUNK: usize = 64 << 10;

const DATA: u8 = b'D';
const ACK: u8 = b'A';
const END: u8 = b'E';
const ABANDON: u8 = b'X';

/// A stream's name: random, chosen by the guest when the agent connects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StreamId(pub u128);

impl StreamId {
    /// The id made of `bytes`, which should be random.
    #[must_use]
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(u128::from_be_bytes(bytes))
    }
}

impl fmt::Display for StreamId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:032x}", self.0)
    }
}

impl FromStr for StreamId {
    type Err = ();

    fn from_str(text: &str) -> Result<Self, ()> {
        if text.len() != 32 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(());
        }
        u128::from_str_radix(text, 16).map(Self).map_err(drop)
    }
}

/// What the guest sends first on each vsock connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hello {
    pub id: StreamId,
    /// What the guest received of the host's direction.
    pub received: u64,
    /// What the guest sent of its own direction, acknowledged or not.
    pub sent: u64,
}

impl Hello {
    #[must_use]
    pub fn line(&self) -> String {
        format!("resume {} {} {}\n", self.id, self.received, self.sent)
    }

    /// The hello `line` holds, its newline included.
    #[must_use]
    pub fn parse(line: &str) -> Option<Self> {
        let rest = line.strip_suffix('\n')?.strip_prefix("resume ")?;
        let mut parts = rest.split(' ');
        let hello = Self {
            id: parts.next()?.parse().ok()?,
            received: count(parts.next()?)?,
            sent: count(parts.next()?)?,
        };
        parts.next().is_none().then_some(hello)
    }
}

/// What the host answers a hello with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The stream goes on; the host received this much of the guest's
    /// direction.
    Resumed { received: u64 },
    /// The host has no such stream to go on with.
    Gone,
}

impl Answer {
    #[must_use]
    pub fn line(&self) -> String {
        match self {
            Self::Resumed { received } => format!("ok {received}\n"),
            Self::Gone => "gone\n".to_owned(),
        }
    }

    /// The answer `line` holds, its newline included.
    #[must_use]
    pub fn parse(line: &str) -> Option<Self> {
        let line = line.strip_suffix('\n')?;
        if line == "gone" {
            return Some(Self::Gone);
        }
        Some(Self::Resumed {
            received: count(line.strip_prefix("ok ")?)?,
        })
    }
}

/// A decimal count, digits only.
fn count(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// One frame after the hello and its answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    /// `bytes`, which start at `offset` in the sender's direction.
    Data { offset: u64, bytes: &'a [u8] },
    /// The receiver handed on everything before this position.
    Ack(u64),
    /// The sender's direction ends at this position.
    End(u64),
    /// The sender gives the stream up: the receiver ends it at once.
    Abandon,
}

/// Bytes that are not a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// A frame of a kind this side does not know.
    Unknown(u8),
    /// A data frame that carries no bytes, or more than [`CHUNK`].
    Length(u32),
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown(kind) => write!(f, "unknown frame kind {kind:#04x}"),
            Self::Length(length) => write!(f, "data frame of {length} bytes"),
        }
    }
}

impl std::error::Error for WireError {}

impl Frame<'_> {
    /// Appends the frame to `out`.
    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Self::Data { offset, bytes } => {
                debug_assert!(!bytes.is_empty() && bytes.len() <= CHUNK);
                out.push(DATA);
                out.extend_from_slice(&offset.to_be_bytes());
                let length = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
                out.extend_from_slice(&length.to_be_bytes());
                out.extend_from_slice(bytes);
            }
            Self::Ack(count) => {
                out.push(ACK);
                out.extend_from_slice(&count.to_be_bytes());
            }
            Self::End(offset) => {
                out.push(END);
                out.extend_from_slice(&offset.to_be_bytes());
            }
            Self::Abandon => out.push(ABANDON),
        }
    }

    /// The frame at the start of `bytes` and how many bytes it takes;
    /// `None` while `bytes` holds only part of it.
    pub fn decode(bytes: &[u8]) -> Result<Option<(Frame<'_>, usize)>, WireError> {
        let Some((&kind, rest)) = bytes.split_first() else {
            return Ok(None);
        };
        let frame = match kind {
            DATA => {
                let (Some(offset), Some(length)) = (u64_at(rest, 0), u32_at(rest, 8)) else {
                    return Ok(None);
                };
                let size = usize::try_from(length).unwrap_or(usize::MAX);
                if size == 0 || size > CHUNK {
                    return Err(WireError::Length(length));
                }
                let Some(data) = rest.get(12..12 + size) else {
                    return Ok(None);
                };
                (
                    Frame::Data {
                        offset,
                        bytes: data,
                    },
                    13 + size,
                )
            }
            ACK => match u64_at(rest, 0) {
                Some(count) => (Frame::Ack(count), 9),
                None => return Ok(None),
            },
            END => match u64_at(rest, 0) {
                Some(offset) => (Frame::End(offset), 9),
                None => return Ok(None),
            },
            ABANDON => (Frame::Abandon, 1),
            other => return Err(WireError::Unknown(other)),
        };
        Ok(Some(frame))
    }
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hello_and_its_answers_read_back() {
        let hello = Hello {
            id: StreamId(0x0123_4567_89ab_cdef_0011_2233_4455_6677),
            received: 12,
            sent: 0,
        };
        let line = hello.line();
        assert_eq!(
            line, "resume 0123456789abcdef0011223344556677 12 0\n",
            "fixed width, so ids sort as they print"
        );
        assert_eq!(Hello::parse(&line), Some(hello));
        for answer in [Answer::Resumed { received: 7 }, Answer::Gone] {
            assert_eq!(Answer::parse(&answer.line()), Some(answer));
        }
    }

    #[test]
    fn malformed_lines_are_refused() {
        for line in [
            "resume 0123456789abcdef0011223344556677 1 2",
            "resume 0123456789abcdef0011223344556677 1 2 3\n",
            "resume 0123456789abcdef001122334455667 1 2\n",
            "resume 0123456789abcdef001122334455667g 1 2\n",
            "resume 0123456789abcdef0011223344556677 +1 2\n",
            "resume 0123456789abcdef0011223344556677 1 18446744073709551616\n",
            "hello 0123456789abcdef0011223344556677 1 2\n",
        ] {
            assert_eq!(Hello::parse(line), None, "{line:?}");
        }
        for line in ["ok\n", "ok -1\n", "ok 1", "gone \n", "ok 1 2\n"] {
            assert_eq!(Answer::parse(line), None, "{line:?}");
        }
    }

    #[test]
    fn frames_read_back_whole_and_wait_for_their_rest() {
        let frames = [
            Frame::Data {
                offset: 1 << 40,
                bytes: b"hello",
            },
            Frame::Ack(9),
            Frame::End(u64::MAX),
            Frame::Abandon,
        ];
        let mut bytes = Vec::new();
        for frame in &frames {
            frame.encode(&mut bytes);
        }
        let mut at = 0;
        for frame in &frames {
            let (got, length) = Frame::decode(&bytes[at..]).unwrap().unwrap();
            assert_eq!(&got, frame);
            for short in 0..length {
                assert_eq!(Frame::decode(&bytes[at..at + short]), Ok(None));
            }
            at += length;
        }
        assert_eq!(at, bytes.len());
    }

    #[test]
    fn unknown_kinds_and_bad_lengths_are_errors() {
        assert_eq!(Frame::decode(b"Z"), Err(WireError::Unknown(b'Z')));
        let mut empty = vec![DATA];
        empty.extend_from_slice(&0_u64.to_be_bytes());
        empty.extend_from_slice(&0_u32.to_be_bytes());
        assert_eq!(Frame::decode(&empty), Err(WireError::Length(0)));
        let mut long = vec![DATA];
        long.extend_from_slice(&0_u64.to_be_bytes());
        let over = u32::try_from(CHUNK + 1).unwrap();
        long.extend_from_slice(&over.to_be_bytes());
        assert_eq!(
            Frame::decode(&long),
            Err(WireError::Length(over)),
            "refused before its bytes arrive"
        );
    }
}
