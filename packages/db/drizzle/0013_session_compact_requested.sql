-- Operator /compact request flag (slash-command palette).
--
-- /compact is a manual trigger for the client-side (Azure) context compaction
-- path. The API sets this flag true; the worker honors it BEFORE the next
-- turn's model call by forcing a compaction (bypassing the token-budget
-- trigger), then clears it. A durable column — not a transient signal — so the
-- request survives a worker restart and converges before the next turn.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "compact_requested" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
