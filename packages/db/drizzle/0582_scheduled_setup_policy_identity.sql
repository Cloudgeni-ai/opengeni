-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- A creator's immutable setup restriction is standing authority; a manual
-- caller's restriction is not. Keep generated-session metadata exact, deriving
-- its policy only from the accepted run and the tenant-bound creator column.
-- All other generated-session identity checks and routine grants stay intact.
DO $migration$
DECLARE
  target regprocedure := 'fence_scheduled_task_run_connection_session_identity()'::regprocedure;
  definition text;
  anchor text := $before$      IF generated_binding = 'null'::jsonb$before$;
  replacement text;
BEGIN
  definition := pg_get_functiondef(target);
  replacement := $after$      IF EXISTS (
        SELECT 1 FROM scheduled_tasks creator_task
        WHERE creator_task.id = OLD.task_id
          AND creator_task.account_id = OLD.account_id
          AND creator_task.workspace_id = OLD.workspace_id
          AND creator_task.creator_session_policy ->> 'credentialRestriction' = 'developer_setup'
      ) THEN
        IF accepted -> 'turnExecutionPolicy' ->> 'credentialRestriction'
            IS DISTINCT FROM 'developer_setup' THEN
          RAISE EXCEPTION 'scheduled setup creator policy differs from accepted execution'
            USING ERRCODE = '42501';
        END IF;
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            'turnExecutionPolicyV1', accepted -> 'turnExecutionPolicy'
          );
      END IF;
      IF generated_binding = 'null'::jsonb$after$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'scheduled generated setup policy source contract changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$migration$;