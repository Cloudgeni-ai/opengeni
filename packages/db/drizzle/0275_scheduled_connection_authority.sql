-- deployment-mode: maintenance
-- Freeze common-user Connection authority on scheduled-task revisions, admit
-- one immutable copy per stable occurrence, and bind that copy to the exact
-- logical turn before the existing exact-attempt provider-use boundary.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $scheduled_connection_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      '0275 scheduled connection authority requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$scheduled_connection_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turns IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_system_updates IN ACCESS EXCLUSIVE MODE;
LOCK TABLE scheduled_tasks IN ACCESS EXCLUSIVE MODE;
LOCK TABLE scheduled_task_runs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE connections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_user_resource_grants IN ACCESS EXCLUSIVE MODE;

-- Existing/warm target sessions retain their exact authority epoch even when
-- a workspace-shared personal-resource grant has mode=always. The grant itself
-- is not session-bound in that mode, but attempt admission still compares the
-- accepted task snapshot to the target session epoch.
ALTER TABLE scheduled_task_personal_resource_snapshots
  DROP CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fence_chk,
  ADD CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fence_chk CHECK (
    (
      grant_mode = 'always'
      AND grant_session_id IS NULL
      AND grant_authority_epoch IS NULL
    ) OR (
      grant_mode IN ('once', 'session')
      AND grant_session_id IS NOT NULL
      AND grant_authority_epoch = session_authority_epoch
    )
  );

ALTER TABLE opengeni_private.scheduled_personal_resource_capabilities
  DROP CONSTRAINT scheduled_personal_resource_capabilities_kind_chk,
  ADD CONSTRAINT scheduled_personal_resource_capabilities_kind_chk CHECK (
    capability_kind IN ('task_write', 'run_admit', 'attempt_match', 'run_lifecycle')
  );

-- Every agent-task authority revision carries one explicit human authorizer,
-- even when the selected Variable Set/Rig is organization- or workspace-owned
-- and therefore has no 0252 personal-resource snapshot. This is separate from
-- task creation provenance: a later authorized editor may own a later revision.
CREATE TABLE scheduled_task_revision_authorities (
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  task_authority_revision bigint NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL,
  organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  execution_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduled_task_revision_authorities_pk
    PRIMARY KEY (task_id, task_authority_revision),
  CONSTRAINT scheduled_task_revision_authorities_membership_fk
    FOREIGN KEY (organization_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_task_revision_authorities_shape_chk CHECK (
    task_authority_revision > 0
    AND membership_authorization_revision > 0
    AND octet_length(subject_id) BETWEEN 1 AND 4096
    AND execution_digest ~ '^[0-9a-f]{64}$'
  )
);
ALTER TABLE scheduled_task_revision_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revision_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_revision_authorities_workspace_isolation
  ON scheduled_task_revision_authorities
  USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  );

INSERT INTO scheduled_task_revision_authorities (
  task_id, task_authority_revision, account_id, workspace_id, subject_id,
  organization_membership_id, membership_authorization_revision, execution_digest
)
SELECT task.id, task.authority_revision, task.account_id, task.workspace_id,
  task.created_by_subject_id, membership.id, membership.authorization_revision,
  task.execution_digest
FROM scheduled_tasks task
JOIN organization_memberships membership
  ON membership.account_id = task.account_id
 AND membership.subject_id = task.created_by_subject_id
 AND membership.status = 'active'
 AND membership.revoked_at IS NULL
WHERE task.action ->> 'kind' = 'agent_turn'
  AND task.created_by_kind = 'subject';

-- Agent tasks written by non-human principals (delegated service tokens, API
-- keys, legacy unattributed writers) legitimately carry no human revision
-- authority: their occurrences run under the service initiator alone, and
-- workspace/organization Variable Sets and Rigs remain usable through ordinary
-- workspace authority exactly as before. Only a personal-resource task
-- (user-scoped Variable Set or Rig, personal-resource ledger, Connection, or
-- user-scoped xAI authority) needs an exact human, because that human is the
-- frozen causal subject every attempt revalidates. Such a task whose creator is
-- no longer an active organization member cannot be admitted after cutover, so
-- the operator must pause or re-authorize it before 0275 runs.
DO $scheduled_revision_authority_drain$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scheduled_tasks task
    WHERE task.action ->> 'kind' = 'agent_turn'
      AND task.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_task_revision_authorities authority
        WHERE authority.task_id = task.id
          AND authority.task_authority_revision = task.authority_revision
          AND authority.account_id = task.account_id
          AND authority.workspace_id = task.workspace_id
      )
      AND (
        EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = task.variable_set_id
            AND variable_set.account_id = task.account_id
            AND variable_set.authority_scope = 'user'
        )
        OR EXISTS (
          SELECT 1 FROM rigs rig
          WHERE rig.id = task.rig_id
            AND rig.account_id = task.account_id
            AND rig.authority_scope = 'user'
        )
        OR task.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
        OR EXISTS (
          SELECT 1 FROM scheduled_task_personal_resource_authorities authority
          WHERE authority.task_id = task.id
            AND authority.task_authority_revision = task.authority_revision
        )
      )
  ) THEN
    RAISE EXCEPTION
      '0275 requires every active personal-resource scheduled agent revision to have an exact human authorizer; pause or re-authorize those tasks first'
      USING ERRCODE = '55000';
  END IF;
END
$scheduled_revision_authority_drain$;

CREATE FUNCTION record_scheduled_task_revision_authority(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  subject_value text := nullif(btrim(
    current_setting('opengeni.initiating_human_subject_id', true)
  ), '');
  task_row record;
  membership_row record;
  resource_bearing boolean;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled revision authority scope mismatch'
    USING ERRCODE = '42501'; END IF;
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR SHARE;
  IF task_row.action ->> 'kind' <> 'agent_turn' THEN RETURN NULL; END IF;
  resource_bearing := EXISTS (
      SELECT 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = task_row.account_id
        AND variable_set.authority_scope = 'user'
    )
    OR EXISTS (
      SELECT 1 FROM rigs rig
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
        AND rig.authority_scope = 'user'
    )
    OR task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
    OR EXISTS (
      SELECT 1 FROM scheduled_task_personal_resource_authorities authority
      WHERE authority.task_id = task_row.id
        AND authority.task_authority_revision = task_row.authority_revision
    )
    OR EXISTS (
      SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
      WHERE snapshot.task_id = task_row.id
        AND snapshot.task_authority_revision = task_row.authority_revision
    );
  -- A service/API-key/delegated writer is not a managed human and cannot be a
  -- revision authorizer. That is allowed for a task that delegates no personal
  -- authority (workspace/organization Variable Sets and Rigs use ordinary
  -- workspace authority); a personal-resource task fails closed instead of
  -- running without a causal human.
  IF subject_value IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.subject_id = subject_value
  ) THEN
    IF resource_bearing THEN
      RAISE EXCEPTION
        'scheduled personal-resource agent task requires an exact human revision authorizer'
        USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;
  SELECT membership.* INTO membership_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = subject_value
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND (
      membership.personal_workspace_id = p_workspace_id
      OR EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = subject_value
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled revision authorizer lacks active workspace membership'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO scheduled_task_revision_authorities (
    task_id, task_authority_revision, account_id, workspace_id, subject_id,
    organization_membership_id, membership_authorization_revision, execution_digest
  ) VALUES (
    task_row.id, task_row.authority_revision, task_row.account_id,
    task_row.workspace_id, subject_value, membership_row.id,
    membership_row.authorization_revision, task_row.execution_digest
  );
  RETURN subject_value;
END
$body$;

CREATE FUNCTION clone_scheduled_task_revision_authority(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_source_revision bigint, p_target_revision bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE source_row record; target_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled revision authority clone scope mismatch'
    USING ERRCODE = '42501'; END IF;
  SELECT authority.* INTO source_row
  FROM scheduled_task_revision_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_source_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT task.* INTO STRICT target_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_target_revision
  FOR SHARE;
  INSERT INTO scheduled_task_revision_authorities (
    task_id, task_authority_revision, account_id, workspace_id, subject_id,
    organization_membership_id, membership_authorization_revision, execution_digest
  ) VALUES (
    target_row.id, target_row.authority_revision, target_row.account_id,
    target_row.workspace_id, source_row.subject_id,
    source_row.organization_membership_id,
    source_row.membership_authorization_revision, target_row.execution_digest
  );
  RETURN source_row.subject_id;
END
$body$;

CREATE FUNCTION scheduled_task_revision_authority_subject(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE subject_value text;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled revision authority read scope mismatch'
    USING ERRCODE = '42501'; END IF;
  SELECT authority.subject_id INTO subject_value
  FROM scheduled_task_revision_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_task_authority_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id;
  RETURN subject_value;
END
$body$;

CREATE FUNCTION scheduled_task_revision_authority_snapshot(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE authority_value jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled revision authority read scope mismatch'
    USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'subjectId', authority.subject_id,
    'organizationMembershipId', authority.organization_membership_id,
    'membershipAuthorizationRevision', authority.membership_authorization_revision
  ) INTO authority_value
  FROM scheduled_task_revision_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_task_authority_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id;
  RETURN authority_value;
END
$body$;

DO $scheduled_connection_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      '0275 scheduled connection authority requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$scheduled_connection_writer_drain_after_lock$;

-- Historical agent delivery used `dispatched` as its durable delivery state.
-- Promote only an exact, unambiguous terminal update/turn chain before the new
-- lifecycle constraint is installed. Anything else remains live/contradictory
-- and is rejected by the drain below rather than inferred from mutable task
-- state.
WITH terminal_evidence AS (
  SELECT
    run.id AS run_id,
    CASE
      WHEN turn_value.status = 'completed' THEN 'succeeded'
      WHEN turn_value.status = 'failed' OR update_row.state = 'failed' THEN 'failed'
      ELSE 'skipped'
    END AS terminal_status,
    CASE
      WHEN turn_value.status = 'completed' THEN NULL
      WHEN turn_value.status IS NOT NULL THEN 'scheduled_turn_' || turn_value.status
      ELSE 'scheduled_update_' || update_row.state
    END AS terminal_error,
    COALESCE(turn_value.finished_at, update_row.delivered_at, run.updated_at) AS terminal_at
  FROM scheduled_task_runs run
  JOIN session_system_updates update_row
    ON update_row.account_id = run.account_id
   AND update_row.workspace_id = run.workspace_id
   AND update_row.session_id = run.session_id
   AND update_row.scheduled_task_run_id = run.id
   AND update_row.kind = 'scheduled_occurrence'
   AND update_row.source_id = run.id::text
  LEFT JOIN session_turns turn_value
    ON turn_value.id = update_row.delivered_turn_id
   AND turn_value.account_id = run.account_id
   AND turn_value.workspace_id = run.workspace_id
   AND turn_value.session_id = run.session_id
  WHERE run.action_kind = 'agent_turn'
    AND run.status = 'dispatched'
    AND (
      (
        update_row.state = 'delivered'
        AND turn_value.status IN ('completed','failed','cancelled','superseded','withdrawn_for_edit')
      )
      OR (
        update_row.state IN ('cancelled','superseded','failed')
        AND update_row.delivered_turn_id IS NULL
      )
    )
), exact_terminal_evidence AS (
  SELECT
    run_id,
    min(terminal_status) AS terminal_status,
    min(terminal_error) AS terminal_error,
    min(terminal_at) AS terminal_at
  FROM terminal_evidence
  GROUP BY run_id
  HAVING count(*) = 1
)
UPDATE scheduled_task_runs run
SET status = evidence.terminal_status,
    error = evidence.terminal_error,
    completed_at = evidence.terminal_at,
    updated_at = clock_timestamp()
FROM exact_terminal_evidence evidence
WHERE run.id = evidence.run_id;

-- 0264 intentionally rejected activated scheduled work. A later rolling writer
-- must not have recreated it between that cutover and this one without the
-- revision/run protocol below.
DO $scheduled_connection_accepted_work_drain$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scheduled_task_runs run
    WHERE run.action_kind = 'agent_turn'
      AND run.status IN ('queued','dispatched')
  ) THEN
    RAISE EXCEPTION
      '0275 requires every nonterminal scheduled agent run to be drained'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM scheduled_tasks task
    CROSS JOIN LATERAL jsonb_array_elements(task.personal_connection_delegations) item
    WHERE task.status = 'active'
      AND item -> 'userDelegation' IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '0275 requires activated scheduled connection work to be paused and rewritten'
      USING ERRCODE = '55000';
  END IF;
END
$scheduled_connection_accepted_work_drain$;

ALTER TABLE session_turns ADD COLUMN scheduled_task_run_id uuid;
ALTER TABLE scheduled_tasks ADD COLUMN deleted_at timestamptz;
ALTER TABLE temporal_schedule_cleanup_outbox
  ADD COLUMN scheduled_task_id uuid,
  ADD COLUMN connector_cleanup_subject_id text,
  ADD COLUMN connector_cleanup_snapshot jsonb,
  ADD COLUMN connector_cleanup_completed_at timestamptz,
  DROP CONSTRAINT temporal_schedule_cleanup_outbox_valid_chk,
  ADD CONSTRAINT temporal_schedule_cleanup_outbox_valid_chk CHECK (
    length(temporal_schedule_id) BETWEEN 1 AND 512
    AND attempt_count >= 0
    AND ((claim_id IS NULL AND claim_until IS NULL)
      OR (claim_id IS NOT NULL AND claim_until IS NOT NULL))
    AND ((scheduled_task_id IS NULL AND connector_cleanup_subject_id IS NULL
          AND connector_cleanup_snapshot IS NULL)
      OR (scheduled_task_id IS NOT NULL AND connector_cleanup_subject_id IS NOT NULL
          AND connector_cleanup_snapshot IS NOT NULL))
    AND (connector_cleanup_snapshot IS NOT NULL OR connector_cleanup_completed_at IS NULL)
    AND (connector_cleanup_subject_id IS NULL
      OR octet_length(connector_cleanup_subject_id) BETWEEN 1 AND 4096)
    AND (connector_cleanup_snapshot IS NULL OR (
      jsonb_typeof(connector_cleanup_snapshot) = 'object'
      AND connector_cleanup_snapshot ?& ARRAY[
        'version','taskId','accountId','workspaceId','connectorKind','connectionId',
        'connectionVersion','sourceId','sourceLifecycleGeneration',
        'sourceConfigGeneration','externalSourceId','subjectId'
      ]
      AND connector_cleanup_snapshot - ARRAY[
        'version','taskId','accountId','workspaceId','connectorKind','connectionId',
        'connectionVersion','sourceId','sourceLifecycleGeneration',
        'sourceConfigGeneration','externalSourceId','subjectId'
      ]::text[] = '{}'::jsonb
      AND jsonb_typeof(connector_cleanup_snapshot->'version') = 'number'
      AND jsonb_typeof(connector_cleanup_snapshot->'taskId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'accountId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'workspaceId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'connectorKind') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'connectionId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'connectionVersion') = 'number'
      AND jsonb_typeof(connector_cleanup_snapshot->'sourceId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'sourceLifecycleGeneration') = 'number'
      AND jsonb_typeof(connector_cleanup_snapshot->'sourceConfigGeneration') = 'number'
      AND jsonb_typeof(connector_cleanup_snapshot->'externalSourceId') = 'string'
      AND jsonb_typeof(connector_cleanup_snapshot->'subjectId') = 'string'
      AND connector_cleanup_snapshot->>'version' = '1'
      AND connector_cleanup_snapshot->>'connectorKind' IN ('google_drive','atlassian')
      AND connector_cleanup_snapshot->>'subjectId' = connector_cleanup_subject_id
      AND connector_cleanup_snapshot->>'taskId' = scheduled_task_id::text
      AND connector_cleanup_snapshot->>'accountId' = account_id::text
      AND connector_cleanup_snapshot->>'workspaceId' = workspace_id::text
      AND octet_length(connector_cleanup_snapshot->>'externalSourceId') BETWEEN 1 AND 2048
      AND octet_length(connector_cleanup_snapshot->>'subjectId') BETWEEN 1 AND 4096
      AND connector_cleanup_snapshot->>'taskId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND connector_cleanup_snapshot->>'accountId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND connector_cleanup_snapshot->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND connector_cleanup_snapshot->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND connector_cleanup_snapshot->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND connector_cleanup_snapshot->>'connectionVersion' ~ '^[1-9][0-9]*$'
      AND connector_cleanup_snapshot->>'sourceLifecycleGeneration' ~ '^[1-9][0-9]*$'
      AND connector_cleanup_snapshot->>'sourceConfigGeneration' ~ '^[1-9][0-9]*$'
      AND (connector_cleanup_snapshot->>'connectionVersion')::numeric <= 9007199254740991
      AND (connector_cleanup_snapshot->>'sourceLifecycleGeneration')::numeric <= 9007199254740991
      AND (connector_cleanup_snapshot->>'sourceConfigGeneration')::numeric <= 9007199254740991
    ))
    AND (last_error IS NULL OR length(last_error) <= 2000)
  );

DROP FUNCTION opengeni_private.claim_temporal_schedule_cleanups(uuid, integer, integer);
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_temporal_schedule_cleanups(
      p_claim_id uuid,
      p_limit integer,
      p_claim_seconds integer
    )
    RETURNS TABLE (
      id uuid,
      account_id uuid,
      workspace_id uuid,
      temporal_schedule_id text,
      scheduled_task_id uuid,
      connector_cleanup_subject_id text,
      connector_cleanup_snapshot jsonb,
      connector_cleanup_completed_at timestamptz,
      attempt_count integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_claim_id IS NULL THEN
        RAISE EXCEPTION 'temporal schedule cleanup claim id is required'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
        WITH due AS (
          SELECT cleanup.id
          FROM %1$I.temporal_schedule_cleanup_outbox cleanup
          WHERE cleanup.next_attempt_at <= pg_catalog.now()
            AND (cleanup.claim_until IS NULL OR cleanup.claim_until <= pg_catalog.now())
          ORDER BY cleanup.next_attempt_at, cleanup.created_at, cleanup.id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 32), 100))
        )
        UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
        SET claim_id = p_claim_id,
            claim_until = pg_catalog.now() + pg_catalog.make_interval(
              secs => greatest(5, least(coalesce(p_claim_seconds, 15), 300))
            ),
            attempt_count = cleanup.attempt_count + 1,
            updated_at = pg_catalog.now()
        FROM due
        WHERE cleanup.id = due.id
        RETURNING cleanup.id, cleanup.account_id, cleanup.workspace_id,
          cleanup.temporal_schedule_id, cleanup.scheduled_task_id,
          cleanup.connector_cleanup_subject_id, cleanup.connector_cleanup_snapshot,
          cleanup.connector_cleanup_completed_at, cleanup.attempt_count;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.claim_temporal_schedule_cleanups(uuid, integer, integer)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_temporal_schedule_cleanups(uuid, integer, integer)
      TO opengeni_app;
  END IF;
