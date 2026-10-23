-- deployment-mode: rolling
-- A shared chat that runs on a member's personal machine cannot run work
-- another member started there: their workers' results and messages wait.
-- The machine's owner may now explicitly let the agent continue with another
-- member's waiting worker results under the owner's own authority. The
-- owner's choice is recorded on each waiting update (who, when); the update's
-- producer receipt is not rewritten. The chat explanation also says whose
-- results are waiting, so both people can see what happened and why.
-- New nullable columns and a widened projection keep the previous release
-- working: it never sets or reads them, and an update nobody let continue is
-- checked exactly as before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE session_system_updates
  ADD COLUMN continued_by_subject_id text,
  ADD COLUMN continued_at timestamptz;

-- The human whose turn produced an informational update (a worker's result
-- or an agent message), the same lineage the inbox fence reads. Null for any
-- other update.
CREATE FUNCTION opengeni_private.informational_update_origin_human_v1(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_kind text, p_lineage jsonb)
RETURNS text
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $origin$
  SELECT coalesce(origin.initiating_human_subject_id,
    CASE WHEN origin.initiator_kind = 'subject' THEN origin.initiator_subject_id END)
  FROM session_turns origin
  WHERE (p_kind = 'agent_message' OR p_kind LIKE 'child_%')
    AND origin.account_id = p_account_id AND origin.workspace_id = p_workspace_id
    AND origin.id = CASE WHEN pg_catalog.octet_length((CASE WHEN p_kind = 'agent_message'
        THEN p_lineage ->> 'callerTurnId' ELSE p_lineage ->> 'parentTurnId' END)) = 36
      AND (CASE WHEN p_kind = 'agent_message' THEN p_lineage ->> 'callerTurnId'
        ELSE p_lineage ->> 'parentTurnId' END) COLLATE pg_catalog."C"
        OPERATOR(pg_catalog.~) '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN (CASE WHEN p_kind = 'agent_message' THEN p_lineage ->> 'callerTurnId'
        ELSE p_lineage ->> 'parentTurnId' END)::pg_catalog.uuid END
    AND origin.session_id::text = CASE WHEN p_kind = 'agent_message'
      THEN p_lineage ->> 'callerSessionId' ELSE p_session_id::text END
$origin$;
REVOKE ALL ON FUNCTION opengeni_private.informational_update_origin_human_v1(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION get_session_machine_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  chat sessions%ROWTYPE;
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  result jsonb;
  capability_added boolean;
BEGIN
  IF caller_subject IS NULL
    OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RETURN NULL; END IF;
  SELECT * INTO chat FROM sessions
  WHERE id = p_session_id AND workspace_id = p_workspace_id AND account_id = p_account_id;
  IF chat.id IS NULL OR chat.active_sandbox_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'read') ON CONFLICT DO NOTHING;
  capability_added := FOUND;

  IF EXISTS (
    SELECT 1 FROM organization_memberships member
    WHERE member.account_id = p_account_id AND member.subject_id = caller_subject
      AND member.status = 'active' AND member.revoked_at IS NULL
      AND (member.personal_workspace_id = p_workspace_id OR EXISTS (
        SELECT 1 FROM workspace_memberships access WHERE access.account_id = p_account_id
          AND access.workspace_id = p_workspace_id AND access.subject_id = caller_subject
      ))
  ) THEN
    SELECT jsonb_build_object(
      'sandboxId', sandbox.id,
      'machineName', sandbox.name,
      'ownerName', nullif(btrim(auth_user.name), ''),
      'isOwner', owner.subject_id = caller_subject,
      'queuedTurnBlocked', EXISTS (
        SELECT 1 FROM session_turns turn_value
        WHERE turn_value.id = (
          SELECT queued.id FROM session_turns queued
          WHERE queued.workspace_id = p_workspace_id AND queued.session_id = p_session_id
            AND queued.status = 'queued' AND queued.source IN ('user', 'api')
          ORDER BY queued.position, queued.created_at, queued.id LIMIT 1
        ) AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject' THEN nullif(btrim(turn_value.initiator_subject_id), '') END)
          IS DISTINCT FROM owner.subject_id
      ),
      -- Worker results and agent messages from other people's work that
      -- cannot run on this machine and that the owner has not let continue.
      'waitingWork', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'name', nullif(btrim(person.name), ''),
            'isYou', waiting.human = caller_subject,
            'results', waiting.results)
          ORDER BY waiting.first_at, waiting.human)
        FROM (
          SELECT pending.human, count(*)::integer AS results, min(pending.created_at) AS first_at
          FROM (
            SELECT opengeni_private.informational_update_origin_human_v1(
                waiting_update.account_id, waiting_update.workspace_id, waiting_update.session_id,
                waiting_update.kind, waiting_update.lineage) AS human,
              waiting_update.created_at
            FROM session_system_updates waiting_update
            WHERE waiting_update.workspace_id = p_workspace_id AND waiting_update.session_id = p_session_id
              AND waiting_update.state = 'pending' AND waiting_update.scheduled_task_run_id IS NULL
              AND (waiting_update.kind = 'agent_message' OR waiting_update.kind LIKE 'child_%')
              AND waiting_update.continued_by_subject_id IS NULL
          ) pending
          WHERE pending.human IS NOT NULL AND pending.human IS DISTINCT FROM owner.subject_id
          GROUP BY pending.human
        ) waiting
        LEFT JOIN auth_users person ON waiting.human = 'user:' || person.id
      ), '[]'::jsonb)
    ) INTO result
    FROM sandboxes sandbox
    JOIN enrollments enrollment ON enrollment.id = sandbox.enrollment_id
      AND enrollment.account_id = p_account_id AND enrollment.authority_scope = 'user'
      AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
    JOIN organization_memberships owner ON owner.id = enrollment.owner_organization_membership_id
      AND owner.account_id = p_account_id AND owner.status = 'active' AND owner.revoked_at IS NULL
    LEFT JOIN auth_users auth_user ON owner.subject_id = 'user:' || auth_user.id
    WHERE sandbox.id = chat.active_sandbox_id AND sandbox.account_id = p_account_id;
  END IF;

  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'read';
  END IF;
  RETURN result;
