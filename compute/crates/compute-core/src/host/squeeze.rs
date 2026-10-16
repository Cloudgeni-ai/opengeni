//! Relief from sandboxes in use above their request, once idle ones have
//! nothing left to give: first their balloons, so their guests give file
//! cache back, then pausing and saving the one furthest above its request,
//! which wakes again by itself once there is room. Like all relief it runs
//! in the background, never inside a request, and never touches a sandbox
//! within its request.

use super::{Action, Host, Notice, Resource, WakeRoom};
use crate::ids::SandboxId;
use crate::level::{Level, Priority};
use crate::policy::MemoryPolicy;
use crate::sandbox::{Health, Sandbox};
use crate::time::At;

/// What the host asked of a running sandbox's balloon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Balloon {
    /// Bytes its guest is asked to give back: all its memory above its
    /// request. The guest gives what it can spare, file cache first, and
    /// takes pages back from the balloon rather than run out.
    pub bytes: u64,
    /// Bytes the host held for it above its request when asked: what the
    /// host expects back at most.
    pub relief: u64,
    /// When the host asked.
    pub since: At,
}

/// Whether a sandbox was paused for host memory while in use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Squeeze {
    /// It was not.
    #[default]
    None,
    /// It is being paused and saved, whoever wants it awake; its VM held
    /// `bytes`.
    Leaving {
        /// Host memory its VM held.
        bytes: u64,
    },
    /// It is saved and waits, wanted awake, until `bytes` fit above the
    /// high watermark.
    Waiting {
        /// Host memory its VM held.
        bytes: u64,
    },
    /// It was let through to wake, or its balloon was let go, and it claims
    /// `bytes` of the room above the high watermark, what it may take back,
    /// until its VM has confirmed its balloon is let go and a reading
    /// taken after that, while it runs, shows them. Wakes and balloons
    /// thus never spend the same room, however long a balloon takes to go.
    Returning {
        /// Host memory its VM held.
        bytes: u64,
    },
}

impl Sandbox {
    /// Bytes of host memory it holds above its request. None for a sandbox
    /// whose request is its whole size: what its VM holds beyond that is
    /// the VMM's own.
    fn above_request(&self) -> u64 {
        if self.size.request >= self.size.limit {
            0
        } else {
            self.resident_bytes().saturating_sub(self.size.request)
        }
    }

    /// Whether it is being paused and saved for host memory.
    pub(crate) fn leaving(&self) -> bool {
        matches!(self.squeeze, Squeeze::Leaving { .. })
    }

    /// Whether it runs above its request with nothing in the way of
    /// squeezing it, nor anything already making it sleep.
    fn squeezable(&self) -> bool {
        self.state.level == Level::Running
            && self.in_flight.is_none()
            && self.health == Health::Sound
            && self.squeeze == Squeeze::None
            && self.floor == Level::Running
            && self.above_request() > 0
    }

    /// What its running VM's balloon is to be set to now, if it is not
    /// known to be so and no backoff after a failed setting holds it back.
    /// Nothing asked of it lets the balloon go.
    pub(super) fn balloon_due(&mut self, now: At) -> Option<u64> {
        if self.state.level != Level::Running || self.in_flight.is_some() {
            return None;
        }
        let bytes = self.balloon_wanted();
        let held = self.balloon_retry.is_some_and(|(at, _)| at > now);
        if self.balloon_sent == Some(bytes) || held {
            return None;
        }
        self.balloon_sent = Some(bytes);
        self.balloon_taken = None;
        Some(bytes)
    }

    /// Bytes the host wants its balloon to take: none unless asked.
    fn balloon_wanted(&self) -> u64 {
        self.balloon.map_or(0, |balloon| balloon.bytes)
    }

    /// Whether its VM confirmed the balloon setting the host wants now.
    fn balloon_settled(&self) -> bool {
        self.balloon_taken == Some(self.balloon_wanted())
    }
}

