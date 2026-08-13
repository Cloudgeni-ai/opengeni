-- deployment-mode: rolling
-- Freeze the exact goal projection on each accepted logical turn and
-- separate semantic objective revisions from the established continuation
-- lifecycle version/wake ledger.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_goals"
  ADD COLUMN IF NOT EXISTS "objective_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "mutation_policy" text NOT NULL DEFAULT 'preserve_intent';

ALTER TABLE "session_goals"
  ADD CONSTRAINT "session_goals_objective_revision_chk"
    CHECK ("objective_revision" > 0) NOT VALID,
  ADD CONSTRAINT "session_goals_mutation_policy_chk"
    CHECK ("mutation_policy" IN (
      'review_changes', 'preserve_intent', 'autonomous_adaptation'
    )) NOT VALID;

ALTER TABLE "session_goals"
  VALIDATE CONSTRAINT "session_goals_objective_revision_chk",
  VALIDATE CONSTRAINT "session_goals_mutation_policy_chk";

ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "goal_snapshot" jsonb;

ALTER TABLE "session_turns"
  ADD CONSTRAINT "session_turns_goal_snapshot_chk" CHECK (
    "goal_snapshot" IS NULL
    OR (
      jsonb_typeof("goal_snapshot") = 'object'
      AND "goal_snapshot" ->> 'state' IN ('none', 'active', 'paused', 'completed')
      AND jsonb_typeof("goal_snapshot" -> 'capturedAt') = 'string'
      AND (
        ("goal_snapshot" ->> 'state' = 'none'
          AND "goal_snapshot" - 'state' - 'capturedAt' = '{}'::jsonb)
        OR
        ("goal_snapshot" ->> 'state' IN ('active', 'paused', 'completed')
          AND jsonb_typeof("goal_snapshot" -> 'goalId') = 'string'
          AND jsonb_typeof("goal_snapshot" -> 'objectiveRevision') = 'number'
          AND ("goal_snapshot" ->> 'objectiveRevision') ~ '^[1-9][0-9]*$'
          AND jsonb_typeof("goal_snapshot" -> 'text') = 'string'
          AND length("goal_snapshot" ->> 'text') > 0
          AND octet_length("goal_snapshot" ->> 'text') <= 8192
          AND (
            "goal_snapshot" -> 'successCriteria' = 'null'::jsonb
            OR (
              jsonb_typeof("goal_snapshot" -> 'successCriteria') = 'string'
              AND octet_length("goal_snapshot" ->> 'successCriteria') <= 8192
            )
          )
          AND "goal_snapshot" ->> 'mutationPolicy' IN (
            'review_changes', 'preserve_intent', 'autonomous_adaptation'
          ))
      )
    )
  ) NOT VALID;

ALTER TABLE "session_turns"
  VALIDATE CONSTRAINT "session_turns_goal_snapshot_chk";