END $$;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.complete_temporal_schedule_connector_cleanup(
      p_id uuid,
      p_claim_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE completed_rows bigint := 0;
    BEGIN
      IF p_id IS NULL OR p_claim_id IS NULL THEN
        RAISE EXCEPTION 'temporal connector cleanup id and claim id are required'
          USING ERRCODE = '22023';
      END IF;
      UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
      SET connector_cleanup_completed_at = COALESCE(
            cleanup.connector_cleanup_completed_at,
            pg_catalog.clock_timestamp()
          ),
          updated_at = pg_catalog.clock_timestamp()
      WHERE cleanup.id = p_id
        AND cleanup.claim_id = p_claim_id
        AND cleanup.connector_cleanup_snapshot IS NOT NULL;
      GET DIAGNOSTICS completed_rows = ROW_COUNT;
      RETURN completed_rows = 1;
    END
    $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION
  opengeni_private.complete_temporal_schedule_connector_cleanup(uuid, uuid)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.complete_temporal_schedule_connector_cleanup(uuid, uuid)
      TO opengeni_app;
  END IF;
END $$;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.upgrade_temporal_schedule_connector_cleanup(
      p_account_id uuid,
      p_workspace_id uuid,
      p_temporal_schedule_id text,
      p_scheduled_task_id uuid,
      p_subject_id text,
      p_snapshot jsonb,
      p_claim_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE upgraded_rows bigint := 0;
    BEGIN
      IF p_account_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_temporal_schedule_id IS NULL
        OR p_scheduled_task_id IS NULL
        OR nullif(pg_catalog.btrim(p_subject_id), '') IS NULL
        OR p_snapshot IS NULL
        OR p_claim_id IS NULL
      THEN
        RAISE EXCEPTION 'temporal connector cleanup upgrade scope is invalid'
          USING ERRCODE = '42501';
      END IF;
      UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
      SET scheduled_task_id = p_scheduled_task_id,
          connector_cleanup_subject_id = p_subject_id,
          connector_cleanup_snapshot = p_snapshot,
          connector_cleanup_completed_at = pg_catalog.clock_timestamp(),
          claim_id = p_claim_id,
          claim_until = pg_catalog.now() + pg_catalog.make_interval(secs => 15),
          attempt_count = cleanup.attempt_count + 1,
          next_attempt_at = pg_catalog.now(),
          last_error = NULL,
          updated_at = pg_catalog.now()
      WHERE cleanup.account_id = p_account_id
        AND cleanup.workspace_id = p_workspace_id
        AND cleanup.temporal_schedule_id = p_temporal_schedule_id
        AND cleanup.connector_cleanup_snapshot IS NULL;
      GET DIAGNOSTICS upgraded_rows = ROW_COUNT;
      RETURN upgraded_rows = 1;
    END
    $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION
  opengeni_private.upgrade_temporal_schedule_connector_cleanup(
    uuid, uuid, text, uuid, text, jsonb, uuid
  ) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.upgrade_temporal_schedule_connector_cleanup(
        uuid, uuid, text, uuid, text, jsonb, uuid
      ) TO opengeni_app;
  END IF;
END $$;
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.complete_workspace_temporal_connector_cleanups(
      p_account_id uuid,
      p_workspace_id uuid
    ) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE completed_rows bigint := 0;
    BEGIN
      IF p_account_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
      THEN
        RAISE EXCEPTION 'workspace connector cleanup scope is invalid'
          USING ERRCODE = '42501';
      END IF;
      UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
      SET scheduled_task_id = NULL,
          connector_cleanup_subject_id = NULL,
          connector_cleanup_snapshot = NULL,
          connector_cleanup_completed_at = NULL,
          updated_at = pg_catalog.clock_timestamp()
      WHERE cleanup.account_id = p_account_id
        AND cleanup.workspace_id = p_workspace_id
        AND cleanup.connector_cleanup_snapshot IS NOT NULL;
      GET DIAGNOSTICS completed_rows = ROW_COUNT;
      RETURN completed_rows;
    END
    $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION
  opengeni_private.complete_workspace_temporal_connector_cleanups(uuid, uuid)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.complete_workspace_temporal_connector_cleanups(uuid, uuid)
      TO opengeni_app;
  END IF;
END $$;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_tombstone_chk
  CHECK (deleted_at IS NULL OR status = 'paused');
CREATE INDEX scheduled_tasks_live_workspace_created_idx
  ON scheduled_tasks(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX session_command_receipts_scheduled_goal_run_uq
  ON session_command_receipts(workspace_id, action, operation_key)
  WHERE action = 'scheduled.goal.reset';

ALTER TABLE scheduled_task_runs
  DROP CONSTRAINT scheduled_task_runs_task_id_fkey,
  ADD CONSTRAINT scheduled_task_runs_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT scheduled_task_runs_session_id_fkey,
  ADD CONSTRAINT scheduled_task_runs_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION scheduled_task_execution_state(
  p_task scheduled_tasks
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT pg_catalog.to_jsonb(p_task) - ARRAY[
    'name', 'status', 'deleted_at', 'updated_at', 'authority_revision', 'execution_digest'
  ]::text[]
$body$;

ALTER TABLE scheduled_task_runs
  ADD COLUMN accepted_execution_snapshot jsonb,
  ADD COLUMN accepted_execution_digest text,
  ADD CONSTRAINT scheduled_task_run_accepted_execution_shape_chk CHECK (
    (accepted_execution_snapshot IS NULL AND accepted_execution_digest IS NULL)
    OR (
      accepted_execution_snapshot IS NOT NULL
      AND accepted_execution_digest ~ '^[0-9a-f]{64}$'
      AND accepted_execution_digest = encode(
        digest(convert_to(accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex'
      )
    )
  ),
  ADD CONSTRAINT scheduled_task_run_accepted_execution_required_chk CHECK (
    action_kind <> 'agent_turn'
    OR status NOT IN ('queued', 'dispatched')
    OR accepted_execution_snapshot IS NOT NULL
  ) NOT VALID;

CREATE UNIQUE INDEX scheduled_task_runs_workspace_id_uq
  ON scheduled_task_runs(workspace_id, id);
ALTER TABLE session_system_updates ADD CONSTRAINT
  session_system_updates_scheduled_run_fk
  FOREIGN KEY (workspace_id, scheduled_task_run_id)
  REFERENCES scheduled_task_runs(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE session_turns ADD CONSTRAINT session_turns_scheduled_run_fk
  FOREIGN KEY (workspace_id, scheduled_task_run_id)
  REFERENCES scheduled_task_runs(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX session_turns_scheduled_task_run_idx
  ON session_turns(workspace_id, scheduled_task_run_id)
  WHERE scheduled_task_run_id IS NOT NULL;

CREATE TABLE scheduled_task_connection_authority_snapshots (
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  task_authority_revision bigint NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  execution_digest text NOT NULL,
  server_id text NOT NULL,
  connection_id uuid NOT NULL,
  connection_generation bigint NOT NULL,
  origin_workspace_id uuid NOT NULL,
  provider_domain text NOT NULL,
  connection_kind text NOT NULL,
  selected_kind text,
  connection_type text,
  owner_subject_id text NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  grant_id uuid NOT NULL,
  grant_generation bigint NOT NULL,
  grant_mode text NOT NULL,
  grant_context text NOT NULL,
  grant_session_id uuid,
  grant_authority_epoch integer,
  target_session_id uuid,
  session_visibility text NOT NULL,
  session_authority_epoch integer,
  selection_sources text[] NOT NULL,
  canonical_snapshot jsonb NOT NULL,
  snapshot_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, task_authority_revision, server_id),
  FOREIGN KEY (owner_organization_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (authority_id, account_id)
    REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (grant_id, account_id)
    REFERENCES organization_user_resource_grants(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_task_connection_authority_shape_chk CHECK (
    task_authority_revision > 0
    AND execution_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(server_id) BETWEEN 1 AND 256
    AND connection_generation > 0
    AND (selected_kind IS NULL OR selected_kind IN ('oauth2','api_key','app_install','delegated'))
    AND (connection_type IS NULL OR connection_type = 'mcp')
    AND membership_authorization_revision > 0
    AND authority_generation > 0
    AND grant_generation > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND grant_context IN ('user_private', 'workspace_shared')
    AND grant_context = session_visibility
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND cardinality(selection_sources) > 0
  ),
  CONSTRAINT scheduled_task_connection_authority_session_chk CHECK (
    (target_session_id IS NULL AND session_authority_epoch IS NULL
      AND grant_mode = 'always' AND grant_session_id IS NULL
      AND grant_authority_epoch IS NULL AND session_visibility = 'workspace_shared')
    OR
    (target_session_id IS NOT NULL AND session_authority_epoch > 0 AND (
      (grant_mode IN ('once', 'session')
        AND grant_session_id = target_session_id
        AND grant_authority_epoch = session_authority_epoch)
      OR (grant_mode = 'always' AND grant_session_id IS NULL
        AND grant_authority_epoch IS NULL)
    ))
  )
);

CREATE TABLE scheduled_task_run_connection_authority_snapshots (
  run_id uuid NOT NULL REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  task_authority_revision bigint NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  execution_digest text NOT NULL,
  server_id text NOT NULL,
  connection_id uuid NOT NULL,
  connection_generation bigint NOT NULL,
  origin_workspace_id uuid NOT NULL,
  provider_domain text NOT NULL,
  connection_kind text NOT NULL,
  selected_kind text,
  connection_type text,
  owner_subject_id text NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  grant_id uuid NOT NULL,
  grant_generation bigint NOT NULL,
  grant_mode text NOT NULL,
  grant_context text NOT NULL,
  grant_session_id uuid,
  grant_authority_epoch integer,
  target_session_id uuid,
  session_visibility text NOT NULL,
  session_authority_epoch integer,
  selection_sources text[] NOT NULL,
  canonical_snapshot jsonb NOT NULL,
  snapshot_digest bytea NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_at timestamptz,
  PRIMARY KEY (run_id, server_id),
  FOREIGN KEY (owner_organization_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (authority_id, account_id)
    REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (grant_id, account_id)
    REFERENCES organization_user_resource_grants(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_run_connection_authority_shape_chk CHECK (
    task_authority_revision > 0
    AND execution_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(server_id) BETWEEN 1 AND 256
    AND connection_generation > 0
    AND (selected_kind IS NULL OR selected_kind IN ('oauth2','api_key','app_install','delegated'))
    AND (connection_type IS NULL OR connection_type = 'mcp')
    AND membership_authorization_revision > 0
    AND authority_generation > 0
    AND grant_generation > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND grant_context IN ('user_private', 'workspace_shared')
    AND grant_context = session_visibility
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND cardinality(selection_sources) > 0
  )
);

CREATE TABLE scheduled_task_reusable_connection_materializations (
  task_id uuid NOT NULL,
  run_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source_task_authority_revision bigint NOT NULL,
  target_task_authority_revision bigint NOT NULL,
  source_execution_digest text NOT NULL,
  target_execution_digest text NOT NULL,
  materialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduled_reusable_connection_revision_chk CHECK (
    source_task_authority_revision > 0
    AND target_task_authority_revision IN (
      source_task_authority_revision,
      source_task_authority_revision + 1
    )
    AND source_execution_digest ~ '^[0-9a-f]{64}$'
    AND target_execution_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT scheduled_reusable_connection_source_uq UNIQUE (
    task_id, source_task_authority_revision, source_execution_digest
  ),
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX scheduled_reusable_connection_task_idx
  ON scheduled_task_reusable_connection_materializations(task_id, materialized_at DESC);

CREATE INDEX scheduled_task_connection_authority_grant_idx
  ON scheduled_task_connection_authority_snapshots(account_id, grant_id, task_id);
CREATE INDEX scheduled_run_connection_authority_grant_idx
  ON scheduled_task_run_connection_authority_snapshots(account_id, grant_id, run_id);

ALTER TABLE scheduled_task_connection_authority_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_connection_authority_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_run_connection_authority_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_run_connection_authority_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_reusable_connection_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_reusable_connection_materializations FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_isolation ON scheduled_task_connection_authority_snapshots
  USING (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid);
CREATE POLICY organization_isolation ON scheduled_task_run_connection_authority_snapshots
  USING (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid);
CREATE POLICY organization_isolation ON scheduled_task_reusable_connection_materializations
  USING (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid);
-- Every direct session reference carries the restrictive visibility policy so a
-- receipt can never expose or accept a session the caller cannot see.
CREATE POLICY session_visibility_isolation ON scheduled_task_reusable_connection_materializations
  AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

CREATE FUNCTION freeze_scheduled_task_connection_authorities_inner(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  task_row record;
  session_row record;
  item jsonb;
  delegation jsonb;
  connection_row record;
  membership_row record;
  authority_row record;
  grant_row record;
  initiating_subject text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id', true)), ''),
    nullif(btrim(current_setting('opengeni.subject_id', true)), '')
  );
  target_session uuid;
  target_visibility text := 'workspace_shared';
  target_epoch integer;
  canonical jsonb;
  frozen_count integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'scheduled connection task scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
  WHERE task.id = p_task_id AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(task_row.personal_connection_delegations) selected
    WHERE selected -> 'userDelegation' IS NOT NULL
  ) THEN RETURN 0;
  END IF;
  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION 'scheduled connection authority requires a causal human'
      USING ERRCODE = '42501';
  END IF;

  IF task_row.run_mode = 'existing_session'
    OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
  THEN
    target_session := task_row.reusable_session_id;
    SELECT session_value.* INTO STRICT session_row FROM sessions session_value
    WHERE session_value.id = target_session AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    target_visibility := session_row.visibility;
    target_epoch := session_row.authority_epoch;
  ELSIF task_row.run_mode NOT IN ('new_session_per_run', 'reusable_session') THEN
    RAISE EXCEPTION 'scheduled connection run mode is invalid' USING ERRCODE = '22023';
  END IF;

  -- Canonical task-authority lock suffix. Never inherit JSON/server ordering:
  -- different tasks may name the same grants under different server ids.
  PERFORM 1
  FROM organization_memberships membership
  JOIN connections connection_value
    ON connection_value.owner_organization_membership_id = membership.id
   AND connection_value.account_id = membership.account_id
  JOIN LATERAL jsonb_array_elements(task_row.personal_connection_delegations)
    AS selected(value) ON true
  WHERE selected.value -> 'userDelegation' IS NOT NULL
    AND connection_value.id = (selected.value ->> 'connectionId')::uuid
    AND connection_value.account_id = p_account_id
  ORDER BY membership.id
  FOR SHARE OF membership;
  PERFORM 1
  FROM connections connection_value
  JOIN LATERAL jsonb_array_elements(task_row.personal_connection_delegations)
    AS selected(value) ON true
  WHERE selected.value -> 'userDelegation' IS NOT NULL
    AND connection_value.id = (selected.value ->> 'connectionId')::uuid
    AND connection_value.account_id = p_account_id
  ORDER BY connection_value.id
  FOR SHARE OF connection_value;
  PERFORM 1
  FROM organization_user_resource_authorities authority
  JOIN LATERAL jsonb_array_elements(task_row.personal_connection_delegations)
    AS selected(value) ON true
  WHERE selected.value -> 'userDelegation' IS NOT NULL
    AND authority.id = (selected.value -> 'userDelegation' ->> 'authorityId')::uuid
    AND authority.account_id = p_account_id
  ORDER BY authority.id
  FOR SHARE OF authority;
  PERFORM 1
  FROM organization_user_resource_grants grant_value
  JOIN LATERAL jsonb_array_elements(task_row.personal_connection_delegations)
    AS selected(value) ON true
  WHERE selected.value -> 'userDelegation' IS NOT NULL
    AND grant_value.id = (selected.value -> 'userDelegation' ->> 'grantId')::uuid
    AND grant_value.account_id = p_account_id
  ORDER BY grant_value.id
  FOR SHARE OF grant_value;

  FOR item IN
    SELECT value FROM jsonb_array_elements(task_row.personal_connection_delegations)
    WHERE value -> 'userDelegation' IS NOT NULL
    ORDER BY value ->> 'serverId'
  LOOP
    IF (item ->> 'connectionType') IN ('social', 'atlassian') THEN
      RAISE EXCEPTION 'provider-specific scheduled connection authority is not activated'
        USING ERRCODE = '42501';
    END IF;
    delegation := item -> 'userDelegation';
    IF nullif(item ->> 'serverId', '') IS NULL
      OR octet_length(item ->> 'serverId') > 256
      OR item ->> 'ownerSubjectId' IS DISTINCT FROM initiating_subject
    THEN RAISE EXCEPTION 'scheduled connection selection is invalid' USING ERRCODE = '42501';
    END IF;

    SELECT connection_value.* INTO STRICT connection_row FROM connections connection_value
    WHERE connection_value.id = (item ->> 'connectionId')::uuid
      AND connection_value.account_id = p_account_id
    FOR SHARE;
    IF connection_row.authority_scope <> 'user'
      OR connection_row.status <> 'active'
      OR connection_row.subject_id IS DISTINCT FROM initiating_subject
      OR connection_row.origin_workspace_id IS DISTINCT FROM nullif(item ->> 'originWorkspaceId', '')::uuid
      OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(item ->> 'providerDomain')
      OR (item ? 'kind' AND connection_row.kind IS DISTINCT FROM item ->> 'kind')
    THEN RAISE EXCEPTION 'scheduled connection identity is unavailable' USING ERRCODE = '42501';
    END IF;

    SELECT membership.* INTO STRICT membership_row FROM organization_memberships membership
    WHERE membership.id = connection_row.owner_organization_membership_id
      AND membership.account_id = p_account_id
      AND membership.subject_id = initiating_subject
      AND membership.status = 'active' AND membership.revoked_at IS NULL
    FOR SHARE;
    IF membership_row.personal_workspace_id IS DISTINCT FROM p_workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = initiating_subject
      )
    THEN RAISE EXCEPTION 'scheduled connection owner lacks target workspace access'
      USING ERRCODE = '42501';
    END IF;

    SELECT authority.* INTO STRICT authority_row
    FROM organization_user_resource_authorities authority
    WHERE authority.id = (delegation ->> 'authorityId')::uuid
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = membership_row.id
      AND authority.resource_kind = 'connection'
      AND authority.resource_id = connection_row.id
      AND authority.origin_workspace_id = connection_row.origin_workspace_id
      AND authority.generation = (delegation ->> 'authorityGeneration')::bigint
      AND authority.status = 'active' AND authority.revoked_at IS NULL
    FOR SHARE;

    SELECT grant_value.* INTO STRICT grant_row
    FROM organization_user_resource_grants grant_value
    WHERE grant_value.id = (delegation ->> 'grantId')::uuid
      AND grant_value.account_id = p_account_id
      AND grant_value.authority_id = authority_row.id
      AND grant_value.owner_organization_membership_id = membership_row.id
      AND grant_value.workspace_id = p_workspace_id
      AND grant_value.action = 'connection.use'
      AND grant_value.mode = delegation ->> 'mode'
      AND grant_value.context = target_visibility
      AND grant_value.generation = (delegation ->> 'grantGeneration')::bigint
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND (
        (target_session IS NULL AND grant_value.mode = 'always'
          AND grant_value.context = 'workspace_shared'
          AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        OR (target_session IS NOT NULL AND (
          (grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = target_session
            AND grant_value.authority_epoch = target_epoch)
          OR (grant_value.mode = 'always'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        ))
      )
    FOR SHARE;

    IF delegation ->> 'organizationId' IS DISTINCT FROM p_account_id::text
      OR delegation ->> 'workspaceId' IS DISTINCT FROM p_workspace_id::text
      OR delegation ->> 'action' IS DISTINCT FROM 'connection.use'
      OR delegation ->> 'context' IS DISTINCT FROM target_visibility
      OR nullif(delegation ->> 'sessionId', '')::uuid IS DISTINCT FROM grant_row.session_id
      OR nullif(delegation ->> 'authorityEpoch', '')::integer
        IS DISTINCT FROM grant_row.authority_epoch
    THEN RAISE EXCEPTION 'scheduled connection grant metadata is contradictory'
      USING ERRCODE = '42501';
    END IF;

    canonical := jsonb_build_object(
      'organizationId', p_account_id, 'targetWorkspaceId', p_workspace_id,
      'taskId', p_task_id, 'taskAuthorityRevision', p_task_authority_revision,
      'executionDigest', task_row.execution_digest,
      'serverId', item ->> 'serverId', 'connectionId', connection_row.id,
      'connectionGeneration', connection_row.authority_generation,
      'originWorkspaceId', connection_row.origin_workspace_id,
      'providerDomain', lower(connection_row.provider_domain),
      'connectionKind', connection_row.kind,
      'selectedKind', item -> 'kind',
      'connectionType', item -> 'connectionType', 'scope', 'user',
      'ownerSubjectId', initiating_subject,
      'ownerOrganizationMembershipId', membership_row.id,
      'ownerMembershipAuthorizationRevision', membership_row.authorization_revision,
      'authorityId', authority_row.id, 'authorityGeneration', authority_row.generation,
      'grantId', grant_row.id, 'grantGeneration', grant_row.generation,
      'grantMode', grant_row.mode, 'grantContext', grant_row.context,
      'grantSessionId', grant_row.session_id,
      'grantAuthorityEpoch', grant_row.authority_epoch,
      'targetSessionId', target_session, 'sessionVisibility', target_visibility,
      'sessionAuthorityEpoch', target_epoch,
      'selectionSources', jsonb_build_array('mcp:' || (item ->> 'serverId'))
    );

    INSERT INTO scheduled_task_connection_authority_snapshots (
      task_id, task_authority_revision, account_id, workspace_id, execution_digest,
      server_id, connection_id, connection_generation, origin_workspace_id,
      provider_domain, connection_kind, selected_kind, connection_type, owner_subject_id,
      owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, grant_id, grant_generation,
      grant_mode, grant_context, grant_session_id, grant_authority_epoch,
      target_session_id, session_visibility, session_authority_epoch,
      selection_sources, canonical_snapshot, snapshot_digest
    ) VALUES (
      p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
      task_row.execution_digest, item ->> 'serverId', connection_row.id,
      connection_row.authority_generation, connection_row.origin_workspace_id,
      lower(connection_row.provider_domain), connection_row.kind,
      item ->> 'kind', item ->> 'connectionType', initiating_subject,
      membership_row.id, membership_row.authorization_revision, authority_row.id,
      authority_row.generation, grant_row.id, grant_row.generation, grant_row.mode,
      grant_row.context, grant_row.session_id, grant_row.authority_epoch,
      target_session, target_visibility, target_epoch,
      ARRAY['mcp:' || (item ->> 'serverId')], canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256')
    );
    frozen_count := frozen_count + 1;
  END LOOP;
  RETURN frozen_count;
END
$body$;


CREATE FUNCTION clone_scheduled_task_connection_authorities_inner(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_source_revision bigint, p_target_revision bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  task_row record;
  session_row record;
  source_row record;
  target_session uuid;
  target_visibility text;
  target_epoch integer;
  canonical jsonb;
  copied integer := 0;
  selected_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_target_revision <= p_source_revision
  THEN RAISE EXCEPTION 'scheduled connection clone scope or revision mismatch'
    USING ERRCODE = '42501';
  END IF;
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
  WHERE task.id = p_task_id AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id AND task.authority_revision = p_target_revision
  FOR UPDATE;
  FOR source_row IN SELECT snapshot.*
    FROM scheduled_task_connection_authority_snapshots snapshot
    WHERE snapshot.task_id = p_task_id
      AND snapshot.task_authority_revision = p_source_revision
    ORDER BY snapshot.server_id
  LOOP
    target_session := NULL;
    target_visibility := 'workspace_shared';
    target_epoch := NULL;
    IF task_row.run_mode = 'existing_session'
      OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
    THEN
      target_session := task_row.reusable_session_id;
      SELECT session_value.* INTO STRICT session_row FROM sessions session_value
      WHERE session_value.id = target_session AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id AND session_value.status <> 'cancelled'
      FOR SHARE;
      target_visibility := session_row.visibility;
      target_epoch := session_row.authority_epoch;
      IF source_row.grant_context IS DISTINCT FROM target_visibility THEN
        RAISE EXCEPTION 'scheduled connection clone visibility changed'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF source_row.grant_mode <> 'always'
        OR source_row.grant_context <> 'workspace_shared'
        OR source_row.grant_session_id IS NOT NULL
        OR source_row.grant_authority_epoch IS NOT NULL
      THEN
        RAISE EXCEPTION 'scheduled connection clone cannot unbind a bounded grant'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF source_row.grant_mode IN ('once', 'session') AND (
      source_row.grant_session_id IS DISTINCT FROM target_session
      OR source_row.grant_authority_epoch IS DISTINCT FROM target_epoch
    ) THEN
      RAISE EXCEPTION 'scheduled connection clone cannot retarget a bounded grant'
        USING ERRCODE = '42501';
    END IF;
    canonical := source_row.canonical_snapshot || jsonb_build_object(
      'taskAuthorityRevision', p_target_revision,
      'executionDigest', task_row.execution_digest,
      'targetSessionId', target_session,
      'sessionVisibility', target_visibility,
      'sessionAuthorityEpoch', target_epoch
    );
    INSERT INTO scheduled_task_connection_authority_snapshots
    SELECT p_task_id, p_target_revision, source_row.account_id, source_row.workspace_id,
      task_row.execution_digest, source_row.server_id, source_row.connection_id,
      source_row.connection_generation, source_row.origin_workspace_id,
      source_row.provider_domain, source_row.connection_kind, source_row.selected_kind,
      source_row.connection_type, source_row.owner_subject_id,
      source_row.owner_organization_membership_id,
      source_row.membership_authorization_revision, source_row.authority_id,
      source_row.authority_generation, source_row.grant_id, source_row.grant_generation,
      source_row.grant_mode, source_row.grant_context, source_row.grant_session_id,
      source_row.grant_authority_epoch, target_session, target_visibility, target_epoch,
      source_row.selection_sources, canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256'), clock_timestamp();
    copied := copied + 1;
  END LOOP;
  SELECT count(*)::integer INTO selected_count
  FROM jsonb_array_elements(task_row.personal_connection_delegations) selected
  WHERE selected -> 'userDelegation' IS NOT NULL;
  IF copied <> selected_count OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(task_row.personal_connection_delegations) selected
    WHERE selected -> 'userDelegation' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
        WHERE snapshot.task_id = p_task_id
          AND snapshot.task_authority_revision = p_target_revision
          AND snapshot.server_id = selected ->> 'serverId'
          AND snapshot.connection_id = (selected ->> 'connectionId')::uuid
          AND snapshot.owner_subject_id = selected ->> 'ownerSubjectId'
          AND snapshot.origin_workspace_id = (selected ->> 'originWorkspaceId')::uuid
          AND snapshot.provider_domain = lower(selected ->> 'providerDomain')
          AND (selected ? 'kind') = (snapshot.selected_kind IS NOT NULL)
          AND selected ->> 'kind' IS NOT DISTINCT FROM snapshot.selected_kind
          AND (selected ? 'connectionType') = (snapshot.connection_type IS NOT NULL)
          AND selected ->> 'connectionType' IS NOT DISTINCT FROM snapshot.connection_type
          AND snapshot.authority_id =
            (selected -> 'userDelegation' ->> 'authorityId')::uuid
          AND snapshot.grant_id = (selected -> 'userDelegation' ->> 'grantId')::uuid
          AND selected -> 'userDelegation' ->> 'organizationId' = snapshot.account_id::text
          AND selected -> 'userDelegation' ->> 'workspaceId' = snapshot.workspace_id::text
          AND selected -> 'userDelegation' ->> 'action' = 'connection.use'
          AND selected -> 'userDelegation' ->> 'mode' = snapshot.grant_mode
          AND selected -> 'userDelegation' ->> 'context' = snapshot.grant_context
          AND nullif(selected -> 'userDelegation' ->> 'sessionId', '')::uuid
            IS NOT DISTINCT FROM snapshot.grant_session_id
          AND nullif(selected -> 'userDelegation' ->> 'authorityEpoch', '')::integer
            IS NOT DISTINCT FROM snapshot.grant_authority_epoch
          AND (selected -> 'userDelegation' ->> 'authorityGeneration')::bigint
            = snapshot.authority_generation
          AND (selected -> 'userDelegation' ->> 'grantGeneration')::bigint
            = snapshot.grant_generation
          AND NOT ((selected -> 'userDelegation') ? 'resourceVersionId')
      )
  ) THEN
    RAISE EXCEPTION 'scheduled connection clone source is incomplete'
      USING ERRCODE = '42501';
  END IF;
  RETURN copied;
END
$body$;

-- Preserve the established 0252 ABI. Every caller now advances both resource
-- classes in the same transaction, while the legacy return value remains the
-- Variable Set/Rig count expected by 0252 materialization.
ALTER FUNCTION freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint)
  RENAME TO freeze_scheduled_task_personal_resources_0252;
ALTER FUNCTION clone_scheduled_task_personal_resource_authority(uuid, uuid, uuid, bigint, bigint)
  RENAME TO clone_scheduled_task_personal_resource_authority_0252;
ALTER FUNCTION materialize_scheduled_task_reusable_session_from_run(
  uuid, uuid, uuid, uuid, uuid, bigint, text
) RENAME TO materialize_scheduled_task_reusable_session_from_run_0252;

-- 0253 originally froze the currently active Rig version even for an
-- existing/warm target session. Replace the renamed implementation during
-- this drained migration so target modes retain the session's exact Rig
-- version/defaults while generated/cold modes continue to freeze active heads.
CREATE OR REPLACE FUNCTION freeze_scheduled_task_personal_resources_0252(
  p_account_id uuid,
  p_workspace_id uuid,
  p_task_id uuid,
  p_task_authority_revision bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $freeze_scheduled_task_personal_resources$
DECLARE
  task_row record;
  member_row record;
  session_row record;
  resource_row record;
  grant_row record;
  initiating_subject text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id', true)), ''),
    nullif(btrim(current_setting('opengeni.subject_id', true)), '')
  );
  target_session uuid;
  target_visibility text := 'workspace_shared';
  target_epoch integer;
  target_rig_version_id uuid;
  resource_total integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled personal-resource task scope mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR UPDATE;

  IF task_row.run_mode = 'existing_session'
    OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
  THEN
    target_session := task_row.reusable_session_id;
    SELECT session_value.* INTO STRICT session_row
    FROM sessions session_value
    WHERE session_value.id = target_session
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    target_visibility := session_row.visibility;
    target_epoch := session_row.authority_epoch;
    target_rig_version_id := session_row.rig_version_id;
  END IF;

  SELECT count(*)::integer INTO resource_total
  FROM (
    SELECT variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = task_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'
    UNION
    SELECT rig.id
    FROM rigs rig
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
      AND rig.authority_scope = 'user'
    UNION
    SELECT default_variable_set.id
    FROM rigs rig
    JOIN rig_versions rig_version
      ON rig_version.rig_id = rig.id
     AND rig_version.account_id = rig.account_id
     AND (
       (target_session IS NULL AND rig_version.active)
       OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
     )
    CROSS JOIN LATERAL jsonb_array_elements_text(
      rig_version.default_variable_set_ids
    ) default_id(value)
    JOIN workspace_variable_sets default_variable_set
      ON default_variable_set.id = default_id.value::uuid
     AND default_variable_set.account_id = p_account_id
     AND default_variable_set.authority_scope = 'user'
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
  ) selected;

  IF resource_total = 0 THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION 'scheduled personal resources require a causal human'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = initiating_subject
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'scheduled personal-resource owner lacks workspace access'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
    initiating_subject, member_row.id, member_row.authorization_revision,
    target_session, target_visibility, target_epoch, task_row.execution_digest,
    resource_total
  );

  FOR resource_row IN
    WITH selected AS (
      SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id,
        NULL::uuid AS resource_version_id, 'variable_set.use'::text AS action,
        'session_variable_set'::text AS selection_source,
        variable_set.workspace_id AS resource_workspace_id, variable_set.authority_id,
        variable_set.owner_organization_membership_id, variable_set.origin_workspace_id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.authority_scope = 'user'
      UNION ALL
      SELECT 'rig'::text, rig.id, rig_version.id, 'rig.use'::text,
        'session_rig'::text, rig.workspace_id, rig.authority_id,
        rig.owner_organization_membership_id, rig.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND (
         (target_session IS NULL AND rig_version.active)
         OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
       )
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
        AND rig.authority_scope = 'user'
      UNION ALL
      SELECT 'variable_set'::text, default_variable_set.id, NULL::uuid,
        'variable_set.use'::text,
        ('rig_default_variable_set:' || default_id.ordinality::text)::text,
        default_variable_set.workspace_id, default_variable_set.authority_id,
        default_variable_set.owner_organization_membership_id,
        default_variable_set.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND (
         (target_session IS NULL AND rig_version.active)
         OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
       )
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) WITH ORDINALITY default_id(value, ordinality)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = p_account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
    )
    SELECT resource_kind, resource_id, min(resource_version_id::text)::uuid resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) selection_sources,
      min(resource_workspace_id::text)::uuid resource_workspace_id,
      min(authority_id::text)::uuid authority_id,
      min(owner_organization_membership_id::text)::uuid owner_organization_membership_id,
      min(origin_workspace_id::text)::uuid origin_workspace_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
    ORDER BY resource_kind, resource_id
  LOOP
    IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
    THEN
      RAISE EXCEPTION 'scheduled personal resource belongs to another human or organization'
        USING ERRCODE = '42501';
    END IF;

    SELECT grant_value.* INTO grant_row
    FROM organization_user_resource_grants grant_value
    JOIN organization_user_resource_authorities authority
      ON authority.id = grant_value.authority_id
     AND authority.account_id = grant_value.account_id
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
      AND grant_value.owner_organization_membership_id = member_row.id
      AND grant_value.workspace_id = p_workspace_id
      AND grant_value.action = resource_row.action
      AND grant_value.context = target_visibility
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND (
        (target_session IS NULL AND grant_value.mode = 'always'
          AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        OR (target_session IS NOT NULL AND (
          (grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = target_session
            AND grant_value.authority_epoch = target_epoch)
          OR (grant_value.mode = 'always'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        ))
      )
    ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
      grant_value.generation DESC, grant_value.id
    LIMIT 1
    FOR SHARE OF authority, grant_value;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching scheduled personal-resource grant required'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO scheduled_task_personal_resource_snapshots (
      task_id, task_authority_revision, account_id, workspace_id,
      resource_kind, resource_id, resource_version_id, selection_sources, action,
      origin_workspace_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      target_workspace_id, session_visibility, session_authority_epoch,
      grant_id, grant_generation, grant_mode, grant_context,
      grant_session_id, grant_authority_epoch
    )
    SELECT p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources, resource_row.action,
      resource_row.origin_workspace_id, member_row.id, member_row.authorization_revision,
      authority.id, authority.generation, p_workspace_id, target_visibility, target_epoch,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN resource_total;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$freeze_scheduled_task_personal_resources$;


CREATE FUNCTION freeze_scheduled_task_personal_resources(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE resource_count integer;
BEGIN
  PERFORM freeze_scheduled_task_connection_authorities_inner(
    p_account_id, p_workspace_id, p_task_id, p_revision
  );
  SELECT freeze_scheduled_task_personal_resources_0252(
    p_account_id, p_workspace_id, p_task_id, p_revision
  ) INTO resource_count;
  RETURN resource_count;
END
$body$;

CREATE FUNCTION clone_scheduled_task_personal_resource_authority(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_source_revision bigint, p_target_revision bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE resource_count integer;
BEGIN
  PERFORM clone_scheduled_task_connection_authorities_inner(
    p_account_id, p_workspace_id, p_task_id, p_source_revision, p_target_revision
  );
  SELECT clone_scheduled_task_personal_resource_authority_0252(
    p_account_id, p_workspace_id, p_task_id, p_source_revision, p_target_revision
  ) INTO resource_count;
  RETURN resource_count;
END
$body$;

-- Ordinary task edits still refresh mutable Variable Set/Rig authority, but
-- omitted connectionAuthorities preserves the exact prior immutable
-- Connection snapshot instead of reconstructing it from today's grant head.
CREATE FUNCTION refresh_scheduled_task_personal_resources_clone_connections(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_source_revision bigint, p_target_revision bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE resource_count integer;
BEGIN
  PERFORM clone_scheduled_task_connection_authorities_inner(
    p_account_id, p_workspace_id, p_task_id, p_source_revision, p_target_revision
  );
  SELECT freeze_scheduled_task_personal_resources_0252(
    p_account_id, p_workspace_id, p_task_id, p_target_revision
  ) INTO resource_count;
  RETURN resource_count;
END
$body$;

CREATE FUNCTION admit_scheduled_agent_run_execution()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  task_row record;
  target_row record;
  latest_started record;
  task_snapshot jsonb;
  target_snapshot jsonb;
  expected_target_session_id uuid;
  connection_subject text;
  connection_subject_count integer;
  personal_resource_subject text;
  personal_resource_subject_count integer;
  revision_authority_subject text;
  revision_authority_membership_id uuid;
  revision_authority_membership_revision bigint;
  accepted_causal_subject text;
  generated_variable_set record;
  generated_rig record;
  generated_rig_version record;
  expected_rig_default_variable_sets jsonb;
  generated_slack record;
  workspace_settings jsonb;
  deployment_depth record;
  expected_depth integer;
  expected_depth_source text;
  expected_compaction_mode text;
BEGIN
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = NEW.task_id
    AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR UPDATE;
  IF task_row.status <> 'active'
    OR task_row.deleted_at IS NOT NULL
    OR NEW.action_kind IS DISTINCT FROM task_row.action ->> 'kind'
  THEN RAISE EXCEPTION 'scheduled run action or task lifecycle changed during admission'
    USING ERRCODE = '42501'; END IF;
  IF NEW.action_kind <> 'agent_turn' THEN
    IF NEW.accepted_execution_snapshot IS NOT NULL
      OR NEW.accepted_execution_digest IS NOT NULL
    THEN RAISE EXCEPTION 'non-agent scheduled run cannot carry agent execution truth'
      USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  task_snapshot := NEW.accepted_execution_snapshot -> 'task';
  IF task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
    OR NEW.accepted_execution_snapshot ->> 'version' IS DISTINCT FROM '1'
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'id' IS DISTINCT FROM NEW.task_id::text
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'accountId'
      IS DISTINCT FROM NEW.account_id::text
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'workspaceId'
      IS DISTINCT FROM NEW.workspace_id::text
    OR (NEW.accepted_execution_snapshot -> 'task' ->> 'authorityRevision')::bigint
      IS DISTINCT FROM NEW.task_authority_revision
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'executionDigest'
      IS DISTINCT FROM NEW.task_execution_digest
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'status' IS DISTINCT FROM 'active'
    OR NEW.accepted_execution_snapshot -> 'task' -> 'action' ->> 'kind'
      IS DISTINCT FROM 'agent_turn'
    OR task_snapshot -> 'schedule' IS DISTINCT FROM task_row.schedule
    OR task_snapshot ->> 'temporalScheduleId' IS DISTINCT FROM task_row.temporal_schedule_id
    OR task_snapshot ->> 'runMode' IS DISTINCT FROM task_row.run_mode
    OR task_snapshot ->> 'overlapPolicy' IS DISTINCT FROM task_row.overlap_policy
    OR task_snapshot -> 'action' IS DISTINCT FROM task_row.action
    OR task_snapshot -> 'agentConfig' IS DISTINCT FROM task_row.agent_config
    OR task_snapshot ->> 'createdBy' IS NULL
    OR task_snapshot -> 'createdBy' ->> 'kind' IS DISTINCT FROM task_row.created_by_kind
    OR task_snapshot -> 'createdBy' ->> 'subjectId'
      IS DISTINCT FROM task_row.created_by_subject_id
    OR task_snapshot -> 'createdByContext' IS DISTINCT FROM task_row.created_by_context
    OR task_snapshot -> 'metadata' IS DISTINCT FROM task_row.metadata
    OR nullif(task_snapshot ->> 'variableSetId', '')::uuid
      IS DISTINCT FROM task_row.variable_set_id
    OR nullif(task_snapshot ->> 'environmentId', '')::uuid
      IS DISTINCT FROM task_row.variable_set_id
    OR nullif(task_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM task_row.rig_id
    OR (
      task_row.run_mode = 'existing_session'
      AND (
        nullif(task_snapshot ->> 'targetSessionId', '')::uuid
          IS DISTINCT FROM task_row.reusable_session_id
        OR nullif(task_snapshot ->> 'reusableSessionId', '')::uuid IS NOT NULL
      )
    )
    OR (
      task_row.run_mode <> 'existing_session'
      AND (
        nullif(task_snapshot ->> 'reusableSessionId', '')::uuid
          IS DISTINCT FROM task_row.reusable_session_id
        OR nullif(task_snapshot ->> 'targetSessionId', '')::uuid IS NOT NULL
      )
    )
    OR NEW.accepted_execution_snapshot -> 'personalConnectionDelegations'
      IS DISTINCT FROM task_row.personal_connection_delegations
    OR NEW.accepted_execution_snapshot -> 'xaiProviderAccountAuthoritySnapshot'
      IS DISTINCT FROM task_row.xai_provider_account_authority_snapshot
  THEN
    RAISE EXCEPTION 'scheduled agent run accepted execution changed during admission'
      USING ERRCODE = '40001';
  END IF;

  SELECT min(selected ->> 'ownerSubjectId'),
      count(DISTINCT selected ->> 'ownerSubjectId')::integer
    INTO connection_subject, connection_subject_count
  FROM jsonb_array_elements(task_row.personal_connection_delegations) selected
  WHERE nullif(btrim(selected ->> 'ownerSubjectId'), '') IS NOT NULL;
  SELECT min(authority.initiating_human_subject_id),
      count(DISTINCT authority.initiating_human_subject_id)::integer
    INTO personal_resource_subject, personal_resource_subject_count
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = NEW.task_authority_revision
    AND authority.account_id = NEW.account_id
    AND authority.workspace_id = NEW.workspace_id;
  SELECT authority.subject_id, authority.organization_membership_id,
      authority.membership_authorization_revision
    INTO revision_authority_subject, revision_authority_membership_id,
      revision_authority_membership_revision
  FROM scheduled_task_revision_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = NEW.task_authority_revision
    AND authority.account_id = NEW.account_id
    AND authority.workspace_id = NEW.workspace_id;
  IF connection_subject_count > 1
    OR personal_resource_subject_count > 1
    OR NEW.accepted_execution_snapshot ->> 'connectionAuthoritySubjectId'
      IS DISTINCT FROM connection_subject
    OR NEW.accepted_execution_snapshot ->> 'personalResourceAuthoritySubjectId'
      IS DISTINCT FROM personal_resource_subject
    OR (
      revision_authority_subject IS NOT NULL
      AND personal_resource_subject IS NOT NULL
      AND revision_authority_subject IS DISTINCT FROM personal_resource_subject
    )
    OR (
      revision_authority_subject IS NOT NULL
      AND connection_subject IS NOT NULL
      AND revision_authority_subject IS DISTINCT FROM connection_subject
    )
    OR EXISTS (
      SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
      WHERE snapshot.task_id = NEW.task_id
        AND snapshot.task_authority_revision = NEW.task_authority_revision
        AND snapshot.account_id = NEW.account_id
        AND snapshot.workspace_id = NEW.workspace_id
        AND snapshot.owner_subject_id IS DISTINCT FROM connection_subject
    )
    OR (
      connection_subject IS NOT NULL
      AND personal_resource_subject IS NOT NULL
      AND connection_subject IS DISTINCT FROM personal_resource_subject
    )
    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
      AND (
        task_row.created_by_kind <> 'subject'
        OR NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId'
          IS DISTINCT FROM task_row.created_by_subject_id
        OR (
          connection_subject IS NOT NULL
          AND connection_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
        OR (
          personal_resource_subject IS NOT NULL
          AND personal_resource_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
        OR (
          revision_authority_subject IS NOT NULL
          AND revision_authority_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
      )
    )
    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' <> 'user'
      AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId' IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'scheduled accepted causal subject differs from frozen authority'
      USING ERRCODE = '42501';
  END IF;
  accepted_causal_subject := coalesce(
    revision_authority_subject,
    personal_resource_subject,
    connection_subject,
    CASE WHEN task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
      THEN task_row.created_by_subject_id END
  );
  IF NEW.accepted_execution_snapshot ->> 'causalHumanSubjectId'
      IS DISTINCT FROM accepted_causal_subject
    OR NEW.accepted_execution_snapshot -> 'causalHumanAuthority'
      IS DISTINCT FROM (CASE WHEN revision_authority_subject IS NULL THEN 'null'::jsonb
        ELSE jsonb_build_object(
          'subjectId', revision_authority_subject,
          'organizationMembershipId', revision_authority_membership_id,
          'membershipAuthorizationRevision',
            revision_authority_membership_revision
        ) END)
    OR (
      NEW.status = 'queued'
      AND
      revision_authority_subject IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = revision_authority_membership_id
          AND membership.account_id = NEW.account_id
          AND membership.subject_id = revision_authority_subject
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.authorization_revision =
            revision_authority_membership_revision
          AND (
            membership.personal_workspace_id = NEW.workspace_id
            OR EXISTS (
              SELECT 1 FROM workspace_memberships workspace_membership
              WHERE workspace_membership.account_id = NEW.account_id
                AND workspace_membership.workspace_id = NEW.workspace_id
                AND workspace_membership.subject_id = revision_authority_subject
            )
          )
      )
    )
    OR (
      (
        EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.account_id = NEW.account_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.id IN (
              task_row.variable_set_id,
              nullif(
                NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'variableSetId', ''
              )::uuid
            )
        )
        OR EXISTS (
          SELECT 1 FROM rigs rig
          WHERE rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
            AND rig.id IN (
              task_row.rig_id,
              nullif(
                NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'rigId', ''
              )::uuid
            )
        )
      )
      AND accepted_causal_subject IS NULL
    )
  THEN
    RAISE EXCEPTION 'scheduled accepted causal human is invalid'
      USING ERRCODE = '42501';
  END IF;

  expected_target_session_id := CASE
    WHEN task_row.run_mode = 'existing_session' THEN task_row.reusable_session_id
    WHEN task_row.run_mode = 'reusable_session' THEN task_row.reusable_session_id
    ELSE NULL
  END;
  target_snapshot := NEW.accepted_execution_snapshot -> 'targetSessionExecution';
  -- A targeted occurrence whose exact session no longer exists is a
  -- deterministic terminal outcome for that occurrence, never a retry loop.
  IF task_row.run_mode = 'existing_session' AND expected_target_session_id IS NULL THEN
    NEW.status := 'failed';
    NEW.error := 'scheduled_target_session_unavailable';
    NEW.completed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF expected_target_session_id IS NULL THEN
    IF target_snapshot IS DISTINCT FROM 'null'::jsonb
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding' = 'null'::jsonb
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'nestedAgentDepthPolicySource' NOT IN ('session','workspace','deployment','default')
      OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'effectiveMaxNestedAgentDepth')::integer < 0
      OR (
        task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL
        AND (
          NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM 'session'
          OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'effectiveMaxNestedAgentDepth')::integer
            IS DISTINCT FROM (task_row.agent_config ->> 'maxNestedAgentDepth')::integer
        )
      )
      OR (
        task_row.agent_config ->> 'maxNestedAgentDepth' IS NULL
        AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'nestedAgentDepthPolicySource' = 'session'
      )
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'codexCompactionMode' NOT IN ('portable','remote_v2')
      OR (
        NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%'
        AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'codexCompactionMode' <> 'portable'
      )
    THEN
      RAISE EXCEPTION 'generated scheduled run cannot carry target-session execution policy'
        USING ERRCODE = '42501';
    END IF;

    IF task_row.variable_set_id IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedVariableSet' IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled generated Variable Set changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT variable_set.id, variable_set.generation, variable_set.status
        INTO generated_variable_set
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = NEW.account_id
      FOR SHARE;
      IF NOT FOUND
        OR generated_variable_set.status <> 'active'
        OR NEW.accepted_execution_snapshot -> 'resolvedVariableSet' ->> 'id'
          IS DISTINCT FROM generated_variable_set.id::text
        OR (NEW.accepted_execution_snapshot -> 'resolvedVariableSet' ->> 'generation')::bigint
          IS DISTINCT FROM generated_variable_set.generation
      THEN
        RAISE EXCEPTION 'scheduled generated Variable Set changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    IF task_row.rig_id IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedRig' IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled generated Rig changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT rig_value.id, rig_value.status INTO generated_rig
      FROM rigs rig_value
      WHERE rig_value.id = task_row.rig_id
        AND rig_value.account_id = NEW.account_id
      FOR SHARE;
      SELECT version_value.id, version_value.default_variable_set_ids
        INTO generated_rig_version
      FROM rig_versions version_value
      WHERE version_value.rig_id = task_row.rig_id
        AND version_value.account_id = NEW.account_id
        AND version_value.active
      FOR SHARE;
      PERFORM 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.account_id = NEW.account_id
        AND variable_set.id IN (
          SELECT default_id::uuid
          FROM jsonb_array_elements_text(
            coalesce(generated_rig_version.default_variable_set_ids, '[]'::jsonb)
          ) default_id
        )
      ORDER BY variable_set.id
      FOR SHARE;
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
          ORDER BY selected.ordinality
        ),
        '[]'::jsonb
      ) INTO expected_rig_default_variable_sets
      FROM jsonb_array_elements_text(
        coalesce(generated_rig_version.default_variable_set_ids, '[]'::jsonb)
      ) WITH ORDINALITY selected(id, ordinality)
      JOIN workspace_variable_sets variable_set
        ON variable_set.id = selected.id::uuid
       AND variable_set.account_id = NEW.account_id
       AND variable_set.status = 'active';
      IF generated_rig.id IS NULL
        OR generated_rig.status <> 'active'
        OR generated_rig_version.id IS NULL
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'id'
          IS DISTINCT FROM generated_rig.id::text
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'versionId'
          IS DISTINCT FROM generated_rig_version.id::text
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' -> 'defaultVariableSets'
          IS DISTINCT FROM expected_rig_default_variable_sets
      THEN
        RAISE EXCEPTION 'scheduled generated Rig changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    IF nullif(task_row.agent_config ->> 'slackBotConnectionId', '') IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
        IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT connection_value.id, connection_value.version,
          connection_value.verified_install_version, connection_value.metadata,
          connection_value.status, connection_value.subject_id,
          connection_value.provider_domain, connection_value.kind,
          connection_value.verified_install_at
        INTO generated_slack
      FROM connections connection_value
      WHERE connection_value.id = (task_row.agent_config ->> 'slackBotConnectionId')::uuid
        AND connection_value.account_id = NEW.account_id
        AND connection_value.workspace_id = NEW.workspace_id
      FOR SHARE;
      IF generated_slack.id IS NULL
        OR generated_slack.status <> 'active'
        OR generated_slack.subject_id IS NOT NULL
        OR generated_slack.provider_domain <> 'slack.com'
        OR generated_slack.kind <> 'app_install'
        OR generated_slack.verified_install_at IS NULL
        OR generated_slack.verified_install_version IS DISTINCT FROM generated_slack.version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'id'
          IS DISTINCT FROM generated_slack.id::text
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'version')::integer
          IS DISTINCT FROM generated_slack.version
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
          ->> 'verifiedInstallVersion')::integer
          IS DISTINCT FROM generated_slack.verified_install_version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' -> 'metadata'
          IS DISTINCT FROM generated_slack.metadata
      THEN
        RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    SELECT workspace_value.settings INTO STRICT workspace_settings
    FROM workspaces workspace_value
    WHERE workspace_value.id = NEW.workspace_id
      AND workspace_value.account_id = NEW.account_id
    FOR SHARE;
    SELECT configuration.max_nested_agent_depth, configuration.policy_source
      INTO STRICT deployment_depth
    FROM nested_agent_depth_configuration configuration
    WHERE configuration.singleton
    FOR SHARE;
    IF task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL THEN
      expected_depth := (task_row.agent_config ->> 'maxNestedAgentDepth')::integer;
      expected_depth_source := 'session';
    ELSIF jsonb_typeof(workspace_settings -> 'maxNestedAgentDepth') = 'number' THEN
      expected_depth := (workspace_settings ->> 'maxNestedAgentDepth')::integer;
      expected_depth_source := 'workspace';
    ELSE
      expected_depth := deployment_depth.max_nested_agent_depth;
      expected_depth_source := deployment_depth.policy_source;
    END IF;
    expected_compaction_mode := CASE
      WHEN NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%'
        THEN 'portable'
      WHEN workspace_settings ->> 'codexCompactionDefault' = 'portable'
        THEN 'portable'
      ELSE 'remote_v2'
    END;
    IF (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'effectiveMaxNestedAgentDepth')::integer IS DISTINCT FROM expected_depth
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM expected_depth_source
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'codexCompactionMode' IS DISTINCT FROM expected_compaction_mode
    THEN
      RAISE EXCEPTION 'scheduled generated policy changed during admission'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    IF NEW.accepted_execution_snapshot -> 'generatedSessionBinding' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'targeted scheduled run cannot carry generated-session binding'
      USING ERRCODE = '42501'; END IF;
    SELECT session_value.* INTO target_row
    FROM sessions session_value
    WHERE session_value.id = expected_target_session_id
      AND session_value.account_id = NEW.account_id
      AND session_value.workspace_id = NEW.workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF NOT FOUND THEN
      -- The exact target was cancelled (or is no longer visible): settle this
      -- occurrence terminally instead of failing the activity.
      NEW.status := 'skipped';
      NEW.error := 'session_cancelled';
      NEW.completed_at := clock_timestamp();
      RETURN NEW;
    END IF;
    SELECT turn_value.* INTO latest_started
    FROM session_events event_value
    JOIN session_turns turn_value
      ON turn_value.workspace_id = event_value.workspace_id
     AND turn_value.session_id = event_value.session_id
     AND turn_value.id = event_value.turn_id
    WHERE event_value.workspace_id = NEW.workspace_id
      AND event_value.session_id = expected_target_session_id
      AND event_value.type = 'turn.started'
    ORDER BY event_value.sequence DESC
    LIMIT 1;
    IF target_snapshot ->> 'sessionId' IS DISTINCT FROM target_row.id::text
      OR target_snapshot ->> 'visibility' IS DISTINCT FROM target_row.visibility
      OR (target_snapshot ->> 'authorityEpoch')::integer
        IS DISTINCT FROM target_row.authority_epoch
      OR target_snapshot ->> 'model'
        IS DISTINCT FROM coalesce(latest_started.model, target_row.model)
      OR target_snapshot ->> 'reasoningEffort' IS DISTINCT FROM coalesce(
        latest_started.reasoning_effort,
        CASE WHEN target_row.metadata ->> 'reasoningEffort' IN (
          'none','minimal','low','medium','high','xhigh','max'
        )
          THEN target_row.metadata ->> 'reasoningEffort' ELSE 'medium' END
      )
      OR target_snapshot ->> 'latencyMode' IS DISTINCT FROM coalesce(
        latest_started.latency_mode,
        CASE WHEN target_row.metadata ->> 'latencyMode' IN ('standard','priority','fast')
          THEN target_row.metadata ->> 'latencyMode' ELSE 'standard' END
      )
      OR target_snapshot -> 'tools'
        IS DISTINCT FROM coalesce(latest_started.tools, target_row.tools)
      OR target_snapshot ->> 'sandboxBackend'
        IS DISTINCT FROM coalesce(latest_started.sandbox_backend, target_row.sandbox_backend)
      OR target_snapshot ->> 'sandboxOs'
        IS DISTINCT FROM coalesce(latest_started.sandbox_os, target_row.sandbox_os)
      OR target_snapshot -> 'firstPartyMcpTools'
        IS DISTINCT FROM target_row.first_party_mcp_tools
      OR target_snapshot -> 'firstPartyMcpPermissions'
        IS DISTINCT FROM coalesce(to_jsonb(target_row.first_party_mcp_permissions), 'null'::jsonb)
      OR target_snapshot -> 'toolPolicy' IS DISTINCT FROM target_row.tool_policy
      OR target_snapshot -> 'mcpServerIds' IS DISTINCT FROM (
        SELECT coalesce(jsonb_agg(server_value.server_id ORDER BY server_value.server_id), '[]'::jsonb)
        FROM session_mcp_servers server_value
        WHERE server_value.workspace_id = NEW.workspace_id
          AND server_value.session_id = target_row.id
      )
      OR (target_snapshot ->> 'toolPolicyVersion')::integer
        IS DISTINCT FROM target_row.tool_policy_version
      OR nullif(target_snapshot ->> 'variableSetId', '')::uuid
        IS DISTINCT FROM target_row.variable_set_id
      OR nullif(target_snapshot ->> 'variableSetGeneration', '')::bigint
        IS DISTINCT FROM (
          SELECT variable_set.generation
          FROM workspace_variable_sets variable_set
          WHERE variable_set.id = target_row.variable_set_id
            AND variable_set.account_id = NEW.account_id
        )
      OR nullif(target_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM target_row.rig_id
      OR nullif(target_snapshot ->> 'rigVersionId', '')::uuid
        IS DISTINCT FROM target_row.rig_version_id
      OR target_snapshot -> 'rigDefaultVariableSets' IS DISTINCT FROM (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
            ORDER BY selected.ordinality
          ),
          '[]'::jsonb
        )
        FROM rig_versions version_value
        CROSS JOIN LATERAL jsonb_array_elements_text(
          coalesce(version_value.default_variable_set_ids, '[]'::jsonb)
        ) WITH ORDINALITY selected(id, ordinality)
        JOIN workspace_variable_sets variable_set
          ON variable_set.id = selected.id::uuid
         AND variable_set.account_id = NEW.account_id
         AND variable_set.status = 'active'
        WHERE version_value.id = target_row.rig_version_id
          AND version_value.rig_id = target_row.rig_id
          AND version_value.account_id = NEW.account_id
      )
      OR nullif(target_snapshot ->> 'maxNestedAgentDepthOverride', '')::integer
        IS DISTINCT FROM target_row.max_nested_agent_depth_override
      OR (target_snapshot ->> 'effectiveMaxNestedAgentDepth')::integer
        IS DISTINCT FROM target_row.effective_max_nested_agent_depth
    THEN
      RAISE EXCEPTION 'scheduled target-session execution policy changed during admission'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  IF (
    SELECT count(DISTINCT subject_id)
    FROM (
      SELECT authority.initiating_human_subject_id AS subject_id
      FROM scheduled_task_personal_resource_authorities authority
      WHERE authority.task_id = NEW.task_id
        AND authority.task_authority_revision = NEW.task_authority_revision
        AND authority.account_id = NEW.account_id
        AND authority.workspace_id = NEW.workspace_id
      UNION ALL
      SELECT snapshot.owner_subject_id
      FROM scheduled_task_connection_authority_snapshots snapshot
      WHERE snapshot.task_id = NEW.task_id
        AND snapshot.task_authority_revision = NEW.task_authority_revision
        AND snapshot.account_id = NEW.account_id
        AND snapshot.workspace_id = NEW.workspace_id
    ) causal_subjects
  ) > 1 THEN
    RAISE EXCEPTION 'scheduled authority classes require one causal human'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM scheduled_task_connection_authority_snapshots snapshot
    JOIN organization_user_resource_grants grant_value
      ON grant_value.id = snapshot.grant_id
     AND grant_value.account_id = snapshot.account_id
    WHERE snapshot.task_id = NEW.task_id
      AND snapshot.task_authority_revision = NEW.task_authority_revision
      AND snapshot.grant_mode = 'once'
      AND grant_value.status = 'consumed'
  ) OR EXISTS (
    SELECT 1
    FROM scheduled_task_personal_resource_snapshots snapshot
    JOIN organization_user_resource_grants grant_value
      ON grant_value.id = snapshot.grant_id
     AND grant_value.account_id = snapshot.account_id
    WHERE snapshot.task_id = NEW.task_id
      AND snapshot.task_authority_revision = NEW.task_authority_revision
      AND snapshot.grant_mode = 'once'
      AND grant_value.status = 'consumed'
  ) THEN
    NEW.status := 'failed';
    NEW.error := 'scheduled_authority_exhausted';
    NEW.completed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_agent_run_execution_admission
BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION admit_scheduled_agent_run_execution();

-- Keep the producer receipt even when a live 0252/0275 authority fence rejects
-- the queued admission. The inner block is a PostgreSQL subtransaction: every
-- grant consumption/snapshot copy from the failed INSERT is rolled back before
-- the exact terminal row is inserted. The task lock is acquired outside that
-- block, so a concurrent PATCH cannot replace the accepted task truth between
-- rejection and receipt persistence. Universal BEFORE validation still runs
-- on the terminal insert; malformed accepted execution is never blessed.
CREATE FUNCTION create_scheduled_agent_run_with_admission(
  p_run_id uuid, p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint, p_task_execution_digest text,
  p_trigger_type text, p_producer_key text, p_scheduled_at timestamptz,
  p_fired_at timestamptz, p_accepted_execution_snapshot jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  inserted_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_run_id IS NULL OR p_task_id IS NULL
    OR p_task_authority_revision IS NULL
    OR p_task_execution_digest !~ '^[0-9a-f]{64}$'
    OR p_trigger_type NOT IN ('scheduled','manual','initial','provider_event','retry','repair')
    OR nullif(btrim(p_producer_key), '') IS NULL
    OR p_accepted_execution_snapshot IS NULL
  THEN
    RAISE EXCEPTION 'scheduled agent run producer admission input is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scheduled_tasks task
  WHERE task.id = p_task_id AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
    AND task.execution_digest = p_task_execution_digest
    AND task.status = 'active' AND task.deleted_at IS NULL
    AND task.action ->> 'kind' = 'agent_turn'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled agent run task changed before producer admission'
      USING ERRCODE = '40001';
  END IF;

  BEGIN
    INSERT INTO scheduled_task_runs (
      id, account_id, workspace_id, task_id, task_authority_revision,
      task_execution_digest, trigger_type, producer_key, scheduled_at,
      fired_at, status, action_kind, accepted_execution_snapshot,
      accepted_execution_digest
    ) VALUES (
      p_run_id, p_account_id, p_workspace_id, p_task_id,
      p_task_authority_revision, p_task_execution_digest, p_trigger_type,
      p_producer_key, p_scheduled_at, p_fired_at, 'queued', 'agent_turn',
      p_accepted_execution_snapshot,
      encode(digest(convert_to(p_accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex')
    ) ON CONFLICT (workspace_id, producer_key)
      WHERE producer_key IS NOT NULL DO NOTHING
    RETURNING id INTO inserted_id;
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO scheduled_task_runs (
      id, account_id, workspace_id, task_id, task_authority_revision,
      task_execution_digest, trigger_type, producer_key, scheduled_at,
      fired_at, status, action_kind, accepted_execution_snapshot,
      accepted_execution_digest, error, completed_at
    ) VALUES (
      p_run_id, p_account_id, p_workspace_id, p_task_id,
      p_task_authority_revision, p_task_execution_digest, p_trigger_type,
      p_producer_key, p_scheduled_at, p_fired_at, 'failed', 'agent_turn',
      p_accepted_execution_snapshot,
      encode(digest(convert_to(p_accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex'),
      'scheduled_run_authority_proof_rejected', clock_timestamp()
    ) ON CONFLICT (workspace_id, producer_key)
      WHERE producer_key IS NOT NULL DO NOTHING
    RETURNING id INTO inserted_id;
  END;
  IF inserted_id IS NULL THEN
    SELECT run.id INTO STRICT inserted_id
    FROM scheduled_task_runs run
    WHERE run.workspace_id = p_workspace_id
      AND run.producer_key = p_producer_key
      AND run.task_id = p_task_id
      AND run.trigger_type = p_trigger_type;
  END IF;
  RETURN inserted_id;
END
$body$;

DROP TRIGGER scheduled_task_run_personal_resource_admission ON scheduled_task_runs;
CREATE TRIGGER scheduled_task_run_personal_resource_admission
AFTER INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.status = 'queued')
EXECUTE FUNCTION admit_scheduled_task_run_personal_resources();

CREATE FUNCTION admit_scheduled_task_run_connection_authorities()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  task_row record;
  snapshot record;
  selected_count integer;
  frozen_count integer;
  affected integer;
BEGIN
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
  WHERE task.id = NEW.task_id AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR UPDATE;
  SELECT count(*)::integer INTO selected_count
  FROM jsonb_array_elements(task_row.personal_connection_delegations) selected
  WHERE selected -> 'userDelegation' IS NOT NULL;
  SELECT count(*)::integer INTO frozen_count
  FROM scheduled_task_connection_authority_snapshots frozen
  WHERE frozen.task_id = NEW.task_id
    AND frozen.task_authority_revision = task_row.authority_revision;
  IF selected_count = 0 AND frozen_count = 0 THEN RETURN NEW; END IF;
  IF task_row.status <> 'active' THEN
    RAISE EXCEPTION 'scheduled task is not active' USING ERRCODE = '55000';
  END IF;
  IF NEW.task_authority_revision IS NULL OR NEW.task_execution_digest IS NULL
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
    OR frozen_count IS DISTINCT FROM selected_count
  THEN RAISE EXCEPTION 'scheduled connection run execution binding changed'
    USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM scheduled_task_personal_resource_authorities personal
    JOIN scheduled_task_connection_authority_snapshots connection_snapshot
      ON connection_snapshot.task_id = personal.task_id
     AND connection_snapshot.task_authority_revision = personal.task_authority_revision
    WHERE personal.task_id = NEW.task_id
      AND personal.task_authority_revision = NEW.task_authority_revision
      AND personal.initiating_human_subject_id
        IS DISTINCT FROM connection_snapshot.owner_subject_id
  ) THEN
    RAISE EXCEPTION 'scheduled authority classes have different causal humans'
      USING ERRCODE = '42501';
  END IF;

  -- Match the freezer and grant lifecycle ordering, and take every grant lock
  -- before copying/consuming any snapshot. UUID order is global across tasks.
  PERFORM 1
  FROM organization_memberships membership
  JOIN scheduled_task_connection_authority_snapshots frozen_snapshot
    ON frozen_snapshot.owner_organization_membership_id = membership.id
   AND frozen_snapshot.account_id = membership.account_id
  WHERE frozen_snapshot.task_id = NEW.task_id
    AND frozen_snapshot.task_authority_revision = NEW.task_authority_revision
  ORDER BY membership.id
  FOR SHARE OF membership;
  PERFORM 1
  FROM connections connection_value
  JOIN scheduled_task_connection_authority_snapshots frozen_snapshot
    ON frozen_snapshot.connection_id = connection_value.id
   AND frozen_snapshot.account_id = connection_value.account_id
  WHERE frozen_snapshot.task_id = NEW.task_id
    AND frozen_snapshot.task_authority_revision = NEW.task_authority_revision
  ORDER BY connection_value.id
  FOR SHARE OF connection_value;
  PERFORM 1
  FROM organization_user_resource_authorities authority
  JOIN scheduled_task_connection_authority_snapshots frozen_snapshot
    ON frozen_snapshot.authority_id = authority.id
   AND frozen_snapshot.account_id = authority.account_id
  WHERE frozen_snapshot.task_id = NEW.task_id
    AND frozen_snapshot.task_authority_revision = NEW.task_authority_revision
  ORDER BY authority.id
  FOR SHARE OF authority;
  PERFORM 1
  FROM organization_user_resource_grants grant_value
  JOIN scheduled_task_connection_authority_snapshots frozen_snapshot
    ON frozen_snapshot.grant_id = grant_value.id
   AND frozen_snapshot.account_id = grant_value.account_id
  WHERE frozen_snapshot.task_id = NEW.task_id
    AND frozen_snapshot.task_authority_revision = NEW.task_authority_revision
  ORDER BY grant_value.id
  FOR UPDATE OF grant_value;

  FOR snapshot IN SELECT frozen.*
    FROM scheduled_task_connection_authority_snapshots frozen
    WHERE frozen.task_id = NEW.task_id
      AND frozen.task_authority_revision = NEW.task_authority_revision
    ORDER BY frozen.server_id
  LOOP
    IF snapshot.snapshot_digest IS DISTINCT FROM digest(
      convert_to(snapshot.canonical_snapshot::text, 'UTF8'), 'sha256'
    ) OR NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = snapshot.owner_organization_membership_id
        AND membership.account_id = snapshot.account_id
        AND membership.subject_id = snapshot.owner_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.authorization_revision = snapshot.membership_authorization_revision
        AND (membership.personal_workspace_id = snapshot.workspace_id OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = snapshot.account_id
            AND workspace_membership.workspace_id = snapshot.workspace_id
            AND workspace_membership.subject_id = snapshot.owner_subject_id
        ))
    ) OR NOT EXISTS (
      SELECT 1 FROM connections connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = snapshot.account_id
        AND connection_value.origin_workspace_id = snapshot.origin_workspace_id
        AND connection_value.subject_id = snapshot.owner_subject_id
        AND connection_value.owner_organization_membership_id = snapshot.owner_organization_membership_id
        AND connection_value.authority_scope = 'user'
        AND connection_value.authority_generation = snapshot.connection_generation
        AND connection_value.status = 'active'
        AND lower(connection_value.provider_domain) = snapshot.provider_domain
        AND connection_value.kind = snapshot.connection_kind
    ) OR NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.id = snapshot.authority_id AND authority.account_id = snapshot.account_id
        AND authority.organization_membership_id = snapshot.owner_organization_membership_id
        AND authority.resource_kind = 'connection' AND authority.resource_id = snapshot.connection_id
        AND authority.origin_workspace_id = snapshot.origin_workspace_id
        AND authority.generation = snapshot.authority_generation
        AND authority.status = 'active' AND authority.revoked_at IS NULL
    ) OR (
      snapshot.target_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sessions session_value
        WHERE session_value.id = snapshot.target_session_id
          AND session_value.account_id = snapshot.account_id
          AND session_value.workspace_id = snapshot.workspace_id
          AND session_value.status <> 'cancelled'
          AND session_value.visibility = snapshot.session_visibility
          AND session_value.authority_epoch = snapshot.session_authority_epoch
      )
    ) THEN RAISE EXCEPTION 'scheduled connection authority is no longer live'
      USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM organization_user_resource_grants grant_value
    WHERE grant_value.id = snapshot.grant_id AND grant_value.account_id = snapshot.account_id
      AND grant_value.authority_id = snapshot.authority_id
      AND grant_value.owner_organization_membership_id = snapshot.owner_organization_membership_id
      AND grant_value.workspace_id = snapshot.workspace_id
      AND grant_value.action = 'connection.use'
      AND grant_value.mode = snapshot.grant_mode
      AND grant_value.context = snapshot.grant_context
      AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
      AND grant_value.authority_epoch IS NOT DISTINCT FROM snapshot.grant_authority_epoch
      AND grant_value.generation = snapshot.grant_generation
      AND (
        (grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp()))
        OR (grant_value.mode = 'once' AND grant_value.status = 'consumed' AND EXISTS (
          SELECT 1 FROM connection_use_once_consumption_receipts receipt
          WHERE receipt.grant_id = grant_value.id
            AND receipt.account_id = grant_value.account_id
            AND receipt.authority_id = grant_value.authority_id
            AND receipt.authority_generation = snapshot.authority_generation
            AND receipt.grant_generation = grant_value.generation
            AND receipt.accepted_work_kind = 'scheduled_task'
            AND receipt.accepted_work_id = NEW.id
        ))
      )
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled connection grant is no longer live'
      USING ERRCODE = '42501';
    END IF;

    INSERT INTO scheduled_task_run_connection_authority_snapshots
    SELECT NEW.id, snapshot.task_id, snapshot.task_authority_revision,
      snapshot.account_id, snapshot.workspace_id, snapshot.execution_digest,
      snapshot.server_id, snapshot.connection_id, snapshot.connection_generation,
      snapshot.origin_workspace_id, snapshot.provider_domain, snapshot.connection_kind,
      snapshot.selected_kind, snapshot.connection_type,
      snapshot.owner_subject_id, snapshot.owner_organization_membership_id,
      snapshot.membership_authorization_revision, snapshot.authority_id,
      snapshot.authority_generation, snapshot.grant_id, snapshot.grant_generation,
      snapshot.grant_mode, snapshot.grant_context, snapshot.grant_session_id,
      snapshot.grant_authority_epoch, snapshot.target_session_id,
      snapshot.session_visibility, snapshot.session_authority_epoch,
      snapshot.selection_sources, snapshot.canonical_snapshot,
      snapshot.snapshot_digest, clock_timestamp(), NULL;

    IF snapshot.grant_mode = 'once' THEN
      UPDATE organization_user_resource_grants grant_value
      SET status = 'consumed', updated_at = clock_timestamp()
      WHERE grant_value.id = snapshot.grant_id
        AND grant_value.account_id = snapshot.account_id
        AND grant_value.authority_id = snapshot.authority_id
        AND grant_value.generation = snapshot.grant_generation
        AND grant_value.status = 'active';
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected = 1 THEN
        INSERT INTO connection_use_once_consumption_receipts (
          grant_id, account_id, authority_id, authority_generation,
          grant_generation, accepted_work_kind, accepted_work_id
        ) VALUES (
          snapshot.grant_id, snapshot.account_id, snapshot.authority_id,
          snapshot.authority_generation, snapshot.grant_generation,
          'scheduled_task', NEW.id
        ) ON CONFLICT (grant_id) DO NOTHING;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        JOIN connection_use_once_consumption_receipts receipt
          ON receipt.grant_id = grant_value.id
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = snapshot.account_id
          AND grant_value.authority_id = snapshot.authority_id
          AND grant_value.generation = snapshot.grant_generation
          AND grant_value.status = 'consumed'
          AND receipt.authority_id = snapshot.authority_id
          AND receipt.authority_generation = snapshot.authority_generation
          AND receipt.grant_generation = snapshot.grant_generation
          AND receipt.accepted_work_kind = 'scheduled_task'
          AND receipt.accepted_work_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'scheduled connection once grant lost its first-use race'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_task_run_connection_authority_admission
AFTER INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.status = 'queued')
EXECUTE FUNCTION admit_scheduled_task_run_connection_authorities();

CREATE FUNCTION fence_scheduled_task_run_connection_session_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  accepted jsonb;
  task_snapshot jsonb;
  target_policy jsonb;
  generated_binding jsonb;
  expected_generated_metadata jsonb;
  expected_generated_creator_context jsonb;
  canonical_generated_run_id uuid;
  session_row record;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
    OR NEW.producer_key IS DISTINCT FROM OLD.producer_key
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.fired_at IS DISTINCT FROM OLD.fired_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'scheduled run immutable identity changed'
    USING ERRCODE = '42501'; END IF;
  IF NEW.action_kind IS DISTINCT FROM OLD.action_kind THEN
    RAISE EXCEPTION 'scheduled run action identity is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF (
    NEW.task_authority_revision IS DISTINCT FROM OLD.task_authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM OLD.task_execution_digest
  ) AND NOT opengeni_private.scheduled_personal_resource_capability_active('run_admit')
  THEN RAISE EXCEPTION 'scheduled run authority binding is lifecycle-only'
    USING ERRCODE = '42501'; END IF;
  IF OLD.action_kind = 'agent_turn' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.error IS DISTINCT FROM OLD.error
  ) AND NOT opengeni_private.scheduled_personal_resource_capability_active('run_lifecycle')
  THEN RAISE EXCEPTION 'scheduled agent run transition is lifecycle-only'
    USING ERRCODE = '42501'; END IF;
  IF NEW.accepted_execution_snapshot IS DISTINCT FROM OLD.accepted_execution_snapshot
    OR NEW.accepted_execution_digest IS DISTINCT FROM OLD.accepted_execution_digest
  THEN
    RAISE EXCEPTION 'scheduled run accepted execution is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'scheduled agent run session identity is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.session_id IS NULL AND NEW.session_id IS NOT NULL THEN
    accepted := OLD.accepted_execution_snapshot;
    task_snapshot := accepted -> 'task';
    target_policy := accepted -> 'targetSessionExecution';
    generated_binding := accepted -> 'generatedSessionBinding';
    SELECT session_value.* INTO STRICT session_row
    FROM sessions session_value
    WHERE session_value.id = NEW.session_id
      AND session_value.account_id = OLD.account_id
      AND session_value.workspace_id = OLD.workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF target_policy <> 'null'::jsonb THEN
      IF target_policy ->> 'sessionId' IS DISTINCT FROM NEW.session_id::text
        OR target_policy ->> 'visibility' IS DISTINCT FROM session_row.visibility
        OR (target_policy ->> 'authorityEpoch')::integer
          IS DISTINCT FROM session_row.authority_epoch
      THEN RAISE EXCEPTION 'scheduled run target session changed'
        USING ERRCODE = '42501'; END IF;
    ELSE
      canonical_generated_run_id := nullif(
        session_row.metadata ->> 'scheduledTaskRunId', ''
      )::uuid;
      IF canonical_generated_run_id IS NULL
        OR (
          task_snapshot ->> 'runMode' = 'new_session_per_run'
          AND canonical_generated_run_id IS DISTINCT FROM OLD.id
          AND NOT (
            accepted -> 'alertOccurrenceLabels' IS DISTINCT FROM 'null'::jsonb
            AND EXISTS (
              SELECT 1 FROM scheduled_task_runs canonical_run
              WHERE canonical_run.id = canonical_generated_run_id
                AND canonical_run.task_id = OLD.task_id
                AND canonical_run.account_id = OLD.account_id
                AND canonical_run.workspace_id = OLD.workspace_id
                AND canonical_run.task_authority_revision = OLD.task_authority_revision
                AND canonical_run.task_execution_digest = OLD.task_execution_digest
                AND canonical_run.session_id = NEW.session_id
                AND canonical_run.accepted_execution_snapshot
                  -> 'generatedSessionBinding' ->> 'createIdempotencyKey'
                  IS NOT DISTINCT FROM generated_binding ->> 'createIdempotencyKey'
                AND canonical_run.accepted_execution_snapshot -> 'alertOccurrenceLabels'
                  IS NOT DISTINCT FROM accepted -> 'alertOccurrenceLabels'
            )
          )
        )
        OR (
          task_snapshot ->> 'runMode' = 'reusable_session'
          AND canonical_generated_run_id IS DISTINCT FROM OLD.id
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_task_runs canonical_run
            WHERE canonical_run.id = canonical_generated_run_id
              AND canonical_run.task_id = OLD.task_id
              AND canonical_run.account_id = OLD.account_id
              AND canonical_run.workspace_id = OLD.workspace_id
              AND canonical_run.task_authority_revision = OLD.task_authority_revision
              AND canonical_run.task_execution_digest = OLD.task_execution_digest
              AND canonical_run.session_id = NEW.session_id
              AND canonical_run.accepted_execution_snapshot
                -> 'generatedSessionBinding' ->> 'createIdempotencyKey'
                IS NOT DISTINCT FROM generated_binding ->> 'createIdempotencyKey'
          )
        )
      THEN
        RAISE EXCEPTION 'scheduled generated session producer identity changed'
          USING ERRCODE = '42501';
      END IF;
      expected_generated_creator_context := pg_catalog.jsonb_build_object(
        'label', 'OpenGeni scheduler',
        'scheduledTaskId', OLD.task_id::text,
        'scheduledTaskRunId', canonical_generated_run_id::text
      );
      expected_generated_metadata :=
        (coalesce(task_snapshot -> 'agentConfig' -> 'metadata', '{}'::jsonb)
          - 'opengeniSlackBotConnectionId')
        || pg_catalog.jsonb_build_object(
          'model', accepted ->> 'resolvedModel',
          'reasoningEffort', accepted ->> 'resolvedReasoningEffort',
          'scheduledTaskId', OLD.task_id::text,
          'scheduledTaskRunMode', task_snapshot ->> 'runMode',
          'scheduledTaskRunId', canonical_generated_run_id::text
        );
      IF task_snapshot -> 'agentConfig' -> 'goal' IS NOT NULL THEN
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            'scheduledTaskGoal', task_snapshot -> 'agentConfig' -> 'goal'
          );
      END IF;
      IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb THEN
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            'opengeniSlackBotConnectionId',
            accepted -> 'resolvedSlackBotConnection' ->> 'id'
          );
      END IF;
      IF generated_binding = 'null'::jsonb
        OR generated_binding ->> 'createIdempotencyKey'
          IS DISTINCT FROM session_row.create_idempotency_key
        OR session_row.visibility <> 'workspace_shared'
        OR session_row.authority_epoch <> 1
        OR session_row.owner_organization_membership_id IS NOT NULL
        OR session_row.owner_subject_id IS NOT NULL
        OR session_row.initial_model_context IS NOT NULL
        OR session_row.instructions IS NOT NULL
        OR session_row.policy_role IS NOT NULL
        OR session_row.skills IS DISTINCT FROM '[]'::jsonb
        OR session_row.tool_policy IS DISTINCT FROM
          '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb
        OR session_row.tool_policy_version <> 1
        OR session_row.initial_personal_connection_delegations IS DISTINCT FROM '[]'::jsonb
        OR session_row.parent_session_id IS NOT NULL
        OR session_row.parent_turn_id IS NOT NULL
        OR session_row.root_session_id IS DISTINCT FROM session_row.id
        OR session_row.sandbox_group_id IS DISTINCT FROM session_row.id
        OR session_row.channel_id IS NOT NULL
        OR session_row.nested_agent_depth <> 0
        OR session_row.effective_max_nested_agent_depth IS DISTINCT FROM
          (generated_binding ->> 'effectiveMaxNestedAgentDepth')::integer
        OR session_row.nested_agent_depth_policy_source IS DISTINCT FROM
          generated_binding ->> 'nestedAgentDepthPolicySource'
        OR session_row.nested_agent_depth_policy_session_id IS DISTINCT FROM (CASE
          WHEN generated_binding ->> 'nestedAgentDepthPolicySource' = 'session'
            THEN session_row.id
          ELSE NULL
        END)
        OR session_row.codex_compaction_mode IS DISTINCT FROM
          generated_binding ->> 'codexCompactionMode'
        OR session_row.forked_from_session_id IS NOT NULL
        OR session_row.forked_from_authority_epoch IS NOT NULL
        OR session_row.forked_from_visibility IS NOT NULL
        OR session_row.forked_at IS NOT NULL
        OR session_row.forked_by_organization_membership_id IS NOT NULL
        OR session_row.initial_message IS DISTINCT FROM task_snapshot -> 'agentConfig' ->> 'prompt'
        OR session_row.resources IS DISTINCT FROM task_snapshot -> 'agentConfig' -> 'resources'
        OR session_row.tools IS DISTINCT FROM accepted -> 'resolvedTools'
        OR session_row.model IS DISTINCT FROM accepted ->> 'resolvedModel'
        OR session_row.sandbox_backend IS DISTINCT FROM accepted ->> 'resolvedSandboxBackend'
        OR session_row.sandbox_os IS DISTINCT FROM accepted ->> 'resolvedSandboxOs'
        OR session_row.first_party_mcp_tools
          IS DISTINCT FROM accepted -> 'resolvedFirstPartyMcpTools'
        OR coalesce(to_jsonb(session_row.first_party_mcp_permissions), 'null'::jsonb)
          IS DISTINCT FROM accepted -> 'resolvedFirstPartyMcpPermissions'
        OR session_row.variable_set_id IS DISTINCT FROM
          nullif(accepted -> 'resolvedVariableSet' ->> 'id', '')::uuid
        OR session_row.rig_id IS DISTINCT FROM
          nullif(accepted -> 'resolvedRig' ->> 'id', '')::uuid
        OR session_row.rig_version_id IS DISTINCT FROM
          nullif(accepted -> 'resolvedRig' ->> 'versionId', '')::uuid
        OR session_row.initial_xai_provider_account_authority_snapshot
          IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
        OR session_row.max_nested_agent_depth_override IS DISTINCT FROM
          nullif(task_snapshot -> 'agentConfig' ->> 'maxNestedAgentDepth', '')::integer
        OR session_row.created_by_kind <> 'service'
        OR session_row.created_by_subject_id <> 'scheduler'
        OR session_row.created_by_context IS DISTINCT FROM expected_generated_creator_context
        OR session_row.metadata IS DISTINCT FROM expected_generated_metadata
        OR EXISTS (
          SELECT 1 FROM session_mcp_servers server_value
          WHERE server_value.session_id = session_row.id
            AND server_value.account_id = session_row.account_id
            AND server_value.workspace_id = session_row.workspace_id
        )
      THEN RAISE EXCEPTION 'scheduled generated session differs from accepted execution'
        USING ERRCODE = '42501'; END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM scheduled_task_run_personal_resource_admissions admission
      WHERE admission.run_id = OLD.id
        AND admission.target_session_id IS NOT NULL
        AND admission.target_session_id IS DISTINCT FROM NEW.session_id
    ) OR EXISTS (
      SELECT 1 FROM scheduled_task_run_connection_authority_snapshots snapshot
      WHERE snapshot.run_id = OLD.id AND snapshot.target_session_id IS NOT NULL
        AND snapshot.target_session_id IS DISTINCT FROM NEW.session_id
    ) THEN
      RAISE EXCEPTION 'scheduled authority run target session changed'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_task_run_connection_session_identity_immutable