impl Host {
    /// `id`'s VM did not take a balloon setting of `bytes`: it is asked
    /// again after the sleep backoff, longer after each failure in a row.
    /// What the balloon takes meanwhile is not known.
    pub(super) fn balloon_failed(&mut self, now: At, id: SandboxId, bytes: u64) {
        let backoff = self.policy.sleep_backoff;
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if slot.balloon_sent != Some(bytes) {
            // An older request; a newer one stands.
            return;
        }
        let failures = slot.balloon_retry.map_or(0, |(_, failures)| failures) + 1;
        slot.balloon_sent = None;
        slot.balloon_taken = None;
        slot.balloon_retry = Some((now + backoff.delay(failures), failures));
        self.mark(id);
    }

    /// `id`'s VM took the balloon setting of `bytes`: if that is the one
    /// last sent, it is known to hold, and failures before it are
    /// forgotten.
    pub(super) fn balloon_set(&mut self, id: SandboxId, bytes: u64) {
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if slot.balloon_sent != Some(bytes) {
            // An older request; a newer one stands.
            return;
        }
        slot.balloon_taken = Some(bytes);
        slot.balloon_retry = None;
        self.mark(id);
    }

    /// Frees `needed` bytes that pushing idle sandboxes could not: asks the
    /// guests of sandboxes in use above their request to give memory back
    /// through their balloons, furthest above first, and when even all of
    /// that, counted as given, falls short, pauses and saves the sandbox
    /// furthest above its request, then the next. Balloons asked within
    /// [`MemoryPolicy::balloon_grace`] count as on their way. Returns
    /// whether anything changed.
    pub(super) fn squeeze_busy(&mut self, now: At, memory: MemoryPolicy, needed: u64) -> bool {
        let coming = |slot: &Sandbox| {
            slot.balloon
                .filter(|balloon| now.saturating_since(balloon.since) < memory.balloon_grace)
                .map_or(0, |balloon| balloon.relief)
        };
        let mut needed = needed.saturating_sub(self.sandboxes.values().map(coming).sum());
        let mut above: Vec<(u64, SandboxId)> = self
            .sandboxes
            .iter()
            .filter(|(_, slot)| slot.squeezable() && slot.balloon.is_none())
            .map(|(id, slot)| (slot.above_request(), *id))
            .collect();
        above.sort_unstable_by(|a, b| b.cmp(a));
        let mut changed = false;
        for (relief, id) in above {
            if needed == 0 {
                break;
            }
            let Some(slot) = self.sandboxes.get_mut(&id) else {
                continue;
            };
            slot.balloon = Some(Balloon {
                bytes: slot.size.limit - slot.size.request,
                relief,
                since: now,
            });
            needed = needed.saturating_sub(relief);
            changed = true;
            self.mark(id);
        }
        while needed > 0 {
            let furthest = self
                .sandboxes
                .iter()
                .filter(|(_, slot)| slot.squeezable())
                .map(|(id, slot)| (slot.above_request(), *id))
                .max();
            let Some((_, id)) = furthest else {
                break;
            };
            let Some(slot) = self.sandboxes.get_mut(&id) else {
                break;
            };
            let bytes = slot.resident_bytes();
            let counted = coming(slot);
            slot.squeeze = Squeeze::Leaving { bytes };
            slot.floor = Level::Saved;
            slot.floor_relief += bytes;
            self.pending_relief += bytes;
            needed = needed.saturating_sub(bytes.saturating_sub(counted));
            changed = true;
            self.mark(id);
        }
        changed
    }

    /// Lets balloons go, the longest set first, once each has been given
    /// time and its guest could take back all it gave with the high
    /// watermark still free. Returns whether any went.
    pub(super) fn release_balloons(
        &mut self,
        now: At,
        memory: MemoryPolicy,
        available: u64,
    ) -> bool {
        let mut room = available
            .saturating_sub(memory.high_watermark)
            .saturating_sub(self.claimed_room());
        let mut set: Vec<(At, SandboxId, u64)> = self
            .sandboxes
            .iter()
            .filter_map(|(id, slot)| Some((*id, slot.balloon?)))
            .filter(|(_, balloon)| now.saturating_since(balloon.since) >= memory.balloon_grace)
            .map(|(id, balloon)| (balloon.since, id, balloon.relief))
            .collect();
        set.sort_unstable();
        let mut changed = false;
        for (_, id, relief) in set {
            if relief > room {
                break;
            }
            room -= relief;
            if let Some(slot) = self.sandboxes.get_mut(&id) {
                slot.balloon = None;
                if slot.squeeze == Squeeze::None {
                    slot.squeeze = Squeeze::Returning { bytes: relief };
                }
            }
            changed = true;
            self.mark(id);
        }
        changed
    }

