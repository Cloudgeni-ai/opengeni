//! Whether the host's local disk can take the next save of every VM whose
//! state is not saved yet, and the background relief that keeps it so;
//! see [`crate::DiskPolicy`].

use core::fmt;

use super::Host;
use crate::ids::SandboxId;
use crate::level::{Durability, Level, Step};
use crate::sandbox::Sandbox;
use crate::time::At;

/// Inodes one save may create at most: a generation's few files, its
/// staging directory and the VM's own state files.
const SAVE_INODES: u64 = 16;

/// What a host can run short of for a wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resource {
    /// Memory, in bytes; see [`crate::Admission`].
    Memory,
    /// Local disk for saves, in bytes; see [`crate::DiskPolicy`].
    Disk,
    /// Local disk inodes for saves.
    Inodes,
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Memory => "memory",
            Self::Disk => "disk",
            Self::Inodes => "disk inodes",
        })
    }
}

/// An amount of local disk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiskSpace {
    /// Bytes.
    pub bytes: u64,
    /// Inodes.
    pub inodes: u64,
}

impl DiskSpace {
    /// What one save that writes at most `bytes` books: those bytes and
    /// the inodes of one save's files.
    #[must_use]
    pub const fn save(bytes: u64) -> Self {
        Self {
            bytes,
            inodes: SAVE_INODES,
        }
    }

    pub(super) fn add(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_add(other.bytes),
            inodes: self.inodes.saturating_add(other.inodes),
        }
    }

    fn saturating_sub(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(other.bytes),
            inodes: self.inodes.saturating_sub(other.inodes),
        }
    }
}

/// How much of the host's local disk saves have booked; see
/// [`Host::disk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiskCapacity {
    /// What the disk had available at the last reading.
    pub available: DiskSpace,
    /// What the next saves of VMs not saved yet may need at most.
    pub booked: DiskSpace,
    /// What is never booked; see [`crate::DiskPolicy::reserve`].
    pub reserve: DiskSpace,
}

impl DiskCapacity {
    /// What more wakes may still book.
    #[must_use]
    pub fn free(&self) -> DiskSpace {
        self.available
            .saturating_sub(self.booked)
            .saturating_sub(self.reserve)
    }
}

/// Disk left for more bookings in one decision, negative when overdrawn.
#[derive(Clone, Copy, Debug)]
pub(super) struct DiskRoom {
    bytes: i128,
    inodes: i128,
}

/// A wake the disk cannot book.
#[derive(Clone, Copy, Debug)]
pub(super) struct Short {
    pub resource: Resource,
    pub needed: u64,
    pub free: u64,
}

impl DiskRoom {
    /// Books `need` if it fits, otherwise says what is short.
    pub(super) fn take(&mut self, need: DiskSpace) -> Result<(), Short> {
        let short = |resource, needed: u64, room: i128| Short {
            resource,
            needed,
            free: u64::try_from(room).unwrap_or(0),
        };
        if i128::from(need.bytes) > self.bytes {
            return Err(short(Resource::Disk, need.bytes, self.bytes));
        }
        if i128::from(need.inodes) > self.inodes {
            return Err(short(Resource::Inodes, need.inodes, self.inodes));
        }
        self.bytes -= i128::from(need.bytes);
        self.inodes -= i128::from(need.inodes);
        Ok(())
    }

    /// Gives back what [`Self::take`] booked.
    pub(super) fn give_back(&mut self, need: DiskSpace) {
        self.bytes += i128::from(need.bytes);
        self.inodes += i128::from(need.inodes);
    }
}

impl Sandbox {
    /// Whether it books disk for its next save: its VM holds state no copy
    /// has yet, or it is waking into one.
    pub(super) fn books_save(&self) -> bool {
        self.reserves()
            || (self.state.level.has_process() && self.state.durability == Durability::Volatile)
    }

    /// What its next save may need at most.
    pub(super) fn save_space(&self) -> DiskSpace {
        DiskSpace::save(self.size.save)
    }

