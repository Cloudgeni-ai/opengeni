-- Reclaim direct-upload objects whose signed PUT completed but whose client
-- disappeared before finalize. The global worker cannot enumerate FORCE-RLS
-- workspaces directly, so this tightly-scoped SECURITY DEFINER function is the
-- sanctioned cross-workspace claim seam. It returns only storage routing ids;
-- no user content or signed URL is exposed.
--
-- Claims are leased, not terminal: a provider delete failure or worker crash
-- leaves cleanup_pending rows reclaimable after p_claim_timeout_ms. The caller
-- settles a successful idempotent delete through the ordinary workspace-RLS DB
-- helper. Pending rows are not eligible until their signed URL has expired plus
-- p_grace_ms, so cleanup never races a live draft/upload.

CREATE INDEX IF NOT EXISTS "file_uploads_pending_expiry_cleanup_idx"
  ON "file_uploads" ("expires_at", "id")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "file_uploads_claim_recovery_idx"
  ON "file_uploads" ("updated_at", "id")
  WHERE "status" = 'cleanup_pending';

CREATE OR REPLACE FUNCTION opengeni_private.claim_expired_file_upload_cleanup(
  p_grace_ms bigint,
  p_claim_timeout_ms bigint,
  p_limit integer
)
RETURNS TABLE (
  upload_id uuid,
  account_id uuid,
  workspace_id uuid,
  file_id uuid,
  object_key text
)
LANGUAGE sql
SECURITY DEFINER
-- EMBED-SAFE: the data tables live in the caller-selected public or dedicated
-- schema. Match the repository's existing global-reaper convention by
-- inheriting that schema-aware search_path; opengeni_private is absolute.
AS $$
  WITH candidates AS (
    SELECT U.id
    FROM file_uploads U
    WHERE
      (
        U.status = 'pending'
        AND U.expires_at <= clock_timestamp() - (
          greatest(p_grace_ms, 0)::double precision * interval '1 millisecond'
        )
      )
      OR
      (
        U.status = 'cleanup_pending'
        AND U.updated_at <= clock_timestamp() - (
          greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
        )
      )
    ORDER BY U.expires_at, U.id
    -- Defense in depth: the worker asks for 100, but the privileged function
    -- itself stays bounded even if an application caller passes a huge limit.
    LIMIT least(greatest(p_limit, 0), 1000)
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE file_uploads U
    SET status = 'cleanup_pending', updated_at = clock_timestamp()
    FROM candidates C
    WHERE U.id = C.id
    RETURNING U.id, U.account_id, U.workspace_id, U.file_id
  ), failed_files AS (
    UPDATE files F
    SET status = 'failed', updated_at = clock_timestamp()
    FROM claimed C
    WHERE F.id = C.file_id AND F.workspace_id = C.workspace_id
    RETURNING F.id, F.object_key
  )
  SELECT C.id, C.account_id, C.workspace_id, C.file_id, F.object_key
  FROM claimed C
  JOIN failed_files F ON F.id = C.file_id;
$$;

-- PostgreSQL grants new functions to PUBLIC by default. This function bypasses
-- workspace RLS, so only the migration owner and the explicit application role
-- may execute it.
REVOKE ALL ON FUNCTION opengeni_private.claim_expired_file_upload_cleanup(bigint, bigint, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_expired_file_upload_cleanup(bigint, bigint, integer)
      TO opengeni_app;
  END IF;
END $$;