    /// Whether a sandbox that held `bytes` when it was paused for host
    /// memory may wake: they fit with the high watermark still free, next
    /// to what sandboxes let through before claim.
    pub(super) fn room_returned(&self, bytes: u64) -> bool {
        self.policy.memory.is_none()
            || self.available_memory.is_none()
            || bytes <= self.free_above_watermark()
    }

    /// Bytes available above the high watermark that no sandbox let
    /// through to wake claims; 0 without a reading.
    pub(super) fn free_above_watermark(&self) -> u64 {
        match (self.policy.memory, self.available_memory) {
            (Some(memory), Some(available)) => available
                .saturating_sub(memory.high_watermark)
                .saturating_sub(self.claimed_room()),
            _ => 0,
        }
    }

    /// Bytes claimed by sandboxes let through to wake after waiting for
    /// host memory, not yet shown by a reading.
    fn claimed_room(&self) -> u64 {
        self.sandboxes
            .values()
            .map(|slot| match slot.squeeze {
                Squeeze::Returning { bytes } => bytes,
                _ => 0,
            })
            .sum()
    }

    /// Ends the claims of sandboxes that run, were measured and whose VM
    /// confirmed the balloon setting wanted of it: a reading of available
    /// memory taken now, after that confirmation, shows what they hold.
    pub(super) fn measured_returns(&mut self) {
        for slot in self.sandboxes.values_mut() {
            if matches!(slot.squeeze, Squeeze::Returning { .. })
                && slot.state.level == Level::Running
                && slot.in_flight.is_none()
                && slot.resident.is_some()
                && slot.balloon_settled()
            {
                slot.squeeze = Squeeze::None;
            }
        }
    }

    /// `sandbox` is asked for awake by a touch or a hold. A wake refused
    /// before tries again, but one paused for host memory still waits for
    /// room and is told so at once.
    pub(super) fn ask_awake(&mut self, sandbox: SandboxId, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get(&sandbox) else {
            return;
        };
        if let Squeeze::Waiting { bytes } = slot.squeeze {
            out.push(Action::Notify {
                sandbox,
                notice: Notice::HostFull {
                    resource: Resource::Memory,
                    needed: bytes,
                    free: self.free_above_watermark(),
                },
            });
        } else {
            self.unrefuse(sandbox);
        }
    }

    /// Moves `id` along after a pause for host memory: once saved it
    /// waits, wanted awake, for room, and whoever waits for it hears so;
    /// once nothing wants it awake nothing waits; a wake given up frees
    /// the room it claimed.
    pub(super) fn settle_squeeze(&mut self, id: SandboxId, now: At, out: &mut Vec<Action>) {
        let free = self.free_above_watermark();
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if let Squeeze::Leaving { bytes } = slot.squeeze
            && !slot.state.level.has_process()
            && slot.in_flight.is_none()
        {
            slot.squeeze = Squeeze::Waiting { bytes };
            slot.request_wake(Priority::Background, now);
            slot.room = WakeRoom::Refused;
            self.refused.insert(id);
            out.push(Action::Notify {
                sandbox: id,
                notice: Notice::HostFull {
                    resource: Resource::Memory,
                    needed: bytes,
                    free,
                },
            });
        }
        if slot.room == WakeRoom::Refused && !slot.wants_awake() {
            slot.room = WakeRoom::Open;
            slot.squeeze = Squeeze::None;
            self.refused.remove(&id);
        }
        if matches!(slot.squeeze, Squeeze::Returning { .. })
            && slot.state.level != Level::Running
            && !slot.waking()
        {
            slot.squeeze = Squeeze::None;
        }
    }
}
