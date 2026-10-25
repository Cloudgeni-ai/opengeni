//! Finding guests that stopped while their VMs run on.
//!
//! A guest can stop without its VM process ending. A power-off on x86,
//! where Firecracker gives the guest no way to power off, halts its
//! processors and leaves the VM running; so does a halt, and a guest whose
//! kernel hangs looks the same from outside. Its sandbox still counts as
//! running and answers nothing. Saved as it is, its memory image holds the
//! stopped guest, so every wake from it brings back the same stopped guest
//! and the sandbox never works again.
//!
//! So on a host with a restore notice port, whose guests all listen on it,
//! the agent connects to the port of each running guest every
//! [`GuestChecks::every`] (see [`crate::restore_notice::reachable`]). A
//! live guest's kernel takes the connection by itself, however busy the
//! guest is. One that takes none for [`GuestChecks::misses`] checks in a
//! row has stopped: its VM is ended as a crashed one is, so its running
//! programs are lost, its files kept, and its next wake boots from its
//! disk. A running guest's memory has no current saved copy, so none of
//! the stopped guest is kept either.
//!
//! A check is made only while the guest can run: the agent holds the VM
//! (it lends it to a step only to pause it or work on it paused), the VM
//! is running, and the agent may act (once its lease has run out, the
//! guard keeps every VM frozen). A miss counts only if the guest could run
//! all through the check: a pause, a step or a frozen spell while it
//! waited leaves a connection untaken that a running guest would have
//! taken, so such a check counts for nothing, whatever the VM does by the
//! time it ends.
//!
//! The guard freezes the VMs, a process of its own on its own steps: when
//! the lease is about to run out, and while the host's sleep hook prepares
//! a suspend, for however long that takes. When it acts, nothing here
//! bounds, so no wait or deadline tells whether it froze a guest while it
//! was checked; the guard says so itself. It moves its count of freezes
//! ([`crate::fleet::Freezes`]) on before it freezes the VMs and after it
//! thaws them, so the count is even only while they run, and says it at
//! each of its steps with when it said it. On a host with a lease a miss
//! counts only if the count was even just before the connection and the
//! guard still says the same after the connection ended. So a guard that
//! cannot write its count, which says nothing after, counts no miss; nor
//! does a count that is missing or unreadable: so it is with a guard older
//! than the agent, until the host starts a new one. Nor does a check
//! across a suspend of the whole machine count, as the boot clock, which
//! counts the time suspended, tells.
//!
//! Nor does a check the host could not even ask the VMM for count (see
//! [`crate::restore_notice::Reach`]). Nor is a check made while the VM's
//! memory still comes from object storage: its guest may wait on a page
//! for a while, and its pager decides whether that memory is lost.
//!
//! Checks alone would come too late for a sandbox that pauses seconds
//! after its last use, saving the stopped guest first. So a sandbox about
//! to sleep for being idle whose guest takes no connection when asked
//! whether commands still run stays awake, as one running a command does
//! (see `HostAgent::asked`), until its guest takes one again or is found
//! stopped. A sandbox saved with a stopped guest before this (or for
//! memory pressure, which does not wait) is found stopped after its next
//! wake, and boots from its disk on the one after.

use compute_core::Level;
use compute_engine::Engine;
use std::time::Duration;
use tokio::time::{Instant, sleep};

use crate::fleet::{Freezes, GUARD_STEP, Said, boot_now, slept};
use crate::protocol::Id;
use crate::restore_notice::{REACH_LIMIT, Reach, reachable};
use crate::store::Store;

use super::{Event, HostAgent};

/// More time suspended than this between a check's start and its end
/// voids it; less is the two clocks read a moment apart.
const SLEPT_FLOOR: Duration = Duration::from_millis(100);

/// How long a check that missed waits for the guard to say its count
/// after the connection ended: ten of its steps. A guard that says nothing
/// by then vouches for nothing.
const SAID_WITHIN: Duration = GUARD_STEP.saturating_mul(10);

/// The checks of one VM process's guest.
#[derive(Debug)]
pub(super) struct Check {
    /// The VM process checked.
    incarnation: u64,
    /// Checks in a row its guest took no connection for.
    misses: u32,
    /// When the next one is due.
    next: Instant,
    /// The one under way, if any.
    pending: Option<Pending>,
}

/// A check under way, and what held when it began.
#[derive(Debug, Clone, Copy)]
struct Pending {
    /// Since when the guest could run (see `Slot::runs_since`).
    since: Instant,
    /// How long the machine had been suspended (see [`slept`]).
    slept: Duration,
}

