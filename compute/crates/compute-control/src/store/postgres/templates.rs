//! Templates and captured images in Postgres (see [`crate::store::Store`]).
//!
//! Every use recorded of a captured image (a template, and through its
//! template a sandbox) and a collector's claim on it take turns by locks:
//! a template's insert and a claim lock the image's record, and a
//! sandbox's insert locks its template. A claim looks at what uses the
//! image only once it holds the lock, so a use committed before is seen,
//! and one after finds the image claimed (or, for a sandbox, its template
//! gone) and is refused. A build is a captured image's bytes only once
//! recorded (see [`crate::store::Store::record_built`]), so a claim sees
//! it as a use too.

use std::str::FromStr as _;

use compute_protocol::host::{Id, ImageId};
use tokio_postgres::Row;

use super::{PostgresStore, big, corrupt, database, small};
use crate::store::{Collector, Inserted, Result, TemplateRow};

const TEMPLATE_COLUMNS: &str =
    "team, id, name, image, source, vcpus, memory_mib, disk_mib, created_ms";

/// Whether the image `image`, an SQL expression, is used: by a template,
/// a sandbox's config or an image built from an OCI image.
fn used(image: &str) -> String {
    format!(
        "(exists (select 1 from compute_templates t where t.image = {image}) \
         or exists (select 1 from compute_sandboxes s \
         where s.spec -> 'config' ->> 'image' = {image}) \
         or exists (select 1 from compute_images i where i.image = {image}))"
    )
}

fn template_of(row: &Row) -> Result<TemplateRow> {
    let image: String = row.get("image");
    let source: String = row.get("source");
    let vcpus: i32 = row.get("vcpus");
    Ok(TemplateRow {
        team: row.get("team"),
        id: row.get("id"),
        name: row.get("name"),
        image: ImageId::from_str(&image).map_err(corrupt)?,
        source: Id::from_str(&source).map_err(corrupt)?,
        vcpus: u8::try_from(vcpus).map_err(corrupt)?,
        memory_mib: u32::try_from(small(row.get("memory_mib"))?).map_err(corrupt)?,
        disk_mib: small(row.get("disk_mib"))?,
        created_ms: small(row.get("created_ms"))?,
    })
}

impl PostgresStore {
    pub(super) async fn insert_template_now(&self, row: &TemplateRow) -> Result<Inserted> {
        let image = row.image.to_string();
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        tx.execute(
            "insert into compute_captured_images (image) values ($1) \
             on conflict (image) do nothing",
            &[&image],
        )
        .await
        .map_err(database)?;
        let collecting: bool = tx
            .query_one(
                "select collector is not null from compute_captured_images \
                 where image = $1 for update",
                &[&image],
            )
            .await
            .map_err(database)?
            .get(0);
        if collecting {
            return Ok(Inserted::Collecting);
        }
        let inserted = tx
            .execute(
                &format!(
                    "insert into compute_templates ({TEMPLATE_COLUMNS}) \
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing"
                ),
                &[
                    &row.team,
                    &row.id,
                    &row.name,
                    &image,
                    &row.source.to_string(),
                    &i32::from(row.vcpus),
                    &i64::from(row.memory_mib),
                    &big(row.disk_mib)?,
                    &big(row.created_ms)?,
                ],
            )
            .await
            .map_err(database)?;
        if inserted == 1 {
            tx.execute(
                "update compute_captured_images set unused_ms = null where image = $1",
                &[&image],
            )
            .await
            .map_err(database)?;
        }
        // The image's record stays either way: an image no template keeps
        // is collected like any other unused one.
        tx.commit().await.map_err(database)?;
        Ok(if inserted == 1 {
            Inserted::Done
        } else {
            Inserted::NameTaken
        })
    }

