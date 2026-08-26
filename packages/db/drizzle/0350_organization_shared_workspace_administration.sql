-- deployment-mode: rolling
-- Organization-owned shared-workspace administration. Personal workspaces are
-- identified only by organization_memberships.personal_workspace_id; names,
-- slugs, and external ids are never authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_workspace_operation_receipts (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  action text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, operation_id),
  CONSTRAINT organization_workspace_operation_receipts_action_check CHECK (
    action IN ('create', 'rename', 'grant', 'revoke')
  ),
  CONSTRAINT organization_workspace_operation_receipts_hash_check CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  )
);
ALTER TABLE organization_workspace_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_workspace_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle ON organization_workspace_operation_receipts
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE TABLE organization_workspace_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  target_organization_membership_id uuid,
  target_workspace_membership_id uuid,
  kind text NOT NULL,
  role text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_workspace_lifecycle_events_operation_uq
    UNIQUE (account_id, operation_id),
  CONSTRAINT organization_workspace_lifecycle_events_actor_fk
    FOREIGN KEY (actor_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_workspace_lifecycle_events_target_fk
    FOREIGN KEY (target_organization_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_workspace_lifecycle_events_kind_check CHECK (
    kind IN ('create', 'rename', 'grant', 'revoke')
  ),
  CONSTRAINT organization_workspace_lifecycle_events_role_check CHECK (
    (kind = 'grant' AND role IN ('viewer', 'member', 'admin', 'custom'))
    OR (kind <> 'grant' AND role IS NULL)
  )
);
ALTER TABLE organization_workspace_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_workspace_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle ON organization_workspace_lifecycle_events
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE TRIGGER organization_workspace_operation_receipts_immutable
  BEFORE UPDATE OR DELETE ON organization_workspace_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();
CREATE TRIGGER organization_workspace_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON organization_workspace_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE FUNCTION opengeni_private.workspace_member_role_permissions(p_role text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT CASE p_role
    WHEN 'viewer' THEN '[
      "workspace:read", "sessions:read", "stream:view", "files:read",
      "documents:search", "variable-sets:list", "connections:read",
      "rigs:use", "artifacts:read"
    ]'::jsonb
    WHEN 'member' THEN '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "files:upload", "files:read", "documents:manage", "documents:search",
      "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
      "variable-sets:list", "variable-sets:read", "variable-sets:write",
      "variable-sets:attach", "variable-sets:use", "secrets:list",
      "secrets:write", "goals:manage"
    ]'::jsonb
    WHEN 'admin' THEN '[
      "workspace:read", "workspace:admin", "members:manage", "sessions:create",
      "sessions:read", "sessions:control", "stream:view", "stream:control",
      "stream:acknowledge", "terminal:attach", "codemode:call", "files:upload",
      "files:read", "files:write", "documents:manage", "documents:search",
      "scheduled_tasks:manage", "scheduled_tasks:run", "github:manage",
      "github:use", "api_keys:manage", "connections:read", "connections:write",
      "variable-sets:list", "variable-sets:read", "variable-sets:write",
      "variable-sets:manage", "variable-sets:attach", "variable-sets:use",
      "secrets:list", "secrets:write", "mcp_servers:attach", "goals:manage",
      "rigs:use", "rigs:manage", "enrollments:read", "enrollments:manage",
      "artifacts:read", "artifacts:publish"
    ]'::jsonb
    ELSE NULL
  END
$body$;

