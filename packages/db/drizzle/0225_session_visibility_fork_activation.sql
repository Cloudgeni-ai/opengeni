-- deployment-mode: rolling
-- Activate an atomic, server-authoritative visibility transition. Independent
-- fork activation is added by the same numbered slice after this checkpoint.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_attempt_interruptions"
  DROP CONSTRAINT "session_attempt_interruptions_kind_check";
ALTER TABLE "session_attempt_interruptions"
  ADD CONSTRAINT "session_attempt_interruptions_kind_check"
  CHECK ("kind" IN (
    'session_pause', 'workspace_pause', 'steer', 'maintenance', 'authority_change'
  )) NOT VALID;
ALTER TABLE "session_attempt_interruptions"
  VALIDATE CONSTRAINT "session_attempt_interruptions_kind_check";

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_memberships";
CREATE POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  );

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_user_resource_grants";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_grants"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  );

DO $session_visibility_activation$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_actor_subject_id text,
      p_target_visibility text,
      p_expected_authority_epoch integer,
      p_operation_key text,
      p_canonical_request_hash text
    )
    RETURNS TABLE (
      operation_id uuid,
      visibility text,
      authority_epoch integer,
      owner_organization_membership_id uuid,
      changed boolean,
      replay boolean,
      interrupted_attempt_count integer,
      cancelled_turn_count integer,
      cancelled_update_count integer,
      paused_goal_count integer,
      revoked_grant_count integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership organization_memberships%%ROWTYPE;
      session_row sessions%%ROWTYPE;
      receipt_row session_command_receipts%%ROWTYPE;
      new_owner_id uuid;
      new_epoch integer;
      event_sequence integer;
      interruption_count integer := 0;
      turn_count integer := 0;
      update_count integer := 0;
      goal_count integer := 0;
      grant_count integer := 0;
      result_payload jsonb;
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
        OR p_actor_subject_id IS NULL OR p_expected_authority_epoch IS NULL
        OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
      THEN
        RAISE EXCEPTION 'session visibility transition requires complete authority'
          USING ERRCODE = '42501';
      END IF;
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
      THEN
        RAISE EXCEPTION 'session visibility transition authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      IF p_target_visibility NOT IN ('user_private', 'workspace_shared')
        OR p_expected_authority_epoch < 1
        OR p_actor_subject_id <> pg_catalog.btrim(p_actor_subject_id)
        OR pg_catalog.length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
        OR p_operation_key <> pg_catalog.btrim(p_operation_key)
        OR pg_catalog.length(p_operation_key) NOT BETWEEN 1 AND 1024
        OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
      THEN
        RAISE EXCEPTION 'session visibility transition request is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );

      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.id = p_workspace_id
        AND workspace_row.account_id = p_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;

      SELECT membership.* INTO actor_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_actor_subject_id
        AND membership.status = 'active'
      FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session visibility transition requires active membership'
          USING ERRCODE = '42501';
      END IF;

      SELECT session.* INTO session_row
      FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition session is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF session_row.owner_organization_membership_id IS NOT NULL
        AND session_row.owner_organization_membership_id <> actor_membership.id
      THEN
        RAISE EXCEPTION 'session visibility transition is owner-only'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, operation_key, canonical_request_hash
      ) VALUES (
        p_account_id, p_workspace_id, 'human', p_actor_subject_id,
        'session.visibility.change', p_session_id, p_operation_key,
        p_canonical_request_hash
      ) ON CONFLICT DO NOTHING;

      SELECT receipt.* INTO receipt_row
      FROM session_command_receipts receipt
      WHERE receipt.workspace_id = p_workspace_id
        AND receipt.actor_type = 'human'
        AND receipt.actor_subject_id = p_actor_subject_id
        AND receipt.actor_attempt_id IS NULL
        AND receipt.action = 'session.visibility.change'
        AND receipt.target_session_id = p_session_id
        AND receipt.target_turn_id IS NULL
        AND receipt.operation_key = p_operation_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition receipt is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
        RAISE EXCEPTION 'session visibility transition idempotency conflict'
          USING ERRCODE = '23505';
      END IF;
      IF receipt_row.result ->> 'status' = 'applied' THEN
        operation_id := receipt_row.id;
        visibility := receipt_row.result ->> 'visibility';
        authority_epoch := (receipt_row.result ->> 'authorityEpoch')::integer;
        owner_organization_membership_id := session_row.owner_organization_membership_id;
        changed := (receipt_row.result ->> 'changed')::boolean;
        replay := true;
        interrupted_attempt_count := (receipt_row.result ->> 'interruptedAttemptCount')::integer;
        cancelled_turn_count := (receipt_row.result ->> 'cancelledTurnCount')::integer;
        cancelled_update_count := (receipt_row.result ->> 'cancelledUpdateCount')::integer;
        paused_goal_count := (receipt_row.result ->> 'pausedGoalCount')::integer;
        revoked_grant_count := (receipt_row.result ->> 'revokedGrantCount')::integer;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
        RETURN NEXT;
        RETURN;
      END IF;
      IF session_row.authority_epoch <> p_expected_authority_epoch THEN
        RAISE EXCEPTION 'session visibility transition authority epoch conflict'
          USING ERRCODE = '40001';
      END IF;

      new_owner_id := session_row.owner_organization_membership_id;
      IF p_target_visibility = 'user_private' AND new_owner_id IS NULL THEN
        new_owner_id := actor_membership.id;
      END IF;
      IF session_row.visibility = p_target_visibility THEN
        new_epoch := session_row.authority_epoch;
      ELSE
        new_epoch := session_row.authority_epoch + 1;
        IF new_epoch < 2 THEN
          RAISE EXCEPTION 'session visibility transition authority epoch exhausted'
            USING ERRCODE = '22003';
        END IF;

        INSERT INTO session_attempt_interruptions (
          account_id, workspace_id, session_id, operation_id, attempt_id,
          kind, control_revision
        )
        SELECT attempt.account_id, attempt.workspace_id, attempt.session_id,
               receipt_row.id, attempt.id, 'authority_change', new_epoch
        FROM session_turn_attempts attempt
        WHERE attempt.workspace_id = p_workspace_id
          AND attempt.session_id = p_session_id
          AND attempt.state IN ('claimed', 'running')
        ON CONFLICT (operation_id, attempt_id) DO NOTHING;
        GET DIAGNOSTICS interruption_count = ROW_COUNT;

        UPDATE session_turns turn_row
        SET status = 'cancelled', cancelled_by = p_actor_subject_id,
            cancel_reason = 'authority_changed', finished_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp(), version = turn_row.version + 1
        WHERE turn_row.workspace_id = p_workspace_id
          AND turn_row.session_id = p_session_id
          AND turn_row.status = 'queued';
        GET DIAGNOSTICS turn_count = ROW_COUNT;

        UPDATE session_system_updates update_row
        SET state = 'cancelled', updated_at = pg_catalog.clock_timestamp()
        WHERE update_row.workspace_id = p_workspace_id
          AND update_row.session_id = p_session_id
          AND update_row.state = 'pending';
        GET DIAGNOSTICS update_count = ROW_COUNT;

        UPDATE session_goals goal_row
        SET status = 'paused', paused_reason = 'api',
            rationale = 'Session authority changed; explicit resume is required.',
            version = goal_row.version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE goal_row.workspace_id = p_workspace_id
          AND goal_row.session_id = p_session_id
          AND goal_row.status = 'active';
        GET DIAGNOSTICS goal_count = ROW_COUNT;

        UPDATE organization_user_resource_grants grant_row
        SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
            generation = grant_row.generation + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE grant_row.account_id = p_account_id
          AND grant_row.workspace_id = p_workspace_id
          AND grant_row.session_id = p_session_id
          AND grant_row.authority_epoch = session_row.authority_epoch
          AND grant_row.status = 'active';
        GET DIAGNOSTICS grant_count = ROW_COUNT;

        event_sequence := session_row.last_sequence + 1;
        UPDATE sessions
        SET visibility = p_target_visibility,
            owner_organization_membership_id = new_owner_id,
            authority_epoch = new_epoch,
            initial_personal_connection_delegations = '[]'::jsonb,
            last_sequence = event_sequence,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = p_session_id AND authority_epoch = session_row.authority_epoch;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'session visibility transition lost authority epoch CAS'
            USING ERRCODE = '40001';
        END IF;

        INSERT INTO session_events (
          account_id, workspace_id, session_id, sequence, type, payload, occurred_at
        ) VALUES (
          p_account_id, p_workspace_id, p_session_id, event_sequence,
          'session.visibility.changed',
          pg_catalog.jsonb_build_object(
            'operationId', receipt_row.id,
            'fromVisibility', CASE session_row.visibility
              WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
            'toVisibility', CASE p_target_visibility
              WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
            'previousAuthorityEpoch', session_row.authority_epoch,
            'authorityEpoch', new_epoch,
            'interruptedAttemptCount', interruption_count,
            'cancelledTurnCount', turn_count,
            'cancelledUpdateCount', update_count,
            'pausedGoalCount', goal_count,
            'revokedGrantCount', grant_count
          ),
          pg_catalog.clock_timestamp()
        );
      END IF;

      result_payload := pg_catalog.jsonb_build_object(
        'status', 'applied',
        'visibility', p_target_visibility,
        'authorityEpoch', new_epoch,
        'changed', session_row.visibility <> p_target_visibility,
        'interruptedAttemptCount', interruption_count,
        'cancelledTurnCount', turn_count,
        'cancelledUpdateCount', update_count,
        'pausedGoalCount', goal_count,
        'revokedGrantCount', grant_count
      );
      UPDATE session_command_receipts
      SET result = result_payload, updated_at = pg_catalog.clock_timestamp()
      WHERE id = receipt_row.id;

      operation_id := receipt_row.id;
      visibility := p_target_visibility;
      authority_epoch := new_epoch;
      owner_organization_membership_id := new_owner_id;
      changed := session_row.visibility <> p_target_visibility;
      replay := false;
      interrupted_attempt_count := interruption_count;
      cancelled_turn_count := turn_count;
      cancelled_update_count := update_count;
      paused_goal_count := goal_count;
      revoked_grant_count := grant_count;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$session_visibility_activation$;

COMMENT ON FUNCTION transition_session_visibility(uuid, uuid, uuid, text, text, integer, text, text) IS
  'Atomic owner-authorized visibility transition with authority-epoch CAS, stale-work fencing, grant revocation, and idempotent secret-safe receipt/event.';
