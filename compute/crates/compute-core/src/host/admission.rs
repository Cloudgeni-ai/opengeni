//! Whether a wake fits into the memory the host lets its sandboxes take,
//! decided by arithmetic with instant relief only; the buffer of free room
//! kept ahead of wakes in the background, and the memory pressure relief
//! that shares its mechanism; see [`crate::Admission`]. A wake must also
//! fit the processor time the host guarantees (see
//! [`crate::HostPolicy::cpu_budget`]) and the local disk its saves may need
//! (see [`super::disk`]).

use std::time::Duration;

use super::disk::{DiskRoom, DiskSpace, Resource};
use super::{Action, Host, Notice, Squeeze};
use crate::ids::SandboxId;
use crate::level::{Level, Priority, Step};
use crate::sandbox::{QueueKey, Sandbox};
use crate::time::At;

/// What one sandbox may take of host memory, like a request and a limit,
/// of processor time, and of local disk for a save.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Size {
    /// Bytes reserved for it while it runs: what it is guaranteed. Admission
    /// counts at least this much for every sandbox awake or waking.
    pub request: u64,
    /// Bytes its VM can use at most: its memory size. Counted for a paused
    /// VM whose resident size has not been reported yet.
    pub limit: u64,
    /// Millicores of processor time reserved for it while it is awake or
    /// waking: what it is guaranteed when processors are contended,
    /// counted against [`crate::HostPolicy::cpu_budget`]. A sleeping
    /// sandbox reserves none.
    pub cpu: u64,
    /// Bytes of local disk one save of its VM may write at most, booked
    /// while its VM holds state not saved yet; see [`crate::DiskPolicy`].
    pub save: u64,
    /// Bytes its disk may grow by at most while its VM runs, booked while
    /// it is awake or waking, until [`crate::Input::DiskGrowth`] measures
    /// it; see [`crate::DiskPolicy`].
    pub disk: u64,
    /// Bytes a wake from object storage writes to local disk at most: its
    /// disk, and the memory image its pager fills while the guest already
    /// runs. Booked from the wake's admission until
    /// [`crate::Input::Hydrating`] says the local copy is whole.
    pub fetch: u64,
}

impl Size {
    /// A sandbox that reserves and may use `bytes`, whose saves write at
    /// most as much, and that reserves no processor time and books no disk
    /// growth or fetch.
    #[must_use]
    pub const fn whole(bytes: u64) -> Self {
        Self {
            request: bytes,
            limit: bytes,
            cpu: 0,
            save: bytes,
            disk: 0,
            fetch: 0,
        }
    }

    /// The same, reserving `millis` of processor time while awake.
    #[must_use]
    pub const fn with_cpu(mut self, millis: u64) -> Self {
        self.cpu = millis;
        self
    }
}

/// How much of the admission budget is taken; see [`Host::capacity`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacity {
    /// Bytes of guest memory the host can hold at once.
    pub budget: u64,
    /// Bytes requested by sandboxes awake or waking, and by new ones whose
    /// first wake is booked: what they are guaranteed.
    pub reserved: u64,
    /// Bytes counted against the budget: what awake sandboxes reserve or
    /// use beyond that, what new ones book for their first wake, and what
    /// paused ones hold.
    pub occupied: u64,
    /// Sandboxes awake or waking.
    pub awake: u32,
}

impl Capacity {
    /// Bytes a wake can still take without making room first; 0 when the
    /// budget is overdrawn.
    #[must_use]
    pub const fn free(&self) -> u64 {
        self.budget.saturating_sub(self.occupied)
    }

    /// Bytes left of the budget, negative when it is overdrawn, as after
    /// a restart with a smaller budget: then not even a wake that takes
    /// nothing more fits until room is made.
    pub(super) fn headroom(&self) -> i128 {
        i128::from(self.budget) - i128::from(self.occupied)
    }
}

/// How much of the processor budget is taken; see [`Host::cpu_capacity`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuCapacity {
    /// Millicores the host guarantees its sandboxes at once.
    pub budget: u64,
    /// Millicores reserved by sandboxes awake or waking, and by VMs not
    /// managed here that may run.
    pub reserved: u64,
}

impl CpuCapacity {
    /// Millicores a wake can still reserve; 0 when the budget is
    /// overdrawn.
    #[must_use]
    pub const fn free(&self) -> u64 {
        self.budget.saturating_sub(self.reserved)
    }

    /// Millicores left of the budget, negative when it is overdrawn, as
    /// after a restart with a smaller budget.
    pub(super) fn headroom(&self) -> i128 {
        i128::from(self.budget) - i128::from(self.reserved)
    }
}

