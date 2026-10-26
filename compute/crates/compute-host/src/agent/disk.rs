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
//! guest's to take again. A guest may free and write at any moment, and
//! the disk reading and the disks cannot be read at one instant, so each
//! running disk is read after the disk reading and also books what its
//! VMM wrote from just before that reading until every write it had
//! started by the disk's read has returned (see
//! [`HostAgent::disk_growth_readings`]).
//!
//! A sandbox may ask for a longer disk than its image's
//! ([`SandboxConfig::disk_mib`]): its copy is made that long at once, the
//! new end a hole its guest's file system grows into, and it is booked at
//! that length like any disk.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use compute_core::{DiskSpace, Input, SandboxId};
use compute_engine::{Engine, VmSpec, Writes};
use tokio::task::JoinSet;

use crate::disk_growth::{self, Headroom};
use crate::layout::{Paths, copy_size, vm_spec};
use crate::protocol::SandboxConfig;
use crate::state::Record;
use crate::store::{OwnerEpoch, Store};

use super::{HostAgent, HostError, Reply};
use crate::protocol::{Id, ImageId};

/// Inodes a new sandbox's or a ready sandbox's files take at most: its
/// directories, disk, kernel link, image files and record, with room to
/// spare.
const FIRST_FILES_INODES: u64 = 32;

/// The most one write call may take of the host's disk beyond the bytes it
/// writes. A file system widens a write to whole blocks at each end, XFS
/// a write over shared blocks to whole copy-on-write extents (128 KiB by
/// default), and each sets blocks aside for the extent map; 1 MiB covers
/// them with room to spare.
const WRITE_SLACK: u64 = 1 << 20;

/// How long a sample waits for running VMs' writes to return (see
/// [`Engine::settle_writes`]). A VM whose writes have not by then books
/// all its disk may take, for that reading.
const SETTLE_WITHIN: Duration = Duration::from_millis(100);

/// Makes the disk at `path` at least `length` bytes long and returns how
/// long it is. Its new end is a hole, which takes no disk until the guest
/// writes there; the length lasts a crash, as the record that vouches for
/// it, written next, must.
pub(super) fn lengthen(path: &Path, length: u64) -> io::Result<u64> {
    let disk = std::fs::OpenOptions::new().write(true).open(path)?;
    let found = disk.metadata()?.len();
    if found >= length {
        return Ok(found);
    }
    disk.set_len(length)?;
    disk.sync_all()?;
    Ok(length)
}

/// The disk of a ready sandbox a create claims, which the claim makes as
/// long as the create asks for (see [`ClaimedDisk::lengthen`]).
#[derive(Debug)]
pub(super) struct ClaimedDisk {
    /// Its VM's spec, which names its drives.
    spec: VmSpec,
    disk: PathBuf,
    /// How long its guest was told the disk is, at its fill.
    known: Option<u64>,
}

