-- deployment-mode: rolling
-- A scheduled task that starts its own chats may choose which bundled Skills
-- those chats get, including none (agentConfig.bundledSkillIds). The chat
-- stores that choice in its metadata, which the generated-session identity
-- fence did not expect, so every run of such a task was refused as an
-- authority change. The fence now expects exactly the accepted task's
-- selection there. Tasks without a selection compare as before, so the
-- previous release is unaffected. Only the routine is patched; no rows are
-- read or written.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  anchor constant text := $a$- '_opengeni_session_create_agent_config_v1';$a$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.fence_scheduled_task_run_connection_session_identity()',
    pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, '_opengeni_bundled_skill_ids_v1') > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1225 scheduled generated session fence drift'
      USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, anchor || $a$
          expected_generated_metadata := expected_generated_metadata
            - '_opengeni_bundled_skill_ids_v1';
          IF pg_catalog.jsonb_typeof(
            task_snapshot -> 'agentConfig' -> 'bundledSkillIds') = 'array' THEN
            expected_generated_metadata := expected_generated_metadata
              || pg_catalog.jsonb_build_object(
                '_opengeni_bundled_skill_ids_v1',
                task_snapshot -> 'agentConfig' -> 'bundledSkillIds');
          END IF;$a$);
  EXECUTE definition;
END
$migration$;
