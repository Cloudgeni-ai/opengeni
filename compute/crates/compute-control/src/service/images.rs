//! Asking a host to build a stored image (see [`crate::images`]).

use std::collections::BTreeMap;
use std::time::Duration;

use compute_fleet::HostState;
use compute_protocol::host::{ImageId, Reply, Request};

use super::{Failure, Service, host_failure, now_ms};
use crate::images::built_key;
use crate::store::Store;

/// How long a host may take to answer an ask about a build, which it
/// answers without waiting for the build.
const PREPARE_WAIT: Duration = Duration::from_secs(30);

impl<S: Store> Service<S> {
    /// The guest programs most live hosts build images with, by their
    /// digest (the lowest of those most say, for a tie), or `None` when no
    /// live host says: what this release's images are built with.
    #[must_use]
    pub fn fleet_guest(&self) -> Option<String> {
        most_said(
            self.view
                .hosts()
                .into_iter()
                .filter(|known| known.state == HostState::Live)
                .filter_map(|known| known.capacity.guest),
        )
    }

    /// The stored image recorded as built from the OCI image `source` with
    /// the guest programs `guest` (as [`Service::fleet_guest`] names
    /// them), for the fleet's name `name`: recorded already, or built by
    /// the live host with those programs `turn` places after the first by
    /// name and recorded now. `None` while that host is building it, when
    /// it built it with other programs (recorded, for whoever wants them),
    /// or when no live host has them to build it.
    ///
    /// # Errors
    ///
    /// When the host does not answer or cannot build it, or the store
    /// fails.
    pub async fn prepare_image(
        &self,
        name: &str,
        source: &str,
        guest: Option<&str>,
        turn: usize,
    ) -> Result<Option<ImageId>, Failure> {
        let key = built_key(source, guest);
        if let Some(image) = self.store.image_built(&key).await? {
            // Another replica recorded it: this name uses it now too.
            return Ok(Some(
                self.store.record_built(&key, name, image, now_ms()).await?,
            ));
        }
        let live: Vec<_> = self
            .view
            .hosts()
            .into_iter()
            .filter(|known| {
                known.state == HostState::Live && known.capacity.guest.as_deref() == guest
            })
            .collect();
        if live.is_empty() {
            return Ok(None);
        }
        let target = &live[turn % live.len()].target;
        let request = Request::Prepare {
            image: source.to_owned(),
        };
        let answered = self
            .hosts
            .call(target, None, &request, PREPARE_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        match &answered.answer.reply {
            Reply::Preparing => Ok(None),
            Reply::Prepared {
                image,
                digest,
                guest: built_with,
            } => {
                let built = built_key(source, built_with.as_deref());
                let plain = built_key(source, None);
                if built != plain {
                    // Also the first image of the source with any guest's
                    // programs: what a rollback and replicas of releases
                    // before guest programs were told apart start from.
                    self.store
                        .record_built(&plain, name, *image, now_ms())
                        .await?;
                }
                let kept = self
                    .store
                    .record_built(&built, name, *image, now_ms())
                    .await?;
                tracing::info!(
                    host = %target.name,
                    %source,
                    %digest,
                    guest = built_with.as_deref().unwrap_or("unknown"),
                    built = %image,
                    recorded = %kept,
                    "a host built an image"
                );
                // A host restarted with other programs since this replica
                // last read it: the next ask finds its new registration.
                Ok((built == key).then_some(kept))
            }
            _ => Err(host_failure(&answered)),
        }
    }
}

/// The one of `said` said most often, the lowest of those for a tie.
fn most_said(said: impl IntoIterator<Item = String>) -> Option<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for one in said {
        *counts.entry(one).or_default() += 1;
    }
    // From the highest down, the last of the most is the lowest.
    counts
        .into_iter()
        .rev()
        .max_by_key(|(_, count)| *count)
        .map(|(one, _)| one)
}

#[cfg(test)]
mod tests {
    use super::most_said;

    fn said(of: &[&str]) -> Option<String> {
        most_said(of.iter().map(|one| (*one).to_owned()))
    }

    #[test]
    fn the_fleet_s_guest_programs_are_those_most_hosts_say_and_the_lowest_for_a_tie() {
        assert_eq!(said(&[]), None);
        assert_eq!(said(&["sha256:bb"]).as_deref(), Some("sha256:bb"));
        assert_eq!(
            said(&["sha256:bb", "sha256:aa"]).as_deref(),
            Some("sha256:aa")
        );
        assert_eq!(
            said(&["sha256:aa", "sha256:bb", "sha256:cc", "sha256:bb"]).as_deref(),
            Some("sha256:bb")
        );
    }
}
