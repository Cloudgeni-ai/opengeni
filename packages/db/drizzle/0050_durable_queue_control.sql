-- OPE-18: durable typed queue, generation-fenced system-update fan-in, and
-- session/workspace inference controls. Migration 0049 remains reserved for
-- OPE-21 credential leasing; OPE-20 lifecycle primitives are planned for 0055.
--
-- Rolling contract:
--   * schema first, with workspaces.queue_runtime_state = 'legacy';
--   * controls/fan-in refuse to mutate while the workspace remains legacy;
--   * after every worker understands OPE-18, an explicit CAS cutover changes
--     the workspace to durable_v1;
--   * a trigger then rejects queued->running claims from old workers, which do
--     not set the transaction-local opengeni.queue_runtime_capability marker.

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_reason" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_changed_by" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inference_changed_at" timestamptz;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "queue_runtime_state" text NOT NULL DEFAULT 'legacy';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "queue_runtime_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "queue_runtime_reason" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "queue_runtime_changed_by" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "queue_runtime_changed_at" timestamptz;

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
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "control_state_before_workspace_kill" text;

-- Install the sentinel default BEFORE the typed queue defaults. Rows that
-- predate 0050 receive NULL because ADD COLUMN without a default does not
-- rewrite them; every concurrent/post-migration producer receives a non-null
-- timestamp even if it still writes generation 0. The backfill can therefore
-- select a population that no new typed row can ever join.
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "queue_migrated_at" timestamptz;
ALTER TABLE "session_turns" ALTER COLUMN "queue_migrated_at" SET DEFAULT now();

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
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "bundle_id" uuid;

UPDATE "session_turns"
SET
  "queue_kind" = CASE
    WHEN "source" = 'scheduled_task' THEN 'scheduled_wake'
    WHEN "source" = 'goal' THEN 'goal_continuation'
    WHEN "source" = 'api' THEN 'operator_instruction'
    WHEN "source" = 'system' THEN 'runtime_notice'
    ELSE 'human_message'
  END,
  "origin" = CASE
    WHEN "source" = 'api' THEN 'operator'
    WHEN "source" IN ('scheduled_task', 'goal', 'system') THEN 'system'
    ELSE 'human'
  END,
  "priority" = CASE
    WHEN "source" = 'api' THEN 50
    WHEN "source" IN ('scheduled_task', 'system') THEN 200
    WHEN "source" = 'goal' THEN 300
    ELSE 100
  END,
  "queue_migrated_at" = now()
WHERE "queue_migrated_at" IS NULL;
ALTER TABLE "session_turns" ALTER COLUMN "queue_migrated_at" SET NOT NULL;

ALTER TABLE "scheduled_task_runs" ADD COLUMN IF NOT EXISTS "producer_key" text;

CREATE TABLE IF NOT EXISTS "session_system_update_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "group_key" text NOT NULL,
  "execution_policy" jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "version" integer NOT NULL DEFAULT 1,
  "member_count" integer NOT NULL DEFAULT 0,
  "payload_bytes" integer NOT NULL DEFAULT 0,
  "overflow" boolean NOT NULL DEFAULT false,
  "wake_turn_id" uuid,
  "claimed_at" timestamptz,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session_system_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "bundle_id" uuid NOT NULL,
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

CREATE TABLE IF NOT EXISTS "runtime_control_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "target_id" uuid NOT NULL,
  "client_event_id" text NOT NULL,
  "requested_state" text NOT NULL,
  "expected_state" text,
  "expected_generation" integer,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session_system_update_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "source_session_id" uuid NOT NULL,
  "target_session_id" uuid NOT NULL,
  "dedupe_key" text NOT NULL,
  "grouping_key" text NOT NULL,
  "kind" text NOT NULL,
  "classification" text NOT NULL,
  "source_id" text NOT NULL,
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "update_id" uuid,
  "bundle_id" uuid,
  "wake_turn_id" uuid,
  "last_error" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "turn_generation" integer;
ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "turn_association" text;

-- Composite identity targets. IDs remain globally unique; these indexes make
-- workspace identity independently enforceable and eliminate ambiguous joins.
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_workspace_id_uq" ON "sessions" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "session_turns_workspace_id_uq" ON "session_turns" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_id_uq" ON "session_events" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_workspace_id_uq" ON "session_system_update_bundles" ("workspace_id", "id");

