-- deployment-mode: rolling
-- Preserve trusted per-entry host guidance privately through realtime delegation and tail admission.

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