-- deployment-mode: rolling
-- Active direct managed-human organization owners and administrators may
-- administer a shared workspace without acquiring operational workspace
-- access. Personal workspaces are excluded at the database capability.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_membership_operation_receipts
  DROP CONSTRAINT organization_membership_operation_receipts_action_check;
ALTER TABLE organization_membership_operation_receipts
  ADD CONSTRAINT organization_membership_operation_receipts_action_check CHECK (
    action IN (
      'invite', 'accept', 'revoke_invitation', 'change_role', 'suspend',
      'reactivate', 'offboard', 'retention', 'create_workspace'
    )
  ) NOT VALID;
ALTER TABLE organization_membership_operation_receipts
  VALIDATE CONSTRAINT organization_membership_operation_receipts_action_check;

-- The organization-only exception to the last durable workspace-admin guard
-- must carry route provenance, not merely an organization role. This
-- transaction-scoped capability is opened only by the direct managed-cookie
-- organization route and is invisible to ordinary/delegated workspace paths.
CREATE TABLE organization_shared_workspace_administration_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, capability_id)
);

ALTER TABLE organization_shared_workspace_administration_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_shared_workspace_administration_capabilities FORCE ROW LEVEL SECURITY;

DO $capability_policy$
DECLARE
  target_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY organization_shared_workspace_administration_capability_owner '
      || 'ON %I.organization_shared_workspace_administration_capabilities '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    target_schema, migration_owner, migration_owner
  );
END
$capability_policy$;

CREATE FUNCTION opengeni_private.assert_organization_shared_workspace_administrator(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS void
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF p_account_id IS NULL
    OR p_workspace_id IS NULL
    OR p_actor_subject_id IS NULL
    OR p_actor_subject_id NOT LIKE 'user:%'
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization shared-workspace administration authority is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize role/personal-workspace changes with this transaction. The lock
  -- has no row-level dependency and therefore keeps the canonical lifecycle
  -- ordering intact.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  IF NOT EXISTS (
    SELECT 1
    FROM organization_memberships actor
    WHERE actor.account_id = p_account_id
      AND actor.subject_id = p_actor_subject_id
      AND actor.status = 'active'
      AND actor.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = p_workspace_id
      AND NOT EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.personal_workspace_id = workspace.id
      )
  ) THEN
    -- Cross-organization, missing, and Personal workspaces intentionally share
    -- one non-enumerating result.
    RAISE EXCEPTION 'shared workspace not found' USING ERRCODE = 'P0002';
  END IF;
END
$body$;

CREATE FUNCTION assert_organization_shared_workspace_administrator(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  PERFORM opengeni_private.assert_organization_shared_workspace_administrator(
    p_account_id, p_workspace_id, p_actor_subject_id
  );
END
$body$;

CREATE FUNCTION open_organization_shared_workspace_administration_capability(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  capability_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM opengeni_private.assert_organization_shared_workspace_administrator(
    p_account_id, p_workspace_id, p_actor_subject_id
  );
  INSERT INTO organization_shared_workspace_administration_capabilities (
    backend_pid, transaction_id, capability_id,
    account_id, workspace_id, actor_subject_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), capability_id_value,
    p_account_id, p_workspace_id, p_actor_subject_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_shared_workspace_administration_capability',
    capability_id_value::text,
    true
  );
  RETURN capability_id_value;
END
$body$;

CREATE FUNCTION close_organization_shared_workspace_administration_capability(
  p_capability_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  DELETE FROM organization_shared_workspace_administration_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id()
    AND capability.capability_id = p_capability_id;
  IF pg_catalog.current_setting(
    'opengeni.organization_shared_workspace_administration_capability', true
  ) = p_capability_id::text THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_shared_workspace_administration_capability', '', true
    );
  END IF;
END
$body$;

CREATE FUNCTION create_organization_shared_workspace(
  p_account_id uuid,
  p_actor_subject_id text,
  p_name text,
  p_slug text,
  p_agent_instructions text,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  requested_name text := pg_catalog.btrim(p_name);
  requested_slug text := nullif(pg_catalog.btrim(p_slug), '');
  requested_agent_instructions text := nullif(
    pg_catalog.btrim(p_agent_instructions), ''
  );
  input_hash_value text;
  receipt_row organization_membership_operation_receipts%ROWTYPE;
  workspace_row workspaces%ROWTYPE;
  result_value jsonb;
BEGIN
  IF p_account_id IS NULL
    OR p_operation_id IS NULL
    OR p_actor_subject_id IS NULL
    OR p_actor_subject_id NOT LIKE 'user:%'
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR requested_name IS NULL
    OR pg_catalog.length(requested_name) NOT BETWEEN 1 AND 120
    OR (requested_slug IS NOT NULL AND pg_catalog.length(requested_slug) > 120)
  THEN
    RAISE EXCEPTION 'organization shared-workspace creation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Match the organization lifecycle lock order: advisory organization lock,
  -- account key-share fence, then organization membership and workspace rows.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships actor
    WHERE actor.account_id = p_account_id
      AND actor.subject_id = p_actor_subject_id
      AND actor.status = 'active'
      AND actor.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;

  input_hash_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'actorSubjectId', p_actor_subject_id,
      'name', requested_name,
      'slug', requested_slug,
      'agentInstructions', requested_agent_instructions
    )::text,
    'UTF8'
  )), 'hex');
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle',
    true
  );
  SELECT * INTO receipt_row
  FROM organization_membership_operation_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF receipt_row.action IS DISTINCT FROM 'create_workspace'
      OR receipt_row.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    RETURN receipt_row.result;
  END IF;

  INSERT INTO workspaces (
    account_id, name, slug, external_source, external_id, agent_instructions
  ) VALUES (
    p_account_id, requested_name, requested_slug,
    'opengeni:organization-shared-workspace',
    p_account_id::text || ':' || p_operation_id::text,
    requested_agent_instructions
  ) RETURNING * INTO workspace_row;
  INSERT INTO workspace_inference_controls (workspace_id, account_id)
  VALUES (workspace_row.id, p_account_id);

  result_value := pg_catalog.jsonb_build_object('workspaceId', workspace_row.id);
  INSERT INTO organization_membership_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (
    p_account_id, p_operation_id, 'create_workspace', input_hash_value, result_value
  );
  RETURN result_value;
