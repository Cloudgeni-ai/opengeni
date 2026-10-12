-- deployment-mode: maintenance
-- Remove protected-fill site authentication. Agents now log in by typing
-- {{secret:...}} references into ordinary browser fill and type actions, so
-- the `connection_fields` and `human` site-auth authorities, the
-- `awaiting_secret` auth-run state, its `pending_fields` column and the
-- `protected_fill` operation kind go away. Only provider-managed
-- (`external_provider`) site-auth connections survive.
--
-- A connection survives only when every configured authority is
-- `external_provider`. Every other connection is deleted with its auth runs,
-- the interventions linked to those runs, and their operation journal rows.
-- Auth runs still waiting for a secret on a surviving connection are deleted
-- the same way. Old releases still write the removed state and kind, so stop
-- every API and worker before applying this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The deletes read and write across tenants. Each table below is FORCE row
-- security, so lift it for the owner within this transaction and restore it
-- after the deletes. No advisory fence is taken.
ALTER TABLE "site_auth_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_interventions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_resource_operations" NO FORCE ROW LEVEL SECURITY;

WITH removed_connections AS (
  SELECT connection."workspace_id", connection."id"
  FROM "site_auth_connections" AS connection
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  )
),
removed_runs AS (
  SELECT run."workspace_id", run."id"
  FROM "auth_runs" AS run
  WHERE run."state" = 'awaiting_secret'
    OR ("workspace_id", "site_auth_connection_id") IN (SELECT * FROM removed_connections)
),
removed_interventions AS (
  SELECT intervention."workspace_id", intervention."id"
  FROM "interaction_interventions" AS intervention
  WHERE ("workspace_id", "auth_run_id") IN (SELECT * FROM removed_runs)
)
DELETE FROM "interaction_resource_operations" AS operation
WHERE operation."kind" = 'protected_fill'
  OR (
    operation."resource_kind" = 'site_auth_connection'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_connections)
  )
  OR (
    operation."resource_kind" = 'auth_run'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_runs)
  )
  OR (
    operation."resource_kind" = 'intervention'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_interventions)
  );

-- auth_runs.intervention_id and interaction_interventions.auth_run_id both
-- SET NULL on delete, so interventions go first while their runs still exist.
WITH removed_connections AS (
  SELECT connection."workspace_id", connection."id"
  FROM "site_auth_connections" AS connection
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  )
),
removed_runs AS (
  SELECT run."workspace_id", run."id"
  FROM "auth_runs" AS run
  WHERE run."state" = 'awaiting_secret'
    OR ("workspace_id", "site_auth_connection_id") IN (SELECT * FROM removed_connections)
)
DELETE FROM "interaction_interventions" AS intervention
WHERE (intervention."workspace_id", intervention."auth_run_id") IN (SELECT * FROM removed_runs);

DELETE FROM "auth_runs" AS run
WHERE run."state" = 'awaiting_secret'
  OR EXISTS (
    SELECT 1
    FROM "site_auth_connections" AS connection,
      jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE connection."workspace_id" = run."workspace_id"
      AND connection."id" = run."site_auth_connection_id"
      AND authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  );

DELETE FROM "site_auth_connections" AS connection
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(connection."authorities") AS authority(value)
  WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
);

ALTER TABLE "site_auth_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_interventions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_resource_operations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "auth_runs"
  DROP CONSTRAINT "auth_runs_state_check",
  DROP CONSTRAINT "auth_runs_values_check",
  DROP CONSTRAINT "auth_runs_projection_check";

ALTER TABLE "auth_runs" DROP COLUMN "pending_fields";

ALTER TABLE "auth_runs"
  ADD CONSTRAINT "auth_runs_state_check" CHECK (
    "state" IN (
      'discovering', 'awaiting_choice', 'awaiting_external_action',
      'working', 'verified', 'failed', 'cancelled'
    )
  ),
  ADD CONSTRAINT "auth_runs_values_check" CHECK (
    octet_length("target_id") BETWEEN 1 AND 512
    AND octet_length("controller_generation") BETWEEN 1 AND 256
    AND octet_length("target_generation") BETWEEN 1 AND 256
    AND ("document_generation" IS NULL OR octet_length("document_generation") BETWEEN 1 AND 256)
    AND ("method_id" IS NULL OR octet_length("method_id") BETWEEN 1 AND 512)
    AND ("authority_id" IS NULL OR octet_length("authority_id") BETWEEN 1 AND 512)
    AND jsonb_typeof("choices") = 'array'
    AND octet_length("choices"::text) BETWEEN 2 AND 65536
    AND ("external_action" IS NULL OR (
      jsonb_typeof("external_action") = 'object'
      AND octet_length("external_action"::text) BETWEEN 2 AND 65536
    ))
    AND ("verified_url" IS NULL OR octet_length("verified_url") BETWEEN 1 AND 16384)
    AND ("failure_code" IS NULL OR octet_length("failure_code") BETWEEN 1 AND 512)
    AND "version" > 0
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
  ),
  ADD CONSTRAINT "auth_runs_projection_check" CHECK (
    ("state" = 'awaiting_choice') = (jsonb_array_length("choices") > 0)
    AND ("state" = 'awaiting_external_action') = ("external_action" IS NOT NULL)
    AND ("state" = 'failed') = ("failure_code" IS NOT NULL)
  );

ALTER TABLE "interaction_resource_operations"
  DROP CONSTRAINT "interaction_resource_operations_kind_check";

ALTER TABLE "interaction_resource_operations"
  ADD CONSTRAINT "interaction_resource_operations_kind_check"
  CHECK ("kind" IN (
    'create',
    'update',
    'start',
    'report',
    'external_auth',
    'verify',
    'resolve',
    'save'
  ));
