-- deployment-mode: maintenance
-- Drain API/control/turn writers. After activation, use only context-aware writers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'receiver execution context requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

ALTER TABLE sessions ADD COLUMN execution_context_turn_id uuid REFERENCES session_turns(id) ON DELETE SET NULL;
ALTER TABLE session_turns ADD COLUMN execution_context_turn_id uuid REFERENCES session_turns(id);

-- Select only a proved, started request in the still-valid execution epoch.
-- A claim/started_at alone is insufficient: startup admission may have refused it.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE workspace uuid;
BEGIN
  FOR workspace IN SELECT DISTINCT workspace_id FROM sessions ORDER BY workspace_id LOOP
    PERFORM acquire_session_tenancy_fence(workspace);
    UPDATE sessions s SET execution_context_turn_id = (
      SELECT t.id FROM session_events e JOIN session_turns t
        ON t.id = e.turn_id AND t.account_id = s.account_id
        AND t.workspace_id = s.workspace_id AND t.session_id = s.id
      JOIN session_turn_attempts a ON a.id = e.turn_attempt_id AND a.turn_id = t.id
        AND a.account_id = s.account_id AND a.workspace_id = s.workspace_id AND a.session_id = s.id
      WHERE e.account_id = s.account_id AND e.workspace_id = s.workspace_id AND e.session_id = s.id
        AND e.type = 'turn.started' AND e.turn_association = 'current'
        AND t.source IN ('user','api') AND t.scheduled_task_run_id IS NULL
        AND a.authority_epoch BETWEEN s.execution_authority_epoch AND s.authority_epoch
      ORDER BY e.sequence DESC LIMIT 1
    ) WHERE s.workspace_id = workspace;
  END LOOP;
END $backfill$;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE FUNCTION opengeni_private.fence_session_execution_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.execution_context_turn_id IS NOT NULL THEN
      RAISE EXCEPTION 'a new session has no started execution context' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.execution_authority_epoch IS DISTINCT FROM OLD.execution_authority_epoch THEN
    NEW.execution_context_turn_id := NULL;
  ELSIF NEW.execution_context_turn_id IS DISTINCT FROM OLD.execution_context_turn_id THEN
    IF NEW.execution_context_turn_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM session_turns WHERE id = OLD.execution_context_turn_id) THEN
        RAISE EXCEPTION 'execution context is lifecycle-owned' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM session_turns t JOIN session_turn_attempts a
        ON a.id = t.active_attempt_id AND a.turn_id = t.id AND a.session_id = t.session_id
        AND a.workspace_id = t.workspace_id AND a.account_id = t.account_id
      JOIN session_events e ON e.turn_id = t.id AND e.turn_attempt_id = a.id
        AND e.account_id = t.account_id AND e.workspace_id = t.workspace_id AND e.session_id = t.session_id
      WHERE t.id = NEW.execution_context_turn_id AND t.session_id = NEW.id
        AND t.account_id = NEW.account_id AND t.workspace_id = NEW.workspace_id
        AND t.source IN ('user','api') AND t.scheduled_task_run_id IS NULL
        AND t.status = 'running' AND NEW.active_turn_id = t.id
        AND e.type = 'turn.started' AND e.turn_association = 'current'
        AND a.authority_epoch BETWEEN NEW.execution_authority_epoch AND NEW.authority_epoch
        AND NOT EXISTS (SELECT 1 FROM session_events earlier JOIN session_turn_attempts prior
          ON prior.id = earlier.turn_attempt_id AND prior.turn_id = earlier.turn_id
            AND prior.session_id = earlier.session_id AND prior.workspace_id = earlier.workspace_id
            AND prior.account_id = earlier.account_id
          WHERE earlier.account_id = e.account_id AND earlier.workspace_id = e.workspace_id
            AND earlier.session_id = e.session_id AND earlier.turn_id = e.turn_id
            AND earlier.type = 'turn.started' AND earlier.turn_association = 'current'
            AND earlier.sequence < e.sequence)
    ) THEN RAISE EXCEPTION 'execution context requires an exact started request' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER sessions_zz_execution_context BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_session_execution_context();

