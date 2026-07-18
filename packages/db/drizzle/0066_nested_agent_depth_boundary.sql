-- deployment-mode: rolling
-- OPE-53 mixed-version boundary: old binaries may omit every new column; this
-- trigger derives and enforces their canonical lineage/policy. New binaries are
-- independently validated against the same persisted server-owned state.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "session_spawn_denials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "parent_session_id" uuid,
  "root_session_id" uuid,
  "current_depth" integer NOT NULL,
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

-- Success and denial outcomes share one transaction-scoped key lock, including
-- old-binary inserts that do not consult session_spawn_denials themselves.
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

-- Evidence remains append-only for every direct mutation. A workspace FK
-- cascade is the sole exception: after the parent row is deleted in the same
-- statement it is no longer visible, so retaining the child is impossible and
-- must not roll back legitimate workspace cleanup after external schedules end.
CREATE OR REPLACE FUNCTION opengeni_private.session_spawn_denials_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  workspace_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."workspaces" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    ) INTO workspace_exists USING OLD."workspace_id";
    IF NOT workspace_exists THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'session spawn denial evidence is append-only' USING ERRCODE = '55000';
END
$function$;

-- All settings writers, including an old binary unaware of OPE-53, serialize
-- maxNestedAgentDepth changes through the same mandatory row that creates hold
-- FOR SHARE. This trigger establishes workspace-row -> control-row ordering for
-- settings writes; application code must not pre-lock the control row first.
CREATE OR REPLACE FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  control_account_id uuid;
BEGIN
  IF OLD."settings" -> 'maxNestedAgentDepth'
       IS NOT DISTINCT FROM NEW."settings" -> 'maxNestedAgentDepth' THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT "account_id" FROM %I."workspace_inference_controls" '
      'WHERE "workspace_id" = $1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO control_account_id USING NEW."id";
  IF control_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace has no mandatory inference-control row'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.session_depth_policy_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  control_account_id uuid;
  workspace_account_id uuid;
  parent_found_id uuid;
  parent_root_session_id uuid;
  parent_nested_agent_depth integer;
  parent_effective_max integer;
  parent_policy_source text;
  parent_policy_session_id uuid;
  workspace_configured integer;
  workspace_has_policy boolean;
  deployment_configured integer;
  deployment_source text;
  expected_root uuid;
  expected_depth integer;
  expected_effective integer;
  expected_source text;
  expected_policy_session_id uuid;
BEGIN
  -- Serialize old and new inserts with workspace policy changes.
  EXECUTE format(
    'SELECT "account_id" FROM %I."workspace_inference_controls" '
      'WHERE "workspace_id" = $1 FOR SHARE',
    TG_TABLE_SCHEMA
  ) INTO control_account_id USING NEW."workspace_id";
  IF control_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace has no mandatory inference-control row'
      USING ERRCODE = '23503';
  END IF;

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
        AND (w."settings" ->> 'maxNestedAgentDepth')::numeric BETWEEN 0 AND 2147483647,
      w."account_id"
    FROM %I."workspaces" w WHERE w."id" = $1
  $workspace_query$, TG_TABLE_SCHEMA)
  INTO workspace_configured, workspace_has_policy, workspace_account_id
  USING NEW."workspace_id";
  IF workspace_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace not found for session insert' USING ERRCODE = '23503';
  END IF;

  EXECUTE format(
    'SELECT "max_nested_agent_depth", "policy_source" '
      'FROM %I."nested_agent_depth_configuration" '
      'WHERE "singleton" FOR SHARE',
    TG_TABLE_SCHEMA
  ) INTO deployment_configured, deployment_source;
  IF deployment_configured IS NULL THEN
    RAISE EXCEPTION 'nested-agent deployment policy is not configured'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."parent_session_id" IS NULL THEN
    expected_root := NEW."id";
    expected_depth := 0;
  ELSE
    EXECUTE format($parent_query$
      SELECT s."id", s."root_session_id", s."nested_agent_depth",
             s."effective_max_nested_agent_depth",
             s."nested_agent_depth_policy_source",
             s."nested_agent_depth_policy_session_id"
      FROM %I."sessions" s
      WHERE s."workspace_id" = $1 AND s."id" = $2
      FOR SHARE
    $parent_query$, TG_TABLE_SCHEMA)
    INTO parent_found_id, parent_root_session_id, parent_nested_agent_depth,
         parent_effective_max, parent_policy_source, parent_policy_session_id
    USING NEW."workspace_id", NEW."parent_session_id";
    IF parent_found_id IS NULL THEN
      RAISE EXCEPTION 'parent session not found for nested insert' USING ERRCODE = '23503';
    END IF;

    IF parent_root_session_id IS NULL OR parent_nested_agent_depth IS NULL THEN
      -- A legacy parent may not yet have reached its bounded backfill batch.
      EXECUTE format($legacy_lineage$
        WITH RECURSIVE ancestry AS (
          SELECT s."id", s."parent_session_id", 0::integer AS depth
          FROM %I."sessions" s
          WHERE s."workspace_id" = $1 AND s."id" = $2
          UNION ALL
          SELECT parent."id", parent."parent_session_id", ancestry.depth + 1
          FROM ancestry
          JOIN %I."sessions" parent
            ON parent."workspace_id" = $1
           AND parent."id" = ancestry."parent_session_id"
          WHERE ancestry.depth < 2147483646
        )
        SELECT "id", depth FROM ancestry
        WHERE "parent_session_id" IS NULL
        ORDER BY depth DESC LIMIT 1
      $legacy_lineage$, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
      INTO expected_root, expected_depth USING NEW."workspace_id", NEW."parent_session_id";
      IF expected_root IS NULL THEN
        RAISE EXCEPTION 'legacy parent lineage is incomplete' USING ERRCODE = '23514';
      END IF;
      expected_depth := expected_depth + 1;
    ELSE
      expected_root := parent_root_session_id;
      expected_depth := parent_nested_agent_depth + 1;
    END IF;
  END IF;

  IF NEW."max_nested_agent_depth_override" IS NOT NULL THEN
    expected_effective := NEW."max_nested_agent_depth_override";
    expected_source := 'session';
    expected_policy_session_id := NEW."id";
  ELSIF NEW."parent_session_id" IS NOT NULL
     AND parent_policy_source = 'session' THEN
    expected_effective := parent_effective_max;
    expected_source := 'session';
    expected_policy_session_id := parent_policy_session_id;
  ELSIF coalesce(workspace_has_policy, false) THEN
    expected_effective := workspace_configured;
    expected_source := 'workspace';
    expected_policy_session_id := NULL;
  ELSE
    expected_effective := deployment_configured;
    expected_source := deployment_source;
    expected_policy_session_id := NULL;
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
    'DROP TRIGGER IF EXISTS session_create_idempotency_guard ON %I."session_spawn_denials"',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_create_idempotency_guard '
      'BEFORE INSERT ON %I."session_spawn_denials" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_create_idempotency_guard()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_spawn_denials_append_only '
      'BEFORE UPDATE OR DELETE ON %I."session_spawn_denials" '
      'FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_spawn_denials_append_only()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER lock_nested_agent_workspace_policy_update '
      'BEFORE UPDATE OF "settings" ON %I."workspaces" '
      'FOR EACH ROW EXECUTE FUNCTION '
      'opengeni_private.lock_nested_agent_workspace_policy_update()',
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