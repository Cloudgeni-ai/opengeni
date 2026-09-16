-- deployment-mode: rolling
-- Organization administrators may configure the product gate with a live
-- organization key. This grants no access to private session contents.
-- Existing human command receipts and replay semantics remain valid.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_private_session_setting_events
  ALTER COLUMN actor_membership_id DROP NOT NULL,
  ADD COLUMN actor_subject_id text,
  ADD CONSTRAINT organization_private_session_setting_events_actor_check CHECK (
    actor_membership_id IS NOT NULL OR
    (actor_subject_id IS NOT NULL AND actor_subject_id LIKE 'api_key:%')
  );

-- Share the existing live administrator fence, not its policy-specific name.
-- The authenticated API caller establishes provenance; this is a live DB fence.
CREATE FUNCTION opengeni_private.assert_organization_administrator(
  p_account uuid, p_actor text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  permissions_value jsonb;
  member_id uuid;
BEGIN
  IF p_account IS NULL OR p_actor IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'organization administration scope invalid' USING ERRCODE = '42501';
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
REVOKE ALL ON FUNCTION opengeni_private.assert_organization_administrator(uuid,text) FROM PUBLIC;
-- Replace in place to preserve existing runtime EXECUTE grants during rollout.
CREATE OR REPLACE FUNCTION opengeni_private.assert_organization_integration_policy_administrator(
  p_account uuid, p_actor text
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
  SELECT opengeni_private.assert_organization_administrator(p_account, p_actor)
$body$;

CREATE OR REPLACE FUNCTION get_organization_private_session_settings(
  p_account_id uuid, p_actor_subject_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  setting organization_private_session_settings%ROWTYPE;
  account_created_at timestamptz;
BEGIN
  PERFORM opengeni_private.assert_organization_administrator(p_account_id, p_actor_subject_id);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_private_session_settings', true);
  SELECT created_at INTO account_created_at FROM managed_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO setting FROM organization_private_session_settings WHERE account_id = p_account_id;
  RETURN jsonb_build_object(
    'organizationId', p_account_id,
    'enabled', coalesce(setting.enabled, false),
    'available', session_tenancy_product_activated(p_account_id, 1),
    'version', coalesce(setting.version, 0),
    'updatedAt', coalesce(setting.updated_at, account_created_at)
  );
END $body$;

CREATE OR REPLACE FUNCTION update_organization_private_session_settings(
  p_account_id uuid, p_actor_subject_id text, p_enabled boolean,
  p_expected_version bigint, p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  actor_id uuid;
  setting organization_private_session_settings%ROWTYPE;
  prior organization_private_session_setting_events%ROWTYPE;
  next_version bigint;
  did_change boolean;
BEGIN
  IF p_account_id IS NULL OR p_enabled IS NULL OR p_operation_id IS NULL
    OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization private-session settings request is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_private_session_settings', true);
  PERFORM 1 FROM managed_accounts WHERE id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  -- Revoked/expired keys cannot replay old successful commands.
  PERFORM opengeni_private.assert_organization_administrator(p_account_id, p_actor_subject_id);
  SELECT id INTO actor_id FROM organization_memberships
    WHERE account_id = p_account_id AND subject_id = p_actor_subject_id;
  SELECT * INTO prior FROM organization_private_session_setting_events WHERE id = p_operation_id;
  IF FOUND THEN
    IF prior.account_id IS DISTINCT FROM p_account_id
      OR prior.actor_membership_id IS DISTINCT FROM actor_id
      OR (prior.actor_subject_id IS NOT NULL AND prior.actor_subject_id IS DISTINCT FROM p_actor_subject_id)
      OR prior.requested_enabled IS DISTINCT FROM p_enabled
      OR prior.expected_version IS DISTINCT FROM p_expected_version
    THEN
      RAISE EXCEPTION 'organization private-session operation key was reused' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'organizationId', p_account_id, 'enabled', prior.result_enabled,
      'available', session_tenancy_product_activated(p_account_id, 1),
      'version', prior.result_version, 'updatedAt', prior.result_updated_at, 'changed', prior.changed
    );
  END IF;
  SELECT * INTO setting FROM organization_private_session_settings WHERE account_id = p_account_id FOR UPDATE;
  IF coalesce(setting.version, 0) IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'organization private-session settings changed before update' USING ERRCODE = '40001';
  END IF;
  IF p_enabled AND NOT session_tenancy_product_activated(p_account_id, 1) THEN
    RAISE EXCEPTION 'session tenancy product surface is not available for this organization' USING ERRCODE = '55000';
  END IF;
  did_change := coalesce(setting.enabled, false) IS DISTINCT FROM p_enabled;
  next_version := CASE WHEN setting.account_id IS NULL THEN 1 ELSE setting.version + 1 END;
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (p_account_id, p_enabled, next_version, actor_id, clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE SET
    enabled = excluded.enabled, version = excluded.version,
    updated_by_membership_id = excluded.updated_by_membership_id, updated_at = excluded.updated_at
  RETURNING * INTO setting;
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, actor_subject_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    p_operation_id, p_account_id, actor_id, p_actor_subject_id, p_enabled,
    p_expected_version, setting.enabled, setting.version, setting.updated_at, did_change
  );
  RETURN jsonb_build_object(
    'organizationId', p_account_id, 'enabled', setting.enabled,
    'available', session_tenancy_product_activated(p_account_id, 1),
    'version', setting.version, 'updatedAt', setting.updated_at, 'changed', did_change
  );
END $body$;

DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.assert_organization_administrator(uuid,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.assert_organization_integration_policy_administrator(uuid,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION get_organization_private_session_settings(uuid,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION update_organization_private_session_settings(uuid,text,boolean,bigint,uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;