CREATE FUNCTION opengeni_private.workspace_member_role(
  p_role text,
  p_permissions jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT CASE
    WHEN p_role IN ('viewer', 'member', 'admin')
      AND p_permissions @> opengeni_private.workspace_member_role_permissions(p_role)
      AND opengeni_private.workspace_member_role_permissions(p_role) @> p_permissions
    THEN p_role
    ELSE 'custom'
  END
$body$;

CREATE FUNCTION opengeni_private.workspace_member_custom_permissions_valid(p_permissions jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_permissions) IS DISTINCT FROM 'array' THEN false
    ELSE pg_catalog.jsonb_array_length(p_permissions) <= 128
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(p_permissions) permission(value)
        WHERE permission.value NOT IN (
        'members:manage', 'workspace:read', 'workspace:admin',
        'sessions:create', 'sessions:read', 'sessions:control', 'stream:view',
        'stream:control', 'stream:acknowledge', 'files:upload', 'files:read',
        'files:write', 'terminal:attach', 'documents:manage', 'documents:search',
        'scheduled_tasks:manage', 'scheduled_tasks:run', 'github:manage',
        'github:use', 'api_keys:manage', 'connections:read', 'connections:write',
        'environments:manage', 'environments:use', 'variable-sets:list',
        'variable-sets:read', 'variable-sets:write', 'variable-sets:manage',
        'variable-sets:attach', 'variable-sets:use', 'secrets:list',
        'secrets:read', 'secrets:write', 'mcp_servers:attach', 'codemode:call',
        'goals:manage', 'enrollments:read', 'enrollments:manage', 'rigs:use',
        'rigs:manage', 'artifacts:read', 'artifacts:publish'
      )
    ) END
$body$;

CREATE FUNCTION get_workspace_kind(p_account_id uuid, p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  kind_value text;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'workspace kind authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  kind_value := CASE WHEN EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.personal_workspace_id = p_workspace_id
  ) THEN 'personal' ELSE 'shared' END;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN kind_value;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$body$;

