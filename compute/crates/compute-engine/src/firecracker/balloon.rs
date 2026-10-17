//! A VM's balloon: how much of its memory its guest is asked to give back
//! to the host. Set only while the VM runs, and let go before every pause,
//! so neither a paused VM nor a saved copy carries a squeezed guest.
//!
//! The device is configured at boot with `deflate_on_oom`, so a guest that
//! needs the memory takes pages back from the balloon rather than run out.
//! It also has statistics, the only way its API tells how many pages the
//! guest actually holds in it: a request to let it go resolves once that
//! is none, not when the target is set. A VM restored from an image booted
//! without statistics cannot tell, and they cannot be turned on after
//! boot: its let-go resolves once it has run for as long as one with
//! statistics may take to report empty ([`EMPTYING_LIMIT`]). A guest's
//! driver gives pages back as soon as it sees the new target, in batches
//! of a megabyte, far faster than that.
//!
//! A request outlives nothing: once its VM is stopped or dropped, a
//! request still on its way does nothing and fails, so it never reaches a
//! later VM behind the same API socket, and is never taken for done.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep, sleep_until};

use super::api::Api;
use crate::error::{EngineError, ErrorKind};

/// How often a balloon let go is looked at until its guest holds nothing
/// in it.
const EMPTYING_POLL: Duration = Duration::from_millis(50);

/// How long a guest may take to take back every page of a balloon let go
/// before the request fails, to be asked again later; and how long one
/// that cannot report it is given before it counts as done.
const EMPTYING_LIMIT: Duration = Duration::from_secs(10);

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
    /// [`EMPTYING_LIMIT`], shorter in tests.
    limit: Duration,
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
        Self::with_limit(api, device, EMPTYING_LIMIT)
    }

    fn with_limit(api: &Api, device: bool, limit: Duration) -> Self {
        Self {
            inner: device.then(|| {
                Arc::new(Inner {
                    api: api.clone(),
                    state: Mutex::new(State {
                        mib: None,
                        paused: false,
                    }),
                    ended: AtomicBool::new(false),
                    limit,
                })
            }),
        }
    }

    /// Sets it to take `bytes`, rounded down to MiB. For 0, resolves only
    /// once the guest has taken back every page it gave. Fails if the VM
    /// is paused or has ended, so nothing was asked. Does not borrow the
    /// VM.
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
            {
                let mut state = inner.state.lock().await;
                inner.running(&state)?;
                if state.mib != Some(mib) {
                    patch(&inner.api, mib).await?;
                    state.mib = Some(mib);
                }
            }
            if mib == 0 {
                inner.emptied().await
            } else {
                Ok(())
            }
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

impl Inner {
    /// Fails unless its VM runs, read under `state`.
    fn running(&self, state: &State) -> Result<(), EngineError> {
        if self.ended.load(Ordering::Acquire) {
            Err(EngineError::new(
                ErrorKind::Transient,
                "balloon",
                "the VM has ended",
            ))
        } else if state.paused {
            Err(EngineError::new(
                ErrorKind::Transient,
                "balloon",
                "the VM is paused",
            ))
        } else {
            Ok(())
        }
    }

