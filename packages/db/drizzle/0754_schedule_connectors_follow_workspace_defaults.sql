-- deployment-mode: rolling
-- Schedules that start their own session follow the workspace's default
-- connectors at each run, the way a new chat does.
--
-- Earlier releases copied the workspace defaults into `agentConfig.tools`
-- when a schedule was created without choosing tools, so a connector the
-- workspace added later never reached it. A schedule now says that it follows
-- the defaults (`agentConfig.toolPolicy` with mode `workspace_default`) and
-- each run resolves them afresh; `tools` lists only connectors added on top.
--
-- An agent schedule that starts its own session (a new session for each run,
-- or a reusable session that does not exist yet) is moved to follow the
-- defaults when nobody demonstrably chose its list: an agent created it, or a
-- service did. Its saved tools stay as additions, so no run loses a connector
-- it had; a run may gain defaults the old copy lacked. Nothing is excluded,
-- because a saved copy of the defaults cannot show which ones were left out
-- on purpose.
--
-- A schedule a person created directly keeps its list exactly: that list is
-- the person's choice, often a deliberate narrowing. "Directly" is the same
-- test the server applies to a person's own turn: created by a subject, with
-- no delegation, truncated or unknown provenance and no backfill in its
-- creation context. Schedules that post into an existing chat, reusable sessions
-- that already exist (the session owns its connectors) and knowledge syncs
-- are unchanged too.
--
-- The change is authority-equivalent for the schedule head, as in 0753: the
-- owner, the authority revision and every other execution field stay, the
-- digest trigger derives the new execution digest, and the current-revision
-- authority rows that matched the previous digest move to it.
--
-- Rolling: a previous release ignores `toolPolicy` and runs exactly `tools`,
-- which is what it did before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revision_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_personal_resource_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_connection_authority_snapshots NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE schedule_connectors_follow_defaults ON COMMIT DROP AS
SELECT
  task.id,
  task.authority_revision,
  task.execution_digest AS previous_execution_digest,
  task.agent_config || jsonb_build_object(
    'toolPolicy',
    jsonb_build_object('mode', 'workspace_default', 'excludedMcpServerIds', '[]'::jsonb)
  ) AS agent_config
FROM scheduled_tasks task
WHERE task.action ->> 'kind' = 'agent_turn'
  AND NOT task.agent_config ? 'toolPolicy'
  AND NOT task.agent_config ? 'knowledgeSource'
  AND (
    task.run_mode = 'new_session_per_run'
    OR (task.run_mode = 'reusable_session' AND task.reusable_session_id IS NULL)
  )
  AND (
    task.created_by_kind <> 'subject'
    OR task.created_by_context ?| ARRAY['via', 'viaTruncated', 'provenanceError', 'backfill']
  );

DO $schedule_connectors_follow_defaults_before$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schedule_connectors_follow_defaults migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE migrated.previous_execution_digest IS DISTINCT FROM
      scheduled_task_execution_digest(task)
  ) THEN
    RAISE EXCEPTION
      '0754 cannot reproduce a stored scheduled-task execution digest'
      USING ERRCODE = '23514';
  END IF;
END
$schedule_connectors_follow_defaults_before$;

ALTER TABLE scheduled_tasks DISABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE scheduled_tasks
  DISABLE TRIGGER scheduled_task_personal_resource_execution_revision;

UPDATE scheduled_tasks task
SET agent_config = migrated.agent_config
FROM schedule_connectors_follow_defaults migrated
WHERE task.id = migrated.id;

UPDATE scheduled_task_revision_authorities authority
SET execution_digest = task.execution_digest
FROM schedule_connectors_follow_defaults migrated
JOIN scheduled_tasks task ON task.id = migrated.id
WHERE authority.task_id = migrated.id
  AND authority.task_authority_revision = migrated.authority_revision
  AND authority.execution_digest = migrated.previous_execution_digest;

UPDATE scheduled_task_personal_resource_authorities authority
SET execution_digest = task.execution_digest
FROM schedule_connectors_follow_defaults migrated
JOIN scheduled_tasks task ON task.id = migrated.id
WHERE authority.task_id = migrated.id
  AND authority.task_authority_revision = migrated.authority_revision
  AND authority.execution_digest = migrated.previous_execution_digest;

WITH rewritten AS (
  SELECT
    snapshot.task_id,
    snapshot.task_authority_revision,
    snapshot.server_id,
    task.execution_digest,
    jsonb_set(
      snapshot.canonical_snapshot,
      '{executionDigest}',
      to_jsonb(task.execution_digest),
      false
    ) AS canonical_snapshot
  FROM scheduled_task_connection_authority_snapshots snapshot
  JOIN schedule_connectors_follow_defaults migrated
    ON migrated.id = snapshot.task_id
   AND migrated.authority_revision = snapshot.task_authority_revision
  JOIN scheduled_tasks task ON task.id = migrated.id
  WHERE snapshot.execution_digest = migrated.previous_execution_digest
)
UPDATE scheduled_task_connection_authority_snapshots snapshot
SET execution_digest = rewritten.execution_digest,
    canonical_snapshot = rewritten.canonical_snapshot,
    snapshot_digest = digest(
      convert_to(rewritten.canonical_snapshot::text, 'UTF8'),
      'sha256'
    )
FROM rewritten
WHERE snapshot.task_id = rewritten.task_id
  AND snapshot.task_authority_revision = rewritten.task_authority_revision
  AND snapshot.server_id = rewritten.server_id;

ALTER TABLE scheduled_tasks
  ENABLE TRIGGER scheduled_task_personal_resource_execution_revision;
ALTER TABLE scheduled_tasks ENABLE TRIGGER session_tenancy_workspace_fence;

DO $schedule_connectors_follow_defaults_after$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schedule_connectors_follow_defaults migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE task.agent_config IS DISTINCT FROM migrated.agent_config
      OR task.authority_revision IS DISTINCT FROM migrated.authority_revision
      OR task.execution_digest IS DISTINCT FROM scheduled_task_execution_digest(task)
  ) OR EXISTS (
    SELECT 1
    FROM schedule_connectors_follow_defaults migrated
    JOIN scheduled_task_revision_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest = migrated.previous_execution_digest
      AND migrated.previous_execution_digest IS DISTINCT FROM (
        SELECT task.execution_digest FROM scheduled_tasks task WHERE task.id = migrated.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM schedule_connectors_follow_defaults migrated
    JOIN scheduled_task_personal_resource_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest = migrated.previous_execution_digest
      AND migrated.previous_execution_digest IS DISTINCT FROM (
        SELECT task.execution_digest FROM scheduled_tasks task WHERE task.id = migrated.id
      )
  ) THEN
    RAISE EXCEPTION '0754 schedule connector defaults did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$schedule_connectors_follow_defaults_after$;

ALTER TABLE scheduled_task_connection_authority_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_personal_resource_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revision_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
