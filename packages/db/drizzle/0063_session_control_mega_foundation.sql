-- deployment-mode: maintenance
-- tracking-18/tracking-54: one-way queue/control maintenance cutover. Old workers are
-- drained before this migration; obsolete columns are removed in this same
-- transaction so no mixed runtime architecture can survive deployment.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

-- Queue Edit has a distinct terminal fate: it atomically checks the prompt out
-- into the private composer rather than pretending the human deleted it.
ALTER TABLE "session_turns" DROP CONSTRAINT "session_turns_status_check";
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_status_check"
  CHECK ("status" IN (
    'queued','running','requires_action','recovering','waiting_capacity',
    'completed','failed','cancelled','superseded','withdrawn_for_edit'
  ));

-- Parentage is immutable, workspace-scoped, and structurally complete. Fail
-- before changing the FK if historical data violates the new ownership model.
DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sessions" child
    JOIN "sessions" parent ON parent."id" = child."parent_session_id"
    WHERE child."parent_session_id" IS NOT NULL
      AND child."workspace_id" <> parent."workspace_id"
  ) THEN
    RAISE EXCEPTION 'session-control cutover: cross-workspace parent link';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "sessions" WHERE "parent_session_id" = "id"
  ) THEN
    RAISE EXCEPTION 'session-control cutover: self-parent session';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT s."workspace_id", s."id" AS origin_id, s."parent_session_id" AS next_id,
             ARRAY[s."id"]::uuid[] AS path
      FROM "sessions" s
      WHERE s."parent_session_id" IS NOT NULL
      UNION ALL
      SELECT a."workspace_id", a.origin_id, parent."parent_session_id",
             a.path || parent."id"
      FROM ancestry a
      JOIN "sessions" parent
        ON parent."workspace_id" = a."workspace_id" AND parent."id" = a.next_id
      WHERE a.next_id IS NOT NULL
        AND NOT parent."id" = ANY(a.path)
        AND cardinality(a.path) <= 10000
    )
    SELECT 1
    FROM ancestry a
    WHERE a.next_id = ANY(a.path)
  ) THEN
    RAISE EXCEPTION 'session-control cutover: cyclic session ancestry';
  END IF;
