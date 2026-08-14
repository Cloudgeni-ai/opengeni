-- deployment-mode: maintenance
-- Crash-safe SiteAuth maintenance claims. A claim owns one hidden session id
-- and one operation id; retries repair the same session rather than dispatching
-- duplicate health or repair agents.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "site_auth_connections"
  ADD COLUMN "maintenance_operation_id" uuid,
  ADD COLUMN "maintenance_action" text,
  ADD COLUMN "maintenance_due_at" timestamptz,
  ADD COLUMN "maintenance_claimed_at" timestamptz,
  ADD COLUMN "maintenance_session_id" uuid,
  ADD COLUMN "maintenance_started_at" timestamptz;

ALTER TABLE "site_auth_connections"
  ADD CONSTRAINT "site_auth_connections_maintenance_check" CHECK (
    (
      "maintenance_operation_id" IS NULL
      AND "maintenance_action" IS NULL
      AND "maintenance_due_at" IS NULL
      AND "maintenance_claimed_at" IS NULL
      AND "maintenance_session_id" IS NULL
      AND "maintenance_started_at" IS NULL
    ) OR (
      "status" = 'active'
      AND "health_policy"->>'mode' = 'maintained'
      AND "maintenance_operation_id" IS NOT NULL
      AND "maintenance_action" IN ('health_check', 'repair')
      AND "maintenance_due_at" IS NOT NULL
      AND "maintenance_claimed_at" IS NOT NULL
      AND "maintenance_session_id" IS NOT NULL
      AND (
        "maintenance_started_at" IS NULL
        OR "maintenance_started_at" >= "maintenance_due_at"
      )
    )
  );

ALTER TABLE "auth_runs"
  ADD COLUMN "maintenance_operation_id" uuid,
  ADD CONSTRAINT "auth_runs_maintenance_check" CHECK (
    "maintenance_operation_id" IS NULL
    OR "purpose" IN ('health_check', 'repair')
  );

DROP INDEX "site_auth_connections_health_maintenance_idx";
CREATE INDEX "site_auth_connections_health_maintenance_idx"
  ON "site_auth_connections" (
    "next_check_at", "maintenance_claimed_at", "id"
  );

CREATE UNIQUE INDEX "auth_runs_workspace_maintenance_operation_uq"
  ON "auth_runs" ("workspace_id", "maintenance_operation_id")
  WHERE "maintenance_operation_id" IS NOT NULL;

