-- tracking-18/tracking-21/tracking-22: one prompt queue, one current inference, portable
-- compaction, attempt-fenced publication, coalesced internal updates, and
-- session/workspace Pause.
--
-- This is a one-way maintenance migration. The production release gate stops
-- admission, pauses Temporal Schedules, drains workers, terminates the old
-- session workflows, and scales the old worker fleet to zero before applying
-- it. No old worker or old workflow is allowed to execute after this boundary.

ALTER TABLE "workspaces" ADD COLUMN "inference_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "workspaces" ADD COLUMN "inference_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN "inference_reason" text;
ALTER TABLE "workspaces" ADD COLUMN "inference_changed_by" text;
ALTER TABLE "workspaces" ADD COLUMN "inference_changed_at" timestamptz;

ALTER TABLE "sessions" ADD COLUMN "queue_version" integer NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "queue_head_position" bigint NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "queue_tail_position" bigint NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "control_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "sessions" ADD COLUMN "control_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "control_reason" text;
ALTER TABLE "sessions" ADD COLUMN "control_changed_by" text;
ALTER TABLE "sessions" ADD COLUMN "control_changed_at" timestamptz;
ALTER TABLE "sessions" ADD COLUMN "pending_control_event_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "pending_control_kind" text;
ALTER TABLE "sessions" ADD COLUMN "pending_control_expected_turn_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "pending_control_expected_generation" integer;
ALTER TABLE "sessions" ADD COLUMN "pending_control_expected_attempt_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "workspace_run_exception_generation" integer;

ALTER TABLE "session_turns" ALTER COLUMN "position" TYPE bigint USING "position"::bigint;
ALTER TABLE "session_turns" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "session_turns" ADD COLUMN "execution_generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "session_turns" ADD COLUMN "active_attempt_id" uuid;
ALTER TABLE "session_turns" ADD COLUMN "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "session_turns" ADD COLUMN "cancelled_by" text;
ALTER TABLE "session_turns" ADD COLUMN "cancel_reason" text;

ALTER TABLE "session_events" ADD COLUMN "turn_generation" integer;
ALTER TABLE "session_events" ADD COLUMN "turn_attempt_id" uuid;
ALTER TABLE "session_events" ADD COLUMN "turn_association" text;

ALTER TABLE "scheduled_task_runs" ADD COLUMN "producer_key" text;

CREATE TABLE "session_system_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "classification" text NOT NULL DEFAULT 'info',
  "source_id" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "state" text NOT NULL DEFAULT 'pending',
  "delivered_turn_id" uuid,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Capacity becoming available is an internal update, never a queued goal turn.
-- Retarget the durable waiter receipt from the removed queue representation to
-- the typed update that will drive the next internal inference.
ALTER TABLE "codex_capacity_waiters"
  DROP CONSTRAINT "codex_capacity_waiters_workspace_resumed_turn_fk";
ALTER TABLE "codex_capacity_waiters"
  RENAME COLUMN "resumed_turn_id" TO "resumed_update_id";
UPDATE "codex_capacity_waiters" SET "resumed_update_id" = NULL;