BEFORE UPDATE ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_run_connection_session_identity();

CREATE FUNCTION fence_scheduled_agent_run_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF OLD.action_kind = 'agent_turn' AND EXISTS (
    SELECT 1 FROM scheduled_tasks task WHERE task.id = OLD.task_id
  ) AND EXISTS (
    SELECT 1 FROM workspaces workspace_value
    WHERE workspace_value.id = OLD.workspace_id
  ) AND EXISTS (
    SELECT 1 FROM managed_accounts account_value
    WHERE account_value.id = OLD.account_id
  ) THEN RAISE EXCEPTION 'scheduled agent run evidence cannot be deleted'
    USING ERRCODE = '42501'; END IF;
  RETURN OLD;
END
$body$;

CREATE TRIGGER scheduled_agent_run_delete_immutable
BEFORE DELETE ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_agent_run_delete();

CREATE FUNCTION fence_scheduled_occurrence_evidence_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF OLD.scheduled_task_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM workspaces workspace_value WHERE workspace_value.id = OLD.workspace_id
    )
    AND EXISTS (
      SELECT 1 FROM managed_accounts account_value WHERE account_value.id = OLD.account_id
    )
  THEN RAISE EXCEPTION 'scheduled occurrence evidence cannot be deleted'
    USING ERRCODE = '42501'; END IF;
  RETURN OLD;
