-- deployment-mode: rolling
-- Migration 0278: workspace-membership removal becomes one fenced
-- SECURITY DEFINER teardown instead of a bare personal-row cleanup + DELETE.
--
-- Before this migration `removeWorkspaceMember` deleted the target's
-- session-list snapshots, pins, drafts and the membership row and fenced
-- nothing: the removed member's queued/live turns kept running, their
-- user-private sessions in the workspace kept their authority epoch, their
-- active realtime modes stayed open, and nothing woke the affected workflows.
-- Organization offboarding (migration 0263) already performs the canonical
-- teardown account-wide; this migration is the same teardown scoped to
-- exactly one workspace and one target subject.
--
-- Rolling window. Two new functions only; no table shape changes. An old API
-- image keeps calling the bare delete path until it is replaced - removal
-- through the old path stays exactly as weak as before, never weaker, and the
-- new path composes with every existing invariant:
--   * the canonical event-write lock order is preserved (control FOR SHARE ->
--     workspace FOR KEY SHARE -> sessions FOR NO KEY UPDATE -> turns
--     FOR UPDATE -> attempts FOR UPDATE);
--   * a turn with pending tool calls and no live attempt must be settled
--     through the canonical application protocol first - the command fails
--     closed (55000) exactly like the 0263 command, and the application runs
--     the same prepare/settle pass before invoking it;
--   * live attempts are interrupted, never presumed quiesced: the command
--     records `session_attempt_interruptions` (kind `authority_change`) and
--     registers workflow wakes; Temporal cancellation semantics are untouched;
--   * removal never touches other workspaces, other subjects, organization
--     membership status, personal-workspace pointers, or retention.
--
-- Guards, restated from the application layer as fail-closed authority:
--   * the actor cannot remove their own membership;
--   * the last member holding an administering permission
--     ('workspace:admin' or 'members:manage') cannot be removed;
--   * the actor must either hold an administering permission in this
--     workspace or be an active organization owner/admin.
--
-- Idempotency: the whole command is one transaction. A retry after success
-- finds no membership row and returns removed=false without re-tearing
-- anything down; there is no partial state to repair.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- 1. Preparation: the same "settle pending tool calls first" contract as the
-- organization lifecycle, scoped to one workspace + one subject. Returns the
-- exact turns the application must settle through its canonical protocol
-- before calling the removal command.

CREATE FUNCTION prepare_workspace_membership_removal_settlements(
  p_command jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  target_subject text := p_command ->> 'targetSubjectId';
  target_membership_id uuid;
  result jsonb := '[]'::jsonb;
  previous_workspace text := pg_catalog.current_setting('opengeni.workspace_id', true);
BEGIN
  IF p_command IS NULL
    OR (p_command ->> 'action') IS DISTINCT FROM 'remove'
    OR account_id_value IS NULL
    OR workspace_id_value IS NULL
    OR actor_subject IS NULL
    OR target_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'workspace membership removal preparation authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value AND workspace.id = workspace_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM opengeni_private.assert_workspace_membership_removal_actor(
    account_id_value, workspace_id_value, actor_subject, target_subject
  );
  SELECT membership.id INTO target_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = target_subject;

  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', workspace_id_value::text, true
  );
  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = account_id_value
    AND control.workspace_id = workspace_id_value
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value
    AND workspace.id = workspace_id_value
  FOR KEY SHARE;
  PERFORM 1 FROM sessions affected
  WHERE affected.account_id = account_id_value
    AND affected.workspace_id = workspace_id_value
    AND (
      (target_membership_id IS NOT NULL
        AND affected.owner_organization_membership_id = target_membership_id)
      OR EXISTS (
        SELECT 1 FROM session_turns initiated
        WHERE initiated.session_id = affected.id
          AND initiated.initiating_human_subject_id = target_subject
      )
    )
  ORDER BY affected.id
  FOR NO KEY UPDATE;
  PERFORM 1 FROM session_turns turn_row
  WHERE turn_row.account_id = account_id_value
    AND turn_row.workspace_id = workspace_id_value
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = turn_row.session_id
        AND (
          (target_membership_id IS NOT NULL
            AND owned.owner_organization_membership_id = target_membership_id)
          OR turn_row.initiating_human_subject_id = target_subject
        )
    )
  ORDER BY turn_row.id
  FOR UPDATE;
  PERFORM 1 FROM session_turn_attempts attempt
  WHERE attempt.account_id = account_id_value
    AND attempt.workspace_id = workspace_id_value
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = attempt.session_id
        AND (
          (target_membership_id IS NOT NULL
            AND owned.owner_organization_membership_id = target_membership_id)
          OR EXISTS (
            SELECT 1 FROM session_turns initiated
            WHERE initiated.id = attempt.turn_id
              AND initiated.initiating_human_subject_id = target_subject
          )
        )
    )
  ORDER BY attempt.id
  FOR UPDATE;
  SELECT result || COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'accountId', turn_row.account_id,
        'workspaceId', turn_row.workspace_id,
        'sessionId', turn_row.session_id,
        'turnId', turn_row.id,
        'executionGeneration', turn_row.execution_generation,
        'turnAssociation', CASE WHEN owned.active_turn_id = turn_row.id
          THEN 'current' ELSE NULL END
      ) ORDER BY turn_row.session_id, turn_row.id
    ), '[]'::jsonb
  ) INTO result
  FROM session_turns turn_row
  JOIN sessions owned ON owned.id = turn_row.session_id
  WHERE turn_row.account_id = account_id_value
    AND turn_row.workspace_id = workspace_id_value
    AND turn_row.status IN (
      'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
    )
    AND (
      (target_membership_id IS NOT NULL
        AND owned.owner_organization_membership_id = target_membership_id)
      OR turn_row.initiating_human_subject_id = target_subject
    )
    AND EXISTS (
      SELECT 1 FROM session_pending_tool_calls pending
      WHERE pending.account_id = turn_row.account_id
        AND pending.workspace_id = turn_row.workspace_id
        AND pending.session_id = turn_row.session_id
        AND pending.turn_id = turn_row.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_turn_attempts live_attempt
      WHERE live_attempt.account_id = turn_row.account_id
        AND live_attempt.workspace_id = turn_row.workspace_id
        AND live_attempt.session_id = turn_row.session_id
        AND live_attempt.turn_id = turn_row.id
        AND live_attempt.id = turn_row.active_attempt_id
        AND live_attempt.state IN ('claimed', 'running')
    );
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', COALESCE(previous_workspace, ''), true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', COALESCE(previous_workspace, ''), true
  );
  RAISE;
