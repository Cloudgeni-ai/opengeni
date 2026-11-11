//! Reading how much each sandbox's disk may still grow, off the agent's
//! loop (#6976).
//!
//! What a disk may still take depends on which of its blocks it holds
//! alone, which the agent reads from the file's extent map (FIEMAP; see
//! [`disk_growth::headroom`]). On XFS that read takes the allocation
//! group's lock to see which extents are shared, and on a host pressed for
//! memory and disk, behind the saves that write meanwhile, it waited for
//! seconds. The agent read every disk at rest and every running disk on
//! its loop, once a sample, so the loop answered nothing for as long,
//! not even what the host can take on, and the lease's watchdog stopped
//! the agent as stuck.
//!
//! So the loop never waits long on an extent map:
//!
//! - **Disks at rest** (saved or archived, with no VM, no step and no
//!   teardown) are read on a thread of their own, one measurement at a
//!   time, whenever their file changed and every [`REMEASURE`] besides,
//!   since another file starting or ending to share a disk's blocks
//!   changes what it holds alone without changing the file. The loop keeps
//!   what each reading found with the file and the
//!   [generation](DiskMeter::generations) it found it in, and tells the
//!   core as each comes.
//! - **Where the loop needs a stopped disk's headroom at once**, for a
//!   wake's admission, a thread of its own checks the file and uses the
//!   latest reading if that is of the file as it is now, of the sandbox's
//!   present generation, and younger than [`VALID_FOR`], or else reads the
//!   disk. The loop waits [`READ_NOW_WITHIN`] at most for one read, and
//!   in all no more than a budget of [`READ_NOW_BUDGET`] that refills at
//!   a tenth of the time that passes: a disk not read in time, or that
//!   cannot be read, books its whole bound, as does one met with less than
//!   [`READ_NOW_FLOOR`] of budget left, and no such read starts while one
//!   that came late still runs. A late reading is kept once it comes.
//! - **Running disks** are read on a thread of their own each sample,
//!   after the disk reading and before their writes are settled, as
//!   [`HostAgent::disk_growth_readings`] needs. A sample waits for that
//!   reading [`READ_WITHIN`] at most and takes the disks read by then:
//!   the others book all they may take for that sample, as a disk that
//!   cannot be read always did, and no sample reads them again until that
//!   reading ends.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use compute_core::{Input, Level, SandboxId};
use compute_engine::Engine;
use tokio::task::JoinHandle;

use super::{Event, HostAgent};
use crate::disk_growth::{self, Headroom};
use crate::protocol::Id;
use crate::store::Store;

/// How old a reading of a disk at rest may grow before it is read again.
const REMEASURE: Duration = Duration::from_secs(30);

/// How old a reading of a disk at rest may be and still be used.
const VALID_FOR: Duration = Duration::from_secs(60);

/// How long a sample waits for its reading of the running disks.
const READ_WITHIN: Duration = Duration::from_millis(200);

/// How long the loop waits for a stopped disk it needs read at once.
const READ_NOW_WITHIN: Duration = Duration::from_millis(100);

/// How long the loop may wait for such reads in all: the budget refills
/// at a tenth of the time that passes, up to this.
const READ_NOW_BUDGET: Duration = Duration::from_millis(200);

/// The least budget a read the loop waits for starts with: with less, the
/// disk books its whole bound unread rather than surely miss.
const READ_NOW_FLOOR: Duration = Duration::from_millis(10);

/// Which file a reading was of: a disk at rest that changes, or is
/// replaced, is another stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl FileStamp {
    /// The stamp of the file at `path`, or `None` when it cannot be read.
    pub(super) fn of(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let found = std::fs::metadata(path).ok()?;
        Some(Self {
            dev: found.dev(),
            ino: found.ino(),
            len: found.len(),
            mtime: (found.mtime(), found.mtime_nsec()),
            ctime: (found.ctime(), found.ctime_nsec()),
        })
    }
}

