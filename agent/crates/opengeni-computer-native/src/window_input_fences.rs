use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_RECENT_FENCES: usize = 64;
const MAX_SUPERSEDED_AGE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowInputIdentity {
    pub(crate) target_id: String,
    pub(crate) generation: String,
    pub(crate) key: String,
    pub(crate) client: String,
}

struct ObservedWindow<T> {
    identity: WindowInputIdentity,
    observation_id: String,
    observed_at: Instant,
    value: T,
}

/// Keeps only immutable window identity, never semantic refs or image bytes.
/// Read-only observations cannot revoke an immediately following keyboard or
/// clipboard action. Callers must still revalidate the original native object,
/// process, placement and live focus before every physical delivery.
pub(crate) struct WindowInputFences<T> {
    recent: VecDeque<ObservedWindow<T>>,
}

impl<T> WindowInputFences<T> {
    pub(crate) fn new() -> Self {
        Self {
            recent: VecDeque::new(),
        }
    }

    pub(crate) fn remember(
        &mut self,
        identity: WindowInputIdentity,
        observation_id: String,
        value: T,
        observed_at: Instant,
        now: Instant,
    ) {
        self.recent.retain(|entry| {
            now.saturating_duration_since(entry.observed_at) <= MAX_SUPERSEDED_AGE
                && entry.observation_id != observation_id
                && (entry.identity.target_id != identity.target_id || entry.identity == identity)
        });
        if now.saturating_duration_since(observed_at) > MAX_SUPERSEDED_AGE {
            return;
        }
        self.recent.push_back(ObservedWindow {
            identity,
            observation_id,
            observed_at,
            value,
        });
        while self.recent.len() > MAX_RECENT_FENCES {
            self.recent.pop_front();
        }
    }

    pub(crate) fn get(
        &self,
        identity: &WindowInputIdentity,
        observation_id: &str,
        now: Instant,
    ) -> Option<&T> {
        self.recent
            .iter()
            .rev()
            .find(|entry| {
                entry.identity == *identity
                    && entry.observation_id == observation_id
                    && now.saturating_duration_since(entry.observed_at) <= MAX_SUPERSEDED_AGE
            })
            .map(|entry| &entry.value)
    }

    pub(crate) fn forget_target(&mut self, target_id: &str) {
        self.recent
            .retain(|entry| entry.identity.target_id != target_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(target: &str, generation: &str, key: &str, client: &str) -> WindowInputIdentity {
        WindowInputIdentity {
            target_id: target.into(),
            generation: generation.into(),
            key: key.into(),
            client: client.into(),
        }
    }

    #[test]
    fn read_only_refresh_retains_only_the_original_window_identity() {
        let now = Instant::now();
        let mut fences = WindowInputFences::new();
        fences.remember(
            identity("window-a", "generation-a", "object-a", "client-a"),
            "observation-a".into(),
            42,
            now,
            now,
        );
        fences.remember(
            identity("window-a", "generation-a", "object-a", "client-a"),
            "observation-b".into(),
            43,
            now,
            now,
        );
        assert_eq!(
            fences.get(
                &identity("window-a", "generation-a", "object-a", "client-a"),
                "observation-a",
                now,
            ),
            Some(&42)
        );
        for (target, generation, key, observation) in [
            ("window-b", "generation-a", "object-a", "observation-a"),
            ("window-a", "generation-b", "object-a", "observation-a"),
            ("window-a", "generation-a", "object-b", "observation-a"),
            ("window-a", "generation-a", "object-a", "observation-c"),
        ] {
            assert!(fences
                .get(
                    &identity(target, generation, key, "client-a"),
                    observation,
                    now
                )
                .is_none());
        }
        assert!(fences
            .get(
                &identity("window-a", "generation-a", "object-a", "client-b"),
                "observation-a",
                now,
            )
            .is_none());
    }

    #[test]
    fn superseded_identity_expires_and_storage_is_globally_bounded() {
        let now = Instant::now();
        let mut fences = WindowInputFences::new();
        for index in 0..=MAX_RECENT_FENCES {
            fences.remember(
                identity(&format!("window-{index}"), "generation", "object", "client"),
                format!("observation-{index}"),
                index,
                now,
                now,
            );
        }
        assert_eq!(fences.recent.len(), MAX_RECENT_FENCES);
        assert!(fences
            .get(
                &identity("window-0", "generation", "object", "client"),
                "observation-0",
                now,
            )
            .is_none());
        assert_eq!(
            fences.get(
                &identity("window-1", "generation", "object", "client"),
                "observation-1",
                now + MAX_SUPERSEDED_AGE
            ),
            Some(&1)
        );
        let expired = now + MAX_SUPERSEDED_AGE + Duration::from_nanos(1);
        assert!(fences
            .get(
                &identity("window-1", "generation", "object", "client"),
                "observation-1",
                expired,
            )
            .is_none());
        fences.remember(
            identity("window-new", "generation", "object", "client"),
            "observation-new".into(),
            100,
            expired,
            expired,
        );
        assert_eq!(fences.recent.len(), 1);
    }

    #[test]
    fn an_observed_identity_discontinuity_never_revives_earlier_observations() {
        let now = Instant::now();
        let original = identity("window-a", "generation-a", "object-a", "client-a");
        for changed in [
            identity("window-a", "generation-b", "object-a", "client-a"),
            identity("window-a", "generation-a", "object-b", "client-a"),
            identity("window-a", "generation-a", "object-a", "client-b"),
        ] {
            let mut fences = WindowInputFences::new();
            fences.remember(original.clone(), "o-original".into(), 1, now, now);
            fences.remember(changed, "o-changed".into(), 2, now, now);
            fences.remember(original.clone(), "o-returned".into(), 3, now, now);
            assert!(fences.get(&original, "o-original", now).is_none());
            assert_eq!(fences.get(&original, "o-returned", now), Some(&3));
        }
    }

    #[test]
    fn missing_identity_and_slow_enrichment_cannot_extend_old_authority() {
        let now = Instant::now();
        let identity = identity("window-a", "generation-a", "object-a", "client-a");
        let mut fences = WindowInputFences::new();
        fences.remember(identity.clone(), "o-original".into(), 1, now, now);
        fences.forget_target(&identity.target_id);
        fences.remember(identity.clone(), "o-returned".into(), 2, now, now);
        assert!(fences.get(&identity, "o-original", now).is_none());
        let finished = now + MAX_SUPERSEDED_AGE + Duration::from_nanos(1);
        fences.remember(identity.clone(), "o-slow".into(), 3, now, finished);
        assert!(fences.get(&identity, "o-slow", finished).is_none());
    }
}
