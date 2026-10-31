//! The memory bounds the host asks of a running VM (ADR 24): its
//! `memory.low`, its request plus what the kernel compressed of it, and its
//! `memory.high`, past which the VM waits on its own allocations while the
//! kernel compresses its coldest pages.
//!
//! A `memory.high` alone takes nothing from a VM that does not allocate:
//! the kernel holds it there only as it reaches for more, and on kernels
//! that honour a non-blocking write not even while the write runs. An idle
//! sandbox held back first would keep all it borrowed. So the writer
//! reclaims down to the high itself (`memory.reclaim`), a step at a time.
//!
//! Each step is metered in swap slots. zswap takes a slot for every page
//! the kernel hands it, and a page it refuses because it does not compress
//! (random or compressed data) keeps its slot and stays in RAM, unmapped
//! from the VM, to be handed to it again: a reclaim of such memory goes on
//! scanning the same pages for as long as it frees a few others, which in
//! the lab was minutes, the VM faulting its own pages back all along. So
//! before each step the writer lets the VM hold one step more of swap than
//! it holds (`memory.swap.max`): once that is spent the kernel takes none
//! of its anonymous pages, for this reclaim or any other, and the step
//! ends with what it freed. A step that spent most of that swap on pages
//! zswap refused (slots taken less pages kept: `zswpout` and
//! `swpout_zero`) shows that what is left does not compress, or that zswap
//! has no room: the writer then closes the VM's swap, so that no reclaim,
//! the VM's own or the host's, scans that memory again until a later bound
//! tries it once more, a reset gives the VM back what it was launched
//! with, or the bound is lifted. The steps after it take only cache. Swap
//! is the writer's to meter only on a VM launched with it open: one that
//! may be compressed while it runs.
//!
//! Once a step showed that the VM's memory compresses, one step that
//! refused is not enough: the kernel walks a VM's pages coldest first, a
//! few of them may not compress among many that do, and the counters a
//! step reads lag what it did by a little. Closing the swap there would
//! leave the kernel nothing to take of a VM whose memory compresses, and
//! the host would end the program that borrowed it. So the swap of a VM
//! shown to compress closes only when two steps in a row refused, bounds
//! apart or not, or when one refused and brought it no lower; what does
//! not compress then costs it at most one step more.
//!
//! It never sets a high below what the VM holds before a step showed that
//! its memory compresses. Past its high every page the VM takes waits, the
//! longer the further past, up to two seconds for each few hundred
//! kilobytes, and the kernel reclaims from it first: a VM held below what
//! it holds stops when its pages do not compress, and its guest cannot
//! even answer a request to shrink. Once a step compressed, the writer
//! keeps the high a [`LEAD`]th below what the VM holds while it reclaims,
//! lowering it as the VM comes down: a VM that compresses pays for what it
//! takes meanwhile by compressing itself. Where the kernel takes no more,
//! the high goes back to what the VM holds: only its growth past that
//! waits, and the host, seeing it above its bound, asks its guest to
//! shrink. A new bound never raises the high above where it holds a VM
//! either, unless the bound itself is higher, so that a VM the kernel
//! could not compress does not grow by being bounded again: it starts
//! where the bound before settled, never at a lead a descent overtaken by
//! it left behind.
//!
//! The kernel counts a VM's compressed pages in what it holds, so each
//! page it compresses takes back only part of what it frees. A bound is
//! what the VM may hold uncompressed with what it had compressed when the
//! host read it: while bringing it down, the writer raises the high by
//! what the VM compressed since, so that it ends uncompressed where the
//! bound put it, never below, however well its pages compress.
//!
//! A descent can be slow to start: before the kernel compresses any of a
//! VM's pages it ages them, clearing what marks each as recently used,
//! and a VM that has just written gigabytes may take it many seconds of a
//! busy or nested host's time to age before the first megabytes compress,
//! then come down hundreds of megabytes a second. The host asks whether a
//! descent is under way ([`Bounds::descending`]), so that it does not take
//! a VM the kernel is still bringing down for one it cannot hold.
//!
//! One thread at a time works for a VM, and only on the latest bound asked:
//! one asked while it works replaces any not yet applied. A resume, a pause
//! or an adoption sets the VM's bounds back with [`Bounds::reset`], which
//! makes every bound asked before it stale, so a bound being applied as the
//! VM pauses or resumes can never land after it.

use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use crate::cgroup::{Cgroup, Swap};

/// Bytes reclaimed per step, and the swap a step may take: small enough
/// that a newer bound, a pause or a resume waits at most one step's work,
/// and that memory which does not compress costs at most one step's.
const RECLAIM_STEP: u64 = 64 << 20;

/// The least a step must bring the VM down by for the writer to try
/// another, unless it is the first to show that the VM's memory
/// compresses: less, and what is left is not the kernel's to take, or the
/// VM takes as fast as it is compressed.
const PROGRESS: u64 = 4 << 20;