END
$body$;

CREATE TRIGGER scheduled_system_update_evidence_delete_immutable
BEFORE DELETE ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_evidence_delete();

CREATE TRIGGER scheduled_turn_evidence_delete_immutable
BEFORE DELETE ON session_turns
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_evidence_delete();

CREATE FUNCTION fence_scheduled_task_tombstone()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.action ->> 'kind' IS DISTINCT FROM OLD.action ->> 'kind' THEN
    RAISE EXCEPTION 'scheduled task action kind is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    NEW.variable_set_id := NULL;
    NEW.reusable_session_id := NULL;
  END IF;
  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN RAISE EXCEPTION 'scheduled task tombstone is immutable'
    USING ERRCODE = '42501'; END IF;
  IF NEW.deleted_at IS NOT NULL AND NEW.status <> 'paused' THEN
    RAISE EXCEPTION 'tombstoned scheduled task must remain paused'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_task_tombstone_immutable
BEFORE UPDATE ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_tombstone();

CREATE FUNCTION fence_scheduled_task_connection_authority_execution_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE execution_changed boolean;
BEGIN
  IF NEW.authority_revision IS DISTINCT FROM OLD.authority_revision
    AND NEW.authority_revision <> OLD.authority_revision + 1
  THEN RAISE EXCEPTION 'scheduled connection authority revision update is invalid'
    USING ERRCODE = '22023';
  END IF;
  execution_changed := (
    to_jsonb(NEW) - ARRAY['name','status','updated_at','authority_revision','execution_digest']::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY['name','status','updated_at','authority_revision','execution_digest']::text[]
  );
  IF execution_changed AND NEW.authority_revision = OLD.authority_revision
    AND EXISTS (
      SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
      WHERE snapshot.task_id = OLD.id
    )
  THEN NEW.authority_revision := OLD.authority_revision + 1;
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_task_connection_authority_execution_revision
BEFORE UPDATE ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_connection_authority_execution_update();

