//! Hosts given up on and the sandboxes that wait for them, in Postgres:
//! giving up leaves each sandbox its host's, and only declaring the host
//! gone lets one go on from its stored copy, noting the loss.

use compute_fleet::{HostId, OwnerEpoch, Ownership};
use deadpool_postgres::Transaction;
use tokio_postgres::types::Json;

use super::{PostgresStore, big, database, optional, small};
use crate::store::{Forsaken, Gone, LostCopy, Result};

/// Writes `ownership` and the loss `lost` over sandbox `name`'s row in
/// `tx`, raising its version.
pub(super) async fn write(
    tx: &Transaction<'_>,
    name: &str,
    ownership: Ownership,
    lost: Option<&LostCopy>,
) -> Result<()> {
    let owner = ownership.owner.map(|host| big(host.0)).transpose()?;
    tx.execute(
        "update compute_sandboxes set owner = $2, epoch = $3, taken = $4, \
         whole_epoch = $5, lost = $6, version = version + 1 where id = $1",
        &[
            &name,
            &owner,
            &big(ownership.epoch.0)?,
            &big(ownership.taken.0)?,
            &ownership.whole.map(|epoch| big(epoch.0)).transpose()?,
            &lost.map(Json),
        ],
    )
    .await
    .map_err(database)?;
    Ok(())
}

impl PostgresStore {
    pub(super) async fn give_up_now(
        &self,
        host: HostId,
        renewals: u64,
        at_ms: u64,
    ) -> Result<Option<usize>> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let id = big(host.0)?;
        let lost = tx
            .execute(
                "update compute_hosts set state = 'lost', gone_ms = $3, \
                 changed = nextval('compute_changes') \
                 where id = $1 and renewals = $2 and state <> 'lost'",
                &[&id, &big(renewals)?, &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        if lost != 1 {
            return Ok(None);
        }
        // Counted by a statement of its own, which sees every write that
        // named the host before it was lost: each held the host's row
        // until it committed, so the update above waited for it.
        let owned: i64 = tx
            .query_one(
                "select count(*) as owned from compute_sandboxes where owner = $1",
                &[&id],
            )
            .await
            .map_err(database)?
            .get("owned");
        tx.commit().await.map_err(database)?;
        Ok(Some(usize::try_from(owned).map_err(super::corrupt)?))
    }

    pub(super) async fn declare_gone_now(
        &self,
        host: HostId,
        why: Gone,
        at_ms: u64,
    ) -> Result<Option<Vec<Forsaken>>> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let id = big(host.0)?;
        // Locked against its registering again meanwhile, which takes the
        // same row first.
        let Some(found) = tx
            .query_opt(
                "select name from compute_hosts where id = $1 and state = 'lost' for update",
                &[&id],
            )
            .await
            .map_err(database)?
        else {
            return Ok(None);
        };
        let name: String = found.get("name");
        let rows = tx
            .query(
                "select s.id, s.epoch, s.taken, s.whole_epoch, p.saved_ms \
                 from compute_sandboxes s left join compute_pointers p on p.name = s.id \
                 where s.owner = $1 order by s.id for update of s",
                &[&id],
            )
            .await
            .map_err(database)?;
        let mut forsaken = Vec::with_capacity(rows.len());
        for row in rows {
            let sandbox: String = row.get("id");
            let ownership = Ownership {
                owner: Some(host),
                epoch: OwnerEpoch(small(row.get("epoch"))?),
                taken: OwnerEpoch(small(row.get("taken"))?),
                whole: optional(&row, "whole_epoch")?.map(OwnerEpoch),
            };
            let saved_ms = optional(&row, "saved_ms")?;
            let set = ownership.lose().set;
            let lost = LostCopy {
                host: name.clone(),
                why,
                at_ms,
                epoch: set.epoch.0,
                saved_ms,
                set_aside_ms: None,
            };
            write(&tx, &sandbox, set, Some(&lost)).await?;
            forsaken.push(Forsaken {
                id: sandbox.parse().map_err(super::corrupt)?,
                saved_ms,
            });
        }
        tx.commit().await.map_err(database)?;
        Ok(Some(forsaken))
    }
}
