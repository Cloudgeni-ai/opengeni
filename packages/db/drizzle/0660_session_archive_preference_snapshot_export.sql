-- deployment-mode: rolling
-- preference_registry_snapshots are visible only to their initiating human
-- (preference_registry_snapshot_isolation), so the archive worker's workspace
-- context read none of them and every bundle omitted them. This definer reads
-- one keyset page of a session's snapshots as exact JSON text, only while that
-- session is being archived. The rows themselves stay in PostgreSQL.
CREATE FUNCTION opengeni_private.session_archive_preference_snapshot_rows(
  p_workspace_id uuid,
  p_session_id uuid,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (id uuid, row_json text)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
  SELECT P.id, row_to_json(P)::text
  FROM preference_registry_snapshots P
  WHERE P.workspace_id = p_workspace_id
    AND P.session_id = p_session_id
    AND (p_after_id IS NULL OR P.id > p_after_id)
    AND EXISTS (
      SELECT 1 FROM sessions S
      WHERE S.workspace_id = p_workspace_id AND S.id = p_session_id
        AND S.content_archive_state = 'archiving')
  ORDER BY P.id
  LIMIT least(greatest(p_limit, 0), 1000);
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_archive_preference_snapshot_rows(
  uuid, uuid, uuid, integer) FROM PUBLIC;
DO $preference_export_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.session_archive_preference_snapshot_rows(
      uuid, uuid, uuid, integer) TO opengeni_app;
  END IF;
END
$preference_export_grants$;