/// What a stopped disk may still grow by, as one reading found it.
#[derive(Clone, Copy, Debug)]
pub(super) struct Reading {
    /// The file it was read in; `None` if there was none.
    stamp: Option<FileStamp>,
    /// The sandbox's generation it was read in.
    generation: u64,
    /// Bytes it may still grow by: what it may take at most where its
    /// extents could not be read.
    bytes: u64,
    at: Instant,
}

/// Readings of stopped disks: one of a measurement, as it is taken, or
/// one the loop stopped waiting for; or, with none, the end of a
/// measurement.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Measured {
    reading: Option<(SandboxId, Reading)>,
    ends: bool,
}

/// The agent's readings of its disks.
#[derive(Debug, Default)]
pub(super) struct DiskMeter {
    /// The latest reading of each stopped disk.
    resting: HashMap<SandboxId, Reading>,
    /// Each sandbox's generation: it moves on whenever a step of the
    /// sandbox ends and as it is added, so a reading taken before cannot
    /// stand for its disk after, whatever the step did to it or to files
    /// sharing its blocks. Generations are drawn from one count for the
    /// whole host, so a sandbox that leaves and comes back never meets a
    /// generation of its earlier stay.
    generations: HashMap<SandboxId, u64>,
    /// The latest generation drawn.
    drawn: u64,
    /// Since when a measurement of disks at rest is under way.
    measuring: Option<Instant>,
    /// Whether that one was warned of as slow.
    measuring_warned: bool,
    /// A reading of running disks that a sample stopped waiting for, until
    /// it ends.
    running: Option<JoinHandle<()>>,
    /// Whether that was warned of.
    running_warned: bool,
    /// A read the loop needed at once and stopped waiting for, until it
    /// ends.
    now: Option<Arc<AtomicBool>>,
    /// What the loop may still wait for such reads, as of when.
    budget: Option<(Duration, Instant)>,
    /// Whether the budget's running out was warned of, until it refills.
    budget_warned: bool,
}

impl DiskMeter {
    /// Sandbox `id`'s disk may have changed: readings taken so far no
    /// longer stand for it.
    pub(super) fn changed(&mut self, id: SandboxId) {
        self.drawn += 1;
        self.generations.insert(id, self.drawn);
        self.resting.remove(&id);
    }

    /// Forgets sandbox `id`, gone from the host.
    pub(super) fn forget(&mut self, id: SandboxId) {
        self.generations.remove(&id);
        self.resting.remove(&id);
    }

    fn generation(&self, id: SandboxId) -> u64 {
        self.generations.get(&id).copied().unwrap_or_default()
    }

    /// What the loop may wait for a read at `now`, the budget refilled to
    /// then.
    fn budget(&mut self, now: Instant) -> Duration {
        let (left, at) = self.budget.unwrap_or((READ_NOW_BUDGET, now));
        let left = left
            .saturating_add(now.saturating_duration_since(at) / 10)
            .min(READ_NOW_BUDGET);
        self.budget = Some((left, now));
        left
    }

    /// Takes `waited` out of the budget.
    fn spend(&mut self, waited: Duration) {
        if let Some((left, at)) = self.budget {
            self.budget = Some((left.saturating_sub(waited), at));
        }
    }

    /// Keeps `reading` of sandbox `id`'s disk if it is of the disk's
    /// present generation; says whether it did.
    fn keep(&mut self, id: SandboxId, reading: Reading) -> bool {
        if reading.generation == 0 || reading.generation != self.generation(id) {
            return false;
        }
        self.resting.insert(id, reading);
        true
    }
}

/// What the disk at `path` may still grow by, if its extents can be read.
/// `shares` says whether files share extents (see [`disk_growth::headroom`]).
fn read(path: &Path, unit: u64, shares: bool) -> Option<Headroom> {
    disk_growth::headroom(path, unit, shares)
        .inspect_err(|error| {
            tracing::debug!(
                path = %path.display(),
                %error,
                "could not read how much a disk may still grow"
            );
        })
        .ok()
}

