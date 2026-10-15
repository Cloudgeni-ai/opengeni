//! Engine errors, classified by what the host should do next.

use std::error::Error as StdError;
use std::io;

/// What a failure means for the sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// Nothing changed; retrying later may succeed.
    Transient,
    /// The VM's memory is gone or unusable; its disk is intact.
    MemoryLost,
    /// The sandbox cannot be recovered on this host.
    Fatal,
}

/// A failed engine operation.
#[derive(Debug, thiserror::Error)]
#[error("{operation} failed: {message}")]
pub struct EngineError {
    /// What the failure means for the sandbox.
    pub kind: ErrorKind,
    /// The operation that failed, such as `restore`.
    pub operation: &'static str,
    /// What went wrong, for logs.
    pub message: String,
    #[source]
    source: Option<Box<dyn StdError + Send + Sync>>,
}

impl EngineError {
    /// A failure without an underlying error.
    #[must_use]
    pub fn new(kind: ErrorKind, operation: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            operation,
            message: message.into(),
            source: None,
        }
    }

    /// A failure caused by `source`.
    #[must_use]
    pub fn caused_by(
        kind: ErrorKind,
        operation: &'static str,
        source: impl StdError + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            operation,
            message: source.to_string(),
            source: Some(Box::new(source)),
        }
    }

    /// A transient I/O failure.
    #[must_use]
    pub fn io(operation: &'static str, source: io::Error) -> Self {
        Self::caused_by(ErrorKind::Transient, operation, source)
    }
}
