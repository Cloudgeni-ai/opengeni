-- deployment-mode: maintenance
-- Organization-owned Vercel AI Gateway/OpenRouter credentials and model catalog.
-- Personal workspaces are deliberately excluded from runtime inheritance.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $scope_visibility$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.organization_model_provider_scope_visible(
      p_account_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
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
      THEN RETURN false; END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true
      );
      IF workspace_value IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM %1$I.workspaces workspace
          WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
        ) AND NOT EXISTS (
          SELECT 1 FROM %1$I.organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.personal_workspace_id = workspace_value
        ) INTO visible;
      ELSIF subject_value IS NOT NULL AND (
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
        SELECT EXISTS (
          SELECT 1 FROM %1$I.organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.subject_id = subject_value
            AND membership.status = 'active'
            AND membership.role IN ('owner', 'admin')
        ) INTO visible;
      END IF;
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
  $ddl$, data_schema);
END
$scope_visibility$;

CREATE TABLE organization_model_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider_kind text NOT NULL CHECK (provider_kind IN ('vercel_gateway', 'openrouter')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  credential_encrypted text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  updated_by_subject_id text NOT NULL CHECK (octet_length(updated_by_subject_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_kind),
  UNIQUE (account_id, provider_kind, operation_id)
);

CREATE TABLE organization_model_provider_connection_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider_kind text NOT NULL CHECK (provider_kind IN ('vercel_gateway', 'openrouter')),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_status text NOT NULL CHECK (result_status IN ('active', 'revoked')),
  result_version integer NOT NULL CHECK (result_version > 0),
  result_created_at timestamptz NOT NULL,
  result_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_kind, operation_id)
);

CREATE TABLE organization_model_provider_custom_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider_kind text NOT NULL CHECK (provider_kind IN ('vercel_gateway', 'openrouter')),
  upstream_model_id text NOT NULL CHECK (
    octet_length(upstream_model_id) BETWEEN 1 AND 238
    AND upstream_model_id ~ '^[!-~]+$' AND upstream_model_id !~ '[|]'
  ),
  label text CHECK (
    label IS NULL OR (octet_length(label) BETWEEN 1 AND 128 AND label !~ '[\r\n|]')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_operation_id uuid NOT NULL,
  create_request_hash text NOT NULL CHECK (create_request_hash ~ '^[a-f0-9]{64}$'),
  delete_operation_id uuid,
  delete_request_hash text,
  created_by_subject_id text NOT NULL CHECK (octet_length(created_by_subject_id) BETWEEN 1 AND 1024),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (delete_operation_id IS NULL AND delete_request_hash IS NULL)
    OR (delete_operation_id IS NOT NULL AND delete_request_hash ~ '^[a-f0-9]{64}$' AND retired_at IS NOT NULL)
  ),
  UNIQUE (account_id, provider_kind, create_operation_id)
);
CREATE UNIQUE INDEX organization_model_provider_custom_models_active_uq
  ON organization_model_provider_custom_models(account_id, provider_kind, upstream_model_id)
  WHERE retired_at IS NULL;
CREATE UNIQUE INDEX organization_model_provider_custom_models_delete_operation_uq
  ON organization_model_provider_custom_models(account_id, provider_kind, delete_operation_id)
  WHERE delete_operation_id IS NOT NULL;

ALTER TABLE organization_model_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_model_provider_connection_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_provider_connection_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_model_provider_custom_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_provider_custom_models FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_model_provider_scope
  ON organization_model_provider_connections
  USING (opengeni_private.organization_model_provider_scope_visible(account_id))
  WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));
CREATE POLICY organization_model_provider_scope
  ON organization_model_provider_connection_operations
  USING (opengeni_private.organization_model_provider_scope_visible(account_id))
  WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));
CREATE POLICY organization_model_provider_scope
  ON organization_model_provider_custom_models
  USING (opengeni_private.organization_model_provider_scope_visible(account_id))
  WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));

REVOKE ALL ON organization_model_provider_connections FROM PUBLIC;
REVOKE ALL ON organization_model_provider_connection_operations FROM PUBLIC;
REVOKE ALL ON organization_model_provider_custom_models FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.organization_model_provider_scope_visible(uuid) FROM PUBLIC;

DO $application_grants$
DECLARE
  data_schema text := current_schema();
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
      'GRANT SELECT, INSERT, UPDATE ON TABLE %1$I.organization_model_provider_connections, %1$I.organization_model_provider_connection_operations, %1$I.organization_model_provider_custom_models TO %2$I',
      data_schema, application_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.organization_model_provider_scope_visible(uuid) TO %I',
      application_role
    );
  END LOOP;
END
$application_grants$;

COMMENT ON TABLE organization_model_provider_connections IS
  'Encrypted organization-owned Vercel AI Gateway/OpenRouter credentials inherited by shared workspaces only.';
COMMENT ON TABLE organization_model_provider_connection_operations IS
  'Durable secret-free idempotency receipts for organization provider connection mutations.';
COMMENT ON TABLE organization_model_provider_custom_models IS
  'Retained organization provider model generations; active rows are fresh-selection authority.';