/// A disk at rest to measure: its file, its generation, its latest
/// reading, and what it may take at most.
struct Wanted {
    id: SandboxId,
    path: PathBuf,
    generation: u64,
    known: Option<Reading>,
    whole: u64,
}

/// Sends the end of a measurement once dropped, also if it ends part way,
/// so the agent never waits for one that will not come.
struct Sending<V> {
    events: tokio::sync::mpsc::UnboundedSender<Event<V>>,
}

impl<V> Sending<V> {
    /// Sends `reading` of sandbox `id`'s disk.
    fn send(&self, id: SandboxId, reading: Reading) {
        let measured = Measured {
            reading: Some((id, reading)),
            ends: false,
        };
        let _ = self.events.send(Event::DisksMeasured(Box::new(measured)));
    }
}

/// Marks a read the loop stopped waiting for as ended once dropped, also
/// if it ends part way.
struct Ended(Arc<AtomicBool>);

impl Drop for Ended {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Whether nothing can change sandbox `id`'s disk now: no step, no
    /// teardown and no running guest.
    pub(super) fn disk_rests(&self, id: SandboxId) -> bool {
        let Some(slot) = self.slots.get(&id) else {
            return false;
        };
        !slot.destroy
            && slot.op.is_none()
            && !self.tearing_down.contains_key(&id)
            && self.core.sandbox(id).is_some_and(|view| {
                view.step.is_none() && !matches!(view.state.level, Level::Running | Level::Remote)
            })
    }

    /// What stopped disk `id` may still grow by, from its latest reading
    /// if that stands for it, else read now; all it may take, `whole`,
    /// where neither comes within [`READ_NOW_WITHIN`] and the budget, or
    /// while an earlier such read still runs.
    pub(super) fn stopped_growth(&mut self, id: SandboxId, whole: u64) -> u64 {
        use std::sync::mpsc::RecvTimeoutError;
        let Some(path) = self.slots.get(&id).map(|slot| slot.paths.disk.clone()) else {
            return whole;
        };
        if let Some(late) = &self.disks.now {
            if !late.load(Ordering::Acquire) {
                return whole;
            }
            self.disks.now = None;
            tracing::info!("stopped disks are read in time again");
        }
        let within = READ_NOW_WITHIN.min(self.disks.budget(Instant::now()));
        if within < READ_NOW_FLOOR {
            if !std::mem::replace(&mut self.disks.budget_warned, true) {
                tracing::warn!(
                    "the loop has waited its budget for stopped disks: until it refills, each books all it may take unread"
                );
            }
            return whole;
        }
        self.disks.budget_warned = false;
        let generation = self.disks.generation(id);
        let known = self
            .disks
            .resting
            .get(&id)
            .copied()
            .filter(|known| known.generation == generation && known.at.elapsed() < VALID_FOR);
        let (unit, shares) = (self.allocation_unit, self.save_copies == 1);
        let events = self.events_tx.clone();
        // With no buffer, a reading sent after the loop stopped waiting is
        // refused, and so sent as an event instead of lost.
        let (sent, answer) = std::sync::mpsc::sync_channel(0);
        let ended = Arc::new(AtomicBool::new(false));
        let done = Ended(Arc::clone(&ended));
        tokio::task::spawn_blocking(move || {
            let _done = done;
            let stamp = FileStamp::of(&path);
            let reading = match known {
                Some(known) if known.stamp == stamp => known,
                _ => Reading {
                    stamp,
                    generation,
                    bytes: read(&path, unit, shares).map_or(whole, |found| found.left),
                    at: Instant::now(),
                },
            };
            if sent.send(reading).is_err() {
                // The loop stopped waiting: it keeps the reading once it
                // comes, if it still stands then.
                let late = Measured {
                    reading: Some((id, reading)),
                    ends: false,
                };
                let _ = events.send(Event::DisksMeasured(Box::new(late)));
            }
        });
        let started = Instant::now();
        let answered = answer.recv_timeout(within);
        self.disks.spend(started.elapsed());
        match answered {
            Ok(reading) => {
                self.disks.keep(id, reading);
                reading.bytes
            }
            Err(RecvTimeoutError::Timeout) => {
                drop(answer);
                tracing::warn!(
                    sandbox = %Id(id),
                    within_ms = within.as_millis(),
                    "a stopped disk could not be read in time: until such reads end, each books all it may take"
                );
                self.disks.now = Some(ended);
                whole
            }
            Err(RecvTimeoutError::Disconnected) => whole,
        }
    }

