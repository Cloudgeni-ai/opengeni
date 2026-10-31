//! What a host tells of itself under a registration it kept, in Postgres:
//! the store keeps it as the host's description
//! ([`compute_protocol::fleet::Capacity::info`]).

use compute_protocol::fleet::HostInfo;
use deadpool_postgres::Transaction;
use tokio_postgres::types::Json;

use super::{big, corrupt, database};
use crate::store::Result;

/// `told` as the description of host `host` under registration `epoch`,
/// with the name and boot it registered with
/// ([`HostInfo::told_again`]), read in `tx` with the host's row locked
/// for the write that keeps it. `None` if it told nothing, or the row is
/// not that registration's, which that write then leaves alone too.
pub(super) async fn description(
    tx: &Transaction<'_>,
    host: u64,
    epoch: u64,
    told: Option<&HostInfo>,
) -> Result<Option<HostInfo>> {
    let Some(told) = told else {
        return Ok(None);
    };
    let Some(row) = tx
        .query_opt(
            "select info from compute_hosts where id = $1 and epoch = $2 for update",
            &[&big(host)?, &big(epoch)?],
        )
        .await
        .map_err(database)?
    else {
        return Ok(None);
    };
    let Json(registered): Json<HostInfo> = row.try_get("info").map_err(corrupt)?;
    Ok(Some(told.told_again(&registered)))
}
