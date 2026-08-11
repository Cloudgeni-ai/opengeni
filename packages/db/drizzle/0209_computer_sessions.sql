-- deployment-mode: maintenance
-- Canonical durable ComputerSession registry. Native seat/display facts are
-- supplied only by the exact placement controller after physical activation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "computer_sessions" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "lifecycle" text NOT NULL DEFAULT 'starting',
  "placement_kind" text NOT NULL,
  "sandbox_group_id" uuid,
  "connected_sandbox_id" uuid,
  "device_id" uuid,
  "external_provider_id" text,
  "external_placement_id" text,
  "controller_id" text,
  "controller_generation" text,
  "placement_instance_id" text,
  "token_generation" integer NOT NULL DEFAULT 1,
  "platform" text,
  "adapter" text,
  "seat_id" text,
  "display_id" text,
  "capabilities" jsonb,
  "create_operation_id" uuid NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "failure_code" text,
  "controller_heartbeat_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "computer_sessions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "computer_sessions_create_operation_fk"
    FOREIGN KEY ("workspace_id", "create_operation_id")
    REFERENCES "interaction_operations"("workspace_id", "operation_id") ON DELETE RESTRICT,
  CONSTRAINT "computer_sessions_lifecycle_check" CHECK (
    "lifecycle" IN (
      'starting', 'active', 'suspending', 'suspended', 'restoring',
      'repair_required', 'lost', 'ending', 'ended', 'failed'
    )
  ),
  CONSTRAINT "computer_sessions_platform_check"
    CHECK ("platform" IS NULL OR "platform" IN ('linux', 'macos', 'windows')),
  CONSTRAINT "computer_sessions_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND "token_generation" > 0
    AND ("adapter" IS NULL OR octet_length("adapter") BETWEEN 1 AND 512)
    AND ("seat_id" IS NULL OR octet_length("seat_id") BETWEEN 1 AND 512)
    AND ("display_id" IS NULL OR octet_length("display_id") BETWEEN 1 AND 512)
    AND ("capabilities" IS NULL OR (
      jsonb_typeof("capabilities") = 'object'
      AND octet_length("capabilities"::text) BETWEEN 2 AND 65536
    ))
    AND ("failure_code" IS NULL OR octet_length("failure_code") BETWEEN 1 AND 512)
  ),
  CONSTRAINT "computer_sessions_placement_check" CHECK (
    (
      "placement_kind" = 'sandbox_group'
      AND "sandbox_group_id" IS NOT NULL
      AND "connected_sandbox_id" IS NULL
      AND "device_id" IS NULL
      AND "external_provider_id" IS NULL
      AND "external_placement_id" IS NULL
    ) OR (
      "placement_kind" = 'connected_machine'
      AND "sandbox_group_id" IS NULL
      AND "connected_sandbox_id" IS NOT NULL
      AND "device_id" IS NULL
      AND "external_provider_id" IS NULL
      AND "external_placement_id" IS NULL
    ) OR (
      "placement_kind" = 'attached_device'
      AND "sandbox_group_id" IS NULL
      AND "connected_sandbox_id" IS NULL
      AND "device_id" IS NOT NULL
      AND "external_provider_id" IS NULL
      AND "external_placement_id" IS NULL
    ) OR (
      "placement_kind" = 'external_provider'
      AND "sandbox_group_id" IS NULL
      AND "connected_sandbox_id" IS NULL
      AND "device_id" IS NULL
      AND "external_provider_id" IS NOT NULL
      AND "external_placement_id" IS NOT NULL
      AND octet_length("external_provider_id") BETWEEN 1 AND 512
      AND octet_length("external_placement_id") BETWEEN 1 AND 512
    )
  ),
  CONSTRAINT "computer_sessions_controller_check" CHECK (
    (
      "controller_id" IS NULL
      AND "controller_generation" IS NULL
      AND "placement_instance_id" IS NULL
      AND "controller_heartbeat_at" IS NULL
    ) OR (
      "controller_id" IS NOT NULL
      AND octet_length("controller_id") BETWEEN 1 AND 512
      AND "controller_generation" IS NOT NULL
      AND octet_length("controller_generation") BETWEEN 1 AND 256
      AND "placement_instance_id" IS NOT NULL
      AND octet_length("placement_instance_id") BETWEEN 1 AND 512
      AND "controller_heartbeat_at" IS NOT NULL
    )
  ),
  CONSTRAINT "computer_sessions_native_binding_check" CHECK (
    (
      "platform" IS NULL
      AND "adapter" IS NULL
      AND "seat_id" IS NULL
      AND "display_id" IS NULL
      AND "capabilities" IS NULL
    ) OR (
      "platform" IS NOT NULL
      AND "adapter" IS NOT NULL
      AND "seat_id" IS NOT NULL
      AND "display_id" IS NOT NULL
      AND "capabilities" IS NOT NULL
    )
  ),
  CONSTRAINT "computer_sessions_active_binding_check" CHECK (
    "lifecycle" <> 'active' OR (
      "controller_id" IS NOT NULL
      AND "platform" IS NOT NULL
      AND "capabilities" IS NOT NULL
    )
  ),
  CONSTRAINT "computer_sessions_failure_check" CHECK (
    (
      "lifecycle" IN ('repair_required', 'lost', 'failed')
      AND "failure_code" IS NOT NULL
    ) OR (
      "lifecycle" NOT IN ('repair_required', 'lost', 'failed')
      AND "failure_code" IS NULL
    )
  ),
  CONSTRAINT "computer_sessions_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "computer_sessions_workspace_create_operation_uq"
    UNIQUE ("workspace_id", "create_operation_id")
);