    /// Measures, on a thread of its own, the disks at rest whose file
    /// changed since their latest reading or whose reading is older than
    /// [`REMEASURE`], unless a measurement is under way;
    /// [`Event::DisksMeasured`] brings what it read.
    pub(super) fn measure_resting_disks(&mut self) {
        if let Some(since) = self.disks.measuring {
            if since.elapsed() >= REMEASURE
                && !std::mem::replace(&mut self.disks.measuring_warned, true)
            {
                tracing::warn!(
                    took_s = since.elapsed().as_secs(),
                    "a measurement of disks at rest is slow: disks it has not read yet keep their latest readings while those stand, and are read again for a wake"
                );
            }
            return;
        }
        let wanted: Vec<Wanted> = self
            .slots
            .iter()
            .filter(|(id, slot)| {
                slot.vm.is_none()
                    && self.disk_rests(**id)
                    && self.core.sandbox(**id).is_some_and(|view| {
                        matches!(view.state.level, Level::Saved | Level::Archived)
                    })
            })
            .filter_map(|(id, slot)| {
                let record = self.records.get(Id(*id))?;
                Some(Wanted {
                    id: *id,
                    path: slot.paths.disk.clone(),
                    generation: self.disks.generation(*id),
                    known: self.disks.resting.get(id).copied(),
                    whole: self.record_size(&record).disk,
                })
            })
            .collect();
        if wanted.is_empty() {
            return;
        }
        self.disks.measuring = Some(Instant::now());
        let (unit, shares) = (self.allocation_unit, self.save_copies == 1);
        let sending = Sending {
            events: self.events_tx.clone(),
        };
        tokio::task::spawn_blocking(move || {
            for want in wanted {
                let stamp = FileStamp::of(&want.path);
                if want.known.is_some_and(|known| {
                    known.generation == want.generation
                        && known.stamp == stamp
                        && known.at.elapsed() < REMEASURE
                }) {
                    continue;
                }
                let bytes = read(&want.path, unit, shares).map_or(want.whole, |found| found.left);
                let reading = Reading {
                    stamp,
                    generation: want.generation,
                    bytes,
                    at: Instant::now(),
                };
                sending.send(want.id, reading);
            }
        });
    }

    /// Takes in a reading of a stopped disk, or the end of a measurement,
    /// and tells the core what the disk, still at rest in the same
    /// generation, may grow by.
    pub(super) fn disks_measured(&mut self, measured: Measured) {
        if measured.ends {
            if self
                .disks
                .measuring
                .take()
                .is_some_and(|_| self.disks.measuring_warned)
            {
                tracing::info!("disks at rest are measured again");
            }
            self.disks.measuring_warned = false;
            // Sandboxes no longer here go too.
            let slots = &self.slots;
            self.disks.resting.retain(|id, _| slots.contains_key(id));
            self.disks
                .generations
                .retain(|id, _| slots.contains_key(id));
        }
        let Some((id, reading)) = measured.reading else {
            return;
        };
        if self.slots.contains_key(&id) && self.disks.keep(id, reading) && self.disk_rests(id) {
            self.input(Input::DiskGrowth {
                sandbox: id,
                bytes: reading.bytes,
            });
        }
    }

