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

-- Private creation is intentionally separate from the generic visibility
-- lifecycle capability. The application role can ask the definer to mint one
-- exact, transaction-local INSERT authority, but cannot use it for UPDATE or
-- a second session.
CREATE TABLE private_session_create_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  owner_membership_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, capability_id)
);
ALTER TABLE private_session_create_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_session_create_capabilities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private_session_create_capabilities FROM PUBLIC;
CREATE POLICY private_session_create_capability_owner
  ON private_session_create_capabilities
  USING (current_setting('opengeni.private_session_create_lifecycle', true)
    = 'private_session_create')
  WITH CHECK (current_setting('opengeni.private_session_create_lifecycle', true)
    = 'private_session_create');

CREATE FUNCTION get_organization_administration_overview(
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
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = p_account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
  FOR SHARE;
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
  ),
  bounds AS (
    SELECT count(*)::integer AS workspace_count,
      coalesce(bool_or(shared.member_count > 1000), false) AS oversized_workspace
    FROM shared_workspaces shared
  )
  SELECT bounds.workspace_count, bounds.oversized_workspace,
    CASE
      WHEN bounds.workspace_count <= 500 AND NOT bounds.oversized_workspace
      THEN pg_catalog.jsonb_build_object(
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
          ) FROM shared_workspaces workspace
        ), '[]'::jsonb)
      )
      ELSE NULL
    END
  INTO workspace_count, oversized_workspace, result
  FROM managed_accounts account CROSS JOIN bounds
  WHERE account.id = p_account_id;
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
  SELECT * INTO account FROM managed_accounts candidate
  WHERE candidate.id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
  FOR SHARE;
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
    account.name := prior.requested_name;
    account.updated_at := prior.result_updated_at;
  ELSE
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
    OR NOT session_tenancy_product_activated(p_account_id, 1)
  THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  -- Match the organization lifecycle's workspace -> membership prefix so
  -- suspension/offboarding cannot pass between authorization and INSERT.
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
  -- An ordinary workspace's exact access row is authority, not just evidence.
  -- Lock it after the canonical workspace + organization-membership prefix so
  -- workspace-membership removal cannot miss an uncommitted private session,
  -- delete access, and let this transaction commit from an older snapshot.
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

CREATE FUNCTION close_private_session_create_capability(p_capability_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_lifecycle', 'private_session_create', true
  );
  DELETE FROM private_session_create_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = p_capability_id;
  PERFORM pg_catalog.set_config('opengeni.private_session_create_capability', '', true);
END
$body$;

CREATE FUNCTION fence_session_create_requested_visibility_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF NEW.create_requested_visibility IS DISTINCT FROM OLD.create_requested_visibility THEN
    RAISE EXCEPTION 'session requested visibility is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER sessions_create_requested_visibility_immutable
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION fence_session_create_requested_visibility_update();

REVOKE ALL ON FUNCTION get_organization_administration_overview(uuid,text) FROM PUBLIC;

