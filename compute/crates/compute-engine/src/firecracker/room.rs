//! The room the VMs' group keeps free under its limit (ADR 24).
//!
//! The host's memory rule leaves its low watermark available under the
//! VMs' limit for sandboxes that grow within their request, and counts the
//! page cache charged to the VMs' group as available, since the kernel can
//! drop it at once. Yet the kernel holds the group to its limit by all it
//! charges, that cache included: a sandbox growing into a reserve the
//! cache fills waits while it drops that cache, and while it compresses the
//! borrowers its growth reaches past it. The cache is there whatever the
//! VMs do now: what their disks read and wrote, and what VMs that ended
//! left to the group. In the lab, after a few sandboxes had come and gone,
//! it was 900 MiB of a 1 GiB reserve, and a neighbour growing within its
//! request waited a hundredth of the time while the borrower beside it
//! was brought down.
//!
//! So whenever less than the reserve is free under the limit, the engine
//! drops the group's cache, and only its cache, by the difference, in the
//! background: the reserve is free memory for whoever grows into it, and
//! what borrowers hold beyond their bounds is theirs to give back.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use crate::RoomKept;
use crate::cgroup::Cgroup;

/// Less than this is not worth a write: the kernel reclaims in batches,
/// and the next reading asks again.
const LEAST: u64 = 4 << 20;

/// What one write asks for. The kernel may take a good deal more than a
/// large ask (on Linux 7.0 with MGLRU, up to 687 MiB for 384 asked), so a
/// drop asks in steps and reads again after each.
const STEP: u64 = 32 << 20;

/// [`Room::refused`]: the kernel took every drop asked so far.
const TAKEN: u8 = 0;
/// The kernel refused to drop cache alone, and nobody was told yet.
const REFUSED: u8 = 1;
/// It refused, and that was said.
const SAID: u8 = 2;

/// Keeps the VMs' group's reserve free of page cache.
#[derive(Debug, Default)]
pub(super) struct Room {
    /// Whether a thread is dropping cache.
    working: AtomicBool,
    /// Whether the kernel cannot be asked for cache alone, and whether
    /// that was said.
    refused: AtomicU8,
}

impl Room {
    /// Drops `group`'s page cache in the background while less than
    /// `reserve` is free under its `memory.high`; nothing without one, or
    /// while an earlier drop is under way. A drop that fails is asked
    /// again on the next call; one the kernel refuses for asking for cache
    /// alone is never asked again, and the next call says so, once.
    /// A drop goes in [`STEP`]s, and stops early once a step frees less
    /// than a quarter of what it asked: what is left is not cache the
    /// kernel drops at once, and the next call looks again.
    pub(super) fn keep(self: &Arc<Self>, group: &Cgroup, reserve: u64) -> RoomKept {
        match self.refused.load(Ordering::Acquire) {
            TAKEN => {}
            REFUSED => {
                self.refused.store(SAID, Ordering::Release);
                return RoomKept::Unsupported;
            }
            _ => return RoomKept::Free,
        }
        let Some((wanted, _)) = wanted(group, reserve) else {
            return RoomKept::Free;
        };
        if wanted == 0 || self.working.swap(true, Ordering::AcqRel) {
            return RoomKept::Free;
        }
        let (room, group) = (Arc::clone(self), group.clone());
        std::thread::spawn(move || {
            room.drop_steps(&group, reserve);
            room.working.store(false, Ordering::Release);
        });
        RoomKept::Dropping(wanted)
    }

    /// Drops `group`'s cache step by step until `reserve` is free under
    /// its high, the cache is gone, or a step frees little.
    fn drop_steps(&self, group: &Cgroup, reserve: u64) {
        while let Some((wanted, current)) = wanted(group, reserve) {
            if wanted == 0 {
                return;
            }
            let asked = wanted.min(STEP);
            match group.drop_cache(asked) {
                Ok(Some(())) => {}
                Ok(None) => {
                    self.refused.store(REFUSED, Ordering::Release);
                    return;
                }
                Err(_) => return,
            }
            let Ok(after) = group.memory_current() else {
                return;
            };
            if current.saturating_sub(after) < asked / 4 {
                return;
            }
        }
    }
}

/// What `group` should drop for `reserve` to be free under its high, and
/// what it holds now; `None` when it cannot be read.
fn wanted(group: &Cgroup, reserve: u64) -> Option<(u64, u64)> {
    match (
        group.memory_high(),
        group.memory_current(),
        group.droppable_cache(),
    ) {
        (Ok(high), Ok(current), Ok(droppable)) => {
            Some((to_drop(high, current, droppable, reserve), current))
        }
        _ => None,
    }
}

/// Bytes of page cache to drop from a group holding `current` under
/// `high`, with `droppable` of it cache it can drop at once, for `reserve`
/// to be free under its high: none without a high, or when that is less
/// than [`LEAST`].
pub(super) fn to_drop(high: Option<u64>, current: u64, droppable: u64, reserve: u64) -> u64 {
    let Some(high) = high else {
        return 0;
    };
    let short = reserve.saturating_sub(high.saturating_sub(current));
    let wanted = short.min(droppable);
    if wanted < LEAST { 0 } else { wanted }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;

    #[test]
    fn only_what_the_reserve_lacks_and_the_cache_has_is_dropped() {
        // The lab's case: 159 MiB free of a 1 GiB reserve, 900 MiB cache.
        assert_eq!(
            to_drop(Some(4864 * MIB), 4705 * MIB, 900 * MIB, 1024 * MIB),
            865 * MIB
        );
        // Less cache than the reserve lacks: all of it.
        assert_eq!(
            to_drop(Some(4864 * MIB), 4705 * MIB, 300 * MIB, 1024 * MIB),
            300 * MIB
        );
        // The reserve free, or nothing to drop, or no limit: nothing.
        assert_eq!(
            to_drop(Some(4864 * MIB), 3000 * MIB, 900 * MIB, 1024 * MIB),
            0
        );
        assert_eq!(to_drop(Some(4864 * MIB), 4705 * MIB, 0, 1024 * MIB), 0);
        assert_eq!(to_drop(None, 4705 * MIB, 900 * MIB, 1024 * MIB), 0);
        // Above the high already: the whole reserve, as far as cache goes.
        assert_eq!(
            to_drop(Some(4864 * MIB), 5000 * MIB, 2048 * MIB, 1024 * MIB),
            1024 * MIB
        );
        // Too little to be worth a write.
        assert_eq!(
            to_drop(Some(4864 * MIB), 3842 * MIB, 900 * MIB, 1024 * MIB),
            0
        );
    }
}
