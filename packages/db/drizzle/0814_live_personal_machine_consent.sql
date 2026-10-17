-- deployment-mode: rolling
-- An owner's move authorizes this machine for this logical turn, independently
-- of who initiated the turn. It never changes that person's other authorities.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Scoped compute helpers lock membership and turn rows while checking them.
-- FORCE RLS requires UPDATE visibility for those row locks. WITH CHECK false
-- admits the locks without granting these capabilities a new mutation lane.
DO $lock_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships', 'workspace_memberships', 'session_turns', 'session_turn_attempts'
  ] LOOP
    EXECUTE format('CREATE POLICY scoped_compute_capability_lock ON %I FOR UPDATE USING '
      || '(scoped_compute_policy_capability_active(current_user, %L, NULL)) WITH CHECK (false)',
      table_name, current_user);
  END LOOP;
END
$lock_policies$;

CREATE TABLE session_turn_machine_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  consenting_subject_id text NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  enrollment_generation bigint NOT NULL,
  session_authority_epoch bigint NOT NULL,
  route_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (turn_id, enrollment_id, route_epoch)
);
CREATE TABLE session_attempt_machine_consents (
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  consent_id uuid NOT NULL REFERENCES session_turn_machine_consents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_id, consent_id)
);
ALTER TABLE session_turn_machine_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_turn_machine_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE session_attempt_machine_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attempt_machine_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped_compute_capability_read ON session_turn_machine_consents FOR SELECT
  USING (opengeni_private.scoped_compute_capability_active());
CREATE POLICY scoped_compute_capability_insert ON session_turn_machine_consents FOR INSERT
  WITH CHECK (opengeni_private.scoped_compute_capability_active('write'));
CREATE POLICY scoped_compute_capability_read ON session_attempt_machine_consents FOR SELECT
  USING (opengeni_private.scoped_compute_capability_active());
CREATE POLICY scoped_compute_capability_insert ON session_attempt_machine_consents FOR INSERT
  WITH CHECK (opengeni_private.scoped_compute_capability_active('write'));

-- Internal live revalidation shared by admission and dispatch. Neither a receipt
-- nor a still-connected process survives revoked ownership/access/generations.
CREATE FUNCTION live_session_turn_machine_consent(p_consent_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM session_turn_machine_consents consent
    JOIN sessions session ON session.id = consent.session_id
      AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    JOIN organization_memberships owner ON owner.id = consent.owner_organization_membership_id
      AND owner.account_id = consent.account_id AND owner.subject_id = consent.consenting_subject_id
      AND owner.status = 'active' AND owner.revoked_at IS NULL
      AND owner.authorization_revision = consent.membership_authorization_revision
    JOIN enrollments enrollment ON enrollment.id = consent.enrollment_id
      AND enrollment.account_id = consent.account_id AND enrollment.authority_scope = 'user'
      AND enrollment.owner_organization_membership_id = owner.id
      AND enrollment.generation = consent.enrollment_generation
      AND enrollment.authority_id = consent.authority_id
      AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
    JOIN organization_user_resource_authorities authority ON authority.id = consent.authority_id
      AND authority.account_id = consent.account_id AND authority.organization_membership_id = owner.id
      AND authority.resource_kind = 'connected_machine' AND authority.resource_id = enrollment.id
      AND authority.generation = consent.authority_generation
      AND authority.status = 'active' AND authority.revoked_at IS NULL
    JOIN sandboxes sandbox ON sandbox.id = consent.sandbox_id
      AND sandbox.account_id = consent.account_id AND sandbox.enrollment_id = enrollment.id
    WHERE consent.id = p_consent_id
      AND consent.session_authority_epoch BETWEEN session.execution_authority_epoch AND session.authority_epoch
      AND (owner.personal_workspace_id = consent.workspace_id OR EXISTS (
        SELECT 1 FROM workspace_memberships membership
        WHERE membership.account_id = consent.account_id AND membership.workspace_id = consent.workspace_id
          AND membership.subject_id = owner.subject_id
      ))
  )
$$;
REVOKE ALL ON FUNCTION live_session_turn_machine_consent(uuid) FROM PUBLIC;

