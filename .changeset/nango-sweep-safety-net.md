---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Follow-ups to one Nango connection per account.

- **Missing connections:** the Nango sweep now asks an active row to reconnect (`nango_connection_missing`) when Nango confirms its connection is gone (a 404 for that connection), for example after an older release deleted a shared connection during a rollout or rollback. A row whose account has another healthy connection that covers its scopes is moved onto that one instead. People whose only connection is gone are found through a new deployment-wide listing (migration 1484) once a later migration grants it; until then only people with a connection Nango lists for this deployment are visited.
- **Legacy duplicates keep running turns:** a legacy duplicate row moved onto the shared connection without its account key keeps its `authority_generation`, so turns already running on it keep working.
- **Scopes count as a grant only when confirmed:** a row's scopes count as a grant for sharing only when it carries `nangoScopesConfirmed` (Nango reported them). Rows saved before the marker no longer move another organization's row onto their connection on their stored scopes; for such connections the scopes Nango reports count instead, so older duplicates still merge.
- **Deletes after commit:** the sweep deletes connections Nango can no longer refresh only after the rows' writes commit, under the person lock in a transaction that writes no connection rows.
- **Deployment tag mismatch:** a worker whose deployment tag matches none of the listed connections logs once that its tag is possibly mismatched.
