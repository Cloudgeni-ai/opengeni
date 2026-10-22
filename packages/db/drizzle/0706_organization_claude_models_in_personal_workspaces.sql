-- deployment-mode: rolling
-- An organization Claude subscription that is allowed in personal workspaces
-- offered no models there. The organization model rows share the scope rule
-- of organization API keys, which never serve personal workspaces, so a
-- personal workspace could not read the Claude model rows at all even though
-- the subscription itself was ready for it. The picker then showed no Claude
-- models and admission could not resolve one.
--
-- Claude subscription model rows are now readable from any workspace of the
-- same organization. They are model definitions only: whether the
-- subscription reaches a workspace is still decided by the credential's own
-- workspace and personal-workspace access. Writes and API-key provider rows
-- keep the existing rule.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION opengeni_private.organization_subscription_model_scope_visible(
  p_account_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  workspace_value uuid := opengeni_private.current_workspace_id();
  visible boolean := false;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_account_id IS NULL
    OR workspace_value IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN RETURN false; END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT EXISTS (
    SELECT 1 FROM public.workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
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
$function$;

REVOKE ALL ON FUNCTION opengeni_private.organization_subscription_model_scope_visible(uuid)
  FROM PUBLIC;

CREATE POLICY organization_model_provider_subscription_models_read
  ON organization_model_provider_custom_models
  FOR SELECT
  USING (
    provider_kind = 'claude_subscription'
    AND opengeni_private.organization_subscription_model_scope_visible(account_id)
  );

DO $application_grants$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.organization_subscription_model_scope_visible(uuid) TO %I',
      application_role
    );
  END LOOP;
END
$application_grants$;
