-- deployment-mode: maintenance
-- Stop old API/control/turn workers; old binaries do not enforce exact accounts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'exact MCP accounts migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

-- SQL NULL is a historical/unbound receipt, never equivalent to an explicit
-- empty accepted selection. [] denies every connection route at use time.
ALTER TABLE sessions ADD COLUMN initial_mcp_account_bindings jsonb DEFAULT NULL
  CHECK (initial_mcp_account_bindings IS NULL OR jsonb_typeof(initial_mcp_account_bindings) = 'array');
ALTER TABLE session_turns ADD COLUMN mcp_account_bindings jsonb DEFAULT NULL
  CHECK (mcp_account_bindings IS NULL OR jsonb_typeof(mcp_account_bindings) = 'array');
ALTER TABLE session_system_updates ADD COLUMN mcp_account_bindings jsonb DEFAULT NULL
  CHECK (mcp_account_bindings IS NULL OR jsonb_typeof(mcp_account_bindings) = 'array');
ALTER TABLE session_system_update_outbox ADD COLUMN mcp_account_bindings jsonb DEFAULT NULL
  CHECK (mcp_account_bindings IS NULL OR jsonb_typeof(mcp_account_bindings) = 'array');

-- This helper validates evidence, not authority. Personal authority continues
-- through the sender snapshot capture and live 0478 membership/resource fences.
CREATE FUNCTION opengeni_private.validate_mcp_account_bindings(bindings jsonb, delegations jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE item jsonb; ref jsonb; key text; seen text[] := ARRAY[]::text[];
  pairs jsonb := '[]'::jsonb; pair jsonb;
BEGIN
  IF bindings IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(bindings) > 128 THEN
    RAISE EXCEPTION 'invalid MCP account bindings' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(bindings) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid MCP account binding' USING ERRCODE = '22023';
    END IF;
    FOREACH key IN ARRAY ARRAY['serverId','canonicalServerId','connectionId','originWorkspaceId',
      'subjectScope','accountLabel','providerDomain','kind'] LOOP
      IF jsonb_typeof(item -> key) IS DISTINCT FROM 'string' OR nullif(btrim(item ->> key),'') IS NULL THEN
        RAISE EXCEPTION 'invalid MCP account binding field %', key USING ERRCODE = '22023';
      END IF;
    END LOOP;
    PERFORM (item ->> 'connectionId')::uuid, (item ->> 'originWorkspaceId')::uuid;
    ref := item -> 'connectionRef';
    pair := jsonb_build_array(item ->> 'canonicalServerId',item ->> 'connectionId');
    IF length(item ->> 'serverId') > 256 OR length(item ->> 'canonicalServerId') > 256
      OR length(item ->> 'accountLabel') > 512 OR length(item ->> 'providerDomain') > 2048
      OR item ->> 'serverId' = ANY(seen)
      OR pairs @> jsonb_build_array(pair)
      OR item - ARRAY['serverId','canonicalServerId','connectionId','originWorkspaceId',
        'subjectScope','ownerSubjectId','accountLabel','providerDomain','kind','connectionRef',
        'connectionAuthorityGeneration'] <> '{}'::jsonb
      OR item ->> 'subjectScope' NOT IN ('workspace','subject')
      OR item ->> 'kind' NOT IN ('oauth2','api_key','app_install','delegated')
      OR NOT item ? 'ownerSubjectId'
      OR (item ->> 'subjectScope' = 'workspace' AND item -> 'ownerSubjectId' IS DISTINCT FROM 'null'::jsonb)
      OR (item ->> 'subjectScope' = 'subject' AND (jsonb_typeof(item -> 'ownerSubjectId') IS DISTINCT FROM 'string'
        OR length(btrim(item ->> 'ownerSubjectId')) NOT BETWEEN 1 AND 512))
      OR jsonb_typeof(ref) IS DISTINCT FROM 'object'
      OR ref ? 'authoritySource' OR ref ? 'hostBinding'
      OR ref - ARRAY['connectionId','provider','providerDomain','kind','scopes','resource',
        'selectedResources','subjectScope'] <> '{}'::jsonb
      OR ref ->> 'connectionId' IS DISTINCT FROM item ->> 'connectionId'
      OR ref ->> 'subjectScope' IS DISTINCT FROM item ->> 'subjectScope'
      OR ref ->> 'providerDomain' IS DISTINCT FROM item ->> 'providerDomain'
      OR ref ->> 'kind' IS DISTINCT FROM item ->> 'kind'
      OR (item ? 'connectionAuthorityGeneration' AND (
        jsonb_typeof(item -> 'connectionAuthorityGeneration') IS DISTINCT FROM 'number'
        OR (item ->> 'connectionAuthorityGeneration') !~ '^[1-9][0-9]*$'))
    THEN RAISE EXCEPTION 'invalid MCP account binding identity' USING ERRCODE = '22023'; END IF;
    IF item ->> 'subjectScope' = 'subject' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(delegations,'[]'::jsonb)) d
      WHERE d ->> 'serverId' = item ->> 'serverId'
        AND d ->> 'connectionId' = item ->> 'connectionId'
        AND d ->> 'originWorkspaceId' = item ->> 'originWorkspaceId'
        AND d ->> 'ownerSubjectId' = item ->> 'ownerSubjectId'
        AND d ->> 'providerDomain' = item ->> 'providerDomain'
        AND d ->> 'kind' = item ->> 'kind'
        AND d ->> 'connectionType' = 'mcp'
    ) THEN RAISE EXCEPTION 'MCP account binding requires exact sender delegation' USING ERRCODE = '42501'; END IF;
    seen := array_append(seen,item ->> 'serverId');
    pairs := pairs || jsonb_build_array(pair);
  END LOOP;
