-- deployment-mode: rolling
-- A person's own Connected Machine runs their own turns wherever it is on,
-- without a grant for each chat (docs/design/ownership-and-reach.md, rules 5
-- and 8). "On in a workspace" is the standing (`always`) permission the owner
-- gives there, in either chat context. The owner's Personal workspace and the
-- workspace where the machine was connected are on without asking: the first
-- turn there records that standing permission.
--
-- Before this, a turn accepted without a turn-bound approval for the machine
-- (an agent's own continuation, a wake-up, a schedule, a move the agent made)
-- was refused unless an earlier attempt of the same turn had been admitted,
-- even when the owner had given standing permission; standing permission for
-- private chats also did not cover shared chats. Owners were asked again in
-- every chat.
--
-- opengeni_private.admit_own_personal_machine_v1 proves, for one live
-- attempt: the turn's person owns the machine, still belongs to the
-- organization and can reach the workspace, the machine authority is current,
-- and standing permission exists in the workspace. It records the attempt's
-- machine authorization and returns true; otherwise it returns false and
-- records nothing. carry_session_attempt_machine_authorization (attempt
-- admission), admit_session_attempt_personal_machine (the same for turns
-- sent without approvals) and authorize_session_attempt_personal_machine
-- (moving a running chat onto the machine) call it before refusing.
-- get_session_machine_access no longer reports such a turn as waiting for an
-- approval. Everything else in all four is unchanged. Other people's turns
-- are still never admitted.
--
-- Both new functions are plain (SECURITY INVOKER) helpers that only those
-- admission definers call, so they run as the definers' owner. Nobody else
-- can execute them.
--
-- Same signatures, so grants are kept. The previous release keeps working:
-- this only admits more of the owner's own turns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Whether a personal machine is on in a workspace for its owner: standing
-- permission there, or the owner's Personal workspace or the workspace where
-- it was connected, unless the owner turned it off there. Callers hold a
-- scoped compute capability that lets them read grants.
CREATE FUNCTION opengeni_private.personal_machine_on_in_workspace_v1(
  p_account_id uuid, p_enrollment_id uuid, p_workspace_id uuid
) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path FROM CURRENT
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM enrollments enrollment
    JOIN organization_memberships owner ON owner.id = enrollment.owner_organization_membership_id
      AND owner.account_id = enrollment.account_id
    WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
      AND enrollment.authority_scope = 'user'
      AND (EXISTS (
          SELECT 1 FROM organization_user_resource_grants standing
          WHERE standing.account_id = p_account_id
            AND standing.authority_id = enrollment.authority_id
            AND standing.owner_organization_membership_id = owner.id
            AND standing.workspace_id = p_workspace_id
            AND standing.action = 'connected_machine.use'
            AND standing.mode = 'always' AND standing.session_id IS NULL
            AND standing.status = 'active'
            AND (standing.expires_at IS NULL OR standing.expires_at > clock_timestamp()))
        OR ((p_workspace_id = owner.personal_workspace_id
            OR p_workspace_id = coalesce(enrollment.origin_workspace_id, enrollment.workspace_id))
          AND NOT EXISTS (
            -- Once the owner turned it off there, it stays off until they allow it.
            SELECT 1 FROM organization_user_resource_grants revoked
            WHERE revoked.account_id = p_account_id
              AND revoked.authority_id = enrollment.authority_id
              AND revoked.workspace_id = p_workspace_id
              AND revoked.action = 'connected_machine.use'
              AND revoked.mode = 'always' AND revoked.session_id IS NULL
              AND revoked.status = 'revoked')))
  )
$$;

