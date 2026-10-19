//! When each open stream last carried traffic.
//!
//! A compute sandbox sleeps when nothing in it is in use. The agent reports
//! its open streams that moved bytes within a silence limit as part of what
//! is in use, so an open terminal or a view someone is using keeps its
//! sandbox awake while one left open and silent does not.
//!
//! What counts as traffic: anything a viewer sends, on every kind of stream,
//! and what the agent sends on terminal, browser and computer streams. A
//! desktop stream's frames do not count, because its pump captures the
//! screen at a fixed rate whether or not anything changed or anyone watches.
//!
//! Times are wall-clock milliseconds, so a sandbox that slept sees its
//! streams as silent for the time it slept.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The stamps of every stream a hub opened that is still open.
#[derive(Clone, Default, Debug)]
pub struct StreamActivity {
    stamps: Arc<Mutex<Vec<Weak<AtomicU64>>>>,
}

impl StreamActivity {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The stamps. A panic elsewhere cannot leave the list inconsistent, so a
    /// poisoned lock is taken as it is.
    fn stamps(&self) -> std::sync::MutexGuard<'_, Vec<Weak<AtomicU64>>> {
        self.stamps.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A stamp for a stream being opened, counted as moving now. The stream's
    /// entry ends when its last stamp clone is dropped.
    #[must_use]
    pub fn track(&self) -> ActivityStamp {
        let stamp = Arc::new(AtomicU64::new(now_ms()));
        let mut stamps = self.stamps();
        stamps.retain(|stamp| stamp.strong_count() > 0);
        stamps.push(Arc::downgrade(&stamp));
        ActivityStamp(Some(stamp))
    }

    /// How many open streams carried traffic within `within`.
    #[must_use]
    pub fn moving(&self, within: Duration) -> usize {
        self.moving_at(now_ms(), within)
    }

    fn moving_at(&self, now_ms: u64, within: Duration) -> usize {
        let within_ms = u64::try_from(within.as_millis()).unwrap_or(u64::MAX);
        let mut stamps = self.stamps();
        stamps.retain(|stamp| stamp.strong_count() > 0);
        stamps
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|stamp| now_ms.saturating_sub(stamp.load(Ordering::Relaxed)) <= within_ms)
            .count()
    }
}

/// One stream's last-traffic time. Clones share it.
#[derive(Clone, Default, Debug)]
pub struct ActivityStamp(Option<Arc<AtomicU64>>);

impl ActivityStamp {
    /// A stamp no registry counts (tests and standalone channels).
    #[must_use]
    pub fn untracked() -> Self {
        Self(None)
    }

    /// Records traffic now.
    pub fn touch(&self) {
        if let Some(stamp) = &self.0 {
            stamp.store(now_ms(), Ordering::Relaxed);
        }
    }

    #[cfg(test)]
    fn set_at(&self, at_ms: u64) {
        if let Some(stamp) = &self.0 {
            stamp.store(at_ms, Ordering::Relaxed);
        }
    }

    /// Makes the stream look silent since the epoch.
    #[cfg(test)]
    pub(crate) fn set_silent_for_test(&self) {
        self.set_at(0);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SILENCE: Duration = Duration::from_secs(600);

    #[test]
    fn a_stream_counts_until_it_is_silent_for_the_limit() {
        let activity = StreamActivity::new();
        let stamp = activity.track();
        let now = now_ms();
        assert_eq!(activity.moving_at(now, SILENCE), 1);
        stamp.set_at(now - 600_000);
        assert_eq!(activity.moving_at(now, SILENCE), 1, "exactly the limit");
        stamp.set_at(now - 600_001);
        assert_eq!(activity.moving_at(now, SILENCE), 0);
        stamp.touch();
        assert_eq!(activity.moving(SILENCE), 1);
    }

    #[test]
    fn a_closed_stream_no_longer_counts() {
        let activity = StreamActivity::new();
        let open = activity.track();
        let closed = activity.track();
        let closed_clone = closed.clone();
        assert_eq!(activity.moving(SILENCE), 2);
        drop(closed);
        assert_eq!(activity.moving(SILENCE), 2, "a clone keeps it open");
        drop(closed_clone);
        assert_eq!(activity.moving(SILENCE), 1);
        drop(open);
        assert_eq!(activity.moving(SILENCE), 0);
        assert!(activity.stamps.lock().unwrap().is_empty());
    }

    #[test]
    fn a_clock_that_went_back_counts_as_moving() {
        let activity = StreamActivity::new();
        let stamp = activity.track();
        stamp.set_at(u64::MAX);
        assert_eq!(activity.moving(SILENCE), 1);
    }

    #[test]
    fn an_untracked_stamp_is_inert() {
        ActivityStamp::untracked().touch();
        assert_eq!(StreamActivity::new().moving(SILENCE), 0);
    }
}
