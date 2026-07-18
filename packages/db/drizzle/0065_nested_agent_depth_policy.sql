-- deployment-mode: rolling
-- OPE-53: persist the session hierarchy depth and creation-time nested-agent
-- policy, and make denied spawns first-class idempotent audit outcomes.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

-- Expand first. New binaries supply every value. The temporary nullable shape
-- lets the recursive legacy backfill complete without a table rewrite.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "root_session_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nested_agent_depth" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "max_nested_agent_depth_override" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "effective_max_nested_agent_depth" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_source" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_session_id" uuid;

-- Legacy rows have no deployment snapshot. Backfill from the workspace setting
-- visible at migration time, then the product default. Existing rows deeper
-- than that limit remain valid: enforcement applies only to future inserts.
WITH RECURSIVE lineage AS (
  SELECT s."workspace_id", s."id", s."parent_session_id",
         s."id" AS "root_session_id", 0 AS "nested_agent_depth"
  FROM "sessions" s
  WHERE s."parent_session_id" IS NULL
  UNION ALL
  SELECT child."workspace_id", child."id", child."parent_session_id",
         lineage."root_session_id", lineage."nested_agent_depth" + 1
  FROM lineage
  JOIN "sessions" child
    ON child."workspace_id" = lineage."workspace_id"
   AND child."parent_session_id" = lineage."id"
), workspace_policy AS (
  SELECT
    w."id" AS "workspace_id",
    CASE
      WHEN jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
       AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
      THEN (w."settings" ->> 'maxNestedAgentDepth')::integer
      ELSE 3
    END AS "effective_max_nested_agent_depth",
    CASE
      WHEN jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
       AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
      THEN 'workspace'
      ELSE 'default'
    END AS "nested_agent_depth_policy_source"
  FROM "workspaces" w
)
UPDATE "sessions" s
SET "root_session_id" = lineage."root_session_id",
    "nested_agent_depth" = lineage."nested_agent_depth",
    "max_nested_agent_depth_override" = NULL,
    "effective_max_nested_agent_depth" = workspace_policy."effective_max_nested_agent_depth",
    "nested_agent_depth_policy_source" = workspace_policy."nested_agent_depth_policy_source",
    "nested_agent_depth_policy_session_id" = NULL
FROM lineage
JOIN workspace_policy ON workspace_policy."workspace_id" = lineage."workspace_id"
WHERE s."workspace_id" = lineage."workspace_id"
  AND s."id" = lineage."id";

