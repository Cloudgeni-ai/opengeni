//! The guard: what stops a host's VMs when its lease runs out, whatever
//! happens to the agent.
//!
//! The guard is a small process of its own on every host with a lease. It
//! reads the lease's deadline from a file the agent writes in `/run`, and
//! steps this machine every 100 ms:
//!
//! - a second before the deadline it asks the kernel to freeze the cgroup
//!   that holds every VM;
//! - from the deadline, until the kernel reports the VMs frozen or gone,
//!   it kills every process in that cgroup;
//! - while the deadline is further off, it thaws the cgroup if anything
//!   froze it.
//!
//! Each step decides from what the kernel reports alone, not from what an
//! earlier step asked for, so a guard that restarts, after one that froze
//! the VMs and died, picks up where that one left off.
//!
//! Freezing and killing both complete asynchronously, and the guard itself
//! can stall, so it also holds the kernel's watchdog: it feeds it only
//! while the lease is valid or the VMs are known to have stopped. If the
//! guard stalls, dies, or cannot stop the VMs, the watchdog reboots the
//! machine its timeout later, which stops them for certain
//! ([`crate::LeaseTerms::needed_margin`] keeps that inside the service's
//! margin).
//!
//! The watchdog counts on a clock that stops while the machine is
//! suspended, and the lease on one that does not, so a machine resumed
//! after its deadline would run its VMs until the guard's next step. The
//! host's sleep hook prevents that: before a suspend it marks one under
//! way (the guard then treats the lease as run out) and waits for the VMs
//! to freeze; it lifts the mark after the resume, and the guard thaws them
//! only if the lease is still valid then.

use core::time::Duration;

use compute_core::At;

/// Where the VMs are, as the kernel reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Vms {
    /// They run.
    Running,
    /// A freeze was asked for and has not completed yet.
    Freezing,
    /// Frozen: no VM runs.
    Frozen,
    /// Every VM process is gone.
    Gone,
}

/// What the guard asks of the kernel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GuardAction {
    /// Freeze the VMs' cgroup.
    Freeze,
    /// Kill every process in the VMs' cgroup; asked again on every step
    /// until the cgroup is empty.
    Kill,
    /// Thaw the VMs' cgroup.
    Thaw,
}

/// What the guard sees when it steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "four independent kernel and hook readings, each a flag in its own file"
)]
pub struct Observed {
    /// A freeze is asked for (`cgroup.freeze` reads `1`), whoever asked.
    pub freezing: bool,
    /// The kernel reports the cgroup frozen (`cgroup.events`: `frozen 1`).
    pub frozen: bool,
    /// No process is left in the cgroup (`cgroup.events`: `populated 0`).
    pub empty: bool,
    /// The sleep hook marked a suspend under way.
    pub suspending: bool,
}

impl Observed {
    /// Where the VMs are.
    #[must_use]
    pub const fn vms(self) -> Vms {
        if self.empty {
            Vms::Gone
        } else if self.frozen {
            Vms::Frozen
        } else if self.freezing {
            Vms::Freezing
        } else {
            Vms::Running
        }
    }

    /// Whether no VM runs.
    #[must_use]
    pub const fn stopped(self) -> bool {
        self.frozen || self.empty
    }
}

/// One step's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GuardStep {
    /// What to ask of the kernel, if anything.
    pub action: Option<GuardAction>,
    /// Whether to feed the watchdog.
    pub feed: bool,
}

/// The guard's decisions, on the host's boot clock. It keeps no state: a
/// step depends only on the time, the deadline and what it observes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Guard {
    lead: Duration,
}

impl Guard {
    /// How long before the deadline the guard starts freezing.
    pub const LEAD: Duration = Duration::from_secs(1);

    /// The guard.
    #[must_use]
    pub const fn new() -> Self {
        Self { lead: Self::LEAD }
    }

    /// Steps at `now` with the lease's `deadline` and what it observes.
    #[must_use]
    pub fn step(&self, now: At, deadline: At, observed: Observed) -> GuardStep {
        let before_deadline = now < deadline;
        let action = if observed.suspending || now + self.lead >= deadline {
            if observed.stopped() {
                None
            } else if before_deadline {
                (!observed.freezing).then_some(GuardAction::Freeze)
            } else {
                Some(GuardAction::Kill)
            }
        } else {
            observed.freezing.then_some(GuardAction::Thaw)
        };
        GuardStep {
            action,
            feed: before_deadline || observed.stopped(),
        }
    }
}

