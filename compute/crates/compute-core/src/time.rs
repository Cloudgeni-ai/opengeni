//! Monotonic time supplied by the caller, so the core never reads a clock.

use core::fmt;
use core::ops::Add;
use core::time::Duration;

/// A point on the host's monotonic clock, measured from an arbitrary origin.
///
/// The core never reads a clock. Callers stamp every call with the current
/// `At`, which keeps decisions deterministic and replayable in tests.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct At(Duration);

impl At {
    /// The clock origin.
    pub const ZERO: Self = Self(Duration::ZERO);

    /// The point `since_origin` after the origin.
    #[must_use]
    pub const fn from_duration(since_origin: Duration) -> Self {
        Self(since_origin)
    }

    /// The point `millis` milliseconds after the origin.
    #[must_use]
    pub const fn from_millis(millis: u64) -> Self {
        Self(Duration::from_millis(millis))
    }

    /// Time since the origin.
    #[must_use]
    pub const fn since_origin(self) -> Duration {
        self.0
    }

    /// Time from `earlier` to `self`, or zero when `earlier` is later.
    #[must_use]
    pub const fn saturating_since(self, earlier: Self) -> Duration {
        self.0.saturating_sub(earlier.0)
    }
}

impl Add<Duration> for At {
    type Output = Self;

    /// Saturates at the far end of the clock instead of overflowing.
    fn add(self, rhs: Duration) -> Self {
        Self(self.0.saturating_add(rhs))
    }
}

impl fmt::Debug for At {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "t+{:?}", self.0)
    }
}
