-- deployment-mode: rolling
-- A fork is the same agent as its source: same tools, built-in tool selection
-- and policy, agent configuration, model and execution settings, provider
-- account authority and code search decision. Only its identity, ownership,
-- provenance, lifecycle state and history are its own.
--
-- Both fork routines (whole session and message boundary) used to insert the
-- new row from a fixed column list that wrote empty tools, empty metadata and
-- an explicit empty tool policy, and every session column added since then
-- fell back to its column default (agent configuration, provider snapshots,
-- scope subject, code search, Memory and agent access). The replacement starts
-- from the complete source row, so agent settings, including columns added
-- later, carry over, and overrides only what belongs to the new session or to
-- the person who created the source. packages/db/test/
-- session-fork-agent-parity-postgres.test.ts classifies every sessions column,
-- so a new column has to be placed on one side or the other.
--
-- Rolling: only the two SECURITY DEFINER routine bodies change. Their
-- signatures, results, receipts and events are unchanged, so older binaries
-- keep calling them exactly as before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $fork_agent_parity$
DECLARE
  whole_session constant regprocedure :=
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure;
  message_boundary constant regprocedure :=
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  declare_anchor constant text := E'  source_session sessions%ROWTYPE;\n';
  declare_addition constant text :=
    E'  destination_row sessions%ROWTYPE;\n  fork_same_creator boolean;\n';
  expected_old constant text := $old$  -- This one insert establishes fresh ownership, authority epoch, provenance,
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
      'sourceSessionId', p_source_session_id,__SOURCE_EVENT_CONTEXT__
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
$old$;
  replacement constant text := $new$  -- A fork is the same agent as its source. Start from the complete source row
  -- so every agent setting, including columns added later, carries over. Then
  -- replace only what belongs to the new session or to the person who created
  -- the source. session-fork-agent-parity-postgres.test.ts classifies every
  -- column; a new column must be placed on one side or the other.
  destination_row := source_session;
  -- Settings bound to the source's creator personally carry over only when
  -- that same person forks a top-level session they created.
  fork_same_creator := source_session.parent_session_id IS NULL
    AND source_session.created_by_kind = 'subject'
    AND source_session.created_by_subject_id = p_actor_subject_id;

  -- Identity, ownership and provenance of the new session.
  destination_row.id := destination_session_id;
  destination_row.account_id := p_account_id;
  destination_row.workspace_id := p_source_workspace_id;
  destination_row.created_at := now();
  destination_row.updated_at := now();
  destination_row.authority_inserted_at := transaction_timestamp();
  destination_row.created_by_kind := 'subject';
  destination_row.created_by_subject_id := p_actor_subject_id;
  destination_row.created_by_context := jsonb_build_object(
      'fork', true,
      'sourceSessionId', p_source_session_id,__SOURCE_EVENT_CONTEXT__
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged
    );
  destination_row.owner_organization_membership_id := actor_membership.id;
  destination_row.owner_subject_id := actor_membership.subject_id;
  -- Both visibility columns record the audience the fork's creator asked for;
  -- the source's creation request is its own history.
  destination_row.visibility := p_destination_visibility;
  destination_row.create_requested_visibility := p_destination_visibility;
  destination_row.authority_epoch := 1;
  destination_row.execution_authority_epoch := 1;
  destination_row.forked_from_session_id := p_source_session_id;
  destination_row.forked_from_authority_epoch := source_session.authority_epoch;
  destination_row.forked_from_visibility := source_session.visibility;
  destination_row.forked_at := clock_timestamp();
  destination_row.forked_by_organization_membership_id := actor_membership.id;
  destination_row.create_idempotency_key := NULL;
  destination_row.agent_creation_attempt_id := NULL;
  destination_row.imported_archive_import_id := NULL;
  destination_row.imported_archive_imported_at := NULL;
  destination_row.imported_archive_request_hash := NULL;
  destination_row.imported_archive_subject_id := NULL;
  destination_row.imported_archive_next_offset := NULL;
  -- Historical end-user labels; new sessions never write them.
  destination_row.end_user_source := NULL;
  destination_row.end_user_id := NULL;
  -- A Site audience is derived by the server for a Site conversation itself.
  destination_row.site_id := NULL;
  destination_row.site_access_root_id := NULL;
  destination_row.site_viewer_principal := NULL;
  destination_row.site_owner_subject_id := NULL;
  -- Metadata keeps the agent's settings (model, reasoning, execution policy,
  -- creation configuration). Links to a schedule run, a Site, or this
  -- session's own fork runtime receipt identify the source, not the agent.
  destination_row.metadata := source_session.metadata
    - 'scheduledTaskId' - 'scheduledTaskRunId' - 'opengeniPublishedSite'
    - '_opengeniSiteOrigin' - 'forkRuntimeConfiguration';

  -- A fork is the root of its own tree and keeps the nesting limit the source
  -- chose for itself; otherwise the destination workspace policy applies.
  destination_row.parent_session_id := NULL;
  destination_row.parent_turn_id := NULL;
  destination_row.root_session_id := destination_session_id;
  destination_row.nested_agent_depth := 0;
  destination_row.max_nested_agent_depth_override := CASE
    WHEN source_session.nested_agent_depth_policy_source = 'session'
    THEN source_session.effective_max_nested_agent_depth END;
  destination_row.effective_max_nested_agent_depth :=
    coalesce(destination_row.max_nested_agent_depth_override, destination_depth);
  destination_row.nested_agent_depth_policy_source := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN destination_depth_source ELSE 'session' END;
  destination_row.nested_agent_depth_policy_session_id := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN NULL ELSE destination_session_id END;

  -- A new session starts idle in its own sandbox group, with no runs, queue,
  -- controls, waits, archive or measurements of its own yet.
  destination_row.status := 'idle';
  destination_row.temporal_workflow_id := NULL;
  destination_row.active_turn_id := NULL;
  destination_row.execution_context_turn_id := NULL;
  destination_row.last_sequence := 1;
  destination_row.queue_version := 0;
  destination_row.queue_head_position := 0;
  destination_row.queue_tail_position := 0;
  destination_row.sandbox_group_id := destination_session_id;
  destination_row.active_sandbox_id := NULL;
  destination_row.active_epoch := 0;
  destination_row.working_dir := NULL;
  destination_row.codex_last_credential_id := NULL;
  destination_row.last_input_tokens := NULL;
  destination_row.compact_requested := false;
  destination_row.direct_control_state := 'active';
  destination_row.direct_pause_revision := NULL;
  destination_row.subtree_run_override_revision := NULL;
  destination_row.control_version := 0;
  destination_row.direct_control_reason := NULL;
  destination_row.direct_control_changed_by := NULL;
  destination_row.direct_control_changed_at := NULL;
  destination_row.activity_revision := 0;
  destination_row.activity_revision_pending_xid := NULL;
  destination_row.activity_xid := '0'::xid8;
  destination_row.input_wait_turn_id := NULL;
  destination_row.input_wait_until := NULL;
  destination_row.input_wait_reason := NULL;
  destination_row.input_wait_set_at := NULL;
  destination_row.admission_block := NULL;
  destination_row.content_archive_state := NULL;
  destination_row.content_archive_started_at := NULL;
  destination_row.content_archived_at := NULL;
  destination_row.content_archive := NULL;
  destination_row.content_archive_purged_at := NULL;
  -- Optimistic edit counter of this row's tool policy, not the policy itself.
  destination_row.tool_policy_version := 1;
  destination_row.resources := destination_resources;
  -- Variable Sets are retired; only an explicit fork runtime request may
  -- select runtime setup, and that path now refuses Variable Sets.
  destination_row.variable_set_ids := '[]'::jsonb;
  destination_row.variable_set_id := NULL;
  -- Another person's personal Rig stays with them.
  IF source_session.rig_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM rigs rig_row
    WHERE rig_row.account_id = p_account_id AND rig_row.id = source_session.rig_id
      AND rig_row.authority_scope = 'user'
      AND rig_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
  ) THEN
    destination_row.rig_id := NULL;
    destination_row.rig_version_id := NULL;
  END IF;

  -- What the source's creator accepted for the source's first turn stays with
  -- that turn. A fork starts no first turn and accepts no accounts of its own;
  -- each later turn resolves its own sender's connections and accounts.
  destination_row.initial_personal_connection_delegations := '[]'::jsonb;
  destination_row.initial_mcp_account_bindings := '[]'::jsonb;
  destination_row.initial_connection_account_intent := NULL;
  destination_row.initial_personal_resource_attachment_intent := NULL;
  -- Organization and workspace provider-account authority carries over; a
  -- personal pool belongs to the source's creator.
  IF source_session.initial_xai_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_xai_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  IF source_session.initial_claude_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_claude_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  -- A manual account pin is its creator's own choice; a policy pin is
  -- reassigned for the new session.
  IF NOT (fork_same_creator AND source_session.codex_pin_source = 'manual') THEN
    destination_row.codex_pinned_credential_id := NULL;
    destination_row.codex_pin_source := NULL;
  END IF;
  -- Agent scope binds to the person creating the session, exactly as create
  -- derives it. A user Memory selector needs that person.
  destination_row.scope_subject_id := CASE
    WHEN p_actor_subject_id ~ '^(user:|external_user:).+' THEN p_actor_subject_id END;
  IF destination_row.memory_scope = 'user' AND destination_row.scope_subject_id IS NULL THEN
    destination_row.memory_scope := 'off';
  END IF;

  INSERT INTO sessions SELECT (destination_row).*;

  -- Session-supplied MCP servers are part of the agent's tools. Headers the
  -- source's creator supplied are their credentials: another person's fork
  -- keeps only servers that carry none (public or connection-resolved ones).
  INSERT INTO session_mcp_servers
  SELECT (jsonb_populate_record(server_row, jsonb_build_object(
    'id', gen_random_uuid(), 'session_id', destination_session_id,
    'created_at', now(), 'updated_at', now()
  ))).*
  FROM session_mcp_servers server_row
  WHERE server_row.account_id = p_account_id
    AND server_row.workspace_id = p_source_workspace_id
    AND server_row.session_id = p_source_session_id
    AND (fork_same_creator OR server_row.headers_encrypted = '{}'::jsonb)
  ORDER BY server_row.created_at, server_row.server_id;
