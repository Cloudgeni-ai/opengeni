-- deployment-mode: rolling
-- Make the provider-teardown ownership point durable across a mixed worker
-- rollout. Pre-0184 reapers clear archive_capture_id after publication and
-- before provider termination; new admission must not re-arm that exact box in
-- the resulting window. The existing rotation columns are already honored by
-- every supported old/new acquire path, so a typed teardown_claim marker is a
-- backward-compatible bridge as well as useful durable lifecycle truth.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- A logical operation survives Temporal retries. capture_id changes per DB
-- owner, while provider_request_id remains the external operation lineage.
-- replay_safe is explicit: old rolling workers are false; only a caller that
-- actually supplied a provider-defined idempotency key may retry immediately.
ALTER TABLE "sandbox_leases"
  ADD COLUMN IF NOT EXISTS "archive_capture_operation_id" uuid,
  ADD COLUMN IF NOT EXISTS "archive_capture_provider_request_id" uuid,
  ADD COLUMN IF NOT EXISTS "archive_capture_provider_replay_safe" boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "archive_capture_attempt" integer,
  ADD COLUMN IF NOT EXISTS "archive_capture_published_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reaper_hold_id" uuid,
  ADD COLUMN IF NOT EXISTS "reaper_hold_until" timestamptz,
  ADD COLUMN IF NOT EXISTS "reaper_hold_reason" text;

ALTER TABLE "sandbox_leases"
  DROP CONSTRAINT IF EXISTS "sandbox_leases_reaper_hold_check",
  ADD CONSTRAINT "sandbox_leases_reaper_hold_check"
    CHECK (
      (
        "reaper_hold_id" IS NULL
        AND "reaper_hold_until" IS NULL
        AND "reaper_hold_reason" IS NULL
      ) OR (
        "reaper_hold_id" IS NOT NULL
        AND "reaper_hold_until" IS NOT NULL
        AND "reaper_hold_reason" IS NOT NULL
        AND length("reaper_hold_reason") BETWEEN 1 AND 500
      )
    ) NOT VALID;

ALTER TABLE "sandbox_leases"
  VALIDATE CONSTRAINT "sandbox_leases_reaper_hold_check";

ALTER TABLE "sandbox_leases"
  DROP CONSTRAINT IF EXISTS "sandbox_leases_rotation_check",
  ADD CONSTRAINT "sandbox_leases_rotation_check"
    CHECK (
      ("rotation_requested_at" IS NULL AND "rotation_reason" IS NULL)
      OR (
        "rotation_requested_at" IS NOT NULL
        AND "rotation_reason" IS NOT NULL
        AND "rotation_reason" IN ('provider_deadline', 'operator', 'teardown_claim')
      )
    ) NOT VALID;

ALTER TABLE "sandbox_leases"
  VALIDATE CONSTRAINT "sandbox_leases_rotation_check";

