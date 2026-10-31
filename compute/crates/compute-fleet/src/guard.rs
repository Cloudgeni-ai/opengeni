//! The guard: what stops a host's VMs when its lease runs out, whatever
//! happens to the agent.
//!
//! The guard is a small process of its own on every host with a lease. It
//! reads the lease's deadline from a file the agent writes in `/run`, and
//! steps this machine every 100 ms:
//!
//! - three seconds before the deadline ([`Guard::LEAD`]) it asks the
//!   kernel to freeze each VM's group (each VM has a group of its own in
//!   the cgroup that holds every VM);
//! - from the deadline, until the kernel reports them frozen or gone, it
//!   kills each VM that is neither, and leaves the frozen ones frozen;
//! - while the deadline is further off, it thaws every group anything
//!   froze.
//!
//! It leaves running a VM that is its sandbox's only copy ([`Group`]):
//! the agent marks one whose sandbox has no copy in object storage and
//! makes none while it runs, such as a CI runner's. The service never
//! gives such a sandbox to another host (it has nothing to start it
//! from), so it can never run twice, and stopping it would protect
//! nothing while costing its programs (ADR 18). A mark holds only while
//! the agent that set it runs; one an agent that has ended left is
//! frozen with the others until the next agent marks it again, but not
//! killed for having run past the deadline.
//!
//! While no VM is marked so and none holds a freeze of its own, or when
//! the VMs cannot be told apart (a process sits in the cgroup itself, or
//! what is inside it cannot be read), it freezes, kills and thaws that
//! whole cgroup instead ([`Guard::step`]), as a guard of an earlier
//! release always did: a VM started meanwhile then starts frozen. Asked
//! to stop while the lease runs out, it leaves the VMs as such a guard
//! expects them, frozen as a whole ([`Guard::plan`]).
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
    /// Kill every VM in the VMs' cgroup that is neither frozen nor gone;
    /// asked again on every step until the cgroup is frozen or empty.
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

/// One VM's own group in the cgroup that holds every VM, as the kernel
/// reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "an agent mark and three kernel readings, each a flag in its own file"
)]
pub struct Group {
    /// The agent marked the VM its sandbox's only copy: the sandbox has
    /// no copy in object storage and the VM makes none, so no other host
    /// can ever run it, and the guard leaves it running. Only a mark the
    /// agent that set it still vouches for, by running; a group whose
    /// mark cannot be read is not marked.
    pub only_copy: bool,
    /// It holds a mark no agent vouches for any more: the agent that set
    /// it has ended, and the next one has not marked it again yet. It is
    /// stopped as any other VM, but frozen rather than killed when it is
    /// found running past the deadline, since until its agent ended it
    /// was rightly left running. A freeze of it that does not complete by
    /// a later step past the deadline is a kill, as any other.
    pub orphaned: bool,
    /// A freeze is asked for in the group itself (`cgroup.freeze` reads
    /// `1`); one the cgroup above asks for holds it without this.
    pub freezing: bool,
    /// The kernel reports it frozen (`cgroup.events`: `frozen 1`), by its
    /// own freeze or the one above.
    pub frozen: bool,
    /// No process is left in it.
    pub empty: bool,
}

impl Group {
    /// Whether no VM runs in it.
    #[must_use]
    pub const fn stopped(self) -> bool {
        self.frozen || self.empty
    }
}

/// One step's outcome, VM by VM (see [`Guard::plan`]).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Plan {
    /// What to ask of each group, in the order they were observed (none
    /// when they could not be told apart); done before the cgroup's own
    /// action.
    pub groups: Vec<Option<GuardAction>>,
    /// What to ask of the cgroup that holds every VM, after the groups'.
    /// A kill of it kills every VM that is neither frozen nor gone.
    pub vms: Option<GuardAction>,
    /// Whether to feed the watchdog.
    pub feed: bool,
    /// Whether a guard asked to stop may stop at this step: it feeds the
    /// watchdog, and leaves the VMs as any guard, of this release or an
    /// earlier one, expects them.
    pub may_stop: bool,
}

/// The guard's decisions, on the host's boot clock. It keeps no state: a
/// step depends only on the time, the deadline and what it observes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Guard {
    lead: Duration,
}

