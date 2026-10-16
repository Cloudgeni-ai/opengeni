//! Spare VMs: ones the host runs outside sandbox management that nobody
//! uses yet, such as ready sandboxes and template builds. They share the
//! one memory book with sandboxes: they count against the admission
//! budget like any VM, a new one takes only room no wake wants (see
//! [`Host::spare_fits`]), and ready ones are the first memory given back,
//! ahead of any sandbox, since ending one loses nothing but a refill. What
//! one may still write to local disk, such as a template build's snapshot,
//! is booked with the saves of sandboxes (see [`Host::disk`]).

use std::collections::HashMap;

use super::admission::needs_memory;
use super::disk::DiskSpace;
use super::{Action, Host};
use crate::ids::SandboxId;
use crate::level::Step;

/// One spare VM; see [`crate::Input::Spare`].
#[derive(Clone, Copy, Debug)]
pub(super) struct Spare {
    /// Host memory it holds, or will once filled.
    bytes: u64,
    /// Local disk it may still write.
    disk: DiskSpace,
    /// Still coming up: what it takes is not in any reading yet.
    filling: bool,
    /// Asked to end for memory.
    ending: bool,
    /// Whether [`Action::Discard`] went out for it.
    sent: bool,
    /// When it was first reported, for ending the oldest first.
    order: u64,
}

/// The host's spare VMs.
#[derive(Debug, Default)]
pub(super) struct Spares {
    vms: HashMap<SandboxId, Spare>,
    next: u64,
}

impl Spares {
    /// Bytes they hold, all counted against the admission budget.
    pub(super) fn held(&self) -> u64 {
        self.vms.values().map(|spare| spare.bytes).sum()
    }

    /// Bytes of those coming up, which no reading shows yet.
    pub(super) fn filling(&self) -> u64 {
        self.sum(|spare| spare.filling)
    }

    /// Bytes of those asked to end, freed once they have.
    pub(super) fn ending(&self) -> u64 {
        self.sum(|spare| spare.ending)
    }

    /// Bytes of those that could be asked to end now.
    pub(super) fn endable(&self) -> u64 {
        self.sum(endable)
    }

    /// Local disk they may still write.
    pub(super) fn disk(&self) -> DiskSpace {
        self.vms
            .values()
            .fold(DiskSpace::default(), |sum, spare| sum.add(spare.disk))
    }

    fn sum(&self, which: impl Fn(&Spare) -> bool) -> u64 {
        self.vms
            .values()
            .filter(|spare| which(spare))
            .map(|spare| spare.bytes)
            .sum()
    }
}

/// Whether `spare` can be asked to end: ready, and not asked already. One
/// still filling is left to finish.
fn endable(spare: &Spare) -> bool {
    !spare.filling && !spare.ending
}

impl Host {
    /// Takes in [`crate::Input::Unmanaged`].
    pub(super) fn unmanaged(&mut self, sandbox: SandboxId, bytes: u64) {
        if bytes == 0 {
            self.unmanaged.remove(&sandbox);
            self.removed_claims.remove(&sandbox);
        } else {
            // A spare VM that could not be ended moves to this book: it
            // freed nothing, so it is no relief. One still filling may go
            // on taking memory, so its claim lasts until it is gone; what
            // it wrote stays booked until the next disk reading.
            if let Some(spare) = self.spares.vms.remove(&sandbox) {
                if spare.filling {
                    *self.removed_claims.entry(sandbox).or_default() += spare.bytes;
                }
                self.disk_spent = self.disk_spent.add(spare.disk);
            }
            self.unmanaged.insert(sandbox, bytes);
        }
    }

