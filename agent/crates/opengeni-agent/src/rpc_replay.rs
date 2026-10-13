//! Process-scoped control delivery receipts. Transport generations never own
//! execution. A delivery is admitted once, and a successor socket can retrieve
//! its exact reply. Expiry rejects delayed buffered requests, not just cached
//! replies, so collecting a receipt cannot license another execution.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use opengeni_agent_platform::WorkReservation;
use tokio::sync::watch;

tokio::task_local! {
    static REPLY: Option<Arc<Receipt>>;
}

pub fn current() -> Option<Arc<Receipt>> {
    REPLY.try_with(Clone::clone).ok().flatten()
}

pub async fn scope<F: Future>(receipt: Option<Arc<Receipt>>, work: F) -> F::Output {
    REPLY.scope(receipt, work).await
}

#[derive(Default)]
pub struct Registry {
    entries: HashMap<String, Arc<Receipt>>,
    // Once an expiry was observed, a wall-clock rollback must not revive it.
    clock_floor: u64,
}

pub enum Admission {
    New(Arc<Receipt>),
    Existing(Arc<Receipt>),
    Rejected,
}

impl Registry {
    pub fn collect(&mut self) {
        self.clock_floor = self.clock_floor.max(now_ms());
        self.entries
            .retain(|_, entry| entry.expires_at > self.clock_floor);
    }

    pub fn admit(&mut self, suffix: &str, payload: &[u8]) -> Admission {
        self.clock_floor = self.clock_floor.max(now_ms());
        let Some((expires, id)) = suffix.split_once('.') else {
            return Admission::Rejected;
        };
        let Ok(expires_at) = expires.parse::<u64>() else {
            return Admission::Rejected;
        };
        if expires_at <= self.clock_floor || uuid::Uuid::parse_str(id).is_err() {
            return Admission::Rejected;
        }
        let digest = blake3::hash(payload);
        if let Some(entry) = self.entries.get(id) {
            return if entry.digest == digest && entry.expires_at == expires_at {
                Admission::Existing(entry.clone())
            } else {
                Admission::Rejected
            };
        }
        let (reply, _) = watch::channel(None);
        let entry = Arc::new(Receipt {
            expires_at,
            digest,
            reply,
            reservation: Mutex::new(None),
        });
        self.entries.insert(id.to_owned(), entry.clone());
        Admission::New(entry)
    }
}

pub fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

pub struct Receipt {
    expires_at: u64,
    digest: blake3::Hash,
    reply: watch::Sender<Option<Arc<Vec<u8>>>>,
    // A lost publication is not settled work. Keep its original guard until
    // some socket has a publication receipt; never clear a physical-work fault.
    reservation: Mutex<Option<WorkReservation>>,
}

impl Receipt {
    pub fn complete(&self, payload: Vec<u8>, reservation: Option<WorkReservation>) {
        *self.reservation.lock().expect("reply reservation") = reservation;
        self.reply.send_replace(Some(Arc::new(payload)));
    }

    pub async fn deliver(&self, client: &async_nats::Client, subject: async_nats::Subject) {
        let mut receiver = self.reply.subscribe();
        let payload = loop {
            if let Some(payload) = receiver.borrow_and_update().clone() {
                break payload;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        };
        match client
            .publish_with_flush(subject, payload.as_ref().clone().into())
            .await
        {
            Ok(()) => {
                self.reservation.lock().expect("reply reservation").take();
            }
            Err(error) => {
                tracing::debug!(%error, "control reply retained for transport recovery");
            }
        }
    }
}

impl Drop for Receipt {
    fn drop(&mut self) {
        if let Some(reservation) = self.reservation.lock().expect("reply reservation").take() {
            // Expiry or shutdown without publication proof remains uncertain.
            reservation.mark_unsettled();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_delivery_joins_but_changed_bytes_or_expiry_cannot_execute() {
        let mut registry = Registry::default();
        let id = uuid::Uuid::new_v4();
        let expiry = now_ms() + 120_000;
        let subject = format!("{expiry}.{id}");
        let Admission::New(first) = registry.admit(&subject, b"mutation") else {
            panic!("new delivery");
        };
        let Admission::Existing(second) = registry.admit(&subject, b"mutation") else {
            panic!("must join accepted delivery");
        };
        assert!(Arc::ptr_eq(&first, &second));
        assert!(matches!(
            registry.admit(&subject, b"changed"),
            Admission::Rejected
        ));
        assert!(matches!(
            registry.admit(&format!("{}.{id}", expiry + 1), b"mutation"),
            Admission::Rejected
        ));
        registry.clock_floor = expiry;
        registry.collect();
        assert!(registry.entries.is_empty());
        assert!(matches!(
            registry.admit(&subject, b"mutation"),
            Admission::Rejected
        ));
    }

    #[tokio::test]
    async fn child_work_inherits_the_receipt_explicitly() {
        let mut registry = Registry::default();
        let subject = format!("{}.{}", now_ms() + 120_000, uuid::Uuid::new_v4());
        let Admission::New(receipt) = registry.admit(&subject, b"mutation") else {
            panic!("new delivery");
        };
        scope(Some(receipt.clone()), async {
            let captured = current();
            tokio::spawn(scope(captured, async {
                current().unwrap().complete(b"exact reply".to_vec(), None);
            }))
            .await
            .unwrap();
        })
        .await;
        assert_eq!(
            receipt.reply.borrow().as_deref(),
            Some(&b"exact reply".to_vec())
        );
    }
}