END $body$;

CREATE FUNCTION opengeni_private.fence_mcp_account_bindings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE document jsonb := to_jsonb(NEW); old_document jsonb; bindings jsonb; old_bindings jsonb;
  delegations jsonb; item jsonb; connection_row record; column_name text; run_bindings jsonb;
  visibility_cleanup boolean := false;
  inherited_bindings boolean := false;
BEGIN
  column_name := CASE WHEN TG_TABLE_NAME = 'sessions' THEN 'initial_mcp_account_bindings'
    ELSE 'mcp_account_bindings' END;
  IF TG_TABLE_NAME = 'scheduled_task_runs' THEN
    bindings := nullif(document #> '{accepted_execution_snapshot,mcpAccountBindings}','null'::jsonb);
    delegations := document #> '{accepted_execution_snapshot,personalConnectionDelegations}';
  ELSE
    bindings := nullif(document -> column_name,'null'::jsonb);
    delegations := document -> CASE WHEN TG_TABLE_NAME = 'sessions' THEN 'initial_personal_connection_delegations'
      ELSE 'personal_connection_delegations' END;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_document := to_jsonb(OLD);
    old_bindings := CASE WHEN TG_TABLE_NAME = 'scheduled_task_runs'
      THEN nullif(old_document #> '{accepted_execution_snapshot,mcpAccountBindings}','null'::jsonb)
      ELSE nullif(old_document -> column_name,'null'::jsonb) END;
    IF TG_TABLE_NAME = 'sessions' AND document ->> 'visibility' IS DISTINCT FROM old_document ->> 'visibility' THEN
      -- Match 0481's native visibility cleanup capability. A caller-set GUC
      -- alone cannot clear a receipt or re-enable legacy ambient fallback.
      IF (document ->> 'authority_epoch')::integer IS DISTINCT FROM (old_document ->> 'authority_epoch')::integer + 1
        OR document -> 'owner_subject_id' IS DISTINCT FROM old_document -> 'owner_subject_id'
        OR document -> 'owner_organization_membership_id' IS DISTINCT FROM old_document -> 'owner_organization_membership_id'
        OR document -> 'parent_turn_id' IS DISTINCT FROM old_document -> 'parent_turn_id'
        OR (bindings IS DISTINCT FROM old_bindings AND bindings IS DISTINCT FROM '[]'::jsonb)
      THEN RAISE EXCEPTION 'invalid MCP account visibility cleanup' USING ERRCODE = '42501'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_backend_pid()
          AND capability.transaction_id = pg_current_xact_id()
          AND capability.capability_id = nullif(current_setting('opengeni.session_visibility_write_capability',true),'')::uuid
      ) THEN RAISE EXCEPTION 'MCP account cleanup requires the visibility lifecycle capability' USING ERRCODE = '42501'; END IF;
      bindings := '[]'::jsonb;
      NEW := jsonb_populate_record(NEW,jsonb_build_object(column_name,bindings));
      visibility_cleanup := true;
    END IF;
    IF bindings IS DISTINCT FROM old_bindings AND NOT visibility_cleanup THEN
      RAISE EXCEPTION 'accepted MCP account bindings are immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM opengeni_private.validate_mcp_account_bindings(bindings,delegations);
  -- Only new execution acceptance validates live workspace identity. Updates
  -- and outbox rows carry already accepted causal evidence: revocation must
  -- not strand terminal settlement or delivery. Shape/immutability still apply
  -- to those carriers above; execution revalidates live authority below.
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('sessions','session_turns','scheduled_task_runs') THEN
    IF TG_TABLE_NAME = 'session_turns' AND document ->> 'scheduled_task_run_id' IS NOT NULL THEN
      SELECT nullif(r.accepted_execution_snapshot -> 'mcpAccountBindings','null'::jsonb)
      INTO run_bindings FROM scheduled_task_runs r
      WHERE r.id = (document ->> 'scheduled_task_run_id')::uuid
        AND r.account_id = NEW.account_id AND r.workspace_id = NEW.workspace_id FOR SHARE;
      IF NOT FOUND OR bindings IS DISTINCT FROM run_bindings THEN
        RAISE EXCEPTION 'scheduled turn differs from accepted MCP account bindings' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'session_turns'
      AND document ->> 'source' IN ('system','goal')
      AND document ->> 'status' = 'running'
    THEN
      -- Claim marks the exact delivered batch before inserting its turn (the
      -- delivery FK is deferred). A copied receipt is not new account admission.
      -- Require both the delivered carrier and its immutable causal turn; a
      -- caller-supplied lineage, actor, or matching account alone is insufficient.
      SELECT EXISTS (
        SELECT 1 FROM session_system_updates update_value
        JOIN session_turns origin ON origin.account_id = NEW.account_id
          AND origin.workspace_id = NEW.workspace_id
          AND origin.id::text = CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerTurnId'
            WHEN update_value.kind LIKE 'child_%'
              THEN update_value.lineage ->> 'parentTurnId'
            ELSE update_value.lineage ->> 'causalTurnId' END
          AND origin.session_id::text = CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerSessionId'
            ELSE document ->> 'session_id' END
        WHERE update_value.account_id = NEW.account_id
          AND update_value.workspace_id = NEW.workspace_id
          AND update_value.session_id = NEW.session_id
          AND update_value.state = 'delivered'
          AND update_value.delivered_turn_id = NEW.id
          AND update_value.mcp_account_bindings IS NOT DISTINCT FROM bindings
          AND origin.mcp_account_bindings IS NOT DISTINCT FROM bindings
          AND (coalesce(origin.initiating_human_subject_id,
            CASE WHEN origin.initiator_kind = 'subject' THEN origin.initiator_subject_id END)
            IS NOT DISTINCT FROM coalesce(NEW.initiating_human_subject_id,
              CASE WHEN NEW.initiator_kind = 'subject' THEN NEW.initiator_subject_id END)
            OR (
              -- Ordinary workspace-only agent messages execute as a service,
              -- not as the origin's human. Preserve that absence of personal
              -- authority without stranding delivery of the exact receipt.
              update_value.kind = 'agent_message'
              AND NEW.initiator_kind = 'service'
              AND NEW.initiating_human_subject_id IS NULL
              AND origin.personal_connection_delegations = '[]'::jsonb
              AND update_value.personal_connection_delegations = '[]'::jsonb
              AND delegations = '[]'::jsonb
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bindings) selected
                WHERE selected ->> 'subjectScope' IS DISTINCT FROM 'workspace')
            ))
      ) AND NOT EXISTS (
        SELECT 1 FROM session_system_updates update_value
        WHERE update_value.account_id = NEW.account_id
          AND update_value.workspace_id = NEW.workspace_id
          AND update_value.session_id = NEW.session_id
          AND update_value.state = 'delivered'
          AND update_value.delivered_turn_id = NEW.id
          AND update_value.mcp_account_bindings IS DISTINCT FROM bindings
      ) INTO inherited_bindings;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(bindings) LOOP
      IF item ->> 'subjectScope' = 'workspace' AND NOT inherited_bindings THEN
        SELECT c.* INTO connection_row FROM opengeni_private.read_sender_connection(
          NEW.account_id, NEW.workspace_id, (item ->> 'connectionId')::uuid, NULL) c;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'MCP workspace account missing' USING ERRCODE = '42501';
        END IF;
        IF item ->> 'originWorkspaceId' IS DISTINCT FROM NEW.workspace_id::text
          OR connection_row.authority_scope IS DISTINCT FROM 'workspace'
          OR connection_row.workspace_id IS DISTINCT FROM NEW.workspace_id
          OR connection_row.origin_workspace_id IS DISTINCT FROM NEW.workspace_id
          OR connection_row.status IS DISTINCT FROM 'active'
          OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(item ->> 'providerDomain')
          OR connection_row.kind IS DISTINCT FROM item ->> 'kind'
          OR (item ->> 'connectionAuthorityGeneration')::bigint IS DISTINCT FROM connection_row.authority_generation
        THEN RAISE EXCEPTION 'MCP workspace account identity changed' USING ERRCODE = '42501'; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $body$;

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT OR UPDATE ON session_turns
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT OR UPDATE ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT OR UPDATE ON session_system_update_outbox
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT OR UPDATE ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

