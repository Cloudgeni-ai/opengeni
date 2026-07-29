-- deployment-mode: rolling
-- Stage one replacement beside the active GPT-Live connection until the browser
-- proves its data channel is ready, then promote it transactionally.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

DROP INDEX "session_realtime_connections_one_open_uq";

CREATE UNIQUE INDEX "session_realtime_connections_one_active_uq"
  ON "session_realtime_connections" ("realtime_id")
  WHERE "state" = 'active';

CREATE UNIQUE INDEX "session_realtime_connections_one_preparing_uq"
  ON "session_realtime_connections" ("realtime_id")
  WHERE "state" IN ('negotiating', 'ready');

ALTER TABLE "session_realtime_connections"
  DROP CONSTRAINT "session_realtime_connections_state_check",
  ADD CONSTRAINT "session_realtime_connections_state_check"
    CHECK ("state" IN ('negotiating', 'ready', 'active', 'failed', 'closed'));

ALTER TABLE "session_realtime_connections"
  DROP CONSTRAINT "session_realtime_connections_terminal_check",
  ADD CONSTRAINT "session_realtime_connections_terminal_check"
    CHECK (
      ("state" = 'negotiating' AND "sdp_answer" IS NULL AND "failure_code" IS NULL AND "negotiated_at" IS NULL AND "closed_at" IS NULL)
      OR
      ("state" = 'ready' AND "sdp_answer" IS NOT NULL AND "failure_code" IS NULL AND "negotiated_at" IS NOT NULL AND "closed_at" IS NULL)
      OR
      ("state" = 'active' AND "sdp_answer" IS NOT NULL AND "failure_code" IS NULL AND "negotiated_at" IS NOT NULL AND "closed_at" IS NULL)
      OR
      ("state" = 'failed' AND "sdp_answer" IS NULL AND "failure_code" IS NOT NULL AND "closed_at" IS NOT NULL)
      OR
      ("state" = 'closed' AND "closed_at" IS NOT NULL)
    );

RESET statement_timeout;
RESET lock_timeout;