CREATE OR REPLACE FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  -- The receipt must predate teardown. This blocks both a new drain capture and
  -- an attempt replacement from an old/new worker after an operator acquired a
  -- live hold. Warm turn-end capture remains allowed: the hold governs only
  -- automatic draining teardown.
  IF NEW.liveness = 'draining'
    AND NEW.archive_capture_id IS NOT NULL
    AND NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id
    AND NEW.reaper_hold_id IS NOT NULL
    AND NEW.reaper_hold_until > pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION 'sandbox reaper hold blocks drain capture for lease %', NEW.id
      USING ERRCODE = '55000';
  END IF;

  -- Protect old confirmDrainCold implementations too. A hold can be acquired
  -- only before the durable teardown claim, so a draining->cold write during an
  -- active hold is always stale/unsafe.
  IF OLD.liveness = 'draining'
    AND NEW.liveness = 'cold'
    AND NEW.reaper_hold_id IS NOT NULL
    AND NEW.reaper_hold_until > pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION 'sandbox reaper hold blocks cold commit for lease %', NEW.id
      USING ERRCODE = '55000';
  END IF;

  -- A mixed-version race needs a table-boundary ownership check too. An old
  -- reaper publishes its archive by clearing archive_capture_id, then performs
  -- provider teardown and a later draining->cold write. A new reaper can claim
  -- the row in that window. The old cold write must not atomically erase that
  -- newer claim. New confirmDrainCold sets this transaction-local receipt only
  -- after locking and revalidating the exact capture; old binaries set nothing.
  IF OLD.liveness = 'draining'
    AND NEW.liveness = 'cold'
    AND OLD.archive_capture_id IS NOT NULL
    AND NULLIF(
      pg_catalog.current_setting('opengeni.sandbox_drain_capture_id', true),
      ''
    ) IS DISTINCT FROM OLD.archive_capture_id::text
  THEN
    RAISE EXCEPTION 'sandbox drain capture ownership blocks cold commit for lease %', NEW.id
      USING ERRCODE = '55000';
  END IF;

  -- Old binaries know only archive_capture_id. Normalize their writes at the
  -- table boundary so the rolling deployment always retains a complete receipt.
  IF NEW.archive_capture_id IS NULL THEN
    NEW.archive_capture_operation_id := NULL;
    NEW.archive_capture_provider_request_id := NULL;
    NEW.archive_capture_provider_replay_safe := false;
    NEW.archive_capture_attempt := NULL;
    NEW.archive_capture_published_at := NULL;
  ELSIF NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id THEN
    -- Publication belongs to one exact physical capture. A replacement cannot
    -- inherit permission to skip capture from its predecessor.
    NEW.archive_capture_published_at := NULL;
    IF NEW.archive_capture_operation_id IS NOT DISTINCT FROM OLD.archive_capture_operation_id
      AND NEW.archive_capture_attempt IS NOT DISTINCT FROM OLD.archive_capture_attempt
    THEN
      NEW.archive_capture_operation_id := NEW.archive_capture_id;
      NEW.archive_capture_provider_request_id := NEW.archive_capture_id;
      NEW.archive_capture_provider_replay_safe := false;
      NEW.archive_capture_attempt := 1;
    ELSE
      NEW.archive_capture_operation_id := COALESCE(
        NEW.archive_capture_operation_id,
        NEW.archive_capture_id
      );
      NEW.archive_capture_provider_request_id := COALESCE(
        NEW.archive_capture_provider_request_id,
        NEW.archive_capture_id
      );
      NEW.archive_capture_attempt := COALESCE(NEW.archive_capture_attempt, 1);
    END IF;
  ELSE
    NEW.archive_capture_operation_id := COALESCE(
      NEW.archive_capture_operation_id,
      NEW.archive_capture_id
    );
    NEW.archive_capture_provider_request_id := COALESCE(
      NEW.archive_capture_provider_request_id,
      NEW.archive_capture_id
    );
    NEW.archive_capture_attempt := COALESCE(NEW.archive_capture_attempt, 1);
  END IF;

  IF OLD.liveness = 'draining'
    AND NEW.liveness = 'draining'
    AND OLD.archive_capture_id IS NULL
    AND NEW.archive_capture_id IS NOT NULL
    AND NEW.rotation_requested_at IS NULL
  THEN
    NEW.rotation_requested_at := COALESCE(
      NEW.archive_capture_started_at,
      pg_catalog.clock_timestamp()
    );
    NEW.rotation_reason := 'teardown_claim';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS sandbox_leases_drain_teardown_fence ON "sandbox_leases";
CREATE TRIGGER sandbox_leases_drain_teardown_fence
BEFORE UPDATE OF "archive_capture_id", "liveness" ON "sandbox_leases"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence();

