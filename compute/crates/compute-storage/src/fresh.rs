//! The rules that let a sweep delete stored objects no copy names while
//! archives that may name them are still in flight, on a store that does
//! nothing on condition but replace a pointer (ADR 25).
//!
//! Chunks and manifests are named by their content and by the day they
//! were written ([`day_of`], in UTC), and are written only under the
//! writer's current day. An archive reuses what the pointers it reads after
//! it began name, whatever their day, and an object of new bytes only if
//! another archive wrote the same bytes today. The pointers it reads are
//! its own sandbox's, which nothing but the sandbox's owner and a sweep's
//! fence change, and its image's, which is written once and emptied only
//! once no sandbox or template has used the image for a while: reusing
//! what a pointer names that may change while the archive is in flight
//! would not be safe. Two rules then make a sweep safe:
//!
//! 1. An archive begins by noting which version of its pointer is kept,
//!    keeping an empty pointer if there is none, and publishes only on
//!    condition that the pointer is still that version (see
//!    [`ChunkStore::begin`](crate::store::ChunkStore::begin)). Before it
//!    deletes anything, a sweep keeps every pointer again as it read it, on
//!    condition that it is still the version read: an archive that began
//!    before then can no longer publish, and starts again.
//! 2. A sweep deletes an object no pointer names only once its day ended a
//!    whole day before the sweep began ([`sweepable`]).
//!
//! So every pointer after a sweep's fence names only objects named at the
//! fence or written after it, and nothing written after it is two days
//! old. Nothing writes a name of an earlier day either, so a delete held
//! up in flight, however long, never takes a later write: no delete needs
//! a condition. Only rule 2 rests on clocks, which may disagree by up to
//! [`CLOCK_SKEW`], well within its day of margin. In a fleet every writer
//! and sweep reads one clock, the database's ([`Clock::following`]), so a
//! host whose own clock runs wrong, or is stepped while it runs, cannot
//! break it.
//!
//! Objects in the old layout, named by content alone, are never written
//! again. One no pointer names is deleted once it was last stored more
//! than [`LEGACY_SWEEP_AFTER`] before the sweep began, and only once the
//! pointers that may name it have been where the sweep reads them for as
//! long (see [`crate::sweep::sweep`]).

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

const DAY: Duration = Duration::from_secs(86_400);

/// How far the clock of any host or sweep may disagree with another's.
pub const CLOCK_SKEW: Duration = Duration::from_secs(3_600);

/// How long ago an object of the old layout no pointer names must have
/// been stored for a sweep to delete it: the week after which writers of
/// that layout stored a reused object again, and two clock disagreements.
pub const LEGACY_SWEEP_AFTER: Duration =
    Duration::from_secs(7 * DAY.as_secs() + 2 * CLOCK_SKEW.as_secs());

/// The day `at` falls on, in whole UTC days since 1970; 0 before then.
#[must_use]
pub fn day_of(at: SystemTime) -> u32 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            u32::try_from(since.as_secs() / DAY.as_secs()).unwrap_or(u32::MAX)
        })
}

/// Whether an object of day `day` no pointer names may be deleted by a
/// sweep that began at `began`: its day ended at least a whole day before.
#[must_use]
pub fn sweepable(day: u32, began: SystemTime) -> bool {
    day.checked_add(2)
        .is_some_and(|after| after <= day_of(began))
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

    /// Another clock, as `heard` last heard it, moved on since by this
    /// process's monotonic clock: a step of the system clock does not move
    /// it. The system clock until it is first heard.
    #[must_use]
    pub fn following(heard: Arc<Heard>) -> Self {
        Self::from_fn(move || heard.now())
    }

    #[must_use]
    pub fn now(&self) -> SystemTime {
        (self.0)()
    }
}

/// `at` moved by `offset_ms`, which may be negative; never before 1970.
#[must_use]
pub fn shifted(at: SystemTime, offset_ms: i64) -> SystemTime {
    let by = Duration::from_millis(offset_ms.unsigned_abs());
    if offset_ms >= 0 {
        at.checked_add(by).unwrap_or(at)
    } else {
        at.checked_sub(by)
            .filter(|moved| *moved >= SystemTime::UNIX_EPOCH)
            .unwrap_or(SystemTime::UNIX_EPOCH)
    }
}