CREATE FUNCTION organization_workspace_command(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  action_value text := p_command ->> 'action';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  target_membership_id_value uuid := nullif(
    p_command ->> 'targetOrganizationMembershipId', ''
  )::uuid;
  role_value text := p_command ->> 'role';
  permissions_value jsonb := p_command -> 'permissions';
  resolved_permissions jsonb;
  name_value text := nullif(btrim(p_command ->> 'name'), '');
  expected_updated_at_value timestamptz := nullif(
    p_command ->> 'expectedUpdatedAt', ''
  )::timestamptz;
  input_hash_value text;
  actor organization_memberships%ROWTYPE;
  target organization_memberships%ROWTYPE;
  workspace workspaces%ROWTYPE;
  access workspace_memberships%ROWTYPE;
  prior organization_workspace_operation_receipts%ROWTYPE;
  result jsonb;
BEGIN
  IF p_command IS NULL OR account_id_value IS NULL OR actor_subject IS NULL
    OR action_value NOT IN ('create', 'rename', 'grant')
    OR operation_id_value IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization workspace command is invalid' USING ERRCODE = '22023';
  END IF;
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = actor_subject
  FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM organization_workspace_operation_receipts receipt
  WHERE receipt.account_id = account_id_value
    AND receipt.operation_id = operation_id_value;
  IF FOUND THEN
    IF prior.action IS DISTINCT FROM action_value
      OR prior.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization workspace operation key was reused'
        USING ERRCODE = '23505';
    END IF;
    RETURN prior.result || pg_catalog.jsonb_build_object('replay', true);
  END IF;

  IF action_value = 'create' THEN
    IF name_value IS NULL
      OR char_length(name_value) > 120
      OR octet_length(convert_to(name_value, 'UTF8')) > 480
      OR workspace_id_value IS NOT NULL
      OR target_membership_id_value IS NOT NULL
      OR role_value IS NOT NULL
      OR permissions_value IS NOT NULL
      OR expected_updated_at_value IS NOT NULL
    THEN
      RAISE EXCEPTION 'shared workspace create input is invalid' USING ERRCODE = '22023';
    END IF;
    workspace_id_value := pg_catalog.gen_random_uuid();
    PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
    INSERT INTO workspaces (id, account_id, name)
    VALUES (workspace_id_value, account_id_value, name_value)
    RETURNING * INTO workspace;
    INSERT INTO workspace_inference_controls (workspace_id, account_id)
    VALUES (workspace_id_value, account_id_value);
  ELSE
    IF workspace_id_value IS NULL THEN
      RAISE EXCEPTION 'shared workspace id is required' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
    PERFORM 1 FROM workspace_inference_controls control
    WHERE control.account_id = account_id_value
      AND control.workspace_id = workspace_id_value
    FOR SHARE;
    SELECT * INTO workspace FROM workspaces candidate
    WHERE candidate.account_id = account_id_value
      AND candidate.id = workspace_id_value
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (
      SELECT 1 FROM organization_memberships personal_owner
      WHERE personal_owner.account_id = account_id_value
        AND personal_owner.personal_workspace_id = workspace_id_value
    ) THEN
      RAISE EXCEPTION 'personal workspaces are not administrable'
        USING ERRCODE = '42501';
    END IF;
    IF action_value = 'rename' THEN
      IF name_value IS NULL
        OR char_length(name_value) > 120
        OR octet_length(convert_to(name_value, 'UTF8')) > 480
        OR expected_updated_at_value IS NULL
        OR target_membership_id_value IS NOT NULL
        OR role_value IS NOT NULL
        OR permissions_value IS NOT NULL
      THEN
        RAISE EXCEPTION 'shared workspace rename input is invalid' USING ERRCODE = '22023';
      END IF;
      IF workspace.updated_at IS DISTINCT FROM expected_updated_at_value THEN
        RAISE EXCEPTION 'shared workspace changed before rename' USING ERRCODE = '40001';
      END IF;
      UPDATE workspaces SET name = name_value, updated_at = clock_timestamp()
      WHERE id = workspace_id_value RETURNING * INTO workspace;
    ELSE
      IF target_membership_id_value IS NULL
        OR role_value NOT IN ('viewer', 'member', 'admin', 'custom')
        OR name_value IS NOT NULL
        OR (role_value = 'custom'
          AND opengeni_private.workspace_member_custom_permissions_valid(permissions_value)
            IS DISTINCT FROM true)
        OR (role_value <> 'custom' AND permissions_value IS NOT NULL)
      THEN
        RAISE EXCEPTION 'shared workspace grant input is invalid' USING ERRCODE = '22023';
      END IF;
      resolved_permissions := CASE
        WHEN role_value = 'custom' THEN permissions_value
        ELSE opengeni_private.workspace_member_role_permissions(role_value)
      END;
      SELECT * INTO target FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.id = target_membership_id_value
      FOR SHARE;
      IF NOT FOUND OR target.status <> 'active' OR target.subject_id NOT LIKE 'user:%' THEN
        RAISE EXCEPTION 'active organization member not found' USING ERRCODE = 'P0002';
      END IF;
      SELECT * INTO access FROM workspace_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.workspace_id = workspace_id_value
        AND membership.subject_id = target.subject_id
      FOR UPDATE;
      IF FOUND THEN
        IF expected_updated_at_value IS NULL
          OR access.updated_at IS DISTINCT FROM expected_updated_at_value
        THEN
          RAISE EXCEPTION 'workspace access changed before grant' USING ERRCODE = '40001';
        END IF;
        UPDATE workspace_memberships SET
          role = role_value,
          permissions = resolved_permissions,
          subject_label = NULL,
          updated_at = clock_timestamp()
        WHERE id = access.id RETURNING * INTO access;
      ELSE
        IF expected_updated_at_value IS NOT NULL THEN
          RAISE EXCEPTION 'workspace access changed before grant' USING ERRCODE = '40001';
        END IF;
        INSERT INTO workspace_memberships (
          account_id, workspace_id, subject_id, subject_label, role, permissions
        ) VALUES (
          account_id_value, workspace_id_value, target.subject_id, NULL,
          role_value, resolved_permissions
        ) RETURNING * INTO access;
      END IF;
    END IF;
  END IF;

  result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'workspaceId', workspace_id_value,
    'organizationMembershipId', target_membership_id_value,
    'workspaceMembershipId', access.id,
    'updatedAt', coalesce(access.updated_at, workspace.updated_at),
    'replay', false
  ));
  INSERT INTO organization_workspace_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (
    account_id_value, operation_id_value, action_value, input_hash_value, result
  );
  INSERT INTO organization_workspace_lifecycle_events (
    account_id, operation_id, actor_membership_id, workspace_id,
    target_organization_membership_id, target_workspace_membership_id, kind, role
  ) VALUES (
    account_id_value, operation_id_value, actor.id, workspace_id_value,
    target_membership_id_value, access.id, action_value,
    CASE WHEN action_value = 'grant' THEN role_value ELSE NULL END
  );
  RETURN result;
END
$body$;

