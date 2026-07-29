-- deployment-mode: rolling
-- Link one terminal delegation result/error to the accepted ordinary turn.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "session_realtime_entries"
  DROP CONSTRAINT "session_realtime_entries_turn_check";

ALTER TABLE "session_realtime_entries"
  ADD CONSTRAINT "session_realtime_entries_turn_check"
  CHECK (
    "turn_id" IS NULL
    OR ("kind" = 'delegation_call' AND "direction" = 'provider_in')
    OR ("kind" IN ('delegation_result', 'error') AND "direction" = 'provider_out')
  );

DROP INDEX "session_realtime_entries_delegation_turn_uq";

CREATE UNIQUE INDEX "session_realtime_entries_delegation_turn_uq"
  ON "session_realtime_entries" ("turn_id")
  WHERE "kind" = 'delegation_call' AND "turn_id" IS NOT NULL;

CREATE UNIQUE INDEX "session_realtime_entries_delegation_terminal_uq"
  ON "session_realtime_entries" ("turn_id")
  WHERE "direction" = 'provider_out'
    AND "kind" IN ('delegation_result', 'error')
    AND "turn_id" IS NOT NULL;

DROP INDEX "session_realtime_entries_outbound_pending_idx";

CREATE INDEX "session_realtime_entries_outbound_pending_idx"
  ON "session_realtime_entries" ("realtime_id", "sequence")
  WHERE "direction" = 'provider_out' AND "provider_acked_at" IS NULL;

RESET statement_timeout;
RESET lock_timeout;