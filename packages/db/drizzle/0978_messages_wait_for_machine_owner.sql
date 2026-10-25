-- deployment-mode: rolling
-- A chat that runs on a member's personal machine can only start work that
-- member caused. A message somebody else queued there used to become the next
-- turn anyway: the attempt admission trigger refused it, the whole chat was
-- blocked behind it, and a Steer from that person also interrupted the
-- owner's running turn and each new one. Such a message now waits instead:
-- it is never claimed while the chat stays on that machine, it does not steer,
-- and the owner's next own message takes it in as context.
--
-- opengeni_private.session_machine_owner_subject_v1() tells the runtime whose
-- personal machine a chat runs on, live, so claim, peek and steer delivery can
-- recognise those waiting messages. It reads like get_session_machine_access:
-- the chat under the caller's ordinary RLS context, then the narrow
-- compute-read capability. It authorizes nothing; the admission trigger stays
-- the only authority. SECURITY DEFINER, owned by its tables' owner, never
-- PUBLIC. As 0937 explains, the previous release rejects a runtime EXECUTE
-- grant on a definer it doesn't know, so this migration grants nothing: until
-- a later migration grants EXECUTE, the runtime keeps today's behaviour.
-- get_session_machine_access also lists whose messages wait, for the chat's
-- explanation. The previous release never calls the new function and ignores
-- the added key, so both can run against this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.session_machine_owner_subject_v1(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  chat_sandbox_id uuid;
  owner_subject text;
  capability_added boolean;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RETURN NULL; END IF;
  SELECT chat.active_sandbox_id INTO chat_sandbox_id FROM sessions chat
  WHERE chat.id = p_session_id AND chat.workspace_id = p_workspace_id AND chat.account_id = p_account_id;
  IF chat_sandbox_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'read') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  SELECT owner.subject_id INTO owner_subject
  FROM sandboxes sandbox
  JOIN enrollments enrollment ON enrollment.id = sandbox.enrollment_id
    AND enrollment.account_id = p_account_id AND enrollment.authority_scope = 'user'
    AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
  JOIN organization_memberships owner ON owner.id = enrollment.owner_organization_membership_id
    AND owner.account_id = p_account_id AND owner.status = 'active' AND owner.revoked_at IS NULL
  WHERE sandbox.id = chat_sandbox_id AND sandbox.account_id = p_account_id;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'read';
  END IF;
  RETURN owner_subject;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid) FROM PUBLIC;

-- Unchanged from 0917 except for `waitingMessages`: queued messages from
-- anyone but the owner, which wait on this machine, grouped by sender.
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
      ), '[]'::jsonb),
      -- Messages from anyone but the owner that wait for the owner here. The
      -- sender is read exactly as the attempt admission trigger reads it.
      'waitingMessages', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'name', nullif(btrim(person.name), ''),
            'isYou', waiting.human IS NOT DISTINCT FROM caller_subject,
            'messages', waiting.messages)
          ORDER BY waiting.first_at, waiting.human)
        FROM (
          SELECT queued.human, count(*)::integer AS messages, min(queued.created_at) AS first_at
          FROM (
            SELECT coalesce(nullif(btrim(message.initiating_human_subject_id), ''),
                CASE WHEN message.initiator_kind = 'subject'
                  THEN nullif(btrim(message.initiator_subject_id), '') END) AS human,
              message.created_at
            FROM session_turns message
            WHERE message.workspace_id = p_workspace_id AND message.session_id = p_session_id
              AND message.status = 'queued' AND message.source IN ('user', 'api')
              AND message.started_at IS NULL
          ) queued
          WHERE queued.human IS DISTINCT FROM owner.subject_id
          GROUP BY queued.human
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
