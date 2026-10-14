//! Carries an existing admitted reservation to the actual producer. No new
//! admission or counter is created by spawning a child task or blocking worker.

use std::future::Future;

use crate::WorkReservation;

tokio::task_local! {
    static WORK: Option<WorkReservation>;
}

struct PanicWitness(Option<WorkReservation>);

impl Drop for PanicWitness {
    fn drop(&mut self) {
        if std::thread::panicking() {
            if let Some(reservation) = &self.0 {
                reservation.mark_unsettled();
            }
        }
    }
}

/// Scope one admitted execution and its reply with the same retained guard.
pub async fn with_work_reservation<F: Future>(
    reservation: Option<WorkReservation>,
    future: F,
) -> F::Output {
    let witness = PanicWitness(reservation.clone());
    WORK.scope(reservation, async move {
        let _witness = witness;
        future.await
    })
    .await
}

/// Capture synchronously, before spawning; child Tokio tasks do not inherit
/// task-local values automatically.
#[must_use]
pub fn current_work_reservation() -> Option<WorkReservation> {
    WORK.try_with(Clone::clone).ok().flatten()
}

/// Carry the same ownership and panic witness into non-Tokio child cleanup.
pub fn with_work_reservation_sync<F: FnOnce() -> R, R>(
    reservation: Option<WorkReservation>,
    work: F,
) -> R {
    let _witness = PanicWitness(reservation.clone());
    WORK.sync_scope(reservation, work)
}

/// A relay pump owns its reservation until its actual task finishes, including
/// readiness failure, reconnect, and retirement of the opening connection.
pub fn spawn_reserved<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let reservation = current_work_reservation();
    tokio::spawn(with_work_reservation(reservation, future))
}

/// Cancelling a waiter cannot cancel a started blocking operation. Move its
/// guard into the actual worker, and propagate it to nested cleanup workers.
pub fn spawn_blocking_reserved<F, R>(work: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let reservation = current_work_reservation();
    tokio::task::spawn_blocking(move || with_work_reservation_sync(reservation, work))
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_agent_engine::update_drain::{UpdateDrain, UpdateReservation};
    use std::sync::Arc;

    #[tokio::test]
    async fn cancelled_waiter_does_not_release_a_started_blocking_producer() {
        let drain = Arc::new(UpdateDrain::default());
        let work = drain.reserve_work(None).unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(with_work_reservation(Some(work), async move {
            spawn_blocking_reserved(move || {
                let _ = started.send(());
                let _ = released.recv();
            })
            .await
            .unwrap();
        }));
        started_rx.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(drain.reserve_update("update"), UpdateReservation::Started);
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        assert!(!drain.seal_update("update"));
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while drain.snapshot().unwrap().routed != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(drain.seal_update("update"));
    }

    #[tokio::test]
    async fn child_pump_retains_opening_reservation_after_opener_and_hub_retire() {
        let drain = Arc::new(UpdateDrain::default());
        let (release, released) = tokio::sync::oneshot::channel();
        let pump = with_work_reservation_sync(Some(drain.reserve_work(None).unwrap()), move || {
            spawn_reserved(async move {
                let _ = released.await;
            })
        });
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        assert_eq!(
            drain.reserve_update("other-link"),
            UpdateReservation::Started
        );
        assert!(!drain.seal_update("other-link"));
        release.send(()).unwrap();
        pump.await.unwrap();
        assert_eq!(drain.snapshot().unwrap().routed, 0);
        assert!(drain.seal_update("other-link"));
    }

    #[tokio::test]
    async fn physical_worker_panic_is_not_idle_proof() {
        let drain = Arc::new(UpdateDrain::default());
        let work = drain.reserve_work(None).unwrap();
        let worker = with_work_reservation_sync(Some(work), || {
            spawn_blocking_reserved(|| panic!("synthetic worker failure"))
        });
        assert!(worker.await.unwrap_err().is_panic());
        assert_eq!(drain.snapshot(), None);
        assert_eq!(
            drain.reserve_update("update"),
            UpdateReservation::Unavailable
        );
    }
}
