-- deployment-mode: rolling
-- A Connected Machine can change who can use it (Workspace or Only me) in
-- place. The enrollment, its sandbox, credentials and live connection are kept,
-- so chats, schedules and the installed agent are not registered again. One
-- confirmation applies the whole change in one transaction:
--
--   * The new owner's chats stay on the machine and keep working, with their
--     current audience (who can read a chat and who can use a box are separate,
--     as in 0738). Their running attempts are re-authorized.
--   * Other people's chats move off the machine. Their files stay on it, and
--     their next turn runs without it, as after removing a machine.
--   * Running turns that may no longer use the machine are stopped for good
--     through an authority_change interruption (terminal, like a revoked
--     membership), and the agents' running commands in chats that move off
--     are stopped.
--   * The new owner's Workspace schedules on the machine become Only me when
--     the organization allows Only me (otherwise they pause); everyone else's
--     schedules on it pause, and the Temporal schedules follow through 0761's
--     outbox.
--   * Each affected person gets one inbox notice saying what moved and why.
--
-- preview_connected_machine_audience_change lists exactly that plan without
-- changing anything. Neither function changes the agent's credential or
-- connection, so a connected agent keeps running without a restart.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The definer routines below read these tables across chats and workspaces of
-- one account. Like 0262, access is limited to a same-transaction capability
-- that only those routines can mint.
DO $policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scheduled_task_runs', 'session_background_commands'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies policy
      WHERE policy.schemaname = data_schema AND policy.tablename = table_name
        AND policy.policyname = 'scoped_compute_capability_read'
    ) THEN
      EXECUTE format(
        'CREATE POLICY scoped_compute_capability_read ON %I.%I FOR SELECT USING '
        || '(scoped_compute_policy_capability_active(current_user, %L, NULL))',
        data_schema, table_name, migration_owner
      );
    END IF;
  END LOOP;
END
$policies$;

-- Re-authorizing a running attempt refreshes its existing authorization row.
CREATE POLICY scoped_compute_capability_update
  ON session_attempt_connected_machine_authorizations FOR UPDATE
  USING (opengeni_private.scoped_compute_capability_active('write'))
  WITH CHECK (opengeni_private.scoped_compute_capability_active('write'));