CREATE FUNCTION materialize_scheduled_task_reusable_session_from_run(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_run_id uuid,
  p_session_id uuid, p_source_revision bigint, p_source_digest text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  task_row record;
  run_row record;
  admission_row record;
  target_revision bigint;
  target_digest text;
  copied_count integer;
  affected integer;
  session_row record;
  snapshot_row record;
  canonical jsonb;
  existing_receipt record;
  has_connection_authority boolean;
  installs_current_head boolean;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
    current_setting('opengeni.account_id', true), ''
  )::uuid OR p_workspace_id IS DISTINCT FROM nullif(
    current_setting('opengeni.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'scheduled reusable-session materialization scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_source_revision <= 0 OR p_source_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'scheduled reusable-session source binding is invalid'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
  ON CONFLICT DO NOTHING;

  -- Serialize first materialization and every concurrent adopter on the task.
  -- The durable receipt, rather than the mutable task head, is authoritative
  -- once one occurrence has materialized the reusable session.
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
  WHERE task.id = p_task_id AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
  FOR UPDATE;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.visibility = 'workspace_shared'
    AND session_value.status <> 'cancelled'
  FOR NO KEY UPDATE;
  SELECT receipt.* INTO existing_receipt
  FROM scheduled_task_reusable_connection_materializations receipt
  WHERE receipt.task_id = p_task_id
    AND receipt.session_id = p_session_id
    AND (
      (receipt.source_task_authority_revision = p_source_revision
        AND receipt.source_execution_digest = p_source_digest)
      OR (receipt.target_task_authority_revision = p_source_revision
        AND receipt.target_execution_digest = p_source_digest)
    )
  FOR UPDATE;
  IF FOUND THEN
    IF existing_receipt.account_id IS DISTINCT FROM p_account_id
      OR existing_receipt.workspace_id IS DISTINCT FROM p_workspace_id
      OR existing_receipt.session_id IS DISTINCT FROM p_session_id
      OR NOT (
        (existing_receipt.source_task_authority_revision = p_source_revision
          AND existing_receipt.source_execution_digest = p_source_digest)
        OR
        (existing_receipt.target_task_authority_revision = p_source_revision
          AND existing_receipt.target_execution_digest = p_source_digest)
      )
    THEN RAISE EXCEPTION 'scheduled reusable connection materialization changed'
      USING ERRCODE = '23505';
    END IF;
    target_revision := existing_receipt.target_task_authority_revision;
    target_digest := existing_receipt.target_execution_digest;

    SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
    WHERE run.id = p_run_id AND run.task_id = p_task_id
      AND run.account_id = p_account_id AND run.workspace_id = p_workspace_id
      AND run.status = 'queued' AND run.session_id = p_session_id
      AND (
        (run.task_authority_revision = existing_receipt.source_task_authority_revision
          AND run.task_execution_digest = existing_receipt.source_execution_digest)
        OR
        (run.task_authority_revision = target_revision
          AND run.task_execution_digest = target_digest)
      )
    FOR UPDATE;

    SELECT admission.* INTO admission_row
    FROM scheduled_task_run_personal_resource_admissions admission
    WHERE admission.run_id = p_run_id
    FOR UPDATE;
    IF FOUND AND admission_row.task_authority_revision = existing_receipt.source_task_authority_revision
      AND admission_row.execution_digest = existing_receipt.source_execution_digest
    THEN
      UPDATE scheduled_task_run_personal_resource_snapshots snapshot
      SET task_authority_revision = target_revision
      WHERE snapshot.run_id = p_run_id
        AND snapshot.task_id = p_task_id
        AND snapshot.task_authority_revision = existing_receipt.source_task_authority_revision;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> admission_row.resource_count THEN RAISE EXCEPTION
        'scheduled reusable-session adopted resource snapshot is incomplete'
        USING ERRCODE = '42501'; END IF;
      UPDATE scheduled_task_run_personal_resource_admissions admission
      SET task_authority_revision = target_revision,
        execution_digest = target_digest
      WHERE admission.run_id = p_run_id
        AND admission.task_authority_revision = existing_receipt.source_task_authority_revision
        AND admission.execution_digest = existing_receipt.source_execution_digest;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN RAISE EXCEPTION
        'scheduled reusable-session adopted resource admission changed'
        USING ERRCODE = '42501'; END IF;
    ELSIF FOUND AND (
      admission_row.task_authority_revision IS DISTINCT FROM target_revision
      OR admission_row.execution_digest IS DISTINCT FROM target_digest
    ) THEN RAISE EXCEPTION 'scheduled reusable-session adopted resource admission changed'
      USING ERRCODE = '42501';
    END IF;

    FOR snapshot_row IN SELECT snapshot.*
      FROM scheduled_task_run_connection_authority_snapshots snapshot
      WHERE snapshot.run_id = p_run_id
      ORDER BY snapshot.server_id
      FOR UPDATE
    LOOP
      IF snapshot_row.task_id IS DISTINCT FROM p_task_id THEN
        RAISE EXCEPTION 'scheduled reusable connection run binding changed'
          USING ERRCODE = '42501';
      END IF;
      IF snapshot_row.task_authority_revision = existing_receipt.source_task_authority_revision
        AND snapshot_row.execution_digest = existing_receipt.source_execution_digest
      THEN
        IF snapshot_row.target_session_id IS DISTINCT FROM p_session_id
          OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
          OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
          OR snapshot_row.grant_mode <> 'always'
          OR snapshot_row.grant_context <> 'workspace_shared'
        THEN RAISE EXCEPTION 'scheduled reusable connection run cannot be adopted'
          USING ERRCODE = '42501'; END IF;
        canonical := snapshot_row.canonical_snapshot || jsonb_build_object(
          'taskAuthorityRevision', target_revision,
          'executionDigest', target_digest,
          'targetSessionId', p_session_id,
          'sessionVisibility', session_row.visibility,
          'sessionAuthorityEpoch', session_row.authority_epoch
        );
        UPDATE scheduled_task_run_connection_authority_snapshots snapshot
        SET task_authority_revision = target_revision,
          execution_digest = target_digest,
          target_session_id = p_session_id,
          session_visibility = session_row.visibility,
          session_authority_epoch = session_row.authority_epoch,
          canonical_snapshot = canonical,
          snapshot_digest = digest(convert_to(canonical::text, 'UTF8'), 'sha256'),
          bound_at = clock_timestamp()
        WHERE snapshot.run_id = p_run_id
          AND snapshot.server_id = snapshot_row.server_id;
      ELSIF snapshot_row.task_authority_revision IS DISTINCT FROM target_revision
        OR snapshot_row.execution_digest IS DISTINCT FROM target_digest
        OR snapshot_row.target_session_id IS DISTINCT FROM p_session_id
        OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
        OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
      THEN RAISE EXCEPTION 'scheduled reusable connection adopted binding changed'
        USING ERRCODE = '42501';
      END IF;
    END LOOP;

    IF run_row.task_authority_revision = existing_receipt.source_task_authority_revision THEN
      UPDATE scheduled_task_runs run
      SET task_authority_revision = target_revision,
        task_execution_digest = target_digest,
        updated_at = clock_timestamp()
      WHERE run.id = p_run_id
        AND run.task_authority_revision = existing_receipt.source_task_authority_revision
        AND run.task_execution_digest = existing_receipt.source_execution_digest;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN RAISE EXCEPTION
        'scheduled reusable connection adopted run changed'
        USING ERRCODE = '42501'; END IF;
    END IF;
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'run_admit';
    RETURN target_revision;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = p_run_id
  ) INTO has_connection_authority;
  PERFORM 1 FROM scheduled_task_runs run
  WHERE run.id = p_run_id AND run.task_id = p_task_id
    AND run.account_id = p_account_id AND run.workspace_id = p_workspace_id
    AND run.status = 'queued' AND run.session_id = p_session_id
    AND run.task_authority_revision = p_source_revision
    AND run.task_execution_digest = p_source_digest
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION
    'scheduled reusable run session binding changed'
    USING ERRCODE = '40001'; END IF;
  PERFORM 1 FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.visibility = 'workspace_shared'
    AND session_value.status <> 'cancelled'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION
    'scheduled reusable session must be workspace-shared'
    USING ERRCODE = '42501'; END IF;
  installs_current_head := task_row.status = 'active'
    AND task_row.run_mode = 'reusable_session'
    AND task_row.reusable_session_id IS NULL
    AND task_row.authority_revision = p_source_revision
    AND task_row.execution_digest = p_source_digest;

  IF installs_current_head AND EXISTS (
    SELECT 1 FROM scheduled_task_run_personal_resource_admissions admission
    WHERE admission.run_id = p_run_id
      AND admission.task_id = p_task_id
      AND admission.account_id = p_account_id
      AND admission.workspace_id = p_workspace_id
      AND admission.task_authority_revision = p_source_revision
      AND admission.execution_digest = p_source_digest
  ) THEN
    SELECT materialize_scheduled_task_reusable_session_from_run_0252(
      p_account_id, p_workspace_id, p_task_id, p_run_id, p_session_id,
      p_source_revision, p_source_digest
    ) INTO target_revision;
    IF target_revision IS DISTINCT FROM p_source_revision THEN
      PERFORM clone_scheduled_task_revision_authority(
        p_account_id, p_workspace_id, p_task_id, p_source_revision, target_revision
      );
    END IF;
    SELECT run.task_execution_digest INTO STRICT target_digest
    FROM scheduled_task_runs run
    WHERE run.id = p_run_id
      AND run.task_id = p_task_id
      AND run.account_id = p_account_id
      AND run.workspace_id = p_workspace_id
      AND run.task_authority_revision = target_revision
      AND run.session_id = p_session_id;
  ELSIF installs_current_head THEN
    INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
      backend_pid, transaction_id, capability_kind
    ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
    ON CONFLICT DO NOTHING;
    PERFORM 1 FROM scheduled_task_runs run
    WHERE run.id = p_run_id AND run.task_id = p_task_id
      AND run.account_id = p_account_id AND run.workspace_id = p_workspace_id
      AND run.status = 'queued'
      AND run.session_id = p_session_id
      AND run.task_authority_revision = p_source_revision
      AND run.task_execution_digest = p_source_digest
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled reusable-session run binding changed'
      USING ERRCODE = '40001'; END IF;
    PERFORM 1 FROM sessions session_value
    WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.visibility = 'workspace_shared'
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled reusable-session target is unavailable'
      USING ERRCODE = '42501'; END IF;
    PERFORM 1 FROM scheduled_tasks task
    WHERE task.id = p_task_id AND task.account_id = p_account_id
      AND task.workspace_id = p_workspace_id AND task.status = 'active'
      AND task.run_mode = 'reusable_session' AND task.reusable_session_id IS NULL
      AND task.authority_revision = p_source_revision
      AND task.execution_digest = p_source_digest
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION
      'scheduled reusable-session task changed before materialization'
      USING ERRCODE = '40001'; END IF;
    UPDATE scheduled_tasks task
    SET reusable_session_id = p_session_id,
      authority_revision = task.authority_revision + 1,
      updated_at = clock_timestamp()
    WHERE task.id = p_task_id AND task.account_id = p_account_id
      AND task.workspace_id = p_workspace_id
    RETURNING task.authority_revision, task.execution_digest
      INTO STRICT target_revision, target_digest;
    SELECT clone_scheduled_task_personal_resource_authority(
      p_account_id, p_workspace_id, p_task_id, p_source_revision, target_revision
    ) INTO copied_count;
    IF copied_count <> 0 THEN RAISE EXCEPTION
      'unexpected scheduled reusable personal-resource authority appeared'
      USING ERRCODE = '42501'; END IF;
    -- The installed head is a new revision of the same accepted human authority;
    -- clone it so the next occurrence still resolves the exact causal human.
    PERFORM clone_scheduled_task_revision_authority(
      p_account_id, p_workspace_id, p_task_id, p_source_revision, target_revision
    );
    UPDATE scheduled_task_runs run
    SET task_authority_revision = target_revision,
      task_execution_digest = target_digest,
      updated_at = clock_timestamp()
    WHERE run.id = p_run_id AND run.task_authority_revision = p_source_revision
      AND run.task_execution_digest = p_source_digest;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION
      'scheduled reusable connection run row rebind failed'
      USING ERRCODE = '42501'; END IF;
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'run_admit';
  ELSE
    -- The occurrence was admitted before the task head changed or paused. It
    -- still owns its immutable run/session truth, but must not install an old
    -- session pointer into the newer task head. A same-revision receipt makes
    -- this detached materialization durable and adoptable without rewriting
    -- either the task or the already-admitted 0252 authority.
    target_revision := p_source_revision;
    target_digest := p_source_digest;
  END IF;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id AND session_value.status <> 'cancelled'
  FOR SHARE;

  FOR snapshot_row IN SELECT snapshot.*
    FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = p_run_id
    ORDER BY snapshot.server_id
    FOR UPDATE
  LOOP
    IF snapshot_row.task_id IS DISTINCT FROM p_task_id
      OR snapshot_row.task_authority_revision IS DISTINCT FROM p_source_revision
      OR snapshot_row.execution_digest IS DISTINCT FROM p_source_digest
      OR snapshot_row.target_session_id IS DISTINCT FROM p_session_id
      OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
      OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
      OR snapshot_row.grant_mode <> 'always'
      OR snapshot_row.grant_context <> 'workspace_shared'
    THEN RAISE EXCEPTION 'scheduled reusable connection run binding changed'
      USING ERRCODE = '42501';
    END IF;
    canonical := snapshot_row.canonical_snapshot || jsonb_build_object(
      'taskAuthorityRevision', target_revision,
      'executionDigest', target_digest,
      'targetSessionId', p_session_id,
      'sessionVisibility', session_row.visibility,
      'sessionAuthorityEpoch', session_row.authority_epoch
    );
    UPDATE scheduled_task_run_connection_authority_snapshots snapshot
    SET task_authority_revision = target_revision,
      execution_digest = target_digest,
      target_session_id = p_session_id,
      session_visibility = session_row.visibility,
      session_authority_epoch = session_row.authority_epoch,
      canonical_snapshot = canonical,
      snapshot_digest = digest(convert_to(canonical::text, 'UTF8'), 'sha256'),
      bound_at = clock_timestamp()
    WHERE snapshot.run_id = p_run_id AND snapshot.server_id = snapshot_row.server_id;
  END LOOP;

  SELECT receipt.* INTO existing_receipt
  FROM scheduled_task_reusable_connection_materializations receipt
  WHERE receipt.run_id = p_run_id
    OR (
      receipt.task_id = p_task_id
      AND receipt.session_id = p_session_id
      AND receipt.source_task_authority_revision = p_source_revision
      AND receipt.source_execution_digest = p_source_digest
    );
  IF FOUND THEN
    IF existing_receipt.run_id IS DISTINCT FROM p_run_id
      OR existing_receipt.session_id IS DISTINCT FROM p_session_id
      OR existing_receipt.source_task_authority_revision IS DISTINCT FROM p_source_revision
      OR existing_receipt.target_task_authority_revision IS DISTINCT FROM target_revision
      OR existing_receipt.source_execution_digest IS DISTINCT FROM p_source_digest
      OR existing_receipt.target_execution_digest IS DISTINCT FROM target_digest
    THEN RAISE EXCEPTION 'scheduled reusable connection materialization changed'
      USING ERRCODE = '23505';
    END IF;
  ELSE
    INSERT INTO scheduled_task_reusable_connection_materializations (
      task_id, run_id, account_id, workspace_id, session_id,
      source_task_authority_revision, target_task_authority_revision,
      source_execution_digest, target_execution_digest
    ) VALUES (
      p_task_id, p_run_id, p_account_id, p_workspace_id, p_session_id,
      p_source_revision, target_revision, p_source_digest, target_digest
    );
  END IF;
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RETURN target_revision;
END
$body$;

CREATE FUNCTION bind_scheduled_task_run_connection_authorities(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  run_row record;
  session_row record;
  snapshot_row record;
  canonical jsonb;
  bound_count integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
    current_setting('opengeni.account_id', true), ''
  )::uuid OR p_workspace_id IS DISTINCT FROM nullif(
    current_setting('opengeni.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'scheduled connection run bind scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id
  FOR UPDATE;
  IF run_row.status NOT IN ('queued', 'dispatched') THEN
    RAISE EXCEPTION 'scheduled connection run is not turn-admissible'
    USING ERRCODE = '42501';
  END IF;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id AND session_value.status <> 'cancelled'
  FOR SHARE;
  IF run_row.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'scheduled connection run session binding changed'
      USING ERRCODE = '42501';
  END IF;

  FOR snapshot_row IN SELECT snapshot.*
    FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = p_run_id
    ORDER BY snapshot.server_id
    FOR UPDATE
  LOOP
    IF snapshot_row.task_id IS DISTINCT FROM run_row.task_id
      OR snapshot_row.task_authority_revision IS DISTINCT FROM run_row.task_authority_revision
      OR snapshot_row.execution_digest IS DISTINCT FROM run_row.task_execution_digest
      OR snapshot_row.snapshot_digest IS DISTINCT FROM digest(
      convert_to(snapshot_row.canonical_snapshot::text, 'UTF8'), 'sha256'
    ) THEN RAISE EXCEPTION 'scheduled connection run snapshot digest changed'
      USING ERRCODE = '42501';
    END IF;
    IF snapshot_row.target_session_id IS NULL THEN
      IF snapshot_row.grant_mode <> 'always'
        OR snapshot_row.grant_context <> 'workspace_shared'
        OR session_row.visibility <> 'workspace_shared'
      THEN RAISE EXCEPTION 'scheduled connection run cannot bind a private new session'
        USING ERRCODE = '42501';
      END IF;
      canonical := snapshot_row.canonical_snapshot || jsonb_build_object(
        'targetSessionId', p_session_id,
        'sessionVisibility', session_row.visibility,
        'sessionAuthorityEpoch', session_row.authority_epoch
      );
      UPDATE scheduled_task_run_connection_authority_snapshots snapshot
      SET target_session_id = p_session_id,
        session_visibility = session_row.visibility,
        session_authority_epoch = session_row.authority_epoch,
        canonical_snapshot = canonical,
        snapshot_digest = digest(convert_to(canonical::text, 'UTF8'), 'sha256'),
        bound_at = clock_timestamp()
      WHERE snapshot.run_id = p_run_id AND snapshot.server_id = snapshot_row.server_id;
    ELSIF snapshot_row.target_session_id IS DISTINCT FROM p_session_id
      OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
      OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
    THEN RAISE EXCEPTION 'scheduled connection run is bound to another session authority'
      USING ERRCODE = '42501';
    END IF;
    bound_count := bound_count + 1;
  END LOOP;
  RETURN bound_count;
END
$body$;

CREATE FUNCTION bind_scheduled_task_run_session(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled run bind scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id AND session_value.status <> 'cancelled'
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scheduled run bind session unavailable'
    USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM scheduled_task_runs run
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id AND run.action_kind = 'agent_turn'
    AND run.status IN ('queued','dispatched')
    AND (run.session_id IS NULL OR run.session_id = p_session_id)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scheduled run bind identity changed'
    USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_lifecycle')
  ON CONFLICT DO NOTHING;
  UPDATE scheduled_task_runs run
  SET session_id = p_session_id, updated_at = clock_timestamp()
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id;
  PERFORM bind_scheduled_task_run_connection_authorities(
    p_account_id, p_workspace_id, p_run_id, p_session_id
  );
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
END
$body$;

CREATE FUNCTION transition_scheduled_agent_run(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid,
  p_trigger_event_id uuid, p_status text, p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE run_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_status NOT IN ('dispatched','failed','skipped')
  THEN RAISE EXCEPTION 'scheduled run transition scope or status mismatch'
    USING ERRCODE = '42501'; END IF;
  IF p_session_id IS NOT NULL THEN
    PERFORM 1 FROM sessions session_value
    WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled run transition session unavailable'
      USING ERRCODE = '42501'; END IF;
  END IF;
  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id AND run.action_kind = 'agent_turn'
  FOR UPDATE;
  IF run_row.status IN ('succeeded','failed','skipped') THEN RETURN; END IF;
  IF run_row.status NOT IN ('queued','dispatched')
    OR (p_session_id IS NOT NULL AND run_row.session_id IS NOT NULL
      AND run_row.session_id IS DISTINCT FROM p_session_id)
    OR (p_status = 'dispatched' AND (p_session_id IS NULL OR p_trigger_event_id IS NULL))
    OR (p_status IN ('failed','skipped') AND p_error IS NULL)
  THEN RAISE EXCEPTION 'scheduled run transition identity changed'
    USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_lifecycle')
  ON CONFLICT DO NOTHING;
  UPDATE scheduled_task_runs run
  SET status = p_status,
    session_id = coalesce(p_session_id, run.session_id),
    trigger_event_id = CASE WHEN p_status = 'dispatched' THEN p_trigger_event_id
      ELSE run.trigger_event_id END,
    error = p_error,
    completed_at = CASE WHEN p_status IN ('failed','skipped')
      THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id;
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
END
$body$;

CREATE FUNCTION scheduled_task_run_connection_authority_subject(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  owner_subject text;
  owner_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
    current_setting('opengeni.account_id', true), ''
  )::uuid OR p_workspace_id IS DISTINCT FROM nullif(
    current_setting('opengeni.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'scheduled connection authority subject scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  SELECT min(snapshot.owner_subject_id), count(DISTINCT snapshot.owner_subject_id)::integer
    INTO owner_subject, owner_count
  FROM scheduled_task_run_connection_authority_snapshots snapshot
  JOIN scheduled_task_runs run ON run.id = snapshot.run_id
    AND run.account_id = snapshot.account_id
    AND run.workspace_id = snapshot.workspace_id
    AND run.task_id = snapshot.task_id
    AND run.task_authority_revision = snapshot.task_authority_revision
    AND run.task_execution_digest = snapshot.execution_digest
  WHERE snapshot.run_id = p_run_id AND snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id;
  IF owner_count > 1 THEN
    RAISE EXCEPTION 'scheduled connection authority has multiple causal humans'
      USING ERRCODE = '42501';
  END IF;
  RETURN owner_subject;
END
$body$;

CREATE FUNCTION scheduled_task_personal_resource_authority_subject(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  owner_subject text;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
    current_setting('opengeni.account_id', true), ''
  )::uuid OR p_workspace_id IS DISTINCT FROM nullif(
    current_setting('opengeni.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'scheduled personal-resource authority subject scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  SELECT authority.initiating_human_subject_id INTO owner_subject
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_task_authority_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id;
  RETURN owner_subject;
END
$body$;

CREATE FUNCTION fence_scheduled_task_turn_run_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id THEN
    RAISE EXCEPTION 'scheduled task run turn identity is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION validate_scheduled_occurrence_accepted_execution()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  run_row record;
  accepted jsonb;
  task_snapshot jsonb;
  expected_payload jsonb;
BEGIN
  IF NEW.kind <> 'scheduled_occurrence' THEN RETURN NEW; END IF;
  IF NEW.scheduled_task_run_id IS NULL THEN
    RAISE EXCEPTION 'scheduled occurrence requires an accepted run'
      USING ERRCODE = '42501';
  END IF;
  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = NEW.scheduled_task_run_id
    AND run.account_id = NEW.account_id
    AND run.workspace_id = NEW.workspace_id
    AND run.session_id = NEW.session_id
    AND run.status IN ('queued', 'dispatched')
  FOR UPDATE;
  accepted := run_row.accepted_execution_snapshot;
  task_snapshot := accepted -> 'task';
  IF accepted IS NULL
    OR run_row.accepted_execution_digest IS DISTINCT FROM encode(
      digest(convert_to(accepted::text, 'UTF8'), 'sha256'), 'hex'
    )
    OR NOT (
      ((task_snapshot ->> 'authorityRevision')::bigint = run_row.task_authority_revision
        AND task_snapshot ->> 'executionDigest' = run_row.task_execution_digest)
      OR EXISTS (
        SELECT 1 FROM scheduled_task_reusable_connection_materializations receipt
        WHERE receipt.task_id = run_row.task_id
          AND receipt.account_id = run_row.account_id
          AND receipt.workspace_id = run_row.workspace_id
          AND receipt.session_id = run_row.session_id
          AND receipt.source_task_authority_revision =
            (task_snapshot ->> 'authorityRevision')::bigint
          AND receipt.source_execution_digest = task_snapshot ->> 'executionDigest'
          AND receipt.target_task_authority_revision = run_row.task_authority_revision
          AND receipt.target_execution_digest = run_row.task_execution_digest
      )
    )
  THEN
    RAISE EXCEPTION 'scheduled occurrence accepted execution binding changed'
      USING ERRCODE = '42501';
  END IF;

  expected_payload := jsonb_build_object(
    'type', 'scheduled_occurrence',
    'text', task_snapshot -> 'agentConfig' ->> 'prompt',
    'scheduledTaskId', run_row.task_id,
    'scheduledTaskRunId', run_row.id
  );
  IF jsonb_array_length(task_snapshot -> 'agentConfig' -> 'resources') > 0 THEN
    expected_payload := expected_payload || jsonb_build_object(
      'resources', task_snapshot -> 'agentConfig' -> 'resources'
    );
  END IF;
  IF jsonb_array_length(accepted -> 'resolvedTools') > 0 THEN
    expected_payload := expected_payload || jsonb_build_object(
      'tools', accepted -> 'resolvedTools'
    );
  END IF;
  IF NEW.source_id IS DISTINCT FROM run_row.id::text
    OR NEW.dedupe_key IS DISTINCT FROM 'scheduled-task-run:' || run_row.id::text
    OR NEW.summary IS DISTINCT FROM task_snapshot -> 'agentConfig' ->> 'prompt'
    OR NEW.payload IS DISTINCT FROM expected_payload
    OR NEW.personal_connection_delegations
      IS DISTINCT FROM accepted -> 'personalConnectionDelegations'
    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
    OR NEW.lineage ->> 'scheduledTaskId' IS DISTINCT FROM run_row.task_id::text
    OR NEW.lineage ->> 'scheduledTaskRunId' IS DISTINCT FROM run_row.id::text
    OR NEW.lineage ->> 'causalHumanSubjectId'
      IS DISTINCT FROM accepted ->> 'causalHumanSubjectId'
    OR NEW.lineage ->> 'connectionAuthoritySubjectId'
      IS DISTINCT FROM accepted ->> 'connectionAuthoritySubjectId'
    OR NEW.lineage ->> 'xaiAuthoritySubjectId'
      IS DISTINCT FROM accepted ->> 'xaiAuthoritySubjectId'
    OR (accepted ->> 'incidentPreflightRequired')::boolean
      IS DISTINCT FROM (NEW.lineage ? 'incidentTelemetryAuthorityFence')
  THEN
    RAISE EXCEPTION 'scheduled occurrence differs from accepted execution'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_occurrence_accepted_execution_validation
BEFORE INSERT ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION validate_scheduled_occurrence_accepted_execution();

CREATE FUNCTION fence_scheduled_occurrence_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF OLD.scheduled_task_run_id IS NULL THEN
    IF NEW.scheduled_task_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'scheduled occurrence identity cannot be attached after acceptance'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.classification IS DISTINCT FROM OLD.classification
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.summary_codec_version IS DISTINCT FROM OLD.summary_codec_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_codec_version IS DISTINCT FROM OLD.payload_codec_version
    OR NEW.lineage IS DISTINCT FROM OLD.lineage
    OR NEW.personal_connection_delegations IS DISTINCT FROM OLD.personal_connection_delegations
    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM OLD.xai_provider_account_authority_snapshot
  THEN RAISE EXCEPTION 'scheduled occurrence accepted content is immutable'
    USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_occurrence_update_immutable
BEFORE UPDATE ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_update();

CREATE TRIGGER scheduled_task_turn_run_identity_immutable
  BEFORE UPDATE OF scheduled_task_run_id ON session_turns
  FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_turn_run_identity();

CREATE FUNCTION fence_scheduled_turn_execution_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF OLD.scheduled_task_run_id IS NOT NULL AND (
    NEW.model IS DISTINCT FROM OLD.model
    OR NEW.reasoning_effort IS DISTINCT FROM OLD.reasoning_effort
    OR NEW.latency_mode IS DISTINCT FROM OLD.latency_mode
    OR NEW.tools IS DISTINCT FROM OLD.tools
    OR NEW.sandbox_backend IS DISTINCT FROM OLD.sandbox_backend
    OR NEW.sandbox_os IS DISTINCT FROM OLD.sandbox_os
    OR NEW.initiating_human_subject_id IS DISTINCT FROM OLD.initiating_human_subject_id
    OR NEW.personal_connection_delegations IS DISTINCT FROM OLD.personal_connection_delegations
    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM OLD.xai_provider_account_authority_snapshot
  ) THEN RAISE EXCEPTION 'scheduled turn accepted execution is immutable'
    USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_turn_execution_immutable
BEFORE UPDATE OF model, reasoning_effort, latency_mode, tools, sandbox_backend,
  sandbox_os, initiating_human_subject_id, personal_connection_delegations,
  xai_provider_account_authority_snapshot ON session_turns
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_turn_execution_update();

CREATE FUNCTION settle_scheduled_run_from_terminal_turn()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
BEGIN
  IF NEW.scheduled_task_run_id IS NULL
    OR NEW.status NOT IN ('completed','failed','cancelled','superseded','withdrawn_for_edit')
    OR NEW.status IS NOT DISTINCT FROM OLD.status
  THEN RETURN NEW; END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_lifecycle')
  ON CONFLICT DO NOTHING;
  UPDATE scheduled_task_runs run
  SET status = CASE WHEN NEW.status = 'completed' THEN 'succeeded'
    WHEN NEW.status = 'failed' THEN 'failed' ELSE 'skipped' END,
    error = CASE WHEN NEW.status = 'completed' THEN NULL
      ELSE 'scheduled_turn_' || NEW.status END,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE run.id = NEW.scheduled_task_run_id
    AND run.account_id = NEW.account_id
    AND run.workspace_id = NEW.workspace_id
    AND run.session_id = NEW.session_id
    AND run.status = 'dispatched';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    PERFORM 1 FROM scheduled_task_runs run
    WHERE run.id = NEW.scheduled_task_run_id
      AND run.account_id = NEW.account_id
      AND run.workspace_id = NEW.workspace_id
      AND run.session_id = NEW.session_id
      AND run.status IN ('succeeded','failed','skipped');
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled run terminal turn settlement changed'
      USING ERRCODE = '42501'; END IF;
  END IF;
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_run_terminal_turn_settlement
AFTER UPDATE OF status ON session_turns
FOR EACH ROW EXECUTE FUNCTION settle_scheduled_run_from_terminal_turn();

CREATE FUNCTION settle_scheduled_run_from_terminal_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.scheduled_task_run_id IS NULL
    OR OLD.state <> 'pending'
    OR NEW.state NOT IN ('cancelled','superseded','failed')
    OR NEW.delivered_turn_id IS NOT NULL
  THEN RETURN NEW; END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_lifecycle')
  ON CONFLICT DO NOTHING;
  UPDATE scheduled_task_runs run
  SET status = CASE WHEN NEW.state = 'failed' THEN 'failed' ELSE 'skipped' END,
    error = 'scheduled_update_' || NEW.state,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE run.id = NEW.scheduled_task_run_id
    AND run.account_id = NEW.account_id
    AND run.workspace_id = NEW.workspace_id
    AND run.session_id = NEW.session_id
    AND run.status IN ('queued','dispatched');
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_run_terminal_update_settlement
AFTER UPDATE OF state ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION settle_scheduled_run_from_terminal_update();

ALTER FUNCTION opengeni_private.capture_accepted_turn_connection_authorities()
  RENAME TO capture_accepted_turn_connection_authorities_0264;
DROP TRIGGER accepted_turn_connection_authority_capture ON session_turns;
CREATE TRIGGER accepted_turn_connection_authority_capture
  AFTER INSERT OR UPDATE OF personal_connection_delegations ON session_turns
  FOR EACH ROW
  WHEN (NEW.scheduled_task_run_id IS NULL)
  EXECUTE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities_0264();

CREATE FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  run_row record;
  run_snapshot record;
  item jsonb;
  selected_count integer;
  snapshot_count integer;
  canonical jsonb;
  accepted jsonb;
  execution_policy jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id THEN
      RAISE EXCEPTION 'scheduled logical-turn occurrence identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.personal_connection_delegations IS NOT DISTINCT FROM OLD.personal_connection_delegations
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'scheduled connection authority cannot change after acceptance'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = NEW.scheduled_task_run_id AND run.account_id = NEW.account_id
    AND run.workspace_id = NEW.workspace_id
  FOR UPDATE;
  IF run_row.status NOT IN ('queued', 'dispatched')
    OR run_row.session_id IS DISTINCT FROM NEW.session_id
  THEN
    RAISE EXCEPTION 'scheduled turn does not match its run session'
      USING ERRCODE = '42501';
  END IF;
  accepted := run_row.accepted_execution_snapshot;
  execution_policy := accepted -> 'targetSessionExecution';
  IF execution_policy = 'null'::jsonb THEN
    IF NEW.model IS DISTINCT FROM accepted ->> 'resolvedModel'
      OR NEW.reasoning_effort IS DISTINCT FROM accepted ->> 'resolvedReasoningEffort'
      OR NEW.latency_mode IS DISTINCT FROM accepted ->> 'resolvedLatencyMode'
      OR NEW.tools IS DISTINCT FROM accepted -> 'resolvedTools'
      OR NEW.sandbox_backend IS DISTINCT FROM accepted ->> 'resolvedSandboxBackend'
      OR NEW.sandbox_os IS DISTINCT FROM accepted ->> 'resolvedSandboxOs'
    THEN RAISE EXCEPTION 'generated scheduled turn differs from accepted execution policy'
      USING ERRCODE = '42501'; END IF;
  ELSE
    IF execution_policy ->> 'sessionId' IS DISTINCT FROM NEW.session_id::text
      OR NEW.model IS DISTINCT FROM execution_policy ->> 'model'
      OR NEW.reasoning_effort IS DISTINCT FROM execution_policy ->> 'reasoningEffort'
      OR NEW.latency_mode IS DISTINCT FROM execution_policy ->> 'latencyMode'
      OR NEW.tools IS DISTINCT FROM execution_policy -> 'tools'
      OR NEW.sandbox_backend IS DISTINCT FROM execution_policy ->> 'sandboxBackend'
      OR NEW.sandbox_os IS DISTINCT FROM execution_policy ->> 'sandboxOs'
    THEN RAISE EXCEPTION 'targeted scheduled turn differs from accepted execution policy'
      USING ERRCODE = '42501'; END IF;
  END IF;
  PERFORM bind_scheduled_task_run_connection_authorities(
    NEW.account_id, NEW.workspace_id, NEW.scheduled_task_run_id, NEW.session_id
  );

  SELECT count(*)::integer INTO snapshot_count
  FROM scheduled_task_run_connection_authority_snapshots snapshot
  WHERE snapshot.run_id = NEW.scheduled_task_run_id;
  SELECT count(*)::integer INTO selected_count
  FROM jsonb_array_elements(NEW.personal_connection_delegations) selected
  WHERE selected -> 'userDelegation' IS NOT NULL;
  IF selected_count IS DISTINCT FROM snapshot_count THEN
    RAISE EXCEPTION 'scheduled turn connection authority widened or disappeared'
      USING ERRCODE = '42501';
  END IF;

  FOR run_snapshot IN SELECT snapshot.*
    FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = NEW.scheduled_task_run_id
    ORDER BY snapshot.server_id
  LOOP
    SELECT value INTO STRICT item
    FROM jsonb_array_elements(NEW.personal_connection_delegations)
    WHERE value ->> 'serverId' = run_snapshot.server_id;
    IF NEW.initiating_human_subject_id IS DISTINCT FROM run_snapshot.owner_subject_id
      OR item ->> 'connectionId' IS DISTINCT FROM run_snapshot.connection_id::text
      OR item ->> 'originWorkspaceId' IS DISTINCT FROM run_snapshot.origin_workspace_id::text
      OR item ->> 'ownerSubjectId' IS DISTINCT FROM run_snapshot.owner_subject_id
      OR lower(item ->> 'providerDomain') IS DISTINCT FROM run_snapshot.provider_domain
      OR (item ? 'kind') IS DISTINCT FROM (run_snapshot.selected_kind IS NOT NULL)
      OR item ->> 'kind' IS DISTINCT FROM run_snapshot.selected_kind
      OR (item ? 'connectionType')
        IS DISTINCT FROM (run_snapshot.connection_type IS NOT NULL)
      OR item ->> 'connectionType' IS DISTINCT FROM run_snapshot.connection_type
      OR item -> 'userDelegation' ->> 'authorityId' IS DISTINCT FROM run_snapshot.authority_id::text
      OR item -> 'userDelegation' ->> 'grantId' IS DISTINCT FROM run_snapshot.grant_id::text
      OR item -> 'userDelegation' ->> 'organizationId'
        IS DISTINCT FROM run_snapshot.account_id::text
      OR item -> 'userDelegation' ->> 'workspaceId'
        IS DISTINCT FROM run_snapshot.workspace_id::text
      OR item -> 'userDelegation' ->> 'action' IS DISTINCT FROM 'connection.use'
      OR item -> 'userDelegation' ->> 'mode' IS DISTINCT FROM run_snapshot.grant_mode
      OR item -> 'userDelegation' ->> 'context' IS DISTINCT FROM run_snapshot.grant_context
      OR nullif(item -> 'userDelegation' ->> 'sessionId', '')::uuid
        IS DISTINCT FROM run_snapshot.grant_session_id
      OR nullif(item -> 'userDelegation' ->> 'authorityEpoch', '')::integer
        IS DISTINCT FROM run_snapshot.grant_authority_epoch
      OR (item -> 'userDelegation' ->> 'authorityGeneration')::bigint
        IS DISTINCT FROM run_snapshot.authority_generation
      OR (item -> 'userDelegation' ->> 'grantGeneration')::bigint
        IS DISTINCT FROM run_snapshot.grant_generation
      OR (item -> 'userDelegation') ? 'resourceVersionId'
    THEN RAISE EXCEPTION 'scheduled turn connection selection changed from its run'
      USING ERRCODE = '42501';
    END IF;
    canonical := jsonb_build_object(
      'organizationId', NEW.account_id,
      'originWorkspaceId', run_snapshot.origin_workspace_id,
      'targetWorkspaceId', NEW.workspace_id,
      'targetSessionId', NEW.session_id,
      'targetSessionVisibility', run_snapshot.session_visibility,
      'targetSessionAuthorityEpoch', run_snapshot.session_authority_epoch,
      'acceptedWork', jsonb_build_object(
        'kind', 'scheduled_task', 'taskId', run_snapshot.task_id,
        'taskAuthorityRevision', run_snapshot.task_authority_revision,
        'runId', run_snapshot.run_id
      ),
      'connectionId', run_snapshot.connection_id,
      'connectionGeneration', run_snapshot.connection_generation,
      'connectionStatus', 'active', 'providerDomain', run_snapshot.provider_domain,
      'connectionKind', run_snapshot.connection_kind, 'scope', 'user',
      'ownerSubjectId', run_snapshot.owner_subject_id,
      'ownerOrganizationMembershipId', run_snapshot.owner_organization_membership_id,
      'ownerMembershipAuthorizationRevision', run_snapshot.membership_authorization_revision,
      'authoritySource', 'user_delegation',
      'selectionSources', to_jsonb(run_snapshot.selection_sources),
      'userDelegation', jsonb_build_object(
        'organizationId', NEW.account_id, 'authorityId', run_snapshot.authority_id,
        'authorityGeneration', run_snapshot.authority_generation,
        'workspaceId', NEW.workspace_id, 'sessionId', run_snapshot.grant_session_id,
        'action', 'connection.use', 'mode', run_snapshot.grant_mode,
        'context', run_snapshot.grant_context,
        'authorityEpoch', run_snapshot.grant_authority_epoch,
        'grantId', run_snapshot.grant_id,
        'grantGeneration', run_snapshot.grant_generation
      )
    );
    INSERT INTO turn_connection_authority_snapshots (
      account_id, workspace_id, session_id, turn_id, server_id,
      connection_id, connection_generation, origin_workspace_id,
      provider_domain, connection_kind, authority_scope, authority_source,
      owner_subject_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      grant_id, grant_generation, grant_mode, grant_context, grant_session_id,
      grant_authority_epoch, session_visibility, session_authority_epoch,
      canonical_snapshot, snapshot_digest
    ) VALUES (
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.id, run_snapshot.server_id,
      run_snapshot.connection_id, run_snapshot.connection_generation,
      run_snapshot.origin_workspace_id, run_snapshot.provider_domain,
      run_snapshot.connection_kind, 'user', 'user_delegation',
      run_snapshot.owner_subject_id, run_snapshot.owner_organization_membership_id,
      run_snapshot.membership_authorization_revision, run_snapshot.authority_id,
      run_snapshot.authority_generation, run_snapshot.grant_id,
      run_snapshot.grant_generation, run_snapshot.grant_mode,
      run_snapshot.grant_context, run_snapshot.grant_session_id,
      run_snapshot.grant_authority_epoch, run_snapshot.session_visibility,
      run_snapshot.session_authority_epoch, canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256')
    );
  END LOOP;
  RETURN NEW;
END
$body$;

CREATE TRIGGER accepted_scheduled_turn_connection_authority_capture
  AFTER INSERT OR UPDATE OF personal_connection_delegations ON session_turns
  FOR EACH ROW
  WHEN (NEW.scheduled_task_run_id IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities();

-- Once an occurrence is admitted and bound, a later task-head edit governs
-- only new runs. Exact attempt admission follows the immutable run/session/turn
-- chain while the ordinary attempt snapshot triggers still revalidate current
-- resource generations and revocations.
CREATE OR REPLACE FUNCTION validate_scheduled_task_attempt_personal_resources()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  scheduled_run_id uuid;
  run_count integer;
  admission_row record;
  turn_subject text;
  mismatch_count integer;
BEGIN
  SELECT count(DISTINCT update_row.scheduled_task_run_id)::integer,
    min(update_row.scheduled_task_run_id::text)::uuid
  INTO run_count, scheduled_run_id
  FROM session_system_updates update_row
  WHERE update_row.workspace_id = NEW.workspace_id
    AND update_row.session_id = NEW.session_id
    AND update_row.delivered_turn_id = NEW.turn_id
    AND update_row.kind = 'scheduled_occurrence'
    AND update_row.scheduled_task_run_id IS NOT NULL;
  IF run_count = 0 THEN RETURN NEW; END IF;
  IF run_count <> 1 THEN
    RAISE EXCEPTION 'scheduled personal-resource attempt requires one occurrence snapshot'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'attempt_match')
  ON CONFLICT DO NOTHING;

  SELECT admission.* INTO admission_row
  FROM scheduled_task_run_personal_resource_admissions admission
  WHERE admission.run_id = scheduled_run_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'scheduled occurrence has no admitted personal-resource snapshot'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT coalesce(
    nullif(btrim(turn_value.initiating_human_subject_id), ''),
    CASE WHEN turn_value.initiator_kind = 'subject'
      THEN nullif(btrim(turn_value.initiator_subject_id), '') END
  ) INTO turn_subject
  FROM session_turns turn_value
  WHERE turn_value.id = NEW.turn_id
    AND turn_value.account_id = NEW.account_id
    AND turn_value.workspace_id = NEW.workspace_id
    AND turn_value.session_id = NEW.session_id;
  IF turn_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
    RAISE EXCEPTION 'scheduled occurrence causal human mismatch' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM scheduled_task_runs run
  JOIN session_turns turn_value
    ON turn_value.id = NEW.turn_id
   AND turn_value.account_id = run.account_id
   AND turn_value.workspace_id = run.workspace_id
   AND turn_value.session_id = run.session_id
   AND turn_value.scheduled_task_run_id = run.id
  WHERE run.id = scheduled_run_id
    AND run.task_id = admission_row.task_id
    AND run.account_id = admission_row.account_id
    AND run.workspace_id = admission_row.workspace_id
    AND run.session_id = NEW.session_id
    AND run.status IN ('queued', 'dispatched')
    AND run.task_authority_revision = admission_row.task_authority_revision
    AND run.task_execution_digest = admission_row.execution_digest
  FOR SHARE OF run, turn_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled run authority changed before attempt admission'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO mismatch_count
  FROM scheduled_task_run_personal_resource_snapshots run_snapshot
  FULL JOIN session_attempt_personal_resource_snapshots attempt_snapshot
    ON attempt_snapshot.attempt_id = NEW.id
   AND attempt_snapshot.resource_kind = run_snapshot.resource_kind
   AND attempt_snapshot.resource_id = run_snapshot.resource_id
  WHERE run_snapshot.run_id = scheduled_run_id
    AND (
      attempt_snapshot.attempt_id IS NULL
      OR attempt_snapshot.resource_version_id IS DISTINCT FROM run_snapshot.resource_version_id
      OR attempt_snapshot.selection_sources IS DISTINCT FROM run_snapshot.selection_sources
      OR attempt_snapshot.authority_id IS DISTINCT FROM run_snapshot.authority_id
      OR attempt_snapshot.authority_generation IS DISTINCT FROM run_snapshot.authority_generation
      OR attempt_snapshot.grant_id IS DISTINCT FROM run_snapshot.grant_id
      OR attempt_snapshot.grant_generation IS DISTINCT FROM run_snapshot.grant_generation
      OR attempt_snapshot.grant_mode IS DISTINCT FROM run_snapshot.grant_mode
    );
  IF mismatch_count <> 0 OR (
    SELECT count(*) FROM session_attempt_personal_resource_snapshots snapshot
    WHERE snapshot.attempt_id = NEW.id
  ) <> admission_row.resource_count THEN
    RAISE EXCEPTION 'scheduled occurrence personal-resource snapshot widened or changed'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RAISE;
END
$body$;

-- 0264 admitted `once` only when the immutable receipt named the logical turn.
-- Scheduled authority consumes at stable run admission, so the same resolver
-- accepts the exact run id retained inside the canonical turn snapshot.
CREATE OR REPLACE FUNCTION resolve_accepted_connection_use(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_physical_request_id uuid,
  p_use_phase text, p_server_id text, p_connection_id uuid,
  p_provider_domain text, p_connection_kind text, p_subject_scope text,
  p_owner_subject_id text DEFAULT NULL
) RETURNS TABLE (
  authorization_status text, denial_reason text, resolved_connection_id uuid,
  connection_generation bigint, origin_workspace_id uuid,
  resolved_connection_kind text, authority_scope text, owner_subject_id text,
  authority_id uuid, grant_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  prior record;
  connection_row record;
  snapshot record;
  session_row record;
  grant_row record;
  request_digest bytea;
  has_prior boolean := false;
  reason text;
  scheduled_run_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_execution_generation <= 0
    OR p_use_phase NOT IN ('credential_resolution', 'provider_request')
    OR nullif(btrim(p_server_id), '') IS NULL OR octet_length(p_server_id) > 256
  THEN RAISE EXCEPTION 'connection use scope mismatch' USING ERRCODE = '42501';
  END IF;
  request_digest := digest(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'sessionId', p_session_id, 'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'usePhase', p_use_phase,
    'serverId', p_server_id, 'connectionId', p_connection_id,
    'providerDomain', lower(p_provider_domain), 'connectionKind', p_connection_kind,
    'subjectScope', p_subject_scope, 'ownerSubjectId', p_owner_subject_id
  )::text, 'UTF8'), 'sha256');

  -- Canonical lifecycle lock prefix: control -> workspace -> session -> turn -> attempt.
  PERFORM 1 FROM workspace_inference_controls control_row
  WHERE control_row.account_id = p_account_id AND control_row.workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM workspaces workspace_value
    WHERE workspace_value.account_id = p_account_id AND workspace_value.id = p_workspace_id
    FOR KEY SHARE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    SELECT session_value.* INTO session_row FROM sessions session_value
    WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
    FOR NO KEY UPDATE;
    IF NOT FOUND OR session_row.active_turn_id IS DISTINCT FROM p_turn_id
      OR session_row.status = 'cancelled'
    THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turns turn_value
    WHERE turn_value.id = p_turn_id AND turn_value.account_id = p_account_id
      AND turn_value.workspace_id = p_workspace_id AND turn_value.session_id = p_session_id
      AND turn_value.active_attempt_id = p_attempt_id
      AND turn_value.execution_generation = p_execution_generation
      AND turn_value.status = 'running'
    FOR UPDATE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turn_attempts attempt
    WHERE attempt.id = p_attempt_id AND attempt.account_id = p_account_id
      AND attempt.workspace_id = p_workspace_id AND attempt.session_id = p_session_id
      AND attempt.turn_id = p_turn_id
      AND attempt.execution_generation = p_execution_generation
      AND attempt.state IN ('claimed', 'running')
      AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
      AND attempt.authority_visibility = session_row.visibility
      AND attempt.authority_epoch = session_row.authority_epoch
      AND attempt.authority_owner_organization_membership_id
        IS NOT DISTINCT FROM session_row.owner_organization_membership_id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.session_id = p_session_id
        AND interruption.attempt_id = p_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    ) THEN reason := 'session_identity_changed'; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_physical_request_id::text, 0));
  SELECT EXISTS (SELECT 1 FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id) INTO has_prior;
  -- Only dereference `prior` inside the guarded branch: PL/pgSQL evaluates
  -- both operands of `has_prior AND prior.<field>`, and an unassigned record
  -- raises instead of yielding NULL.
  IF has_prior THEN
    SELECT audit.* INTO STRICT prior FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id;
    IF prior.request_digest IS DISTINCT FROM request_digest THEN
      RAISE EXCEPTION 'physical connection request id was reused for different work'
        USING ERRCODE = '23505';
    END IF;
    IF reason IS NULL AND prior.outcome = 'denied' THEN
      authorization_status := prior.outcome; denial_reason := prior.denial_reason;
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  IF reason IS NULL THEN
    SELECT authority_snapshot.* INTO snapshot
    FROM turn_connection_authority_snapshots authority_snapshot
    WHERE authority_snapshot.turn_id = p_turn_id
      AND authority_snapshot.server_id = p_server_id
      AND authority_snapshot.account_id = p_account_id
      AND authority_snapshot.workspace_id = p_workspace_id
      AND authority_snapshot.session_id = p_session_id;
    IF FOUND THEN
      scheduled_run_id := CASE
        WHEN snapshot.canonical_snapshot -> 'acceptedWork' ->> 'kind' = 'scheduled_task'
        THEN nullif(snapshot.canonical_snapshot -> 'acceptedWork' ->> 'runId', '')::uuid
        ELSE NULL END;
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = p_account_id;
      IF snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'), 'sha256'
      ) THEN reason := 'accepted_snapshot_digest_changed';
      ELSIF NOT FOUND THEN reason := 'connection_missing';
      ELSIF snapshot.authority_scope IS DISTINCT FROM 'user'
        OR p_subject_scope IS DISTINCT FROM 'subject'
        OR p_connection_id IS DISTINCT FROM snapshot.connection_id
        OR lower(p_provider_domain) IS DISTINCT FROM snapshot.provider_domain
        OR (p_connection_kind IS NOT NULL
          AND p_connection_kind IS DISTINCT FROM snapshot.connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'user'
        OR connection_row.subject_id IS DISTINCT FROM snapshot.owner_subject_id
        OR connection_row.owner_organization_membership_id
          IS DISTINCT FROM snapshot.owner_organization_membership_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM snapshot.origin_workspace_id
      THEN reason := 'connection_owner_changed';
      ELSIF connection_row.authority_generation IS DISTINCT FROM snapshot.connection_generation
      THEN reason := 'connection_generation_changed';
      ELSIF session_row.visibility IS DISTINCT FROM snapshot.session_visibility
        OR session_row.authority_epoch IS DISTINCT FROM snapshot.session_authority_epoch
      THEN reason := 'session_authority_epoch_changed';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = p_account_id
          AND membership.subject_id = snapshot.owner_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot.owner_subject_id
          ))
      ) THEN reason := 'owner_membership_inactive';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id AND authority.account_id = p_account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = 'connection'
          AND authority.resource_id = snapshot.connection_id
          AND authority.origin_workspace_id = snapshot.origin_workspace_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
      ) THEN reason := 'authority_status_inactive';
      ELSE
        SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id AND grant_value.account_id = p_account_id
        FOR UPDATE;
        IF NOT FOUND THEN reason := 'grant_missing';
        ELSIF grant_row.authority_id IS DISTINCT FROM snapshot.authority_id
          OR grant_row.owner_organization_membership_id
            IS DISTINCT FROM snapshot.owner_organization_membership_id
          OR grant_row.workspace_id IS DISTINCT FROM p_workspace_id
          OR grant_row.action <> 'connection.use'
          OR grant_row.mode IS DISTINCT FROM snapshot.grant_mode
          OR grant_row.context IS DISTINCT FROM snapshot.grant_context
          OR grant_row.session_id IS DISTINCT FROM snapshot.grant_session_id
          OR grant_row.authority_epoch IS DISTINCT FROM snapshot.grant_authority_epoch
        THEN reason := 'grant_identity_changed';
        ELSIF grant_row.generation IS DISTINCT FROM snapshot.grant_generation
        THEN reason := 'grant_generation_changed';
        ELSIF grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= clock_timestamp()
        THEN reason := 'grant_expired';
        ELSIF grant_row.mode = 'once' THEN
          IF grant_row.status <> 'consumed' OR NOT EXISTS (
            SELECT 1 FROM connection_use_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_row.id
              AND receipt.authority_id = snapshot.authority_id
              AND receipt.authority_generation = snapshot.authority_generation
              AND receipt.grant_generation = snapshot.grant_generation
              AND (
                (receipt.accepted_work_kind = 'turn'
                  AND receipt.accepted_work_id = p_turn_id)
                OR (receipt.accepted_work_kind = 'scheduled_task'
                  AND scheduled_run_id IS NOT NULL
                  AND receipt.accepted_work_id = scheduled_run_id)
              )
          ) THEN reason := 'grant_already_consumed'; END IF;
        ELSIF grant_row.status <> 'active' THEN reason := 'grant_status_inactive';
        END IF;
      END IF;
      resolved_connection_id := snapshot.connection_id;
      connection_generation := snapshot.connection_generation;
      origin_workspace_id := snapshot.origin_workspace_id;
      resolved_connection_kind := snapshot.connection_kind;
      authority_scope := snapshot.authority_scope;
      owner_subject_id := snapshot.owner_subject_id;
      authority_id := snapshot.authority_id;
      grant_id := snapshot.grant_id;
    ELSE
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = p_connection_id AND connection_value.account_id = p_account_id;
      IF NOT FOUND THEN reason := 'connection_missing';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'legacy_user'
        OR p_subject_scope IS DISTINCT FROM 'subject' OR p_owner_subject_id IS NULL
        OR connection_row.subject_id IS DISTINCT FROM p_owner_subject_id
        OR connection_row.workspace_id IS DISTINCT FROM p_workspace_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM p_workspace_id
        OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(p_provider_domain)
        OR (p_connection_kind IS NOT NULL
          AND connection_row.kind IS DISTINCT FROM p_connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSE
        resolved_connection_id := connection_row.id;
        connection_generation := connection_row.authority_generation;
        origin_workspace_id := connection_row.origin_workspace_id;
        resolved_connection_kind := connection_row.kind;
        authority_scope := 'legacy_user'; owner_subject_id := connection_row.subject_id;
      END IF;
    END IF;
  END IF;

  authorization_status := CASE WHEN reason IS NULL THEN 'authorized' ELSE 'denied' END;
  denial_reason := reason;
  IF NOT has_prior THEN
    INSERT INTO connection_use_audit_facts (
      physical_request_id, use_phase, request_digest, account_id, workspace_id,
      session_id, turn_id, attempt_id, execution_generation, server_id,
      connection_id, connection_generation, authority_scope, owner_subject_id,
      authority_id, grant_id, outcome, denial_reason
    ) VALUES (
      p_physical_request_id, p_use_phase, request_digest, p_account_id,
      p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
      p_execution_generation, p_server_id, resolved_connection_id,
      connection_generation, authority_scope, owner_subject_id, authority_id,
      grant_id, authorization_status, denial_reason
    ) ON CONFLICT (physical_request_id) DO NOTHING;
  END IF;
  RETURN NEXT;
END
$body$;

-- The organization membership command (migration 0263) predates scheduled task authority
-- snapshots. Its suspend/offboard prefix locked memberships before the tasks
-- and sessions that it subsequently revokes, while scheduled task writers use
-- task -> target session -> membership. Preserve the proven lifecycle body
-- behind a private name and put the shared prefix in front of it.
ALTER FUNCTION organization_membership_command(jsonb)
  RENAME TO organization_membership_command_0263;

CREATE FUNCTION organization_membership_command(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  action_name text := p_command ->> 'action';
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  target_id uuid;
  target_subject text;
  workspace_id_value uuid;
BEGIN
  IF action_name NOT IN ('suspend', 'offboard') THEN
    RETURN organization_membership_command_0263(p_command);
  END IF;
  IF p_command IS NULL
    OR account_id_value IS NULL
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization membership command authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  target_id := nullif(p_command ->> 'membershipId', '')::uuid;
  IF target_id IS NULL THEN
    RAISE EXCEPTION 'organization membership target is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- The application settles the target's pending protocol state first and
  -- finalizes that workspace activity gate, which leaves the session commit
  -- guards IMMEDIATE for the rest of the transaction. The wrapped command then
  -- opens the gate again per workspace and stamps its own writes through the
  -- same finalization protocol, so its guards must start DEFERRED exactly as
  -- they were when 0263 shipped; otherwise a target with live turns in a
  -- workspace-shared session fails at its first gated session write.
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;

  -- The account row is the organization-lifecycle prefix. It makes the
  -- following non-locking identity reads stable against another command.
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT membership.subject_id INTO target_subject
  FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.id = target_id;
  IF target_subject IS NULL THEN
    RAISE EXCEPTION 'organization membership not found' USING ERRCODE = 'P0002';
  END IF;

  -- Match the command's existing account-wide workspace prefix before the new
  -- task/session suffix. The wrapped implementation re-locks these rows
  -- reentrantly and then continues with its canonical turn/attempt mutations.
  FOR workspace_id_value IN
    SELECT workspace.id
    FROM workspaces workspace
    WHERE workspace.account_id = account_id_value
    ORDER BY workspace.id
  LOOP
    PERFORM pg_catalog.set_config(
      'opengeni.workspace_id', workspace_id_value::text, true
    );
    PERFORM 1 FROM workspace_inference_controls control
    WHERE control.account_id = account_id_value
      AND control.workspace_id = workspace_id_value
    FOR SHARE;
    PERFORM 1 FROM workspaces workspace
    WHERE workspace.account_id = account_id_value
      AND workspace.id = workspace_id_value
    FOR KEY SHARE;

    -- Task/session prefix per workspace: FORCE-RLS on both tables resolves the
    -- exact opengeni.workspace_id GUC, so a non-BYPASSRLS definer owner would
    -- otherwise lock and pause only the last workspace's rows.
    PERFORM 1 FROM scheduled_tasks task
    WHERE task.account_id = account_id_value
      AND task.workspace_id = workspace_id_value
      AND task.deleted_at IS NULL
      AND task.status = 'active'
      AND (
        (task.created_by_kind = 'subject' AND task.created_by_subject_id = target_subject)
        OR EXISTS (
          SELECT 1 FROM scheduled_task_revision_authorities authority
          WHERE authority.task_id = task.id
            AND authority.task_authority_revision = task.authority_revision
            AND authority.subject_id = target_subject
        )
        OR EXISTS (
          SELECT 1 FROM scheduled_task_personal_resource_authorities authority
          WHERE authority.task_id = task.id
            AND authority.task_authority_revision = task.authority_revision
            AND authority.initiating_human_subject_id = target_subject
        )
        OR EXISTS (
          SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
          WHERE snapshot.task_id = task.id
            AND snapshot.task_authority_revision = task.authority_revision
            AND snapshot.owner_subject_id = target_subject
        )
      )
    ORDER BY task.id
    FOR UPDATE;

    PERFORM 1 FROM sessions session_row
    WHERE session_row.account_id = account_id_value
      AND session_row.workspace_id = workspace_id_value
      AND (
        session_row.owner_organization_membership_id = target_id
        OR EXISTS (
          SELECT 1 FROM session_turns initiated
          WHERE initiated.account_id = account_id_value
            AND initiated.session_id = session_row.id
            AND initiated.initiating_human_subject_id = target_subject
        )
        OR EXISTS (
          SELECT 1 FROM scheduled_tasks task
          WHERE task.account_id = account_id_value
            AND task.workspace_id = workspace_id_value
            AND task.deleted_at IS NULL
            AND task.status = 'active'
            AND (
              (task.created_by_kind = 'subject' AND task.created_by_subject_id = target_subject)
              OR EXISTS (
                SELECT 1 FROM scheduled_task_revision_authorities authority
                WHERE authority.task_id = task.id
                  AND authority.task_authority_revision = task.authority_revision
                  AND authority.subject_id = target_subject
              )
              OR EXISTS (
                SELECT 1 FROM scheduled_task_personal_resource_authorities authority
                WHERE authority.task_id = task.id
                  AND authority.task_authority_revision = task.authority_revision
                  AND authority.initiating_human_subject_id = target_subject
              )
              OR EXISTS (
                SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
                WHERE snapshot.task_id = task.id
                  AND snapshot.task_authority_revision = task.authority_revision
                  AND snapshot.owner_subject_id = target_subject
              )
            )
            AND task.reusable_session_id = session_row.id
        )
      )
    ORDER BY session_row.id
    FOR NO KEY UPDATE;



    -- Pause every task whose current frozen execution authority belongs to the
    -- target, including A-created tasks explicitly reauthorized by B. Doing this
    -- while the target membership is still live preserves task -> session ->
    -- membership order; the wrapped command then performs the revocation.
    UPDATE scheduled_tasks task
    SET status = 'paused', personal_connection_delegations = '[]'::jsonb,
      authority_revision = task.authority_revision + 1,
      updated_at = clock_timestamp()
    WHERE task.account_id = account_id_value
      AND task.workspace_id = workspace_id_value
      AND task.deleted_at IS NULL
      AND task.status = 'active'
      AND (
        (task.created_by_kind = 'subject' AND task.created_by_subject_id = target_subject)
        OR EXISTS (
          SELECT 1 FROM scheduled_task_revision_authorities authority
          WHERE authority.task_id = task.id
            AND authority.task_authority_revision = task.authority_revision
            AND authority.subject_id = target_subject
        )
        OR EXISTS (
          SELECT 1 FROM scheduled_task_personal_resource_authorities authority
          WHERE authority.task_id = task.id
            AND authority.task_authority_revision = task.authority_revision
            AND authority.initiating_human_subject_id = target_subject
        )
        OR EXISTS (
          SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
          WHERE snapshot.task_id = task.id
            AND snapshot.task_authority_revision = task.authority_revision
            AND snapshot.owner_subject_id = target_subject
        )
      );
  END LOOP;

  PERFORM 1 FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.id IN (
      target_id,
      (
        SELECT actor.id FROM organization_memberships actor
        WHERE actor.account_id = account_id_value
          AND actor.subject_id = actor_subject
      )
    )
  ORDER BY membership.id
  FOR UPDATE;

  RETURN organization_membership_command_0263(p_command);
END
$body$;

CREATE FUNCTION validate_scheduled_agent_run_live_authority(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  run_row record;
  accepted jsonb;
  causal jsonb;
  snapshot record;
  grant_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RETURN 'scheduled_authority_scope_changed'; END IF;
  SELECT run.* INTO run_row
  FROM scheduled_task_runs run
  WHERE run.id = p_run_id
    AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR run_row.accepted_execution_snapshot IS NULL THEN
    RETURN 'scheduled_authority_snapshot_missing';
  END IF;
  accepted := run_row.accepted_execution_snapshot;
  causal := accepted -> 'causalHumanAuthority';

  -- Match task admission and organization lifecycle lock order. Claim must
  -- linearize before delivery: a concurrent suspension/revocation either
  -- completes first and is observed below, or waits until this claim commits.
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.id IN (
      SELECT (causal ->> 'organizationMembershipId')::uuid
      WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
      UNION
      SELECT frozen.owner_organization_membership_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
    )
  ORDER BY membership.id
  FOR SHARE;
  PERFORM 1 FROM workspace_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.workspace_id = p_workspace_id
    AND membership.subject_id IN (
      SELECT causal ->> 'subjectId'
      WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
      UNION
      SELECT frozen.owner_subject_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
    )
  ORDER BY membership.subject_id
  FOR SHARE;
  PERFORM 1 FROM connections connection_value
  WHERE connection_value.account_id = p_account_id
    AND connection_value.id IN (
      SELECT frozen.connection_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
      UNION
      SELECT (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
      WHERE accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
    )
  ORDER BY connection_value.id
  FOR SHARE;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.id IN (
      SELECT frozen.authority_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
      UNION
      SELECT xai_authority.id
      FROM organization_user_resource_authorities xai_authority
      WHERE accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
        AND causal IS NOT NULL AND causal <> 'null'::jsonb
        AND xai_authority.account_id = p_account_id
        AND xai_authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND xai_authority.resource_kind = 'xai_subscription'
        AND xai_authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
    )
  ORDER BY authority.id
  FOR SHARE;
  PERFORM 1 FROM organization_user_resource_grants grant_value
  WHERE grant_value.account_id = p_account_id
    AND grant_value.id IN (
      SELECT frozen.grant_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
    )
  ORDER BY grant_value.id
  FOR UPDATE;
  PERFORM 1 FROM workspace_variable_sets variable_set
  WHERE variable_set.account_id = p_account_id
    AND variable_set.id IN (
      SELECT (accepted -> 'resolvedVariableSet' ->> 'id')::uuid
      WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
        AND accepted -> 'resolvedVariableSet' <> 'null'::jsonb
      UNION
      SELECT (accepted -> 'targetSessionExecution' ->> 'variableSetId')::uuid
      WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
        AND accepted -> 'targetSessionExecution' ->> 'variableSetId' IS NOT NULL
      UNION
      SELECT (selected.value ->> 'id')::uuid
      FROM jsonb_array_elements(coalesce(
        accepted -> 'resolvedRig' -> 'defaultVariableSets', '[]'::jsonb
      )) selected(value)
      UNION
      SELECT (selected.value ->> 'id')::uuid
      FROM jsonb_array_elements(coalesce(
        accepted -> 'targetSessionExecution' -> 'rigDefaultVariableSets',
        '[]'::jsonb
      )) selected(value)
    )
  ORDER BY variable_set.id
  FOR SHARE;
  PERFORM 1 FROM rigs rig
  WHERE rig.account_id = p_account_id
    AND rig.id IN (
      SELECT (accepted -> 'resolvedRig' ->> 'id')::uuid
      WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
        AND accepted -> 'resolvedRig' <> 'null'::jsonb
      UNION
      SELECT (accepted -> 'targetSessionExecution' ->> 'rigId')::uuid
      WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
        AND accepted -> 'targetSessionExecution' ->> 'rigId' IS NOT NULL
    )
  ORDER BY rig.id
  FOR SHARE;
  PERFORM 1 FROM rig_versions version_value
  WHERE version_value.account_id = p_account_id
    AND version_value.id IN (
      SELECT (accepted -> 'resolvedRig' ->> 'versionId')::uuid
      WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
        AND accepted -> 'resolvedRig' <> 'null'::jsonb
      UNION
      SELECT (accepted -> 'targetSessionExecution' ->> 'rigVersionId')::uuid
      WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
        AND accepted -> 'targetSessionExecution' ->> 'rigVersionId' IS NOT NULL
    )
  ORDER BY version_value.id
  FOR SHARE;

  IF causal IS NOT NULL AND causal <> 'null'::jsonb AND NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = (causal ->> 'organizationMembershipId')::uuid
      AND membership.account_id = p_account_id
      AND membership.subject_id = causal ->> 'subjectId'
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND membership.authorization_revision =
        (causal ->> 'membershipAuthorizationRevision')::bigint
      AND (
        membership.personal_workspace_id = p_workspace_id
        OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = causal ->> 'subjectId'
        )
      )
  ) THEN RETURN 'scheduled_causal_membership_changed'; END IF;
  IF accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.account_id = p_account_id
        AND authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND authority.resource_kind = 'xai_subscription'
        AND authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL
    )
  THEN RETURN 'scheduled_xai_authority_changed'; END IF;
  IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM connections connection_value
      WHERE connection_value.id =
          (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
        AND connection_value.account_id = p_account_id
        AND connection_value.workspace_id = p_workspace_id
        AND connection_value.subject_id IS NULL
        AND connection_value.provider_domain = 'slack.com'
        AND connection_value.kind = 'app_install'
        AND connection_value.status = 'active'
        AND connection_value.verified_install_at IS NOT NULL
        AND connection_value.version =
          (accepted -> 'resolvedSlackBotConnection' ->> 'version')::integer
        AND connection_value.verified_install_version =
          (accepted -> 'resolvedSlackBotConnection'
            ->> 'verifiedInstallVersion')::integer
        AND connection_value.verified_install_version = connection_value.version
        AND connection_value.metadata IS NOT DISTINCT FROM
          accepted -> 'resolvedSlackBotConnection' -> 'metadata'
    )
  THEN RETURN 'scheduled_slack_bot_changed'; END IF;

  FOR snapshot IN
    SELECT value.* FROM scheduled_task_run_connection_authority_snapshots value
    WHERE value.run_id = p_run_id
    ORDER BY value.server_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = snapshot.owner_organization_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = snapshot.owner_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND membership.authorization_revision = snapshot.membership_authorization_revision
        AND (
          membership.personal_workspace_id = p_workspace_id
          OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot.owner_subject_id
          )
        )
    ) THEN RETURN 'scheduled_connection_membership_changed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM connections connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = p_account_id
        AND connection_value.workspace_id = snapshot.origin_workspace_id
        AND connection_value.subject_id = snapshot.owner_subject_id
        AND connection_value.owner_organization_membership_id =
          snapshot.owner_organization_membership_id
        AND connection_value.authority_scope = 'user'
        AND connection_value.authority_generation = snapshot.connection_generation
        AND connection_value.status = 'active'
        AND lower(connection_value.provider_domain) = snapshot.provider_domain
        AND connection_value.kind = snapshot.connection_kind
    ) THEN RETURN 'scheduled_connection_changed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.id = snapshot.authority_id
        AND authority.account_id = p_account_id
        AND authority.organization_membership_id =
          snapshot.owner_organization_membership_id
        AND authority.resource_kind = 'connection'
        AND authority.resource_id = snapshot.connection_id
        AND authority.origin_workspace_id = snapshot.origin_workspace_id
        AND authority.generation = snapshot.authority_generation
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL
    ) THEN RETURN 'scheduled_connection_authority_changed'; END IF;
    SELECT grant_value.* INTO grant_row
    FROM organization_user_resource_grants grant_value
    WHERE grant_value.id = snapshot.grant_id
      AND grant_value.account_id = p_account_id;
    IF NOT FOUND THEN RETURN 'scheduled_connection_grant_changed'; END IF;
    IF grant_row.authority_id IS DISTINCT FROM snapshot.authority_id
      OR grant_row.owner_organization_membership_id IS DISTINCT FROM
        snapshot.owner_organization_membership_id
      OR grant_row.workspace_id IS DISTINCT FROM p_workspace_id
      OR grant_row.action <> 'connection.use'
      OR grant_row.mode IS DISTINCT FROM snapshot.grant_mode
      OR grant_row.context IS DISTINCT FROM snapshot.grant_context
      OR grant_row.session_id IS DISTINCT FROM snapshot.grant_session_id
      OR grant_row.authority_epoch IS DISTINCT FROM snapshot.grant_authority_epoch
      OR grant_row.generation IS DISTINCT FROM snapshot.grant_generation
      OR (grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= clock_timestamp())
      OR (
        grant_row.mode = 'once' AND (
          grant_row.status <> 'consumed'
          OR NOT EXISTS (
            SELECT 1 FROM connection_use_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_row.id
              AND receipt.account_id = p_account_id
              AND receipt.authority_id = snapshot.authority_id
              AND receipt.authority_generation = snapshot.authority_generation
              AND receipt.grant_generation = snapshot.grant_generation
              AND receipt.accepted_work_kind = 'scheduled_task'
              AND receipt.accepted_work_id = p_run_id
          )
        )
      )
      OR (grant_row.mode <> 'once' AND grant_row.status <> 'active')
    THEN RETURN 'scheduled_connection_grant_changed'; END IF;
  END LOOP;

  IF accepted -> 'targetSessionExecution' = 'null'::jsonb THEN
    IF accepted -> 'resolvedVariableSet' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.id = (accepted -> 'resolvedVariableSet' ->> 'id')::uuid
        AND variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
        AND variable_set.generation =
          (accepted -> 'resolvedVariableSet' ->> 'generation')::bigint
    ) THEN RETURN 'scheduled_variable_set_changed'; END IF;
    IF accepted -> 'resolvedRig' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1 FROM rigs rig
      JOIN rig_versions version_value
        ON version_value.id = (accepted -> 'resolvedRig' ->> 'versionId')::uuid
       AND version_value.rig_id = rig.id
       AND version_value.account_id = rig.account_id
      WHERE rig.id = (accepted -> 'resolvedRig' ->> 'id')::uuid
        AND rig.account_id = p_account_id
        AND rig.status = 'active'
    ) THEN RETURN 'scheduled_rig_changed'; END IF;
    IF accepted -> 'resolvedRig' <> 'null'::jsonb AND (
      accepted -> 'resolvedRig' -> 'defaultVariableSets' IS DISTINCT FROM (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
            ORDER BY selected.ordinality
          ),
          '[]'::jsonb
        )
        FROM rig_versions version_value
        CROSS JOIN LATERAL jsonb_array_elements_text(
          coalesce(version_value.default_variable_set_ids, '[]'::jsonb)
        ) WITH ORDINALITY selected(id, ordinality)
        JOIN workspace_variable_sets variable_set
          ON variable_set.id = selected.id::uuid
         AND variable_set.account_id = p_account_id
         AND variable_set.status = 'active'
        WHERE version_value.id = (accepted -> 'resolvedRig' ->> 'versionId')::uuid
          AND version_value.rig_id = (accepted -> 'resolvedRig' ->> 'id')::uuid
          AND version_value.account_id = p_account_id
      )
    ) THEN RETURN 'scheduled_rig_default_variable_set_changed'; END IF;
  END IF;
  RETURN NULL;
