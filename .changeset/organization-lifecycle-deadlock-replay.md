---
"@opengeni/db": patch
---

Replay an organization membership suspend/offboard transaction after a PostgreSQL deadlock abort. The lifecycle SECURITY DEFINER seam locks the organization row (`managed_accounts FOR UPDATE`) before it locks the account's `workspaces` rows `FOR KEY SHARE`, while every ordinary workspace writer takes the opposite order - its `workspaces` row first, then the same organization row implicitly through the account foreign-key check of a row it inserts. A concurrent offboard and session-visibility transition therefore deadlock, and PostgreSQL aborts one of them with `40P01`. `updateOrganizationMember()` now replays that exact transaction (bounded, same operation id, same CAS revisions, nothing durable to roll forward). `40001` is still surfaced unchanged as the authoritative stale-revision conflict. The underlying lock-order inversion lives in SQL and still needs a migration to remove.
