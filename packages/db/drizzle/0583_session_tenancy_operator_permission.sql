-- deployment-mode: rolling
-- Inert preparation: no activation, preference, session or default is changed.
-- Only the migration owner may enable the preference during the drained cutover.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_private_session_setting_events
  DROP CONSTRAINT organization_private_session_setting_events_actor_check,
  ADD CONSTRAINT organization_private_session_setting_events_actor_check CHECK (
    actor_membership_id IS NOT NULL OR
    (actor_subject_id IS NOT NULL AND (
      actor_subject_id LIKE 'api_key:%' OR
      actor_subject_id = 'service:session-tenancy-activation'
    ))
  );

CREATE FUNCTION enable_organization_private_sessions_from_activation(
  p_account_id uuid, p_application_roles text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $enable$
DECLARE
  previous_account text := current_setting('opengeni.account_id', true);
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  setting organization_private_session_settings%ROWTYPE;
  expected_version bigint;
  operation_id uuid;
BEGIN
  IF p_account_id IS NULL OR p_application_roles IS NULL
    OR cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
        OR NOT EXISTS (
          SELECT 1 FROM pg_roles role WHERE role.rolname = role_name
            AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolbypassrls
        )
    )
    OR cardinality(ARRAY(SELECT DISTINCT role_name FROM unnest(p_application_roles) role_name))
      <> cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy permission enablement request is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_stat_clear_snapshot();
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    WHERE activity.datname = current_database() AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy permission enablement requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  LOCK TABLE session_tenancy_activations, organization_private_session_settings,
    organization_private_session_setting_events IN ACCESS EXCLUSIVE MODE;
  PERFORM pg_stat_clear_snapshot();
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    WHERE activity.datname = current_database() AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy permission enablement requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('opengeni.account_id', p_account_id::text, true);
  PERFORM 1 FROM managed_accounts WHERE id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, 1) THEN
    RAISE EXCEPTION 'session tenancy product surface is not available for this organization' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_private_session_settings', true);
  SELECT * INTO setting FROM organization_private_session_settings WHERE account_id = p_account_id FOR UPDATE;
  IF coalesce(setting.enabled, false) THEN
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
    PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
    RETURN jsonb_build_object('organizationId', p_account_id, 'enabled', true,
      'version', setting.version, 'changed', false);
  END IF;
  expected_version := coalesce(setting.version, 0);
  operation_id := gen_random_uuid();
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (p_account_id, true, expected_version + 1, NULL, clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE SET enabled = true, version = excluded.version,
    updated_by_membership_id = NULL, updated_at = excluded.updated_at
  RETURNING * INTO setting;
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, actor_subject_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (operation_id, p_account_id, NULL, 'service:session-tenancy-activation', true,
    expected_version, true, setting.version, setting.updated_at, true);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
  RETURN jsonb_build_object('organizationId', p_account_id, 'enabled', true,
    'version', setting.version, 'changed', true, 'operationId', operation_id);
END $enable$;
REVOKE ALL ON FUNCTION enable_organization_private_sessions_from_activation(uuid,text[]) FROM PUBLIC;
DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION enable_organization_private_sessions_from_activation(uuid,text[]) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;
COMMENT ON FUNCTION enable_organization_private_sessions_from_activation(uuid,text[]) IS
  'Migration-owner-only drained permission enablement after a v1 activation receipt. Truthful service audit, idempotent when already enabled, no session visibility or default changes; never granted to application roles.';