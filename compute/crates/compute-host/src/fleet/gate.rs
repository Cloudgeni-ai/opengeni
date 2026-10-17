//! The lease gate: whether this host may run its VMs now, as the lease it
//! holds from the fleet service says, and which requests from the service
//! it may still carry out.
//!
//! The renewer moves the deadline forward as renewals are accepted; the
//! agent reads it to decide whether to act at all, and waits on it while
//! it is closed. The deadline is a time on the boot clock, which keeps
//! counting while the machine is suspended, as the guard's is.
//!
//! The gate also holds the registration and the number of the last
//! renewal sent under it. A request from the service is admitted under
//! the registration it names and the renewal it was stamped with
//! ([`Admission`]); the listener checks that when it arrives and the agent
//! again when it acts, so a request that waited in between is carried out
//! only if it would still be admitted.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use compute_core::At;
use compute_protocol::fleet::Answered;
use tokio::sync::Notify;

/// The time on the boot clock: since the machine started, including any
/// time suspended.
#[must_use]
pub fn boot_now() -> At {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::Boottime);
    let seconds = u64::try_from(now.tv_sec).unwrap_or(0);
    let nanos = u32::try_from(now.tv_nsec).unwrap_or(0);
    At::from_duration(Duration::new(seconds, nanos))
}

/// Nanoseconds since the clock's start, saturating.
pub(crate) fn nanos(at: At) -> u64 {
    u64::try_from(at.since_origin().as_nanos()).unwrap_or(u64::MAX)
}

/// What a request from the fleet service was admitted under: the
/// registration it named and the renewal number it was stamped with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    /// The registration.
    pub host_epoch: u64,
    /// The last renewal of it the service had heard when it sent the
    /// request.
    pub stamp: u64,
}

/// Shared by the renewer, the agent, the listener and the store: VMs may
/// run strictly before the deadline.
#[derive(Clone, Debug)]
pub struct LeaseGate {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    /// The deadline in nanoseconds on the boot clock.
    deadline: AtomicU64,
    /// The registration held, and the last renewal sent under it.
    held: Mutex<Answered>,
    /// How many renewals old a request may be.
    window: u64,
    changed: Notify,
}

impl LeaseGate {
    /// A gate with `deadline` and no registration, such as a test's.
    #[must_use]
    pub fn new(deadline: At) -> Self {
        Self::holding(
            deadline,
            Answered {
                host_epoch: None,
                seq: 0,
            },
            0,
        )
    }

    /// A gate with `deadline` under the registration and renewal `held`,
    /// such as a previous run of the agent left in the lease file,
    /// admitting requests up to `window` renewals old.
    #[must_use]
    pub fn holding(deadline: At, held: Answered, window: u64) -> Self {
        Self {
            inner: Arc::new(Inner {
                deadline: AtomicU64::new(nanos(deadline)),
                held: Mutex::new(held),
                window,
                changed: Notify::new(),
            }),
        }
    }

    /// The registration held and its last renewal sent: when an answer
    /// given now was given.
    #[must_use]
    pub fn answered(&self) -> Answered {
        *self
            .inner
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a request stamped `stamp` under the registration held is
    /// recent enough.
    #[must_use]
    pub fn admits_stamp(&self, stamp: u64) -> bool {
        stamp.saturating_add(self.inner.window) >= self.answered().seq
    }

    /// Whether a request admitted under `admission` may be carried out
    /// now: the lease runs, under the registration it named, and it is
    /// still recent enough.
    #[must_use]
    pub fn admits(&self, admission: Admission) -> bool {
        self.answered().host_epoch == Some(admission.host_epoch)
            && self.admits_stamp(admission.stamp)
            && self.is_open()
    }

    /// VMs may run strictly before this.
    #[must_use]
    pub fn deadline(&self) -> At {
        At::from_duration(Duration::from_nanos(
            self.inner.deadline.load(Ordering::Acquire),
        ))
    }

    /// Whether VMs may run, and the agent act, now.
    #[must_use]
    pub fn is_open(&self) -> bool {
        boot_now() < self.deadline()
    }

    /// Moves the deadline to `deadline`; only the renewer does, once the
    /// lease file says the same, so the guard never sees an earlier one.
    pub fn set(&self, deadline: At) {
        self.inner
            .deadline
            .store(nanos(deadline), Ordering::Release);
        self.inner.changed.notify_waiters();
    }

    /// Holds `held` from now on, then moves the deadline to `deadline`.
    /// A reader between the two sees the new registration with the old
    /// deadline: closed for a new registration, which admits nothing
    /// before its deadline is written.
    pub fn hold(&self, held: Answered, deadline: At) {
        *self
            .inner
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = held;
        self.set(deadline);
    }

    /// Returns when the gate may have opened or closed: at the deadline
    /// while it is open, or when the renewer moves it.
    pub async fn changed(&self) {
        let notified = self.inner.changed.notified();
        let left = self.deadline().saturating_since(boot_now());
        if left.is_zero() {
            notified.await;
        } else {
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep(left) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_gate_is_open_until_its_deadline_and_wakes_its_waiters_when_moved() {
        let gate = LeaseGate::new(At::ZERO);
        assert!(!gate.is_open(), "a host that never registered runs nothing");
        let waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.changed().await }
        });
        tokio::task::yield_now().await;
        gate.set(boot_now() + Duration::from_millis(200));
        waiter.await.unwrap();
        assert!(gate.is_open());
        // It closes at the deadline by itself.
        tokio::time::timeout(Duration::from_secs(5), gate.changed())
            .await
            .unwrap();
        assert!(!gate.is_open());
    }

    #[test]
    fn a_request_is_admitted_only_under_its_registration_while_recent_and_open() {
        let held = |seq| Answered {
            host_epoch: Some(3),
            seq,
        };
        let gate = LeaseGate::holding(boot_now() + Duration::from_secs(60), held(10), 2);
        let admission = |host_epoch, stamp| Admission { host_epoch, stamp };
        assert!(gate.admits(admission(3, 10)));
        assert!(gate.admits(admission(3, 8)), "within the window");
        assert!(!gate.admits(admission(3, 7)), "too many renewals old");
        assert!(!gate.admits(admission(2, 10)), "another registration");
        gate.hold(held(11), boot_now() + Duration::from_secs(60));
        assert!(
            !gate.admits(admission(3, 8)),
            "a renewal later, it is too old"
        );
        gate.hold(
            Answered {
                host_epoch: None,
                seq: 0,
            },
            boot_now() + Duration::from_secs(60),
        );
        assert!(!gate.admits(admission(3, 11)), "no registration held");
        gate.hold(held(11), boot_now());
        assert!(!gate.admits(admission(3, 11)), "the lease ran out");
        assert!(!LeaseGate::new(boot_now() + Duration::from_secs(60)).admits(admission(0, 0)));
    }
}