-- Cover every claim already held when the online migration activates. The
-- trigger owns every claim that starts after it is installed.
UPDATE "sandbox_leases"
SET
  "archive_capture_operation_id" = COALESCE(
    "archive_capture_operation_id",
    "archive_capture_id"
  ),
  "archive_capture_provider_request_id" = "archive_capture_id",
  "archive_capture_provider_replay_safe" = false,
  "archive_capture_attempt" = COALESCE("archive_capture_attempt", 1),
  "updated_at" = pg_catalog.clock_timestamp()
WHERE "archive_capture_id" IS NOT NULL;

-- A pre-migration draining claim also needs the old-reader teardown bridge.
UPDATE "sandbox_leases"
SET
  "rotation_requested_at" = COALESCE(
    "rotation_requested_at",
    "archive_capture_started_at",
    pg_catalog.clock_timestamp()
  ),
  "rotation_reason" = COALESCE("rotation_reason", 'teardown_claim'),
  "updated_at" = pg_catalog.clock_timestamp()
WHERE "liveness" = 'draining'
  AND "archive_capture_id" IS NOT NULL
  AND "rotation_requested_at" IS NULL;

ALTER TABLE "sandbox_leases"
  DROP CONSTRAINT IF EXISTS "sandbox_leases_archive_capture_check",
  ADD CONSTRAINT "sandbox_leases_archive_capture_check"
    CHECK (
      (
        "archive_capture_id" IS NULL
        AND "archive_capture_operation_id" IS NULL
        AND "archive_capture_provider_request_id" IS NULL
        AND "archive_capture_provider_replay_safe" = false
        AND "archive_capture_attempt" IS NULL
        AND "archive_capture_generation" IS NULL
        AND "archive_capture_started_at" IS NULL
        AND "archive_capture_deadline_at" IS NULL
        AND "archive_capture_published_at" IS NULL
      ) OR (
        "archive_capture_id" IS NOT NULL
        AND "archive_capture_operation_id" IS NOT NULL
        AND "archive_capture_provider_request_id" IS NOT NULL
        AND (
          "archive_capture_provider_replay_safe" = false
          OR (
            "backend" = 'modal'
            AND COALESCE(
              "resume_state" #>> '{sessionState,providerState,workspacePersistence}',
              "resume_state" #>> '{sessionState,workspacePersistence}'
            ) = 'snapshot_filesystem'
          )
        )
        AND "archive_capture_attempt" IS NOT NULL
        AND "archive_capture_attempt" > 0
        AND "archive_capture_generation" IS NOT NULL
        AND "archive_capture_generation" = "workspace_generation"
        AND "archive_capture_started_at" IS NOT NULL
        AND "archive_capture_deadline_at" IS NOT NULL
        AND "archive_capture_deadline_at" > "archive_capture_started_at"
        AND (
          "archive_capture_published_at" IS NULL
          OR "liveness" = 'draining'
        )
      )
    ) NOT VALID;

ALTER TABLE "sandbox_leases"
  VALIDATE CONSTRAINT "sandbox_leases_archive_capture_check";

