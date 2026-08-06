-- deployment-mode: rolling
-- Personal MCP authority is additive and frozen separately from causal initiators.

ALTER TABLE sessions
  ADD COLUMN initial_personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN parent_turn_id uuid,
  ADD CONSTRAINT sessions_initial_personal_delegations_array_chk
    CHECK (
      jsonb_typeof(initial_personal_connection_delegations) = 'array'
      AND jsonb_array_length(initial_personal_connection_delegations) <= 128
    );

ALTER TABLE session_turns
  ADD COLUMN personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT session_turns_personal_delegations_array_chk
    CHECK (
      jsonb_typeof(personal_connection_delegations) = 'array'
      AND jsonb_array_length(personal_connection_delegations) <= 128
    );

ALTER TABLE session_system_updates
  ADD COLUMN personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT session_updates_personal_delegations_array_chk
    CHECK (
      jsonb_typeof(personal_connection_delegations) = 'array'
      AND jsonb_array_length(personal_connection_delegations) <= 128
    );

ALTER TABLE session_system_update_outbox
  ADD COLUMN personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT session_update_outbox_personal_delegations_array_chk
    CHECK (
      jsonb_typeof(personal_connection_delegations) = 'array'
      AND jsonb_array_length(personal_connection_delegations) <= 128
    );

ALTER TABLE scheduled_tasks
  ADD COLUMN created_by_kind text NOT NULL DEFAULT 'service',
  ADD COLUMN created_by_subject_id text NOT NULL DEFAULT 'unattributed-legacy',
  ADD COLUMN created_by_context jsonb NOT NULL DEFAULT '{"backfill":true}'::jsonb,
  ADD COLUMN personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT scheduled_tasks_created_by_kind_check
    CHECK (created_by_kind IN ('subject', 'service')),
  ADD CONSTRAINT scheduled_tasks_created_by_subject_nonempty_check
    CHECK (octet_length(btrim(created_by_subject_id)) BETWEEN 1 AND 512),
  ADD CONSTRAINT scheduled_tasks_created_by_context_object_check
    CHECK (jsonb_typeof(created_by_context) = 'object'),
  ADD CONSTRAINT scheduled_tasks_personal_delegations_array_chk
    CHECK (
      jsonb_typeof(personal_connection_delegations) = 'array'
      AND jsonb_array_length(personal_connection_delegations) <= 128
    );

DROP FUNCTION opengeni_private.claim_session_system_update_outbox(integer);
CREATE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, payload jsonb, lineage jsonb,
  personal_connection_delegations jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    )
    UPDATE session_system_update_outbox o
    SET attempts = o.attempts + 1, updated_at = now()
    FROM claimed c WHERE o.id = c.id
    RETURNING o.id, o.account_id, o.workspace_id, o.source_session_id,
      o.target_session_id, o.dedupe_key, o.kind, o.classification,
      o.source_id, o.summary, o.payload, o.lineage,
      o.personal_connection_delegations;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
      TO opengeni_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF NEW.initial_personal_connection_delegations IS DISTINCT FROM OLD.initial_personal_connection_delegations
      OR NEW.parent_turn_id IS DISTINCT FROM OLD.parent_turn_id
    THEN
      RAISE EXCEPTION 'session initial personal MCP authority is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.personal_connection_delegations IS DISTINCT FROM OLD.personal_connection_delegations THEN
    RAISE EXCEPTION '% personal MCP authority is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.validate_session_parent_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_turn_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM session_turns parent_turn
    WHERE parent_turn.id = NEW.parent_turn_id
      AND parent_turn.workspace_id = NEW.workspace_id
      AND parent_turn.session_id = NEW.parent_session_id
  ) THEN
    RAISE EXCEPTION 'session parent turn must belong to its parent session and workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_personal_authority_immutable
  BEFORE UPDATE OF initial_personal_connection_delegations, parent_turn_id
  ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER sessions_parent_turn_valid
  BEFORE INSERT OR UPDATE OF parent_turn_id, parent_session_id, workspace_id
  ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.validate_session_parent_turn();

CREATE TRIGGER session_turns_personal_authority_immutable
  BEFORE UPDATE OF personal_connection_delegations
  ON session_turns
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER session_updates_personal_authority_immutable
  BEFORE UPDATE OF personal_connection_delegations
  ON session_system_updates
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER session_update_outbox_personal_authority_immutable
  BEFORE UPDATE OF personal_connection_delegations
  ON session_system_update_outbox
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE OR REPLACE FUNCTION opengeni_private.prevent_scheduled_task_creator_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind
    OR NEW.created_by_subject_id IS DISTINCT FROM OLD.created_by_subject_id
    OR NEW.created_by_context IS DISTINCT FROM OLD.created_by_context
  THEN
    RAISE EXCEPTION 'scheduled task creator is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_tasks_creator_immutable
  BEFORE UPDATE OF created_by_kind, created_by_subject_id, created_by_context
  ON scheduled_tasks
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_scheduled_task_creator_mutation();