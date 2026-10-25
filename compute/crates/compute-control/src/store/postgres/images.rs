//! The stored images built from OCI images, in Postgres.

use std::str::FromStr as _;

use compute_protocol::host::ImageId;

use super::{PostgresStore, big, corrupt, database};
use crate::store::Result;

fn image_of(text: &str) -> Result<ImageId> {
    ImageId::from_str(text).map_err(corrupt)
}

impl PostgresStore {
    pub(super) async fn image_built_now(&self, source: &str) -> Result<Option<ImageId>> {
        self.client()
            .await?
            .query_opt(
                "select image from compute_images where source = $1",
                &[&source],
            )
            .await
            .map_err(database)?
            .map(|row| image_of(row.get(0)))
            .transpose()
    }

    pub(super) async fn record_built_now(
        &self,
        source: &str,
        name: &str,
        image: ImageId,
        at_ms: u64,
    ) -> Result<ImageId> {
        // Two statements: one alone would not see a row another recorded
        // while it waited on it.
        let client = self.client().await?;
        client
            .execute(
                "insert into compute_images (source, name, image, built_ms) \
                 values ($1, $2, $3, $4) on conflict (source) do nothing",
                &[&source, &name, &image.to_string(), &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        let row = client
            .query_one(
                "select image from compute_images where source = $1",
                &[&source],
            )
            .await
            .map_err(database)?;
        image_of(row.get(0))
    }

    pub(super) async fn latest_built_now(&self, name: &str) -> Result<Option<ImageId>> {
        self.client()
            .await?
            .query_opt(
                "select image from compute_images where name = $1 order by seq desc limit 1",
                &[&name],
            )
            .await
            .map_err(database)?
            .map(|row| image_of(row.get(0)))
            .transpose()
    }
}
