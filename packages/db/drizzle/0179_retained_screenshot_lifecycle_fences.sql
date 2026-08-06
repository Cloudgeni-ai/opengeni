-- deployment-mode: rolling
-- Preserve retained screenshot cleanup/accounting authority across parent
-- deletion, make quota release explicit and idempotent, and fence provider
-- deletion with one durable maintenance claim.

ALTER TABLE "retained_screenshot_artifacts"
  ALTER COLUMN "session_id" DROP NOT NULL,
  ALTER COLUMN "turn_id" DROP NOT NULL,
  ALTER COLUMN "attempt_id" DROP NOT NULL,
  ADD COLUMN "quota_state" text NOT NULL DEFAULT 'reserved',
  ADD COLUMN "maintenance_claim_id" uuid,
  ADD COLUMN "maintenance_claimed_at" timestamptz;

ALTER TABLE "retained_screenshot_artifacts"
  DROP CONSTRAINT "retained_screenshot_artifacts_workspace_session_fk",
  DROP CONSTRAINT "retained_screenshot_artifacts_workspace_turn_fk",
  DROP CONSTRAINT "retained_screenshot_artifacts_workspace_attempt_fk",
  DROP CONSTRAINT "retained_screenshot_artifacts_workspace_file_fk",
  DROP CONSTRAINT "retained_screenshot_artifacts_status_chk",
  DROP CONSTRAINT "retained_screenshot_artifacts_ready_shape_chk",
  DROP CONSTRAINT "retained_screenshot_artifacts_terminal_cleanup_chk";

-- Claims created by migration 0140 carried no owner token. Return them to an
-- unclaimed state before the ownership constraint is installed.
UPDATE "retained_screenshot_artifacts"
SET
  "status" = CASE
    WHEN "status" = 'reconciling' THEN 'pending'
    WHEN "status" = 'cleanup_pending' THEN 'cleanup_queued'
    ELSE "status"
  END,
  "quota_state" = CASE
    WHEN "status" IN ('failed', 'expired', 'deleted') THEN 'released'
    WHEN "status" = 'ready' OR "ready_at" IS NOT NULL THEN 'ready'
    ELSE 'reserved'
  END,
  "cleanup_reason" = CASE
    WHEN "status" = 'cleanup_pending' THEN coalesce("cleanup_reason", 'orphaned')
    WHEN "status" IN ('failed', 'expired', 'deleted')
      THEN coalesce("cleanup_reason", "status")
    ELSE "cleanup_reason"
  END,
  "maintenance_claim_id" = NULL,
  "maintenance_claimed_at" = NULL;