/// How far `other`, in milliseconds since 1970, is ahead of `at` (behind
/// when negative).
#[must_use]
pub fn offset_ms(other: u64, at: SystemTime) -> i64 {
    let at = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i128::try_from(since.as_millis()).unwrap_or(i128::MAX)
        });
    let offset = i128::from(other) - at;
    i64::try_from(offset).unwrap_or(if offset < 0 { i64::MIN } else { i64::MAX })
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

/// Another clock as last heard: the time it told, in milliseconds since
/// 1970, and when that was on this process's monotonic clock.
#[derive(Debug, Default)]
pub struct Heard(Mutex<Option<(Instant, u64)>>);

impl Heard {
    /// Heard as telling `now_ms` just now.
    #[must_use]
    pub fn at(now_ms: u64) -> Self {
        let heard = Self::default();
        heard.note(now_ms);
        heard
    }

    /// Notes that the other clock tells `now_ms` now.
    pub fn note(&self, now_ms: u64) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), now_ms));
    }

    /// The other clock now: as last heard, moved on by the time since on the
    /// monotonic clock; the system clock if it was never heard.
    #[must_use]
    pub fn now(&self) -> SystemTime {
        let heard = *self.0.lock().unwrap_or_else(PoisonError::into_inner);
        heard.map_or_else(SystemTime::now, |(at, ms)| {
            SystemTime::UNIX_EPOCH + Duration::from_millis(ms) + at.elapsed()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_are_utc_days_since_1970() {
        let at = SystemTime::UNIX_EPOCH + 20_390 * DAY;
        assert_eq!(day_of(at), 20_390);
        assert_eq!(day_of(at + DAY - Duration::from_secs(1)), 20_390);
        assert_eq!(day_of(at + DAY), 20_391);
        assert_eq!(day_of(SystemTime::UNIX_EPOCH - DAY), 0);
    }

    #[test]
    fn a_clock_follows_another_by_its_offset() {
        let at = SystemTime::UNIX_EPOCH + 20_390 * DAY;
        let ahead = at + DAY;
        let offset = offset_ms(
            u64::try_from(
                ahead
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap(),
            at,
        );
        assert_eq!(offset, 86_400_000);
        assert_eq!(shifted(at, offset), ahead);
        assert_eq!(shifted(ahead, -offset), at);
        assert_eq!(shifted(at, i64::MIN), SystemTime::UNIX_EPOCH);
        let near = |a: SystemTime, b: SystemTime| {
            a.duration_since(b)
                .or_else(|_| b.duration_since(a))
                .unwrap()
                < Duration::from_secs(60)
        };
        let followed = Arc::new(Heard::default());
        let clock = Clock::following(Arc::clone(&followed));
        assert!(
            near(clock.now(), SystemTime::now()),
            "unheard, the system's"
        );
        let behind = SystemTime::now() - DAY;
        followed.note(
            u64::try_from(
                behind
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap(),
        );
        assert!(near(clock.now() + DAY, SystemTime::now()));
        let earlier = clock.now();
        std::thread::sleep(Duration::from_millis(20));
        assert!(clock.now() > earlier, "it moves on by the monotonic clock");
        followed.note(millis_now());
        assert!(near(clock.now(), SystemTime::now()));
    }

    fn millis_now() -> u64 {
        u64::try_from(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }

    #[test]
    fn an_object_is_swept_only_once_its_day_ended_a_whole_day_before() {
        let midnight = SystemTime::UNIX_EPOCH + 20_392 * DAY;
        // Yesterday's ended less than a day ago.
        assert!(!sweepable(20_391, midnight));
        assert!(!sweepable(20_391, midnight + DAY - Duration::from_secs(1)));
        assert!(sweepable(20_390, midnight));
        assert!(!sweepable(20_392, midnight), "today's");
        assert!(!sweepable(u32::MAX, midnight), "a later clock's");
        // A writer whose clock is behind by the skew, writing just after a
        // sweep's fence, writes a day the sweep keeps.
        let fence = midnight + Duration::from_secs(60);
        assert!(!sweepable(day_of(fence - CLOCK_SKEW), fence));
    }
}
