//! Running sandboxes that borrow memory above their request (ADR 24).
//!
//! A running VM's `memory.low` is its request plus the host memory its
//! compressed pages take, so the kernel never takes what the sandbox was
//! promised, however much of what it borrowed it compressed. Its
//! `memory.high` is that and a level of borrowed memory: past it the kernel
//! compresses the sandbox's own coldest pages and the sandbox waits on its
//! own allocations, so the one that borrowed pays, never the others. The
//! levels leave the low watermark of the host's memory available. Idle
//! sandboxes, those memory pressure may put to sleep, are held back first;
//! those in use may grow into whatever idle ones borrowed. A sandbox that
//! never sleeps, such as a CI runner, is in use however quiet it is: its
//! work goes on with nobody calling it. Within a group every sandbox gets
//! the same level, so the largest borrowers give back first, and a level
//! that holds nobody back still keeps one sandbox from taking more than is
//! left.
//!
//! The levels count memory on its way back as available: sandboxes the
//! host is putting to sleep and spares ending. Pressure puts idle
//! sandboxes to sleep before any of this, and a sandbox in use is not
//! compressed for memory an idle one is about to give back.
//!
//! The engine never sets a high below what a VM holds, since past its high
//! every page the VM takes waits, the longer the further past: it brings
//! the VM down toward its bound as far as the kernel can compress it and
//! leaves the high there. A VM the kernel holds above its bound is bounded
//! again once it has come down a step, so that it is brought down as far
//! as it then can be.
//!
//! A host still short with every running sandbox held to its request and
//! what is on its way back counted, which means pressure has put to sleep
//! every idle sandbox it could, has the guest of the sandbox in use holding
//! the most host memory above its request shrunk from inside: it drops its
//! page cache and ends its largest programs, never below its request. So
//! does a sandbox that holds more than its bound and no longer comes down
//! while the host runs below its low watermark: the kernel could not
//! compress what it borrowed (its pages do not compress, or zswap's pool
//! or swap slots are full), so the others would pay for it. That is known
//! only once the engine has brought it down as far as the kernel takes:
//! before the kernel compresses a VM that has just written gigabytes it
//! ages its pages, which on a busy host can take many seconds before the
//! first megabytes compress and the VM comes down hundreds of megabytes a
//! second. One the engine is still bringing down counts as not held only
//! once it has not come down for the longer `descent`, and is reported
//! meanwhile. Until its guest answers, its high is lifted
//! to what it holds and the least a shrink frees, so that the guest can run
//! to answer. A guest that cannot be shrunk (it has nothing left to end,
//! does not answer, or is older than shrinking) has its VM ended. A
//! sandbox that only stalls slows nobody but itself, and is never shrunk or
//! ended for that: its stall is reported. One action at a time, the next
//! only once a reading taken after it shows what it did, and not before
//! what the guest freed has had time to reach the host. A sandbox in use
//! is never paused for memory, and an idle one is put to sleep, never
//! shrunk.

use super::admission::releasable;
use super::{Action, Host};
use crate::ids::{SandboxId, ShrinkRequest};
use crate::level::Level;
use crate::policy::Outgrowth;
use crate::sandbox::{Health, Sandbox};
use crate::time::At;

/// How a running VM uses memory beyond what its resident size says.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Paging {
    /// Bytes its compressed pages take in host memory: part of its
    /// resident size.
    pub compressed: u64,
    /// Bytes of its memory out of RAM, at their original size: compressed
    /// or on swap.
    pub swapped: u64,
    /// Thousandths of the last ten seconds all its threads were stalled on
    /// memory: reported, never acted on.
    pub stall: u16,
    /// Since when it has held more than its bound lets it while the host
    /// was below its low watermark, and not come down a step on any
    /// reading since: the kernel could not hold it there, or is still
    /// working up to it (see `bringing_down`).
    pub unheld_since: Option<At>,
    /// Whether the engine was still bringing it down toward its bound on
    /// the latest reading: the kernel has not yet shown that it can take
    /// no more.
    pub bringing_down: bool,
    /// Its resident size on the reading before, to tell a VM the kernel
    /// is bringing down from one it cannot.
    pub before: u64,
    /// Its `memory.high` as the kernel last held it; `None` for none or
    /// unknown.
    pub high: Option<u64>,
    /// Whether its high was lifted for its guest to answer a shrink, and
    /// it is not bounded again yet.
    pub lifted: bool,
}

