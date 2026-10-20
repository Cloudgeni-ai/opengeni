//! API keys: callers name theirs in `X-API-Key`; the store holds only each
//! key's digest and its team. Both public APIs, ours and the E2B one, read
//! keys through here, with a short cache.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

use crate::store::{Store, StoreError};

/// How long a key's team stays cached.
const KEY_TTL: Duration = Duration::from_secs(60);

/// The digest the store keeps of an API key.
#[must_use]
pub fn key_digest(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

/// The teams of keys seen lately.
#[derive(Debug, Default)]
pub struct Keys {
    cache: Mutex<HashMap<String, (String, Instant)>>,
}

impl Keys {
    /// The team of the key in `headers`' `X-API-Key`; `None` without a
    /// key or for a key the store does not know.
    ///
    /// # Errors
    ///
    /// When the store cannot be read.
    pub async fn team<S: Store>(
        &self,
        store: &S,
        headers: &HeaderMap,
    ) -> Result<Option<String>, StoreError> {
        let Some(key) = headers.get("x-api-key").and_then(|key| key.to_str().ok()) else {
            return Ok(None);
        };
        let digest = key_digest(key);
        let cached = {
            let cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            cache
                .get(&digest)
                .filter(|(_, when)| when.elapsed() < KEY_TTL)
                .map(|(team, _)| team.clone())
        };
        if cached.is_some() {
            return Ok(cached);
        }
        let Some(team) = store.team_of(&digest).await? else {
            return Ok(None);
        };
        self.cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(digest, (team.clone(), Instant::now()));
        Ok(Some(team))
    }
}
