//! Whether the host's local disk can take everything its sandboxes may
//! still write: the next save of every VM whose state is not saved yet,
//! what the disks of awake VMs may grow by, and what wakes from object
//! storage still write locally; and the relief that makes room for it;
//! see [`crate::DiskPolicy`].
//!
//! Disk relief frees what the host can lose without losing anything: the
//! local copies of idle sandboxes whose state object storage holds, and
//! what the host keeps only to go faster, such as templates and cached
//! images ([`crate::Input::Cache`]). What it frees, as the host agent
//! measures it, counts as room for a create, an adopt or a wake, as instant
//! memory relief does (ADR 30): one that fits only with it books its room,
//! relief frees what it needs, least recently used first across every
//! kind, and the readings after decide it.

use core::fmt;

use super::{Action, Input, Size};
use super::{CreateRoom, Host};
use crate::ids::{CacheId, SandboxId};
use crate::level::{Durability, Level, Step};
use crate::policy::SleepPolicy;
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
    /// Processor time, in millicores; see [`crate::HostPolicy::cpu_budget`].
    Cpu,
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Memory => "memory",
            Self::Disk => "disk",
            Self::Inodes => "disk inodes",
            Self::Cpu => "processor time",
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

    /// Both together.
    #[must_use]
    pub const fn add(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_add(other.bytes),
            inodes: self.inodes.saturating_add(other.inodes),
        }
    }

    /// Whether it is no space at all.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.bytes == 0 && self.inodes == 0
    }

    pub(super) fn saturating_sub(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(other.bytes),
            inodes: self.inodes.saturating_sub(other.inodes),
        }
    }

    /// The larger of each part.
    pub(super) fn max(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.max(other.bytes),
            inodes: self.inodes.max(other.inodes),
        }
    }

    pub(super) fn bytes(bytes: u64) -> Self {
        Self { bytes, inodes: 0 }
    }
}

/// How much of the host's local disk saves have booked; see
/// [`Host::disk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiskCapacity {
    /// What the disk had available at the last reading.
    pub available: DiskSpace,
    /// What sandboxes may still write at most: the next saves of VMs not
    /// saved yet, the growth of awake VMs' disks and the local copies
    /// wakes from object storage still write, and what spare VMs may
    /// still write; with what any of them wrote since the last reading.
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

    /// Books `need` whether it fits or not, for a wake that waits for the
    /// next reading: later ones in the same decision are charged it.
    pub(super) fn charge(&mut self, need: DiskSpace) {
        self.bytes -= i128::from(need.bytes);
        self.inodes -= i128::from(need.inodes);
    }

    /// Whether `need`, which does not fit, would fit if `unread`, what
    /// bookings that ended since the last reading stood for, had written
    /// nothing.
    pub(super) fn may_take(&self, need: DiskSpace, unread: DiskSpace) -> bool {
        i128::from(need.bytes) <= self.bytes + i128::from(unread.bytes)
            && i128::from(need.inodes) <= self.inodes + i128::from(unread.inodes)
    }

    /// Books `need` if it fits now, or charges it (see [`Self::charge`])
    /// if it would fit once `relief` is in: what readings may show free
    /// and disk relief frees. Returns whether it did either.
    pub(super) fn book(&mut self, need: DiskSpace, relief: DiskSpace) -> bool {
        if self.take(need).is_ok() {
            return true;
        }
        let fits = self.may_take(need, relief);
        if fits {
            self.charge(need);
        }
        fits
    }

    /// What is missing for `need` to fit.
    fn shortfall(&self, need: DiskSpace) -> DiskSpace {
        let missing = |need: u64, room: i128| u64::try_from(i128::from(need) - room).unwrap_or(0);
        DiskSpace {
            bytes: missing(need.bytes, self.bytes),
            inodes: missing(need.inodes, self.inodes),
        }
    }
}

/// Something the host keeps on local disk only to go faster; see
/// [`crate::Input::Cache`].
#[derive(Clone, Copy, Debug)]
pub(super) struct Cache {
    /// What removing it frees at least.
    disk: DiskSpace,
    /// When it was last used.
    last_used: At,
    /// Asked to be removed for disk relief.
    removing: bool,
    /// Whether [`Action::RemoveCache`] went out for it.
    sent: bool,
}

impl Sandbox {
    /// Whether its VM holds state no copy has yet, or it is waking into
    /// one.
    pub(super) fn unsaved(&self) -> bool {
        self.reserves()
            || (self.state.level.has_process() && self.state.durability == Durability::Volatile)
    }