    /// Reads what each running disk of `disks` may still grow by, on a
    /// thread of its own, waiting [`READ_WITHIN`] at most, and answers
    /// those read by then. None are read while an earlier reading still
    /// runs.
    pub(super) async fn read_running_disks(
        &mut self,
        disks: Vec<(SandboxId, PathBuf)>,
    ) -> HashMap<SandboxId, Headroom> {
        if disks.is_empty() {
            return HashMap::new();
        }
        if self
            .disks
            .running
            .as_ref()
            .is_some_and(|reading| !reading.is_finished())
        {
            return HashMap::new();
        }
        let (unit, shares) = (self.allocation_unit, self.save_copies == 1);
        let read_so_far = Arc::new(Mutex::new(HashMap::new()));
        let into = Arc::clone(&read_so_far);
        let mut task = tokio::task::spawn_blocking(move || {
            for (id, path) in disks {
                if let Some(headroom) = read(&path, unit, shares) {
                    into.lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(id, headroom);
                }
            }
        });
        let finished = tokio::time::timeout(READ_WITHIN, &mut task).await.is_ok();
        let read = std::mem::take(&mut *read_so_far.lock().unwrap_or_else(PoisonError::into_inner));
        if finished {
            self.disks.running = None;
            if std::mem::take(&mut self.disks.running_warned) {
                tracing::info!("running disks are read in time again");
            }
        } else {
            if !std::mem::replace(&mut self.disks.running_warned, true) {
                tracing::warn!(
                    within_ms = READ_WITHIN.as_millis(),
                    read = read.len(),
                    "running disks could not all be read in time: until they are, each not read books all it may take"
                );
            }
            self.disks.running = Some(task);
        }
        read
    }
}

impl<V> Drop for Sending<V> {
    fn drop(&mut self) {
        let ends = Measured {
            reading: None,
            ends: true,
        };
        let _ = self.events.send(Event::DisksMeasured(Box::new(ends)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(generation: u64) -> Reading {
        Reading {
            stamp: None,
            generation,
            bytes: 1,
            at: Instant::now(),
        }
    }

    /// A reading taken before a sandbox's disk may have changed, by a step
    /// that ended or a copy of it, never stands for it after.
    #[test]
    fn a_reading_from_an_earlier_generation_is_not_kept() {
        let mut meter = DiskMeter::default();
        let id = SandboxId(7);
        assert!(
            !meter.keep(id, reading(meter.generation(id))),
            "a sandbox never added has no generation to read in"
        );
        meter.changed(id);
        let before = reading(meter.generation(id));
        assert!(meter.keep(id, before));
        meter.changed(id);
        assert!(meter.resting.is_empty(), "a change drops the reading");
        assert!(!meter.keep(id, before), "nor is a late one kept");
        assert!(meter.keep(id, reading(meter.generation(id))));
    }

    /// A sandbox that leaves the host and comes back starts a generation
    /// its earlier stay never had, so a read still under way from then
    /// never stands for its disk.
    #[test]
    fn a_sandbox_back_on_the_host_meets_no_earlier_generation() {
        let mut meter = DiskMeter::default();
        let (id, other) = (SandboxId(7), SandboxId(8));
        meter.changed(id);
        let earlier = reading(meter.generation(id));
        meter.forget(id);
        meter.changed(other);
        meter.changed(id);
        assert!(!meter.keep(id, earlier));
        meter.forget(id);
        meter.changed(id);
        assert!(!meter.keep(id, earlier));
    }

    /// The loop waits for reads it needs at once no more than the budget,
    /// which refills with time.
    #[test]
    fn reads_the_loop_waits_for_are_budgeted() {
        let mut meter = DiskMeter::default();
        let start = Instant::now();
        assert_eq!(meter.budget(start), READ_NOW_BUDGET);
        meter.spend(READ_NOW_BUDGET);
        assert_eq!(meter.budget(start), Duration::ZERO);
        let later = start + Duration::from_millis(100);
        assert_eq!(meter.budget(later), Duration::from_millis(10));
        meter.spend(Duration::from_millis(4));
        assert_eq!(meter.budget(later), Duration::from_millis(6));
        assert_eq!(
            meter.budget(later + Duration::from_secs(10)),
            READ_NOW_BUDGET,
            "it refills no further than the budget"
        );
    }
}
