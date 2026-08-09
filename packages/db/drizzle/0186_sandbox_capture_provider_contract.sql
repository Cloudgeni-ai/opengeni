-- deployment-mode: rolling
-- Make provider capture takeover semantics explicit and provider-neutral. The
-- durable bit records whether a successor may safely overlap an ambiguous
-- predecessor. It covers both same-request provider idempotency and independent
-- read-only captures; replay_safe remains the narrower wire-idempotency proof.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "sandbox_leases"
  ADD COLUMN IF NOT EXISTS "archive_capture_takeover_safe" boolean
    NOT NULL DEFAULT false;

-- Claims created before this migration had only the narrower Modal replay
-- receipt. Preserve exactly that proven subset; all other legacy claims remain
-- exclusive until their deadline plus provider-specific proof.
UPDATE "sandbox_leases"
SET
  "archive_capture_takeover_safe" = "archive_capture_provider_replay_safe",
  "updated_at" = pg_catalog.clock_timestamp()
WHERE "archive_capture_id" IS NOT NULL
  AND "archive_capture_takeover_safe" IS DISTINCT FROM
    "archive_capture_provider_replay_safe";

CREATE OR REPLACE FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.liveness = 'draining'
    AND NEW.archive_capture_id IS NOT NULL
    AND NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id
    AND NEW.reaper_hold_id IS NOT NULL
    AND NEW.reaper_hold_until > pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION 'sandbox reaper hold blocks drain capture for lease %', NEW.id
      USING ERRCODE = '55000';
  END IF;

  IF OLD.liveness = 'draining'
    AND NEW.liveness = 'cold'
    AND NEW.reaper_hold_id IS NOT NULL
    AND NEW.reaper_hold_until > pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION 'sandbox reaper hold blocks cold commit for lease %', NEW.id
      USING ERRCODE = '55000';
  END IF;

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

  IF NEW.archive_capture_id IS NULL THEN
    NEW.archive_capture_operation_id := NULL;
    NEW.archive_capture_provider_request_id := NULL;
    NEW.archive_capture_provider_replay_safe := false;
    NEW.archive_capture_takeover_safe := false;
    NEW.archive_capture_attempt := NULL;
    NEW.archive_capture_published_at := NULL;
  ELSIF NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id THEN
    NEW.archive_capture_published_at := NULL;
    IF NEW.archive_capture_operation_id IS NOT DISTINCT FROM OLD.archive_capture_operation_id
      AND NEW.archive_capture_attempt IS NOT DISTINCT FROM OLD.archive_capture_attempt
    THEN
      -- A pre-0186 writer knows neither takeover contract. Never inherit the
      -- predecessor's permission merely because the new column is invisible to it.
      NEW.archive_capture_operation_id := NEW.archive_capture_id;
      NEW.archive_capture_provider_request_id := NEW.archive_capture_id;
      NEW.archive_capture_provider_replay_safe := false;
      NEW.archive_capture_takeover_safe := false;
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

  IF NEW.archive_capture_provider_replay_safe
    AND NOT NEW.archive_capture_takeover_safe
  THEN
    RAISE EXCEPTION 'provider-replay-safe capture must be takeover-safe for lease %', NEW.id
      USING ERRCODE = '23514';
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

ALTER TABLE "sandbox_leases"
  DROP CONSTRAINT IF EXISTS "sandbox_leases_archive_capture_check",
  ADD CONSTRAINT "sandbox_leases_archive_capture_check"
    CHECK (
      (
        "archive_capture_id" IS NULL
        AND "archive_capture_operation_id" IS NULL
        AND "archive_capture_provider_request_id" IS NULL
        AND "archive_capture_provider_replay_safe" = false
        AND "archive_capture_takeover_safe" = false
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
          OR "archive_capture_takeover_safe" = true
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

-- Keep the global DB-owned sweep aligned with the per-workspace implementation.
-- A live turn heartbeats every 10s. A canonical holder whose authoritative turn
-- is already closed is dead immediately; every other turn holder gets the normal
-- lease-TTL crash horizon. Once a capture claim exists, holder-zero dispatch is
-- immediate because that claim already is the durable admission/teardown fence.
DO $capture_aware_reaper$
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
            AND (
              stale.last_heartbeat_at
                < pg_catalog.now()
                  - pg_catalog.make_interval(secs => p_turn_holder_ttl_ms / 1000.0)
              OR (
                stale.holder_id ~* '^turn-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                AND NOT EXISTS (
                  SELECT 1
                  FROM %1$I.session_turn_attempts attempt
                  JOIN %1$I.session_turns turn
                    ON turn.account_id = attempt.account_id
                   AND turn.workspace_id = attempt.workspace_id
                   AND turn.session_id = attempt.session_id
                   AND turn.id = attempt.turn_id
                   AND turn.execution_generation = attempt.execution_generation
                   AND turn.active_attempt_id = attempt.id
                  WHERE stale.holder_id = ('turn-attempt:' || attempt.id::text)
                    AND attempt.account_id = stale.account_id
                    AND attempt.workspace_id = stale.workspace_id
                    AND attempt.session_id = stale.subject_id
                    AND attempt.state IN ('claimed', 'running')
                )
              )
            )
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
              OR lease.archive_capture_id IS NOT NULL
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
$capture_aware_reaper$;

REVOKE ALL ON FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence() FROM PUBLIC;

RESET statement_timeout;
RESET lock_timeout;