/// How far below what a VM holds the writer sets its high while it brings
/// it down, once a step showed that its memory compresses: a
/// thirty-second. Past its high the kernel has the VM compress its own
/// pages for what it takes, and makes it wait about 64 s times the square
/// of how far past it is, as a share of the high, for every 256 KiB: here
/// at most about 60 ms, for as long as a step lasts. A VM growing as it is
/// brought down pays for it, and none ever stops.
const LEAD: u64 = 32;

/// What the writer reads and writes of a VM's group.
pub(super) trait Group {
    /// Bytes the group holds (`memory.current`).
    fn current(&self) -> io::Result<u64>;
    /// Bytes of that its compressed pages take (`memory.zswap.current`).
    fn compressed(&self) -> io::Result<u64>;
    /// Sets its `memory.low`.
    fn set_low(&self, bytes: u64) -> io::Result<()>;
    /// Sets its `memory.high`; `None` for none.
    fn set_high(&self, bytes: Option<u64>) -> io::Result<()>;
    /// Its swap slots; `None` on a kernel without swap.
    fn swap(&self) -> io::Result<Option<Swap>>;
    /// Sets its `memory.swap.max`; `None` for none.
    fn set_swap_max(&self, bytes: Option<u64>) -> io::Result<()>;
    /// Bytes of it the kernel has taken out of RAM so far without a disk.
    fn stored(&self) -> io::Result<u64>;
    /// Reclaims `bytes` from it: `false` when the kernel took less.
    fn reclaim(&self, bytes: u64) -> io::Result<bool>;
}

impl Group for Cgroup {
    fn current(&self) -> io::Result<u64> {
        self.memory_current()
    }

    fn compressed(&self) -> io::Result<u64> {
        self.memory_compressed()
    }

    fn set_low(&self, bytes: u64) -> io::Result<()> {
        self.set_memory_low(bytes)
    }

    fn set_high(&self, bytes: Option<u64>) -> io::Result<()> {
        self.set_memory_high(bytes)
    }

    fn swap(&self) -> io::Result<Option<Swap>> {
        Cgroup::swap(self)
    }

    fn set_swap_max(&self, bytes: Option<u64>) -> io::Result<()> {
        Cgroup::set_swap_max(self, bytes)
    }

    fn stored(&self) -> io::Result<u64> {
        self.memory_stored()
    }

    fn reclaim(&self, bytes: u64) -> io::Result<bool> {
        Cgroup::reclaim(self, bytes)
    }
}

/// A running VM's memory bounds and the writer applying them.
#[derive(Debug, Default)]
pub(super) struct Bounds {
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    /// Raised by every reset: a bound asked under an earlier one is stale.
    epoch: u64,
    /// The latest bound asked and not yet applied: `memory.low`, and
    /// `memory.high` or `None` for none.
    wanted: Option<(u64, Option<u64>)>,
    /// Whether a writer thread is at work.
    working: bool,
    /// Whether it is bringing the VM down toward a bound's high: a descent
    /// began and has not ended, or ended with a newer bound to apply.
    descending: bool,
    /// What the writer did with the VM's swap since the latest reset.
    meter: Meter,
    /// The high the latest bound settled at, `None` for none: where a
    /// descent holds the VM, never the lead below what it holds that a
    /// descent overtaken by a newer bound leaves behind.
    settled: Option<u64>,
    /// What the steps since the latest reset showed of the VM's memory.
    shown: Shown,
}

/// What a descent's steps showed of a VM's memory since the latest reset.
#[derive(Clone, Copy, Debug, Default)]
struct Shown {
    /// Whether a step showed that it compresses: zswap kept most of what it
    /// was handed.
    compresses: bool,
    /// Whether the latest step spent most of its swap on pages zswap
    /// refused.
    refused: bool,
}

/// What the writer did with a VM's swap (`memory.swap.max`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Meter {
    /// Nothing: it is what the VM was launched or last reset with, or open
    /// again.
    #[default]
    Untouched,
    /// One step more than the VM held as a step began.
    Metered,
    /// Closed: what was left of the VM's memory did not compress.
    Closed,
}

impl Bounds {
    /// Asks for `low` and `high` on `group`, applied in the background.
    pub(super) fn ask<G>(self: &Arc<Self>, group: &G, low: u64, high: Option<u64>)
    where
        G: Group + Clone + Send + 'static,
    {
        let mut state = self.lock();
        state.wanted = Some((low, high));
        if state.working {
            return;
        }
        state.working = true;
        drop(state);
        let (bounds, group) = (Arc::clone(self), group.clone());
        std::thread::spawn(move || bounds.work(&group));
    }