END $audit$;

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_parent_session_id_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_not_self_check"
  CHECK ("parent_session_id" IS NULL OR "parent_session_id" <> "id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_parent_fk"
  FOREIGN KEY ("workspace_id", "parent_session_id")
  REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT;

CREATE TABLE "workspace_inference_controls" (
  "workspace_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT 0,
  "workspace_state" text NOT NULL DEFAULT 'active',
  "workspace_pause_revision" bigint,
  "reason" text,
  "changed_by" text,
  "changed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_inference_controls_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_inference_controls_state_check"
    CHECK ("workspace_state" IN ('active', 'paused')),
  CONSTRAINT "workspace_inference_controls_pause_revision_check"
    CHECK (
      ("workspace_state" = 'active' AND "workspace_pause_revision" IS NULL)
      OR ("workspace_state" = 'paused' AND "workspace_pause_revision" IS NOT NULL)
    ),
  CONSTRAINT "workspace_inference_controls_revision_check"
    CHECK (
      "revision" >= 0
      AND ("workspace_pause_revision" IS NULL OR "workspace_pause_revision" <= "revision")
    )
);
CREATE UNIQUE INDEX "workspace_inference_controls_workspace_account_uq"
  ON "workspace_inference_controls" ("workspace_id", "account_id");

ALTER TABLE "sessions" ADD COLUMN "direct_control_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "sessions" ADD COLUMN "direct_pause_revision" bigint;
ALTER TABLE "sessions" ADD COLUMN "subtree_run_override_revision" bigint;
ALTER TABLE "sessions" ADD COLUMN "control_version" bigint NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "direct_control_reason" text;
ALTER TABLE "sessions" ADD COLUMN "direct_control_changed_by" text;
ALTER TABLE "sessions" ADD COLUMN "direct_control_changed_at" timestamptz;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_direct_control_state_check"
  CHECK ("direct_control_state" IN ('active', 'paused'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_direct_pause_revision_check"
  CHECK (
    ("direct_control_state" = 'active' AND "direct_pause_revision" IS NULL)
    OR ("direct_control_state" = 'paused' AND "direct_pause_revision" IS NOT NULL)
  );
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_control_revision_order_check"
  CHECK (
    "control_version" >= 0
    AND ("direct_pause_revision" IS NULL OR "direct_pause_revision" <= "control_version")
    AND (
      "subtree_run_override_revision" IS NULL
      OR "subtree_run_override_revision" <= "control_version"
    )
  );

CREATE TABLE "session_turn_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'claimed',
  "outcome" text,
  "temporal_workflow_id" text NOT NULL,
  "temporal_workflow_run_id" text NOT NULL,
  "temporal_activity_id" text NOT NULL,
  "worker_id" text,
  "lease_id" text,
  "lease_expires_at" timestamptz,
  "verified_control_revision" bigint NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "session_turn_attempts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_attempts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_attempts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_attempts_state_check"
    CHECK ("state" IN ('claimed', 'running', 'closed')),
  CONSTRAINT "session_turn_attempts_outcome_check"
    CHECK (
      "outcome" IS NULL OR "outcome" IN (
        'completed', 'failed', 'cancelled', 'superseded', 'requires_action',
        'interrupted_recoverable', 'lease_lost_recoverable', 'pre_cutover_closed'
      )
    ),
  CONSTRAINT "session_turn_attempts_closed_check"
    CHECK (
      ("state" = 'closed' AND "outcome" IS NOT NULL AND "closed_at" IS NOT NULL)
      OR ("state" <> 'closed' AND "outcome" IS NULL AND "closed_at" IS NULL)
    )
);
CREATE UNIQUE INDEX "session_turn_attempts_workspace_id_uq"
  ON "session_turn_attempts" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_turn_attempts_live_turn_uq"
  ON "session_turn_attempts" ("workspace_id", "turn_id")
  WHERE "state" IN ('claimed', 'running');
CREATE UNIQUE INDEX "session_turn_attempts_live_session_uq"
  ON "session_turn_attempts" ("workspace_id", "session_id")
  WHERE "state" IN ('claimed', 'running');
CREATE UNIQUE INDEX "session_turn_attempts_dispatch_uq"
  ON "session_turn_attempts" ("workspace_id", "temporal_workflow_run_id", "temporal_activity_id");
CREATE INDEX "session_turn_attempts_lease_expiry_idx"
  ON "session_turn_attempts" ("lease_expires_at", "workspace_id", "session_id")
  WHERE "state" IN ('claimed', 'running');

-- Every historical UUID that still participates in attempt lineage becomes one
-- closed first-class attempt before any new FK is installed. The maintenance
-- drain guarantees none of these is a live owner. Conflicting reuse of one UUID
-- across two turns/generations is corruption and aborts the whole migration.
CREATE TEMP TABLE "cutover_attempt_ownership" (
  "attempt_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "temporal_workflow_id" text NOT NULL,
  "started_at" timestamptz
) ON COMMIT DROP;

DO $attempt_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "session_events" event
    LEFT JOIN "session_turns" turn
      ON turn."workspace_id" = event."workspace_id" AND turn."id" = event."turn_id"
    WHERE event."turn_attempt_id" IS NOT NULL
      AND (
        turn."id" IS NULL
        OR turn."session_id" <> event."session_id"
        OR event."turn_generation" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'session-control cutover: unclassifiable event attempt ownership';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "sessions" session
    LEFT JOIN "session_turns" turn
      ON turn."workspace_id" = session."workspace_id"
     AND turn."id" = session."pending_control_expected_turn_id"
    WHERE session."pending_control_expected_attempt_id" IS NOT NULL
      AND (
        turn."id" IS NULL
        OR turn."session_id" <> session."id"
        OR session."pending_control_expected_generation" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'session-control cutover: unclassifiable pending-control attempt ownership';
  END IF;
END $attempt_preflight$;

INSERT INTO "cutover_attempt_ownership"
SELECT turn."active_attempt_id", turn."account_id", turn."workspace_id", turn."session_id",
       turn."id", turn."execution_generation", turn."temporal_workflow_id", turn."started_at"
FROM "session_turns" turn
WHERE turn."active_attempt_id" IS NOT NULL
UNION ALL
SELECT event."turn_attempt_id", event."account_id", event."workspace_id", event."session_id",
       turn."id", event."turn_generation", turn."temporal_workflow_id", event."occurred_at"
FROM "session_events" event
JOIN "session_turns" turn
  ON turn."workspace_id" = event."workspace_id" AND turn."id" = event."turn_id"
WHERE event."turn_attempt_id" IS NOT NULL
UNION ALL
SELECT call."attempt_id", call."account_id", call."workspace_id", call."session_id",
       call."turn_id", call."execution_generation", turn."temporal_workflow_id", call."created_at"
FROM "session_pending_tool_calls" call
JOIN "session_turns" turn
  ON turn."workspace_id" = call."workspace_id" AND turn."id" = call."turn_id"
UNION ALL
SELECT session."pending_control_expected_attempt_id", session."account_id", session."workspace_id",
       session."id", turn."id", session."pending_control_expected_generation",
       turn."temporal_workflow_id", session."control_changed_at"
FROM "sessions" session
JOIN "session_turns" turn
  ON turn."workspace_id" = session."workspace_id"
 AND turn."id" = session."pending_control_expected_turn_id"
WHERE session."pending_control_expected_attempt_id" IS NOT NULL;

DO $attempt_identity$
BEGIN
  IF EXISTS (
    SELECT attempt_id
    FROM "cutover_attempt_ownership"
    GROUP BY attempt_id
    HAVING count(DISTINCT (
      account_id, workspace_id, session_id, turn_id, execution_generation,
      temporal_workflow_id
    )) <> 1
  ) THEN
    RAISE EXCEPTION 'session-control cutover: one attempt UUID maps to conflicting ownership';
  END IF;
END $attempt_identity$;

INSERT INTO "session_turn_attempts" (
  "id", "account_id", "workspace_id", "session_id", "turn_id",
  "execution_generation", "state", "outcome", "temporal_workflow_id",
  "temporal_workflow_run_id", "temporal_activity_id", "verified_control_revision",
  "started_at", "closed_at"
)
SELECT ownership."attempt_id", ownership."account_id", ownership."workspace_id",
       ownership."session_id", ownership."turn_id", ownership."execution_generation",
       'closed', 'pre_cutover_closed', ownership."temporal_workflow_id",
       'pre-cutover:' || ownership."attempt_id"::text,
       'pre-cutover:' || ownership."attempt_id"::text, 0,
       min(coalesce(ownership."started_at", now())), now()
FROM "cutover_attempt_ownership" ownership
GROUP BY ownership."attempt_id", ownership."account_id", ownership."workspace_id",
         ownership."session_id", ownership."turn_id", ownership."execution_generation",
         ownership."temporal_workflow_id";

-- Maintenance must have converted every executing logical turn into an
-- ownerless recovery state before schema cutover. A closed historical attempt
-- is evidence only; silently clearing ownership from a still-running turn
-- would strand it and let the new workflow misclassify the state.
DO $drained_attempts$
BEGIN
  IF EXISTS (SELECT 1 FROM "session_turns" WHERE "status" = 'running') THEN
    RAISE EXCEPTION 'session-control cutover: running turn survived maintenance drain';
  END IF;
END $drained_attempts$;

-- A drained logical turn is not owned after the cutover. Historical events and
-- unresolved tool-call receipts keep their immutable reference to the closed
-- evidence row; a new worker creates a new attempt only when it actually claims.
UPDATE "session_turns" SET "active_attempt_id" = NULL
WHERE "active_attempt_id" IS NOT NULL;

ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_workspace_active_attempt_fk"
  FOREIGN KEY ("workspace_id", "active_attempt_id")
  REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_workspace_attempt_fk"
  FOREIGN KEY ("workspace_id", "turn_attempt_id")
  REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "session_pending_tool_calls" ADD CONSTRAINT "pending_tool_calls_workspace_attempt_fk"
  FOREIGN KEY ("workspace_id", "attempt_id")
  REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "session_command_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "actor_type" text NOT NULL,
  "actor_subject_id" text,
  "actor_attempt_id" uuid,
  "action" text NOT NULL,
  "target_session_id" uuid,
  "target_turn_id" uuid,
  "operation_key" text NOT NULL,
  "canonical_request_hash" text NOT NULL,
  "applied_control_revision" bigint,
  "applied_queue_version" integer,
  "applied_turn_version" integer,
  "applied_draft_revision" bigint,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_command_receipts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_command_receipts_actor_attempt_fk"
    FOREIGN KEY ("workspace_id", "actor_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_command_receipts_target_session_fk"
    FOREIGN KEY ("workspace_id", "target_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_command_receipts_target_turn_fk"
    FOREIGN KEY ("workspace_id", "target_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "session_command_receipts_actor_check"
    CHECK (
      ("actor_type" = 'agent_attempt' AND "actor_attempt_id" IS NOT NULL
        AND "actor_subject_id" IS NULL)
      OR ("actor_type" IN ('human', 'operator') AND "actor_subject_id" IS NOT NULL
        AND "actor_attempt_id" IS NULL)
    )
);
CREATE UNIQUE INDEX "session_command_receipts_workspace_id_uq"
  ON "session_command_receipts" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_command_receipts_idempotency_uq"
  ON "session_command_receipts" (
    "workspace_id", "actor_type", "actor_subject_id", "actor_attempt_id",
    "action", "target_session_id", "target_turn_id", "operation_key"
  ) NULLS NOT DISTINCT;
CREATE INDEX "session_command_receipts_target_created_idx"
  ON "session_command_receipts" ("workspace_id", "target_session_id", "created_at");

CREATE TABLE "workspace_control_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "revision" bigint NOT NULL,
  "scope" text NOT NULL,
  "root_session_id" uuid,
  "action" text NOT NULL,
  "automatic" boolean NOT NULL DEFAULT false,
  "reason" text,
  "actor" text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_control_events_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_control_events_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "workspace_control_events_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "workspace_control_events_shape_check" CHECK (
    ("scope" = 'workspace' AND "root_session_id" IS NULL)
    OR ("scope" = 'session' AND "root_session_id" IS NOT NULL)
  ),
  CONSTRAINT "workspace_control_events_action_check" CHECK ("action" IN ('pause', 'resume'))
);
CREATE UNIQUE INDEX "workspace_control_events_workspace_revision_uq"
  ON "workspace_control_events" ("workspace_id", "revision");

CREATE TABLE "session_attempt_interruptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "control_revision" bigint NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  "acknowledged_at" timestamptz,
  "settled_at" timestamptz,
  CONSTRAINT "session_attempt_interruptions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_attempt_interruptions_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_interruptions_operation_fk"
    FOREIGN KEY ("workspace_id", "operation_id")
    REFERENCES "session_command_receipts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_interruptions_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_interruptions_kind_check"
    CHECK ("kind" IN ('session_pause', 'workspace_pause', 'steer', 'maintenance')),
  CONSTRAINT "session_attempt_interruptions_state_check"
    CHECK ("state" IN ('pending', 'delivered', 'acknowledged', 'settled', 'rejected_stale')),
  CONSTRAINT "session_attempt_interruptions_operation_attempt_uq"
    UNIQUE ("operation_id", "attempt_id")
);
CREATE INDEX "session_attempt_interruptions_unsettled_idx"
  ON "session_attempt_interruptions" ("workspace_id", "session_id", "requested_at")
  WHERE "state" IN ('pending', 'delivered', 'acknowledged');

CREATE TABLE "composer_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1,
  "text" text NOT NULL DEFAULT '',
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model" text NOT NULL,
  "reasoning_effort" text NOT NULL,
  "source_turn_id" uuid,
  "source_turn_version" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "composer_drafts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "composer_drafts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "composer_drafts_source_turn_fk"
    FOREIGN KEY ("workspace_id", "source_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "composer_drafts_subject_check" CHECK (length(btrim("subject_id")) > 0),
  CONSTRAINT "composer_drafts_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "composer_drafts_subject_session_uq"
  ON "composer_drafts" ("workspace_id", "session_id", "subject_id");

-- Derive one deterministic per-workspace revision order for historical direct
-- barriers. There are intentionally zero migration-created subtree overrides.
WITH paused_sessions AS (
  SELECT s."workspace_id", s."id",
         row_number() OVER (
           PARTITION BY s."workspace_id"
           ORDER BY s."control_changed_at" NULLS FIRST, s."created_at", s."id"
         )::bigint AS pause_revision
  FROM "sessions" s
  WHERE s."control_state" = 'paused'
), workspace_seed AS (
  SELECT w."id" AS workspace_id, w."account_id", w."inference_state",
         w."inference_reason", w."inference_changed_by", w."inference_changed_at",
         count(p."id")::bigint AS direct_pause_count
  FROM "workspaces" w
  LEFT JOIN paused_sessions p ON p."workspace_id" = w."id"
  GROUP BY w."id", w."account_id", w."inference_state", w."inference_reason",
           w."inference_changed_by", w."inference_changed_at"
)
INSERT INTO "workspace_inference_controls" (
  "workspace_id", "account_id", "revision", "workspace_state",
  "workspace_pause_revision", "reason", "changed_by", "changed_at"
)
SELECT workspace_id, account_id,
       direct_pause_count + CASE WHEN inference_state = 'paused' THEN 1 ELSE 0 END,
       inference_state,
       CASE WHEN inference_state = 'paused' THEN direct_pause_count + 1 ELSE NULL END,
       inference_reason, inference_changed_by, inference_changed_at
FROM workspace_seed;

WITH paused_sessions AS (
  SELECT s."workspace_id", s."id",
         row_number() OVER (
           PARTITION BY s."workspace_id"
           ORDER BY s."control_changed_at" NULLS FIRST, s."created_at", s."id"
         )::bigint AS pause_revision
  FROM "sessions" s
  WHERE s."control_state" = 'paused'
), session_seed AS (
  SELECT s."workspace_id", s."id",
         CASE WHEN p."id" IS NULL THEN 'active' ELSE 'paused' END AS direct_state,
         p.pause_revision
  FROM "sessions" s
  LEFT JOIN paused_sessions p
    ON p."workspace_id" = s."workspace_id" AND p."id" = s."id"
)
UPDATE "sessions" s
SET "direct_control_state" = seed.direct_state,
    "direct_pause_revision" = seed.pause_revision,
    "subtree_run_override_revision" = NULL,
    "control_version" = coalesce(seed.pause_revision, 0),
    "direct_control_reason" = s."control_reason",
    "direct_control_changed_by" = s."control_changed_by",
    "direct_control_changed_at" = s."control_changed_at"
FROM session_seed seed
WHERE s."workspace_id" = seed."workspace_id" AND s."id" = seed."id";

DO $verify$
BEGIN
  IF (SELECT count(*) FROM "workspace_inference_controls") <>
     (SELECT count(*) FROM "workspaces") THEN
    RAISE EXCEPTION 'session-control cutover: missing workspace control row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "sessions"
    WHERE ("control_state" = 'paused') <> ("direct_control_state" = 'paused')
       OR "subtree_run_override_revision" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'session-control cutover: direct barrier seed mismatch';
  END IF;
END $verify$;

-- Record every discarded exact-session workspace exception and every intentional
-- hold-only delta without prompt or model content. Migration creates barriers
-- only: no historical exception is reinterpreted as a new branch override.
INSERT INTO "audit_events" (
  "account_id", "workspace_id", "subject_id", "action", "target_type", "target_id", "metadata"
)
SELECT session."account_id", session."workspace_id", 'control-mega-migration',
       'session.control.migration.workspace_exception_dropped', 'session', session."id"::text,
       jsonb_build_object(
         'oldExceptionGeneration', session."workspace_run_exception_generation",
         'oldWorkspaceGeneration', workspace."inference_generation",
         'wasCurrent',
           session."workspace_run_exception_generation" = workspace."inference_generation"
       )
FROM "sessions" session
JOIN "workspaces" workspace ON workspace."id" = session."workspace_id"
WHERE session."workspace_run_exception_generation" IS NOT NULL;

WITH RECURSIVE ancestry AS (
  SELECT session."account_id", session."workspace_id", session."id" AS target_id,
         session."id" AS ancestor_id, session."parent_session_id", 0 AS depth
  FROM "sessions" session
  UNION ALL
  SELECT ancestry."account_id", ancestry."workspace_id", ancestry.target_id,
         parent."id", parent."parent_session_id", ancestry.depth + 1
  FROM ancestry
  JOIN "sessions" parent
    ON parent."workspace_id" = ancestry."workspace_id"
   AND parent."id" = ancestry."parent_session_id"
  WHERE ancestry.depth < 10000
), fate AS (
  SELECT session."account_id", session."workspace_id", session."id",
         (
           session."control_state" = 'paused'
           OR (
             workspace."inference_state" = 'paused'
             AND session."workspace_run_exception_generation" IS DISTINCT FROM
                 workspace."inference_generation"
           )
         ) AS old_blocked,
         (
           workspace."inference_state" = 'paused'
           OR EXISTS (
             SELECT 1
             FROM ancestry
             JOIN "sessions" ancestor
               ON ancestor."workspace_id" = ancestry."workspace_id"
              AND ancestor."id" = ancestry."ancestor_id"
             WHERE ancestry."workspace_id" = session."workspace_id"
               AND ancestry.target_id = session."id"
               AND ancestor."control_state" = 'paused'
           )
         ) AS new_blocked,
         workspace."inference_state" = 'paused'
           AND session."workspace_run_exception_generation" = workspace."inference_generation"
           AS dropped_current_workspace_exception
  FROM "sessions" session
  JOIN "workspaces" workspace ON workspace."id" = session."workspace_id"
)
INSERT INTO "audit_events" (
  "account_id", "workspace_id", "subject_id", "action", "target_type", "target_id", "metadata"
)
SELECT fate."account_id", fate."workspace_id", 'control-mega-migration',
       'session.control.migration.hold_only_delta', 'session', fate."id"::text,
       jsonb_build_object(
         'classification', CASE
           WHEN fate.dropped_current_workspace_exception THEN 'dropped_workspace_exception'
           ELSE 'recursive_pause_descendant'
         END,
         'oldBlocked', fate.old_blocked,
         'newBlocked', fate.new_blocked
       )
FROM fate
WHERE NOT fate.old_blocked AND fate.new_blocked;

DO $hold_only_verify$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT session."workspace_id", session."id" AS target_id,
             session."id" AS ancestor_id, session."parent_session_id", 0 AS depth
      FROM "sessions" session
      UNION ALL
      SELECT ancestry."workspace_id", ancestry.target_id,
             parent."id", parent."parent_session_id", ancestry.depth + 1
      FROM ancestry
      JOIN "sessions" parent
        ON parent."workspace_id" = ancestry."workspace_id"
       AND parent."id" = ancestry."parent_session_id"
      WHERE ancestry.depth < 10000
    )
    SELECT 1
    FROM "sessions" session
    JOIN "workspaces" workspace ON workspace."id" = session."workspace_id"
    WHERE (
      session."control_state" = 'paused'
      OR (
        workspace."inference_state" = 'paused'
        AND session."workspace_run_exception_generation" IS DISTINCT FROM
            workspace."inference_generation"
      )
    )
    AND NOT (
      workspace."inference_state" = 'paused'
      OR EXISTS (
        SELECT 1
        FROM ancestry
        JOIN "sessions" ancestor
          ON ancestor."workspace_id" = ancestry."workspace_id"
         AND ancestor."id" = ancestry."ancestor_id"
        WHERE ancestry."workspace_id" = session."workspace_id"
          AND ancestry.target_id = session."id"
          AND ancestor."control_state" = 'paused'
      )
    )
  ) THEN
    RAISE EXCEPTION 'session-control cutover: old-blocked session became runnable';
  END IF;
END $hold_only_verify$;

-- Old Session Pause silently paused an otherwise-active goal with the private
-- reason user_pause and emitted no goal.paused event. Migration 0057 also
-- normalized the older *explicit* user-goal reason user_interrupt to the same
-- database value, while correctly preserving its goal.paused event. Classify
-- the current goal by its latest status-changing event so an explicit user
-- pause stays sacred and only the eventless Session-Pause coupling is removed.
CREATE TEMP TABLE "cutover_user_pause_goal_fates" (
  "workspace_id" uuid NOT NULL,
  "goal_id" uuid PRIMARY KEY,
  "source" text NOT NULL CHECK ("source" IN ('explicit_goal_pause', 'session_pause'))
) ON COMMIT DROP;

INSERT INTO "cutover_user_pause_goal_fates" ("workspace_id", "goal_id", "source")
SELECT goal."workspace_id", goal."id",
       CASE
         WHEN latest."type" = 'goal.paused'
          AND latest."reason" IN ('user_interrupt', 'user_pause')
         THEN 'explicit_goal_pause'
         ELSE 'session_pause'
       END
FROM "session_goals" goal
LEFT JOIN LATERAL (
  SELECT event."type", event."payload" ->> 'reason' AS reason
  FROM "session_events" event
  WHERE event."workspace_id" = goal."workspace_id"
    AND event."session_id" = goal."session_id"
    AND event."payload" ->> 'goalId' = goal."id"::text
    AND event."type" IN ('goal.set', 'goal.paused', 'goal.resumed', 'goal.completed', 'goal.cleared')
  ORDER BY event."sequence" DESC, event."id" DESC
  LIMIT 1
) latest ON TRUE
WHERE goal."status" = 'paused'
  AND goal."paused_reason" = 'user_pause';

DO $goal_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "cutover_user_pause_goal_fates" fate
    JOIN "session_goals" goal
      ON goal."workspace_id" = fate."workspace_id" AND goal."id" = fate."goal_id"
    JOIN "sessions" session
      ON session."workspace_id" = goal."workspace_id" AND session."id" = goal."session_id"
    WHERE fate."source" = 'session_pause'
      AND session."control_state" <> 'paused'
  ) THEN
    RAISE EXCEPTION 'session-control cutover: eventless user_pause goal outside paused session';
  END IF;
END $goal_preflight$;

INSERT INTO "audit_events" (
  "account_id", "workspace_id", "subject_id", "action", "target_type", "target_id", "metadata"
)
SELECT goal."account_id", goal."workspace_id", 'control-mega-migration',
       'session.goal.migration.restored_from_session_pause', 'session_goal', goal."id"::text,
       jsonb_build_object('oldStatus', goal."status", 'newStatus', 'active', 'oldVersion', goal."version")
FROM "session_goals" goal
JOIN "cutover_user_pause_goal_fates" fate
  ON fate."workspace_id" = goal."workspace_id" AND fate."goal_id" = goal."id"
JOIN "sessions" session
  ON session."workspace_id" = goal."workspace_id" AND session."id" = goal."session_id"
WHERE fate."source" = 'session_pause'
  AND session."control_state" = 'paused';

UPDATE "session_goals" goal
SET "status" = 'active',
    "paused_reason" = NULL,
    "rationale" = NULL,
    "auto_continuations" = 0,
    "no_progress_streak" = 0,
    "last_continuation_turn_id" = NULL,
    "version_at_last_continuation" = NULL,
    "version" = goal."version" + 1,
    "updated_at" = now()
FROM "sessions" session
JOIN "cutover_user_pause_goal_fates" fate
  ON fate."workspace_id" = session."workspace_id"
WHERE session."workspace_id" = goal."workspace_id"
  AND session."id" = goal."session_id"
  AND fate."goal_id" = goal."id"
  AND fate."source" = 'session_pause'
  AND session."control_state" = 'paused';

-- Pause was previously overloaded into session lifecycle. Recover canonical
-- lifecycle from the owned turn first, then visible queued work, then the last
-- non-pause lifecycle event. Unknown active-turn shapes fail closed rather than
-- being guessed into an idle session.
DO $lifecycle_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sessions" s
    LEFT JOIN "session_turns" t
      ON t."workspace_id" = s."workspace_id" AND t."id" = s."active_turn_id"
    WHERE s."status" = 'paused'
      AND s."active_turn_id" IS NOT NULL
      AND (
        t."id" IS NULL
        OR t."session_id" <> s."id"
        OR t."status" NOT IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
      )
  ) THEN
    RAISE EXCEPTION 'session-control cutover: paused lifecycle has unclassifiable active turn';
  END IF;
