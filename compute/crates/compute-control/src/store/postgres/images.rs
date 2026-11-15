//! The stored images built from OCI images, in Postgres. Each is recorded
//! beside the captured images, whose collector forgets the ones nothing
//! uses (see [`crate::store::Store::record_built`]).

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
                "select i.image from compute_images i where i.source = $1 \
                 and not exists (select 1 from compute_captured_images c \
                 where c.image = i.image and c.collector is not null)",
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
        // it. A use only moves forward: this one drew its number before it
        // waited on the row, so a use recorded meanwhile may be the later
        // one.
        let offered = image.to_string();
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        tx.execute(
            "insert into compute_images (source, image, built_ms) \
             values ($1, $2, $3) on conflict (source) do nothing",
            &[&source, &offered, &big(at_ms)?],
        )
        .await
        .map_err(database)?;
        let recorded: String = tx
            .query_one(
                "select image from compute_images where source = $1",
                &[&source],
            )
            .await
            .map_err(database)?
            .get(0);
        // Every stored image has a record the collector reads: the one
        // recorded, and the one offered when another was recorded first,
        // which nothing uses. In one order always, so two records never
        // wait on each other.
        let mut stored = [&recorded, &offered];
        stored.sort();
        for stored in stored {
            tx.execute(
                "insert into compute_captured_images (image) values ($1) \
                 on conflict (image) do nothing",
                &[stored],
            )
            .await
            .map_err(database)?;
        }
        let collecting: bool = tx
            .query_one(
                "select collector is not null from compute_captured_images \
                 where image = $1 for update",
                &[&recorded],
            )
            .await
            .map_err(database)?
            .get(0);
        if collecting {
            // Dropped with the transaction: nothing is recorded of an image
            // being forgotten.
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
        tx.execute(
            "update compute_captured_images set unused_ms = null \
             where image = $1 and unused_ms is not null",
            &[&recorded],
        )
        .await
        .map_err(database)?;
        tx.commit().await.map_err(database)?;
        image_of(&recorded).map(Some)
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
