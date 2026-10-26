//! What sandboxes, and the agent's own work, may still write to local
//! disk, for the decision core's disk book (see [`compute_core::Host::disk`]).
//!
//! Besides saves, which the core sizes by itself, three kinds of writes
//! can fill the disk: a guest writing to its disk while its VM runs, a wake
//! from object storage writing its local copy while its pager fills the
//! memory image, and copies the agent makes, such as a new sandbox's first
//! files and a ready sandbox's fill. A full disk blocks the very saves that
//! relieve memory, so each is booked before it can write and stays booked
//! until a disk reading shows what it wrote.
//!
//! Work short of disk by no more than what such bookings stood for since
//! the last reading may yet fit (see
//! [`compute_core::Host::disk_awaits_reading`]): it waits for the next
//! reading, about a second away, which decides it.
//!
//! A guest also frees space while its VM runs, since its disk takes
//! discards: the space comes back to the host's disk, but stays the
//! guest's to take again. So each disk is read both before and after the
//! disk reading, and books the larger of the two (see
//! [`HostAgent::disk_growth_readings`]).

use std::path::Path;

use compute_core::{DiskSpace, Input, SandboxId};
use compute_engine::Engine;

use crate::disk_growth;
use crate::layout::copy_size;
use crate::protocol::SandboxConfig;
use crate::store::{OwnerEpoch, Store};

use super::{HostAgent, HostError, Reply};
use crate::protocol::{Id, ImageId};

/// Inodes a new sandbox's or a ready sandbox's files take at most: its
/// directories, disk, kernel link, image files and record, with room to
/// spare.
const FIRST_FILES_INODES: u64 = 32;

/// Work that waits for the next disk reading to say whether the disk can
/// take it.
#[derive(Debug)]
pub(super) enum AfterReading {
    /// A create whose first files and first wake may not fit; its id is
    /// reserved meanwhile.
    Create(Id, Box<SandboxConfig>, OwnerEpoch, Reply<()>),
    /// An adopt whose first wake may not fit, with whether it is from the
    /// copy's files alone; its id is reserved meanwhile.
    Adopt(Id, Box<SandboxConfig>, OwnerEpoch, bool, Reply<()>),
    /// The fetch of an image whose file is `length` bytes long.
    Fetch(ImageId, u64),
}

/// What each disk of a sandbox with a VM may still grow by, read before
/// the disk reading of a sample, with whether its memory image was still
/// being filled; see [`HostAgent::disk_readings`].
#[derive(Debug, Default)]
pub(super) struct BeforeReading {
    growth: Vec<(SandboxId, Option<u64>)>,
    hydrating: Vec<Input>,
}

