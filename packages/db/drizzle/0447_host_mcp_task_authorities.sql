-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
-- Recording a revision reads and locks its exact organization membership.
-- Preserve native checks under a NOSUPERUSER migration owner with FORCE RLS.
-- Restore the constrained lifecycle marker on every return and exception.
DO $revision_membership_read$
DECLARE definition text; signature text;
BEGIN
  definition := pg_get_functiondef('record_scheduled_task_revision_authority(uuid,uuid,uuid,bigint)'::regprocedure);
  IF strpos(definition, 'resource_bearing boolean;') = 0
    OR strpos(definition, 'RETURN subject_value;') = 0 THEN
    RAISE EXCEPTION 'scheduled revision membership reader drifted' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, 'resource_bearing boolean;',
    'resource_bearing boolean; previous_membership_marker text := current_setting(''opengeni.organization_tenancy_lifecycle'', true);');
  definition := replace(definition, E'BEGIN\n', E'BEGIN\n  PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', ''personal_resource_grant_management'', true);\n');
  definition := replace(definition, 'RETURN NULL;',
    'PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', coalesce(previous_membership_marker, ''''), true); RETURN NULL;');
  definition := replace(definition, E'RETURN subject_value;\nEND',
    E'PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', coalesce(previous_membership_marker, ''''), true); RETURN subject_value;\nEXCEPTION WHEN OTHERS THEN\n  PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', coalesce(previous_membership_marker, ''''), true);\n  RAISE;\nEND');
  EXECUTE definition;
  -- Admission and physical-use revalidation read the same membership. Retain
  -- their exact native revision/workspace checks; do not add an owner bypass.
  FOREACH signature IN ARRAY ARRAY[
    'admit_scheduled_agent_run_execution()',
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF strpos(definition, E'DECLARE\n') = 0 OR strpos(definition, E'BEGIN\n') = 0
      OR strpos(definition, 'organization_memberships') = 0 THEN
      RAISE EXCEPTION 'scheduled membership reader drifted: %', signature USING ERRCODE = '55000';
    END IF;
    definition := regexp_replace(definition, E'DECLARE\n', E'DECLARE\n  previous_membership_marker text := current_setting(''opengeni.organization_tenancy_lifecycle'', true);\n');
    definition := regexp_replace(definition, E'BEGIN\n', E'BEGIN\n  PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', ''personal_resource_grant_management'', true);\n');
    definition := regexp_replace(definition, 'RETURN (NEW|NULL|''[^'']*'');',
      E'PERFORM set_config(''opengeni.organization_tenancy_lifecycle'', coalesce(previous_membership_marker, ''''), true); RETURN \\1;', 'g');
    -- An exception unwinds the statement/subtransaction and its LOCAL marker.
    EXECUTE definition;
  END LOOP;
END
$revision_membership_read$;
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0447 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0447 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0447 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
CREATE TABLE host_mcp_task_authorities (
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  task_authority_revision bigint NOT NULL CHECK (task_authority_revision > 0),
  server_id text NOT NULL CHECK (octet_length(server_id) BETWEEN 1 AND 1024),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  binding_id uuid NOT NULL REFERENCES host_mcp_bindings(id),
  delegation_id uuid NOT NULL REFERENCES host_mcp_delegations(id),
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot) = 'object' AND octet_length(canonical_snapshot::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, task_authority_revision, server_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE host_mcp_task_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_task_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY host_mcp_task_authorities_owner_scope ON host_mcp_task_authorities
  USING (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id())
  WITH CHECK (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id());
CREATE FUNCTION opengeni_private.guard_host_mcp_task_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  t scheduled_tasks%ROWTYPE;
  s sessions%ROWTYPE;
  d host_mcp_delegations%ROWTYPE;
  b host_mcp_bindings%ROWTYPE;
  membership jsonb;
  revision_authority jsonb;
  expected jsonb;
  target_context text := 'workspace_shared';
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NEW.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'host task authority scope unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT value INTO membership FROM jsonb_array_elements(list_self_organization_memberships(NEW.owner_subject_id))
    WHERE value ->> 'organizationId' = NEW.account_id::text AND value ->> 'status' = 'active';
  IF membership IS NULL OR NOT (EXISTS (
    SELECT 1 FROM workspace_memberships w WHERE w.workspace_id = NEW.workspace_id AND w.subject_id = NEW.owner_subject_id
  ) OR coalesce(membership ->> 'personalWorkspaceId' = NEW.workspace_id::text, false)) THEN
    RAISE EXCEPTION 'host task membership unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM scheduled_tasks WHERE id = NEW.task_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND authority_revision = NEW.task_authority_revision FOR SHARE;
  IF NOT FOUND OR t.deleted_at IS NOT NULL OR t.action ->> 'kind' <> 'agent_turn' THEN
    RAISE EXCEPTION 'host task revision unavailable' USING ERRCODE = '42501';
  END IF;
  revision_authority := scheduled_task_revision_authority_snapshot(NEW.account_id, NEW.workspace_id, NEW.task_id, NEW.task_authority_revision);
  IF revision_authority IS NULL OR revision_authority ->> 'subjectId' IS DISTINCT FROM NEW.owner_subject_id
    OR revision_authority ->> 'organizationMembershipId' IS DISTINCT FROM membership ->> 'id'
    OR revision_authority ->> 'membershipAuthorizationRevision' IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host task causal authority unavailable' USING ERRCODE = '42501';
  END IF;
  IF t.run_mode = 'existing_session' THEN
    SELECT * INTO s FROM sessions WHERE id = t.reusable_session_id AND workspace_id = NEW.workspace_id AND account_id = NEW.account_id FOR SHARE;
    IF NOT FOUND OR (s.visibility = 'user_private' AND s.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id) THEN
      RAISE EXCEPTION 'host task target unavailable' USING ERRCODE = '42501';
    END IF;
    target_context := s.visibility;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(
    CASE WHEN t.run_mode = 'existing_session' THEN s.tools ELSE t.agent_config -> 'tools' END
  ) tool WHERE tool ->> 'kind' = 'mcp' AND tool ->> 'id' = NEW.server_id) THEN
    RAISE EXCEPTION 'host task server is not selected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM host_mcp_delegations WHERE id = NEW.delegation_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR d.status <> 'active' OR d.revoked_at IS NOT NULL OR d.binding_id <> NEW.binding_id
    OR d.owner_authorization_revision::text IS DISTINCT FROM membership ->> 'authorizationRevision'
    OR d.grant_definition ->> 'context' IS DISTINCT FROM target_context
    OR (d.grant_definition ->> 'mode' = 'session' AND (t.run_mode <> 'existing_session'
      OR d.grant_definition ->> 'sessionId' IS DISTINCT FROM s.id::text
      OR d.grant_definition ->> 'expectedAuthorityEpoch' IS DISTINCT FROM s.authority_epoch::text)) THEN
    RAISE EXCEPTION 'host task delegation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM host_mcp_bindings WHERE id = NEW.binding_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'active' OR b.revoked_at IS NOT NULL OR b.generation <> d.binding_generation
    OR b.authorization_revision <> d.owner_authorization_revision OR b.definition ->> 'serverId' IS DISTINCT FROM NEW.server_id THEN
    RAISE EXCEPTION 'host task binding unavailable' USING ERRCODE = '42501';
  END IF;
  expected := jsonb_build_object('version',1,'accountId',NEW.account_id,'workspaceId',NEW.workspace_id,
    'taskId',t.id,'taskAuthorityRevision',t.authority_revision,'taskExecutionDigest',t.execution_digest,
    'ownerSubjectId',NEW.owner_subject_id,'ownerOrganizationMembershipId',membership ->> 'id',
    'ownerMembershipAuthorizationRevision',(membership ->> 'authorizationRevision')::bigint,
    'bindingId',b.id,'bindingGeneration',b.generation,'delegationId',d.id,'delegationGeneration',d.generation,
    'definition',b.definition,'context',target_context);
  IF NEW.canonical_snapshot IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'host task snapshot is not canonical' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER host_mcp_task_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_task_authorities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_task_authority();
REVOKE ALL ON TABLE host_mcp_task_authorities FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_task_authority() FROM PUBLIC;

CREATE FUNCTION opengeni_private.guard_host_mcp_scheduled_turn_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  t session_turns%ROWTYPE;
  s sessions%ROWTYPE;
  r scheduled_task_runs%ROWTYPE;
  a host_mcp_task_authorities%ROWTYPE;
  d host_mcp_delegations%ROWTYPE;
  b host_mcp_bindings%ROWTYPE;
  membership jsonb;
  expected jsonb;
  origin jsonb;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NEW.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR current_setting('opengeni.session_inference_claim', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'host scheduled turn scope unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT value INTO membership FROM jsonb_array_elements(list_self_organization_memberships(NEW.owner_subject_id))
    WHERE value ->> 'organizationId' = NEW.account_id::text AND value ->> 'status' = 'active';
  SELECT * INTO s FROM sessions WHERE id = NEW.session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR membership IS NULL OR (s.visibility = 'user_private' AND s.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id) THEN
    RAISE EXCEPTION 'host scheduled session authority unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM session_turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR t.source <> 'system' OR t.status <> 'running' OR t.execution_generation <> 1
    OR t.active_attempt_id IS NULL OR t.scheduled_task_run_id IS NULL
    OR t.initiating_human_subject_id IS DISTINCT FROM NEW.owner_subject_id
    OR EXISTS (SELECT 1 FROM session_turn_attempts attempt WHERE attempt.turn_id = t.id AND attempt.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'host scheduled turn unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM scheduled_task_runs WHERE id = t.scheduled_task_run_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND session_id = NEW.session_id FOR SHARE;
  IF NOT FOUND OR r.status <> 'dispatched' OR r.accepted_execution_snapshot IS NULL
    OR r.accepted_execution_snapshot ->> 'causalHumanSubjectId' IS DISTINCT FROM NEW.owner_subject_id
    OR validate_scheduled_agent_run_live_authority(NEW.account_id, NEW.workspace_id, r.id) IS NOT NULL THEN
    RAISE EXCEPTION 'host scheduled run authority unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM host_mcp_task_authorities WHERE task_id = r.task_id AND task_authority_revision = r.task_authority_revision
    AND server_id = NEW.server_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id
    AND owner_subject_id = NEW.owner_subject_id;
  IF NOT FOUND OR a.binding_id <> NEW.binding_id OR a.delegation_id <> NEW.delegation_id
    OR a.canonical_snapshot ->> 'taskExecutionDigest' IS DISTINCT FROM r.task_execution_digest
    OR a.canonical_snapshot ->> 'context' IS DISTINCT FROM s.visibility
    OR a.canonical_snapshot ->> 'ownerOrganizationMembershipId' IS DISTINCT FROM membership ->> 'id'
    OR a.canonical_snapshot ->> 'ownerMembershipAuthorizationRevision' IS DISTINCT FROM membership ->> 'authorizationRevision' THEN
    RAISE EXCEPTION 'host scheduled selection changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM host_mcp_delegations WHERE id = NEW.delegation_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR d.status <> 'active' OR d.revoked_at IS NOT NULL
    OR d.generation::text IS DISTINCT FROM a.canonical_snapshot ->> 'delegationGeneration'
    OR d.owner_authorization_revision::text IS DISTINCT FROM membership ->> 'authorizationRevision'
    OR (d.grant_definition ->> 'mode' = 'session' AND (
      d.grant_definition ->> 'sessionId' IS DISTINCT FROM s.id::text
      OR d.grant_definition ->> 'expectedAuthorityEpoch' IS DISTINCT FROM s.authority_epoch::text)) THEN
    RAISE EXCEPTION 'host scheduled delegation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM host_mcp_bindings WHERE id = NEW.binding_id AND account_id = NEW.account_id
    AND workspace_id = NEW.workspace_id AND owner_subject_id = NEW.owner_subject_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'active' OR b.revoked_at IS NOT NULL OR b.generation <> d.binding_generation
    OR b.generation::text IS DISTINCT FROM a.canonical_snapshot ->> 'bindingGeneration'
    OR b.definition IS DISTINCT FROM a.canonical_snapshot -> 'definition' THEN
    RAISE EXCEPTION 'host scheduled binding unavailable' USING ERRCODE = '42501';
  END IF;
  origin := jsonb_build_object('taskId',r.task_id,'taskAuthorityRevision',r.task_authority_revision,'runId',r.id);
  expected := (a.canonical_snapshot - ARRAY['taskId','taskAuthorityRevision','taskExecutionDigest','context'])
    || jsonb_build_object('targetSessionId',s.id,'targetSessionVisibility',s.visibility,'targetSessionAuthorityEpoch',s.authority_epoch,
      'acceptedWork',origin || jsonb_build_object('kind','scheduled_task'),'scheduledOrigin',origin,
      'source',jsonb_build_object('kind','scheduled_task'));
  IF NEW.canonical_snapshot IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'host scheduled snapshot is not canonical' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_scheduled_turn_authority() FROM PUBLIC;
DROP TRIGGER host_mcp_turn_authority_guard ON host_mcp_turn_authorities;
CREATE TRIGGER host_mcp_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'inherited_turn'
    AND NEW.canonical_snapshot #>> '{source,kind}' IS DISTINCT FROM 'scheduled_task')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_turn_authority();
CREATE TRIGGER host_mcp_scheduled_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities
  FOR EACH ROW WHEN (NEW.canonical_snapshot #>> '{source,kind}' = 'scheduled_task')
  EXECUTE FUNCTION opengeni_private.guard_host_mcp_scheduled_turn_authority();
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'host_mcp_task_authorities'::regclass AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE host_mcp_task_authorities FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0447 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;