/// What a compressed VM keeps of its memory, in percent, when no memory
/// policy says: typical of zswap on guest memory.
const COMPRESSED_PERCENT: u8 = 25;

/// The first wake a create booked for a sandbox not added yet; see
/// [`crate::Input::Creating`].
#[derive(Clone, Copy, Debug)]
pub(super) struct FirstWake {
    /// What the sandbox may take of host memory.
    pub(super) size: Size,
    /// Whether that wake fetches it from object storage.
    pub(super) remote: bool,
    /// When the booking lapses.
    pub(super) until: At,
}

impl FirstWake {
    /// What the wake books on local disk, as the sandbox does once added:
    /// its next save, what its disk may grow by, and from object storage
    /// its local copy.
    pub(super) fn disk(&self) -> DiskSpace {
        let mut disk = DiskSpace::save(self.size.save).add(DiskSpace::bytes(self.size.disk));
        if self.remote {
            disk = disk.add(DiskSpace::save(self.size.fetch));
        }
        disk
    }
}

/// Whether a host can take a new sandbox now; see [`Host::create_room`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateRoom {
    /// Its first wake fits now, with what is written for it before.
    Fits,
    /// Only local disk is short, and by no more than what bookings that
    /// ended since the last reading stood for (see
    /// [`Host::disk_awaits_reading`]): the next reading decides it. Says
    /// what of the disk is short, what it needs and what is free now.
    AwaitsReading(Resource, u64, u64),
    /// The resource that is short, what it needs and what is free.
    Short(Resource, u64, u64),
}

/// Where a sandbox's wake stands with admission.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum WakeRoom {
    /// Its wake, if any, has not been admitted yet.
    #[default]
    Open,
    /// Its wake was admitted and owns its room until the sandbox runs or
    /// nothing wants it awake any more, across every step it takes: a wake
    /// from object storage fetches first and restores after, and the room
    /// booked for the fetch is the restore's.
    Admitted,
    /// Its wake was refused for want of room, and is not tried again until
    /// asked anew or it fits; see [`crate::Notice::HostFull`].
    Refused,
}

/// Whether `step` wakes a sandbox into memory: it creates or resumes a VM
/// process, or fetches a sandbox only to restore it, so it is admitted
/// before any download starts and holds the room meanwhile.
pub(super) const fn needs_memory(step: Step) -> bool {
    matches!(
        step,
        Step::Resume | Step::Restore | Step::Boot | Step::Fetch
    )
}

impl Sandbox {
    /// Whether it holds its reservation: it is awake or waking, or it is
    /// new and its first wake is booked.
    pub(super) fn reserves(&self) -> bool {
        self.awake_or_waking() || self.fresh_until.is_some()
    }

    /// Whether it is awake or waking, or its wake was let in.
    pub(super) fn awake_or_waking(&self) -> bool {
        self.state.level == Level::Running
            || self.room == WakeRoom::Admitted
            || self
                .in_flight
                .is_some_and(|flight| needs_memory(flight.step))
    }

    /// Ends the booking of its first wake once it runs, once it cannot
    /// run here any more, or at the end of the booking.
    pub(super) fn settle_first_wake(&mut self, now: At) {
        let ran = self.state.level == Level::Running && self.in_flight.is_none();
        if self
            .fresh_until
            .is_some_and(|until| until <= now || ran || self.is_broken())
        {
            self.fresh_until = None;
        }
    }

    /// Ends the room its wake owned once it runs, or once nothing waits
    /// for it and no step is waking it.
    pub(super) fn settle_room(&mut self) {
        let waking = self
            .in_flight
            .is_some_and(|flight| needs_memory(flight.step));
        let running = self.state.level == Level::Running && self.in_flight.is_none();
        if self.room == WakeRoom::Admitted
            && (running || self.is_broken() || (!self.wants_awake() && !waking))
        {
            self.room = WakeRoom::Open;
        }
    }

    /// Bytes of the budget it takes now.
    pub(super) fn occupies(&self, compressed_percent: u8) -> u64 {
        if self.reserves() {
            self.awake_bytes()
        } else {
            self.occupies_at(self.state.level, compressed_percent)
        }
    }

    /// Bytes of the budget its VM takes now, if it has one, or is about
    /// to: as [`Self::occupies`], less the booking of a first wake that has
    /// not started.
    pub(super) fn vm_occupies(&self, compressed_percent: u8) -> u64 {
        if self.awake_or_waking() {
            self.awake_bytes()
        } else {
            self.occupies_at(self.state.level, compressed_percent)
        }
    }

