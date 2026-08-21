-- deployment-mode: rolling
-- Lets one exact live attempt of a private session create one private child.
-- The capability is transaction-local, target-bound, and cannot authorize an
-- UPDATE or a second/multi-row INSERT.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE private_session_create_capabilities
  ADD COLUMN parent_session_id uuid,
  ADD COLUMN actor_turn_id uuid,
  ADD COLUMN actor_attempt_id uuid,
  ADD COLUMN actor_execution_generation integer,
  ADD CONSTRAINT private_session_create_capability_lane_check CHECK (
    (parent_session_id IS NULL
      AND actor_turn_id IS NULL
      AND actor_attempt_id IS NULL
      AND actor_execution_generation IS NULL)
    OR
    (parent_session_id IS NOT NULL
      AND actor_turn_id IS NOT NULL
      AND actor_attempt_id IS NOT NULL
      AND actor_execution_generation > 0)
  );

CREATE FUNCTION open_private_child_session_create_capability(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_parent_session_id uuid,
  p_actor_turn_id uuid,
  p_actor_attempt_id uuid,
  p_actor_execution_generation integer
) RETURNS TABLE (
  capability_id uuid,
  owner_membership_id uuid,
  owner_subject_id text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  new_capability_id uuid := gen_random_uuid();
  parent_row sessions%ROWTYPE;
  owner_membership organization_memberships%ROWTYPE;
  owner_workspace_access_id uuid;
  actor_human_subject_id text;
  actor_interrupted boolean;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_parent_session_id IS NULL OR p_actor_turn_id IS NULL
    OR p_actor_attempt_id IS NULL OR p_actor_execution_generation IS NULL
    OR p_actor_execution_generation < 1
    OR p_session_id = p_parent_session_id
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NOT session_tenancy_product_activated(p_account_id, 1)
  THEN
    RAISE EXCEPTION 'private child session create authority required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = p_account_id AND control.workspace_id = p_workspace_id
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;

  SELECT parent.* INTO parent_row
  FROM sessions parent
  WHERE parent.account_id = p_account_id
    AND parent.workspace_id = p_workspace_id
    AND parent.id = p_parent_session_id
  FOR NO KEY UPDATE;
  IF NOT FOUND
    OR parent_row.visibility <> 'user_private'
    OR parent_row.owner_organization_membership_id IS NULL
    OR parent_row.owner_subject_id IS NULL
    OR parent_row.active_turn_id IS DISTINCT FROM p_actor_turn_id
  THEN
    RAISE EXCEPTION 'private child session create authority required'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO owner_membership
  FROM organization_memberships membership
  WHERE membership.id = parent_row.owner_organization_membership_id
    AND membership.account_id = p_account_id
    AND membership.subject_id = parent_row.owner_subject_id
    AND membership.status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'private child session owner authority is no longer active'
      USING ERRCODE = '42501';
  END IF;
  IF NOT (
    owner_membership.subject_id LIKE 'user:%'
    AND owner_membership.personal_workspace_id = p_workspace_id
  ) THEN
    -- Match the top-level private-create lock prefix: in an ordinary shared
    -- workspace the exact access row is authority, so hold it through INSERT.
    SELECT access.id INTO owner_workspace_access_id
    FROM workspace_memberships access
    WHERE access.account_id = p_account_id
      AND access.workspace_id = p_workspace_id
      AND access.subject_id = owner_membership.subject_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private child session owner authority is no longer active'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT
    coalesce(
      turn_row.initiating_human_subject_id,
      CASE WHEN turn_row.initiator_kind = 'subject'
        THEN turn_row.initiator_subject_id ELSE NULL END
    ),
    EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace_id
        AND interruption.attempt_id = p_actor_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  INTO actor_human_subject_id, actor_interrupted
  FROM session_turns turn_row
  JOIN session_turn_attempts attempt
    ON attempt.workspace_id = turn_row.workspace_id
    AND attempt.session_id = turn_row.session_id
    AND attempt.turn_id = turn_row.id
  WHERE turn_row.account_id = p_account_id
    AND turn_row.workspace_id = p_workspace_id
    AND turn_row.session_id = p_parent_session_id
    AND turn_row.id = p_actor_turn_id
    AND turn_row.active_attempt_id = p_actor_attempt_id
    AND turn_row.execution_generation = p_actor_execution_generation
    AND turn_row.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND attempt.id = p_actor_attempt_id
    AND attempt.execution_generation = p_actor_execution_generation
    AND attempt.state IN ('claimed', 'running')
  FOR UPDATE OF turn_row, attempt;
  IF NOT FOUND OR actor_interrupted
    OR actor_human_subject_id IS DISTINCT FROM parent_row.owner_subject_id
  THEN
    RAISE EXCEPTION 'private child session create attempt is stale or unauthorized'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_lifecycle', 'private_session_create', true
  );
  INSERT INTO private_session_create_capabilities (
    backend_pid, transaction_id, capability_id, account_id, workspace_id,
    session_id, actor_subject_id, owner_membership_id, parent_session_id,
    actor_turn_id, actor_attempt_id, actor_execution_generation
  ) VALUES (
    pg_backend_pid(), pg_current_xact_id(), new_capability_id, p_account_id,
    p_workspace_id, p_session_id, parent_row.owner_subject_id,
    parent_row.owner_organization_membership_id, p_parent_session_id,
    p_actor_turn_id, p_actor_attempt_id, p_actor_execution_generation
  );
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), new_capability_id);
  PERFORM pg_catalog.set_config(
    'opengeni.private_child_session_create_capability', new_capability_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability', new_capability_id::text, true
  );
  capability_id := new_capability_id;
  owner_membership_id := parent_row.owner_organization_membership_id;
  owner_subject_id := parent_row.owner_subject_id;
  RETURN NEXT;