$new$;
  target regprocedure;
  event_context text;
  definition text;
  old_block text;
BEGIN
  FOREACH target IN ARRAY ARRAY[whole_session, message_boundary] LOOP
    event_context := CASE WHEN target = message_boundary
      THEN ' ''sourceEventId'', p_source_event_id,' ELSE '' END;
    definition := pg_get_functiondef(target);
    old_block := replace(expected_old, '__SOURCE_EVENT_CONTEXT__', event_context);
    IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1
      OR (length(definition) - length(replace(definition, declare_anchor, '')))
        / length(declare_anchor) <> 1
    THEN
      RAISE EXCEPTION 'session fork insert of % changed before 0855', target;
    END IF;
    definition := replace(definition, declare_anchor, declare_anchor || declare_addition);
    definition := replace(definition, old_block,
      replace(replacement, '__SOURCE_EVENT_CONTEXT__', event_context));
    EXECUTE definition;
  END LOOP;
END
$fork_agent_parity$;

DO $postflight$
DECLARE
  target regprocedure;
  definition text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    IF strpos(definition, 'destination_row := source_session;') = 0
      OR strpos(definition, 'INSERT INTO sessions SELECT (destination_row).*;') = 0
      OR strpos(definition, 'INSERT INTO session_mcp_servers') = 0
      OR strpos(definition, 'No live source authority is copied') > 0
    THEN
      RAISE EXCEPTION 'session fork agent parity was not installed for %', target;
    END IF;
  END LOOP;
END
$postflight$;
