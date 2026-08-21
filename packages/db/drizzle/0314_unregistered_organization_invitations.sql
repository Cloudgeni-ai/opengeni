-- deployment-mode: maintenance
-- Permit an organization invitation to exist before its target has an
-- OpenGeni login. A verified Better Auth email binds the invitation to the
-- canonical user subject before the existing acceptance lifecycle runs.
-- This is a one-way application protocol cutover: stop every API, control
-- worker, and turn worker before applying it, and never restart a pre-0314
-- image. Old callers can accept without initial workspace grants and can
-- provision a fallback organization before verified invitation convergence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $organization_invitation_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0314 organization invitation activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0314 organization invitation activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0314 organization invitation activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0314 organization invitation activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$organization_invitation_writer_drain_before_lock$;

LOCK TABLE organization_membership_invitations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_membership_operation_receipts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_memberships IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspace_memberships IN ACCESS EXCLUSIVE MODE;

DO $organization_invitation_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0314 organization invitation activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$organization_invitation_writer_drain_after_lock$;

ALTER TABLE organization_membership_invitations
  ALTER COLUMN target_subject_id DROP NOT NULL,
  ADD COLUMN target_name text,
  ADD COLUMN initial_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

ALTER TABLE organization_membership_invitations
  DROP CONSTRAINT organization_membership_invitations_subject_check,
  ADD CONSTRAINT organization_membership_invitations_subject_check CHECK (
    target_subject_id IS NULL
    OR (
      target_subject_id = btrim(target_subject_id)
      AND target_subject_id LIKE 'user:%'
      AND octet_length(convert_to(target_subject_id, 'UTF8')) BETWEEN 6 AND 1024
    )
  ),
  ADD CONSTRAINT organization_membership_invitations_name_check CHECK (
    target_name IS NULL
    OR (
      target_name = btrim(target_name)
      AND octet_length(convert_to(target_name, 'UTF8')) BETWEEN 1 AND 120
    )
  ),
  ADD CONSTRAINT organization_membership_invitations_workspace_count_check CHECK (
    cardinality(initial_workspace_ids) BETWEEN 0 AND 100
  );

DROP INDEX organization_membership_invitations_pending_target_uq;
CREATE UNIQUE INDEX organization_membership_invitations_pending_target_uq
  ON organization_membership_invitations (account_id, target_subject_id)
  WHERE status = 'pending' AND target_subject_id IS NOT NULL;
CREATE UNIQUE INDEX organization_membership_invitations_pending_email_uq
  ON organization_membership_invitations (account_id, target_email)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION opengeni_private.organization_invitation_row_json(
  p_invitation organization_membership_invitations
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $body$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_invitation.id,
    'organizationId', p_invitation.account_id,
    'targetEmail', p_invitation.target_email,
    'targetName', p_invitation.target_name,
    'initialWorkspaceIds', p_invitation.initial_workspace_ids,
    'role', p_invitation.role,
    'status', CASE
      WHEN p_invitation.status = 'pending'
        AND p_invitation.expires_at <= pg_catalog.clock_timestamp()
      THEN 'expired'
      ELSE p_invitation.status
    END,
    'revision', p_invitation.revision,
    'expiresAt', p_invitation.expires_at,
    'acceptedMembershipId', p_invitation.accepted_membership_id,
    'createdAt', p_invitation.created_at,
    'updatedAt', p_invitation.updated_at
  )
$body$;