CREATE FUNCTION resolve_organization_workspace_removal_subject(
  p_account_id uuid,
  p_actor_subject_id text,
  p_target_organization_membership_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  target organization_memberships%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_target_organization_membership_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization workspace removal authority required'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || p_account_id::text, 0)
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.id = p_target_organization_membership_id;
  IF NOT FOUND OR target.subject_id NOT LIKE 'user:%' THEN
    RAISE EXCEPTION 'organization member not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN target.subject_id;
END
$body$;

CREATE FUNCTION prepare_organization_workspace_member_removal(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  target_membership_id_value uuid := nullif(
    p_command ->> 'targetOrganizationMembershipId', ''
  )::uuid;
  target_subject text := p_command ->> 'targetSubjectId';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  expected_updated_at_value timestamptz := nullif(
    p_command ->> 'expectedUpdatedAt', ''
  )::timestamptz;
  input_hash_value text;
  actor organization_memberships%ROWTYPE;
  target organization_memberships%ROWTYPE;
  access workspace_memberships%ROWTYPE;
  prior organization_workspace_operation_receipts%ROWTYPE;
BEGIN
  IF p_command IS NULL OR (p_command ->> 'action') IS DISTINCT FROM 'revoke'
    OR account_id_value IS NULL OR workspace_id_value IS NULL
    OR actor_subject IS NULL OR target_membership_id_value IS NULL
    OR target_subject IS NULL OR operation_id_value IS NULL
    OR expected_updated_at_value IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization workspace removal request is invalid'
      USING ERRCODE = '22023';
  END IF;
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = account_id_value AND control.workspace_id = workspace_id_value
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value AND workspace.id = workspace_id_value
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_memberships personal_owner
    WHERE personal_owner.account_id = account_id_value
      AND personal_owner.personal_workspace_id = workspace_id_value
  ) THEN
    RAISE EXCEPTION 'personal workspaces are not administrable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = actor_subject
  FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM organization_workspace_operation_receipts receipt
  WHERE receipt.account_id = account_id_value
    AND receipt.operation_id = operation_id_value;
  IF FOUND THEN
    IF prior.action <> 'revoke' OR prior.input_hash IS DISTINCT FROM input_hash_value THEN
      RAISE EXCEPTION 'organization workspace operation key was reused'
        USING ERRCODE = '23505';
    END IF;
    RETURN prior.result || pg_catalog.jsonb_build_object('replay', true);
  END IF;
  SELECT * INTO target FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.id = target_membership_id_value
    AND membership.subject_id = target_subject
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization member not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO access FROM workspace_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.workspace_id = workspace_id_value
    AND membership.subject_id = target_subject
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace access not found' USING ERRCODE = 'P0002';
  END IF;
  IF access.updated_at IS DISTINCT FROM expected_updated_at_value THEN
    RAISE EXCEPTION 'workspace access changed before removal' USING ERRCODE = '40001';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'removed', false,
    'replay', false,
    'workspaceMembershipId', access.id,
    'actorMembershipId', actor.id
  );
END
$body$;

CREATE FUNCTION record_organization_workspace_member_removal(
  p_command jsonb,
  p_workspace_membership_id uuid,
  p_actor_membership_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  target_membership_id_value uuid := nullif(
    p_command ->> 'targetOrganizationMembershipId', ''
  )::uuid;
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  input_hash_value text;
  result jsonb;
BEGIN
  IF p_command IS NULL OR (p_command ->> 'action') IS DISTINCT FROM 'revoke'
    OR account_id_value IS NULL OR workspace_id_value IS NULL
    OR target_membership_id_value IS NULL OR operation_id_value IS NULL
    OR p_workspace_membership_id IS NULL OR p_actor_membership_id IS NULL
    OR (p_command ->> 'actorSubjectId') IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships actor
      WHERE actor.account_id = account_id_value
        AND actor.id = p_actor_membership_id
        AND actor.subject_id = p_command ->> 'actorSubjectId'
        AND actor.status = 'active'
        AND actor.role IN ('owner', 'admin')
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships target
      WHERE target.account_id = account_id_value
        AND target.id = target_membership_id_value
        AND target.subject_id = p_command ->> 'targetSubjectId'
    )
    OR EXISTS (
      SELECT 1 FROM workspace_memberships membership
      WHERE membership.id = p_workspace_membership_id
        OR (
          membership.account_id = account_id_value
          AND membership.workspace_id = workspace_id_value
          AND membership.subject_id = p_command ->> 'targetSubjectId'
        )
    )
  THEN
    RAISE EXCEPTION 'organization workspace removal receipt is invalid'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  result := pg_catalog.jsonb_build_object('removed', true, 'replay', false);
  INSERT INTO organization_workspace_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (account_id_value, operation_id_value, 'revoke', input_hash_value, result);
  INSERT INTO organization_workspace_lifecycle_events (
    account_id, operation_id, actor_membership_id, workspace_id,
    target_organization_membership_id, target_workspace_membership_id, kind
  ) VALUES (
    account_id_value, operation_id_value, p_actor_membership_id, workspace_id_value,
    target_membership_id_value, p_workspace_membership_id, 'revoke'
  );
  RETURN result;