    /// Bytes it takes running: its request, or what it was last seen to
    /// use if more.
    fn awake_bytes(&self) -> u64 {
        self.size.request.max(self.resident_bytes())
    }

    /// Bytes it would take at `level`, as deep as its own or deeper, with no
    /// step in flight.
    fn occupies_at(&self, level: Level, compressed_percent: u8) -> u64 {
        let paused = self.resident.unwrap_or(self.size.limit);
        match level {
            Level::Running => self.awake_bytes(),
            Level::Paused => paused,
            // What a report taken while compressed already shows.
            Level::Compressed if self.state.level == Level::Compressed => self
                .resident
                .unwrap_or(self.size.limit / 100 * u64::from(compressed_percent)),
            Level::Compressed => paused / 100 * u64::from(compressed_percent),
            Level::Saved | Level::Archived | Level::Remote => 0,
        }
    }

    /// Bytes more it takes once a wake of it has started.
    pub(super) fn wake_need(&self, compressed_percent: u8) -> u64 {
        self.awake_bytes()
            .saturating_sub(self.occupies(compressed_percent))
    }

    /// Millicores more it reserves once a wake of it has started: none
    /// when it reserves already.
    pub(super) fn cpu_need(&self) -> u64 {
        if self.reserves() { 0 } else { self.size.cpu }
    }
}

/// What relief is measured in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Measure {
    /// Host memory a sandbox holds, as reported.
    Resident,
    /// The admission budget a sandbox takes.
    Occupancy,
}

impl Host {
    /// How much of the admission budget is taken, or `None` without
    /// admission.
    #[must_use]
    pub fn capacity(&self) -> Option<Capacity> {
        let admission = self.policy.admission?;
        let percent = self.compressed_percent();
        let mut capacity = Capacity {
            budget: admission.budget,
            reserved: 0,
            occupied: 0,
            awake: 0,
        };
        for slot in self.sandboxes.values() {
            capacity.occupied += slot.occupies(percent);
            if slot.reserves() {
                capacity.reserved += slot.size.request;
            }
            if slot.awake_or_waking() {
                capacity.awake += 1;
            }
        }
        for booked in self.creating.values() {
            capacity.occupied += booked.size.request;
            capacity.reserved += booked.size.request;
        }
        capacity.occupied += self.unmanaged.values().sum::<u64>() + self.spares.held();
        Some(capacity)
    }

    /// How much of the processor budget is taken, or `None` without one.
    #[must_use]
    pub fn cpu_capacity(&self) -> Option<CpuCapacity> {
        let budget = self.policy.cpu_budget?;
        let awake: u64 = self
            .sandboxes
            .values()
            .filter(|slot| slot.reserves())
            .map(|slot| slot.size.cpu)
            .sum();
        let creating: u64 = self.creating.values().map(|booked| booked.size.cpu).sum();
        Some(CpuCapacity {
            budget,
            reserved: awake
                + creating
                + self.unmanaged_cpu.values().sum::<u64>()
                + self.spares.filling_cpu(),
        })
    }

