-- deployment-mode: rolling
-- Adds the owner/admin product setting for organization-workspace Only-me
-- chats. The operator activation receipt remains a separate readiness fence;
-- personal workspaces are intrinsically private and do not require this
-- organization setting.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE session_spawn_denials
  ADD COLUMN organization_private_session_denial_reason text;
ALTER TABLE session_spawn_denials
  ADD CONSTRAINT session_spawn_denials_organization_private_reason_check CHECK (
    organization_private_session_denial_reason IS NULL
    OR organization_private_session_denial_reason = 'organization_private_sessions_disabled'
  );

CREATE TABLE organization_private_session_settings (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  updated_by_membership_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_private_session_settings_updater_fk
    FOREIGN KEY (updated_by_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_private_session_settings_version_check CHECK (version > 0)
);
ALTER TABLE organization_private_session_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_private_session_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_private_session_settings FROM PUBLIC;
CREATE POLICY organization_private_session_settings_lifecycle
  ON organization_private_session_settings
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_private_session_settings')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_private_session_settings');
CREATE POLICY organization_private_session_settings_scoped_read
  ON organization_private_session_settings
  FOR SELECT USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
  );

-- Organizations that completed the older operator activation already had the
-- product surface enabled. Preserve that behavior; only organizations activated
-- after this migration require an owner/admin product decision.
--
-- Both the source and target are FORCE-RLS tables. Production migrations run as
-- their NOSUPERUSER/NOBYPASSRLS owner with no tenant GUC, so the owner would
-- otherwise see zero activation rows and be unable to insert the compatibility
-- settings. The migration runner executes this file in one transaction: NO
-- FORCE relaxes only the owner, the application role remains policy-bound, and
-- any failed verification rolls the data and posture changes back together.
ALTER TABLE session_tenancy_activations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_private_session_settings NO FORCE ROW LEVEL SECURITY;
INSERT INTO organization_private_session_settings (
  account_id, enabled, version, updated_by_membership_id, updated_at
)
SELECT activation.account_id, true, 1, NULL, activation.activated_at
FROM session_tenancy_activations activation
ON CONFLICT (account_id) DO NOTHING;
DO $organization_private_session_compatibility_backfill$
DECLARE
  missing_enabled_settings bigint;
BEGIN
  SELECT count(*) INTO missing_enabled_settings
  FROM session_tenancy_activations activation
  LEFT JOIN organization_private_session_settings setting
    ON setting.account_id = activation.account_id
  WHERE setting.account_id IS NULL OR NOT setting.enabled;
  IF missing_enabled_settings > 0 THEN
    RAISE EXCEPTION
      'organization private-session compatibility backfill did not converge: % activated organization(s) remain disabled',
      missing_enabled_settings
      USING ERRCODE = '55000';
  END IF;
END
$organization_private_session_compatibility_backfill$;
ALTER TABLE organization_private_session_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE session_tenancy_activations FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_private_session_setting_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  actor_membership_id uuid NOT NULL,
  requested_enabled boolean NOT NULL,
  expected_version bigint NOT NULL,
  result_enabled boolean NOT NULL,
  result_version bigint NOT NULL,
  result_updated_at timestamptz NOT NULL,
  changed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_private_session_setting_events_actor_fk
    FOREIGN KEY (actor_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_private_session_setting_events_versions_check CHECK (
    expected_version >= 0 AND result_version > 0
  )
);
ALTER TABLE organization_private_session_setting_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_private_session_setting_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_private_session_setting_events FROM PUBLIC;
CREATE POLICY organization_private_session_setting_events_lifecycle
  ON organization_private_session_setting_events
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_private_session_settings')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_private_session_settings');

