-- deployment-mode: maintenance

-- Move the durable out-of-turn wait from an active goal to its owning session.
-- This is an intentional clean break: the first-party tool is now
-- `wait_for_input`, it does not require a goal, and there is no compatibility
-- alias for `goal_wait`. Existing declarations keep their exact turn,
-- deadline, reason, and set time across the cutover. Existing explicit tool
-- selections replace `goal_wait` with `wait_for_input` in place across
-- sessions, workspace defaults, private drafts, automation definitions and
-- accepted runs, scheduled accepted-execution snapshots, and registered or
-- installed Pack manifests. Digest-bound snapshots are rewritten with their
-- exact native digest authority in the same transaction.
-- Stop every API, control worker, and turn worker before applying this
-- migration, and never restart a pre-0402 image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $session_input_wait_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0402 session input wait activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0402 session input wait activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0402 session input wait activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0402 session input wait activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_input_wait_runtime_drain_before$;

-- The runtime drain is a process fence. Hold every affected persistence
-- authority too, so no migration/admin writer can create a stale snapshot
-- between inventory, digest proof, and rewrite.
LOCK TABLE
  "workspaces",
  "sessions",
  "session_goals",
  "new_session_drafts",
  "automation_trigger_revisions",
  "automation_runs",
  "scheduled_tasks",
  "scheduled_task_revision_authorities",
  "scheduled_task_personal_resource_authorities",
  "scheduled_task_connection_authority_snapshots",
  "scheduled_task_runs",
  "workspace_packs",
  "pack_installations",
  "capability_operations"
IN ACCESS EXCLUSIVE MODE;

-- Preserve exact first-seen order. The rename may make an existing
-- wait_for_input entry collide with one or more historical goal_wait entries;
-- collapse only that replacement, leaving every unrelated entry byte-order
-- equivalent (including any unrelated duplicates).
CREATE FUNCTION opengeni_private.session_wait_translate_tool_array(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $translate$
DECLARE
  translated jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(value) AS entry(item)
    WHERE jsonb_typeof(entry.item) <> 'string'
  ) THEN
    RAISE EXCEPTION 'persisted first-party tool selection must be a string array'
      USING ERRCODE = '23514';
  END IF;

  WITH mapped AS (
    SELECT
      CASE entry.value #>> '{}'
        WHEN 'goal_wait' THEN 'wait_for_input'
        ELSE entry.value #>> '{}'
      END AS tool,
      entry.ordinality
    FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality)
  ), ranked AS (
    SELECT
      mapped.tool,
      mapped.ordinality,
      row_number() OVER (
        PARTITION BY mapped.tool
        ORDER BY mapped.ordinality
      ) AS tool_ordinality
    FROM mapped
  )
  SELECT coalesce(
    jsonb_agg(to_jsonb(ranked.tool) ORDER BY ranked.ordinality),
    '[]'::jsonb
  )
  INTO translated
  FROM ranked
  WHERE ranked.tool <> 'wait_for_input' OR ranked.tool_ordinality = 1;

  RETURN translated;
END
$translate$;

CREATE FUNCTION opengeni_private.session_wait_rewrite_automation_template(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_automation_template$
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR jsonb_typeof(value -> 'firstPartyMcpTools') <> 'array'
  THEN
    RAISE EXCEPTION 'persisted automation session template has invalid tool selection'
      USING ERRCODE = '23514';
  END IF;
  IF value -> 'firstPartyMcpTools' @> '["goal_wait"]'::jsonb THEN
    RETURN jsonb_set(
      value,
      '{firstPartyMcpTools}',
      opengeni_private.session_wait_translate_tool_array(
        value -> 'firstPartyMcpTools'
      ),
      false
    );
  END IF;
  RETURN value;
END
$rewrite_automation_template$;

CREATE FUNCTION opengeni_private.session_wait_rewrite_pack(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_pack$
DECLARE
  templates jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR NOT (value ? 'automationTemplates')
    OR jsonb_typeof(value -> 'automationTemplates') <> 'array'
  THEN
    RETURN value;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      CASE
        WHEN template.value #> '{sessionTemplate,firstPartyMcpTools}'
          @> '["goal_wait"]'::jsonb
        THEN jsonb_set(
          template.value,
          '{sessionTemplate}',
          opengeni_private.session_wait_rewrite_automation_template(
            template.value -> 'sessionTemplate'
          ),
          false
        )
        ELSE template.value
      END
      ORDER BY template.ordinality
    ),
    '[]'::jsonb
  )
  INTO templates
  FROM jsonb_array_elements(value -> 'automationTemplates')
    WITH ORDINALITY AS template(value, ordinality);

  RETURN jsonb_set(value, '{automationTemplates}', templates, false);
