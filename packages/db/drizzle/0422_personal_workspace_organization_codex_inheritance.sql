-- deployment-mode: maintenance
-- Extend the existing organization Codex pool to same-organization Personal
-- workspaces. Workspace access remains independently authorized; this changes
-- only the effective provider pool, never session or workspace visibility.
-- Stop all old API and worker processes before activation. Old Codex mutation
-- callers omit Personal workspaces from source locks and capacity wakeups;
-- never restart a pre-0422 binary after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $personal_codex_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$personal_codex_runtime_drain_before$;


CREATE FUNCTION list_organization_codex_workspace_ids(p_account_id uuid)
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR opengeni_private.current_workspace_id() IS NOT NULL
  THEN
    RAISE EXCEPTION 'organization Codex workspace inventory authority required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  RETURN QUERY
  SELECT workspace.id
  FROM workspaces workspace
  WHERE workspace.account_id = p_account_id;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$body$;

REVOKE ALL ON FUNCTION list_organization_codex_workspace_ids(uuid) FROM PUBLIC;

DO $pin_codex_workspace_inventory$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_codex_workspace_ids(uuid) '
      'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$pin_codex_workspace_inventory$;

COMMENT ON FUNCTION list_organization_codex_workspace_ids(uuid) IS
  'Content-free same-organization workspace IDs, including Personal, for Codex source fences and capacity wakes only. Grants no workspace access.';

DO $codex_scope_visibility_schema$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_organization_scope_visible(
      p_account_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      workspace_value uuid := opengeni_private.current_workspace_id();
      subject_value text := opengeni_private.current_subject_id();
      visible boolean := false;
      previous_lifecycle text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
      THEN
        RETURN false;
      END IF;
      IF workspace_value IS NOT NULL THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true
        );
        SELECT EXISTS (
          SELECT 1 FROM %1$I.workspaces workspace
          WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
        ) INTO visible;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
        );
        RETURN coalesce(visible, false);
      END IF;
      IF subject_value IS NULL OR NOT (
        subject_value LIKE 'user:%%'
        OR (
          subject_value = 'dev'
          AND EXISTS (
            SELECT 1 FROM %1$I.managed_accounts account
            WHERE account.id = p_account_id
              AND account.external_source = 'opengeni:local'
              AND account.external_id = 'default'
          )
        )
      ) THEN
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true
      );
      SELECT EXISTS (
        SELECT 1 FROM %1$I.organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = subject_value
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
      ) INTO visible;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RETURN coalesce(visible, false);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RAISE;
    END
    $function$
  $ddl$, data_schema);
END
$codex_scope_visibility_schema$;

CREATE OR REPLACE FUNCTION resolve_workspace_codex_subscription_source(
  p_account_id uuid,
  p_workspace_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $body$
DECLARE
  mode_value text := 'automatic';
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'Codex workspace source authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT preference.mode INTO mode_value
  FROM workspace_codex_subscription_preferences preference
  WHERE preference.account_id = p_account_id
    AND preference.workspace_id = p_workspace_id;
  mode_value := coalesce(mode_value, 'automatic');
  IF mode_value <> 'automatic' THEN
    RETURN mode_value;
  END IF;
  IF EXISTS (
    SELECT 1 FROM codex_subscription_credentials credential
    WHERE credential.account_id = p_account_id
      AND credential.workspace_id = p_workspace_id
      AND credential.authority_scope IN ('workspace', 'user')
  ) THEN
    RETURN 'workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM codex_subscription_credentials credential
    WHERE credential.account_id = p_account_id
      AND credential.organization_id = p_account_id
      AND credential.authority_scope = 'organization'
  ) THEN
    RETURN 'organization';
  END IF;
  RETURN 'workspace';
END
$body$;

DO $codex_reference_guards$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_credential_serves_workspace(
      p_account_id uuid,
      p_workspace_id uuid,
      p_credential_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    DECLARE
      credential codex_subscription_credentials%%ROWTYPE;
      mode_value text := 'automatic';
      effective_source text;
    BEGIN
      SELECT * INTO credential
      FROM codex_subscription_credentials candidate
      WHERE candidate.account_id = p_account_id AND candidate.id = p_credential_id;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT preference.mode INTO mode_value
      FROM workspace_codex_subscription_preferences preference
      WHERE preference.account_id = p_account_id
        AND preference.workspace_id = p_workspace_id;
      mode_value := coalesce(mode_value, 'automatic');
      IF mode_value <> 'automatic' THEN
        effective_source := mode_value;
      ELSIF EXISTS (
        SELECT 1 FROM codex_subscription_credentials candidate
        WHERE candidate.account_id = p_account_id
          AND candidate.workspace_id = p_workspace_id
          AND candidate.authority_scope IN ('workspace', 'user')
      ) THEN
        effective_source := 'workspace';
      ELSIF EXISTS (
        SELECT 1 FROM codex_subscription_credentials candidate
        WHERE candidate.account_id = p_account_id
          AND candidate.organization_id = p_account_id
          AND candidate.authority_scope = 'organization'
      ) THEN
        effective_source := 'organization';
      ELSE
        effective_source := 'workspace';
      END IF;
      IF credential.authority_scope IN ('workspace', 'user') THEN
        RETURN credential.workspace_id = p_workspace_id
          AND effective_source = 'workspace';
      END IF;
      RETURN credential.authority_scope = 'organization'
        AND credential.organization_id = p_account_id
        AND effective_source = 'organization';
    END
    $function$;

  $ddl$, data_schema);
END
$codex_reference_guards$;

COMMENT ON TABLE workspace_codex_subscription_preferences IS
  'One effective Codex source per workspace, including Personal. Absent means automatic.';

DO $personal_codex_runtime_drain_after$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0422 Personal Codex activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$personal_codex_runtime_drain_after$;
