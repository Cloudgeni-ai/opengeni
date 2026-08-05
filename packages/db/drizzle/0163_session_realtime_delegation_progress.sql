-- deployment-mode: rolling
-- Stream durable ordinary-turn assistant deltas back to their active V3 delegation.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "session_realtime_entries"
  DROP CONSTRAINT "session_realtime_entries_kind_check";

ALTER TABLE "session_realtime_entries"
  ADD CONSTRAINT "session_realtime_entries_kind_check"
  CHECK ("kind" IN (
    'user_transcript',
    'assistant_transcript',
    'delegation_call',
    'delegation_progress',
    'delegation_result',
    'interruption',
    'session_update',
    'error'
  ));

ALTER TABLE "session_realtime_entries"
  DROP CONSTRAINT "session_realtime_entries_turn_check";

ALTER TABLE "session_realtime_entries"
  ADD CONSTRAINT "session_realtime_entries_turn_check"
  CHECK (
    "turn_id" IS NULL
    OR ("kind" = 'delegation_call' AND "direction" = 'provider_in')
    OR ("kind" IN ('delegation_progress', 'delegation_result', 'error') AND "direction" = 'provider_out')
  );

RESET statement_timeout;
RESET lock_timeout;