    /// Sets the VM's bounds back with `apply`, after any write under way
    /// and before any asked later: what was asked before is dropped. Its
    /// swap is `apply`'s to set back too.
    pub(super) fn reset(&self, apply: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
        let mut state = self.lock();
        state.epoch += 1;
        state.wanted = None;
        state.meter = Meter::Untouched;
        state.settled = None;
        state.shown = Shown::default();
        apply()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the writer is still bringing the VM down toward the high of
    /// the latest bound: a descent began and has not ended, so the kernel
    /// has not yet shown that it can take no more.
    pub(super) fn descending(&self) -> bool {
        self.lock().descending
    }

    /// Applies the latest bound asked, then reclaims down to its high,
    /// until none is left to apply. A bound still wanted was asked after
    /// the latest reset, which drops all asked before it.
    fn work(&self, group: &impl Group) {
        loop {
            let (epoch, high, at) = {
                let mut state = self.lock();
                let Some((low, high)) = state.wanted.take() else {
                    state.working = false;
                    state.descending = false;
                    return;
                };
                // Under the lock, so a reset cannot run between the check
                // and the write. Both writes return as soon as they apply:
                // the high is never below what the VM holds.
                let settled = state.settled;
                match first(group, low, high, settled) {
                    Ok(None) => {
                        // Lifted, so its swap opens again too.
                        state.settled = None;
                        state.descending = false;
                        if state.meter != Meter::Untouched && group.set_swap_max(None).is_ok() {
                            state.meter = Meter::Untouched;
                        }
                        continue;
                    }
                    Ok(Some(at)) => {
                        state.settled = Some(at);
                        let high = high.unwrap_or(at);
                        state.descending = at > high;
                        (state.epoch, high, at)
                    }
                    Err(_) => {
                        // The VM is gone, and its group with it: nothing
                        // is left to bound.
                        state.wanted = None;
                        state.working = false;
                        state.descending = false;
                        return;
                    }
                }
            };
            self.descend(group, epoch, high, at);
        }
    }

    /// Brings `group` down toward `high` from `start`, the high it was
    /// given, a step at a time: each step sets its `memory.high` to what it
    /// holds, or a [`LEAD`]th below once a step compressed, so that what
    /// the VM takes meanwhile it compresses of its own and waits for, then
    /// meters its swap and reclaims a step. Ends once its high is `high`,
    /// when a newer bound or a reset comes, or when the kernel takes no
    /// more, which sets its high back to what it holds, never above
    /// `start`. A step that spent most of its swap on pages zswap refused
    /// closes the VM's swap, and the steps after it take only its cache.
    /// `high` grows by what the VM compressed since the descent began (see
    /// the module).
    fn descend(&self, group: &impl Group, epoch: u64, high: u64, start: u64) {
        let Ok(zswapped) = group.compressed() else {
            return;
        };
        let meters = self.meters(group);
        let mut at = start;
        // Whether the step before showed that the VM's memory compresses.
        let mut proven = false;
        // Whether a step closed its swap.
        let mut closed = false;
        loop {
            let Ok(before) = group.current() else {
                return;
            };
            let grown = group
                .compressed()
                .map_or(0, |now| now.saturating_sub(zswapped));
            let target = high.saturating_add(grown);
            if at <= target || before <= target {
                // There, or below it by what the VM compressed since: its
                // high goes to the bound in what it holds uncompressed, and
                // swap a step metered opens again.
                if self.hold(group, epoch, target, &mut at, true) && meters {
                    self.open_metered(group, epoch);
                }
                return;
            }
            let lead = if proven { before / LEAD } else { 0 };
            let next = target.max(at.min(before.saturating_sub(lead)));
            if !self.hold(group, epoch, next, &mut at, false) {
                return;
            }
            if meters && !closed && !self.set_swap(group, epoch, Meter::Metered) {
                return;
            }
            let slots = swap_used(group);
            let stored = group.stored().unwrap_or(0);
            let asked = before.saturating_sub(target).min(RECLAIM_STEP);
            let took = matches!(group.reclaim(asked), Ok(true));
            let Ok(after) = group.current() else {
                return;
            };
            // By this reclaim or any other, the VM's own included.
            let kept = group.stored().map_or(0, |now| now.saturating_sub(stored));
            let refused = swap_used(group).saturating_sub(slots).saturating_sub(kept);
            let compressing = took || kept >= asked / 2;
            let refusing = meters && !closed && refused >= RECLAIM_STEP / 2;
            let progressed = before.saturating_sub(after) >= PROGRESS;
            if self.shows_refusal(epoch, refusing, compressing, progressed) {
                // Most of the step's swap went to pages zswap refused: what
                // is left of the VM's memory does not compress, or zswap
                // has no room. Nothing scans it again.
                if !self.set_swap(group, epoch, Meter::Closed) {
                    return;
                }
                closed = true;
            }
            if !progressed && (proven || !compressing) {
                // What is left does not compress, zswap has no room, or the
                // VM takes as fast as it is compressed: below what it holds
                // it would only wait.
                self.hold(group, epoch, target.max(start.min(after)), &mut at, true);
                if meters && !closed {
                    self.set_swap(group, epoch, Meter::Untouched);
                }
                return;
            }
            proven = compressing;
        }
    }

    /// Whether the writer meters `group`'s swap: one launched with it open,
    /// which the writer may since have metered or closed.
    fn meters(&self, group: &impl Group) -> bool {
        let state = self.lock();
        match state.meter {
            Meter::Untouched => matches!(group.swap(), Ok(Some(Swap { max: None, .. }))),
            Meter::Metered | Meter::Closed => true,
        }
    }

    /// Records what a step of the bound of `epoch` showed of the VM's
    /// memory, and whether that shows its swap should close: it spent most
    /// of its swap on pages zswap refused (`refusing`), and no step before
    /// it showed that the VM's memory compresses, the step before it
    /// refused too, or it brought the VM down by less than [`PROGRESS`].
    /// Nothing is recorded after a reset.
    fn shows_refusal(
        &self,
        epoch: u64,
        refusing: bool,
        compressing: bool,
        progressed: bool,
    ) -> bool {
        let mut state = self.lock();
        if state.epoch != epoch {
            return false;
        }
        let shown = &mut state.shown;
        let close = refusing && (!shown.compresses || shown.refused || !progressed);
        shown.refused = refusing;
        shown.compresses |= compressing && !refusing;
        close
    }

    /// Sets `group`'s swap to `meter` unless the bound of `epoch` was
    /// overtaken: open, closed, or what it holds and one step more.
    /// Returns whether it is set.
    fn set_swap(&self, group: &impl Group, epoch: u64, meter: Meter) -> bool {
        let mut state = self.lock();
        if state.stale(epoch) {
            return false;
        }
        let max = match meter {
            Meter::Untouched => Ok(None),
            Meter::Closed => Ok(Some(0)),
            Meter::Metered => group.swap().map(|swap| {
                Some(
                    swap.map_or(0, |swap| swap.used)
                        .saturating_add(RECLAIM_STEP),
                )
            }),
        };
        if max.and_then(|max| group.set_swap_max(max)).is_err() {
            return false;
        }
        state.meter = meter;
        true
    }

    /// Opens `group`'s swap again if a step metered it; swap the writer
    /// closed stays closed.
    fn open_metered(&self, group: &impl Group, epoch: u64) {
        if self.lock().meter == Meter::Metered {
            self.set_swap(group, epoch, Meter::Untouched);
        }
    }

    /// Sets `group`'s `memory.high` to `bytes`, kept in `at`, unless the
    /// bound of `epoch` was overtaken, and where the bound `settles`, as
    /// where a descent ends. Returns whether it is set.
    fn hold(
        &self,
        group: &impl Group,
        epoch: u64,
        bytes: u64,
        at: &mut u64,
        settles: bool,
    ) -> bool {
        let mut state = self.lock();
        if state.stale(epoch) {
            return false;
        }
        if bytes != *at {
            if group.set_high(Some(bytes)).is_err() {
                return false;
            }
            *at = bytes;
        }
        if settles {
            state.settled = Some(bytes);
        }
        true
    }
}

impl State {
    /// Whether a bound asked under `epoch` was overtaken: by a reset, or
    /// by a newer bound waiting.
    fn stale(&self, epoch: u64) -> bool {
        self.epoch != epoch || self.wanted.is_some()
    }
}

/// Sets `low` on `group`, and the high a bound of `high` starts at: none
/// for none, else `high`, or what the VM holds if that is more, but never
/// more than the high the bound before `settled` at unless `high` is.
/// Returns that high, or `None` for none.
fn first(
    group: &impl Group,
    low: u64,
    high: Option<u64>,
    settled: Option<u64>,
) -> io::Result<Option<u64>> {
    group.set_low(low)?;
    let Some(high) = high else {
        group.set_high(None)?;
        return Ok(None);
    };
    let at = high.max(settled.unwrap_or(u64::MAX).min(group.current()?));
    group.set_high(Some(at))?;
    Ok(Some(at))
}

/// Bytes of swap slots `group` holds; 0 without swap.
fn swap_used(group: &impl Group) -> u64 {
    group.swap().ok().flatten().map_or(0, |swap| swap.used)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, Instant};