-- FOR SHARE requires UPDATE visibility as well as SELECT under FORCE RLS.
-- Keep the authorization locks, but give this bounded owner check the internal
-- write capability they require, without consuming a caller's nested capability.
CREATE OR REPLACE FUNCTION authorize_scoped_sandbox_attach(
  p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE actor_membership_id uuid; sandbox_row sandboxes%ROWTYPE;
  enrollment_row enrollments%ROWTYPE; authorized boolean := false; capability_added boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.id = p_sandbox_id AND sandbox.account_id = p_account_id FOR SHARE;
  IF sandbox_row.id IS NOT NULL AND sandbox_row.kind <> 'selfhosted' THEN
    authorized := sandbox_row.workspace_id = p_workspace_id;
  ELSIF sandbox_row.id IS NOT NULL THEN
    SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
    WHERE enrollment.id = sandbox_row.enrollment_id AND enrollment.account_id = p_account_id
      AND enrollment.status = 'active' FOR SHARE;
    authorized := enrollment_row.id IS NOT NULL AND (
      enrollment_row.authority_scope = 'organization'
      OR (enrollment_row.authority_scope = 'workspace' AND enrollment_row.workspace_id = p_workspace_id)
      OR (enrollment_row.authority_scope = 'user'
        AND enrollment_row.owner_organization_membership_id = actor_membership_id)
    );
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN authorized;
END
$$;

-- Only called from the trusted human move transaction, after its route CAS.
CREATE FUNCTION consent_session_turn_personal_machine(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_enrollment_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  owner_row organization_memberships%ROWTYPE;
  consent_id_value uuid;
  capability_added boolean;
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN RAISE EXCEPTION 'machine runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  SELECT * INTO STRICT session_row FROM sessions
  WHERE id = p_session_id AND account_id = p_account_id AND workspace_id = p_workspace_id
  FOR NO KEY UPDATE;
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  SELECT * INTO STRICT owner_row FROM organization_memberships
  WHERE id = scoped_compute_actor_membership(p_account_id, p_workspace_id)
    AND subject_id = caller_subject AND status = 'active' AND revoked_at IS NULL FOR SHARE;
  SELECT enrollment.* INTO STRICT enrollment_row FROM enrollments enrollment
  JOIN sandboxes sandbox ON sandbox.enrollment_id = enrollment.id AND sandbox.account_id = p_account_id
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
    AND enrollment.authority_scope = 'user' AND enrollment.status = 'active'
    AND enrollment.revoked_at IS NULL AND enrollment.owner_organization_membership_id = owner_row.id
    AND sandbox.id = session_row.active_sandbox_id FOR SHARE OF enrollment;
  -- A recovering turn can be between attempts with no active_turn_id. Queued
  -- future work is deliberately excluded: the click is not another person's
  -- standing permission to run future turns on this owner's machine.
  SELECT turn_value.* INTO turn_row FROM session_turns turn_value
  WHERE turn_value.account_id = p_account_id AND turn_value.workspace_id = p_workspace_id
    AND turn_value.session_id = p_session_id
    AND (turn_value.id = session_row.active_turn_id OR
      (session_row.active_turn_id IS NULL AND turn_value.status = 'recovering'))
    AND turn_value.status IN ('running', 'recovering', 'requires_action')
  ORDER BY turn_value.created_at DESC LIMIT 1 FOR SHARE;
  IF turn_row.id IS NOT NULL THEN
    INSERT INTO session_turn_machine_consents(
      account_id, workspace_id, session_id, turn_id, enrollment_id, sandbox_id,
      consenting_subject_id, owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, enrollment_generation, session_authority_epoch, route_epoch
    ) VALUES (
      p_account_id, p_workspace_id, p_session_id, turn_row.id, p_enrollment_id, session_row.active_sandbox_id,
      caller_subject, owner_row.id, owner_row.authorization_revision, enrollment_row.authority_id,
      enrollment_row.generation, enrollment_row.generation, session_row.authority_epoch, session_row.active_epoch
    ) RETURNING id INTO consent_id_value;
    IF NOT live_session_turn_machine_consent(consent_id_value) THEN
      RAISE EXCEPTION 'personal machine authority is no longer live' USING ERRCODE = '42501';
    END IF;
    INSERT INTO session_attempt_machine_consents(attempt_id, consent_id)
    SELECT attempt.id, consent_id_value FROM session_turn_attempts attempt
    WHERE attempt.id = turn_row.active_attempt_id AND attempt.turn_id = turn_row.id
      AND attempt.account_id = p_account_id AND attempt.workspace_id = p_workspace_id
      AND attempt.session_id = p_session_id AND attempt.execution_generation = turn_row.execution_generation
      AND attempt.state IN ('claimed', 'running') AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL;
    INSERT INTO audit_events(account_id, workspace_id, subject_id, action, target_type, target_id,
      metadata, metadata_codec_version)
    VALUES (p_account_id, p_workspace_id, caller_subject, 'connected_machine.turn_consent',
      'enrollment', p_enrollment_id::text, jsonb_build_object('sessionId', p_session_id,
        'turnId', turn_row.id, 'attemptId', turn_row.active_attempt_id,
        'consentId', consent_id_value, 'routeEpoch', session_row.active_epoch), 1);
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION consent_session_turn_personal_machine(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- Recovery binds the same logical-turn consent to the newly claimed attempt.
-- No initiating-human rewrite or new personal-resource snapshot is involved.
CREATE FUNCTION bind_session_attempt_machine_consent(
  p_attempt_id uuid, p_turn_id uuid, p_session_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE consent_id_value uuid; capability_added boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  SELECT consent.id INTO consent_id_value FROM session_turn_machine_consents consent
  JOIN sessions session ON session.id = p_session_id AND session.id = consent.session_id
    AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    AND session.active_sandbox_id = consent.sandbox_id
  WHERE consent.turn_id = p_turn_id ORDER BY consent.route_epoch DESC LIMIT 1;
  IF consent_id_value IS NOT NULL AND NOT live_session_turn_machine_consent(consent_id_value) THEN
    -- An independent, newer ordinary grant (for example an audience change)
    -- may still admit the owner through the existing trigger below.
    consent_id_value := NULL;
  END IF;
  IF consent_id_value IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM session_turn_attempts attempt
      JOIN session_turns turn_value ON turn_value.id = attempt.turn_id
        AND turn_value.session_id = attempt.session_id AND turn_value.account_id = attempt.account_id
        AND turn_value.workspace_id = attempt.workspace_id
      JOIN sessions session ON session.id = attempt.session_id
        AND session.account_id = attempt.account_id AND session.workspace_id = attempt.workspace_id
      WHERE attempt.id = p_attempt_id AND attempt.turn_id = p_turn_id AND attempt.session_id = p_session_id
        AND session.active_turn_id = p_turn_id AND turn_value.active_attempt_id = p_attempt_id
        AND turn_value.execution_generation = attempt.execution_generation
        AND attempt.state IN ('claimed', 'running') AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
        AND attempt.authority_epoch BETWEEN session.execution_authority_epoch AND session.authority_epoch
    ) THEN
      RAISE EXCEPTION 'personal machine authority is no longer live' USING ERRCODE = '42501';
    END IF;
    INSERT INTO session_attempt_machine_consents(attempt_id, consent_id)
    VALUES (p_attempt_id, consent_id_value);
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN consent_id_value IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION bind_session_attempt_machine_consent(uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION assert_session_attempt_machine_consent(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid,
  p_require_active_sandbox boolean, p_record_use boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE consent_row session_turn_machine_consents%ROWTYPE; capability_added boolean;
  caller_subject text := coalesce(nullif(current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(current_setting('opengeni.subject_id', true), ''));
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'machine runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'runtime') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  SELECT consent.* INTO consent_row FROM session_attempt_machine_consents binding
  JOIN session_turn_machine_consents consent ON consent.id = binding.consent_id
  WHERE binding.attempt_id = p_attempt_id AND consent.account_id = p_account_id
    AND consent.workspace_id = p_workspace_id AND consent.session_id = p_session_id
    AND consent.turn_id = p_turn_id AND consent.enrollment_id = p_enrollment_id
  ORDER BY consent.route_epoch DESC LIMIT 1;
  IF consent_row.id IS NOT NULL AND NOT live_session_turn_machine_consent(consent_row.id) THEN
    consent_row.id := NULL;
  END IF;
  IF consent_row.id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM sessions session
      JOIN session_turns turn_value ON turn_value.id = p_turn_id AND turn_value.session_id = session.id
        AND turn_value.account_id = session.account_id AND turn_value.workspace_id = session.workspace_id
      JOIN session_turn_attempts attempt ON attempt.id = p_attempt_id AND attempt.turn_id = turn_value.id
        AND attempt.session_id = session.id AND attempt.account_id = session.account_id
        AND attempt.workspace_id = session.workspace_id
      WHERE session.id = p_session_id AND session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.active_turn_id = p_turn_id AND turn_value.active_attempt_id = p_attempt_id
        AND turn_value.execution_generation = p_execution_generation AND turn_value.status = 'running'
        AND attempt.execution_generation = p_execution_generation AND attempt.state IN ('claimed', 'running')
        AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
        AND attempt.authority_epoch BETWEEN session.execution_authority_epoch AND session.authority_epoch
        AND (NOT p_require_active_sandbox OR session.active_sandbox_id = consent_row.sandbox_id)
        AND caller_subject IS NOT DISTINCT FROM coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject' THEN nullif(btrim(turn_value.initiator_subject_id), '') END)
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.attempt_id = attempt.id AND interruption.account_id = p_account_id
            AND interruption.workspace_id = p_workspace_id AND interruption.state IN ('pending', 'delivered', 'acknowledged'))
    ) THEN RAISE EXCEPTION 'personal machine authority is no longer live' USING ERRCODE = '42501'; END IF;
    IF p_record_use THEN
    INSERT INTO audit_events(account_id, workspace_id, subject_id, action, target_type, target_id,
      metadata, metadata_codec_version)
    VALUES (p_account_id, p_workspace_id, caller_subject, 'connected_machine.used',
      'enrollment', p_enrollment_id::text, jsonb_build_object('sessionId', p_session_id,
        'turnId', p_turn_id, 'attemptId', p_attempt_id, 'executionGeneration', p_execution_generation,
        'consentId', consent_row.id, 'consentingSubjectId', consent_row.consenting_subject_id,
        'ownerOrganizationMembershipId', consent_row.owner_organization_membership_id,
        'scope', 'user', 'generation', consent_row.enrollment_generation), 1);
    END IF;
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'runtime';
  END IF;
  RETURN consent_row.id IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION assert_session_attempt_machine_consent(uuid, uuid, uuid, uuid, uuid, integer, uuid, boolean, boolean) FROM PUBLIC;

-- Preserve the old admission/checks exactly when there is no owner-click
-- receipt. Both protocol versions get same-turn recovery, including consumed
-- once-resource turns, without editing their immutable accepted snapshots.
DO $extend$
DECLARE signature text; body text; addition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['admit_session_attempt_personal_machine()', 'admit_session_attempt_personal_machine_v1()'] LOOP
    SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid = signature::regprocedure;
    addition := E'BEGIN\n  IF bind_session_attempt_machine_consent(NEW.id, NEW.turn_id, NEW.session_id) THEN RETURN NEW; END IF;';
    body := overlay(body placing addition from position('BEGIN' in body) for 5);
    EXECUTE format('CREATE OR REPLACE FUNCTION %s RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS %L', signature, current_schema(), body);
  END LOOP;
  signature := 'assert_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean)';
  SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid = signature::regprocedure;
  addition := E'BEGIN\n  IF assert_session_attempt_machine_consent(p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id, p_execution_generation, p_enrollment_id, p_require_active_sandbox, true) THEN RETURN true; END IF;';
  body := overlay(body placing addition from position('BEGIN' in body) for 5);
  EXECUTE format('CREATE OR REPLACE FUNCTION assert_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid, p_require_active_sandbox boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS %L', current_schema(), body);
END
$extend$;

-- Exact-attempt projection, not discovery. The original caller is checked
-- before using the owner's existing JSON projection and is restored before
-- return. Only this one authorized machine escapes; no owner authority does.
CREATE FUNCTION get_session_attempt_machine(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_sandbox_id uuid,
  p_enrollment_id uuid, p_require_active_sandbox boolean, p_metadata_only boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE enrollment_id_value uuid; sandbox_id_value uuid; owner_subject text; result jsonb;
  capability_added boolean;
  authorized boolean := false;
  original_subject text := current_setting('opengeni.subject_id', true);
  original_initiator text := current_setting('opengeni.initiating_human_subject_id', true);
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'runtime') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  SELECT enrollment.id, sandbox.id, owner.subject_id INTO enrollment_id_value, sandbox_id_value, owner_subject
  FROM sandboxes sandbox JOIN enrollments enrollment ON enrollment.id = sandbox.enrollment_id
    AND enrollment.account_id = sandbox.account_id
    AND (enrollment.authority_scope = 'user' OR p_enrollment_id IS NOT NULL)
  LEFT JOIN organization_memberships owner ON owner.id = enrollment.owner_organization_membership_id
    AND owner.account_id = enrollment.account_id
  WHERE sandbox.account_id = p_account_id AND sandbox.kind = 'selfhosted'
    AND (p_sandbox_id IS NULL OR sandbox.id = p_sandbox_id)
    AND (p_enrollment_id IS NULL OR enrollment.id = p_enrollment_id)
    AND (p_sandbox_id IS NOT NULL OR p_enrollment_id IS NOT NULL);
  IF enrollment_id_value IS NOT NULL THEN
    result := jsonb_build_object('sandbox', NULL, 'enrollment', NULL);
  END IF;
  -- Metadata lookup does not claim use or require the pointer to stay still:
  -- the resolver's epoch fence retries a concurrent move, and dispatch audits
  -- and checks the exact active route. Owners already have ordinary discovery;
  -- another caller must prove this turn's explicit consent even for metadata.
  IF enrollment_id_value IS NOT NULL THEN
    IF p_metadata_only THEN
      IF owner_subject IS NOT NULL AND owner_subject = nullif(original_subject, '') THEN
        authorized := true;
      ELSE
        authorized := assert_session_attempt_machine_consent(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
          p_execution_generation, enrollment_id_value, false, false);
      END IF;
    ELSE
      authorized := assert_session_attempt_personal_machine(
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, enrollment_id_value, p_require_active_sandbox);
    END IF;
  END IF;
  IF authorized THEN
    PERFORM set_config('opengeni.subject_id', owner_subject, true);
    PERFORM set_config('opengeni.initiating_human_subject_id', owner_subject, true);
    SELECT jsonb_build_object('sandbox', get_scoped_sandbox(p_account_id, p_workspace_id, sandbox_id_value),
      'enrollment', value) INTO result
    FROM list_scoped_enrollments(p_account_id, p_workspace_id, enrollment_id_value, 'active') value;
    PERFORM set_config('opengeni.subject_id', coalesce(original_subject, ''), true);
    PERFORM set_config('opengeni.initiating_human_subject_id', coalesce(original_initiator, ''), true);
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'runtime';
  END IF;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION get_session_attempt_machine(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, boolean, boolean) FROM PUBLIC;

DO $pin$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'authorize_scoped_sandbox_attach(uuid,uuid,uuid)',
    'live_session_turn_machine_consent(uuid)',
    'consent_session_turn_personal_machine(uuid,uuid,uuid,uuid)',
    'bind_session_attempt_machine_consent(uuid,uuid,uuid)',
    'assert_session_attempt_machine_consent(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)',
    'get_session_attempt_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,boolean,boolean)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp', signature, current_schema());
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION consent_session_turn_personal_machine(uuid,uuid,uuid,uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION get_session_attempt_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,boolean,boolean) TO opengeni_app;
    REVOKE ALL ON TABLE session_turn_machine_consents, session_attempt_machine_consents FROM opengeni_app;
  END IF;
END
$pin$;
