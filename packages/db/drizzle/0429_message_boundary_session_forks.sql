-- deployment-mode: maintenance
-- Drain API and both worker pools before updating the exact routine posture.
-- Add a message-boundary overload. Authority, locking, receipt replay and
-- destination creation retain the existing whole-session lifecycle; only the
-- selected boundary validation and history spool predicate differ.
CREATE OR REPLACE FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_source_event_id uuid)
 RETURNS TABLE(operation_id uuid, event_id uuid, event_sequence integer, session_id uuid, workspace_id uuid, visibility text, authority_epoch integer, copied_history_item_count integer, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  selected_event session_events%ROWTYPE;
  selected_turn_id uuid;
  boundary_position numeric;
  boundary_matches integer;
  actor_membership organization_memberships%ROWTYPE;
  source_session sessions%ROWTYPE;
  destination_workspace workspaces%ROWTYPE;
  receipt_row session_command_receipts%ROWTYPE;
  destination_session_id uuid;
  history_count integer := 0;
  destination_activity_revision bigint;
  destination_depth integer;
  destination_depth_source text;
  destination_resources jsonb := '[]'::jsonb;
  event_row_id uuid;
  public_destination_visibility text;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_gate_state text := current_setting('opengeni.session_activity_gate_state', true);
  previous_gate_workspace text := current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
BEGIN
  IF p_account_id IS NULL OR p_source_workspace_id IS NULL
    OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
    OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
    OR p_workspace_shared_acknowledged IS NULL
    OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
    OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session fork requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session fork authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_destination_workspace_id IS DISTINCT FROM p_source_workspace_id
    OR p_destination_visibility NOT IN ('user_private', 'workspace_shared')
    OR (p_destination_visibility = 'user_private' AND p_workspace_shared_acknowledged)
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session fork request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF nullif(previous_gate_state, '') IS NOT NULL
    OR nullif(previous_gate_workspace, '') IS NOT NULL
  THEN RAISE EXCEPTION 'session fork requires ownership of the activity gate'
    USING ERRCODE = '55000'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_source_workspace_id::text, 0
  ));

  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  SELECT * INTO destination_workspace FROM workspaces workspace_row
  WHERE workspace_row.account_id = p_account_id
    AND workspace_row.id = p_source_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_source_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_source_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session fork requires active workspace authority'
    USING ERRCODE = '42501'; END IF;

  -- Resolve an already-applied receipt before inspecting mutable source state.
  -- The same still-authorized workspace actor can therefore recover the exact
  -- destination after a lost response even if the source owner later makes the
  -- source private. A new key still reaches the current source authorization
  -- check below and is denied.
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
    AND receipt.result ->> 'status' = 'applied';
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- Product decision, distinct from authority, and the same one migration 0323
  -- makes on the create path: a private destination inside a shared workspace
  -- requires the organization's private-session setting. A personal workspace
  -- is exempt exactly as it is there. This is deliberately placed after the
  -- keyed replay above and before any source read, so a fork that already
  -- committed still replays byte-identically after an owner disables the
  -- setting, while a fresh key fails closed with the same SQLSTATE the create
  -- path raises.
  IF p_destination_visibility = 'user_private'
    AND actor_membership.personal_workspace_id IS DISTINCT FROM p_source_workspace_id
    AND NOT organization_private_sessions_enabled(p_account_id)
  THEN
    RAISE EXCEPTION
      'private sessions are not enabled for this organization''s shared workspaces'
      USING ERRCODE = '55000';
  END IF;

  SELECT session.* INTO source_session FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_source_workspace_id
    AND session.id = p_source_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork source session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  -- A private source remains owner-only. A workspace-shared source follows
  -- current workspace authority, and the fork becomes a fresh session owned
  -- by the actor. This is what lets any authorized collaborator fork shared
  -- work privately without retaining the source owner's authority.
  IF source_session.visibility = 'user_private' AND (
    source_session.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR source_session.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  )
  THEN RAISE EXCEPTION 'session fork source session is private'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
    'session.fork', p_source_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- The acknowledgement is content-exposure evidence, not a blanket checkbox:
  -- it is required only when private source content crosses into workspace scope.
  IF source_session.visibility = 'user_private'
    AND p_destination_visibility = 'workspace_shared'
    AND NOT p_workspace_shared_acknowledged
  THEN RAISE EXCEPTION 'private-to-workspace fork requires explicit acknowledgement'
    USING ERRCODE = '22023'; END IF;

  PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, true
  );

  SELECT coalesce(jsonb_agg(
    CASE WHEN resource.value ->> 'connectionType' = 'github_personal'
      THEN resource.value
        - 'provider' - 'connectionType' - 'credentialBindingId' - 'access'
        - 'repositoryId' - 'installationId' - 'projectId' - 'connectionId'
        - 'githubInstallationId' - 'githubRepositoryId'
      ELSE resource.value
        - 'credentialBindingId' - 'connectionId' - 'installationId'
        - 'projectId' - 'githubInstallationId'
    END
    ORDER BY resource.ordinality
  ), '[]'::jsonb) INTO destination_resources
  FROM jsonb_array_elements(source_session.resources)
    WITH ORDINALITY AS resource(value, ordinality);


  -- Authority, source locks, keyed replay, and quiescence have already been
  -- established by the unchanged lifecycle prefix. Never infer a history
  -- boundary from timestamps or manufacture model input from audit events.
  SELECT event.* INTO selected_event FROM session_events event
    WHERE event.account_id = p_account_id
      AND event.workspace_id = p_source_workspace_id
      AND event.session_id = p_source_session_id AND event.id = p_source_event_id
      AND event.type IN ('user.message', 'agent.message.completed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected message is not available for forking' USING ERRCODE = '22023';
  END IF;
  IF selected_event.type = 'user.message' THEN
    SELECT turn.id INTO selected_turn_id FROM session_turns turn
      WHERE turn.account_id = p_account_id AND turn.workspace_id = p_source_workspace_id
        AND turn.session_id = p_source_session_id AND turn.trigger_event_id = selected_event.id;
    SELECT min(history.position), count(*) INTO boundary_position, boundary_matches
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id AND history.turn_id = selected_turn_id
        AND history.item ->> 'role' = 'user';
  ELSE
    SELECT min(history.position), count(*) INTO boundary_position, boundary_matches
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id AND history.turn_id = selected_event.turn_id
        AND history.item ->> 'role' = 'assistant'
        AND CASE WHEN jsonb_typeof(history.item -> 'content') = 'array' THEN
          (SELECT string_agg(part.value ->> 'text', '' ORDER BY part.ordinality)
           FROM jsonb_array_elements(history.item -> 'content') WITH ORDINALITY part(value, ordinality)
           WHERE part.value ->> 'type' IN ('output_text', 'text'))
          ELSE history.item ->> 'content' END = selected_event.payload ->> 'text';
  END IF;
  IF boundary_matches <> 1 OR boundary_position IS NULL THEN
    RAISE EXCEPTION 'This message has no unambiguous retained conversation boundary' USING ERRCODE = '22023';
  END IF;
  -- Compaction can replace an earlier prefix with a summary containing later
  -- messages. Fail closed rather than leak those later messages into this fork.
  IF EXISTS (SELECT 1 FROM session_history_items history
    WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
      AND history.session_id = p_source_session_id
      AND (NOT history.active OR history.position <> trunc(history.position)
        OR history.item ->> 'type' = 'compaction')) THEN
    RAISE EXCEPTION 'Forking at a message is unavailable after conversation compaction' USING ERRCODE = '22023';
  END IF;
  -- A selected assistant message must not split an in-flight tool exchange.
  IF EXISTS (
    WITH prefix AS (
      SELECT history.position, history.item ->> 'type' AS item_type,
        (SELECT identity.value #>> '{}' FROM (VALUES
          (1, history.item -> 'callId'), (2, history.item -> 'call_id'),
          (3, history.item #> '{providerData,callId}'),
          (4, history.item #> '{providerData,call_id}'), (5, history.item -> 'id')
        ) AS identity(priority, value)
        WHERE jsonb_typeof(identity.value) = 'string' AND identity.value #>> '{}' <> ''
        ORDER BY identity.priority LIMIT 1) AS call_id
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id AND history.position <= boundary_position
    )
    SELECT 1 FROM prefix call
    WHERE call.item_type IN ('function_call', 'computer_call', 'shell_call', 'apply_patch_call', 'tool_search_call')
      AND NOT EXISTS (SELECT 1 FROM prefix result
        WHERE result.position > call.position AND result.call_id = call.call_id
          AND result.item_type = ANY (CASE call.item_type
            WHEN 'function_call' THEN ARRAY['function_call_result', 'function_call_output']
            WHEN 'computer_call' THEN ARRAY['computer_call_result', 'computer_call_output']
            WHEN 'shell_call' THEN ARRAY['shell_call_output']
            WHEN 'apply_patch_call' THEN ARRAY['apply_patch_call_output']
            WHEN 'tool_search_call' THEN ARRAY['tool_search_output']
          END))
  ) THEN
    RAISE EXCEPTION 'This message splits an unfinished tool exchange' USING ERRCODE = '22023';
  END IF;
  DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;

  CREATE TEMP TABLE opengeni_session_fork_history_spool (
    position numeric NOT NULL,
    item jsonb NOT NULL,
    item_codec_version integer,
    active boolean NOT NULL,
    provider_artifact_invalidated_at timestamptz,
    provider_artifact_invalidation_reason text,
    provider_artifact_invalidated_by_attempt_id uuid,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.opengeni_session_fork_history_spool (
    position, item, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT source_item.position, source_item.item,
      source_item.item_codec_version, source_item.active,
      source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id,
      source_item.created_at
    FROM session_history_items source_item
    WHERE source_item.account_id = p_account_id
      AND source_item.workspace_id = p_source_workspace_id
      AND source_item.session_id = p_source_session_id AND source_item.position <= boundary_position
    ORDER BY source_item.position;
  GET DIAGNOSTICS history_count = ROW_COUNT;

  SELECT coalesce(
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

  destination_session_id := gen_random_uuid();
  public_destination_visibility := CASE p_destination_visibility
    WHEN 'user_private' THEN 'private' ELSE 'workspace' END;
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    visibility_write_capability_id::text, true);
  PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    p_source_workspace_id::text, true);

  -- This one insert establishes fresh ownership, authority epoch, provenance,
  -- root identity and singleton sandbox group. No live source authority is copied.
  INSERT INTO sessions (
    id, account_id, workspace_id, status,
    initial_message, initial_message_codec_version,
    title, title_source, instructions, policy_role,
    resources, skills, tools, metadata,
    created_by_kind, created_by_subject_id, created_by_context,
    owner_organization_membership_id, owner_subject_id,
    visibility, create_requested_visibility, authority_epoch,
    forked_from_session_id, forked_from_authority_epoch,
    forked_from_visibility, forked_at, forked_by_organization_membership_id,
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
    queue_version, queue_head_position, queue_tail_position, last_sequence
  ) VALUES (
    destination_session_id, p_account_id, p_source_workspace_id, 'idle',
    source_session.initial_message, source_session.initial_message_codec_version,
    source_session.title, source_session.title_source,
    source_session.instructions, source_session.policy_role,
    destination_resources, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'subject', p_actor_subject_id, jsonb_build_object(
      'fork', true,
      'sourceSessionId', p_source_session_id, 'sourceEventId', p_source_event_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged
    ),
    actor_membership.id, actor_membership.subject_id,
    -- create_requested_visibility mirrors the destination the caller actually
    -- asked for. Leaving it at the column default made a private fork row
    -- internally inconsistent with its own visibility.
    p_destination_visibility, p_destination_visibility, 1,
    p_source_session_id, source_session.authority_epoch,
    source_session.visibility, clock_timestamp(), actor_membership.id,
    source_session.model, source_session.reasoning_effort, source_session.latency_mode,
    source_session.sandbox_backend, source_session.sandbox_os, destination_session_id,
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
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT p_account_id, p_source_workspace_id, destination_session_id, NULL,
      source_item.position, source_item.item, source_item.item_codec_version,
      source_item.active, source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at
    FROM pg_temp.opengeni_session_fork_history_spool source_item
    ORDER BY source_item.position;

  INSERT INTO session_events (
    account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  ) VALUES (
    p_account_id, p_source_workspace_id, destination_session_id, 1,
    'session.created', jsonb_build_object(
      'forked', true, 'sourceSessionId', p_source_session_id, 'sourceEventId', p_source_event_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'visibility', public_destination_visibility,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
      'copiedHistoryItemCount', history_count
    ), clock_timestamp()
  ) RETURNING id INTO event_row_id;

  PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = p_source_workspace_id
  RETURNING counter.revision INTO destination_activity_revision;
  IF destination_activity_revision IS NULL THEN
    RAISE EXCEPTION 'session fork destination activity counter is unavailable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE sessions destination_session SET
    activity_revision = destination_activity_revision,
    activity_revision_pending_xid = NULL
  WHERE destination_session.id = destination_session_id
    AND destination_session.activity_revision_pending_xid
      = pg_current_xact_id()::text::bigint;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork activity was not finalized'
    USING ERRCODE = '55000'; END IF;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;

  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = visibility_write_capability_id;
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id, 'eventSequence', 1,
    'sessionId', destination_session_id, 'workspaceId', p_source_workspace_id,
    'visibility', p_destination_visibility, 'authorityEpoch', 1,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
    'copiedHistoryItemCount', history_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id; event_sequence := 1;
  session_id := destination_session_id; workspace_id := p_source_workspace_id;
  visibility := p_destination_visibility; authority_epoch := 1;
  copied_history_item_count := history_count; replay := false;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_activity_gate_state',
    CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END, true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    CASE WHEN previous_gate_workspace IS NULL THEN '' ELSE previous_gate_workspace END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$function$;
-- Keep the same trusted schema path and owner as the existing authority seam,
-- including migrations executed in a dedicated test or deployment schema.
DO $posture$
DECLARE
  source_function regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure;
  destination_function regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  function_owner text;
  trusted_path text;
BEGIN
  SELECT pg_get_userbyid(proowner),
    (SELECT substr(setting, length('search_path=') + 1)
      FROM unnest(proconfig) setting WHERE setting LIKE 'search_path=%')
    INTO function_owner, trusted_path FROM pg_proc WHERE oid = source_function;
  IF trusted_path IS NULL THEN RAISE EXCEPTION 'fork authority search path is missing'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO %s', destination_function, trusted_path);
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I', destination_function, function_owner);
END
$posture$;
REVOKE ALL ON FUNCTION fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid) TO opengeni_app;
  END IF;
END
$grant$;
