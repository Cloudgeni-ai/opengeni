//! The E2B lifecycles of sandboxes (see [`crate::e2b::lifecycle`]), in
//! Postgres.

use std::str::FromStr as _;

use compute_protocol::host::Id;
use tokio_postgres::Row;
use tokio_postgres::types::Json;

use super::{PostgresStore, big, corrupt, database, small};
use crate::e2b::lifecycle::Record;
use crate::store::{LifecycleRow, Result};

const LIFECYCLE_COLUMNS: &str = "id, team, record, version";

/// When a lifecycle is due, as a `bigint`: never is the largest one.
fn due(record: &Record) -> i64 {
    i64::try_from(record.due_ms()).unwrap_or(i64::MAX)
}

fn lifecycle_row(row: &Row) -> Result<LifecycleRow> {
    let id: String = row.get(0);
    let Json(record): Json<Record> = row.try_get(2).map_err(corrupt)?;
    Ok(LifecycleRow {
        id: Id::from_str(&id).map_err(corrupt)?,
        team: row.get(1),
        record,
        version: small(row.get(3))?,
    })
}

impl PostgresStore {
    pub(super) async fn insert_lifecycle_now(&self, row: &LifecycleRow) -> Result<bool> {
        let written = self
            .client()
            .await?
            .execute(
                "insert into compute_lifecycles (id, team, record, due_ms, version) \
                 values ($1, $2, $3, $4, $5) on conflict (id) do nothing",
                &[
                    &row.id.to_string(),
                    &row.team,
                    &Json(&row.record),
                    &due(&row.record),
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(written == 1)
    }

    pub(super) async fn lifecycle_now(&self, id: Id) -> Result<Option<LifecycleRow>> {
        self.client()
            .await?
            .query_opt(
                &format!("select {LIFECYCLE_COLUMNS} from compute_lifecycles where id = $1"),
                &[&id.to_string()],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(lifecycle_row)
            .transpose()
    }

    pub(super) async fn replace_lifecycle_now(&self, row: &LifecycleRow) -> Result<bool> {
        let written = self
            .client()
            .await?
            .execute(
                "update compute_lifecycles set record = $2, due_ms = $3, version = version + 1 \
                 where id = $1 and version = $4",
                &[
                    &row.id.to_string(),
                    &Json(&row.record),
                    &due(&row.record),
                    &big(row.version)?,
                ],
            )
            .await
            .map_err(database)?;
        Ok(written == 1)
    }

    pub(super) async fn delete_lifecycle_now(&self, id: Id, version: u64) -> Result<bool> {
        let deleted = self
            .client()
            .await?
            .execute(
                "delete from compute_lifecycles where id = $1 and version = $2",
                &[&id.to_string(), &big(version)?],
            )
            .await
            .map_err(database)?;
        Ok(deleted == 1)
    }

    pub(super) async fn lifecycles_now(&self, team: &str) -> Result<Vec<LifecycleRow>> {
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where team = $1 order by id"
                ),
                &[&team],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }

    pub(super) async fn lifecycles_due_now(
        &self,
        now_ms: u64,
        after: Option<(u64, Id)>,
        limit: usize,
    ) -> Result<Vec<LifecycleRow>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        // The largest `bigint` is never (see `due`), so no time reaches it.
        let now = i64::try_from(now_ms).unwrap_or(i64::MAX).min(i64::MAX - 1);
        // Due times are never negative, so -1 comes before every row.
        let (after_due, after_id) = after.map_or((-1, String::new()), |(due, id)| {
            (i64::try_from(due).unwrap_or(i64::MAX), id.to_string())
        });
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where due_ms <= $1 \
                     and (due_ms, id collate \"C\") > ($2, $3) \
                     order by due_ms, id collate \"C\" limit $4"
                ),
                &[&now, &after_due, &after_id, &limit],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }

    pub(super) async fn lifecycles_paused_now(
        &self,
        after: Option<Id>,
        limit: usize,
    ) -> Result<Vec<LifecycleRow>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let after = after.map_or_else(String::new, |id| id.to_string());
        self.client()
            .await?
            .query(
                &format!(
                    "select {LIFECYCLE_COLUMNS} from compute_lifecycles where due_ms = $1 \
                     and id collate \"C\" > $2 order by id collate \"C\" limit $3"
                ),
                &[&i64::MAX, &after, &limit],
            )
            .await
            .map_err(database)?
            .iter()
            .map(lifecycle_row)
            .collect()
    }
}