-- All constraint existence checks are relation-scoped. A same-named constraint
-- in another embedded schema/table must never suppress this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_steer_target_turn_fk' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_steer_target_turn_fk"
      FOREIGN KEY ("workspace_id", "steer_target_turn_id") REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_pending_control_event_fk' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_event_fk"
      FOREIGN KEY ("workspace_id", "pending_control_event_id") REFERENCES "session_events"("workspace_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_pending_control_turn_fk' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_turn_fk"
      FOREIGN KEY ("workspace_id", "pending_control_expected_turn_id") REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_bundle_fk' AND conrelid = format('%I.%I', current_schema(), 'session_turns')::regclass) THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_bundle_fk"
      FOREIGN KEY ("workspace_id", "bundle_id") REFERENCES "session_system_update_bundles"("workspace_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_bundles_workspace_account_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_bundles')::regclass) THEN
    ALTER TABLE "session_system_update_bundles" ADD CONSTRAINT "system_update_bundles_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_bundles_workspace_session_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_bundles')::regclass) THEN
    ALTER TABLE "session_system_update_bundles" ADD CONSTRAINT "system_update_bundles_workspace_session_fk"
      FOREIGN KEY ("workspace_id", "session_id") REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_bundles_workspace_turn_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_bundles')::regclass) THEN
    ALTER TABLE "session_system_update_bundles" ADD CONSTRAINT "system_update_bundles_workspace_turn_fk"
      FOREIGN KEY ("workspace_id", "wake_turn_id") REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_workspace_account_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_workspace_session_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_session_fk"
      FOREIGN KEY ("workspace_id", "session_id") REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_workspace_bundle_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_bundle_fk"
      FOREIGN KEY ("workspace_id", "bundle_id") REFERENCES "session_system_update_bundles"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_control_operations_workspace_account_fk' AND conrelid = format('%I.%I', current_schema(), 'runtime_control_operations')::regclass) THEN
    ALTER TABLE "runtime_control_operations" ADD CONSTRAINT "runtime_control_operations_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_outbox_workspace_account_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_outbox')::regclass) THEN
    ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_outbox_source_session_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_outbox')::regclass) THEN
    ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_source_session_fk"
      FOREIGN KEY ("workspace_id", "source_session_id") REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_outbox_target_session_fk' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_outbox')::regclass) THEN
    ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_target_session_fk"
      FOREIGN KEY ("workspace_id", "target_session_id") REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_steer_target_turn_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_pending_control_event_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_pending_control_turn_fk";
ALTER TABLE "session_turns" VALIDATE CONSTRAINT "session_turns_bundle_fk";
ALTER TABLE "session_system_update_bundles" VALIDATE CONSTRAINT "system_update_bundles_workspace_account_fk";
ALTER TABLE "session_system_update_bundles" VALIDATE CONSTRAINT "system_update_bundles_workspace_session_fk";
ALTER TABLE "session_system_update_bundles" VALIDATE CONSTRAINT "system_update_bundles_workspace_turn_fk";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_workspace_account_fk";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_workspace_session_fk";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_workspace_bundle_fk";
ALTER TABLE "runtime_control_operations" VALIDATE CONSTRAINT "runtime_control_operations_workspace_account_fk";
ALTER TABLE "session_system_update_outbox" VALIDATE CONSTRAINT "system_update_outbox_workspace_account_fk";
ALTER TABLE "session_system_update_outbox" VALIDATE CONSTRAINT "system_update_outbox_source_session_fk";
ALTER TABLE "session_system_update_outbox" VALIDATE CONSTRAINT "system_update_outbox_target_session_fk";

