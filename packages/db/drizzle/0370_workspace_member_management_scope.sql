-- deployment-mode: rolling
-- Workspace administrators may manage access to their exact shared workspace,
-- but they may only add active human members of the owning organization.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE FUNCTION assert_workspace_member_management_candidate(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text,
  p_target_subject_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR nullif(pg_catalog.btrim(p_actor_subject_id), '') IS NULL
    OR nullif(pg_catalog.btrim(p_target_subject_id), '') IS NULL
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

  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships target
    WHERE target.account_id = p_account_id
      AND target.subject_id = p_target_subject_id
      AND target.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active organization member not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', COALESCE(previous_lifecycle, ''), true
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', COALESCE(previous_lifecycle, ''), true
  );
  RAISE;
END
$body$;

REVOKE ALL ON FUNCTION assert_workspace_member_management_candidate(uuid, uuid, text, text)
  FROM PUBLIC;
DO $workspace_member_management_role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION assert_workspace_member_management_candidate(
      uuid, uuid, text, text
    ) TO opengeni_app;
  END IF;
END
$workspace_member_management_role$;
