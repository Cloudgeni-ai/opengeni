//! Typed errors for the self-updater.
//!
//! Every fallible step (manifest fetch/parse, verify, download, swap, rollback)
//! returns an [`UpdateError`]. A failure NEVER panics and NEVER leaves the agent
//! on a half-written binary: an atomic same-filesystem rename means the worst case
//! is "old binary still in place" (see [`apply`](crate::apply)).

use thiserror::Error;

/// An error from any stage of the self-update flow.
#[derive(Debug, Error)]
pub enum UpdateError {
    /// The requested update channel is not published by this origin.
    #[error("unsupported update channel: {0}")]
    Channel(String),
    /// The signed channel manifest could not be fetched or parsed.
    #[error("manifest error: {0}")]
    Manifest(String),

    /// No artifact in the manifest matches this agent's target triple.
    #[error("no artifact for target {0} in the manifest")]
    NoArtifactForTarget(String),

    /// A network/IO error downloading the manifest or an artifact.
    #[error("download error for {url}: {source}")]
    Download {
        /// The URL that failed.
        url: String,
        /// The underlying error.
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// A filesystem operation (temp write, rename, backup) failed.
    #[error("io error at {path}: {source}")]
    Io {
        /// The path the failing op touched.
        path: String,
        /// The underlying IO error.
        source: std::io::Error,
    },

    /// The minisign signature did not verify against the pinned public key. A
    /// TAMPERED artifact lands here — it is NEVER installed.
    #[error("signature verification failed: {0}")]
    Signature(String),

    /// The sha256 of the downloaded artifact did not match the (signed) manifest.
    #[error("sha256 mismatch: expected {expected}, got {actual}")]
    Checksum {
        /// The sha256 the signed manifest pins.
        expected: String,
        /// The sha256 actually computed over the downloaded bytes.
        actual: String,
    },

    /// The candidate version is not strictly newer than the running version, or is
    /// below `min_supported` (a downgrade-attack rejection).
    #[error(
        "version gate rejected {candidate} (current {current}, min_supported {min_supported})"
    )]
    VersionGate {
        /// The version the manifest offered.
        candidate: String,
        /// The version currently running.
        current: String,
        /// The minimum version the manifest still permits.
        min_supported: String,
    },

    /// A semantic-version string could not be parsed.
    #[error("invalid semantic version {value}: {source}")]
    SemVer {
        /// The offending version string.
        value: String,
        /// The parse error.
        source: semver::Error,
    },

    /// macOS updates must replace the complete signed app bundle. Mutating only
    /// `.app/Contents/MacOS/opengeni-agent` would invalidate the bundle signature
    /// and its TCC identity, so the running-executable path fails before any write.
    #[error(
        "macOS in-place update is disabled for {path}: no files were changed; reinstall the complete signed OpenGeni Agent.app bundle"
    )]
    BundleReinstallRequired {
        /// The running executable path that was intentionally left untouched.
        path: String,
    },

    /// The post-update health gate failed; the prior binary was rolled back.
    #[error("post-update health check failed: {0}")]
    HealthCheck(String),
}

impl UpdateError {
    /// Helper to wrap an IO error with the path it touched.
    pub(crate) fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// The crate result alias.
pub type UpdateResult<T> = Result<T, UpdateError>;
