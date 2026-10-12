-- deployment-mode: rolling
-- Schedules resolve connector accounts live. A schedule no longer stores the
-- accounts a save happened to see: every connector follows the owner's
-- current accounts at each run, and only a person can pin an account (on a
-- schedule that starts its own session) under `agentConfig.pinnedAccounts`.
--
-- Earlier releases wrote every save's resolved accounts back into
-- `agentConfig.connectionAccounts` with `connectionAccountsFrozen: true`,
-- whoever saved it and whatever they chose. Those lists are snapshots, not
-- choices: the write-back made a person's narrowing indistinguishable from a
-- snapshot and saves were not audited, so nothing stored can show that a
-- person picked them. Every stored list is therefore removed and the schedule
-- returns to its owner's current accounts. Nothing is converted into a pin.
--
-- The removal is authority-equivalent for the schedule head: the owner, the
-- authority revision and every other execution field stay exactly as they
-- were. The normal digest trigger derives the new execution digest, and the
-- current-revision authority rows that matched the previous digest move to
-- it. Rows that were already out of step stay as they were. Accepted run
-- snapshots are immutable history and are not touched.
--
-- Rolling: a previous release reading a migrated schedule finds no stored
-- list and resolves the owner's current accounts, which is the new meaning.
-- A previous release's save during rollout may write a list again; current
-- releases never read it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- These hold each table exclusively until commit, so no application writer
-- runs concurrently and no workspace fence is taken.
ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revision_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_personal_resource_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_connection_authority_snapshots NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE schedule_live_connector_accounts ON COMMIT DROP AS
SELECT
  task.id,
  task.authority_revision,
  task.execution_digest AS previous_execution_digest,
  task.agent_config - 'connectionAccounts' - 'connectionAccountsFrozen' AS agent_config
FROM scheduled_tasks task
WHERE task.agent_config ?| ARRAY['connectionAccounts', 'connectionAccountsFrozen'];

DO $schedule_live_connector_accounts_before$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schedule_live_connector_accounts migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE migrated.previous_execution_digest IS DISTINCT FROM
      scheduled_task_execution_digest(task)
  ) THEN
    RAISE EXCEPTION
      '0738 cannot reproduce a stored scheduled-task execution digest'
      USING ERRCODE = '23514';
  END IF;
END
$schedule_live_connector_accounts_before$;

-- The workspace fence trigger and the personal-resource revision trigger
-- would treat this rewrite as an ordinary edit. The exclusive table lock above
-- already serializes it, and the revision must not advance.
ALTER TABLE scheduled_tasks DISABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE scheduled_tasks
  DISABLE TRIGGER scheduled_task_personal_resource_execution_revision;

UPDATE scheduled_tasks task
SET agent_config = migrated.agent_config
FROM schedule_live_connector_accounts migrated
WHERE task.id = migrated.id;

UPDATE scheduled_task_revision_authorities authority
SET execution_digest = task.execution_digest
FROM schedule_live_connector_accounts migrated
JOIN scheduled_tasks task ON task.id = migrated.id
WHERE authority.task_id = migrated.id
  AND authority.task_authority_revision = migrated.authority_revision
  AND authority.execution_digest = migrated.previous_execution_digest;

UPDATE scheduled_task_personal_resource_authorities authority
SET execution_digest = task.execution_digest
FROM schedule_live_connector_accounts migrated
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
  JOIN schedule_live_connector_accounts migrated
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

DO $schedule_live_connector_accounts_after$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM scheduled_tasks task
    WHERE task.agent_config ?| ARRAY['connectionAccounts', 'connectionAccountsFrozen']
  ) OR EXISTS (
    SELECT 1
    FROM schedule_live_connector_accounts migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE task.agent_config IS DISTINCT FROM migrated.agent_config
      OR task.authority_revision IS DISTINCT FROM migrated.authority_revision
      OR task.execution_digest IS DISTINCT FROM scheduled_task_execution_digest(task)
  ) OR EXISTS (
    SELECT 1
    FROM schedule_live_connector_accounts migrated
    JOIN scheduled_task_revision_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest = migrated.previous_execution_digest
      AND migrated.previous_execution_digest IS DISTINCT FROM (
        SELECT task.execution_digest FROM scheduled_tasks task WHERE task.id = migrated.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM schedule_live_connector_accounts migrated
    JOIN scheduled_task_personal_resource_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest = migrated.previous_execution_digest
      AND migrated.previous_execution_digest IS DISTINCT FROM (
        SELECT task.execution_digest FROM scheduled_tasks task WHERE task.id = migrated.id
      )
  ) THEN
    RAISE EXCEPTION '0738 schedule connector account removal did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$schedule_live_connector_accounts_after$;

ALTER TABLE scheduled_task_connection_authority_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_personal_resource_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revision_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
