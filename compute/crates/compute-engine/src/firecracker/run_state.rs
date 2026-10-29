//! Pausing and resuming a VM's processors through its VMM's API.

use serde_json::{Value, json};

use super::api::{Api, ApiError};
use crate::error::{EngineError, ErrorKind};

/// Pauses or resumes the processors so that a failure always means nothing
/// changed. A request refused or never sent is a transient failure. A
/// request whose answer was lost or late may still have taken effect, so the
/// VMM is asked which state the VM is in. It answers requests one at a time,
/// so once it answers, the earlier request has either taken effect or never
/// will. If it cannot say in time, the VM is beyond control and counts as
/// lost, since its guest may or may not be running.
pub(super) async fn set_run_state(
    api: &Api,
    alive: impl Fn() -> bool,
    operation: &'static str,
    run: RunState,
) -> Result<(), EngineError> {
    let body = json!({ "state": run.request() });
    let error = match api.call("PATCH", "/vm", Some(&body)).await {
        Ok(_) => return Ok(()),
        Err(error @ (ApiError::Connect(_) | ApiError::Status { .. })) if alive() => {
            return Err(EngineError::caused_by(
                ErrorKind::Transient,
                operation,
                error,
            ));
        }
        Err(error) => error,
    };
    let reported = api
        .call("GET", "/", None)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|info| info.get("state")?.as_str().map(str::to_owned));
    match reported.as_deref() {
        Some(state) if state == run.reported() => Ok(()),
        Some(_) if alive() => Err(EngineError::caused_by(
            ErrorKind::Transient,
            operation,
            error,
        )),
        _ if !alive() => Err(EngineError::new(
            ErrorKind::MemoryLost,
            operation,
            "the VMM process has exited",
        )),
        _ => Err(EngineError::caused_by(
            ErrorKind::MemoryLost,
            operation,
            error,
        )),
    }
}

/// The processor state asked of the VMM.
#[derive(Clone, Copy)]
pub(super) enum RunState {
    Paused,
    Running,
}

impl RunState {
    /// The value `PATCH /vm` takes.
    const fn request(self) -> &'static str {
        match self {
            Self::Paused => "Paused",
            Self::Running => "Resumed",
        }
    }

    /// The value `GET /` reports once the change took effect.
    const fn reported(self) -> &'static str {
        match self {
            Self::Paused => "Paused",
            Self::Running => "Running",
        }
    }
}