/// The memory bounds asked of a running VM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Bound {
    /// Its `memory.low`.
    pub low: u64,
    /// Its `memory.high`; `None` for none.
    pub high: Option<u64>,
}

/// The borrowed memory running sandboxes may keep, from the latest reading.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryLevels {
    /// Bytes above its request an idle sandbox may hold in RAM.
    pub idle: u64,
    /// Bytes above its request a sandbox in use may hold in RAM.
    pub busy: u64,
    /// Whether the host is short even with every running sandbox held to
    /// its request and what is on its way back counted.
    pub short: bool,
    /// Bytes it is short by then, below the low watermark: what guests are
    /// shrunk for. 0 when it is not short.
    pub shortfall: u64,
    /// Bytes on their way back: from sandboxes the host is putting to
    /// sleep and from spares ending. The levels count them as available.
    pub relief: u64,
    /// Running sandboxes in use whose borrowed memory the level holds
    /// back now.
    pub held_back: u64,
    /// Idle running sandboxes it holds back now.
    pub idle_held_back: u64,
    /// Running sandboxes that hold more than their bound lets them while
    /// the host is below its low watermark, and no longer come down:
    /// memory the kernel cannot compress, such as data that is compressed
    /// already, or a full zswap pool or swap device.
    pub over_bound: u64,
    /// Running sandboxes that hold more than their bound lets them while
    /// the host is below its low watermark, and have not come down since
    /// the last reading, while the engine is still bringing them down and
    /// for less than [`crate::Outgrowth::descent`]: the kernel is slow to
    /// start compressing them, aging their pages first.
    pub bringing_down: u64,
}

/// Whether a sandbox's guest may still be shrunk for host memory.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Shrink {
    /// It may.
    #[default]
    Open,
    /// It was asked, by `request`, at `since`, and has not answered.
    Asked {
        /// The request.
        request: ShrinkRequest,
        /// When it was asked.
        since: At,
    },
    /// Its guest has nothing more it may end, did not answer, or cannot be
    /// shrunk: if it is chosen while the host is short, its VM is ended.
    Spent,
    /// Its VM is being ended for memory, since `since`.
    Ending {
        /// When it was asked to end.
        since: At,
    },
}

/// Why the host shrinks a sandbox's guest or ends its VM for memory: the
/// two cases operators act on differently, the one a host too small or too
/// full for what it runs, the other a sandbox whose memory the kernel
/// cannot compress.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShrinkCause {
    /// The host is short of memory even with every running sandbox held to
    /// its request and what is on its way back counted: it is `shortfall`
    /// bytes below its low watermark, with `available` bytes available.
    Short {
        /// Bytes it is short by.
        shortfall: u64,
        /// Bytes of host memory available on the latest reading.
        available: u64,
    },
    /// The sandbox holds `over` bytes more than its bound lets it, and the
    /// kernel has not brought it down while the host ran below its low
    /// watermark: what it borrowed does not compress, or zswap has no room.
    OverBound {
        /// Bytes it holds above its bound.
        over: u64,
        /// Bytes of host memory available on the latest reading.
        available: u64,
    },
}

/// The host's side of bounding running sandboxes.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Outgrown {
    /// The levels from the latest reading.
    pub levels: MemoryLevels,
    /// Since when the host has been short with every running sandbox held
    /// to its request and what is on its way back counted.
    pub short_since: Option<At>,
    /// When the last shrink or end was asked or answered.
    pub acted: Option<At>,
    /// When the latest memory reading came in.
    pub read_at: Option<At>,
    /// Whether a memory reading came in since the bounds were last set.
    pub fresh: bool,
    /// The next shrink request's number.
    pub next_request: u64,
}

impl Paging {
    /// When, held above its bound since `since`, it counts as one the
    /// kernel cannot hold: `hold` later once the engine has brought it
    /// down as far as the kernel takes, `descent` later while it is still
    /// bringing it down.
    fn unheld_at(&self, since: At, rule: Outgrowth) -> At {
        since
            + if self.bringing_down {
                rule.descent.max(rule.hold)
            } else {
                rule.hold
            }
    }

    /// When it counts as one the kernel cannot hold, if it is held above
    /// its bound.
    fn unheld_due(&self, rule: Outgrowth) -> Option<At> {
        self.unheld_since.map(|since| self.unheld_at(since, rule))
    }
}

