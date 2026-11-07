-- deployment-mode: rolling
-- "Allow once" for a personal Connected Machine never worked for a message
-- sent with it. Accepting the message uses up the one-time grant and files
-- its receipt against the message (turn_personal_resource_once_receipts).
-- Admitting the turn's attempt checks that receipt and records the machine
-- authorization with grant mode 'once'. The check right before the turn uses
-- the machine (assert_session_attempt_personal_machine) only looked for a
-- receipt filed against the attempt (personal_resource_once_consumption_
-- receipts), which only turns sent without an attachment get. Every such turn
-- was refused with "personal machine authority is no longer live".
--
-- The check now also accepts the message's own receipt for the same grant,
-- grant generation and machine authority, read under the same transient
-- 'resolve' capability resolve_session_attempt_personal_resources uses. The
-- receipt belongs to the message, so a retry of the same message is still
-- covered and a later message never is. Everything else is unchanged from the
-- baseline.
--
-- Same signature, so the owner and grants are kept. The previous release
-- keeps working: this only admits turns it wrongly refused.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION assert_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid, p_require_active_sandbox boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  authorization_row session_attempt_connected_machine_authorizations%ROWTYPE;
  resolve_added boolean := false;
  caller_subject text := coalesce(
    nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
  );
BEGIN
  IF assert_session_attempt_machine_consent(p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id, p_execution_generation, p_enrollment_id, p_require_active_sandbox, true) THEN RETURN true; END IF;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'machine runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'runtime')
  ON CONFLICT DO NOTHING;
  SELECT authorization_value.* INTO authorization_row
  FROM session_attempt_connected_machine_authorizations authorization_value
  WHERE authorization_value.attempt_id = p_attempt_id
    AND authorization_value.account_id = p_account_id
    AND authorization_value.workspace_id = p_workspace_id
    AND authorization_value.session_id = p_session_id
    AND authorization_value.turn_id = p_turn_id
    AND authorization_value.execution_generation = p_execution_generation
    AND authorization_value.enrollment_id = p_enrollment_id;
  IF authorization_row.attempt_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'runtime';
    RETURN false;
  END IF;
  -- A message sent with "Allow once" files its receipt against the message;
  -- reading it needs the transient resolve capability.
  IF authorization_row.grant_mode = 'once' THEN
    INSERT INTO opengeni_private.personal_resource_delegation_capabilities(
      backend_pid, transaction_id, capability_kind
    ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
    ON CONFLICT DO NOTHING;
    resolve_added := FOUND;
  END IF;
  IF caller_subject IS DISTINCT FROM authorization_row.initiating_human_subject_id
    OR NOT EXISTS (
      SELECT 1 FROM sessions session_value
      JOIN session_turns turn_value ON turn_value.id = p_turn_id
        AND turn_value.account_id = session_value.account_id
        AND turn_value.workspace_id = session_value.workspace_id
        AND turn_value.session_id = session_value.id
      JOIN session_turn_attempts attempt ON attempt.id = p_attempt_id
        AND attempt.turn_id = turn_value.id AND attempt.session_id = session_value.id
        AND attempt.account_id = session_value.account_id
        AND attempt.workspace_id = session_value.workspace_id
      JOIN sandboxes sandbox ON sandbox.id = authorization_row.sandbox_id
        AND sandbox.account_id = session_value.account_id
      WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id
        AND session_value.active_turn_id = p_turn_id
        AND (NOT p_require_active_sandbox
          OR session_value.active_sandbox_id = authorization_row.sandbox_id)
        AND (authorization_row.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)
        AND turn_value.active_attempt_id = p_attempt_id
        AND turn_value.execution_generation = p_execution_generation
        AND turn_value.status = 'running'
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL
        AND attempt.quiesced_at IS NULL
        AND sandbox.enrollment_id = p_enrollment_id
    )
    OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.attempt_id = p_attempt_id AND interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.state IN ('pending','delivered','acknowledged')
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = authorization_row.owner_organization_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = authorization_row.initiating_human_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.authorization_revision
          = authorization_row.membership_authorization_revision
        AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = membership.subject_id
        ))
    )
    OR NOT EXISTS (
      SELECT 1 FROM enrollments enrollment
      WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
        AND enrollment.authority_scope = 'user'
        AND enrollment.owner_organization_membership_id
          = authorization_row.owner_organization_membership_id
        AND enrollment.authority_id = authorization_row.authority_id
        AND enrollment.generation = authorization_row.enrollment_generation
        AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.id = authorization_row.authority_id
        AND authority.account_id = p_account_id
        AND authority.organization_membership_id
          = authorization_row.owner_organization_membership_id
        AND authority.resource_kind = 'connected_machine'
        AND authority.resource_id = p_enrollment_id
        AND authority.generation = authorization_row.authority_generation
        AND authority.status = 'active' AND authority.revoked_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_user_resource_grants grant_value
      WHERE grant_value.id = authorization_row.grant_id
        AND grant_value.account_id = p_account_id
        AND grant_value.authority_id = authorization_row.authority_id
        AND grant_value.owner_organization_membership_id
          = authorization_row.owner_organization_membership_id
        AND grant_value.workspace_id = p_workspace_id
        AND grant_value.generation = authorization_row.grant_generation
        AND grant_value.action = 'connected_machine.use'
        AND grant_value.context = authorization_row.session_visibility
        AND grant_value.mode = authorization_row.grant_mode
        AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
        AND (personal_machine_grant_covers_descendant(grant_value.id, p_session_id, p_turn_id, p_enrollment_id) OR (authorization_row.grant_mode = 'once' AND grant_value.status = 'consumed'
          AND grant_value.session_id = p_session_id
          AND EXISTS (SELECT 1 FROM sessions grant_session WHERE grant_session.account_id=p_account_id AND grant_session.workspace_id=p_workspace_id AND grant_session.id=p_session_id AND grant_value.authority_epoch BETWEEN grant_session.execution_authority_epoch AND grant_session.authority_epoch)
          AND (EXISTS (SELECT 1 FROM personal_resource_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_value.id AND receipt.attempt_id = p_attempt_id
              AND receipt.account_id = p_account_id)
            -- The receipt of the message this attempt runs, as admission checked it.
            OR EXISTS (SELECT 1 FROM turn_personal_resource_once_receipts once_receipt
              WHERE once_receipt.grant_id = grant_value.id AND once_receipt.turn_id = p_turn_id
                AND once_receipt.account_id = p_account_id
                AND once_receipt.authority_id = authorization_row.authority_id
                AND once_receipt.authority_generation = authorization_row.authority_generation
                AND once_receipt.grant_generation = authorization_row.grant_generation)))
          OR (authorization_row.grant_mode = 'session' AND grant_value.status = 'active'
            AND grant_value.session_id = p_session_id
            AND EXISTS (SELECT 1 FROM sessions grant_session WHERE grant_session.account_id=p_account_id AND grant_session.workspace_id=p_workspace_id AND grant_session.id=p_session_id AND grant_value.authority_epoch BETWEEN grant_session.execution_authority_epoch AND grant_session.authority_epoch))
          OR (authorization_row.grant_mode = 'always' AND grant_value.status = 'active'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL))
    )
  THEN RAISE EXCEPTION 'personal machine authority is no longer live'
    USING ERRCODE = '42501'; END IF;
  INSERT INTO audit_events(
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, authorization_row.initiating_human_subject_id,
    'connected_machine.used', 'enrollment', p_enrollment_id::text,
    pg_catalog.jsonb_build_object(
      'ownerOrganizationMembershipId', authorization_row.owner_organization_membership_id,
      'scope', 'user', 'sessionId', p_session_id, 'turnId', p_turn_id,
      'attemptId', p_attempt_id, 'executionGeneration', p_execution_generation,
      'generation', authorization_row.enrollment_generation
    ), 1
  );
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'runtime';
  IF resolve_added THEN
    DELETE FROM opengeni_private.personal_resource_delegation_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'resolve';
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  IF resolve_added THEN
    DELETE FROM opengeni_private.personal_resource_delegation_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'resolve';
  END IF;
  RAISE;
END
$$;

-- The same pinned search path the baseline gave this routine.
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION assert_session_attempt_personal_machine(uuid, uuid, uuid, uuid, uuid, integer, uuid, boolean) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$search_path$;
