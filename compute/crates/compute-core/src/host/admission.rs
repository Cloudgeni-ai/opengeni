//! Whether a wake fits into the memory the host lets its sandboxes take,
//! making room for it by pushing idle sandboxes deeper, and the memory
//! pressure relief that shares that mechanism; see [`crate::Admission`].

use std::time::Duration;

use super::{Action, Host, Notice};
use crate::ids::SandboxId;
use crate::level::{Level, Priority, Step};
use crate::sandbox::{QueueKey, Sandbox};
use crate::time::At;

/// What one sandbox may take of host memory, like a request and a limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Size {
    /// Bytes reserved for it while it runs: what it is guaranteed. Admission
    /// counts at least this much for every sandbox awake or waking.
    pub request: u64,
    /// Bytes its VM can use at most: its memory size. Counted for a paused
    /// VM whose resident size has not been reported yet.
    pub limit: u64,
}

impl Size {
    /// A sandbox that reserves and may use `bytes`.
    #[must_use]
    pub const fn whole(bytes: u64) -> Self {
        Self {
            request: bytes,
            limit: bytes,
        }
    }
}

/// How much of the admission budget is taken; see [`Host::capacity`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacity {
    /// Bytes of guest memory the host can hold at once.
    pub budget: u64,
    /// Bytes requested by sandboxes awake or waking: what they are
    /// guaranteed.
    pub reserved: u64,
    /// Bytes counted against the budget: what awake sandboxes reserve or
    /// use beyond that, and what paused ones hold.
    pub occupied: u64,
    /// Sandboxes awake or waking.
    pub awake: u32,
}

impl Capacity {
    /// Bytes a wake can still take without making room first.
    #[must_use]
    pub const fn free(&self) -> u64 {
        self.budget.saturating_sub(self.occupied)
    }
}

/// Whether `step` creates or resumes a VM process, and so needs memory.
pub(super) const fn needs_memory(step: Step) -> bool {
    matches!(step, Step::Resume | Step::Restore | Step::Boot)
}

impl Sandbox {
    /// Whether it is awake or waking: whether it holds its reservation.
    fn reserves(&self) -> bool {
        self.state.level == Level::Running
            || self
                .in_flight
                .is_some_and(|flight| needs_memory(flight.step))
    }

