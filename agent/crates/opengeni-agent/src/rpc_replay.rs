//! Process-scoped control delivery receipts. Transport generations never own
//! execution. A delivery is admitted once, and a successor socket can retrieve
//! its exact reply. Expiry rejects delayed buffered requests, not just cached
//! replies, so collecting a receipt cannot license another execution.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    entries: HashMap<String, Lease>,
}

struct Lease {
    issued_at: Duration,
    expires_at: Duration,
    receipt: Option<Arc<Receipt>>,
}

pub enum Admission {
    New(Arc<Receipt>),
    Existing(Arc<Receipt>),
    Rejected(Rejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    ExpiredOrUnknown,
    ConflictingPayload,
    InvalidWindow,
    ClockUnavailable,
}

impl Rejection {
    pub fn response(self, request_id: String) -> opengeni_agent_proto::v1::ControlResponse {
        use opengeni_agent_proto::v1;
        let (code, message) = match self {
            Self::ExpiredOrUnknown => (
                "control_delivery_expired",
                "The machine's control delivery receipt expired or is unavailable. Earlier execution may have occurred; inspect the outcome before retrying.",
            ),
            Self::ConflictingPayload => (
                "control_delivery_conflict",
                "The control delivery conflicts with its original request. Earlier execution may have occurred; inspect the outcome before retrying.",
            ),
            Self::InvalidWindow => (
                "control_delivery_window_invalid",
                "The requested control delivery lifetime is invalid.",
            ),
            Self::ClockUnavailable => (
                "control_delivery_clock_unavailable",
                "The machine could not read its elapsed-time clock. Check the agent logs before retrying; an earlier delivery may have executed.",
            ),
        };
        v1::ControlResponse {
            request_id,
            result: None,
            error: Some(v1::AgentError {
                code: v1::ErrorCode::Protocol as i32,
                message: message.to_owned(),
                retryable: false,
                detail: HashMap::from([
                    ("failure_code".to_owned(), code.to_owned()),
                    (
                        "outcome_unknown".to_owned(),
                        (self != Self::InvalidWindow).to_string(),
                    ),
                ]),
            }),
        }
    }
}

impl Registry {
    pub fn collect(&mut self) {
        if let Ok(now) = opengeni_agent_platform::continuous_time() {
            self.collect_at(now);
        }
    }

    fn collect_at(&mut self, now: Duration) {
        self.entries.retain(|_, entry| entry.expires_at > now);
    }

    /// The receiver issues the identity before execution. An absent identity is
    /// never admitted, including after collection, restart or a clock correction.
    pub fn issue(&mut self, lifetime: Duration) -> Result<String, Rejection> {
        self.issue_at(lifetime, Self::now()?)
    }

    fn now() -> Result<Duration, Rejection> {
        opengeni_agent_platform::continuous_time().map_err(|error| {
            tracing::warn!(%error, "control delivery elapsed clock unavailable");
            Rejection::ClockUnavailable
        })
    }

    fn issue_at(&mut self, lifetime: Duration, now: Duration) -> Result<String, Rejection> {
        let Some(expires_at) = now.checked_add(lifetime).filter(|_| !lifetime.is_zero()) else {
            return Err(Rejection::InvalidWindow);
        };
        let token = uuid::Uuid::new_v4().to_string();
        self.entries.insert(
            token.clone(),
            Lease {
                issued_at: now,
                expires_at,
                receipt: None,
            },
        );
        Ok(token)
    }

    pub fn admit(&mut self, token: &str, payload: &[u8]) -> Admission {
        match Self::now() {
            Ok(now) => self.admit_at(token, payload, now),
            Err(reason) => Admission::Rejected(reason),
        }
    }

    fn admit_at(&mut self, token: &str, payload: &[u8], now: Duration) -> Admission {
        let Some(lease) = self.entries.get_mut(token) else {
            return Admission::Rejected(Rejection::ExpiredOrUnknown);
        };
        if lease.expires_at <= now {
            return Admission::Rejected(Rejection::ExpiredOrUnknown);
        }
        let digest = blake3::hash(payload);
        if let Some(entry) = &lease.receipt {
            return if entry.digest == digest {
                Admission::Existing(entry.clone())
            } else {
                Admission::Rejected(Rejection::ConflictingPayload)
            };
        }
        let (reply, _) = watch::channel(None);
        let entry = Arc::new(Receipt {
            issued_at: lease.issued_at,
            digest,
            reply,
            reservation: Mutex::new(None),
        });
        lease.receipt = Some(entry.clone());
        Admission::New(entry)
    }
}

pub struct Receipt {
    issued_at: Duration,
    digest: blake3::Hash,
    reply: watch::Sender<Option<Arc<Vec<u8>>>>,
    // Keep the original guard through publication or receipt expiry. Physical
    // producers own their own clones; losing a reply is not live native work.
    reservation: Mutex<Option<WorkReservation>>,
}

impl Receipt {
    /// The existing relative exec budget starts at lease issuance, not at a
    /// delayed delivery or retry. A zero budget still means no process deadline.
    pub fn exec_deadline(
        &self,
        timeout_ms: u32,
    ) -> Result<Option<tokio::time::Instant>, Rejection> {
        Ok(self
            .exec_remaining(timeout_ms, Registry::now()?)
            .map(|remaining| tokio::time::Instant::now() + remaining))
    }

