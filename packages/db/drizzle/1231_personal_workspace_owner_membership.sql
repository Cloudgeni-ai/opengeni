-- deployment-mode: rolling
-- A Personal workspace's owner gets a real workspace_memberships row
-- (docs/organization-tenancy.md). 1159 already lets only that one row exist.
-- This keeps it in step with the owner's organization membership:
--
-- - The row exists exactly while the managed human's (user:) organization
--   membership is active, not revoked, and points at a workspace carrying
--   its Personal identity (organization id ':' subject). Provisioning,
--   invitation acceptance and reactivation create it; suspension, offboarding
--   (whether the workspace is retained or not), moving the pointer and
--   deleting the membership remove it.
-- - It is role member with exactly the owner's runtime permissions
--   (personal_workspace_owner_permissions(), the same list as
--   managedPersonalWorkspacePermissions in TypeScript): never workspace
--   administration, member management, workspace API keys or usage allowances.
--   The 1159 guard now refuses any other role or permission set there.
-- - The SQL paths that assumed a Personal workspace has no row at all
--   (repeated provisioning, the two activation graph checks and the tenancy
--   parity gate) accept exactly that row and still refuse every other one.
--
-- Local single-user ('dev') and external_user Personal workspaces keep
-- pointer-only access for now: several SQL pointer arms admit only user:
-- owners (guard_session_authority_write), so a row would widen them.
--
-- Rolling: the previous release (with 1159's reader filters) never treats a
-- row in a Personal workspace as access in TypeScript, and every SQL reader
-- that accepts a row already accepts the owner's pointer under the same
-- active-membership conditions. Existing owners get their row from the
-- post-release backfill 1232; until then readers fall back to the pointer as
-- before. The new trigger runs as the writer (SECURITY INVOKER); every
-- organization_memberships writer is an owner-owned lifecycle function.

CREATE FUNCTION personal_workspace_owner_permissions() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT '["workspace:read","sessions:create","sessions:read","sessions:control","stream:view","stream:control","stream:acknowledge","terminal:attach","files:write","files:upload","files:read","documents:manage","documents:search","scheduled_tasks:manage","scheduled_tasks:run","github:manage","github:use","connections:read","connections:write","capabilities:manage","secrets:list","secrets:read","secrets:write","secrets:use","mcp_servers:attach","goals:manage","enrollments:read","enrollments:manage","rigs:use","rigs:manage","artifacts:read","artifacts:publish"]'::jsonb
$$;

COMMENT ON FUNCTION personal_workspace_owner_permissions() IS
  'The permissions of a Personal workspace owner''s own row; equal to managedPersonalWorkspacePermissions (packages/db/src/personal-workspace-permissions.ts).';

CREATE OR REPLACE FUNCTION guard_personal_workspace_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  new_identity text;
  old_personal boolean := false;
  owner_prefix text := NEW.account_id::text || ':';
  owner_permissions jsonb;
BEGIN
  SELECT w.external_id INTO new_identity FROM workspaces w
  WHERE w.id = NEW.workspace_id AND w.external_source = 'opengeni:organization-membership';
  IF TG_OP = 'UPDATE' THEN
    old_personal := EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = OLD.workspace_id AND w.external_source = 'opengeni:organization-membership'
    );
    IF (new_identity IS NOT NULL OR old_personal)
      AND (NEW.workspace_id, NEW.subject_id, NEW.account_id)
        IS DISTINCT FROM (OLD.workspace_id, OLD.subject_id, OLD.account_id)
    THEN
      RAISE EXCEPTION 'a Personal workspace membership cannot move to another person, workspace or organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF new_identity IS NOT NULL THEN
    IF new_identity IS DISTINCT FROM owner_prefix || NEW.subject_id THEN
      RAISE EXCEPTION 'a Personal workspace has exactly one member, its owner'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.role IN ('owner', 'admin')
      OR jsonb_typeof(NEW.permissions) IS DISTINCT FROM 'array'
      OR NEW.permissions ?| ARRAY['workspace:admin', 'members:manage', 'api_keys:manage', 'usage_allowances:manage']
    THEN
      RAISE EXCEPTION 'a Personal workspace owner never administers members, workspace API keys or usage allowances'
        USING ERRCODE = '42501';
    END IF;
    owner_permissions := personal_workspace_owner_permissions();
    IF NEW.role IS DISTINCT FROM 'member'
      OR NOT (NEW.permissions @> owner_permissions AND owner_permissions @> NEW.permissions)
    THEN
      RAISE EXCEPTION 'a Personal workspace owner''s row carries exactly the owner''s permissions'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION sync_personal_workspace_owner_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  keeps boolean := false;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    keeps := NEW.status = 'active'
      AND NEW.revoked_at IS NULL
      AND NEW.subject_id LIKE 'user:%'
      AND NEW.personal_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id = NEW.personal_workspace_id
          AND w.account_id = NEW.account_id
          AND w.external_source = 'opengeni:organization-membership'
          AND w.external_id = NEW.account_id::text || ':' || NEW.subject_id
      );
  END IF;
  -- Remove the row the old state carried, unless the same row stays.
  IF TG_OP <> 'INSERT' AND OLD.personal_workspace_id IS NOT NULL
    AND (TG_OP = 'DELETE' OR NOT keeps
      OR (NEW.personal_workspace_id, NEW.subject_id, NEW.account_id)
        IS DISTINCT FROM (OLD.personal_workspace_id, OLD.subject_id, OLD.account_id))
  THEN
    DELETE FROM workspace_memberships access
    USING workspaces w
    WHERE access.account_id = OLD.account_id
      AND access.workspace_id = OLD.personal_workspace_id
      AND access.subject_id = OLD.subject_id
      AND w.id = access.workspace_id
      AND w.external_source = 'opengeni:organization-membership'
      AND w.external_id = OLD.account_id::text || ':' || OLD.subject_id;
  END IF;
  IF keeps THEN
    INSERT INTO workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    VALUES (NEW.account_id, NEW.personal_workspace_id, NEW.subject_id, 'member',
      personal_workspace_owner_permissions())
    ON CONFLICT (subject_id, workspace_id) DO UPDATE
      SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = clock_timestamp()
      WHERE (workspace_memberships.role, workspace_memberships.permissions)
        IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.permissions);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER personal_workspace_owner_membership