CREATE FUNCTION create_organization_invitation_v2(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  input_hash_value text;
  receipt_row organization_membership_operation_receipts%ROWTYPE;
  actor organization_memberships%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  target_subject text := nullif(p_command ->> 'targetSubjectId', '');
  target_email_value text := lower(btrim(p_command ->> 'targetEmail'));
  target_name_value text := nullif(btrim(p_command ->> 'targetName'), '');
  requested_role text := p_command ->> 'role';
  expires_at_value timestamptz := nullif(p_command ->> 'expiresAt', '')::timestamptz;
  requested_workspace_ids uuid[];
  now_value timestamptz := pg_catalog.clock_timestamp();
  result jsonb;
BEGIN
  IF p_command IS NULL
    OR account_id_value IS NULL
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR operation_id_value IS NULL
  THEN
    RAISE EXCEPTION 'organization invitation authority is invalid' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(pg_catalog.array_agg(candidate.workspace_id ORDER BY candidate.workspace_id), '{}')
  INTO requested_workspace_ids
  FROM (
    SELECT DISTINCT value::uuid AS workspace_id
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(p_command -> 'initialWorkspaceIds', '[]'::jsonb)
    ) value
  ) candidate;

  IF target_email_value IS NULL
    OR target_email_value <> btrim(target_email_value)
    OR octet_length(convert_to(target_email_value, 'UTF8')) NOT BETWEEN 3 AND 320
    OR (target_subject IS NOT NULL AND target_subject NOT LIKE 'user:%')
    OR (target_name_value IS NOT NULL
      AND octet_length(convert_to(target_name_value, 'UTF8')) NOT BETWEEN 1 AND 120)
    OR requested_role NOT IN ('owner', 'admin', 'member')
    OR expires_at_value <= now_value
    OR expires_at_value > now_value + interval '30 days'
    OR cardinality(requested_workspace_ids) > 100
  THEN
    RAISE EXCEPTION 'organization invitation input is invalid' USING ERRCODE = '22023';
  END IF;

  -- Email-first is the canonical ordering shared with verified signup
  -- convergence. It makes invitation creation and fallback organization
  -- provisioning mutually exclusive for one normalized identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization-invitation-email:' || target_email_value, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  SELECT * INTO receipt_row
  FROM organization_membership_operation_receipts receipt
  WHERE receipt.account_id = account_id_value
    AND receipt.operation_id = operation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF receipt_row.action IS DISTINCT FROM 'invite'
      OR receipt_row.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    RETURN receipt_row.result;
  END IF;

  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = actor_subject
  FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  IF actor.role = 'admin' AND requested_role <> 'member' THEN
    RAISE EXCEPTION 'administrators may invite members only' USING ERRCODE = '22023';
  END IF;

  IF cardinality(requested_workspace_ids) > 0 THEN
    IF (
      SELECT pg_catalog.count(*)::integer
      FROM workspaces workspace
      WHERE workspace.account_id = account_id_value
        AND workspace.id = ANY(requested_workspace_ids)
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = account_id_value
            AND membership.personal_workspace_id = workspace.id
        )
    ) IS DISTINCT FROM cardinality(requested_workspace_ids)
    THEN
      RAISE EXCEPTION 'initial workspace access contains an unavailable workspace'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF target_subject IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = target_subject
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'subject is already an active organization member' USING ERRCODE = '55000';
  END IF;
  IF target_subject IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = target_subject
      AND membership.status IN ('suspended', 'revoked')
  ) THEN
    RAISE EXCEPTION 'inactive organization membership cannot be re-invited'
      USING ERRCODE = '55000';
  END IF;

  UPDATE organization_membership_invitations SET
    status = 'revoked', revision = revision + 1, updated_at = now_value
  WHERE account_id = account_id_value
    AND status = 'pending'
    AND (
      organization_membership_invitations.target_email = target_email_value
      OR (target_subject IS NOT NULL AND target_subject_id = target_subject)
    );

  INSERT INTO organization_membership_invitations (
    account_id, target_subject_id, target_email, target_name,
    initial_workspace_ids, role, created_by_membership_id, expires_at
  ) VALUES (
    account_id_value, target_subject, target_email_value, target_name_value,
    requested_workspace_ids, requested_role, actor.id, expires_at_value
  ) RETURNING * INTO invitation;

  result := opengeni_private.organization_invitation_row_json(invitation);
  INSERT INTO organization_membership_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (
    account_id_value, operation_id_value, 'invite', input_hash_value, result
  );
  RETURN result;
END
$body$;

