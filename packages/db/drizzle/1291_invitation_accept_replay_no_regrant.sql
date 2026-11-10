-- deployment-mode: rolling
-- Replaying an organization invitation accept no longer grants its initial
-- shared workspaces again.
--
-- accept_organization_invitation_v2 calls organization_membership_command and
-- then inserts a member row for every initial workspace on the invitation.
-- When the call repeats an earlier accept (same operation id and input), the
-- command returns the stored receipt without changing anything, but the
-- wrapper still ran its insert. A member an administrator had since removed
-- from one of those workspaces was added back by the replay.
--
-- The wrapper now checks, under the organization membership advisory fence
-- the command takes first (reentrant, so the lock order is unchanged), whether
-- a receipt for this operation already exists. A replay returns the stored
-- result with no further effect; only the call that performs the acceptance
-- grants the initial workspaces. Every other line is the previous body.
--
-- Rolling: the signature, owner and grants are unchanged, and the previous
-- release calls the function the same way.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Later migrations name the install schema at run time; the baseline wrote it
-- as a placeholder.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION accept_organization_invitation_v2(p_command jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  invitation_id_value uuid := nullif(p_command ->> 'invitationId', '')::uuid;
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  invitation organization_membership_invitations%%ROWTYPE;
  result jsonb;
  replayed boolean;
  default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions('member');
BEGIN
  IF account_id_value IS NULL
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR invitation_id_value IS NULL
  THEN
    RAISE EXCEPTION 'organization invitation acceptance authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  -- The same organization fence organization_membership_command takes first;
  -- holding it here keeps the replay decision stable against a concurrent
  -- first acceptance with this operation id.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  replayed := EXISTS (
    SELECT 1 FROM organization_membership_operation_receipts receipt
    WHERE receipt.account_id = account_id_value
      AND receipt.operation_id = operation_id_value
  );
  result := organization_membership_command(p_command);
  IF replayed THEN
    -- An idempotent replay returns the stored result and applies nothing.
    RETURN result;
  END IF;

  SELECT * INTO invitation
  FROM organization_membership_invitations candidate
  WHERE candidate.account_id = account_id_value
    AND candidate.id = invitation_id_value;
  IF NOT FOUND OR invitation.target_subject_id IS DISTINCT FROM actor_subject THEN
    RAISE EXCEPTION 'organization invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF cardinality(invitation.initial_workspace_ids) > 0 THEN
    IF (
      SELECT pg_catalog.count(*)::integer
      FROM workspaces workspace
      WHERE workspace.account_id = account_id_value
        AND workspace.id = ANY(invitation.initial_workspace_ids)
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = account_id_value
            AND membership.personal_workspace_id = workspace.id
        )
    ) IS DISTINCT FROM cardinality(invitation.initial_workspace_ids)
    THEN
      RAISE EXCEPTION 'initial workspace access is no longer available'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO workspace_memberships (
      account_id, workspace_id, subject_id, subject_label, role, permissions
    )
    SELECT
      account_id_value, workspace_id, actor_subject,
      coalesce(invitation.target_name, invitation.target_email),
      'member', default_member_permissions
    FROM pg_catalog.unnest(invitation.initial_workspace_ids) workspace_id
    ON CONFLICT (subject_id, workspace_id) DO NOTHING;
  END IF;
  RETURN result;
END
$$;
$create$, data_schema);
END $install$;
