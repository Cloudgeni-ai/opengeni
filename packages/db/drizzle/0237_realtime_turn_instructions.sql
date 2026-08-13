-- deployment-mode: rolling
-- Preserve trusted per-entry host guidance privately through realtime delegation and tail admission.
-- Mixed-version safety lives at the database boundary: old API replicas may
-- continue ordinary traffic, but cannot introduce, replace, or clear hidden
-- instructions because they do not set the v1 writer marker.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_realtime_entries"
  ADD COLUMN "turn_instructions" text;

ALTER TABLE "session_realtime_entries"
  ADD CONSTRAINT "session_realtime_entries_turn_instructions_check"
  CHECK (
    "turn_instructions" IS NULL
    OR (
      "direction" = 'provider_in'
      AND "kind" IN ('delegation_call', 'user_transcript', 'assistant_transcript')
      AND "turn_instructions" = btrim("turn_instructions")
      AND char_length("turn_instructions") BETWEEN 1 AND 32768
    )
  ) NOT VALID;

ALTER TABLE "session_realtime_entries"
  VALIDATE CONSTRAINT "session_realtime_entries_turn_instructions_check";

CREATE OR REPLACE FUNCTION opengeni_private.enforce_turn_instructions_protocol_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  mutating_hidden_instructions boolean := false;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'sessions' THEN
      mutating_hidden_instructions := (TG_OP = 'INSERT' AND NEW.initial_turn_instructions IS NOT NULL)
        OR (TG_OP = 'UPDATE'
          AND NEW.initial_turn_instructions IS DISTINCT FROM OLD.initial_turn_instructions
          AND (NEW.initial_turn_instructions IS NOT NULL OR OLD.initial_turn_instructions IS NOT NULL));
    WHEN 'session_turns' THEN
      mutating_hidden_instructions := (TG_OP = 'INSERT' AND NEW.turn_instructions IS NOT NULL)
        OR (TG_OP = 'UPDATE'
          AND NEW.turn_instructions IS DISTINCT FROM OLD.turn_instructions
          AND (NEW.turn_instructions IS NOT NULL OR OLD.turn_instructions IS NOT NULL));
    WHEN 'session_realtime_entries' THEN
      mutating_hidden_instructions := (TG_OP = 'INSERT' AND NEW.turn_instructions IS NOT NULL)
        OR (TG_OP = 'UPDATE'
          AND NEW.turn_instructions IS DISTINCT FROM OLD.turn_instructions
          AND (NEW.turn_instructions IS NOT NULL OR OLD.turn_instructions IS NOT NULL));
    ELSE
      RAISE EXCEPTION 'unsupported turn-instructions protocol table: %', TG_TABLE_NAME
        USING ERRCODE = '55000';
  END CASE;

  IF mutating_hidden_instructions
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper
    )
    AND current_setting('opengeni.turn_instructions_protocol_v1', true) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'turn-instructions protocol v1 marker is required for % on %', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_turn_instructions_protocol_v1() FROM PUBLIC;

CREATE TRIGGER sessions_turn_instructions_protocol_v1_guard
BEFORE INSERT OR UPDATE OF initial_turn_instructions ON "sessions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_turn_instructions_protocol_v1();

CREATE TRIGGER session_turns_turn_instructions_protocol_v1_guard
BEFORE INSERT OR UPDATE OF turn_instructions ON "session_turns"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_turn_instructions_protocol_v1();

CREATE TRIGGER session_realtime_entries_turn_instructions_protocol_v1_guard
BEFORE INSERT OR UPDATE OF turn_instructions ON "session_realtime_entries"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_turn_instructions_protocol_v1();