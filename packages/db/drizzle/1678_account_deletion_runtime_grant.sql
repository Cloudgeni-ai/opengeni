-- deployment-mode: rolling
-- Deploy only after the previous API and worker know these two signatures.
DO $account_deletion_runtime_grant$
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
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.account_deletion_user_v1(text,jsonb), opengeni_private.account_deletion_work_v1(text,jsonb) TO %I',
      application_role
    );
  END LOOP;
END $account_deletion_runtime_grant$;
