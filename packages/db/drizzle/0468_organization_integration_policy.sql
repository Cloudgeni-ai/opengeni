-- deployment-mode: maintenance
-- Foundation only: new binaries must opt acquisition writers into the guard.
-- The runtime table/grant contract changes; old processes must be drained.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'integration policy migration requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
    OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'integration policy migration requires valid stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

CREATE TABLE organization_integration_policies (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('unrestricted', 'restricted')),
  allowed_integration_keys jsonb NOT NULL CHECK (jsonb_typeof(allowed_integration_keys) = 'array'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE organization_integration_policy_operations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (account_id, operation_id)
);
ALTER TABLE organization_integration_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_integration_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_integration_policy_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_integration_policy_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON organization_integration_policies, organization_integration_policy_operations FROM PUBLIC;
CREATE POLICY organization_integration_policy_account ON organization_integration_policies
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
CREATE POLICY organization_integration_policy_operation_account ON organization_integration_policy_operations
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());

-- This is a live fence, not authentication. The application must verify canonical
-- administrator provenance before selecting the subject, including on replay.
CREATE FUNCTION opengeni_private.assert_organization_integration_policy_administrator(
  p_account uuid, p_actor text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  permissions_value jsonb; member_id uuid;
BEGIN
  IF p_account IS NULL OR p_actor IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'integration policy scope invalid' USING ERRCODE = '42501';
  END IF;
  IF p_actor LIKE 'api_key:%' THEN
    SELECT permissions INTO permissions_value FROM api_keys
      WHERE account_id = p_account AND 'api_key:' || id::text = p_actor
        AND credential_kind = 'organization' AND workspace_id IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR SHARE;
    IF NOT coalesce(permissions_value ? 'workspace:admin', false) THEN
      RAISE EXCEPTION 'organization administrator required' USING ERRCODE = '42501';
    END IF;
  ELSE
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_private_session_settings', true);
    SELECT id INTO member_id FROM organization_memberships
      WHERE account_id = p_account AND subject_id = p_actor AND status = 'active' AND role IN ('owner','admin') FOR SHARE;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
    IF member_id IS NULL THEN RAISE EXCEPTION 'organization administrator required' USING ERRCODE = '42501'; END IF;
  END IF;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.assert_organization_integration_policy_administrator(uuid,text) FROM PUBLIC;

CREATE FUNCTION opengeni_private.update_organization_integration_policy(
  p_account uuid, p_actor text, p_request jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  prior organization_integration_policy_operations%ROWTYPE;
  current_revision bigint; expected_revision bigint; operation_value uuid; result_value jsonb;
  policy_lock bigint := hashtextextended('organization-integration-policy:' || p_account::text, 0);
BEGIN
  IF p_account IS NULL OR p_actor IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'integration policy scope invalid' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR p_request ->> 'mode' IS NULL OR p_request ->> 'mode' NOT IN ('unrestricted', 'restricted')
    OR jsonb_typeof(p_request -> 'allowedIntegrationKeys') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_request -> 'expectedRevision') IS DISTINCT FROM 'number'
    OR coalesce(p_request ->> 'expectedRevision', '') !~ '^[0-9]+$'
    OR jsonb_typeof(p_request -> 'operationId') IS DISTINCT FROM 'string'
    OR p_request - ARRAY['mode','allowedIntegrationKeys','expectedRevision','operationId'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'integration policy request invalid' USING ERRCODE = '22023';
  END IF;
  expected_revision := (p_request ->> 'expectedRevision')::bigint;
  operation_value := (p_request ->> 'operationId')::uuid;
  IF expected_revision NOT BETWEEN 0 AND 9007199254740990
    OR jsonb_array_length(p_request -> 'allowedIntegrationKeys') > 10000
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_request -> 'allowedIntegrationKeys') k
      WHERE jsonb_typeof(k) <> 'string' OR length(k #>> '{}') NOT BETWEEN 1 AND 200
        OR k #>> '{}' !~ '^[a-z0-9][a-z0-9._:-]*$')
    OR (SELECT count(*) <> count(DISTINCT k) FROM jsonb_array_elements(p_request -> 'allowedIntegrationKeys') k) THEN
    RAISE EXCEPTION 'integration policy request invalid' USING ERRCODE = '22023';
  END IF;
  -- Never upgrade a shared acquisition fence: two upgrading acquisitions deadlock.
  -- This also detects a shared fence retained by a released nested savepoint.
  IF EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
    AND mode = 'ShareLock' AND granted AND objsubid = 1
    AND classid = ((policy_lock >> 32) & 4294967295)::oid
    AND objid = (policy_lock & 4294967295)::oid) THEN
    RAISE EXCEPTION 'policy mutation cannot upgrade an acquisition fence' USING ERRCODE = '55000';
  END IF;
  -- Policy BEFORE membership: acquisition callbacks such as personal OAuth take
  -- membership themselves. The inverse order cycles with their shared policy lock.
  -- No workspace row is required or locked by this organization-only operation.
  PERFORM pg_advisory_xact_lock(policy_lock);
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account::text, 0));
  PERFORM opengeni_private.assert_organization_integration_policy_administrator(p_account, p_actor);
  SELECT * INTO prior FROM organization_integration_policy_operations
    WHERE account_id = p_account AND operation_id = operation_value;
  IF FOUND THEN
    IF prior.actor_subject_id <> p_actor OR prior.request <> p_request THEN
      RAISE EXCEPTION 'integration policy operation reused' USING ERRCODE = '23505';
    END IF;
    RETURN prior.result;
  END IF;
  SELECT revision INTO current_revision FROM organization_integration_policies WHERE account_id = p_account;
  IF coalesce(current_revision, 0) <> expected_revision THEN
    RAISE EXCEPTION 'integration policy revision conflict' USING ERRCODE = '40001';
  END IF;
  result_value := jsonb_build_object('mode', p_request -> 'mode', 'allowedIntegrationKeys', p_request -> 'allowedIntegrationKeys', 'revision', expected_revision + 1);
  INSERT INTO organization_integration_policies (account_id, mode, allowed_integration_keys, revision)
    VALUES (p_account, p_request ->> 'mode', p_request -> 'allowedIntegrationKeys', expected_revision + 1)
    ON CONFLICT (account_id) DO UPDATE SET mode = excluded.mode,
      allowed_integration_keys = excluded.allowed_integration_keys, revision = excluded.revision;
  INSERT INTO organization_integration_policy_operations (account_id, operation_id, actor_subject_id, request, result)
    VALUES (p_account, operation_value, p_actor, p_request, result_value);
  RETURN result_value;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.update_organization_integration_policy(uuid,text,jsonb) FROM PUBLIC;
-- Explicit pg_temp LAST prevents temporary relation shadowing in the definer.
DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.update_organization_integration_policy(uuid,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.assert_organization_integration_policy_administrator(uuid,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;