DO $private_session_create_guard$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.guard_session_authority_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      resolved_owner_id uuid;
      resolved_owner_subject_id text;
      private_create_capability_id uuid;
      creator_has_active_membership boolean;
      owner_provenance_supplied boolean :=
        NEW.owner_organization_membership_id IS NOT NULL
        OR NEW.owner_subject_id IS NOT NULL;
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF TG_OP = 'INSERT'
        AND NEW.owner_organization_membership_id IS NULL
        AND NEW.owner_subject_id IS NULL
      THEN
        IF NEW.parent_session_id IS NOT NULL THEN
          SELECT parent.owner_organization_membership_id, parent.owner_subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM sessions parent
          WHERE parent.account_id = NEW.account_id
            AND parent.workspace_id = NEW.workspace_id
            AND parent.id = NEW.parent_session_id;
        ELSIF NEW.created_by_kind = 'subject'
          AND NEW.created_by_subject_id IS NOT NULL
        THEN
          PERFORM pg_catalog.set_config(
            'opengeni.organization_tenancy_lifecycle',
            'session_visibility_activation',
            true
          );
          SELECT membership.id, membership.subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM organization_memberships membership
          WHERE membership.account_id = NEW.account_id
            AND membership.subject_id = NEW.created_by_subject_id
            AND membership.status = 'active'
            AND (
              -- Stated authority, read from the authority row itself: a managed
              -- human's personal workspace has no workspace_memberships row by
              -- design (0219), so the membership's own personal-workspace
              -- pointer is the authority for exactly that one workspace. Same
              -- shape as 0258's personal Document authority.
              --
              -- Restricted to `user:%%` because 0219 and 0263 gate the ENTIRE
              -- managed-human lifecycle - provisioning, invitation, acceptance
              -- - to that prefix. A personal-workspace pointer on an
              -- `api_key:`/`configured:` membership is not a shape any
              -- lifecycle can produce, and 0297's classifier calls that lane
              -- (`external_lane_owns_row`) permanently unrepairable. The write
              -- path must not attribute what the classifier refuses.
              (
                NEW.created_by_subject_id LIKE 'user:%%'
                AND membership.personal_workspace_id = NEW.workspace_id
              )
              OR EXISTS (
                SELECT 1
                FROM workspace_memberships workspace_membership
                WHERE workspace_membership.account_id = NEW.account_id
                  AND workspace_membership.workspace_id = NEW.workspace_id
                  AND workspace_membership.subject_id = membership.subject_id
              )
            );
          IF NOT FOUND THEN
            -- Classify the miss instead of writing an indistinguishable NULL.
            SELECT EXISTS (
              SELECT 1
              FROM organization_memberships creator_membership
              WHERE creator_membership.account_id = NEW.account_id
                AND creator_membership.subject_id = NEW.created_by_subject_id
                AND creator_membership.status = 'active'
                AND NEW.created_by_subject_id LIKE 'user:%%'
            ) INTO creator_has_active_membership;
            IF creator_has_active_membership
              AND EXISTS (
                SELECT 1
                FROM organization_memberships personal_owner
                WHERE personal_owner.account_id = NEW.account_id
                  AND personal_owner.personal_workspace_id = NEW.workspace_id
                  AND personal_owner.status = 'active'
                  AND personal_owner.subject_id LIKE 'user:%%'
              )
            THEN
              RAISE EXCEPTION
                'session owner authority is unresolved in a personal workspace'
                USING ERRCODE = '55000';
            END IF;
            -- Otherwise genuinely ownerless: no active organization membership,
            -- or no stated authority over an ordinary shared workspace.
          END IF;
        END IF;
        NEW.owner_organization_membership_id := resolved_owner_id;
        NEW.owner_subject_id := resolved_owner_subject_id;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
      END IF;

      IF (NEW.owner_organization_membership_id IS NULL)
          <> (NEW.owner_subject_id IS NULL)
        OR (NEW.visibility = 'user_private'
          AND NEW.owner_organization_membership_id IS NULL)
      THEN
        RAISE EXCEPTION 'session authority owner provenance is incomplete'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'UPDATE'
        AND (
          NEW.visibility IS DISTINCT FROM OLD.visibility
          OR NEW.owner_organization_membership_id
            IS DISTINCT FROM OLD.owner_organization_membership_id
          OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
          OR NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
          OR NEW.forked_from_session_id IS DISTINCT FROM OLD.forked_from_session_id
          OR NEW.forked_from_authority_epoch
            IS DISTINCT FROM OLD.forked_from_authority_epoch
          OR NEW.forked_from_visibility IS DISTINCT FROM OLD.forked_from_visibility
          OR NEW.forked_at IS DISTINCT FROM OLD.forked_at
          OR NEW.forked_by_organization_membership_id
            IS DISTINCT FROM OLD.forked_by_organization_membership_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'session authority changes require the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_catalog.set_config(
          'opengeni.private_session_create_lifecycle', 'private_session_create', true
        );
        DELETE FROM private_session_create_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id()
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
          AND NEW.created_by_kind = 'subject'
          AND NEW.owner_subject_id = capability.actor_subject_id
          AND NEW.visibility = 'user_private'
          AND NEW.create_requested_visibility = 'user_private'
          AND NEW.authority_epoch = 1
          AND NEW.parent_session_id IS NULL
          AND NEW.sandbox_group_id = NEW.id
          AND NEW.forked_from_session_id IS NULL
          AND NEW.forked_from_authority_epoch IS NULL
          AND NEW.forked_from_visibility IS NULL
          AND NEW.forked_at IS NULL
          AND NEW.forked_by_organization_membership_id IS NULL
        RETURNING capability.capability_id INTO private_create_capability_id;
        IF private_create_capability_id IS NOT NULL THEN
          PERFORM pg_catalog.set_config('opengeni.private_session_create_capability', '', true);
        END IF;
      END IF;

      IF TG_OP = 'INSERT'
        AND (
          NEW.visibility <> 'workspace_shared'
          OR NEW.authority_epoch <> 1
          OR NEW.forked_from_session_id IS NOT NULL
          OR NEW.forked_from_authority_epoch IS NOT NULL
          OR NEW.forked_from_visibility IS NOT NULL
          OR NEW.forked_at IS NOT NULL
          OR NEW.forked_by_organization_membership_id IS NOT NULL
          OR owner_provenance_supplied
        )
        AND private_create_capability_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'non-default session authority requires the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'ALTER FUNCTION %I.guard_session_authority_write() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'COMMENT ON FUNCTION %I.guard_session_authority_write() IS %L',
    data_schema,
    'Session authority write fence (0225, repaired by 0302 and 0311). '
      || 'Private creation accepts one exact account/workspace/session/subject/owner capability '
      || 'on INSERT only and consumes it before the write; existing visibility lifecycle '
      || 'capabilities remain unchanged.'
  );
END
$private_session_create_guard$;

REVOKE ALL ON FUNCTION update_organization_name(uuid,text,text,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_private_session_create_capability(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_private_session_create_capability(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_session_create_requested_visibility_update() FROM PUBLIC;

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
    'ALTER FUNCTION %I.open_private_session_create_capability(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.close_private_session_create_capability(uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fence_session_create_requested_visibility_update() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.private_session_create_capabilities FROM opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_organization_administration_overview(uuid,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.update_organization_name(uuid,text,text,timestamptz,uuid) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.open_private_session_create_capability(uuid,uuid,uuid,text) TO opengeni_app',
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
COMMENT ON FUNCTION open_private_session_create_capability(uuid,uuid,uuid,text) IS
  'Transaction-local capability for one activated managed-human private session insert.';