END
$rewrite_pack$;

CREATE FUNCTION opengeni_private.session_wait_rewrite_scheduled_agent_config(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_scheduled_agent_config$
DECLARE
  rewritten jsonb := value;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RAISE EXCEPTION 'persisted scheduled agent config must be an object'
      USING ERRCODE = '23514';
  END IF;

  IF rewritten #> '{incidentTelemetryPreflight,requiredFirstPartyMcpTools}'
    @> '["goal_wait"]'::jsonb
  THEN
    rewritten := jsonb_set(
      rewritten,
      '{incidentTelemetryPreflight,requiredFirstPartyMcpTools}',
      opengeni_private.session_wait_translate_tool_array(
        rewritten #> '{incidentTelemetryPreflight,requiredFirstPartyMcpTools}'
      ),
      false
    );
  END IF;
  IF rewritten #>> '{incidentTelemetryPreflight,dataSource,route,kind}' = 'first_party'
    AND rewritten #>> '{incidentTelemetryPreflight,dataSource,route,tool}' = 'goal_wait'
  THEN
    rewritten := jsonb_set(
      rewritten,
      '{incidentTelemetryPreflight,dataSource,route,tool}',
      to_jsonb('wait_for_input'::text),
      false
    );
  END IF;
  RETURN rewritten;
END
$rewrite_scheduled_agent_config$;

CREATE FUNCTION opengeni_private.session_wait_rewrite_scheduled_execution(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_scheduled_execution$
DECLARE
  rewritten jsonb := value;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RAISE EXCEPTION 'persisted scheduled accepted execution must be an object'
      USING ERRCODE = '23514';
  END IF;

  IF rewritten -> 'resolvedFirstPartyMcpTools' @> '["goal_wait"]'::jsonb THEN
    rewritten := jsonb_set(
      rewritten,
      '{resolvedFirstPartyMcpTools}',
      opengeni_private.session_wait_translate_tool_array(
        rewritten -> 'resolvedFirstPartyMcpTools'
      ),
      false
    );
  END IF;
  IF rewritten #> '{targetSessionExecution,firstPartyMcpTools}'
    @> '["goal_wait"]'::jsonb
  THEN
    rewritten := jsonb_set(
      rewritten,
      '{targetSessionExecution,firstPartyMcpTools}',
      opengeni_private.session_wait_translate_tool_array(
        rewritten #> '{targetSessionExecution,firstPartyMcpTools}'
      ),
      false
    );
  END IF;
  IF rewritten #> '{task,agentConfig}' IS DISTINCT FROM
    opengeni_private.session_wait_rewrite_scheduled_agent_config(
      rewritten #> '{task,agentConfig}'
    )
  THEN
    rewritten := jsonb_set(
      rewritten,
      '{task,agentConfig}',
      opengeni_private.session_wait_rewrite_scheduled_agent_config(
        rewritten #> '{task,agentConfig}'
      ),
      false
    );
  END IF;
  RETURN rewritten;
END
$rewrite_scheduled_execution$;

-- Pack manifests are hashed with contracts stableJson(), whose object-key
-- order uses the default en-US Intl comparator. Reproduce those exact bytes;
-- the old-digest precondition below aborts before mutation if this database's
-- ICU/scalar rendering cannot reproduce any affected stored digest.
CREATE COLLATION opengeni_private.session_wait_js_en_us (
  provider = icu,
  locale = 'en-US',
  deterministic = false
);

CREATE FUNCTION opengeni_private.session_wait_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $canonical_json$
DECLARE
  rendered text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT coalesce(
        '{' || string_agg(
          to_jsonb(entry.key)::text || ':' ||
            opengeni_private.session_wait_canonical_json(entry.value),
          ',' ORDER BY
            entry.key COLLATE opengeni_private.session_wait_js_en_us,
            entry.ordinality
        ) || '}',
        '{}'
      )
      INTO rendered
      FROM jsonb_each(value) WITH ORDINALITY AS entry(key, value, ordinality);
      RETURN rendered;
    WHEN 'array' THEN
      SELECT coalesce(
        '[' || string_agg(
          opengeni_private.session_wait_canonical_json(entry.value),
          ',' ORDER BY entry.ordinality
        ) || ']',
        '[]'
      )
      INTO rendered
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN value::text;
  END CASE;
END
$canonical_json$;

ALTER TABLE "sessions"
  ADD COLUMN "input_wait_turn_id" uuid,
  ADD COLUMN "input_wait_until" timestamptz,
  ADD COLUMN "input_wait_reason" text,
  ADD COLUMN "input_wait_set_at" timestamptz;

-- The production migration identity is a NOSUPERUSER/NOBYPASSRLS table owner.
-- Relax FORCE only for this drained owner backfill, then restore it before any
-- constraint or column cutover. The enclosing migration transaction makes a
-- failure rollback both posture changes.
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_goals" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "new_session_drafts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "automation_trigger_revisions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "automation_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_revision_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_connection_authority_snapshots" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_packs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "pack_installations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_operations" NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE session_wait_scheduled_task_cutover ON COMMIT DROP AS
SELECT
  task.id,
  task.account_id,
  task.workspace_id,
  task.authority_revision,
  task.execution_digest AS previous_execution_digest,
  task.agent_config AS previous_agent_config,
  opengeni_private.session_wait_rewrite_scheduled_agent_config(
    task.agent_config
  ) AS agent_config
FROM scheduled_tasks task
WHERE task.agent_config IS DISTINCT FROM
  opengeni_private.session_wait_rewrite_scheduled_agent_config(
    task.agent_config
  );

CREATE TEMP TABLE session_wait_scheduled_snapshot_cutover ON COMMIT DROP AS
SELECT
  run.id,
  run.workspace_id,
  run.accepted_execution_snapshot AS previous_snapshot,
  run.accepted_execution_digest AS previous_digest,
  opengeni_private.session_wait_rewrite_scheduled_execution(
    run.accepted_execution_snapshot
  ) AS accepted_execution_snapshot
FROM scheduled_task_runs run
WHERE run.accepted_execution_snapshot IS NOT NULL
  AND run.accepted_execution_snapshot IS DISTINCT FROM
    opengeni_private.session_wait_rewrite_scheduled_execution(
      run.accepted_execution_snapshot
    );

CREATE TEMP TABLE session_wait_pack_snapshot_cutover ON COMMIT DROP AS
SELECT
  installation.id,
  installation.workspace_id,
  installation.pack_id,
  installation.manifest_snapshot AS previous_manifest_snapshot,
  installation.manifest_digest AS previous_manifest_digest,
  opengeni_private.session_wait_rewrite_pack(
    installation.manifest_snapshot
  ) AS manifest_snapshot,
  encode(
    digest(
      convert_to(
        opengeni_private.session_wait_canonical_json(
          opengeni_private.session_wait_rewrite_pack(
            installation.manifest_snapshot
          )
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) AS manifest_digest
FROM pack_installations installation
WHERE installation.manifest_snapshot IS NOT NULL
  AND installation.manifest_snapshot IS DISTINCT FROM
    opengeni_private.session_wait_rewrite_pack(
      installation.manifest_snapshot
    );

DO $session_wait_snapshot_preconditions$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE migrated.previous_execution_digest IS DISTINCT FROM
      scheduled_task_execution_digest(task)
  ) THEN
    RAISE EXCEPTION
      '0402 cannot reproduce a stored scheduled-task execution digest'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_task_revision_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest IS DISTINCT FROM
      migrated.previous_execution_digest
  ) OR EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_task_personal_resource_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest IS DISTINCT FROM
      migrated.previous_execution_digest
  ) OR EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_task_connection_authority_snapshots snapshot
      ON snapshot.task_id = migrated.id
     AND snapshot.task_authority_revision = migrated.authority_revision
    WHERE snapshot.execution_digest IS DISTINCT FROM
        migrated.previous_execution_digest
      OR snapshot.canonical_snapshot ->> 'executionDigest' IS DISTINCT FROM
        migrated.previous_execution_digest
      OR snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'),
        'sha256'
      )
  ) THEN
    RAISE EXCEPTION
      '0402 scheduled-task authority digest evidence is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_scheduled_snapshot_cutover migrated
    WHERE migrated.previous_digest IS DISTINCT FROM encode(
      digest(convert_to(migrated.previous_snapshot::text, 'UTF8'), 'sha256'),
      'hex'
    )
  ) THEN
    RAISE EXCEPTION
      '0402 cannot reproduce a stored scheduled accepted-execution digest'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_pack_snapshot_cutover migrated
    WHERE migrated.previous_manifest_digest IS DISTINCT FROM encode(
      digest(
        convert_to(
          opengeni_private.session_wait_canonical_json(
            migrated.previous_manifest_snapshot
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  ) THEN
    RAISE EXCEPTION
      '0402 cannot reproduce a stored runtime Pack manifest digest'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM capability_operations operation
    JOIN (
      SELECT pack.workspace_id, pack.pack_id
      FROM workspace_packs pack
      WHERE pack.manifest IS DISTINCT FROM
        opengeni_private.session_wait_rewrite_pack(pack.manifest)
      UNION
      SELECT migrated.workspace_id, migrated.pack_id
      FROM session_wait_pack_snapshot_cutover migrated
    ) affected
      ON affected.workspace_id = operation.workspace_id
     AND affected.pack_id = operation.target_id
    WHERE operation.target_kind = 'pack'
      AND operation.status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION
      '0402 requires affected Pack operations to be settled before cutover'
      USING ERRCODE = '55000';
  END IF;
END
$session_wait_snapshot_preconditions$;

DO $session_input_wait_workspace_fences$
DECLARE
  workspace_id_value uuid;
BEGIN
  FOR workspace_id_value IN
    SELECT affected."workspace_id"
    FROM (
      SELECT session."workspace_id"
      FROM "sessions" AS session
      JOIN "session_goals" AS goal
        ON goal."workspace_id" = session."workspace_id"
       AND goal."session_id" = session."id"
      WHERE goal."continuation_hold_turn_id" IS NOT NULL
      UNION
      SELECT session."workspace_id"
      FROM "sessions" AS session
      WHERE session."first_party_mcp_tools" @> '["goal_wait"]'::jsonb
      UNION
      SELECT workspace.id
      FROM workspaces workspace
      WHERE workspace.settings #> '{sessionToolDefaults,firstPartyMcpTools}'
        @> '["goal_wait"]'::jsonb
      UNION
      SELECT draft.workspace_id
      FROM new_session_drafts draft
      WHERE draft.session_options -> 'firstPartyMcpTools'
        @> '["goal_wait"]'::jsonb
      UNION
      SELECT revision.workspace_id
      FROM automation_trigger_revisions revision
      WHERE revision.session_template -> 'firstPartyMcpTools'
        @> '["goal_wait"]'::jsonb
      UNION
      SELECT run.workspace_id
      FROM automation_runs run
      WHERE run.accepted_execution #> '{sessionTemplate,firstPartyMcpTools}'
        @> '["goal_wait"]'::jsonb
      UNION
      SELECT migrated.workspace_id
      FROM session_wait_scheduled_task_cutover migrated
      UNION
      SELECT migrated.workspace_id
      FROM session_wait_scheduled_snapshot_cutover migrated
      UNION
      SELECT pack.workspace_id
      FROM workspace_packs pack
      WHERE pack.manifest IS DISTINCT FROM
        opengeni_private.session_wait_rewrite_pack(pack.manifest)
      UNION
      SELECT migrated.workspace_id
      FROM session_wait_pack_snapshot_cutover migrated
    ) AS affected
    ORDER BY affected."workspace_id"
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
  END LOOP;
END
$session_input_wait_workspace_fences$;

UPDATE "sessions" AS session SET
  "input_wait_turn_id" = goal."continuation_hold_turn_id",
  "input_wait_until" = goal."continuation_hold_until",
  "input_wait_reason" = coalesce(nullif(btrim(goal."continuation_hold_reason"), ''), 'Waiting for external input'),
  "input_wait_set_at" = goal."continuation_hold_set_at"
FROM "session_goals" AS goal
WHERE goal."workspace_id" = session."workspace_id"
  AND goal."session_id" = session."id"
  AND goal."continuation_hold_turn_id" IS NOT NULL
  AND goal."continuation_hold_until" IS NOT NULL
  AND goal."continuation_hold_set_at" IS NOT NULL;

-- Tool selection is an immutable per-session snapshot. Preserve every
-- selected tool and its first-seen order while translating the clean-break
-- rename; collapse the replacement when a snapshot already contains both.
UPDATE "sessions" AS session
SET "first_party_mcp_tools" =
  opengeni_private.session_wait_translate_tool_array(
    session."first_party_mcp_tools"
  )
WHERE session."first_party_mcp_tools" @> '["goal_wait"]'::jsonb;

UPDATE workspaces workspace
SET settings = jsonb_set(
  workspace.settings,
  '{sessionToolDefaults,firstPartyMcpTools}',
  opengeni_private.session_wait_translate_tool_array(
    workspace.settings #> '{sessionToolDefaults,firstPartyMcpTools}'
  ),
  false
)
WHERE workspace.settings #> '{sessionToolDefaults,firstPartyMcpTools}'
  @> '["goal_wait"]'::jsonb;

UPDATE new_session_drafts draft
SET session_options = jsonb_set(
  draft.session_options,
  '{firstPartyMcpTools}',
  opengeni_private.session_wait_translate_tool_array(
    draft.session_options -> 'firstPartyMcpTools'
  ),
  false
)
WHERE draft.session_options -> 'firstPartyMcpTools'
  @> '["goal_wait"]'::jsonb;

UPDATE automation_trigger_revisions revision
SET session_template =
  opengeni_private.session_wait_rewrite_automation_template(
    revision.session_template
  )
WHERE revision.session_template -> 'firstPartyMcpTools'
  @> '["goal_wait"]'::jsonb;

UPDATE automation_runs run
SET accepted_execution = jsonb_set(
  run.accepted_execution,
  '{sessionTemplate}',
  opengeni_private.session_wait_rewrite_automation_template(
    run.accepted_execution -> 'sessionTemplate'
  ),
  false
)
WHERE run.accepted_execution #> '{sessionTemplate,firstPartyMcpTools}'
  @> '["goal_wait"]'::jsonb;

-- The protocol rename is authority-equivalent for an active scheduled-task
-- head. Preserve its exact revision while the normal digest trigger derives
-- the new execution digest, then move only the current-revision authority
-- headers and canonical Connection evidence to that digest. Ordinary runtime
-- updates still advance revisions through the two triggers disabled here.
ALTER TABLE scheduled_tasks
  DISABLE TRIGGER scheduled_task_connection_authority_execution_revision;
ALTER TABLE scheduled_tasks
  DISABLE TRIGGER scheduled_task_personal_resource_execution_revision;

UPDATE scheduled_tasks task
SET agent_config = migrated.agent_config
FROM session_wait_scheduled_task_cutover migrated
WHERE task.id = migrated.id;

UPDATE scheduled_task_revision_authorities authority
SET execution_digest = task.execution_digest
FROM session_wait_scheduled_task_cutover migrated
JOIN scheduled_tasks task ON task.id = migrated.id
WHERE authority.task_id = migrated.id
  AND authority.task_authority_revision = migrated.authority_revision;

UPDATE scheduled_task_personal_resource_authorities authority
SET execution_digest = task.execution_digest
FROM session_wait_scheduled_task_cutover migrated
JOIN scheduled_tasks task ON task.id = migrated.id
WHERE authority.task_id = migrated.id
  AND authority.task_authority_revision = migrated.authority_revision;

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
  JOIN session_wait_scheduled_task_cutover migrated
    ON migrated.id = snapshot.task_id
   AND migrated.authority_revision = snapshot.task_authority_revision
  JOIN scheduled_tasks task ON task.id = migrated.id
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
ALTER TABLE scheduled_tasks
  ENABLE TRIGGER scheduled_task_connection_authority_execution_revision;

-- Accepted scheduled execution is immutable during runtime. The drained
-- protocol migration is the one bounded exception: prove the previous digest,
-- disable only that immutable-update trigger, replace the typed paths, and
-- recompute the database-native JSONB digest atomically.
ALTER TABLE scheduled_task_runs
  DISABLE TRIGGER scheduled_task_run_connection_session_identity_immutable;

UPDATE scheduled_task_runs run
SET accepted_execution_snapshot = migrated.accepted_execution_snapshot,
    accepted_execution_digest = encode(
      digest(
        convert_to(migrated.accepted_execution_snapshot::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
FROM session_wait_scheduled_snapshot_cutover migrated
WHERE run.id = migrated.id;

ALTER TABLE scheduled_task_runs
  ENABLE TRIGGER scheduled_task_run_connection_session_identity_immutable;

UPDATE workspace_packs pack
SET manifest = opengeni_private.session_wait_rewrite_pack(pack.manifest)
WHERE pack.manifest IS DISTINCT FROM
  opengeni_private.session_wait_rewrite_pack(pack.manifest);

UPDATE pack_installations installation
SET manifest_snapshot = migrated.manifest_snapshot,
    manifest_digest = migrated.manifest_digest
FROM session_wait_pack_snapshot_cutover migrated
WHERE installation.id = migrated.id;

DO $session_wait_selection_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessions session
    WHERE session.first_party_mcp_tools @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.settings #> '{sessionToolDefaults,firstPartyMcpTools}'
      @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM new_session_drafts draft
    WHERE draft.session_options -> 'firstPartyMcpTools'
      @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM automation_trigger_revisions revision
    WHERE revision.session_template -> 'firstPartyMcpTools'
      @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM automation_runs run
    WHERE run.accepted_execution #> '{sessionTemplate,firstPartyMcpTools}'
      @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM scheduled_tasks task
    WHERE task.agent_config IS DISTINCT FROM
      opengeni_private.session_wait_rewrite_scheduled_agent_config(
        task.agent_config
      )
  ) OR EXISTS (
    SELECT 1 FROM scheduled_task_runs run
    WHERE run.accepted_execution_snapshot -> 'resolvedFirstPartyMcpTools'
        @> '["goal_wait"]'::jsonb
      OR run.accepted_execution_snapshot
        #> '{targetSessionExecution,firstPartyMcpTools}'
        @> '["goal_wait"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM workspace_packs pack
    WHERE pack.manifest IS DISTINCT FROM
      opengeni_private.session_wait_rewrite_pack(pack.manifest)
  ) OR EXISTS (
    SELECT 1 FROM pack_installations installation
    WHERE installation.manifest_snapshot IS NOT NULL
      AND installation.manifest_snapshot IS DISTINCT FROM
        opengeni_private.session_wait_rewrite_pack(
          installation.manifest_snapshot
        )
  ) THEN
    RAISE EXCEPTION '0402 persisted first-party tool migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    WHERE task.agent_config IS DISTINCT FROM migrated.agent_config
      OR task.authority_revision IS DISTINCT FROM migrated.authority_revision
      OR task.execution_digest IS DISTINCT FROM scheduled_task_execution_digest(task)
  ) OR EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    JOIN scheduled_task_revision_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest IS DISTINCT FROM task.execution_digest
  ) OR EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    JOIN scheduled_task_personal_resource_authorities authority
      ON authority.task_id = migrated.id
     AND authority.task_authority_revision = migrated.authority_revision
    WHERE authority.execution_digest IS DISTINCT FROM task.execution_digest
  ) OR EXISTS (
    SELECT 1
    FROM session_wait_scheduled_task_cutover migrated
    JOIN scheduled_tasks task ON task.id = migrated.id
    JOIN scheduled_task_connection_authority_snapshots snapshot
      ON snapshot.task_id = migrated.id
     AND snapshot.task_authority_revision = migrated.authority_revision
    WHERE snapshot.execution_digest IS DISTINCT FROM task.execution_digest
      OR snapshot.canonical_snapshot ->> 'executionDigest' IS DISTINCT FROM
        task.execution_digest
      OR snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'),
        'sha256'
      )
  ) THEN
    RAISE EXCEPTION '0402 scheduled-task head migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_scheduled_snapshot_cutover migrated
    JOIN scheduled_task_runs run ON run.id = migrated.id
    WHERE run.accepted_execution_snapshot IS DISTINCT FROM
        migrated.accepted_execution_snapshot
      OR run.accepted_execution_digest IS DISTINCT FROM encode(
        digest(
          convert_to(migrated.accepted_execution_snapshot::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      )
  ) THEN
    RAISE EXCEPTION '0402 scheduled accepted-execution migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM session_wait_pack_snapshot_cutover migrated
    JOIN pack_installations installation ON installation.id = migrated.id
    WHERE installation.manifest_snapshot IS DISTINCT FROM migrated.manifest_snapshot
      OR installation.manifest_digest IS DISTINCT FROM migrated.manifest_digest
  ) THEN
    RAISE EXCEPTION '0402 Pack manifest migration did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$session_wait_selection_postcondition$;

-- The snapshot rewrite queues ordinary deferred row constraints. Prove them
-- before ALTER TABLE restores the production RLS posture.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "capability_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pack_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_packs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_connection_authority_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_revision_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "automation_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "automation_trigger_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "new_session_drafts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_goals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_input_wait_check" CHECK (
    (
      "input_wait_turn_id" IS NULL
      AND "input_wait_until" IS NULL
      AND "input_wait_reason" IS NULL
      AND "input_wait_set_at" IS NULL
    )
    OR (
      "input_wait_turn_id" IS NOT NULL
      AND "input_wait_until" IS NOT NULL
      AND "input_wait_reason" IS NOT NULL
      AND octet_length(btrim("input_wait_reason")) BETWEEN 1 AND 2048
      AND "input_wait_set_at" IS NOT NULL
    )
  );

