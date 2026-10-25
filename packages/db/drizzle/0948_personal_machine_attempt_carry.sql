-- deployment-mode: rolling
-- A turn may move to one of its initiating owner's personal machines while it
-- runs (the runtime authorizes that exact attempt against a live grant). When
-- the turn then continues in a replacement attempt, the accepted snapshot does
-- not mention the new machine and no owner click exists, so admission used to
-- fail on a missing snapshot row. The replacement attempt now re-proves the
-- same turn's earlier authorization against current state, or is refused with
-- the typed grant-required cause.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION carry_session_attempt_machine_authorization(
  p_attempt_id uuid, p_turn_id uuid, p_session_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  attempt_row session_turn_attempts%ROWTYPE;
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  authority_row organization_user_resource_authorities%ROWTYPE;
  prior_row session_attempt_connected_machine_authorizations%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  initiating_subject text;
  capability_added boolean;
  carried boolean := false;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;

  SELECT attempt.* INTO attempt_row FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id AND attempt.turn_id = p_turn_id AND attempt.session_id = p_session_id;
  SELECT session_value.* INTO session_row FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = attempt_row.account_id
    AND session_value.workspace_id = attempt_row.workspace_id FOR SHARE;
  IF session_row.active_sandbox_id IS NOT NULL THEN
    SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
    WHERE sandbox.id = session_row.active_sandbox_id AND sandbox.account_id = attempt_row.account_id
      AND sandbox.kind = 'selfhosted' FOR SHARE;
  END IF;
  IF sandbox_row.enrollment_id IS NOT NULL THEN
    SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
    WHERE enrollment.id = sandbox_row.enrollment_id AND enrollment.account_id = attempt_row.account_id
      AND enrollment.authority_scope = 'user' AND enrollment.status = 'active' FOR SHARE;
  END IF;

  -- Applies only where the accepted snapshot cannot: an active personal
  -- machine this attempt's snapshot does not cover. Everything else keeps the
  -- existing admission path unchanged.
  IF enrollment_row.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM session_attempt_personal_resource_snapshots snapshot
    WHERE snapshot.attempt_id = attempt_row.id AND snapshot.account_id = attempt_row.account_id
      AND snapshot.workspace_id = attempt_row.workspace_id AND snapshot.session_id = attempt_row.session_id
      AND snapshot.turn_id = attempt_row.turn_id
      AND snapshot.execution_generation = attempt_row.execution_generation
      AND snapshot.resource_kind = 'connected_machine' AND snapshot.resource_id = enrollment_row.id
      AND snapshot.action = 'connected_machine.use'
  ) THEN
    SELECT prior.* INTO prior_row FROM session_attempt_connected_machine_authorizations prior
    WHERE prior.account_id = attempt_row.account_id AND prior.workspace_id = attempt_row.workspace_id
      AND prior.session_id = attempt_row.session_id AND prior.turn_id = attempt_row.turn_id
      AND prior.enrollment_id = enrollment_row.id AND prior.attempt_id <> attempt_row.id
      AND prior.execution_generation < attempt_row.execution_generation
    ORDER BY prior.execution_generation DESC, prior.created_at DESC LIMIT 1;
    IF prior_row.attempt_id IS NULL THEN
      RAISE EXCEPTION 'matching personal-resource grant required' USING ERRCODE = 'OG002';
    END IF;

    SELECT turn_value.* INTO turn_row FROM session_turns turn_value
    WHERE turn_value.id = attempt_row.turn_id AND turn_value.account_id = attempt_row.account_id
      AND turn_value.workspace_id = attempt_row.workspace_id
      AND turn_value.session_id = attempt_row.session_id FOR SHARE;
    IF attempt_row.state NOT IN ('claimed', 'running') OR attempt_row.closed_at IS NOT NULL
      OR attempt_row.quiesced_at IS NOT NULL OR session_row.active_turn_id IS DISTINCT FROM attempt_row.turn_id
      OR turn_row.active_attempt_id IS DISTINCT FROM attempt_row.id
      OR turn_row.execution_generation IS DISTINCT FROM attempt_row.execution_generation
      OR NOT (attempt_row.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
    THEN RAISE EXCEPTION 'personal machine requires exact current attempt authority'
      USING ERRCODE = '42501'; END IF;

    -- Re-prove the earlier authorization with the rules the runtime used to
    -- grant it: the frozen initiating human still owns the machine, can still
    -- reach this workspace, and the machine authority has not moved on.
    initiating_subject := coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
      CASE WHEN turn_row.initiator_kind = 'subject' THEN nullif(btrim(turn_row.initiator_subject_id), '') END);
    SELECT membership.* INTO member_row FROM organization_memberships membership
    WHERE membership.account_id = attempt_row.account_id AND membership.subject_id = initiating_subject
      AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
    IF initiating_subject IS DISTINCT FROM prior_row.initiating_human_subject_id
      OR member_row.id IS NULL
      OR member_row.id IS DISTINCT FROM enrollment_row.owner_organization_membership_id
      OR member_row.id IS DISTINCT FROM prior_row.owner_organization_membership_id
      OR enrollment_row.revoked_at IS NOT NULL
      OR enrollment_row.generation IS DISTINCT FROM prior_row.enrollment_generation
      OR enrollment_row.authority_id IS DISTINCT FROM prior_row.authority_id
    THEN RAISE EXCEPTION 'matching personal-resource grant required' USING ERRCODE = 'OG002'; END IF;
    IF member_row.personal_workspace_id IS DISTINCT FROM attempt_row.workspace_id THEN
      PERFORM 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = attempt_row.account_id
        AND workspace_membership.workspace_id = attempt_row.workspace_id
        AND workspace_membership.subject_id = initiating_subject FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'matching personal-resource grant required'
        USING ERRCODE = 'OG002'; END IF;
    END IF;
    SELECT authority.* INTO authority_row FROM organization_user_resource_authorities authority
    WHERE authority.id = enrollment_row.authority_id AND authority.account_id = attempt_row.account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = 'connected_machine' AND authority.resource_id = enrollment_row.id
      AND authority.generation = enrollment_row.generation
      AND authority.generation = prior_row.authority_generation
      AND authority.status = 'active' AND authority.revoked_at IS NULL FOR SHARE;
    IF authority_row.id IS NULL THEN
      RAISE EXCEPTION 'matching personal-resource grant required' USING ERRCODE = 'OG002';
    END IF;

    -- A one-time grant this same turn already consumed keeps covering the
    -- turn, exactly like same-turn recovery of an accepted snapshot.
    IF prior_row.grant_mode = 'once' THEN
      SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
      JOIN personal_resource_once_consumption_receipts receipt ON receipt.grant_id = grant_value.id
        AND receipt.account_id = grant_value.account_id AND receipt.turn_id = attempt_row.turn_id
        AND receipt.session_id = attempt_row.session_id AND receipt.grant_generation = grant_value.generation
      WHERE grant_value.id = prior_row.grant_id AND grant_value.account_id = attempt_row.account_id
        AND grant_value.generation = prior_row.grant_generation
        AND grant_value.authority_id = authority_row.id
        AND grant_value.owner_organization_membership_id = member_row.id
        AND grant_value.workspace_id = attempt_row.workspace_id
        AND grant_value.action = 'connected_machine.use'
        AND grant_value.mode = 'once' AND grant_value.status = 'consumed'
        AND grant_value.session_id = attempt_row.session_id
        AND grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch
      FOR SHARE OF grant_value;
    END IF;
    -- Otherwise a live grant must still cover this chat. Recovery never spends
    -- a fresh one-time grant: that is a new use, decided by the runtime or owner.
    IF grant_row.id IS NULL THEN
      SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
      WHERE grant_value.account_id = attempt_row.account_id
        AND grant_value.authority_id = authority_row.id
        AND grant_value.owner_organization_membership_id = member_row.id
        AND grant_value.workspace_id = attempt_row.workspace_id
        AND grant_value.action = 'connected_machine.use'
        AND grant_value.mode <> 'once'
        AND (((grant_value.context = session_row.visibility OR (
          grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'
          AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id
          AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))) AND grant_value.status = 'active'
        AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
        AND ((grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = attempt_row.session_id
            AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))
          OR (grant_value.mode = 'always' AND grant_value.session_id IS NULL
            AND grant_value.authority_epoch IS NULL))
        ) OR personal_machine_grant_covers_descendant(grant_value.id, attempt_row.session_id, attempt_row.turn_id, enrollment_row.id))
      ORDER BY CASE grant_value.mode WHEN 'session' THEN 1 ELSE 2 END,
        grant_value.generation DESC, grant_value.id LIMIT 1 FOR SHARE;
    END IF;
    IF grant_row.id IS NULL THEN
      RAISE EXCEPTION 'matching personal-resource grant required' USING ERRCODE = 'OG002';
    END IF;

    INSERT INTO session_attempt_connected_machine_authorizations(
      attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
      initiating_human_subject_id, owner_organization_membership_id,
      membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
      authority_generation, enrollment_generation, session_visibility,
      session_authority_epoch, grant_id, grant_generation, grant_mode
    ) VALUES (
      attempt_row.id, attempt_row.account_id, attempt_row.workspace_id, attempt_row.session_id,
      attempt_row.turn_id, attempt_row.execution_generation, initiating_subject, member_row.id,
      member_row.authorization_revision, enrollment_row.id, sandbox_row.id,
      authority_row.id, authority_row.generation, enrollment_row.generation,
      session_row.visibility, session_row.authority_epoch,
      grant_row.id, grant_row.generation, grant_row.mode
    ) ON CONFLICT (attempt_id, enrollment_id) DO NOTHING;
    carried := true;
  END IF;

  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN carried;