AFTER INSERT OR DELETE OR UPDATE OF status, revoked_at, personal_workspace_id, subject_id, account_id
ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION sync_personal_workspace_owner_membership();

DO $secure$
DECLARE
  owner_name text := pg_get_userbyid((SELECT relowner FROM pg_class
    WHERE oid = format('%I.workspace_memberships', current_schema())::regclass));
  routine text;
BEGIN
  FOREACH routine IN ARRAY ARRAY['guard_personal_workspace_membership()',
    'sync_personal_workspace_owner_membership()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO %I', current_schema(), routine, owner_name);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp',
      current_schema(), routine, current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', current_schema(), routine);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.personal_workspace_owner_permissions() OWNER TO %I', current_schema(),
    owner_name);
END
$secure$;

-- The functions below are unchanged except where they assumed a Personal
-- workspace has no row at all; each now accepts exactly the owner's own row.

CREATE OR REPLACE FUNCTION ensure_managed_human_personal_workspace(p_account_id uuid, p_subject_id text, p_personal_workspace_id uuid)
 RETURNS TABLE(organization_membership_id uuid, personal_workspace_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
    DECLARE
      expected_external_id text;
      managed_identity boolean := false;
      local_identity boolean := false;
      membership_row organization_memberships%ROWTYPE;
      workspace_row workspaces%ROWTYPE;
      previous_workspace_id text := pg_catalog.current_setting(
        'opengeni.workspace_id', true
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_subject_id IS NULL
        OR p_personal_workspace_id IS NULL
        OR p_subject_id <> pg_catalog.btrim(p_subject_id)
        OR pg_catalog.length(p_subject_id) NOT BETWEEN 1 AND 1024
      THEN
        RAISE EXCEPTION 'human provisioning requires a valid complete identity'
          USING ERRCODE = '42501';
      END IF;

      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'human provisioning account authority is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF p_subject_id LIKE 'user:%' THEN
        expected_external_id := pg_catalog.substr(p_subject_id, 6);
        SELECT EXISTS (
          SELECT 1
          FROM managed_accounts account_row
          WHERE account_row.id = p_account_id
            AND account_row.external_source = 'better-auth:user'
            AND account_row.external_id = expected_external_id
        ) INTO managed_identity;
      END IF;
      SELECT EXISTS (
        SELECT 1
        FROM managed_accounts account_row
        WHERE account_row.id = p_account_id
          AND account_row.external_source = 'opengeni:local'
          AND account_row.external_id = 'default'
          AND p_subject_id = 'dev'
          AND opengeni_private.current_subject_id() = p_subject_id
      ) INTO local_identity;
      IF NOT managed_identity AND NOT local_identity THEN
        RAISE EXCEPTION 'human provisioning account identity is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM workspace_memberships owner_membership
        INNER JOIN workspaces owner_workspace
          ON owner_workspace.id = owner_membership.workspace_id
         AND owner_workspace.account_id = owner_membership.account_id
        WHERE owner_membership.account_id = p_account_id
          AND owner_membership.subject_id = p_subject_id
          AND owner_membership.role = 'owner'
          AND (
            NOT local_identity
            OR (
              owner_workspace.external_source = 'opengeni:local'
              AND owner_workspace.external_id = 'default'
            )
          )
      ) THEN
        RAISE EXCEPTION 'human provisioning owner membership is invalid'
          USING ERRCODE = '42501';
      END IF;

      SELECT * INTO workspace_row
      FROM workspaces candidate_workspace
      WHERE candidate_workspace.id = p_personal_workspace_id
      FOR UPDATE;
      IF NOT FOUND
        OR workspace_row.account_id IS DISTINCT FROM p_account_id
        OR workspace_row.external_source IS DISTINCT FROM 'opengeni:organization-membership'
        OR workspace_row.external_id IS DISTINCT FROM (
          p_account_id::text || ':' || p_subject_id
        )
      THEN
        RAISE EXCEPTION 'human provisioning personal workspace identity is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1 FROM workspaces conflicting_workspace
        WHERE conflicting_workspace.account_id = p_account_id AND conflicting_workspace.external_source = 'opengeni:organization-membership'
          AND conflicting_workspace.external_id = p_account_id::text || ':' || p_subject_id
          AND conflicting_workspace.id <> p_personal_workspace_id
      ) THEN
        RAISE EXCEPTION 'human provisioning personal workspace identity conflicts'
          USING ERRCODE = '23505';
      END IF;

      IF EXISTS (
        SELECT 1 FROM workspace_memberships personal_access
        WHERE personal_access.workspace_id = p_personal_workspace_id
          -- The owner's own row (1231) is the one row a Personal workspace has.
          AND NOT (personal_access.subject_id = p_subject_id
          AND personal_access.account_id = p_account_id
          AND personal_access.role = 'member'
          AND personal_access.permissions = personal_workspace_owner_permissions())
      ) THEN
        RAISE EXCEPTION 'human personal workspace already has runtime access'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_personal_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_inference_controls control_row
        WHERE control_row.workspace_id = p_personal_workspace_id
          AND control_row.account_id = p_account_id
      ) THEN
        RAISE EXCEPTION 'human personal workspace control is missing'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'managed_human_provisioning',
        true
      );
      INSERT INTO organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) VALUES (
        p_account_id, p_subject_id, 'active', p_personal_workspace_id
      ) ON CONFLICT (account_id, subject_id) DO NOTHING;

      SELECT * INTO membership_row
      FROM organization_memberships candidate_membership
      WHERE candidate_membership.account_id = p_account_id
        AND candidate_membership.subject_id = p_subject_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'human organization membership was not created'
          USING ERRCODE = 'P0002';
      END IF;
      IF membership_row.status IN ('suspended', 'revoked') THEN
        RAISE EXCEPTION 'human organization membership is not active'
          USING ERRCODE = '42501';
      END IF;
      IF membership_row.personal_workspace_id IS NOT NULL
        AND membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'human organization membership personal workspace conflicts'
          USING ERRCODE = '23505';
      END IF;
      IF membership_row.status = 'provisioning' THEN
        UPDATE organization_memberships
        SET status = 'active',
            personal_workspace_id = p_personal_workspace_id,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = membership_row.id;
        membership_row.status := 'active';
        membership_row.personal_workspace_id := p_personal_workspace_id;
      END IF;
      IF membership_row.status <> 'active'
        OR membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'human organization membership did not converge'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', coalesce(previous_workspace_id, ''), true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        coalesce(previous_lifecycle_marker, ''),
        true
      );
      organization_membership_id := membership_row.id;
      personal_workspace_id := membership_row.personal_workspace_id;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', coalesce(previous_workspace_id, ''), true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        coalesce(previous_lifecycle_marker, ''),
        true
      );
      RAISE;
    END;
    $function$;

