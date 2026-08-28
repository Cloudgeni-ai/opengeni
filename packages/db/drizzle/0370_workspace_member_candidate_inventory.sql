-- deployment-mode: rolling
-- Workspace member managers may enumerate only active same-organization humans
-- who do not already have access to their exact shared workspace.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE FUNCTION list_workspace_member_management_candidates(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  result jsonb;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR nullif(pg_catalog.btrim(p_actor_subject_id), '') IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'workspace member management authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.id = p_workspace_id AND workspace.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.personal_workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'Personal workspace membership is owner-only' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM organization_memberships organization_membership
    JOIN workspace_memberships workspace_membership
      ON workspace_membership.account_id = organization_membership.account_id
     AND workspace_membership.subject_id = organization_membership.subject_id
     AND workspace_membership.workspace_id = p_workspace_id
    WHERE organization_membership.account_id = p_account_id
      AND organization_membership.subject_id = p_actor_subject_id
      AND organization_membership.status = 'active'
      AND (
        workspace_membership.permissions ? 'members:manage'
        OR workspace_membership.permissions ? 'workspace:admin'
      )
  ) THEN
    RAISE EXCEPTION 'workspace member management authority required' USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT count(*)
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.status = 'active'
      AND membership.subject_id LIKE 'user:%'
      AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships access
        WHERE access.account_id = p_account_id
          AND access.workspace_id = p_workspace_id
          AND access.subject_id = membership.subject_id
      )
  ) > 1000 THEN
    RAISE EXCEPTION 'workspace member candidate inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationMembershipId', membership.id,
      'subjectId', membership.subject_id,
      'name', auth_user.name,
      'email', auth_user.email,
      'organizationRole', membership.role
    ) ORDER BY lower(coalesce(auth_user.name, auth_user.email, membership.subject_id)), membership.id
  ), '[]'::jsonb) INTO result
  FROM organization_memberships membership
  LEFT JOIN auth_users auth_user
    ON membership.subject_id = 'user:' || auth_user.id
  WHERE membership.account_id = p_account_id
    AND membership.status = 'active'
    AND membership.subject_id LIKE 'user:%'
    AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships access
      WHERE access.account_id = p_account_id
        AND access.workspace_id = p_workspace_id
        AND access.subject_id = membership.subject_id
    );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', COALESCE(previous_lifecycle, ''), true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', COALESCE(previous_lifecycle, ''), true
  );
  RAISE;
END
$body$;

REVOKE ALL ON FUNCTION list_workspace_member_management_candidates(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_workspace_member_management_candidates(uuid, uuid, text)
  TO opengeni_app;
