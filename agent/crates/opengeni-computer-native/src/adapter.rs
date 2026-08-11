use async_trait::async_trait;
use serde::Serialize;

use crate::{
    NativeActionCommand, NativeCapabilities, NativeCapturedFrame, NativeObservation, NativeTarget,
};

/// Stable native-adapter failure classes mapped by computerd into the public
/// InteractionError contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeAdapterErrorCode {
    /// The target or element no longer exists.
    TargetNotFound,
    /// Target generation changed since observation.
    TargetStale,
    /// Observation-backed semantic reference changed.
    ObservationStale,
    /// Screenshot geometry changed.
    FrameStale,
    /// Locator matched no element.
    LocatorNotFound,
    /// Locator matched more than one element.
    LocatorAmbiguous,
    /// The platform or element cannot perform the requested operation.
    Unsupported,
    /// OS accessibility/screen-control permission is absent.
    PermissionDenied,
    /// A graphical seat or accessibility service is temporarily unavailable.
    Unavailable,
    /// The machine is locked and the requested operation cannot proceed.
    MachineLocked,
    /// The request was invalid before any side effect.
    InvalidAction,
    /// A bounded native operation timed out.
    Timeout,
    /// The native adapter failed before dispatch.
    DriverFailed,
    /// A side effect may have occurred, so callers must not replay blindly.
    OutcomeUnknown,
}

/// Typed native edge failure. `dispatched` distinguishes a definite safe
/// rejection from an ambiguous result after an OS API accepted a mutation.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct NativeAdapterError {
    /// Stable class.
    pub code: NativeAdapterErrorCode,
    /// Bounded non-secret diagnostic.
    pub message: String,
    /// Whether the identical request may be useful after new external state.
    pub retryable: bool,
    /// Whether the native mutation crossed its side-effect boundary.
    pub dispatched: bool,
}

impl NativeAdapterError {
    /// Constructs an unsupported error.
    #[must_use]
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: NativeAdapterErrorCode::Unsupported,
            message: message.into(),
            retryable: false,
            dispatched: false,
        }
    }

    /// Constructs an unavailable error.
    #[must_use]
    pub fn unavailable(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: NativeAdapterErrorCode::Unavailable,
            message: message.into(),
            retryable,
            dispatched: false,
        }
    }

    /// Constructs a safe pre-dispatch rejection.
    #[must_use]
    pub fn definite(
        code: NativeAdapterErrorCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            dispatched: false,
        }
    }

    /// Constructs an ambiguous post-dispatch failure.
    #[must_use]
    pub fn outcome_unknown(message: impl Into<String>) -> Self {
        Self {
            code: NativeAdapterErrorCode::OutcomeUnknown,
            message: message.into(),
            retryable: false,
            dispatched: true,
        }
    }
}

/// Native adapter result.
pub type NativeAdapterResult<T> = Result<T, NativeAdapterError>;

/// One platform/seat adapter. Implementations retain accessibility object maps
/// only for their most recent bounded observations; public authority stays in
/// computerd.
#[async_trait]
pub trait ComputerAdapter: Send + Sync {
    /// Platform capabilities available for this seat now.
    fn capabilities(&self) -> NativeCapabilities;

    /// Enumerates current app/window/screen targets.
    async fn targets(&self) -> NativeAdapterResult<Vec<NativeTarget>>;

    /// Returns a fresh semantic snapshot for one exact target.
    async fn observe(&self, target_id: &str) -> NativeAdapterResult<NativeObservation>;

    /// Captures one exact target and establishes a new pointer frame fence.
    async fn capture(&self, target_id: &str) -> NativeAdapterResult<NativeCapturedFrame>;

    /// Validates all observation/frame fences without performing a mutation.
    async fn validate(&self, command: &NativeActionCommand) -> NativeAdapterResult<()>;

    /// Executes one already-validated command and returns a fresh observation.
    async fn dispatch(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<NativeObservation>;
}