CREATE FUNCTION opengeni_private.admit_own_personal_machine_v1(
  p_attempt_id uuid, p_enrollment_id uuid, p_sandbox_id uuid
) RETURNS boolean
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  attempt_row session_turn_attempts%ROWTYPE;
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  authority_row organization_user_resource_authorities%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  initiating_subject text;
BEGIN
  -- Callers hold the scoped compute write capability for this transaction.
  SELECT attempt.* INTO attempt_row FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id;
  IF attempt_row.id IS NULL THEN RETURN false; END IF;
  SELECT session_value.* INTO session_row FROM sessions session_value
  WHERE session_value.id = attempt_row.session_id
    AND session_value.account_id = attempt_row.account_id
    AND session_value.workspace_id = attempt_row.workspace_id FOR SHARE;
  SELECT turn_value.* INTO turn_row FROM session_turns turn_value
  WHERE turn_value.id = attempt_row.turn_id AND turn_value.account_id = attempt_row.account_id
    AND turn_value.workspace_id = attempt_row.workspace_id
    AND turn_value.session_id = attempt_row.session_id FOR SHARE;
  IF session_row.id IS NULL OR turn_row.id IS NULL
    OR attempt_row.state NOT IN ('claimed', 'running') OR attempt_row.closed_at IS NOT NULL
    OR attempt_row.quiesced_at IS NOT NULL
    OR session_row.active_turn_id IS DISTINCT FROM attempt_row.turn_id
    OR turn_row.active_attempt_id IS DISTINCT FROM attempt_row.id
    OR turn_row.execution_generation IS DISTINCT FROM attempt_row.execution_generation
    OR NOT (attempt_row.authority_epoch
      BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
    OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.attempt_id = attempt_row.id
        AND interruption.account_id = attempt_row.account_id
        AND interruption.workspace_id = attempt_row.workspace_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged'))
  THEN RETURN false; END IF;

  -- The turn's person: its sender, or for work started on their behalf the
  -- human it was frozen to. A turn without a person never uses a personal
  -- machine.
  initiating_subject := coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN nullif(btrim(turn_row.initiator_subject_id), '') END);
  IF initiating_subject IS NULL THEN RETURN false; END IF;

  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = attempt_row.account_id
    AND enrollment.authority_scope = 'user' AND enrollment.status = 'active'
    AND enrollment.revoked_at IS NULL FOR SHARE;
  IF enrollment_row.id IS NULL THEN RETURN false; END IF;
  SELECT membership.* INTO member_row FROM organization_memberships membership
  WHERE membership.account_id = attempt_row.account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
  IF member_row.id IS NULL
    OR member_row.id IS DISTINCT FROM enrollment_row.owner_organization_membership_id
  THEN RETURN false; END IF;
  IF member_row.personal_workspace_id IS DISTINCT FROM attempt_row.workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = attempt_row.account_id
      AND workspace_membership.workspace_id = attempt_row.workspace_id
      AND workspace_membership.subject_id = initiating_subject FOR KEY SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  SELECT authority.* INTO authority_row FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id
    AND authority.account_id = attempt_row.account_id
    AND authority.organization_membership_id = member_row.id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = enrollment_row.id
    AND authority.generation = enrollment_row.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL FOR SHARE;
  IF authority_row.id IS NULL THEN RETURN false; END IF;

  -- Standing permission in this workspace covers private and shared chats.
  SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
  WHERE grant_value.account_id = attempt_row.account_id
    AND grant_value.authority_id = authority_row.id
    AND grant_value.owner_organization_membership_id = member_row.id
    AND grant_value.workspace_id = attempt_row.workspace_id
    AND grant_value.action = 'connected_machine.use'
    AND grant_value.mode = 'always' AND grant_value.session_id IS NULL
    AND grant_value.status = 'active'
    AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
  ORDER BY (grant_value.context = session_row.visibility) DESC,
    grant_value.generation DESC, grant_value.id
  LIMIT 1 FOR SHARE;
  -- The owner's Personal workspace and the workspace where the machine was
  -- connected are on from the start. Recording it there gives the owner one
  -- place to turn it off again.
  IF grant_row.id IS NULL AND opengeni_private.personal_machine_on_in_workspace_v1(
    attempt_row.account_id, enrollment_row.id, attempt_row.workspace_id)
  THEN
    INSERT INTO organization_user_resource_grants(
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, generation, status
    ) VALUES (
      attempt_row.account_id, authority_row.id, member_row.id, attempt_row.workspace_id,
      NULL, 'connected_machine.use', 'always', session_row.visibility, NULL, 1, 'active'
    ) ON CONFLICT DO NOTHING;
    SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
    WHERE grant_value.account_id = attempt_row.account_id
      AND grant_value.authority_id = authority_row.id
      AND grant_value.owner_organization_membership_id = member_row.id
      AND grant_value.workspace_id = attempt_row.workspace_id
      AND grant_value.action = 'connected_machine.use'
      AND grant_value.mode = 'always' AND grant_value.session_id IS NULL
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
    ORDER BY (grant_value.context = session_row.visibility) DESC,
      grant_value.generation DESC, grant_value.id
    LIMIT 1 FOR SHARE;
  END IF;
  IF grant_row.id IS NULL THEN RETURN false; END IF;

  INSERT INTO session_attempt_connected_machine_authorizations(
    attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
    authority_generation, enrollment_generation, session_visibility,
    session_authority_epoch, grant_id, grant_generation, grant_mode
  ) VALUES (
    attempt_row.id, attempt_row.account_id, attempt_row.workspace_id,
    attempt_row.session_id, attempt_row.turn_id, attempt_row.execution_generation,
    initiating_subject, member_row.id, member_row.authorization_revision,
    enrollment_row.id, p_sandbox_id, authority_row.id, authority_row.generation,
    enrollment_row.generation, session_row.visibility, session_row.authority_epoch,
    grant_row.id, grant_row.generation, grant_row.mode
  ) ON CONFLICT (attempt_id, enrollment_id) DO NOTHING;
  RETURN true;