    pub(super) async fn template_now(&self, team: &str, key: &str) -> Result<Option<TemplateRow>> {
        self.client()
            .await?
            .query_opt(
                &format!(
                    "select {TEMPLATE_COLUMNS} from compute_templates \
                     where team = $1 and (id = $2 or name = $2) \
                     order by (id = $2) desc limit 1"
                ),
                &[&team, &key],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(template_of)
            .transpose()
    }

    pub(super) async fn templates_now(&self, team: &str) -> Result<Vec<TemplateRow>> {
        self.client()
            .await?
            .query(
                &format!(
                    "select {TEMPLATE_COLUMNS} from compute_templates \
                     where team = $1 order by created_ms, id"
                ),
                &[&team],
            )
            .await
            .map_err(database)?
            .iter()
            .map(template_of)
            .collect()
    }

    pub(super) async fn delete_template_now(&self, team: &str, id: &str) -> Result<bool> {
        let deleted = self
            .client()
            .await?
            .execute(
                "delete from compute_templates where team = $1 and id = $2",
                &[&team, &id],
            )
            .await
            .map_err(database)?;
        Ok(deleted > 0)
    }

    pub(super) async fn unused_images_now(
        &self,
        now_ms: u64,
        before_ms: u64,
    ) -> Result<Vec<ImageId>> {
        let client = self.client().await?;
        // Only rows that change are written. A mark this makes as a
        // template of the image commits is cleared by the next look, and
        // a claim looks again under the image's lock.
        client
            .execute(
                &format!(
                    "update compute_captured_images c set unused_ms = null \
                     where c.collector is null and c.unused_ms is not null and {}",
                    used("c.image")
                ),
                &[],
            )
            .await
            .map_err(database)?;
        client
            .execute(
                &format!(
                    "update compute_captured_images c set unused_ms = $1 \
                     where c.collector is null and c.unused_ms is null and not {}",
                    used("c.image")
                ),
                &[&big(now_ms)?],
            )
            .await
            .map_err(database)?;
        client
            .query(
                "select image from compute_captured_images \
                 where collector is not null or unused_ms < $1 order by image",
                &[&big(before_ms)?],
            )
            .await
            .map_err(database)?
            .iter()
            .map(|row| ImageId::from_str(row.get(0)).map_err(corrupt))
            .collect()
    }

    pub(super) async fn collect_image_now(
        &self,
        image: ImageId,
        before_ms: u64,
        collector: &Collector,
    ) -> Result<bool> {
        let image = image.to_string();
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let Some(found) = tx
            .query_opt(
                "select collector, claimed_ms, unused_ms from compute_captured_images \
                 where image = $1 for update",
                &[&image],
            )
            .await
            .map_err(database)?
        else {
            return Ok(false);
        };
        if let Some(holder) = found.get::<_, Option<String>>(0) {
            if holder == collector.id {
                return Ok(true);
            }
            let claimed_ms: Option<i64> = found.get(1);
            if claimed_ms.is_some_and(|at| at >= big(collector.lapsed_ms).unwrap_or(i64::MAX)) {
                return Ok(false);
            }
            // Lapsed: taken over. Nothing recorded a use of it meanwhile.
            claim(&tx, &image, collector).await?;
            tx.commit().await.map_err(database)?;
            return Ok(true);
        }
        let unused_ms: Option<i64> = found.get(2);
        if unused_ms.is_none_or(|since| since >= big(before_ms).unwrap_or(i64::MAX)) {
            return Ok(false);
        }
        // Under the lock: a template inserted before it was taken is seen.
        let in_use: bool = tx
            .query_one(&format!("select {}", used("$1")), &[&image])
            .await
            .map_err(database)?
            .get(0);
        if in_use {
            tx.execute(
                "update compute_captured_images set unused_ms = null where image = $1",
                &[&image],
            )
            .await
            .map_err(database)?;
        } else {
            claim(&tx, &image, collector).await?;
        }
        tx.commit().await.map_err(database)?;
        Ok(!in_use)
    }

    pub(super) async fn collecting_now(&self, image: ImageId, collector: &str) -> Result<bool> {
        Ok(self
            .client()
            .await?
            .query_one(
                "select exists (select 1 from compute_captured_images \
                 where image = $1 and collector = $2)",
                &[&image.to_string(), &collector],
            )
            .await
            .map_err(database)?
            .get(0))
    }

    pub(super) async fn collected_now(&self, image: ImageId, collector: &str) -> Result<()> {
        self.client()
            .await?
            .execute(
                "delete from compute_captured_images where image = $1 and collector = $2",
                &[&image.to_string(), &collector],
            )
            .await
            .map_err(database)?;
        Ok(())
    }
}

/// Records in `tx` that `collector` claims captured image `image`.
async fn claim(
    tx: &deadpool_postgres::Transaction<'_>,
    image: &str,
    collector: &Collector,
) -> Result<()> {
    tx.execute(
        "update compute_captured_images set collector = $2, claimed_ms = $3 where image = $1",
        &[&image, &collector.id, &big(collector.at_ms)?],
    )
    .await
    .map_err(database)?;
    Ok(())
}
