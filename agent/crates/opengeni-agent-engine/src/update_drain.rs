//! Process-wide reservation boundary shared by routed work and self-update.
//! Reserve before spawning: an unpolled task must already prevent an idle proof.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Default)]
/// One host-wide admission boundary shared by every ingress connection.
pub struct UpdateDrain {
    state: Mutex<State>,
}

impl std::fmt::Debug for UpdateDrain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateDrain").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
/// Exact accepted upload transaction allowed to continue during update drain.
pub struct UploadIdentity {
    /// Owning enrollment connection.
    pub connection: String,
    /// Transaction operation identifier.
    pub operation: String,
    /// Fenced route epoch.
    pub epoch: u32,
}

#[derive(Default)]
struct State {
    operation: Option<String>,
    /// Accepted update still waiting for the host to become idle. It does not
    /// fence admission; each idle attempt fences through `reserve_update`.
    waiting: Option<String>,
    sealed: bool,
    unsettled: bool,
    routed: usize,
    uploads: HashSet<UploadIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Result of claiming the sole host updater.
pub enum UpdateReservation {
    /// This operation became the updater.
    Started,
    /// A retry of the already accepted operation.
    AlreadyAccepted,
    /// Another updater owns the fence.
    Busy,
    /// Authoritative settlement cannot be established.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Retained accepted producers across all connections and transport generations.
pub struct Snapshot {
    /// Request/pump/physical/reply ownership, counted once per admitted request.
    pub routed: usize,
    /// Upload lifetimes independently retained between transaction requests.
    pub uploads: usize,
}

impl UpdateDrain {
    /// Ordinary controller recovery must not release a live updater's fence.
    pub fn is_draining(&self) -> bool {
        self.state
            .lock()
            .map_or(true, |state| state.operation.is_some())
    }

    /// Preserve lost physical settlement even after its controller is retired.
    pub fn mark_unsettled(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.unsettled = true;
        }
    }
    /// Accept the sole host update without fencing work. The update waits for
    /// idle through repeated `reserve_update` attempts until `finish_update`.
    pub fn accept_update(&self, operation: &str) -> UpdateReservation {
        let Ok(mut state) = self.state.lock() else {
            return UpdateReservation::Unavailable;
        };
        if state.waiting.as_deref() == Some(operation)
            || state.operation.as_deref() == Some(operation)
        {
            return UpdateReservation::AlreadyAccepted;
        }
        if state.waiting.is_some() || state.operation.is_some() {
            return UpdateReservation::Busy;
        }
        if state.unsettled {
            return UpdateReservation::Unavailable;
        }
        state.waiting = Some(operation.to_owned());
        UpdateReservation::Started
    }

    /// End an accepted update: release its fence and stop it waiting.
    pub fn finish_update(&self, operation: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.waiting.as_deref() == Some(operation) {
                state.waiting = None;
            }
            if state.operation.as_deref() == Some(operation) {
                state.operation = None;
                state.sealed = false;
            }
        }
    }