impl Sandbox {
    /// Bytes of host memory its VM holds uncompressed: its resident size
    /// less what its compressed pages take.
    pub(crate) fn in_ram(&self) -> u64 {
        self.resident_bytes().saturating_sub(self.paging.compressed)
    }

    /// Bytes of host memory its VM holds above its request, its compressed
    /// pages included: what ending its programs can give the host. None
    /// for a sandbox whose request is its whole size.
    pub(crate) fn held_above_request(&self) -> u64 {
        if self.size.request >= self.size.limit {
            0
        } else {
            self.resident_bytes().saturating_sub(self.size.request)
        }
    }

    /// Bytes it holds in RAM above its request.
    pub(crate) fn borrowed(&self) -> u64 {
        if self.size.request >= self.size.limit {
            0
        } else {
            self.in_ram().saturating_sub(self.size.request)
        }
    }

    /// Whether its VM's bounds are the host's to set now: it runs, with a
    /// reading and no step on it.
    fn bounded(&self) -> bool {
        self.state.level == Level::Running && self.in_flight.is_none() && self.resident.is_some()
    }

    /// Whether it may be shrunk or ended for host memory now: its VM runs
    /// holding host memory above its request with no step on it, nothing
    /// already makes it sleep, and no shrink or end of it is under way.
    fn outgrows(&self) -> bool {
        self.state.level == Level::Running
            && self.in_flight.is_none()
            && self.health != Health::Broken
            && self.floor == Level::Running
            && matches!(self.shrink, Shrink::Open | Shrink::Spent)
            && self.held_above_request() > 0
    }

    /// When a shrink or an end of it under way counts as failed, if one
    /// is: the agent gives a guest `answer` and says when it did not
    /// answer, so the core waits a `settle` longer for that word.
    fn shrink_due(&self, rule: Outgrowth) -> Option<At> {
        match self.shrink {
            Shrink::Asked { since, .. } => Some(since + rule.answer + rule.settle),
            Shrink::Ending { since } => Some(since + rule.answer),
            Shrink::Open | Shrink::Spent => None,
        }
    }

    /// Whether its VM is to be asked for `wanted`: it differs from the
    /// bound asked last by a step, its high was lifted for a shrink, or
    /// the kernel holds it above its bound, where it could compress it no
    /// further, and it has come down a step since, so that bounded again
    /// it is brought down as far as it now can be.
    fn rebound(&self, wanted: Bound, step: u64) -> bool {
        let asked = self.bound.unwrap_or(Bound {
            low: self.size.request,
            high: None,
        });
        let came_down = wanted
            .high
            .zip(self.paging.high)
            .is_some_and(|(high, kernel)| {
                kernel >= high.saturating_add(step)
                    && self.resident_bytes().saturating_add(step) <= kernel
            });
        moved(asked, wanted, step) || came_down || self.paging.lifted
    }

    /// Lifts its VM's high for its guest to answer a shrink. Past its high
    /// every page its VM takes waits, the longer the further past: a guest
    /// the kernel could not compress would not even answer. Until it does,
    /// it may hold what it holds and `room` more; its bound stays what it
    /// was, and is asked again on the first reading after the answer.
    fn lift(&mut self, id: SandboxId, room: u64, out: &mut Vec<Action>) {
        if let Some(Bound {
            low,
            high: Some(high),
        }) = self.bound
        {
            let lifted = self.resident_bytes().saturating_add(room);
            if lifted > high {
                self.paging.lifted = true;
                out.push(Action::Bound {
                    sandbox: id,
                    low,
                    high: Some(lifted),
                });
            }
        }
    }
}

/// The level of borrowed memory that lets sandboxes borrowing `borrows`
/// hold together at most `room`: every one at most the level, the smaller
/// ones what they have. When all of them fit, the largest may grow by
/// what is left, and the others up to it.
fn level(room: u64, borrows: &mut [u64]) -> u64 {
    borrows.sort_unstable();
    let total: u64 = borrows.iter().sum();
    if total <= room {
        let largest = borrows.last().copied().unwrap_or(0);
        return largest.saturating_add(room - total);
    }
    let mut left = room;
    let count = borrows.len() as u64;
    for (index, &borrow) in borrows.iter().enumerate() {
        let rest = count - index as u64;
        if borrow.saturating_mul(rest) > left {
            return left / rest;
        }
        left -= borrow;
    }
    unreachable!("borrows that do not fit leave a level below the largest")
}