CREATE TABLE "session_goal_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "goal_id" uuid NOT NULL,
  "disposition" text NOT NULL,
  "change_kind" text NOT NULL,
  "base_objective_revision" integer NOT NULL,
  "result_objective_revision" integer,
  "text" text NOT NULL,
  "success_criteria" text,
  "mutation_policy" text NOT NULL,
  "rationale" text NOT NULL,
  "actor" text NOT NULL,
  "actor_turn_id" uuid,
  "actor_attempt_id" uuid,
  "proposal_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_goal_revisions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_goal_revisions_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_goal_revisions_actor_turn_fk"
    FOREIGN KEY ("workspace_id", "actor_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_goal_revisions_actor_attempt_fk"
    FOREIGN KEY ("workspace_id", "actor_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_goal_revisions_disposition_chk"
    CHECK ("disposition" IN ('applied', 'proposed', 'rejected')),
  CONSTRAINT "session_goal_revisions_change_kind_chk"
    CHECK ("change_kind" IN ('refinement', 'adaptation', 'replacement')),
  CONSTRAINT "session_goal_revisions_policy_chk"
    CHECK ("mutation_policy" IN (
      'review_changes', 'preserve_intent', 'autonomous_adaptation'
    )),
  CONSTRAINT "session_goal_revisions_actor_chk"
    CHECK ("actor" IN ('agent', 'api', 'scheduled_task')),
  CONSTRAINT "session_goal_revisions_revision_shape_chk" CHECK (
    ("disposition" = 'applied'
      AND "result_objective_revision" = "base_objective_revision" + 1)
    OR
    ("disposition" IN ('proposed', 'rejected')
      AND "result_objective_revision" IS NULL)
  )
);

CREATE UNIQUE INDEX "session_goal_revisions_workspace_id_uq"
  ON "session_goal_revisions" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_goal_revisions_applied_revision_uq"
  ON "session_goal_revisions" (
    "workspace_id", "goal_id", "result_objective_revision"
  ) WHERE "disposition" = 'applied';
CREATE INDEX "session_goal_revisions_goal_timeline_idx"
  ON "session_goal_revisions" ("workspace_id", "goal_id", "created_at", "id");
ALTER TABLE "session_goal_revisions"
  ADD CONSTRAINT "session_goal_revisions_proposal_fk"
  FOREIGN KEY ("workspace_id", "proposal_id")
  REFERENCES "session_goal_revisions"("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "session_goal_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_goal_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_goal_revisions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation ON "session_goal_revisions"
  AS RESTRICTIVE
  USING (session_reference_visible(
    "account_id", "workspace_id", "session_id"
  ))
  WITH CHECK (session_reference_visible(
    "account_id", "workspace_id", "session_id"
  ));

CREATE OR REPLACE FUNCTION session_goal_revision_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent lifecycle deletion is the sole mutation exception. PostgreSQL's
  -- cascading constraint trigger runs only after its parent row is absent;
  -- require both nested trigger context and one missing ownership edge so
  -- direct or unrelated-trigger deletes remain fail-closed.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM "managed_accounts" WHERE "id" = OLD."account_id")
      OR NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id")
      OR NOT EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."session_id")
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'session goal revisions are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS session_goal_revisions_immutable
  ON "session_goal_revisions";
CREATE TRIGGER session_goal_revisions_immutable
  BEFORE UPDATE OR DELETE ON "session_goal_revisions"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_reject_mutation();

CREATE OR REPLACE FUNCTION session_goal_revision_bound_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF octet_length(NEW."text") > 8192 THEN
    RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
      USING ERRCODE = '22001';
  END IF;
  IF NEW."success_criteria" IS NOT NULL
    AND octet_length(NEW."success_criteria") > 8192 THEN
    RAISE EXCEPTION 'goal success criteria exceeds 8192 UTF-8 bytes'
      USING ERRCODE = '22001';
  END IF;
  IF octet_length(NEW."rationale") > 2048 THEN
    RAISE EXCEPTION 'goal rationale exceeds 2048 UTF-8 bytes'
      USING ERRCODE = '22001';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO "session_goal_revisions" (
  "account_id", "workspace_id", "session_id", "goal_id", "disposition",
  "change_kind", "base_objective_revision", "result_objective_revision",
  "text", "success_criteria", "mutation_policy", "rationale", "actor",
  "created_at"
)
SELECT
  goal."account_id", goal."workspace_id", goal."session_id", goal."id",
  'applied', 'replacement', 0, 1, goal."text", goal."success_criteria",
  goal."mutation_policy", 'Existing goal captured during policy activation',
  CASE
    WHEN goal."created_by" = 'scheduled_task' THEN 'scheduled_task'
    WHEN goal."created_by" = 'agent' THEN 'agent'
    ELSE 'api'
  END,
  goal."created_at"
FROM "session_goals" goal
ON CONFLICT ("workspace_id", "goal_id", "result_objective_revision")
  WHERE "disposition" = 'applied'
  DO NOTHING;

DROP TRIGGER IF EXISTS session_goal_revisions_bound_insert
  ON "session_goal_revisions";
CREATE TRIGGER session_goal_revisions_bound_insert
  BEFORE INSERT ON "session_goal_revisions"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_bound_insert();

