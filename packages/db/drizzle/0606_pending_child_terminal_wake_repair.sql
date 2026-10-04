-- deployment-mode: rolling
-- Content-free, bounded discovery only. Scoped runtime repair owns canonical
-- control/ancestry, exact ownership and physical/inference admission checks.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE INDEX IF NOT EXISTS session_system_updates_pending_terminal_repair_idx
  ON session_system_updates (workspace_id, session_id, source_id, dedupe_key)
  WHERE state = 'pending' AND kind = 'child_terminal_result';

DO $install$
DECLARE target_schema text := current_schema(); role_name text; dispatcher_owner text;
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(
      p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid)
    RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid child repair batch'; END IF;
      IF (p_after_workspace_id IS NULL) <> (p_after_session_id IS NULL) THEN
        RAISE EXCEPTION 'incomplete child repair cursor';
      END IF;
      RETURN QUERY
        SELECT DISTINCT input.account_id, input.workspace_id, input.session_id
        FROM %1$I.session_system_updates input
        JOIN %1$I.sessions parent ON parent.account_id = input.account_id
          AND parent.workspace_id = input.workspace_id AND parent.id = input.session_id
        JOIN %1$I.session_system_update_outbox producer
          ON producer.account_id = input.account_id AND producer.workspace_id = input.workspace_id
          AND producer.target_session_id = input.session_id AND producer.dedupe_key = input.dedupe_key
          AND producer.source_id = input.source_id AND producer.kind = 'child_terminal_result'
          AND producer.status = 'delivered'
        JOIN %1$I.sessions child ON child.account_id = input.account_id
          AND child.workspace_id = input.workspace_id AND child.id = producer.source_session_id
          AND child.parent_session_id = input.session_id AND child.id::text = input.source_id
        LEFT JOIN %1$I.session_workflow_wake_outbox wake
          ON wake.account_id = input.account_id AND wake.workspace_id = input.workspace_id
          AND wake.session_id = input.session_id
        WHERE input.state = 'pending' AND input.kind = 'child_terminal_result'
          AND input.payload ->> 'childSessionId' = input.source_id
          AND parent.status = 'idle' AND parent.active_turn_id IS NULL AND parent.admission_block IS NULL
          AND NOT EXISTS (SELECT 1 FROM %1$I.session_goals goal
            WHERE goal.workspace_id = input.workspace_id AND goal.session_id = input.session_id)
          AND (wake.session_id IS NULL OR wake.wake_revision = wake.delivered_revision)
          AND (p_after_workspace_id IS NULL OR
            (input.workspace_id, input.session_id) > (p_after_workspace_id, p_after_session_id))
        ORDER BY input.workspace_id, input.session_id, input.account_id LIMIT p_limit;
    END $body$;
  $definition$, target_schema);
  -- This is the same bounded global inventory authority as the existing wake
  -- dispatcher, not a new data-owner or arbitrary-query capability.
  SELECT pg_get_userbyid(proowner) INTO STRICT dispatcher_owner FROM pg_proc
    WHERE oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure;
  EXECUTE format('ALTER FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer, uuid, uuid) OWNER TO %I', dispatcher_owner);
  REVOKE ALL ON FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer, uuid, uuid) FROM PUBLIC;
  -- Preserve the existing dispatcher's runtime grant set, including custom
  -- role names. Capability-owner classification is a separate governed seam.
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.claim_session_workflow_wakes(integer)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer, uuid, uuid) TO %I', role_name);
  END LOOP;
END $install$;