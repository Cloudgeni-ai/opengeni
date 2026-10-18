-- deployment-mode: rolling
-- Chat visibility permits explaining its attached personal machine, not using
-- or discovering that machine elsewhere. Resolve the chat under the caller's
-- ordinary RLS before entering the narrow compute metadata capability.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION get_session_machine_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid)
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
      )
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
REVOKE ALL ON FUNCTION get_session_machine_access(uuid, uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION get_session_machine_access(uuid, uuid, uuid) TO opengeni_app;
  END IF;
END $$;