CREATE OR REPLACE FUNCTION session_goal_revision_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  semantic_change boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF octet_length(NEW."text") > 8192 THEN
      RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."success_criteria" IS NOT NULL
      AND octet_length(NEW."success_criteria") > 8192 THEN
      RAISE EXCEPTION 'goal success criteria exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."objective_revision" <> 1 THEN
      RAISE EXCEPTION 'a new goal must start at objective revision 1'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  semantic_change :=
    NEW."text" IS DISTINCT FROM OLD."text"
    OR NEW."success_criteria" IS DISTINCT FROM OLD."success_criteria"
    OR NEW."mutation_policy" IS DISTINCT FROM OLD."mutation_policy";

  IF semantic_change THEN
    IF octet_length(NEW."text") > 8192 THEN
      RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."success_criteria" IS NOT NULL
      AND octet_length(NEW."success_criteria") > 8192 THEN
      RAISE EXCEPTION 'goal success criteria exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."objective_revision" = OLD."objective_revision" THEN
      -- Rolling-old writers know only the lifecycle version. Preserve their
      -- semantic mutation while still advancing the new exact objective fence.
      NEW."objective_revision" := OLD."objective_revision" + 1;
    ELSIF NEW."objective_revision" <> OLD."objective_revision" + 1 THEN
      RAISE EXCEPTION 'goal objective revision must advance exactly once'
        USING ERRCODE = '40001';
    END IF;
  ELSIF NEW."objective_revision" <> OLD."objective_revision" THEN
    RAISE EXCEPTION 'goal objective revision changed without semantic content'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION session_goal_revision_after_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  semantic_change boolean := TG_OP = 'INSERT';
  base_revision integer := 0;
  change_kind text := 'replacement';
  change_rationale text := 'Goal created';
  change_actor text;
  change_turn_id uuid;
  change_attempt_id uuid;
  source_proposal_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    semantic_change :=
      NEW."text" IS DISTINCT FROM OLD."text"
      OR NEW."success_criteria" IS DISTINCT FROM OLD."success_criteria"
      OR NEW."mutation_policy" IS DISTINCT FROM OLD."mutation_policy";
    base_revision := OLD."objective_revision";
    change_rationale := 'Goal changed by a rolling-compatible writer';
  END IF;
  IF NOT semantic_change THEN
    RETURN NEW;
  END IF;

  change_kind := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_kind', true), ''),
    change_kind
  );
  change_rationale := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_rationale', true), ''),
    change_rationale
  );
  change_actor := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_actor', true), ''),
    CASE
      WHEN NEW."created_by" = 'scheduled_task' THEN 'scheduled_task'
      WHEN NEW."created_by" = 'agent' THEN 'agent'
      ELSE 'api'
    END
  );
  change_turn_id := NULLIF(
    current_setting('opengeni.goal_change_turn_id', true), ''
  )::uuid;
  change_attempt_id := NULLIF(
    current_setting('opengeni.goal_change_attempt_id', true), ''
  )::uuid;
  source_proposal_id := NULLIF(
    current_setting('opengeni.goal_change_proposal_id', true), ''
  )::uuid;

  INSERT INTO "session_goal_revisions" (
    "account_id", "workspace_id", "session_id", "goal_id", "disposition",
    "change_kind", "base_objective_revision", "result_objective_revision",
    "text", "success_criteria", "mutation_policy", "rationale", "actor",
    "actor_turn_id", "actor_attempt_id", "proposal_id", "created_at"
  ) VALUES (
    NEW."account_id", NEW."workspace_id", NEW."session_id", NEW."id",
    'applied', change_kind, base_revision, NEW."objective_revision", NEW."text",
    NEW."success_criteria", NEW."mutation_policy", change_rationale,
    change_actor, change_turn_id, change_attempt_id, source_proposal_id, now()
  )
  ON CONFLICT ("workspace_id", "goal_id", "result_objective_revision")
    WHERE "disposition" = 'applied'
    DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_goal_revision_before_write_trigger ON "session_goals";