    /// Whether this update is still accepted. A waiting updater whose
    /// acceptance was finished elsewhere stops at its next attempt.
    pub fn is_accepted(&self, operation: &str) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.waiting.as_deref() == Some(operation)
                || state.operation.as_deref() == Some(operation)
        })
    }

    /// Fence admission for one idle attempt of the accepted waiting update.
    /// Never fences for an operation that is no longer accepted.
    pub fn fence_update(&self, operation: &str) -> UpdateReservation {
        let Ok(mut state) = self.state.lock() else {
            return UpdateReservation::Unavailable;
        };
        if state.unsettled {
            return UpdateReservation::Unavailable;
        }
        if state.waiting.as_deref() != Some(operation) {
            return UpdateReservation::Busy;
        }
        match state.operation.as_deref() {
            Some(current) if current == operation => UpdateReservation::AlreadyAccepted,
            Some(_) => UpdateReservation::Busy,
            None => {
                state.operation = Some(operation.to_owned());
                UpdateReservation::Started
            }
        }
    }

    /// Claim the updater and fence new work before any asynchronous proof. An
    /// accepted waiting update can only be fenced by its own operation.
    pub fn reserve_update(&self, operation: &str) -> UpdateReservation {
        let Ok(mut state) = self.state.lock() else {
            return UpdateReservation::Unavailable;
        };
        match state.operation.as_deref() {
            Some(current) if current == operation => UpdateReservation::AlreadyAccepted,
            Some(_) => UpdateReservation::Busy,
            None => {
                if state.unsettled {
                    return UpdateReservation::Unavailable;
                }
                if state
                    .waiting
                    .as_deref()
                    .is_some_and(|waiting| waiting != operation)
                {
                    return UpdateReservation::Busy;
                }
                state.operation = Some(operation.to_owned());
                UpdateReservation::Started
            }
        }
    }

    /// Release only this updater's fence; never clear unsettled physical work.
    /// An accepted waiting update stays accepted.
    pub fn release_update(&self, operation: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.operation.as_deref() == Some(operation) {
                state.operation = None;
                state.sealed = false;
            }
        }
    }

    /// Admit synchronously before spawning a worker, or an exact upload continuation.
    pub fn reserve_work(
        self: &Arc<Self>,
        identity: Option<UploadIdentity>,
    ) -> Option<WorkReservation> {
        let mut state = self.state.lock().ok()?;
        if state.operation.is_some()
            && !identity
                .as_ref()
                .is_some_and(|id| state.uploads.contains(id))
        {
            return None;
        }
        state.routed += 1;
        Some(WorkReservation(Arc::new(Reservation {
            drain: self.clone(),
            upload: false,
            identity,
        })))
    }

    /// Return no idle evidence after a lost physical/transport settlement.
    pub fn snapshot(&self) -> Option<Snapshot> {
        self.state
            .lock()
            .ok()
            .filter(|state| !state.unsettled)
            .map(|state| Snapshot {
                routed: state.routed,
                uploads: state.uploads.len(),
            })
    }

    /// Existing operation controls remain usable while draining, until the
    /// final idle check atomically seals admission for binary replacement.
    pub fn reserve_control(self: &Arc<Self>) -> Option<WorkReservation> {
        let mut state = self.state.lock().ok()?;
        if state.sealed {
            return None;
        }
        state.routed += 1;
        Some(WorkReservation(Arc::new(Reservation {
            drain: self.clone(),
            upload: false,
            identity: None,
        })))
    }

    /// Called only after engine and controller idle proofs. Controls admitted
    /// during either proof invalidate this final check rather than racing apply.
    pub fn seal_update(&self, operation: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.operation.as_deref() != Some(operation)
            || state.unsettled
            || state.routed != 0
            || !state.uploads.is_empty()
        {
            return false;
        }
        state.sealed = true;
        true
    }
}

/// Cloning retains one reservation; it does not mint new accepted work.
#[derive(Clone)]
pub struct WorkReservation(Arc<Reservation>);

impl std::fmt::Debug for WorkReservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkReservation").finish_non_exhaustive()
    }
}

impl WorkReservation {
    /// A lost transport/cleanup receipt is not proof that physical work ended.
    /// Keep updates unavailable for this process; ordinary work can continue.
    pub fn mark_unsettled(&self) {
        self.0.drain.mark_unsettled();
    }
    /// The begin RPC remains reserved while an accepted upload takes ownership.
    /// # Panics
    /// Panics if called without an admitted, registered upload identity.
    #[must_use]
    pub fn retain_upload(&self) -> Self {
        let identity = self.0.identity.clone().expect("upload route identity");
        assert!(
            self.0
                .drain
                .state
                .lock()
                .expect("update drain")
                .uploads
                .insert(identity.clone()),
            "one accepted upload lifetime"
        );
        Self(Arc::new(Reservation {
            drain: self.0.drain.clone(),
            upload: true,
            identity: Some(identity),
        }))
    }
}