COMMENT ON COLUMN "sessions"."input_wait_turn_id" IS
  'Exact turn that declared wait_for_input; current only while it remains the latest finished turn.';
COMMENT ON COLUMN "sessions"."input_wait_until" IS
  'Absolute timeout safety-wake deadline persisted from wait_for_input timeoutSeconds.';
COMMENT ON COLUMN "sessions"."input_wait_reason" IS
  'Bounded agent-declared reason for the session-level wait.';
COMMENT ON COLUMN "sessions"."input_wait_set_at" IS
  'Database time when the current wait_for_input obligation was recorded.';

ALTER TABLE "session_goals"
  DROP CONSTRAINT "session_goals_continuation_hold_check",
  DROP COLUMN "continuation_hold_turn_id",
  DROP COLUMN "continuation_hold_until",
  DROP COLUMN "continuation_hold_reason",
  DROP COLUMN "continuation_hold_set_at";

-- A wait operation belongs to the target session and logical turn, not to one
-- replaceable physical attempt. The receipt still retains the first attempt FK
-- for audit, while this partial identity makes a recovered attempt replay the
-- original deadline/result instead of stamping a second wait.
CREATE UNIQUE INDEX "session_command_receipts_wait_for_input_operation_uq"
  ON "session_command_receipts" (
    "workspace_id", "action", "target_session_id", "operation_key"
  )
  WHERE "action" = 'session.wait_for_input';

