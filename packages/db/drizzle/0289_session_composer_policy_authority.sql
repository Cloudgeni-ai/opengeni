-- deployment-mode: maintenance
-- One-way authority cutover: session-default reasoning and latency become typed
-- columns. Established-session composer drafts and queued turns remain separate
-- exact authorities; metadata is no longer consulted for execution policy.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_policy_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'session policy authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_policy_writer_drain_before_lock$;

LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session_turns" IN SHARE MODE;

DO $session_policy_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'session policy authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_policy_writer_drain_after_lock$;

ALTER TABLE "sessions"
  ADD COLUMN "reasoning_effort" text,
  ADD COLUMN "latency_mode" text;

UPDATE "sessions" AS session
SET
  "reasoning_effort" = coalesce(
    CASE
      WHEN session."metadata" ->> 'reasoningEffort'
        IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
      THEN session."metadata" ->> 'reasoningEffort'
    END,
    (
      SELECT turn."reasoning_effort"
      FROM "session_turns" AS turn
      WHERE turn."workspace_id" = session."workspace_id"
        AND turn."session_id" = session."id"
      ORDER BY turn."created_at", turn."id"
      LIMIT 1
    ),
    'medium'
  ),
  "latency_mode" = coalesce(
    CASE
      WHEN session."metadata" ->> 'latencyMode' IN ('standard', 'priority', 'fast')
      THEN session."metadata" ->> 'latencyMode'
    END,
    (
      SELECT turn."latency_mode"
      FROM "session_turns" AS turn
      WHERE turn."workspace_id" = session."workspace_id"
        AND turn."session_id" = session."id"
      ORDER BY turn."created_at", turn."id"
      LIMIT 1
    ),
    'standard'
  );

ALTER TABLE "sessions"
  ALTER COLUMN "reasoning_effort" SET NOT NULL,
  ALTER COLUMN "latency_mode" SET NOT NULL,
  ADD CONSTRAINT "sessions_reasoning_effort_check" CHECK (
    "reasoning_effort" IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  ),
  ADD CONSTRAINT "sessions_latency_mode_check" CHECK (
    "latency_mode" IN ('standard', 'priority', 'fast')
  );

