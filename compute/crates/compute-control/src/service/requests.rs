//! Creates their caller names with a request id, so retrying one after a
//! lost answer is safe: the same id answers the sandbox it made, the same
//! id for another create is refused, and after that sandbox was deleted
//! the id answers that it is gone.

use std::collections::BTreeMap;

use compute_protocol::host::PriorityName;
use serde::Serialize;

use super::{Failure, Service, new_id, now_ms};
use crate::store::{RequestRow, SandboxRow, Spec, Store};

/// The digest a create's request is known by: BLAKE3 over its JSON.
#[must_use]
pub fn request_digest(asked: &impl Serialize) -> String {
    blake3::hash(&serde_json::to_vec(asked).unwrap_or_default())
        .to_hex()
        .to_string()
}

/// Refuses a request id that is not 1 to 128 of `[A-Za-z0-9._:-]`.
fn validate(request_id: &str) -> Result<(), Failure> {
    let valid = (1..=128).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(Failure::Invalid(
            "a request id is 1 to 128 of [A-Za-z0-9._:-]".into(),
        ))
    }
}

impl<S: Store> Service<S> {
    /// Creates `team`'s sandbox for request `request_id`, whose create
    /// digests to `digest`, or, when that request made one already, wakes
    /// it and answers it.
    ///
    /// # Errors
    ///
    /// [`Failure::Mismatch`] when the request id was used for another
    /// create, [`Failure::Gone`] when the sandbox it made was deleted, and
    /// as [`Service::create`] and [`Service::wake`] otherwise.
    pub async fn create_requested(
        &self,
        team: &str,
        request_id: &str,
        digest: &str,
        spec: Spec,
        metadata: BTreeMap<String, String>,
    ) -> Result<SandboxRow, Failure> {
        validate(request_id)?;
        let asked = RequestRow {
            team: team.to_owned(),
            request_id: request_id.to_owned(),
            id: new_id()?,
            digest: digest.to_owned(),
            created_ms: now_ms(),
            gone_ms: None,
        };
        let claimed = self.store.claim_request(&asked).await?;
        if claimed.digest != digest {
            return Err(Failure::Mismatch(request_id.to_owned()));
        }
        if claimed.gone() {
            return Err(Failure::Gone(request_id.to_owned()));
        }
        match self.store.sandbox(claimed.id).await? {
            // The first attempt, or one after a create that left nothing;
            // if its sandbox was deleted since the request was read, the
            // insert finds the request retired.
            None => {
                self.create_for(claimed.id, team, spec, metadata, Some(request_id))
                    .await
            }
            Some(row) if row.team == team => {
                let reached = self
                    .wake(team, claimed.id, PriorityName::Interactive)
                    .await?;
                Ok(reached.row)
            }
            Some(_) => Err(Failure::NotFound),
        }
    }

    /// The sandbox `team`'s request `request_id` made.
    ///
    /// # Errors
    ///
    /// [`Failure::NotFound`] when there is no such request or it made no
    /// sandbox, and [`Failure::Gone`] when that sandbox was deleted.
    pub async fn requested(&self, team: &str, request_id: &str) -> Result<SandboxRow, Failure> {
        let request = self
            .store
            .request(team, request_id)
            .await?
            .ok_or(Failure::NotFound)?;
        if request.gone() {
            return Err(Failure::Gone(request_id.to_owned()));
        }
        self.get(team, request.id).await
    }

    /// Forgets requests whose sandbox was deleted at least `keep_ms` ago.
    /// Answers how many.
    ///
    /// # Errors
    ///
    /// When the store fails.
    pub async fn prune_requests(&self, keep_ms: u64) -> Result<u64, Failure> {
        Ok(self
            .store
            .prune_requests(now_ms().saturating_sub(keep_ms))
            .await?)
    }

    /// Forgets hosts given up on at least `keep_ms` ago. Answers how many.
    ///
    /// # Errors
    ///
    /// When the store fails.
    pub async fn prune_hosts(&self, keep_ms: u64) -> Result<u64, Failure> {
        Ok(self
            .store
            .prune_hosts(now_ms().saturating_sub(keep_ms))
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_are_bounded_tokens() {
        assert!(validate("og:lease-1.a_b").is_ok());
        assert!(validate(&"x".repeat(128)).is_ok());
        for bad in ["", "a b", "a/b", "é", &"x".repeat(129)] {
            assert!(validate(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn digests_follow_the_whole_request() {
        let a = request_digest(&serde_json::json!({"vcpus": 2, "init": {"agent": "a"}}));
        let b = request_digest(&serde_json::json!({"vcpus": 2, "init": {"agent": "b"}}));
        assert_ne!(a, b);
        assert_eq!(
            a,
            request_digest(&serde_json::json!({"vcpus": 2, "init": {"agent": "a"}}))
        );
    }
}
