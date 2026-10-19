-- deployment-mode: rolling
-- Personal-machine consent covers only the consenting human's actual agent
-- subtree. Keep the original grant and revalidate every causal parent snapshot;
-- no descendant grant is minted and other personal resources are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION personal_machine_grant_covers_descendant(
  p_grant_id uuid, p_session_id uuid, p_turn_id uuid, p_enrollment_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  grant_row organization_user_resource_grants%ROWTYPE;
  owner_row organization_memberships%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  child_row sessions%ROWTYPE;
  parent_row sessions%ROWTYPE;
  visited uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Only the existing machine admission/dispatch helpers open this capability.
  IF NOT opengeni_private.scoped_compute_capability_active() THEN RETURN false; END IF;
  SELECT * INTO grant_row FROM organization_user_resource_grants
  WHERE id = p_grant_id
    AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND action = 'connected_machine.use' AND revoked_at IS NULL
    AND ((mode = 'session' AND status = 'active') OR (mode = 'once' AND status = 'consumed'))
    AND (expires_at IS NULL OR expires_at > clock_timestamp());
  IF grant_row.id IS NULL OR grant_row.session_id = p_session_id THEN RETURN false; END IF;

  SELECT * INTO owner_row FROM organization_memberships
  WHERE id = grant_row.owner_organization_membership_id AND account_id = grant_row.account_id
    AND status = 'active' AND revoked_at IS NULL;
  IF owner_row.id IS NULL OR NOT (owner_row.personal_workspace_id = grant_row.workspace_id
    OR EXISTS (SELECT 1 FROM workspace_memberships membership
      WHERE membership.account_id = grant_row.account_id
        AND membership.workspace_id = grant_row.workspace_id
        AND membership.subject_id = owner_row.subject_id)) THEN RETURN false; END IF;

  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  JOIN organization_user_resource_authorities authority ON authority.id = enrollment.authority_id
    AND authority.account_id = enrollment.account_id
    AND authority.organization_membership_id = enrollment.owner_organization_membership_id
    AND authority.resource_kind = 'connected_machine' AND authority.resource_id = enrollment.id
    AND authority.generation = enrollment.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL
  WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = grant_row.account_id
    AND enrollment.authority_scope = 'user' AND enrollment.authority_id = grant_row.authority_id
    AND enrollment.owner_organization_membership_id = owner_row.id
    AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL;
  IF enrollment_row.id IS NULL THEN RETURN false; END IF;

  SELECT session.* INTO child_row FROM sessions session
  JOIN session_turns turn_value ON turn_value.session_id = session.id
    AND turn_value.account_id = session.account_id AND turn_value.workspace_id = session.workspace_id
  WHERE session.id = p_session_id AND session.account_id = grant_row.account_id
    AND session.workspace_id = grant_row.workspace_id AND turn_value.id = p_turn_id
    AND session.owner_organization_membership_id = owner_row.id
    AND session.owner_subject_id = owner_row.subject_id
    AND session.visibility = grant_row.context
    AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
      CASE WHEN turn_value.initiator_kind = 'subject'
        THEN nullif(btrim(turn_value.initiator_subject_id), '') END) = owner_row.subject_id;
  IF child_row.id IS NULL THEN RETURN false; END IF;

  LOOP
    IF child_row.id = ANY(visited) OR child_row.parent_session_id IS NULL
      OR child_row.parent_turn_id IS NULL THEN RETURN false; END IF;
    visited := array_append(visited, child_row.id);
    -- parent_turn_id is frozen only by exact agent-attempt child creation.
    -- A plain parent ID, group ID, fork, sibling, or another human's turn is
    -- not a delegation edge, even if the machine owner can read that chat.
    SELECT parent.* INTO parent_row FROM sessions parent
    JOIN session_turns causal ON causal.id = child_row.parent_turn_id
      AND causal.session_id = parent.id AND causal.account_id = parent.account_id
      AND causal.workspace_id = parent.workspace_id
    WHERE parent.id = child_row.parent_session_id AND parent.account_id = grant_row.account_id
      AND parent.workspace_id = grant_row.workspace_id
      AND parent.owner_organization_membership_id = owner_row.id
      AND parent.owner_subject_id = owner_row.subject_id
      AND coalesce(nullif(btrim(causal.initiating_human_subject_id), ''),
        CASE WHEN causal.initiator_kind = 'subject'
          THEN nullif(btrim(causal.initiator_subject_id), '') END) = owner_row.subject_id;
    IF parent_row.id IS NULL THEN RETURN false; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM session_attempt_connected_machine_authorizations snapshot
      JOIN sandboxes sandbox ON sandbox.id = snapshot.sandbox_id
        AND sandbox.account_id = grant_row.account_id AND sandbox.enrollment_id = p_enrollment_id
      WHERE snapshot.account_id = grant_row.account_id AND snapshot.workspace_id = grant_row.workspace_id
        AND snapshot.session_id = parent_row.id AND snapshot.turn_id = child_row.parent_turn_id
        AND snapshot.enrollment_id = p_enrollment_id
        AND snapshot.initiating_human_subject_id = owner_row.subject_id
        AND snapshot.owner_organization_membership_id = owner_row.id
        AND snapshot.membership_authorization_revision = owner_row.authorization_revision
        AND snapshot.authority_id = grant_row.authority_id
        AND snapshot.authority_generation = enrollment_row.generation
        AND snapshot.enrollment_generation = enrollment_row.generation
        AND snapshot.session_authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch
        AND snapshot.grant_id = grant_row.id AND snapshot.grant_generation = grant_row.generation
        AND snapshot.grant_mode = grant_row.mode
    ) AND NOT EXISTS (
      -- A human move onto a machine (0823) can bind the originating turn
      -- through its live owner-click receipt instead of an ordinary snapshot.
      SELECT 1 FROM session_turn_machine_consents consent
      WHERE grant_row.mode = 'session' AND consent.account_id = grant_row.account_id
        AND consent.workspace_id = grant_row.workspace_id AND consent.session_id = parent_row.id
        AND consent.turn_id = child_row.parent_turn_id AND consent.enrollment_id = p_enrollment_id
        AND consent.consenting_subject_id = owner_row.subject_id
        AND consent.owner_organization_membership_id = owner_row.id
        AND consent.authority_id = grant_row.authority_id
        AND live_session_turn_machine_consent(consent.id)
    ) THEN RETURN false; END IF;

    IF parent_row.id = grant_row.session_id THEN
      RETURN grant_row.authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch;
    END IF;
    child_row := parent_row;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION personal_machine_grant_covers_descendant(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- Owner moves made by current binaries use a logical-turn receipt rather than
-- a standing grant (0823). Descendants bind that SAME receipt. Its existing live
-- authority checks remain the single revocation source; no new consent is made.
CREATE FUNCTION personal_machine_turn_consent_covers_descendant(
  p_consent_id uuid, p_session_id uuid, p_turn_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  consent_row session_turn_machine_consents%ROWTYPE;
  child_row sessions%ROWTYPE;
  parent_row sessions%ROWTYPE;
  visited uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NOT opengeni_private.scoped_compute_capability_active() THEN RETURN false; END IF;
  SELECT * INTO consent_row FROM session_turn_machine_consents
  WHERE id = p_consent_id
    AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
  IF consent_row.id IS NULL OR consent_row.session_id = p_session_id
    OR NOT live_session_turn_machine_consent(consent_row.id) THEN RETURN false; END IF;
  -- If this source also has an exact-session grant, its tree is grant-derived.
  -- Do not use a turn-local move receipt to bypass that grant's revocation or
  -- expiry. This includes terminal grant rows: only an explicit new grant or a
  -- new execution-authority epoch can restore tree coverage in that case.
  IF EXISTS (
    SELECT 1 FROM organization_user_resource_grants grant_value
    JOIN sessions source ON source.id = consent_row.session_id
      AND source.account_id = consent_row.account_id AND source.workspace_id = consent_row.workspace_id
    WHERE grant_value.account_id = consent_row.account_id AND grant_value.workspace_id = consent_row.workspace_id
      AND grant_value.session_id = consent_row.session_id AND grant_value.authority_id = consent_row.authority_id
      AND grant_value.owner_organization_membership_id = consent_row.owner_organization_membership_id
      AND grant_value.action = 'connected_machine.use' AND grant_value.mode IN ('once','session')
      AND grant_value.authority_epoch BETWEEN source.execution_authority_epoch AND source.authority_epoch
  ) THEN RETURN false; END IF;
  SELECT session.* INTO child_row FROM sessions session
  JOIN session_turns turn_value ON turn_value.session_id = session.id
    AND turn_value.account_id = session.account_id AND turn_value.workspace_id = session.workspace_id
  WHERE session.id = p_session_id AND session.account_id = consent_row.account_id
    AND session.workspace_id = consent_row.workspace_id AND turn_value.id = p_turn_id
    AND session.owner_organization_membership_id = consent_row.owner_organization_membership_id
    AND session.owner_subject_id = consent_row.consenting_subject_id
    AND coalesce(nullif(btrim(turn_value.initiating_human_subject_id), ''),
      CASE WHEN turn_value.initiator_kind = 'subject'
        THEN nullif(btrim(turn_value.initiator_subject_id), '') END) = consent_row.consenting_subject_id;
  IF child_row.id IS NULL THEN RETURN false; END IF;
  LOOP
    IF child_row.id = ANY(visited) OR child_row.parent_session_id IS NULL
      OR child_row.parent_turn_id IS NULL THEN RETURN false; END IF;
    visited := array_append(visited, child_row.id);
    SELECT parent.* INTO parent_row FROM sessions parent
    JOIN session_turns causal ON causal.id = child_row.parent_turn_id
      AND causal.session_id = parent.id AND causal.account_id = parent.account_id
      AND causal.workspace_id = parent.workspace_id
    WHERE parent.id = child_row.parent_session_id AND parent.account_id = consent_row.account_id
      AND parent.workspace_id = consent_row.workspace_id
      AND parent.owner_organization_membership_id = consent_row.owner_organization_membership_id
      AND parent.owner_subject_id = consent_row.consenting_subject_id
      AND coalesce(nullif(btrim(causal.initiating_human_subject_id), ''),
        CASE WHEN causal.initiator_kind = 'subject'
          THEN nullif(btrim(causal.initiator_subject_id), '') END) = consent_row.consenting_subject_id;
    IF parent_row.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM session_attempt_machine_consents binding
      JOIN session_turn_attempts snapshot ON snapshot.id = binding.attempt_id
      WHERE binding.consent_id = consent_row.id AND snapshot.account_id = consent_row.account_id
        AND snapshot.workspace_id = consent_row.workspace_id AND snapshot.session_id = parent_row.id
        AND snapshot.turn_id = child_row.parent_turn_id
        AND snapshot.authority_epoch BETWEEN parent_row.execution_authority_epoch AND parent_row.authority_epoch
    ) THEN RETURN false; END IF;
    IF parent_row.id = consent_row.session_id THEN
      RETURN child_row.parent_turn_id = consent_row.turn_id;
    END IF;
    child_row := parent_row;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION personal_machine_turn_consent_covers_descendant(uuid, uuid, uuid) FROM PUBLIC;
DO $harden$
BEGIN
  EXECUTE format('ALTER FUNCTION personal_machine_grant_covers_descendant(uuid,uuid,uuid,uuid) SET search_path=pg_catalog,%I,pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION personal_machine_turn_consent_covers_descendant(uuid,uuid,uuid) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END
$harden$;

-- Extend only the machine-specific grant predicates. Source assertions keep
-- the installed exact-session paths (including later lifecycle changes) intact.
DO $extend_machine_grants$
DECLARE
  signature text; definition text; old_predicate text; new_predicate text;
  scope_start integer; scope_end integer; session_expr text; turn_expr text;
  consume_guard text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'admit_session_attempt_personal_machine()',
    'authorize_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    scope_start := strpos(definition, '    AND (grant_value.context = session_row.visibility OR (');
    scope_end := strpos(definition, '  ORDER BY CASE grant_value.mode WHEN ''once'' THEN 1 WHEN ''session'' THEN 2 ELSE 3 END,');
    IF scope_start = 0 OR scope_end <= scope_start THEN
      RAISE EXCEPTION '0844 machine grant predicate drift: %', signature;
    END IF;
    old_predicate := substring(definition FROM scope_start FOR scope_end - scope_start);
    IF signature = 'admit_session_attempt_personal_machine()' THEN
      session_expr := 'NEW.session_id'; turn_expr := 'NEW.turn_id';
      consume_guard := 'IF grant_row.mode = ''once'' THEN';
    ELSE
      session_expr := 'p_session_id'; turn_expr := 'p_turn_id';
      consume_guard := 'IF affected = 1 AND grant_row.mode = ''once'' THEN';
    END IF;
    IF strpos(old_predicate, 'grant_value.session_id = ' || session_expr) = 0
      OR strpos(old_predicate, 'grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch') = 0
      OR (length(definition) - length(replace(definition, consume_guard, ''))) / length(consume_guard) <> 1 THEN
      RAISE EXCEPTION '0844 machine grant scope drift: %', signature;
    END IF;
    new_predicate := '    AND ((' || substring(old_predicate FROM 9) || ') OR personal_machine_grant_covers_descendant(grant_value.id, '
      || session_expr || ', ' || turn_expr || ', enrollment_row.id))' || chr(10);
    definition := replace(definition, old_predicate, new_predicate);
    -- An inherited once grant was consumed by the original logical turn. Its
    -- causal descendants reuse that exact proof; they never consume it again.
    definition := replace(definition, consume_guard,
      replace(consume_guard, ' THEN', ' AND grant_row.session_id = ' || session_expr || ' THEN'));
    EXECUTE definition;
  END LOOP;

  signature := 'assert_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean)';
  definition := pg_get_functiondef(signature::regprocedure);
  old_predicate := 'AND ((authorization_row.grant_mode = ''once'' AND grant_value.status = ''consumed''';
  IF (length(definition) - length(replace(definition, old_predicate, ''))) / length(old_predicate) <> 1 THEN
    RAISE EXCEPTION '0844 machine runtime predicate drift';
  END IF;
  EXECUTE replace(definition, old_predicate,
    'AND (personal_machine_grant_covers_descendant(grant_value.id, p_session_id, p_turn_id, p_enrollment_id) OR (authorization_row.grant_mode = ''once'' AND grant_value.status = ''consumed''');
END
$extend_machine_grants$;

CREATE FUNCTION pg_temp.install_tree_turn_consents() RETURNS void
LANGUAGE plpgsql AS $extend_turn_consents$
DECLARE definition text; before_text text; after_text text;
BEGIN
  definition := pg_get_functiondef('bind_session_attempt_machine_consent(uuid,uuid,uuid)'::regprocedure);
  before_text := $before$  SELECT consent.id INTO consent_id_value FROM session_turn_machine_consents consent
  JOIN sessions session ON session.id = p_session_id AND session.id = consent.session_id
    AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    AND session.active_sandbox_id = consent.sandbox_id
  WHERE consent.turn_id = p_turn_id ORDER BY consent.route_epoch DESC LIMIT 1;$before$;
  after_text := $after$  SELECT consent.id INTO consent_id_value FROM session_turn_machine_consents consent
  JOIN sessions session ON session.id = p_session_id
    AND session.account_id = consent.account_id AND session.workspace_id = consent.workspace_id
    AND session.active_sandbox_id = consent.sandbox_id
  WHERE (consent.session_id = p_session_id AND consent.turn_id = p_turn_id)
    OR personal_machine_turn_consent_covers_descendant(consent.id, p_session_id, p_turn_id)
  ORDER BY (consent.session_id = p_session_id) DESC, consent.route_epoch DESC, consent.id LIMIT 1;$after$;
  IF (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1 THEN
    RAISE EXCEPTION '0844 turn-consent binding drift';
  END IF;
  EXECUTE replace(definition, before_text, after_text);

  definition := pg_get_functiondef('assert_session_attempt_machine_consent(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)'::regprocedure);
  before_text := E'AND consent.session_id = p_session_id\n    AND consent.turn_id = p_turn_id';
  after_text := E'AND ((consent.session_id = p_session_id AND consent.turn_id = p_turn_id)\n      OR personal_machine_turn_consent_covers_descendant(consent.id, p_session_id, p_turn_id))';
  IF (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1 THEN
    RAISE EXCEPTION '0844 turn-consent dispatch drift';
  END IF;
  EXECUTE replace(definition, before_text, after_text);
END
$extend_turn_consents$;
SELECT pg_temp.install_tree_turn_consents();
DROP FUNCTION pg_temp.install_tree_turn_consents();