    /// Whether it books disk for its next save: it is [`Self::unsaved`],
    /// and the host may save it without being asked (see
    /// [`crate::SleepPolicy::saves`]), a save of it is asked for or one
    /// runs. One the host never saves so books its save from the request
    /// on, which the host refuses unless it fits ([`Host::save_room`]), so
    /// its VM is never paused for a save the disk cannot take.
    pub(super) fn books_save(&self) -> bool {
        let asked = self.requested.max(self.floor) >= Level::Saved;
        let saving = self
            .in_flight
            .is_some_and(|flight| flight.step == Step::Save);
        self.unsaved() && (self.policy().saves() || asked || saving)
    }

    /// What its next save may need at most.
    pub(super) fn save_space(&self) -> DiskSpace {
        DiskSpace::save(self.size.save)
    }

    /// What it books on local disk now: its next save while its VM holds
    /// state no copy has; what its disk may grow by while it is awake or
    /// waking, since only a running VM writes to it; and what a wake from
    /// object storage still writes locally, from its admission, across
    /// any retry, until its copy is whole.
    ///
    /// While a checkpoint runs, a clone of its disk shares every block the
    /// disk held alone, so any guest write may take a new one. While a
    /// pause runs, its guest first trims its disk and may take what that
    /// frees again before it pauses, and its disk is not read meanwhile.
    /// Either way its disk may grow by its whole bound until the step ends
    /// and a reading shows what it took.
    pub(super) fn disk_booking(&self) -> DiskSpace {
        let whole_disk = self
            .in_flight
            .is_some_and(|flight| matches!(flight.step, Step::Checkpoint | Step::Pause));
        self.booking(whole_disk)
    }

    /// What a checkpoint or a pause of it books besides what it already
    /// does: the rest of its disk's bound, which its disk may grow by while
    /// the step runs; see [`Self::disk_booking`].
    pub(super) fn checkpoint_need(&self) -> DiskSpace {
        self.booking(true).saturating_sub(self.booking(false))
    }

    /// [`Self::disk_booking`], with a step that books the whole disk
    /// running or not.
    fn booking(&self, whole_disk: bool) -> DiskSpace {
        let mut booked = DiskSpace::default();
        if self.books_save() {
            booked = booked.add(self.save_space());
        }
        if self.reserves() {
            let growth = if whole_disk {
                self.local_disk.growth.max(self.size.disk)
            } else {
                self.local_disk.growth
            };
            booked = booked.add(DiskSpace::bytes(growth));
        }
        if self.local_disk.hydrating || (self.reserves() && self.state.level == Level::Remote) {
            booked = booked.add(DiskSpace::save(self.size.fetch));
        }
        booked
    }

    /// What a wake of it books besides what it already does: its next
    /// save if the host may save it unasked, its disk's growth, and from
    /// object storage its local copy.
    pub(super) fn disk_need(&self) -> DiskSpace {
        let mut awake = DiskSpace::bytes(self.local_disk.growth);
        if self.policy().saves() {
            awake = awake.add(self.save_space());
        }
        if self.local_disk.hydrating || self.state.level == Level::Remote {
            awake = awake.add(DiskSpace::save(self.size.fetch));
        }
        awake.saturating_sub(self.disk_booking())
    }
}

impl Host {
    /// How much of the host's local disk is booked, or `None` without a
    /// disk policy or a reading: what sandboxes may still write (see
    /// [`DiskCapacity::booked`]), and what spare VMs may, such as a
    /// template build its snapshot. What any booking that ended since that
    /// reading stood for stays booked until the next one, which shows what
    /// was written. Work waiting for disk relief books what it waits for
    /// (see [`crate::Input::Wants`]).
    #[must_use]
    pub fn disk(&self) -> Option<DiskCapacity> {
        let policy = self.policy.disk?;
        let available = self.disk?;
        let booked = self
            .sandboxes
            .values()
            .fold(self.disk_spent.add(self.spares.disk()), |sum, slot| {
                sum.add(slot.disk_booking())
            });
        let booked = self
            .writes
            .values()
            .chain(self.removed_disk.values())
            .chain(self.wants.values())
            .fold(booked, |sum, disk| sum.add(*disk));
        let booked = self
            .creating
            .values()
            .fold(booked, |sum, first| sum.add(first.disk()));
        Some(DiskCapacity {
            available,
            booked,
            reserve: DiskSpace {
                bytes: policy.reserve,
                inodes: policy.reserve_inodes,
            },
        })
    }

