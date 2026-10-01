---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

Collect product usage analytics server-side, independent of browser analytics consent.

Record throttled, batched presence for managed browser sessions and publish `opengeni_active_users{window}` from control workers. Add the `user.active`, `credits.granted` (grant class) and `connection.revoked` (provider class) lifecycle facts, live `opengeni_sessions_created_total{surface,created_by_kind,root}` and `opengeni_user_messages_total{surface}` counters, and database-derived `opengeni_credit_grants_total{grant_class}` / `opengeni_credit_granted_micros_total{grant_class}` that include trigger-written trial grants.

Add an idempotent operator backfill (`bun run db:backfill-lifecycle-facts`) for lifecycle facts captured before the first lifecycle consumer registered.

Give the logical workspace capture its own `opengeni_workspace_capture_revision_duration_seconds` histogram so it no longer collides with the physical capture histogram's label set in one worker registry.
