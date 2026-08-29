-- deployment-mode: rolling
-- Account-scoped organization API keys need one complete shared-workspace
-- inventory without direct runtime access to organization membership rows.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION list_organization_workspace_ids(p_account_id uuid)
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
    RAISE EXCEPTION 'organization workspace inventory authority required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  RETURN QUERY
  SELECT workspace.id
  FROM workspaces workspace
  WHERE workspace.account_id = p_account_id
    AND NOT EXISTS (
      SELECT 1
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.personal_workspace_id = workspace.id
    );

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

REVOKE ALL ON FUNCTION list_organization_workspace_ids(uuid) FROM PUBLIC;

DO $pin_and_grant_organization_workspace_inventory$
DECLARE
  data_schema text := current_schema();
  application_role text;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_workspace_ids(uuid) '
      'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );

  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(
        nullif(current_setting('opengeni.migration_application_roles', true), ''),
        '[]'
      )::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value
      ON role_value.rolname = configured.value
    UNION
    SELECT 'opengeni_app'
    WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.list_organization_workspace_ids(uuid) TO %I',
      data_schema, application_role
    );
  END LOOP;
END
$pin_and_grant_organization_workspace_inventory$;

COMMENT ON FUNCTION list_organization_workspace_ids(uuid) IS
  'Complete content-free organization workspace inventory. Canonical personal-workspace pointers are excluded under exact account scope.';