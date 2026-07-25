-- deployment-mode: rolling
-- Authoritative admission boundary, denial evidence, policy lock/read, and RLS.
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
    CHECK ("current_depth" >= 0 AND "attempted_depth" >= 0
      AND "effective_max_nested_agent_depth" >= 0
      AND ("requested_max_nested_agent_depth_override" IS NULL
        OR "requested_max_nested_agent_depth_override" >= 0)),
  CONSTRAINT "session_spawn_denials_policy_source_check"
    CHECK ("policy_source" IN ('session', 'workspace', 'deployment', 'default')),
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

DO $lock_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I."lock_nested_agent_depth_configuration"()
    RETURNS TABLE ("max_nested_agent_depth" integer, "policy_source" text)
    LANGUAGE sql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
      SELECT "max_nested_agent_depth", "policy_source"
      FROM %I."nested_agent_depth_configuration"
      WHERE "singleton" FOR SHARE
    $body$
  $ddl$, target_schema, target_schema, target_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I."lock_nested_agent_depth_configuration"() FROM PUBLIC', target_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I."lock_nested_agent_depth_configuration"() TO opengeni_app', target_schema);
    EXECUTE format('GRANT SELECT, INSERT ON %I."session_spawn_denials" TO opengeni_app', target_schema);
  END IF;
END $lock_function$;

CREATE OR REPLACE FUNCTION opengeni_private.session_depth_policy_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  workspace_policy integer;
  workspace_has_policy boolean;
  workspace_account_id uuid;
  control_account_id uuid;
  deployment_policy integer;
  deployment_source text;
  parent_root uuid;
  parent_depth integer;
  parent_effective integer;
  parent_source text;
  parent_policy_session uuid;
  expected_root uuid;
  expected_depth bigint;
  expected_effective integer;
  expected_source text;
  expected_policy_session uuid;
