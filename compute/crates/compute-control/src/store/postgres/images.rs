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
    ) -> Result<Option<ImageId>> {
        // Separate statements, each seeing what committed before it: one
        // alone would not see a row another recorded while it waited on
        // it. The use comes after the image it names, which is never
        // deleted. A use only moves forward: this one drew its number
        // before it waited on the row, so a use recorded meanwhile may be
        // the later one.
        let image = image.to_string();
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let inserted = tx
            .execute(
                "insert into compute_images (source, image, built_ms) \
                 values ($1, $2, $3) on conflict (source) do nothing",
                &[&source, &image, &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        // A captured image of the same bytes a collector claimed is being
        // forgotten: not recorded. Locked after the insert, so a claim
        // either sees it, once committed, or is seen here. The row is
        // locked whoever holds it: a collector holding it unclaimed may
        // be about to claim it, not having seen this insert, so this
        // waits for it and reads what it committed.
        if inserted == 1
            && tx
                .query_opt(
                    "select collector is not null from compute_captured_images \
                     where image = $1 for share",
                    &[&image],
                )
                .await
                .map_err(database)?
                .is_some_and(|row| row.get::<_, bool>(0))
        {
            return Ok(None);
        }
        tx.execute(
            "insert into compute_image_names (name, source, used) \
             values ($1, $2, nextval('compute_image_uses')) \
             on conflict (name, source) do update \
             set used = greatest(compute_image_names.used, excluded.used)",
            &[&name, &source],
        )
        .await
        .map_err(database)?;
        let row = tx
            .query_one(
                "select image from compute_images where source = $1",
                &[&source],
            )
            .await
            .map_err(database)?;
        let recorded = image_of(row.get(0))?;
        tx.commit().await.map_err(database)?;
        Ok(Some(recorded))
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