-- NOT VALID + VALIDATE performs the large scans without holding the stronger
-- ALTER lock. PostgreSQL can then prove SET NOT NULL from the validated checks.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_root_session_not_null"
  CHECK ("root_session_id" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_not_null"
  CHECK ("nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_effective_nested_agent_depth_not_null"
  CHECK ("effective_max_nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_not_null"
  CHECK ("nested_agent_depth_policy_source" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_root_session_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_depth_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_effective_nested_agent_depth_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_source_not_null";

ALTER TABLE "sessions"
  ALTER COLUMN "root_session_id" SET NOT NULL,
  ALTER COLUMN "nested_agent_depth" SET NOT NULL,
  ALTER COLUMN "effective_max_nested_agent_depth" SET NOT NULL,
  ALTER COLUMN "nested_agent_depth_policy_source" SET NOT NULL;

ALTER TABLE "sessions" DROP CONSTRAINT "sessions_root_session_not_null";
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_nested_agent_depth_not_null";
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_effective_nested_agent_depth_not_null";
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_nested_agent_policy_source_not_null";

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_check"
  CHECK (
    "nested_agent_depth" >= 0
    AND "effective_max_nested_agent_depth" >= 0
    AND ("max_nested_agent_depth_override" IS NULL
      OR "max_nested_agent_depth_override" >= 0)
  ) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_check"
  CHECK ("nested_agent_depth_policy_source" IN ('session', 'workspace', 'deployment', 'default'))
  NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_session_check"
  CHECK (
    ("nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" IS NOT NULL)
    OR ("nested_agent_depth_policy_source" <> 'session'
      AND "nested_agent_depth_policy_session_id" IS NULL
      AND "max_nested_agent_depth_override" IS NULL)
  ) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_override_check"
  CHECK (
    "max_nested_agent_depth_override" IS NULL
    OR (
      "nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" = "id"
      AND "effective_max_nested_agent_depth" = "max_nested_agent_depth_override"
    )
  ) NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_depth_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_source_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_session_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_override_check";

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_root_session_fk"
  FOREIGN KEY ("workspace_id", "root_session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_policy_session_fk"
  FOREIGN KEY ("workspace_id", "nested_agent_depth_policy_session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_root_session_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_policy_session_fk";

CREATE INDEX IF NOT EXISTS "sessions_workspace_root_depth_idx"
  ON "sessions" ("workspace_id", "root_session_id", "nested_agent_depth");

CREATE TABLE "session_spawn_denials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "parent_session_id" uuid,
  "root_session_id" uuid,
  "current_depth" integer NOT NULL,
  -- A parent may physically be at int-max, making the rejected attempt
  -- int-max+1. bigint keeps the denial path fail-safe at that edge.
  "attempted_depth" bigint NOT NULL,
  "effective_max_nested_agent_depth" integer NOT NULL,
  "requested_max_nested_agent_depth_override" integer,
  "policy_source" text NOT NULL,
  "policy_session_id" uuid,
  "subject_id" text,
  "code" text NOT NULL,
  "idempotency_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_spawn_denials_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_spawn_denials_depth_check"
    CHECK (
      "current_depth" >= 0
      AND "attempted_depth" >= 0
      AND "effective_max_nested_agent_depth" >= 0
      AND ("requested_max_nested_agent_depth_override" IS NULL
        OR "requested_max_nested_agent_depth_override" >= 0)
    ),
  CONSTRAINT "session_spawn_denials_policy_source_check"
    CHECK ("policy_source" IN ('session', 'workspace', 'deployment', 'default')),
  CONSTRAINT "session_spawn_denials_policy_session_check"
    CHECK (
      ("policy_source" = 'session' AND (
        "policy_session_id" IS NOT NULL
        OR (
          "code" = 'nested_agent_depth_exceeded'
          AND "requested_max_nested_agent_depth_override" IS NOT NULL
        )
      ))
      OR ("policy_source" <> 'session' AND "policy_session_id" IS NULL)
    ),
  CONSTRAINT "session_spawn_denials_code_check"
    CHECK ("code" IN ('nested_agent_depth_exceeded', 'nested_agent_depth_override_forbidden'))
);

CREATE UNIQUE INDEX "session_spawn_denials_workspace_id_uq"
  ON "session_spawn_denials" ("workspace_id", "id");
CREATE INDEX "session_spawn_denials_workspace_created_idx"
  ON "session_spawn_denials" ("workspace_id", "created_at");
CREATE INDEX "session_spawn_denials_parent_idx"
  ON "session_spawn_denials" ("workspace_id", "parent_session_id", "created_at");
CREATE UNIQUE INDEX "session_spawn_denials_workspace_idempotency_idx"
  ON "session_spawn_denials" ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Both outcome tables take the same transaction-scoped key lock. This closes
-- the cross-table race even while an old binary still inserts sessions without
-- first consulting session_spawn_denials.
CREATE OR REPLACE FUNCTION opengeni_private.session_create_idempotency_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  create_key text;
  opposite_exists boolean;
BEGIN
  -- A trigger function is compiled against each relation it is attached to;
  -- direct NEW."idempotency_key"/NEW."create_idempotency_key" references make
  -- the function invalid for the other relation. JSON projection keeps the
  -- function valid for both outcome tables and still avoids dynamic SQL here.
  create_key := to_jsonb(NEW) ->> CASE
    WHEN TG_TABLE_NAME = 'sessions' THEN 'create_idempotency_key'
    ELSE 'idempotency_key'
  END;
  IF create_key IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('session-create:' || (to_jsonb(NEW) ->> 'workspace_id') || ':' || create_key)
  );
  IF TG_TABLE_NAME = 'sessions' THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."session_spawn_denials" '
        'WHERE "workspace_id" = $1 AND "idempotency_key" = $2)',
      TG_TABLE_SCHEMA
    ) INTO opposite_exists USING (to_jsonb(NEW) ->> 'workspace_id')::uuid, create_key;
  ELSE
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."sessions" '
        'WHERE "workspace_id" = $1 AND "create_idempotency_key" = $2)',
      TG_TABLE_SCHEMA
    ) INTO opposite_exists USING (to_jsonb(NEW) ->> 'workspace_id')::uuid, create_key;
  END IF;
  IF opposite_exists THEN
    RAISE EXCEPTION 'session create idempotency key already has an opposite outcome'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$;

-- Denial evidence is append-only even if a later role-provisioning pass grants
-- broader table privileges. Privilege minimization below remains defense in
-- depth; this trigger is the authoritative mutation guard.
CREATE OR REPLACE FUNCTION opengeni_private.session_spawn_denials_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'session spawn denial evidence is append-only' USING ERRCODE = '55000';
END
$function$;

-- Validate/fill hierarchy for new binaries and fail closed for nested inserts
-- from old binaries during rolling deployment. Deployment policy is not stored
-- in PostgreSQL, so an old binary cannot safely infer it; refusing its nested
-- insert is safer than silently allowing an over-depth child.
CREATE OR REPLACE FUNCTION opengeni_private.session_depth_policy_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  parent_row record;
  configured integer;
  workspace_configured boolean;
  expected_root uuid;
  expected_depth integer;
  expected_effective integer;
  expected_source text;
  expected_policy_session_id uuid;
BEGIN
  IF NEW."parent_session_id" IS NULL THEN
    expected_root := NEW."id";
    expected_depth := 0;

    IF NEW."max_nested_agent_depth_override" IS NOT NULL THEN
      expected_effective := NEW."max_nested_agent_depth_override";
      expected_source := 'session';
      expected_policy_session_id := NEW."id";
    ELSIF NEW."effective_max_nested_agent_depth" IS NOT NULL
       AND NEW."nested_agent_depth_policy_source" IS NOT NULL THEN
      expected_effective := NEW."effective_max_nested_agent_depth";
      expected_source := NEW."nested_agent_depth_policy_source";
      expected_policy_session_id := NEW."nested_agent_depth_policy_session_id";
    ELSE
      EXECUTE format($workspace_query$
        SELECT
          CASE
            WHEN jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
             AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
             AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
            THEN (w."settings" ->> 'maxNestedAgentDepth')::integer
            ELSE 3
          END,
          jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
            AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
            AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
        FROM %I."workspaces" w WHERE w."id" = $1
      $workspace_query$, TG_TABLE_SCHEMA)
      INTO configured, workspace_configured USING NEW."workspace_id";
      expected_effective := coalesce(configured, 3);
      expected_source := CASE
        WHEN coalesce(workspace_configured, false) THEN 'workspace' ELSE 'default'
      END;
      expected_policy_session_id := NULL;
    END IF;
  ELSE
    EXECUTE format($parent_query$
      SELECT s."root_session_id", s."nested_agent_depth",
             s."effective_max_nested_agent_depth",
             s."nested_agent_depth_policy_source",
             s."nested_agent_depth_policy_session_id"
      FROM %I."sessions" s
      WHERE s."workspace_id" = $1 AND s."id" = $2
      FOR SHARE
    $parent_query$, TG_TABLE_SCHEMA)
    INTO parent_row USING NEW."workspace_id", NEW."parent_session_id";
    IF parent_row IS NULL THEN
      RAISE EXCEPTION 'parent session not found for nested insert' USING ERRCODE = '23503';
    END IF;

    -- Old binaries supply none of the 0065 columns. Do not infer a deployment
    -- policy that exists only in the new process configuration.
    IF NEW."root_session_id" IS NULL
       AND NEW."nested_agent_depth" IS NULL
       AND NEW."effective_max_nested_agent_depth" IS NULL
       AND NEW."nested_agent_depth_policy_source" IS NULL
       AND NEW."max_nested_agent_depth_override" IS NULL THEN
      RAISE EXCEPTION 'nested session insert requires a depth-policy-aware creator'
        USING ERRCODE = '23514';
    END IF;

    expected_root := parent_row."root_session_id";
    expected_depth := parent_row."nested_agent_depth" + 1;
    IF NEW."max_nested_agent_depth_override" IS NOT NULL THEN
      expected_effective := NEW."max_nested_agent_depth_override";
      expected_source := 'session';
      expected_policy_session_id := NEW."id";
    ELSIF parent_row."nested_agent_depth_policy_source" = 'session' THEN
      expected_effective := parent_row."effective_max_nested_agent_depth";
      expected_source := 'session';
      expected_policy_session_id := parent_row."nested_agent_depth_policy_session_id";
    ELSE
      EXECUTE format($workspace_query$
        SELECT
          CASE
            WHEN jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
             AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
             AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
            THEN (w."settings" ->> 'maxNestedAgentDepth')::integer
            ELSE NULL
          END,
          jsonb_typeof(w."settings" -> 'maxNestedAgentDepth') = 'number'
            AND w."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
            AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647
        FROM %I."workspaces" w WHERE w."id" = $1
      $workspace_query$, TG_TABLE_SCHEMA)
      INTO configured, workspace_configured USING NEW."workspace_id";
      IF coalesce(workspace_configured, false) THEN
        expected_effective := configured;
        expected_source := 'workspace';
      ELSIF NEW."nested_agent_depth_policy_source" = 'deployment'
         AND NEW."effective_max_nested_agent_depth" IS NOT NULL THEN
        expected_effective := NEW."effective_max_nested_agent_depth";
        expected_source := 'deployment';
      ELSE
        expected_effective := 3;
        expected_source := 'default';
      END IF;
      expected_policy_session_id := NULL;
    END IF;
  END IF;

  IF NEW."root_session_id" IS NOT NULL AND NEW."root_session_id" <> expected_root THEN
    RAISE EXCEPTION 'nested session root lineage mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."nested_agent_depth" IS NOT NULL AND NEW."nested_agent_depth" <> expected_depth THEN
    RAISE EXCEPTION 'nested session depth mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."effective_max_nested_agent_depth" IS NOT NULL
     AND NEW."effective_max_nested_agent_depth" <> expected_effective THEN
    RAISE EXCEPTION 'nested session effective policy mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."nested_agent_depth_policy_source" IS NOT NULL
     AND NEW."nested_agent_depth_policy_source" <> expected_source THEN
    RAISE EXCEPTION 'nested session policy source mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."nested_agent_depth_policy_session_id" IS DISTINCT FROM expected_policy_session_id THEN
    RAISE EXCEPTION 'nested session policy source session mismatch' USING ERRCODE = '23514';
  END IF;
  IF expected_depth > expected_effective THEN
    RAISE EXCEPTION 'nested agent depth exceeds effective maximum' USING ERRCODE = '23514';
  END IF;

  NEW."root_session_id" := expected_root;
  NEW."nested_agent_depth" := expected_depth;
  NEW."effective_max_nested_agent_depth" := expected_effective;
  NEW."nested_agent_depth_policy_source" := expected_source;
  NEW."nested_agent_depth_policy_session_id" := expected_policy_session_id;
  RETURN NEW;
END
$function$;

DO $session_triggers$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_create_idempotency_guard ON %I."sessions"', target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_create_idempotency_guard BEFORE INSERT ON %I."sessions" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_create_idempotency_guard()',
    target_schema
  );
  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_depth_policy_defaults ON %I."sessions"', target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_depth_policy_defaults BEFORE INSERT ON %I."sessions" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_depth_policy_defaults()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_create_idempotency_guard BEFORE INSERT ON %I."session_spawn_denials" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_create_idempotency_guard()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_spawn_denials_append_only '
      'BEFORE UPDATE OR DELETE ON %I."session_spawn_denials" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_spawn_denials_append_only()',
    target_schema
  );
END $session_triggers$;

ALTER TABLE "session_spawn_denials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_spawn_denials" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_spawn_denials"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $denial_grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON %I."session_spawn_denials" FROM opengeni_app', target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON %I."session_spawn_denials" TO opengeni_app', target_schema
    );
  END IF;
END $denial_grants$;

RESET statement_timeout;
RESET lock_timeout;