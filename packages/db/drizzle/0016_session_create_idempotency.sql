-- Workspace-scoped CREATE idempotency for sessions.
--
-- Closes the stuck-queued create-path bug: createSessionForRequest used to
-- unconditionally insert a brand-new session on every call, so a double-fire
-- (client double-submit / retry / double-dispatch) created duplicate sessions,
-- some stranded status=queued forever. clientEventId cannot dedup this — its
-- unique index is per-session, so two brand-new sessions never collide on it.
--
-- The new nullable key + PARTIAL unique index gives the create path a
-- workspace-scoped dedup target: concurrent creates carrying the same key
-- collapse to a single row (the loser sees a unique violation, which the
-- domain layer catches and turns into "return the existing session"). NULL
-- keys are exempt from the index, so back-compat (key-less) creates stay
-- independent and existing rows need no backfill.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "create_idempotency_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "sessions_workspace_create_idempotency_idx"
  ON "sessions" ("workspace_id", "create_idempotency_key")
  WHERE "create_idempotency_key" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