CREATE OR REPLACE FUNCTION activate_greenfield_session_tenancy_from_setup(p_auth_user_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  actor_subject text := 'user:' || p_auth_user_id;
  setup self_service_organization_setup_receipts%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  membership organization_memberships%ROWTYPE;
  workspace workspaces%ROWTYPE;
  witness session_tenancy_activations%ROWTYPE;
  inserted_activation session_tenancy_activations%ROWTYPE;
  existing_evidence session_tenancy_greenfield_activation_evidence%ROWTYPE;
  account_inserted_in_current_transaction boolean;
  account_never_updated boolean;
  membership_count integer;
  workspace_count integer;
  workspace_control_count integer;
  workspace_membership_count integer;
  graph_evidence_value jsonb;
  graph_digest_value text;
  parity_digest_value text;
BEGIN
  IF p_auth_user_id IS NULL
    OR pg_catalog.octet_length(pg_catalog.convert_to(p_auth_user_id, 'UTF8'))
      NOT BETWEEN 1 AND 1019
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'greenfield session tenancy setup authority required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO setup
  FROM self_service_organization_setup_receipts receipt
  WHERE receipt.auth_user_id = p_auth_user_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR setup.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR setup.result ->> 'status' IS DISTINCT FROM 'complete'
    OR setup.result ->> 'organizationId' IS DISTINCT FROM setup.account_id::text
    OR setup.result ->> 'personalWorkspaceId' IS DISTINCT FROM setup.personal_workspace_id::text
    OR setup.result ->> 'workspaceId' IS DISTINCT FROM setup.personal_workspace_id::text
  THEN
    RAISE EXCEPTION 'greenfield session tenancy setup receipt is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO account_row
  FROM managed_accounts account
  WHERE account.id = setup.account_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR account_row.external_source IS DISTINCT FROM 'better-auth:user'
    OR account_row.external_id IS DISTINCT FROM p_auth_user_id
    OR account_row.name IS DISTINCT FROM setup.organization_name
  THEN
    RAISE EXCEPTION 'greenfield session tenancy requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;
  SELECT account.xmin::text::bigint
      = pg_catalog.pg_current_xact_id()::text::bigint,
    account.created_at = account.updated_at
  INTO account_inserted_in_current_transaction, account_never_updated
  FROM managed_accounts account
  WHERE account.id = setup.account_id;
  IF account_inserted_in_current_transaction IS NOT TRUE
    OR account_never_updated IS NOT TRUE
  THEN
    RAISE EXCEPTION 'greenfield session tenancy requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO membership
  FROM organization_memberships candidate
  WHERE candidate.id = setup.organization_membership_id
    AND candidate.account_id = setup.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO membership_count
  FROM organization_memberships candidate
  WHERE candidate.account_id = setup.account_id;
  IF membership.id IS NULL
    OR membership_count <> 1
    OR membership.subject_id IS DISTINCT FROM actor_subject
    OR membership.role IS DISTINCT FROM 'owner'
    OR membership.status IS DISTINCT FROM 'active'
    OR membership.personal_workspace_id IS DISTINCT FROM setup.personal_workspace_id
  THEN
    RAISE EXCEPTION 'greenfield session tenancy membership graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO workspace
  FROM workspaces candidate
  WHERE candidate.id = setup.personal_workspace_id
    AND candidate.account_id = setup.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO workspace_count
  FROM workspaces candidate WHERE candidate.account_id = setup.account_id;
  SELECT count(*)::integer INTO workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = setup.account_id
    AND control.workspace_id = setup.personal_workspace_id;
  -- The owner's own Personal workspace row (1231) is not workspace access.
  SELECT count(*)::integer INTO workspace_membership_count
  FROM workspace_memberships candidate
  WHERE candidate.account_id = setup.account_id
    AND NOT (candidate.workspace_id = setup.personal_workspace_id
      AND candidate.subject_id = actor_subject
      AND candidate.role = 'member'
      AND candidate.permissions = personal_workspace_owner_permissions());
  IF workspace.id IS NULL
    OR workspace_count <> 1
    OR workspace_control_count <> 1
    OR workspace_membership_count <> 0
    OR workspace.name IS DISTINCT FROM 'Personal workspace'
    OR workspace.slug IS NOT NULL
    OR workspace.external_source IS DISTINCT FROM 'opengeni:organization-membership'
    OR workspace.external_id IS DISTINCT FROM
      setup.account_id::text || ':' || actor_subject
  THEN
    RAISE EXCEPTION 'greenfield session tenancy Personal workspace graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  graph_evidence_value := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'self_service_personal_only',
    'accountId', setup.account_id,
    'setupAuthUserId', setup.auth_user_id,
    'setupOperationId', setup.operation_id,
    'personalWorkspaceId', setup.personal_workspace_id,
    'organizationMembershipId', setup.organization_membership_id,
    'organizationMembershipCount', membership_count,
    'workspaceCount', workspace_count,
    'workspaceControlCount', workspace_control_count,
    'workspaceMembershipCount', workspace_membership_count
  );
  graph_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    graph_evidence_value::text, 'UTF8'
  )), 'hex');

  -- Graph first, deployment boundary last. Operator activation takes every
  -- source-table lock before this same fence, so either setup commits before
  -- the first witness or it waits and observes the committed witness.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );

  SELECT * INTO existing_evidence
  FROM session_tenancy_greenfield_activation_evidence evidence
  WHERE evidence.account_id = setup.account_id;
  IF FOUND THEN
    IF existing_evidence.setup_auth_user_id IS DISTINCT FROM setup.auth_user_id
      OR existing_evidence.setup_operation_id IS DISTINCT FROM setup.operation_id
      OR existing_evidence.setup_request_fingerprint IS DISTINCT FROM
        setup.request_fingerprint
      OR existing_evidence.personal_workspace_id IS DISTINCT FROM
        setup.personal_workspace_id
      OR existing_evidence.organization_membership_id IS DISTINCT FROM
        setup.organization_membership_id
      OR existing_evidence.graph_digest IS DISTINCT FROM graph_digest_value
    THEN
      RAISE EXCEPTION 'greenfield session tenancy evidence conflicts with durable setup'
        USING ERRCODE = '23505';
    END IF;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN true;
  END IF;

  SELECT * INTO witness
  FROM session_tenancy_activations activation
  WHERE activation.account_id <> setup.account_id
  ORDER BY activation.activated_at, activation.account_id
  LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = setup.account_id
  ) OR EXISTS (
    SELECT 1 FROM organization_private_session_settings setting
    WHERE setting.account_id = setup.account_id
  ) THEN
    RAISE EXCEPTION 'greenfield session tenancy authority already exists without evidence'
      USING ERRCODE = '55000';
  END IF;

  parity_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'graphDigest', graph_digest_value,
      'boundaryWitnessAccountId', witness.account_id,
      'boundaryWitnessActivatedAt', witness.activated_at
    )::text,
    'UTF8'
  )), 'hex');

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
  );
  INSERT INTO session_tenancy_activations (
    account_id, activation_version, inventory_digest, parity_digest,
    activated_by, backfill_receipt_ids
  ) VALUES (
    setup.account_id, 1, graph_digest_value, parity_digest_value,
    'opengeni:greenfield-organization-setup:v1', ARRAY[]::uuid[]
  ) RETURNING * INTO inserted_activation;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (
    setup.account_id, true, 1, setup.organization_membership_id,
    inserted_activation.activated_at
  );
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    setup.operation_id, setup.account_id, setup.organization_membership_id, true,
    0, true, 1, inserted_activation.activated_at, true
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );
  INSERT INTO session_tenancy_greenfield_activation_evidence (
    account_id, eligibility_version, setup_auth_user_id, setup_operation_id,
    setup_request_fingerprint, personal_workspace_id,
    organization_membership_id, boundary_witness_account_id,
    boundary_witness_activated_at, graph_evidence, graph_digest,
    activation_parity_digest, private_setting_version,
    private_setting_event_id, activated_at
  ) VALUES (
    setup.account_id, 1, setup.auth_user_id, setup.operation_id,
    setup.request_fingerprint, setup.personal_workspace_id,
    setup.organization_membership_id, witness.account_id,
    witness.activated_at, graph_evidence_value, graph_digest_value,
    parity_digest_value, 1, setup.operation_id, inserted_activation.activated_at
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION activate_session_tenancy_from_additional_organization(p_operation_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  creation additional_organization_creation_receipts%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  organization_membership organization_memberships%ROWTYPE;
  personal_workspace workspaces%ROWTYPE;
  shared_workspace workspaces%ROWTYPE;
  shared_access workspace_memberships%ROWTYPE;
  witness session_tenancy_activations%ROWTYPE;
  inserted_activation session_tenancy_activations%ROWTYPE;
  existing_evidence session_tenancy_additional_organization_activation_evidence%ROWTYPE;
  account_inserted_in_current_transaction boolean;
  account_never_updated boolean;
  organization_membership_count integer;
  workspace_count integer;
  workspace_control_count integer;
  personal_workspace_control_count integer;
  shared_workspace_control_count integer;
  workspace_membership_count integer;
  graph_evidence_value jsonb;
  graph_digest_value text;
  parity_digest_value text;
  private_setting_event_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'additional organization activation operation is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO creation
  FROM additional_organization_creation_receipts receipt
  WHERE receipt.operation_id = p_operation_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR creation.actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR creation.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR creation.result ->> 'organizationId' IS DISTINCT FROM creation.account_id::text
    OR creation.result ->> 'personalWorkspaceId'
      IS DISTINCT FROM creation.personal_workspace_id::text
    OR creation.result ->> 'workspaceId' IS DISTINCT FROM creation.shared_workspace_id::text
  THEN
    RAISE EXCEPTION 'additional organization activation receipt is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  SELECT * INTO account_row
  FROM managed_accounts account
  WHERE account.id = creation.account_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR account_row.external_source IS DISTINCT FROM 'opengeni:additional-organization'
    OR account_row.external_id IS DISTINCT FROM creation.operation_id::text
    OR account_row.name IS DISTINCT FROM creation.organization_name
  THEN
    RAISE EXCEPTION 'additional organization activation requires its exact new account'
      USING ERRCODE = '55000';
  END IF;
  SELECT
    account.xmin::text::bigint = pg_catalog.pg_current_xact_id()::text::bigint,
    account.created_at = account.updated_at
  INTO account_inserted_in_current_transaction, account_never_updated
  FROM managed_accounts account
  WHERE account.id = creation.account_id;
  IF account_inserted_in_current_transaction IS NOT TRUE
    OR account_never_updated IS NOT TRUE
  THEN
    RAISE EXCEPTION 'additional organization activation requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO organization_membership
  FROM organization_memberships membership
  WHERE membership.id = creation.organization_membership_id
    AND membership.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO organization_membership_count
  FROM organization_memberships membership
  WHERE membership.account_id = creation.account_id;
  IF organization_membership.id IS NULL
    OR organization_membership_count <> 1
    OR organization_membership.subject_id IS DISTINCT FROM creation.actor_subject_id
    OR organization_membership.role IS DISTINCT FROM 'owner'
    OR organization_membership.status IS DISTINCT FROM 'active'
    OR organization_membership.personal_workspace_id
      IS DISTINCT FROM creation.personal_workspace_id
  THEN
    RAISE EXCEPTION 'additional organization membership graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', creation.personal_workspace_id::text, true
  );
  SELECT * INTO personal_workspace
  FROM workspaces workspace
  WHERE workspace.id = creation.personal_workspace_id
    AND workspace.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO personal_workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = creation.account_id
    AND control.workspace_id = creation.personal_workspace_id;

  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', creation.shared_workspace_id::text, true
  );
  SELECT * INTO shared_workspace
  FROM workspaces workspace
  WHERE workspace.id = creation.shared_workspace_id
    AND workspace.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO workspace_count
  FROM workspaces workspace WHERE workspace.account_id = creation.account_id;
  SELECT count(*)::integer INTO shared_workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = creation.account_id
    AND control.workspace_id = creation.shared_workspace_id;
  workspace_control_count :=
    personal_workspace_control_count + shared_workspace_control_count;
  -- The owner's own Personal workspace row (1231) is not workspace access.
  SELECT count(*)::integer INTO workspace_membership_count
  FROM workspace_memberships membership
  WHERE membership.account_id = creation.account_id
    AND NOT (membership.workspace_id = creation.personal_workspace_id
      AND membership.subject_id = creation.actor_subject_id
      AND membership.role = 'member'
      AND membership.permissions = personal_workspace_owner_permissions());
  SELECT * INTO shared_access
  FROM workspace_memberships membership
  WHERE membership.account_id = creation.account_id
    AND membership.workspace_id = creation.shared_workspace_id
    AND membership.subject_id = creation.actor_subject_id
  FOR KEY SHARE;
  IF personal_workspace.id IS NULL
    OR shared_workspace.id IS NULL
    OR shared_access.id IS NULL
    OR workspace_count <> 2
    OR workspace_control_count <> 2
    OR workspace_membership_count <> 1
    OR personal_workspace.name IS DISTINCT FROM 'Personal workspace'
    OR personal_workspace.slug IS NOT NULL
    OR personal_workspace.external_source IS DISTINCT FROM
      'opengeni:organization-membership'
    OR personal_workspace.external_id IS DISTINCT FROM
      creation.account_id::text || ':' || creation.actor_subject_id
    OR shared_workspace.name IS DISTINCT FROM creation.workspace_name
    OR shared_workspace.slug IS NOT NULL
    OR shared_workspace.external_source IS DISTINCT FROM
      'opengeni:additional-organization-default'
    OR shared_workspace.external_id IS DISTINCT FROM creation.account_id::text
    OR shared_access.role IS DISTINCT FROM 'admin'
    OR shared_access.permissions IS DISTINCT FROM
      opengeni_private.workspace_member_role_permissions('admin')
  THEN
    RAISE EXCEPTION 'additional organization workspace graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  graph_evidence_value := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'additional_organization_with_first_shared_workspace',
    'accountId', creation.account_id,
    'operationId', creation.operation_id,
    'actorSubjectId', creation.actor_subject_id,
    'organizationMembershipId', creation.organization_membership_id,
    'personalWorkspaceId', creation.personal_workspace_id,
    'sharedWorkspaceId', creation.shared_workspace_id,
    'organizationMembershipCount', organization_membership_count,
    'workspaceCount', workspace_count,
    'workspaceControlCount', workspace_control_count,
    'workspaceMembershipCount', workspace_membership_count
  );
  graph_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    graph_evidence_value::text, 'UTF8'
  )), 'hex');

  -- The exact graph is locked before the same deployment-wide fence used by
  -- operator and first-signup activation. A creation that wins the fence stays
  -- operator-managed; one after the first product witness activates atomically.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );

  SELECT * INTO existing_evidence
  FROM session_tenancy_additional_organization_activation_evidence evidence
  WHERE evidence.account_id = creation.account_id;
  IF FOUND THEN
    IF existing_evidence.creation_operation_id IS DISTINCT FROM creation.operation_id
      OR existing_evidence.actor_subject_id IS DISTINCT FROM creation.actor_subject_id
      OR existing_evidence.personal_workspace_id IS DISTINCT FROM creation.personal_workspace_id
      OR existing_evidence.shared_workspace_id IS DISTINCT FROM creation.shared_workspace_id
      OR existing_evidence.organization_membership_id
        IS DISTINCT FROM creation.organization_membership_id
      OR existing_evidence.graph_digest IS DISTINCT FROM graph_digest_value
    THEN
      RAISE EXCEPTION 'additional organization activation evidence conflicts with creation'
        USING ERRCODE = '23505';
    END IF;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN true;
  END IF;

  SELECT * INTO witness
  FROM session_tenancy_activations activation
  WHERE activation.account_id <> creation.account_id
  ORDER BY activation.activated_at, activation.account_id
  LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = creation.account_id
  ) OR EXISTS (
    SELECT 1 FROM organization_private_session_settings setting
    WHERE setting.account_id = creation.account_id
  ) THEN
    RAISE EXCEPTION 'additional organization session tenancy already exists without evidence'
      USING ERRCODE = '55000';
  END IF;

  parity_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'graphDigest', graph_digest_value,
      'boundaryWitnessAccountId', witness.account_id,
      'boundaryWitnessActivatedAt', witness.activated_at
    )::text,
    'UTF8'
  )), 'hex');

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
  );
  INSERT INTO session_tenancy_activations (
    account_id, activation_version, inventory_digest, parity_digest,
    activated_by, backfill_receipt_ids
  ) VALUES (
    creation.account_id, 1, graph_digest_value, parity_digest_value,
    'opengeni:additional-organization-creation:v1', ARRAY[]::uuid[]
  ) RETURNING * INTO inserted_activation;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (
    creation.account_id, true, 1, creation.organization_membership_id,
    inserted_activation.activated_at
  );
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    private_setting_event_id_value, creation.account_id,
    creation.organization_membership_id, true, 0, true, 1,
    inserted_activation.activated_at, true
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );
  INSERT INTO session_tenancy_additional_organization_activation_evidence (
    account_id, eligibility_version, creation_operation_id, actor_subject_id,
    personal_workspace_id, shared_workspace_id, organization_membership_id,
    boundary_witness_account_id, boundary_witness_activated_at,
    graph_evidence, graph_digest, activation_parity_digest,
    private_setting_version, private_setting_event_id, activated_at
  ) VALUES (
    creation.account_id, 1, creation.operation_id, creation.actor_subject_id,
    creation.personal_workspace_id, creation.shared_workspace_id,
    creation.organization_membership_id, witness.account_id, witness.activated_at,
    graph_evidence_value, graph_digest_value, parity_digest_value,
    1, private_setting_event_id_value, inserted_activation.activated_at
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.check_organization_tenancy_parity_pre_0340(p_organization_id uuid, p_evidence_limit integer DEFAULT 10, p_observation_window_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  result jsonb;
  evidence_limit integer := least(greatest(coalesce(p_evidence_limit, 10), 0), 50);
  window_days integer := least(greatest(coalesce(p_observation_window_days, 30), 1), 365);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy parity check requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy parity scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_parity_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  WITH gate_catalog(gate_id) AS (
    VALUES
      ('membership_personal_workspace_pointer'::text),
      ('membership_personal_workspace_exclusive'),
      ('membership_personal_workspace_same_organization'),
      ('personal_workspace_has_no_membership_row'),
      ('authority_resource_single_owner'),
      ('grant_delegation_fence_complete'),
      ('grant_owner_membership_active'),
      ('grant_authority_live'),
      ('grant_session_fence_not_ahead'),
      ('session_owner_provenance_paired'),
      ('session_owner_subject_matches_membership'),
      ('session_owner_membership_same_organization'),
      ('login_binding_dispute_propagated'),
      ('identity_active_binding_owned'),
      ('user_scoped_resource_live_anchor')
  ),
  -- Canonical human identities are organization-INDEPENDENT by design, so an
  -- organization-scoped parity report may only inspect the identities that
  -- actually anchor a subject of THIS organization. `user:<auth_user_id>` is
  -- the canonical subject encoding used by organization_memberships.
  scoped_identities AS (
    SELECT DISTINCT identity_subject.identity_id
    FROM canonical_human_identity_subjects identity_subject
    JOIN organization_memberships membership
      ON membership.account_id = p_organization_id
     AND membership.subject_id = 'user:' || identity_subject.auth_user_id
  ),
  violations(gate_id, evidence_id) AS (
    -- An active membership must identify a personal workspace.
    SELECT 'membership_personal_workspace_pointer'::text, membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.status = 'active'
      AND membership.personal_workspace_id IS NULL

    UNION ALL
    -- A personal workspace may identify at most one organization membership.
    SELECT 'membership_personal_workspace_exclusive', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = p_organization_id
          AND other.id <> membership.id
          AND other.personal_workspace_id = membership.personal_workspace_id
      )

    UNION ALL
    -- The personal workspace must belong to the same organization.
    SELECT 'membership_personal_workspace_same_organization', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces workspace
        WHERE workspace.id = membership.personal_workspace_id
          AND workspace.account_id = p_organization_id
      )

    UNION ALL
    -- A managed personal workspace's only workspace_memberships row is its
    -- active owner's own (1231): role member and exactly the owner's
    -- permissions. Any other row - another subject's, an administering one, or
    -- one left behind after the owner's membership stopped being active - is
    -- how membership CRUD and the subject-membership fallback would widen it.
    -- Evidence is the workspace id.
    SELECT DISTINCT 'personal_workspace_has_no_membership_row',
      membership.personal_workspace_id
    FROM organization_memberships membership
    JOIN workspace_memberships workspace_membership
      ON workspace_membership.account_id = p_organization_id
     AND workspace_membership.workspace_id = membership.personal_workspace_id
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND NOT (workspace_membership.subject_id = membership.subject_id
        AND membership.subject_id LIKE 'user:%'
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND workspace_membership.role = 'member'
        AND workspace_membership.permissions
          = personal_workspace_owner_permissions())

    UNION ALL
    -- Stable authority uniqueness. The physical unique index is per
    -- (account, membership, kind, resource), so two DIFFERENT memberships can
    -- still claim the same resource - the ambiguity that must never be
    -- resolved toward either user.
    SELECT 'authority_resource_single_owner', authority.id
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_organization_id
      AND authority.status <> 'revoked'
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities rival
        WHERE rival.account_id = p_organization_id
          AND rival.status <> 'revoked'
          AND rival.resource_kind = authority.resource_kind
          AND rival.resource_id = authority.resource_id
          AND rival.organization_membership_id
            <> authority.organization_membership_id
      )

    UNION ALL
    -- Zero partial delegations: `always` carries neither fence, once/session
    -- carry both.
    SELECT 'grant_delegation_fence_complete', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    WHERE resource_grant.account_id = p_organization_id
      AND NOT (
        (resource_grant.mode = 'always'
          AND resource_grant.session_id IS NULL
          AND resource_grant.authority_epoch IS NULL)
        OR (resource_grant.mode IN ('once', 'session')
          AND resource_grant.session_id IS NOT NULL
          AND resource_grant.authority_epoch IS NOT NULL
          AND resource_grant.authority_epoch > 0)
      )

    UNION ALL
    -- A live personal delegation owned by a human whose organization
    -- membership is suspended or revoked is a fallback to user authority.
    -- Suspension revokes personal-resource grants and offboarding runs the
    -- same teardown, so the drained state is the normal one.
    SELECT 'grant_owner_membership_active', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_memberships membership
      ON membership.id = resource_grant.owner_organization_membership_id
     AND membership.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND membership.status <> 'active'

    UNION ALL
    -- An active grant over a revoked authority.
    SELECT 'grant_authority_live', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_user_resource_authorities authority
      ON authority.id = resource_grant.authority_id
     AND authority.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND authority.status = 'revoked'

    UNION ALL
    -- A session-fenced grant whose epoch is AHEAD of the session it fences
    -- would survive the epoch advance that is supposed to revoke it. Epochs
    -- are monotonic and the fence is copied from the session at issuance, so
    -- `grant.authority_epoch <= session.authority_epoch` always holds.
    SELECT 'grant_session_fence_not_ahead', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN sessions session_row
      ON session_row.id = resource_grant.session_id
     AND session_row.workspace_id = resource_grant.workspace_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.session_id IS NOT NULL
      AND resource_grant.authority_epoch > session_row.authority_epoch

    UNION ALL
    -- Session owner provenance is paired, and a user_private session always
    -- has an owner.
    SELECT 'session_owner_provenance_paired', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND (
        (session_row.owner_organization_membership_id IS NULL)
          <> (session_row.owner_subject_id IS NULL)
        OR (session_row.visibility = 'user_private'
          AND session_row.owner_organization_membership_id IS NULL)
      )

    UNION ALL
    -- The denormalized owner subject must still name the owning membership.
    SELECT 'session_owner_subject_matches_membership', session_row.id
    FROM sessions session_row
    JOIN organization_memberships membership
      ON membership.id = session_row.owner_organization_membership_id
     AND membership.account_id = session_row.account_id
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_subject_id IS DISTINCT FROM membership.subject_id

    UNION ALL
    -- The owning membership must exist in this organization.
    SELECT 'session_owner_membership_same_organization', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = session_row.owner_organization_membership_id
          AND membership.account_id = p_organization_id
      )

    UNION ALL
    -- Provider-account collision rule: the physical unique index makes a
    -- second binding for one (provider, provider_account) impossible, so the
    -- collision is recorded by DISPUTING the existing binding and BOTH
    -- identities. A disputed binding whose identity is still usable is a
    -- collision that never fenced its identity.
    SELECT 'login_binding_dispute_propagated', binding.id
    FROM canonical_human_login_bindings binding
    JOIN scoped_identities scoped ON scoped.identity_id = binding.identity_id
    JOIN canonical_human_identities identity ON identity.id = binding.identity_id
    WHERE binding.status = 'disputed'
      AND identity.status <> 'disputed'

    UNION ALL
    -- The FK on active_login_binding_id proves existence, never ownership.
    SELECT 'identity_active_binding_owned', identity.id
    FROM canonical_human_identities identity
    JOIN scoped_identities scoped ON scoped.identity_id = identity.id
    WHERE identity.active_login_binding_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM canonical_human_login_bindings binding
        WHERE binding.id = identity.active_login_binding_id
          AND binding.identity_id = identity.id
      )

    UNION ALL
    -- Shadow comparison, connections lane: legacy effective scope is
    -- workspace; the proposed effective scope is `user`. A row claiming user
    -- authority without a live authority AND a live owning membership has no
    -- reachable user resolution - it must fall back to workspace or deny.
    SELECT 'user_scoped_resource_live_anchor', connection_row.id
    FROM connections connection_row
    WHERE connection_row.account_id = p_organization_id
      AND connection_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = connection_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.account_id = p_organization_id
      AND variable_set.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = variable_set.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', rig_row.id
    FROM rigs rig_row
    WHERE rig_row.account_id = p_organization_id
      AND rig_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = rig_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', enrollment.id
    FROM enrollments enrollment
    WHERE enrollment.account_id = p_organization_id
      AND enrollment.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = enrollment.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    -- Documents carry the same claim as authority_kind='personal' WITH a
    -- non-null authority_id (a null authority_id there is the separate,
    -- deliberately bounded legacy lane reported under `lanes`).
    SELECT 'user_scoped_resource_live_anchor', document.id
    FROM documents document
    WHERE document.account_id = p_organization_id
      AND document.authority_kind = 'personal'
      AND document.authority_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = document.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )
  ),
  aggregated AS (
    SELECT
      violation.gate_id,
      count(*)::int AS violation_count,
      (pg_catalog.array_agg(
        violation.evidence_id ORDER BY violation.evidence_id
      ))[1:evidence_limit] AS evidence
    FROM violations violation
    GROUP BY violation.gate_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'evidenceLimit', evidence_limit,
    'observationWindowDays', window_days,
    'gates', (
      SELECT pg_catalog.jsonb_object_agg(
        catalog.gate_id,
        pg_catalog.jsonb_build_object(
          'violations', coalesce(aggregated.violation_count, 0),
          'evidence', pg_catalog.to_jsonb(
            coalesce(aggregated.evidence, ARRAY[]::uuid[])
          ),
          'truncated', coalesce(aggregated.violation_count, 0)
            > coalesce(pg_catalog.array_length(aggregated.evidence, 1), 0)
        )
      )
      FROM gate_catalog catalog
      LEFT JOIN aggregated ON aggregated.gate_id = catalog.gate_id
    ),
    -- Compatibility lanes. These are populations the phase-D backfill drains;
    -- they are NOT invariant violations and must never be read as such.
    'lanes', pg_catalog.jsonb_build_object(
      'connectionsLegacyUser', (
        SELECT count(*)::int FROM connections connection_row
        WHERE connection_row.account_id = p_organization_id
          AND connection_row.authority_scope = 'legacy_user'
      ),
      -- Workspace-writer admissions and retained processes are immutable
      -- history: they are settled by UPDATE, nothing in the tree DELETEs them,
      -- and 0277's one-shot backfill only reached rows whose actor was a turn
      -- (`actor_kind`/`owner_actor_kind` = 'turn'), so every pre-0277 `direct:`
      -- or `process:` admission keeps the legacy_unattributed sentinel
      -- permanently. An all-time count of them therefore can never drain, and
      -- marking it drainable would make cutoverReady structurally unreachable
      -- for any deployment carrying one. Same treatment as the connection-use
      -- lane below: report the bounded recent window, where zero IS reachable
      -- and the honest signal is "the lane stopped being exercised".
      'workspaceWriterAdmissionsLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_workspace_mutation_admissions admission
        WHERE admission.account_id = p_organization_id
          AND admission.initiator_kind = 'legacy_unattributed'
          AND admission.admitted_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'workspaceWriterProcessesLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_retained_processes retained_process
        WHERE retained_process.account_id = p_organization_id
          AND retained_process.initiator_kind = 'legacy_unattributed'
          AND retained_process.started_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'documentsLegacyPersonalNullAuthority', (
        SELECT count(*)::int FROM documents document
        WHERE document.account_id = p_organization_id
          AND document.authority_kind = 'personal'
          AND document.authority_id IS NULL
      ),
      'codexCredentialsUnattributedConnector', (
        SELECT count(*)::int FROM codex_subscription_credentials credential
        WHERE credential.account_id = p_organization_id
          AND credential.connected_by_subject_id IS NULL
      ),
      'workspaceMemberSubjectsWithoutMembershipAnchor', (
        SELECT count(DISTINCT workspace_membership.subject_id)::int
        FROM workspace_memberships workspace_membership
        JOIN workspaces workspace ON workspace.id = workspace_membership.workspace_id
        WHERE workspace.account_id = p_organization_id
          AND workspace_membership.subject_id LIKE 'user:%'
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = workspace_membership.subject_id
          )
      ),
      -- The DRAINABLE refinement of "ownerless sessions": a session whose
      -- creating subject would be attributed by today's write fence but whose
      -- owner is still null. Total ownerlessness is deliberately NOT reported
      -- as drainable - a service/API-key session is permanently ownerless.
      'sessionsAttributableButUnattributed', (
        SELECT count(*)::int FROM sessions session_row
        WHERE session_row.account_id = p_organization_id
          AND session_row.owner_organization_membership_id IS NULL
          AND session_row.created_by_kind = 'subject'
          AND session_row.created_by_subject_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = session_row.created_by_subject_id
              AND membership.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_organization_id
              AND workspace_membership.workspace_id = session_row.workspace_id
              AND workspace_membership.subject_id = session_row.created_by_subject_id
          )
      ),
      -- Connection-use audit facts are immutable history, so the all-time
      -- count can never drain. The reachable-zero signal is "was the bounded
      -- pre-snapshot/legacy resolution lane exercised inside the observation
      -- window".
      'connectionUseLegacyResolutionsInWindow', (
        SELECT count(*)::int FROM connection_use_audit_facts audit_fact
        WHERE audit_fact.account_id = p_organization_id
          AND audit_fact.authority_scope = 'legacy_user'
          AND audit_fact.occurred_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$function$;

COMMENT ON FUNCTION ensure_managed_human_personal_workspace(p_account_id uuid, p_subject_id text, p_personal_workspace_id uuid) IS 'Lifecycle-only managed or explicit local-human organization membership and personal-workspace provisioning; grants no workspace access beyond the managed owner''s own Personal workspace row (1231).';

-- Restore the redefined definers' exact original search paths in the
-- migration's own schema (the baseline wrote them with its schema placeholder).
DO $paths$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.ensure_managed_human_personal_workspace(uuid, text, uuid) '
    'SET search_path = %I, pg_catalog', current_schema(), current_schema());
  EXECUTE format('ALTER FUNCTION %I.activate_greenfield_session_tenancy_from_setup(text) '
    'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema(), current_schema());
  EXECUTE format('ALTER FUNCTION %I.activate_session_tenancy_from_additional_organization(uuid) '
    'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema(), current_schema());
END
$paths$;
