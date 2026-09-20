-- deployment-mode: maintenance
-- Add exact-turn source authorization without broadening ordinary workspace reads.
-- Stop every old/new API and worker process before applying this migration;
-- never restart a pre-0492 binary. Accepted turns survive through recovery.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE FUNCTION pg_temp.assert_codex_source_runtime_drain() RETURNS void
LANGUAGE plpgsql AS $drain$
DECLARE
  configured_roles_text text := nullif(current_setting('opengeni.migration_application_roles', true), '');
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION '0492 Codex source activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '0492 Codex source activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array' THEN
    RAISE EXCEPTION '0492 Codex source activation requires an application role array'
      USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) roles(value)
      WHERE jsonb_typeof(value) <> 'string' OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    ) OR (SELECT count(*) FROM jsonb_array_elements_text(configured_roles))
      <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(configured_roles) roles(value))
  THEN
    RAISE EXCEPTION '0492 Codex source activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name) ON roles.role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0492 Codex source activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$drain$;
SELECT pg_temp.assert_codex_source_runtime_drain();

-- Sidecar authority for turns accepted before their first source-bearing policy.
-- Source changes never edit conversation/turn metadata or session ordering.
CREATE TABLE codex_turn_source_bindings (
  turn_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('workspace', 'organization', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE codex_turn_source_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE codex_turn_source_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON codex_turn_source_bindings
  FOR SELECT USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON codex_turn_source_bindings FROM PUBLIC;

DO $accepted_codex_source$
DECLARE
  data_schema text := current_schema();
  definition text;
  patched text;
  role_name text;
BEGIN
  -- Even accidental runtime INSERT grants cannot forge a receipt. Only the
  -- migration-owner definer may insert; no role receives UPDATE/DELETE policies.
  EXECUTE format('CREATE POLICY capture_insert ON %I.codex_turn_source_bindings '
    'FOR INSERT WITH CHECK (current_user = %L AND '
    'opengeni_private.workspace_rls_visible(account_id, workspace_id))', data_schema, current_user);
  FOR role_name IN
    SELECT DISTINCT role_row.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE relation.oid = 'codex_turn_source_bindings'::regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON %I.codex_turn_source_bindings FROM %I', data_schema, role_name);
  END LOOP;
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.capture_legacy_codex_turn_sources(
      p_account_id uuid, p_workspace_id uuid
    ) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $function$
    DECLARE
      accepted_source text;
      previous_subject text := current_setting('opengeni.subject_id', true);
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN
        RAISE EXCEPTION 'Codex source capture requires the exact workspace scope'
          USING ERRCODE = '42501';
      END IF;
      -- Use the same lock as admission, allocation, and every source mutation.
      -- Callers cannot choose a source, turn, or subject, even on conflict.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'codex-subscription-source:' || p_workspace_id::text, 0));
      accepted_source := %1$I.resolve_workspace_codex_subscription_source(
        p_account_id, p_workspace_id);
      -- Only this fixed, content-free statement may see other actors' turns.
      -- Never substitute an arbitrary subject or expose session content.
      PERFORM set_config('opengeni.subject_id', '', true);
      INSERT INTO %1$I.codex_turn_source_bindings (turn_id, account_id, workspace_id, source)
      SELECT turn.id, turn.account_id, turn.workspace_id, accepted_source
      FROM %1$I.session_turns turn
      JOIN %1$I.sessions session ON session.id = turn.session_id
        AND session.account_id = turn.account_id AND session.workspace_id = turn.workspace_id
      WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
        AND turn.model LIKE 'codex/%%'
        AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
        AND turn.metadata #>> '{codexCredentialPolicySnapshotV1,source}' IS NULL
      ON CONFLICT (turn_id) DO NOTHING;
      PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
      RAISE;
    END
    $function$;
    REVOKE ALL ON FUNCTION %1$I.capture_legacy_codex_turn_sources(uuid,uuid) FROM PUBLIC;

    CREATE OR REPLACE FUNCTION opengeni_private.codex_credential_serves_turn(
      p_account_id uuid, p_workspace_id uuid, p_credential_id uuid, p_turn_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $function$
    DECLARE accepted_source text;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN RETURN false; END IF;
      SELECT coalesce(turn.metadata #>> '{codexCredentialPolicySnapshotV1,source}', binding.source)
        INTO accepted_source
      FROM session_turns turn
      JOIN sessions session ON session.id = turn.session_id
        AND session.workspace_id = turn.workspace_id AND session.account_id = turn.account_id
      LEFT JOIN codex_turn_source_bindings binding ON binding.turn_id = turn.id
        AND binding.account_id = turn.account_id AND binding.workspace_id = turn.workspace_id
      WHERE turn.id = p_turn_id AND turn.account_id = p_account_id
        AND turn.workspace_id = p_workspace_id
        AND turn.model LIKE 'codex/%%'
        AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity');
      IF NOT FOUND THEN RETURN false; END IF;
      -- Before the first cutover a legacy policy can still use current source.
      -- Every source mutation captures its pre-change authority in the sidecar.
      IF accepted_source IS NULL THEN
        RETURN opengeni_private.codex_credential_serves_workspace(
          p_account_id, p_workspace_id, p_credential_id);
      END IF;
      RETURN EXISTS (
        SELECT 1 FROM codex_subscription_credentials credential
        WHERE credential.id = p_credential_id AND credential.account_id = p_account_id
          AND (
            (accepted_source = 'workspace' AND credential.workspace_id = p_workspace_id
              AND credential.authority_scope IN ('workspace', 'user'))
            OR (accepted_source = 'organization' AND credential.organization_id = p_account_id
              AND credential.authority_scope = 'organization'
              AND opengeni_private.codex_organization_scope_visible(p_account_id))
          )
      );
    END
    $function$;
    REVOKE ALL ON FUNCTION opengeni_private.codex_credential_serves_turn(uuid,uuid,uuid,uuid) FROM PUBLIC;

    CREATE OR REPLACE FUNCTION opengeni_private.enforce_codex_lease_source()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $function$
    BEGIN
      IF NOT opengeni_private.codex_credential_serves_turn(
        NEW.account_id, NEW.workspace_id, NEW.credential_id, NEW.turn_id
      ) THEN
        RAISE EXCEPTION 'Codex credential is outside the accepted turn pool' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$;
  $ddl$, data_schema);

  -- Preserve the complete existing ownership and execution-time count guards.
  SELECT pg_get_functiondef('opengeni_private.codex_organization_live_lease_count(uuid,uuid,uuid)'::regprocedure)
    INTO definition;
  patched := replace(definition,
    E'OR NOT opengeni_private.codex_credential_serves_workspace(\n          p_account_id,\n          opengeni_private.current_workspace_id(),\n          p_credential_id\n        )',
    E'OR NOT (CASE WHEN p_exclude_turn_id IS NULL THEN\n          opengeni_private.codex_credential_serves_workspace(p_account_id, opengeni_private.current_workspace_id(), p_credential_id)\n        ELSE opengeni_private.codex_credential_serves_turn(p_account_id, opengeni_private.current_workspace_id(), p_credential_id, p_exclude_turn_id) END)');
  IF patched = definition THEN
    RAISE EXCEPTION '0492 organization lease count prerequisite drift';
  END IF;
  EXECUTE patched;
  -- Pin every authority lookup in this helper chain, including pre-0492
  -- definitions. An omitted pg_temp is implicitly searched before real tables.
  EXECUTE format('ALTER FUNCTION %I.resolve_workspace_codex_subscription_source(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema, data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.codex_credential_serves_workspace(uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.codex_organization_live_lease_count(uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.enforce_codex_credential_workspace() SET search_path = pg_catalog, %I, pg_temp', data_schema);

  SELECT pg_get_functiondef('opengeni_private.enforce_codex_credential_workspace()'::regprocedure)
    INTO definition;
  patched := replace(definition,
    E'IF NOT opengeni_private.codex_credential_serves_workspace(\n        NEW.account_id, NEW.workspace_id, candidate\n      ) THEN',
    E'IF NOT opengeni_private.codex_credential_serves_workspace(\n        NEW.account_id, NEW.workspace_id, candidate\n      ) AND NOT opengeni_private.codex_credential_serves_turn(\n        NEW.account_id, NEW.workspace_id, candidate, NEW.active_turn_id\n      ) THEN');
  IF patched = definition THEN
    RAISE EXCEPTION '0492 session credential guard prerequisite drift';
  END IF;
  EXECUTE patched;
  FOR role_name IN
    SELECT DISTINCT role_row.rolname FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
    JOIN pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE routine.oid = 'capture_legacy_codex_turn_sources(uuid,uuid)'::regprocedure
      AND privilege.grantee <> routine.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.capture_legacy_codex_turn_sources(uuid,uuid) FROM %I', data_schema, role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('REVOKE ALL ON %I.codex_turn_source_bindings FROM opengeni_app', data_schema);
    EXECUTE format('GRANT SELECT ON %I.codex_turn_source_bindings TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.capture_legacy_codex_turn_sources(uuid,uuid) TO opengeni_app', data_schema);
    GRANT EXECUTE ON FUNCTION opengeni_private.codex_credential_serves_turn(uuid,uuid,uuid,uuid) TO opengeni_app;
  END IF;
END
$accepted_codex_source$;

-- Retargeting an existing lease changes the accepted authority just as surely
-- as changing its credential; validate both paths at the database boundary.
DROP TRIGGER codex_credential_leases_source_guard ON codex_credential_leases;
CREATE TRIGGER codex_credential_leases_source_guard
BEFORE INSERT OR UPDATE OF account_id, workspace_id, credential_id, turn_id
ON codex_credential_leases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_lease_source();

SELECT pg_temp.assert_codex_source_runtime_drain();
DROP FUNCTION pg_temp.assert_codex_source_runtime_drain();

RESET statement_timeout;
RESET lock_timeout;