-- The plan for one change. It only reads; the caller has already checked the
-- request scope and minted a capability. `notices` (one per affected person,
-- with the chat it is filed under) and the owner's membership stay internal.
CREATE FUNCTION connected_machine_audience_inventory(
  p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid,
  p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  enrollment_row enrollments%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  owner_row organization_memberships%ROWTYPE;
  current_audience text;
  target_audience text;
  items jsonb := '[]'::jsonb;
  notices jsonb := '{}'::jsonb;
  kept_chat_count integer := 0;
  kept_shared_count integer := 0;
  moved_chat_count integer := 0;
  only_me_schedule_count integer := 0;
  paused_schedule_count integer := 0;
  stopped_turn_count integer := 0;
  stopped_command_count integer := 0;
  retired_record_count integer := 0;
  ready boolean := true;
  chat record;
  schedule record;
  sibling record;
  owner_chat boolean;
  moves_off boolean;
  stops_turn boolean;
  relation text;
  action text;
  person text;
  notice jsonb;
BEGIN
  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
    AND enrollment.workspace_id = p_workspace_id;
  IF enrollment_row.id IS NULL OR enrollment_row.status <> 'active' THEN
    RETURN pg_catalog.jsonb_build_object('refusal', 'machine_not_found');
  END IF;
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.account_id = p_account_id AND sandbox.enrollment_id = enrollment_row.id
    AND sandbox.kind = 'selfhosted'
  ORDER BY sandbox.created_at, sandbox.id LIMIT 1;
  IF sandbox_row.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('refusal', 'machine_not_found');
  END IF;
  current_audience := CASE enrollment_row.authority_scope
    WHEN 'user' THEN 'only_me' ELSE enrollment_row.authority_scope END;
  IF enrollment_row.authority_scope = 'organization' THEN
    RETURN pg_catalog.jsonb_build_object('refusal', 'organization_machine');
  END IF;
  IF p_target_scope IS NULL OR p_target_scope NOT IN ('user', 'workspace') THEN
    RETURN pg_catalog.jsonb_build_object('refusal', 'invalid_target');
  END IF;
  target_audience := CASE p_target_scope WHEN 'user' THEN 'only_me' ELSE 'workspace' END;
  IF enrollment_row.authority_scope = p_target_scope THEN
    RETURN pg_catalog.jsonb_build_object('refusal', 'already_target');
  END IF;

  IF p_target_scope = 'user' THEN
    SELECT membership.* INTO owner_row FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.subject_id = p_owner_subject_id
      AND membership.status = 'active' AND membership.revoked_at IS NULL;
    IF owner_row.id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('refusal', 'owner_not_member');
    END IF;
    IF owner_row.personal_workspace_id IS DISTINCT FROM p_workspace_id AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = owner_row.subject_id
    ) THEN
      RETURN pg_catalog.jsonb_build_object('refusal', 'owner_lacks_workspace_access');
    END IF;
  ELSE
    SELECT membership.* INTO owner_row FROM organization_memberships membership
    WHERE membership.id = enrollment_row.owner_organization_membership_id
      AND membership.account_id = p_account_id;
    -- Only the owner sees an Only me machine, so only the owner can share it.
    IF owner_row.id IS NULL OR caller_subject IS DISTINCT FROM owner_row.subject_id
      OR (p_owner_subject_id IS NOT NULL AND p_owner_subject_id <> owner_row.subject_id)
    THEN
      RETURN pg_catalog.jsonb_build_object('refusal', 'not_machine_owner');
    END IF;
  END IF;

  -- Chats, the machine's own workspace and most recent first, so a person's
  -- notice is filed under the chat they used last.
  FOR chat IN
    SELECT session.id, session.workspace_id, session.title, session.visibility,
      session.owner_subject_id, session.owner_organization_membership_id,
      opengeni_private.session_person_v1(
        session.workspace_id, session.id, session.owner_subject_id,
        session.created_by_subject_id
      ) AS person,
      attempt.id AS live_attempt_id,
      coalesce(
        nullif(pg_catalog.btrim(turn.initiating_human_subject_id), ''),
        CASE WHEN turn.initiator_kind = 'subject'
          THEN nullif(pg_catalog.btrim(turn.initiator_subject_id), '') END
      ) AS turn_initiator,
      (
        SELECT pg_catalog.count(*) FROM session_background_commands command
        WHERE command.account_id = session.account_id
          AND command.workspace_id = session.workspace_id
          AND command.session_id = session.id
          AND command.enrollment_id = enrollment_row.id
          AND command.state = 'running'
      )::integer AS running_commands
    FROM sessions session
    LEFT JOIN session_turns turn ON turn.id = session.active_turn_id
      AND turn.account_id = session.account_id
      AND turn.workspace_id = session.workspace_id
      AND turn.session_id = session.id
    LEFT JOIN session_turn_attempts attempt ON attempt.id = turn.active_attempt_id
      AND attempt.account_id = turn.account_id
      AND attempt.workspace_id = turn.workspace_id
      AND attempt.session_id = turn.session_id
      AND attempt.turn_id = turn.id
      AND attempt.state IN ('claimed', 'running')
    WHERE session.account_id = p_account_id
      AND (session.active_sandbox_id = sandbox_row.id
        OR (session.sandbox_group_id = sandbox_row.id
          AND session.sandbox_backend = 'selfhosted'))
    ORDER BY session.workspace_id = p_workspace_id DESC, session.updated_at DESC, session.id
  LOOP
    owner_chat := coalesce(
      chat.owner_organization_membership_id = owner_row.id
        OR (chat.owner_organization_membership_id IS NULL
          AND chat.owner_subject_id = owner_row.subject_id),
      false
    );
    IF chat.workspace_id <> p_workspace_id THEN
      -- A Workspace machine serves its own workspace only.
      relation := 'other_workspace';
      moves_off := true;
    ELSIF p_target_scope = 'user' AND NOT owner_chat THEN
      relation := 'other_member';
      moves_off := true;
    ELSIF p_target_scope = 'user' AND chat.visibility = 'workspace_shared' THEN
      -- Stays shared: the workspace keeps reading it, only the owner runs it.
      relation := 'owner_shared';
      moves_off := false;
    ELSE
      relation := 'owner_private';
      moves_off := false;
    END IF;
    -- Someone else's turn on a machine that becomes Only me stops, wherever it
    -- runs; a chat that moves off stops whatever runs in it.
    stops_turn := chat.live_attempt_id IS NOT NULL AND (moves_off
      OR (p_target_scope = 'user' AND chat.turn_initiator IS DISTINCT FROM owner_row.subject_id));
    IF relation = 'owner_private' AND NOT stops_turn THEN
      kept_chat_count := kept_chat_count + 1;
      CONTINUE;
    END IF;
    action := CASE WHEN moves_off THEN 'move_off' ELSE 'keep' END;
    IF moves_off THEN
      moved_chat_count := moved_chat_count + 1;
      stopped_command_count := stopped_command_count + chat.running_commands;
    ELSIF relation = 'owner_shared' THEN
      kept_shared_count := kept_shared_count + 1;
    ELSE
      kept_chat_count := kept_chat_count + 1;
    END IF;
    IF stops_turn THEN
      stopped_turn_count := stopped_turn_count + 1;
    END IF;

    -- Who hears about it: the chat's person when it moves off, and whoever
    -- started a turn that stops. Never the person making the change.
    FOR person IN
      SELECT DISTINCT candidate FROM pg_catalog.unnest(ARRAY[
        CASE WHEN moves_off THEN chat.person END,
        CASE WHEN stops_turn THEN coalesce(chat.turn_initiator, chat.person) END
      ]) candidate
      WHERE candidate IS NOT NULL AND candidate LIKE 'user:%'
        AND candidate IS DISTINCT FROM caller_subject
    LOOP
      notice := coalesce(notices -> person, pg_catalog.jsonb_build_object(
        'sessionId', chat.id, 'workspaceId', chat.workspace_id,
        'chats', 0, 'schedules', 0, 'turns', 0
      ));
      IF moves_off AND person = chat.person THEN
        notice := notice || pg_catalog.jsonb_build_object(
          'chats', (notice ->> 'chats')::integer + 1);
      END IF;
      IF stops_turn AND person = coalesce(chat.turn_initiator, chat.person) THEN
        notice := notice || pg_catalog.jsonb_build_object(
          'turns', (notice ->> 'turns')::integer + 1);
      END IF;
      notices := notices || pg_catalog.jsonb_build_object(person, notice);
    END LOOP;

    items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'chat',
      'sessionId', chat.id,
      'workspaceId', chat.workspace_id,
      'relation', relation,
      'visibility', chat.visibility,
      'action', action,
      'stopsTurn', stops_turn,
      'stopsCommands', CASE WHEN moves_off THEN chat.running_commands ELSE 0 END,
      -- Another member's private chat is listed without its title or owner.
      'title', CASE WHEN owner_chat OR chat.visibility = 'workspace_shared'
        THEN chat.title END,
      'ownerSubjectId', CASE WHEN owner_chat OR chat.visibility = 'workspace_shared'
        THEN chat.owner_subject_id END
    ));
  END LOOP;

  FOR schedule IN
    SELECT task.id, task.workspace_id, task.name, task.visibility,
      task.owner_subject_id,
      (
        SELECT run.session_id FROM scheduled_task_runs run
        WHERE run.account_id = task.account_id AND run.workspace_id = task.workspace_id
          AND run.task_id = task.id AND run.session_id IS NOT NULL
        ORDER BY run.created_at DESC, run.id DESC LIMIT 1
      ) AS last_session_id
    FROM scheduled_tasks task
    WHERE task.account_id = p_account_id AND task.deleted_at IS NULL
      AND task.status = 'active'
      AND task.agent_config -> 'machineTarget' ->> 'targetSandboxId'
        = sandbox_row.id::text
    ORDER BY task.workspace_id = p_workspace_id DESC, task.created_at, task.id
  LOOP
    IF schedule.workspace_id <> p_workspace_id THEN
      relation := 'other_workspace';
      action := 'pause';
    ELSIF p_target_scope = 'workspace' THEN
      CONTINUE;
    ELSIF schedule.owner_subject_id = owner_row.subject_id
      AND schedule.visibility = 'user_private'
    THEN
      -- The new owner's Only me schedules keep running with no change.
      CONTINUE;
    ELSIF schedule.owner_subject_id = owner_row.subject_id THEN
      relation := 'owner_shared';
      action := CASE WHEN coalesce(p_schedules_may_be_only_me, false)
        THEN 'make_only_me' ELSE 'pause' END;
    ELSE
      relation := 'other_member';
      action := 'pause';
    END IF;
    IF action = 'pause' THEN
      paused_schedule_count := paused_schedule_count + 1;
    ELSE
      only_me_schedule_count := only_me_schedule_count + 1;
    END IF;
    person := schedule.owner_subject_id;
    IF action = 'pause' AND person LIKE 'user:%'
      AND person IS DISTINCT FROM caller_subject
      AND (notices ? person OR schedule.last_session_id IS NOT NULL)
    THEN
      notice := coalesce(notices -> person, pg_catalog.jsonb_build_object(
        'sessionId', schedule.last_session_id, 'workspaceId', schedule.workspace_id,
        'chats', 0, 'schedules', 0, 'turns', 0
      ));
      notices := notices || pg_catalog.jsonb_build_object(person,
        notice || pg_catalog.jsonb_build_object(
          'schedules', (notice ->> 'schedules')::integer + 1));
    END IF;
    items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'schedule',
      'scheduledTaskId', schedule.id,
      'workspaceId', schedule.workspace_id,
      'relation', relation,
      'visibility', schedule.visibility,
      'action', action,
      'name', CASE WHEN schedule.visibility = 'workspace_shared'
          OR schedule.owner_subject_id = owner_row.subject_id
        THEN schedule.name END,
      'ownerSubjectId', CASE WHEN schedule.visibility = 'workspace_shared'
          OR schedule.owner_subject_id = owner_row.subject_id
        THEN schedule.owner_subject_id END
    ));
  END LOOP;

  -- The machine takes the target identity's unique (owner or workspace, key)
  -- slot. A removed record holding it is retired by the change; a live one is
  -- the same computer connected a second time and must be removed first.
  FOR sibling IN
    SELECT enrollment.id, enrollment.status FROM enrollments enrollment
    WHERE enrollment.account_id = p_account_id
      AND enrollment.pubkey = enrollment_row.pubkey
      AND enrollment.id <> enrollment_row.id
      AND enrollment.authority_scope = p_target_scope
      AND ((p_target_scope = 'user'
          AND enrollment.owner_organization_membership_id = owner_row.id)
        OR (p_target_scope = 'workspace'
          AND enrollment.workspace_id = p_workspace_id))
    ORDER BY enrollment.created_at, enrollment.id
  LOOP
    IF sibling.status = 'revoked' THEN
      retired_record_count := retired_record_count + 1;
    ELSE
      ready := false;
      items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'duplicate_connection',
        'enrollmentId', sibling.id,
        'action', 'remove_first'
      ));
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'enrollmentId', enrollment_row.id,
    'sandboxId', sandbox_row.id,
    'machineName', sandbox_row.name,
    'currentAudience', current_audience,
    'targetAudience', target_audience,
    'generation', enrollment_row.generation,
    'ownerSubjectId', owner_row.subject_id,
    'ownerMembershipId', owner_row.id,
    'ownerAuthorizationRevision', owner_row.authorization_revision,
    'summary', pg_catalog.jsonb_build_object(
      'keptChats', kept_chat_count,
      'keptSharedChats', kept_shared_count,
      'movedOffChats', moved_chat_count,
      'schedulesMadeOnlyMe', only_me_schedule_count,
      'schedulesPaused', paused_schedule_count,
      'stoppedTurns', stopped_turn_count,
      'stoppedCommands', stopped_command_count,
      'notifiedPeople', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(notices))
    ),
    'retiredRecordCount', retired_record_count,
    'items', items,
    'notices', notices,
    'ready', ready
  );
