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
        // Separate statements: one alone would not see a row another
        // recorded while it waited on it. The use comes after the image it
        // names, which is never deleted.
        let client = self.client().await?;
        client
            .execute(
                "insert into compute_images (source, image, built_ms) \
                 values ($1, $2, $3) on conflict (source) do nothing",
                &[&source, &image.to_string(), &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        client
            .execute(
                "insert into compute_image_names (name, source, used) \
                 values ($1, $2, nextval('compute_image_uses')) \
                 on conflict (name, source) do update set used = excluded.used",
                &[&name, &source],
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
                "select images.image from compute_image_names names \
                 join compute_images images on images.source = names.source \
                 where names.name = $1 order by names.used desc limit 1",
                &[&name],
            )
            .await
            .map_err(database)?
            .map(|row| image_of(row.get(0)))
            .transpose()
    }
}
