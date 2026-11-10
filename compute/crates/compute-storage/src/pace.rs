//! How many uploads a store is sent at once, and trying an upload again.
//!
//! A store that slows down answers every upload in flight more slowly: on
//! one shared by many writers, with a node short of disk bandwidth, a pack
//! took from under two to eleven seconds on its own. An archive (and every
//! archive on the host at once) sending dozens of packs together then
//! splits the store's bandwidth so finely that every one of them runs past
//! the client's deadline at about the same time: nothing is stored, the
//! archive fails and starts over, and the store is no less busy.
//!
//! So uploads take a slot first, and the number of slots follows what the
//! store manages, as TCP's window does: one more for every window of
//! uploads stored in time, half as many when an upload sent under the
//! current number fails as a busy store fails (it timed out, or the
//! connection broke), never fewer than one. An upload that failed that way
//! is tried again after a pause, in a slot of its own: what is stored
//! under a content name allows no other bytes, so sending it twice cannot
//! store anything else. A store that takes uploads one at a time is then
//! still sent one at a time, and each finishes.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::Notify;

use crate::Error;

/// Uploads sent at once before the store has said anything.
pub(crate) const FIRST: f64 = 8.0;

/// The most uploads sent at once, however well the store keeps up: each
/// pack holds its bytes in memory until stored.
pub(crate) const MOST: f64 = 64.0;

/// How many times an upload is sent before its failure is the caller's.
pub(crate) const TRIES: u32 = 6;

/// The pause before the first try again; each next one waits twice as
/// long, up to [`PAUSE_MOST`].
const PAUSE: Duration = Duration::from_secs(1);
const PAUSE_MOST: Duration = Duration::from_secs(30);

/// The slots for a store's uploads, shared by every clone of the store.
#[derive(Debug)]
pub(crate) struct Pace {
    state: Mutex<State>,
    freed: Notify,
}

#[derive(Debug)]
struct State {
    /// How many uploads may be under way: a fraction grows the next.
    limit: f64,
    running: usize,
    /// How many times the limit was cut: an upload that fails under a
    /// limit already cut since it began cuts it no further.
    cuts: u64,
}

/// One upload's place among those under way; given back when dropped.
#[derive(Debug)]
pub(crate) struct Slot<'a> {
    pace: &'a Pace,
    /// The cuts made when it was taken.
    cuts: u64,
}

impl Pace {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                limit: FIRST,
                running: 0,
                cuts: 0,
            }),
            freed: Notify::new(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// How many uploads may be under way now.
    #[cfg(test)]
    pub(crate) fn limit(&self) -> usize {
        slots(self.state().limit)
    }

    /// Waits for a slot.
    pub(crate) async fn slot(&self) -> Slot<'_> {
        loop {
            let freed = self.freed.notified();
            let mut freed = std::pin::pin!(freed);
            // Listening before looking, so a slot given back in between
            // still wakes this one.
            freed.as_mut().enable();
            {
                let mut state = self.state();
                if state.running < slots(state.limit) {
                    state.running += 1;
                    return Slot {
                        pace: self,
                        cuts: state.cuts,
                    };
                }
            }
            freed.await;
        }
    }
}

impl Slot<'_> {
    /// Its upload was stored: one more slot for every window of uploads.
    pub(crate) fn stored(self) {
        let mut state = self.pace.state();
        state.limit = (state.limit + 1.0 / state.limit).min(MOST);
    }

    /// Its upload failed as a busy store's do: half as many slots, unless
    /// they were cut since it began.
    pub(crate) fn crowded(self) {
        let mut state = self.pace.state();
        if state.cuts == self.cuts {
            state.limit = (state.limit / 2.0).max(1.0);
            state.cuts += 1;
            tracing::info!(
                uploads_at_once = slots(state.limit),
                "the object store is slow to take uploads: fewer are sent at once"
            );
        }
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.pace.state().running -= 1;
        self.pace.freed.notify_waiters();
    }
}

/// Whole slots of `limit`, at least one.
fn slots(limit: f64) -> usize {
    // Within 1..=MOST, so the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let whole = limit.floor() as usize;
    whole.max(1)
}

/// Whether an upload failed as one to a busy store does, so trying it
/// again later may store it: the request timed out or its connection
/// broke, which `object_store` reports as a generic error after its own
/// retries, or the Cloud Storage uploader as a failed transfer.
pub(crate) fn crowded(error: &Error) -> bool {
    matches!(
        error,
        Error::Transfer(_) | Error::Object(object_store::Error::Generic { .. })
    )
}

/// How long to wait before try `tries` + 1, after `tries` failed.
pub(crate) fn pause(tries: u32) -> Duration {
    PAUSE
        .saturating_mul(1 << tries.saturating_sub(1).min(16))
        .min(PAUSE_MOST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_grow_a_window_at_a_time_and_halve_once_per_crowding() {
        let pace = Pace::new();
        assert_eq!(pace.limit(), 8);
        // Nine stored, each adding about an eighth: one more slot.
        for _ in 0..9 {
            let slot = futures::executor::block_on(pace.slot());
            slot.stored();
        }
        assert_eq!(pace.limit(), 9);
        // Nine taken together all fail: one cut, not nine.
        let taken: Vec<Slot<'_>> = (0..9)
            .map(|_| futures::executor::block_on(pace.slot()))
            .collect();
        for slot in taken {
            slot.crowded();
        }
        assert_eq!(pace.limit(), 4);
        // Then a slot taken under the cut limit cuts again, down to one.
        for expected in [2, 1, 1] {
            futures::executor::block_on(pace.slot()).crowded();
            assert_eq!(pace.limit(), expected);
        }
    }

    #[tokio::test]
    async fn an_upload_waits_for_a_slot_given_back() {
        let pace = std::sync::Arc::new(Pace::new());
        let held: Vec<Slot<'_>> = futures::future::join_all((0..8).map(|_| pace.slot())).await;
        let waiting = {
            let pace = std::sync::Arc::clone(&pace);
            tokio::spawn(async move {
                pace.slot().await.stored();
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "all eight slots are taken");
        drop(held);
        waiting.await.unwrap();
    }

    #[test]
    fn pauses_double_up_to_half_a_minute() {
        let seconds: Vec<u64> = (1..=7).map(|tries| pause(tries).as_secs()).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn only_timeouts_and_broken_transfers_count_as_a_busy_store() {
        let timeout = Error::Object(object_store::Error::Generic {
            store: "S3",
            source: "Error performing PUT in 30s - HTTP error: error sending request".into(),
        });
        assert!(crowded(&timeout));
        assert!(crowded(&Error::Transfer("reset".into())));
        assert!(!crowded(&Error::Integrity));
        let denied = Error::Object(object_store::Error::PermissionDenied {
            path: "packs/v1/x".into(),
            source: "denied".into(),
        });
        assert!(!crowded(&denied));
    }
}