END
$$;

-- Unchanged from the baseline except for the standing-permission check before
-- refusing an uncovered personal machine.
CREATE OR REPLACE FUNCTION carry_session_attempt_machine_authorization(p_attempt_id uuid, p_turn_id uuid, p_session_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
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
  -- The owner's own turn where the machine is on needs no turn-bound approval.
  IF opengeni_private.admit_own_personal_machine_v1(attempt_row.id, enrollment_row.id, sandbox_row.id) THEN
    carried := true;
  ELSE
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
  END IF;

  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN carried;
END
$$;

-- Unchanged from the baseline except for the standing-permission check before
-- refusing a move onto the machine.
CREATE OR REPLACE FUNCTION authorize_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  attempt_row session_turn_attempts%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  authority_row organization_user_resource_authorities%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  authorization_row session_attempt_connected_machine_authorizations%ROWTYPE;
  initiating_subject text;
  caller_subject text := coalesce(
    nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
  );
  affected integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'machine runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id FOR SHARE;
  SELECT turn_value.* INTO STRICT turn_row FROM session_turns turn_value
  WHERE turn_value.id = p_turn_id AND turn_value.account_id = p_account_id
    AND turn_value.workspace_id = p_workspace_id
    AND turn_value.session_id = p_session_id FOR SHARE;
  SELECT attempt_value.* INTO STRICT attempt_row FROM session_turn_attempts attempt_value
  WHERE attempt_value.id = p_attempt_id AND attempt_value.account_id = p_account_id
    AND attempt_value.workspace_id = p_workspace_id
    AND attempt_value.session_id = p_session_id
    AND attempt_value.turn_id = p_turn_id FOR SHARE;
  IF attempt_row.execution_generation IS DISTINCT FROM p_execution_generation
    OR attempt_row.state NOT IN ('claimed', 'running')
    OR attempt_row.closed_at IS NOT NULL OR attempt_row.quiesced_at IS NOT NULL
    OR session_row.active_turn_id IS DISTINCT FROM p_turn_id
    OR turn_row.active_attempt_id IS DISTINCT FROM p_attempt_id
    OR turn_row.execution_generation IS DISTINCT FROM p_execution_generation
    OR NOT (attempt_row.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
    OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.attempt_id = p_attempt_id
        AND interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  THEN RAISE EXCEPTION 'personal machine requires exact current attempt authority'
    USING ERRCODE = '42501'; END IF;
  initiating_subject := coalesce(
    nullif(btrim(turn_row.initiating_human_subject_id), ''),
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN nullif(btrim(turn_row.initiator_subject_id), '') END
  );
  IF caller_subject IS DISTINCT FROM initiating_subject THEN
    RAISE EXCEPTION 'personal machine caller is not the frozen initiating human'
      USING ERRCODE = '42501';
  END IF;
  SELECT enrollment.* INTO STRICT enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
    AND enrollment.authority_scope = 'user' AND enrollment.status = 'active'
    AND enrollment.revoked_at IS NULL FOR SHARE;
  SELECT sandbox.* INTO STRICT sandbox_row FROM sandboxes sandbox
  WHERE sandbox.account_id = p_account_id AND sandbox.enrollment_id = p_enrollment_id
    AND sandbox.kind = 'selfhosted' ORDER BY sandbox.created_at, sandbox.id LIMIT 1 FOR SHARE;
  SELECT membership.* INTO STRICT member_row FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.subject_id = initiating_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
  IF member_row.id IS DISTINCT FROM enrollment_row.owner_organization_membership_id THEN
    RAISE EXCEPTION 'only the personal machine owner may use it'
      USING ERRCODE = '42501';
  END IF;
  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = initiating_subject FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'machine owner lacks target workspace access'
      USING ERRCODE = '42501'; END IF;
  END IF;
  SELECT authority.* INTO STRICT authority_row
  FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id AND authority.account_id = p_account_id
    AND authority.organization_membership_id = member_row.id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = enrollment_row.id
    AND authority.generation = enrollment_row.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL FOR SHARE;
  SELECT authorization_value.* INTO authorization_row
  FROM session_attempt_connected_machine_authorizations authorization_value
  WHERE authorization_value.attempt_id = p_attempt_id
    AND authorization_value.enrollment_id = p_enrollment_id FOR SHARE;
  IF authorization_row.attempt_id IS NOT NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'write';
    RETURN true;
  END IF;
  SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
  WHERE grant_value.account_id = p_account_id
    AND grant_value.authority_id = authority_row.id
    AND grant_value.owner_organization_membership_id = member_row.id
    AND grant_value.workspace_id = p_workspace_id
    AND grant_value.action = 'connected_machine.use'
    AND (((grant_value.context = session_row.visibility OR (
      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'
      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id
      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))) AND grant_value.status = 'active'
    AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
    AND ((grant_value.mode IN ('once', 'session')
        AND grant_value.session_id = p_session_id
        AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))
      OR (grant_value.mode = 'always' AND grant_value.session_id IS NULL
        AND grant_value.authority_epoch IS NULL))
) OR personal_machine_grant_covers_descendant(grant_value.id, p_session_id, p_turn_id, enrollment_row.id))
  ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
    grant_value.generation DESC, grant_value.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- The owner's own turn where the machine is on needs no grant for this chat.
    IF opengeni_private.admit_own_personal_machine_v1(p_attempt_id, p_enrollment_id, sandbox_row.id) THEN
      DELETE FROM opengeni_private.scoped_compute_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RETURN true;
    END IF;
    RAISE EXCEPTION 'personal machine use requires explicit grant'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO session_attempt_connected_machine_authorizations(
    attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
    authority_generation, enrollment_generation, session_visibility,
    session_authority_epoch, grant_id, grant_generation, grant_mode
  ) VALUES (
    p_attempt_id, p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_execution_generation, initiating_subject, member_row.id,
    member_row.authorization_revision, enrollment_row.id, sandbox_row.id,
    authority_row.id, authority_row.generation, enrollment_row.generation,
    session_row.visibility, session_row.authority_epoch,
    grant_row.id, grant_row.generation, grant_row.mode
  ) ON CONFLICT (attempt_id, enrollment_id) DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 AND grant_row.mode = 'once' AND grant_row.session_id = p_session_id THEN
    UPDATE organization_user_resource_grants SET status = 'consumed',
      updated_at = clock_timestamp()
    WHERE id = grant_row.id AND account_id = p_account_id
      AND generation = grant_row.generation AND status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'once machine grant lost first-use race'
      USING ERRCODE = '40001'; END IF;
    INSERT INTO personal_resource_once_consumption_receipts(
      grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
      execution_generation, authority_id, authority_generation, grant_generation
    ) VALUES (
      grant_row.id, p_account_id, p_attempt_id, p_workspace_id, p_session_id,
      p_turn_id, p_execution_generation, authority_row.id,
      authority_row.generation, grant_row.generation
    );
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;



