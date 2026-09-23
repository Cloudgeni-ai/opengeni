-- deployment-mode: maintenance
-- Preserve exact host selections across same-session causal resumptions only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0446 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0446 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0446 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE FUNCTION opengeni_private.guard_host_mcp_inherited_turn_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  s sessions%ROWTYPE;
  t session_turns%ROWTYPE;
  prior host_mcp_turn_authorities%ROWTYPE;
  d host_mcp_delegations%ROWTYPE;
  b host_mcp_bindings%ROWTYPE;
  membership jsonb;
  expected jsonb;
  causal_id text;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NEW.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR current_setting('opengeni.session_inference_claim', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'host inherited authority scope unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT value INTO membership FROM jsonb_array_elements(list_self_organization_memberships(NEW.owner_subject_id))
    WHERE value ->> 'organizationId' = NEW.account_id::text AND value ->> 'status' = 'active';
  IF membership IS NULL OR NOT (EXISTS (
    SELECT 1 FROM workspace_memberships w WHERE w.workspace_id = NEW.workspace_id AND w.subject_id = NEW.owner_subject_id
  ) OR coalesce(membership ->> 'personalWorkspaceId' = NEW.workspace_id::text, false)) THEN
    RAISE EXCEPTION 'host inherited membership unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM sessions WHERE id = NEW.session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR (s.visibility = 'user_private' AND s.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id) THEN
    RAISE EXCEPTION 'host inherited session unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM session_turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR t.source NOT IN ('goal','system') OR t.status <> 'running'
    OR t.execution_generation <> 1 OR t.active_attempt_id IS NULL OR t.scheduled_task_run_id IS NOT NULL
    OR t.initiating_human_subject_id IS DISTINCT FROM NEW.owner_subject_id
    OR EXISTS (SELECT 1 FROM session_turn_attempts a WHERE a.turn_id = t.id AND a.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'host inherited turn unavailable' USING ERRCODE = '42501';
  END IF;
  causal_id := NEW.canonical_snapshot #>> '{source,turnId}';
  IF causal_id IS NULL OR causal_id = NEW.turn_id::text
    OR NEW.canonical_snapshot #>> '{source,sessionId}' IS DISTINCT FROM NEW.session_id::text THEN
    RAISE EXCEPTION 'host inherited source unavailable' USING ERRCODE = '42501';
  END IF;
  -- The canonical claim has already delivered the exact machine input. Never
  -- inherit from the latest turn, a creator, or an unconsumed queued notice.
  IF NOT EXISTS (SELECT 1 FROM session_system_updates u
    WHERE u.account_id = NEW.account_id AND u.workspace_id = NEW.workspace_id AND u.session_id = NEW.session_id
      AND u.delivered_turn_id = NEW.turn_id AND u.state = 'delivered' AND u.delivered_history_item_id IS NOT NULL
      AND ((u.kind = 'goal_continuation' AND u.lineage ->> 'causalTurnId' = causal_id)
        OR (u.kind IN ('child_terminal_result','child_requires_action','child_requires_action_resolved','child_paused','child_waiting_capacity','child_progress')
          AND u.lineage ->> 'parentTurnId' = causal_id))) THEN
    RAISE EXCEPTION 'host inherited causal delivery unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM host_mcp_turn_authorities WHERE turn_id = causal_id::uuid
    AND server_id = NEW.server_id AND session_id = NEW.session_id AND workspace_id = NEW.workspace_id
    AND account_id = NEW.account_id AND owner_subject_id = NEW.owner_subject_id;
  IF NOT FOUND OR prior.binding_id <> NEW.binding_id OR prior.delegation_id <> NEW.delegation_id
    OR prior.canonical_snapshot ->> 'targetSessionVisibility' IS DISTINCT FROM s.visibility
    OR prior.canonical_snapshot ->> 'targetSessionAuthorityEpoch' IS DISTINCT FROM s.authority_epoch::text
    OR prior.canonical_snapshot ->> 'ownerOrganizationMembershipId' IS DISTINCT FROM membership ->> 'id'
    OR prior.canonical_snapshot ->> 'ownerMembershipAuthorizationRevision' IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host inherited source changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM host_mcp_delegations WHERE id = NEW.delegation_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR d.status <> 'active' OR d.revoked_at IS NOT NULL OR d.binding_id <> NEW.binding_id
    OR d.generation::text IS DISTINCT FROM prior.canonical_snapshot ->> 'delegationGeneration'
    OR d.owner_authorization_revision::text IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host inherited delegation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM host_mcp_bindings WHERE id = NEW.binding_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'active' OR b.revoked_at IS NOT NULL OR b.generation <> d.binding_generation
    OR b.generation::text IS DISTINCT FROM prior.canonical_snapshot ->> 'bindingGeneration'
    OR b.definition IS DISTINCT FROM prior.canonical_snapshot -> 'definition'
    OR b.authorization_revision <> d.owner_authorization_revision THEN
    RAISE EXCEPTION 'host inherited binding unavailable' USING ERRCODE = '42501';
  END IF;
  expected := prior.canonical_snapshot || jsonb_build_object(
    'acceptedWork', jsonb_build_object('kind','turn','turnId',NEW.turn_id),
    'source', jsonb_build_object('kind','inherited_turn','sessionId',NEW.session_id,'turnId',causal_id));
  IF NEW.canonical_snapshot IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'host inherited authority is not an exact copy' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_inherited_turn_authority() FROM PUBLIC;
DROP TRIGGER host_mcp_turn_authority_guard ON host_mcp_turn_authorities;
CREATE TRIGGER host_mcp_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'inherited_turn')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_turn_authority();
CREATE TRIGGER host_mcp_inherited_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' = 'inherited_turn')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_inherited_turn_authority();
DO $drain$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0446 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;