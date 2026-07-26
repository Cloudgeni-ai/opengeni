-- Provider-aware conversation context compaction (client-side path).
--
-- Long-lived sessions grow session_history_items unbounded until they overflow
-- the model context window and 400 every turn. On Azure the server-side
-- Responses-API compaction is unavailable, so OpenGeni runs its own
-- client-side compaction: it summarizes an old turn-boundary-aligned prefix
-- into one synthetic user message and supersedes (NOT deletes) the summarized
-- rows so the full transcript survives as an audit trail.
--
-- "active": the live-row flag. The read path selects only active rows ordered
-- by position => [active summary, ...active recent tail]. A compaction sets the
-- summarized prefix rows inactive and inserts one active summary row at the
-- boundary. Defaults true so all existing and normally-appended rows stay live.
ALTER TABLE "session_history_items"
  ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true;

-- Fast active-row read per session (the live conversation-truth read path).
CREATE INDEX IF NOT EXISTS "session_history_items_active_idx"
  ON "session_history_items" ("workspace_id", "session_id", "position")
  WHERE "active";

-- Last model-call input tokens of the most recent turn: the pre-turn
-- client-side compaction trigger reads it as its budget signal (char/4 over the
-- active items is the same-turn fallback). Null until a turn with usage lands.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "last_input_tokens" integer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