impl Guard {
    /// How long before the deadline the guard starts freezing. A VM
    /// freezes only once each of its threads can stop, and one waiting
    /// on its disk cannot until that write ends, which on a host whose
    /// disk is busy can take seconds: whatever has not frozen by the
    /// deadline is killed, so the freeze starts early enough for a busy
    /// VM to finish it.
    pub const LEAD: Duration = Duration::from_secs(3);

    /// The guard.
    #[must_use]
    pub const fn new() -> Self {
        Self { lead: Self::LEAD }
    }

    /// Steps at `now` with the lease's `deadline` and what it observes.
    /// This is how it treats the VMs as a whole: the cgroup that holds them
    /// frozen, killed and thawed at once.
    #[must_use]
    pub fn step(&self, now: At, deadline: At, observed: Observed) -> GuardStep {
        let before_deadline = now < deadline;
        let action = if self.lapsing(now, deadline, observed.suspending) {
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

    /// Whether the VMs must stop: the deadline is less than [`Self::LEAD`]
    /// away or past, or a suspend is under way.
    #[must_use]
    pub fn lapsing(&self, now: At, deadline: At, suspending: bool) -> bool {
        suspending || now + self.lead >= deadline
    }

    /// Steps at `now` with the lease's `deadline`, what it observes of the
    /// cgroup that holds every VM (`vms`), and of each VM's own group, or
    /// `None` when the VMs cannot be told apart. `stopping`: the guard is
    /// asked to stop.
    ///
    /// It treats the VMs as a whole, as [`Self::step`] does, when they
    /// cannot be told apart, or when no group is marked its sandbox's only
    /// copy (by an agent that runs or one that has ended) and none asks
    /// for a freeze of its own; then it may stop at any step that feeds
    /// the watchdog, as a guard always could.
    ///
    /// Otherwise, while the VMs must stop, it freezes each one that is not
    /// its sandbox's only copy, kills those that have not frozen by the
    /// deadline (one whose mark is [`Group::orphaned`] and that has not
    /// been asked to, it freezes first), and feeds the watchdog while the
    /// deadline is ahead or
    /// every one of them is frozen or gone; it thaws a freeze of the
    /// cgroup above (an earlier guard's, or its own while it treated them
    /// as a whole) once each of them asks for its own, and any freeze of a
    /// VM's own group that marks it its sandbox's only copy. While they
    /// may run, it thaws every freeze.
    ///
    /// Asked to stop while the VMs must stop, it freezes the cgroup above
    /// and, once that holds every VM, thaws the groups' own freezes: a
    /// guard of an earlier release freezes and thaws only the cgroup
    /// above, so it would leave a group's own freeze in place for good,
    /// and kill a VM left running for being its sandbox's only copy. The
    /// next guard of this release lets those run again.
    #[must_use]
    pub fn plan(
        &self,
        now: At,
        deadline: At,
        vms: Observed,
        groups: Option<&[Group]>,
        stopping: bool,
    ) -> Plan {
        let lapsing = self.lapsing(now, deadline, vms.suspending);
        let before = now < deadline;
        let apart = groups.filter(|groups| {
            groups
                .iter()
                .any(|group| group.only_copy || group.orphaned || group.freezing)
        });
        let Some(groups) = apart else {
            let step = self.step(now, deadline, vms);
            return Plan {
                groups: groups.map_or_else(Vec::new, |groups| vec![None; groups.len()]),
                vms: step.action,
                feed: step.feed,
                may_stop: step.feed,
            };
        };
        let handing_over = stopping && lapsing;
        let actions = groups
            .iter()
            .map(|group| {
                if !lapsing || group.only_copy {
                    group.freezing.then_some(GuardAction::Thaw)
                } else if group.empty {
                    None
                } else if handing_over && vms.frozen {
                    // Held by the cgroup above, its own freeze can go.
                    group.freezing.then_some(GuardAction::Thaw)
                } else if group.freezing {
                    // Asked for: it is frozen, or freezing until the
                    // deadline.
                    (!group.frozen && !before).then_some(GuardAction::Kill)
                } else if group.frozen && !handing_over {
                    // Held only by the cgroup above, which is thawed next:
                    // it asks for its own first, so it stays frozen.
                    Some(GuardAction::Freeze)
                } else if group.frozen {
                    None
                } else if before || group.orphaned {
                    // Running past the deadline, an orphaned mark's VM was
                    // rightly left running until its agent ended: it gets
                    // its freeze, and the kill only if that does not take.
                    Some(GuardAction::Freeze)
                } else {
                    Some(GuardAction::Kill)
                }
            })
            .collect();
        let action = if handing_over {
            (!vms.freezing).then_some(GuardAction::Freeze)
        } else {
            vms.freezing.then_some(GuardAction::Thaw)
        };
        let feed = before
            || vms.stopped()
            || groups
                .iter()
                .all(|group| group.only_copy || group.stopped());
        let own_freezes = groups.iter().any(|group| group.freezing);
        let settled = if lapsing {
            vms.stopped()
        } else {
            !vms.freezing
        };
        Plan {
            groups: actions,
            vms: action,
            feed,
            may_stop: feed && settled && !own_freezes,
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
    use super::{At, Group, Guard, GuardAction, GuardStep, Observed, Plan, Vms};

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
        let lead = u64::try_from(Guard::LEAD.as_millis()).unwrap();
        assert_eq!(lead, 3_000);
        assert_eq!(
            guard
                .step(at(10_000 - lead - 100), deadline, RUNNING)
                .action,
            None
        );
        assert_eq!(
            guard.step(at(10_000 - lead), deadline, RUNNING),
            GuardStep {
                action: Some(GuardAction::Freeze),
                feed: true
            }
        );
        // Asked for, the freeze is not asked for again.
        assert_eq!(
            guard
                .step(at(10_000 - lead + 100), deadline, FREEZING)
                .action,
            None
        );
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

    const RUN: Group = Group {
        only_copy: false,
        orphaned: false,
        freezing: false,
        frozen: false,
        empty: false,
    };
    /// A VM that is its sandbox's only copy, running.
    const ONLY: Group = Group {
        only_copy: true,
        ..RUN
    };
    /// A group whose own freeze is asked for and done.
    const OWN_FROZEN: Group = Group {
        freezing: true,
        frozen: true,
        ..RUN
    };
    /// A group held frozen by the cgroup above alone.
    const HELD: Group = Group {
        frozen: true,
        ..RUN
    };
    const EMPTY: Group = Group { empty: true, ..RUN };
    /// A running VM whose mark its agent, now ended, set.
    const ORPHAN: Group = Group {
        orphaned: true,
        ..RUN
    };

    fn plan(now: u64, deadline: u64, vms: Observed, groups: &[Group]) -> Plan {
        Guard::new().plan(at(now), at(deadline), vms, Some(groups), false)
    }

    #[test]
    fn only_the_vms_that_are_not_their_sandboxes_only_copy_freeze() {
        let deadline = 10_000;
        // Well ahead: nothing to do.
        assert_eq!(
            plan(1_000, deadline, RUNNING, &[RUN, ONLY]),
            Plan {
                groups: vec![None, None],
                vms: None,
                feed: true,
                may_stop: true
            }
        );
        // From the lead on, each fenced VM freezes on its own; the only
        // copy runs on, and the cgroup above is left alone.
        let lead = 10_000 - 3_000;
        assert_eq!(
            plan(lead, deadline, RUNNING, &[RUN, ONLY, EMPTY]),
            Plan {
                groups: vec![Some(GuardAction::Freeze), None, None],
                vms: None,
                feed: true,
                may_stop: false
            }
        );
        let freezing = Group {
            freezing: true,
            ..RUN
        };
        // Asked for, the freeze is not asked again.
        assert_eq!(
            plan(lead + 100, deadline, RUNNING, &[freezing, ONLY]).groups,
            vec![None, None]
        );
        // Past the deadline with the fenced VM frozen, it feeds the
        // watchdog while the only copy runs.
        let past = plan(12_000, deadline, RUNNING, &[OWN_FROZEN, ONLY]);
        assert_eq!(past.groups, vec![None, None]);
        assert!(past.feed, "every fenced VM is frozen");
        // A fenced VM that has not frozen by the deadline is killed, and
        // the watchdog is not fed until it has gone.
        assert_eq!(
            plan(10_000, deadline, RUNNING, &[freezing, ONLY, OWN_FROZEN]),
            Plan {
                groups: vec![Some(GuardAction::Kill), None, None],
                vms: None,
                feed: false,
                may_stop: false
            }
        );
        assert!(plan(10_100, deadline, RUNNING, &[EMPTY, ONLY]).feed);
        // Renewed, every own freeze is thawed.
        assert_eq!(
            plan(10_200, 40_000, RUNNING, &[OWN_FROZEN, ONLY, EMPTY]).groups,
            vec![Some(GuardAction::Thaw), None, None]
        );
    }

    #[test]
    fn a_vm_marked_its_sandboxes_only_copy_is_never_frozen_or_killed() {
        // Not even with no lease at all, or in a suspend.
        let suspending = Observed {
            suspending: true,
            ..RUNNING
        };
        for (now, deadline, vms) in [
            (5, 0, RUNNING),
            (50_000, 10_000, RUNNING),
            (1_000, 10_000, suspending),
        ] {
            let step = plan(now, deadline, vms, &[ONLY, ONLY]);
            assert_eq!(step.groups, vec![None, None]);
            assert_eq!(step.vms, None);
            assert!(step.feed, "nothing that must stop runs");
        }
        // One the agent marked after it froze (or that an earlier guard
        // froze) is thawed.
        let frozen_only = Group {
            only_copy: true,
            ..OWN_FROZEN
        };
        assert_eq!(
            plan(50_000, 10_000, RUNNING, &[frozen_only]).groups,
            vec![Some(GuardAction::Thaw)]
        );
    }

    #[test]
    fn a_vm_whose_marking_agent_ended_is_frozen_past_the_deadline_not_killed() {
        let deadline = 10_000;
        // Alone, it still keeps the VMs apart: as a whole, every VM still
        // running past the deadline would be killed.
        let step = plan(20_000, deadline, RUNNING, &[ORPHAN]);
        assert_eq!(step.groups, vec![Some(GuardAction::Freeze)]);
        assert_eq!(step.vms, None);
        assert!(!step.feed, "it runs, and nothing vouches for it");
        // Beside a fenced VM still running, which is killed.
        assert_eq!(
            plan(20_000, deadline, RUNNING, &[RUN, ORPHAN, ONLY]).groups,
            vec![Some(GuardAction::Kill), Some(GuardAction::Freeze), None]
        );
        // Ahead of the deadline it freezes as any VM does.
        assert_eq!(
            plan(8_000, deadline, RUNNING, &[ORPHAN]).groups,
            vec![Some(GuardAction::Freeze)]
        );
        // Frozen, it stays so, and the watchdog is fed.
        let frozen = Group {
            freezing: true,
            frozen: true,
            ..ORPHAN
        };
        let step = plan(20_100, deadline, RUNNING, &[frozen, ONLY]);
        assert_eq!(step.groups, vec![None, None]);
        assert!(step.feed);
        // A freeze of it that has not taken by a later step is a kill.
        let freezing = Group {
            freezing: true,
            ..ORPHAN
        };
        assert_eq!(
            plan(20_100, deadline, RUNNING, &[freezing]).groups,
            vec![Some(GuardAction::Kill)]
        );
        // Marked again by the agent that runs now, it is thawed.
        let marked = Group {
            only_copy: true,
            ..OWN_FROZEN
        };
        assert_eq!(
            plan(20_200, deadline, RUNNING, &[marked]).groups,
            vec![Some(GuardAction::Thaw)]
        );
        // Renewed, it is thawed with the others.
        assert_eq!(
            plan(20_300, 60_000, RUNNING, &[frozen]).groups,
            vec![Some(GuardAction::Thaw)]
        );
    }

    #[test]
    fn after_an_earlier_guard_froze_every_vm_each_fenced_one_keeps_its_freeze() {
        // The guard before froze the cgroup above and ended; the lease has
        // run out. Each fenced VM asks for its own freeze before the
        // cgroup above is thawed, so it never runs; the only copy runs
        // again.
        let step = plan(
            20_000,
            10_000,
            FROZEN,
            &[
                HELD,
                Group {
                    only_copy: true,
                    ..HELD
                },
                EMPTY,
            ],
        );
        assert_eq!(
            step,
            Plan {
                groups: vec![Some(GuardAction::Freeze), None, None],
                vms: Some(GuardAction::Thaw),
                feed: true,
                may_stop: true
            }
        );
        // Renewed instead, everything is thawed.
        let step = plan(1_000, 10_000, FROZEN, &[HELD, OWN_FROZEN]);
        assert_eq!(step.groups, vec![None, Some(GuardAction::Thaw)]);
        assert_eq!(step.vms, Some(GuardAction::Thaw));
    }

    #[test]
    fn asked_to_stop_while_the_lease_runs_out_it_leaves_the_vms_frozen_as_a_whole() {
        let guard = Guard::new();
        let hand_over = |now: u64, vms: Observed, groups: &[Group]| {
            guard.plan(at(now), at(10_000), vms, Some(groups), true)
        };
        // With the fenced VM frozen on its own and the only copy running:
        // the cgroup above freezes first, every VM with it.
        let step = hand_over(20_000, RUNNING, &[OWN_FROZEN, ONLY]);
        assert_eq!(step.vms, Some(GuardAction::Freeze));
        assert_eq!(step.groups, vec![None, None]);
        assert!(step.feed);
        assert!(!step.may_stop, "the only copy still runs");
        // Once it holds every VM, the own freezes go: a guard of an
        // earlier release would never thaw them.
        let held = Group {
            only_copy: true,
            ..HELD
        };
        let step = hand_over(20_100, FROZEN, &[OWN_FROZEN, held]);
        assert_eq!(step.vms, None);
        assert_eq!(step.groups, vec![Some(GuardAction::Thaw), None]);
        assert!(!step.may_stop, "not yet thawed");
        let step = hand_over(20_200, FROZEN, &[HELD, held]);
        assert!(step.may_stop);
        // A fenced VM still running past the deadline is killed meanwhile.
        assert_eq!(
            hand_over(20_000, RUNNING, &[RUN, ONLY]).groups,
            vec![Some(GuardAction::Kill), None]
        );
        // With the lease valid it stops once nothing is frozen.
        let step = guard.plan(at(1_000), at(10_000), RUNNING, Some(&[OWN_FROZEN]), true);
        assert_eq!(step.groups, vec![Some(GuardAction::Thaw)]);
        assert!(!step.may_stop);
        assert!(
            guard
                .plan(at(1_100), at(10_000), RUNNING, Some(&[RUN]), true)
                .may_stop
        );
    }

    #[test]
    fn vms_it_cannot_tell_apart_are_frozen_killed_and_thawed_as_a_whole() {
        let guard = Guard::new();
        for (now, deadline, vms) in [
            (7_000, 10_000, RUNNING),
            (10_000, 10_000, FREEZING),
            (12_000, 10_000, FROZEN),
            (1_000, 10_000, FROZEN),
        ] {
            let step = guard.step(at(now), at(deadline), vms);
            let plan = guard.plan(at(now), at(deadline), vms, None, false);
            assert_eq!((plan.vms, plan.feed), (step.action, step.feed));
            assert!(plan.groups.is_empty());
            // So are VMs none of which is marked or frozen on its own.
            let plan = guard.plan(at(now), at(deadline), vms, Some(&[RUN, HELD, EMPTY]), false);
            assert_eq!((plan.vms, plan.feed), (step.action, step.feed));
            assert_eq!(plan.groups, vec![None, None, None]);
        }
        // Asked to stop, it stops at any step that feeds the watchdog, as a
        // guard of an earlier release did: the next guard, of any release,
        // goes on from the cgroup's freezer.
        for (now, vms, may_stop) in [
            (7_000, FREEZING, true),
            (10_000, FREEZING, false),
            (10_100, FROZEN, true),
            (1_000, RUNNING, true),
        ] {
            for groups in [None, Some(&[RUN][..])] {
                let plan = guard.plan(at(now), at(10_000), vms, groups, true);
                assert_eq!(plan.may_stop, may_stop, "at {now} with {vms:?}");
            }
        }
    }
}