END
$body$;

CREATE FUNCTION upsert_organization_shared_workspace_member(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text,
  p_target_membership_id uuid,
  p_subject_label text,
  p_role text,
  p_permissions jsonb,
  p_require_existing boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  target organization_memberships%ROWTYPE;
  access workspace_memberships%ROWTYPE;
  normalized_role text;
  existing_role text;
BEGIN
  IF p_target_membership_id IS NULL
    OR p_require_existing IS NULL
    OR p_permissions IS NULL
    OR pg_catalog.jsonb_typeof(p_permissions) <> 'array'
    OR pg_catalog.jsonb_array_length(p_permissions) > 128
    OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_permissions) item(value)
      WHERE pg_catalog.jsonb_typeof(item.value) <> 'string'
        OR char_length(item.value #>> '{}') NOT BETWEEN 1 AND 128
    )
  THEN
    RAISE EXCEPTION 'organization shared-workspace member request is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM opengeni_private.assert_organization_shared_workspace_administrator(
    p_account_id, p_workspace_id, p_actor_subject_id
  );

  SELECT * INTO target
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.id = p_target_membership_id
    AND membership.status = 'active'
    AND membership.subject_id LIKE 'user:%'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active organization member not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT membership.role INTO existing_role
  FROM workspace_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.workspace_id = p_workspace_id
    AND membership.subject_id = target.subject_id;
  IF p_require_existing AND existing_role IS NULL THEN
    RAISE EXCEPTION 'workspace member not found' USING ERRCODE = 'P0002';
  END IF;
  normalized_role := coalesce(nullif(btrim(p_role), ''), existing_role, 'member');
  IF char_length(normalized_role) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'organization shared-workspace member role is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO workspace_memberships (
    account_id, workspace_id, subject_id, subject_label, role, permissions
  ) VALUES (
    p_account_id, p_workspace_id, target.subject_id,
    nullif(btrim(p_subject_label), ''), normalized_role, p_permissions
  )
  ON CONFLICT (subject_id, workspace_id) DO UPDATE SET
    subject_label = coalesce(EXCLUDED.subject_label, workspace_memberships.subject_label),
    role = EXCLUDED.role,
    permissions = EXCLUDED.permissions,
    updated_at = pg_catalog.clock_timestamp()
  RETURNING * INTO access;

  RETURN pg_catalog.jsonb_build_object(
    'subjectId', access.subject_id,
    'subjectLabel', access.subject_label,
    'role', access.role,
    'permissions', access.permissions,
    'createdAt', access.created_at
  );
END
$body$;

-- Migration 0278 allowed an organization administrator to remove a workspace
-- member, but still required another durable workspace administrator to remain.
-- Once organization administration is a complete shared-workspace control
-- plane, that durable operational grant is no longer required. Preserve the
-- guard for workspace-only administrators and exclude Personal workspaces for
-- both actor paths.
CREATE OR REPLACE FUNCTION opengeni_private.assert_workspace_membership_removal_actor(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject text,
  p_target_subject text
) RETURNS void
LANGUAGE plpgsql
AS $body$
DECLARE
  actor_is_organization_administrator boolean;
  actor_can_administer boolean;