CREATE FUNCTION opengeni_private.advance_session_execution_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  -- Unqualified history/audit events are not proof that an accepted attempt started.
  IF NEW.type = 'turn.started' AND NEW.turn_association = 'current' AND NEW.turn_attempt_id IS NOT NULL
  THEN
    UPDATE sessions s SET execution_context_turn_id = NEW.turn_id
      FROM session_turns t JOIN session_turn_attempts a
        ON a.id = t.active_attempt_id AND a.turn_id = t.id AND a.session_id = t.session_id
          AND a.workspace_id = t.workspace_id AND a.account_id = t.account_id
      WHERE s.id = NEW.session_id AND s.workspace_id = NEW.workspace_id
        AND s.account_id = NEW.account_id AND t.id = NEW.turn_id AND t.session_id = s.id
        AND t.workspace_id = s.workspace_id AND t.account_id = s.account_id
        AND t.source IN ('user','api') AND t.scheduled_task_run_id IS NULL
        AND t.status = 'running' AND s.active_turn_id = t.id AND a.id = NEW.turn_attempt_id
        AND a.authority_epoch BETWEEN s.execution_authority_epoch AND s.authority_epoch
        AND NOT EXISTS (SELECT 1 FROM session_events e JOIN session_turn_attempts prior
          ON prior.id = e.turn_attempt_id AND prior.turn_id = e.turn_id
            AND prior.session_id = e.session_id AND prior.workspace_id = e.workspace_id
            AND prior.account_id = e.account_id
          WHERE e.account_id = NEW.account_id AND e.workspace_id = NEW.workspace_id
            AND e.session_id = NEW.session_id AND e.turn_id = NEW.turn_id
            AND e.type = 'turn.started' AND e.turn_association = 'current' AND e.sequence < NEW.sequence);
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER session_started_execution_context AFTER INSERT ON session_events
FOR EACH ROW WHEN (NEW.type = 'turn.started' AND NEW.turn_association = 'current')
EXECUTE FUNCTION opengeni_private.advance_session_execution_context();

