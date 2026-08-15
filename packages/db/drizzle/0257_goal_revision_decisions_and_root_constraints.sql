-- deployment-mode: rolling
-- Complete governed goal revision decisions and freeze bounded root constraints
-- into the existing accepted-turn goal authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION session_goal_normalize_root_constraints(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item jsonb;
  normalized jsonb;
  normalized_count integer;
  aggregate_bytes integer;
BEGIN
  IF value IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_typeof(value) <> 'array' THEN
    RAISE EXCEPTION 'goal root constraints must be a JSON array'
      USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT value_item FROM jsonb_array_elements(value) AS items(value_item)
  LOOP
    IF jsonb_typeof(item) <> 'string' THEN
      RAISE EXCEPTION 'goal root constraints must contain only strings'
        USING ERRCODE = '23514';
    END IF;
    IF btrim(item #>> '{}') = '' THEN
      RAISE EXCEPTION 'goal root constraints must not be blank'
        USING ERRCODE = '23514';
    END IF;
    IF octet_length(btrim(item #>> '{}')) > 512 THEN
      RAISE EXCEPTION 'goal root constraint exceeds 512 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
  END LOOP;

  SELECT
    coalesce(jsonb_agg(to_jsonb(candidate) ORDER BY convert_to(candidate, 'UTF8')), '[]'::jsonb),
    count(*)::integer,
    coalesce(sum(octet_length(candidate)), 0)::integer
  INTO normalized, normalized_count, aggregate_bytes
  FROM (
    SELECT DISTINCT btrim(value_item #>> '{}') AS candidate
    FROM jsonb_array_elements(value) AS items(value_item)
  ) normalized_items;

  IF normalized_count > 16 THEN
    RAISE EXCEPTION 'goal root constraints exceed 16 items'
      USING ERRCODE = '22001';
  END IF;
  IF aggregate_bytes > 4096 THEN
    RAISE EXCEPTION 'goal root constraints exceed 4096 aggregate UTF-8 bytes'
      USING ERRCODE = '22001';
  END IF;
  RETURN normalized;
END;
$$;

ALTER TABLE "session_goals"
  ADD COLUMN IF NOT EXISTS "root_constraints" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "session_goal_revisions"
  ADD COLUMN IF NOT EXISTS "root_constraints" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "rollback_of_revision_id" uuid;

CREATE OR REPLACE FUNCTION session_goal_normalize_root_constraints_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."root_constraints" := session_goal_normalize_root_constraints(
    NEW."root_constraints"
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_goal_00_normalize_root_constraints ON "session_goals";
CREATE TRIGGER session_goal_00_normalize_root_constraints
  BEFORE INSERT OR UPDATE OF "root_constraints" ON "session_goals"
  FOR EACH ROW EXECUTE FUNCTION session_goal_normalize_root_constraints_before_write();

DROP TRIGGER IF EXISTS session_goal_revisions_00_normalize_root_constraints
  ON "session_goal_revisions";
CREATE TRIGGER session_goal_revisions_00_normalize_root_constraints
  BEFORE INSERT OR UPDATE OF "root_constraints" ON "session_goal_revisions"
  FOR EACH ROW EXECUTE FUNCTION session_goal_normalize_root_constraints_before_write();

ALTER TABLE "session_goals"
  ADD CONSTRAINT "session_goals_root_constraints_chk"
  CHECK (
    jsonb_typeof("root_constraints") = 'array'
    AND "root_constraints" = session_goal_normalize_root_constraints("root_constraints")
  ) NOT VALID;

ALTER TABLE "session_goal_revisions"
  ADD CONSTRAINT "session_goal_revisions_root_constraints_chk"
  CHECK (
    jsonb_typeof("root_constraints") = 'array'
    AND "root_constraints" = session_goal_normalize_root_constraints("root_constraints")
  ) NOT VALID;

ALTER TABLE "session_goals"
  VALIDATE CONSTRAINT "session_goals_root_constraints_chk";
ALTER TABLE "session_goal_revisions"
  VALIDATE CONSTRAINT "session_goal_revisions_root_constraints_chk";

ALTER TABLE "session_goal_revisions"
  ADD CONSTRAINT "session_goal_revisions_rollback_of_revision_fk"
  FOREIGN KEY ("workspace_id", "rollback_of_revision_id")
  REFERENCES "session_goal_revisions"("workspace_id", "id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "session_goal_revisions_proposal_decision_uq"
  ON "session_goal_revisions" ("workspace_id", "proposal_id")
  WHERE "proposal_id" IS NOT NULL
    AND "disposition" IN ('applied', 'rejected');

CREATE UNIQUE INDEX "session_goal_revisions_rollback_request_uq"
  ON "session_goal_revisions" (
    "workspace_id", "goal_id", "rollback_of_revision_id", "base_objective_revision"
  )
  WHERE "disposition" = 'applied' AND "rollback_of_revision_id" IS NOT NULL;

ALTER TABLE "session_goal_revisions"
  ADD CONSTRAINT "session_goal_revisions_lineage_shape_chk" CHECK (
    ("disposition" = 'proposed'
      AND "proposal_id" IS NULL AND "rollback_of_revision_id" IS NULL)
    OR
    ("disposition" = 'rejected'
      AND "proposal_id" IS NOT NULL AND "rollback_of_revision_id" IS NULL)
    OR
    ("disposition" = 'applied'
      AND NOT ("proposal_id" IS NOT NULL AND "rollback_of_revision_id" IS NOT NULL))
  ) NOT VALID;

ALTER TABLE "session_goal_revisions"
  VALIDATE CONSTRAINT "session_goal_revisions_lineage_shape_chk";

ALTER TABLE "session_turns"
  ADD CONSTRAINT "session_turns_goal_root_constraints_chk" CHECK (
    "goal_snapshot" IS NULL
    OR "goal_snapshot" ->> 'state' = 'none'
    OR NOT ("goal_snapshot" ? 'rootConstraints')
    OR (
      jsonb_typeof("goal_snapshot" -> 'rootConstraints') = 'array'
      AND ("goal_snapshot" -> 'rootConstraints') =
        session_goal_normalize_root_constraints("goal_snapshot" -> 'rootConstraints')
    )
  ) NOT VALID;

ALTER TABLE "session_turns"
  VALIDATE CONSTRAINT "session_turns_goal_root_constraints_chk";

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
    OR NEW."root_constraints" IS DISTINCT FROM OLD."root_constraints"
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
  rollback_revision_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    semantic_change :=
      NEW."text" IS DISTINCT FROM OLD."text"
      OR NEW."success_criteria" IS DISTINCT FROM OLD."success_criteria"
      OR NEW."root_constraints" IS DISTINCT FROM OLD."root_constraints"
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
  rollback_revision_id := NULLIF(
    current_setting('opengeni.goal_change_rollback_of_revision_id', true), ''
  )::uuid;

  INSERT INTO "session_goal_revisions" (
    "account_id", "workspace_id", "session_id", "goal_id", "disposition",
    "change_kind", "base_objective_revision", "result_objective_revision",
    "text", "success_criteria", "root_constraints", "mutation_policy",
    "rationale", "actor", "actor_turn_id", "actor_attempt_id", "proposal_id",
    "rollback_of_revision_id", "created_at"
  ) VALUES (
    NEW."account_id", NEW."workspace_id", NEW."session_id", NEW."id",
    'applied', change_kind, base_revision, NEW."objective_revision", NEW."text",
    NEW."success_criteria", NEW."root_constraints", NEW."mutation_policy",
    change_rationale, change_actor, change_turn_id, change_attempt_id,
    source_proposal_id, rollback_revision_id, now()
  )
  ON CONFLICT ("workspace_id", "goal_id", "result_objective_revision")
    WHERE "disposition" = 'applied'
    DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_goal_revision_before_write_trigger ON "session_goals";
CREATE TRIGGER session_goal_revision_before_write_trigger
  BEFORE INSERT OR UPDATE OF
    "text", "success_criteria", "root_constraints", "mutation_policy", "objective_revision"
  ON "session_goals"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_before_write();

DROP TRIGGER IF EXISTS session_goal_revision_after_write_trigger ON "session_goals";
CREATE TRIGGER session_goal_revision_after_write_trigger
  AFTER INSERT OR UPDATE OF
    "text", "success_criteria", "root_constraints", "mutation_policy"
  ON "session_goals"
  FOR EACH ROW EXECUTE FUNCTION session_goal_revision_after_write();

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
      'rootConstraints', goal_row."root_constraints",
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