    /// Whether the new sandbox `sandbox` of `size` can be created or
    /// adopted here and woken at once. Its first wake must fit as a wake
    /// queued behind those already queued would: memory counting the
    /// instant relief a wake may wait for, processor time, and the local
    /// disk the wake books, from object storage with `remote`, together
    /// with `files`, what is written for it before it joins the core (its
    /// first files). What it books already with [`crate::Input::Creating`]
    /// counts as free for it.
    #[must_use]
    pub fn create_room(
        &self,
        now: At,
        sandbox: SandboxId,
        size: Size,
        remote: bool,
        files: DiskSpace,
    ) -> CreateRoom {
        let percent = self.compressed_percent();
        let own = self.creating.get(&sandbox);
        let queued: Vec<&Sandbox> = Step::ALL
            .into_iter()
            .filter(|step| needs_memory(*step))
            .flat_map(|step| self.queues[step.index()].iter())
            .filter_map(|key| self.sandboxes.get(&key.sandbox))
            .collect();
        let free = |headroom: i128, own: u64, wanted: i128| {
            u64::try_from(headroom + i128::from(own) - wanted).unwrap_or(0)
        };
        if let Some(cpu) = self.cpu_capacity() {
            let wanted = queued.iter().map(|slot| i128::from(slot.cpu_need())).sum();
            let free = free(cpu.headroom(), own.map_or(0, |own| own.size.cpu), wanted);
            if size.cpu > free {
                return CreateRoom::Short(Resource::Cpu, size.cpu, free);
            }
        }
        let mut awaits_reading = None;
        if let Some(mut room) = self.disk_room() {
            for slot in &queued {
                // What a wake already queued cannot book does not change
                // whether this one can.
                let _ = room.take(slot.disk_need());
            }
            if let Some(own) = own {
                room.give_back(own.disk());
            }
            let disk = FirstWake {
                size,
                remote,
                until: now,
            }
            .disk()
            .add(files);
            if let Err(short) = room.take(disk) {
                if !room.may_take(disk, self.disk_spent) {
                    return CreateRoom::Short(short.resource, short.needed, short.free);
                }
                awaits_reading = Some(short);
            }
        }
        if let Some(capacity) = self.capacity() {
            let (dropping, droppable) = self.instant_room(now, sandbox);
            let wanted: u64 = queued.iter().map(|slot| slot.wake_need(percent)).sum();
            let headroom = capacity.headroom() + i128::from(dropping) + i128::from(droppable);
            let free = free(
                headroom,
                own.map_or(0, |own| own.size.request),
                i128::from(wanted),
            );
            if size.request > free {
                return CreateRoom::Short(Resource::Memory, size.request, free);
            }
        }
        awaits_reading.map_or(CreateRoom::Fits, |short| {
            CreateRoom::AwaitsReading(short.resource, short.needed, short.free)
        })
    }

    /// Takes in [`crate::Input::Creating`].
    pub(super) fn creating(&mut self, now: At, sandbox: SandboxId, booked: FirstWake) {
        if booked.until > now {
            self.creating.insert(sandbox, booked);
            return;
        }
        self.creating.remove(&sandbox);
        if let Some(slot) = self.sandboxes.get_mut(&sandbox)
            && slot.fresh_until.take().is_some()
        {
            self.mark(sandbox);
        }
    }

    /// Takes in [`crate::Input::CpuBudget`].
    pub(super) fn set_cpu_budget(&mut self, millis: u64) {
        if self.policy.cpu_budget.is_some() {
            self.policy.cpu_budget = Some(millis);
        }
    }

    /// Whether `id`'s wake was refused for want of memory and it waits,
    /// held, for room; see [`Notice::HostFull`].
    #[must_use]
    pub fn waits_for_room(&self, id: SandboxId) -> bool {
        self.refused.contains(&id)
    }

    /// Bytes of the budget `id`'s wake needs while it waits, held, for
    /// room; `None` when it does not wait.
    #[must_use]
    pub fn room_needed(&self, id: SandboxId) -> Option<u64> {
        let slot = self
            .sandboxes
            .get(&id)
            .filter(|_| self.refused.contains(&id))?;
        Some(slot.wake_need(self.compressed_percent()))
    }

    /// What a compressed VM is expected to keep of its memory, in percent:
    /// the memory policy's estimate, or a quarter without one.
    pub(super) fn compressed_percent(&self) -> u8 {
        self.policy
            .memory
            .map_or(COMPRESSED_PERCENT, |memory| memory.compressed_percent)
    }

    pub(super) fn busy_grace(&self) -> Duration {
        self.policy
            .admission
            .map_or(Duration::ZERO, |admission| admission.busy_grace)
    }

    /// What wakes may take in one decision, or `None` when every wake is
    /// admitted.
    pub(super) fn left(&self) -> Option<Left> {
        let left = Left {
            memory: self.capacity().map(|capacity| capacity.headroom()),
            cpu: self.cpu_capacity().map(|capacity| capacity.headroom()),
            waiting: 0,
            disk: self.disk_room(),
        };
        (left.memory.is_some() || left.cpu.is_some() || left.disk.is_some()).then_some(left)
    }