CREATE FUNCTION opengeni_private.fence_inbox_execution_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE context session_turns%ROWTYPE; target sessions%ROWTYPE; human text; u record;
  origin session_turns%ROWTYPE; origin_session sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.execution_context_turn_id IS DISTINCT FROM OLD.execution_context_turn_id THEN
      RAISE EXCEPTION 'accepted execution context is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.execution_context_turn_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO target FROM sessions WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id
    AND account_id = NEW.account_id;
  SELECT * INTO context FROM session_turns WHERE id = NEW.execution_context_turn_id
    AND session_id = NEW.session_id AND workspace_id = NEW.workspace_id AND account_id = NEW.account_id;
  human := coalesce(context.initiating_human_subject_id,
    CASE WHEN context.initiator_kind = 'subject' THEN context.initiator_subject_id END);
  IF context.id IS NULL OR context.id = NEW.id OR target.execution_context_turn_id IS DISTINCT FROM context.id
    OR NEW.source NOT IN ('system','goal') OR NEW.status <> 'running' OR NEW.scheduled_task_run_id IS NOT NULL
    OR human IS NULL OR NEW.initiating_human_subject_id IS DISTINCT FROM human
    OR NEW.personal_connection_delegations IS DISTINCT FROM context.personal_connection_delegations
    OR NEW.mcp_account_bindings IS DISTINCT FROM context.mcp_account_bindings
    OR NEW.xai_provider_account_authority_snapshot IS DISTINCT FROM context.xai_provider_account_authority_snapshot
    OR NEW.claude_provider_account_authority_snapshot IS DISTINCT FROM context.claude_provider_account_authority_snapshot
    OR ((context.initiator_context ->> 'credentialRestriction' = 'developer_setup'
      OR context.metadata #>> '{turnExecutionPolicyV1,credentialRestriction}' = 'developer_setup')
      AND NEW.initiator_context ->> 'credentialRestriction' IS DISTINCT FROM 'developer_setup')
    OR EXISTS (SELECT 1 FROM external_link_turn_authorities WHERE turn_id = context.id)
    OR NOT EXISTS (SELECT 1 FROM session_system_updates WHERE delivered_turn_id = NEW.id AND state = 'delivered'
      AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id AND session_id = NEW.session_id)
  THEN RAISE EXCEPTION 'invalid receiving execution context' USING ERRCODE = '42501'; END IF;
  FOR u IN SELECT * FROM session_system_updates WHERE delivered_turn_id = NEW.id AND state = 'delivered'
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id AND session_id = NEW.session_id
  LOOP
    IF u.scheduled_task_run_id IS NOT NULL OR u.kind = 'agent_steer_instruction' THEN
      RAISE EXCEPTION 'control input cannot borrow receiving execution context' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO origin FROM session_turns t WHERE t.account_id = NEW.account_id AND t.workspace_id = NEW.workspace_id
      AND t.id::text = CASE WHEN u.kind = 'agent_message' THEN u.lineage ->> 'callerTurnId'
        WHEN u.kind LIKE 'child_%' THEN u.lineage ->> 'parentTurnId' ELSE u.lineage ->> 'causalTurnId' END
      AND t.session_id::text = CASE WHEN u.kind = 'agent_message' THEN u.lineage ->> 'callerSessionId'
        ELSE NEW.session_id::text END;
    IF u.kind = 'agent_message' OR u.kind LIKE 'child_%' THEN
      SELECT * INTO origin_session FROM sessions WHERE id = origin.session_id;
      IF origin.id IS NULL OR coalesce(origin.initiating_human_subject_id,
          CASE WHEN origin.initiator_kind = 'subject' THEN origin.initiator_subject_id END) IS DISTINCT FROM human
        OR EXISTS (SELECT 1 FROM external_link_turn_authorities WHERE turn_id = origin.id)
        OR u.lineage ? 'credentialRestriction' OR origin.initiator_context ? 'credentialRestriction'
        OR origin.metadata #>> '{turnExecutionPolicyV1,credentialRestriction}' IS NOT NULL
        OR origin_session.metadata #>> '{turnExecutionPolicyV1,credentialRestriction}' IS NOT NULL
        OR (u.kind = 'agent_message' AND (
          coalesce(u.lineage ->> 'callerAttemptId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          OR CASE WHEN jsonb_typeof(u.lineage -> 'callerExecutionGeneration') = 'number' THEN
            (u.lineage ->> 'callerExecutionGeneration')::numeric NOT BETWEEN 1 AND 9007199254740991
            OR mod((u.lineage ->> 'callerExecutionGeneration')::numeric, 1) <> 0
          ELSE true END))
      THEN RAISE EXCEPTION 'informational input has different execution authority' USING ERRCODE = '42501'; END IF;
    ELSE
      IF u.mcp_account_bindings IS DISTINCT FROM NEW.mcp_account_bindings
        OR u.personal_connection_delegations IS DISTINCT FROM NEW.personal_connection_delegations
        OR u.xai_provider_account_authority_snapshot IS DISTINCT FROM NEW.xai_provider_account_authority_snapshot
        OR u.claude_provider_account_authority_snapshot IS DISTINCT FROM NEW.claude_provider_account_authority_snapshot
        OR (u.kind IN ('goal_continuation','background_command_result','session_wait_timeout') AND (
          origin.id IS NULL OR coalesce(origin.initiating_human_subject_id,
            CASE WHEN origin.initiator_kind = 'subject' THEN origin.initiator_subject_id END) IS DISTINCT FROM human
          OR EXISTS (SELECT 1 FROM external_link_turn_authorities WHERE turn_id = origin.id)))
      THEN RAISE EXCEPTION 'causal input has different execution authority' USING ERRCODE = '42501'; END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $body$;
-- Run before the existing MCP receipt fence. Both validate every new context inference.
CREATE TRIGGER inbox_execution_context_fence BEFORE INSERT OR UPDATE ON session_turns
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_inbox_execution_context();

-- Preserve the installed 0501 sharing behavior and the legacy explicit-owner proof.
DO $mcp_fence$
DECLARE definition text;
  anchor text := '    FOR item IN SELECT value FROM jsonb_array_elements(bindings) LOOP';
BEGIN
  definition := pg_get_functiondef('opengeni_private.fence_mcp_account_bindings()'::regprocedure);
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'MCP receipt inheritance anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, $patch$
    IF TG_TABLE_NAME = 'session_turns' AND document ->> 'execution_context_turn_id' IS NOT NULL THEN
      inherited_bindings := true; -- validated by inbox_execution_context_fence
    END IF;
$patch$ || anchor);
END $mcp_fence$;

-- Retain exact personal receipts, including generations/epochs. Delivery must
-- not silently refresh revoked authority; the existing physical-use gate denies it.
DO $personal_receipts$
DECLARE definition text;
  anchor text := E'  FOR item IN\n    SELECT value FROM jsonb_array_elements(NEW.personal_connection_delegations)';
  insertion text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.capture_accepted_turn_connection_authorities()'::regprocedure);
  insertion := $patch$
  IF NEW.execution_context_turn_id IS NOT NULL THEN
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.personal_connection_delegations)
      WHERE value ->> 'connectionType' IS DISTINCT FROM 'social'
    LOOP
      IF NOT EXISTS (SELECT 1 FROM turn_connection_authority_snapshots source
        WHERE source.turn_id = NEW.execution_context_turn_id AND source.account_id = NEW.account_id
          AND source.workspace_id = NEW.workspace_id AND source.session_id = NEW.session_id
          AND source.server_id = item ->> 'serverId' AND source.connection_id::text = item ->> 'connectionId'
          AND source.owner_subject_id IS NOT DISTINCT FROM initiating_subject
          AND source.snapshot_digest = digest(convert_to(source.canonical_snapshot::text,'UTF8'),'sha256'))
      THEN RAISE EXCEPTION 'receiving connection receipt is unavailable' USING ERRCODE = '42501'; END IF;
    END LOOP;
    INSERT INTO turn_connection_authority_snapshots (
      account_id,workspace_id,session_id,turn_id,server_id,connection_id,connection_generation,
      origin_workspace_id,provider_domain,connection_kind,authority_scope,authority_source,owner_subject_id,
      owner_organization_membership_id,membership_authorization_revision,authority_id,authority_generation,
      grant_id,grant_generation,grant_mode,grant_context,grant_session_id,grant_authority_epoch,
      session_visibility,session_authority_epoch,canonical_snapshot,snapshot_digest)
    SELECT account_id,workspace_id,session_id,NEW.id,server_id,connection_id,connection_generation,
      origin_workspace_id,provider_domain,connection_kind,authority_scope,authority_source,owner_subject_id,
      owner_organization_membership_id,membership_authorization_revision,authority_id,authority_generation,
      grant_id,grant_generation,grant_mode,grant_context,grant_session_id,grant_authority_epoch,
      session_visibility,session_authority_epoch,
      jsonb_set(canonical_snapshot,'{acceptedWork}',jsonb_build_object('kind','turn','turnId',NEW.id)),
      digest(convert_to(jsonb_set(canonical_snapshot,'{acceptedWork}',jsonb_build_object('kind','turn','turnId',NEW.id))::text,'UTF8'),'sha256')
    FROM turn_connection_authority_snapshots WHERE turn_id = NEW.execution_context_turn_id
      AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id AND session_id = NEW.session_id;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true);
    RETURN NEW;
  END IF;
  FOR item IN
    SELECT value FROM jsonb_array_elements(NEW.personal_connection_delegations)
