-- deployment-mode: rolling
-- Personal-machine consent covers only the consenting human's actual agent
-- subtree. Keep the original grant and revalidate every causal parent snapshot;
-- no descendant grant is minted and other personal resources are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Parent IDs alone are app-writable on INSERT. Only the atomic agent-create
-- seam may INSERT the attempt witness; no function can stamp an existing row.
-- Existing/old-binary children have no witness and do not gain tree consent.
ALTER TABLE sessions ADD COLUMN agent_creation_attempt_id uuid;

CREATE FUNCTION guard_session_agent_creation_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.agent_creation_attempt_id IS NOT NULL
      AND current_user IS DISTINCT FROM pg_get_userbyid((
        SELECT relowner FROM pg_class WHERE oid = TG_RELID)) THEN
      RAISE EXCEPTION 'agent creation witness requires the exact creation seam' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.agent_creation_attempt_id IS DISTINCT FROM OLD.agent_creation_attempt_id
      OR (OLD.agent_creation_attempt_id IS NOT NULL AND (
        NEW.parent_session_id IS DISTINCT FROM OLD.parent_session_id
        OR NEW.parent_turn_id IS DISTINCT FROM OLD.parent_turn_id)) THEN
      RAISE EXCEPTION 'agent creation provenance is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION guard_session_agent_creation_provenance() FROM PUBLIC;
CREATE TRIGGER session_agent_creation_provenance_guard BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION guard_session_agent_creation_provenance();

