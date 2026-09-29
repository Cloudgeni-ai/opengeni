//! Process-wide reservation boundary shared by routed work and self-update.
//! Reserve before spawning: an unpolled task must already prevent an idle proof.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct UpdateDrain {
    state: Mutex<State>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct UploadIdentity {
    pub connection: String,
    pub operation: String,
    pub epoch: u32,
}

#[derive(Default)]
struct State {
    operation: Option<String>,
    routed: usize,
    uploads: HashSet<UploadIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateReservation {
    Started,
    AlreadyAccepted,
    Busy,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub routed: usize,
    pub uploads: usize,
}

impl UpdateDrain {
    pub fn reserve_update(&self, operation: &str) -> UpdateReservation {
        let Ok(mut state) = self.state.lock() else {
            return UpdateReservation::Unavailable;
        };
        match state.operation.as_deref() {
            Some(current) if current == operation => UpdateReservation::AlreadyAccepted,
            Some(_) => UpdateReservation::Busy,
            None => {
                state.operation = Some(operation.to_owned());
                UpdateReservation::Started
            }
        }
    }

    pub fn release_update(&self, operation: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.operation.as_deref() == Some(operation) {
                state.operation = None;
            }
        }
    }

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

    pub fn snapshot(&self) -> Option<Snapshot> {
        self.state.lock().ok().map(|state| Snapshot {
            routed: state.routed,
            uploads: state.uploads.len(),
        })
    }
}

/// Cloning retains one reservation; it does not mint new accepted work.
#[derive(Clone)]
pub(crate) struct WorkReservation(Arc<Reservation>);

impl WorkReservation {
    /// The begin RPC remains reserved while an accepted upload takes ownership.
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