END
$body$;

CREATE FUNCTION scheduled_scoped_rig_version_metadata(
  p_account_id uuid, p_workspace_id uuid, p_subject_id text,
  p_rig_id uuid, p_version_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  accessible_rig jsonb;
  result_value jsonb;
  health_value jsonb;
  health_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM nullif(
      current_setting('opengeni.subject_id', true), ''
    )
  THEN RAISE EXCEPTION 'scheduled scoped Rig metadata authority changed'
    USING ERRCODE = '42501'; END IF;

  SELECT value INTO accessible_rig
  FROM list_scoped_rigs(p_account_id, p_workspace_id, p_rig_id, null, null) value;
  IF accessible_rig IS NULL THEN RETURN NULL; END IF;

  SELECT candidate.check_health, candidate.verified_at INTO health_row
  FROM (
      SELECT CASE change.verification ->> 'passed'
          WHEN 'true' THEN 'passing' WHEN 'false' THEN 'failing' END AS check_health,
        coalesce(
          nullif(change.verification ->> 'finishedAt', '')::timestamptz,
          change.updated_at
        ) AS verified_at
      FROM rig_changes change
      WHERE change.account_id = p_account_id
        AND change.result_version_id = p_version_id
        AND change.verification ->> 'passed' IN ('true', 'false')
      UNION ALL
      SELECT CASE event.action WHEN 'rig.verification.passed' THEN 'passing'
          ELSE 'failing' END,
        event.occurred_at
      FROM audit_events event
      WHERE event.account_id = p_account_id
        AND event.target_type = 'rig'
        AND event.action IN ('rig.verification.passed', 'rig.verification.failed')
        AND event.metadata ->> 'versionId' = p_version_id::text
  ) candidate
  ORDER BY candidate.verified_at DESC
  LIMIT 1;
  health_value := jsonb_build_object(
    'checkHealth', coalesce(health_row.check_health, 'unknown'),
    'lastVerifiedAt', health_row.verified_at
  );

  SELECT jsonb_build_object(
      'name', rig.name,
      'version', jsonb_build_object(
        'id', version_value.id,
        'rigId', version_value.rig_id,
        'version', version_value.version,
        'image', version_value.image,
        'setupScript', version_value.setup_script,
        'checks', version_value.checks,
        'credentialHooks', version_value.credential_hooks,
        'defaultVariableSetIds', version_value.default_variable_set_ids,
        'changelog', version_value.changelog,
        'providerImages', version_value.provider_images,
        'createdBy', version_value.created_by,
        'active', version_value.active,
        'createdAt', version_value.created_at
      ),
      'health', health_value
    ) INTO result_value
  FROM rigs rig
  JOIN rig_versions version_value
    ON version_value.rig_id = rig.id
   AND version_value.account_id = rig.account_id
  WHERE rig.id = p_rig_id
    AND rig.account_id = p_account_id
    AND rig.status = 'active'
    AND version_value.id = p_version_id;
  RETURN result_value;
END
$body$;

CREATE FUNCTION scheduled_variable_set_expected_generation_for_attempt(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  run_snapshot jsonb;
  expected_generation bigint;
  expected_count integer;
  session_row record;
  turn_row record;
  attempt_row record;
  variable_set_row record;
  resolved_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled Variable Set attempt scope changed'
    USING ERRCODE = '42501'; END IF;
  -- Runtime materialization admission (0273): organization/workspace sets may
  -- be materialized by an exact pure-service attempt; user-scoped sets still
  -- resolve through the causal human and the personal-resource ledger below.
  PERFORM assert_scoped_variable_set_materialization_attempt(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  SELECT session_value.id, session_value.active_turn_id,
      session_value.variable_set_id, session_value.rig_id,
      session_value.rig_version_id
    INTO session_row
  FROM sessions session_value
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND OR session_row.active_turn_id IS DISTINCT FROM p_turn_id THEN
    RAISE EXCEPTION 'scheduled Variable Set attempt is not exact-current'
      USING ERRCODE = '42501';
  END IF;

  SELECT turn_value.id, turn_value.execution_generation,
      turn_value.active_attempt_id, turn_value.scheduled_task_run_id
    INTO turn_row
  FROM session_turns turn_value
  WHERE turn_value.id = p_turn_id
    AND turn_value.account_id = p_account_id
    AND turn_value.workspace_id = p_workspace_id
    AND turn_value.session_id = p_session_id
  FOR SHARE;
  IF NOT FOUND
    OR turn_row.execution_generation IS DISTINCT FROM p_execution_generation
    OR turn_row.active_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RAISE EXCEPTION 'scheduled Variable Set attempt is not exact-current'
    USING ERRCODE = '42501'; END IF;

  SELECT attempt.id, attempt.execution_generation, attempt.state INTO attempt_row
  FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = p_session_id
    AND attempt.turn_id = p_turn_id
  FOR SHARE;
  IF NOT FOUND
    OR attempt_row.execution_generation IS DISTINCT FROM p_execution_generation
    OR attempt_row.state NOT IN ('claimed','running')
  THEN RAISE EXCEPTION 'scheduled Variable Set attempt is not exact-current'
    USING ERRCODE = '42501'; END IF;

  IF turn_row.scheduled_task_run_id IS NULL THEN RETURN NULL; END IF;
  SELECT run.accepted_execution_snapshot INTO run_snapshot
  FROM scheduled_task_runs run
  WHERE run.id = turn_row.scheduled_task_run_id
    AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id
    AND run.session_id = p_session_id
  FOR SHARE;
  IF NOT FOUND OR run_snapshot IS NULL THEN
    RAISE EXCEPTION 'scheduled Variable Set run binding changed'
      USING ERRCODE = '42501';
  END IF;
  SELECT min(candidate.generation), count(DISTINCT candidate.generation)::integer
    INTO expected_generation, expected_count
  FROM (
    SELECT (run_snapshot -> 'resolvedVariableSet' ->> 'generation')::bigint AS generation
    WHERE run_snapshot -> 'targetSessionExecution' = 'null'::jsonb
      AND run_snapshot -> 'resolvedVariableSet' ->> 'id' = p_variable_set_id::text
    UNION ALL
    SELECT (item ->> 'generation')::bigint
    FROM jsonb_array_elements(
      coalesce(run_snapshot -> 'resolvedRig' -> 'defaultVariableSets', '[]'::jsonb)
    ) item
    WHERE item ->> 'id' = p_variable_set_id::text
    UNION ALL
    SELECT (run_snapshot -> 'targetSessionExecution' ->> 'variableSetGeneration')::bigint
    WHERE run_snapshot -> 'targetSessionExecution' <> 'null'::jsonb
      AND run_snapshot -> 'targetSessionExecution' ->> 'variableSetId' = p_variable_set_id::text
    UNION ALL
    SELECT (item ->> 'generation')::bigint
    FROM jsonb_array_elements(coalesce(
      run_snapshot -> 'targetSessionExecution' -> 'rigDefaultVariableSets',
      '[]'::jsonb
    )) item
    WHERE item ->> 'id' = p_variable_set_id::text
  ) candidate;
  IF expected_count <> 1 OR expected_generation IS NULL THEN
    RAISE EXCEPTION 'scheduled Variable Set has no exact accepted generation'
      USING ERRCODE = '42501';
  END IF;
  SELECT variable_set.id, variable_set.generation, variable_set.status,
      variable_set.authority_scope, variable_set.workspace_id,
      variable_set.authority_id
    INTO variable_set_row
  FROM workspace_variable_sets variable_set
  WHERE variable_set.id = p_variable_set_id
    AND variable_set.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND OR variable_set_row.status <> 'active'
    OR variable_set_row.generation IS DISTINCT FROM expected_generation
  THEN RAISE EXCEPTION 'scheduled Variable Set generation changed after claim'
    USING ERRCODE = '42501'; END IF;
  IF session_row.variable_set_id IS DISTINCT FROM p_variable_set_id
    AND NOT EXISTS (
      SELECT 1 FROM rig_versions version_value
      WHERE version_value.id = session_row.rig_version_id
        AND version_value.rig_id = session_row.rig_id
        AND version_value.account_id = p_account_id
        AND coalesce(version_value.default_variable_set_ids, '[]'::jsonb)
          ? p_variable_set_id::text
      FOR SHARE
    )
  THEN RAISE EXCEPTION 'runtime Variable Set was not selected by the exact session'
    USING ERRCODE = '42501'; END IF;
  IF variable_set_row.authority_scope = 'workspace'
    AND variable_set_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN RAISE EXCEPTION 'workspace Variable Set is outside the runtime workspace'
    USING ERRCODE = '42501';
  ELSIF variable_set_row.authority_scope = 'user' THEN
    SELECT count(*)::integer INTO resolved_count
    FROM resolve_session_attempt_personal_resources(
      p_account_id, p_workspace_id, p_attempt_id
    ) resolved
    WHERE resolved.resource_kind = 'variable_set'
      AND resolved.resource_id = variable_set_row.id
      AND resolved.authority_id = variable_set_row.authority_id
      AND resolved.authority_generation = variable_set_row.generation;
    IF resolved_count <> 1 THEN
      RAISE EXCEPTION 'personal Variable Set grant is not exact or current'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN expected_generation;
END
$body$;

DO $scheduled_connection_live_posture$
DECLARE
  data_schema text := current_schema();
  signature text;
  table_name text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'freeze_scheduled_task_connection_authorities_inner(uuid,uuid,uuid,bigint)',
    'clone_scheduled_task_connection_authorities_inner(uuid,uuid,uuid,bigint,bigint)',
    'freeze_scheduled_task_personal_resources_0252(uuid,uuid,uuid,bigint)',
    'freeze_scheduled_task_personal_resources(uuid,uuid,uuid,bigint)',
    'clone_scheduled_task_personal_resource_authority(uuid,uuid,uuid,bigint,bigint)',
    'refresh_scheduled_task_personal_resources_clone_connections(uuid,uuid,uuid,bigint,bigint)',
    'admit_scheduled_agent_run_execution()',
    'create_scheduled_agent_run_with_admission(uuid,uuid,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
    'admit_scheduled_task_run_connection_authorities()',
    'fence_scheduled_task_run_connection_session_identity()',
    'fence_scheduled_task_connection_authority_execution_update()',
    'materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)',
    'bind_scheduled_task_run_connection_authorities(uuid,uuid,uuid,uuid)',
    'bind_scheduled_task_run_session(uuid,uuid,uuid,uuid)',
    'transition_scheduled_agent_run(uuid,uuid,uuid,uuid,uuid,text,text)',
    'scheduled_task_run_connection_authority_subject(uuid,uuid,uuid)',
    'scheduled_task_personal_resource_authority_subject(uuid,uuid,uuid,bigint)',
    'record_scheduled_task_revision_authority(uuid,uuid,uuid,bigint)',
    'clone_scheduled_task_revision_authority(uuid,uuid,uuid,bigint,bigint)',
    'scheduled_task_revision_authority_subject(uuid,uuid,uuid,bigint)',
    'scheduled_task_revision_authority_snapshot(uuid,uuid,uuid,bigint)',
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)',
    'scheduled_scoped_rig_version_metadata(uuid,uuid,text,uuid,uuid)',
    'scheduled_variable_set_expected_generation_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)',
    'fence_scheduled_agent_run_delete()',
    'fence_scheduled_occurrence_evidence_delete()',
    'fence_scheduled_task_tombstone()',
    'fence_scheduled_task_turn_run_identity()',
    'fence_scheduled_turn_execution_update()',
    'fence_scheduled_occurrence_update()',
    'settle_scheduled_run_from_terminal_turn()',
    'settle_scheduled_run_from_terminal_update()',
    'validate_scheduled_occurrence_accepted_execution()',
    'validate_scheduled_task_attempt_personal_resources()',
    'resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, public, pg_temp',
      data_schema, signature, data_schema
    );
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  END LOOP;
  -- The membership command keeps the stricter 0263 definer posture: it needs
  -- no extension schema, so `public` stays out of its resolution path.
  EXECUTE format(
    'ALTER FUNCTION %I.organization_membership_command(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.organization_membership_command(jsonb) FROM PUBLIC', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities() '
      || 'SET search_path = pg_catalog, %I, public, pg_temp', data_schema
  );
  REVOKE ALL ON FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities()
    FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.capture_accepted_turn_connection_authorities_0264()
    FROM PUBLIC;
  REVOKE ALL ON FUNCTION freeze_scheduled_task_personal_resources_0252(
    uuid, uuid, uuid, bigint
  ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION clone_scheduled_task_personal_resource_authority_0252(
    uuid, uuid, uuid, bigint, bigint
  ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION materialize_scheduled_task_reusable_session_from_run_0252(
    uuid, uuid, uuid, uuid, uuid, bigint, text
  ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION organization_membership_command_0263(jsonb) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE EXECUTE ON FUNCTION freeze_scheduled_task_personal_resources_0252(
      uuid, uuid, uuid, bigint
    ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION clone_scheduled_task_personal_resource_authority_0252(
      uuid, uuid, uuid, bigint, bigint
    ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION materialize_scheduled_task_reusable_session_from_run_0252(
      uuid, uuid, uuid, uuid, uuid, bigint, text
    ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION organization_membership_command_0263(jsonb)
      FROM opengeni_app;
    FOREACH signature IN ARRAY ARRAY[
      'freeze_scheduled_task_personal_resources(uuid,uuid,uuid,bigint)',
      'clone_scheduled_task_personal_resource_authority(uuid,uuid,uuid,bigint,bigint)',
      'refresh_scheduled_task_personal_resources_clone_connections(uuid,uuid,uuid,bigint,bigint)',
      'create_scheduled_agent_run_with_admission(uuid,uuid,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
      'materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)',
      'bind_scheduled_task_run_session(uuid,uuid,uuid,uuid)',
      'transition_scheduled_agent_run(uuid,uuid,uuid,uuid,uuid,text,text)',
      'scheduled_task_run_connection_authority_subject(uuid,uuid,uuid)',
      'scheduled_task_personal_resource_authority_subject(uuid,uuid,uuid,bigint)',
      'record_scheduled_task_revision_authority(uuid,uuid,uuid,bigint)',
      'clone_scheduled_task_revision_authority(uuid,uuid,uuid,bigint,bigint)',
      'scheduled_task_revision_authority_subject(uuid,uuid,uuid,bigint)',
      'scheduled_task_revision_authority_snapshot(uuid,uuid,uuid,bigint)',
      'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)',
      'scheduled_scoped_rig_version_metadata(uuid,uuid,text,uuid,uuid)',
      'scheduled_variable_set_expected_generation_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)',
      'organization_membership_command(jsonb)',
      'resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO opengeni_app', data_schema, signature);
    END LOOP;
    REVOKE DELETE ON TABLE scheduled_tasks, scheduled_task_runs FROM opengeni_app;
    FOREACH table_name IN ARRAY ARRAY[
      'scheduled_task_connection_authority_snapshots',
      'scheduled_task_run_connection_authority_snapshots',
      'scheduled_task_reusable_connection_materializations'
      ,'scheduled_task_revision_authorities'
    ] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM opengeni_app', data_schema, table_name);
    END LOOP;
  END IF;
END
$scheduled_connection_live_posture$;

COMMENT ON TABLE scheduled_task_connection_authority_snapshots IS
  'Credential-free immutable common-user Connection authority for one scheduled task revision.';
COMMENT ON TABLE scheduled_task_run_connection_authority_snapshots IS
  'Exact stable-occurrence copy bound once to the resulting scheduled session and logical turn.';
COMMENT ON TABLE scheduled_task_reusable_connection_materializations IS
  'Idempotent receipt for the first reusable-session authority revision and session binding.';
