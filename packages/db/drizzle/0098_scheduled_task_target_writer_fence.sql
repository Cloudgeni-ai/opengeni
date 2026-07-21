-- Targeted scheduled tasks are intentionally readable by legacy workers during
-- a rolling deployment: 0097 mirrors target_session_id through the old
-- reusable_session_id route. Legacy APIs must not, however, be able to alter
-- that route or inject a goal that an old worker would apply to the existing
-- thread. The writer capability is transaction-local and is set by the
-- target-aware DB helpers in packages/db/src/index.ts.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scheduled_tasks_target_no_goal_ck'
       AND conrelid = 'scheduled_tasks'::regclass
  ) THEN
    ALTER TABLE "scheduled_tasks"
      ADD CONSTRAINT "scheduled_tasks_target_no_goal_ck"
      CHECK ("target_session_id" IS NULL OR NOT ("agent_config" ? 'goal'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_scheduled_task_target_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_workspace uuid;
  target_backend text;
  target_write_capability text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD."target_session_id" IS NOT NULL OR NEW."target_session_id" IS NOT NULL)
     AND (
       NEW."target_session_id" IS DISTINCT FROM OLD."target_session_id"
       OR NEW."reusable_session_id" IS DISTINCT FROM OLD."reusable_session_id"
       OR NEW."run_mode" IS DISTINCT FROM OLD."run_mode"
       OR NEW."agent_config" IS DISTINCT FROM OLD."agent_config"
       OR NEW."variable_set_id" IS DISTINCT FROM OLD."variable_set_id"
       OR NEW."rig_id" IS DISTINCT FROM OLD."rig_id"
     )
  THEN
    target_write_capability := current_setting(
      'opengeni.scheduled_task_target_capability',
      true
    );
    IF target_write_capability IS DISTINCT FROM 'v1' THEN
      RAISE EXCEPTION
        'targeted scheduled task requires a target-aware writer'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW."target_session_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT session."workspace_id", session."sandbox_backend"
    INTO target_workspace, target_backend
    FROM "sessions" AS session
   WHERE session."id" = NEW."target_session_id";

  IF target_workspace IS NULL THEN
    RAISE EXCEPTION
      'target session is not visible in the scheduled task workspace'
      USING ERRCODE = '23503';
  END IF;
  IF target_workspace IS DISTINCT FROM NEW."workspace_id" THEN
    RAISE EXCEPTION
      'scheduled task target session must belong to the task workspace'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."run_mode" IS DISTINCT FROM 'reusable_session' THEN
    RAISE EXCEPTION
      'targeted scheduled task must use reusable_session'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."reusable_session_id" IS DISTINCT FROM NEW."target_session_id" THEN
    RAISE EXCEPTION
      'targeted scheduled task must mirror its target through reusable_session_id'
      USING ERRCODE = '23514';
  END IF;
  IF COALESCE(NEW."agent_config", '{}'::jsonb) ? 'goal' THEN
    RAISE EXCEPTION
      'targeted scheduled task cannot replace the target session goal'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."agent_config"->>'sandboxBackend' IS DISTINCT FROM target_backend THEN
    RAISE EXCEPTION
      'targeted scheduled task must use the target session sandbox backend'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduled_tasks_target_writer_fence ON "scheduled_tasks";
CREATE TRIGGER scheduled_tasks_target_writer_fence
BEFORE INSERT OR UPDATE ON "scheduled_tasks"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_scheduled_task_target_writer();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.enforce_scheduled_task_target_writer() TO opengeni_app'
    );
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;
