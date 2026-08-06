-- deployment-mode: rolling
-- Retain computer screenshots as deterministic, tenant-owned files while
-- keeping provider object locations server-private. Pending/ready bytes are
-- quota-accounted, and one bounded SECURITY DEFINER claim seam drives stale
-- settlement reconciliation plus expiry/orphan cleanup across FORCE-RLS rows.

CREATE UNIQUE INDEX IF NOT EXISTS "files_workspace_id_uq"
  ON "files" ("workspace_id", "id");

CREATE TABLE "workspace_screenshot_quotas" (
  "workspace_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "reserved_bytes" bigint NOT NULL DEFAULT 0,
  "ready_bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_screenshot_quotas_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_screenshot_quotas_nonnegative_chk"
    CHECK ("reserved_bytes" >= 0 AND "ready_bytes" >= 0)
);

CREATE TABLE "retained_screenshot_artifacts" (
  "artifact_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "settlement_key" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_output_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "media_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "retention_expires_at" timestamptz NOT NULL,
  "ready_at" timestamptz,
  "cleanup_reason" text,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "retained_screenshot_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "retained_screenshot_artifacts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "retained_screenshot_artifacts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "retained_screenshot_artifacts_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "retained_screenshot_artifacts_workspace_file_fk"
    FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "files"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "retained_screenshot_artifacts_settlement_key_uq"
    UNIQUE ("settlement_key"),
  CONSTRAINT "retained_screenshot_artifacts_status_chk"
    CHECK ("status" IN ('pending', 'reconciling', 'ready', 'cleanup_pending', 'failed', 'expired', 'deleted')),
  CONSTRAINT "retained_screenshot_artifacts_media_type_chk"
    CHECK ("media_type" = 'image/png'),
  CONSTRAINT "retained_screenshot_artifacts_size_chk"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 33554432),
  CONSTRAINT "retained_screenshot_artifacts_sha256_chk"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "retained_screenshot_artifacts_dimensions_chk"
    CHECK (
      "width" BETWEEN 1 AND 16384
      AND "height" BETWEEN 1 AND 16384
      AND ("width"::bigint * "height"::bigint) <= 67108864
    ),
  CONSTRAINT "retained_screenshot_artifacts_ready_shape_chk"
    CHECK (
      ("status" = 'ready' AND "ready_at" IS NOT NULL)
      OR ("status" IN ('pending', 'reconciling') AND "ready_at" IS NULL)
      OR "status" IN ('cleanup_pending', 'failed', 'expired', 'deleted')
    ),
  CONSTRAINT "retained_screenshot_artifacts_terminal_cleanup_chk"
    CHECK (
      ("status" IN ('cleanup_pending', 'failed', 'expired', 'deleted'))
      OR "cleanup_reason" IS NULL
    )
);

CREATE INDEX "retained_screenshot_artifacts_session_created_idx"
  ON "retained_screenshot_artifacts" ("workspace_id", "session_id", "created_at", "artifact_id");
CREATE INDEX "retained_screenshot_artifacts_ready_expiry_idx"
  ON "retained_screenshot_artifacts" ("retention_expires_at", "artifact_id")
  WHERE "status" = 'ready';
CREATE INDEX "retained_screenshot_artifacts_pending_reconcile_idx"
  ON "retained_screenshot_artifacts" ("updated_at", "artifact_id")
  WHERE "status" IN ('pending', 'reconciling', 'cleanup_pending');

ALTER TABLE "workspace_screenshot_quotas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_screenshot_quotas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "workspace_screenshot_quotas"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "retained_screenshot_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retained_screenshot_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "retained_screenshot_artifacts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE OR REPLACE FUNCTION opengeni_private.claim_retained_screenshot_maintenance(
  p_pending_grace_ms bigint,
  p_claim_timeout_ms bigint,
  p_limit integer
)
RETURNS TABLE (
  action text,
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
AS $$
  WITH candidates AS (
    SELECT A.artifact_id,
      CASE
        WHEN A.status IN ('pending', 'reconciling') THEN 'reconcile'
        ELSE 'delete'
      END AS action,
      CASE
        WHEN A.status = 'ready' THEN 'expired'
        WHEN A.status IN ('pending', 'reconciling') THEN A.cleanup_reason
        ELSE coalesce(A.cleanup_reason, 'orphaned')
      END AS cleanup_reason
    FROM retained_screenshot_artifacts A
    WHERE
      (A.status = 'ready' AND A.retention_expires_at <= clock_timestamp())
      OR (
        A.status = 'pending'
        AND A.updated_at <= clock_timestamp() - (
          greatest(p_pending_grace_ms, 0)::double precision * interval '1 millisecond'
        )
      )
      OR (
        A.status IN ('reconciling', 'cleanup_pending')
        AND A.updated_at <= clock_timestamp() - (
          greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
        )
      )
    ORDER BY A.retention_expires_at, A.artifact_id
    LIMIT least(greatest(p_limit, 0), 1000)
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE retained_screenshot_artifacts A
    SET
      status = CASE WHEN C.action = 'reconcile' THEN 'reconciling' ELSE 'cleanup_pending' END,
      cleanup_reason = C.cleanup_reason,
      updated_at = clock_timestamp()
    FROM candidates C
    WHERE A.artifact_id = C.artifact_id
    RETURNING A.*, C.action
  )
  SELECT C.action, C.artifact_id, C.account_id, C.workspace_id, C.session_id,
    F.object_key, C.media_type, C.size_bytes, C.sha256, C.width, C.height,
    C.retention_expires_at, C.cleanup_reason
  FROM claimed C
  JOIN files F
    ON F.workspace_id = C.workspace_id
   AND F.id = C.artifact_id;
$$;

REVOKE ALL ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_screenshot_quotas" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "retained_screenshot_artifacts" TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer)
      TO opengeni_app;
  END IF;
END $$;