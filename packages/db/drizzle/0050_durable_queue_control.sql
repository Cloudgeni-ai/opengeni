-- OPE-18: durable typed queue, generation-fenced system-update fan-in, and
-- session/workspace inference controls. 0049 is intentionally reserved for
-- OPE-21 credential leases; this migration is additive and rolling-safe.

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_reason" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_changed_by" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_changed_at" timestamptz;

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "queue_version" integer NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_reason" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_changed_by" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_changed_at" timestamptz;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "steer_target_turn_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pending_control_event_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pending_control_kind" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pending_control_expected_turn_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pending_control_expected_generation" integer;

ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "queue_kind" text NOT NULL DEFAULT 'human_message';
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'human';
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 100;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "execution_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "delivery_state" text NOT NULL DEFAULT 'pending';
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamptz;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "promoted_at" timestamptz;

-- Honest typed backfill for pre-OPE-18 rows.
UPDATE "session_turns"
SET
  "queue_kind" = CASE
    WHEN "source" = 'scheduled_task' THEN 'scheduled_wake'
    WHEN "source" = 'goal' THEN 'goal_continuation'
    WHEN "source" = 'api' THEN 'operator_instruction'
    ELSE 'human_message'
  END,
  "origin" = CASE
    WHEN "source" = 'api' THEN 'operator'
    WHEN "source" IN ('scheduled_task', 'goal') THEN 'system'
    ELSE 'human'
  END,
  "priority" = CASE
    WHEN "source" = 'api' THEN 50
    WHEN "source" = 'scheduled_task' THEN 200
    WHEN "source" = 'goal' THEN 300
    ELSE 100
  END
WHERE "execution_generation" = 0;

CREATE TABLE IF NOT EXISTS "session_system_update_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "version" integer NOT NULL DEFAULT 1,
  "member_count" integer NOT NULL DEFAULT 0,
  "payload_bytes" integer NOT NULL DEFAULT 0,
  "overflow" boolean NOT NULL DEFAULT false,
  "wake_turn_id" uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,
  "claimed_at" timestamptz,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session_system_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "bundle_id" uuid NOT NULL REFERENCES "session_system_update_bundles"("id") ON DELETE CASCADE,
  "bundle_generation" integer NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" text NOT NULL,
  "classification" text NOT NULL DEFAULT 'info',
  "source_id" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "delivery_state" text NOT NULL DEFAULT 'pending',
  "delivered_at" timestamptz,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "bundle_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_steer_target_turn_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_steer_target_turn_fk"
      FOREIGN KEY ("steer_target_turn_id") REFERENCES "session_turns"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_pending_control_event_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_event_fk"
      FOREIGN KEY ("pending_control_event_id") REFERENCES "session_events"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_pending_control_turn_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_turn_fk"
      FOREIGN KEY ("pending_control_expected_turn_id") REFERENCES "session_turns"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_bundle_fk') THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_bundle_fk"
      FOREIGN KEY ("bundle_id") REFERENCES "session_system_update_bundles"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_bundles_workspace_account_fk') THEN
    ALTER TABLE "session_system_update_bundles" ADD CONSTRAINT "system_update_bundles_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_workspace_account_fk') THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_generation_uq"
  ON "session_system_update_bundles" ("workspace_id", "session_id", "generation");
CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_one_queued_uq"
  ON "session_system_update_bundles" ("workspace_id", "session_id") WHERE "status" = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_one_running_uq"
  ON "session_system_update_bundles" ("workspace_id", "session_id") WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "system_update_bundles_session_status_idx"
  ON "session_system_update_bundles" ("workspace_id", "session_id", "status", "generation");
CREATE UNIQUE INDEX IF NOT EXISTS "system_updates_dedupe_uq"
  ON "session_system_updates" ("workspace_id", "session_id", "dedupe_key");
CREATE UNIQUE INDEX IF NOT EXISTS "system_updates_bundle_ordinal_uq"
  ON "session_system_updates" ("workspace_id", "bundle_id", "ordinal");
CREATE INDEX IF NOT EXISTS "system_updates_bundle_page_idx"
  ON "session_system_updates" ("workspace_id", "bundle_id", "ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "session_turns_queue_dedupe_uq"
  ON "session_turns" ("workspace_id", "session_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session_turns_priority_queue_idx"
  ON "session_turns" ("workspace_id", "session_id", "status", "priority", "position");

ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "turn_generation" integer;

ALTER TABLE "session_system_update_bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_bundles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'session_system_update_bundles' AND policyname = 'workspace_isolation') THEN
    DROP POLICY workspace_isolation ON "session_system_update_bundles";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'session_system_updates' AND policyname = 'workspace_isolation') THEN
    DROP POLICY workspace_isolation ON "session_system_updates";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_system_update_bundles"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_system_updates"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app', current_schema());
  END IF;
END $$;