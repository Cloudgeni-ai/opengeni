//! Content-addressed checkpoints for sleepable compute disks.
//!
//! The caller must supply an immutable, point-in-time disk view. Dirty tracking
//! is a candidate filter, not a replacement for quiescing or snapshotting a disk.
//! Object publication is separate from advancing the control-plane checkpoint.

pub mod chunk;
pub mod dirty;
#[cfg(test)]
mod fake;
#[cfg(target_os = "linux")]
pub mod fiemap;
pub mod fresh;
pub mod lazy;
pub mod manifest;
pub mod store;
pub mod sweep;
mod upload;

/// Fail closed on invalid metadata, unavailable objects and corrupt content.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid storage input: {0}")]
    Invalid(&'static str),
    /// Stored or received bytes do not match their content hash.
    #[error("chunk integrity check failed")]
    Integrity,
    /// A stored object is shorter or longer than its reference says.
    #[error("object has {actual} bytes, expected {expected}")]
    Truncated { expected: u64, actual: u64 },
    /// An upload or download did not complete; trying again may work.
    #[error("transfer failed: {0}")]
    Transfer(String),
    /// An archive ran past the window in which it may publish what it
    /// stored; it starts again.
    #[error("the archive took too long to publish; it starts again")]
    Expired,
    /// This store cannot do what was asked.
    #[error("unsupported by this store: {0}")]
    Unsupported(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Object(#[from] object_store::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Whether the stored data itself is bad or gone, so trying again cannot
    /// help. Transfers, local I/O and other store failures may pass.
    #[must_use]
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::Invalid(_)
            | Self::Integrity
            | Self::Truncated { .. }
            | Self::Json(_)
            | Self::Unsupported(_)
            | Self::Object(object_store::Error::NotFound { .. }) => true,
            Self::Transfer(_) | Self::Expired | Self::Io(_) | Self::Object(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn only_bad_or_missing_data_is_permanent() {
        let missing = object_store::Error::NotFound {
            path: "chunks/x".into(),
            source: "gone".into(),
        };
        let timeout = object_store::Error::Generic {
            store: "test",
            source: "timed out".into(),
        };
        assert!(Error::Integrity.is_permanent());
        assert!(
            Error::Truncated {
                expected: 2,
                actual: 1
            }
            .is_permanent()
        );
        assert!(Error::Object(missing).is_permanent());
        assert!(!Error::Object(timeout).is_permanent());
        assert!(!Error::Transfer("reset".into()).is_permanent());
        let full = std::io::Error::from_raw_os_error(24);
        assert!(!Error::Io(full).is_permanent());
    }
}
