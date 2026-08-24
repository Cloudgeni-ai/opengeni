-- deployment-mode: rolling
-- A physically queued turn is not necessarily part of the operator-visible
-- prompt queue: an idle Send and a Steer are accepted immediately, then wait
-- only for the worker claim boundary. Persist that admission decision so UI
-- projections never infer product semantics from worker implementation state.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE session_turns
  ADD COLUMN prompt_routing text;

ALTER TABLE session_turns
  ADD CONSTRAINT session_turns_prompt_routing_check CHECK (
    prompt_routing IS NULL OR prompt_routing IN (
      'accepted_for_execution',
      'queued_for_execution',
      'accepted_for_steering'
    )
  ) NOT VALID;

ALTER TABLE session_turns
  VALIDATE CONSTRAINT session_turns_prompt_routing_check;

CREATE FUNCTION opengeni_private.reject_session_turn_prompt_routing_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.prompt_routing IS DISTINCT FROM OLD.prompt_routing THEN
    RAISE EXCEPTION 'turn prompt routing is immutable after admission'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.reject_session_turn_prompt_routing_mutation() FROM PUBLIC;

CREATE TRIGGER session_turns_prompt_routing_immutable
  BEFORE UPDATE OF prompt_routing ON session_turns
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_session_turn_prompt_routing_mutation();

COMMENT ON COLUMN session_turns.prompt_routing IS
  'Immutable admission intent for human/API prompts. Null is rolling/legacy compatibility; status remains physical execution state.';
