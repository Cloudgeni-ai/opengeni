-- deployment-mode: rolling
-- A saved message is approved for the machine the chat ran on when it was
-- sent (or the machine its "use this machine" message chose). When the chat
-- has since moved to another of the owner's personal machines, the attempt
-- admission trigger refuses it (personal_resource_grant_required) and no
-- recheck can pass: only moving the chat back, or removing the message and
-- sending it again, unblocks the chat. The chat could not say which machine
-- the message belongs to, so people were told to "ask the owner" of their
-- own machine.
--
-- get_session_machine_access now also says:
-- - queuedTurnNotApprovedHere: the first queued message is the machine
--   owner's own, sent with turn-bound approvals (protocol 1), none of them
--   covers this machine, and no earlier attempt of it carried this machine.
--   carry_session_attempt_machine_authorization refuses exactly that turn.
-- - queuedTurnApprovedMachines: for the machine's owner only (the sender of
--   that message), the active personal machines the message was approved
--   for, so the chat can offer to run it there.
-- It reads the turn's personal-resource snapshots under the narrow resolve
-- capability, held only for this call. It authorizes nothing; admission
-- stays the only authority. Same signature, so grants are kept. The previous
-- release ignores the added keys, so both can run against this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Unchanged from 0978 except for `queuedTurnNotApprovedHere` and
-- `queuedTurnApprovedMachines`.
CREATE OR REPLACE FUNCTION get_session_machine_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  chat sessions%ROWTYPE;
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  result jsonb;
  capability_added boolean;
  resolve_added boolean;
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
  INSERT INTO opengeni_private.personal_resource_delegation_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'resolve') ON CONFLICT DO NOTHING;
  resolve_added := FOUND;

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
      ), '[]'::jsonb),
      -- The owner's own first saved message, not approved for this machine.
      'queuedTurnNotApprovedHere', unapproved.id IS NOT NULL,
      -- Where it may run instead: only its sender (the owner) sees the names.
      'queuedTurnApprovedMachines', CASE
        WHEN unapproved.id IS NULL OR owner.subject_id IS DISTINCT FROM caller_subject THEN '[]'::jsonb
        ELSE coalesce((
          SELECT jsonb_agg(jsonb_build_object('sandboxId', approved.id, 'machineName', approved.name)
            ORDER BY approved.name, approved.id)
          FROM (
            SELECT DISTINCT ON (snapshot.resource_id) machine.id, machine.name
            FROM turn_personal_resource_snapshots snapshot
            JOIN enrollments approved_enrollment ON approved_enrollment.id = snapshot.resource_id
              AND approved_enrollment.account_id = p_account_id
              AND approved_enrollment.authority_scope = 'user'
              AND approved_enrollment.status = 'active' AND approved_enrollment.revoked_at IS NULL
              AND approved_enrollment.owner_organization_membership_id = owner.id
            JOIN sandboxes machine ON machine.enrollment_id = approved_enrollment.id
              AND machine.account_id = p_account_id
            WHERE snapshot.turn_id = unapproved.id AND snapshot.account_id = p_account_id
              AND snapshot.workspace_id = p_workspace_id AND snapshot.session_id = p_session_id
              AND snapshot.resource_kind = 'connected_machine'
              AND snapshot.action = 'connected_machine.use'
            ORDER BY snapshot.resource_id, (machine.workspace_id = p_workspace_id) DESC,
              machine.created_at, machine.id
          ) approved
        ), '[]'::jsonb)
      END
    ) INTO result
    FROM sandboxes sandbox
    JOIN enrollments enrollment ON enrollment.id = sandbox.enrollment_id
      AND enrollment.account_id = p_account_id AND enrollment.authority_scope = 'user'
      AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
    JOIN organization_memberships owner ON owner.id = enrollment.owner_organization_membership_id
      AND owner.account_id = p_account_id AND owner.status = 'active' AND owner.revoked_at IS NULL
    LEFT JOIN auth_users auth_user ON owner.subject_id = 'user:' || auth_user.id
    -- The first saved message (ordered as the queue runs) when it is the
    -- owner's own, carries turn-bound approvals, and none covers this machine.
    LEFT JOIN LATERAL (
      SELECT turn_value.id FROM session_turns turn_value
      WHERE turn_value.id = (
          SELECT queued.id FROM session_turns queued
          WHERE queued.workspace_id = p_workspace_id AND queued.session_id = p_session_id
            AND queued.status = 'queued' AND queued.source IN ('user', 'api')
          ORDER BY queued.position, queued.created_at, queued.id LIMIT 1
        ) AND turn_value.personal_resource_protocol_version = 1
        AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject' THEN nullif(btrim(turn_value.initiator_subject_id), '') END)
          = owner.subject_id
        AND NOT EXISTS (
          SELECT 1 FROM turn_personal_resource_snapshots snapshot
          WHERE snapshot.turn_id = turn_value.id AND snapshot.account_id = p_account_id
            AND snapshot.workspace_id = p_workspace_id AND snapshot.session_id = p_session_id
            AND snapshot.resource_kind = 'connected_machine' AND snapshot.resource_id = enrollment.id
            AND snapshot.action = 'connected_machine.use'
        )
        -- An agent's own move between the owner's machines during this turn
        -- carries to its next attempt; that refusal (for example a revoked
        -- grant) is not about where the message was sent.
        AND NOT EXISTS (
          SELECT 1 FROM session_attempt_connected_machine_authorizations prior
          WHERE prior.account_id = p_account_id AND prior.workspace_id = p_workspace_id
            AND prior.session_id = p_session_id AND prior.turn_id = turn_value.id
            AND prior.enrollment_id = enrollment.id
        )
    ) unapproved ON true
    WHERE sandbox.id = chat.active_sandbox_id AND sandbox.account_id = p_account_id;
  END IF;

  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'read';
  END IF;
  IF resolve_added THEN
    DELETE FROM opengeni_private.personal_resource_delegation_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'resolve';
  END IF;
  RETURN result;
END
$$;
