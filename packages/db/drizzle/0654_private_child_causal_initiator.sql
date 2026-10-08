-- deployment-mode: rolling
-- Private child authority comes from the exact parent attempt's causal human,
-- already checked and locked by open_private_child_session_create_capability.
-- Internal updates retain service audit attribution; it must match that turn,
-- not be rewritten into the owner's identity. No capability or grant is added.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION guard_private_child_session_create()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  child_capability private_session_create_capabilities%ROWTYPE;
  parent_sandbox_group_id uuid;
  actor_initiator_kind text;
  actor_initiator_subject_id text;
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
  -- These rows remain locked by the capability opener for this transaction.
  SELECT parent.sandbox_group_id, turn_row.initiator_kind, turn_row.initiator_subject_id
    INTO parent_sandbox_group_id, actor_initiator_kind, actor_initiator_subject_id
  FROM sessions parent
  JOIN session_turns turn_row
    ON turn_row.account_id = parent.account_id
    AND turn_row.workspace_id = parent.workspace_id
    AND turn_row.session_id = parent.id
    AND turn_row.id = child_capability.actor_turn_id
  WHERE parent.account_id = NEW.account_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.id = child_capability.parent_session_id;
  IF NOT FOUND
    OR child_capability.account_id IS DISTINCT FROM NEW.account_id
    OR child_capability.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR child_capability.session_id IS DISTINCT FROM NEW.id
    OR child_capability.parent_session_id IS DISTINCT FROM NEW.parent_session_id
    OR child_capability.actor_turn_id IS DISTINCT FROM NEW.parent_turn_id
    OR actor_initiator_kind IS DISTINCT FROM NEW.created_by_kind
    OR actor_initiator_subject_id IS DISTINCT FROM NEW.created_by_subject_id
    OR child_capability.owner_membership_id
      IS DISTINCT FROM NEW.owner_organization_membership_id
    OR child_capability.actor_subject_id IS DISTINCT FROM NEW.owner_subject_id
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

REVOKE ALL ON FUNCTION guard_private_child_session_create() FROM PUBLIC;
DO $body$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.guard_private_child_session_create() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$body$;
