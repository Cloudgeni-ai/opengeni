-- deployment-mode: rolling
-- Opt-in external service operations reuse the native workspace receipt ledger
-- and membership-removal protocol. Unkeyed in-flight grants cannot be fenced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_workspace_lifecycle_events
  ALTER COLUMN actor_membership_id DROP NOT NULL,
  ADD COLUMN actor_service_subject text,
  ADD CONSTRAINT organization_workspace_lifecycle_actor_check CHECK (
    (actor_membership_id IS NOT NULL AND actor_service_subject IS NULL)
    OR (actor_membership_id IS NULL AND actor_service_subject IS NOT NULL AND actor_service_subject ~ '^api_key:[0-9a-f-]{36}$')
  );
CREATE INDEX organization_workspace_cancelled_grant_idx
  ON organization_workspace_operation_receipts (account_id, (result ->> 'fencedGrantOperationId'))
  WHERE action = 'revoke' AND result ? 'fencedGrantOperationId';

-- Authentication is performed by the API. This is its live commit-time fence,
-- not permission to derive an actor from request JSON.
CREATE FUNCTION opengeni_private.external_workspace_service_permissions(p_account uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE permissions_value jsonb;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor IS NULL OR p_actor IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'external workspace service scope invalid' USING ERRCODE = '42501'; END IF;
  SELECT k.permissions INTO permissions_value FROM api_keys k
  WHERE k.account_id = p_account AND 'api_key:' || k.id::text = p_actor
    AND k.credential_kind = 'organization' AND k.workspace_id IS NULL
    AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp())
  FOR SHARE;
  IF NOT coalesce(permissions_value ?| ARRAY['members:manage', 'workspace:admin'], false)
  THEN RAISE EXCEPTION 'external workspace service administration required' USING ERRCODE = '42501'; END IF;
  RETURN permissions_value;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.external_workspace_service_permissions(uuid,text) FROM PUBLIC;

CREATE FUNCTION lookup_external_identity(p_account uuid, p_actor text, p_source text, p_external_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE result jsonb; previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  PERFORM opengeni_private.external_workspace_service_permissions(p_account, p_actor);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  SELECT jsonb_build_object('found', true, 'subjectId', i.subject_id,
    'organizationMembershipId', m.id, 'identityStatus', i.status,
    'identityAuthorizationRevision', i.authorization_revision,
    'membershipStatus', m.status, 'membershipAuthorizationRevision', m.authorization_revision)
  INTO result FROM external_identities i JOIN organization_memberships m
    ON m.account_id = i.account_id AND m.id = i.organization_membership_id AND m.subject_id = i.subject_id
  WHERE i.account_id = p_account AND i.source = p_source AND i.external_id = p_external_id;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN coalesce(result, '{"found":false}'::jsonb);
END $body$;
REVOKE ALL ON FUNCTION lookup_external_identity(uuid,text,text,text) FROM PUBLIC;

-- Both preparation and recording run in the caller's ONE open transaction.
-- The same organization prefix serializes unstarted grants with cancellation.
CREATE FUNCTION prepare_external_workspace_membership_operation(p_command jsonb)
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
    OR action_value IS NULL OR action_value NOT IN ('grant','revoke')
    OR (action_value = 'revoke' AND (cancelled_value IS NULL OR cancelled_value = operation_value))
    OR (action_value = 'grant' AND cancelled_value IS NOT NULL)
  THEN RAISE EXCEPTION 'invalid external workspace operation' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || account_value::text, 0));
  service_permissions := opengeni_private.external_workspace_service_permissions(account_value, actor_value);
  IF action_value = 'grant' AND (jsonb_typeof(p_command -> 'permissions') IS DISTINCT FROM 'array'
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
    SELECT * INTO prior FROM organization_workspace_operation_receipts
      WHERE account_id = account_value AND operation_id = cancelled_value;
    IF FOUND AND (prior.action <> 'grant' OR prior.result ->> 'workspaceId' IS DISTINCT FROM workspace_value::text
      OR prior.result #>> '{identity,organizationMembershipId}' IS DISTINCT FROM identity_value ->> 'organizationMembershipId')
    THEN RAISE EXCEPTION 'cancelled operation target mismatch' USING ERRCODE = '23505'; END IF;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN jsonb_build_object('replay', false, 'identity', identity_value);
END $body$;
REVOKE ALL ON FUNCTION prepare_external_workspace_membership_operation(jsonb) FROM PUBLIC;

CREATE FUNCTION record_external_workspace_membership_operation(p_command jsonb, p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE prepared jsonb; subject_value text; member_value uuid; hash_value text;
  account_value uuid := (p_command ->> 'organizationId')::uuid;
  workspace_value uuid := (p_command ->> 'workspaceId')::uuid;
  action_value text := p_command ->> 'action';
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  prepared := prepare_external_workspace_membership_operation(p_command);
  IF (prepared ->> 'replay')::boolean THEN RAISE EXCEPTION 'operation already recorded' USING ERRCODE = '23505'; END IF;
  subject_value := prepared #>> '{identity,subjectId}';
  IF action_value = 'grant' AND p_result -> 'identity' IS DISTINCT FROM prepared -> 'identity'
  THEN RAISE EXCEPTION 'grant receipt identity mismatch' USING ERRCODE = '55000'; END IF;
  IF p_result ->> 'workspaceId' IS DISTINCT FROM workspace_value::text
    OR (action_value = 'revoke' AND p_result ->> 'fencedGrantOperationId' IS DISTINCT FROM p_command ->> 'cancelGrantOperationId')
  THEN RAISE EXCEPTION 'operation receipt scope mismatch' USING ERRCODE = '55000'; END IF;
  SELECT id INTO member_value FROM workspace_memberships
    WHERE account_id = account_value AND workspace_id = workspace_value AND subject_id = subject_value;
  IF (action_value = 'grant' AND member_value IS NULL) OR (action_value = 'revoke' AND member_value IS NOT NULL)
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
END $body$;
REVOKE ALL ON FUNCTION record_external_workspace_membership_operation(jsonb,jsonb) FROM PUBLIC;

DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT grantee FROM information_schema.routine_privileges
    WHERE routine_schema = current_schema() AND routine_name = 'ensure_external_identity'
      AND grantee <> 'PUBLIC' AND privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION lookup_external_identity(uuid,text,text,text), prepare_external_workspace_membership_operation(jsonb), record_external_workspace_membership_operation(jsonb,jsonb) TO %I', target_role.grantee);
  END LOOP;
END $acl$;