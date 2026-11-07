---
"@opengeni/db": patch
---

Migrations 1281 to 1292 drop the seven retired Knowledge sync tables (`knowledge_source_sync_states`, `knowledge_source_sync_wakes`, `knowledge_source_sync_object_observations`, `knowledge_source_sync_item_outcomes`, `knowledge_source_sync_index_obligations`, `google_drive_object_acl_evidence` and `google_drive_object_acl_principals`) and the `knowledge_source_index_wake()` trigger function. 1281 to 1291 first remove their foreign keys into surviving tables, one referenced table per migration, so no migration locks several busy tables at once. Runtime readiness no longer lists them. The scoped-knowledge provenance tables stay.

Upgrade order: deploy the release containing the Knowledge sync removal (Opengeni PR #6919, migration 1275) first, and only run these migrations once every binary that can still run against the database, including any rollback target, contains it. Do not skip that release, and do not roll back to an earlier one after these migrations have run.