END $lifecycle_preflight$;

WITH reconstructed AS (
  SELECT s."workspace_id", s."id",
    CASE
      WHEN s."status" <> 'paused' THEN s."status"
      WHEN active_turn."status" IS NOT NULL THEN active_turn."status"
      WHEN EXISTS (
        SELECT 1 FROM "session_turns" queued
        WHERE queued."workspace_id" = s."workspace_id"
          AND queued."session_id" = s."id"
          AND queued."status" = 'queued'
      ) THEN 'queued'
      ELSE coalesce((
        SELECT event."payload" ->> 'status'
        FROM "session_events" event
        WHERE event."workspace_id" = s."workspace_id"
          AND event."session_id" = s."id"
          AND event."type" = 'session.status.changed'
          AND event."payload" ->> 'status' IN (
            'queued', 'running', 'idle', 'requires_action', 'recovering',
            'waiting_capacity', 'failed', 'cancelled'
          )
        ORDER BY event."sequence" DESC, event."id" DESC
        LIMIT 1
      ), 'idle')
    END AS lifecycle_status
  FROM "sessions" s
  LEFT JOIN "session_turns" active_turn
    ON active_turn."workspace_id" = s."workspace_id"
   AND active_turn."id" = s."active_turn_id"
)
UPDATE "sessions" s
SET "status" = reconstructed.lifecycle_status,
    "updated_at" = greatest(s."updated_at", now())