impl Host {
    /// Takes in an input of bounding running sandboxes.
    pub(super) fn outgrowth_input(&mut self, now: At, input: crate::Input) {
        match input {
            crate::Input::MemoryUse {
                sandbox,
                compressed,
                swapped,
                stall,
                high,
                bringing_down,
            } => self.memory_use(
                sandbox,
                Paging {
                    compressed,
                    swapped,
                    stall,
                    bringing_down,
                    high,
                    ..Paging::default()
                },
            ),
            crate::Input::Shrunk {
                sandbox,
                request,
                spent,
                ..
            } => self.shrunk(now, sandbox, request, spent),
            crate::Input::ShrinkFailed { sandbox, request } => {
                self.shrink_failed(now, sandbox, request);
            }
            _ => {}
        }
    }

    /// Takes in [`crate::Input::MemoryUse`] of `id`: what `read` says of
    /// it.
    fn memory_use(&mut self, id: SandboxId, read: Paging) {
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if slot.state.level != Level::Running {
            return;
        }
        slot.paging.compressed = read.compressed;
        slot.paging.swapped = read.swapped;
        slot.paging.stall = read.stall;
        slot.paging.high = read.high;
        slot.paging.bringing_down = read.bringing_down;
        // Back within its request, its guest may be asked again.
        if slot.held_above_request() == 0 && slot.shrink == Shrink::Spent {
            slot.shrink = Shrink::Open;
        }
    }

    /// Takes in [`crate::Input::Shrunk`]: `id`'s guest answered `request`,
    /// and `spent` says whether it has nothing more it may end. An answer
    /// to any other request changes nothing.
    fn shrunk(&mut self, now: At, id: SandboxId, request: ShrinkRequest, spent: bool) {
        if let Some(slot) = self.sandboxes.get_mut(&id)
            && matches!(slot.shrink, Shrink::Asked { request: asked, .. } if asked == request)
        {
            slot.shrink = if spent { Shrink::Spent } else { Shrink::Open };
            self.outgrown.acted = Some(now);
        }
    }

    /// Takes in [`crate::Input::ShrinkFailed`]: `id`'s guest could not be
    /// asked, did not answer, or cannot be shrunk.
    fn shrink_failed(&mut self, now: At, id: SandboxId, request: ShrinkRequest) {
        if let Some(slot) = self.sandboxes.get_mut(&id)
            && matches!(slot.shrink, Shrink::Asked { request: asked, .. } if asked == request)
        {
            slot.shrink = Shrink::Spent;
            self.outgrown.acted = Some(now);
        }
    }

    /// The levels of borrowed memory from the latest reading.
    #[must_use]
    pub fn memory_levels(&self) -> Option<MemoryLevels> {
        self.policy.memory?.outgrowth?;
        self.available_memory?;
        Some(self.outgrown.levels)
    }

    /// The levels of borrowed memory that leave `low_watermark` of host
    /// memory available with `available` available now and what is on its
    /// way back. A sandbox the host is putting to sleep is in that, not in
    /// what running sandboxes hold.
    fn levels(&self, now: At, available: u64, low_watermark: u64) -> MemoryLevels {
        let grace = self.busy_grace();
        let (mut in_ram, mut base) = (0_u64, 0_u64);
        let (mut idle, mut busy) = (Vec::new(), Vec::new());
        for slot in self
            .sandboxes
            .values()
            .filter(|slot| slot.bounded() && slot.floor == Level::Running)
        {
            in_ram = in_ram.saturating_add(slot.in_ram());
            base = base.saturating_add(slot.in_ram().min(slot.size.request));
            let borrowed = slot.borrowed();
            if borrowed > 0 {
                if releasable(slot, now, grace) {
                    idle.push(borrowed);
                } else {
                    busy.push(borrowed);
                }
            }
        }
        let relief = self
            .pending_relief
            .saturating_add(self.settled_relief)
            .saturating_add(self.spares.ending());
        // What they may hold uncompressed, with their compressed pages, so
        // that the low watermark stays available: holding one back moves
        // memory from what it holds to what is available, which leaves
        // `have` where it was, less what its compressed pages take.
        let have = in_ram.saturating_add(available).saturating_add(relief);
        let need = base.saturating_add(low_watermark);
        match have.checked_sub(need) {
            None => MemoryLevels {
                short: true,
                shortfall: need - have,
                relief,
                ..MemoryLevels::default()
            },
            Some(room) => {
                let in_use: u64 = busy.iter().sum();
                MemoryLevels {
                    busy: level(room, &mut busy),
                    idle: level(room.saturating_sub(in_use), &mut idle),
                    relief,
                    ..MemoryLevels::default()
                }
            }
        }
    }