END
$body$;

-- 2. Shared actor/guard authority. The exact application guards, restated as
-- fail-closed database authority so no future caller can skip them:
-- self-removal, last-admin, and actor administration.

CREATE FUNCTION opengeni_private.assert_workspace_membership_removal_actor(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject text,
  p_target_subject text
) RETURNS void
LANGUAGE plpgsql
AS $body$
DECLARE
  actor_can_administer boolean;
BEGIN
  IF p_actor_subject = p_target_subject THEN
    RAISE EXCEPTION 'a member cannot remove their own workspace membership'
      USING ERRCODE = '55000';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships actor_row
    WHERE actor_row.account_id = p_account_id
      AND actor_row.workspace_id = p_workspace_id
      AND actor_row.subject_id = p_actor_subject
      AND actor_row.permissions ?| ARRAY['workspace:admin', 'members:manage']
  ) OR EXISTS (
    SELECT 1 FROM organization_memberships org_actor
    WHERE org_actor.account_id = p_account_id
      AND org_actor.subject_id = p_actor_subject
      AND org_actor.status = 'active'
      AND org_actor.role IN ('owner', 'admin')
  ) INTO actor_can_administer;
  IF NOT actor_can_administer THEN
    RAISE EXCEPTION 'workspace member administration required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace_memberships target_row
    WHERE target_row.account_id = p_account_id
      AND target_row.workspace_id = p_workspace_id
      AND target_row.subject_id = p_target_subject
      AND target_row.permissions ?| ARRAY['workspace:admin', 'members:manage']
  ) AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships other
    WHERE other.account_id = p_account_id
      AND other.workspace_id = p_workspace_id
      AND other.subject_id <> p_target_subject
      AND other.permissions ?| ARRAY['workspace:admin', 'members:manage']
  ) THEN
    RAISE EXCEPTION 'cannot remove the last administering workspace member'
      USING ERRCODE = '55000';
  END IF;
END
$body$;

-- 3. The removal command itself.

