-- Immediate-offline on a CLEAN going-offline signal.
--
-- A machine that explicitly announced "I'm stopping" (a typed GoingOffline:
-- user-stop / self-update / host-shutdown) must read OFFLINE immediately — for the
-- Machines dashboard AND for anything deciding whether to route work at it —
-- instead of waiting out the last_seen dead-detect window. Persist that goodbye as
-- a nullable marker on the enrollment: went_offline_at (WHEN it said goodbye) +
-- went_offline_reason (the typed reason string). The liveness derivation gives an
-- un-cleared marker precedence over last_seen aging; ANY newer liveness signal (a
-- reconnect Hello or a fresher heartbeat) clears it back to NULL. Both NULL (the
-- default) ⇒ today's behavior exactly — every existing + new row is a
-- behavior-preserving no-op, no backfill.
ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "went_offline_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "went_offline_reason" text;

-- Re-grant on the new columns (idempotent; schema-agnostic per the Migration
-- Authoring rules — grants target current_schema() via dynamic SQL so an embedded
-- host running under a dedicated data schema is covered, not just `public`).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;