DO $binding_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.fence_mcp_account_bindings() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $binding_path$;

-- Patch only a checked insertion point: preserve all sender, lock, replay,
-- attribution and revocation behavior in the installed resolver.
DO $resolver$
DECLARE definition text; anchor text := E'  IF reason IS NULL THEN\n    SELECT authority_snapshot.* INTO snapshot';
  insertion text;
BEGIN
  insertion := $gate$
  -- 0492 exact accepted account gate, inside the canonical lifecycle locks.
  IF reason IS NULL THEN
    SELECT value INTO exact_binding FROM jsonb_array_elements(turn_row.mcp_account_bindings)
    WHERE value ->> 'serverId' = p_server_id;
    IF FOUND THEN
      IF p_connection_id IS DISTINCT FROM (exact_binding ->> 'connectionId')::uuid
        OR p_subject_scope IS DISTINCT FROM exact_binding ->> 'subjectScope'
        OR p_owner_subject_id IS DISTINCT FROM exact_binding ->> 'ownerSubjectId'
        OR lower(p_provider_domain) IS DISTINCT FROM lower(exact_binding ->> 'providerDomain')
        OR p_connection_kind IS DISTINCT FROM exact_binding ->> 'kind'
      THEN reason := 'accepted_account_binding_changed';
      ELSE
        SELECT c.* INTO connection_row FROM opengeni_private.read_sender_connection(
          p_account_id, (exact_binding ->> 'originWorkspaceId')::uuid, p_connection_id,
          exact_binding ->> 'ownerSubjectId') c;
        IF NOT FOUND THEN reason := 'connection_missing';
        ELSIF connection_row.status IS DISTINCT FROM 'active' THEN reason := 'connection_status_inactive';
        ELSIF exact_binding ? 'connectionAuthorityGeneration' AND connection_row.authority_generation
          IS DISTINCT FROM (exact_binding ->> 'connectionAuthorityGeneration')::bigint
        THEN reason := 'connection_generation_changed';
        ELSIF p_subject_scope = 'workspace' AND (
          NOT exact_binding ? 'connectionAuthorityGeneration'
          OR exact_binding ->> 'originWorkspaceId' IS DISTINCT FROM p_workspace_id::text)
        THEN reason := 'accepted_account_binding_changed';
        END IF;
      END IF;
    ELSIF p_server_id = 'github:personal' AND p_subject_scope = 'subject'
      AND lower(p_provider_domain) = 'github.com' AND p_connection_kind = 'oauth2'
      AND EXISTS (
        SELECT 1 FROM turn_connection_authority_snapshots specialized
        WHERE specialized.account_id = p_account_id AND specialized.workspace_id = p_workspace_id
          AND specialized.session_id = p_session_id AND specialized.turn_id = p_turn_id
          AND specialized.server_id = p_server_id AND specialized.connection_id = p_connection_id
          AND specialized.authority_source = 'sender' AND specialized.authority_scope = 'user'
          AND specialized.owner_subject_id = p_owner_subject_id
      ) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(turn_row.personal_connection_delegations) selected
        WHERE selected ->> 'connectionType' = 'github_personal'
          AND selected ->> 'serverId' = p_server_id
          AND selected ->> 'connectionId' = p_connection_id::text
          AND selected ->> 'ownerSubjectId' = p_owner_subject_id
      ) THEN
      -- Git broker and GitHub REST use a separate repository-selection receipt,
      -- not a generic MCP alias. Continue into the existing snapshot-only lane
      -- below, including its digest, sender, membership and revocation checks.
      NULL;
    ELSIF turn_row.mcp_account_bindings IS NOT NULL OR p_server_id ~ '^account-[0-9a-f]{64}$' THEN
      reason := 'accepted_account_binding_required';
    END IF;
  END IF;
  IF reason IS NULL THEN
    SELECT authority_snapshot.* INTO snapshot$gate$;
  definition := pg_get_functiondef('resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1
    OR strpos(definition,'  scheduled_run_id uuid;') = 0 THEN
    RAISE EXCEPTION '0492 connection resolver prerequisite drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition,'  scheduled_run_id uuid;',E'  scheduled_run_id uuid;\n  exact_binding jsonb;');
  EXECUTE replace(definition,anchor,insertion);
END $resolver$;

-- Changing RETURNS TABLE requires recreation. Preserve the installed body and
-- its hardened search_path; role provisioning grants only the release role.
DO $outbox$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure);
  IF strpos(definition,'personal_connection_delegations jsonb') = 0
    OR strpos(definition,'o.personal_connection_delegations,') = 0 THEN
    RAISE EXCEPTION '0492 outbox claim prerequisite drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition,'personal_connection_delegations jsonb',
    'mcp_account_bindings jsonb, personal_connection_delegations jsonb');
  definition := replace(definition,'o.personal_connection_delegations,',
    'o.mcp_account_bindings, o.personal_connection_delegations,');
  DROP FUNCTION opengeni_private.claim_session_system_update_outbox(integer);
  EXECUTE definition;
END $outbox$;

REVOKE ALL ON FUNCTION opengeni_private.validate_mcp_account_bindings(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fence_mcp_account_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;