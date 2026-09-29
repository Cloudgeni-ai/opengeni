-- deployment-mode: rolling
-- Keyed permission updates for an external member's shared-workspace access.
-- An organization service key can already grant (0464) and revoke an external
-- member, but changing permissions required a destructive revoke + re-grant.
-- `update` reuses the same receipt ledger, organization fence, service
-- authority check and exact-replay contract as `grant`:
--   * the request names the external organization membership and the complete
--     new permission set; it never creates or removes the workspace membership;
--   * widening only rewrites the permission set;
--   * narrowing also advances the member's organization authorization
--     revision, the existing lifecycle signal (as for an organization role
--     change) that live authority snapshots compare, so frozen personal
--     authority and identity links re-check on their next use. No session,
--     turn, attempt, schedule or process is cancelled or torn down.
-- Old binaries only send `grant`/`revoke`; those branches are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Constraint-only changes: every existing row already satisfies the widened
-- set, and VALIDATE sees all rows regardless of row-level security.
ALTER TABLE organization_workspace_operation_receipts
  DROP CONSTRAINT organization_workspace_operation_receipts_action_check,
  ADD CONSTRAINT organization_workspace_operation_receipts_action_check CHECK (
    action IN ('create', 'rename', 'grant', 'revoke', 'update')
  ) NOT VALID;
ALTER TABLE organization_workspace_operation_receipts
  VALIDATE CONSTRAINT organization_workspace_operation_receipts_action_check;
ALTER TABLE organization_workspace_lifecycle_events
  DROP CONSTRAINT organization_workspace_lifecycle_events_kind_check,
  ADD CONSTRAINT organization_workspace_lifecycle_events_kind_check CHECK (
    kind IN ('create', 'rename', 'grant', 'revoke', 'update')
  ) NOT VALID;
ALTER TABLE organization_workspace_lifecycle_events
  VALIDATE CONSTRAINT organization_workspace_lifecycle_events_kind_check;

