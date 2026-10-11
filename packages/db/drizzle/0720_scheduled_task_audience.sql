-- deployment-mode: rolling
-- A schedule has an audience, like a chat: everyone in the workspace
-- (`workspace_shared`, the default and every existing schedule's behaviour) or
-- only its owner (`user_private`). An Only me schedule needs a human owner.
--
-- The audience decides who can read the schedule and whether its runs create
-- Only me chats. It is not execution configuration: like `name`, `status` and
-- the immutable owner, it is left out of the execution digest, so every
-- accepted run receipt keeps its exact digest and changing the audience never
-- invents a new authority revision.
--
-- Existing schedules that already post into an Only me chat, or write to the
-- owner's personal knowledge, become Only me. That only narrows who can read
-- them. Old releases never read the column and keep showing them as before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
CREATE TEMP TABLE scheduled_task_audience_bindings_before ON COMMIT DROP AS
  SELECT id, authority_revision, execution_digest FROM scheduled_tasks;

ALTER TABLE scheduled_tasks
  ADD COLUMN visibility text NOT NULL DEFAULT 'workspace_shared',
  ADD CONSTRAINT scheduled_tasks_visibility_check CHECK (
    visibility IN ('workspace_shared', 'user_private')
    AND (visibility = 'workspace_shared' OR owner_subject_id IS NOT NULL)
  );

DO $audience_digest$
DECLARE signature text; definition text;
  anchor constant text := '''execution_digest'', ''owner_subject_id''';
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'scheduled_task_execution_state(scheduled_tasks)',
    'scheduled_task_execution_digest(scheduled_tasks)',
    'set_scheduled_task_execution_digest()',
    'fence_scheduled_task_personal_resource_execution_update()'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF strpos(definition, anchor) = 0 THEN
      RAISE EXCEPTION 'scheduled task digest definition changed: %', signature;
    END IF;
    EXECUTE replace(definition, anchor, anchor || ', ''visibility''');
  END LOOP;
END
$audience_digest$;

-- Backfills obey the same workspace mutation fence as application writers.
DO $audience_fences$
DECLARE workspace_value uuid;
BEGIN
  FOR workspace_value IN SELECT DISTINCT workspace_id FROM scheduled_tasks ORDER BY workspace_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('session-tenancy:' || workspace_value::text, 0));
  END LOOP;
END
$audience_fences$;

ALTER TABLE scheduled_tasks DISABLE TRIGGER zz_scheduled_task_execution_digest;
UPDATE scheduled_tasks task SET visibility = 'user_private'
WHERE task.owner_subject_id IS NOT NULL
  AND (
    task.agent_config #>> '{knowledgeSource,destination,kind}' = 'personal'
    OR EXISTS (
      SELECT 1 FROM sessions target
      WHERE target.account_id = task.account_id
        AND target.workspace_id = task.workspace_id
        AND target.id = task.reusable_session_id
        AND target.visibility = 'user_private'
        AND target.owner_subject_id = task.owner_subject_id
    )
  );
ALTER TABLE scheduled_tasks ENABLE TRIGGER zz_scheduled_task_execution_digest;

DO $audience_binding_check$
BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_tasks task
    JOIN scheduled_task_audience_bindings_before prior ON prior.id = task.id
    WHERE task.authority_revision IS DISTINCT FROM prior.authority_revision
      OR task.execution_digest IS DISTINCT FROM prior.execution_digest) THEN
    RAISE EXCEPTION 'schedule audience backfill changed accepted execution bindings';
  END IF;
END
$audience_binding_check$;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;

-- The scheduler may create an Only me chat for an accepted run of an Only me
-- schedule, owned by the schedule's owner, who must also be the human the run
-- was admitted for. The existing personal-knowledge run proof is unchanged.
DO $private_schedule_session_create$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.guard_session_authority_write()', pg_catalog.current_schema()
  )::regprocedure);
  run_mode_anchor text := $a$run.accepted_execution_snapshot#>>'{task,runMode}'='new_session_per_run'$a$;
  knowledge_tail_anchor text := $a$'{task,agentConfig,knowledgeSource,initiatingSubjectId}'=capability.actor_subject_id$a$;
BEGIN
  IF strpos(definition, '{task,visibility}') > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, run_mode_anchor, ''))) / length(run_mode_anchor) <> 1
    OR (length(definition) - length(replace(definition, knowledge_tail_anchor, ''))) / length(knowledge_tail_anchor) <> 1
  THEN
    RAISE EXCEPTION '0720 private schedule session create drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, run_mode_anchor,
    $r$((run.accepted_execution_snapshot#>>'{task,visibility}'='private'
                AND run.accepted_execution_snapshot#>>'{task,ownerSubjectId}'=capability.actor_subject_id
                AND run.accepted_execution_snapshot#>>'{task,runMode}' IN ('new_session_per_run','reusable_session'))
              OR (run.accepted_execution_snapshot#>>'{task,runMode}'='new_session_per_run'$r$);
  definition := replace(definition, knowledge_tail_anchor, knowledge_tail_anchor || '))');
  EXECUTE definition;
END
$private_schedule_session_create$;

-- The generated chat of an Only me schedule's run is Only me and owned by the
-- run's admitted human, who must be the schedule's owner.
DO $private_schedule_session_identity$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.fence_scheduled_task_run_connection_session_identity()', pg_catalog.current_schema()
  )::regprocedure);
  anchor text := $a$WHEN task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'$a$;
BEGIN
  IF strpos(definition, $a$task_snapshot->>'visibility'='private'$a$) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 3 THEN
    RAISE EXCEPTION '0720 private schedule session identity drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    $r$WHEN (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
            OR (task_snapshot->>'visibility'='private'
              AND task_snapshot->>'ownerSubjectId' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
              AND accepted#>>'{causalHumanAuthority,subjectId}' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
              AND accepted->>'causalHumanSubjectId' IS NOT NULL))$r$);
END
$private_schedule_session_identity$;

-- An Only me schedule that reuses one chat reuses its owner's Only me chat.
DO $private_schedule_reusable_session$
DECLARE
  target regprocedure := pg_catalog.format(
    '%I.materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)',
    pg_catalog.current_schema()
  )::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target);
  anchor text := $a$session_value.visibility = 'workspace_shared'$a$;
BEGIN
  IF strpos(definition, $a$task_row.visibility = 'user_private'$a$) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 3 THEN
    RAISE EXCEPTION '0720 private schedule reusable session drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    $r$(session_value.visibility = 'workspace_shared'
      OR (task_row.visibility = 'user_private' AND session_value.visibility = 'user_private'
        AND session_value.owner_subject_id IS NOT DISTINCT FROM task_row.owner_subject_id))$r$);
END
$private_schedule_reusable_session$;
