-- deployment-mode: rolling
-- An MCP server can stop a tool call to ask the person a question (0981).
-- Each question opens a new round of the call's connector action record: the
-- record returns from executing to an undecided pending request, so the
-- answer, possibly from a later turn attempt, is that round's decision and
-- the retry is that round's single execution. Within a round the decision
-- and the executing attempt stay as immutable as before; only advancing the
-- round by one, from executing to an undecided pending request with no
-- executing attempt, clears them. Every earlier round's decision remains in
-- the audit log.
--
-- Adding a column with a constant default rewrites nothing. The previous
-- release never advances the round, so for it the replaced immutability
-- trigger checks exactly what the 0971 version did.
SET LOCAL lock_timeout = '5s';

ALTER TABLE connector_action_requests
  ADD COLUMN IF NOT EXISTS input_round integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN connector_action_requests.input_round IS
  'How many times the provider stopped this call to ask the person a question (MCP elicitation). Each round has its own decision and execution.';

CREATE OR REPLACE FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
    OR NEW.creation_attempt_id IS DISTINCT FROM OLD.creation_attempt_id
    OR NEW.creation_execution_generation IS DISTINCT FROM OLD.creation_execution_generation
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.initiator_kind IS DISTINCT FROM OLD.initiator_kind
    OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_version IS DISTINCT FROM OLD.connection_version
    OR NEW.server_id IS DISTINCT FROM OLD.server_id
    OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.action_name IS DISTINCT FROM OLD.action_name
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.policy_source IS DISTINCT FROM OLD.policy_source
    OR NEW.policy_decision IS DISTINCT FROM OLD.policy_decision
    OR NEW.action_fingerprint IS DISTINCT FROM OLD.action_fingerprint
  THEN
    RAISE EXCEPTION 'connector action request identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.input_round IS DISTINCT FROM OLD.input_round THEN
    IF NEW.input_round <> OLD.input_round + 1
      OR OLD.status <> 'executing'
      OR NEW.status <> 'pending'
      OR NEW.decision IS NOT NULL
      OR NEW.execution_attempt_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'connector action input round advances only from executing to an undecided pending request'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.execution_attempt_id IS NOT NULL AND (
    NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    OR NEW.execution_attempt_generation IS DISTINCT FROM OLD.execution_attempt_generation
  ) THEN
    RAISE EXCEPTION 'connector action execution attempt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.decision IS NOT NULL AND (
    NEW.decision IS DISTINCT FROM OLD.decision
    OR NEW.decision_by_subject_id IS DISTINCT FROM OLD.decision_by_subject_id
    OR NEW.decision_event_id IS DISTINCT FROM OLD.decision_event_id
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decision_by_kind IS DISTINCT FROM OLD.decision_by_kind
    OR NEW.decision_by_signed_in_person IS DISTINCT FROM OLD.decision_by_signed_in_person
  ) THEN
    RAISE EXCEPTION 'connector action approval decision is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