FROM reconstructed
WHERE s."workspace_id" = reconstructed."workspace_id"
  AND s."id" = reconstructed."id"
  AND s."status" IS DISTINCT FROM reconstructed.lifecycle_status;

-- The former passive child-notification preference is not part of the closed
-- internal-update contract. Every child terminal result is now a coalescible,
-- actionable update, so remove the obsolete metadata rather than leaving a
-- setting that current code cannot and must not honor.
UPDATE "sessions"
SET "metadata" = "metadata" - 'childNotificationsMode',
    "updated_at" = greatest("updated_at", now())
WHERE "metadata" ? 'childNotificationsMode';

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_lifecycle_status_check"
  CHECK ("status" IN (
    'queued', 'running', 'idle', 'requires_action', 'recovering',
    'waiting_capacity', 'failed', 'cancelled'
  ));

DO $lifecycle_verify$
BEGIN
  IF EXISTS (SELECT 1 FROM "sessions" WHERE "status" = 'paused') THEN
    RAISE EXCEPTION 'session-control cutover: paused lifecycle survived reconstruction';
  END IF;
END $lifecycle_verify$;

-- Destructive half of the same maintenance cutover. New code cannot compile
-- against these columns, and the database cannot accept writes through them.
ALTER TABLE "sessions"
  DROP COLUMN "control_state",
  DROP COLUMN "control_generation",
  DROP COLUMN "control_reason",
  DROP COLUMN "control_changed_by",
  DROP COLUMN "control_changed_at",
  DROP COLUMN "pending_control_event_id",
  DROP COLUMN "pending_control_kind",
  DROP COLUMN "pending_control_expected_turn_id",
  DROP COLUMN "pending_control_expected_generation",
  DROP COLUMN "pending_control_expected_attempt_id",
  DROP COLUMN "workspace_run_exception_generation";

