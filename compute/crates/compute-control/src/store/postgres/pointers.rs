//! The fleet's pointers in Postgres (ADR 25). A write lands only on the
//! version its writer read, and every version comes from one sequence.
//!
//! The import and every registration, renewal or report of a host that
//! keeps its pointers in the object store itself take turns on an
//! advisory lock, the import holding it alone: once the import is
//! recorded no such host is admitted again, and the import sees every one
//! admitted before.

use compute_fleet::{OwnerEpoch, Stamp};
use deadpool_postgres::{GenericClient, Transaction};
use tokio_postgres::Row;

use super::{PostgresStore, big, bits, corrupt, database, small, unbits};
use crate::store::{Found, Import, Imported, PointerRow, Result};

/// The transaction-scoped advisory lock the import holds alone and
/// registrations of hosts that keep pointers in the object store share.
const IMPORT_LOCK: i64 = 7_231_403;

fn pointer_row(row: &Row) -> PointerRow {
    PointerRow {
        owner: Stamp {
            epoch: OwnerEpoch(unbits(row.get("owner_epoch"))),
            save: unbits(row.get("owner_save")),
        },
        pointer: row.get("pointer"),
        version: row.get("version"),
    }
}

/// Whether a host that does or does not keep its pointers in the service
/// (`in_service`) is outdated: one that does not, once the fleet's
/// pointers are imported. For one that does not, holds the import lock
/// shared until `tx` ends.
pub(super) async fn outdated(tx: &Transaction<'_>, in_service: bool) -> Result<bool> {
    if in_service {
        return Ok(false);
    }
    tx.execute("select pg_advisory_xact_lock_shared($1)", &[&IMPORT_LOCK])
        .await
        .map_err(database)?;
    let row = tx
        .query_one(
            "select exists (select 1 from compute_pointers_imported)",
            &[],
        )
        .await
        .map_err(database)?;
    Ok(row.get(0))
}

impl PostgresStore {
    pub(super) async fn registered_now(&self, epoch: u64, names: &[String]) -> Result<bool> {
        let row = self
            .client()
            .await?
            .query_one(
                "select exists (select 1 from compute_hosts where epoch = $1 \
                 and state <> 'lost' and name = any($2))",
                &[&big(epoch)?, &names],
            )
            .await
            .map_err(database)?;
        Ok(row.get(0))
    }

    pub(super) async fn pointer_now(&self, name: &str) -> Result<Option<PointerRow>> {
        Ok(self
            .client()
            .await?
            .query_opt(
                "select owner_epoch, owner_save, pointer, version from compute_pointers \
                 where name = $1",
                &[&name],
            )
            .await
            .map_err(database)?
            .as_ref()
            .map(pointer_row))
    }

    pub(super) async fn write_pointer_now(
        &self,
        name: &str,
        owner: Stamp,
        pointer: &[u8],
        on: Option<i64>,
    ) -> Result<Option<i64>> {
        let client = self.client().await?;
        let (epoch, save) = (bits(owner.epoch.0), bits(owner.save));
        let row = match on {
            None => {
                client
                    .query_opt(
                        "insert into compute_pointers \
                         (name, owner_epoch, owner_save, pointer, version) \
                         values ($1, $2, $3, $4, nextval('compute_pointer_versions')) \
                         on conflict (name) do nothing returning version",
                        &[&name, &epoch, &save, &pointer],
                    )
                    .await
            }
            Some(on) => {
                client
                    .query_opt(
                        "update compute_pointers set owner_epoch = $2, owner_save = $3, \
                         pointer = $4, version = nextval('compute_pointer_versions') \
                         where name = $1 and version = $5 returning version",
                        &[&name, &epoch, &save, &pointer, &on],
                    )
                    .await
            }
        }
        .map_err(database)?;
        Ok(row.map(|row| row.get(0)))
    }

    pub(super) async fn pointer_names_now(&self) -> Result<Vec<String>> {
        let rows = self
            .client()
            .await?
            .query("select name from compute_pointers order by name", &[])
            .await
            .map_err(database)?;
        Ok(rows.iter().map(|row| row.get(0)).collect())
    }

    pub(super) async fn pointers_imported_now(&self) -> Result<Option<Imported>> {
        self.client()
            .await?
            .query_opt(
                "select imported_ms, from_store from compute_pointers_imported",
                &[],
            )
            .await
            .map_err(database)?
            .map(|row| imported(&row))
            .transpose()
    }

    pub(super) async fn adopt_pointers_now(&self, found: &[Found]) -> Result<usize> {
        let client = self.client().await?;
        let kept = insert_absent(&client, found).await?;
        Ok(usize::try_from(kept).unwrap_or(usize::MAX))
    }

    pub(super) async fn clock_ms_now(&self) -> Result<u64> {
        let row = self
            .client()
            .await?
            .query_one(
                "select (extract(epoch from clock_timestamp()) * 1000)::bigint",
                &[],
            )
            .await
            .map_err(database)?;
        small(row.get(0))
    }

    pub(super) async fn import_pointers_now(
        &self,
        found: &[Found],
        from: &str,
        at_ms: u64,
        seen: u64,
    ) -> Result<Import> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        tx.execute("select pg_advisory_xact_lock($1)", &[&IMPORT_LOCK])
            .await
            .map_err(database)?;
        if let Some(row) = tx
            .query_opt(
                "select imported_ms, from_store from compute_pointers_imported",
                &[],
            )
            .await
            .map_err(database)?
        {
            return Ok(Import::Done(imported(&row)?));
        }
        let waiting: Vec<String> = tx
            .query(
                "select name from compute_hosts \
                 where not coalesce((capacity ->> 'pointers_in_service')::boolean, false) \
                 and (state <> 'lost' or changed > $1) \
                 order by name",
                &[&big(seen)?],
            )
            .await
            .map_err(database)?
            .iter()
            .map(|row| row.get(0))
            .collect();
        if !waiting.is_empty() {
            return Ok(Import::Waiting(waiting));
        }
        insert_absent(&tx, found).await?;
        tx.execute(
            "insert into compute_pointers_imported (imported_ms, from_store) values ($1, $2)",
            &[&big(at_ms)?, &from],
        )
        .await
        .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(Import::Done(Imported {
            at_ms,
            from: from.to_owned(),
        }))
    }
}

/// Keeps each of `found` the store has no pointer of, a pointer kept
/// winning: how many it kept.
async fn insert_absent(client: &impl GenericClient, found: &[Found]) -> Result<u64> {
    let names: Vec<&str> = found.iter().map(|found| found.name.as_str()).collect();
    let epochs: Vec<i64> = found
        .iter()
        .map(|found| bits(found.owner.epoch.0))
        .collect();
    let saves: Vec<i64> = found.iter().map(|found| bits(found.owner.save)).collect();
    let pointers: Vec<&[u8]> = found.iter().map(|found| found.pointer.as_slice()).collect();
    client
        .execute(
            "insert into compute_pointers (name, owner_epoch, owner_save, pointer, version) \
             select name, owner_epoch, owner_save, pointer, nextval('compute_pointer_versions') \
             from unnest($1::text[], $2::bigint[], $3::bigint[], $4::bytea[]) \
             as found (name, owner_epoch, owner_save, pointer) \
             on conflict (name) do nothing",
            &[&names, &epochs, &saves, &pointers],
        )
        .await
        .map_err(database)
}

fn imported(row: &Row) -> Result<Imported> {
    Ok(Imported {
        at_ms: small(row.get("imported_ms"))?,
        from: row.try_get("from_store").map_err(corrupt)?,
    })
}
