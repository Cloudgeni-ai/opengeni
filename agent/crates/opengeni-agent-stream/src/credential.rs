//! The relay credential a stream presents when it registers.
//!
//! A Connected Machine's credential comes from its enrollment and is fixed
//! for the life of its connection file ([`RelayCredential::fixed`]). An agent
//! in a fabric sandbox has none at start: its host hands it a relay address
//! and a short-lived producer token, and a fresh one before that expires
//! ([`RelayCredential::pending`] then [`RelayCredential::set`]). Every
//! registration, the first and each reconnect, takes one snapshot of the
//! current credential, so a stream that reconnects after its token was
//! replaced presents the new one.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::error::{StreamError, StreamResult};

/// How long a registration waits for a credential when there is none it can
/// use: an agent whose host has not sent one yet, or whose last one expired.
pub const CREDENTIAL_WAIT: Duration = Duration::from_secs(10);

/// A token closer than this to its expiry is not presented: the relay checks
/// it when the registration arrives, not when it was sent.
const EXPIRY_MARGIN_MS: u64 = 2_000;

/// A relay address and the producer token to present there.
#[derive(Clone, PartialEq, Eq)]
pub struct RelayEndpoint {
    /// The relay base URL (`wss://relay…`); the channel appends its routing
    /// query.
    pub url: String,
    /// The producer token. Never logged.
    pub token: String,
    /// Unix milliseconds at which the relay stops accepting the token, or
    /// `None` for an enrollment token that does not expire on its own.
    pub expires_at_ms: Option<u64>,
}

impl std::fmt::Debug for RelayEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayEndpoint")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl RelayEndpoint {
    fn usable_at(&self, now_ms: u64) -> bool {
        self.expires_at_ms
            .is_none_or(|expires| now_ms.saturating_add(EXPIRY_MARGIN_MS) < expires)
    }
}

/// The shared, replaceable relay credential of one agent connection. Cheap to
/// clone; every clone sees the same latest value.
#[derive(Clone)]
pub struct RelayCredential {
    latest: Arc<watch::Sender<Option<RelayEndpoint>>>,
}

impl std::fmt::Debug for RelayCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let latest = self.latest.borrow();
        f.debug_struct("RelayCredential")
            .field("url", &latest.as_ref().map(|endpoint| endpoint.url.clone()))
            .field(
                "expires_at_ms",
                &latest.as_ref().and_then(|endpoint| endpoint.expires_at_ms),
            )
            .finish_non_exhaustive()
    }
}

impl RelayCredential {
    /// A credential that never changes: a Connected Machine's enrollment.
    #[must_use]
    pub fn fixed(url: impl Into<String>, token: impl Into<String>) -> Self {
        let credential = Self::pending();
        credential.set(RelayEndpoint {
            url: url.into(),
            token: token.into(),
            expires_at_ms: None,
        });
        credential
    }

    /// A credential that arrives later, through [`set`](Self::set).
    #[must_use]
    pub fn pending() -> Self {
        let (latest, _) = watch::channel(None);
        Self {
            latest: Arc::new(latest),
        }
    }

    /// Replaces the credential. Registrations waiting for one proceed with it;
    /// streams already registered keep theirs until they reconnect.
    pub fn set(&self, endpoint: RelayEndpoint) {
        self.latest.send_replace(Some(endpoint));
    }

    /// The credential to present now, waiting up to [`CREDENTIAL_WAIT`] for
    /// one when there is none that is still valid.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`], which callers retry, when none arrives in
    /// time.
    pub async fn current(&self) -> StreamResult<RelayEndpoint> {
        self.current_within(CREDENTIAL_WAIT).await
    }

    /// [`current`](Self::current) with an explicit wait.
    ///
    /// # Errors
    ///
    /// [`StreamError::Transport`] when no usable credential arrives within
    /// `wait`.
    pub async fn current_within(&self, wait: Duration) -> StreamResult<RelayEndpoint> {
        let mut latest = self.latest.subscribe();
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(endpoint) = latest
                .borrow_and_update()
                .as_ref()
                .filter(|endpoint| endpoint.usable_at(now_ms()))
            {
                return Ok(endpoint.clone());
            }
            // The sender lives in `self`, so `changed` ends only by a new value
            // or the deadline.
            if tokio::time::timeout_at(deadline, latest.changed())
                .await
                .is_err()
            {
                return Err(StreamError::Transport(
                    "no valid relay credential yet".to_string(),
                ));
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(token: &str, expires_at_ms: Option<u64>) -> RelayEndpoint {
        RelayEndpoint {
            url: "wss://relay.example/stream".to_string(),
            token: token.to_string(),
            expires_at_ms,
        }
    }

    #[tokio::test]
    async fn a_fixed_credential_is_current_at_once() {
        let credential = RelayCredential::fixed("wss://relay.example/stream", "ogr_x");
        let current = credential
            .current_within(Duration::ZERO)
            .await
            .expect("fixed credential");
        assert_eq!(current, endpoint("ogr_x", None));
    }

    #[tokio::test(start_paused = true)]
    async fn a_pending_credential_waits_for_the_first_value() {
        let credential = RelayCredential::pending();
        let waiter = tokio::spawn({
            let credential = credential.clone();
            async move { credential.current().await }
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!waiter.is_finished());
        credential.set(endpoint("ogr_first", Some(u64::MAX)));
        let current = waiter.await.expect("join").expect("credential");
        assert_eq!(current.token, "ogr_first");
    }

    #[tokio::test(start_paused = true)]
    async fn no_credential_in_time_is_a_retryable_transport_error() {
        let error = RelayCredential::pending()
            .current()
            .await
            .expect_err("nothing arrives");
        assert!(error.retryable(), "{error:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_token_is_not_presented_and_its_successor_is() {
        let credential = RelayCredential::pending();
        credential.set(endpoint("ogr_old", Some(now_ms().saturating_sub(1))));
        let waiter = tokio::spawn({
            let credential = credential.clone();
            async move { credential.current().await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!waiter.is_finished(), "an expired token must not be used");
        credential.set(endpoint("ogr_new", Some(now_ms() + 3_600_000)));
        assert_eq!(
            waiter.await.expect("join").expect("credential").token,
            "ogr_new"
        );
    }

    #[test]
    fn a_token_about_to_expire_is_not_usable() {
        let now = 1_000_000;
        assert!(!endpoint("t", Some(now + 1_000)).usable_at(now));
        assert!(endpoint("t", Some(now + 10_000)).usable_at(now));
        assert!(endpoint("t", None).usable_at(u64::MAX));
    }

    #[test]
    fn debug_output_never_shows_the_token() {
        let credential = RelayCredential::fixed("wss://relay.example", "ogr_secret");
        assert!(!format!("{credential:?}").contains("ogr_secret"));
        assert!(!format!("{:?}", endpoint("ogr_secret", None)).contains("ogr_secret"));
    }
}
