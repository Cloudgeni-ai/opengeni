-- deployment-mode: rolling
-- Activates the bounded organization administration projection and the atomic
-- private-session create seam. Existing session creation remains workspace-
-- shared unless an exact managed-human caller explicitly requests privacy.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_profile_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  actor_membership_id uuid NOT NULL,
  previous_name text NOT NULL,
  requested_name text NOT NULL,
  expected_updated_at timestamptz NOT NULL,
  result_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_profile_events_actor_fk
    FOREIGN KEY (actor_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_profile_events_name_check CHECK (
    octet_length(btrim(requested_name)) BETWEEN 1 AND 480
  )
);
ALTER TABLE organization_profile_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_profile_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_profile_events FROM PUBLIC;
CREATE POLICY organization_tenancy_lifecycle ON organization_profile_events
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

ALTER TABLE sessions
  ADD COLUMN create_requested_visibility text NOT NULL DEFAULT 'workspace_shared';
ALTER TABLE sessions
  ADD CONSTRAINT sessions_create_requested_visibility_check
  CHECK (create_requested_visibility IN ('user_private', 'workspace_shared'));

CREATE FUNCTION get_organization_administration_overview(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE actor organization_memberships%ROWTYPE; result jsonb;
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
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM workspaces workspace
      WHERE workspace.account_id = p_account_id
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.personal_workspace_id = workspace.id
        )) > 500
  THEN
    RAISE EXCEPTION 'organization workspace inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.personal_workspace_id = workspace.id
      )
      AND (SELECT count(*) FROM workspace_memberships access
           WHERE access.workspace_id = workspace.id) > 1000
  ) THEN
    RAISE EXCEPTION 'workspace access inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  SELECT pg_catalog.jsonb_build_object(
    'organization', pg_catalog.jsonb_build_object(
      'id', account.id,
      'name', account.name,
      'createdAt', account.created_at,
      'updatedAt', account.updated_at
    ),
    'workspaces', coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', workspace.id,
          'name', workspace.name,
          'slug', workspace.slug,
          'createdAt', workspace.created_at,
          'updatedAt', workspace.updated_at,
          'members', coalesce((
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'membershipId', access.id,
                'subjectId', access.subject_id,
                'subjectLabel', access.subject_label,
                'principalKind', CASE WHEN access.subject_id LIKE 'user:%'
                  THEN 'human' ELSE 'service' END,
                'role', access.role,
                'permissions', access.permissions,
                'createdAt', access.created_at
              ) ORDER BY coalesce(access.subject_label, access.subject_id), access.id
            ) FROM workspace_memberships access
            WHERE access.workspace_id = workspace.id
          ), '[]'::jsonb)
        ) ORDER BY lower(workspace.name), workspace.id
      )
      FROM workspaces workspace
      WHERE workspace.account_id = p_account_id
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.personal_workspace_id = workspace.id
        )
    ), '[]'::jsonb)
  ) INTO result
  FROM managed_accounts account WHERE account.id = p_account_id;
  IF result IS NULL THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$body$;

CREATE FUNCTION update_organization_name(
  p_account_id uuid,
  p_actor_subject_id text,
  p_name text,
  p_expected_updated_at timestamptz,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  account managed_accounts%ROWTYPE;
  prior organization_profile_events%ROWTYPE;
  normalized_name text := btrim(p_name);
  previous_name_value text;
BEGIN
  IF p_account_id IS NULL OR p_name IS NULL OR p_operation_id IS NULL
    OR p_expected_updated_at IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR char_length(normalized_name) NOT BETWEEN 1 AND 120
    OR octet_length(normalized_name) > 480
  THEN
    RAISE EXCEPTION 'organization name request is invalid' USING ERRCODE = '22023';
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
  SELECT * INTO prior FROM organization_profile_events event
  WHERE event.id = p_operation_id;
  IF FOUND THEN
    IF prior.account_id IS DISTINCT FROM p_account_id
      OR prior.requested_name IS DISTINCT FROM normalized_name
      OR prior.expected_updated_at IS DISTINCT FROM p_expected_updated_at
    THEN
      RAISE EXCEPTION 'organization name operation key was reused'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO account FROM managed_accounts candidate WHERE candidate.id = p_account_id;
    account.name := prior.requested_name;
    account.updated_at := prior.result_updated_at;
  ELSE
    SELECT * INTO account FROM managed_accounts candidate
    WHERE candidate.id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
    IF account.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'organization changed before rename' USING ERRCODE = '40001';
    END IF;
    previous_name_value := account.name;
    UPDATE managed_accounts SET name = normalized_name, updated_at = clock_timestamp()
    WHERE id = p_account_id RETURNING * INTO account;
    INSERT INTO organization_profile_events (
      id, account_id, actor_membership_id, previous_name, requested_name,
      expected_updated_at, result_updated_at
    ) VALUES (
      p_operation_id, p_account_id, actor.id, previous_name_value, normalized_name,
      p_expected_updated_at, account.updated_at
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', account.id,
    'name', account.name,
    'createdAt', account.created_at,
    'updatedAt', account.updated_at
  );
END
$body$;

CREATE FUNCTION open_private_session_create_capability(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS TABLE (capability_id uuid, owner_membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  new_capability_id uuid := gen_random_uuid();
  actor_membership_id uuid;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_actor_subject_id IS NULL OR p_actor_subject_id NOT LIKE 'user:%'
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NOT session_tenancy_product_activated(p_account_id, 1)
  THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  SELECT membership.id INTO actor_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
    AND (
      membership.personal_workspace_id = p_workspace_id
      OR EXISTS (
        SELECT 1 FROM workspace_memberships access
        WHERE access.account_id = p_account_id
          AND access.workspace_id = p_workspace_id
          AND access.subject_id = p_actor_subject_id
      )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), new_capability_id);
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability', new_capability_id::text, true
  );
  capability_id := new_capability_id;
  owner_membership_id := actor_membership_id;
  RETURN NEXT;
END
$body$;

CREATE FUNCTION close_private_session_create_capability(p_capability_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = p_capability_id;
  PERFORM pg_catalog.set_config('opengeni.session_visibility_write_capability', '', true);
END
$body$;

REVOKE ALL ON FUNCTION get_organization_administration_overview(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_organization_name(uuid,text,text,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_private_session_create_capability(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_private_session_create_capability(uuid) FROM PUBLIC;

DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.get_organization_administration_overview(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.update_organization_name(uuid,text,text,timestamptz,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.open_private_session_create_capability(uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.close_private_session_create_capability(uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_organization_administration_overview(uuid,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.update_organization_name(uuid,text,text,timestamptz,uuid) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.open_private_session_create_capability(uuid,uuid,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.close_private_session_create_capability(uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$pin_and_grant$;

COMMENT ON FUNCTION get_organization_administration_overview(uuid,text) IS
  'Bounded organization-admin projection of canonical organization identity and shared workspace access; personal workspaces are excluded in the database.';
COMMENT ON FUNCTION open_private_session_create_capability(uuid,uuid,text) IS
  'Transaction-local capability for one activated managed-human private session insert.';