-- Fork copies the exact source session policy. Do not invent defaults.
DO $session_fork_activation$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.fork_session_content(
      p_account_id uuid,
      p_source_workspace_id uuid,
      p_source_session_id uuid,
      p_actor_subject_id text,
      p_destination_workspace_id uuid,
      p_destination_visibility text,
      p_operation_key text,
      p_canonical_request_hash text
    )
    RETURNS TABLE (
      operation_id uuid,
      session_id uuid,
      workspace_id uuid,
      visibility text,
      authority_epoch integer,
      copied_history_item_count integer,
      replay boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership organization_memberships%%ROWTYPE;
      source_session sessions%%ROWTYPE;
      destination_workspace workspaces%%ROWTYPE;
      receipt_row session_command_receipts%%ROWTYPE;
      destination_session_id uuid;
      destination_owner_id uuid;
      history_count integer := 0;
      destination_activity_revision bigint;
      destination_depth integer;
      destination_depth_source text;
      destination_resources jsonb := '[]'::jsonb;
      previous_workspace_id text := pg_catalog.current_setting('opengeni.workspace_id', true);
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      previous_gate_state text := pg_catalog.current_setting(
        'opengeni.session_activity_gate_state', true
      );
      previous_gate_workspace_id text := pg_catalog.current_setting(
        'opengeni.session_activity_gate_workspace_id', true
      );
      previous_visibility_marker text := pg_catalog.current_setting(
        'opengeni.session_visibility_write_capability', true
      );
      visibility_write_capability_id uuid := pg_catalog.gen_random_uuid();
    BEGIN
      IF p_account_id IS NULL OR p_source_workspace_id IS NULL
        OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
        OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
        OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
      THEN
        RAISE EXCEPTION 'session fork requires complete authority'
          USING ERRCODE = '42501';
      END IF;
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
      THEN
        RAISE EXCEPTION 'session fork authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      IF p_destination_visibility NOT IN ('user_private', 'workspace_shared')
        OR p_actor_subject_id <> pg_catalog.btrim(p_actor_subject_id)
        OR pg_catalog.length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
        OR p_operation_key <> pg_catalog.btrim(p_operation_key)
        OR pg_catalog.length(p_operation_key) NOT BETWEEN 1 AND 1024
        OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
      THEN
        RAISE EXCEPTION 'session fork request is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF nullif(previous_gate_state, '') IS NOT NULL
        OR nullif(previous_gate_workspace_id, '') IS NOT NULL
      THEN
        RAISE EXCEPTION 'session fork requires ownership of the activity gate'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(
          'session-fork-workspace:' || ordered_workspaces.lock_workspace_id::text
        )
      )
      FROM (
        SELECT DISTINCT requested.lock_workspace_id
        FROM (VALUES (p_source_workspace_id), (p_destination_workspace_id))
          AS requested(lock_workspace_id)
        ORDER BY requested.lock_workspace_id
      ) AS ordered_workspaces;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_source_workspace_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork source workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_destination_workspace_id::text, true
      );
      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_destination_workspace_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork destination workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );
      SELECT membership.* INTO actor_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_actor_subject_id
        AND membership.status = 'active'
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork requires active organization membership'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_memberships source_access
        WHERE source_access.account_id = p_account_id
          AND source_access.workspace_id = p_source_workspace_id
          AND source_access.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session fork source workspace access is unavailable'
          USING ERRCODE = '42501';
      END IF;
      SELECT session.* INTO source_session
      FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_source_workspace_id
        AND session.id = p_source_session_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork source session is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF source_session.visibility = 'user_private'
        AND source_session.owner_organization_membership_id <> actor_membership.id
      THEN
        RAISE EXCEPTION 'session fork source session is private'
          USING ERRCODE = '42501';
      END IF;

      SELECT coalesce(
        pg_catalog.jsonb_agg(
          CASE WHEN resource.value ->> 'kind' = 'repository'
            THEN resource.value
              - 'credentialBindingId'
              - 'connectionId'
              - 'installationId'
              - 'projectId'
              - 'githubInstallationId'
            ELSE resource.value
          END
          ORDER BY resource.ordinality
        ),
        '[]'::jsonb
      ) INTO destination_resources
      FROM pg_catalog.jsonb_array_elements(source_session.resources)
        WITH ORDINALITY AS resource(value, ordinality);

      DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;
      CREATE TEMP TABLE opengeni_session_fork_history_spool (
        position numeric NOT NULL,
        item jsonb NOT NULL,
        item_codec_version integer,
        active boolean NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT DROP;
      INSERT INTO opengeni_session_fork_history_spool (
        position, item, item_codec_version, active, created_at
      )
      SELECT source_item.position, source_item.item,
        source_item.item_codec_version, source_item.active, source_item.created_at
      FROM session_history_items source_item
      WHERE source_item.account_id = p_account_id
        AND source_item.workspace_id = p_source_workspace_id
        AND source_item.session_id = p_source_session_id
      ORDER BY source_item.position;
      GET DIAGNOSTICS history_count = ROW_COUNT;

      INSERT INTO session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, operation_key, canonical_request_hash
      ) VALUES (
        p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
        'session.fork', p_source_session_id, p_operation_key,
        p_canonical_request_hash
      ) ON CONFLICT DO NOTHING;
      SELECT receipt.* INTO receipt_row
      FROM session_command_receipts receipt
      WHERE receipt.workspace_id = p_source_workspace_id
        AND receipt.actor_type = 'human'
        AND receipt.actor_subject_id = p_actor_subject_id
        AND receipt.actor_attempt_id IS NULL
        AND receipt.action = 'session.fork'
        AND receipt.target_session_id = p_source_session_id
        AND receipt.target_turn_id IS NULL
        AND receipt.operation_key = p_operation_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork receipt is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
        RAISE EXCEPTION 'session fork idempotency conflict'
          USING ERRCODE = '23505';
      END IF;
      IF receipt_row.result ->> 'status' = 'applied' THEN
        operation_id := receipt_row.id;
        session_id := (receipt_row.result ->> 'sessionId')::uuid;
        workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
        visibility := receipt_row.result ->> 'visibility';
        authority_epoch := 1;
        copied_history_item_count :=
          (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
        replay := true;
        PERFORM pg_catalog.set_config(
          'opengeni.workspace_id',
          CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
          true
        );
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
        RETURN NEXT;
        RETURN;
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_destination_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_memberships destination_access
        WHERE destination_access.account_id = p_account_id
          AND destination_access.workspace_id = p_destination_workspace_id
          AND destination_access.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session fork destination workspace access is unavailable'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO destination_workspace
      FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_destination_workspace_id;

      SELECT
        coalesce(
          CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
            THEN (destination_workspace.settings ->> 'maxNestedAgentDepth')::integer END,
          configuration.max_nested_agent_depth
        ),
        CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
          THEN 'workspace' ELSE configuration.policy_source END
      INTO destination_depth, destination_depth_source
      FROM nested_agent_depth_configuration configuration
      WHERE configuration.singleton = true;
      IF destination_depth IS NULL OR destination_depth_source IS NULL THEN
        RAISE EXCEPTION 'session fork destination depth policy is unavailable'
          USING ERRCODE = '55000';
      END IF;

      destination_session_id := pg_catalog.gen_random_uuid();
      destination_owner_id := CASE WHEN p_destination_visibility = 'user_private'
        THEN actor_membership.id ELSE actor_membership.id END;
      INSERT INTO session_visibility_write_capabilities (
        backend_pid, transaction_id, capability_id
      ) VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.pg_current_xact_id(),
        visibility_write_capability_id
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        visibility_write_capability_id::text,
        true
      );
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'open', true);
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_workspace_id',
        p_destination_workspace_id::text,
        true
      );

      INSERT INTO sessions (
        id, account_id, workspace_id, status,
        initial_message, initial_message_codec_version,
        title, title_source, instructions, policy_role,
        resources, skills, tools, metadata,
        created_by_kind, created_by_subject_id, created_by_context,
        owner_organization_membership_id, owner_subject_id,
        visibility, authority_epoch,
        forked_from_session_id, forked_from_authority_epoch,
        forked_from_visibility, forked_at,
        forked_by_organization_membership_id,
        model, reasoning_effort, latency_mode, sandbox_backend, sandbox_os, sandbox_group_id,
        first_party_mcp_permissions, first_party_mcp_tools,
        initial_personal_connection_delegations, tool_policy,
        root_session_id, nested_agent_depth,
        max_nested_agent_depth_override, effective_max_nested_agent_depth,
        nested_agent_depth_policy_source, nested_agent_depth_policy_session_id,
        temporal_workflow_id, active_turn_id, variable_set_id,
        rig_id, rig_version_id, active_sandbox_id, active_epoch,
        working_dir, codex_pinned_credential_id, codex_last_credential_id,
        codex_pin_source, codex_compaction_mode,
        queue_version, queue_head_position, queue_tail_position,
        last_sequence
      ) VALUES (
        destination_session_id, p_account_id, p_destination_workspace_id, 'idle',
        source_session.initial_message, source_session.initial_message_codec_version,
        source_session.title, source_session.title_source,
        source_session.instructions, source_session.policy_role,
        destination_resources, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        'subject', p_actor_subject_id, '{"fork":true}'::jsonb,
        destination_owner_id, actor_membership.subject_id,
        p_destination_visibility, 1,
        p_source_session_id, source_session.authority_epoch,
        source_session.visibility, pg_catalog.clock_timestamp(), actor_membership.id,
        source_session.model, source_session.reasoning_effort, source_session.latency_mode,
        source_session.sandbox_backend,
        source_session.sandbox_os, destination_session_id,
        NULL, '[]'::jsonb, '[]'::jsonb,
        '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,
        destination_session_id, 0, NULL, destination_depth,
        destination_depth_source, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL,
        source_session.codex_compaction_mode,
        0, 0, 0, 1
      );

      INSERT INTO session_history_items (
        account_id, workspace_id, session_id, turn_id,
        position, item, item_codec_version, active,
        provider_artifact_invalidated_at,
        provider_artifact_invalidation_reason,
        provider_artifact_invalidated_by_attempt_id,
        created_at
      )
      SELECT p_account_id, p_destination_workspace_id, destination_session_id, NULL,
        source_item.position, source_item.item, source_item.item_codec_version,
        source_item.active, NULL, NULL, NULL, source_item.created_at
      FROM opengeni_session_fork_history_spool source_item
      ORDER BY source_item.position;

      INSERT INTO session_events (
        account_id, workspace_id, session_id, sequence, type, payload, occurred_at
      ) VALUES (
        p_account_id, p_destination_workspace_id, destination_session_id, 1,
        'session.created',
        pg_catalog.jsonb_build_object(
          'forked', true,
          'sourceSessionId', p_source_session_id,
          'sourceAuthorityEpoch', source_session.authority_epoch,
          'sourceVisibility', CASE source_session.visibility
            WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
          'visibility', CASE p_destination_visibility
            WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
          'copiedHistoryItemCount', history_count
        ),
        pg_catalog.clock_timestamp()
      );

      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'preparing', true);
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS sessions_activity_insert_commit_guard,
        sessions_activity_update_commit_guard DEFERRED;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'finalizing', true);
      UPDATE workspace_session_activity_revisions counter
      SET revision = counter.revision + 1
      WHERE counter.workspace_id = p_destination_workspace_id
      RETURNING counter.revision INTO destination_activity_revision;
      IF destination_activity_revision IS NULL THEN
        RAISE EXCEPTION 'session fork destination activity counter is unavailable'
          USING ERRCODE = '55000';
      END IF;
      UPDATE sessions destination_session
      SET activity_revision = destination_activity_revision,
          activity_revision_pending_xid = NULL
      WHERE destination_session.id = destination_session_id
        AND destination_session.activity_revision_pending_xid
          = pg_catalog.pg_current_xact_id()::text::bigint;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork destination activity was not finalized'
          USING ERRCODE = '55000';
      END IF;
      SET CONSTRAINTS sessions_activity_insert_commit_guard,
        sessions_activity_update_commit_guard IMMEDIATE;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', '', true);
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_workspace_id', '', true);
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        CASE WHEN previous_visibility_marker IS NULL THEN '' ELSE previous_visibility_marker END,
        true
      );
      DELETE FROM session_visibility_write_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id()
        AND capability.capability_id = visibility_write_capability_id;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      UPDATE session_command_receipts
      SET result = pg_catalog.jsonb_build_object(
            'status', 'applied',
            'sessionId', destination_session_id,
            'workspaceId', p_destination_workspace_id,
            'visibility', p_destination_visibility,
            'authorityEpoch', 1,
            'copiedHistoryItemCount', history_count
          ),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = receipt_row.id;

      operation_id := receipt_row.id;
      session_id := destination_session_id;
      workspace_id := p_destination_workspace_id;
      visibility := p_destination_visibility;
      authority_epoch := 1;
      copied_history_item_count := history_count;
      replay := false;
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_state',
        CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_workspace_id',
        CASE WHEN previous_gate_workspace_id IS NULL THEN '' ELSE previous_gate_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        CASE WHEN previous_visibility_marker IS NULL THEN '' ELSE previous_visibility_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$session_fork_activation$;
