//! The fence on archive pointers in object storage.
//!
//! Each sandbox's archive pointer carries a [`Stamp`]: the owner epoch of
//! the host that wrote it and that host's number for the save it names.
//! A pointer is only ever replaced on condition that it has not changed
//! since it was read, and only by a later stamp. A new owner first stores
//! the pointer again under its own epoch (it claims it), which makes every
//! archive a former owner began earlier fail its condition; that archive
//! then reads the pointer again, finds the newer epoch and stops. Within
//! one owner, an older save never replaces a newer one, even when the two
//! archives overlap.

use crate::ids::OwnerEpoch;

/// What an archive pointer says about the save it names. Stamps order by
/// epoch, then by save.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp {
    /// The owner epoch of the host that wrote the pointer.
    pub epoch: OwnerEpoch,
    /// That host's number for the save, rising with each save it takes.
    /// A host that adopts a sandbox continues from the number it claims.
    pub save: u64,
}

/// What a host does with the pointer it found when it comes to publish.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fence {
    /// Replace it, on condition that it has not changed since it was read.
    Publish,
    /// It already names this save or a later one by the same owner, so
    /// there is nothing to publish and this save counts as archived.
    Done,
    /// A later owner claimed it: the sandbox belongs to that owner now,
    /// and this host should drop its copy.
    Superseded {
        /// The epoch the pointer carries.
        by: OwnerEpoch,
    },
}

/// What a host owning a sandbox may do with its pointer when publishing
/// the save `own` over the pointer it found carrying `found` (`None` when
/// there is no pointer yet).
#[must_use]
pub fn fence(own: Stamp, found: Option<Stamp>) -> Fence {
    match found {
        Some(found) if found.epoch > own.epoch => Fence::Superseded { by: found.epoch },
        Some(found) if found >= own => Fence::Done,
        _ => Fence::Publish,
    }
}

#[cfg(test)]
mod tests {
    use super::{Fence, OwnerEpoch, Stamp, fence};

    fn stamp(epoch: u64, save: u64) -> Stamp {
        Stamp {
            epoch: OwnerEpoch(epoch),
            save,
        }
    }

    #[test]
    fn a_later_epoch_supersedes_whatever_the_save() {
        assert_eq!(
            fence(stamp(4, 90), Some(stamp(5, 1))),
            Fence::Superseded { by: OwnerEpoch(5) }
        );
    }

    #[test]
    fn the_same_or_a_later_save_by_this_owner_is_done() {
        assert_eq!(fence(stamp(4, 7), Some(stamp(4, 7))), Fence::Done);
        assert_eq!(fence(stamp(4, 7), Some(stamp(4, 8))), Fence::Done);
    }

    #[test]
    fn an_earlier_stamp_or_none_is_published_over() {
        assert_eq!(fence(stamp(4, 7), None), Fence::Publish);
        assert_eq!(fence(stamp(4, 7), Some(stamp(4, 6))), Fence::Publish);
        assert_eq!(fence(stamp(4, 1), Some(stamp(3, 90))), Fence::Publish);
    }
}
