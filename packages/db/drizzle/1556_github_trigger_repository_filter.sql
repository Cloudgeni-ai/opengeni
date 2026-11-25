-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: adds one repository condition to the GitHub triggers of agent tasks that keep exactly one GitHub repository, once; few rows.
-- GitHub triggers filter on their repository (docs/agents.md, "Starts when").
-- Until now the repository picked for an agent's GitHub trigger was only
-- checked out: no condition named it, so the trigger fired for every
-- repository the GitHub connection reaches, and each of those runs checked
-- out the picked one. Add trigger now saves a data.repository.full_name
-- condition instead (all repositories, or the chosen ones), and each run
-- checks out the repository its event is about.
--
-- Existing agent triggers keep their one repository and now fire only for it:
-- each trigger on a GitHub source, whose task belongs to an agent
-- (agent_config.agentId, what Add trigger saves), keeps exactly one
-- repository resource on github.com and whose conditions name no
-- data.repository field yet, gets
-- {"field":"data.repository.full_name","op":"equals","value":"owner/name"}.
-- A task with no repository keeps firing for every repository; a task with
-- several keeps its conditions (none was saved by Add trigger). Other
-- automations are left as they are: watching every repository while working
-- in one can be deliberate there.
--
-- Rolling: the previous release reads the same condition model and applies
-- the condition as it would one a person added. event_triggers,
-- scheduled_tasks and event_sources are FORCE ROW LEVEL SECURITY, so the
-- window is lifted for the backfill and restored before commit
-- (docs/force-rls-migration-backfills.md). A NOTICE reports the count.
SET LOCAL lock_timeout = '5s';

ALTER TABLE event_triggers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE event_sources NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  changed bigint;
BEGIN
  WITH single_repository AS (
    SELECT task.id AS task_id,
      regexp_replace(
        regexp_replace(resource ->> 'uri', '^https://github\.com/', ''),
        '\.git$', ''
      ) AS full_name
    FROM scheduled_tasks task
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(task.agent_config -> 'resources') = 'array'
        THEN task.agent_config -> 'resources' ELSE '[]'::jsonb END
    ) resource
    WHERE task.agent_config ->> 'agentId' IS NOT NULL
      AND resource ->> 'kind' = 'repository'
      AND resource ->> 'uri' ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
      AND (
        SELECT count(*) FROM jsonb_array_elements(task.agent_config -> 'resources') other
        WHERE other ->> 'kind' = 'repository'
      ) = 1
  )
  UPDATE event_triggers trigger_row SET
    conditions = trigger_row.conditions || jsonb_build_array(jsonb_build_object(
      'field', 'data.repository.full_name',
      'op', 'equals',
      'value', single_repository.full_name
    )),
    updated_at = now()
  FROM single_repository, event_sources source
  WHERE trigger_row.task_id = single_repository.task_id
    AND source.id = trigger_row.source_id
    AND source.kind = 'github'
    AND single_repository.full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    AND jsonb_typeof(trigger_row.conditions) = 'array'
    AND jsonb_array_length(trigger_row.conditions) < 16
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(trigger_row.conditions) condition
      WHERE condition ->> 'field' LIKE 'data.repository%'
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'github trigger repository filter backfill: triggers changed %', changed;
END $$;

ALTER TABLE event_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE event_triggers FORCE ROW LEVEL SECURITY;