    /// Starts the queued wakes of kind `step`, which needs memory, while
    /// its limit allows and they fit into what is `left`. A wake whose
    /// processor time does not fit is refused at once: nothing frees
    /// processor time instantly. A wake the disk cannot book is refused at
    /// once, unless it is short by no more than what bookings that ended
    /// since the last disk reading stood for (see
    /// [`Host::disk_awaits_reading`]): it waits, queued, for the next
    /// reading to decide it. One whose memory does not fit waits only if
    /// ending idle VM processes that are already saved frees enough for it
    /// and every wake waiting before it; otherwise it is refused at once.
    /// Returns whether anything must be reconciled again.
    pub(super) fn admit_measured(
        &mut self,
        now: At,
        step: Step,
        left: &mut Left,
        out: &mut Vec<Action>,
    ) -> bool {
        let index = step.index();
        let limit = self.policy.limits.get(step);
        let percent = self.compressed_percent();
        let unread = self.disk_spent;
        let mut changed = false;
        let keys: Vec<QueueKey> = self.queues[index].iter().copied().collect();
        for key in keys {
            if self.in_flight[index] >= limit {
                break;
            }
            let Some(slot) = self.sandboxes.get(&key.sandbox) else {
                continue;
            };
            if slot.room == WakeRoom::Admitted {
                // Its room and its save are booked already: a fetched
                // sandbox restores into the room its fetch was given.
                self.queues[index].remove(&key);
                self.start(step, key, out);
                continue;
            }
            let need = slot.wake_need(percent);
            let cpu = slot.cpu_need();
            let save = slot.disk_need();
            if let Some(headroom) = left.cpu.as_mut() {
                if i128::from(cpu) > *headroom {
                    let free = u64::try_from(*headroom).unwrap_or(0);
                    let overdraft = u64::try_from(-*headroom).unwrap_or(0);
                    self.refuse(key, step, Resource::Cpu, cpu + overdraft, free, out);
                    changed = true;
                    continue;
                }
                *headroom -= i128::from(cpu);
            }
            if let Some(disk) = left.disk.as_mut()
                && let Err(short) = disk.take(save)
            {
                if disk.may_take(save, unread) {
                    // Perhaps there is room: the next reading shows. What
                    // it needs is charged meanwhile, its processor time
                    // among it, so a later wake does not take room it may
                    // get.
                    disk.charge(save);
                    continue;
                }
                left.give_back_cpu(cpu);
                self.refuse(key, step, short.resource, short.needed, short.free, out);
                changed = true;
                continue;
            }
            let Some(headroom) = left.memory.as_mut() else {
                self.queues[index].remove(&key);
                self.start(step, key, out);
                continue;
            };
            if i128::from(need) <= *headroom {
                *headroom -= i128::from(need);
                self.queues[index].remove(&key);
                self.start(step, key, out);
                continue;
            }
            left.waiting += need;
            let deficit = u64::try_from(i128::from(left.waiting) - *headroom).unwrap_or(u64::MAX);
            match self.drop_for(now, key.sandbox, deficit) {
                Room::Coming => {}
                Room::Made => changed = true,
                Room::None => {
                    left.waiting -= need;
                    // On an overdrawn budget a wake needs the overdraft
                    // freed too.
                    let free = u64::try_from(*headroom).unwrap_or(0);
                    let overdraft = u64::try_from(-*headroom).unwrap_or(0);
                    left.give_back_cpu(cpu);
                    if let Some(disk) = left.disk.as_mut() {
                        disk.give_back(save);
                    }
                    self.refuse(key, step, Resource::Memory, need + overdraft, free, out);
                    changed = true;
                }
            }
        }
        changed
    }

    /// Starts queued checkpoints while their limit allows and the disk
    /// left can book what each adds while it runs (see
    /// [`Sandbox::checkpoint_need`]). One that does not fit stays queued
    /// without holding up those behind it, and is tried again at every
    /// decision, a disk reading's among them; [`Host::keep_disk`] makes
    /// room for it meanwhile.
    pub(super) fn admit_checkpoints(&mut self, left: Option<&mut Left>, out: &mut Vec<Action>) {
        let index = Step::Checkpoint.index();
        let limit = self.policy.limits.get(Step::Checkpoint);
        let mut disk = left.and_then(|left| left.disk.as_mut());
        let keys: Vec<QueueKey> = self.queues[index].iter().copied().collect();
        for key in keys {
            if self.in_flight[index] >= limit {
                break;
            }
            let need = self
                .sandboxes
                .get(&key.sandbox)
                .map_or_else(DiskSpace::default, Sandbox::checkpoint_need);
            if disk
                .as_deref_mut()
                .is_some_and(|room| room.take(need).is_err())
            {
                continue;
            }
            self.queues[index].remove(&key);
            self.start(Step::Checkpoint, key, out);
        }
    }