-- Sole cross-workspace claim boundary. An undispatched stale claim reuses its
-- exact ids. A completed/failed maintenance session without a live AuthRun is
-- replaced only after the claim timeout. Active sessions and interventions are
-- never stolen.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_site_auth_maintenance(
      p_claim_timeout_ms bigint,
      p_limit integer
    )
    RETURNS TABLE (
      operation_id uuid,
      session_id uuid,
      account_id uuid,
      workspace_id uuid,
      site_auth_connection_id uuid,
      connection_version bigint,
      action text,
      due_at timestamptz,
      claimed_at timestamptz,
      name text,
      account_label text,
      login_url text,
      verification_url_prefixes jsonb,
      preferred_identity_id uuid,
      preferred_placement jsonb,
      preferred_network_route_id uuid,
      health_policy jsonb,
      verification_state text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      WITH candidates AS MATERIALIZED (
        SELECT
          C.id,
          C.maintenance_operation_id,
          C.maintenance_session_id,
          C.maintenance_started_at,
          S.status AS session_status
        FROM %1$I.site_auth_connections C
        LEFT JOIN %1$I.sessions S
          ON S.workspace_id = C.workspace_id
          AND S.id = C.maintenance_session_id
        WHERE C.status = 'active'
          AND C.health_policy->>'mode' = 'maintained'
          AND C.next_check_at <= clock_timestamp()
          AND (
            C.maintenance_operation_id IS NULL
            OR (
              C.maintenance_started_at IS NULL
              AND C.maintenance_claimed_at <= clock_timestamp() - (
                greatest(coalesce(p_claim_timeout_ms, 0), 0)::double precision * interval '1 millisecond'
              )
            )
            OR (
              C.maintenance_started_at IS NOT NULL
              AND S.status = 'queued'
              AND NOT EXISTS (
                SELECT 1
                FROM %1$I.auth_runs R
                WHERE R.workspace_id = C.workspace_id
                  AND R.maintenance_operation_id = C.maintenance_operation_id
                  AND R.settled_at IS NULL
              )
              AND C.maintenance_claimed_at <= clock_timestamp() - (
                greatest(coalesce(p_claim_timeout_ms, 0), 0)::double precision * interval '1 millisecond'
              )
            )
            OR (
              C.maintenance_started_at IS NOT NULL
              AND (S.id IS NULL OR S.status IN ('idle', 'failed', 'cancelled'))
              AND NOT EXISTS (
                SELECT 1
                FROM %1$I.auth_runs R
                WHERE R.workspace_id = C.workspace_id
                  AND R.maintenance_operation_id = C.maintenance_operation_id
                  AND R.settled_at IS NULL
              )
              AND C.maintenance_claimed_at <= clock_timestamp() - (
                greatest(coalesce(p_claim_timeout_ms, 0), 0)::double precision * interval '1 millisecond'
              )
            )
          )
        ORDER BY C.next_check_at, C.id
        LIMIT least(greatest(coalesce(p_limit, 0), 0), 1000)
        FOR UPDATE OF C SKIP LOCKED
      ), prepared AS (
        SELECT
          X.id,
          CASE
            WHEN X.maintenance_operation_id IS NOT NULL
              AND (
                X.maintenance_started_at IS NULL
                OR X.session_status = 'queued'
              )
              THEN X.maintenance_operation_id
            ELSE gen_random_uuid()
          END AS operation_id,
          CASE
            WHEN X.maintenance_session_id IS NOT NULL
              AND (
                X.maintenance_started_at IS NULL
                OR X.session_status = 'queued'
              )
              THEN X.maintenance_session_id
            ELSE gen_random_uuid()
          END AS session_id
        FROM candidates X
      ), claimed AS (
        UPDATE %1$I.site_auth_connections C
        SET
          maintenance_operation_id = P.operation_id,
          maintenance_action = CASE
            WHEN C.verification_state IN ('needs_repair', 'failed')
              AND (C.health_policy->>'automaticRepair')::boolean
              THEN 'repair'
            ELSE 'health_check'
          END,
          maintenance_due_at = C.next_check_at,
          maintenance_claimed_at = clock_timestamp(),
          maintenance_session_id = P.session_id,
          maintenance_started_at = NULL,
          version = C.version + 1,
          updated_by_subject_id = 'site-auth-maintenance',
          updated_at = clock_timestamp()
        FROM prepared P
        WHERE C.id = P.id
        RETURNING C.*
      ), revisions AS (
        INSERT INTO %1$I.workspace_interaction_revisions (
          workspace_id, account_id, revision, updated_at
        )
        SELECT DISTINCT C.workspace_id, C.account_id, 1, clock_timestamp()
        FROM claimed C
        ON CONFLICT (workspace_id) DO UPDATE
        SET revision = %1$I.workspace_interaction_revisions.revision + 1,
          updated_at = excluded.updated_at
        RETURNING workspace_id
      )
      SELECT
        C.maintenance_operation_id,
        C.maintenance_session_id,
        C.account_id,
        C.workspace_id,
        C.id,
        C.version,
        C.maintenance_action,
        C.maintenance_due_at,
        C.maintenance_claimed_at,
        C.name,
        C.account_label,
        C.login_url,
        C.verification_url_prefixes,
        C.preferred_identity_id,
        C.preferred_placement,
        C.preferred_network_route_id,
        C.health_policy,
        C.verification_state
      FROM claimed C;
    $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_site_auth_maintenance(bigint, integer)
  FROM PUBLIC;

DO $site_auth_maintenance_role_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_site_auth_maintenance(bigint, integer)
      TO opengeni_app;
  END IF;
END
$site_auth_maintenance_role_grants$;
