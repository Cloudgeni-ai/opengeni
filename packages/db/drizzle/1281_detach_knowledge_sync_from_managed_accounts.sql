-- deployment-mode: rolling
-- contract-step: PR #6919 (migration 1275) stopped every application path and SQL routine from using the Knowledge sync tables; queue only once the release containing #6919 is the previous production release and the runtime-posture baseline pins it.
-- 1281 to 1291 detach the retired Knowledge sync tables from the tables they
-- reference, one referenced table per file, before 1292 drops them. Dropping
-- a foreign key locks the referenced table, so each transaction holds one
-- surviving table briefly instead of eleven together until commit. Nothing
-- writes the sync tables any more.
--
-- Each file finds the foreign keys in the catalog instead of naming them, so
-- a database whose constraint names differ from the baseline still detaches
-- fully. Missing tables (developer databases, reruns) are skipped.
-- This file: managed_accounts.
-- Expected here: google_drive_object_acl_evidence_account_id_fkey, google_drive_object_acl_principals_account_id_fkey.
DO $detach$
DECLARE
  foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT c.conrelid::regclass AS child, c.conname AS name
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = to_regclass('managed_accounts')
      AND c.conrelid = ANY (ARRAY[
        to_regclass('knowledge_source_sync_states'),
        to_regclass('knowledge_source_sync_wakes'),
        to_regclass('knowledge_source_sync_object_observations'),
        to_regclass('knowledge_source_sync_item_outcomes'),
        to_regclass('knowledge_source_sync_index_obligations'),
        to_regclass('google_drive_object_acl_evidence'),
        to_regclass('google_drive_object_acl_principals')
      ])
    ORDER BY c.conrelid::regclass::text, c.conname
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', foreign_key.child, foreign_key.name);
  END LOOP;
END
$detach$;