    /// Lets sandboxes refused earlier but still held try again once their
    /// wake fits, memory counting instant relief, processor time and disk,
    /// next to every wake already queued for memory: a retried wake queues
    /// behind those, and [`Self::admit_measured`] charges it their need
    /// too, so a sandbox let through here is not refused again for the same
    /// shortfall. One paused for host memory waits, besides, until the
    /// memory it held is free above the high watermark, next to what others
    /// let through before it claim; see [`Host::room_returned`]. Returns
    /// whether any did.
    pub(super) fn retry_refused(&mut self, now: At) -> bool {
        let capacity = self.capacity();
        let mut cpu = self.cpu_capacity().map(|cpu| cpu.headroom());
        let percent = self.compressed_percent();
        let queued: Vec<&Sandbox> = Step::ALL
            .into_iter()
            .filter(|step| needs_memory(*step))
            .flat_map(|step| self.queues[step.index()].iter())
            .filter_map(|key| self.sandboxes.get(&key.sandbox))
            .collect();
        let mut wanted: u64 = queued.iter().map(|slot| slot.wake_need(percent)).sum();
        if let Some(headroom) = cpu.as_mut() {
            *headroom -= queued
                .iter()
                .map(|slot| i128::from(slot.cpu_need()))
                .sum::<i128>();
        }
        let mut disk = self.disk_room();
        if let Some(room) = disk.as_mut() {
            for slot in &queued {
                // What a wake already queued cannot book does not change
                // whether a retried one can.
                let _ = room.take(slot.disk_need());
            }
        }
        let mut ready = Vec::new();
        let mut claimed = 0;
        for id in &self.refused {
            let Some(slot) = self.sandboxes.get(id) else {
                continue;
            };
            let need = slot.wake_need(percent);
            let returning = match slot.squeeze {
                Squeeze::Waiting { bytes } if !self.room_returned(claimed + bytes) => continue,
                Squeeze::Waiting { bytes } => bytes,
                _ => 0,
            };
            let cpu_need = i128::from(slot.cpu_need());
            let fits = cpu.is_none_or(|headroom| cpu_need <= headroom)
                && capacity.is_none_or(|capacity| {
                    let (dropping, droppable) = self.instant_room(now, *id);
                    i128::from(wanted + need)
                        <= capacity.headroom() + i128::from(dropping) + i128::from(droppable)
                })
                && disk
                    .as_mut()
                    .is_none_or(|room| room.take(slot.disk_need()).is_ok());
            if fits {
                wanted += need;
                claimed += returning;
                if let Some(headroom) = cpu.as_mut() {
                    *headroom -= cpu_need;
                }
                ready.push(*id);
            }
        }
        for id in &ready {
            self.unrefuse(*id);
            if let Some(slot) = self.sandboxes.get_mut(id) {
                if let Squeeze::Waiting { bytes } = slot.squeeze {
                    slot.squeeze = Squeeze::Returning { bytes };
                }
                slot.request_wake(Priority::Interactive, now);
            }
            self.mark(*id);
        }
        !ready.is_empty()
    }

    /// Forgets that `id`'s wake was refused. One paused for host memory
    /// still waits for room; see [`Squeeze::Waiting`].
    pub(super) fn unrefuse(&mut self, id: SandboxId) {
        if self.refused.remove(&id)
            && let Some(slot) = self.sandboxes.get_mut(&id)
        {
            slot.room = WakeRoom::Open;
        }
    }

    /// Refuses the queued wake `key`: it needs `need` of `resource`, only
    /// `free` is left, and instant relief cannot free the rest.
    fn refuse(
        &mut self,
        key: QueueKey,
        step: Step,
        resource: Resource,
        need: u64,
        free: u64,
        out: &mut Vec<Action>,
    ) {
        let Some(slot) = self.sandboxes.get_mut(&key.sandbox) else {
            return;
        };
        self.queues[step.index()].remove(&key);
        slot.queued = None;
        slot.wake = None;
        slot.room = WakeRoom::Refused;
        self.refused.insert(key.sandbox);
        out.push(Action::Notify {
            sandbox: key.sandbox,
            notice: Notice::HostFull {
                resource,
                needed: need,
                free,
            },
        });
        self.mark(key.sandbox);
    }