BEGIN
  -- Keep direct/older writers on the same control-row -> workspace-row
  -- ordering as current application admission. This prevents a session from
  -- observing a workspace policy half-way through a narrowing update.
  EXECUTE format('SELECT account_id FROM %I.workspace_inference_controls '
      'WHERE workspace_id = $1 FOR SHARE', TG_TABLE_SCHEMA)
    INTO control_account_id USING NEW.workspace_id;
  IF control_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace has no mandatory inference-control row' USING ERRCODE = '23503';
  END IF;

  EXECUTE format('SELECT CASE WHEN jsonb_typeof(settings -> ''maxNestedAgentDepth'') = ''number''
      AND settings ->> ''maxNestedAgentDepth'' ~ ''^(0|[1-9][0-9]{0,9})$''
      AND (settings ->> ''maxNestedAgentDepth'')::numeric BETWEEN 0 AND 2147483647
      THEN (settings ->> ''maxNestedAgentDepth'')::integer ELSE NULL END,
      coalesce((jsonb_typeof(settings -> ''maxNestedAgentDepth'') = ''number''
       AND settings ->> ''maxNestedAgentDepth'' ~ ''^(0|[1-9][0-9]{0,9})$''
       AND (settings ->> ''maxNestedAgentDepth'')::numeric BETWEEN 0 AND 2147483647), false),
      account_id
      FROM %I.workspaces WHERE id = $1', TG_TABLE_SCHEMA)
    INTO workspace_policy, workspace_has_policy, workspace_account_id USING NEW.workspace_id;
  IF workspace_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace not found for session insert' USING ERRCODE = '23503';
  END IF;
  EXECUTE format('SELECT max_nested_agent_depth, policy_source FROM %I.lock_nested_agent_depth_configuration()', TG_TABLE_SCHEMA)
    INTO deployment_policy, deployment_source;
  IF deployment_policy IS NULL THEN
    RAISE EXCEPTION 'nested-agent deployment policy is not configured' USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_session_id IS NULL THEN
    expected_root := NEW.id;
    expected_depth := 0;
  ELSE
    EXECUTE format('SELECT root_session_id, nested_agent_depth, effective_max_nested_agent_depth,
        nested_agent_depth_policy_source, nested_agent_depth_policy_session_id
        FROM %I.sessions WHERE workspace_id = $1 AND id = $2 FOR SHARE', TG_TABLE_SCHEMA)
      INTO parent_root, parent_depth, parent_effective, parent_source, parent_policy_session
      USING NEW.workspace_id, NEW.parent_session_id;
    IF parent_root IS NULL OR parent_depth IS NULL THEN
      RAISE EXCEPTION 'parent session not found for nested insert' USING ERRCODE = '23503';
    END IF;
    expected_root := parent_root;
    expected_depth := parent_depth + 1;
  END IF;

  IF NEW.max_nested_agent_depth_override IS NOT NULL THEN
    expected_effective := NEW.max_nested_agent_depth_override;
    expected_source := 'session';
    expected_policy_session := NEW.id;
  ELSIF NEW.parent_session_id IS NOT NULL AND parent_source = 'session' THEN
    expected_effective := parent_effective;
    expected_source := 'session';
    expected_policy_session := parent_policy_session;
  ELSIF workspace_has_policy THEN
    expected_effective := workspace_policy;
    expected_source := 'workspace';
    expected_policy_session := NULL;
  ELSE
    expected_effective := deployment_policy;
    expected_source := deployment_source;
    expected_policy_session := NULL;
  END IF;

  IF expected_depth > expected_effective THEN
    RAISE EXCEPTION 'nested agent depth exceeds effective maximum' USING ERRCODE = '23514';
  END IF;
  NEW.root_session_id := expected_root;
  NEW.nested_agent_depth := expected_depth;
  NEW.effective_max_nested_agent_depth := expected_effective;
  NEW.nested_agent_depth_policy_source := expected_source;
  NEW.nested_agent_depth_policy_session_id := expected_policy_session;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.session_spawn_denials_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  workspace_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Workspace/account deletion is intentionally allowed to cascade through
    -- evidence rows. A direct row delete while its workspace still exists is
    -- never allowed, preserving append-only audit evidence for live tenants.
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    -- The FK cascade removes the parent workspace before its child rows are
    -- deleted. Resolve the target schema dynamically because embedded hosts
    -- run the same migration chain outside public.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.workspaces WHERE id = $1)', TG_TABLE_SCHEMA)
      INTO workspace_exists
      USING OLD.workspace_id;
    IF NOT workspace_exists THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'session spawn denial evidence is append-only' USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  control_account_id uuid;
BEGIN
  IF OLD.settings -> 'maxNestedAgentDepth'
       IS NOT DISTINCT FROM NEW.settings -> 'maxNestedAgentDepth' THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT account_id FROM %I.workspace_inference_controls '
      'WHERE workspace_id = $1 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO control_account_id USING NEW.id;
  IF control_account_id IS NULL THEN
    RAISE EXCEPTION 'workspace has no mandatory inference-control row' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$function$;

DO $triggers$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS session_depth_policy_defaults ON %I.sessions', target_schema);
  EXECUTE format('CREATE TRIGGER session_depth_policy_defaults BEFORE INSERT ON %I.sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_depth_policy_defaults()', target_schema);
  EXECUTE format('DROP TRIGGER IF EXISTS session_spawn_denials_append_only ON %I.session_spawn_denials', target_schema);
  EXECUTE format('CREATE TRIGGER session_spawn_denials_append_only BEFORE UPDATE OR DELETE ON %I.session_spawn_denials FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_spawn_denials_append_only()', target_schema);
  EXECUTE format('DROP TRIGGER IF EXISTS lock_nested_agent_workspace_policy_update ON %I.workspaces', target_schema);
  EXECUTE format('CREATE TRIGGER lock_nested_agent_workspace_policy_update BEFORE UPDATE OF settings ON %I.workspaces FOR EACH ROW EXECUTE FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update()', target_schema);
END $triggers$;

ALTER TABLE "session_spawn_denials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_spawn_denials" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_spawn_denials"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

RESET statement_timeout;
RESET lock_timeout;