ALTER TABLE "workspaces"
  DROP COLUMN "inference_state",
  DROP COLUMN "inference_generation",
  DROP COLUMN "inference_reason",
  DROP COLUMN "inference_changed_by",
  DROP COLUMN "inference_changed_at";

ALTER TABLE "codex_capacity_waiters" DROP COLUMN "control_generation";
DROP TABLE "runtime_control_operations";

-- Workflow signals are replaceable wake hints. The dispatcher derives whether
-- a wake must cancel an executing activity from the durable interruption
-- ledger at claim time; a later ordinary queue wake therefore cannot erase or
-- downgrade an already-pending Pause/Steer request.
DROP FUNCTION opengeni_private.claim_session_workflow_wakes(integer);
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      wake_revision bigint,
      interruption_requested boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RETURN QUERY
        WITH due AS (
          SELECT o.session_id
          FROM %1$I.session_workflow_wake_outbox o
          WHERE o.wake_revision > o.delivered_revision
            AND o.next_attempt_at <= now()
          ORDER BY o.next_attempt_at, o.updated_at, o.session_id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
        )
        UPDATE %1$I.session_workflow_wake_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(o.attempts, 8))::integer))
            ),
            updated_at = now()
        FROM due
        WHERE o.session_id = due.session_id
        RETURNING o.account_id, o.workspace_id, o.session_id,
          o.temporal_workflow_id, o.wake_revision,
          EXISTS (
            SELECT 1
            FROM %1$I.session_attempt_interruptions interruption
            WHERE interruption.workspace_id = o.workspace_id
              AND interruption.session_id = o.session_id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          ) AS interruption_requested;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;