-- The global reaper is database-owned, so replacing it here protects a hold
-- even while old worker binaries are still running. Held rows may still have
-- stale holder receipts reconciled, but cannot enter/complete automatic drain.
DO $hold_aware_reaper$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
      p_viewer_holder_ttl_ms bigint,
      p_turn_holder_ttl_ms bigint,
      p_idle_grace_ms bigint
    )
    RETURNS TABLE (
      workspace_id uuid,
      sandbox_group_id uuid,
      instance_id text,
      lease_epoch integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE locked_ids uuid[];
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      SELECT coalesce(
        pg_catalog.array_agg(candidate.id),
        ARRAY[]::uuid[]
      )
      INTO locked_ids
      FROM (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.liveness <> 'cold'
          OR EXISTS (
            SELECT 1
            FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id
          )
        ORDER BY lease.updated_at, lease.id
        LIMIT 500
        FOR UPDATE OF lease SKIP LOCKED
      ) candidate;

      IF pg_catalog.cardinality(locked_ids) = 0 THEN
        RETURN;
      END IF;

      DELETE FROM %1$I.sandbox_lease_holders holder
      USING (
        SELECT stale.id
        FROM %1$I.sandbox_lease_holders stale
        WHERE stale.lease_id = ANY(locked_ids)
          AND stale.kind IN ('viewer', 'direct')
          AND stale.last_heartbeat_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_viewer_holder_ttl_ms / 1000.0)
        FOR UPDATE OF stale SKIP LOCKED
      ) victim
      WHERE holder.id = victim.id;

      IF p_turn_holder_ttl_ms > 0 THEN
        DELETE FROM %1$I.sandbox_lease_holders holder
        USING (
          SELECT stale.id
          FROM %1$I.sandbox_lease_holders stale
          WHERE stale.lease_id = ANY(locked_ids)
            AND stale.kind = 'turn'
            AND stale.last_heartbeat_at
              < pg_catalog.now()
                - pg_catalog.make_interval(secs => p_turn_holder_ttl_ms / 1000.0)
          FOR UPDATE OF stale SKIP LOCKED
        ) victim
        WHERE holder.id = victim.id;
      END IF;

      UPDATE %1$I.sandbox_leases lease SET
        refcount = counts.total,
        turn_holders = counts.turns,
        viewer_holders = counts.viewers,
        liveness = CASE
          WHEN lease.liveness = 'warm'
            AND counts.total = 0
            AND counts.turns = 0
            AND (
              lease.reaper_hold_id IS NULL
              OR lease.reaper_hold_until <= pg_catalog.now()
            )
          THEN 'draining' ELSE lease.liveness END,
        expires_at = CASE
          WHEN lease.liveness = 'warm'
            AND counts.total = 0
            AND counts.turns = 0
            AND (
              lease.reaper_hold_id IS NULL
              OR lease.reaper_hold_until <= pg_catalog.now()
            )
          THEN CASE
            WHEN lease.rotation_requested_at IS NOT NULL
            THEN pg_catalog.now() - interval '1 millisecond'
            ELSE pg_catalog.now()
              + pg_catalog.make_interval(secs => p_idle_grace_ms / 1000.0)
          END
          ELSE lease.expires_at END,
        updated_at = pg_catalog.now()
      FROM (
        SELECT candidate.id,
          pg_catalog.count(holder.id)::int AS total,
          pg_catalog.count(holder.id)
            FILTER (WHERE holder.kind = 'turn')::int AS turns,
          pg_catalog.count(holder.id)
            FILTER (WHERE holder.kind = 'viewer')::int AS viewers
        FROM pg_catalog.unnest(locked_ids) candidate(id)
        LEFT JOIN %1$I.sandbox_lease_holders holder
          ON holder.lease_id = candidate.id
        GROUP BY candidate.id
      ) counts
      WHERE lease.id = counts.id;

      UPDATE %1$I.sandbox_leases lease SET
        liveness = 'cold',
        instance_id = null,
        lease_epoch = lease.lease_epoch + 1,
        reaper_hold_id = null,
        reaper_hold_until = null,
        reaper_hold_reason = null,
        resume_state = opengeni_private.warming_reset_resume_state_v2(
          lease.backend,
          lease.resume_backend_id,
          lease.resume_state,
          lease.workspace_generation,
          lease.archive_generation,
          pg_catalog.clock_timestamp()
        ),
        resume_backend_id = CASE
          WHEN coalesce(
            lease.resume_state #>> '{sessionState,workspaceArchive}', ''
          ) <> ''
            OR coalesce(
              lease.resume_state #>> '{sessionState,workspaceArchivePrev}', ''
            ) <> ''
          THEN coalesce(lease.resume_backend_id, lease.backend)
          ELSE null END,
        data_plane_url = null,
        terminal_data_plane_url = null,
        provider_created_at = null,
        provider_deadline_at = null,
        rotation_requested_at = null,
        rotation_reason = null,
        updated_at = pg_catalog.now()
      WHERE lease.id = ANY(locked_ids)
        AND lease.liveness = 'warming'
        AND lease.expires_at < pg_catalog.now()
        AND lease.instance_id IS NULL
        AND (
          lease.reaper_hold_id IS NULL
          OR lease.reaper_hold_until <= pg_catalog.now()
        );

      UPDATE %1$I.sandbox_leases lease SET
        liveness = 'draining',
        refcount = 0,
        turn_holders = 0,
        viewer_holders = 0,
        data_plane_url = null,
        terminal_data_plane_url = null,
        lease_epoch = lease.lease_epoch + 1,
        reaper_hold_id = null,
        reaper_hold_until = null,
        reaper_hold_reason = null,
        expires_at = pg_catalog.now() - interval '1 millisecond',
        updated_at = pg_catalog.now()
      WHERE lease.id = ANY(locked_ids)
        AND lease.liveness = 'warming'
        AND lease.expires_at < pg_catalog.now()
        AND lease.instance_id IS NOT NULL
        AND (
          lease.reaper_hold_id IS NULL
          OR lease.reaper_hold_until <= pg_catalog.now()
        );

      RETURN QUERY
        SELECT lease.workspace_id, lease.sandbox_group_id,
          lease.instance_id, lease.lease_epoch
        FROM %1$I.sandbox_leases lease
        WHERE lease.id = ANY(locked_ids)
          AND lease.liveness = 'draining'
          AND lease.expires_at < pg_catalog.now()
          AND lease.refcount = 0
          AND (
            lease.reaper_hold_id IS NULL
            OR lease.reaper_hold_until <= pg_catalog.now()
          );
    END;
    $function$;
  $create$, data_schema);
