//! The rules that let a sweep delete stored objects no copy names while
//! archives that may name them again are still in flight.
//!
//! Chunks and manifests are named by their content and shared. An archive
//! that finds one already stored reuses it without writing it, and names
//! it only when it publishes its pointer at the end. A sweep could
//! therefore delete an old object no pointer names just as an archive
//! starts to reuse it. Three rules close that gap:
//!
//! 1. An archive begins by noting which version of its pointer is stored,
//!    storing an empty pointer if there is none, and publishes only on
//!    condition that the pointer is still that version (see
//!    [`ChunkStore::begin`](crate::store::ChunkStore::begin)).
//! 2. Before it deletes anything, a sweep stores every pointer again as it
//!    read it, on condition that it is still the version read. An archive
//!    that began before then can no longer publish, and starts again; one
//!    that published meanwhile changed the pointer, so the sweep reads it
//!    again.
//! 3. An archive that reuses an object stored more than
//!    [`Freshness::refresh_after`] ago stores it again, and a sweep deletes
//!    only objects stored more than [`Freshness::sweep_after`] before it
//!    began, each only if it has not been stored again since it looked.
//!
//! So every pointer a sweep did not account for was published by an
//! archive that began after the sweep did, and everything such an archive
//! relies on was stored too recently for the sweep to delete. The store
//! enforces rules 1 and 2 on each write, so neither a slow request nor a
//! stalled host can publish past a sweep; only rule 3 rests on the clocks
//! of hosts, sweeps and the store agreeing to within
//! [`Freshness::clock_skew`].

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const DAY: Duration = Duration::from_secs(86_400);

/// The times of rule 3 above. Host agents and sweeps of one store must use
/// the same values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Freshness {
    /// A reused object stored longer ago than this is stored again.
    pub refresh_after: Duration,
    /// How far the clock of any host or sweep may disagree with the
    /// store's.
    pub clock_skew: Duration,
}

impl Freshness {
    /// A week before a reused object is stored again and an hour of clock
    /// disagreement: an object no copy names is deleted about a week after
    /// it was last stored.
    pub const DEFAULT: Self = Self {
        refresh_after: Duration::from_secs(7 * DAY.as_secs()),
        clock_skew: Duration::from_secs(3_600),
    };

    /// How long ago an object no pointer names must have been stored for a
    /// sweep to delete it: the refresh window, and the clocks of a host and
    /// a sweep disagreeing in opposite directions.
    #[must_use]
    pub fn sweep_after(&self) -> Duration {
        self.refresh_after + self.clock_skew * 2
    }

    /// Whether an object stored at `stored` must be stored again before an
    /// archive relies on it. An object stored "in the future" by this
    /// host's clock is recent.
    #[must_use]
    pub fn is_stale(&self, stored: SystemTime, now: SystemTime) -> bool {
        now.duration_since(stored)
            .is_ok_and(|age| age > self.refresh_after)
    }
}

impl Default for Freshness {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Where a store reads the time: the system clock, or a test's.
#[derive(Clone)]
pub struct Clock(Arc<dyn Fn() -> SystemTime + Send + Sync>);

impl Clock {
    #[must_use]
    pub fn system() -> Self {
        Self(Arc::new(SystemTime::now))
    }

    pub fn from_fn(now: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        Self(Arc::new(now))
    }

    #[must_use]
    pub fn now(&self) -> SystemTime {
        (self.0)()
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::system()
    }
}

impl fmt::Debug for Clock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Clock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sweep_waits_out_the_refresh_window_and_the_clocks() {
        let freshness = Freshness::DEFAULT;
        assert_eq!(
            freshness.sweep_after(),
            7 * DAY + 2 * 3_600 * Duration::from_secs(1)
        );
        let now = SystemTime::UNIX_EPOCH + 30 * DAY;
        assert!(!freshness.is_stale(now - 7 * DAY, now));
        assert!(freshness.is_stale(now - 7 * DAY - Duration::from_secs(1), now));
        assert!(!freshness.is_stale(now + DAY, now), "from a later clock");
    }
}
