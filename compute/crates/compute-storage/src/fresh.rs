//! The time rules that let a sweep delete stored objects no copy names
//! while archives that may name them again are still in flight.
//!
//! Chunks and manifests are named by their content and shared. An archive
//! that finds one already stored reuses it without writing it, and names
//! it only when it publishes its pointer at the end. A sweep could
//! therefore delete an old object no pointer names just as an archive
//! starts to reuse it. Three rules close that gap:
//!
//! 1. An archive that reuses an object stored more than
//!    [`Freshness::refresh_after`] ago stores it again, so everything an
//!    archive relies on was stored recently.
//! 2. An archive publishes its pointer within [`Freshness::publish_within`]
//!    of starting, or not at all (see [`Publication`]).
//! 3. A sweep deletes only objects stored more than
//!    [`Freshness::sweep_after`] before it began reading pointers, and only
//!    if the object has not been stored again since it looked, so a store
//!    under rule 1 survives a sweep that saw the older copy.
//!
//! `sweep_after` covers both windows and the clocks' disagreement twice
//! over, so any pointer naming an object a sweep may delete was published
//! before the sweep read pointers: the sweep sees it and keeps the object.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const DAY: Duration = Duration::from_secs(86_400);

/// The windows of the rules above. Host agents and sweeps of one store
/// must use the same values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Freshness {
    /// A reused object stored longer ago than this is stored again.
    pub refresh_after: Duration,
    /// An archive publishes within this long of starting, or not at all.
    pub publish_within: Duration,
    /// How far the clocks of hosts and the store may disagree.
    pub clock_skew: Duration,
}

impl Freshness {
    /// A week before a reused object is stored again, a day to publish, an
    /// hour of clock disagreement: an object no copy names is deleted
    /// about eight days after it was last stored.
    pub const DEFAULT: Self = Self {
        refresh_after: Duration::from_secs(7 * DAY.as_secs()),
        publish_within: DAY,
        clock_skew: Duration::from_secs(3_600),
    };

    /// How long ago an object no pointer names must have been stored for a
    /// sweep to delete it.
    #[must_use]
    pub fn sweep_after(&self) -> Duration {
        self.refresh_after + self.publish_within + self.clock_skew * 2
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

/// One archive between its start and the pointer naming what it stored.
/// Begun before the archive looks at the store at all.
#[derive(Clone, Copy, Debug)]
#[must_use = "an archive publishes through its publication"]
pub struct Publication {
    pub(crate) started: SystemTime,
}

impl Publication {
    /// Whether a pointer may still be published at `now`. A clock that
    /// went backwards leaves the elapsed time unknown, so it may not.
    pub(crate) fn open(&self, freshness: &Freshness, now: SystemTime) -> bool {
        now.duration_since(self.started)
            .is_ok_and(|elapsed| elapsed <= freshness.publish_within)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sweep_waits_out_both_windows_and_the_clocks() {
        let freshness = Freshness::DEFAULT;
        assert_eq!(
            freshness.sweep_after(),
            8 * DAY + 2 * 3_600 * Duration::from_secs(1)
        );
        let now = SystemTime::UNIX_EPOCH + 30 * DAY;
        assert!(!freshness.is_stale(now - 7 * DAY, now));
        assert!(freshness.is_stale(now - 7 * DAY - Duration::from_secs(1), now));
        assert!(!freshness.is_stale(now + DAY, now), "from a later clock");
    }

    #[test]
    fn a_publication_closes_after_its_window_or_a_clock_going_back() {
        let freshness = Freshness::DEFAULT;
        let started = SystemTime::UNIX_EPOCH + 30 * DAY;
        let publication = Publication { started };
        assert!(publication.open(&freshness, started));
        assert!(publication.open(&freshness, started + DAY));
        assert!(!publication.open(&freshness, started + DAY + Duration::from_secs(1)));
        assert!(!publication.open(&freshness, started - Duration::from_secs(1)));
    }
}
