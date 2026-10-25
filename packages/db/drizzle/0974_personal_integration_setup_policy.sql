-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the policy table holds at most one row per organization, so checking it is instant
-- Members holding the personal setup permission (connections:personal, which
-- connections:write includes) may turn on a reviewed OAuth integration for
-- personal accounts. This adds the organization's choice to reserve that for
-- integration admins.
--
-- 1. organization_integration_policies.personal_integration_setup, 'members'
--    by default (constant default: no table rewrite; the table has one row
--    per organization at most).
-- 2. update_organization_integration_policy accepts an optional
--    personalIntegrationSetup key. Omitted keeps the stored value, and the
--    returned result names the key only when the request did, so the
--    previous release (which never sends it and parses the result strictly)
--    keeps working. Everything else restates 0470 exactly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_integration_policies
  ADD COLUMN personal_integration_setup text NOT NULL DEFAULT 'members'
    CONSTRAINT organization_integration_policies_personal_setup_check
    CHECK (personal_integration_setup IN ('members', 'admins'));

CREATE OR REPLACE FUNCTION opengeni_private.update_organization_integration_policy(
  p_account uuid, p_actor text, p_request jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  prior organization_integration_policy_operations%ROWTYPE;
  current_revision bigint; expected_revision bigint; operation_value uuid; result_value jsonb;
  personal_value text;
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
    OR (p_request ? 'personalIntegrationSetup' AND (
      jsonb_typeof(p_request -> 'personalIntegrationSetup') IS DISTINCT FROM 'string'
      OR p_request ->> 'personalIntegrationSetup' NOT IN ('members', 'admins')))
    OR p_request - ARRAY['mode','allowedIntegrationKeys','personalIntegrationSetup','expectedRevision','operationId'] <> '{}'::jsonb THEN
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
  SELECT revision, personal_integration_setup INTO current_revision, personal_value
    FROM organization_integration_policies WHERE account_id = p_account;
  IF coalesce(current_revision, 0) <> expected_revision THEN
    RAISE EXCEPTION 'integration policy revision conflict' USING ERRCODE = '40001';
  END IF;
  personal_value := coalesce(p_request ->> 'personalIntegrationSetup', personal_value, 'members');
  result_value := jsonb_build_object('mode', p_request -> 'mode', 'allowedIntegrationKeys', p_request -> 'allowedIntegrationKeys', 'revision', expected_revision + 1);
  IF p_request ? 'personalIntegrationSetup' THEN
    result_value := result_value || jsonb_build_object('personalIntegrationSetup', personal_value);
  END IF;
  INSERT INTO organization_integration_policies (account_id, mode, allowed_integration_keys, personal_integration_setup, revision)
    VALUES (p_account, p_request ->> 'mode', p_request -> 'allowedIntegrationKeys', personal_value, expected_revision + 1)
    ON CONFLICT (account_id) DO UPDATE SET mode = excluded.mode,
      allowed_integration_keys = excluded.allowed_integration_keys,
      personal_integration_setup = excluded.personal_integration_setup,
      revision = excluded.revision;
  INSERT INTO organization_integration_policy_operations (account_id, operation_id, actor_subject_id, request, result)
    VALUES (p_account, operation_value, p_actor, p_request, result_value);
  RETURN result_value;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.update_organization_integration_policy(uuid,text,jsonb) FROM PUBLIC;
-- Explicit pg_temp LAST prevents temporary relation shadowing in the definer.
DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.update_organization_integration_policy(uuid,text,jsonb) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;
