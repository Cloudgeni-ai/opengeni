-- deployment-mode: rolling
-- contract-step: PR #6919 (migration 1275) stopped every application path and SQL routine from using the Knowledge sync tables; queue only once the release containing #6919 is the previous production release and the runtime-posture baseline pins it.
-- Detach the retired Knowledge sync tables from knowledge_source_objects before 1292
-- drops them (see 1281: one referenced table per file, found in the catalog).
-- Expected here: knowledge_source_sync_index_obligations_object_fk, google_drive_object_acl_evidenc_knowledge_source_object_id_fkey.
DO $detach$
DECLARE
  foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT c.conrelid::regclass AS child, c.conname AS name
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = to_regclass('knowledge_source_objects')
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
