//! Typed platform errors and their mapping to the wire [`AgentError`].
//!
//! Every fallible [`Platform`](crate::Platform) method returns a
//! [`PlatformError`]. The error carries enough structure that the agent's RPC
//! dispatch can translate it into a proto [`AgentError`] with a stable
//! [`ErrorCode`] (so the control plane can decide whether to pause-and-retry a
//! reconnect blip versus surface a hard failure). The mapping lives here, beside
//! the error definition, so the two never drift.

use std::collections::BTreeMap;

use opengeni_agent_proto::v1::{AgentError, ErrorCode};
use thiserror::Error;

/// A typed error raised by a [`Platform`](crate::Platform) operation.
///
/// Variants map 1:1 onto the proto [`ErrorCode`] discriminants via
/// [`PlatformError::to_agent_error`]. Free-form OS detail (an errno, a non-zero
/// exit code, a path) rides the `detail` map for logs without bloating the
/// human-facing message.
#[derive(Debug, Error)]
pub enum PlatformError {
    /// The operation is not implemented on this platform (e.g. desktop capture on
    /// a headless host) or is reserved for a later milestone (terminal/desktop
    /// streams are the M8 seam). Maps to [`ErrorCode::Unsupported`].
    #[error("unsupported operation: {0}")]
    Unsupported(String),

    /// The referenced path / ref / target does not exist. Maps to
    /// [`ErrorCode::NotFound`].
    #[error("not found: {0}")]
    NotFound(String),

    /// The operation was rejected because a required consent grant (whole-machine
    /// or screen-control) was not given at enrollment. Maps to
    /// [`ErrorCode::ConsentRequired`].
    #[error("consent required: {0}")]
    ConsentRequired(String),

    /// The operation exceeded its wall-clock budget. Maps to
    /// [`ErrorCode::Timeout`].
    #[error("timed out: {0}")]
    Timeout(String),

    /// An OS-level failure (a syscall, spawning a child, an IO error). Carries an
    /// optional errno-style code in `detail`. Maps to [`ErrorCode::Os`].
    #[error("os error: {message}")]
    Os {
        /// Human-facing summary.
        message: String,
        /// Structured detail (e.g. `errno`, `path`) surfaced in logs only.
        detail: BTreeMap<String, String>,
    },
}

impl PlatformError {
    /// Constructs an [`PlatformError::Os`] from a message with no extra detail.
    #[must_use]
    pub fn os(message: impl Into<String>) -> Self {
        Self::Os {
            message: message.into(),
            detail: BTreeMap::new(),
        }
    }

    /// Constructs an [`PlatformError::Os`] from an [`std::io::Error`], folding the
    /// raw OS error code (errno) and a contextual label into `detail`. A
    /// not-found IO error is promoted to [`PlatformError::NotFound`] so the
    /// control plane sees the precise [`ErrorCode::NotFound`].
    #[must_use]
    pub fn from_io(context: &str, err: &std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            return Self::NotFound(format!("{context}: {err}"));
        }
        let mut detail = BTreeMap::new();
        detail.insert("context".to_string(), context.to_string());
        if let Some(code) = err.raw_os_error() {
            detail.insert("errno".to_string(), code.to_string());
        }
        Self::Os {
            message: format!("{context}: {err}"),
            detail,
        }
    }

    /// The stable [`ErrorCode`] this error maps to on the wire.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Unsupported(_) => ErrorCode::Unsupported,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::ConsentRequired(_) => ErrorCode::ConsentRequired,
            Self::Timeout(_) => ErrorCode::Timeout,
            Self::Os { .. } => ErrorCode::Os,
        }
    }

    /// Whether the control plane should treat this as retryable. Platform errors
    /// are deterministic OS-level failures (a missing path, a non-zero exit, a
    /// consent gap) — retrying does not help, so they are not retryable. Transient
    /// retryable conditions (a reconnect blip, an offline agent) are synthesized
    /// by the transport layer, not here.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Timeout(_))
    }

    /// Renders this error into the proto [`AgentError`] carried on a
    /// [`ControlResponse`](opengeni_agent_proto::v1::ControlResponse).
    #[must_use]
    pub fn to_agent_error(&self) -> AgentError {
        let detail = match self {
            Self::Os { detail, .. } => detail.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            _ => std::collections::HashMap::new(),
        };
        AgentError {
            code: self.code() as i32,
            message: self.to_string(),
            retryable: self.retryable(),
            detail,
        }
    }
}

/// A convenience result alias for [`Platform`](crate::Platform) operations.
pub type PlatformResult<T> = Result<T, PlatformError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_not_found_promotes_to_not_found() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let err = PlatformError::from_io("stat /missing", &io);
        assert!(matches!(err, PlatformError::NotFound(_)));
        assert_eq!(err.code(), ErrorCode::NotFound);
    }

    #[test]
    fn io_other_carries_errno_detail() {
        let io = std::io::Error::from_raw_os_error(13); // EACCES
        let err = PlatformError::from_io("open /root/secret", &io);
        let proto = err.to_agent_error();
        assert_eq!(proto.code, ErrorCode::Os as i32);
        assert_eq!(proto.detail.get("errno"), Some(&"13".to_string()));
        assert!(!proto.retryable);
    }

    #[test]
    fn timeout_is_retryable() {
        let err = PlatformError::Timeout("exec exceeded 5000ms".to_string());
        assert!(err.retryable());
        assert_eq!(err.code(), ErrorCode::Timeout);
        assert!(err.to_agent_error().retryable);
    }

    #[test]
    fn consent_maps_to_consent_required() {
        let err = PlatformError::ConsentRequired("screen-control".to_string());
        assert_eq!(err.to_agent_error().code, ErrorCode::ConsentRequired as i32);
    }
}
