//! Asking a host to build a stored image (see [`crate::images`]).

use std::time::Duration;

use compute_fleet::HostState;
use compute_protocol::host::{ImageId, Reply, Request};

use super::{Failure, Service, host_failure, now_ms};
use crate::store::Store;

/// How long a host may take to answer an ask about a build, which it
/// answers without waiting for the build.
const PREPARE_WAIT: Duration = Duration::from_secs(30);

impl<S: Store> Service<S> {
    /// The stored image recorded as built from the OCI image `source`, for
    /// the fleet's name `name`: recorded already, or built by the live host
    /// `turn` places after the first by name and recorded now. `None`
    /// while that host is building it, or no host is live to build it.
    ///
    /// # Errors
    ///
    /// When the host does not answer or cannot build it, or the store
    /// fails.
    pub async fn prepare_image(
        &self,
        name: &str,
        source: &str,
        turn: usize,
    ) -> Result<Option<ImageId>, Failure> {
        if let Some(image) = self.store.image_built(source).await? {
            // Another replica recorded it: this name uses it now too.
            return Ok(Some(
                self.store
                    .record_built(source, name, image, now_ms())
                    .await?,
            ));
        }
        let live: Vec<_> = self
            .view
            .hosts()
            .into_iter()
            .filter(|known| known.state == HostState::Live)
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
            Reply::Prepared { image, digest } => {
                let kept = self
                    .store
                    .record_built(source, name, *image, now_ms())
                    .await?;
                tracing::info!(
                    host = %target.name,
                    %source,
                    %digest,
                    built = %image,
                    recorded = %kept,
                    "a host built an image"
                );
                Ok(Some(kept))
            }
            _ => Err(host_failure(&answered)),
        }
    }
}