    /// Waits, within [`EMPTYING_LIMIT`], until the guest holds no page in
    /// the balloon, as the device reports. One without statistics counts
    /// as emptied once that limit has passed with the VM running and the
    /// balloon still let go. Each look is made under `state`, so none
    /// reaches a later VM, and fails once the VM no longer runs or its
    /// balloon was set again.
    async fn emptied(&self) -> Result<(), EngineError> {
        let deadline = Instant::now() + self.limit;
        loop {
            let held = {
                let state = self.state.lock().await;
                self.running(&state)?;
                if state.mib != Some(0) {
                    return Err(EngineError::new(
                        ErrorKind::Transient,
                        "balloon",
                        "the balloon was set again before it emptied",
                    ));
                }
                held_pages(&self.api).await?
            };
            match (held, Instant::now() >= deadline) {
                (Some(0), _) | (None, true) => return Ok(()),
                // Nothing to look at until the limit has passed.
                (None, false) => sleep_until(deadline).await,
                (Some(held), true) => {
                    return Err(EngineError::new(
                        ErrorKind::Transient,
                        "balloon",
                        format!(
                            "the guest still holds {held} pages in its balloon after {}s",
                            self.limit.as_secs()
                        ),
                    ));
                }
                (Some(_), false) => sleep(EMPTYING_POLL).await,
            }
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

/// Pages the guest holds in the balloon now, from the device's statistics;
/// `None` for a VM booted without them, whose device reports a polling
/// interval of 0.
async fn held_pages(api: &Api) -> Result<Option<u64>, EngineError> {
    let body = match api.call("GET", "/balloon/statistics", None).await {
        Ok(body) => body,
        Err(error) => {
            let config = api.call("GET", "/balloon", None).await.ok();
            let polling = config
                .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
                .and_then(|config| config.get("stats_polling_interval_s")?.as_u64());
            if polling == Some(0) {
                return Ok(None);
            }
            return Err(EngineError::caused_by(
                ErrorKind::Transient,
                "balloon",
                error,
            ));
        }
    };
    serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|stats| stats.get("actual_pages")?.as_u64())
        .map(Some)
        .ok_or_else(|| {
            EngineError::new(
                ErrorKind::Transient,
                "balloon",
                format!(
                    "balloon statistics without actual_pages: {}",
                    String::from_utf8_lossy(&body)
                ),
            )
        })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex as Shared;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    use super::*;

    /// A VMM's API that keeps every request but reads and answers them
    /// all. Statistics report the pages in `held`, one reading each, the
    /// last for good; none at all as when disabled, when the device's
    /// configuration reports a polling interval of 0.
    fn device(held: &[u64]) -> (tempfile::TempDir, Api, Arc<Shared<Vec<String>>>) {
        device_polling(held, u64::from(!held.is_empty()))
    }

    /// [`device`], its configuration reporting `polling` whatever its
    /// statistics answer.
    fn device_polling(
        held: &[u64],
        polling: u64,
    ) -> (tempfile::TempDir, Api, Arc<Shared<Vec<String>>>) {
        let dir = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
        let socket = dir.path().join("api.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let seen = Arc::new(Shared::new(Vec::new()));
        let kept = Arc::clone(&seen);
        let mut held: VecDeque<u64> = held.iter().copied().collect();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0_u8; 4096];
                let read = stream.read(&mut request).await.unwrap();
                if read == 0 {
                    // A client that sent nothing.
                    continue;
                }
                let request = String::from_utf8_lossy(&request[..read]).into_owned();
                if request.starts_with("GET /balloon ") {
                    let body = format!(
                        "{{\"amount_mib\":0,\"deflate_on_oom\":true,\"stats_polling_interval_s\":{polling}}}"
                    );
                    let answer = format!(
                        "HTTP/1.1 200 \r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(answer.as_bytes()).await.unwrap();
                    continue;
                }
                if !request.starts_with("GET /balloon/statistics ") {
                    kept.lock().unwrap().push(request);
                    stream.write_all(b"HTTP/1.1 204 \r\n\r\n").await.unwrap();
                    continue;
                }
                let pages = if held.len() > 1 {
                    held.pop_front()
                } else {
                    held.front().copied()
                };
                let answer = pages.map_or_else(
                    || "HTTP/1.1 400 \r\nContent-Length: 0\r\n\r\n".to_owned(),
                    |pages| {
                        let body = format!("{{\"target_pages\":0,\"actual_pages\":{pages}}}");
                        format!(
                            "HTTP/1.1 200 \r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                    },
                );
                stream.write_all(answer.as_bytes()).await.unwrap();
            }
        });
        (dir, Api::new(socket), seen)
    }

    /// A device whose guest holds nothing in its balloon.
    fn api() -> (tempfile::TempDir, Api, Arc<Shared<Vec<String>>>) {
        device(&[0])
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
        // Asked, then the VM is stopped before the request runs: it fails,
        // as nothing was asked.
        let late = balloon.set(1 << 30);
        balloon.end().await;
        late.await.unwrap_err();
        balloon.set(1 << 30).await.unwrap_err();
        // Asked, then the VM is dropped.
        let other = Balloon::unknown(&api, true);
        let late = other.set(1 << 30);
        drop(other);
        late.await.unwrap_err();
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_paused_vm_s_balloon_is_not_asked_and_says_so() {
        let (_dir, api, seen) = api();
        let balloon = Balloon::unknown(&api, true);
        balloon.pausing(async { Ok(()) }).await.unwrap();
        let asked = seen.lock().unwrap().len();
        balloon.set(0).await.unwrap_err();
        balloon.set(1 << 30).await.unwrap_err();
        assert_eq!(seen.lock().unwrap().len(), asked);
    }

    #[tokio::test]
    async fn a_balloon_let_go_is_done_only_once_its_guest_holds_nothing_in_it() {
        // The guest takes its pages back over three readings.
        let (_dir, api, _seen) = device(&[512, 256, 0]);
        let balloon = Balloon::unknown(&api, true);
        let started = Instant::now();
        balloon.set(0).await.unwrap();
        assert!(
            started.elapsed() >= 2 * EMPTYING_POLL,
            "{:?}",
            started.elapsed()
        );
        // Known let go: it is not set again, but still looked at.
        balloon.set(0).await.unwrap();
    }

    /// A VM booted without statistics cannot tell how much it holds: its
    /// let-go is done once it has run, let go, for as long as one with
    /// statistics may take to report empty, and not before.
    #[tokio::test]
    async fn a_balloon_let_go_without_statistics_is_done_after_the_limit() {
        let limit = Duration::from_millis(300);
        let (_dir, api, seen) = device(&[]);
        let balloon = Balloon::with_limit(&api, true, limit);
        let started = Instant::now();
        balloon.set(0).await.unwrap();
        assert!(started.elapsed() >= limit, "{:?}", started.elapsed());
        assert_eq!(seen.lock().unwrap().len(), 1, "set once");
        // Setting it to take memory needs no statistics.
        balloon.set(1 << 30).await.unwrap();

        // Paused meanwhile, it is not done.
        let balloon = Balloon::with_limit(&api, true, limit);
        let waiting = balloon.set(0);
        let pausing = async {
            sleep(limit / 3).await;
            balloon.pausing(async { Ok(()) }).await
        };
        let (waited, paused) = tokio::join!(waiting, pausing);
        paused.unwrap();
        waited.unwrap_err();
    }

    /// Statistics that fail to answer on a VM that has them are no reason
    /// to take a let-go for done.
    #[tokio::test]
    async fn statistics_that_fail_on_a_vm_with_them_do_not_confirm_a_let_go() {
        let (_dir, api, _seen) = device_polling(&[], 1);
        let balloon = Balloon::with_limit(&api, true, Duration::from_millis(100));
        balloon.set(0).await.unwrap_err();
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