-- Clean internal-update cutover: preserve every durable row identity while
-- replacing the four open-ended legacy buckets with the five closed actionable
-- producer contracts. Unknown lifecycle shapes fail the migration below.
ALTER TABLE "session_system_updates" DROP CONSTRAINT "system_updates_kind_check";
ALTER TABLE "session_system_updates" DROP CONSTRAINT "system_updates_state_check";

-- Migration 0057 converted unstarted scheduled queue rows before scheduled
-- updates had a closed payload contract. Rebind those exact durable rows to the
-- owning scheduled-task occurrence; an orphan/ambiguous occurrence is not safe
-- to invent and fails the classifier below.
UPDATE "session_system_updates" update_row
SET "source_id" = run."id"::text,
    "dedupe_key" = 'scheduled-occurrence:' || run."id"::text,
    "payload" = update_row."payload" || jsonb_build_object(
      'text', update_row."summary",
      'scheduledTaskId', run."task_id",
      'scheduledTaskRunId', run."id"
    ),
    "lineage" = update_row."lineage" || jsonb_build_object(
      'scheduledTaskId', run."task_id",
      'scheduledTaskRunId', run."id"
    )
FROM "session_turns" turn
JOIN "scheduled_task_runs" run
  ON run."workspace_id" = turn."workspace_id"
 AND run."trigger_event_id" = turn."trigger_event_id"
WHERE update_row."workspace_id" = turn."workspace_id"
  AND update_row."payload" ->> 'migratedTurnId' = turn."id"::text
  AND update_row."kind" = 'scheduled_wake';

UPDATE "session_system_updates"
SET kind = 'scheduled_occurrence',
    payload = payload || jsonb_build_object(
      'type', 'scheduled_occurrence',
      'text', coalesce(nullif(payload ->> 'text', ''), summary)
    )
WHERE kind = 'scheduled_wake';

UPDATE "session_system_updates"
SET kind = 'goal_continuation',
    payload = payload || jsonb_build_object(
      'type', 'goal_continuation',
      'prompt', coalesce(nullif(payload ->> 'prompt', ''), summary)
    )
WHERE kind = 'lifecycle_event' AND payload ->> 'type' = 'goal_continuation';

UPDATE "session_system_updates"
SET kind = 'agent_message',
    payload = payload || jsonb_build_object(
      'type', 'agent_message',
      'text', coalesce(nullif(payload ->> 'text', ''), summary),
      'operationId', id
    )
