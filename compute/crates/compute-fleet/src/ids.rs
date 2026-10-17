//! Identifiers and epochs.

use core::fmt;

/// A host, unique across the fleet for as long as it exists. The service
/// assigns these when a host first registers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostId(pub u64);

/// Which registration of a host a lease belongs to. Raised every time the
/// host registers, so a renewal from an earlier registration, or from a
/// host the service has given up on, changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct HostEpoch(pub u64);

/// Which ownership of a sandbox a write belongs to. Raised every time the
/// sandbox changes hands or loses its owner, so every period of ownership
/// has its own epoch and a former owner's writes can be refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct OwnerEpoch(pub u64);

impl OwnerEpoch {
    /// The epoch a new sandbox starts at.
    pub const FIRST: Self = Self(1);

    /// The epoch after this one.
    #[must_use]
    pub const fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// How many epochs `self` is past `earlier`, or `None` when it is not.
    #[must_use]
    pub const fn since(self, earlier: Self) -> Option<u64> {
        self.0.checked_sub(earlier.0)
    }
}

impl fmt::Display for OwnerEpoch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// A failure domain, such as a cloud zone. Interned by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ZoneId(pub u16);

/// Hosts whose saved memory images restore on one another: the same CPU
/// template, Firecracker release and memory layout. Interned by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ClassId(pub u16);

/// A kind of new sandbox a host can keep ready clones of: an image and a
/// shape. Chosen by the caller, for example as a hash of both.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ShapeKey(pub u64);
