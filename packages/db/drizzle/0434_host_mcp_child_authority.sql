-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0424 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0424 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0424 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
CREATE FUNCTION opengeni_private.guard_host_mcp_child_turn_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  s sessions%ROWTYPE;
  p sessions%ROWTYPE;
  t session_turns%ROWTYPE;
  a host_mcp_turn_authorities%ROWTYPE;
  d host_mcp_delegations%ROWTYPE;
  b host_mcp_bindings%ROWTYPE;
  membership jsonb;
  expected jsonb;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NEW.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'host child authority scope unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT value INTO membership FROM jsonb_array_elements(list_self_organization_memberships(NEW.owner_subject_id))
    WHERE value ->> 'organizationId' = NEW.account_id::text AND value ->> 'status' = 'active';
  IF membership IS NULL OR NOT (EXISTS (SELECT 1 FROM workspace_memberships w
    WHERE w.workspace_id = NEW.workspace_id AND w.subject_id = NEW.owner_subject_id)
    OR coalesce(membership ->> 'personalWorkspaceId' = NEW.workspace_id::text, false)) THEN
    RAISE EXCEPTION 'host child membership unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM sessions WHERE id = NEW.session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR s.parent_session_id IS NULL OR s.parent_turn_id IS NULL
    OR (s.visibility = 'user_private' AND s.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id) THEN
    RAISE EXCEPTION 'host child parent unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM sessions WHERE id = s.parent_session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR p.visibility <> s.visibility THEN
    RAISE EXCEPTION 'host child visibility changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM session_turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR t.status <> 'queued' OR t.active_attempt_id IS NOT NULL OR t.source NOT IN ('user','api')
    OR t.initiating_human_subject_id IS DISTINCT FROM NEW.owner_subject_id
    OR EXISTS (SELECT 1 FROM session_turns other WHERE other.session_id = s.id AND other.id <> t.id)
    OR EXISTS (SELECT 1 FROM session_turn_attempts attempt WHERE attempt.turn_id = t.id)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.tools) tool WHERE tool ->> 'kind' = 'mcp' AND tool ->> 'id' = NEW.server_id) THEN
    RAISE EXCEPTION 'host child initial turn unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM host_mcp_turn_authorities WHERE turn_id = s.parent_turn_id AND session_id = s.parent_session_id
    AND server_id = NEW.server_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id;
  IF NOT FOUND OR a.binding_id <> NEW.binding_id OR a.delegation_id <> NEW.delegation_id
    OR a.canonical_snapshot ->> 'targetSessionAuthorityEpoch' IS DISTINCT FROM p.authority_epoch::text
    OR a.canonical_snapshot ->> 'targetSessionVisibility' IS DISTINCT FROM p.visibility
    OR a.canonical_snapshot ->> 'ownerOrganizationMembershipId' IS DISTINCT FROM membership ->> 'id'
    OR a.canonical_snapshot ->> 'ownerMembershipAuthorizationRevision' IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host child source changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM host_mcp_delegations WHERE id = NEW.delegation_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR d.status <> 'active' OR d.revoked_at IS NOT NULL OR d.grant_definition ->> 'mode' <> 'always'
    OR d.generation::text IS DISTINCT FROM a.canonical_snapshot ->> 'delegationGeneration'
    OR d.owner_authorization_revision::text IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host child delegation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM host_mcp_bindings WHERE id = NEW.binding_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'active' OR b.revoked_at IS NOT NULL OR b.generation <> d.binding_generation
    OR b.generation::text IS DISTINCT FROM a.canonical_snapshot ->> 'bindingGeneration'
    OR b.definition IS DISTINCT FROM a.canonical_snapshot -> 'definition' THEN
    RAISE EXCEPTION 'host child binding unavailable' USING ERRCODE = '42501';
  END IF;
  expected := a.canonical_snapshot || jsonb_build_object('targetSessionId',s.id,
    'targetSessionAuthorityEpoch',s.authority_epoch,'targetSessionVisibility',s.visibility,
    'acceptedWork',jsonb_build_object('kind','turn','turnId',t.id),
    'source',jsonb_build_object('kind','child_turn','sessionId',p.id,'turnId',s.parent_turn_id));
  IF NEW.canonical_snapshot IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'host child authority is not an exact copy' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_child_turn_authority() FROM PUBLIC;
DROP TRIGGER host_mcp_turn_authority_guard ON host_mcp_turn_authorities;
CREATE TRIGGER host_mcp_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'inherited_turn'
    AND NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'scheduled_task'
    AND NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'child_turn')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_turn_authority();
CREATE TRIGGER host_mcp_child_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' = 'child_turn')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_child_turn_authority();
DO $drain$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0424 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;