CREATE FUNCTION create_agent_child_session(
  p_account uuid, p_workspace uuid, p_parent uuid,
  p_turn uuid, p_attempt uuid, p_generation integer, p_values jsonb
) RETURNS TABLE (id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
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
    'nested_agent_depth_policy_session_id','codex_compaction_mode','code_search_enabled','agent_config','status'
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
$$;
REVOKE ALL ON FUNCTION create_agent_child_session(uuid,uuid,uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
DO $creation_acl$
DECLARE role_name text;
BEGIN
  EXECUTE format('ALTER FUNCTION guard_session_agent_creation_provenance() SET search_path=pg_catalog,%I,pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION create_agent_child_session(uuid,uuid,uuid,uuid,uuid,integer,jsonb) SET search_path=pg_catalog,%I,pg_temp',current_schema());
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname <> current_user
    AND has_function_privilege(oid,'open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer)','EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION create_agent_child_session(uuid,uuid,uuid,uuid,uuid,integer,jsonb) TO %I',role_name);
  END LOOP;
END
$creation_acl$;

CREATE FUNCTION personal_machine_grant_covers_descendant(
  p_grant_id uuid, p_session_id uuid, p_turn_id uuid, p_enrollment_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  grant_row organization_user_resource_grants%ROWTYPE;
  owner_row organization_memberships%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  child_row sessions%ROWTYPE;
  parent_row sessions%ROWTYPE;
  visited uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Only the existing machine admission/dispatch helpers open this capability.
  IF NOT opengeni_private.scoped_compute_capability_active() THEN RETURN false; END IF;
  SELECT * INTO grant_row FROM organization_user_resource_grants
  WHERE id = p_grant_id
    AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND action = 'connected_machine.use' AND revoked_at IS NULL
    AND ((mode = 'session' AND status = 'active') OR (mode = 'once' AND status = 'consumed'))
    AND (expires_at IS NULL OR expires_at > clock_timestamp());
  IF grant_row.id IS NULL OR grant_row.session_id = p_session_id THEN RETURN false; END IF;

  SELECT * INTO owner_row FROM organization_memberships
  WHERE id = grant_row.owner_organization_membership_id AND account_id = grant_row.account_id
    AND status = 'active' AND revoked_at IS NULL;
  IF owner_row.id IS NULL OR NOT (owner_row.personal_workspace_id = grant_row.workspace_id
    OR EXISTS (SELECT 1 FROM workspace_memberships membership
      WHERE membership.account_id = grant_row.account_id
        AND membership.workspace_id = grant_row.workspace_id
        AND membership.subject_id = owner_row.subject_id)) THEN RETURN false; END IF;

  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  JOIN organization_user_resource_authorities authority ON authority.id = enrollment.authority_id
    AND authority.account_id = enrollment.account_id
    AND authority.organization_membership_id = enrollment.owner_organization_membership_id
    AND authority.resource_kind = 'connected_machine' AND authority.resource_id = enrollment.id
    AND authority.generation = enrollment.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = grant_row.account_id
    AND enrollment.authority_scope = 'user' AND enrollment.authority_id = grant_row.authority_id
    AND enrollment.owner_organization_membership_id = owner_row.id
    AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL;
  IF enrollment_row.id IS NULL THEN RETURN false; END IF;

  SELECT session.* INTO child_row FROM sessions session
  JOIN session_turns turn_value ON turn_value.session_id = session.id
    AND turn_value.account_id = session.account_id AND turn_value.workspace_id = session.workspace_id
  WHERE session.id = p_session_id AND session.account_id = grant_row.account_id
    AND session.workspace_id = grant_row.workspace_id AND turn_value.id = p_turn_id
    AND session.owner_organization_membership_id = owner_row.id
    AND session.owner_subject_id = owner_row.subject_id
    AND session.visibility = grant_row.context
    AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
      CASE WHEN turn_value.initiator_kind = 'subject'
        THEN nullif(btrim(turn_value.initiator_subject_id), '') END) = owner_row.subject_id;
  IF child_row.id IS NULL THEN RETURN false; END IF;

  LOOP
    IF child_row.id = ANY(visited) OR child_row.parent_session_id IS NULL
      OR child_row.parent_turn_id IS NULL OR child_row.agent_creation_attempt_id IS NULL THEN RETURN false; END IF;
    visited := array_append(visited, child_row.id);
    -- Parent IDs need a protected creation witness, not just immutable values.
    SELECT parent.* INTO parent_row FROM sessions parent
    JOIN session_turns causal ON causal.id = child_row.parent_turn_id
      AND causal.session_id = parent.id AND causal.account_id = parent.account_id
      AND causal.workspace_id = parent.workspace_id
    WHERE parent.id = child_row.parent_session_id AND parent.account_id = grant_row.account_id
      AND parent.workspace_id = grant_row.workspace_id
      AND parent.owner_organization_membership_id = owner_row.id
      AND parent.owner_subject_id = owner_row.subject_id
      AND coalesce(nullif(btrim(causal.initiating_human_subject_id), ''),
        CASE WHEN causal.initiator_kind = 'subject'
          THEN nullif(btrim(causal.initiator_subject_id), '') END) = owner_row.subject_id;
    IF parent_row.id IS NULL THEN RETURN false; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM session_attempt_connected_machine_authorizations snapshot
      JOIN sandboxes sandbox ON sandbox.id = snapshot.sandbox_id
        AND sandbox.account_id = grant_row.account_id AND sandbox.enrollment_id = p_enrollment_id
      WHERE snapshot.account_id = grant_row.account_id AND snapshot.workspace_id = grant_row.workspace_id
        AND snapshot.session_id = parent_row.id AND snapshot.turn_id = child_row.parent_turn_id
        AND snapshot.attempt_id = child_row.agent_creation_attempt_id
        AND snapshot.enrollment_id = p_enrollment_id
        AND snapshot.initiating_human_subject_id = owner_row.subject_id
        AND snapshot.owner_organization_membership_id = owner_row.id
        AND snapshot.membership_authorization_revision = owner_row.authorization_revision
        AND snapshot.authority_id = grant_row.authority_id
        AND snapshot.authority_generation = enrollment_row.generation
        AND snapshot.enrollment_generation = enrollment_row.generation
        AND snapshot.session_authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch
        AND snapshot.grant_id = grant_row.id AND snapshot.grant_generation = grant_row.generation
        AND snapshot.grant_mode = grant_row.mode
    ) THEN RETURN false; END IF;

    IF parent_row.id = grant_row.session_id THEN
      RETURN grant_row.authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch;
    END IF;
    child_row := parent_row;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION personal_machine_grant_covers_descendant(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- Owner moves made by current binaries use a logical-turn receipt rather than
-- a standing grant (0823). Descendants bind that SAME receipt. Its existing live
-- authority checks remain the single revocation source; no new consent is made.
CREATE FUNCTION personal_machine_turn_consent_covers_descendant(
  p_consent_id uuid, p_session_id uuid, p_turn_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  consent_row session_turn_machine_consents%ROWTYPE;
  child_row sessions%ROWTYPE;
  parent_row sessions%ROWTYPE;
  visited uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NOT opengeni_private.scoped_compute_capability_active() THEN RETURN false; END IF;
  SELECT * INTO consent_row FROM session_turn_machine_consents
  WHERE id = p_consent_id
    AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
  IF consent_row.id IS NULL OR consent_row.session_id = p_session_id
    OR NOT live_session_turn_machine_consent(consent_row.id) THEN RETURN false; END IF;
  -- If this source also has an exact-session grant, its tree is grant-derived.
  -- Do not use a turn-local move receipt to bypass that grant's revocation or
  -- expiry. This includes terminal grant rows: only an explicit new grant or a
  -- new execution-authority epoch can restore tree coverage in that case.
  IF EXISTS (
    SELECT 1 FROM organization_user_resource_grants grant_value
    JOIN sessions source ON source.id = consent_row.session_id
      AND source.account_id = consent_row.account_id AND source.workspace_id = consent_row.workspace_id
    WHERE grant_value.account_id = consent_row.account_id AND grant_value.workspace_id = consent_row.workspace_id
      AND grant_value.session_id = consent_row.session_id AND grant_value.authority_id = consent_row.authority_id
      AND grant_value.owner_organization_membership_id = consent_row.owner_organization_membership_id
      AND grant_value.action = 'connected_machine.use' AND grant_value.mode IN ('once','session')
      AND grant_value.authority_epoch BETWEEN source.execution_authority_epoch AND source.authority_epoch
  ) THEN RETURN false; END IF;
  SELECT session.* INTO child_row FROM sessions session
  JOIN session_turns turn_value ON turn_value.session_id = session.id
    AND turn_value.account_id = session.account_id AND turn_value.workspace_id = session.workspace_id
  WHERE session.id = p_session_id AND session.account_id = consent_row.account_id
    AND session.workspace_id = consent_row.workspace_id AND turn_value.id = p_turn_id
    AND session.owner_organization_membership_id = consent_row.owner_organization_membership_id
    AND session.owner_subject_id = consent_row.consenting_subject_id
    AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
      CASE WHEN turn_value.initiator_kind = 'subject'
        THEN nullif(btrim(turn_value.initiator_subject_id), '') END) = consent_row.consenting_subject_id;
  IF child_row.id IS NULL THEN RETURN false; END IF;
  LOOP
    IF child_row.id = ANY(visited) OR child_row.parent_session_id IS NULL
      OR child_row.parent_turn_id IS NULL OR child_row.agent_creation_attempt_id IS NULL THEN RETURN false; END IF;
    visited := array_append(visited, child_row.id);
    SELECT parent.* INTO parent_row FROM sessions parent
    JOIN session_turns causal ON causal.id = child_row.parent_turn_id
      AND causal.session_id = parent.id AND causal.account_id = parent.account_id
      AND causal.workspace_id = parent.workspace_id
    WHERE parent.id = child_row.parent_session_id AND parent.account_id = consent_row.account_id
      AND parent.workspace_id = consent_row.workspace_id
      AND parent.owner_organization_membership_id = consent_row.owner_organization_membership_id
      AND parent.owner_subject_id = consent_row.consenting_subject_id
      AND coalesce(nullif(btrim(causal.initiating_human_subject_id), ''),
        CASE WHEN causal.initiator_kind = 'subject'
          THEN nullif(btrim(causal.initiator_subject_id), '') END) = consent_row.consenting_subject_id;
    IF parent_row.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM session_attempt_machine_consents binding
      JOIN session_turn_attempts snapshot ON snapshot.id = binding.attempt_id
      WHERE binding.consent_id = consent_row.id AND snapshot.account_id = consent_row.account_id
        AND snapshot.workspace_id = consent_row.workspace_id AND snapshot.session_id = parent_row.id
        AND snapshot.turn_id = child_row.parent_turn_id
        AND snapshot.id = child_row.agent_creation_attempt_id
        AND snapshot.authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch
    ) THEN RETURN false; END IF;
    IF parent_row.id = consent_row.session_id THEN
      RETURN child_row.parent_turn_id = consent_row.turn_id;
    END IF;
    child_row := parent_row;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION personal_machine_turn_consent_covers_descendant(uuid, uuid, uuid) FROM PUBLIC;
DO $harden$
BEGIN
  EXECUTE format('ALTER FUNCTION personal_machine_grant_covers_descendant(uuid,uuid,uuid,uuid) SET search_path=pg_catalog,%I,pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION personal_machine_turn_consent_covers_descendant(uuid,uuid,uuid) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END
$harden$;

-- Extend only the machine-specific grant predicates. Source assertions keep
-- the installed exact-session paths (including later lifecycle changes) intact.
DO $extend_machine_grants$
DECLARE
  signature text; definition text; old_predicate text; new_predicate text;
  scope_start integer; scope_end integer; session_expr text; turn_expr text;
  consume_guard text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'admit_session_attempt_personal_machine()',
    'authorize_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    scope_start := strpos(definition, '    AND (grant_value.context = session_row.visibility OR (');
    scope_end := strpos(definition, '  ORDER BY CASE grant_value.mode WHEN ''once'' THEN 1 WHEN ''session'' THEN 2 ELSE 3 END,');
    IF scope_start = 0 OR scope_end <= scope_start THEN
      RAISE EXCEPTION '0849 machine grant predicate drift: %', signature;
    END IF;
    old_predicate := substring(definition FROM scope_start FOR scope_end - scope_start);
    IF signature = 'admit_session_attempt_personal_machine()' THEN
      session_expr := 'NEW.session_id'; turn_expr := 'NEW.turn_id';
      consume_guard := 'IF grant_row.mode = ''once'' THEN';
    ELSE
      session_expr := 'p_session_id'; turn_expr := 'p_turn_id';
      consume_guard := 'IF affected = 1 AND grant_row.mode = ''once'' THEN';
    END IF;
    IF strpos(old_predicate, 'grant_value.session_id = ' || session_expr) = 0
      OR strpos(old_predicate, 'grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch') = 0
      OR (length(definition) - length(replace(definition, consume_guard, ''))) / length(consume_guard) <> 1 THEN
      RAISE EXCEPTION '0849 machine grant scope drift: %', signature;
    END IF;
    new_predicate := '    AND ((' || substring(old_predicate FROM 9) || ') OR personal_machine_grant_covers_descendant(grant_value.id, '
      || session_expr || ', ' || turn_expr || ', enrollment_row.id))' || chr(10);
    definition := replace(definition, old_predicate, new_predicate);
    -- An inherited once grant was consumed by the original logical turn. Its
    -- causal descendants reuse that exact proof; they never consume it again.
    definition := replace(definition, consume_guard,
      replace(consume_guard, ' THEN', ' AND grant_row.session_id = ' || session_expr || ' THEN'));
    EXECUTE definition;
  END LOOP;

  signature := 'assert_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean)';
  definition := pg_get_functiondef(signature::regprocedure);
  old_predicate := 'AND ((authorization_row.grant_mode = ''once'' AND grant_value.status = ''consumed''';
  IF (length(definition) - length(replace(definition, old_predicate, ''))) / length(old_predicate) <> 1 THEN
    RAISE EXCEPTION '0849 machine runtime predicate drift';
  END IF;
  EXECUTE replace(definition, old_predicate,
    'AND (personal_machine_grant_covers_descendant(grant_value.id, p_session_id, p_turn_id, p_enrollment_id) OR (authorization_row.grant_mode = ''once'' AND grant_value.status = ''consumed''');
END
$extend_machine_grants$;

CREATE FUNCTION pg_temp.install_tree_turn_consents() RETURNS void
LANGUAGE plpgsql AS $extend_turn_consents$
DECLARE definition text; before_text text; after_text text;
BEGIN
  definition := pg_get_functiondef('bind_session_attempt_machine_consent(uuid,uuid,uuid)'::regprocedure);
  before_text := $before$  SELECT consent.id INTO consent_id_value FROM session_turn_machine_consents consent
  JOIN sessions session ON session.id = p_session_id AND session.id = consent.session_id
    AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    AND session.active_sandbox_id = consent.sandbox_id
  WHERE consent.turn_id = p_turn_id ORDER BY consent.route_epoch DESC LIMIT 1;$before$;
  after_text := $after$  SELECT consent.id INTO consent_id_value FROM session_turn_machine_consents consent
  JOIN sessions session ON session.id = p_session_id
    AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    AND session.active_sandbox_id = consent.sandbox_id
  WHERE (consent.session_id = p_session_id AND consent.turn_id = p_turn_id)
    OR personal_machine_turn_consent_covers_descendant(consent.id, p_session_id, p_turn_id)
  ORDER BY (consent.session_id = p_session_id) DESC, consent.route_epoch DESC, consent.id LIMIT 1;$after$;
  IF (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1 THEN
    RAISE EXCEPTION '0849 turn-consent binding drift';
  END IF;
  EXECUTE replace(definition, before_text, after_text);

  definition := pg_get_functiondef('assert_session_attempt_machine_consent(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)'::regprocedure);
  before_text := E'AND consent.session_id = p_session_id\n    AND consent.turn_id = p_turn_id';
  after_text := E'AND ((consent.session_id = p_session_id AND consent.turn_id = p_turn_id)\n      OR personal_machine_turn_consent_covers_descendant(consent.id, p_session_id, p_turn_id))';
  IF (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1 THEN
    RAISE EXCEPTION '0849 turn-consent dispatch drift';
  END IF;
  EXECUTE replace(definition, before_text, after_text);
END
$extend_turn_consents$;
SELECT pg_temp.install_tree_turn_consents();
DROP FUNCTION pg_temp.install_tree_turn_consents();