CREATE TRIGGER session_goal_revision_before_write_trigger
  BEFORE INSERT OR UPDATE OF "text", "success_criteria", "mutation_policy", "objective_revision"
  ON "session_goals"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_before_write();

DROP TRIGGER IF EXISTS session_goal_revision_after_write_trigger ON "session_goals";
CREATE TRIGGER session_goal_revision_after_write_trigger
  AFTER INSERT OR UPDATE OF "text", "success_criteria", "mutation_policy"
  ON "session_goals"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_after_write();

CREATE OR REPLACE FUNCTION session_goal_prompt_projection(
  value text,
  max_bytes integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  original_bytes integer := octet_length(value);
  marker text;
  budget integer;
  lower_chars integer := 0;
  upper_chars integer := length(value);
  midpoint integer;
BEGIN
  IF original_bytes <= max_bytes THEN
    RETURN value;
  END IF;
  marker := E'\n[truncated; original UTF-8 bytes=' || original_bytes::text || ']';
  budget := greatest(0, max_bytes - octet_length(marker));
  WHILE lower_chars < upper_chars LOOP
    midpoint := (lower_chars + upper_chars + 1) / 2;
    IF octet_length(left(value, midpoint)) <= budget THEN
      lower_chars := midpoint;
    ELSE
      upper_chars := midpoint - 1;
    END IF;
  END LOOP;
  RETURN left(value, lower_chars) || marker;
END;
$$;

CREATE OR REPLACE FUNCTION session_goal_freeze_turn_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  goal_row "session_goals"%ROWTYPE;
BEGIN
  SELECT * INTO goal_row
  FROM "session_goals"
  WHERE "workspace_id" = NEW."workspace_id"
    AND "session_id" = NEW."session_id";

  IF FOUND THEN
    NEW."goal_snapshot" := jsonb_build_object(
      'state', goal_row."status",
      'goalId', goal_row."id"::text,
      'objectiveRevision', goal_row."objective_revision",
      'text', session_goal_prompt_projection(goal_row."text", 8192),
      'successCriteria', to_jsonb(
        session_goal_prompt_projection(goal_row."success_criteria", 8192)
      ),
      'mutationPolicy', goal_row."mutation_policy",
      'capturedAt', to_char(
        NEW."created_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
  ELSE
    NEW."goal_snapshot" := jsonb_build_object(
      'state', 'none',
      'capturedAt', to_char(
        NEW."created_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION session_goal_reject_turn_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."goal_snapshot" IS NOT NULL
    AND NEW."goal_snapshot" IS DISTINCT FROM OLD."goal_snapshot" THEN
    RAISE EXCEPTION 'turn goal snapshot is immutable after acceptance'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_turns_goal_snapshot_insert ON "session_turns";
CREATE TRIGGER session_turns_goal_snapshot_insert
  BEFORE INSERT ON "session_turns"
  FOR EACH ROW EXECUTE FUNCTION session_goal_freeze_turn_snapshot();

DROP TRIGGER IF EXISTS session_turns_goal_snapshot_immutable ON "session_turns";
CREATE TRIGGER session_turns_goal_snapshot_immutable
  BEFORE UPDATE OF "goal_snapshot" ON "session_turns"
  FOR EACH ROW EXECUTE FUNCTION session_goal_reject_turn_snapshot_mutation();

DROP INDEX IF EXISTS "session_command_receipts_goal_progress_operation_uq";
CREATE UNIQUE INDEX "session_command_receipts_goal_progress_operation_uq"
  ON "session_command_receipts" (
    "workspace_id", "action", "target_session_id", "operation_key"
  ) WHERE "action" = 'goal.progress';

UPDATE "sessions"
SET "first_party_mcp_tools" = "first_party_mcp_tools" || '["goal_progress"]'::jsonb
WHERE "first_party_mcp_tools" ? 'goal_update'
  AND NOT "first_party_mcp_tools" ? 'goal_progress';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON "session_goal_revisions" TO opengeni_app;
    REVOKE UPDATE, DELETE ON "session_goal_revisions" FROM opengeni_app;
  END IF;
END $$;