END
$$;
REVOKE ALL ON FUNCTION carry_session_attempt_machine_authorization(uuid, uuid, uuid) FROM PUBLIC;

DO $pin$
BEGIN
  EXECUTE format('ALTER FUNCTION carry_session_attempt_machine_authorization(uuid,uuid,uuid) '
    || 'SET search_path = pg_catalog, %I, pg_temp', current_schema());
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON FUNCTION carry_session_attempt_machine_authorization(uuid,uuid,uuid) FROM opengeni_app;
  END IF;
END
$pin$;

-- Only the snapshot-based protocol needs this. The legacy protocol already
-- evaluates live grants on every attempt. An owner-click consent still wins.
DO $extend$
DECLARE
  body text;
  anchor constant text := 'IF bind_session_attempt_machine_consent(NEW.id, NEW.turn_id, NEW.session_id) THEN RETURN NEW; END IF;';
BEGIN
  SELECT prosrc INTO STRICT body FROM pg_proc
  WHERE oid = 'admit_session_attempt_personal_machine_v1()'::regprocedure;
  IF (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0948 personal machine admission source drift' USING ERRCODE = '55000';
  END IF;
  body := replace(body, anchor, anchor || E'\n  IF carry_session_attempt_machine_authorization(NEW.id, NEW.turn_id, NEW.session_id) THEN RETURN NEW; END IF;');
  EXECUTE format('CREATE OR REPLACE FUNCTION admit_session_attempt_personal_machine_v1() RETURNS trigger '
    || 'LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS %L', current_schema(), body);
END
$extend$;
