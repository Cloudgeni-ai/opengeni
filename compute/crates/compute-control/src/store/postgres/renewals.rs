//! A host's renewals and reports in Postgres: each is one update of its
//! row, keeping what it can take on and what it says it is now
//! ([`Capacity::info`]).

use compute_protocol::fleet::{Capacity, Renew, Report};
use tokio_postgres::types::Json;

use super::{PostgresStore, big, database, pointers};
use crate::store::Result;

/// A host row's description once the host told it is parameter `param`
/// (`null` if it told none): what it told under the name and boot the row
/// holds, as [`compute_protocol::fleet::HostInfo::told_again`] keeps it,
/// in the row's own update.
fn told(param: u8) -> String {
    format!(
        "coalesce((${param}::jsonb - 'name' - 'boot') \
         || jsonb_build_object('name', info->'name') \
         || case when info ? 'boot' then jsonb_build_object('boot', info->'boot') \
         else '{{}}'::jsonb end, info)"
    )
}

impl PostgresStore {
    pub(super) async fn renew_now(&self, renew: &Renew, names: &[String]) -> Result<bool> {
        // A renewal without a capacity keeps the one last heard, and one
        // without a description the one last heard.
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        let in_service = renew
            .capacity
            .as_ref()
            .is_none_or(|capacity| capacity.pointers_in_service);
        if pointers::outdated(&tx, in_service).await? {
            return Ok(false);
        }
        let (capacity, described) = renew
            .capacity
            .as_ref()
            .map(Capacity::split)
            .map_or((None, None), |(capacity, info)| (Some(capacity), info));
        let updated = tx
            .execute(
                &format!(
                    "update compute_hosts set renewals = renewals + 1, \
                     seq = greatest(seq, $3), capacity = coalesce($4, capacity), \
                     info = {}, changed = nextval('compute_changes') \
                     where id = $1 and epoch = $2 and state <> 'lost' and name = any($5)",
                    told(6)
                ),
                &[
                    &big(renew.host)?,
                    &big(renew.epoch)?,
                    &big(renew.seq)?,
                    &capacity.as_ref().map(Json),
                    &names,
                    &described.as_ref().map(Json),
                ],
            )
            .await
            .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(updated == 1)
    }

    pub(super) async fn report_now(&self, report: &Report, names: &[String]) -> Result<bool> {
        let mut client = self.client().await?;
        let tx = client.transaction().await.map_err(database)?;
        if pointers::outdated(&tx, report.capacity.pointers_in_service).await? {
            return Ok(false);
        }
        let (capacity, described) = report.capacity.split();
        let updated = tx
            .execute(
                &format!(
                    "update compute_hosts set capacity = $3, info = {}, \
                     changed = nextval('compute_changes') \
                     where id = $1 and epoch = $2 and state <> 'lost' and name = any($4)",
                    told(5)
                ),
                &[
                    &big(report.host)?,
                    &big(report.epoch)?,
                    &Json(&capacity),
                    &names,
                    &described.as_ref().map(Json),
                ],
            )
            .await
            .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(updated == 1)
    }
}
