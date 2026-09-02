-- deployment-mode: rolling
-- Shared-workspace creators receive explicit operational administration while
-- organization administrators retain a separate, content-blind lifecycle
-- authority for the workspace management surface.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER FUNCTION organization_workspace_command(jsonb)
  RENAME TO organization_workspace_command_without_creator_access;

REVOKE ALL ON FUNCTION organization_workspace_command_without_creator_access(jsonb) FROM PUBLIC;

DO $revoke_legacy_runtime_callers$
DECLARE
  legacy_owner oid;
  grantee_name text;
BEGIN
  SELECT function.proowner INTO legacy_owner
  FROM pg_catalog.pg_proc function
  WHERE function.oid = 'organization_workspace_command_without_creator_access(jsonb)'::regprocedure;
  FOR grantee_name IN
    SELECT role.rolname
    FROM pg_catalog.pg_proc function
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
    ) grant_value
    JOIN pg_catalog.pg_roles role ON role.oid = grant_value.grantee
    WHERE function.oid =
        'organization_workspace_command_without_creator_access(jsonb)'::regprocedure
      AND grant_value.privilege_type = 'EXECUTE'
      AND grant_value.grantee <> legacy_owner
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.organization_workspace_command_without_creator_access(jsonb) FROM %I',
      current_schema(), grantee_name
    );
  END LOOP;
END
$revoke_legacy_runtime_callers$;

CREATE FUNCTION organization_workspace_command(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  result jsonb;
  actor_membership_id uuid;
  creator_grant_operation_id uuid;
  creator_grant_operation_hash text;
BEGIN
  result := organization_workspace_command_without_creator_access(p_command);
  IF p_command ->> 'action' IS DISTINCT FROM 'create' THEN
    RETURN result;
  END IF;

  SELECT membership.id INTO actor_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = nullif(p_command ->> 'organizationId', '')::uuid
    AND membership.subject_id = p_command ->> 'actorSubjectId'
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'admin');
  IF actor_membership_id IS NULL THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;

  -- Derive one stable, private follow-up operation from the public create key.
  -- A committed create can therefore be retried safely after a lost response,
  -- without ever re-elevating a creator who was deliberately demoted later.
  creator_grant_operation_hash := pg_catalog.md5(
    'organization-workspace-creator-admin:' || (p_command ->> 'operationId')
  );
  creator_grant_operation_id := (
    pg_catalog.substr(creator_grant_operation_hash, 1, 12)
    || '5'
    || pg_catalog.substr(creator_grant_operation_hash, 14, 3)
    || '8'
    || pg_catalog.substr(creator_grant_operation_hash, 18)
  )::uuid;

  result := result || organization_workspace_command_without_creator_access(
    pg_catalog.jsonb_build_object(
      'action', 'grant',
      'organizationId', p_command ->> 'organizationId',
      'actorSubjectId', p_command ->> 'actorSubjectId',
      'workspaceId', result ->> 'workspaceId',
      'targetOrganizationMembershipId', actor_membership_id,
      'role', 'admin',
      'operationId', creator_grant_operation_id
    )
  );
  RETURN result;
END
$body$;

CREATE FUNCTION authorize_organization_shared_workspace_administration(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_actor_subject_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'organization workspace administration is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || p_account_id::text, 0)
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
  FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.personal_workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'personal workspaces are not administrable'
      USING ERRCODE = '42501';
  END IF;
END
$body$;

REVOKE ALL ON FUNCTION organization_workspace_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_organization_shared_workspace_administration(uuid,uuid,text)
  FROM PUBLIC;

DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.organization_workspace_command_without_creator_access(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.organization_workspace_command(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.authorize_organization_shared_workspace_administration(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.organization_workspace_command_without_creator_access(jsonb) FROM opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.organization_workspace_command(jsonb) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.authorize_organization_shared_workspace_administration(uuid,uuid,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$pin_and_grant$;

COMMENT ON FUNCTION organization_workspace_command(jsonb) IS
  'Idempotent organization-admin shared-workspace command. A create atomically materializes an explicit named admin grant for its creator.';
COMMENT ON FUNCTION authorize_organization_shared_workspace_administration(uuid,uuid,text) IS
  'Transaction-scoped, content-blind organization owner/admin authority for managing one shared workspace. It grants no operational workspace access.';
