-- deployment-mode: rolling
-- contract-step: PR #6919 (migration 1275) stopped every application path and SQL routine from reading or writing these tables, deleted their rows, and listed them as retiring so its readiness accepts them absent; queue this only once the release containing #6919 is the previous production release and the runtime-posture baseline pins it.
-- Integration Knowledge sync is gone. Drop the seven tables only it used, and
-- the trigger function that woke indexing from one of them.
--
-- Nothing else references them: no other table has a foreign key into them,
-- and no routine, view or policy outside them reads them. 1281 to 1291 already
-- removed their foreign keys into surviving tables, one referenced table per
-- transaction, so this drop locks only the seven retired tables. Their
-- remaining foreign keys among themselves, triggers, policies and indexes go
-- with them. The scoped-knowledge
-- provenance tables (providers, sources, ACL versions, objects, document
-- versions, lifecycle events and sync runs) stay: surviving Knowledge and
-- learning routines and foreign keys still use them.
--
-- One statement drops all seven, so the foreign keys among them (including
-- the cycle between ACL evidence and index obligations) need no CASCADE.
-- IF EXISTS keeps developer databases that never had them safe.
DROP TABLE IF EXISTS
  "google_drive_object_acl_principals",
  "google_drive_object_acl_evidence",
  "knowledge_source_sync_item_outcomes",
  "knowledge_source_sync_index_obligations",
  "knowledge_source_sync_object_observations",
  "knowledge_source_sync_wakes",
  "knowledge_source_sync_states";

DROP FUNCTION IF EXISTS knowledge_source_index_wake();