END
$body$;

CREATE FUNCTION list_organization_administration_members(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  result jsonb;
BEGIN
  IF p_account_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization member authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM organization_memberships WHERE account_id = p_account_id) > 1000 THEN
    RAISE EXCEPTION 'organization member inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', membership.id,
      'organizationId', membership.account_id,
      'subjectId', membership.subject_id,
      'name', auth_user.name,
      'email', auth_user.email,
      'role', membership.role,
      'status', membership.status,
      'authorizationRevision', membership.authorization_revision,
      'sharedWorkspaceAccess', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'workspaceId', workspace.id,
          'workspaceName', workspace.name,
          'membershipId', access.id,
          'role', opengeni_private.workspace_member_role(access.role, access.permissions),
          'updatedAt', access.updated_at
        ) ORDER BY lower(workspace.name), workspace.id)
        FROM workspace_memberships access
        JOIN workspaces workspace ON workspace.id = access.workspace_id
        WHERE access.account_id = p_account_id
          AND access.subject_id = membership.subject_id
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships personal_owner
            WHERE personal_owner.account_id = p_account_id
              AND personal_owner.personal_workspace_id = workspace.id
          )
      ), '[]'::jsonb),
      'revokedAt', membership.revoked_at,
      'createdAt', membership.created_at,
      'updatedAt', membership.updated_at
    ) ORDER BY lower(coalesce(auth_user.name, auth_user.email, membership.subject_id)), membership.id
  ), '[]'::jsonb) INTO result
  FROM organization_memberships membership
  LEFT JOIN auth_users auth_user
    ON membership.subject_id = 'user:' || auth_user.id
  WHERE membership.account_id = p_account_id;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION get_organization_administration_overview(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  result jsonb;
  workspace_count integer;
  oversized_workspace boolean;
BEGIN
  IF p_account_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization administration authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  WITH shared_workspaces AS MATERIALIZED (
    SELECT workspace.*,
      (SELECT count(*)::integer FROM workspace_memberships access
       WHERE access.workspace_id = workspace.id) AS member_count
    FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.personal_workspace_id = workspace.id
      )
  ), bounds AS (
    SELECT count(*)::integer AS workspace_count,
      coalesce(bool_or(shared.member_count > 1000), false) AS oversized_workspace
    FROM shared_workspaces shared
  )
  SELECT bounds.workspace_count, bounds.oversized_workspace,
    CASE WHEN bounds.workspace_count <= 500 AND NOT bounds.oversized_workspace THEN
      pg_catalog.jsonb_build_object(
        'organization', pg_catalog.jsonb_build_object(
          'id', account.id, 'name', account.name,
          'createdAt', account.created_at, 'updatedAt', account.updated_at
        ),
        'roles', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'role', 'viewer', 'label', 'Viewer',
            'description', 'Can view shared workspace sessions, files, and approved knowledge.',
            'permissions', opengeni_private.workspace_member_role_permissions('viewer')
          ),
          pg_catalog.jsonb_build_object(
            'role', 'member', 'label', 'Member',
            'description', 'Can create sessions and contribute shared workspace content.',
            'permissions', opengeni_private.workspace_member_role_permissions('member')
          ),
          pg_catalog.jsonb_build_object(
            'role', 'admin', 'label', 'Workspace admin',
            'description', 'Can manage shared workspace settings, access, and integrations.',
            'permissions', opengeni_private.workspace_member_role_permissions('admin')
          )
        ),
        'workspaces', coalesce((SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', workspace.id, 'name', workspace.name, 'slug', workspace.slug,
            'createdAt', workspace.created_at, 'updatedAt', workspace.updated_at,
            'members', coalesce((SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'membershipId', access.id,
                'organizationMembershipId', org_member.id,
                'subjectId', access.subject_id,
                'name', auth_user.name,
                'email', auth_user.email,
                'subjectLabel', CASE
                  WHEN org_member.id IS NULL THEN access.subject_label
                  ELSE coalesce(auth_user.name, auth_user.email)
                END,
                'principalKind', CASE WHEN org_member.id IS NULL THEN 'service' ELSE 'human' END,
                'organizationRole', org_member.role,
                'role', opengeni_private.workspace_member_role(access.role, access.permissions),
                'permissions', access.permissions,
                'createdAt', access.created_at,
                'updatedAt', access.updated_at
              ) ORDER BY lower(coalesce(auth_user.name, auth_user.email, access.subject_label,
                access.subject_id)), access.id
            )
            FROM workspace_memberships access
            LEFT JOIN organization_memberships org_member
              ON org_member.account_id = p_account_id
             AND org_member.subject_id = access.subject_id
            LEFT JOIN auth_users auth_user
              ON access.subject_id = 'user:' || auth_user.id
            WHERE access.workspace_id = workspace.id), '[]'::jsonb)
          ) ORDER BY lower(workspace.name), workspace.id
        ) FROM shared_workspaces workspace), '[]'::jsonb)
      ) ELSE NULL END
  INTO workspace_count, oversized_workspace, result
  FROM managed_accounts account CROSS JOIN bounds WHERE account.id = p_account_id;
  IF workspace_count > 500 THEN
    RAISE EXCEPTION 'organization workspace inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  IF oversized_workspace THEN
    RAISE EXCEPTION 'workspace access inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  RETURN result;