    /// Frees `deficit` bytes of the budget for `waiter` by ending idle VM
    /// processes that are already saved, least recently used first, after
    /// ready spare VMs, oldest first, counting those already ending.
    fn drop_for(&mut self, now: At, waiter: SandboxId, deficit: u64) -> Room {
        let (dropping, droppable) = self.instant_room(now, waiter);
        let Some(mut needed) = deficit.checked_sub(dropping).filter(|needed| *needed > 0) else {
            return Room::Coming;
        };
        if droppable < needed {
            return Room::None;
        }
        needed = self.end_spares(needed);
        let percent = self.compressed_percent();
        let grace = self.busy_grace();
        let mut candidates: Vec<(At, SandboxId)> = self
            .sandboxes
            .iter()
            .filter(|(id, slot)| {
                **id != waiter && slot.floor < Level::Saved && droppable_now(slot, now, grace)
            })
            .map(|(id, slot)| (slot.last_activity, *id))
            .collect();
        candidates.sort_unstable();
        for (_, id) in candidates {
            if needed == 0 {
                break;
            }
            let Some(slot) = self.sandboxes.get_mut(&id) else {
                continue;
            };
            let reached = slot.state.level.max(slot.floor);
            let resident = slot.relief_between(reached, Level::Saved, percent);
            needed = needed.saturating_sub(slot.occupies(percent));
            slot.floor = Level::Saved;
            slot.floor_relief += resident;
            self.pending_relief += resident;
            self.mark(id);
        }
        Room::Made
    }

    /// Bytes of the budget that VM processes other than `waiter`'s already
    /// ending will free, and that ending every other idle one already saved
    /// would free besides, ready spare VMs included. Both take milliseconds
    /// and no I/O; a sandbox backing off after a failed step takes no step
    /// until its backoff ends, so it counts for neither.
    fn instant_room(&self, now: At, waiter: SandboxId) -> (u64, u64) {
        let percent = self.compressed_percent();
        let grace = self.busy_grace();
        let (mut dropping, mut droppable) = (self.spares.ending(), self.spares.endable());
        for (id, slot) in &self.sandboxes {
            if *id == waiter {
                continue;
            }
            let ending = slot
                .in_flight
                .is_some_and(|flight| flight.step == Step::Drop)
                || (slot.floor >= Level::Saved
                    && slot.in_flight.is_none()
                    && slot.reclaimable()
                    && !slot.backing_off(now));
            if ending {
                dropping += slot.occupies(percent);
            } else if droppable_now(slot, now, grace) {
                droppable += slot.occupies(percent);
            }
        }
        (dropping, droppable)
    }

    /// Keeps [`crate::Admission::buffer`] bytes of the budget free ahead of
    /// wakes, plus what the wakes refused and still held need, by pushing
    /// idle sandboxes deeper, least recently used first, after ending ready
    /// spare VMs, oldest first. A held wake that waits for processor time
    /// counts no memory until that is free: freeing memory would not let
    /// it through. Counts what floors already set and spare VMs already
    /// ending will free. Returns whether any floor changed.
    pub(super) fn keep_buffer(&mut self, now: At) -> bool {
        let (Some(admission), Some(capacity)) = (self.policy.admission, self.capacity()) else {
            return false;
        };
        let percent = self.compressed_percent();
        let cpu = self.cpu_capacity().map(|cpu| cpu.headroom());
        let planned: u64 = self
            .sandboxes
            .values()
            .filter(|slot| slot.floor > slot.state.level && !slot.wants_awake())
            .map(|slot| {
                slot.occupies(percent)
                    .saturating_sub(slot.occupies_at(slot.floor, percent))
            })
            .sum();
        let held: u64 = self
            .refused
            .iter()
            .filter_map(|id| self.sandboxes.get(id))
            .filter(|slot| cpu.is_none_or(|headroom| i128::from(slot.cpu_need()) <= headroom))
            .map(|slot| slot.wake_need(percent))
            .sum();
        let needed = (admission.buffer + held)
            .saturating_sub(capacity.free() + planned + self.spares.ending());
        let needed = self.end_spares(needed);
        needed > 0 && self.push_idle(now, needed, Measure::Occupancy).0
    }

    /// When available memory drops below the low watermark, pushes the least
    /// recently used idle sandboxes deeper until the expected available
    /// memory reaches the high watermark, after ending ready spare VMs,
    /// and squeezes sandboxes in use above their request when that is not
    /// enough; lets their balloons go once there is room for what they
    /// gave. Returns whether anything changed.
    pub(super) fn relieve_pressure(&mut self, now: At) -> bool {
        let (Some(memory), Some(available)) = (self.policy.memory, self.available_memory) else {
            return false;
        };
        let released = self.release_balloons(now, memory, available);
        if available >= memory.low_watermark {
            return released;
        }
        let needed = memory
            .high_watermark
            .saturating_sub(available)
            .saturating_sub(self.pending_relief)
            .saturating_sub(self.settled_relief)
            .saturating_sub(self.spares.ending());
        let needed = self.end_spares(needed);
        if needed == 0 {
            return released;
        }
        let (pushed, rest) = self.push_idle(now, needed, Measure::Resident);
        released | pushed | (rest > 0 && self.squeeze_busy(now, memory, rest))
    }

