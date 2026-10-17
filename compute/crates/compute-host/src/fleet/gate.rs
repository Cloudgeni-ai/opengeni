//! The lease gate: whether this host may run its VMs now, as the lease it
//! holds from the fleet service says.
//!
//! The renewer moves the deadline forward as renewals are accepted; the
//! agent reads it to decide whether to act at all, and waits on it while
//! it is closed. The deadline is a time on the boot clock, which keeps
//! counting while the machine is suspended, as the guard's is.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use compute_core::At;
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
    changed: Notify,
}

impl LeaseGate {
    /// A gate with `deadline`, such as the one a previous run of the agent
    /// left in the lease file.
    #[must_use]
    pub fn new(deadline: At) -> Self {
        Self {
            inner: Arc::new(Inner {
                deadline: AtomicU64::new(nanos(deadline)),
                changed: Notify::new(),
            }),
        }
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
}
