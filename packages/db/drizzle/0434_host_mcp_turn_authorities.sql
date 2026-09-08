-- deployment-mode: maintenance
-- Direct-turn capture only. Runtime consumption and inherited admission are separate.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0421 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0421 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0421 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE host_mcp_turn_authorities (
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  server_id text NOT NULL CHECK (octet_length(server_id) BETWEEN 1 AND 1024),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_subject_id text NOT NULL,
  binding_id uuid NOT NULL REFERENCES host_mcp_bindings(id),
  delegation_id uuid NOT NULL REFERENCES host_mcp_delegations(id),
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot) = 'object' AND octet_length(canonical_snapshot::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (turn_id, server_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE host_mcp_turn_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_turn_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY session_visibility_isolation ON host_mcp_turn_authorities AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
CREATE POLICY host_mcp_turn_authorities_owner_scope ON host_mcp_turn_authorities
  USING (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id())
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id());

CREATE FUNCTION opengeni_private.guard_host_mcp_turn_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  s sessions%ROWTYPE;
  t session_turns%ROWTYPE;
  d host_mcp_delegations%ROWTYPE;
  b host_mcp_bindings%ROWTYPE;
  membership jsonb;
  expected jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'accepted host authority is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NEW.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'host authority scope unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT value INTO membership FROM jsonb_array_elements(list_self_organization_memberships(NEW.owner_subject_id))
    WHERE value ->> 'organizationId' = NEW.account_id::text AND value ->> 'status' = 'active';
  IF membership IS NULL OR NOT (EXISTS (
    SELECT 1 FROM workspace_memberships w WHERE w.workspace_id = NEW.workspace_id AND w.subject_id = NEW.owner_subject_id
  ) OR coalesce(membership ->> 'personalWorkspaceId' = NEW.workspace_id::text, false)) THEN
    RAISE EXCEPTION 'host authority membership unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM sessions WHERE id = NEW.session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR (s.visibility = 'user_private' AND s.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id) THEN
    RAISE EXCEPTION 'host authority session unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM session_turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'queued' OR t.active_attempt_id IS NOT NULL
    OR t.source NOT IN ('user','api') OR t.initiator_kind <> 'subject'
    OR t.initiator_subject_id <> NEW.owner_subject_id
    OR (t.initiating_human_subject_id IS NOT NULL AND t.initiating_human_subject_id <> NEW.owner_subject_id)
    OR t.initiator_context ?| ARRAY['via','viaTruncated','provenanceError','backfill']
    OR EXISTS (SELECT 1 FROM session_turn_attempts a WHERE a.turn_id = t.id AND a.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'host direct turn unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM host_mcp_delegations WHERE id = NEW.delegation_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR d.status <> 'active' OR d.revoked_at IS NOT NULL OR d.binding_id <> NEW.binding_id
    OR d.owner_authorization_revision::text IS DISTINCT FROM membership ->> 'authorizationRevision'
    OR d.grant_definition ->> 'context' IS DISTINCT FROM s.visibility
    OR (d.grant_definition ->> 'mode' = 'session' AND (
      d.grant_definition ->> 'sessionId' IS DISTINCT FROM s.id::text
      OR d.grant_definition ->> 'expectedAuthorityEpoch' IS DISTINCT FROM s.authority_epoch::text)) THEN
    RAISE EXCEPTION 'host delegation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM host_mcp_bindings WHERE id = NEW.binding_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'active' OR b.revoked_at IS NOT NULL
    OR b.generation <> d.binding_generation OR b.authorization_revision <> d.owner_authorization_revision
    OR b.definition ->> 'serverId' IS DISTINCT FROM NEW.server_id THEN
    RAISE EXCEPTION 'host binding unavailable' USING ERRCODE = '42501';
  END IF;
  expected := jsonb_build_object(
    'version', 1, 'accountId', NEW.account_id, 'workspaceId', NEW.workspace_id,
    'targetSessionId', s.id, 'targetSessionVisibility', s.visibility, 'targetSessionAuthorityEpoch', s.authority_epoch,
    'acceptedWork', jsonb_build_object('kind','turn','turnId',t.id),
    'bindingId', b.id, 'bindingGeneration', b.generation, 'definition', b.definition,
    'ownerSubjectId', NEW.owner_subject_id, 'ownerOrganizationMembershipId', membership ->> 'id',
    'ownerMembershipAuthorizationRevision', (membership ->> 'authorizationRevision')::bigint,
    'delegationId', d.id, 'delegationGeneration', d.generation, 'source', jsonb_build_object('kind','direct')
  );
  IF NEW.canonical_snapshot IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'host authority snapshot is not canonical' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER host_mcp_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_turn_authority();
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_turn_authority() FROM PUBLIC;
REVOKE ALL ON TABLE host_mcp_turn_authorities FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'host_mcp_turn_authorities'::regclass AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE host_mcp_turn_authorities FROM %I', target_role.rolname); END LOOP;
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE routine.oid = 'opengeni_private.guard_host_mcp_turn_authority()'::regprocedure AND privilege.grantee <> routine.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_turn_authority() FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0421 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;