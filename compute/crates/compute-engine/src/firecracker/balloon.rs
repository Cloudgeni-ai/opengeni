//! A VM's balloon: how much of its memory its guest is asked to give back
//! to the host. Set only while the VM runs, and let go before every pause,
//! so neither a paused VM nor a saved copy carries a squeezed guest.
//!
//! The device is configured at boot with `deflate_on_oom`, so a guest that
//! needs the memory takes pages back from the balloon rather than run out.

use std::future::Future;
use std::sync::Arc;

use serde_json::json;
use tokio::sync::Mutex;

use super::api::Api;
use crate::error::{EngineError, ErrorKind};

/// One VM's balloon.
#[derive(Debug)]
pub(super) struct Balloon {
    /// `None` for a VM without a balloon device.
    inner: Option<Arc<Inner>>,
}

#[derive(Debug)]
struct Inner {
    api: Api,
    /// Held while the balloon or the run state changes, so a request to
    /// set it never lands between letting it go and pausing.
    state: Mutex<State>,
}

#[derive(Debug)]
struct State {
    /// MiB it was last set to take; `None` when unknown, as for a VM an
    /// earlier agent ran.
    mib: Option<u32>,
    /// Whether the VM is paused, so setting it waits for the next run.
    paused: bool,
}

impl Balloon {
    /// The balloon of a VM booted or restored with `device`: set to
    /// nothing, since no VM pauses with it set.
    pub(super) fn new(api: &Api, device: bool) -> Self {
        Self::with(api, device, Some(0))
    }

    /// The balloon of a VM an earlier agent ran, set to who knows what.
    pub(super) fn unknown(api: &Api, device: bool) -> Self {
        Self::with(api, device, None)
    }

    fn with(api: &Api, device: bool, mib: Option<u32>) -> Self {
        Self {
            inner: device.then(|| {
                Arc::new(Inner {
                    api: api.clone(),
                    state: Mutex::new(State { mib, paused: false }),
                })
            }),
        }
    }

    /// Sets it to take `bytes`, rounded down to MiB, unless the VM is
    /// paused. Does not borrow the VM.
    pub(super) fn set(
        &self,
        bytes: u64,
    ) -> impl Future<Output = Result<(), EngineError>> + Send + 'static {
        let inner = self.inner.clone();
        async move {
            let Some(inner) = inner else {
                return Ok(());
            };
            let mib = u32::try_from(bytes >> 20).unwrap_or(u32::MAX);
            let mut state = inner.state.lock().await;
            if state.paused || state.mib == Some(mib) {
                return Ok(());
            }
            patch(&inner.api, mib).await?;
            state.mib = Some(mib);
            Ok(())
        }
    }

    /// Lets it go, then runs `pause`, with no request to set it in
    /// between. Pauses even if it cannot be let go, which then happens
    /// once the VM runs again: a sleeping guest keeps a set balloon, but a
    /// pause never fails for it.
    pub(super) async fn pausing(
        &self,
        pause: impl Future<Output = Result<(), EngineError>>,
    ) -> Result<(), EngineError> {
        let Some(inner) = &self.inner else {
            return pause.await;
        };
        let mut state = inner.state.lock().await;
        let_go(&inner.api, &mut state).await;
        pause.await?;
        state.paused = true;
        Ok(())
    }

    /// Runs `resume`, after which it may be set again, and lets go a
    /// balloon an earlier pause or agent may have left set.
    pub(super) async fn resuming(
        &self,
        resume: impl Future<Output = Result<(), EngineError>>,
    ) -> Result<(), EngineError> {
        let Some(inner) = &self.inner else {
            return resume.await;
        };
        let mut state = inner.state.lock().await;
        resume.await?;
        state.paused = false;
        let_go(&inner.api, &mut state).await;
        Ok(())
    }
}

/// Sets the balloon to take nothing unless it is known to, or forgets what
/// it takes if that fails.
async fn let_go(api: &Api, state: &mut State) {
    if state.mib != Some(0) {
        state.mib = patch(api, 0).await.ok().map(|()| 0);
    }
}

async fn patch(api: &Api, mib: u32) -> Result<(), EngineError> {
    api.call("PATCH", "/balloon", Some(&json!({ "amount_mib": mib })))
        .await
        .map(drop)
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, "balloon", error))
}