END
$$;
REVOKE ALL ON FUNCTION connected_machine_audience_inventory(
  uuid, uuid, uuid, text, text, boolean
) FROM PUBLIC;

CREATE FUNCTION preview_connected_machine_audience_change(
  p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid,
  p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
    OR nullif(pg_catalog.current_setting('opengeni.subject_id', true), '') IS NULL
  THEN RAISE EXCEPTION 'machine audience scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  result := connected_machine_audience_inventory(
    p_account_id, p_workspace_id, p_enrollment_id, p_target_scope,
    p_owner_subject_id, p_schedules_may_be_only_me
  );
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN result - 'ownerMembershipId' - 'ownerAuthorizationRevision' - 'notices';
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION preview_connected_machine_audience_change(
  uuid, uuid, uuid, text, text, boolean
) FROM PUBLIC;

-- Every workspace one change touches: the machine's own, and any whose chats
-- or active schedules use the machine. Reads only; callers hold the fence
-- inventory capability.
CREATE FUNCTION connected_machine_audience_workspaces(
  p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid
) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  RETURN (SELECT coalesce(
    pg_catalog.array_agg(DISTINCT candidate ORDER BY candidate), ARRAY[]::uuid[])
  FROM (
    SELECT p_workspace_id AS candidate
    UNION
    SELECT session.workspace_id FROM sessions session
    WHERE session.account_id = p_account_id AND p_sandbox_id IS NOT NULL
      AND (session.active_sandbox_id = p_sandbox_id
        OR (session.sandbox_group_id = p_sandbox_id
          AND session.sandbox_backend = 'selfhosted'))
    UNION
    SELECT task.workspace_id FROM scheduled_tasks task
    WHERE task.account_id = p_account_id AND p_sandbox_id IS NOT NULL
      AND task.deleted_at IS NULL AND task.status = 'active'
      AND task.agent_config -> 'machineTarget' ->> 'targetSandboxId' = p_sandbox_id::text
  ) workspaces);
