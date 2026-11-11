//! The caller's W3C trace context, carried on requests as `traceparent`.

use std::fmt;
use std::str::FromStr;

/// A caller's trace context: which trace and span a request belongs to.
/// Events about the request, and steps it started, carry it, so a log
/// store can join them with the caller's own spans. No spans are made here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TraceContext {
    /// The trace, never all zeros.
    pub trace_id: [u8; 16],
    /// The caller's span, never all zeros.
    pub span_id: [u8; 8],
    /// The trace flags; bit 0 is "sampled".
    pub flags: u8,
}

impl TraceContext {
    /// The trace id as 32 lowercase hex digits.
    #[must_use]
    pub fn trace_hex(&self) -> String {
        hex(&self.trace_id)
    }

    /// The span id as 16 lowercase hex digits.
    #[must_use]
    pub fn span_hex(&self) -> String {
        hex(&self.span_id)
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// Parses `N` bytes of lowercase hex from `text`, which must be exactly
/// that long.
fn parse_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != 2 * N {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut bytes = [0; N];
    let (pairs, _) = text.as_bytes().as_chunks::<2>();
    for (byte, pair) in bytes.iter_mut().zip(pairs) {
        *byte = digit(pair[0])? << 4 | digit(pair[1])?;
    }
    Some(bytes)
}

impl FromStr for TraceContext {
    type Err = String;

    /// Reads a `traceparent` value: `version-traceid-spanid-flags` in
    /// lowercase hex. Version `ff` and all-zero ids are invalid; a later
    /// version may append fields after a dash, which are ignored, as the
    /// W3C recommendation says.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let invalid = || format!("invalid traceparent {text:?}");
        let mut fields = text.splitn(5, '-');
        let version = fields.next().and_then(parse_hex::<1>).ok_or_else(invalid)?;
        let trace_id = fields
            .next()
            .and_then(parse_hex::<16>)
            .ok_or_else(invalid)?;
        let span_id = fields.next().and_then(parse_hex::<8>).ok_or_else(invalid)?;
        let flags = fields.next().and_then(parse_hex::<1>).ok_or_else(invalid)?;
        let rest = fields.next();
        if version[0] == 0xff
            || (version[0] == 0 && rest.is_some())
            || trace_id == [0; 16]
            || span_id == [0; 8]
        {
            return Err(invalid());
        }
        Ok(Self {
            trace_id,
            span_id,
            flags: flags[0],
        })
    }
}

impl fmt::Display for TraceContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "00-{}-{}-{:02x}",
            self.trace_hex(),
            self.span_hex(),
            self.flags
        )
    }
}

#[cfg(test)]
mod tests {
    use super::TraceContext;

    const VALID: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    #[test]
    fn a_valid_traceparent_round_trips() {
        let trace: TraceContext = VALID.parse().unwrap();
        assert_eq!(trace.trace_hex(), "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(trace.span_hex(), "00f067aa0ba902b7");
        assert_eq!(trace.flags, 1);
        assert_eq!(trace.to_string(), VALID);
    }

    #[test]
    fn invalid_traceparents_are_refused() {
        for bad in [
            "",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
            "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-701",
        ] {
            assert!(bad.parse::<TraceContext>().is_err(), "{bad:?} parsed");
        }
    }

    #[test]
    fn a_later_version_may_carry_more_fields() {
        let trace: TraceContext = "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00-what"
            .parse()
            .unwrap();
        assert_eq!(trace.flags, 0);
    }
}
