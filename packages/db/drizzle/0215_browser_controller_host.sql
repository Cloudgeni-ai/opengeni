-- deployment-mode: maintenance
-- Separate a remote browser's logical placement from the sandbox that hosts
-- its sole browserd mutation controller. Existing managed sessions preserve
-- their current home placement; remote rows are backfilled from their immutable
-- creation association.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "browser_sessions"
  ADD COLUMN "controller_host_sandbox_group_id" uuid;

UPDATE "browser_sessions"
SET "controller_host_sandbox_group_id" = "sandbox_group_id"
WHERE "placement_kind" = 'sandbox_group';

UPDATE "browser_sessions" browser
SET "controller_host_sandbox_group_id" = source."sandbox_group_id"
FROM "browser_session_associations" association
JOIN "sessions" source
  ON source."workspace_id" = association."workspace_id"
 AND source."id" = association."session_id"
WHERE browser."workspace_id" = association."workspace_id"
  AND browser."id" = association."browser_session_id"
  AND browser."placement_kind" = 'external_provider'
  AND association."relationship" = 'created';

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_controller_host_check" CHECK (
    ("placement_kind" = 'sandbox_group'
      AND "controller_host_sandbox_group_id" = "sandbox_group_id")
    OR
    ("placement_kind" = 'external_provider'
      AND "controller_host_sandbox_group_id" IS NOT NULL)
    OR
    ("placement_kind" IN ('connected_machine', 'attached_device')
      AND "controller_host_sandbox_group_id" IS NULL)
  );

CREATE INDEX "browser_sessions_controller_host_sandbox_group_idx"
  ON "browser_sessions"
  ("workspace_id", "controller_host_sandbox_group_id", "lifecycle");

-- Reinstall the interaction-aware lease reaper against controller locality,
-- not logical browser locality. This keeps a remote browser alive exactly while
-- its home browserd lease and holder remain authoritative.
DO $interaction_aware_reaper$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
      p_viewer_holder_ttl_ms bigint,
      p_turn_holder_ttl_ms bigint,
      p_interaction_holder_ttl_ms bigint,
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
    DECLARE
      locked_ids uuid[];
      stale_interaction_ids uuid[];
      changed_interaction_workspaces uuid[];
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      SELECT coalesce(pg_catalog.array_agg(candidate.id), ARRAY[]::uuid[])
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

      IF p_interaction_holder_ttl_ms > 0 THEN
        SELECT coalesce(pg_catalog.array_agg(candidate.id), ARRAY[]::uuid[])
        INTO stale_interaction_ids
        FROM (
          SELECT stale.id
          FROM %1$I.sandbox_lease_holders stale
          JOIN %1$I.sandbox_leases lease ON lease.id = stale.lease_id
          WHERE stale.lease_id = ANY(locked_ids)
            AND stale.kind = 'interaction'
            AND (
              stale.last_heartbeat_at
                < pg_catalog.now()
                  - pg_catalog.make_interval(
                      secs => p_interaction_holder_ttl_ms / 1000.0
                    )
              OR NOT (
                EXISTS (
                  SELECT 1
                  FROM %1$I.browser_sessions browser
                  WHERE stale.holder_id = ('browser-session:' || browser.id::text)
                    AND browser.account_id = stale.account_id
                    AND browser.workspace_id = stale.workspace_id
                    AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
                    AND browser.lifecycle IN (
                      'starting', 'active', 'suspending', 'restoring', 'ending'
                    )
                )
                OR EXISTS (
                  SELECT 1
                  FROM %1$I.computer_sessions computer
                  WHERE stale.holder_id = ('computer-session:' || computer.id::text)
                    AND computer.account_id = stale.account_id
                    AND computer.workspace_id = stale.workspace_id
                    AND computer.sandbox_group_id = lease.sandbox_group_id
                    AND computer.lifecycle IN (
                      'starting', 'active', 'suspending', 'restoring', 'ending'
                    )
                )
              )
            )
          FOR UPDATE OF stale SKIP LOCKED
        ) candidate;

        IF pg_catalog.cardinality(stale_interaction_ids) > 0 THEN
          WITH updated_browser AS (
            UPDATE %1$I.browser_sessions browser
            SET lifecycle = 'lost',
                controller_id = null,
                controller_generation = null,
                placement_instance_id = null,
                controller_heartbeat_at = null,
                failure_code = 'controller_heartbeat_expired',
                updated_at = pg_catalog.now()
            FROM %1$I.sandbox_lease_holders holder
            WHERE holder.id = ANY(stale_interaction_ids)
              AND holder.holder_id = ('browser-session:' || browser.id::text)
              AND holder.account_id = browser.account_id
              AND holder.workspace_id = browser.workspace_id
              AND browser.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
            RETURNING browser.workspace_id
          ), updated_computer AS (
            UPDATE %1$I.computer_sessions computer
            SET lifecycle = 'lost',
                controller_id = null,
                controller_generation = null,
                placement_instance_id = null,
                controller_heartbeat_at = null,
                failure_code = 'controller_heartbeat_expired',
                updated_at = pg_catalog.now()
            FROM %1$I.sandbox_lease_holders holder
            WHERE holder.id = ANY(stale_interaction_ids)
              AND holder.holder_id = ('computer-session:' || computer.id::text)
              AND holder.account_id = computer.account_id
              AND holder.workspace_id = computer.workspace_id
              AND computer.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
            RETURNING computer.workspace_id
          ), updated AS (
            SELECT workspace_id FROM updated_browser
            UNION
            SELECT workspace_id FROM updated_computer
          )
          SELECT coalesce(
            pg_catalog.array_agg(DISTINCT updated.workspace_id),
            ARRAY[]::uuid[]
          )
          INTO changed_interaction_workspaces
          FROM updated;

          DELETE FROM %1$I.sandbox_lease_holders holder
          WHERE holder.id = ANY(stale_interaction_ids);

          UPDATE %1$I.workspace_interaction_revisions revision
          SET revision = revision.revision + 1,
              updated_at = pg_catalog.now()
          WHERE revision.workspace_id = ANY(changed_interaction_workspaces);
        END IF;
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
$interaction_aware_reaper$;

REVOKE ALL ON FUNCTION opengeni_private.reap_sandbox_leases(
  bigint, bigint, bigint, bigint
) FROM PUBLIC;

DO $reaper_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(
      bigint, bigint, bigint, bigint
    ) TO opengeni_app;
  END IF;
END
$reaper_grant$;

RESET statement_timeout;
RESET lock_timeout;