impl Default for Guard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{At, Guard, GuardAction, GuardStep, Observed, Vms};

    fn at(ms: u64) -> At {
        At::from_millis(ms)
    }

    const RUNNING: Observed = Observed {
        freezing: false,
        frozen: false,
        empty: false,
        suspending: false,
    };
    const FREEZING: Observed = Observed {
        freezing: true,
        ..RUNNING
    };
    const FROZEN: Observed = Observed {
        freezing: true,
        frozen: true,
        ..RUNNING
    };
    const GONE: Observed = Observed {
        empty: true,
        ..RUNNING
    };

    #[test]
    fn it_freezes_ahead_of_the_deadline_and_thaws_on_renewal() {
        let guard = Guard::new();
        let deadline = at(10_000);
        assert_eq!(guard.step(at(8_900), deadline, RUNNING).action, None);
        assert_eq!(
            guard.step(at(9_000), deadline, RUNNING),
            GuardStep {
                action: Some(GuardAction::Freeze),
                feed: true
            }
        );
        // Asked for, the freeze is not asked for again.
        assert_eq!(guard.step(at(9_100), deadline, FREEZING).action, None);
        assert_eq!(FROZEN.vms(), Vms::Frozen);
        // Stopped, it keeps feeding past the deadline.
        assert_eq!(
            guard.step(at(12_000), deadline, FROZEN),
            GuardStep {
                action: None,
                feed: true
            }
        );
        let step = guard.step(at(12_100), at(20_000), FROZEN);
        assert_eq!(step.action, Some(GuardAction::Thaw));
    }

    #[test]
    fn a_freeze_that_does_not_complete_by_the_deadline_becomes_a_kill() {
        let guard = Guard::new();
        let deadline = at(10_000);
        assert!(guard.step(at(9_900), deadline, FREEZING).feed);
        assert_eq!(
            guard.step(at(10_000), deadline, FREEZING),
            GuardStep {
                action: Some(GuardAction::Kill),
                feed: false
            }
        );
        // A kill that never completes is asked again and never feeds the
        // watchdog.
        assert_eq!(
            guard.step(at(10_100), deadline, FREEZING),
            GuardStep {
                action: Some(GuardAction::Kill),
                feed: false
            }
        );
        assert_eq!(
            guard.step(at(10_200), deadline, GONE),
            GuardStep {
                action: None,
                feed: true
            }
        );
        // Killed while frozen, the cgroup still reads frozen: a renewal
        // thaws it for the VMs that start next.
        let killed = Observed {
            freezing: true,
            empty: true,
            ..RUNNING
        };
        assert_eq!(
            guard.step(at(10_300), at(30_000), killed).action,
            Some(GuardAction::Thaw)
        );
    }

    #[test]
    fn a_guard_that_starts_without_a_lease_kills_at_once() {
        let guard = Guard::new();
        assert_eq!(
            guard.step(at(5), At::ZERO, RUNNING),
            GuardStep {
                action: Some(GuardAction::Kill),
                feed: false
            }
        );
        // With no VM at all, as after a reboot, nothing needs stopping.
        assert_eq!(
            guard.step(at(5), At::ZERO, GONE),
            GuardStep {
                action: None,
                feed: true
            }
        );
    }

    #[test]
    fn a_guard_restarted_after_one_froze_the_vms_thaws_them_once_renewed() {
        // The guard before froze them and died; this one starts with a
        // valid lease and the cgroup frozen.
        let guard = Guard::new();
        assert_eq!(
            guard.step(at(1_000), at(10_000), FROZEN),
            GuardStep {
                action: Some(GuardAction::Thaw),
                feed: true
            }
        );
        // And past the deadline it leaves them frozen, feeding.
        assert_eq!(
            guard.step(at(11_000), at(10_000), FROZEN),
            GuardStep {
                action: None,
                feed: true
            }
        );
    }

    #[test]
    fn a_suspend_freezes_and_keeps_frozen_until_it_ends_on_a_valid_lease() {
        let guard = Guard::new();
        let deadline = at(10_000);
        let suspending = Observed {
            suspending: true,
            ..RUNNING
        };
        assert_eq!(
            guard.step(at(2_000), deadline, suspending),
            GuardStep {
                action: Some(GuardAction::Freeze),
                feed: true
            }
        );
        let asked = Observed {
            freezing: true,
            ..suspending
        };
        assert_eq!(
            guard.step(at(2_100), deadline, asked),
            GuardStep {
                action: None,
                feed: true
            }
        );
        let frozen = Observed {
            frozen: true,
            ..asked
        };
        assert_eq!(guard.step(at(2_200), deadline, frozen).action, None);
        // Resumed before the deadline with the mark lifted: thawed.
        assert_eq!(
            guard.step(at(3_000), deadline, FROZEN).action,
            Some(GuardAction::Thaw)
        );
        // Resumed after it: they stay frozen.
        assert_eq!(guard.step(at(40_000), deadline, FROZEN).action, None);
        // A freeze the suspend asked for that hangs past the deadline is a
        // kill.
        assert_eq!(
            guard.step(at(10_000), deadline, asked).action,
            Some(GuardAction::Kill)
        );
    }
}
