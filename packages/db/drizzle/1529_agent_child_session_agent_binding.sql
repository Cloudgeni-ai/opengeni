-- deployment-mode: rolling
-- An agent's worker chat can run as another agent (delegation by name,
-- session_create's agentName) or inherit its parent's organization agent.
-- Both write the chat's agent binding on create: agent_id and
-- agent_prompt_revision (1244) for a workspace agent; agent_id,
-- agent_version, agent_prompt_version and agent_overrides (1505) for an
-- organization agent. When the parent turn has an initiating person, the
-- child is inserted through create_agent_child_session, whose closed column
-- allow-list predates those columns, so every such create was refused with
-- 'agent child does not match its request claims' (42501).
--
-- The function is replaced with the same signature, owner, grants and pinned
-- search path; only those five columns join the allow-list. They are the
-- chat's agent configuration, already checked by the caller in the same
-- transaction (the agent is read under the person's row security), not
-- execution or authority state. The guard from 1244 still refuses any later
-- change of agent_id. The body is otherwise copied unchanged from the
-- baseline (0977_baseline_01), its latest definition.
--
-- Rolling: the previous release never sends these columns, and the
-- allow-list only grows, so every call it makes behaves as before.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION create_agent_child_session(p_account uuid, p_workspace uuid, p_parent uuid, p_turn uuid, p_attempt uuid, p_generation integer, p_values jsonb) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
DECLARE
  cap_added integer;
  caller_subject text := nullif(current_setting('opengeni.subject_id',true),'');
  -- An agent attempt's request subject is its worker principal; the API sets
  -- the attempt's verified initiating human separately. A direct human
  -- request has no actor and claims itself.
  claimed_human text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id',true)),''),caller_subject);
  turn_initiator_kind text;
  turn_initiator_subject text;
  child_id uuid;
  column_names text;
  allowed_columns constant text[] := ARRAY[
    'id','account_id','workspace_id','initial_message','initial_message_codec_version',
    'initial_model_context','title','title_source','resources','skills','tools','tool_policy',
    'metadata','mcp_approval_policies','created_by_kind','created_by_subject_id','created_by_context',
    'owner_organization_membership_id','owner_subject_id','model','reasoning_effort','latency_mode',
    'sandbox_backend','sandbox_os','sandbox_group_id','variable_set_ids','variable_set_id','rig_id',
    'rig_version_id','channel_id','first_party_mcp_permissions','first_party_mcp_tools',
    'initial_personal_connection_delegations','initial_mcp_account_bindings',
    'initial_connection_account_intent','initial_personal_resource_attachment_intent',
    'visibility','create_requested_visibility','initial_xai_provider_account_authority_snapshot',
    'initial_claude_provider_account_authority_snapshot','instructions','vault_policy','policy_role',
    'agent_access','scope_subject_id','end_user_source','end_user_id','memory_scope',
    'parent_session_id','parent_turn_id','create_idempotency_key','root_session_id','nested_agent_depth',
    'max_nested_agent_depth_override','effective_max_nested_agent_depth','nested_agent_depth_policy_source',
    'nested_agent_depth_policy_session_id','codex_compaction_mode','code_search_enabled','agent_config','status',
    'agent_id','agent_prompt_revision','agent_version','agent_prompt_version','agent_overrides'
  ];
BEGIN
  -- Like existing exact-session machine checks, this trusts claims set by the
  -- authenticated API. It does not claim to authenticate a compromised app role.
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_account IS NULL OR p_workspace IS NULL OR caller_subject IS NULL OR claimed_human IS NULL
    OR p_generation IS NULL OR p_generation < 1 THEN
    RAISE EXCEPTION 'exact agent creation scope required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'agent child creation values required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_values) key WHERE NOT key = ANY(allowed_columns))
    OR p_values->>'account_id' IS DISTINCT FROM p_account::text
    OR p_values->>'workspace_id' IS DISTINCT FROM p_workspace::text
    OR p_values->>'parent_session_id' IS DISTINCT FROM p_parent::text
    OR p_values->>'parent_turn_id' IS DISTINCT FROM p_turn::text
    OR (p_values ? 'owner_subject_id' AND p_values->>'owner_subject_id' IS DISTINCT FROM claimed_human)
    OR p_values->>'status' IS DISTINCT FROM 'idle' THEN
    RAISE EXCEPTION 'agent child does not match its request claims' USING ERRCODE = '42501';
  END IF;
  child_id := (p_values->>'id')::uuid;
  IF child_id IS NULL OR child_id = p_parent THEN
    RAISE EXCEPTION 'fresh agent child identity required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid,transaction_id,capability_kind)
    VALUES (pg_backend_pid(),pg_current_xact_id(),'write') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS cap_added = ROW_COUNT;
  IF p_values ? 'owner_organization_membership_id' AND NOT EXISTS (
    SELECT 1 FROM organization_memberships owner_value
    WHERE owner_value.account_id = p_account AND owner_value.subject_id = claimed_human
      AND owner_value.id::text = p_values->>'owner_organization_membership_id'
      AND owner_value.status = 'active' AND owner_value.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'agent child owner does not match request subject' USING ERRCODE = '42501';
  END IF;
  -- Use the same live attempt/turn/epoch/interruption fences as agent commands.
  -- These locks are already held by createSession's frozen-creator check.
  -- The covered human is the turn's recorded initiating human, so the owner's
  -- service-initiated turns (internal updates, goal continuations) qualify
  -- while another person's turns never match the owner's consent.
  SELECT turn_value.initiator_kind, turn_value.initiator_subject_id
  INTO turn_initiator_kind, turn_initiator_subject FROM sessions parent
  JOIN session_turns turn_value ON turn_value.account_id = parent.account_id
    AND turn_value.workspace_id = parent.workspace_id AND turn_value.session_id = parent.id
  JOIN session_turn_attempts attempt ON attempt.account_id = parent.account_id
    AND attempt.workspace_id = parent.workspace_id AND attempt.session_id = parent.id
    AND attempt.turn_id = turn_value.id
  WHERE parent.account_id = p_account AND parent.workspace_id = p_workspace AND parent.id = p_parent
    AND parent.active_turn_id = p_turn AND turn_value.id = p_turn
    AND turn_value.active_attempt_id = p_attempt AND attempt.id = p_attempt
    AND turn_value.execution_generation = p_generation AND attempt.execution_generation = p_generation
    AND turn_value.status IN ('running','requires_action','recovering','waiting_capacity')
    AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
    AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id),''),
      CASE WHEN turn_value.initiator_kind='subject'
        THEN nullif(btrim(turn_value.initiator_subject_id),'') END) = claimed_human
    AND attempt.authority_epoch BETWEEN parent.execution_authority_epoch AND parent.authority_epoch
    AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace AND interruption.attempt_id = p_attempt
        AND interruption.state IN ('pending','delivered','acknowledged'))
  FOR UPDATE OF turn_value, attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent creation attempt is stale or unauthorized' USING ERRCODE = '42501';
  END IF;
  -- The child is attributed to the exact frozen initiator of that turn, as
  -- createSession's frozen creator records it; nobody else may be named.
  IF p_values->>'created_by_kind' IS DISTINCT FROM turn_initiator_kind
    OR p_values->>'created_by_subject_id' IS DISTINCT FROM turn_initiator_subject THEN
    RAISE EXCEPTION 'agent child creator does not match its parent turn' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM sessions existing WHERE existing.id = child_id) THEN
    RAISE EXCEPTION 'agent creation cannot stamp an existing session' USING ERRCODE = '42501';
  END IF;
  -- Omitted values retain the table defaults, as with the ordinary INSERT.
  -- A closed column allowlist and typed populate_record avoid arbitrary SQL or
  -- writable execution/authority state. Provenance is added only here.
  p_values := p_values || jsonb_build_object('agent_creation_attempt_id',p_attempt);
  SELECT string_agg(format('%I',key),',' ORDER BY key) INTO column_names
    FROM jsonb_object_keys(p_values) key;
  RETURN QUERY EXECUTE format(
    'INSERT INTO %s AS inserted (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) '
    'ON CONFLICT DO NOTHING RETURNING inserted.id',
    'sessions'::regclass,column_names,column_names,'sessions'::regclass
  ) USING p_values;
  IF cap_added = 1 THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
      WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id() AND capability_kind = 'write';
  END IF;
END
$_$;

-- The same pinned search path as the baseline gave it.
DO $agent_child_search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION create_agent_child_session(uuid, uuid, uuid, uuid, uuid, integer, jsonb) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$agent_child_search_path$;
