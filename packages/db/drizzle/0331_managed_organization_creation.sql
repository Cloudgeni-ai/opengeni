-- deployment-mode: rolling
-- Self-service organization creation for an authenticated managed human. One
-- lifecycle seam creates the organization, its first shared workspace, the
-- caller's personal workspace, and both authority anchors atomically.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION create_managed_organization(
  p_subject_id text,
  p_subject_label text,
  p_name text,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  requested_name text := btrim(p_name);
  account_row managed_accounts%ROWTYPE;
  shared_workspace workspaces%ROWTYPE;
  personal_workspace workspaces%ROWTYPE;
  membership_row organization_memberships%ROWTYPE;
  workspace_permissions jsonb := pg_catalog.jsonb_build_array(
    'workspace:read', 'workspace:admin', 'members:manage',
    'sessions:create', 'sessions:read', 'sessions:control',
    'files:upload', 'files:read', 'documents:manage', 'documents:search',
    'scheduled_tasks:manage', 'scheduled_tasks:run',
    'github:manage', 'github:use', 'api_keys:manage',
    'connections:read', 'connections:write',
    'variable-sets:list', 'variable-sets:read', 'variable-sets:write',
    'variable-sets:manage', 'variable-sets:attach', 'variable-sets:use',
    'secrets:list', 'secrets:read', 'secrets:write',
    'mcp_servers:attach', 'goals:manage',
    'enrollments:read', 'enrollments:manage',
    'artifacts:read', 'artifacts:publish'
  );
BEGIN
  IF p_operation_id IS NULL
    OR p_subject_id IS NULL
    OR p_subject_id NOT LIKE 'user:%'
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR requested_name IS NULL
    OR length(requested_name) NOT BETWEEN 1 AND 120
    OR NOT EXISTS (
      SELECT 1 FROM auth_users auth_user
      WHERE auth_user.id = substr(p_subject_id, length('user:') + 1)
    )
  THEN
    RAISE EXCEPTION 'managed organization creation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- One operation id is one durable creation attempt. Serialize before the
  -- replay lookup so concurrent retries cannot both miss the account row and
  -- race its unique external identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'managed-organization-creation:' || p_operation_id::text, 0
  ));

  SELECT * INTO account_row
  FROM managed_accounts account
  WHERE account.external_source = 'opengeni:managed-organization'
    AND account.external_id = p_operation_id::text
  FOR UPDATE;

  IF FOUND THEN
    IF account_row.name IS DISTINCT FROM requested_name THEN
      RAISE EXCEPTION 'organization operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM organization_memberships membership
      WHERE membership.account_id = account_row.id
        AND membership.subject_id = p_subject_id
        AND membership.role = 'owner'
        AND membership.status = 'active'
    ) THEN
      RAISE EXCEPTION 'organization operation id belongs to another subject'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO shared_workspace
    FROM workspaces workspace
    WHERE workspace.account_id = account_row.id
      AND workspace.external_source = 'opengeni:managed-organization-default';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'managed organization creation is incomplete' USING ERRCODE = '55000';
    END IF;
  ELSE
    INSERT INTO managed_accounts (name, external_source, external_id)
    VALUES (requested_name, 'opengeni:managed-organization', p_operation_id::text)
    RETURNING * INTO account_row;

    PERFORM pg_catalog.set_config('opengeni.account_id', account_row.id::text, true);
    INSERT INTO workspaces (account_id, name, slug, external_source, external_id)
    VALUES (
      account_row.id, 'Default workspace', NULL,
      'opengeni:managed-organization-default', account_row.id::text
    ) RETURNING * INTO shared_workspace;
    INSERT INTO workspace_inference_controls (workspace_id, account_id)
    VALUES (shared_workspace.id, account_row.id);

    INSERT INTO workspaces (account_id, name, slug, external_source, external_id)
    VALUES (
      account_row.id, 'Personal workspace', NULL,
      'opengeni:organization-membership', account_row.id::text || ':' || p_subject_id
    ) RETURNING * INTO personal_workspace;
    INSERT INTO workspace_inference_controls (workspace_id, account_id)
    VALUES (personal_workspace.id, account_row.id);

    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle',
      'organization_membership_lifecycle',
      true
    );
    INSERT INTO organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id
    ) VALUES (
      account_row.id, p_subject_id, 'owner', 'active', personal_workspace.id
    ) RETURNING * INTO membership_row;

    INSERT INTO workspace_memberships (
      account_id, workspace_id, subject_id, subject_label, role, permissions
    ) VALUES (
      account_row.id, shared_workspace.id, p_subject_id,
      nullif(btrim(p_subject_label), ''), 'owner', workspace_permissions
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'organization', pg_catalog.jsonb_build_object(
      'id', account_row.id,
      'name', account_row.name,
      'createdAt', account_row.created_at,
      'updatedAt', account_row.updated_at
    ),
    'workspaceId', shared_workspace.id
  );
END
$body$;

REVOKE ALL ON FUNCTION create_managed_organization(text, text, text, uuid) FROM PUBLIC;
DO $body$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.create_managed_organization(text,text,text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.create_managed_organization(text,text,text,uuid) TO opengeni_app',
      target_schema
    );
  END IF;
END
$body$;

COMMENT ON FUNCTION create_managed_organization(text, text, text, uuid) IS
  'Creates one managed organization and its initial authority graph atomically.';
