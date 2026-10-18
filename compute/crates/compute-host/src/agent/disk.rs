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

use std::path::Path;

use compute_core::{DiskSpace, Input};
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
    /// A create whose first files may not fit; its id is reserved
    /// meanwhile.
    Create(Id, Box<SandboxConfig>, OwnerEpoch, Reply<()>),
    /// The fetch of an image whose file is `length` bytes long.
    Fetch(ImageId, u64),
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
    /// what the disk grew by and what the fill wrote.
    pub(super) fn disk_readings(&self) -> Vec<Input> {
        // A save writes one copy of memory only where files share extents.
        let shares = self.save_copies == 1;
        let mut readings = Vec::new();
        for (id, slot) in &self.slots {
            let Some(live) = slot.vm.as_ref() else {
                continue;
            };
            match disk_growth::headroom(&slot.paths.disk, self.allocation_unit, shares) {
                Ok(bytes) => readings.push(Input::DiskGrowth {
                    sandbox: *id,
                    bytes,
                }),
                // It stays booked at what it last could grow by.
                Err(error) => tracing::debug!(
                    sandbox = %crate::protocol::Id(*id),
                    %error,
                    "could not read how much a disk may still grow"
                ),
            }
            readings.push(Input::Hydrating {
                sandbox: *id,
                hydrating: live.memory.hydrating(),
            });
        }
        readings
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

    /// What a new sandbox `id`'s first files from `template` may write, to
    /// be booked with [`Input::Writes`] before they are; `None` while only
    /// the next reading can tell whether they fit; a refusal if the disk
    /// cannot take them.
    pub(super) fn first_files_fit(
        &self,
        id: Id,
        image: Option<ImageId>,
        template: Option<&Path>,
    ) -> Result<Option<DiskSpace>, HostError> {
        let disk = self.first_files_disk(image, template);
        if let Some((resource, needed, free)) = self.core.disk_shortage(disk) {
            if self.core.disk_awaits_reading(disk) {
                return Ok(None);
            }
            return Err(HostError::HostFull {
                id,
                resource,
                needed,
                free,
            });
        }
        Ok(Some(disk))
    }

    /// Has `work` wait for the next disk reading.
    pub(super) fn after_reading(&mut self, work: AfterReading) {
        if let AfterReading::Create(id, ..) = &work {
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
                AfterReading::Fetch(image, length) => self.image_sized(image, Ok(Some(length))),
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
