---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Follow-ups to one Nango connection per account.

- **Missing connections:** the Nango sweep now asks an active row to reconnect (`nango_connection_missing`) when Nango confirms its connection is gone, for example after an older release deleted a shared connection during a rollout or rollback. A row whose account has another healthy connection that covers its scopes is moved onto that one instead.
- **Legacy duplicates keep running turns:** a legacy duplicate row moved onto the shared connection without its account key keeps its `authority_generation`, so turns already running on it keep working.
- **Scopes count as a grant only when confirmed:** a row's scopes count as a grant for sharing only when it carries `nangoScopesConfirmed` (Nango reported them). Rows saved before the marker no longer move another organization's row onto their connection.
- **Deletes after commit:** the sweep deletes connections Nango can no longer refresh only after the rows' writes commit, under the person lock in a transaction that writes nothing.
- **Deployment tag mismatch:** a worker whose deployment tag matches none of the listed connections logs that once.
