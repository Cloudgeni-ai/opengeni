-- deployment-mode: rolling
-- FORCE RLS also binds the table owner. The recording recovery inventory
-- (opengeni_private.list_stalled_recording_work_v1, 0930) is SECURITY DEFINER
-- and runs as the owner, which production provisions NOSUPERUSER NOBYPASSRLS,
-- so without an owner policy it sees no rows. Give the two tables it reads
-- exact owner-only policies, as 0929 and 0932 do for their inventories. The
-- runtime role is never the owner and stays bound to its workspace scope.
DO $recording_maintenance_owner_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['recordings', 'recording_transcript_versions'] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY recording_maintenance_owner ON %1$I '
        || 'USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass)) '
        || 'WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass))',
      table_name
    );
  END LOOP;
END $recording_maintenance_owner_policies$;