    /// Bytes of the budget it takes now.
    pub(super) fn occupies(&self, compressed_percent: u8) -> u64 {
        if self.reserves() {
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

    /// The deepest level memory pressure may push it to, from `reached`.
    fn deepest_relief(&self, reached: Level) -> Level {
        let mut level = reached;
        while let Some(deeper) = self.policy().relief_target(level) {
            level = deeper;
        }
        level
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
                capacity.awake += 1;
            }
        }
        Some(capacity)
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

    fn compressed_percent(&self) -> u8 {
        self.policy
            .memory
            .map_or(100, |memory| memory.compressed_percent)
    }

    fn busy_grace(&self) -> Duration {
        self.policy
            .admission
            .map_or(Duration::ZERO, |admission| admission.busy_grace)
    }

    /// Starts the queued wakes of kind `step`, which needs memory, while
    /// its limit allows and they fit into `free` bytes of the budget,
    /// making room for those that do not and refusing those no room can
    /// be made for. `waiting` sums what the wakes still waiting need.
    /// Returns whether anything must be reconciled again.
    pub(super) fn admit_measured(
        &mut self,
        now: At,
        step: Step,
        free: &mut u64,
        waiting: &mut u64,
        out: &mut Vec<Action>,
    ) -> bool {
        let index = step.index();
        let limit = self.policy.limits.get(step);
        let percent = self.compressed_percent();
        let mut changed = false;
        let keys: Vec<QueueKey> = self.queues[index].iter().copied().collect();
        for key in keys {
            if self.in_flight[index] >= limit {
                break;
            }
            let Some(slot) = self.sandboxes.get(&key.sandbox) else {
                continue;
            };
            let need = slot.wake_need(percent);
            if need <= *free {
                *free -= need;
                self.queues[index].remove(&key);
                self.start(step, key, out);
                continue;
            }
            // It waits while room is made for it and for every wake
            // waiting before it.
            *waiting += need;
            let deficit = waiting.saturating_sub(*free);
            match self.make_room(now, key.sandbox, deficit) {
                Room::Coming => {}
                Room::Made => changed = true,
                Room::None => {
                    *waiting -= need;
                    self.refuse(key, step, need, *free, out);
                    changed = true;
                }
            }
        }
        changed
    }

    /// Lets sandboxes refused earlier but still held try again once their
    /// wake fits, or room can be made for it, next to every wake already
    /// queued for memory: a retried wake queues behind those, and
    /// [`Self::admit_measured`] charges it their need too, so a sandbox let
    /// through here is not refused again for the same shortfall. Returns
    /// whether any did.
    pub(super) fn retry_refused(&mut self, now: At) -> bool {
        let Some(capacity) = self.capacity() else {
            return false;
        };
        let percent = self.compressed_percent();
        let mut wanted: u64 = Step::ALL
            .into_iter()
            .filter(|step| needs_memory(*step))
            .flat_map(|step| self.queues[step.index()].iter())
            .filter_map(|key| self.sandboxes.get(&key.sandbox))
            .map(|slot| slot.wake_need(percent))
            .sum();
        let mut ready = Vec::new();
        for id in &self.refused {
            let Some(slot) = self.sandboxes.get(id) else {
                continue;
            };
            let need = slot.wake_need(percent);
            let (planned, possible) = self.room(now, *id);
            if wanted + need <= capacity.free() + planned + possible {
                wanted += need;
                ready.push(*id);
            }
        }
        for id in &ready {
            self.unrefuse(*id);
            if let Some(slot) = self.sandboxes.get_mut(id) {
                slot.request_wake(Priority::Interactive, now);
            }
            self.mark(*id);
        }
        !ready.is_empty()
    }

    /// Forgets that `id`'s wake was refused.
    pub(super) fn unrefuse(&mut self, id: SandboxId) {
        if self.refused.remove(&id)
            && let Some(slot) = self.sandboxes.get_mut(&id)
        {
            slot.refused = false;
        }
    }

    /// Refuses the queued wake `key`: it needs `need` bytes, only `free`
    /// are left, and no room can be made.
    fn refuse(&mut self, key: QueueKey, step: Step, need: u64, free: u64, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get_mut(&key.sandbox) else {
            return;
        };
        self.queues[step.index()].remove(&key);
        slot.queued = None;
        slot.wake = None;
        slot.refused = true;
        self.refused.insert(key.sandbox);
        out.push(Action::Notify {
            sandbox: key.sandbox,
            notice: Notice::HostFull { needed: need, free },
        });
        self.mark(key.sandbox);
    }

    /// Makes `deficit` bytes of the budget free for `waiter`, counting what
    /// floors already set will free.
    fn make_room(&mut self, now: At, waiter: SandboxId, deficit: u64) -> Room {
        let (planned, possible) = self.room(now, waiter);
        let Some(needed) = deficit.checked_sub(planned).filter(|needed| *needed > 0) else {
            return Room::Coming;
        };
        if possible < needed {
            return Room::None;
        }
        self.push_idle(now, needed, Measure::Occupancy, Some(waiter));
        Room::Made
    }

    /// Bytes of the budget that floors already set will free, and that
    /// pushing every other idle sandbox than `waiter` as deep as it may go
    /// would free besides.
    fn room(&self, now: At, waiter: SandboxId) -> (u64, u64) {
        let percent = self.compressed_percent();
        let planned: u64 = self
            .sandboxes
            .values()
            .filter(|slot| slot.floor > slot.state.level && !slot.wants_awake())
            .map(|slot| {
                slot.occupies(percent)
                    .saturating_sub(slot.occupies_at(slot.floor, percent))
            })
            .sum();
        let grace = self.busy_grace();
        let possible: u64 = self
            .sandboxes
            .iter()
            .filter(|(id, slot)| **id != waiter && pushable(slot, now, grace))
            .map(|(_, slot)| {
                let reached = slot.state.level.max(slot.floor);
                reached_bytes(slot, reached, percent)
                    .saturating_sub(slot.occupies_at(slot.deepest_relief(reached), percent))
            })
            .sum();
        (planned, possible)
    }

    /// When available memory drops below the low watermark, pushes the least
    /// recently used idle sandboxes deeper until the expected available
    /// memory reaches the high watermark. Returns whether any floor changed.
    pub(super) fn relieve_pressure(&mut self, now: At) -> bool {
        let (Some(memory), Some(available)) = (self.policy.memory, self.available_memory) else {
            return false;
        };
        if available >= memory.low_watermark {
            return false;
        }
        let needed = memory
            .high_watermark
            .saturating_sub(available)
            .saturating_sub(self.pending_relief)
            .saturating_sub(self.settled_relief);
        needed > 0 && self.push_idle(now, needed, Measure::Resident, None)
    }

    /// Pushes idle sandboxes other than `except` deeper, least recently
    /// used first, until `needed` bytes of `measure` are expected back.
    /// Returns whether any floor changed.
    ///
    /// Each pass moves every candidate at most one level deeper, oldest
    /// first. When even that is not enough, the next pass goes deeper, so
    /// a large shortfall ends processes directly instead of compressing
    /// memory that is about to be freed anyway.
    fn push_idle(
        &mut self,
        now: At,
        mut needed: u64,
        measure: Measure,
        except: Option<SandboxId>,
    ) -> bool {
        let percent = self.compressed_percent();
        let grace = self.busy_grace();
        let mut changed = false;
        let mut candidates: Vec<(At, SandboxId, Level, u64, u64)> = Vec::new();
        while needed > 0 {
            candidates.clear();
            candidates.extend(
                self.sandboxes
                    .iter()
                    .filter(|(id, slot)| Some(**id) != except && pushable(slot, now, grace))
                    .filter_map(|(id, slot)| {
                        let reached = slot.state.level.max(slot.floor);
                        let target = slot.policy().relief_target(reached)?;
                        let resident = slot.relief_between(reached, target, percent);
                        let relief = match measure {
                            Measure::Resident if slot.resident_bytes() == 0 => 0,
                            Measure::Resident => resident,
                            Measure::Occupancy => reached_bytes(slot, reached, percent)
                                .saturating_sub(slot.occupies_at(target, percent)),
                        };
                        (relief > 0).then_some((slot.last_activity, *id, target, relief, resident))
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
        changed
    }
}

/// How making room for a wake went.
enum Room {
    /// Floors already set will free enough.
    Coming,
    /// Floors were set that will free enough.
    Made,
    /// Not even pushing every idle sandbox as deep as it may go would.
    None,
}

/// Whether `slot` may be pushed deeper to free memory at `now`: nothing
/// needs it awake, nothing is waking it, it is not busy, and it is sound.
fn pushable(slot: &Sandbox, now: At, grace: Duration) -> bool {
    !slot.is_broken()
        && !slot.wants_awake()
        && !slot.in_flight.is_some_and(|flight| flight.step.wakes())
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
