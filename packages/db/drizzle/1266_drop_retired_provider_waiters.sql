-- deployment-mode: rolling
-- contract-step: only after the readiness and ORM predecessors in PRs #6710 and #6714 have shipped, and the previous-production readiness baseline has advanced separately. PR #6436 retired the old provider pools; current waits use subscription_capacity_waiters.
-- Replace every surviving SQL caller explicitly before dropping the closed
-- old table group. No CASCADE, no new authority and no accepted work rewrite.

SET LOCAL lock_timeout = '5s';

-- ALTER takes each required table lock before the preflight, preventing a
-- racing old-provider waiter. FORCE RLS binds the migration owner too, so
-- open its visibility window. Failure rolls everything back atomically.
ALTER TABLE claude_capacity_waiters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_capacity_waiters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_capacity_waiters NO FORCE ROW LEVEL SECURITY;
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM claude_capacity_waiters WHERE status = 'waiting')
    OR EXISTS (SELECT 1 FROM codex_capacity_waiters WHERE status = 'waiting')
    OR EXISTS (SELECT 1 FROM xai_capacity_waiters WHERE status = 'waiting')
  THEN
    RAISE EXCEPTION 'retired provider capacity waiters must be settled before contraction'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.list_continuable_sessions(p_workspace_id uuid, p_root_session_id uuid)
 RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, temporal_workflow_id text, reasons text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
      WITH RECURSIVE control_tree AS (
        SELECT session.workspace_id, session.id, session.parent_session_id,
               greatest(control.workspace_pause_revision, session.direct_pause_revision)
                 AS max_pause_revision,
               session.subtree_run_override_revision AS max_override_revision,
               0::integer AS depth
        FROM %1$I.sessions session
        JOIN %1$I.workspace_inference_controls control
          ON control.workspace_id = session.workspace_id
        WHERE session.parent_session_id IS NULL
          AND (p_workspace_id IS NULL OR session.workspace_id = p_workspace_id)
        UNION ALL
        SELECT child.workspace_id, child.id, child.parent_session_id,
               greatest(parent.max_pause_revision, child.direct_pause_revision),
               greatest(parent.max_override_revision, child.subtree_run_override_revision),
               parent.depth + 1
        FROM control_tree parent
        JOIN %1$I.sessions child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
        WHERE parent.depth < 10000
      ), descendants AS (
        SELECT tree.workspace_id, tree.id
        FROM control_tree tree
        WHERE p_root_session_id IS NOT NULL AND tree.id = p_root_session_id
        UNION ALL
        SELECT child.workspace_id, child.id
        FROM descendants parent
        JOIN control_tree child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
      ), scope_sessions AS (
        SELECT session.*, tree.max_pause_revision, tree.max_override_revision
        FROM %1$I.sessions session
        JOIN control_tree tree
          ON tree.workspace_id = session.workspace_id AND tree.id = session.id
        WHERE (
            p_root_session_id IS NULL
            OR EXISTS (
              SELECT 1 FROM descendants descendant
              WHERE descendant.workspace_id = session.workspace_id
                AND descendant.id = session.id
            )
          )
      ), control_state AS (
        SELECT session.workspace_id, session.id AS session_id,
               session.max_pause_revision IS NOT NULL
                 AND (
                   session.max_override_revision IS NULL
                   OR session.max_pause_revision >= session.max_override_revision
                 ) AS blocked
        FROM scope_sessions session
      ), unsettled_interruptions AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_attempt_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        WHERE interruption.state IN ('pending', 'delivered', 'acknowledged')
      ), queued_human AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id AND turn.session_id = session.id
        WHERE turn.status = 'queued' AND turn.source IN ('user', 'api')
      ), recovering_turn AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        WHERE turn.status = 'recovering'
      ), capacity_wait AS (
        SELECT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        WHERE EXISTS (
            SELECT 1 FROM %1$I.subscription_capacity_waiters waiter
            WHERE waiter.workspace_id = session.workspace_id
              AND waiter.session_id = session.id
          )
          OR EXISTS (
            SELECT 1 FROM %1$I.session_turns turn
            WHERE turn.workspace_id = session.workspace_id
              AND turn.session_id = session.id
              AND turn.id = session.active_turn_id
              AND turn.status = 'waiting_capacity'
          )
      ), decided_approval AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        JOIN %1$I.session_events trigger_event
          ON trigger_event.workspace_id = turn.workspace_id
         AND trigger_event.id = turn.trigger_event_id
        JOIN %1$I.session_events decision
          ON decision.workspace_id = turn.workspace_id
         AND decision.session_id = turn.session_id
         AND decision.sequence > trigger_event.sequence
         AND decision.type = 'user.approvalDecision'
        WHERE turn.status = 'requires_action'
      ), active_goal AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_goals goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        WHERE goal.status = 'active'
      ), pending_internal_updates AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_system_updates update_row
          ON update_row.workspace_id = session.workspace_id
         AND update_row.session_id = session.id
        WHERE update_row.state = 'pending'
      ), classified AS (
        SELECT session.account_id, session.workspace_id, session.id AS session_id,
               coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
                 AS temporal_workflow_id,
               array_remove(ARRAY[
                 CASE WHEN interruption.session_id IS NOT NULL
                   THEN 'interruption_settlement' END,
                 CASE WHEN NOT control.blocked AND queued.session_id IS NOT NULL
                   THEN 'queued_human' END,
                 CASE WHEN NOT control.blocked AND recovering.session_id IS NOT NULL
                   THEN 'recovering_turn' END,
                 CASE WHEN NOT control.blocked AND capacity.session_id IS NOT NULL
                   THEN 'capacity_wait' END,
                 CASE WHEN NOT control.blocked AND approval.session_id IS NOT NULL
                   THEN 'decided_approval' END,
                 CASE WHEN NOT control.blocked AND goal.session_id IS NOT NULL
                   THEN 'active_goal' END,
                 CASE WHEN NOT control.blocked AND updates.session_id IS NOT NULL
                   THEN 'pending_internal_updates' END,
                 CASE WHEN NOT control.blocked AND session.compact_requested
                   THEN 'compaction_requested' END
               ]::text[], NULL) AS reasons
        FROM scope_sessions session
        JOIN control_state control
          ON control.workspace_id = session.workspace_id AND control.session_id = session.id
        LEFT JOIN unsettled_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        LEFT JOIN queued_human queued
          ON queued.workspace_id = session.workspace_id AND queued.session_id = session.id
        LEFT JOIN recovering_turn recovering
          ON recovering.workspace_id = session.workspace_id AND recovering.session_id = session.id
        LEFT JOIN capacity_wait capacity
          ON capacity.workspace_id = session.workspace_id AND capacity.session_id = session.id
        LEFT JOIN decided_approval approval
          ON approval.workspace_id = session.workspace_id AND approval.session_id = session.id
        LEFT JOIN active_goal goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        LEFT JOIN pending_internal_updates updates
          ON updates.workspace_id = session.workspace_id AND updates.session_id = session.id
      )
      SELECT classified.account_id, classified.workspace_id, classified.session_id,
             classified.temporal_workflow_id, classified.reasons
      FROM classified
      WHERE cardinality(classified.reasons) > 0
      ORDER BY classified.workspace_id, classified.session_id
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.assert_session_tenancy_quiescent(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_require_singleton_group boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
AS $function$
DECLARE
  session_group_id uuid;
  previous_subject text := current_setting('opengeni.subject_id', true);
  blocker text;
BEGIN

  SELECT sandbox_group_id INTO session_group_id FROM sessions
  WHERE account_id = p_account_id AND workspace_id = p_workspace_id
    AND id = p_session_id;

  IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND status IN ('queued','running','requires_action','recovering','waiting_capacity'))
  THEN blocker := 'nonterminal_turn';
  ELSIF EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state <> 'closed')
  THEN blocker := 'nonterminal_attempt';
  ELSIF EXISTS (SELECT 1 FROM session_attempt_interruptions WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state IN ('pending','delivered','acknowledged'))
  THEN blocker := 'unsettled_interruption';
  ELSIF EXISTS (SELECT 1 FROM session_system_updates pending_update
      JOIN sessions update_owner ON update_owner.id = pending_update.session_id
      WHERE pending_update.workspace_id = p_workspace_id
        AND pending_update.session_id = p_session_id AND pending_update.state = 'pending'
        AND session_system_update_carries_foreign_authority(pending_update,
          update_owner.owner_subject_id, update_owner.owner_organization_membership_id))
  THEN blocker := 'pending_system_update';
  ELSIF EXISTS (SELECT 1 FROM session_human_input_requests request
      WHERE request.workspace_id = p_workspace_id
        AND request.session_id = p_session_id AND request.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM session_turns request_turn
          WHERE request_turn.workspace_id = request.workspace_id
            AND request_turn.id = request.turn_id
            AND request_turn.status IN (
              'completed','failed','cancelled','superseded','withdrawn_for_edit')))
  THEN blocker := 'pending_human_input';
  ELSIF EXISTS (SELECT 1 FROM session_pending_tool_calls pending
      WHERE pending.workspace_id = p_workspace_id
        AND pending.session_id = p_session_id
        AND (EXISTS (SELECT 1 FROM session_turns owner_turn
            WHERE owner_turn.workspace_id = pending.workspace_id
              AND owner_turn.id = pending.turn_id
              AND owner_turn.status NOT IN (
                'completed','failed','cancelled','superseded','withdrawn_for_edit'))
          OR EXISTS (SELECT 1 FROM session_turn_attempts owner_attempt
            WHERE owner_attempt.workspace_id = pending.workspace_id
              AND owner_attempt.id = pending.attempt_id
              AND (owner_attempt.state <> 'closed'
                OR (owner_attempt.quiesced_at IS NULL AND EXISTS (
                  SELECT 1 FROM session_attempt_interruptions interruption
                  WHERE interruption.attempt_id = owner_attempt.id))))))
  THEN blocker := 'pending_tool_receipt';
  ELSIF EXISTS (SELECT 1 FROM agent_run_states run_state
      WHERE run_state.workspace_id = p_workspace_id
        AND run_state.session_id = p_session_id
        AND NOT EXISTS (SELECT 1 FROM session_turns state_turn
          WHERE state_turn.workspace_id = run_state.workspace_id
            AND state_turn.id = run_state.turn_id
            AND state_turn.status IN (
              'completed','failed','cancelled','superseded','withdrawn_for_edit')))
  THEN blocker := 'run_state';
  ELSIF EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'active')
  THEN blocker := 'active_goal';
  ELSE
    blocker := session_tenancy_standing_blocker(p_account_id, p_workspace_id, p_session_id);
  END IF;

  IF blocker IS NULL AND p_require_singleton_group THEN
    -- The caller's own actor-scoped RLS must not hide a sibling. The function
    -- has already locked and identified the authorized source session.
    PERFORM set_config('opengeni.subject_id', '', true);
    IF EXISTS (SELECT 1 FROM sessions sibling
      WHERE sibling.account_id = p_account_id
        AND sibling.workspace_id = p_workspace_id
        AND sibling.sandbox_group_id = session_group_id
        AND sibling.id <> p_session_id)
    THEN blocker := 'shared_sandbox_group'; END IF;
    PERFORM set_config(
      'opengeni.subject_id', CASE WHEN previous_subject IS NULL THEN '' ELSE previous_subject END, true
    );
  END IF;

  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'session tenancy mutation requires a quiescent session'
      USING ERRCODE = '55P03', DETAIL = blocker;
  END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.subject_id', CASE WHEN previous_subject IS NULL THEN '' ELSE previous_subject END, true
  );
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.activate_session_tenancy_product(p_account_id uuid, p_inventory_digest text, p_parity_digest text, p_activated_by text, p_application_roles text[])
 RETURNS TABLE(account_id uuid, activation_version integer, activated_at timestamp with time zone, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'public', 'pg_temp'
AS $function$
DECLARE
  existing session_tenancy_activations%%ROWTYPE;
  inserted session_tenancy_activations%%ROWTYPE;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  inventory_report jsonb;
  parity_report jsonb;
  backfill_evidence jsonb;
  computed_inventory_digest text;
  computed_parity_digest text;
  evidence_receipt_ids uuid[];
  required_gate text;
  required_lane text;
  required_gates constant text[] := ARRAY[
    'membership_personal_workspace_pointer',
    'membership_personal_workspace_exclusive',
    'membership_personal_workspace_same_organization',
    'personal_workspace_has_no_membership_row',
    'authority_resource_single_owner',
    'grant_delegation_fence_complete',
    'grant_owner_membership_active',
    'grant_authority_live',
    'grant_session_fence_not_ahead',
    'session_owner_provenance_paired',
    'session_owner_subject_matches_membership',
    'session_owner_membership_same_organization',
    'login_binding_dispute_propagated',
    'identity_active_binding_owned',
    'user_scoped_resource_live_anchor'
  ];
  required_lanes constant text[] := ARRAY[
    'connectionsLegacyUser',
    'workspaceWriterAdmissionsLegacyUnattributedInWindow',
    'workspaceWriterProcessesLegacyUnattributedInWindow',
    'documentsLegacyPersonalNullAuthority',
    'codexCredentialsUnattributedConnector',
    'workspaceMemberSubjectsWithoutMembershipAnchor',
    'sessionsAttributableButUnattributed',
    'connectionUseLegacyResolutionsInWindow'
  ];
BEGIN
  IF p_account_id IS NULL
    OR p_inventory_digest !~ '^[0-9a-f]{64}$'
    OR p_parity_digest !~ '^[0-9a-f]{64}$'
    OR pg_catalog.octet_length(pg_catalog.btrim(p_activated_by)) NOT BETWEEN 1 AND 256
    OR p_application_roles IS NULL
    OR pg_catalog.cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name <> pg_catalog.btrim(role_name)
        OR pg_catalog.octet_length(role_name) NOT BETWEEN 1 AND 63
    )
    OR pg_catalog.cardinality(ARRAY(
      SELECT DISTINCT role_name FROM pg_catalog.unnest(p_application_roles) role_name
    )) <> pg_catalog.cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy activation request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  LOCK TABLE
    workspaces, workspace_memberships, organization_memberships,
    canonical_human_identities, canonical_human_identity_subjects,
    canonical_human_login_bindings, sessions, session_turns,
    session_turn_attempts, session_attempt_interruptions,
    session_system_updates, session_human_input_requests,
    session_pending_tool_calls, agent_run_states, session_goals,
    session_realtime_modes,
    session_realtime_connections, scheduled_tasks,
    workspace_variable_sets, rigs, enrollments, connections, documents,
    codex_subscription_credentials, sandbox_workspace_mutation_admissions,
    sandbox_retained_processes, sandbox_lease_holders,
    organization_user_resource_authorities, organization_user_resource_grants,
    connection_use_audit_facts, tenancy_backfill_receipts,
    tenancy_backfill_unresolved_rows, session_tenancy_activations
  IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  -- Lock every provisioning source before the shared deployment fence. The
  -- greenfield path writes its graph first and takes the fence last; reversing
  -- this order would deadlock RowExclusive -> boundary against boundary ->
  -- AccessExclusive during the first cutover.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  SELECT * INTO existing FROM session_tenancy_activations activation
  WHERE activation.account_id = p_account_id;
  IF FOUND THEN
    IF existing.inventory_digest <> p_inventory_digest
      OR existing.parity_digest <> p_parity_digest
    THEN
      RAISE EXCEPTION 'session tenancy activation evidence conflicts with the durable receipt'
        USING ERRCODE = '23505';
    END IF;
    account_id := existing.account_id;
    activation_version := existing.activation_version;
    activated_at := existing.activated_at;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  inventory_report := inventory_organization_tenancy(p_account_id);
  parity_report := check_organization_tenancy_parity(p_account_id, 10, 30);
  backfill_evidence := check_tenancy_backfill_activation_evidence(p_account_id);
  IF inventory_report #>> '{schemaVersion}' <> '2'
    OR inventory_report ->> 'organizationId' <> p_account_id::text
    OR parity_report #>> '{schemaVersion}' <> '1'
    OR parity_report ->> 'organizationId' <> p_account_id::text
    OR pg_catalog.jsonb_typeof(parity_report -> 'gates') <> 'object'
    OR pg_catalog.jsonb_typeof(parity_report -> 'lanes') <> 'object'
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;

  FOREACH required_gate IN ARRAY required_gates LOOP
    IF NOT (parity_report -> 'gates' ? required_gate)
      OR pg_catalog.jsonb_typeof(parity_report -> 'gates' -> required_gate -> 'violations')
        <> 'number'
      OR (parity_report #>> ARRAY['gates', required_gate, 'violations'])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation parity gate is not clean: %%', required_gate
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'gates') gate
    WHERE pg_catalog.jsonb_typeof(gate.value -> 'violations') <> 'number'
      OR (gate.value ->> 'violations')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation parity has a non-zero gate'
      USING ERRCODE = '55000';
  END IF;
  FOREACH required_lane IN ARRAY required_lanes LOOP
    IF NOT (parity_report -> 'lanes' ? required_lane)
      OR pg_catalog.jsonb_typeof(parity_report -> 'lanes' -> required_lane) <> 'number'
      OR (parity_report #>> ARRAY['lanes', required_lane])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation compatibility lane is not drained: %%',
        required_lane USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'lanes') lane
    WHERE pg_catalog.jsonb_typeof(lane.value) <> 'number'
      OR (lane.value #>> '{}')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation has an undrained compatibility lane'
      USING ERRCODE = '55000';
  END IF;
  IF coalesce((backfill_evidence ->> 'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'session tenancy activation requires settled backfill evidence'
      USING ERRCODE = '55000', DETAIL = (backfill_evidence -> 'blockers')::text;
  END IF;

  computed_inventory_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(inventory_report), 'UTF8'
  ), 'sha256'), 'hex');
  computed_parity_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(parity_report), 'UTF8'
  ), 'sha256'), 'hex');
  IF computed_inventory_digest <> p_inventory_digest
    OR computed_parity_digest <> p_parity_digest
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence changed before the cutover lock'
      USING ERRCODE = '40001';
  END IF;

  SELECT pg_catalog.array_agg(receipt_id::uuid ORDER BY ordinal)
    INTO evidence_receipt_ids
  FROM pg_catalog.jsonb_array_elements_text(backfill_evidence -> 'receiptIds')
    WITH ORDINALITY AS evidence(receipt_id, ordinal);
  IF pg_catalog.cardinality(evidence_receipt_ids) <> 6 THEN
    RAISE EXCEPTION 'session tenancy activation backfill evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;
  -- The narrow marker window for the one append this function performs. The
  -- `RETURNING` read is covered by 0303's existing organization-isolation
  -- SELECT policy, whose account GUC this function already set above.
  BEGIN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
    );
    INSERT INTO session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) VALUES (
      p_account_id, 1, p_inventory_digest, p_parity_digest,
      pg_catalog.btrim(p_activated_by), evidence_receipt_ids
    ) RETURNING * INTO inserted;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RAISE;
  END;
  account_id := inserted.account_id;
  activation_version := inserted.activation_version;
  activated_at := inserted.activated_at;
  replay := false;
  RETURN NEXT;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.organization_membership_command_0263(p_command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
AS $function$
DECLARE
  action_name text := p_command ->> 'action';
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  input_hash_value text;
  service_authorized boolean := false;
  receipt_row organization_membership_operation_receipts%%ROWTYPE;
  actor organization_memberships%%ROWTYPE;
  target organization_memberships%%ROWTYPE;
  invitation organization_membership_invitations%%ROWTYPE;
  policy organization_user_retention_policies%%ROWTYPE;
  result jsonb;
  now_value timestamptz := pg_catalog.clock_timestamp();
  target_subject text;
  target_email text;
  requested_role text;
  target_id uuid;
  expected_revision bigint;
  workspace_id_value uuid;
  reason_value text;
  retention_days_value integer;
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
  visibility_capability_id uuid;
  interruption_operation_id uuid;
  affected_session_ids uuid[];
  affected_realtime_ids uuid[];
  cancelled_turn_ids uuid[];
  cancelled_turn record;
  cancelled_request record;
  cancelled_sequence bigint;
  cancelled_association text;
  settled_update_ids uuid[];
  settled_history_item_id uuid;
  activity_revision_value bigint;
BEGIN
  IF p_command IS NULL
    OR action_name NOT IN ('invite', 'accept', 'revoke_invitation', 'change_role', 'suspend', 'reactivate', 'offboard', 'retention')
    OR account_id_value IS NULL
    OR operation_id_value IS NULL
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization membership command authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  service_authorized := opengeni_private.external_membership_service_authority(p_command);
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  -- Lock-order repair: advisory organization fence plus a non-conflicting row lock
  -- (see the header: `FOR UPDATE` here inverted the canonical order).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM acquire_organization_session_tenancy_fences(
    account_id_value
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  SELECT * INTO receipt_row
  FROM organization_membership_operation_receipts receipt
  WHERE receipt.account_id = account_id_value
    AND receipt.operation_id = operation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF receipt_row.action IS DISTINCT FROM action_name
      OR receipt_row.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    RETURN receipt_row.result;
  END IF;

  IF action_name = 'accept' THEN
    target_id := nullif(p_command ->> 'invitationId', '')::uuid;
    expected_revision := nullif(p_command ->> 'expectedRevision', '')::bigint;
    SELECT * INTO invitation
    FROM organization_membership_invitations candidate
    WHERE candidate.id = target_id AND candidate.account_id = account_id_value
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002'; END IF;
    IF invitation.target_subject_id IS DISTINCT FROM actor_subject THEN
      RAISE EXCEPTION 'invitation belongs to another subject' USING ERRCODE = '42501';
    END IF;
    IF invitation.status <> 'pending' OR invitation.expires_at <= now_value THEN
      RAISE EXCEPTION 'invitation is not active' USING ERRCODE = '55000';
    END IF;
    IF invitation.revision IS DISTINCT FROM expected_revision THEN
      RAISE EXCEPTION 'invitation revision is stale' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO target FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = actor_subject
    FOR UPDATE;
    IF NOT FOUND THEN
      workspace_id_value := gen_random_uuid();
      PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
      INSERT INTO workspaces (
        id, account_id, name, slug, external_source, external_id
      ) VALUES (
        workspace_id_value, account_id_value, 'Personal workspace', NULL,
        'opengeni:organization-membership', account_id_value::text || ':' || actor_subject
      ) ON CONFLICT (account_id, external_source, external_id) DO UPDATE
        SET updated_at = workspaces.updated_at
      RETURNING id INTO workspace_id_value;
      INSERT INTO workspace_inference_controls (workspace_id, account_id)
      VALUES (workspace_id_value, account_id_value) ON CONFLICT DO NOTHING;
      INSERT INTO organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) VALUES (
        account_id_value, actor_subject, invitation.role, 'active', workspace_id_value
      ) RETURNING * INTO target;
    ELSE
      IF target.status = 'active' THEN
        RAISE EXCEPTION 'organization membership is already active' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'inactive organization membership requires explicit owner lifecycle action'
        USING ERRCODE = '55000';
    END IF;
    UPDATE organization_membership_invitations SET
      status = 'accepted', revision = revision + 1,
      accepted_membership_id = target.id, updated_at = now_value
    WHERE id = invitation.id RETURNING * INTO invitation;
    result := pg_catalog.jsonb_build_object(
      'invitation', opengeni_private.organization_invitation_row_json(invitation),
      'membership', opengeni_private.organization_membership_row_json(target)
    );
    actor := target;
  ELSE
    -- Existing session-visibility activation serializes workspace -> member ->
    -- session. Offboarding spans every owned workspace, so pre-lock that exact
    -- workspace prefix in UUID order before locking either actor or target
    -- membership. This prevents member/workspace lock inversion while the
    -- later per-workspace pass takes the canonical session/turn/attempt suffix.
    IF action_name IN ('suspend', 'offboard') THEN
      target_id := nullif(p_command ->> 'membershipId', '')::uuid;
      expected_revision := nullif(
        p_command ->> 'expectedAuthorizationRevision', ''
      )::bigint;
      FOR workspace_id_value IN
        SELECT workspace.id
        FROM workspaces workspace
        WHERE workspace.account_id = account_id_value
        ORDER BY workspace.id
      LOOP
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
      END LOOP;
      PERFORM 1 FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.id IN (
          target_id,
          (
            SELECT candidate.id FROM organization_memberships candidate
            WHERE candidate.account_id = account_id_value
              AND candidate.subject_id = actor_subject
          )
        )
      ORDER BY membership.id
      FOR UPDATE;
      SELECT * INTO actor FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.subject_id = actor_subject;
    ELSE
      SELECT * INTO actor FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.subject_id = actor_subject
      FOR UPDATE;
    END IF;
    IF NOT service_authorized AND (NOT FOUND OR actor.status <> 'active') THEN
      RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
    END IF;

    IF action_name = 'invite' THEN
      IF NOT service_authorized AND actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_subject := p_command ->> 'targetSubjectId';
      target_email := lower(btrim(p_command ->> 'targetEmail'));
      requested_role := p_command ->> 'role';
      IF target_subject IS NULL OR target_subject NOT LIKE 'user:%%'
        OR requested_role NOT IN ('owner', 'admin', 'member')
        OR (actor.role = 'admin' AND requested_role <> 'member')
        OR nullif(p_command ->> 'expiresAt', '')::timestamptz <= now_value
        OR nullif(p_command ->> 'expiresAt', '')::timestamptz > now_value + interval '30 days'
      THEN
        RAISE EXCEPTION 'invitation input is invalid' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = account_id_value
          AND membership.subject_id = target_subject
          AND membership.status = 'active'
      ) THEN
        RAISE EXCEPTION 'subject is already an active organization member' USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = account_id_value
          AND membership.subject_id = target_subject
          AND membership.status IN ('suspended', 'revoked')
      ) THEN
        RAISE EXCEPTION 'inactive organization membership cannot be re-invited'
          USING ERRCODE = '55000';
      END IF;
      UPDATE organization_membership_invitations SET
        status = 'revoked', revision = revision + 1, updated_at = now_value
      WHERE account_id = account_id_value
        AND target_subject_id = target_subject AND status = 'pending';
      INSERT INTO organization_membership_invitations (
        account_id, target_subject_id, target_email, role,
        created_by_membership_id, expires_at
      ) VALUES (
        account_id_value, target_subject, target_email, requested_role,
        actor.id, nullif(p_command ->> 'expiresAt', '')::timestamptz
      ) RETURNING * INTO invitation;
      result := opengeni_private.organization_invitation_row_json(invitation);
      target := NULL;
    ELSIF action_name = 'revoke_invitation' THEN
      IF NOT service_authorized AND actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'invitationId', '')::uuid;
      expected_revision := nullif(p_command ->> 'expectedRevision', '')::bigint;
      SELECT * INTO invitation
      FROM organization_membership_invitations candidate
      WHERE candidate.id = target_id AND candidate.account_id = account_id_value
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002'; END IF;
      IF invitation.revision IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'invitation revision is stale' USING ERRCODE = '40001';
      END IF;
      IF invitation.status <> 'pending' THEN
        RAISE EXCEPTION 'only a pending invitation can be revoked' USING ERRCODE = '55000';
      END IF;
      IF actor.role = 'admin' AND invitation.role <> 'member' THEN
        RAISE EXCEPTION 'administrators may revoke member invitations only' USING ERRCODE = '42501';
      END IF;
      UPDATE organization_membership_invitations SET
        status = 'revoked', revision = revision + 1, updated_at = now_value
      WHERE id = invitation.id RETURNING * INTO invitation;
      result := opengeni_private.organization_invitation_row_json(invitation);
      target := NULL;
    ELSIF action_name = 'retention' THEN
      IF actor.role <> 'owner' THEN
        RAISE EXCEPTION 'organization owner required' USING ERRCODE = '42501';
      END IF;
      expected_revision := nullif(p_command ->> 'expectedVersion', '')::bigint;
      requested_role := p_command ->> 'mode';
      retention_days_value := nullif(p_command ->> 'retentionDays', '')::integer;
      IF requested_role NOT IN ('retain', 'delete_after')
        OR (requested_role = 'retain' AND retention_days_value IS NOT NULL)
        OR (requested_role = 'delete_after' AND retention_days_value NOT BETWEEN 30 AND 90)
      THEN
        RAISE EXCEPTION 'retention policy input is invalid' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO policy FROM organization_user_retention_policies candidate
      WHERE candidate.account_id = account_id_value FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO organization_user_retention_policies (
          account_id, mode, retention_days, version, updated_by_membership_id
        ) VALUES (account_id_value, 'retain', NULL, 1, actor.id)
        RETURNING * INTO policy;
      END IF;
      IF policy.version IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'retention policy version is stale' USING ERRCODE = '40001';
      END IF;
      UPDATE organization_user_retention_policies SET
        mode = requested_role, retention_days = retention_days_value,
        version = version + 1, updated_by_membership_id = actor.id,
        updated_at = now_value
      WHERE account_id = account_id_value RETURNING * INTO policy;
      result := pg_catalog.jsonb_build_object(
        'organizationId', policy.account_id, 'mode', policy.mode,
        'retentionDays', policy.retention_days, 'version', policy.version,
        'updatedAt', policy.updated_at
      );
      target := NULL;
    ELSE
      IF NOT service_authorized AND actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'membershipId', '')::uuid;
      expected_revision := nullif(p_command ->> 'expectedAuthorizationRevision', '')::bigint;
      requested_role := p_command ->> 'role';
      reason_value := nullif(btrim(p_command ->> 'reason'), '');
      IF reason_value IS NOT NULL
        AND octet_length(convert_to(reason_value, 'UTF8')) > 512
      THEN RAISE EXCEPTION 'reason is too large' USING ERRCODE = '22023'; END IF;
      PERFORM 1 FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.id IN (actor.id, target_id)
      ORDER BY membership.id FOR UPDATE;
      SELECT * INTO target FROM organization_memberships membership
      WHERE membership.account_id = account_id_value AND membership.id = target_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'organization member not found' USING ERRCODE = 'P0002'; END IF;
      IF target.authorization_revision IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'organization membership revision is stale' USING ERRCODE = '40001';
      END IF;
      IF actor.role = 'admin' AND target.role <> 'member' THEN
        RAISE EXCEPTION 'administrators may manage members only' USING ERRCODE = '42501';
      END IF;
      IF target.role = 'owner' AND (
        action_name IN ('suspend', 'offboard')
        OR (action_name = 'change_role' AND requested_role <> 'owner')
      ) AND NOT EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = account_id_value AND other.id <> target.id
          AND other.status = 'active' AND other.role = 'owner'
      ) THEN
        RAISE EXCEPTION 'cannot remove the last active organization owner'
          USING ERRCODE = '55000';
      END IF;
      IF action_name = 'change_role' THEN
        IF target.status <> 'active' OR requested_role NOT IN ('owner', 'admin', 'member')
          OR (actor.role = 'admin' AND requested_role <> 'member')
        THEN RAISE EXCEPTION 'role transition is invalid' USING ERRCODE = '55000'; END IF;
        IF requested_role IS DISTINCT FROM target.role THEN
          UPDATE organization_memberships SET role = requested_role,
            authorization_revision = authorization_revision + 1, updated_at = now_value
          WHERE id = target.id RETURNING * INTO target;
        END IF;
      ELSIF action_name = 'reactivate' THEN
        IF target.status <> 'suspended' THEN
          RAISE EXCEPTION 'only a suspended member can be reactivated' USING ERRCODE = '55000';
        END IF;
        UPDATE organization_memberships SET status = 'active',
          authorization_revision = authorization_revision + 1, updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;
      ELSIF action_name IN ('suspend', 'offboard') THEN
        IF action_name = 'suspend' AND target.status <> 'active' THEN
          RAISE EXCEPTION 'only an active member can be suspended' USING ERRCODE = '55000';
        ELSIF action_name = 'offboard' AND target.status NOT IN ('active', 'suspended') THEN
          RAISE EXCEPTION 'only an active or suspended member can be offboarded'
            USING ERRCODE = '55000';
        END IF;
        SELECT * INTO policy FROM organization_user_retention_policies candidate
        WHERE candidate.account_id = account_id_value;
        UPDATE organization_user_resource_grants SET
          status = 'revoked', generation = generation + 1,
          revoked_at = now_value, updated_at = now_value
        WHERE account_id = account_id_value
          AND owner_organization_membership_id = target.id AND status = 'active';
        UPDATE organization_user_resource_authorities SET
          status = 'retained', generation = generation + 1, updated_at = now_value
        WHERE account_id = account_id_value
          AND organization_membership_id = target.id AND status = 'active'
          AND action_name = 'offboard';
        DELETE FROM workspace_memberships
        WHERE account_id = account_id_value AND subject_id = target.subject_id;
        -- Private-session attempts carry the exact authority epoch. Advance it
        -- under each workspace's FORCE-RLS context without touching updated_at
        -- (the session activity commit gate owns that separate concern).
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
        FOR workspace_id_value IN
          SELECT workspace.id
          FROM workspaces workspace
          WHERE workspace.account_id = account_id_value
          ORDER BY workspace.id
        LOOP
          PERFORM pg_catalog.set_config(
            'opengeni.workspace_id', workspace_id_value::text, true
          );
          PERFORM pg_catalog.set_config(
            'opengeni.session_activity_gate_state', 'open', true
          );
          PERFORM pg_catalog.set_config(
            'opengeni.session_activity_gate_workspace_id', workspace_id_value::text, true
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
              affected.owner_organization_membership_id = target.id
              OR EXISTS (
                SELECT 1 FROM session_turns initiated
                WHERE initiated.session_id = affected.id
                  AND initiated.initiating_human_subject_id = target.subject_id
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
                  owned.owner_organization_membership_id = target.id
                  OR turn_row.initiating_human_subject_id = target.subject_id
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
                  owned.owner_organization_membership_id = target.id
                  OR EXISTS (
                    SELECT 1 FROM session_turns initiated
                    WHERE initiated.id = attempt.turn_id
                      AND initiated.initiating_human_subject_id = target.subject_id
                  )
                )
            )
          ORDER BY attempt.id
          FOR UPDATE;
          PERFORM 1 FROM session_realtime_modes realtime
          WHERE realtime.account_id = account_id_value
            AND realtime.workspace_id = workspace_id_value
            AND realtime.owner_subject_id = target.subject_id
            AND realtime.state = 'active'
          ORDER BY realtime.id
          FOR UPDATE;
          SELECT COALESCE(pg_catalog.array_agg(realtime.id ORDER BY realtime.id), ARRAY[]::uuid[])
          INTO affected_realtime_ids
          FROM session_realtime_modes realtime
          WHERE realtime.account_id = account_id_value
            AND realtime.workspace_id = workspace_id_value
            AND realtime.owner_subject_id = target.subject_id
            AND realtime.state = 'active';
          PERFORM 1 FROM session_realtime_connections connection
          WHERE connection.account_id = account_id_value
            AND connection.workspace_id = workspace_id_value
            AND connection.realtime_id = ANY(affected_realtime_ids)
            AND connection.state IN ('negotiating', 'ready', 'active')
          ORDER BY connection.id
          FOR UPDATE;
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
                owned.owner_organization_membership_id = target.id
                OR turn_row.initiating_human_subject_id = target.subject_id
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
              owned.owner_organization_membership_id = target.id
              OR turn_row.initiating_human_subject_id = target.subject_id
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
            CASE WHEN service_authorized THEN 'service' ELSE 'human' END, actor_subject, 'organization.membership.' || action_name,
            'organization-membership:' || operation_id_value::text,
            input_hash_value,
            pg_catalog.jsonb_build_object(
              'organizationMembershipOperationId', operation_id_value,
              'organizationMembershipId', target.id
            )
          );
          INSERT INTO session_attempt_interruptions (
            account_id, workspace_id, session_id, operation_id, attempt_id,
            kind, control_revision
          )
          SELECT attempt.account_id, attempt.workspace_id, attempt.session_id,
            interruption_operation_id, attempt.id, 'organization_membership_revoked',
            CASE WHEN owned.owner_organization_membership_id = target.id
              THEN owned.authority_epoch + 1 ELSE owned.authority_epoch END
          FROM session_turn_attempts attempt
          JOIN sessions owned ON owned.id = attempt.session_id
          JOIN session_turns initiated ON initiated.id = attempt.turn_id
          WHERE attempt.account_id = account_id_value
            AND attempt.workspace_id = workspace_id_value
            AND (
              owned.owner_organization_membership_id = target.id
              OR initiated.initiating_human_subject_id = target.subject_id
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
                    owned.owner_organization_membership_id = target.id
                    OR turn_row.initiating_human_subject_id = target.subject_id
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
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = update_row.session_id
                AND owned.owner_organization_membership_id = target.id
            );
          UPDATE session_system_update_outbox outbox
          SET status = 'failed', last_error = 'organization_membership_' || action_name,
            updated_at = now_value
          WHERE outbox.account_id = account_id_value
            AND outbox.workspace_id = workspace_id_value
            AND outbox.status = 'pending'
            AND EXISTS (
              SELECT 1 FROM sessions source_session
              WHERE source_session.id = outbox.source_session_id
                AND source_session.owner_organization_membership_id = target.id
            );
          UPDATE session_goals goal_row
          SET status = 'paused', paused_reason = 'api',
            rationale = CASE WHEN action_name = 'suspend'
              THEN 'Organization membership was suspended; explicit reauthorization is required.'
              ELSE 'Organization membership was revoked; explicit reauthorization is required.' END,
            version = goal_row.version + 1, updated_at = now_value
          WHERE goal_row.account_id = account_id_value
            AND goal_row.workspace_id = workspace_id_value
            AND goal_row.status = 'active'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = goal_row.session_id
                AND owned.owner_organization_membership_id = target.id
            );
          UPDATE scheduled_tasks task
          SET status = 'paused', personal_connection_delegations = '[]'::jsonb,
            authority_revision = task.authority_revision + 1,
            updated_at = now_value
          WHERE task.account_id = account_id_value
            AND task.workspace_id = workspace_id_value
            AND task.status = 'active'
            AND task.created_by_kind = 'subject'
            AND task.created_by_subject_id = target.subject_id;
          UPDATE organization_user_resource_grants grant_row
          SET status = 'revoked', revoked_at = now_value,
            generation = grant_row.generation + 1, updated_at = now_value
          WHERE grant_row.account_id = account_id_value
            AND grant_row.workspace_id = workspace_id_value
            AND grant_row.status = 'active'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = grant_row.session_id
                AND owned.owner_organization_membership_id = target.id
                AND owned.authority_epoch = grant_row.authority_epoch
            );
          WITH advanced AS (
            UPDATE sessions owned SET
              authority_epoch = owned.authority_epoch + 1,
              initial_personal_connection_delegations = '[]'::jsonb,
              last_sequence = owned.last_sequence + 1
            WHERE owned.account_id = account_id_value
              AND owned.workspace_id = workspace_id_value
              AND owned.owner_organization_membership_id = target.id
            RETURNING owned.id, owned.workspace_id, owned.last_sequence,
              owned.authority_epoch
          )
          INSERT INTO session_events (
            account_id, workspace_id, session_id, sequence, type, payload, occurred_at
          )
          SELECT account_id_value, advanced.workspace_id, advanced.id,
            advanced.last_sequence,
            CASE WHEN action_name = 'suspend'
              THEN 'session.authority.suspended' ELSE 'session.authority.revoked' END,
            pg_catalog.jsonb_build_object(
              'operationId', operation_id_value,
              'organizationMembershipId', target.id,
              'previousAuthorityEpoch', advanced.authority_epoch - 1,
              'authorityEpoch', advanced.authority_epoch
            ), now_value
          FROM advanced;
          INSERT INTO session_workflow_wake_outbox (
            session_id, account_id, workspace_id, temporal_workflow_id,
            reason, control_revision
          )
          SELECT affected.id, affected.account_id, affected.workspace_id,
            COALESCE(affected.temporal_workflow_id, 'session-' || affected.id::text),
            'organization_membership_' || action_name, 1
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
            RAISE EXCEPTION 'organization membership session activity counter is unavailable'
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
          SET CONSTRAINTS sessions_activity_insert_commit_guard,
            sessions_activity_update_commit_guard DEFERRED;
          PERFORM pg_catalog.set_config(
            'opengeni.session_activity_gate_state',
            COALESCE(previous_activity_gate_state, ''), true
          );
          PERFORM pg_catalog.set_config(
            'opengeni.session_activity_gate_workspace_id',
            COALESCE(previous_activity_gate_workspace, ''), true
          );
        END LOOP;
        DELETE FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id()
          AND capability.capability_id = visibility_capability_id;
        PERFORM pg_catalog.set_config(
          'opengeni.session_visibility_write_capability',
          coalesce(previous_visibility_capability, ''), true
        );
        UPDATE organization_memberships SET
          status = CASE WHEN action_name = 'suspend' THEN 'suspended' ELSE 'revoked' END,
          authorization_revision = authorization_revision + 1,
          revoked_at = CASE WHEN action_name = 'offboard' THEN now_value ELSE NULL END,
          personal_retention_until = CASE
            WHEN action_name = 'offboard' AND policy.mode = 'delete_after'
              THEN now_value + pg_catalog.make_interval(days => policy.retention_days)
            ELSE NULL
          END,
          updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;
      END IF;
      result := opengeni_private.organization_membership_row_json(target);
    END IF;
  END IF;

  INSERT INTO organization_membership_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (
    account_id_value, operation_id_value, action_name, input_hash_value, result
  );
  INSERT INTO organization_membership_lifecycle_events (
    account_id, operation_id, actor_membership_id, actor_service_subject, target_membership_id, kind,
    prior_authorization_revision, resulting_authorization_revision, reason
  ) VALUES (
    account_id_value, operation_id_value, actor.id, CASE WHEN service_authorized THEN actor_subject ELSE NULL END,
    CASE WHEN target.id IS NULL THEN NULL ELSE target.id END,
    action_name, expected_revision,
    CASE WHEN target.id IS NULL THEN NULL ELSE target.authorization_revision END,
    reason_value
  );
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', coalesce(previous_workspace, ''), true
  );
  RETURN result;
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
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.workspace_membership_removal_command(p_command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
AS $function$
DECLARE

  previous_membership_lifecycle text := pg_catalog.current_setting('opengeni.organization_tenancy_lifecycle', true);
  removal_fenced_access_id uuid;
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

  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  removal_fenced_access_id := opengeni_private.open_session_tenancy_fenced_access(session_tenancy_fence_target_schema());
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
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM acquire_session_tenancy_fence(workspace_id_value);

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

  -- The personal-state fence the pre-0278 delete path took: session listing
  -- takes its shared counterpart and pin mutation the same exclusive one, so
  -- a racing snapshot/pin writer cannot recreate personal rows after this
  -- cleanup. Same key derivation as lockSessionPersonalStateExclusive.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-personal-state:' || workspace_id_value::text || ':' || target_subject, 0
  ));

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
  -- Task rows before membership/session rows (0275 writer order; reentrant
  -- with the preparation pass in the same transaction).
  PERFORM 1 FROM scheduled_tasks task
  WHERE task.account_id = account_id_value
    AND task.workspace_id = workspace_id_value
    AND task.deleted_at IS NULL
    AND task.status = 'active'
    AND (
      (task.created_by_kind = 'subject' AND task.created_by_subject_id = target_subject)
      OR EXISTS (
        SELECT 1 FROM scheduled_task_revision_authorities authority
        WHERE authority.task_id = task.id
          AND authority.task_authority_revision = task.authority_revision
          AND authority.subject_id = target_subject
      )
      OR EXISTS (
        SELECT 1 FROM scheduled_task_personal_resource_authorities authority
        WHERE authority.task_id = task.id
          AND authority.task_authority_revision = task.authority_revision
          AND authority.initiating_human_subject_id = target_subject
      )
      OR EXISTS (
        SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
        WHERE snapshot.task_id = task.id
          AND snapshot.task_authority_revision = task.authority_revision
          AND snapshot.owner_subject_id = target_subject
      )
    )
  ORDER BY task.id
  FOR UPDATE;
  -- Serialize the administering roster before re-running the guards: the
  -- actor's organization membership (shared - the organization lifecycle
  -- takes it FOR UPDATE) and every admin/actor/target workspace membership
  -- row in id order. Two concurrent removals of the two last administering
  -- members therefore serialize, and the loser re-reads a roster with only
  -- one administering member left and fails closed.
  PERFORM 1 FROM organization_memberships org_actor
  WHERE org_actor.account_id = account_id_value
    AND org_actor.subject_id = actor_subject
  FOR SHARE;
  PERFORM 1 FROM workspace_memberships roster
  WHERE roster.account_id = account_id_value
    AND roster.workspace_id = workspace_id_value
    AND (
      roster.subject_id IN (actor_subject, target_subject)
      OR roster.permissions ?| ARRAY['workspace:admin', 'members:manage']
    )
  ORDER BY roster.id
  FOR UPDATE;
  PERFORM opengeni_private.assert_workspace_membership_removal_actor(
    account_id_value, workspace_id_value, actor_subject, target_subject
  );
  SELECT membership.id INTO membership_row_id
  FROM workspace_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.workspace_id = workspace_id_value
    AND membership.subject_id = target_subject;
  IF membership_row_id IS NULL THEN
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
    PERFORM opengeni_private.close_session_tenancy_fenced_access(removal_fenced_access_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_lifecycle, ''), true
  );
    RETURN pg_catalog.jsonb_build_object('removed', false);
  END IF;
  SELECT membership.id INTO target_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = target_subject;
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
    CASE WHEN actor_subject LIKE 'api_key:%%' THEN 'service' ELSE 'human' END, actor_subject, 'workspace.membership.remove',
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
    AND task.deleted_at IS NULL
    AND task.status = 'active'
    AND (
      (task.created_by_kind = 'subject' AND task.created_by_subject_id = target_subject)
      OR EXISTS (
        SELECT 1 FROM scheduled_task_revision_authorities authority
        WHERE authority.task_id = task.id
          AND authority.task_authority_revision = task.authority_revision
          AND authority.subject_id = target_subject
      )
      OR EXISTS (
        SELECT 1 FROM scheduled_task_personal_resource_authorities authority
        WHERE authority.task_id = task.id
          AND authority.task_authority_revision = task.authority_revision
          AND authority.initiating_human_subject_id = target_subject
      )
      OR EXISTS (
        SELECT 1 FROM scheduled_task_connection_authority_snapshots snapshot
        WHERE snapshot.task_id = task.id
          AND snapshot.task_authority_revision = task.authority_revision
          AND snapshot.owner_subject_id = target_subject
      )
    );
  UPDATE organization_user_resource_grants grant_row
  SET status = 'revoked', revoked_at = now_value,
    generation = grant_row.generation + 1, updated_at = now_value
  WHERE grant_row.account_id = account_id_value
    AND grant_row.workspace_id = workspace_id_value
    AND grant_row.status = 'active'
    AND target_membership_id IS NOT NULL
    AND grant_row.owner_organization_membership_id = target_membership_id;
  UPDATE organization_user_resource_grants grant_row
  SET status = 'revoked', revoked_at = now_value,
    generation = grant_row.generation + 1, updated_at = now_value
  WHERE grant_row.account_id = account_id_value
    AND grant_row.workspace_id = workspace_id_value
    AND grant_row.status = 'active'
    AND target_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions owned
      WHERE owned.id = grant_row.session_id
        AND owned.owner_organization_membership_id = target_membership_id
        AND owned.authority_epoch = grant_row.authority_epoch
    );
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
  PERFORM opengeni_private.close_session_tenancy_fenced_access(removal_fenced_access_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_lifecycle, ''), true
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
  PERFORM opengeni_private.close_session_tenancy_fenced_access(removal_fenced_access_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_lifecycle, ''), true
  );
  RAISE;
END
$function$

$create$, data_schema);
END
$install$;

-- Settled waiters belonged to the removed runtime, not current subscription
-- waiters or durable turn/history truth. Unexpected views/FKs fail closed.
DROP TABLE claude_capacity_waiters, codex_capacity_waiters, xai_capacity_waiters RESTRICT;