BEGIN
  IF p_actor_subject = p_target_subject THEN
    RAISE EXCEPTION 'a member cannot remove their own workspace membership'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = p_workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.personal_workspace_id = workspace.id
      )
  ) THEN
    RAISE EXCEPTION 'shared workspace not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships org_actor
    JOIN organization_shared_workspace_administration_capabilities capability
      ON capability.account_id = org_actor.account_id
      AND capability.workspace_id = p_workspace_id
      AND capability.actor_subject_id = org_actor.subject_id
      AND capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id()
      AND capability.capability_id::text = pg_catalog.current_setting(
        'opengeni.organization_shared_workspace_administration_capability', true
      )
    WHERE org_actor.account_id = p_account_id
      AND org_actor.subject_id = p_actor_subject
      AND p_actor_subject LIKE 'user:%'
      AND org_actor.status = 'active'
      AND org_actor.role IN ('owner', 'admin')
  ) INTO actor_is_organization_administrator;
  SELECT actor_is_organization_administrator OR EXISTS (
    SELECT 1 FROM workspace_memberships actor_row
    WHERE actor_row.account_id = p_account_id
      AND actor_row.workspace_id = p_workspace_id
      AND actor_row.subject_id = p_actor_subject
      AND actor_row.permissions ?| ARRAY['workspace:admin', 'members:manage']
  ) INTO actor_can_administer;
  IF NOT actor_can_administer THEN
    RAISE EXCEPTION 'workspace member administration required' USING ERRCODE = '42501';
  END IF;
  IF NOT actor_is_organization_administrator
    AND EXISTS (
      SELECT 1 FROM workspace_memberships target_row
      WHERE target_row.account_id = p_account_id
        AND target_row.workspace_id = p_workspace_id
        AND target_row.subject_id = p_target_subject
        AND target_row.permissions ?| ARRAY['workspace:admin', 'members:manage']
    ) AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships other
      WHERE other.account_id = p_account_id
        AND other.workspace_id = p_workspace_id
        AND other.subject_id <> p_target_subject
        AND other.permissions ?| ARRAY['workspace:admin', 'members:manage']
    )
  THEN
    RAISE EXCEPTION 'cannot remove the last administering workspace member'
      USING ERRCODE = '55000';
  END IF;
END
$body$;

REVOKE ALL ON FUNCTION opengeni_private.assert_organization_shared_workspace_administrator(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_organization_shared_workspace_administrator(uuid, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION open_organization_shared_workspace_administration_capability(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_organization_shared_workspace_administration_capability(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION create_organization_shared_workspace(
  uuid, text, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_organization_shared_workspace_member(
  uuid, uuid, text, uuid, text, text, jsonb, boolean
) FROM PUBLIC;
REVOKE ALL ON TABLE organization_shared_workspace_administration_capabilities FROM PUBLIC;

DO $body$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.assert_organization_shared_workspace_administrator(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.assert_workspace_membership_removal_actor(uuid,uuid,text,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.assert_organization_shared_workspace_administrator(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.open_organization_shared_workspace_administration_capability(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.close_organization_shared_workspace_administration_capability(uuid) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.create_organization_shared_workspace(uuid,text,text,text,text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.upsert_organization_shared_workspace_member(uuid,uuid,text,uuid,text,text,jsonb,boolean) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.organization_shared_workspace_administration_capabilities FROM opengeni_app',
      target_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.assert_organization_shared_workspace_administrator(uuid,uuid,text) TO opengeni_app',
      target_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.upsert_organization_shared_workspace_member(uuid,uuid,text,uuid,text,text,jsonb,boolean) TO opengeni_app',
      target_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.open_organization_shared_workspace_administration_capability(uuid,uuid,text) TO opengeni_app',
      target_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.close_organization_shared_workspace_administration_capability(uuid) TO opengeni_app',
      target_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.create_organization_shared_workspace(uuid,text,text,text,text,uuid) TO opengeni_app',
      target_schema
    );
  END IF;
END
$body$;

COMMENT ON FUNCTION assert_organization_shared_workspace_administrator(uuid,uuid,text) IS
  'Authorizes the direct managed-human organization control plane for one shared workspace; Personal workspaces are excluded.';
COMMENT ON FUNCTION upsert_organization_shared_workspace_member(uuid,uuid,text,uuid,text,text,jsonb,boolean) IS
  'Assigns or updates one active organization member in a shared workspace without granting the actor operational access.';
COMMENT ON FUNCTION create_organization_shared_workspace(uuid,text,text,text,text,uuid) IS
  'Idempotently creates a shared workspace through the direct organization control plane without granting operational workspace access to the actor.';