    /// Brings `id`'s disk booking up to date. What it no longer books
    /// stays counted until the next reading, which shows what was written
    /// meanwhile. A wake from object storage whose sandbox has nothing
    /// local left, nor a step that could write it, writes no more.
    pub(super) fn rebook_disk(&mut self, id: SandboxId) {
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if slot.local_disk.hydrating
            && slot.state.level == Level::Remote
            && slot.in_flight.is_none()
        {
            slot.local_disk.hydrating = false;
        }
        let booked = slot.disk_booking();
        self.disk_spent = self
            .disk_spent
            .add(slot.local_disk.booked.saturating_sub(booked));
        slot.local_disk.booked = booked;
    }

    /// Takes in [`crate::Input::DiskGrowth`]: what `id`'s disk may still
    /// grow by. A smaller number than before stands for what the disk
    /// grew by, which only a reading taken after it shows: it stays
    /// booked until then, and a reading later in the same batch ends that
    /// at once.
    pub(super) fn disk_growth(&mut self, id: SandboxId, bytes: u64) {
        if let Some(slot) = self.sandboxes.get_mut(&id) {
            slot.local_disk.growth = bytes;
            self.mark(id);
        }
        self.rebook_disk(id);
    }

    /// Takes in [`crate::Input::Hydrating`]. What a finished wake no
    /// longer books is rebooked at once, as for [`Self::disk_growth`], so
    /// a reading later in the same batch, which shows what it wrote, ends
    /// it.
    pub(super) fn hydrating(&mut self, id: SandboxId, hydrating: bool) {
        if let Some(slot) = self.sandboxes.get_mut(&id) {
            slot.local_disk.hydrating = hydrating;
            self.mark(id);
        }
        self.rebook_disk(id);
    }

    /// Takes in [`crate::Input::Disk`]: it shows everything written so
    /// far, so nothing that ended before it stays booked.
    pub(super) fn disk_read(&mut self, available: DiskSpace) {
        self.disk = Some(available);
        self.disk_fresh = true;
        self.disk_spent = DiskSpace::default();
        self.disk_freed = DiskSpace::default();
    }

    /// Takes in [`crate::Input::Writes`].
    pub(super) fn writes(&mut self, key: SandboxId, disk: DiskSpace) {
        let before = if disk == DiskSpace::default() {
            self.writes.remove(&key)
        } else {
            self.writes.insert(key, disk)
        };
        self.disk_spent = self
            .disk_spent
            .add(before.unwrap_or_default().saturating_sub(disk));
    }

    /// Keeps `disk`, what the removed sandbox or spare VM `id` booked,
    /// booked until the host agent reports it ended (see
    /// [`Self::removal_ended`]): until then its VM, or a step still running
    /// for it, may write, and no reading can show what they will.
    pub(super) fn book_removed(&mut self, id: SandboxId, disk: DiskSpace) {
        if disk != DiskSpace::default() {
            let booked = self.removed_disk.entry(id).or_default();
            *booked = booked.add(disk);
        }
    }

    /// The removed `id` has ended: nothing of it writes any more, and what
    /// it booked stays counted only until the next reading, which shows
    /// what it wrote.
    pub(super) fn removal_ended(&mut self, id: SandboxId) {
        if let Some(disk) = self.removed_disk.remove(&id) {
            self.disk_spent = self.disk_spent.add(disk);
        }
    }

    /// What is short, if anything, for work that may write `disk` to
    /// local disk: the resource, what it needs and what is free. Nothing
    /// fits before the first reading; everything does without a disk
    /// policy.
    #[must_use]
    pub fn disk_shortage(&self, disk: DiskSpace) -> Option<(Resource, u64, u64)> {
        let mut room = self.disk_room()?;
        room.take(disk)
            .err()
            .map(|short| (short.resource, short.needed, short.free))
    }