END
$$;

-- The owner of the personal machine a chat runs on lets the agent continue,
-- under the owner's authority, with the results other members' work left
-- waiting there. Only that owner may, only while the chat's current
-- receiving context is the owner's own work, and only for informational
-- updates (worker results and agent messages; never control input or a
-- schedule's run). Returns how many waiting results now continue.
-- SECURITY INVOKER: it runs as the caller under FORCE RLS and learns machine
-- ownership from the existing get_session_machine_access capability, so it
-- adds no new elevated routine.
CREATE FUNCTION opengeni_private.continue_session_waiting_work_v1(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  chat sessions%ROWTYPE;
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  access jsonb;
  context_human text;
  continued integer;
BEGIN
  IF caller_subject IS NULL
    OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'waiting work can only be continued by its machine owner' USING ERRCODE = '42501'; END IF;
  -- The caller's own RLS view of the chat: lock it against a concurrent claim.
  SELECT * INTO chat FROM sessions
  WHERE id = p_session_id AND workspace_id = p_workspace_id AND account_id = p_account_id
  FOR UPDATE;
  IF chat.id IS NULL OR chat.active_sandbox_id IS NULL THEN
    RAISE EXCEPTION 'waiting work can only be continued by its machine owner' USING ERRCODE = '42501';
  END IF;
  access := get_session_machine_access(p_account_id, p_workspace_id, p_session_id);
  IF access IS NULL OR access ->> 'sandboxId' IS DISTINCT FROM chat.active_sandbox_id::text
    OR (access ->> 'isOwner')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'waiting work can only be continued by its machine owner' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(context.initiating_human_subject_id,
      CASE WHEN context.initiator_kind = 'subject' THEN context.initiator_subject_id END)
    INTO context_human
  FROM session_turns context
  WHERE context.id = chat.execution_context_turn_id AND context.session_id = chat.id
    AND context.workspace_id = p_workspace_id AND context.account_id = p_account_id;
  IF context_human IS DISTINCT FROM caller_subject THEN
    RAISE EXCEPTION 'the chat is not continuing your own work yet' USING ERRCODE = '55000';
  END IF;

  UPDATE session_system_updates waiting_update
  SET continued_by_subject_id = caller_subject, continued_at = clock_timestamp()
  WHERE waiting_update.workspace_id = p_workspace_id AND waiting_update.session_id = p_session_id
    AND waiting_update.account_id = p_account_id
    AND waiting_update.state = 'pending' AND waiting_update.scheduled_task_run_id IS NULL
    AND (waiting_update.kind = 'agent_message' OR waiting_update.kind LIKE 'child_%')
    AND waiting_update.continued_by_subject_id IS NULL
    AND opengeni_private.informational_update_origin_human_v1(
      waiting_update.account_id, waiting_update.workspace_id, waiting_update.session_id,
      waiting_update.kind, waiting_update.lineage) IS DISTINCT FROM caller_subject;
  GET DIAGNOSTICS continued = ROW_COUNT;
  RETURN continued;
END
$$;DO $continue_waiting_work$
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.continue_session_waiting_work_v1(uuid,uuid,uuid) FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.continue_session_waiting_work_v1(uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    current_schema());
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.continue_session_waiting_work_v1(uuid,uuid,uuid)
      TO opengeni_app;
  END IF;
END $continue_waiting_work$;

-- The receiving-context fence accepts an informational update its owner let
-- continue under this context's human, in place of the origin-human match.
-- Control input, schedule runs and every other check are unchanged.
DO $continued_fence$
DECLARE
  definition text;
  anchor text := $anchor$    IF u.kind = 'agent_message' OR u.kind LIKE 'child_%' THEN$anchor$;
BEGIN
  definition := pg_get_functiondef('opengeni_private.fence_inbox_execution_context()'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'continued waiting work: expected one informational anchor in fence_inbox_execution_context';
  END IF;
  EXECUTE replace(definition, anchor, $patch$    IF (u.kind = 'agent_message' OR u.kind LIKE 'child_%')
      AND u.continued_by_subject_id IS NOT NULL AND u.continued_by_subject_id = human THEN
      NULL; -- its machine owner let it continue under this receiving context
    ELSIF u.kind = 'agent_message' OR u.kind LIKE 'child_%' THEN$patch$);
END
$continued_fence$;