$patch$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'personal receipt inheritance anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, insertion);
END $personal_receipts$;

-- Explicit messages and Steer retain their real external restriction, including
-- revocation. The exact delivered command proves the cross-session source.
ALTER TABLE external_link_turn_authorities DROP CONSTRAINT external_link_turn_authorities_source_kind_check;
ALTER TABLE external_link_turn_authorities DROP CONSTRAINT external_link_turn_authorities_check;
ALTER TABLE external_link_turn_authorities ADD CHECK (source_kind IN ('direct','causal','child','scheduled','agent'));
ALTER TABLE external_link_turn_authorities ADD CHECK (
  (source_kind = 'direct' AND source_turn_id IS NULL AND source_task_id IS NULL AND source_task_revision IS NULL)
  OR (source_kind IN ('causal','child','agent') AND source_turn_id IS NOT NULL AND source_task_id IS NULL AND source_task_revision IS NULL)
  OR (source_kind = 'scheduled' AND source_turn_id IS NULL AND source_task_id IS NOT NULL AND source_task_revision > 0));
DO $external_inheritance$
DECLARE definition text;
  anchor text := '  ELSIF NEW.source_kind IN (''causal'',''child'') THEN';
  insertion text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.guard_external_link_work_snapshot()'::regprocedure);
  insertion := $patch$
  ELSIF NEW.source_kind = 'agent' THEN
    SELECT a.canonical_snapshot INTO source_snapshot FROM external_link_turn_authorities a
      WHERE a.turn_id = NEW.source_turn_id AND a.account_id = NEW.account_id AND a.workspace_id = NEW.workspace_id;
    IF source_snapshot IS DISTINCT FROM NEW.canonical_snapshot OR t.source NOT IN ('goal','system') OR t.status <> 'running'
      OR NOT EXISTS (
        SELECT 1 FROM session_system_updates u JOIN session_turns origin ON origin.id = NEW.source_turn_id
          AND origin.account_id = NEW.account_id AND origin.workspace_id = NEW.workspace_id
        WHERE u.account_id = NEW.account_id AND u.workspace_id = NEW.workspace_id AND u.session_id = NEW.session_id
          AND u.delivered_turn_id = NEW.turn_id AND u.state = 'delivered' AND u.delivered_history_item_id IS NOT NULL
          AND u.kind IN ('agent_message','agent_steer_instruction') AND u.lineage ->> 'callerTurnId' = origin.id::text
          AND u.lineage ->> 'callerSessionId' = origin.session_id::text)
    THEN RAISE EXCEPTION 'external link exact execution source unavailable' USING ERRCODE = '42501'; END IF;
  ELSIF NEW.source_kind IN ('causal','child') THEN
$patch$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'external link inheritance anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, insertion);
END $external_inheritance$;

REVOKE ALL ON FUNCTION opengeni_private.fence_session_execution_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.advance_session_execution_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fence_inbox_execution_context() FROM PUBLIC;
