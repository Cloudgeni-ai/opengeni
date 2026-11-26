//! Draining and undraining a host in Postgres, noting the leader's drain
//! to remove it (see [`crate::store::Store::set_state`] and
//! [`crate::store::Store::drain_to_remove`]).

use compute_fleet::{HostId, HostState};

use super::{PostgresStore, big, database, state_name};
use crate::store::Result;

impl PostgresStore {
    pub(super) async fn set_state_now(
        &self,
        host: HostId,
        from: HostState,
        to: HostState,
    ) -> Result<bool> {
        let updated = self
            .client()
            .await?
            .execute(
                "update compute_hosts \
                 set state = case when state = 'lost' then state else $3 end, \
                 drained = $3 = 'draining', drained_by = null, drained_at = null, \
                 changed = nextval('compute_changes') \
                 where id = $1 and (state = $2 \
                 or (state = $3 and (drained <> ($3 = 'draining') or drained_by is not null)) \
                 or (state = 'lost' and drained and $2 = 'draining' and $3 = 'live'))",
                &[&big(host.0)?, &state_name(from), &state_name(to)],
            )
            .await
            .map_err(database)?;
        Ok(updated == 1)
    }

    pub(super) async fn drain_to_remove_now(&self, host: HostId, at_ms: u64) -> Result<bool> {
        let ours = self
            .client()
            .await?
            .query_one(
                "with drained as (update compute_hosts set state = 'draining', drained = true, \
                 drained_by = 'leader', drained_at = $2, changed = nextval('compute_changes') \
                 where id = $1 and state = 'live' returning 1) \
                 select exists (select 1 from drained) or exists (select 1 from compute_hosts \
                 where id = $1 and state = 'draining' and drained_by = 'leader') as ours",
                &[&big(host.0)?, &big(at_ms)?],
            )
            .await
            .map_err(database)?;
        Ok(ours.get("ours"))
    }
}