    fn exec_remaining(&self, timeout_ms: u32, now: Duration) -> Option<Duration> {
        (timeout_ms != 0).then(|| {
            Duration::from_millis(u64::from(timeout_ms))
                .saturating_sub(now.saturating_sub(self.issued_at))
        })
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_reply_does_not_poison_updates_or_release_a_live_producer() {
        use opengeni_agent_engine::update_drain::{UpdateDrain, UpdateReservation};
        let drain = Arc::new(UpdateDrain::default());
        let physical = drain.reserve_work(None).unwrap();
        let mut registry = Registry::default();
        let start = Registry::now().unwrap();
        let expiry = start + Duration::from_secs(120);
        let subject = registry.issue_at(Duration::from_secs(120), start).unwrap();
        let Admission::New(receipt) = registry.admit(&subject, b"mutation") else {
            panic!("admit")
        };
        receipt.complete(b"reply".to_vec(), Some(physical.clone()));
        drop(receipt);
        registry.collect_at(expiry);
        assert!(matches!(
            registry.admit(&subject, b"mutation"),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        assert_eq!(drain.reserve_update("update"), UpdateReservation::Started);
        assert!(!drain.seal_update("update"));
        drop(physical);
        assert!(drain.seal_update("update"));
    }

    #[test]
    fn concurrent_delivery_joins_but_changed_bytes_cannot_execute() {
        let mut registry = Registry::default();
        let start = Registry::now().unwrap();
        let expiry = start + Duration::from_secs(120);
        let subject = registry.issue_at(Duration::from_secs(120), start).unwrap();
        let Admission::New(first) = registry.admit(&subject, b"mutation") else {
            panic!("new delivery");
        };
        let Admission::Existing(second) = registry.admit(&subject, b"mutation") else {
            panic!("must join accepted delivery");
        };
        assert!(Arc::ptr_eq(&first, &second));
        assert!(matches!(
            registry.admit(&subject, b"changed"),
            Admission::Rejected(Rejection::ConflictingPayload)
        ));
        assert!(matches!(
            registry.admit(&format!("9999999999999.{subject}"), b"mutation"),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        assert!(matches!(
            registry.admit_at(
                &subject,
                b"mutation",
                expiry.checked_sub(Duration::from_millis(1)).unwrap()
            ),
            Admission::Existing(_)
        ));
        assert!(matches!(
            registry.admit_at(&subject, b"mutation", expiry),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        registry.collect_at(expiry);
        assert!(registry.entries.is_empty());
        assert!(matches!(
            registry.admit(&subject, b"mutation"),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
    }

    #[test]
    fn expired_unused_tokens_and_other_registries_never_admit_delayed_delivery() {
        let mut registry = Registry::default();
        let start = Registry::now().unwrap();
        let token = registry.issue_at(Duration::from_secs(2), start).unwrap();
        let mut successor = Registry::default();
        assert!(matches!(
            successor.admit(&token, b"mutation"),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        assert!(matches!(
            registry.admit_at(&token, b"mutation", start + Duration::from_secs(2)),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        registry.collect_at(start + Duration::from_secs(2));
        assert!(matches!(
            registry.admit_at(&token, b"mutation", start),
            Admission::Rejected(Rejection::ExpiredOrUnknown)
        ));
        let fresh = registry
            .issue_at(Duration::from_secs(2), start + Duration::from_secs(3))
            .unwrap();
        assert!(matches!(
            registry.admit_at(&fresh, b"new request", start + Duration::from_secs(3)),
            Admission::New(_)
        ));
    }

    #[test]
    fn invalid_lifetime_does_not_allocate_a_token() {
        let mut registry = Registry::default();
        assert_eq!(
            registry.issue(Duration::ZERO),
            Err(Rejection::InvalidWindow)
        );
        assert_eq!(registry.issue(Duration::MAX), Err(Rejection::InvalidWindow));
        assert!(registry.entries.is_empty());
    }

    #[test]
    fn exec_budget_starts_at_issuance_and_is_not_reset_by_delivery_or_retries() {
        let mut registry = Registry::default();
        let start = Registry::now().unwrap();
        let token = registry.issue_at(Duration::from_secs(120), start).unwrap();
        let Admission::New(receipt) =
            registry.admit_at(&token, b"exec", start + Duration::from_secs(5))
        else {
            panic!("lease admitted")
        };
        assert_eq!(
            receipt.exec_remaining(10_000, start + Duration::from_secs(5)),
            Some(Duration::from_secs(5))
        );
        assert!(receipt.exec_remaining(0, start).is_none());
        let Admission::Existing(replayed) =
            registry.admit_at(&token, b"exec", start + Duration::from_secs(15))
        else {
            panic!("same receipt")
        };
        assert_eq!(
            replayed.exec_remaining(10_000, start + Duration::from_secs(15)),
            Some(Duration::ZERO)
        );
    }

    #[tokio::test]
    async fn child_work_inherits_the_receipt_explicitly() {
        let mut registry = Registry::default();
        let subject = registry.issue(Duration::from_secs(120)).unwrap();
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