END
$body$;

REVOKE ALL ON TABLE organization_workspace_operation_receipts FROM PUBLIC;
REVOKE ALL ON TABLE organization_workspace_lifecycle_events FROM PUBLIC;
REVOKE ALL ON FUNCTION get_workspace_kind(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION organization_workspace_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_organization_workspace_removal_subject(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_organization_workspace_member_removal(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_organization_workspace_member_removal(jsonb,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_organization_administration_members(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_organization_administration_overview(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_role_permissions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_role(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_custom_permissions_valid(jsonb) FROM PUBLIC;

DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.get_workspace_kind(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.organization_workspace_command(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_organization_workspace_removal_subject(uuid,text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.prepare_organization_workspace_member_removal(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.record_organization_workspace_member_removal(jsonb,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_administration_members(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_organization_administration_overview(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.organization_workspace_operation_receipts FROM opengeni_app',
      data_schema
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.organization_workspace_lifecycle_events FROM opengeni_app',
      data_schema
    );
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_workspace_kind(uuid,uuid) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.organization_workspace_command(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.resolve_organization_workspace_removal_subject(uuid,text,uuid) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.prepare_organization_workspace_member_removal(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.record_organization_workspace_member_removal(jsonb,uuid,uuid) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_organization_administration_members(uuid,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_organization_administration_overview(uuid,text) TO opengeni_app', data_schema);
  END IF;
END
$pin_and_grant$;

COMMENT ON FUNCTION organization_workspace_command(jsonb) IS
  'Idempotent and CAS-fenced organization-admin create, rename, and named-role shared workspace grant command. Personal workspaces are excluded by canonical membership pointers.';
COMMENT ON FUNCTION get_workspace_kind(uuid,uuid) IS
  'Machine-readable personal/shared workspace kind derived only from canonical organization membership personal-workspace authority.';
COMMENT ON FUNCTION list_organization_administration_members(uuid,text) IS
  'Safe organization-admin member projection with shared-workspace access and no personal-workspace metadata. The legacy list_organization_members projection remains unchanged for rolling compatibility.';
