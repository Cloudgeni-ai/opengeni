-- deployment-mode: rolling
-- Like a causal turn receipt, an already admitted scheduled occurrence copies
-- evidence, not live account authority. Keep the exact frozen bindings; actual
-- credential resolution and provider requests still require the live identity.
CREATE OR REPLACE FUNCTION opengeni_private.fence_mcp_account_bindings() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE document jsonb := to_jsonb(NEW); old_document jsonb; bindings jsonb; old_bindings jsonb;
  delegations jsonb; item jsonb; connection_row record; column_name text; run_bindings jsonb;
  run_session_id uuid;
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
    IF TG_TABLE_NAME = 'sessions' AND (document ->> 'visibility' IS DISTINCT FROM old_document ->> 'visibility'
      -- 0873: membership revocation clears delegations under the same capability.
      OR (delegations = '[]'::jsonb
        AND old_document -> 'initial_personal_connection_delegations' IS DISTINCT FROM '[]'::jsonb
        -- Without the capability every other write keeps its original refusal.
        AND EXISTS (
          SELECT 1 FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_backend_pid()
            AND capability.transaction_id = pg_current_xact_id()
            AND capability.capability_id = nullif(current_setting('opengeni.session_visibility_write_capability',true),'')::uuid))) THEN
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
      bindings := CASE WHEN document ->> 'visibility' = 'workspace_shared'
        AND old_document ->> 'visibility' IS DISTINCT FROM 'workspace_shared'
        THEN old_bindings ELSE '[]'::jsonb END;
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
      SELECT nullif(r.accepted_execution_snapshot -> 'mcpAccountBindings','null'::jsonb), r.session_id
      INTO run_bindings, run_session_id FROM scheduled_task_runs r
      WHERE r.id = (document ->> 'scheduled_task_run_id')::uuid
        AND r.account_id = NEW.account_id AND r.workspace_id = NEW.workspace_id FOR SHARE;
      IF NOT FOUND OR bindings IS DISTINCT FROM run_bindings THEN
        RAISE EXCEPTION 'scheduled turn differs from accepted MCP account bindings' USING ERRCODE = '42501';
      END IF;
      -- The claim marks the canonical occurrence delivered before inserting
      -- its turn (the delivery FK is deferred). A run ID alone is not proof.
      IF bindings IS NOT NULL AND document ->> 'source' = 'system'
        AND document ->> 'status' = 'running' AND run_session_id = NEW.session_id
      THEN
        SELECT EXISTS (
          SELECT 1 FROM session_system_updates occurrence
          WHERE occurrence.account_id = NEW.account_id
            AND occurrence.workspace_id = NEW.workspace_id
            AND occurrence.session_id = run_session_id
            AND occurrence.dedupe_key = 'scheduled-task-run:' || (document ->> 'scheduled_task_run_id')
            AND occurrence.scheduled_task_run_id = (document ->> 'scheduled_task_run_id')::uuid
            AND occurrence.kind = 'scheduled_occurrence'
            AND occurrence.state = 'delivered'
            AND occurrence.delivered_turn_id = NEW.id
            AND occurrence.mcp_account_bindings IS NOT DISTINCT FROM bindings
        ) INTO inherited_bindings;
      END IF;
    END IF;
    IF NOT inherited_bindings AND TG_TABLE_NAME = 'session_turns'
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
          AND origin.id = CASE WHEN pg_catalog.octet_length((CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerTurnId'
            WHEN update_value.kind LIKE 'child_%'
              THEN update_value.lineage ->> 'parentTurnId'
            ELSE update_value.lineage ->> 'causalTurnId' END)) = 36 AND (CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerTurnId'
            WHEN update_value.kind LIKE 'child_%'
              THEN update_value.lineage ->> 'parentTurnId'
            ELSE update_value.lineage ->> 'causalTurnId' END) COLLATE pg_catalog."C" OPERATOR(pg_catalog.~) '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerTurnId'
            WHEN update_value.kind LIKE 'child_%'
              THEN update_value.lineage ->> 'parentTurnId'
            ELSE update_value.lineage ->> 'causalTurnId' END)::pg_catalog.uuid END
          AND origin.session_id = CASE WHEN pg_catalog.octet_length((CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerSessionId'
            ELSE document ->> 'session_id' END)) = 36 AND (CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerSessionId'
            ELSE document ->> 'session_id' END) COLLATE pg_catalog."C" OPERATOR(pg_catalog.~) '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerSessionId'
            ELSE document ->> 'session_id' END)::pg_catalog.uuid END
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

    IF TG_TABLE_NAME = 'session_turns' AND document ->> 'execution_context_turn_id' IS NOT NULL
      -- 0755: freshly resolved accounts are admitted live below.
      AND EXISTS (SELECT 1 FROM session_turns context_turn
        WHERE context_turn.id = (document ->> 'execution_context_turn_id')::uuid
          AND context_turn.account_id = NEW.account_id
          AND context_turn.workspace_id = NEW.workspace_id
          AND nullif(context_turn.mcp_account_bindings, 'null'::jsonb) IS NOT DISTINCT FROM bindings)
    THEN
      inherited_bindings := true; -- validated by inbox_execution_context_fence
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
END $_$;

DO $search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.fence_mcp_account_bindings() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$search_path$;