CREATE TABLE "runtime_control_operations" (
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

CREATE TABLE "session_system_update_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "source_session_id" uuid NOT NULL,
  "target_session_id" uuid NOT NULL,
  "dedupe_key" text NOT NULL,
  "kind" text NOT NULL,
  "classification" text NOT NULL,
  "source_id" text NOT NULL,
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lineage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "update_id" uuid,
  "last_error" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "session_pending_tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "attempt_id" uuid NOT NULL,
  "call_id" text NOT NULL,
  "call_type" text NOT NULL,
  "call_item" jsonb NOT NULL,
  "result_item" jsonb,
  "result_recorded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Composite identities make every new foreign key workspace-scoped.
CREATE UNIQUE INDEX "sessions_workspace_id_uq" ON "sessions" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_turns_workspace_id_uq" ON "session_turns" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_events_workspace_id_uq" ON "session_events" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_system_updates_workspace_id_uq"
  ON "session_system_updates" ("workspace_id", "id");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_event_fk"
  FOREIGN KEY ("workspace_id", "pending_control_event_id")
  REFERENCES "session_events"("workspace_id", "id") ON DELETE SET NULL;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_turn_fk"
  FOREIGN KEY ("workspace_id", "pending_control_expected_turn_id")
  REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL;
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_account_fk"
  FOREIGN KEY ("workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_session_fk"
  FOREIGN KEY ("workspace_id", "session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE;
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_workspace_turn_fk"
  FOREIGN KEY ("workspace_id", "delivered_turn_id")
  REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "codex_capacity_waiters" ADD CONSTRAINT "codex_capacity_waiters_workspace_resumed_update_fk"
  FOREIGN KEY ("workspace_id", "resumed_update_id")
  REFERENCES "session_system_updates"("workspace_id", "id") ON DELETE SET NULL;
ALTER TABLE "runtime_control_operations" ADD CONSTRAINT "runtime_control_operations_workspace_account_fk"
  FOREIGN KEY ("workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_workspace_account_fk"
  FOREIGN KEY ("workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_source_session_fk"
  FOREIGN KEY ("workspace_id", "source_session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE;
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_target_session_fk"
  FOREIGN KEY ("workspace_id", "target_session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE;
ALTER TABLE "session_pending_tool_calls" ADD CONSTRAINT "pending_tool_calls_workspace_account_fk"
  FOREIGN KEY ("workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
ALTER TABLE "session_pending_tool_calls" ADD CONSTRAINT "pending_tool_calls_workspace_session_fk"
  FOREIGN KEY ("workspace_id", "session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE;
ALTER TABLE "session_pending_tool_calls" ADD CONSTRAINT "pending_tool_calls_workspace_turn_fk"
  FOREIGN KEY ("workspace_id", "turn_id")
  REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE;

-- Preserve historical evidence while normalizing every event name to the new
-- vocabulary before new workers parse it.
UPDATE "session_events" SET "type" = CASE "type"
  WHEN 'user.interrupt' THEN 'user.pause'
  WHEN 'turn.preempted' THEN 'turn.recovery.requested'
  WHEN 'turn.updated' THEN 'session.queue.history'
  WHEN 'turn.queue_drained' THEN 'session.queue.history'
  WHEN 'system.update.bundle' THEN 'system.update.pending'
  WHEN 'system.update.bundle.updated' THEN 'system.update.pending'
  WHEN 'session.control.stopped' THEN 'session.control.paused'
  WHEN 'session.control.interrupt_requested' THEN 'session.control.paused'
  WHEN 'workspace.inference.killed' THEN 'workspace.inference.paused'
  WHEN 'session.queue.item.edited' THEN 'session.queue.history'
  WHEN 'session.queue.item.promoted' THEN 'session.queue.history'
  WHEN 'session.queue.reordered' THEN 'session.queue.history'
  WHEN 'session.queue.item.cancelled' THEN 'session.queue.prompt.cancelled'
  ELSE "type"
END
WHERE "type" IN (
  'user.interrupt','turn.preempted','turn.updated','turn.queue_drained','system.update.bundle',
  'system.update.bundle.updated','session.control.stopped',
  'session.control.interrupt_requested','workspace.inference.killed',
  'session.queue.item.edited','session.queue.item.promoted',
  'session.queue.reordered','session.queue.item.cancelled'
);

UPDATE "session_goals"
SET "paused_reason" = 'user_pause'
WHERE "paused_reason" = 'user_interrupt';

-- A drained turn that started before and was put back into the old queue is
-- the same current inference in recovery, not a waiting prompt. The drain gate
-- guarantees no old attempt still owns it here.
UPDATE "session_turns" t
SET "status" = 'recovering',
    "active_attempt_id" = NULL,
    "updated_at" = now()
WHERE t."status" = 'running'
   OR (
     t."status" = 'queued'
     AND EXISTS (
       SELECT 1 FROM "session_events" e
       WHERE e."workspace_id" = t."workspace_id"
         AND e."session_id" = t."session_id"
         AND e."turn_id" = t."id"
         AND e."type" = 'turn.started'
     )
   );

-- Unstarted reusable-session machine work moves to the typed update plane.
INSERT INTO "session_system_updates" (
  "account_id", "workspace_id", "session_id", "kind", "classification",
  "source_id", "dedupe_key", "summary", "payload", "lineage"
)
SELECT
  t."account_id", t."workspace_id", t."session_id",
  CASE WHEN t."source" = 'scheduled_task' THEN 'scheduled_wake' ELSE 'runtime_notice' END,
  'info', t."id"::text, 'migrated-turn:' || t."id"::text, t."prompt",
  jsonb_build_object('migratedTurnId', t."id", 'source', t."source"),
  jsonb_build_object('migratedTurnId', t."id")
FROM "session_turns" t
WHERE t."status" = 'queued' AND t."source" IN ('scheduled_task','system');

-- The delivered-turn FK above is INITIALLY DEFERRED because normal runtime
-- fan-in may preallocate an update and its delivered turn in one transaction.
-- This migration still has table-level DDL below (RLS, constraints, indexes).
-- PostgreSQL refuses ALTER TABLE while a table has pending deferred constraint
-- triggers, even when every inserted delivered_turn_id is NULL. Settle the
-- migration's own inserts now; this changes only this transaction's constraint
-- mode and leaves the declared runtime default deferred.
SET CONSTRAINTS ALL IMMEDIATE;

UPDATE "session_turns"
SET "status" = 'superseded',
    "cancelled_by" = 'control-plane-cutover',
    "cancel_reason" = 'migrated_to_internal_update',
    "finished_at" = now(),
    "updated_at" = now()
WHERE "status" = 'queued' AND "source" IN ('scheduled_task','system');

-- An unstarted goal row carries no truth that is not already in session_goals;
-- the generalized wake scan will continue the active goal after cutover.
UPDATE "session_turns"
SET "status" = 'superseded',
    "cancelled_by" = 'control-plane-cutover',
    "cancel_reason" = 'goal_continuation_is_not_queue_work',
    "finished_at" = now(),
    "updated_at" = now()
WHERE "status" = 'queued' AND "source" = 'goal';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "session_turns"
    WHERE "status" = 'queued' AND "source" NOT IN ('user','api')
  ) THEN
    RAISE EXCEPTION 'unclassified queued machine turn remains at control-plane cutover';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "session_turns"
    WHERE "status" NOT IN (
      'queued','running','requires_action','recovering','waiting_capacity',
      'completed','failed','cancelled','superseded'
    )
  ) THEN
    RAISE EXCEPTION 'unknown session turn status at control-plane cutover';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "session_turns"
    WHERE "status" IN ('running','requires_action','recovering','waiting_capacity')
    GROUP BY "workspace_id", "session_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple current inferences found for one session at control-plane cutover';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "session_history_items"
    WHERE "active" = true AND "item" ->> 'type' IN ('compaction','compaction_summary')
  ) THEN
    RAISE EXCEPTION 'active opaque remote compaction item found at control-plane cutover';
  END IF;
END $$;

UPDATE "sessions" s
SET "active_turn_id" = current_turn."id"
FROM (
  SELECT "workspace_id", "session_id", max("id"::text)::uuid AS "id"
  FROM "session_turns"
  WHERE "status" IN ('running','requires_action','recovering','waiting_capacity')
  GROUP BY "workspace_id", "session_id"
) current_turn
WHERE s."workspace_id" = current_turn."workspace_id"
  AND s."id" = current_turn."session_id";

UPDATE "sessions" s
SET "active_turn_id" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "session_turns" t
  WHERE t."workspace_id" = s."workspace_id"
    AND t."session_id" = s."id"
    AND t."status" IN ('running','requires_action','recovering','waiting_capacity')
);

UPDATE "sessions" s
SET "queue_head_position" = bounds."head",
    "queue_tail_position" = bounds."tail"
FROM (
  SELECT "workspace_id", "session_id",
         coalesce(min("position"), 0) AS "head",
         coalesce(max("position"), 0) AS "tail"
  FROM "session_turns"
  GROUP BY "workspace_id", "session_id"
) bounds
WHERE s."workspace_id" = bounds."workspace_id"
  AND s."id" = bounds."session_id";

UPDATE "sessions" s
SET "status" = CASE
  WHEN s."control_state" = 'paused' THEN 'paused'
  WHEN t."status" = 'requires_action' THEN 'requires_action'
  WHEN t."status" = 'recovering' THEN 'recovering'
  WHEN t."status" = 'waiting_capacity' THEN 'waiting_capacity'
  WHEN t."status" = 'running' THEN 'running'
  WHEN EXISTS (
    SELECT 1 FROM "session_turns" q
    WHERE q."workspace_id" = s."workspace_id"
      AND q."session_id" = s."id" AND q."status" = 'queued'
  ) THEN 'queued'
  ELSE 'idle'
END
FROM "session_turns" t
WHERE t."workspace_id" = s."workspace_id"
  AND t."id" = s."active_turn_id";

UPDATE "sessions" s
SET "status" = CASE
  WHEN s."control_state" = 'paused' THEN 'paused'
  WHEN EXISTS (
    SELECT 1 FROM "session_turns" q
    WHERE q."workspace_id" = s."workspace_id"
      AND q."session_id" = s."id" AND q."status" = 'queued'
  ) THEN 'queued'
  ELSE 'idle'
END
WHERE s."active_turn_id" IS NULL;

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_inference_state_check"
  CHECK ("inference_state" IN ('active','paused'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_control_state_check"
  CHECK ("control_state" IN ('active','paused'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_control_kind_check"
  CHECK ("pending_control_kind" IS NULL OR "pending_control_kind" IN ('pause','steer'));
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_status_check"
  CHECK ("status" IN (
    'queued','running','requires_action','recovering','waiting_capacity',
    'completed','failed','cancelled','superseded'
  ));
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_queue_purity_check"
  CHECK ("status" <> 'queued' OR "source" IN ('user','api'));
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_kind_check"
  CHECK ("kind" IN ('child_session_update','scheduled_wake','lifecycle_event','runtime_notice'));
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_classification_check"
  CHECK ("classification" IN ('success','failure','action_required','info'));
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_state_check"
  CHECK ("state" IN ('pending','delivered','cancelled','failed'));
ALTER TABLE "runtime_control_operations" ADD CONSTRAINT "runtime_control_operations_scope_check"
  CHECK ("scope" IN ('session','workspace'));
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_status_check"
  CHECK ("status" IN ('pending','delivered','failed'));
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_turn_association_check"
  CHECK ("turn_association" IS NULL OR "turn_association" IN ('current','late_rejected'));

CREATE UNIQUE INDEX "session_turns_one_current_inference_uq"
  ON "session_turns" ("workspace_id", "session_id")
  WHERE "status" IN ('running','requires_action','recovering','waiting_capacity');
CREATE INDEX "session_turns_prompt_queue_idx"
  ON "session_turns" ("workspace_id", "session_id", "position")
  WHERE "status" = 'queued';
CREATE UNIQUE INDEX "session_system_updates_dedupe_uq"
  ON "session_system_updates" ("workspace_id", "session_id", "dedupe_key");
CREATE INDEX "session_system_updates_pending_idx"
  ON "session_system_updates" ("workspace_id", "session_id", "state", "created_at");
CREATE UNIQUE INDEX "runtime_control_operations_client_uq"
  ON "runtime_control_operations" ("workspace_id", "client_event_id");
CREATE INDEX "runtime_control_operations_target_idx"
  ON "runtime_control_operations" ("workspace_id", "scope", "target_id", "created_at");
CREATE UNIQUE INDEX "session_system_update_outbox_dedupe_uq"
  ON "session_system_update_outbox" ("workspace_id", "dedupe_key");
CREATE INDEX "session_system_update_outbox_pending_idx"
  ON "session_system_update_outbox" ("status", "created_at");
CREATE UNIQUE INDEX "session_pending_tool_calls_turn_call_idx"
  ON "session_pending_tool_calls" ("workspace_id", "turn_id", "call_id");
CREATE INDEX "session_pending_tool_calls_session_turn_idx"
  ON "session_pending_tool_calls" ("workspace_id", "session_id", "turn_id");
CREATE UNIQUE INDEX "scheduled_task_runs_producer_key_uq"
  ON "scheduled_task_runs" ("workspace_id", "producer_key")
  WHERE "producer_key" IS NOT NULL;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_session_inference_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'running' AND OLD.status <> 'running'
     AND coalesce(current_setting('opengeni.session_inference_claim', true), '') <> '1' THEN
    RAISE EXCEPTION 'session inference must be claimed through the fenced claim transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_turns_inference_claim_guard
BEFORE UPDATE OF status ON "session_turns" FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_session_inference_claim();

ALTER TABLE "session_system_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_pending_tool_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_pending_tool_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_system_updates"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "runtime_control_operations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_system_update_outbox"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_pending_tool_calls"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Bounded cross-workspace recovery claim for the worker outbox reconciler.
CREATE OR REPLACE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, payload jsonb, lineage jsonb
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
      o.target_session_id, o.dedupe_key, o.kind, o.classification,
      o.source_id, o.summary, o.payload, o.lineage;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;

-- Generalized post-cutover repair scan. It returns each runnable session once;
-- the workflow claim transaction chooses recovery, prompt, then update/goal.
CREATE OR REPLACE FUNCTION opengeni_private.list_claimable_sessions(p_limit integer)
RETURNS TABLE (
  account_id uuid, workspace_id uuid, session_id uuid, temporal_workflow_id text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT DISTINCT s.account_id, s.workspace_id, s.id,
         coalesce(s.temporal_workflow_id, 'session-' || s.id::text)
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  WHERE s.control_state = 'active'
    AND (
      w.inference_state = 'active'
      OR s.workspace_run_exception_generation = w.inference_generation
    )
    AND s.pending_control_event_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM session_turns t
        WHERE t.workspace_id = s.workspace_id AND t.session_id = s.id
          AND t.status IN ('queued','recovering','waiting_capacity')
      )
      OR EXISTS (
        SELECT 1 FROM session_system_updates u
        WHERE u.workspace_id = s.workspace_id AND u.session_id = s.id
          AND u.state = 'pending'
      )
      OR EXISTS (
        SELECT 1 FROM session_goals g
        WHERE g.workspace_id = s.workspace_id AND g.session_id = s.id
          AND g.status = 'active'
      )
    )
  ORDER BY s.id
  LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000));
$$;
REVOKE ALL ON FUNCTION opengeni_private.list_claimable_sessions(integer) FROM PUBLIC;

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_claimable_sessions(integer)
      TO opengeni_app;
  END IF;
END $$;