ALTER TABLE "retained_screenshot_artifacts"
  ADD CONSTRAINT "retained_screenshot_artifacts_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "retained_screenshot_artifacts_turn_fk"
    FOREIGN KEY ("turn_id") REFERENCES "session_turns"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "retained_screenshot_artifacts_attempt_fk"
    FOREIGN KEY ("attempt_id") REFERENCES "session_turn_attempts"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "retained_screenshot_artifacts_workspace_file_fk"
    FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "files"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "retained_screenshot_artifacts_status_chk"
    CHECK (
      "status" IN (
        'pending', 'reconciling', 'ready', 'cleanup_queued',
        'cleanup_pending', 'failed', 'expired', 'deleted'
      )
    ),
  ADD CONSTRAINT "retained_screenshot_artifacts_quota_state_chk"
    CHECK ("quota_state" IN ('reserved', 'ready', 'released')),
  ADD CONSTRAINT "retained_screenshot_artifacts_status_quota_chk"
    CHECK (
      ("status" IN ('pending', 'reconciling') AND "quota_state" = 'reserved')
      OR ("status" = 'ready' AND "quota_state" = 'ready')
      OR (
        "status" IN ('cleanup_queued', 'cleanup_pending')
        AND "quota_state" IN ('reserved', 'ready')
      )
      OR (
        "status" IN ('failed', 'expired', 'deleted')
        AND "quota_state" = 'released'
      )
    ),
  ADD CONSTRAINT "retained_screenshot_artifacts_ready_shape_chk"
    CHECK (
      ("status" = 'ready' AND "ready_at" IS NOT NULL)
      OR ("status" IN ('pending', 'reconciling') AND "ready_at" IS NULL)
      OR "status" IN ('cleanup_queued', 'cleanup_pending', 'failed', 'expired', 'deleted')
    ),
  ADD CONSTRAINT "retained_screenshot_artifacts_cleanup_reason_chk"
    CHECK (
      ("status" IN ('pending', 'reconciling', 'ready') AND "cleanup_reason" IS NULL)
      OR (
        "status" IN ('cleanup_queued', 'cleanup_pending', 'failed', 'expired', 'deleted')
        AND "cleanup_reason" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "retained_screenshot_artifacts_claim_shape_chk"
    CHECK (
      (
        "status" IN ('reconciling', 'cleanup_pending')
        AND "maintenance_claim_id" IS NOT NULL
        AND "maintenance_claimed_at" IS NOT NULL
      )
      OR (
        "status" NOT IN ('reconciling', 'cleanup_pending')
        AND "maintenance_claim_id" IS NULL
        AND "maintenance_claimed_at" IS NULL
      )
    );

DROP INDEX "retained_screenshot_artifacts_pending_reconcile_idx";
CREATE INDEX "retained_screenshot_artifacts_pending_reconcile_idx"
  ON "retained_screenshot_artifacts" ("updated_at", "artifact_id")
  WHERE "status" IN ('pending', 'reconciling', 'cleanup_queued', 'cleanup_pending');

-- Make the aggregate counters a projection of explicit artifact quota state.
-- This also clears quota leaked by an old parent/file cascade whose lifecycle
-- row no longer exists.
INSERT INTO "workspace_screenshot_quotas" ("workspace_id", "account_id")
SELECT DISTINCT "workspace_id", "account_id"
FROM "retained_screenshot_artifacts"
ON CONFLICT ("workspace_id") DO NOTHING;

UPDATE "workspace_screenshot_quotas" Q
SET
  "reserved_bytes" = COALESCE((
    SELECT sum(A."size_bytes")
    FROM "retained_screenshot_artifacts" A
    WHERE A."workspace_id" = Q."workspace_id" AND A."quota_state" = 'reserved'
  ), 0),
  "ready_bytes" = COALESCE((
    SELECT sum(A."size_bytes")
    FROM "retained_screenshot_artifacts" A
    WHERE A."workspace_id" = Q."workspace_id" AND A."quota_state" = 'ready'
  ), 0),
  "updated_at" = clock_timestamp();

CREATE OR REPLACE FUNCTION opengeni_private.queue_detached_retained_screenshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_reason text;
BEGIN
  IF NOT (
    (OLD.session_id IS NOT NULL AND NEW.session_id IS NULL)
    OR (OLD.turn_id IS NOT NULL AND NEW.turn_id IS NULL)
    OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL)
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('failed', 'expired', 'deleted') THEN
    RETURN NEW;
  END IF;

  v_reason := CASE
    WHEN NEW.session_id IS NULL THEN 'session_deleted'
    WHEN NEW.turn_id IS NULL THEN 'turn_deleted'
    ELSE 'attempt_deleted'
  END;
  NEW.cleanup_reason := v_reason;
  NEW.updated_at := clock_timestamp();

  IF NEW.status IN ('pending', 'reconciling', 'ready', 'cleanup_queued') THEN
    NEW.status := 'cleanup_queued';
    NEW.maintenance_claim_id := NULL;
    NEW.maintenance_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "retained_screenshot_detachment_queue_trg"
  ON "retained_screenshot_artifacts";
CREATE TRIGGER "retained_screenshot_detachment_queue_trg"
BEFORE UPDATE OF "session_id", "turn_id", "attempt_id"
ON "retained_screenshot_artifacts"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.queue_detached_retained_screenshot();

DROP FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer);

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_retained_screenshot_maintenance(
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
        ORDER BY A.retention_expires_at, A.artifact_id
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

REVOKE ALL ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(bigint, bigint, integer)
      TO opengeni_app;
  END IF;
END $$;