-- Unchanged from the baseline except for the standing-permission check before
-- refusing the machine to a turn sent without approvals (protocol 0).
CREATE OR REPLACE FUNCTION admit_session_attempt_personal_machine() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  initiating_subject text;
  affected integer;
BEGIN
  IF bind_session_attempt_machine_consent(NEW.id, NEW.turn_id, NEW.session_id) THEN RETURN NEW; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = NEW.session_id AND session_value.account_id = NEW.account_id
    AND session_value.workspace_id = NEW.workspace_id FOR SHARE;
  IF session_row.active_sandbox_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.id = session_row.active_sandbox_id AND sandbox.account_id = NEW.account_id
    AND sandbox.kind = 'selfhosted' FOR SHARE;
  IF sandbox_row.enrollment_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = sandbox_row.enrollment_id AND enrollment.account_id = NEW.account_id
    AND enrollment.authority_scope = 'user' AND enrollment.status = 'active' FOR SHARE;
  IF enrollment_row.id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT turn_value.* INTO STRICT turn_row FROM session_turns turn_value
  WHERE turn_value.id = NEW.turn_id AND turn_value.account_id = NEW.account_id
    AND turn_value.workspace_id = NEW.workspace_id
    AND turn_value.session_id = NEW.session_id FOR SHARE;
  IF NEW.state NOT IN ('claimed', 'running') OR NEW.closed_at IS NOT NULL
    OR NEW.quiesced_at IS NOT NULL OR session_row.active_turn_id IS DISTINCT FROM NEW.turn_id
    OR turn_row.active_attempt_id IS DISTINCT FROM NEW.id
    OR turn_row.execution_generation IS DISTINCT FROM NEW.execution_generation
    OR NOT (NEW.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
  THEN RAISE EXCEPTION 'personal machine requires exact current attempt authority'
    USING ERRCODE = '42501'; END IF;
  initiating_subject := coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN nullif(btrim(turn_row.initiator_subject_id), '') END);
  SELECT membership.* INTO STRICT member_row FROM organization_memberships membership
  WHERE membership.account_id = NEW.account_id AND membership.subject_id = initiating_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
  IF member_row.id IS DISTINCT FROM enrollment_row.owner_organization_membership_id THEN
    RAISE EXCEPTION 'only the personal machine owner may attach it'
      USING ERRCODE = '42501';
  END IF;
  IF member_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = NEW.account_id
      AND workspace_membership.workspace_id = NEW.workspace_id
      AND workspace_membership.subject_id = initiating_subject FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'machine owner lacks target workspace access'
      USING ERRCODE = '42501'; END IF;
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id
    AND authority.organization_membership_id = member_row.id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = enrollment_row.id
    AND authority.generation = enrollment_row.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'personal machine authority is stale'
    USING ERRCODE = '42501'; END IF;
  SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
  WHERE grant_value.account_id = NEW.account_id
    AND grant_value.authority_id = enrollment_row.authority_id
    AND grant_value.owner_organization_membership_id = member_row.id
    AND grant_value.workspace_id = NEW.workspace_id
    AND grant_value.action = 'connected_machine.use'
    AND (((grant_value.context = session_row.visibility OR (
      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'
      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id
      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))) AND grant_value.status = 'active'
    AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
    AND ((grant_value.mode IN ('once','session')
        AND grant_value.session_id = NEW.session_id
        AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch))
      OR (grant_value.mode = 'always' AND grant_value.session_id IS NULL
        AND grant_value.authority_epoch IS NULL))
) OR personal_machine_grant_covers_descendant(grant_value.id, NEW.session_id, NEW.turn_id, enrollment_row.id))
  ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
    grant_value.generation DESC, grant_value.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- The owner's own turn where the machine is on needs no grant for this chat.
    IF opengeni_private.admit_own_personal_machine_v1(NEW.id, enrollment_row.id, sandbox_row.id) THEN
      DELETE FROM opengeni_private.scoped_compute_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal machine use requires explicit grant'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO session_attempt_connected_machine_authorizations(
    attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
    authority_generation, enrollment_generation, session_visibility,
    session_authority_epoch, grant_id, grant_generation, grant_mode
  ) SELECT NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
    NEW.execution_generation, initiating_subject, member_row.id,
    member_row.authorization_revision, enrollment_row.id, sandbox_row.id,
    authority.id, authority.generation, enrollment_row.generation,
    session_row.visibility, session_row.authority_epoch,
    grant_row.id, grant_row.generation, grant_row.mode
  FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id;
  IF grant_row.mode = 'once' AND grant_row.session_id = NEW.session_id THEN
    UPDATE organization_user_resource_grants SET status = 'consumed',
      updated_at = clock_timestamp()
    WHERE id = grant_row.id AND account_id = NEW.account_id
      AND generation = grant_row.generation AND status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'once machine grant lost first-use race'
      USING ERRCODE = '40001'; END IF;
    INSERT INTO personal_resource_once_consumption_receipts(
      grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
      execution_generation, authority_id, authority_generation, grant_generation
    ) SELECT grant_row.id, NEW.account_id, NEW.id, NEW.workspace_id, NEW.session_id,
      NEW.turn_id, NEW.execution_generation, authority.id, authority.generation,
      grant_row.generation FROM organization_user_resource_authorities authority
    WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id;
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;

-- Unchanged from 1065 except that a saved message is not "approved elsewhere"
-- when the machine the chat runs on is on in this workspace for its owner:
-- the owner's turn runs there.
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
        -- Where the owner has the machine on, their own message runs on it.
        AND NOT opengeni_private.personal_machine_on_in_workspace_v1(
          p_account_id, enrollment.id, p_workspace_id)
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

-- The same pinned search paths as the baseline gave these routines.
DO $search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.personal_machine_on_in_workspace_v1(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.admit_own_personal_machine_v1(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION carry_session_attempt_machine_authorization(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION authorize_session_attempt_personal_machine(uuid, uuid, uuid, uuid, uuid, integer, uuid) SET search_path = %I, pg_catalog, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION admit_session_attempt_personal_machine() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$search_paths$;
REVOKE ALL ON FUNCTION opengeni_private.personal_machine_on_in_workspace_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.admit_own_personal_machine_v1(uuid, uuid, uuid) FROM PUBLIC;