CREATE INDEX "computer_sessions_workspace_lifecycle_idx"
  ON "computer_sessions" ("workspace_id", "lifecycle", "last_used_at", "id");
CREATE INDEX "computer_sessions_sandbox_group_idx"
  ON "computer_sessions" ("workspace_id", "sandbox_group_id", "lifecycle");

CREATE TABLE "computer_session_associations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "computer_session_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid,
  "attempt_id" uuid,
  "relationship" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "computer_session_associations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "computer_session_associations_resource_fk"
    FOREIGN KEY ("workspace_id", "computer_session_id")
    REFERENCES "computer_sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "computer_session_associations_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "computer_session_associations_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL ("turn_id"),
  CONSTRAINT "computer_session_associations_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id"),
  CONSTRAINT "computer_session_associations_relationship_check"
    CHECK ("relationship" IN ('created', 'using', 'observing', 'related')),
  CONSTRAINT "computer_session_associations_values_check" CHECK (
    octet_length("actor_subject_id") BETWEEN 1 AND 1024
    AND ("attempt_id" IS NULL OR "turn_id" IS NOT NULL)
  ),
  CONSTRAINT "computer_session_associations_resource_session_relationship_uq"
    UNIQUE ("computer_session_id", "session_id", "relationship")
);

CREATE INDEX "computer_session_associations_workspace_session_idx"
  ON "computer_session_associations" ("workspace_id", "session_id", "last_used_at");
CREATE INDEX "computer_session_associations_resource_idx"
  ON "computer_session_associations" ("workspace_id", "computer_session_id", "last_used_at");

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_linked_computer_session_fk"
  FOREIGN KEY ("workspace_id", "linked_computer_session_id")
  REFERENCES "computer_sessions"("workspace_id", "id")
  ON DELETE SET NULL ("linked_computer_session_id");

ALTER TABLE "computer_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "computer_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "computer_sessions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "computer_session_associations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "computer_session_associations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "computer_session_associations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.computer_sessions, %I.computer_session_associations FROM opengeni_app',
      target_schema,
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.computer_sessions TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.computer_session_associations TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

-- Interaction holders have one shared liveness protocol. A holder remains live
-- only while its exact BrowserSession or ComputerSession is live on the same
-- sandbox-group lease. Stale controllers lose the durable resource before the
-- holder is removed and the placement becomes drainable.
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
                    AND browser.sandbox_group_id = lease.sandbox_group_id
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