/// When a new sandbox fits; see [`HostAgent::room_for`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Room {
    /// Now: it may be taken and its first wake booked.
    Now,
    /// Only the next disk reading can tell: it waits for that.
    AfterReading,
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// The most a sandbox's disk, a copy of `image` or the base image, may
    /// take: its length in whole allocation units, and the blocks that map
    /// them (see [`disk_growth::disk_bound`]). The base image's length when
    /// the agent started, if the image's cannot be read now.
    pub(super) fn disk_bound(&self, image: Option<ImageId>) -> u64 {
        let length =
            std::fs::metadata(self.image_path(image)).map_or(self.base_length, |found| found.len());
        disk_growth::disk_bound(length, self.allocation_unit)
    }

    /// What the disk of each sandbox with a VM may still grow by, and
    /// whether its memory image is still being filled from object storage.
    /// Read before the disk reading of the same sample, which then shows
    /// what the disk grew by and what the fill wrote; the disks are read
    /// again after it by [`Self::disk_growth_readings`].
    pub(super) fn disk_readings(&self) -> BeforeReading {
        let mut before = BeforeReading::default();
        for (id, slot) in &self.slots {
            let Some(live) = slot.vm.as_ref() else {
                continue;
            };
            before
                .growth
                .push((*id, self.headroom(*id, &slot.paths.disk)));
            before.hydrating.push(Input::Hydrating {
                sandbox: *id,
                hydrating: live.memory.hydrating(),
            });
        }
        before
    }

    /// The readings of `before`, with what each of its disks may still
    /// grow by read again, after the disk reading of the same sample: the
    /// larger of the two counts. A guest writing between them took space
    /// the disk reading shows taken, which the first reading still counts
    /// as to come; one freeing space between them, as a trim does, gave
    /// back space the disk reading shows free, which only the second
    /// counts as the guest's to take again. Either way the disk is booked
    /// for at least what it may grow by as the disk reading saw it, short
    /// only of what its guest wrote again in the moment between that
    /// reading and the disk's second one. A disk neither reading could
    /// read books all it may take, its whole size, until one can.
    pub(super) fn disk_growth_readings(&self, before: BeforeReading) -> Vec<Input> {
        let mut readings = before.hydrating;
        for (id, first) in before.growth {
            let Some(slot) = self.slots.get(&id) else {
                continue;
            };
            let second = self.headroom(id, &slot.paths.disk);
            let bytes = match first.max(second) {
                Some(bytes) => bytes,
                None => match self.records.get(crate::protocol::Id(id)) {
                    Some(record) => self.record_size(&record).disk,
                    // Gone meanwhile: nothing of it is left to book.
                    None => continue,
                },
            };
            readings.push(Input::DiskGrowth { sandbox: id, bytes });
        }
        readings
    }

    /// What the disk file of sandbox `id` at `path` may still grow by, if
    /// it can be read; see [`disk_growth::headroom`].
    fn headroom(&self, id: SandboxId, path: &Path) -> Option<u64> {
        // A save writes one copy of memory only where files share extents.
        let shares = self.save_copies == 1;
        disk_growth::headroom(path, self.allocation_unit, shares)
            .inspect_err(|error| {
                tracing::debug!(
                    sandbox = %crate::protocol::Id(id),
                    %error,
                    "could not read how much a disk may still grow"
                );
            })
            .ok()
    }

    /// What a new sandbox's first files may write: a copy of its
    /// template's disk where it has one, otherwise of its image (`image`
    /// or the base image), whichever is larger since a stale template
    /// falls back to the image, as [`copy_size`] counts them; the
    /// template's memory and state are shared by hard link. A source that
    /// cannot be read counts at the most a disk may take.
    pub(super) fn first_files_disk(
        &self,
        image: Option<ImageId>,
        template: Option<&Path>,
    ) -> DiskSpace {
        let unit = self.allocation_unit;
        let copy =
            |source: &Path| copy_size(source, unit).unwrap_or_else(|_| self.disk_bound(image));
        let bytes = template.map_or(0, copy).max(copy(&self.image_path(image)));
        DiskSpace {
            bytes,
            inodes: FIRST_FILES_INODES,
        }
    }

    /// Has `work` wait for the next disk reading.
    pub(super) fn after_reading(&mut self, work: AfterReading) {
        if let AfterReading::Create(id, ..) | AfterReading::Adopt(id, ..) = &work {
            self.preparing.insert(id.0);
        }
        self.after_reading.push(work);
    }

    /// Takes up again, after a disk reading, the work that waited for one.
    pub(super) fn resume_after_reading(&mut self) {
        for work in std::mem::take(&mut self.after_reading) {
            match work {
                AfterReading::Create(id, config, owner, reply) => {
                    self.preparing.remove(&id.0);
                    self.create_fresh(id, *config, owner, reply);
                }
                AfterReading::Adopt(id, config, owner, from_files, reply) => {
                    self.preparing.remove(&id.0);
                    self.adopt(id, *config, owner, from_files, reply);
                }
                AfterReading::Fetch(image, length) => self.image_sized(image, Ok(Some(length))),
            }
        }
    }

    /// Refuses with `error` the work that waits for a disk reading, none of
    /// which has started: its creates and adopts, and those waiting for
    /// its fetches. It frees their ids.
    pub(super) fn refuse_after_reading(&mut self, error: &HostError) {
        for work in std::mem::take(&mut self.after_reading) {
            match work {
                AfterReading::Create(id, _, _, reply) | AfterReading::Adopt(id, _, _, _, reply) => {
                    self.preparing.remove(&id.0);
                    let _ = reply.send(Err(error.clone()));
                }
                AfterReading::Fetch(image, _) => self.fetch_ended(image, &Err(error.clone())),
            }
        }
    }

    /// What a ready sandbox's fill may write until it is ready: its copy of
    /// the template's disk and what its guest writes to it until then,
    /// together never more than the most a disk may take.
    pub(super) fn fill_disk(&self, image: Option<ImageId>) -> DiskSpace {
        DiskSpace {
            bytes: self.disk_bound(image),
            inodes: FIRST_FILES_INODES,
        }
    }
}
