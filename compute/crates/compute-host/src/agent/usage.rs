//! Whether a running guest is busy: windows of its VM's processor use and
//! traffic, judged by the host's busy rule.
//!
//! A window starts afresh whenever the sandbox is not simply running, and
//! whenever a step starts for it, so the work of waking, pausing or saving
//! never counts, even when a whole pause and resume falls between two
//! readings. A checkpoint is the exception: its guest runs on while it
//! waits to capture, which can take as long as a lazy wake's hydration, and
//! again from its resume, so the step reads the VM throughout and lends the
//! agent those readings (see [`crate::step::Meter`]). The window open as it
//! began goes on; its last reading before the capture pauses the VM is
//! judged at once and ends the window, and the next window starts from the
//! first reading lent after the resume, without waiting for the agent's
//! next tick, so the capture's own work never counts as the guest's. As the
//! checkpoint ends, the window is judged at once again, so the core knows a
//! guest is busy before it picks the next step, even when the checkpoint
//! ends before the agent's next tick.
//!
//! Each signal counts only when it was read at both ends of a window, so
//! one that cannot be read leaves the other to decide alone. A sandbox none
//! of whose watched signals could be read counts as busy at once, whatever
//! its window: putting a working guest to sleep costs far more than keeping
//! an idle one awake a little longer. For the same reason a window judged
//! early, before its full length, counts: the busy rule is a rate, which a
//! part of a window shows too.

use std::time::Duration;

use super::BusyRule;
use crate::step::Reading;

/// The start of one VM's current activity window. Each reading is kept only
/// when the rule wants it and it worked, so one signal failing leaves the
/// other to judge alone.
#[derive(Clone, Copy, Debug)]
struct Window {
    incarnation: u64,
    started: tokio::time::Instant,
    /// Processor time so far.
    cpu: Option<Duration>,
    /// Traffic so far.
    io: Option<u64>,
    /// Whether nothing the rule watches could be read over the window
    /// before this one, so the sandbox counted as busy unseen.
    unseen: bool,
}

impl Window {
    /// The window that starts with `reading`, keeping what `rule` watches.
    fn starting(reading: &Reading, rule: BusyRule) -> Self {
        Self {
            incarnation: reading.incarnation,
            started: reading.at,
            cpu: reading.cpu.filter(|_| rule.watches_cpu()),
            io: reading.io.filter(|_| rule.watches_io()),
            unseen: false,
        }
    }

    /// Whether it holds nothing to judge by.
    fn blind(&self) -> bool {
        self.cpu.is_none() && self.io.is_none()
    }

    /// Judges what the guest did from this window's start to `later`'s:
    /// whether that counts as busy, and whether neither watched signal was
    /// read at both ends. None when the two cannot be compared: readings of
    /// different VM processes, or a window that began with nothing to
    /// judge by.
    fn judge(&self, later: &Self, rule: BusyRule) -> Option<(bool, bool)> {
        if self.incarnation != later.incarnation || self.blind() {
            return None;
        }
        let elapsed = later.started.duration_since(self.started);
        let used = self
            .cpu
            .zip(later.cpu)
            .map(|(before, after)| after.saturating_sub(before));
        let moved = self
            .io
            .zip(later.io)
            .map(|(before, after)| after.saturating_sub(before));
        let unseen = used.is_none() && moved.is_none() && watches(rule);
        let busy =
            unseen || rule.is_busy(used.unwrap_or(Duration::ZERO), moved.unwrap_or(0), elapsed);
        Some((busy, unseen))
    }
}

fn watches(rule: BusyRule) -> bool {
    rule.watches_cpu() || rule.watches_io()
}

/// What the agent knows of one sandbox's use: its open window, and the
/// latest reading a step holding its running VM lent.
#[derive(Debug, Default)]
pub(super) struct Usage {
    window: Option<Window>,
    lent: Option<Reading>,
}

impl Usage {
    /// A step starts for the sandbox: what its VM does from here is the
    /// step's work, not the guest's, so the window ends, unless the step
    /// lets the guest run on (`runs_on`) and lends readings of it.
    pub fn step_started(&mut self, runs_on: bool) {
        if !runs_on {
            self.window = None;
        }
        self.lent = None;
    }

    /// The sandbox does not simply run, or its VM could not be read.
    pub fn stopped(&mut self) {
        self.window = None;
    }

    /// Takes a reading the step holding the VM lent. One lent while no
    /// window is open, as the first after a checkpoint's resume is, starts
    /// the window at once. The last before it pauses the VM is judged at
    /// once and ends the window. Returns whether either judged the guest
    /// busy.
    pub fn lend(&mut self, reading: Reading, rule: Option<BusyRule>) -> bool {
        if !reading.last_before_pause {
            let busy = match rule {
                Some(rule) if self.window.is_none() => self.open(&reading, rule),
                _ => false,
            };
            self.lent = Some(reading);
            return busy;
        }
        let busy = rule.is_some_and(|rule| self.judge_now(&reading, rule));
        self.window = None;
        self.lent = None;
        busy
    }

    /// Starts the window at `reading`. Returns whether that alone makes the
    /// guest busy: nothing the rule watches could be read, now or at the
    /// end of any window, and a pause delay shorter than the window would
    /// otherwise let a working guest fall asleep first.
    fn open(&mut self, reading: &Reading, rule: BusyRule) -> bool {
        let mut fresh = Window::starting(reading, rule);
        fresh.unseen = watches(rule) && fresh.blind();
        self.window = Some(fresh);
        fresh.unseen
    }

    /// Takes the next reading by `rule` and returns whether the guest
    /// counts as busy: `own` is the agent's own reading, or none while a
    /// step holding the VM lends its own. Until such a step lent one, the
    /// window goes on as it was.
    pub fn sample(&mut self, own: Option<Reading>, rule: BusyRule) -> bool {
        let Some(reading) = own.or(self.lent) else {
            return false;
        };
        let mut fresh = Window::starting(&reading, rule);
        if watches(rule) && fresh.blind() {
            return self.open(&reading, rule);
        }
        let Some((window, (busy, unseen))) = self
            .window
            .and_then(|window| Some((window, window.judge(&fresh, rule)?)))
        else {
            // A window that began unreadable has nothing to compare
            // against; one starts now.
            return self.open(&reading, rule);
        };
        if fresh.started.duration_since(window.started) < rule.window {
            return false;
        }
        fresh.unseen = unseen;
        self.window = Some(fresh);
        busy
    }

    /// Judges the open window up to `reading` at once, however short it
    /// is, and leaves it open.
    pub fn judge_now(&self, reading: &Reading, rule: BusyRule) -> bool {
        self.window
            .and_then(|window| window.judge(&Window::starting(reading, rule), rule))
            .is_some_and(|(busy, _)| busy)
    }

    /// Whether nothing the rule watches could be read over the last window.
    pub fn unseen(&self) -> bool {
        self.window.is_some_and(|window| window.unseen)
    }
}

#[cfg(test)]
mod tests;