CREATE FUNCTION organization_private_sessions_enabled(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  SELECT p_account_id IS NOT DISTINCT FROM
      nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND session_tenancy_product_activated(p_account_id, 1)
    AND EXISTS (
      SELECT 1 FROM organization_private_session_settings setting
      WHERE setting.account_id = p_account_id AND setting.enabled
    )
$body$;
REVOKE ALL ON FUNCTION organization_private_sessions_enabled(uuid) FROM PUBLIC;

CREATE FUNCTION get_private_session_create_policy(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS TABLE (
  personal_workspace boolean,
  platform_available boolean,
  organization_enabled boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_actor_subject_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'private session create policy authority required'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active';
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) OR NOT (
    actor.personal_workspace_id = p_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships access
      WHERE access.account_id = p_account_id
        AND access.workspace_id = p_workspace_id
        AND access.subject_id = p_actor_subject_id
    )
  ) THEN
    RAISE EXCEPTION 'private session create policy authority required'
      USING ERRCODE = '42501';
  END IF;
  personal_workspace := actor.personal_workspace_id = p_workspace_id;
  platform_available := session_tenancy_product_activated(p_account_id, 1);
  organization_enabled := organization_private_sessions_enabled(p_account_id);
  RETURN NEXT;
END
$body$;
REVOKE ALL ON FUNCTION get_private_session_create_policy(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION get_organization_private_session_settings(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  setting organization_private_session_settings%ROWTYPE;
  account_created_at timestamptz;
BEGIN
  IF p_account_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization administration authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  SELECT account.created_at INTO account_created_at FROM managed_accounts account
  WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
  FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO setting FROM organization_private_session_settings candidate
  WHERE candidate.account_id = p_account_id;
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'enabled', coalesce(setting.enabled, false),
    'available', session_tenancy_product_activated(p_account_id, 1),
    'version', coalesce(setting.version, 0),
    'updatedAt', coalesce(setting.updated_at, account_created_at)
  );
END
$body$;
REVOKE ALL ON FUNCTION get_organization_private_session_settings(uuid,text) FROM PUBLIC;

CREATE FUNCTION update_organization_private_session_settings(
  p_account_id uuid,
  p_actor_subject_id text,
  p_enabled boolean,
  p_expected_version bigint,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
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
    RAISE EXCEPTION 'organization private-session settings request is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
  FOR SHARE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM organization_private_session_setting_events event
  WHERE event.id = p_operation_id;
  IF FOUND THEN
    IF prior.account_id IS DISTINCT FROM p_account_id
      OR prior.actor_membership_id IS DISTINCT FROM actor.id
      OR prior.requested_enabled IS DISTINCT FROM p_enabled
      OR prior.expected_version IS DISTINCT FROM p_expected_version
    THEN
      RAISE EXCEPTION 'organization private-session operation key was reused'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO setting FROM organization_private_session_settings candidate
    WHERE candidate.account_id = p_account_id;
    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_account_id,
      'enabled', prior.result_enabled,
      'available', session_tenancy_product_activated(p_account_id, 1),
      'version', prior.result_version,
      'updatedAt', prior.result_updated_at,
      'changed', prior.changed
    );
  END IF;
  SELECT * INTO setting FROM organization_private_session_settings candidate
  WHERE candidate.account_id = p_account_id FOR UPDATE;
  IF coalesce(setting.version, 0) IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'organization private-session settings changed before update'
      USING ERRCODE = '40001';
  END IF;
  IF p_enabled AND NOT session_tenancy_product_activated(p_account_id, 1) THEN
    RAISE EXCEPTION 'session tenancy product surface is not available for this organization'
      USING ERRCODE = '55000';
  END IF;
  did_change := coalesce(setting.enabled, false) IS DISTINCT FROM p_enabled;
  next_version := CASE WHEN setting.account_id IS NULL THEN 1 ELSE setting.version + 1 END;
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (
    p_account_id, p_enabled, next_version, actor.id, clock_timestamp()
  ) ON CONFLICT (account_id) DO UPDATE SET
    enabled = excluded.enabled,
    version = excluded.version,
    updated_by_membership_id = excluded.updated_by_membership_id,
    updated_at = excluded.updated_at
  RETURNING * INTO setting;
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    p_operation_id, p_account_id, actor.id, p_enabled,
    p_expected_version, setting.enabled, setting.version, setting.updated_at, did_change
  );
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'enabled', setting.enabled,
    'available', session_tenancy_product_activated(p_account_id, 1),
    'version', setting.version,
    'updatedAt', setting.updated_at,
    'changed', did_change
  );