-- Terminal command settlement and wait timeouts are model-visible machine
-- inputs. Their discriminated payloads remain constrained exactly like every
-- other durable session system update.
ALTER TABLE "session_system_updates"
  DROP CONSTRAINT "system_updates_kind_check";

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "system_updates_kind_check" CHECK (
    "kind" IN (
      'scheduled_occurrence',
      'goal_continuation',
      'agent_message',
      'agent_steer_instruction',
      'session_wait_timeout',
      'background_command_result',
      'child_terminal_result',
      'media_generation_result',
      'child_requires_action',
      'child_requires_action_resolved',
      'child_paused',
      'child_waiting_capacity',
      'child_progress'
    )
  );

DO $session_input_wait_runtime_drain_after$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles',
    true
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0402 session input wait activation detected an application database session during cutover'
      USING ERRCODE = '55000';
  END IF;
END
$session_input_wait_runtime_drain_after$;

DROP FUNCTION opengeni_private.session_wait_rewrite_scheduled_execution(jsonb);
DROP FUNCTION opengeni_private.session_wait_rewrite_scheduled_agent_config(jsonb);
DROP FUNCTION opengeni_private.session_wait_rewrite_pack(jsonb);
DROP FUNCTION opengeni_private.session_wait_rewrite_automation_template(jsonb);
DROP FUNCTION opengeni_private.session_wait_translate_tool_array(jsonb);
DROP FUNCTION opengeni_private.session_wait_canonical_json(jsonb);
DROP COLLATION opengeni_private.session_wait_js_en_us;

RESET statement_timeout;
RESET lock_timeout;