    /// Whether work that may write `disk`, which does not fit now (see
    /// [`Self::disk_shortage`]), may fit once the next reading is in: what
    /// a booking that ended since the last reading stood for stays booked
    /// until a reading shows what was written, and `disk` is short by no
    /// more than that. Such work waits for the next reading, which
    /// decides it, rather than being refused for room that is perhaps
    /// there; work short by more is short whatever that reading shows.
    #[must_use]
    pub fn disk_awaits_reading(&self, disk: DiskSpace) -> bool {
        self.disk_room()
            .is_some_and(|room| room.may_take(disk, self.disk_spent))
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

    /// Whether a save asked of `sandbox`, an [`crate::Input::Sleep`] to
    /// [`Level::Saved`] or deeper, can be booked on local disk now. One the
    /// host never saves unasked books its next save only from such a
    /// request on ([`Sandbox::books_save`]), so the host agent refuses a
    /// request this finds short at once rather than pause its VM for a
    /// save that would wait for room, as a hand-off would. Fits for a
    /// sandbox that books its save already or has nothing to save, and on
    /// a host that books no disk. Short by no more than what bookings that
    /// ended since the last reading stood for, it awaits the next reading
    /// (see [`Self::disk_awaits_reading`]), which decides it, as a create
    /// does; before the first reading, it awaits that one.
    #[must_use]
    pub fn save_room(&self, sandbox: SandboxId) -> CreateRoom {
        let Some(slot) = self.sandboxes.get(&sandbox) else {
            return CreateRoom::Fits;
        };
        if !slot.unsaved() || slot.books_save() || slot.cannot_save() {
            return CreateRoom::Fits;
        }
        let Some(mut room) = self.disk_room() else {
            return CreateRoom::Fits;
        };
        let save = slot.save_space();
        if self.disk.is_none() {
            return CreateRoom::AwaitsReading(Resource::Disk, save.bytes, 0);
        }
        match room.take(save) {
            Ok(()) => CreateRoom::Fits,
            Err(short) if room.may_take(save, self.disk_spent) => {
                CreateRoom::AwaitsReading(short.resource, short.needed, short.free)
            }
            Err(short) => CreateRoom::Short(short.resource, short.needed, short.free),
        }
    }

    /// What the first wake of a new sandbox of `size` that sleeps by
    /// `policy`, from object storage with `remote`, books on local disk, as
    /// [`Self::create_room`] counts it: for the host agent to book with
    /// [`crate::Input::Wants`] while a create waits for disk relief.
    #[must_use]
    pub fn first_wake_disk(size: Size, policy: SleepPolicy, remote: bool) -> DiskSpace {
        super::admission::FirstWake::new(size, policy, remote, At::ZERO).disk()
    }

    /// Whether work named `key` that may write `disk` to local disk, such
    /// as the fetch of an image a create needs, fits next to every wake
    /// already queued, as [`Self::create_room`] decides for a create: what
    /// `key` waits for already ([`crate::Input::Wants`]) counts as free for
    /// it. Fits on a host that books no disk.
    #[must_use]
    pub fn disk_room_for(&self, now: At, key: SandboxId, disk: DiskSpace) -> CreateRoom {
        let Some((mut room, relief)) = self.queued_disk_room(now) else {
            return CreateRoom::Fits;
        };
        if let Some(wanted) = self.wants.get(&key) {
            room.give_back(*wanted);
        }
        match room.take(disk) {
            Ok(()) => CreateRoom::Fits,
            Err(short) if room.may_take(disk, relief) => {
                CreateRoom::AwaitsReading(short.resource, short.needed, short.free)
            }
            Err(short) => CreateRoom::Short(short.resource, short.needed, short.free),
        }
    }

    /// What wakes may still book in one decision once every wake already
    /// queued for memory has booked its disk, each that fits now or once
    /// relief is in, with that relief: what bookings that ended since the
    /// last reading stood for, and what disk relief frees ([`Self::disk_relief`]).
    /// A queued wake short even so is refused, so it takes nothing.
    /// `None` without a disk policy.
    pub(super) fn queued_disk_room(&self, now: At) -> Option<(DiskRoom, DiskSpace)> {
        let mut room = self.disk_room()?;
        let relief = self.disk_spent.add(self.disk_relief(now));
        for slot in self.queued_wakes() {
            room.book(slot.disk_need(), relief);
        }
        Some((room, relief))
    }

    /// Bytes beyond [`DiskCapacity::free`] that a new sandbox could book
    /// now by disk relief, as [`Self::create_room`] counts it: what relief
    /// under way frees and what more it could, less what an overdrawn disk
    /// and the wakes already queued take of that first. What bookings that
    /// ended since the last reading stood for is not counted: only the
    /// next reading shows whether it is free. Zero without a disk policy.
    /// Placement counts it as free.
    #[must_use]
    pub fn reclaimable_disk(&self, now: At) -> u64 {
        let Some((room, _)) = self.queued_disk_room(now) else {
            return 0;
        };
        let relief = i128::from(self.disk_relief(now).bytes);
        u64::try_from((room.bytes + relief).max(0) - room.bytes.max(0)).unwrap_or(0)
    }

    /// What disk relief frees without losing anything: what relief under
    /// way frees (see [`Self::disk_coming`]) and what more it could.
    /// That is the local copies of idle sandboxes whose copy object
    /// storage holds (see [`gives_up_copy`]) as measured, and the caches
    /// nothing uses. A copy not measured, or only saved locally, counts
    /// for nothing.
    pub(super) fn disk_relief(&self, now: At) -> DiskSpace {
        if self.policy.disk.is_none() {
            return DiskSpace::default();
        }
        let grace = self.busy_grace();
        let copies = self
            .sandboxes
            .values()
            .filter(|slot| slot.state.level == Level::Archived && gives_up_copy(slot, now, grace))
            .fold(self.disk_coming(now), |sum, slot| {
                sum.add(slot.local_disk.copy)
            });
        self.caches
            .values()
            .filter(|cache| !cache.removing)
            .fold(copies, |sum, cache| sum.add(cache.disk))
    }

    /// What relief under way frees that no reading shows yet: archived
    /// local copies on their way out, caches being removed, and what went
    /// since the last reading. A copy whose eviction failed and backs off
    /// counts for nothing until it is tried again.
    fn disk_coming(&self, now: At) -> DiskSpace {
        let leaving = self
            .sandboxes
            .values()
            .filter(|slot| {
                slot.floor == Level::Remote
                    && slot.state.level == Level::Archived
                    && !slot.backing_off(now)
                    && !slot.wants_awake()
            })
            .fold(self.disk_freed, |sum, slot| sum.add(slot.local_disk.copy));
        self.caches
            .values()
            .filter(|cache| cache.removing)
            .fold(leaving, |sum, cache| sum.add(cache.disk))
    }

    /// Takes in what disk relief needs to know: [`Input::Wants`],
    /// [`Input::Cache`], [`Input::CacheRemoved`] and [`Input::LocalCopy`].
    pub(super) fn relief_input(&mut self, input: Input) {
        match input {
            Input::Wants { key, disk } if disk.is_empty() => {
                self.wants.remove(&key);
            }
            Input::Wants { key, disk } => {
                self.wants.insert(key, disk);
            }
            Input::Cache {
                cache,
                disk,
                last_used,
            } => self.cache(cache, disk, last_used),
            Input::CacheRemoved { cache } => self.cache_removed(cache),
            Input::LocalCopy { sandbox, disk } => {
                if let Some(slot) = self.sandboxes.get_mut(&sandbox) {
                    slot.local_disk.copy = disk;
                }
            }
            _ => {}
        }
    }

    /// Takes in [`Input::Cache`].
    fn cache(&mut self, id: CacheId, disk: DiskSpace, last_used: At) {
        if disk.is_empty() {
            self.caches.remove(&id);
            return;
        }
        let cache = self.caches.entry(id).or_insert(Cache {
            disk,
            last_used,
            removing: false,
            sent: false,
        });
        cache.disk = disk;
        cache.last_used = last_used;
    }

    /// Takes in [`Input::CacheRemoved`]: what it held is free, as only
    /// the next reading shows.
    fn cache_removed(&mut self, id: CacheId) {
        if let Some(cache) = self.caches.remove(&id) {
            self.disk_freed = self.disk_freed.add(cache.disk);
        }
    }

    /// Tells the host agent to remove the caches disk relief chose since.
    pub(super) fn remove_caches(&mut self, out: &mut Vec<Action>) {
        let mut chosen: Vec<CacheId> = self
            .caches
            .iter_mut()
            .filter(|(_, cache)| cache.removing && !cache.sent)
            .map(|(id, cache)| {
                cache.sent = true;
                *id
            })
            .collect();
        chosen.sort_unstable();
        out.extend(
            chosen
                .into_iter()
                .map(|cache| Action::RemoveCache { cache }),
        );
    }

    /// Frees local disk while it cannot book what is booked already and
    /// what the wakes queued, and those refused and still held, need, and
    /// what queued checkpoints add, counting what readings may yet show
    /// free and the relief under way: archived local copies of idle
    /// sandboxes and caches nothing uses go, least recently used first
    /// across both, until what they hold, as measured, covers what is
    /// short. Work waiting for disk relief books what it waits for (see
    /// [`crate::Input::Wants`]), so this frees it too.
    ///
    /// When they cannot cover it, as before any copy is measured, idle
    /// sandboxes that may live in object storage give up their local
    /// copies, least recently used first, as many at once as may be
    /// evicted, saved ones uploading theirs first; it then waits for those
    /// to finish and for a reading taken after them before giving up more,
    /// since only the disk shows what they freed. Returns whether any
    /// floor changed or any cache is to go.
    pub(super) fn keep_disk(&mut self, now: At) -> bool {
        let Some(mut room) = self.disk_room() else {
            return false;
        };
        let held = self
            .refused
            .iter()
            .filter_map(|id| self.sandboxes.get(id))
            .chain(self.queued_wakes())
            .fold(DiskSpace::default(), |sum, slot| sum.add(slot.disk_need()));
        let held = self.queues[Step::Checkpoint.index()]
            .iter()
            .filter_map(|key| self.sandboxes.get(&key.sandbox))
            .fold(held, |sum, slot| sum.add(slot.checkpoint_need()));
        room.give_back(self.disk_spent.add(self.disk_coming(now)));
        let short = room.shortfall(held);
        if short.is_empty() {
            return false;
        }
        let (short, mut changed) = self.free_measured(now, short);
        let leaving = self
            .sandboxes
            .values()
            .any(|slot| slot.floor == Level::Remote);
        if short.is_empty() || leaving || !self.disk_fresh {
            return changed;
        }
        let grace = self.busy_grace();
        let mut candidates: Vec<(At, SandboxId)> = self
            .sandboxes
            .iter()
            .filter(|(_, slot)| gives_up_copy(slot, now, grace))
            .map(|(id, slot)| (slot.last_activity, *id))
            .collect();
        candidates.sort_unstable();
        let mut evicted = false;
        for (_, id) in candidates
            .into_iter()
            .take(self.policy.limits.get(Step::Evict) as usize)
        {
            if let Some(slot) = self.sandboxes.get_mut(&id) {
                slot.floor = Level::Remote;
                evicted = true;
                self.mark(id);
            }
        }
        self.disk_fresh = !evicted;
        changed |= evicted;
        changed
    }

    /// Has archived local copies of idle sandboxes and caches nothing uses
    /// go, least recently used first across both, until what they hold, as
    /// measured, covers `short`; none if all of them would not. Returns
    /// what is still short, and whether any went.
    fn free_measured(&mut self, now: At, mut short: DiskSpace) -> (DiskSpace, bool) {
        /// What disk relief may free.
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        enum Freeable {
            Copy(SandboxId),
            Cache(CacheId),
        }
        let grace = self.busy_grace();
        let copies = self
            .sandboxes
            .iter()
            .filter(|(_, slot)| {
                slot.state.level == Level::Archived
                    && !slot.local_disk.copy.is_empty()
                    && gives_up_copy(slot, now, grace)
            })
            .map(|(id, slot)| {
                (
                    slot.last_activity,
                    Freeable::Copy(*id),
                    slot.local_disk.copy,
                )
            });
        let caches = self
            .caches
            .iter()
            .filter(|(_, cache)| !cache.removing)
            .map(|(id, cache)| (cache.last_used, Freeable::Cache(*id), cache.disk));
        let mut candidates: Vec<(At, Freeable, DiskSpace)> = copies.chain(caches).collect();
        let all = candidates
            .iter()
            .fold(DiskSpace::default(), |sum, (.., disk)| sum.add(*disk));
        if !short.saturating_sub(all).is_empty() {
            return (short, false);
        }
        candidates.sort_unstable_by_key(|&(at, which, _)| (at, which));
        let mut changed = false;
        for (_, which, disk) in candidates {
            if short.is_empty() {
                break;
            }
            short = short.saturating_sub(disk);
            changed = true;
            match which {
                Freeable::Copy(id) => {
                    if let Some(slot) = self.sandboxes.get_mut(&id) {
                        slot.floor = Level::Remote;
                    }
                    self.mark(id);
                }
                Freeable::Cache(id) => {
                    if let Some(cache) = self.caches.get_mut(&id) {
                        cache.removing = true;
                    }
                }
            }
        }
        (short, changed)
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