    /// Sets the levels from a fresh reading, and asks every running VM
    /// whose bounds they change for its new ones; see the module.
    pub(super) fn bound_memory(&mut self, now: At, out: &mut Vec<Action>) {
        let (Some(memory), Some(available)) = (self.policy.memory, self.available_memory) else {
            return;
        };
        let Some(rule) = memory.outgrowth else {
            return;
        };
        if !std::mem::take(&mut self.outgrown.fresh) {
            return;
        }
        let grace = self.busy_grace();
        let mut levels = self.levels(now, available, memory.low_watermark);
        if levels.short {
            self.outgrown.short_since.get_or_insert(now);
        } else {
            self.outgrown.short_since = None;
        }
        // The bounds leave the low watermark available only where the
        // kernel can hold each VM to its bound. One above it that did not
        // come down a step since the last reading, while less than that is
        // available, is one the kernel cannot hold, and costs the others.
        let pressed = available < memory.low_watermark;
        for (id, slot) in &mut self.sandboxes {
            if slot.state.level != Level::Running {
                // A VM starts and resumes with its request and no high.
                slot.bound = None;
                slot.paging.unheld_since = None;
                slot.paging.bringing_down = false;
                slot.paging.lifted = false;
                slot.paging.before = 0;
                continue;
            }
            if !slot.bounded() {
                slot.paging.unheld_since = None;
                continue;
            }
            let resident = slot.resident_bytes();
            let came_down = slot.paging.before.saturating_sub(resident) >= rule.step;
            slot.paging.before = resident;
            if matches!(slot.shrink, Shrink::Asked { .. }) {
                // Its high is lifted for its guest to answer (see
                // `bound_outgrowth`): the first reading after the answer
                // bounds it again, and finds whether it still holds more
                // than its bound.
                continue;
            }
            let unheld = pressed
                && !came_down
                && slot
                    .bound
                    .and_then(|bound| bound.high)
                    .is_some_and(|high| resident > high.saturating_add(rule.step));
            if unheld {
                let since = *slot.paging.unheld_since.get_or_insert(now);
                if slot.paging.bringing_down && now < slot.paging.unheld_at(since, rule) {
                    levels.bringing_down += 1;
                } else {
                    levels.over_bound += 1;
                }
            } else {
                slot.paging.unheld_since = None;
            }
            let idle = releasable(slot, now, grace);
            let level = if idle { levels.idle } else { levels.busy };
            let low = slot.size.request.saturating_add(slot.paging.compressed);
            let high = (slot.size.request.saturating_add(level) < slot.size.limit)
                .then(|| low.saturating_add(level));
            // Held back: it borrows, and would take more than its level
            // were its bound not there.
            if high.is_some()
                && slot.borrowed() > 0
                && slot.borrowed().saturating_add(rule.step) >= level
            {
                if idle {
                    levels.idle_held_back += 1;
                } else {
                    levels.held_back += 1;
                }
            }
            let wanted = Bound { low, high };
            if slot.rebound(wanted, rule.step) {
                slot.bound = Some(wanted);
                slot.paging.lifted = false;
                out.push(Action::Bound {
                    sandbox: *id,
                    low,
                    high,
                });
            }
        }
        self.outgrown.levels = levels;
    }

