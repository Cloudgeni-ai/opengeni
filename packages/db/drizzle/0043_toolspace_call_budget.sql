-- Per-turn toolspace call budget counter. The previous enforcement read the
-- count of `agent.toolCall.created` toolspace events then compared against the
-- limit before appending the next event (read-then-append TOCTOU): concurrent
-- tools/call requests all observed a stale count and all passed. This column
-- makes the budget a single atomic reservation:
--   UPDATE session_turns SET toolspace_call_count = toolspace_call_count + 1
--   WHERE id = $turn AND toolspace_call_count < $limit RETURNING toolspace_call_count
-- Concurrent reservations serialize on the row lock, so exactly `limit` succeed.
--
-- opengeni_app already holds table-level DML on session_turns (migration 0040
-- grants ON ALL TABLES + default privileges); a new column inherits those
-- grants, so no additional GRANT block is required.
ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "toolspace_call_count" integer NOT NULL DEFAULT 0;
