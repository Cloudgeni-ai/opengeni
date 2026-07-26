//! Typed relay errors.

use thiserror::Error;

use crate::token::TokenError;

/// An error in the relay edge.
#[derive(Debug, Error)]
pub enum RelayError {
    /// The dial query was missing or malformed (`ws`/`agent`/`port`).
    #[error("bad channel-key query: {0}")]
    BadQuery(String),

    /// The in-band `StreamOpen` did not arrive first, was malformed, or its key did
    /// not match the dial query.
    #[error("bad handshake: {0}")]
    BadHandshake(String),

    /// The presented token failed verification.
    #[error("token rejected: {0}")]
    Token(#[from] TokenError),

    /// The token authenticated but its claims did not match the channel key
    /// (cross-workspace / cross-agent / wrong port / stale epoch).
    #[error("token scope mismatch: {0}")]
    Scope(String),

    /// A transport-level error on a relay socket.
    #[error("transport: {0}")]
    Transport(String),

    /// The listener could not bind / serve.
    #[error("server: {0}")]
    Server(String),
}

/// A relay result alias.
pub type RelayResult<T> = Result<T, RelayError>;