impl ClaimedDisk {
    /// Makes the disk as long as `config` asks for, and tells the paused
    /// guest of `vm` if that is longer than it knows: the guest learns it
    /// as it next runs, and grows its file system to fit. Returns its
    /// length, or why it could not be done.
    pub(super) async fn lengthen<E: Engine>(
        self,
        engine: &E,
        vm: &E::Vm,
        config: &SandboxConfig,
    ) -> Result<u64, String> {
        let (disk, wanted) = (self.disk, config.clone());
        let length = tokio::task::spawn_blocking(move || {
            let found = std::fs::metadata(&disk)?.len();
            lengthen(&disk, wanted.disk_bytes(found))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("could not lengthen its disk: {error}"))?;
        if self.known != Some(length) {
            engine
                .resize_drives(vm, &self.spec)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(length)
    }
}

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

/// What each sandbox with a VM had written, read just before the disk
/// reading of a sample, with whether its memory image was still being
/// filled; see [`HostAgent::disk_readings`].
#[derive(Debug, Default)]
pub(super) struct BeforeReading {
    writes: Vec<(SandboxId, Option<Writes>)>,
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
    /// The disk of ready sandbox `record`, for a claim of it.
    pub(super) fn claimed_disk(&self, record: &Record) -> ClaimedDisk {
        let paths = Paths::of(&self.root, record);
        ClaimedDisk {
            spec: vm_spec(record, &paths, &self.images),
            disk: paths.disk,
            known: record.allocation.disk_bytes,
        }
    }

    /// How long `image`'s disk is, or the base image's: the base image's
    /// length when the agent started if it cannot be read now.
    fn image_length(&self, image: Option<ImageId>) -> u64 {
        std::fs::metadata(self.image_path(image)).map_or(self.base_length, |found| found.len())
    }

    /// The most a sandbox's disk, a copy of `image` or the base image, may
    /// take: its length in whole allocation units, and the blocks that map
    /// them (see [`disk_growth::disk_bound`]). The base image's length when
    /// the agent started, if the image's cannot be read now.
    pub(super) fn disk_bound(&self, image: Option<ImageId>) -> u64 {
        disk_growth::disk_bound(self.image_length(image), self.allocation_unit)
    }

    /// The most a new sandbox of `config` may take of its disk: its
    /// image's grown to the length `config` asks for, if longer (see
    /// [`SandboxConfig::disk_bytes`]), as [`Self::disk_bound`] counts it.
    pub(super) fn new_disk_bound(&self, config: &SandboxConfig) -> u64 {
        let length = config.disk_bytes(self.image_length(config.image));
        disk_growth::disk_bound(length, self.allocation_unit)
    }

    /// What each sandbox with a VM has written, and whether its memory
    /// image is still being filled from object storage. Read just before
    /// the disk reading of the same sample, which then shows what the fill
    /// wrote; the disks themselves are read after it, by
    /// [`Self::disk_growth_readings`].
    pub(super) fn disk_readings(&self) -> BeforeReading {
        let mut before = BeforeReading::default();
        for (id, slot) in &self.slots {
            let Some(live) = slot.vm.as_ref() else {
                continue;
            };
            before.writes.push((*id, self.vm_writes(*id, &live.vm)));
            before.hydrating.push(Input::Hydrating {
                sandbox: *id,
                hydrating: live.memory.hydrating(),
            });
        }
        before
    }

    /// The readings of `before`, with what each of its disks may still
    /// grow by as the disk reading of the same sample saw it.
    ///
    /// Each disk is read after the disk reading, which shows free any
    /// space its guest freed until then (as a trim does), so what the disk
    /// read counts that space as the guest's to take again. What the
    /// guest wrote after the disk reading, the disk's read counts as taken
    /// although the disk reading shows it free: every byte of it came
    /// through a write call of its VMM that had not returned before the
    /// writes of `before` were read, and had started by the disk's read.
    /// So once every write the VMM started by then has returned, which
    /// [`Engine::settle_writes`] waits for, a second count of the VMM's
    /// writes counts all of them, and the disk books what they wrote, with
    /// [`WRITE_SLACK`] per call, besides what it may grow by: never less
    /// than it may grow by as the disk reading saw it.
    ///
    /// A disk that cannot be read, or whose VM's writes cannot be counted
    /// or do not return within [`SETTLE_WITHIN`], books all it may take,
    /// its whole bound, for this reading.
    pub(super) async fn disk_growth_readings(&self, before: BeforeReading) -> Vec<Input> {
        let mut readings = before.hydrating;
        let mut read = Vec::new();
        let mut settling = JoinSet::new();
        for (id, first) in before.writes {
            let Some(slot) = self.slots.get(&id) else {
                continue;
            };
            let whole = self
                .records
                .get(crate::protocol::Id(id))
                .map(|record| self.record_size(&record).disk);
            let headroom = self.headroom(id, &slot.paths.disk);
            if let (Some(first), Some(headroom), Some(live)) = (first, headroom, slot.vm.as_ref()) {
                // Sent once polled, so after the disk's read.
                let settled = self.engine.settle_writes(&live.vm);
                let index = read.len();
                settling.spawn(async move { (index, settled.await) });
                read.push((id, whole, Some((first, headroom))));
            } else {
                read.push((id, whole, None));
            }
        }
        let mut wrote: Vec<Option<Writes>> = vec![None; read.len()];
        let deadline = tokio::time::Instant::now() + SETTLE_WITHIN;
        while let Ok(Some(joined)) = tokio::time::timeout_at(deadline, settling.join_next()).await {
            let Ok((index, settled)) = joined else {
                continue;
            };
            let (id, ..) = read[index];
            match settled {
                Ok(()) => {
                    wrote[index] = self
                        .slots
                        .get(&id)
                        .and_then(|slot| slot.vm.as_ref())
                        .and_then(|live| self.vm_writes(id, &live.vm));
                }
                Err(error) => tracing::debug!(
                    sandbox = %crate::protocol::Id(id),
                    %error,
                    "could not wait for a VM's writes to return"
                ),
            }
        }
        // Those still waiting book their whole bound; their requests end.
        settling.abort_all();
        for ((id, whole, first), wrote) in read.into_iter().zip(wrote) {
            let bytes = match (first, wrote) {
                (Some((first, headroom)), Some(wrote)) => {
                    let since = wrote.since(first);
                    // No disk takes more than its whole bound.
                    let most = whole.unwrap_or(0).max(headroom.bound);
                    headroom
                        .left
                        .saturating_add(since.bytes)
                        .saturating_add(since.calls.saturating_mul(WRITE_SLACK))
                        .min(most)
                }
                _ => match whole {
                    Some(whole) => whole,
                    // Gone meanwhile: nothing of it is left to book.
                    None => continue,
                },
            };
            readings.push(Input::DiskGrowth { sandbox: id, bytes });
        }
        readings
    }

    /// What the VM of sandbox `id` has written, if it can be read; see
    /// [`Engine::writes`].
    fn vm_writes(&self, id: SandboxId, vm: &E::Vm) -> Option<Writes> {
        self.engine
            .writes(vm)
            .inspect_err(|error| {
                tracing::debug!(
                    sandbox = %crate::protocol::Id(id),
                    %error,
                    "could not read what a VM has written"
                );
            })
            .ok()
    }

    /// What the disk file of sandbox `id` at `path` may still grow by, if
    /// it can be read; see [`disk_growth::headroom`].
    fn headroom(&self, id: SandboxId, path: &Path) -> Option<Headroom> {
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
