-- deployment-mode: rolling
-- A full workspace retained-image quota makes room for a new image by queuing
-- the workspace's oldest ready images for cleanup, instead of refusing the
-- newest image. Bytes already queued for cleanup count as free. Queued rows use
-- the existing cleanup_queued lifecycle that the maintenance sweep already
-- deletes, so previous binaries handle them unchanged and never call this.

CREATE INDEX "retained_screenshot_artifacts_workspace_ready_age_idx"
  ON "retained_screenshot_artifacts" ("workspace_id", "retention_expires_at", "artifact_id")
  WHERE "status" = 'ready';

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.make_room_for_retained_screenshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_needed_bytes bigint
    )
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      leaving bigint;
      candidate record;
    BEGIN
      -- The quota is workspace-wide, so eviction sees every image of the
      -- workspace regardless of session visibility. The caller must already
      -- be scoped to that workspace; nothing about the rows is returned.
      IF NOT opengeni_private.workspace_rls_visible(p_account_id, p_workspace_id) THEN
        RAISE EXCEPTION 'retained screenshot workspace is not in scope' USING ERRCODE = '42501';
      END IF;
      SELECT coalesce(sum(A.size_bytes), 0)::bigint INTO leaving
      FROM %1$I.retained_screenshot_artifacts A
      WHERE A.account_id = p_account_id
        AND A.workspace_id = p_workspace_id
        AND A.status IN ('cleanup_queued', 'cleanup_pending');
      IF leaving >= p_needed_bytes THEN
        RETURN leaving;
      END IF;
      FOR candidate IN
        SELECT A.artifact_id, A.size_bytes
        FROM %1$I.retained_screenshot_artifacts A
        WHERE A.account_id = p_account_id
          AND A.workspace_id = p_workspace_id
          AND A.status = 'ready'
        ORDER BY A.retention_expires_at, A.artifact_id
        FOR UPDATE SKIP LOCKED
      LOOP
        UPDATE %1$I.retained_screenshot_artifacts
        SET status = 'cleanup_queued',
          cleanup_reason = 'evicted',
          updated_at = clock_timestamp()
        WHERE artifact_id = candidate.artifact_id;
        leaving := leaving + candidate.size_bytes;
        EXIT WHEN leaving >= p_needed_bytes;
      END LOOP;
      RETURN leaving;
    END;
    $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.make_room_for_retained_screenshot(uuid, uuid, bigint)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.make_room_for_retained_screenshot(uuid, uuid, bigint)
      TO opengeni_app;
  END IF;
END $$;