    /// Pushes idle sandboxes deeper, least recently used first, until
    /// `needed` bytes of `measure` are expected back. Returns whether any
    /// floor changed, and how much it could not find.
    ///
    /// Each pass moves every candidate at most one level deeper, oldest
    /// first. When even that is not enough, the next pass goes deeper, so
    /// a large shortfall ends processes directly instead of compressing
    /// memory that is about to be freed anyway.
    fn push_idle(&mut self, now: At, mut needed: u64, measure: Measure) -> (bool, u64) {
        let percent = self.compressed_percent();
        let grace = self.busy_grace();
        let mut changed = false;
        let mut candidates: Vec<(At, SandboxId, Level, u64, u64)> = Vec::new();
        while needed > 0 {
            candidates.clear();
            candidates.extend(
                self.sandboxes
                    .iter()
                    .filter(|(_, slot)| pushable(slot, now, grace))
                    .filter_map(|(id, slot)| {
                        let reached = slot.state.level.max(slot.floor);
                        // The first level deeper that frees anything: one
                        // compressing nothing goes straight to the next.
                        let mut target = slot.policy().relief_target(reached)?;
                        loop {
                            let resident = slot.relief_between(reached, target, percent);
                            let relief = match measure {
                                Measure::Resident if slot.resident_bytes() == 0 => 0,
                                Measure::Resident => resident,
                                Measure::Occupancy => reached_bytes(slot, reached, percent)
                                    .saturating_sub(slot.occupies_at(target, percent)),
                            };
                            if relief > 0 {
                                break Some((slot.last_activity, *id, target, relief, resident));
                            }
                            target = slot.policy().relief_target(target)?;
                        }
                    }),
            );
            if candidates.is_empty() {
                break;
            }
            candidates.sort_unstable();
            for &(_, id, target, relief, resident) in &candidates {
                if needed == 0 {
                    break;
                }
                let Some(slot) = self.sandboxes.get_mut(&id) else {
                    continue;
                };
                slot.floor = target;
                slot.floor_relief += resident;
                self.pending_relief += resident;
                needed = needed.saturating_sub(relief);
                changed = true;
                self.mark(id);
            }
        }
        (changed, needed)
    }
}

/// How making room for a wake went.
enum Room {
    /// VM processes already ending will free enough.
    Coming,
    /// VM processes were set to end that will free enough.
    Made,
    /// Not even ending every idle VM process already saved would.
    None,
}

/// What wakes may still take in one decision; see [`Host::left`].
pub(super) struct Left {
    /// Bytes left of the memory budget, negative when it is overdrawn;
    /// `None` without admission.
    memory: Option<i128>,
    /// Millicores left of the processor budget, negative when it is
    /// overdrawn; `None` without one.
    cpu: Option<i128>,
    /// Bytes the wakes waiting for instant relief need.
    waiting: u64,
    /// Disk saves may still book; `None` without a disk policy.
    disk: Option<DiskRoom>,
}

impl Left {
    /// Gives back processor time charged to a wake that was refused after
    /// all.
    fn give_back_cpu(&mut self, millis: u64) {
        if let Some(headroom) = self.cpu.as_mut() {
            *headroom += i128::from(millis);
        }
    }
}

/// Whether ending `slot`'s VM process now frees memory instantly, without
/// losing anything, keeping anyone waiting or ending a busy sandbox, and
/// without waiting for a backoff to end.
fn droppable_now(slot: &Sandbox, now: At, grace: Duration) -> bool {
    slot.in_flight.is_none()
        && slot.reclaimable()
        && !slot.backing_off(now)
        && pushable(slot, now, grace)
}

/// Whether `slot` may be pushed deeper to free memory at `now`: nothing
/// needs it awake, nothing is waking it, it is not new with its first wake
/// booked, it is not busy, and it is sound.
pub(super) fn pushable(slot: &Sandbox, now: At, grace: Duration) -> bool {
    !slot.is_broken()
        && !slot.wants_awake()
        && !slot.in_flight.is_some_and(|flight| flight.step.wakes())
        && slot.fresh_until.is_none()
        && now.saturating_since(slot.last_activity) >= grace
}

/// Bytes of the budget `slot` takes once it reached `reached`.
fn reached_bytes(slot: &Sandbox, reached: Level, percent: u8) -> u64 {
    if reached == slot.state.level {
        slot.occupies(percent)
    } else {
        slot.occupies_at(reached, percent)
    }
}