WHERE kind = 'runtime_notice';

UPDATE "session_system_updates"
SET kind = 'child_terminal_result',
    payload = payload || jsonb_build_object(
      'type', 'child_terminal_result',
      'childSessionId', coalesce(nullif(payload ->> 'childSessionId', ''), source_id),
      'status', CASE
        WHEN coalesce(payload ->> 'status', payload ->> 'terminalStatus') = 'failed'
          THEN 'failed'
        ELSE 'idle'
      END
    )
WHERE kind = 'child_session_update';

-- The durable child-delivery outbox is the upstream half of the same producer.
-- Convert it before a new worker can retry a pending pre-cutover row.
UPDATE "session_system_update_outbox"
SET "kind" = 'child_terminal_result',
    "payload" = "payload" || jsonb_build_object(
      'type', 'child_terminal_result',
      'childSessionId', coalesce(nullif("payload" ->> 'childSessionId', ''), "source_id"),
      'status', CASE
        WHEN coalesce("payload" ->> 'status', "payload" ->> 'terminalStatus') = 'failed'
          THEN 'failed'
        ELSE 'idle'
      END
    )
WHERE "kind" = 'child_session_update';

DO $internal_updates$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "session_system_updates"
    WHERE kind NOT IN (
      'scheduled_occurrence', 'goal_continuation', 'agent_message',
      'agent_steer_instruction', 'child_terminal_result'
    ) OR payload ->> 'type' IS DISTINCT FROM kind
      OR CASE kind
        WHEN 'scheduled_occurrence' THEN NOT (
          nullif(payload ->> 'text', '') IS NOT NULL
          AND (payload ->> 'scheduledTaskId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND (payload ->> 'scheduledTaskRunId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        )
        WHEN 'goal_continuation' THEN NOT (
          nullif(payload ->> 'prompt', '') IS NOT NULL
          AND (payload ->> 'goalId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND (payload ->> 'goalVersion') ~ '^[1-9][0-9]*$'
        )
        WHEN 'agent_message' THEN NOT (
          nullif(payload ->> 'text', '') IS NOT NULL
          AND (payload ->> 'operationId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        )
        WHEN 'agent_steer_instruction' THEN NOT (
          nullif(payload ->> 'instruction', '') IS NOT NULL
          AND (payload ->> 'operationId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        )
        WHEN 'child_terminal_result' THEN NOT (
          (payload ->> 'childSessionId') ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND payload ->> 'status' IN ('idle', 'failed')
        )
        ELSE true
      END
  ) THEN
    RAISE EXCEPTION 'unclassified session_system_updates row blocks canonical cutover';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "session_system_update_outbox"
    WHERE "kind" <> 'child_terminal_result'
      OR "payload" ->> 'type' <> 'child_terminal_result'
      OR NOT (
        ("payload" ->> 'childSessionId') ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        AND "payload" ->> 'status' IN ('idle', 'failed')
      )
  ) THEN
    RAISE EXCEPTION 'unclassified session_system_update_outbox row blocks canonical cutover';
  END IF;
END $internal_updates$;

ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_kind_check"
  CHECK (kind IN (
    'scheduled_occurrence', 'goal_continuation', 'agent_message',
    'agent_steer_instruction', 'child_terminal_result'
  ));
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_payload_kind_check"
  CHECK (payload ->> 'type' = kind);
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_state_check"
  CHECK (state IN ('pending', 'deferred', 'delivered', 'cancelled', 'superseded', 'failed'));
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_kind_check"
  CHECK (kind = 'child_terminal_result');
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_payload_kind_check"
  CHECK (payload ->> 'type' = 'child_terminal_result');

-- One canonical continuability projection owns both runtime Pause/Resume wake
-- registration and maintenance reconstruction. It returns one row per session
-- plus every durable reason that makes a fresh Temporal workflow necessary.
-- Control blocks ordinary work but never blocks settlement of an already
-- committed interruption. Malformed ancestry is omitted (held fail-closed) and
-- is separately rejected by the migration ancestry preflight above.
-- Propagate the greatest Pause and Resume revisions once from each root instead
-- of rescanning every target's ancestry. Pause wins an impossible equal-revision
-- tie, matching the strict "override revision must be newer" control rule.
DO $continuability$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_continuable_sessions(
      p_workspace_id uuid,
      p_root_session_id uuid
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      reasons text[]
    )
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog
    AS $function$
      WITH RECURSIVE control_tree AS (
        SELECT session.workspace_id, session.id, session.parent_session_id,
               greatest(control.workspace_pause_revision, session.direct_pause_revision)
                 AS max_pause_revision,
               session.subtree_run_override_revision AS max_override_revision,
               0::integer AS depth
        FROM %1$I.sessions session
        JOIN %1$I.workspace_inference_controls control
          ON control.workspace_id = session.workspace_id
        WHERE session.parent_session_id IS NULL
          AND (p_workspace_id IS NULL OR session.workspace_id = p_workspace_id)
        UNION ALL
        SELECT child.workspace_id, child.id, child.parent_session_id,
               greatest(parent.max_pause_revision, child.direct_pause_revision),
               greatest(parent.max_override_revision, child.subtree_run_override_revision),
               parent.depth + 1
        FROM control_tree parent
        JOIN %1$I.sessions child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
        WHERE parent.depth < 10000
      ), descendants AS (
        SELECT tree.workspace_id, tree.id
        FROM control_tree tree
        WHERE p_root_session_id IS NOT NULL AND tree.id = p_root_session_id
        UNION ALL
        SELECT child.workspace_id, child.id
        FROM descendants parent
        JOIN control_tree child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
      ), scope_sessions AS (
        SELECT session.*, tree.max_pause_revision, tree.max_override_revision
        FROM %1$I.sessions session
        JOIN control_tree tree
          ON tree.workspace_id = session.workspace_id AND tree.id = session.id
        WHERE (
            p_root_session_id IS NULL
            OR EXISTS (
              SELECT 1 FROM descendants descendant
              WHERE descendant.workspace_id = session.workspace_id
                AND descendant.id = session.id
            )
          )
      ), control_state AS (
        SELECT session.workspace_id, session.id AS session_id,
               session.max_pause_revision IS NOT NULL
                 AND (
                   session.max_override_revision IS NULL
                   OR session.max_pause_revision >= session.max_override_revision
                 ) AS blocked
        FROM scope_sessions session
      ), unsettled_interruptions AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_attempt_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        WHERE interruption.state IN ('pending', 'delivered', 'acknowledged')
      ), queued_human AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id AND turn.session_id = session.id
        WHERE turn.status = 'queued' AND turn.source IN ('user', 'api')
      ), recovering_turn AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        WHERE turn.status = 'recovering'
      ), capacity_wait AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.codex_capacity_waiters waiter
          ON waiter.workspace_id = session.workspace_id AND waiter.session_id = session.id
        WHERE waiter.status = 'waiting'
      ), decided_approval AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        JOIN %1$I.session_events trigger_event
          ON trigger_event.workspace_id = turn.workspace_id
         AND trigger_event.id = turn.trigger_event_id
        JOIN %1$I.session_events decision
          ON decision.workspace_id = turn.workspace_id
         AND decision.session_id = turn.session_id
         AND decision.sequence > trigger_event.sequence
         AND decision.type = 'user.approvalDecision'
        WHERE turn.status = 'requires_action'
      ), active_goal AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_goals goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        WHERE goal.status = 'active'
      ), pending_internal_updates AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_system_updates update_row
          ON update_row.workspace_id = session.workspace_id
         AND update_row.session_id = session.id
        WHERE update_row.state = 'pending'
      ), classified AS (
        SELECT session.account_id, session.workspace_id, session.id AS session_id,
               coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
                 AS temporal_workflow_id,
               array_remove(ARRAY[
                 CASE WHEN interruption.session_id IS NOT NULL
                   THEN 'interruption_settlement' END,
                 CASE WHEN NOT control.blocked AND queued.session_id IS NOT NULL
                   THEN 'queued_human' END,
                 CASE WHEN NOT control.blocked AND recovering.session_id IS NOT NULL
                   THEN 'recovering_turn' END,
                 CASE WHEN NOT control.blocked AND capacity.session_id IS NOT NULL
                   THEN 'capacity_wait' END,
                 CASE WHEN NOT control.blocked AND approval.session_id IS NOT NULL
                   THEN 'decided_approval' END,
                 CASE WHEN NOT control.blocked AND goal.session_id IS NOT NULL
                   THEN 'active_goal' END,
                 CASE WHEN NOT control.blocked AND updates.session_id IS NOT NULL
                   THEN 'pending_internal_updates' END,
                 CASE WHEN NOT control.blocked AND session.compact_requested
                   THEN 'compaction_requested' END
               ]::text[], NULL) AS reasons
        FROM scope_sessions session
        JOIN control_state control
          ON control.workspace_id = session.workspace_id AND control.session_id = session.id
        LEFT JOIN unsettled_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        LEFT JOIN queued_human queued
          ON queued.workspace_id = session.workspace_id AND queued.session_id = session.id
        LEFT JOIN recovering_turn recovering
          ON recovering.workspace_id = session.workspace_id AND recovering.session_id = session.id
        LEFT JOIN capacity_wait capacity
          ON capacity.workspace_id = session.workspace_id AND capacity.session_id = session.id
        LEFT JOIN decided_approval approval
          ON approval.workspace_id = session.workspace_id AND approval.session_id = session.id
        LEFT JOIN active_goal goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        LEFT JOIN pending_internal_updates updates
          ON updates.workspace_id = session.workspace_id AND updates.session_id = session.id
      )
      SELECT classified.account_id, classified.workspace_id, classified.session_id,
             classified.temporal_workflow_id, classified.reasons
      FROM classified
      WHERE cardinality(classified.reasons) > 0
      ORDER BY classified.workspace_id, classified.session_id
    $function$;
  $create$, target_schema);