/// Whether the guard did not freeze the VMs while a check connected: it
/// said an even count just `before` the connection, and the same count
/// `after` it ended. A missing count vouches for nothing.
fn unfrozen(before: Option<Said>, after: Option<Said>) -> bool {
    matches!(
        (before, after),
        (Some(before), Some(after))
            if before.count % 2 == 0 && (after.guard, after.count) == (before.guard, before.count)
    )
}

/// What the guard says at or after `since`, waiting for it up to
/// [`SAID_WITHIN`]; `None` if it says nothing by then.
async fn said_since(freezes: &Freezes, since: compute_core::At) -> Option<Said> {
    let deadline = Instant::now() + SAID_WITHIN;
    loop {
        if let Some(said) = freezes.read().filter(|said| said.at >= since) {
            return Some(said);
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep(GUARD_STEP / 4).await;
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Starts the checks that are due (see the module documentation).
    pub(super) fn check_guests(&mut self) {
        let Some(port) = self.restore_notice_port else {
            return;
        };
        let now = Instant::now();
        let every = self.guest_checks.every;
        // A host with a lease has a guard, whose count must vouch for a miss.
        let guard = self.lease.as_ref().map(|_| self.guard_freezes.clone());
        for (id, slot) in &mut self.slots {
            let (Some(live), Some(since)) = (slot.vm.as_ref(), slot.runs_since) else {
                continue;
            };
            if slot.destroy || live.memory.hydrating() {
                continue;
            }
            let check = match &mut slot.check {
                Some(check) if check.incarnation == live.incarnation => check,
                other => other.insert(Check {
                    incarnation: live.incarnation,
                    misses: 0,
                    next: now + every,
                    pending: None,
                }),
            };
            if check.pending.is_some() || now < check.next {
                continue;
            }
            check.pending = Some(Pending {
                since,
                slept: slept(),
            });
            check.next = now + every;
            let (id, incarnation) = (Id(*id), live.incarnation);
            let vsock = slot.spec.vsock_path();
            let events = self.events_tx.clone();
            let guard = guard.clone();
            tokio::spawn(async move {
                let before = guard.as_ref().and_then(|freezes| freezes.as_ref()?.read());
                let reach = reachable(&vsock, port, REACH_LIMIT).await;
                // A host with a guard: only a miss needs it to vouch, with
                // what it says after the connection ended.
                let unfrozen = match &guard {
                    Some(freezes) if matches!(reach, Reach::Unreached(_)) => {
                        let ended = boot_now();
                        let after = match freezes {
                            Some(freezes) => said_since(freezes, ended).await,
                            None => None,
                        };
                        unfrozen(before, after)
                    }
                    _ => true,
                };
                let _ = events.send(Event::Checked {
                    id,
                    incarnation,
                    reach,
                    unfrozen,
                });
            });
        }
    }

    /// A check of VM process `incarnation` of `id` ended. A miss counts only
    /// if its guest could run all through the check, and the guard (if the
    /// host has one) says it did not freeze it meanwhile; the last one
    /// allowed ends the VM.
    pub(super) fn checked(&mut self, id: Id, incarnation: u64, reach: Reach, unfrozen: bool) {
        let acting = self.may_act();
        let runs = self
            .core
            .sandbox(id.0)
            .is_some_and(|view| view.state.level == Level::Running);
        let allowed = self.guest_checks.misses;
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        let Some(check) = slot
            .check
            .as_mut()
            .filter(|check| check.incarnation == incarnation)
        else {
            return;
        };
        let Some(pending) = check.pending.take() else {
            return;
        };
        let error = match reach {
            Reach::Reached => {
                if check.misses > 0 {
                    tracing::info!(%id, misses = check.misses, "guest takes connections again");
                }
                check.misses = 0;
                return;
            }
            Reach::Untried(error) => {
                tracing::warn!(%id, %error, "could not check the guest: its VMM's socket is out of reach");
                return;
            }
            Reach::Unreached(error) => error,
        };
        let held = slot
            .vm
            .as_ref()
            .is_some_and(|live| live.incarnation == incarnation);
        // It could run all along: since before the check began, unfrozen
        // by the guard, and the machine not suspended meanwhile.
        let throughout = slot.runs_since == Some(pending.since)
            && unfrozen
            && slept().saturating_sub(pending.slept) < SLEPT_FLOOR;
        if !(acting && runs && held && throughout) {
            tracing::debug!(%id, %error, "a check the guest could not take all through counts for nothing");
            return;
        }
        check.misses += 1;
        if check.misses < allowed {
            tracing::warn!(%id, misses = check.misses, %error, "guest took no connection on its notice port");
            return;
        }
        tracing::error!(
            %id,
            misses = check.misses,
            "guest took no connection on its notice port for {} checks in a row: it stopped \
             (powered off, halted or hung); ending its VM, and its next wake boots from its disk",
            check.misses
        );
        slot.check = None;
        self.lost_vm(id, incarnation);
    }
}