CREATE FUNCTION workspace_membership_removal_command(
  p_command jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  target_subject text := p_command ->> 'targetSubjectId';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  input_hash_value text;
  target_membership_id uuid;
  membership_row_id uuid;
  now_value timestamptz := pg_catalog.clock_timestamp();
  affected_session_ids uuid[] := ARRAY[]::uuid[];
  affected_realtime_ids uuid[] := ARRAY[]::uuid[];
  cancelled_turn_ids uuid[] := ARRAY[]::uuid[];
  cancelled_turn record;
  cancelled_request record;
  cancelled_sequence bigint;
  cancelled_association text;
  settled_update_ids uuid[];
  settled_history_item_id uuid;
  interruption_operation_id uuid;
  visibility_capability_id uuid;
  activity_revision_value bigint;
  previous_workspace text := pg_catalog.current_setting('opengeni.workspace_id', true);
  previous_visibility_capability text := pg_catalog.current_setting(
    'opengeni.session_visibility_write_capability', true
  );
  previous_activity_gate_state text := pg_catalog.current_setting(
    'opengeni.session_activity_gate_state', true
  );
  previous_activity_gate_workspace text := pg_catalog.current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
BEGIN
  IF p_command IS NULL
    OR (p_command ->> 'action') IS DISTINCT FROM 'remove'
    OR account_id_value IS NULL
    OR workspace_id_value IS NULL
    OR actor_subject IS NULL
    OR target_subject IS NULL
    OR operation_id_value IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'workspace membership removal authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value AND workspace.id = workspace_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;

  -- The command runs after the application settled the target's pending
  -- protocol state and finalized that workspace activity gate. Its own gated
  -- session writes need the commit guards DEFERRED again (exactly the 0275
  -- wrapper's reasoning).
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;

  PERFORM opengeni_private.assert_workspace_membership_removal_actor(
    account_id_value, workspace_id_value, actor_subject, target_subject
  );
  -- The personal-state fence the pre-0278 delete path took: session listing
  -- takes its shared counterpart and pin mutation the same exclusive one, so
  -- a racing snapshot/pin writer cannot recreate personal rows after this
  -- cleanup. Same key derivation as lockSessionPersonalStateExclusive.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-personal-state:' || workspace_id_value::text || ':' || target_subject, 0
  ));
  SELECT membership.id INTO membership_row_id
  FROM workspace_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.workspace_id = workspace_id_value
    AND membership.subject_id = target_subject
  FOR UPDATE;
  IF membership_row_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('removed', false);
  END IF;
  SELECT membership.id INTO target_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = target_subject;

  visibility_capability_id := pg_catalog.gen_random_uuid();
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
    visibility_capability_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability',
    visibility_capability_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', workspace_id_value::text, true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_state', 'open', true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_workspace_id', workspace_id_value::text, true
  );

  -- Canonical lock prefix for this workspace, then the exact affected rows.
  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = account_id_value
    AND control.workspace_id = workspace_id_value
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value
    AND workspace.id = workspace_id_value
  FOR KEY SHARE;
  PERFORM 1 FROM sessions affected
  WHERE affected.account_id = account_id_value
    AND affected.workspace_id = workspace_id_value
    AND (
      (target_membership_id IS NOT NULL
        AND affected.owner_organization_membership_id = target_membership_id)
      OR EXISTS (
        SELECT 1 FROM session_turns initiated
        WHERE initiated.session_id = affected.id
          AND initiated.initiating_human_subject_id = target_subject
      )
    )
  ORDER BY affected.id
  FOR NO KEY UPDATE;
  PERFORM 1 FROM session_turns turn_row
  WHERE turn_row.account_id = account_id_value
    AND turn_row.workspace_id = workspace_id_value
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = turn_row.session_id
        AND (
          (target_membership_id IS NOT NULL
            AND owned.owner_organization_membership_id = target_membership_id)
          OR turn_row.initiating_human_subject_id = target_subject
        )
    )
  ORDER BY turn_row.id
  FOR UPDATE;
  PERFORM 1 FROM session_turn_attempts attempt
  WHERE attempt.account_id = account_id_value
    AND attempt.workspace_id = workspace_id_value
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = attempt.session_id
        AND (
          (target_membership_id IS NOT NULL
            AND owned.owner_organization_membership_id = target_membership_id)
          OR EXISTS (
            SELECT 1 FROM session_turns initiated
            WHERE initiated.id = attempt.turn_id
              AND initiated.initiating_human_subject_id = target_subject
          )
        )
    )
  ORDER BY attempt.id
  FOR UPDATE;
  PERFORM 1 FROM session_realtime_modes realtime
  WHERE realtime.account_id = account_id_value
    AND realtime.workspace_id = workspace_id_value
    AND realtime.owner_subject_id = target_subject
    AND realtime.state = 'active'
  ORDER BY realtime.id
  FOR UPDATE;
  SELECT COALESCE(pg_catalog.array_agg(realtime.id ORDER BY realtime.id), ARRAY[]::uuid[])
  INTO affected_realtime_ids
  FROM session_realtime_modes realtime
  WHERE realtime.account_id = account_id_value
    AND realtime.workspace_id = workspace_id_value
    AND realtime.owner_subject_id = target_subject
    AND realtime.state = 'active';
  PERFORM 1 FROM session_realtime_connections connection
  WHERE connection.account_id = account_id_value
    AND connection.workspace_id = workspace_id_value
    AND connection.realtime_id = ANY(affected_realtime_ids)
    AND connection.state IN ('negotiating', 'ready', 'active')
  ORDER BY connection.id
  FOR UPDATE;

  -- Pending tool calls with no live attempt need canonical protocol
  -- settlement first, exactly as the organization lifecycle requires.
  IF EXISTS (
    SELECT 1
    FROM session_turns turn_row
    JOIN sessions owned ON owned.id = turn_row.session_id
    WHERE turn_row.account_id = account_id_value
      AND turn_row.workspace_id = workspace_id_value
      AND turn_row.status IN (
        'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
      )
      AND (
        (target_membership_id IS NOT NULL
          AND owned.owner_organization_membership_id = target_membership_id)
        OR turn_row.initiating_human_subject_id = target_subject
      )
      AND EXISTS (
        SELECT 1 FROM session_pending_tool_calls pending
        WHERE pending.account_id = turn_row.account_id
          AND pending.workspace_id = turn_row.workspace_id
          AND pending.session_id = turn_row.session_id
          AND pending.turn_id = turn_row.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM session_turn_attempts live_attempt
        WHERE live_attempt.account_id = turn_row.account_id
          AND live_attempt.workspace_id = turn_row.workspace_id
          AND live_attempt.session_id = turn_row.session_id
          AND live_attempt.turn_id = turn_row.id
          AND live_attempt.id = turn_row.active_attempt_id
          AND live_attempt.state IN ('claimed', 'running')
      )
  ) THEN
    RAISE EXCEPTION 'pending tool calls require canonical protocol settlement'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT turn_row.session_id), ARRAY[]::uuid[])
  INTO affected_session_ids
  FROM session_turns turn_row
  JOIN sessions owned
    ON owned.account_id = turn_row.account_id
   AND owned.workspace_id = turn_row.workspace_id
   AND owned.id = turn_row.session_id
  WHERE turn_row.account_id = account_id_value
    AND turn_row.workspace_id = workspace_id_value
    AND turn_row.status IN (
      'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
    )
    AND (
      (target_membership_id IS NOT NULL
        AND owned.owner_organization_membership_id = target_membership_id)
      OR turn_row.initiating_human_subject_id = target_subject
    );
  affected_session_ids := ARRAY(
    SELECT DISTINCT candidate.session_id
    FROM (
      SELECT unnest(affected_session_ids) AS session_id
      UNION ALL
      SELECT realtime.session_id
      FROM session_realtime_modes realtime
      WHERE realtime.id = ANY(affected_realtime_ids)
    ) candidate
    ORDER BY candidate.session_id
  );

  interruption_operation_id := pg_catalog.gen_random_uuid();
  INSERT INTO session_command_receipts (
    id, account_id, workspace_id, actor_type, actor_subject_id,
    action, operation_key, canonical_request_hash, result
  ) VALUES (
    interruption_operation_id, account_id_value, workspace_id_value,
    'human', actor_subject, 'workspace.membership.remove',
    'workspace-membership:' || operation_id_value::text,
    input_hash_value,
    pg_catalog.jsonb_build_object(
      'workspaceMembershipOperationId', operation_id_value,
      'workspaceMembershipId', membership_row_id,
      'targetSubjectId', target_subject
    )
  );
  INSERT INTO session_attempt_interruptions (
    account_id, workspace_id, session_id, operation_id, attempt_id,
    kind, control_revision
  )
  SELECT attempt.account_id, attempt.workspace_id, attempt.session_id,
    interruption_operation_id, attempt.id, 'authority_change',
    CASE WHEN target_membership_id IS NOT NULL
      AND owned.owner_organization_membership_id = target_membership_id
      THEN owned.authority_epoch + 1 ELSE owned.authority_epoch END
  FROM session_turn_attempts attempt
  JOIN sessions owned ON owned.id = attempt.session_id
  JOIN session_turns initiated ON initiated.id = attempt.turn_id
  WHERE attempt.account_id = account_id_value
    AND attempt.workspace_id = workspace_id_value
    AND (
      (target_membership_id IS NOT NULL
        AND owned.owner_organization_membership_id = target_membership_id)
      OR initiated.initiating_human_subject_id = target_subject
    )
    AND attempt.state IN ('claimed', 'running')
  ON CONFLICT ON CONSTRAINT session_attempt_interruptions_operation_attempt_uq
  DO NOTHING;

  WITH cancelled AS (
    UPDATE session_turns turn_row
    SET status = 'cancelled', active_attempt_id = NULL,
      cancelled_by = actor_subject, cancel_reason = 'authority_changed',
      finished_at = now_value, updated_at = now_value,
      version = turn_row.version + 1
    WHERE turn_row.account_id = account_id_value
      AND turn_row.workspace_id = workspace_id_value
      AND turn_row.status IN (
        'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
      )
      AND EXISTS (
        SELECT 1 FROM sessions owned
        WHERE owned.account_id = turn_row.account_id
          AND owned.workspace_id = turn_row.workspace_id
          AND owned.id = turn_row.session_id
          AND (
            (target_membership_id IS NOT NULL
              AND owned.owner_organization_membership_id = target_membership_id)
            OR turn_row.initiating_human_subject_id = target_subject
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM session_turn_attempts live_attempt
        WHERE live_attempt.account_id = turn_row.account_id
          AND live_attempt.workspace_id = turn_row.workspace_id
          AND live_attempt.session_id = turn_row.session_id
          AND live_attempt.turn_id = turn_row.id
          AND live_attempt.id = turn_row.active_attempt_id
          AND live_attempt.state IN ('claimed', 'running')
      )
    RETURNING turn_row.id
  )
  SELECT COALESCE(pg_catalog.array_agg(cancelled.id ORDER BY cancelled.id), ARRAY[]::uuid[])
  INTO cancelled_turn_ids
  FROM cancelled;

  FOR cancelled_turn IN
    SELECT turn_row.id, turn_row.session_id, turn_row.execution_generation
    FROM session_turns turn_row
    WHERE turn_row.account_id = account_id_value
      AND turn_row.workspace_id = workspace_id_value
      AND turn_row.id = ANY(cancelled_turn_ids)
    ORDER BY turn_row.session_id, turn_row.id
  LOOP
    SELECT affected.last_sequence,
      CASE WHEN affected.active_turn_id = cancelled_turn.id
        THEN 'current' ELSE NULL END
    INTO cancelled_sequence, cancelled_association
    FROM sessions affected
    WHERE affected.account_id = account_id_value
      AND affected.workspace_id = workspace_id_value
      AND affected.id = cancelled_turn.session_id;
    FOR cancelled_request IN
      UPDATE session_human_input_requests request_row
      SET status = 'cancelled', response = '{"outcome":"cancelled"}'::jsonb,
        responded_by = actor_subject, responded_at = now_value,
        updated_at = now_value
      WHERE request_row.account_id = account_id_value
        AND request_row.workspace_id = workspace_id_value
        AND request_row.session_id = cancelled_turn.session_id
        AND request_row.turn_id = cancelled_turn.id
        AND request_row.status = 'pending'
      RETURNING request_row.id, request_row.creation_attempt_id
    LOOP
      cancelled_sequence := cancelled_sequence + 1;
      INSERT INTO session_events (
        account_id, workspace_id, session_id, sequence, type, payload,
        payload_codec_version, turn_id, turn_generation,
        turn_attempt_id, turn_association, occurred_at
      ) VALUES (
        account_id_value, workspace_id_value, cancelled_turn.session_id,
        cancelled_sequence, 'user.humanInputResponse',
        pg_catalog.jsonb_build_object(
          'requestId', cancelled_request.id,
          'response', pg_catalog.jsonb_build_object('outcome', 'cancelled')
        ), 1, cancelled_turn.id, cancelled_turn.execution_generation,
        cancelled_request.creation_attempt_id, cancelled_association, now_value
      );
    END LOOP;
    SELECT
      pg_catalog.array_agg(
        update_row.id ORDER BY update_row.created_at, update_row.id
      ),
      (pg_catalog.array_agg(
        update_row.delivered_history_item_id
        ORDER BY update_row.created_at, update_row.id
      ))[1]
    INTO settled_update_ids, settled_history_item_id
    FROM session_system_updates update_row
    WHERE update_row.account_id = account_id_value
      AND update_row.workspace_id = workspace_id_value
      AND update_row.session_id = cancelled_turn.session_id
      AND update_row.delivered_turn_id = cancelled_turn.id
      AND update_row.state = 'delivered';
    IF COALESCE(pg_catalog.array_length(settled_update_ids, 1), 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM session_events prior_settlement
        WHERE prior_settlement.account_id = account_id_value
          AND prior_settlement.workspace_id = workspace_id_value
          AND prior_settlement.session_id = cancelled_turn.session_id
          AND prior_settlement.turn_id = cancelled_turn.id
          AND prior_settlement.type = 'system.update.settled'
      )
    THEN
      cancelled_sequence := cancelled_sequence + 1;
      INSERT INTO session_events (
        account_id, workspace_id, session_id, sequence, type, payload,
        payload_codec_version, turn_id, turn_generation,
        turn_association, occurred_at
      ) VALUES (
        account_id_value, workspace_id_value, cancelled_turn.session_id,
        cancelled_sequence, 'system.update.settled',
        pg_catalog.jsonb_build_object(
          'updateIds', pg_catalog.to_jsonb(settled_update_ids),
          'count', pg_catalog.array_length(settled_update_ids, 1),
          'historyItemId', settled_history_item_id,
          'outcome', 'cancelled'
        ), 1, cancelled_turn.id, cancelled_turn.execution_generation,
        cancelled_association, now_value
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM session_events prior_cancel
      WHERE prior_cancel.account_id = account_id_value
        AND prior_cancel.workspace_id = workspace_id_value
        AND prior_cancel.session_id = cancelled_turn.session_id
        AND prior_cancel.turn_id = cancelled_turn.id
        AND prior_cancel.type = 'turn.cancelled'
    ) THEN
      cancelled_sequence := cancelled_sequence + 1;
      INSERT INTO session_events (
        account_id, workspace_id, session_id, sequence, type, payload,
        payload_codec_version, turn_id, turn_generation,
        turn_association, occurred_at
      ) VALUES (
        account_id_value, workspace_id_value, cancelled_turn.session_id,
        cancelled_sequence, 'turn.cancelled',
        pg_catalog.jsonb_build_object('reason', 'authority_changed'),
        1, cancelled_turn.id, cancelled_turn.execution_generation,
        cancelled_association, now_value
      );
    END IF;
    UPDATE sessions affected
    SET last_sequence = cancelled_sequence, updated_at = now_value
    WHERE affected.account_id = account_id_value
      AND affected.workspace_id = workspace_id_value
      AND affected.id = cancelled_turn.session_id;
  END LOOP;

  UPDATE interaction_interventions intervention
  SET status = 'cancelled', response_actor_subject_id = actor_subject,
    version = intervention.version + 1, settled_at = now_value,
    updated_at = now_value
  WHERE intervention.account_id = account_id_value
    AND intervention.workspace_id = workspace_id_value
    AND intervention.originating_turn_id = ANY(cancelled_turn_ids)
    AND intervention.status = 'open';
  DELETE FROM agent_run_states run_state
  WHERE run_state.account_id = account_id_value
    AND run_state.workspace_id = workspace_id_value
    AND run_state.turn_id = ANY(cancelled_turn_ids);
  UPDATE codex_capacity_waiters waiter
  SET status = 'superseded', observed_wake_revision = waiter.wake_revision,
    last_wake_reason = 'workspace_membership_remove',
    updated_at = now_value
  WHERE waiter.account_id = account_id_value
    AND waiter.workspace_id = workspace_id_value
    AND waiter.blocked_turn_id = ANY(cancelled_turn_ids)
    AND waiter.status = 'waiting';
  UPDATE xai_capacity_waiters waiter
  SET status = 'superseded', observed_wake_revision = waiter.wake_revision,
    last_wake_reason = 'workspace_membership_remove',
    updated_at = now_value
  WHERE waiter.account_id = account_id_value
    AND waiter.workspace_id = workspace_id_value
    AND waiter.blocked_turn_id = ANY(cancelled_turn_ids)
    AND waiter.status = 'waiting';
  UPDATE session_realtime_connections connection
  SET state = 'closed', closed_at = now_value, updated_at = now_value
  WHERE connection.account_id = account_id_value
    AND connection.workspace_id = workspace_id_value
    AND connection.realtime_id = ANY(affected_realtime_ids)
    AND connection.state IN ('negotiating', 'ready', 'active');
  WITH ended AS (
    UPDATE session_realtime_modes realtime
    SET state = 'ended', version = realtime.version + 1,
      ended_at = now_value, end_reason = 'authority_revoked',
      updated_at = now_value
    WHERE realtime.account_id = account_id_value
      AND realtime.workspace_id = workspace_id_value
      AND realtime.id = ANY(affected_realtime_ids)
      AND realtime.state = 'active'
    RETURNING realtime.id, realtime.session_id, realtime.operation_id,
      realtime.version, realtime.connection_epoch
  ), advanced AS (
    UPDATE sessions affected
    SET last_sequence = affected.last_sequence + 1, updated_at = now_value
    FROM ended
    WHERE affected.account_id = account_id_value
      AND affected.workspace_id = workspace_id_value
      AND affected.id = ended.session_id
    RETURNING affected.id AS session_id, affected.last_sequence,
      ended.id AS realtime_id, ended.operation_id,
      ended.version, ended.connection_epoch
  )
  INSERT INTO session_events (
    account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  )
  SELECT account_id_value, workspace_id_value, advanced.session_id,
    advanced.last_sequence, 'session.realtime.ended',
    pg_catalog.jsonb_build_object(
      'realtimeId', advanced.realtime_id,
      'operationId', advanced.operation_id,
      'reason', 'authority_revoked',
      'version', advanced.version,
      'connectionEpoch', advanced.connection_epoch
    ), now_value
  FROM advanced;
  UPDATE sessions affected
  SET active_turn_id = CASE
        WHEN affected.active_turn_id = ANY(cancelled_turn_ids) THEN NULL
        ELSE affected.active_turn_id
      END,
    status = CASE
      WHEN affected.active_turn_id = ANY(cancelled_turn_ids) THEN
        CASE WHEN EXISTS (
          SELECT 1 FROM session_turns queued
          WHERE queued.account_id = affected.account_id
            AND queued.workspace_id = affected.workspace_id
            AND queued.session_id = affected.id
            AND queued.status = 'queued'
        ) THEN 'queued' ELSE 'idle' END
      ELSE affected.status
    END,
    queue_head_position = COALESCE((
      SELECT min(queued.position)::bigint FROM session_turns queued
      WHERE queued.account_id = affected.account_id
        AND queued.workspace_id = affected.workspace_id
        AND queued.session_id = affected.id
        AND queued.status = 'queued'
    ), 0),
    queue_tail_position = COALESCE((
      SELECT max(queued.position)::bigint FROM session_turns queued
      WHERE queued.account_id = affected.account_id
        AND queued.workspace_id = affected.workspace_id
        AND queued.session_id = affected.id
        AND queued.status = 'queued'
    ), 0),
    queue_version = affected.queue_version + 1,
    updated_at = now_value
  WHERE affected.account_id = account_id_value
    AND affected.workspace_id = workspace_id_value
    AND EXISTS (
      SELECT 1 FROM session_turns cancelled
      WHERE cancelled.account_id = affected.account_id
        AND cancelled.workspace_id = affected.workspace_id
        AND cancelled.session_id = affected.id
        AND cancelled.id = ANY(cancelled_turn_ids)
    );
  UPDATE session_system_updates update_row SET state = 'cancelled'
  WHERE update_row.account_id = account_id_value
    AND update_row.workspace_id = workspace_id_value
    AND update_row.state = 'pending'
    AND target_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = update_row.session_id
        AND owned.owner_organization_membership_id = target_membership_id
    );
  UPDATE session_system_update_outbox outbox
  SET status = 'failed', last_error = 'workspace_membership_remove',
    updated_at = now_value
  WHERE outbox.account_id = account_id_value
    AND outbox.workspace_id = workspace_id_value
    AND outbox.status = 'pending'
    AND target_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions source_session
      WHERE source_session.id = outbox.source_session_id
        AND source_session.owner_organization_membership_id = target_membership_id
    );
  UPDATE session_goals goal_row
  SET status = 'paused', paused_reason = 'api',
    rationale = 'Workspace membership was removed; explicit reauthorization is required.',
    version = goal_row.version + 1, updated_at = now_value
  WHERE goal_row.account_id = account_id_value
    AND goal_row.workspace_id = workspace_id_value
    AND goal_row.status = 'active'
    AND target_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = goal_row.session_id
        AND owned.owner_organization_membership_id = target_membership_id
    );
  UPDATE scheduled_tasks task
  SET status = 'paused', personal_connection_delegations = '[]'::jsonb,
    authority_revision = task.authority_revision + 1,
    updated_at = now_value
  WHERE task.account_id = account_id_value
    AND task.workspace_id = workspace_id_value
    AND task.status = 'active'
    AND task.created_by_kind = 'subject'
    AND task.created_by_subject_id = target_subject;
  UPDATE organization_user_resource_grants grant_row
  SET status = 'revoked', revoked_at = now_value,
    generation = grant_row.generation + 1, updated_at = now_value
  WHERE grant_row.account_id = account_id_value
    AND grant_row.workspace_id = workspace_id_value
    AND grant_row.status = 'active'
    AND target_membership_id IS NOT NULL
    AND grant_row.owner_organization_membership_id = target_membership_id;
  IF target_membership_id IS NOT NULL THEN
    WITH advanced AS (
      UPDATE sessions owned SET
        authority_epoch = owned.authority_epoch + 1,
        initial_personal_connection_delegations = '[]'::jsonb,
        last_sequence = owned.last_sequence + 1
      WHERE owned.account_id = account_id_value
        AND owned.workspace_id = workspace_id_value
        AND owned.owner_organization_membership_id = target_membership_id
      RETURNING owned.id, owned.workspace_id, owned.last_sequence,
        owned.authority_epoch
    )
    INSERT INTO session_events (
      account_id, workspace_id, session_id, sequence, type, payload, occurred_at
    )
    SELECT account_id_value, advanced.workspace_id, advanced.id,
      advanced.last_sequence, 'session.authority.revoked',
      pg_catalog.jsonb_build_object(
        'operationId', operation_id_value,
        'organizationMembershipId', target_membership_id,
        'previousAuthorityEpoch', advanced.authority_epoch - 1,
        'authorityEpoch', advanced.authority_epoch
      ), now_value
    FROM advanced;
  END IF;
  INSERT INTO session_workflow_wake_outbox (
    session_id, account_id, workspace_id, temporal_workflow_id,
    reason, control_revision
  )
  SELECT affected.id, affected.account_id, affected.workspace_id,
    COALESCE(affected.temporal_workflow_id, 'session-' || affected.id::text),
    'workspace_membership_remove', 1
  FROM sessions affected
  WHERE affected.account_id = account_id_value
    AND affected.workspace_id = workspace_id_value
    AND affected.id = ANY(affected_session_ids)
  ON CONFLICT (session_id) DO UPDATE SET
    wake_revision = session_workflow_wake_outbox.wake_revision + 1,
    control_revision = session_workflow_wake_outbox.wake_revision + 1,
    temporal_workflow_id = EXCLUDED.temporal_workflow_id,
    reason = EXCLUDED.reason, attempts = 0,
    next_attempt_at = now_value, last_error = NULL,
    updated_at = now_value;

  -- Personal per-workspace rows and the membership itself, then the activity
  -- gate finalization exactly as the organization lifecycle performs it.
  DELETE FROM session_list_snapshots snapshot
  WHERE snapshot.workspace_id = workspace_id_value
    AND snapshot.subject_id = target_subject;
  DELETE FROM session_pins pin
  WHERE pin.workspace_id = workspace_id_value
    AND pin.subject_id = target_subject;
  DELETE FROM new_session_drafts draft
  WHERE draft.workspace_id = workspace_id_value
    AND draft.subject_id = target_subject;
  DELETE FROM workspace_memberships membership
  WHERE membership.id = membership_row_id;

  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_state', 'preparing', true
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_state', 'finalizing', true
  );
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = workspace_id_value
  RETURNING counter.revision INTO activity_revision_value;
  IF activity_revision_value IS NULL THEN
    RAISE EXCEPTION 'workspace membership session activity counter is unavailable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE sessions affected
  SET activity_revision = activity_revision_value,
    activity_revision_pending_xid = NULL
  WHERE affected.account_id = account_id_value
    AND affected.workspace_id = workspace_id_value
    AND affected.activity_revision_pending_xid
      = pg_catalog.pg_current_xact_id()::text::bigint;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;

  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id()
    AND capability.capability_id = visibility_capability_id;
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability',
    coalesce(previous_visibility_capability, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', coalesce(previous_workspace, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_state',
    coalesce(previous_activity_gate_state, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_workspace_id',
    coalesce(previous_activity_gate_workspace, ''), true
  );
  RETURN pg_catalog.jsonb_build_object(
    'removed', true,
    'workspaceMembershipId', membership_row_id,
    'cancelledTurnIds', pg_catalog.to_jsonb(cancelled_turn_ids),
    'affectedSessionIds', pg_catalog.to_jsonb(affected_session_ids)
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', coalesce(previous_workspace, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability',
    coalesce(previous_visibility_capability, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_state',
    coalesce(previous_activity_gate_state, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_activity_gate_workspace_id',
    coalesce(previous_activity_gate_workspace, ''), true
  );
  RAISE;
END
$body$;

-- 4. Hardening + grants. Same posture as every lifecycle seam: pinned
-- search_path, revoked from PUBLIC, EXECUTE granted only to the runtime role
-- where it exists (role-free dedicated-schema/embedded replays skip it).

REVOKE ALL ON FUNCTION prepare_workspace_membership_removal_settlements(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace_membership_removal_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.assert_workspace_membership_removal_actor(
  uuid, uuid, text, text
) FROM PUBLIC;

DO $workspace_membership_removal_seam$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.prepare_workspace_membership_removal_settlements(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.workspace_membership_removal_command(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.assert_workspace_membership_removal_actor'
      || '(uuid,uuid,text,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.prepare_workspace_membership_removal_settlements(jsonb) '
        || 'TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.workspace_membership_removal_command(jsonb) '
        || 'TO opengeni_app',
      data_schema
    );
  END IF;
END
$workspace_membership_removal_seam$;