CREATE FUNCTION bind_pending_organization_invitations_for_verified_email(
  p_subject_id text,
  p_email text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  normalized_email text := lower(btrim(p_email));
  user_id_value text;
  bound_count integer := 0;
  account_id_value uuid;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
    OR normalized_email IS NULL
    OR octet_length(convert_to(normalized_email, 'UTF8')) NOT BETWEEN 3 AND 320
  THEN
    RAISE EXCEPTION 'verified managed human authority required' USING ERRCODE = '42501';
  END IF;
  user_id_value := substring(p_subject_id FROM 6);
  IF user_id_value IS NULL
    OR octet_length(convert_to(user_id_value, 'UTF8')) NOT BETWEEN 1 AND 1019
  THEN
    RAISE EXCEPTION 'verified managed human authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth_users auth_user
    WHERE auth_user.id = user_id_value
      AND auth_user.email_verified IS TRUE
      AND lower(btrim(auth_user.email)) = normalized_email
  ) THEN
    RAISE EXCEPTION 'verified managed human authority required' USING ERRCODE = '42501';
  END IF;

  -- Hold this transaction-scoped fence through the caller's subsequent
  -- pending-invitation check and fallback provisioning decision. Creation
  -- takes the same fence before any organization lock, so neither path can
  -- snapshot an absence while a matching invitation is committing.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization-invitation-email:' || normalized_email, 0
    )
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  FOR account_id_value IN
    SELECT DISTINCT invitation.account_id
    FROM organization_membership_invitations invitation
    WHERE invitation.target_subject_id IS NULL
      AND invitation.target_email = normalized_email
      AND invitation.status = 'pending'
      AND invitation.expires_at > pg_catalog.clock_timestamp()
    ORDER BY invitation.account_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'organization-membership:' || account_id_value::text, 0
      )
    );
    PERFORM 1 FROM managed_accounts account
    WHERE account.id = account_id_value FOR KEY SHARE;
    WITH bound AS (
      UPDATE organization_membership_invitations invitation SET
        target_subject_id = p_subject_id,
        revision = invitation.revision + 1,
        updated_at = pg_catalog.clock_timestamp()
      WHERE invitation.account_id = account_id_value
        AND invitation.target_subject_id IS NULL
        AND invitation.target_email = normalized_email
        AND invitation.status = 'pending'
        AND invitation.expires_at > pg_catalog.clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM organization_membership_invitations existing
          WHERE existing.account_id = invitation.account_id
            AND existing.target_subject_id = p_subject_id
            AND existing.status = 'pending'
        )
      RETURNING 1
    )
    SELECT bound_count + pg_catalog.count(*)::integer
    INTO bound_count FROM bound;
  END LOOP;
  RETURN bound_count;
END
$body$;

CREATE FUNCTION has_pending_organization_invitation_for_subject(p_subject_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
  THEN
    RAISE EXCEPTION 'managed human subject authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  RETURN EXISTS (
    SELECT 1 FROM organization_membership_invitations invitation
    WHERE invitation.target_subject_id = p_subject_id
      AND invitation.status = 'pending'
      AND invitation.expires_at > pg_catalog.clock_timestamp()
  );
END
$body$;

CREATE FUNCTION accept_organization_invitation_v2(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  invitation_id_value uuid := nullif(p_command ->> 'invitationId', '')::uuid;
  invitation organization_membership_invitations%ROWTYPE;
  result jsonb;
  default_member_permissions jsonb := '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write",
    "goals:manage"
  ]'::jsonb;
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
  result := organization_membership_command(p_command);

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
$body$;

DO $search_paths$
DECLARE data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.create_organization_invitation_v2(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.bind_pending_organization_invitations_for_verified_email(text,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.has_pending_organization_invitation_for_subject(text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.accept_organization_invitation_v2(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$search_paths$;

REVOKE ALL ON FUNCTION create_organization_invitation_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION bind_pending_organization_invitations_for_verified_email(text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION has_pending_organization_invitation_for_subject(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_organization_invitation_v2(jsonb) FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION create_organization_invitation_v2(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      bind_pending_organization_invitations_for_verified_email(text,text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      has_pending_organization_invitation_for_subject(text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION accept_organization_invitation_v2(jsonb) TO opengeni_app;
  END IF;
END
$runtime_grants$;

COMMENT ON FUNCTION bind_pending_organization_invitations_for_verified_email(text,text) IS
  'Binds active pending email invitations only after the exact Better Auth user has verified that email.';
