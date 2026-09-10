-- deployment-mode: rolling
-- Existing callers already carry the accepted source revision and exact generated
-- session key. Materialization advances the canonical producer's row, so admit
-- its concurrent adopter only through the existing immutable source/target receipt.
-- No table, grant, caller, or runtime-posture contract changes; old binaries use
-- the same trigger and retain all subsequent live-authority revalidation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The routine template makes this DDL-only replacement explicit. Preserve the
-- installed header verbatim: the migration runner scopes its SECURITY DEFINER
-- search_path to the deployment schema. The body digest refuses an unexpected
-- predecessor, and exact body equality makes replay retain the same function.
DO $scheduled_generated_producer_materialization$
DECLARE
  definition text;
  current_body text;
  replacement_body text;
  routine_template constant text := $routine$
CREATE OR REPLACE FUNCTION fence_scheduled_task_run_connection_session_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
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
              -- 0414 exact reusable producer materialization receipt
              AND (
                (canonical_run.task_authority_revision = OLD.task_authority_revision
                  AND canonical_run.task_execution_digest = OLD.task_execution_digest)
                OR EXISTS (
                  SELECT 1 FROM scheduled_task_reusable_connection_materializations receipt
                  WHERE receipt.run_id = canonical_generated_run_id
                    AND receipt.account_id = OLD.account_id
                    AND receipt.workspace_id = OLD.workspace_id
                    AND receipt.task_id = OLD.task_id
                    AND receipt.session_id = NEW.session_id
                    AND receipt.source_task_authority_revision = OLD.task_authority_revision
                    AND receipt.source_execution_digest = OLD.task_execution_digest
                    AND receipt.target_task_authority_revision = canonical_run.task_authority_revision
                    AND receipt.target_execution_digest = canonical_run.task_execution_digest
                )
              )
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
$routine$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(oid), prosrc
  INTO definition, current_body
  FROM pg_catalog.pg_proc
  WHERE oid = 'fence_scheduled_task_run_connection_session_identity()'::regprocedure;
  replacement_body := pg_catalog.split_part(routine_template, '$body$', 2);
  IF current_body = replacement_body THEN
    RETURN;
  END IF;
  IF pg_catalog.md5(current_body) IS DISTINCT FROM '7f17f015767b56db14ba6630156fbb79' THEN
    RAISE EXCEPTION '0414 scheduled producer receipt prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, current_body, replacement_body);
END
$scheduled_generated_producer_materialization$;