END
$hold_aware_reaper$;

-- Provider-deadline admission is also automatic teardown. Keep the exact
-- provider available while held; release/expiry makes it eligible next scan.
DO $hold_aware_rotations$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.request_due_sandbox_rotations(
      p_lead_ms bigint,
      p_limit integer
    )
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      requested integer;
      requested_ids uuid[];
    BEGIN
      IF p_lead_ms IS NULL OR p_lead_ms < 0 OR p_lead_ms > 86400000 THEN
        RAISE EXCEPTION 'sandbox rotation lead must be between 0 and 24h'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'sandbox rotation batch limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      WITH candidates AS MATERIALIZED (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.backend = 'modal'
          AND lease.liveness IN ('warming', 'warm')
          AND lease.provider_deadline_at IS NOT NULL
          AND lease.provider_deadline_at
            <= pg_catalog.now()
              + pg_catalog.make_interval(secs => p_lead_ms / 1000.0)
          AND lease.rotation_requested_at IS NULL
          AND (
            lease.reaper_hold_id IS NULL
            OR lease.reaper_hold_until <= pg_catalog.now()
          )
        ORDER BY lease.provider_deadline_at, lease.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      ),
      due AS (
        UPDATE %1$I.sandbox_leases lease SET
          rotation_requested_at = pg_catalog.now(),
          rotation_reason = 'provider_deadline',
          updated_at = pg_catalog.now()
        FROM candidates
        WHERE lease.id = candidates.id
          AND (
            lease.reaper_hold_id IS NULL
            OR lease.reaper_hold_until <= pg_catalog.now()
          )
        RETURNING lease.id
      )
      SELECT
        coalesce(pg_catalog.array_agg(due.id), ARRAY[]::uuid[]),
        pg_catalog.count(*)::integer
      INTO requested_ids, requested
      FROM due;

      DELETE FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = ANY(requested_ids)
        AND holder.kind = 'viewer';

      UPDATE %1$I.sandbox_leases lease SET
        refcount = counts.total,
        turn_holders = counts.turns,
        viewer_holders = counts.viewers,
        liveness = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0 THEN 'draining'
          ELSE lease.liveness
        END,
        expires_at = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0
          THEN pg_catalog.now() - interval '1 millisecond'
          ELSE lease.expires_at
        END,
        updated_at = pg_catalog.now()
      FROM (
        SELECT candidate.id,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id)::int AS total,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id AND holder.kind = 'turn')::int AS turns,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id AND holder.kind = 'viewer')::int AS viewers
        FROM unnest(requested_ids) requested_id(id)
        JOIN %1$I.sandbox_leases candidate ON candidate.id = requested_id.id
      ) counts
      WHERE lease.id = counts.id;

      RETURN requested;
    END;
    $function$;
  $create$, data_schema);