END
$body$;

CREATE OR REPLACE FUNCTION close_private_session_create_capability(p_capability_id uuid)
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
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = p_capability_id;
  PERFORM pg_catalog.set_config('opengeni.private_session_create_capability', '', true);
  PERFORM pg_catalog.set_config('opengeni.private_child_session_create_capability', '', true);
  PERFORM pg_catalog.set_config('opengeni.session_visibility_write_capability', '', true);
END
$body$;

CREATE FUNCTION guard_private_child_session_create()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  child_capability private_session_create_capabilities%ROWTYPE;
  parent_sandbox_group_id uuid;
BEGIN
  IF nullif(pg_catalog.current_setting(
    'opengeni.private_child_session_create_capability', true
  ), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'private child create capability cannot authorize session updates'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_lifecycle', 'private_session_create', true
  );
  SELECT capability.* INTO child_capability
  FROM private_session_create_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id()
    AND capability.capability_id = nullif(pg_catalog.current_setting(
      'opengeni.private_child_session_create_capability', true
    ), '')::uuid;
  IF NOT FOUND OR child_capability.parent_session_id IS NULL THEN
    RAISE EXCEPTION 'private child create capability is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT parent.sandbox_group_id INTO parent_sandbox_group_id
  FROM sessions parent
  WHERE parent.account_id = NEW.account_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.id = child_capability.parent_session_id;
  IF NOT FOUND
    OR child_capability.account_id IS DISTINCT FROM NEW.account_id
    OR child_capability.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR child_capability.session_id IS DISTINCT FROM NEW.id
    OR child_capability.parent_session_id IS DISTINCT FROM NEW.parent_session_id
    OR child_capability.actor_subject_id IS DISTINCT FROM NEW.created_by_subject_id
    OR child_capability.owner_membership_id
      IS DISTINCT FROM NEW.owner_organization_membership_id
    OR child_capability.actor_subject_id IS DISTINCT FROM NEW.owner_subject_id
    OR NEW.created_by_kind <> 'subject'
    OR NEW.visibility <> 'user_private'
    OR NEW.create_requested_visibility <> 'user_private'
    OR NEW.authority_epoch <> 1
    OR NEW.sandbox_group_id IS NULL
    OR (
      NEW.sandbox_group_id IS DISTINCT FROM NEW.id
      AND NEW.sandbox_group_id IS DISTINCT FROM parent_sandbox_group_id
    )
    OR NEW.forked_from_session_id IS NOT NULL
    OR NEW.forked_from_authority_epoch IS NOT NULL
    OR NEW.forked_from_visibility IS NOT NULL
    OR NEW.forked_at IS NOT NULL
    OR NEW.forked_by_organization_membership_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'private child session insert does not match its exact capability'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION fence_child_session_authority()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  parent_visibility text;
  parent_owner_membership_id uuid;
  parent_owner_subject_id text;
BEGIN
  IF NEW.parent_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- The row lock closes the core-read/insert race with a concurrent visibility
  -- transition. It is held through child INSERT and follows the existing
  -- workspace -> parent ordering used by session creation.
  SELECT parent.visibility,
    parent.owner_organization_membership_id,
    parent.owner_subject_id
  INTO parent_visibility, parent_owner_membership_id, parent_owner_subject_id
  FROM sessions parent
  WHERE parent.account_id = NEW.account_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.id = NEW.parent_session_id
  FOR SHARE;
  IF NOT FOUND
    OR NEW.visibility IS DISTINCT FROM parent_visibility
    OR NEW.create_requested_visibility IS DISTINCT FROM parent_visibility
    OR (
      parent_visibility = 'user_private'
      AND (
        NEW.owner_organization_membership_id IS DISTINCT FROM parent_owner_membership_id
        OR NEW.owner_subject_id IS DISTINCT FROM parent_owner_subject_id
      )
    )
  THEN
    RAISE EXCEPTION 'child session authority must match its locked parent'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

DROP TRIGGER IF EXISTS session_00_private_child_create_fence ON sessions;
CREATE TRIGGER session_00_private_child_create_fence
BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION guard_private_child_session_create();

DROP TRIGGER IF EXISTS sessions_child_authority_fence ON sessions;
CREATE TRIGGER sessions_child_authority_fence
BEFORE INSERT ON sessions
FOR EACH ROW EXECUTE FUNCTION fence_child_session_authority();

REVOKE ALL ON FUNCTION open_private_child_session_create_capability(
  uuid,uuid,uuid,uuid,uuid,uuid,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_private_session_create_capability(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_private_child_session_create() FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_child_session_authority() FROM PUBLIC;

DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.close_private_session_create_capability(uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.guard_private_child_session_create() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fence_child_session_authority() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.close_private_session_create_capability(uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$pin_and_grant$;

COMMENT ON FUNCTION open_private_child_session_create_capability(
  uuid,uuid,uuid,uuid,uuid,uuid,integer
) IS 'One exact live private-parent attempt may insert one same-owner private child.';