    /// Takes in [`crate::Input::Spare`].
    pub(super) fn spare(&mut self, sandbox: SandboxId, bytes: u64, disk: DiskSpace, filling: bool) {
        if bytes == 0 {
            let Some(spare) = self.spares.vms.remove(&sandbox) else {
                return;
            };
            // What it held, claimed while filling, or wrote, shows only in
            // the next reading.
            if spare.ending {
                self.settled_relief = self.settled_relief.saturating_add(spare.bytes);
            }
            if spare.filling {
                self.unread_claims = self.unread_claims.saturating_add(spare.bytes);
            }
            self.disk_spent = self.disk_spent.add(spare.disk);
            return;
        }
        let order = self.spares.next;
        let spare = self.spares.vms.entry(sandbox).or_insert_with(|| Spare {
            bytes,
            disk,
            filling,
            ending: false,
            sent: false,
            order,
        });
        if spare.order == order {
            self.spares.next += 1;
        }
        if spare.filling && !filling {
            self.unread_claims = self.unread_claims.saturating_add(spare.bytes);
        }
        spare.bytes = bytes;
        spare.disk = disk;
        spare.filling = filling;
    }

    /// Bytes of memory a new spare VM may take now: room above the
    /// admission buffer and above the high watermark, counting what is
    /// claimed and filling already; 0 while a wake waits for memory,
    /// queued or refused and held, and with a memory policy but no reading
    /// yet. `None` when nothing limits it: no admission and no memory
    /// policy. Report the VM with [`crate::Input::Spare`] at once to book
    /// what it takes.
    #[must_use]
    pub fn spare_room(&self) -> Option<u64> {
        let budget = self
            .policy
            .admission
            .zip(self.capacity())
            .map(|(admission, capacity)| {
                u64::try_from(capacity.headroom() - i128::from(admission.buffer)).unwrap_or(0)
            });
        let watermark = self
            .policy
            .memory
            .is_some()
            .then(|| self.free_above_watermark());
        let room = match (budget, watermark) {
            (Some(budget), Some(watermark)) => Some(budget.min(watermark)),
            (room, None) | (None, room) => room,
        }?;
        let waiting = !self.refused.is_empty()
            || Step::ALL
                .into_iter()
                .filter(|step| needs_memory(*step))
                .any(|step| !self.queues[step.index()].is_empty());
        Some(if waiting { 0 } else { room })
    }

    /// Whether a new spare VM that takes `bytes` of memory and may write
    /// `disk` to local disk fits now: within [`Self::spare_room`], and
    /// within what the disk can still book, nothing before its first
    /// reading.
    #[must_use]
    pub fn spare_fits(&self, bytes: u64, disk: DiskSpace) -> bool {
        self.spare_room().is_none_or(|room| room >= bytes)
            && self
                .disk_room()
                .is_none_or(|mut room| room.take(disk).is_ok())
    }

    /// Asks ready spare VMs to end, oldest first, until they free `needed`
    /// bytes. Returns what is still needed after them.
    pub(super) fn end_spares(&mut self, mut needed: u64) -> u64 {
        let mut ready: Vec<(u64, SandboxId)> = self
            .spares
            .vms
            .iter()
            .filter(|(_, spare)| endable(spare))
            .map(|(id, spare)| (spare.order, *id))
            .collect();
        ready.sort_unstable();
        for (_, id) in ready {
            if needed == 0 {
                break;
            }
            if let Some(spare) = self.spares.vms.get_mut(&id) {
                spare.ending = true;
                needed = needed.saturating_sub(spare.bytes);
            }
        }
        needed
    }

    /// Tells the host agent to end the spare VMs asked to end since.
    pub(super) fn discard_spares(&mut self, out: &mut Vec<Action>) {
        let mut ending: Vec<(u64, SandboxId)> = Vec::new();
        for (id, spare) in &mut self.spares.vms {
            if spare.ending && !spare.sent {
                spare.sent = true;
                ending.push((spare.order, *id));
            }
        }
        ending.sort_unstable();
        out.extend(
            ending
                .into_iter()
                .map(|(_, sandbox)| Action::Discard { sandbox }),
        );
    }
}