END
$hold_aware_rotations$;

-- A native checkpoint exists before its candidate receipt can be published to
-- current/previous. While an archive-capture claim still owns the exact source
-- lease/epoch/instance/generation, every native candidate produced from that
-- physical capture is durable recovery state rather than an orphan. Protect it
-- from generic candidate GC until the claim settles. The provider request id is
-- deliberately not compared with object_id: Modal's request UUID and returned
-- Image id are different identifiers.
DO $capture_aware_checkpoint_gc$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      id uuid,
      provider_backend text,
      provider_binding_key text,
      provider_binding jsonb,
      object_kind text,
      object_id text,
      delete_attempts integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_claim_id IS NULL THEN
        RAISE EXCEPTION 'checkpoint artifact claim id is required'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'checkpoint artifact claim limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms IS NULL
        OR p_claim_ttl_ms < 1000
        OR p_claim_ttl_ms > 3600000
      THEN
        RAISE EXCEPTION 'checkpoint artifact claim TTL must be between 1s and 1h'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      WITH stale_claims AS MATERIALIZED (
        SELECT artifact.id
        FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE artifact.state = 'deleting'
          AND artifact.delete_claimed_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
        ORDER BY artifact.delete_claimed_at, artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.sandbox_checkpoint_artifacts artifact SET
        state = 'delete_failed',
        delete_after = pg_catalog.now(),
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = coalesce(
          last_delete_error, 'stale delete claim recovered'
        ),
        updated_at = pg_catalog.now()
      FROM stale_claims
      WHERE artifact.id = stale_claims.id;

      RETURN QUERY
      WITH candidates AS (
        SELECT artifact.id
        FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE (
            (
              artifact.state = 'candidate'
              AND artifact.created_at < pg_catalog.now() - interval '15 minutes'
            )
            OR (
              artifact.state IN ('current', 'previous')
              AND artifact.created_at < pg_catalog.now() - interval '15 minutes'
            )
            OR (
              artifact.state IN ('delete_pending', 'delete_failed')
              AND coalesce(artifact.delete_after, artifact.created_at)
                <= pg_catalog.now()
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
               OR lease.previous_checkpoint_artifact_id = artifact.id
               OR (
                 artifact.provenance = 'native_capture'
                 AND lease.id = artifact.source_lease_id
                 AND lease.lease_epoch = artifact.source_lease_epoch
                 AND lease.instance_id = artifact.source_instance_id
                 AND lease.backend = artifact.provider_backend
                 AND lease.archive_capture_id IS NOT NULL
                 AND lease.archive_capture_generation
                   = artifact.source_workspace_generation
               )
          )
        ORDER BY coalesce(artifact.delete_after, artifact.created_at), artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.sandbox_checkpoint_artifacts artifact SET
        state = 'deleting',
        delete_attempts = artifact.delete_attempts + 1,
        delete_claim_id = p_claim_id,
        delete_claimed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
      FROM candidates
      WHERE artifact.id = candidates.id
      RETURNING artifact.id, artifact.provider_backend, artifact.provider_binding_key,
        artifact.provider_binding, artifact.object_kind, artifact.object_id,
        artifact.delete_attempts;
    END;
    $function$;
  $create$, data_schema);
END
$capture_aware_checkpoint_gc$;

REVOKE ALL ON FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence() FROM PUBLIC;

RESET statement_timeout;
RESET lock_timeout;
