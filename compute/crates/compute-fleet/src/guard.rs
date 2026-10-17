//! The guard: what stops a host's VMs when its lease runs out, whatever
//! happens to the agent.
//!
//! The guard is a small process of its own on every host with a lease. It
//! reads the lease's deadline from a file the agent writes in `/run`, and
//! steps this machine every 100 ms:
//!
//! - a second before the deadline it asks the kernel to freeze the cgroup
//!   that holds every VM, and waits to see the freeze complete;
//! - at the deadline, if the freeze has not completed, it kills every
//!   process in that cgroup instead;
//! - a renewed deadline thaws what it froze.
//!
//! Freezing and killing both complete asynchronously, and the guard itself
//! can stall, so it also holds the kernel's watchdog: it feeds it only
//! while the lease is valid or the VMs are known to have stopped. If the
//! guard stalls, dies, or cannot stop the VMs, the watchdog reboots the
//! machine a few seconds later, which stops them for certain. So a VM never
//! runs past its host's deadline by more than the watchdog's timeout, which
//! must stay below the service's margin.

use core::time::Duration;

use compute_core::At;

/// Where the VMs are, as far as the guard knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Vms {
    /// They run.
    Running,
    /// A freeze was asked for and has not completed yet.
    Freezing,
    /// Frozen: no VM runs.
    Frozen,
    /// A kill was asked for and has not completed yet.
    Killing,
    /// Every VM process is gone.
    Killed,
}

/// What the guard asks of the kernel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GuardAction {
    /// Freeze the VMs' cgroup.
    Freeze,
    /// Kill every process in the VMs' cgroup.
    Kill,
    /// Thaw the VMs' cgroup.
    Thaw,
}

/// What the guard sees of the kernel when it steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct Observed {
    /// The kernel reports the cgroup frozen (`cgroup.events`: `frozen 1`).
    pub frozen: bool,
    /// No process is left in the cgroup (`cgroup.events`: `populated 0`).
    pub empty: bool,
}

/// One step's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GuardStep {
    /// What to ask of the kernel, if anything.
    pub action: Option<GuardAction>,
    /// Whether to feed the watchdog.
    pub feed: bool,
}

/// The guard's state machine, on the host's boot clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Guard {
    lead: Duration,
    vms: Vms,
}

impl Guard {
    /// How long before the deadline the guard starts freezing.
    pub const LEAD: Duration = Duration::from_secs(1);

    /// A guard whose VMs run, or are about to.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            lead: Self::LEAD,
            vms: Vms::Running,
        }
    }

    /// Where the VMs are.
    #[must_use]
    pub const fn vms(&self) -> Vms {
        self.vms
    }

    /// Steps at `now` with the lease's `deadline` and what the kernel
    /// reports.
    pub fn step(&mut self, now: At, deadline: At, observed: Observed) -> GuardStep {
        let renewed = now + self.lead < deadline;
        let (vms, action) = match self.vms {
            Vms::Running if !renewed => (Vms::Freezing, Some(GuardAction::Freeze)),
            // The cgroup stays frozen after a kill too; new VMs may start
            // in it once the lease is renewed.
            Vms::Freezing | Vms::Frozen | Vms::Killed if renewed => {
                (Vms::Running, Some(GuardAction::Thaw))
            }
            Vms::Freezing if observed.frozen => (Vms::Frozen, None),
            Vms::Freezing if now >= deadline => (Vms::Killing, Some(GuardAction::Kill)),
            Vms::Killing if observed.empty => (Vms::Killed, None),
            vms => (vms, None),
        };
        self.vms = vms;
        let stopped = matches!(vms, Vms::Frozen | Vms::Killed) || observed.empty;
        GuardStep {
            action,
            feed: now < deadline || stopped,
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

    const NONE: Observed = Observed {
        frozen: false,
        empty: false,
    };

    #[test]
    fn it_freezes_ahead_of_the_deadline_and_thaws_on_renewal() {
        let mut guard = Guard::new();
        let deadline = at(10_000);
        assert_eq!(guard.step(at(8_900), deadline, NONE).action, None);
        let step = guard.step(at(9_000), deadline, NONE);
        assert_eq!(
            step,
            GuardStep {
                action: Some(GuardAction::Freeze),
                feed: true
            }
        );
        let frozen = Observed {
            frozen: true,
            empty: false,
        };
        assert_eq!(guard.step(at(9_100), deadline, frozen).action, None);
        assert_eq!(guard.vms(), Vms::Frozen);
        // Stopped, it keeps feeding past the deadline.
        assert!(guard.step(at(12_000), deadline, frozen).feed);
        let step = guard.step(at(12_100), at(20_000), frozen);
        assert_eq!(step.action, Some(GuardAction::Thaw));
        assert_eq!(guard.vms(), Vms::Running);
    }

    #[test]
    fn a_freeze_that_does_not_complete_by_the_deadline_becomes_a_kill() {
        let mut guard = Guard::new();
        let deadline = at(10_000);
        guard.step(at(9_000), deadline, NONE);
        assert!(guard.step(at(9_900), deadline, NONE).feed);
        let step = guard.step(at(10_000), deadline, NONE);
        assert_eq!(
            step,
            GuardStep {
                action: Some(GuardAction::Kill),
                feed: false
            }
        );
        // A kill that never completes never feeds the watchdog again.
        assert!(!guard.step(at(10_100), deadline, NONE).feed);
        let empty = Observed {
            frozen: false,
            empty: true,
        };
        assert!(guard.step(at(10_200), deadline, empty).feed);
        assert_eq!(guard.vms(), Vms::Killed);
        assert_eq!(
            guard.step(at(10_300), at(30_000), empty).action,
            Some(GuardAction::Thaw)
        );
    }

    #[test]
    fn a_guard_that_starts_without_a_lease_freezes_at_once() {
        let mut guard = Guard::new();
        let step = guard.step(at(5), At::ZERO, NONE);
        assert_eq!(
            step,
            GuardStep {
                action: Some(GuardAction::Freeze),
                feed: false
            }
        );
        // With no VM at all, as after a reboot, nothing needs stopping.
        let mut guard = Guard::new();
        let empty = Observed {
            frozen: false,
            empty: true,
        };
        assert!(guard.step(at(5), At::ZERO, empty).feed);
    }
}