END;
$$;
REVOKE ALL ON FUNCTION connected_machine_audience_workspaces(uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION change_connected_machine_audience(
  p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid,
  p_expected_generation bigint, p_target_scope text, p_owner_subject_id text,
  p_schedules_may_be_only_me boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  enrollment_row enrollments%ROWTYPE;
  sandbox_id_value uuid;
  machine_name text;
  inventory jsonb;
  owner_membership_id uuid;
  owner_subject text;
  owner_revision bigint;
  previous_authority_id uuid;
  authority_id_value uuid;
  existing_authority_generation bigint;
  next_generation bigint;
  fence_inventory_id uuid;
  fenced_access_capability_id uuid;
  touched_workspace_id uuid;
  touched_workspace_ids uuid[];
  move_ids uuid[];
  stop_ids uuid[];
  pause_ids uuid[];
  only_me_ids uuid[];
  receipt_id uuid;
  detached_ids uuid[] := ARRAY[]::uuid[];
  stopped_attempt_ids uuid[] := ARRAY[]::uuid[];
  paused_ids uuid[] := ARRAY[]::uuid[];
  made_only_me_ids uuid[] := ARRAY[]::uuid[];
  retired_ids uuid[] := ARRAY[]::uuid[];
  granted_ids uuid[] := ARRAY[]::uuid[];
  reauthorized_ids uuid[] := ARRAY[]::uuid[];
  stopped_command_count integer := 0;
  notified_count integer := 0;
  next_activity_revision bigint;
  wake record;
  kept record;
  notice record;
  grant_id_value uuid;
  grant_generation_value bigint;
  attempt record;
  step_ids uuid[];
  step_count integer;
  notice_body text;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN RAISE EXCEPTION 'machine audience scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;

  -- Fences first, then row locks (the 0345 protocol). Find the machine and
  -- every workspace the change touches without locking, take those
  -- workspaces' session-tenancy fences in workspace order, then lock the
  -- machine row and re-check the generation and the touched workspaces.
  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
    AND enrollment.workspace_id = p_workspace_id;
  IF enrollment_row.id IS NULL OR enrollment_row.status <> 'active' THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'write';
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'refusal', 'machine_not_found');
  END IF;
  SELECT sandbox.id, sandbox.name INTO sandbox_id_value, machine_name FROM sandboxes sandbox
  WHERE sandbox.account_id = p_account_id AND sandbox.enrollment_id = enrollment_row.id
    AND sandbox.kind = 'selfhosted'
  ORDER BY sandbox.created_at, sandbox.id LIMIT 1;
  fence_inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
    session_tenancy_fence_target_schema()
  );
  touched_workspace_ids := connected_machine_audience_workspaces(
    p_account_id, p_workspace_id, sandbox_id_value
  );
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(fence_inventory_id);
  fence_inventory_id := NULL;
  FOREACH touched_workspace_id IN ARRAY touched_workspace_ids LOOP
    PERFORM acquire_session_tenancy_fence(touched_workspace_id);
  END LOOP;

  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
    AND enrollment.workspace_id = p_workspace_id
  FOR UPDATE;
  IF enrollment_row.id IS NULL OR enrollment_row.status <> 'active' THEN
    inventory := pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'refusal', 'machine_not_found');
  ELSIF enrollment_row.generation <> p_expected_generation THEN
    inventory := pg_catalog.jsonb_build_object(
      'outcome', 'stale', 'generation', enrollment_row.generation);
  ELSE
    -- A chat or schedule in a workspace not fenced above started using the
    -- machine in between: nothing changes; preview again.
    fence_inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
    IF NOT (connected_machine_audience_workspaces(
        p_account_id, p_workspace_id, sandbox_id_value
      ) <@ touched_workspace_ids)
    THEN
      inventory := pg_catalog.jsonb_build_object(
        'outcome', 'stale', 'generation', enrollment_row.generation);
    END IF;
    PERFORM opengeni_private.close_session_tenancy_fence_inventory(fence_inventory_id);
    fence_inventory_id := NULL;
  END IF;
  IF inventory IS NOT NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'write';
    RETURN inventory;
  END IF;

  inventory := connected_machine_audience_inventory(
    p_account_id, p_workspace_id, p_enrollment_id, p_target_scope,
    p_owner_subject_id, p_schedules_may_be_only_me
  );
  IF inventory ? 'refusal' OR NOT (inventory ->> 'ready')::boolean THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'write';
    IF inventory ? 'refusal' THEN
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'refusal', inventory ->> 'refusal');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'blocked',
      'preview', inventory - 'ownerMembershipId' - 'ownerAuthorizationRevision' - 'notices');
  END IF;
  owner_membership_id := (inventory ->> 'ownerMembershipId')::uuid;
  owner_subject := inventory ->> 'ownerSubjectId';
  owner_revision := (inventory ->> 'ownerAuthorizationRevision')::bigint;
  next_generation := enrollment_row.generation + 1;

  fenced_access_capability_id :=
    opengeni_private.open_session_tenancy_fenced_access(
      session_tenancy_fence_target_schema()
    );
  -- Each workspace's rows are written in that workspace's scope.
  FOREACH touched_workspace_id IN ARRAY touched_workspace_ids LOOP
    SELECT
      coalesce(pg_catalog.array_agg((item ->> 'sessionId')::uuid)
        FILTER (WHERE item ->> 'kind' = 'chat' AND item ->> 'action' = 'move_off'),
        ARRAY[]::uuid[]),
      coalesce(pg_catalog.array_agg((item ->> 'sessionId')::uuid)
        FILTER (WHERE item ->> 'kind' = 'chat' AND (item ->> 'stopsTurn')::boolean),
        ARRAY[]::uuid[]),
      coalesce(pg_catalog.array_agg((item ->> 'scheduledTaskId')::uuid)
        FILTER (WHERE item ->> 'kind' = 'schedule' AND item ->> 'action' = 'pause'),
        ARRAY[]::uuid[]),
      coalesce(pg_catalog.array_agg((item ->> 'scheduledTaskId')::uuid)
        FILTER (WHERE item ->> 'kind' = 'schedule' AND item ->> 'action' = 'make_only_me'),
        ARRAY[]::uuid[])
    INTO move_ids, stop_ids, pause_ids, only_me_ids
    FROM pg_catalog.jsonb_array_elements(inventory -> 'items') item
    WHERE (item ->> 'workspaceId')::uuid = touched_workspace_id;
    IF pg_catalog.cardinality(move_ids) + pg_catalog.cardinality(stop_ids)
        + pg_catalog.cardinality(pause_ids) + pg_catalog.cardinality(only_me_ids) = 0
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_each(inventory -> 'notices') entry
        WHERE (entry.value ->> 'workspaceId')::uuid = touched_workspace_id
      )
    THEN
      CONTINUE;
    END IF;
    PERFORM pg_catalog.set_config('opengeni.workspace_id', touched_workspace_id::text, true);

    -- Stop the turns that may no longer use the machine, for good. The worker
    -- settles each interruption as cancelled ("authority changed").
    IF pg_catalog.cardinality(stop_ids) > 0 THEN
      INSERT INTO session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        operation_key, canonical_request_hash, result
      ) VALUES (
        p_account_id, touched_workspace_id, 'human', caller_subject,
        'connected_machine.audience_change',
        'connected-machine-audience:' || enrollment_row.id::text || ':'
          || next_generation::text,
        pg_catalog.md5(enrollment_row.id::text || ':' || p_target_scope || ':'
          || coalesce(owner_subject, '')),
        pg_catalog.jsonb_build_object(
          'enrollmentId', enrollment_row.id, 'audience', inventory ->> 'targetAudience')
      )
      RETURNING id INTO receipt_id;
      WITH stopped AS (
        INSERT INTO session_attempt_interruptions (
          account_id, workspace_id, session_id, operation_id, attempt_id,
          kind, control_revision
        )
        SELECT attempt_value.account_id, attempt_value.workspace_id,
          attempt_value.session_id, receipt_id, attempt_value.id,
          'authority_change', session.authority_epoch
        FROM sessions session
        JOIN session_turns turn ON turn.id = session.active_turn_id
          AND turn.account_id = session.account_id
          AND turn.workspace_id = session.workspace_id
          AND turn.session_id = session.id
        JOIN session_turn_attempts attempt_value ON attempt_value.id = turn.active_attempt_id
          AND attempt_value.account_id = turn.account_id
          AND attempt_value.workspace_id = turn.workspace_id
          AND attempt_value.session_id = turn.session_id
          AND attempt_value.turn_id = turn.id
          AND attempt_value.state IN ('claimed', 'running')
        WHERE session.account_id = p_account_id
          AND session.workspace_id = touched_workspace_id
          AND session.id = ANY(stop_ids)
        ON CONFLICT ON CONSTRAINT session_attempt_interruptions_operation_attempt_uq
        DO NOTHING
        RETURNING attempt_id
      )
      SELECT stopped_attempt_ids || coalesce(pg_catalog.array_agg(stopped.attempt_id), ARRAY[]::uuid[])
      INTO stopped_attempt_ids FROM stopped;
      FOR wake IN
        SELECT session.id, coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
          AS workflow_id
        FROM sessions session
        WHERE session.account_id = p_account_id
          AND session.workspace_id = touched_workspace_id
          AND session.id = ANY(stop_ids)
        ORDER BY session.id
      LOOP
        INSERT INTO session_workflow_wake_outbox AS outbox (
          session_id, account_id, workspace_id, temporal_workflow_id, reason,
          control_revision, next_attempt_at
        ) VALUES (
          wake.id, p_account_id, touched_workspace_id, wake.workflow_id,
          'connected_machine_audience_changed', 1, pg_catalog.clock_timestamp()
        )
        ON CONFLICT (session_id) DO UPDATE SET
          temporal_workflow_id = EXCLUDED.temporal_workflow_id,
          wake_revision = outbox.wake_revision + 1,
          control_revision = outbox.wake_revision + 1,
          reason = EXCLUDED.reason,
          attempts = 0,
          next_attempt_at = CASE WHEN outbox.wake_revision > outbox.delivered_revision
            THEN LEAST(outbox.next_attempt_at, EXCLUDED.next_attempt_at)
            ELSE EXCLUDED.next_attempt_at END,
          last_error = NULL,
          updated_at = pg_catalog.clock_timestamp();
      END LOOP;
    END IF;

    -- Move the other chats off the machine. Their history and files stay;
    -- the next turn finds no machine route, as after removal.
    IF pg_catalog.cardinality(move_ids) > 0 THEN
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'open', true);
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_workspace_id', touched_workspace_id::text, true
      );
      WITH detached AS (
        UPDATE sessions session
        SET active_sandbox_id = NULL,
            active_epoch = session.active_epoch + 1,
            sandbox_backend = CASE
              WHEN session.sandbox_backend = 'selfhosted' THEN 'none'
              ELSE session.sandbox_backend
            END,
            updated_at = pg_catalog.clock_timestamp()
        WHERE session.account_id = p_account_id
          AND session.workspace_id = touched_workspace_id
          AND session.id = ANY(move_ids)
          AND (session.active_sandbox_id = sandbox_id_value
            OR (session.sandbox_group_id = sandbox_id_value
              AND session.sandbox_backend = 'selfhosted'))
        RETURNING session.id
      )
      SELECT detached_ids || coalesce(pg_catalog.array_agg(detached.id), ARRAY[]::uuid[])
      INTO detached_ids FROM detached;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'finalizing', true);
      UPDATE workspace_session_activity_revisions counter
      SET revision = counter.revision + 1
      WHERE counter.workspace_id = touched_workspace_id
        AND EXISTS (
          SELECT 1 FROM sessions pending
          WHERE pending.workspace_id = touched_workspace_id
            AND pending.activity_revision_pending_xid
              = pg_catalog.pg_current_xact_id()::text::bigint
        )
      RETURNING counter.revision INTO next_activity_revision;
      UPDATE sessions pending
      SET activity_revision = next_activity_revision,
          activity_revision_pending_xid = NULL
      WHERE pending.workspace_id = touched_workspace_id
        AND pending.activity_revision_pending_xid
          = pg_catalog.pg_current_xact_id()::text::bigint;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'open', true);

      -- The agents' commands still running there stop too.
      WITH stopping AS (
        UPDATE session_background_commands command SET
          state = 'stopping',
          cancel_requested_at = pg_catalog.clock_timestamp(),
          cancel_requested_by = pg_catalog.left(caller_subject, 1024),
          reconcile_after = pg_catalog.clock_timestamp(),
          reconcile_claim_id = NULL,
          reconcile_claimed_at = NULL,
          updated_at = pg_catalog.clock_timestamp()
        WHERE command.account_id = p_account_id
          AND command.workspace_id = touched_workspace_id
          AND command.session_id = ANY(move_ids)
          AND command.enrollment_id = enrollment_row.id
          AND command.state = 'running'
        RETURNING command.retained_process_id
      ), nudged AS (
        UPDATE sandbox_retained_processes process SET
          reconcile_after = pg_catalog.clock_timestamp(),
          reconcile_claim_id = NULL,
          reconcile_claimed_at = NULL,
          last_reconcile_outcome = 'cancel_requested'
        WHERE process.id IN (
          SELECT stopping.retained_process_id FROM stopping
          WHERE stopping.retained_process_id IS NOT NULL
        )
          AND process.state = 'active'
        RETURNING process.id
      )
      SELECT stopped_command_count + pg_catalog.count(*)::integer
      INTO stopped_command_count FROM stopping;
    END IF;

    -- Schedules on the machine: pause, or make the new owner's ones Only me.
    -- The Temporal schedule follows the saved task through 0761's outbox.
    IF pg_catalog.cardinality(pause_ids) > 0 THEN
      WITH paused AS (
        UPDATE scheduled_tasks task SET status = 'paused', updated_at = now()
        WHERE task.account_id = p_account_id
          AND task.workspace_id = touched_workspace_id
          AND task.id = ANY(pause_ids)
          AND task.status = 'active' AND task.deleted_at IS NULL
        RETURNING task.id, task.account_id, task.workspace_id, task.temporal_schedule_id
      ), enqueued AS (
        INSERT INTO scheduled_task_schedule_outbox(
          account_id, workspace_id, temporal_schedule_id, task_id
        )
        SELECT paused.account_id, paused.workspace_id, paused.temporal_schedule_id, paused.id
        FROM paused
        ON CONFLICT (task_id) DO UPDATE SET id = gen_random_uuid(), created_at = now(),
          next_attempt_at = now()
        RETURNING task_id
      )
      SELECT paused_ids || coalesce(pg_catalog.array_agg(paused.id), ARRAY[]::uuid[])
      INTO paused_ids FROM paused;
    END IF;
    IF pg_catalog.cardinality(only_me_ids) > 0 THEN
      WITH narrowed AS (
        UPDATE scheduled_tasks task SET visibility = 'user_private', updated_at = now()
        WHERE task.account_id = p_account_id
          AND task.workspace_id = touched_workspace_id
          AND task.id = ANY(only_me_ids)
          AND task.owner_subject_id = owner_subject
          AND task.visibility = 'workspace_shared'
          AND task.deleted_at IS NULL
        RETURNING task.id
      )
      SELECT made_only_me_ids || coalesce(pg_catalog.array_agg(narrowed.id), ARRAY[]::uuid[])
      INTO made_only_me_ids FROM narrowed;
    END IF;

    -- One notice per affected person, filed under their most recent chat.
    FOR notice IN
      SELECT entry.key AS person, (entry.value ->> 'sessionId')::uuid AS session_id,
        (entry.value ->> 'chats')::integer AS chats,
        (entry.value ->> 'schedules')::integer AS schedules,
        (entry.value ->> 'turns')::integer AS turns
      FROM pg_catalog.jsonb_each(inventory -> 'notices') entry
      WHERE (entry.value ->> 'workspaceId')::uuid = touched_workspace_id
        AND entry.value ->> 'sessionId' IS NOT NULL
      ORDER BY entry.key
    LOOP
      notice_body := 'It was switched to Only me for one person, so your work can''t use it anymore.'
        || CASE WHEN notice.chats > 0 THEN ' Moved off it: ' || notice.chats::text
          || CASE WHEN notice.chats = 1 THEN ' chat.' ELSE ' chats.' END ELSE '' END
        || CASE WHEN notice.schedules > 0 THEN ' Paused: ' || notice.schedules::text
          || CASE WHEN notice.schedules = 1 THEN ' schedule.' ELSE ' schedules.' END ELSE '' END
        || CASE WHEN notice.turns > 0 THEN ' Stopped: ' || notice.turns::text
          || CASE WHEN notice.turns = 1 THEN ' running turn.' ELSE ' running turns.' END
          ELSE '' END
        || ' Choose another machine to continue. Nothing moves back on its own, even if'
        || ' the machine is shared again.';
      PERFORM opengeni_private.open_inbox_item_v1(
        p_account_id, touched_workspace_id, notice.session_id, notice.person,
        'notification',
        -- Per person: two people's notices can be filed under the same chat.
        'connected-machine-audience:' || enrollment_row.id::text || ':'
          || next_generation::text || ':' || notice.person,
        pg_catalog.left(coalesce(nullif(pg_catalog.btrim(machine_name), ''), 'A machine'), 160)
          || ' is no longer shared',
        notice_body, 'normal', '[]'::jsonb
      );
      notified_count := notified_count + 1;
    END LOOP;
    PERFORM pg_catalog.set_config('opengeni.workspace_id', p_workspace_id::text, true);
  END LOOP;
  PERFORM pg_catalog.set_config('opengeni.workspace_id', p_workspace_id::text, true);

  -- A removed record of the same computer that holds the target identity's
  -- unique key slot is retired, so a later re-enrollment finds this machine.
  WITH retired AS (
    UPDATE enrollments enrollment
    SET pubkey = 'retired:' || enrollment.id::text || ':' || enrollment.pubkey,
        updated_at = pg_catalog.clock_timestamp()
    WHERE enrollment.account_id = p_account_id
      AND enrollment.pubkey = enrollment_row.pubkey
      AND enrollment.id <> enrollment_row.id
      AND enrollment.status = 'revoked'
      AND enrollment.authority_scope = p_target_scope
      AND ((p_target_scope = 'user'
          AND enrollment.owner_organization_membership_id = owner_membership_id)
        OR (p_target_scope = 'workspace'
          AND enrollment.workspace_id = p_workspace_id))
    RETURNING enrollment.id
  )
  SELECT coalesce(pg_catalog.array_agg(retired.id), ARRAY[]::uuid[])
  INTO retired_ids FROM retired;

  IF p_target_scope = 'user' THEN
    SELECT authority.generation INTO existing_authority_generation
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = owner_membership_id
      AND authority.resource_kind = 'connected_machine'
      AND authority.resource_id = enrollment_row.id
    FOR UPDATE;
    next_generation := GREATEST(
      enrollment_row.generation, coalesce(existing_authority_generation, 0)
    ) + 1;
    INSERT INTO organization_user_resource_authorities AS authority(
      account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) VALUES (
      p_account_id, owner_membership_id, 'connected_machine', enrollment_row.id,
      p_workspace_id, next_generation, 'active'
    )
    ON CONFLICT (account_id, organization_membership_id, resource_kind, resource_id)
    DO UPDATE SET generation = EXCLUDED.generation, status = 'active',
      revoked_at = NULL, origin_workspace_id = EXCLUDED.origin_workspace_id,
      updated_at = pg_catalog.clock_timestamp()
    RETURNING authority.id INTO authority_id_value;
    -- The enrollment trigger aligns the authority and revokes stale grants.
    UPDATE enrollments
    SET authority_scope = 'user', authority_id = authority_id_value,
        owner_organization_membership_id = owner_membership_id,
        origin_workspace_id = coalesce(origin_workspace_id, p_workspace_id),
        generation = next_generation, updated_at = pg_catalog.clock_timestamp()
    WHERE id = enrollment_row.id;

    -- The owner's chats stay on the machine and keep working: each gets a
    -- chat-bound grant in its current audience. A shared chat stays shared, so
    -- the workspace keeps reading it, while only the owner runs it.
    FOR kept IN
      SELECT session.id, session.workspace_id, session.visibility,
        session.authority_epoch, session.active_turn_id
      FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_workspace_id
        AND (session.active_sandbox_id = sandbox_id_value
          OR (session.sandbox_group_id = sandbox_id_value
            AND session.sandbox_backend = 'selfhosted'))
        AND (session.owner_organization_membership_id = owner_membership_id
          OR (session.owner_organization_membership_id IS NULL
            AND session.owner_subject_id = owner_subject))
      ORDER BY session.id
    LOOP
      grant_id_value := NULL;
      INSERT INTO organization_user_resource_grants(
        account_id, authority_id, owner_organization_membership_id, workspace_id,
        session_id, action, mode, context, authority_epoch, generation, status
      ) VALUES (
        p_account_id, authority_id_value, owner_membership_id, kept.workspace_id,
        kept.id, 'connected_machine.use', 'session', kept.visibility,
        kept.authority_epoch, 1, 'active'
      )
      ON CONFLICT DO NOTHING
      RETURNING id, generation INTO grant_id_value, grant_generation_value;
      IF grant_id_value IS NULL THEN
        SELECT grant_value.id, grant_value.generation
        INTO grant_id_value, grant_generation_value
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.account_id = p_account_id
          AND grant_value.authority_id = authority_id_value
          AND grant_value.workspace_id = kept.workspace_id
          AND grant_value.session_id = kept.id
          AND grant_value.action = 'connected_machine.use'
          AND grant_value.mode = 'session' AND grant_value.context = kept.visibility
          AND grant_value.authority_epoch = kept.authority_epoch
          AND grant_value.status = 'active';
      END IF;
      granted_ids := granted_ids || kept.id;

      -- The owner's running attempt keeps its machine: refresh (or create)
      -- its authorization row to the new authority and grant.
      FOR attempt IN
        SELECT attempt_value.id, attempt_value.turn_id,
          attempt_value.execution_generation
        FROM session_turns turn
        JOIN session_turn_attempts attempt_value
          ON attempt_value.id = turn.active_attempt_id
          AND attempt_value.turn_id = turn.id
          AND attempt_value.session_id = turn.session_id
          AND attempt_value.account_id = turn.account_id
          AND attempt_value.workspace_id = turn.workspace_id
        WHERE turn.id = kept.active_turn_id AND turn.account_id = p_account_id
          AND turn.workspace_id = kept.workspace_id AND turn.session_id = kept.id
          AND attempt_value.state IN ('claimed', 'running')
          AND attempt_value.closed_at IS NULL AND attempt_value.quiesced_at IS NULL
          AND coalesce(
            nullif(pg_catalog.btrim(turn.initiating_human_subject_id), ''),
            CASE WHEN turn.initiator_kind = 'subject'
              THEN nullif(pg_catalog.btrim(turn.initiator_subject_id), '') END
          ) = owner_subject
      LOOP
        INSERT INTO session_attempt_connected_machine_authorizations AS authorization_value(
          attempt_id, account_id, workspace_id, session_id, turn_id,
          execution_generation, initiating_human_subject_id,
          owner_organization_membership_id, membership_authorization_revision,
          enrollment_id, sandbox_id, authority_id, authority_generation,
          enrollment_generation, session_visibility, session_authority_epoch,
          grant_id, grant_generation, grant_mode
        ) VALUES (
          attempt.id, p_account_id, kept.workspace_id, kept.id, attempt.turn_id,
          attempt.execution_generation, owner_subject, owner_membership_id,
          owner_revision, enrollment_row.id, sandbox_id_value, authority_id_value,
          next_generation, next_generation, kept.visibility, kept.authority_epoch,
          grant_id_value, grant_generation_value, 'session'
        )
        ON CONFLICT (attempt_id, enrollment_id) DO UPDATE SET
          initiating_human_subject_id = EXCLUDED.initiating_human_subject_id,
          owner_organization_membership_id = EXCLUDED.owner_organization_membership_id,
          membership_authorization_revision = EXCLUDED.membership_authorization_revision,
          sandbox_id = EXCLUDED.sandbox_id,
          authority_id = EXCLUDED.authority_id,
          authority_generation = EXCLUDED.authority_generation,
          enrollment_generation = EXCLUDED.enrollment_generation,
          session_visibility = EXCLUDED.session_visibility,
          session_authority_epoch = EXCLUDED.session_authority_epoch,
          grant_id = EXCLUDED.grant_id,
          grant_generation = EXCLUDED.grant_generation,
          grant_mode = EXCLUDED.grant_mode;
        reauthorized_ids := reauthorized_ids || attempt.id;
      END LOOP;
    END LOOP;
  ELSE
    previous_authority_id := enrollment_row.authority_id;
    UPDATE enrollments
    SET authority_scope = 'workspace', authority_id = NULL,
        owner_organization_membership_id = NULL,
        generation = next_generation, updated_at = pg_catalog.clock_timestamp()
    WHERE id = enrollment_row.id;
    UPDATE organization_user_resource_authorities
    SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
        generation = GREATEST(generation + 1, next_generation),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = previous_authority_id AND account_id = p_account_id;
    UPDATE organization_user_resource_grants
    SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
        generation = generation + 1, updated_at = pg_catalog.clock_timestamp()
    WHERE authority_id = previous_authority_id AND account_id = p_account_id
      AND status = 'active';
  END IF;

  PERFORM opengeni_private.close_session_tenancy_fenced_access(
    fenced_access_capability_id
  );
  fenced_access_capability_id := NULL;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'changed',
    'enrollmentId', enrollment_row.id,
    'sandboxId', sandbox_id_value,
    'previousAudience', inventory ->> 'currentAudience',
    'audience', inventory ->> 'targetAudience',
    'ownerSubjectId', CASE WHEN p_target_scope = 'user' THEN owner_subject END,
    'previousGeneration', enrollment_row.generation,
    'generation', next_generation,
    'summary', (inventory -> 'summary') || pg_catalog.jsonb_build_object(
      'stoppedCommands', stopped_command_count,
      'notifiedPeople', notified_count
    ),
    'detachedSessionIds', pg_catalog.to_jsonb(detached_ids),
    'keptSessionIds', pg_catalog.to_jsonb(granted_ids),
    'stoppedAttemptIds', pg_catalog.to_jsonb(stopped_attempt_ids),
    'pausedScheduleIds', pg_catalog.to_jsonb(paused_ids),
    'onlyMeScheduleIds', pg_catalog.to_jsonb(made_only_me_ids),
    'reauthorizedAttemptIds', pg_catalog.to_jsonb(reauthorized_ids),
    'retiredEnrollmentIds', pg_catalog.to_jsonb(retired_ids)
  );
EXCEPTION WHEN OTHERS THEN
  IF fence_inventory_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fence_inventory(fence_inventory_id);
  END IF;
  IF fenced_access_capability_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fenced_access(
      fenced_access_capability_id
    );
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION change_connected_machine_audience(
  uuid, uuid, uuid, bigint, text, text, boolean
) FROM PUBLIC;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.connected_machine_audience_inventory(uuid, uuid, uuid, text, text, boolean) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
  EXECUTE format(
    'ALTER FUNCTION %I.connected_machine_audience_workspaces(uuid, uuid, uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
  EXECUTE format(
    'ALTER FUNCTION %I.preview_connected_machine_audience_change(uuid, uuid, uuid, text, text, boolean) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
  EXECUTE format(
    'ALTER FUNCTION %I.change_connected_machine_audience(uuid, uuid, uuid, bigint, text, text, boolean) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
END
$pin$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION preview_connected_machine_audience_change(
      uuid, uuid, uuid, text, text, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION change_connected_machine_audience(
      uuid, uuid, uuid, bigint, text, text, boolean
    ) TO opengeni_app;
  END IF;
END
$grants$;