CREATE OR REPLACE FUNCTION prepare_external_workspace_membership_operation(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  account_value uuid := (p_command ->> 'organizationId')::uuid;
  workspace_value uuid := (p_command ->> 'workspaceId')::uuid;
  operation_value uuid := (p_command ->> 'operationId')::uuid;
  actor_value text := p_command ->> 'actorSubjectId';
  action_value text := p_command ->> 'action';
  cancelled_value uuid := (p_command ->> 'cancelGrantOperationId')::uuid;
  service_permissions jsonb; identity_value jsonb; prior record; cancellation record;
  hash_value text; previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF account_value IS NULL OR workspace_value IS NULL OR operation_value IS NULL
    OR action_value IS NULL OR action_value NOT IN ('grant','revoke','update')
    OR (action_value = 'revoke' AND (cancelled_value IS NULL OR cancelled_value = operation_value))
    OR (action_value IN ('grant','update') AND cancelled_value IS NOT NULL)
    OR (action_value = 'update' AND (p_command ->> 'membershipId') IS NULL)
  THEN RAISE EXCEPTION 'invalid external workspace operation' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || account_value::text, 0));
  service_permissions := opengeni_private.external_workspace_service_permissions(account_value, actor_value);
  IF action_value IN ('grant','update') AND (jsonb_typeof(p_command -> 'permissions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_command -> 'permissions') = 0
    OR ((p_command -> 'permissions') ? 'secrets:read' AND NOT service_permissions ? 'secrets:read')
    OR (NOT service_permissions ? 'workspace:admin' AND NOT (p_command -> 'permissions') <@ service_permissions))
  THEN RAISE EXCEPTION 'external grant exceeds service authority' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM workspaces w WHERE w.account_id = account_value AND w.id = workspace_value FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF EXISTS (SELECT 1 FROM organization_memberships m WHERE m.account_id = account_value AND m.personal_workspace_id = workspace_value)
  THEN RAISE EXCEPTION 'personal workspace is not administrable' USING ERRCODE = '42501'; END IF;
  -- Credential identity is audit attribution, not the operation's semantic
  -- identity: an authorized replacement organization key may reconcile it.
  hash_value := encode(sha256(convert_to((p_command - 'actorSubjectId')::text, 'UTF8')), 'hex');
  SELECT * INTO prior FROM organization_workspace_operation_receipts
    WHERE account_id = account_value AND operation_id = operation_value;
  IF FOUND AND (prior.action <> action_value OR prior.input_hash <> hash_value)
  THEN RAISE EXCEPTION 'operation identity reused' USING ERRCODE = '23505'; END IF;
  IF action_value = 'grant' THEN
    SELECT * INTO cancellation FROM organization_workspace_operation_receipts
      WHERE account_id = account_value AND action = 'revoke'
        AND result ->> 'fencedGrantOperationId' = operation_value::text LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'external membership grant cancelled' USING ERRCODE = '55000'; END IF;
  END IF;
  IF prior.operation_id IS NOT NULL THEN
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
    RETURN jsonb_build_object('replay', true, 'result', prior.result);
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  IF action_value = 'grant' THEN
    identity_value := ensure_external_identity(account_value, p_command #>> '{identity,source}', p_command #>> '{identity,externalId}');
  ELSE
    SELECT jsonb_build_object('subjectId', i.subject_id, 'organizationMembershipId', i.organization_membership_id)
      INTO identity_value FROM external_identities i
      WHERE i.account_id = account_value AND i.organization_membership_id = (p_command ->> 'membershipId')::uuid;
    IF identity_value IS NULL THEN RAISE EXCEPTION 'external member not found' USING ERRCODE = 'P0002'; END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
    IF action_value = 'revoke' THEN
      SELECT * INTO prior FROM organization_workspace_operation_receipts
        WHERE account_id = account_value AND operation_id = cancelled_value;
      IF FOUND AND (prior.action <> 'grant' OR prior.result ->> 'workspaceId' IS DISTINCT FROM workspace_value::text
        OR prior.result #>> '{identity,organizationMembershipId}' IS DISTINCT FROM identity_value ->> 'organizationMembershipId')
      THEN RAISE EXCEPTION 'cancelled operation target mismatch' USING ERRCODE = '23505'; END IF;
    END IF;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN jsonb_build_object('replay', false, 'identity', identity_value);
END $body$;
REVOKE ALL ON FUNCTION prepare_external_workspace_membership_operation(jsonb) FROM PUBLIC;

-- `grant`/`revoke` verify effects the caller already applied. `update` applies
-- its own effect here, on the exact locked rows, so the narrowing decision and
-- the authorization-revision advance are derived from database truth and are
-- atomic with the receipt.
CREATE OR REPLACE FUNCTION record_external_workspace_membership_operation(p_command jsonb, p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE prepared jsonb; subject_value text; member_value uuid; hash_value text;
  account_value uuid := (p_command ->> 'organizationId')::uuid;
  workspace_value uuid := (p_command ->> 'workspaceId')::uuid;
  action_value text := p_command ->> 'action';
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  current_permissions jsonb; requested_permissions jsonb; narrowed_value boolean;
  membership_status_value text;
BEGIN
  prepared := prepare_external_workspace_membership_operation(p_command);
  IF (prepared ->> 'replay')::boolean THEN RAISE EXCEPTION 'operation already recorded' USING ERRCODE = '23505'; END IF;
  subject_value := prepared #>> '{identity,subjectId}';
  IF action_value = 'grant' AND p_result -> 'identity' IS DISTINCT FROM prepared -> 'identity'
  THEN RAISE EXCEPTION 'grant receipt identity mismatch' USING ERRCODE = '55000'; END IF;
  IF p_result ->> 'workspaceId' IS DISTINCT FROM workspace_value::text
    OR (action_value = 'revoke' AND p_result ->> 'fencedGrantOperationId' IS DISTINCT FROM p_command ->> 'cancelGrantOperationId')
  THEN RAISE EXCEPTION 'operation receipt scope mismatch' USING ERRCODE = '55000'; END IF;
  IF action_value = 'update' THEN
    IF p_result -> 'identity' IS DISTINCT FROM prepared -> 'identity'
    THEN RAISE EXCEPTION 'update receipt identity mismatch' USING ERRCODE = '55000'; END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
    SELECT m.status INTO membership_status_value FROM organization_memberships m
      WHERE m.account_id = account_value AND m.id = (prepared #>> '{identity,organizationMembershipId}')::uuid
        AND m.subject_id = subject_value
      FOR UPDATE;
    IF membership_status_value IS DISTINCT FROM 'active'
    THEN RAISE EXCEPTION 'external member is not active' USING ERRCODE = '55000'; END IF;
    SELECT id, permissions INTO member_value, current_permissions FROM workspace_memberships
      WHERE account_id = account_value AND workspace_id = workspace_value AND subject_id = subject_value
      FOR UPDATE;
    IF member_value IS NULL THEN RAISE EXCEPTION 'external workspace member not found' USING ERRCODE = 'P0002'; END IF;
    requested_permissions := p_command -> 'permissions';
    narrowed_value := EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(coalesce(current_permissions, '[]'::jsonb)) permission
      WHERE NOT requested_permissions ? permission
    );
    IF jsonb_typeof(p_result -> 'permissions') IS DISTINCT FROM 'array'
      OR NOT (p_result -> 'permissions') @> requested_permissions
      OR NOT requested_permissions @> (p_result -> 'permissions')
      OR (p_result ->> 'narrowed')::boolean IS DISTINCT FROM narrowed_value
    THEN RAISE EXCEPTION 'update receipt effect mismatch' USING ERRCODE = '55000'; END IF;
    UPDATE workspace_memberships SET permissions = requested_permissions, updated_at = clock_timestamp()
      WHERE id = member_value;
    IF narrowed_value THEN
      -- The existing lifecycle revision (also advanced by an organization role
      -- change). Its trigger mirrors the advance onto the external identity.
      UPDATE organization_memberships SET authorization_revision = authorization_revision + 1,
        updated_at = clock_timestamp()
      WHERE account_id = account_value AND id = (prepared #>> '{identity,organizationMembershipId}')::uuid;
    END IF;
  END IF;
  SELECT id INTO member_value FROM workspace_memberships
    WHERE account_id = account_value AND workspace_id = workspace_value AND subject_id = subject_value;
  IF (action_value IN ('grant','update') AND member_value IS NULL) OR (action_value = 'revoke' AND member_value IS NOT NULL)
  THEN RAISE EXCEPTION 'operation effects not settled' USING ERRCODE = '55000'; END IF;
  hash_value := encode(sha256(convert_to((p_command - 'actorSubjectId')::text, 'UTF8')), 'hex');
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  INSERT INTO organization_workspace_operation_receipts (account_id, operation_id, action, input_hash, result)
    VALUES (account_value, (p_command ->> 'operationId')::uuid, action_value, hash_value, p_result);
  INSERT INTO organization_workspace_lifecycle_events (account_id, operation_id, actor_service_subject,
    workspace_id, target_organization_membership_id, target_workspace_membership_id, kind, role)
    VALUES (account_value, (p_command ->> 'operationId')::uuid, p_command ->> 'actorSubjectId', workspace_value,
      (prepared #>> '{identity,organizationMembershipId}')::uuid, member_value, action_value,
      CASE WHEN action_value = 'grant' THEN 'member' ELSE NULL END);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RAISE;
END $body$;
REVOKE ALL ON FUNCTION record_external_workspace_membership_operation(jsonb,jsonb) FROM PUBLIC;