END $continuability$;

-- Old workflow histories are unconditionally terminated during maintenance.
-- Bump one durable revision for every continuable session even when an older
-- wake row says it was delivered; the new workflow receives the complete set
-- of reasons from current PostgreSQL truth and no prompt is manufactured.
WITH continuable AS (
  SELECT * FROM opengeni_private.list_continuable_sessions(NULL, NULL)
), seeded AS (
  INSERT INTO "session_workflow_wake_outbox" (
    "session_id", "account_id", "workspace_id", "temporal_workflow_id", "reason"
  )
  SELECT session_id, account_id, workspace_id, temporal_workflow_id,
         'control_mega_cutover:' || array_to_string(reasons, ',')
  FROM continuable
  ON CONFLICT ("session_id") DO UPDATE SET
    "wake_revision" = "session_workflow_wake_outbox"."wake_revision" + 1,
    "temporal_workflow_id" = excluded."temporal_workflow_id",
    "reason" = excluded."reason",
    "attempts" = 0,
    "next_attempt_at" = now(),
    "last_error" = NULL,
    "updated_at" = now()
  RETURNING "account_id", "workspace_id", "session_id", "wake_revision", "reason"
)
INSERT INTO "audit_events" (
  "account_id", "workspace_id", "subject_id", "action", "target_type", "target_id", "metadata"
)
SELECT seeded.account_id, seeded.workspace_id, 'control-mega-migration',
       'session.workflow.migration.wake_seeded', 'session', seeded.session_id::text,
       jsonb_build_object('wakeRevision', seeded.wake_revision, 'reason', seeded.reason)
FROM seeded;

REVOKE ALL ON FUNCTION opengeni_private.list_continuable_sessions(uuid, uuid) FROM PUBLIC;

ALTER TABLE "workspace_inference_controls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_inference_controls" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_command_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_command_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_control_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_control_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_interruptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_interruptions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "composer_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "composer_drafts" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_inference_controls"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_turn_attempts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_command_receipts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "workspace_control_events"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "session_attempt_interruptions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "composer_drafts"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  );

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.list_continuable_sessions(uuid, uuid)
      TO opengeni_app;
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;
