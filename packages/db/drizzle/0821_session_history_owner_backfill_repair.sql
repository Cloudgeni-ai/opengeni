-- deployment-mode: rolling
-- opengeni:session-history-owner-backfill-v1
-- Repair already-ledgered 0809/0811 no-ops using owner-only policies and
-- independently committed, workspace-fenced batches. Never relax FORCE RLS.
-- The codec-aware migration runner executes this exact stage and removes its
-- temporary owner policies on success or failure. Old runners fail closed.
DO $$ BEGIN
  RAISE EXCEPTION 'session history backfill requires the current migration runner';
END $$;