    use super::*;

    /// A group's files as a fake: `memory.current` as given, the rest
    /// written by the code under test.
    fn group(current: u64) -> (tempfile::TempDir, Cgroup) {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("vm");
        fs::create_dir(&path).unwrap();
        for (file, text) in [
            ("memory.current", current.to_string()),
            ("memory.low", "0".into()),
            ("memory.high", "max".into()),
        ] {
            fs::write(path.join(file), text).unwrap();
        }
        fs::write(parent.path().join("memory.low"), "0").unwrap();
        (parent, Cgroup::at(path))
    }

    fn read(cgroup: &Cgroup, file: &str) -> String {
        fs::read_to_string(cgroup.path().join(file)).unwrap()
    }

    fn settled(bounds: &Bounds) {
        let start = Instant::now();
        while bounds.lock().working {
            assert!(start.elapsed() < Duration::from_secs(5), "never settled");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_bound_is_applied_with_its_parent_protecting_it() {
        let (_parent, cgroup) = group(1 << 30);
        let bounds = Arc::new(Bounds::default());
        bounds.ask(&cgroup, 512 << 20, None);
        settled(&bounds);
        assert_eq!(read(&cgroup, "memory.low"), (512_u64 << 20).to_string());
        assert_eq!(read(&cgroup, "memory.high"), "max");
        let parent = Cgroup::at(cgroup.path().parent().unwrap());
        assert_eq!(read(&parent, "memory.low"), (512_u64 << 20).to_string());
    }

    #[test]
    fn a_reset_drops_every_bound_asked_before_it() {
        let (_parent, cgroup) = group(1 << 30);
        let bounds = Arc::new(Bounds::default());
        {
            // As if a writer were at work: what is asked waits for it.
            bounds.lock().working = true;
        }
        bounds.ask(&cgroup, 3 << 30, Some(4 << 30));
        bounds
            .reset(|| fs::write(cgroup.path().join("memory.low"), "1024"))
            .unwrap();
        assert_eq!(bounds.lock().wanted, None);
        // The writer finds nothing left to apply.
        bounds.work(&cgroup);
        assert_eq!(read(&cgroup, "memory.low"), "1024");
        assert!(!bounds.lock().working);
    }

    const MIB: u64 = 1 << 20;
    const GIB: u64 = 1 << 30;

    /// A VM's group as the kernel would keep it: it holds `current` bytes,
    /// of which reclaim can take `takeable`, and every high written is
    /// kept with what the VM held as it was. The rest does not compress:
    /// each page of it reclaim reaches takes a swap slot and stays. With a
    /// `ratio`, what reclaim takes is compressed to a `ratio`th of it and
    /// stays charged.
    #[derive(Clone, Default)]
    struct Vm(Arc<Mutex<Kernel>>);

    #[derive(Default)]
    struct Kernel {
        current: u64,
        takeable: u64,
        /// Bytes of it that do not compress.
        refusing: u64,
        /// Bytes of its cache reclaim drops, taking no swap.
        cache: u64,
        ratio: u64,
        compressed: u64,
        low: u64,
        high: Option<u64>,
        /// Its swap; `None` for a kernel without.
        swap: Option<Swap>,
        /// Bytes taken out of RAM so far.
        stored: u64,
        /// Bytes of pages reclaim handed zswap that it refused.
        refused: u64,
        /// Bytes the VM takes again after each reclaim.
        grows: u64,
        /// The reclaims, counted from 0, in which zswap refuses five
        /// eighths of what it is handed of memory that otherwise
        /// compresses: a run of pages that do not, among many that do.
        hiccups: Vec<usize>,
        /// Each high written, and what the VM held then.
        highs: Vec<(Option<u64>, u64)>,
        /// The swap each reclaim could take: `None` for no limit.
        budgets: Vec<Option<u64>>,
    }

    impl Vm {
        fn new(current: u64, takeable: u64) -> Self {
            Self(Arc::new(Mutex::new(Kernel {
                current,
                takeable,
                refusing: current - takeable,
                swap: Some(Swap { used: 0, max: None }),
                ..Kernel::default()
            })))
        }

        fn compressing(current: u64, takeable: u64, ratio: u64) -> Self {
            let vm = Self::new(current, takeable);
            vm.kernel().ratio = ratio;
            vm
        }

        fn kernel(&self) -> std::sync::MutexGuard<'_, Kernel> {
            self.0.lock().unwrap()
        }

        fn swap_max(&self) -> Option<u64> {
            self.kernel().swap.unwrap().max
        }
    }

    impl Group for Vm {
        fn current(&self) -> io::Result<u64> {
            Ok(self.kernel().current)
        }

        fn compressed(&self) -> io::Result<u64> {
            Ok(self.kernel().compressed)
        }

        fn set_low(&self, bytes: u64) -> io::Result<()> {
            self.kernel().low = bytes;
            Ok(())
        }

        fn set_high(&self, bytes: Option<u64>) -> io::Result<()> {
            let mut kernel = self.kernel();
            kernel.high = bytes;
            let held = kernel.current;
            kernel.highs.push((bytes, held));
            Ok(())
        }

        fn swap(&self) -> io::Result<Option<Swap>> {
            Ok(self.kernel().swap)
        }

        fn set_swap_max(&self, bytes: Option<u64>) -> io::Result<()> {
            let mut kernel = self.kernel();
            kernel.swap.as_mut().ok_or(io::ErrorKind::NotFound)?.max = bytes;
            Ok(())
        }

        fn stored(&self) -> io::Result<u64> {
            Ok(self.kernel().stored)
        }

        fn reclaim(&self, bytes: u64) -> io::Result<bool> {
            let mut kernel = self.kernel();
            let budget = kernel.swap.map_or(Some(0), |swap| {
                swap.max.map(|max| max.saturating_sub(swap.used))
            });
            kernel.budgets.push(budget);
            let room = budget.unwrap_or(u64::MAX);
            let hiccup = kernel.hiccups.contains(&(kernel.budgets.len() - 1));
            let (took, refused) = if hiccup {
                let handed = bytes.min(kernel.takeable).min(room);
                (handed - handed * 5 / 8, handed * 5 / 8)
            } else {
                let took = bytes.min(kernel.takeable).min(room);
                (took, (bytes - took).min(room - took).min(kernel.refusing))
            };
            let dropped = (bytes - took).min(kernel.cache);
            kernel.takeable -= took;
            kernel.cache -= dropped;
            let kept = took.checked_div(kernel.ratio).unwrap_or(0);
            kernel.compressed += kept;
            kernel.current -= took - kept + dropped;
            kernel.current += kernel.grows;
            kernel.stored += took;
            kernel.refused += refused;
            if let Some(swap) = &mut kernel.swap {
                swap.used += took + refused;
            }
            Ok(took + dropped == bytes)
        }
    }

    /// Applies `low` and `high` to `vm` before returning.
    fn apply(bounds: &Bounds, vm: &Vm, low: u64, high: Option<u64>) {
        {
            let mut state = bounds.lock();
            state.wanted = Some((low, high));
            state.working = true;
        }
        bounds.work(vm);
        assert!(!bounds.lock().working);
    }

    /// Every high was written at most a lead below what the VM held then.
    fn never_far_below_what_it_held(vm: &Vm) {
        for &(high, held) in &vm.kernel().highs {
            assert!(
                high.is_none_or(|high| high >= held - held / LEAD),
                "{high:?} below {held}"
            );
        }
    }

    /// Every high was written at or above what the VM held then.
    fn never_below_what_it_held(vm: &Vm) {
        for &(high, held) in &vm.kernel().highs {
            assert!(
                high.is_none_or(|high| high >= held),
                "{high:?} below {held}"
            );
        }
    }

    #[test]
    fn a_vm_whose_memory_compresses_is_brought_down_to_its_high_a_step_at_a_time() {
        let vm = Vm::new(3 * GIB, 2 * GIB);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!(
            (kernel.current, kernel.low, kernel.high),
            (2 * GIB, GIB, Some(2 * GIB))
        );
        // It starts where the VM is, and once a step compressed it comes
        // down a lead below it as reclaim takes it.
        assert_eq!(kernel.highs.first(), Some(&(Some(3 * GIB), 3 * GIB)));
        let held = 3 * GIB - RECLAIM_STEP;
        assert_eq!(kernel.highs[1], (Some(held - held / LEAD), held));
        // Each step could take one step of swap, and it is open again.
        assert!(
            kernel
                .budgets
                .iter()
                .all(|&budget| budget == Some(RECLAIM_STEP))
        );
        assert_eq!(kernel.swap.unwrap().max, None);
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn a_vm_whose_memory_does_not_compress_keeps_its_high_where_the_kernel_holds_it() {
        // Reclaim takes 300 MiB of the 1 GiB it is asked, and then nothing.
        let vm = Vm::new(3 * GIB, 300 * MIB);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!(kernel.current, 3 * GIB - 300 * MIB);
        // Its high is what it holds, not the 2 GiB asked: only what it
        // takes past that waits.
        assert_eq!(kernel.high, Some(3 * GIB - 300 * MIB));
        assert_eq!(kernel.low, GIB);
        // What does not compress cost it no more than a step and a part,
        // and its swap is closed so that nothing scans it again.
        assert!(kernel.refused <= 2 * RECLAIM_STEP, "{}", kernel.refused);
        assert_eq!(kernel.swap.unwrap().max, Some(0));
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn a_vm_whose_memory_does_not_compress_is_never_held_below_it_nor_scanned_again() {
        // Random data: every page reclaim hands zswap is refused.
        let vm = Vm::new(3 * GIB, 0);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        // One step's swap is all it cost, and then its swap closed.
        assert_eq!(kernel.budgets, [Some(RECLAIM_STEP)]);
        assert_eq!(kernel.refused, RECLAIM_STEP);
        assert_eq!(kernel.swap.unwrap().max, Some(0));
        // Its high stayed where it holds it, so that its guest can answer.
        assert_eq!(kernel.high, Some(3 * GIB));
        drop(kernel);
        never_below_what_it_held(&vm);
    }

    #[test]
    fn a_vm_that_takes_as_fast_as_it_is_compressed_keeps_its_swap_and_its_high() {
        let vm = Vm::new(3 * GIB, 3 * GIB);
        vm.kernel().grows = RECLAIM_STEP;
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        // A step showed it compresses, and one a lead below it brought it
        // no lower: its high goes back to what it holds, and the kernel
        // may still compress it for what it takes.
        assert_eq!(kernel.budgets.len(), 2);
        assert_eq!(kernel.high, Some(3 * GIB));
        assert_eq!(kernel.swap.unwrap().max, None);
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn one_step_that_meets_memory_that_does_not_compress_leaves_the_swap_of_a_vm_that_does() {
        // Its third step meets a run of pages that do not compress.
        let vm = Vm::new(3 * GIB, 2 * GIB);
        vm.kernel().hiccups = vec![2];
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        // It is brought down all the way, and its swap is open again.
        assert_eq!((kernel.current, kernel.high), (2 * GIB, Some(2 * GIB)));
        assert_eq!(kernel.swap.unwrap().max, None);
        assert!(
            kernel
                .budgets
                .iter()
                .all(|&budget| budget == Some(RECLAIM_STEP))
        );
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn what_compressed_under_an_earlier_bound_still_counts_under_a_later_one() {
        // Bounds come a second apart, and each brings a descent: the first
        // step of a later one meeting pages that do not compress does not
        // close the swap of a VM an earlier one compressed.
        let vm = Vm::new(3 * GIB, 2 * GIB);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(3 * GIB - 2 * RECLAIM_STEP));
        let steps = vm.kernel().budgets.len();
        vm.kernel().hiccups = vec![steps];
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!((kernel.current, kernel.high), (2 * GIB, Some(2 * GIB)));
        assert_eq!(kernel.swap.unwrap().max, None);
    }

    #[test]
    fn two_steps_in_a_row_that_refuse_close_the_swap_of_a_vm_that_compressed() {
        // Two gigabytes compress; then two steps in a row meet memory that
        // does not, as when what compresses was all taken.
        let vm = Vm::new(4 * GIB, 2 * GIB);
        vm.kernel().hiccups = vec![2, 3];
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!(kernel.swap.unwrap().max, Some(0), "closed");
        // The second step closed it, and nothing scanned it after.
        assert_eq!(kernel.budgets.len(), 5, "{:?}", kernel.budgets);
        assert_eq!(kernel.high, Some(kernel.current));
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn a_reset_forgets_that_the_memory_of_a_vm_compressed() {
        let vm = Vm::new(3 * GIB, 2 * GIB);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(3 * GIB - 2 * RECLAIM_STEP));
        // A pause and a resume: what its memory held then says nothing of
        // what it holds now.
        bounds.reset(|| Ok(())).unwrap();
        let steps = vm.kernel().budgets.len();
        vm.kernel().hiccups = vec![steps];
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        assert_eq!(vm.swap_max(), Some(0), "closed by its first step");
    }

    #[test]
    fn the_swap_of_a_vm_launched_without_it_is_left_alone() {
        // A VM guaranteed all its memory never borrows: no swap at all.
        let vm = Vm::new(3 * GIB, 2 * GIB);
        vm.kernel().swap = Some(Swap {
            used: 0,
            max: Some(0),
        });
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        apply(&bounds, &vm, GIB, None);
        assert_eq!(vm.swap_max(), Some(0));
        assert_eq!(vm.kernel().stored, 0);
    }

    #[test]
    fn a_reset_gives_the_vm_back_the_swap_it_was_launched_with() {
        let vm = Vm::new(3 * GIB, 0);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        assert_eq!(vm.swap_max(), Some(0), "closed");
        // A pause sets it back: from then on it is not the writer's to
        // open, even once the bound is lifted.
        bounds.reset(|| vm.set_swap_max(Some(0))).unwrap();
        apply(&bounds, &vm, GIB, None);
        assert_eq!(vm.swap_max(), Some(0));
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        assert_eq!(vm.swap_max(), Some(0));
        assert_eq!(
            vm.kernel().refused,
            RECLAIM_STEP,
            "nothing more was scanned"
        );
    }

    #[test]
    fn a_vm_with_cache_and_memory_that_does_not_compress_spends_one_step_on_it() {
        // Random data and a gigabyte of cache: every step drops cache, and
        // the first one shows what is left does not compress.
        let vm = Vm::new(3 * GIB, 0);
        {
            let mut kernel = vm.kernel();
            kernel.cache = GIB;
            kernel.refusing = 2 * GIB;
        }
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!((kernel.current, kernel.high), (2 * GIB, Some(2 * GIB)));
        assert_eq!(kernel.refused, RECLAIM_STEP);
        assert_eq!(kernel.swap.unwrap().max, Some(0));
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn a_bound_starts_where_the_one_before_settled_never_at_a_lead_left_behind() {
        // A descent overtaken by a newer bound left the high a lead below
        // what the VM holds; it had settled at what the VM held.
        let vm = Vm::new(3 * GIB, 0);
        vm.kernel().high = Some(3 * GIB - 3 * GIB / LEAD);
        let bounds = Bounds::default();
        bounds.lock().settled = Some(3 * GIB);
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        assert_eq!(vm.kernel().high, Some(3 * GIB));
        never_below_what_it_held(&vm);
    }

    #[test]
    fn a_vm_brought_down_keeps_uncompressed_what_its_bound_lets_it() {
        // Its pages compress to a quarter, and stay charged to it: to hold
        // 2 GiB less it would have to compress 8/3 GiB.
        let vm = Vm::compressing(4 * GIB, 4 * GIB, 4);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        let uncompressed = kernel.current - kernel.compressed;
        // It compressed the 2 GiB above its bound, which take 512 MiB: it
        // keeps the 2 GiB the bound lets it, and its high is that and what
        // it compressed.
        assert_eq!(uncompressed, 2 * GIB);
        assert_eq!(kernel.compressed, 512 * MIB);
        assert_eq!(kernel.high, Some(2 * GIB + kernel.compressed));
        assert_eq!(kernel.swap.unwrap().max, None);
        drop(kernel);
        never_far_below_what_it_held(&vm);
    }

    #[test]
    fn bounding_again_never_lets_a_vm_the_kernel_could_not_hold_grow() {
        let vm = Vm::new(3 * GIB, 0);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        assert_eq!(vm.kernel().high, Some(3 * GIB));
        // It grew past its high, slowed; a lower bound, or one between
        // that high and what it holds now, keeps the high where it was,
        // and tries its memory once more for a step at most.
        vm.kernel().current = 3 * GIB + 200 * MIB;
        apply(&bounds, &vm, GIB, Some(GIB + GIB / 2));
        assert_eq!(vm.kernel().high, Some(3 * GIB));
        assert_eq!(vm.kernel().refused, 2 * RECLAIM_STEP);
        apply(&bounds, &vm, GIB, Some(2 * GIB + GIB / 2));
        assert_eq!(vm.kernel().high, Some(3 * GIB));
        // A bound above it raises it; its swap stays closed.
        apply(&bounds, &vm, GIB, Some(3 * GIB + 100 * MIB));
        assert_eq!(vm.kernel().high, Some(3 * GIB + 100 * MIB));
        assert_eq!(vm.swap_max(), Some(0));
        // No bound lifts it, and opens its swap again.
        apply(&bounds, &vm, GIB, None);
        assert_eq!(vm.kernel().high, None);
        assert_eq!(vm.swap_max(), None);
    }

    #[test]
    fn a_vm_within_its_bound_gets_it_at_once() {
        let vm = Vm::new(GIB, GIB);
        let bounds = Bounds::default();
        apply(&bounds, &vm, GIB, Some(2 * GIB));
        let kernel = vm.kernel();
        assert_eq!(kernel.highs, [(Some(2 * GIB), GIB)]);
        assert_eq!(kernel.current, GIB, "nothing is reclaimed");
        assert_eq!(kernel.budgets, Vec::<Option<u64>>::new());
        assert_eq!(kernel.swap.unwrap().max, None);
    }

    #[test]
    fn a_reset_during_a_descent_ends_it() {
        let vm = Vm::new(3 * GIB, 2 * GIB);
        let bounds = Bounds::default();
        {
            let mut state = bounds.lock();
            state.wanted = Some((GIB, Some(2 * GIB)));
            state.working = true;
        }
        // The first high is written, then the VM pauses before a step.
        let (epoch, high, at) = {
            let mut state = bounds.lock();
            let (low, high) = state.wanted.take().unwrap();
            let at = first(&vm, low, high, None).unwrap().unwrap();
            (state.epoch, high.unwrap(), at)
        };
        bounds.reset(|| vm.set_high(None)).unwrap();
        bounds.descend(&vm, epoch, high, at);
        assert_eq!(vm.kernel().high, None, "the reset's high stays");
    }

    /// A VM's group that records, at each reclaim, whether its writer says
    /// it is bringing the VM down.
    struct Watched<'a> {
        vm: Vm,
        bounds: &'a Bounds,
        seen: Mutex<Vec<bool>>,
    }

    impl Group for Watched<'_> {
        fn current(&self) -> io::Result<u64> {
            self.vm.current()
        }

        fn compressed(&self) -> io::Result<u64> {
            self.vm.compressed()
        }

        fn set_low(&self, bytes: u64) -> io::Result<()> {
            self.vm.set_low(bytes)
        }

        fn set_high(&self, bytes: Option<u64>) -> io::Result<()> {
            self.vm.set_high(bytes)
        }

        fn swap(&self) -> io::Result<Option<Swap>> {
            self.vm.swap()
        }

        fn set_swap_max(&self, bytes: Option<u64>) -> io::Result<()> {
            self.vm.set_swap_max(bytes)
        }

        fn stored(&self) -> io::Result<u64> {
            self.vm.stored()
        }

        fn reclaim(&self, bytes: u64) -> io::Result<bool> {
            self.seen.lock().unwrap().push(self.bounds.descending());
            self.vm.reclaim(bytes)
        }
    }

    /// Has `bounds` apply `low` and `high` to `watched` before returning.
    fn apply_watched(bounds: &Bounds, watched: &Watched<'_>, low: u64, high: Option<u64>) {
        {
            let mut state = bounds.lock();
            state.wanted = Some((low, high));
            state.working = true;
        }
        bounds.work(watched);
        assert!(!bounds.lock().working);
    }

    #[test]
    fn a_descent_says_it_is_under_way_until_it_ends() {
        let bounds = Bounds::default();
        let watched = Watched {
            vm: Vm::compressing(3 * GIB, 2 * GIB, 3),
            bounds: &bounds,
            seen: Mutex::default(),
        };
        assert!(!bounds.descending());
        // A bound above what the VM holds asks no descent.
        apply_watched(&bounds, &watched, GIB, Some(4 * GIB));
        assert!(watched.seen.lock().unwrap().is_empty());
        assert!(!bounds.descending());
        // A bound below: every step of the way it says so, and no longer
        // once the VM is there.
        apply_watched(&bounds, &watched, GIB, Some(2 * GIB));
        let seen = watched.seen.lock().unwrap().clone();
        assert!(
            !seen.is_empty() && seen.iter().all(|&under_way| under_way),
            "{seen:?}"
        );
        assert!(watched.vm.current().unwrap() <= 2 * GIB + watched.vm.compressed().unwrap());
        assert!(!bounds.descending());
    }
}