-- Enum-like checks are installed NOT VALID first for low-impact rollout, then
-- validated explicitly. Drizzle/runtime casts use the same contract enums.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_inference_state_check' AND conrelid = format('%I.%I', current_schema(), 'workspaces')::regclass) THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_inference_state_check" CHECK ("inference_state" IN ('active','killed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_queue_runtime_state_check' AND conrelid = format('%I.%I', current_schema(), 'workspaces')::regclass) THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_queue_runtime_state_check" CHECK ("queue_runtime_state" IN ('legacy','durable_v1')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_control_state_check' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_control_state_check" CHECK ("control_state" IN ('active','session_stopped','workspace_killed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_control_state_before_kill_check' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_control_state_before_kill_check" CHECK ("control_state_before_workspace_kill" IS NULL OR "control_state_before_workspace_kill" IN ('active','session_stopped','workspace_killed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_pending_control_kind_check' AND conrelid = format('%I.%I', current_schema(), 'sessions')::regclass) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_kind_check" CHECK ("pending_control_kind" IS NULL OR "pending_control_kind" IN ('interrupt','stop','steer','workspace_kill')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_queue_kind_check' AND conrelid = format('%I.%I', current_schema(), 'session_turns')::regclass) THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_queue_kind_check" CHECK ("queue_kind" IN ('human_message','operator_instruction','child_session_update','scheduled_wake','goal_continuation','runtime_notice','system_update_bundle')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_origin_check' AND conrelid = format('%I.%I', current_schema(), 'session_turns')::regclass) THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_origin_check" CHECK ("origin" IN ('human','operator','system')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_delivery_state_check' AND conrelid = format('%I.%I', current_schema(), 'session_turns')::regclass) THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_delivery_state_check" CHECK ("delivery_state" IN ('pending','delivered','acknowledged','cancelled','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_bundles_status_check' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_bundles')::regclass) THEN
    ALTER TABLE "session_system_update_bundles" ADD CONSTRAINT "system_update_bundles_status_check" CHECK ("status" IN ('queued','running','acknowledged','cancelled','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_kind_check' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_kind_check" CHECK ("kind" IN ('child_session_update','scheduled_wake','lifecycle_event','runtime_notice')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_classification_check' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_classification_check" CHECK ("classification" IN ('success','failure','action_required','info')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_updates_delivery_state_check' AND conrelid = format('%I.%I', current_schema(), 'session_system_updates')::regclass) THEN
    ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_delivery_state_check" CHECK ("delivery_state" IN ('pending','delivered','acknowledged','cancelled','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_control_operations_scope_check' AND conrelid = format('%I.%I', current_schema(), 'runtime_control_operations')::regclass) THEN
    ALTER TABLE "runtime_control_operations" ADD CONSTRAINT "runtime_control_operations_scope_check" CHECK ("scope" IN ('session','descendants','workspace','queue_runtime')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_update_outbox_status_check' AND conrelid = format('%I.%I', current_schema(), 'session_system_update_outbox')::regclass) THEN
    ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_status_check" CHECK ("status" IN ('pending','delivered','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_events_turn_association_check' AND conrelid = format('%I.%I', current_schema(), 'session_events')::regclass) THEN
    ALTER TABLE "session_events" ADD CONSTRAINT "session_events_turn_association_check" CHECK ("turn_association" IS NULL OR "turn_association" IN ('current','late_rejected')) NOT VALID;
  END IF;
END $$;

ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_inference_state_check";
ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_queue_runtime_state_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_control_state_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_control_state_before_kill_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_pending_control_kind_check";
ALTER TABLE "session_turns" VALIDATE CONSTRAINT "session_turns_queue_kind_check";
ALTER TABLE "session_turns" VALIDATE CONSTRAINT "session_turns_origin_check";
ALTER TABLE "session_turns" VALIDATE CONSTRAINT "session_turns_delivery_state_check";
ALTER TABLE "session_system_update_bundles" VALIDATE CONSTRAINT "system_update_bundles_status_check";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_kind_check";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_classification_check";
ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_delivery_state_check";
ALTER TABLE "runtime_control_operations" VALIDATE CONSTRAINT "runtime_control_operations_scope_check";
ALTER TABLE "session_system_update_outbox" VALIDATE CONSTRAINT "system_update_outbox_status_check";
ALTER TABLE "session_events" VALIDATE CONSTRAINT "session_events_turn_association_check";

CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_generation_uq"
  ON "session_system_update_bundles" ("workspace_id", "session_id", "generation");
DROP INDEX IF EXISTS "system_update_bundles_one_queued_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "system_update_bundles_one_queued_group_uq"
  ON "session_system_update_bundles" ("workspace_id", "session_id", "group_key") WHERE "status" = 'queued';
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
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_control_operations_client_uq"
  ON "runtime_control_operations" ("workspace_id", "client_event_id");
CREATE INDEX IF NOT EXISTS "runtime_control_operations_target_idx"
  ON "runtime_control_operations" ("workspace_id", "scope", "target_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "session_system_update_outbox_dedupe_uq"
  ON "session_system_update_outbox" ("workspace_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "session_system_update_outbox_pending_idx"
  ON "session_system_update_outbox" ("status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_task_runs_producer_key_uq"
  ON "scheduled_task_runs" ("workspace_id", "producer_key") WHERE "producer_key" IS NOT NULL;

-- Normalize rows inserted by an old producer after schema-first migration but
-- before durable cutover. New typed producers that supply non-default values
-- pass through unchanged.
CREATE OR REPLACE FUNCTION opengeni_private.normalize_legacy_session_turn_queue()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.queue_kind = 'human_message' AND NEW.origin = 'human' AND NEW.priority = 100 THEN
    IF NEW.source = 'scheduled_task' THEN NEW.queue_kind := 'scheduled_wake'; NEW.origin := 'system'; NEW.priority := 200;
    ELSIF NEW.source = 'goal' THEN NEW.queue_kind := 'goal_continuation'; NEW.origin := 'system'; NEW.priority := 300;
    ELSIF NEW.source = 'api' THEN NEW.queue_kind := 'operator_instruction'; NEW.origin := 'operator'; NEW.priority := 50;
    ELSIF NEW.source = 'system' THEN NEW.queue_kind := 'runtime_notice'; NEW.origin := 'system'; NEW.priority := 200;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_turns_legacy_queue_normalize ON "session_turns";
CREATE TRIGGER session_turns_legacy_queue_normalize
BEFORE INSERT ON "session_turns" FOR EACH ROW
EXECUTE FUNCTION opengeni_private.normalize_legacy_session_turn_queue();

CREATE OR REPLACE FUNCTION opengeni_private.enforce_durable_queue_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE runtime_state text;
BEGIN
  IF OLD.status = 'queued' AND NEW.status = 'running' THEN
    EXECUTE format('SELECT queue_runtime_state FROM %I.workspaces WHERE id = $1', TG_TABLE_SCHEMA)
      INTO runtime_state USING NEW.workspace_id;
    IF runtime_state = 'durable_v1'
       AND coalesce(current_setting('opengeni.queue_runtime_capability', true), '') <> 'durable_v1' THEN
      RAISE EXCEPTION 'durable queue claim requires a compatible worker' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_turns_durable_claim_guard ON "session_turns";
CREATE TRIGGER session_turns_durable_claim_guard
BEFORE UPDATE OF status ON "session_turns" FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_durable_queue_claim();

ALTER TABLE "session_system_update_bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_bundles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'session_system_update_bundles' AND policyname = 'workspace_isolation') THEN DROP POLICY workspace_isolation ON "session_system_update_bundles"; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'session_system_updates' AND policyname = 'workspace_isolation') THEN DROP POLICY workspace_isolation ON "session_system_updates"; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'runtime_control_operations' AND policyname = 'workspace_isolation') THEN DROP POLICY workspace_isolation ON "runtime_control_operations"; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'session_system_update_outbox' AND policyname = 'workspace_isolation') THEN DROP POLICY workspace_isolation ON "session_system_update_outbox"; END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_system_update_bundles" USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_system_updates" USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "runtime_control_operations" USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_system_update_outbox" USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Bounded cross-workspace recovery claim for the one global worker reaper.
-- Rows stay pending until fan-in commits; a worker death after this claim simply
-- makes the next sweep claim them again. No credential/prompt secret is present.
CREATE OR REPLACE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, grouping_key text, kind text,
  classification text, source_id text, summary text, payload jsonb, lineage jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    )
    UPDATE session_system_update_outbox o
    SET attempts = o.attempts + 1, updated_at = now()
    FROM claimed c WHERE o.id = c.id
    RETURNING o.id, o.account_id, o.workspace_id, o.source_session_id,
      o.target_session_id, o.dedupe_key, o.grouping_key, o.kind,
      o.classification, o.source_id, o.summary, o.payload, o.lineage;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;

-- Repair a DB-committed system bundle whose producer died before signalling
-- Temporal. This is intentionally a read-only bounded scan: repeated signals
-- are harmless, while claimNextQueuedTurn is the only generation creator.
CREATE OR REPLACE FUNCTION opengeni_private.list_pending_session_system_wakes(p_limit integer)
RETURNS TABLE (
  account_id uuid, workspace_id uuid, session_id uuid,
  temporal_workflow_id text, turn_id uuid, trigger_event_id uuid
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT s.account_id, s.workspace_id, s.id,
         coalesce(s.temporal_workflow_id, 'session-' || s.id::text),
         t.id, t.trigger_event_id
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN session_turns t
    ON t.workspace_id = s.workspace_id AND t.session_id = s.id
  WHERE w.queue_runtime_state = 'durable_v1'
    AND w.inference_state = 'active'
    AND s.control_state = 'active'
    AND s.active_turn_id IS NULL
    AND s.pending_control_event_id IS NULL
    AND t.status = 'queued'
    AND t.queue_kind = 'system_update_bundle'
  ORDER BY t.created_at, t.id
  LIMIT greatest(1, least(coalesce(p_limit, 100), 100));
$$;
REVOKE ALL ON FUNCTION opengeni_private.list_pending_session_system_wakes(integer) FROM PUBLIC;

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app', target_schema);
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_pending_session_system_wakes(integer) TO opengeni_app;
  END IF;
END $$;