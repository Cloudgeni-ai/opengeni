//! A VM's balloon: how much of its memory its guest is asked to give back
//! to the host. Set only while the VM runs, and let go before every pause,
//! so neither a paused VM nor a saved copy carries a squeezed guest.
//!
//! The device is configured at boot with `deflate_on_oom`, so a guest that
//! needs the memory takes pages back from the balloon rather than run out.
//!
//! A request outlives nothing: once its VM is stopped or dropped, a
//! request still on its way does nothing, so it never reaches a later VM
//! behind the same API socket.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// Set once its VM is stopped or dropped; read under `state`.
    ended: AtomicBool,
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
    /// The balloon of a VM with `device`, set to what is not known: a VM
    /// restored from an image whose balloon could not be let go before
    /// its pause, or one an earlier agent ran, keeps that balloon. The
    /// first request sets it either way.
    pub(super) fn unknown(api: &Api, device: bool) -> Self {
        Self {
            inner: device.then(|| {
                Arc::new(Inner {
                    api: api.clone(),
                    state: Mutex::new(State {
                        mib: None,
                        paused: false,
                    }),
                    ended: AtomicBool::new(false),
                })
            }),
        }
    }

    /// Sets it to take `bytes`, rounded down to MiB, unless the VM is
    /// paused or has ended. Does not borrow the VM.
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
            if inner.ended.load(Ordering::Acquire) || state.paused || state.mib == Some(mib) {
                return Ok(());
            }
            patch(&inner.api, mib).await?;
            state.mib = Some(mib);
            Ok(())
        }
    }

    /// Ends it before its VM is stopped: waits for a request on its way,
    /// and no later one reaches the API socket.
    pub(super) async fn end(&self) {
        if let Some(inner) = &self.inner {
            let _state = inner.state.lock().await;
            inner.ended.store(true, Ordering::Release);
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

impl Drop for Balloon {
    /// A request not yet on its way does nothing once its VM is gone.
    fn drop(&mut self) {
        if let Some(inner) = &self.inner {
            inner.ended.store(true, Ordering::Release);
        }
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex as Shared;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    use super::*;

    /// A VMM's API that answers every request and keeps their bodies.
    fn api() -> (tempfile::TempDir, Api, Arc<Shared<Vec<String>>>) {
        let dir = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
        let socket = dir.path().join("api.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let seen = Arc::new(Shared::new(Vec::new()));
        let kept = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0_u8; 4096];
                let read = stream.read(&mut request).await.unwrap();
                if read == 0 {
                    // A client that sent nothing.
                    continue;
                }
                let request = String::from_utf8_lossy(&request[..read]).into_owned();
                kept.lock().unwrap().push(request);
                stream.write_all(b"HTTP/1.1 204 \r\n\r\n").await.unwrap();
            }
        });
        (dir, Api::new(socket), seen)
    }

    #[tokio::test]
    async fn a_new_vm_s_balloon_is_let_go_even_if_asked_for_nothing() {
        // A restored image may carry a balloon its pause could not let go.
        let (_dir, api, seen) = api();
        let balloon = Balloon::unknown(&api, true);
        balloon.set(0).await.unwrap();
        balloon.set(0).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].contains("\"amount_mib\":0"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_request_on_its_way_never_reaches_a_later_vm() {
        let (_dir, api, seen) = api();
        let balloon = Balloon::unknown(&api, true);
        // Asked, then the VM is stopped before the request runs.
        let late = balloon.set(1 << 30);
        balloon.end().await;
        late.await.unwrap();
        balloon.set(1 << 30).await.unwrap();
        // Asked, then the VM is dropped.
        let other = Balloon::unknown(&api, true);
        let late = other.set(1 << 30);
        drop(other);
        late.await.unwrap();
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_request_reaches_only_the_vmm_it_was_made_for() {
        let (_dir, api, seen) = api();
        let me = i32::try_from(std::process::id()).unwrap();
        // Another process now serves the socket path of an ended VMM.
        let old = Balloon::unknown(&api.clone().served_by(me + 1), true);
        assert!(old.set(1 << 30).await.is_err());
        let new = Balloon::unknown(&api.served_by(me), true);
        new.set(0).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].contains("\"amount_mib\":0"), "{seen:?}");
    }
}