END
$body$;
REVOKE ALL ON FUNCTION
  update_organization_private_session_settings(uuid,text,boolean,bigint,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION open_private_session_create_capability(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_actor_subject_id text
) RETURNS TABLE (capability_id uuid, owner_membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  new_capability_id uuid := gen_random_uuid();
  actor_membership_id uuid;
  actor_personal_workspace boolean;
  workspace_access_id uuid;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_actor_subject_id IS NULL OR p_actor_subject_id NOT LIKE 'user:%'
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  -- This is the same organization-scoped fence taken by settings disablement
  -- and organization membership lifecycle writes. It must be the first lock
  -- after request/GUC validation so an old writer cannot authorize while the
  -- setting is enabled and commit after disablement.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = p_account_id AND control.workspace_id = p_workspace_id
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  SELECT membership.id, membership.personal_workspace_id = p_workspace_id
  INTO actor_membership_id, actor_personal_workspace
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT actor_personal_workspace THEN
    SELECT access.id INTO workspace_access_id
    FROM workspace_memberships access
    WHERE access.account_id = p_account_id
      AND access.workspace_id = p_workspace_id
      AND access.subject_id = p_actor_subject_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
    END IF;
    IF NOT organization_private_sessions_enabled(p_account_id) THEN
      -- Rolling-old binaries do not map a new database exception on this
      -- function. Return a reserved, transaction-local capability instead;
      -- the early sessions trigger below consumes it into the existing keyed
      -- denial contract. Repaired callers recognize the reserved value before
      -- attempting INSERT and retain the precise product-setting error.
      new_capability_id := '00000000-0000-0000-0000-000000000000'::uuid;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_lifecycle', 'private_session_create', true
  );
  INSERT INTO private_session_create_capabilities (
    backend_pid, transaction_id, capability_id, account_id, workspace_id,
    session_id, actor_subject_id, owner_membership_id
  ) VALUES (
    pg_backend_pid(), pg_current_xact_id(), new_capability_id, p_account_id,
    p_workspace_id, p_session_id, p_actor_subject_id, actor_membership_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_capability', new_capability_id::text, true
  );
  capability_id := new_capability_id;
  owner_membership_id := actor_membership_id;
  RETURN NEXT;
END
$body$;

DO $organization_private_session_denial_guard$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.guard_disabled_organization_private_session_create()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $function$
    DECLARE
      denied_capability_id uuid;
    BEGIN
      IF NEW.create_idempotency_key IS NULL
        OR NEW.created_by_kind <> 'subject'
        OR NEW.visibility <> 'user_private'
        OR NEW.create_requested_visibility <> 'user_private'
        OR NEW.authority_epoch <> 1
        OR NEW.parent_session_id IS NOT NULL
        OR NEW.owner_organization_membership_id IS NULL
        OR NEW.owner_subject_id IS DISTINCT FROM NEW.created_by_subject_id
        OR NEW.sandbox_group_id IS DISTINCT FROM NEW.id
        OR NEW.forked_from_session_id IS NOT NULL
        OR NEW.forked_from_authority_epoch IS NOT NULL
        OR NEW.forked_from_visibility IS NOT NULL
        OR NEW.forked_at IS NOT NULL
        OR NEW.forked_by_organization_membership_id IS NOT NULL
      THEN
        RETURN NEW;
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.private_session_create_lifecycle', 'private_session_create', true
      );
      DELETE FROM %1$I.private_session_create_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id()
        AND capability.capability_id = '00000000-0000-0000-0000-000000000000'::uuid
        AND capability.capability_id = nullif(
          pg_catalog.current_setting(
            'opengeni.private_session_create_capability', true
          ),
          ''
        )::uuid
        AND capability.account_id = NEW.account_id
        AND capability.workspace_id = NEW.workspace_id
        AND capability.session_id = NEW.id
        AND capability.actor_subject_id = NEW.created_by_subject_id
        AND capability.owner_membership_id = NEW.owner_organization_membership_id
      RETURNING capability.capability_id INTO denied_capability_id;
      IF denied_capability_id IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_catalog.set_config('opengeni.private_session_create_capability', '', true);
      INSERT INTO %1$I.session_spawn_denials (
        account_id, workspace_id, parent_session_id, root_session_id,
        current_depth, attempted_depth, effective_max_nested_agent_depth,
        requested_max_nested_agent_depth_override, policy_source,
        policy_session_id, subject_id, code, idempotency_key,
        organization_private_session_denial_reason
      ) VALUES (
        NEW.account_id, NEW.workspace_id, NULL, NULL,
        0, 1, 0, NULL, 'default', NULL, NEW.created_by_subject_id,
        'nested_agent_depth_exceeded', NEW.create_idempotency_key,
        'organization_private_sessions_disabled'
      );
      RETURN NULL;
    END
    $function$;

    REVOKE ALL ON FUNCTION %1$I.guard_disabled_organization_private_session_create()
      FROM PUBLIC;
    DROP TRIGGER IF EXISTS session_00_disabled_organization_private_create
      ON %1$I.sessions;
    CREATE TRIGGER session_00_disabled_organization_private_create
      BEFORE INSERT ON %1$I.sessions
      FOR EACH ROW
      EXECUTE FUNCTION %1$I.guard_disabled_organization_private_session_create();
  $ddl$, data_schema);
END
$organization_private_session_denial_guard$;

DO $pin_organization_private_session_routines$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.organization_private_sessions_enabled(uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_private_session_create_policy(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_organization_private_session_settings(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.update_organization_private_session_settings(uuid,text,boolean,bigint,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.open_private_session_create_capability(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$pin_organization_private_session_routines$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION get_private_session_create_policy(uuid,uuid,text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION get_organization_private_session_settings(uuid,text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      update_organization_private_session_settings(uuid,text,boolean,bigint,uuid)
      TO opengeni_app;
  END IF;
END
$grants$;

COMMENT ON TABLE organization_private_session_settings IS
  'Organization owner/admin product setting for new private sessions in shared workspaces; personal workspaces are intrinsically private.';