    /// Shrinks the guest of the sandbox in use that holds the most host
    /// memory above its request among those that cost the others, or ends
    /// its VM if it cannot be shrunk; see the module.
    pub(super) fn bound_outgrowth(&mut self, now: At, out: &mut Vec<Action>) {
        let Some(rule) = self.policy.memory.and_then(|memory| memory.outgrowth) else {
            return;
        };
        // A guest that does not answer in time cannot help, and an end
        // that never came is tried again. The agent gives a guest `answer`
        // and says when it gave none; this is for when it never says.
        for slot in self.sandboxes.values_mut() {
            if slot.shrink_due(rule).is_some_and(|due| now >= due) {
                slot.shrink = Shrink::Spent;
                self.outgrown.acted = Some(now);
            }
        }
        let under_way = self
            .sandboxes
            .values()
            .any(|slot| matches!(slot.shrink, Shrink::Asked { .. } | Shrink::Ending { .. }));
        // The next only on a reading taken once what the last freed has
        // had time to reach the host.
        let read = self.outgrown.read_at.is_some_and(|read| {
            self.outgrown
                .acted
                .is_none_or(|at| read.saturating_since(at) >= rule.settle)
        });
        if under_way || !read {
            return;
        }
        let short = self
            .outgrown
            .short_since
            .is_some_and(|since| now.saturating_since(since) >= rule.hold);
        let unheld = |slot: &Sandbox| slot.paging.unheld_due(rule).is_some_and(|due| now >= due);
        let levels = self.outgrown.levels;
        let grace = self.busy_grace();
        // Only one that costs the others: the host is short, or the kernel
        // cannot hold it to its bound. An idle one goes to sleep instead.
        let Some((excess, id)) = self
            .sandboxes
            .iter()
            .filter(|(_, slot)| slot.outgrows() && !releasable(slot, now, grace))
            .filter(|(_, slot)| short || unheld(slot))
            .map(|(id, slot)| (slot.held_above_request(), *id))
            .max()
        else {
            return;
        };
        let Some(slot) = self.sandboxes.get(&id) else {
            return;
        };
        // What the host is short of, or what it holds above its bound,
        // which the kernel could not take: never all it borrowed, so its
        // guest ends as little as it can.
        let available = self.available_memory.unwrap_or(0);
        let cause = if short {
            ShrinkCause::Short {
                shortfall: levels.shortfall,
                available,
            }
        } else {
            let high = slot.bound.and_then(|bound| bound.high).unwrap_or(u64::MAX);
            ShrinkCause::OverBound {
                over: slot.resident_bytes().saturating_sub(high),
                available,
            }
        };
        let wanted = match cause {
            ShrinkCause::Short { shortfall, .. } => shortfall,
            ShrinkCause::OverBound { over, .. } => over,
        };
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        if slot.shrink == Shrink::Spent {
            // Ending a VM barely above its request frees its request too:
            // that is the host's to keep, not this sandbox's to lose.
            if excess < rule.least {
                return;
            }
            slot.shrink = Shrink::Ending { since: now };
            out.push(Action::EndForMemory { sandbox: id, cause });
        } else {
            let request = ShrinkRequest(self.outgrown.next_request);
            self.outgrown.next_request += 1;
            slot.lift(id, rule.least, out);
            slot.shrink = Shrink::Asked {
                request,
                since: now,
            };
            out.push(Action::Shrink {
                sandbox: id,
                free: wanted.max(rule.least).min(excess),
                keep: slot.size.request,
                request,
                cause,
            });
        }
        self.outgrown.acted = Some(now);
    }

    /// The next moment bounding running sandboxes can change without new
    /// input.
    pub(super) fn outgrowth_deadline(&self) -> Option<At> {
        let rule = self.policy.memory?.outgrowth?;
        let slots = self.sandboxes.values();
        let answers = slots.clone().filter_map(|slot| slot.shrink_due(rule));
        let unheld = slots.filter_map(|slot| slot.paging.unheld_due(rule));
        let short = self.outgrown.short_since.map(|since| since + rule.hold);
        answers.chain(unheld).chain(short).min()
    }
}

/// Whether `wanted` differs from `current` enough to write.
fn moved(current: Bound, wanted: Bound, step: u64) -> bool {
    let far = |a: u64, b: u64| a.abs_diff(b) >= step;
    far(current.low, wanted.low)
        || match (current.high, wanted.high) {
            (Some(current), Some(wanted)) => far(current, wanted),
            (None, None) => false,
            _ => true,
        }
}

#[cfg(test)]
mod tests {
    use super::level;

    #[test]
    fn a_level_holds_the_largest_borrowers_back_first() {
        // 1, 3 and 6 borrowed, 7 of room: the smallest keeps its 1, the
        // other two 3 each.
        assert_eq!(level(7, &mut [6, 1, 3]), 3);
        // Room for exactly the two smaller ones and a part of the largest.
        assert_eq!(level(9, &mut [6, 1, 3]), 5);
        assert_eq!(level(0, &mut [6, 1, 3]), 0);
    }

    #[test]
    fn a_level_with_room_to_spare_lets_the_largest_grow_by_it() {
        assert_eq!(level(12, &mut [6, 1, 3]), 8);
        assert_eq!(level(10, &mut [6, 1, 3]), 6);
        assert_eq!(level(5, &mut []), 5);
    }
}
