-- deployment-mode: rolling
-- Retained-screenshot maintenance claims fresh work before reclaiming claims
-- that timed out. A claim that keeps failing was always the oldest-expiring
-- candidate, so a full batch of them was reclaimed on every sweep and nothing
-- behind it ever expired. Same signature, result and locking; only the order
-- of candidates changes, so old and new workers share it.

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_retained_screenshot_maintenance(
      p_pending_grace_ms bigint,
      p_claim_timeout_ms bigint,
      p_limit integer
    )
    RETURNS TABLE (
      action text,
      claim_id uuid,
      artifact_id uuid,
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      object_key text,
      media_type text,
      size_bytes bigint,
      sha256 text,
      width integer,
      height integer,
      retention_expires_at timestamptz,
      cleanup_reason text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      WITH candidates AS (
        SELECT
          A.artifact_id,
          gen_random_uuid() AS claim_id,
          CASE
            WHEN A.status IN ('pending', 'reconciling') THEN 'reconcile'
            ELSE 'delete'
          END AS action,
          CASE
            WHEN A.status = 'ready' THEN 'expired'
            WHEN A.status IN ('cleanup_queued', 'cleanup_pending')
              THEN coalesce(A.cleanup_reason, 'orphaned')
            ELSE NULL
          END AS cleanup_reason
        FROM %1$I.retained_screenshot_artifacts A
        WHERE
          (A.status = 'ready' AND A.retention_expires_at <= clock_timestamp())
          OR A.status = 'cleanup_queued'
          OR (
            A.status = 'pending'
            AND A.updated_at <= clock_timestamp() - (
              greatest(p_pending_grace_ms, 0)::double precision * interval '1 millisecond'
            )
          )
          OR (
            A.status IN ('reconciling', 'cleanup_pending')
            AND A.maintenance_claimed_at <= clock_timestamp() - (
              greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
            )
          )
        ORDER BY A.maintenance_claimed_at NULLS FIRST, A.retention_expires_at, A.artifact_id
        LIMIT least(greatest(p_limit, 0), 1000)
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE %1$I.retained_screenshot_artifacts A
        SET
          status = CASE WHEN C.action = 'reconcile' THEN 'reconciling' ELSE 'cleanup_pending' END,
          cleanup_reason = C.cleanup_reason,
          maintenance_claim_id = C.claim_id,
          maintenance_claimed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        FROM candidates C
        WHERE A.artifact_id = C.artifact_id
        RETURNING A.*, C.action, C.claim_id
      )
      SELECT C.action, C.claim_id, C.artifact_id, C.account_id, C.workspace_id, C.session_id,
        F.object_key, C.media_type, C.size_bytes, C.sha256, C.width, C.height,
        C.retention_expires_at, C.cleanup_reason
      FROM claimed C
      JOIN %1$I.files F
        ON F.workspace_id = C.workspace_id
       AND F.id = C.artifact_id;
    $function$;
  $create$, target_schema);
END $migration$;