    /// What a wake of it books besides what it already does.
    pub(super) fn save_need(&self) -> DiskSpace {
        if self.books_save() {
            DiskSpace::default()
        } else {
            self.save_space()
        }
    }
}

impl Host {
    /// How much of the host's local disk saves have booked, or `None`
    /// without a disk policy or a reading. Spare VMs book what they may
    /// still write, such as a template build its snapshot. What steps and
    /// spare VMs that finished since that reading wrote stays booked until
    /// the next one.
    #[must_use]
    pub fn disk(&self) -> Option<DiskCapacity> {
        let policy = self.policy.disk?;
        let available = self.disk?;
        let booked = self
            .sandboxes
            .values()
            .filter(|slot| slot.books_save())
            .fold(self.disk_spent.add(self.spares.disk()), |sum, slot| {
                sum.add(slot.save_space())
            });
        Some(DiskCapacity {
            available,
            booked,
            reserve: DiskSpace {
                bytes: policy.reserve,
                inodes: policy.reserve_inodes,
            },
        })
    }

    /// What wakes may still book in one decision: nothing before the first
    /// reading.
    pub(super) fn disk_room(&self) -> Option<DiskRoom> {
        self.policy.disk?;
        let Some(disk) = self.disk() else {
            return Some(DiskRoom {
                bytes: 0,
                inodes: 0,
            });
        };
        let room = |available: u64, booked: u64, reserve: u64| {
            i128::from(available) - i128::from(booked) - i128::from(reserve)
        };
        Some(DiskRoom {
            bytes: room(disk.available.bytes, disk.booked.bytes, disk.reserve.bytes),
            inodes: room(
                disk.available.inodes,
                disk.booked.inodes,
                disk.reserve.inodes,
            ),
        })
    }

    /// While the disk cannot book what is booked already and what the
    /// wakes refused and still held need, has idle sandboxes that may live
    /// in object storage give up their local copies, least recently used
    /// first, as many at once as may be evicted. Waits for those to finish
    /// and for a reading taken after them before giving up more, since
    /// what a local copy takes is only known from the disk. Returns
    /// whether any floor changed.
    pub(super) fn keep_disk(&mut self, now: At) -> bool {
        let Some(mut room) = self.disk_room() else {
            return false;
        };
        let held = self
            .refused
            .iter()
            .filter_map(|id| self.sandboxes.get(id))
            .fold(DiskSpace::default(), |sum, slot| sum.add(slot.save_need()));
        let leaving = self
            .sandboxes
            .values()
            .any(|slot| slot.floor == Level::Remote);
        if room.take(held).is_ok() || leaving || !self.disk_fresh {
            return false;
        }
        let grace = self.busy_grace();
        let mut candidates: Vec<(At, SandboxId)> = self
            .sandboxes
            .iter()
            .filter(|(_, slot)| gives_up_copy(slot, now, grace))
            .map(|(id, slot)| (slot.last_activity, *id))
            .collect();
        candidates.sort_unstable();
        let mut changed = false;
        for (_, id) in candidates
            .into_iter()
            .take(self.policy.limits.get(Step::Evict) as usize)
        {
            if let Some(slot) = self.sandboxes.get_mut(&id) {
                slot.floor = Level::Remote;
                changed = true;
                self.mark(id);
            }
        }
        self.disk_fresh = !changed;
        changed
    }
}

/// Whether `slot` may give up its local copy to free disk now: it has no
/// VM process, may live in object storage, is idle, and nothing needs it.
fn gives_up_copy(slot: &Sandbox, now: At, grace: core::time::Duration) -> bool {
    matches!(slot.state.level, Level::Saved | Level::Archived)
        && slot.policy().rules().archive_after.is_some()
        && slot.in_flight.is_none()
        && !slot.backing_off(now)
        && slot.floor == Level::Running
        && super::admission::pushable(slot, now, grace)
}
