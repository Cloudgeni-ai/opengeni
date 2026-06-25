//! Typed stream-plane errors.
//!
//! The relay dial, channel registration, and pump loops surface a single
//! [`StreamError`]. Transport-level errors are retryable (the channel
//! auto-reconnects + resumes, dossier §10.6); a protocol or rejected-open error is
//! terminal for that channel.

use thiserror::Error;

use opengeni_agent_platform::PlatformError;

/// An error from the relay stream plane.
#[derive(Debug, Error)]
pub enum StreamError {
    /// The relay could not be dialed or the connection dropped. **Retryable** — the
    /// channel backs off and re-registers (§10.6).
    #[error("relay transport error: {0}")]
    Transport(String),

    /// A malformed relay datagram / unknown message tag / undecodable body.
    #[error("relay protocol error: {0}")]
    Protocol(String),

    /// The relay rejected a [`StreamOpen`](opengeni_agent_proto::v1::StreamOpen)
    /// (bad token, failed epoch fence, unknown channel key).
    #[error("relay rejected channel open: {0}")]
    OpenRejected(String),

    /// A platform op underlying a pump failed (a PTY spawn, a capture/inject).
    #[error(transparent)]
    Platform(#[from] PlatformError),
}

impl StreamError {
    /// Whether the channel should back off and re-register, vs. give up. Transport
    /// drops are retryable (the resume-from-seq path makes recovery invisible); a
    /// protocol/rejected error means the channel is misconfigured and retrying will
    /// not help.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Transport(_))
    }
}

/// A stream-plane result alias.
pub type StreamResult<T> = Result<T, StreamError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_errors_are_retryable_others_are_not() {
        assert!(StreamError::Transport("drop".to_string()).retryable());
        assert!(!StreamError::Protocol("bad tag".to_string()).retryable());
        assert!(!StreamError::OpenRejected("bad token".to_string()).retryable());
    }
}
