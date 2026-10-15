//! Content-addressed checkpoints for sleepable compute disks.
//!
//! The caller must supply an immutable, point-in-time disk view. Dirty tracking
//! is a candidate filter, not a replacement for quiescing or snapshotting a disk.
//! Object publication is separate from advancing the control-plane checkpoint.

pub mod chunk;
pub mod dirty;
#[cfg(target_os = "linux")]
pub mod fiemap;
pub mod lazy;
pub mod manifest;
pub mod store;

/// Fail closed on invalid metadata, unavailable objects and corrupt content.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid storage input: {0}")]
    Invalid(&'static str),
    #[error("chunk integrity check failed")]
    Integrity,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Object(#[from] object_store::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