struct Reservation {
    drain: Arc<UpdateDrain>,
    upload: bool,
    identity: Option<UploadIdentity>,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = self.drain.state.lock().expect("update drain");
        if self.upload {
            state
                .uploads
                .remove(self.identity.as_ref().expect("upload identity"));
        } else {
            state.routed -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_invalidate_the_final_seal_and_remain_usable_while_draining() {
        let drain = Arc::new(UpdateDrain::default());
        assert_eq!(drain.reserve_update("one"), UpdateReservation::Started);
        let control = drain.reserve_control().unwrap();
        assert!(!drain.seal_update("one"));
        drop(control);
        assert!(drain.seal_update("one"));
        assert!(drain.reserve_control().is_none());
        drain.release_update("another");
        assert!(drain.reserve_control().is_none());
        drain.release_update("one");
        assert!(drain.reserve_control().is_some());
    }

    #[test]
    fn lost_settlement_prevents_update_without_disabling_ordinary_work() {
        let drain = Arc::new(UpdateDrain::default());
        let work = drain.reserve_work(None).unwrap();
        work.mark_unsettled();
        drop(work);
        assert_eq!(drain.snapshot(), None);
        assert_eq!(drain.reserve_update("one"), UpdateReservation::Unavailable);
        assert!(drain.reserve_work(None).is_some());
    }

    #[test]
    fn pending_unpolled_work_is_reserved_before_update() {
        let drain = Arc::new(UpdateDrain::default());
        let work = drain.reserve_work(None).unwrap();
        assert_eq!(drain.reserve_update("one"), UpdateReservation::Started);
        assert_eq!(drain.snapshot().unwrap().routed, 1);
        assert!(drain.reserve_work(None).is_none());
        drop(work);
        assert_eq!(drain.snapshot().unwrap().routed, 0);
        drain.release_update("another");
        assert!(drain.reserve_work(None).is_none());
        drain.release_update("one");
        assert!(drain.reserve_work(None).is_some());
    }

    #[test]
    fn accepted_update_waits_without_fencing_until_finished() {
        let drain = Arc::new(UpdateDrain::default());
        assert_eq!(drain.accept_update("one"), UpdateReservation::Started);
        assert_eq!(
            drain.accept_update("one"),
            UpdateReservation::AlreadyAccepted
        );
        assert_eq!(drain.accept_update("two"), UpdateReservation::Busy);
        // Waiting admits ordinary work and does not report a draining updater.
        assert!(!drain.is_draining());
        let work = drain.reserve_work(None).unwrap();
        // Only the accepted operation may fence; a busy attempt releases.
        assert_eq!(drain.fence_update("two"), UpdateReservation::Busy);
        assert_eq!(drain.reserve_update("two"), UpdateReservation::Busy);
        assert_eq!(drain.fence_update("one"), UpdateReservation::Started);
        assert!(drain.reserve_work(None).is_none());
        assert!(!drain.seal_update("one"));
        drain.release_update("one");
        assert!(drain.is_accepted("one"));
        assert!(drain.reserve_work(None).is_some());
        assert_eq!(drain.accept_update("two"), UpdateReservation::Busy);
        drop(work);
        // The next attempt fences and seals once work settled.
        assert_eq!(drain.fence_update("one"), UpdateReservation::Started);
        assert!(drain.seal_update("one"));
        assert!(drain.reserve_control().is_none());
        drain.finish_update("one");
        assert!(!drain.is_accepted("one"));
        // A finished update can never fence again.
        assert_eq!(drain.fence_update("one"), UpdateReservation::Busy);
        assert!(drain.reserve_control().is_some());
        assert_eq!(drain.accept_update("two"), UpdateReservation::Started);
        drain.finish_update("two");
        drain.mark_unsettled();
        assert_eq!(drain.accept_update("three"), UpdateReservation::Unavailable);
    }

    #[test]
    fn upload_lifetime_is_distinct_from_rpc_and_survives_reconnect() {
        let drain = Arc::new(UpdateDrain::default());
        let identity = UploadIdentity {
            connection: "one".into(),
            operation: "fsw-one".into(),
            epoch: 7,
        };
        let begin = drain.reserve_work(Some(identity.clone())).unwrap();
        let upload = begin.retain_upload();
        drop(begin);
        assert_eq!(
            drain.snapshot().unwrap(),
            Snapshot {
                routed: 0,
                uploads: 1
            }
        );
        assert_eq!(drain.reserve_update("one"), UpdateReservation::Started);
        let continuation = drain.reserve_work(Some(identity.clone())).unwrap();
        let mut other = identity.clone();
        other.connection = "another-connection".into();
        assert!(drain.reserve_work(Some(other)).is_none());
        let mut newer = identity.clone();
        newer.epoch += 1;
        assert!(drain.reserve_work(Some(newer)).is_none());
        assert!(drain.reserve_work(None).is_none());
        drop(continuation);
        // Dropping generation-bound replies does not destroy the transaction.
        assert_eq!(drain.snapshot().unwrap().uploads, 1);
        drop(upload);
        assert_eq!(
            drain.snapshot().unwrap(),
            Snapshot {
                routed: 0,
                uploads: 0
            }
        );
    }

    #[tokio::test]
    async fn cancellation_of_unpolled_or_timed_out_rpc_releases_reservation() {
        let drain = Arc::new(UpdateDrain::default());
        let work = drain.reserve_work(None).unwrap();
        let mut tasks = tokio::task::JoinSet::new();
        tasks.spawn(async move {
            let _work = work;
            std::future::pending::<()>().await;
        });
        tasks.shutdown().await;
        assert_eq!(drain.snapshot().unwrap().routed, 0);
        let work = drain.reserve_work(None).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), async move {
                let _work = work;
                std::future::pending::<()>().await;
            })
            .await
            .is_err()
        );
        assert_eq!(drain.snapshot().unwrap().routed, 0);
    }
}
