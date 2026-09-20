-- deployment-mode: maintenance
-- Sharing changes audience, not accepted execution authority. Privatization
-- and actual authority revocation still invalidate older execution receipts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $sharing_execution$
DECLARE target regprocedure; source text; before_text text; after_text text; patch jsonb; change jsonb;
BEGIN
 FOR patch IN SELECT jsonb_build_object('signature', value->>'signature', 'patches', jsonb_agg(value ORDER BY ordinal)) FROM jsonb_array_elements($patches$[
  {
    "signature": "admit_session_attempt_personal_resources()",
    "before": "NEW.authority_visibility IS DISTINCT FROM session_row.visibility\n        OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (NEW.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_machine()",
    "before": "NEW.authority_visibility IS DISTINCT FROM session_row.visibility\n    OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (NEW.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "authorize_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid)",
    "before": "attempt_row.authority_visibility IS DISTINCT FROM session_row.visibility\n    OR attempt_row.authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (attempt_row.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "prepare_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)",
    "before": "attempt_row.authority_visibility IS DISTINCT FROM session_row.visibility\n        OR attempt_row.authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (attempt_row.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_resources_v1()",
    "before": "NEW.authority_visibility IS DISTINCT FROM session_row.visibility\n    OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (NEW.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_resources_v1()",
    "before": "receipt_row.session_visibility IS DISTINCT FROM session_row.visibility\n    OR receipt_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (receipt_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_machine_v1()",
    "before": "snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility\n    OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (snapshot_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "assert_scoped_variable_set_attempt(uuid,uuid,uuid,uuid,uuid,integer)",
    "before": "attempt.authority_epoch = session_value.authority_epoch\n        AND attempt.authority_visibility = session_value.visibility",
    "after": "(attempt.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "assert_scoped_variable_set_materialization_attempt(uuid,uuid,uuid,uuid,uuid,integer)",
    "before": "attempt.authority_epoch = session_value.authority_epoch\n    AND attempt.authority_visibility = session_value.visibility",
    "after": "(attempt.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "assert_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean)",
    "before": "session_value.visibility = authorization_row.session_visibility\n        AND session_value.authority_epoch = authorization_row.session_authority_epoch",
    "after": "(authorization_row.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "bind_scheduled_task_run_connection_authorities(uuid,uuid,uuid,uuid)",
    "before": "snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility\n      OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (snapshot_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)",
    "before": "session_row.visibility IS DISTINCT FROM snapshot.session_visibility\n        OR session_row.authority_epoch IS DISTINCT FROM snapshot.session_authority_epoch",
    "after": "NOT (snapshot.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)",
    "before": "attempt.authority_visibility = session_row.visibility\n      AND attempt.authority_epoch = session_row.authority_epoch",
    "after": "(attempt.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "resolve_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)",
    "before": "session_value.visibility = snapshot.session_visibility\n              AND session_value.authority_epoch = snapshot.session_authority_epoch",
    "after": "(snapshot.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "resolve_session_attempt_personal_resources(uuid,uuid,uuid)",
    "before": "session_value.visibility = admission_row.session_visibility\n    AND session_value.authority_epoch = admission_row.session_authority_epoch",
    "after": "(admission_row.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "resolve_session_attempt_personal_resources_legacy_0305(uuid,uuid,uuid)",
    "before": "session_value.visibility = snapshot.session_visibility\n              AND session_value.authority_epoch = snapshot.session_authority_epoch",
    "after": "(snapshot.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "opengeni_private.read_session_file_attachments(uuid,uuid,uuid,integer,uuid[],jsonb)",
    "before": "a.authority_epoch=caller_row.authority_epoch AND a.authority_visibility=caller_row.visibility",
    "after": "(a.authority_epoch BETWEEN caller_row.execution_authority_epoch AND caller_row.authority_epoch)"
  },
  {
    "signature": "opengeni_private.mcp_operation_command_scoped(jsonb,text,jsonb)",
    "before": "a.authority_epoch=s.authority_epoch AND a.authority_visibility=s.visibility",
    "after": "(a.authority_epoch BETWEEN s.execution_authority_epoch AND s.authority_epoch)"
  },
  {
    "signature": "admit_scheduled_task_run_personal_resources()",
    "before": "session_value.visibility = authority_row.session_visibility\n            AND session_value.authority_epoch = authority_row.session_authority_epoch",
    "after": "(authority_row.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)",
    "before": "snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility\n          OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (snapshot_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)",
    "before": "snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility\n        OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (snapshot_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)",
    "before": "snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility\n      OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch",
    "after": "NOT (snapshot_row.session_authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "resolve_session_attempt_personal_resources(uuid,uuid,uuid)",
    "before": "attempt.authority_visibility = admission_row.session_visibility\n    AND attempt.authority_epoch = admission_row.session_authority_epoch",
    "after": "(attempt.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "resolve_session_attempt_personal_resources_legacy_0305(uuid,uuid,uuid)",
    "before": "attempt.authority_visibility = snapshot.session_visibility\n              AND attempt.authority_epoch = snapshot.session_authority_epoch",
    "after": "(attempt.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "admit_scheduled_agent_run_execution()",
    "before": "target_snapshot ->> 'visibility' IS DISTINCT FROM target_row.visibility\n      OR (target_snapshot ->> 'authorityEpoch')::integer\n        IS DISTINCT FROM target_row.authority_epoch",
    "after": "NOT ((target_snapshot ->> 'authorityEpoch')::integer BETWEEN target_row.execution_authority_epoch AND target_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_resources()",
    "before": "grant_value.context = session_row.visibility",
    "after": "(grant_value.context = session_row.visibility OR (\n      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'\n      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id\n      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)))"
  },
  {
    "signature": "admit_session_attempt_personal_resources()",
    "before": "grant_value.authority_epoch = session_row.authority_epoch",
    "after": "(grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "admit_session_attempt_personal_machine()",
    "before": "grant_value.context = session_row.visibility",
    "after": "(grant_value.context = session_row.visibility OR (\n      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'\n      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id\n      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)))"
  },
  {
    "signature": "admit_session_attempt_personal_machine()",
    "before": "grant_value.authority_epoch = session_row.authority_epoch",
    "after": "(grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "authorize_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid)",
    "before": "grant_value.context = session_row.visibility",
    "after": "(grant_value.context = session_row.visibility OR (\n      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'\n      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id\n      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)))"
  },
  {
    "signature": "authorize_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid)",
    "before": "grant_value.authority_epoch = session_row.authority_epoch",
    "after": "(grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "prepare_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)",
    "before": "grant_value.context = session_row.visibility",
    "after": "(grant_value.context = session_row.visibility OR (\n      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'\n      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id\n      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)))"
  },
  {
    "signature": "prepare_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)",
    "before": "grant_value.authority_epoch = session_row.authority_epoch",
    "after": "(grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)"
  },
  {
    "signature": "assert_session_attempt_personal_machine(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean)",
    "before": "grant_value.authority_epoch = authorization_row.session_authority_epoch",
    "after": "(grant_value.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)"
  },
  {
    "signature": "opengeni_private.fence_mcp_account_bindings()",
    "before": "      bindings := '[]'::jsonb;",
    "after": "      bindings := CASE WHEN document ->> 'visibility' = 'workspace_shared'\n        THEN old_bindings ELSE '[]'::jsonb END;"
  },
  {
    "signature": "derive_session_execution_authority_epoch()",
    "before": "      IF TG_OP = 'INSERT' THEN\n        NEW.execution_authority_epoch := NEW.authority_epoch;\n      ELSIF NEW.execution_authority_epoch IS DISTINCT FROM OLD.execution_authority_epoch THEN\n        RAISE EXCEPTION 'execution authority floor is lifecycle-owned' USING ERRCODE='42501';\n      ELSIF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch THEN\n        NEW.execution_authority_epoch := NEW.authority_epoch;\n      END IF;\n      RETURN NEW;",
    "after": "      IF TG_OP = 'INSERT' THEN\n        NEW.execution_authority_epoch := NEW.authority_epoch;\n      ELSIF NEW.execution_authority_epoch IS DISTINCT FROM OLD.execution_authority_epoch THEN\n        RAISE EXCEPTION 'execution authority floor is lifecycle-owned' USING ERRCODE='42501';\n      ELSIF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch THEN\n        IF NOT (OLD.visibility = 'user_private' AND NEW.visibility = 'workspace_shared'\n          AND NEW.authority_epoch = OLD.authority_epoch + 1\n          AND NEW.owner_subject_id IS NOT DISTINCT FROM OLD.owner_subject_id\n          AND NEW.owner_organization_membership_id IS NOT DISTINCT FROM OLD.owner_organization_membership_id) THEN\n          NEW.execution_authority_epoch := NEW.authority_epoch;\n        END IF;\n      END IF;\n      RETURN NEW;"
  },
  {
    "signature": "opengeni_private.read_session_file_attachments(uuid,uuid,uuid,integer,uuid[],jsonb)",
    "before": "session_row.authority_epoch IS DISTINCT FROM p_epoch",
    "after": "NOT COALESCE((session_row.authority_epoch = p_epoch OR (\n      p_actor->>'kind'='agent_attempt' AND (p_actor->>'callerSessionId')::uuid=p_session\n      AND p_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)), false)"
  }
]$patches$::jsonb) WITH ORDINALITY AS ordered(value,ordinal) GROUP BY value->>'signature' LOOP
  target := to_regprocedure(patch->>'signature');
  IF target IS NULL THEN RAISE EXCEPTION 'sharing execution routine missing: %',patch->>'signature'; END IF;
  source := pg_get_functiondef(target);
  FOR change IN SELECT value FROM jsonb_array_elements(patch->'patches') LOOP
  before_text := change->>'before'; after_text := change->>'after';
  IF strpos(source,before_text)=0 THEN RAISE EXCEPTION 'sharing execution routine drift: %',target; END IF;
  source := replace(source,before_text,after_text);
  END LOOP;
  EXECUTE source;
 END LOOP;
END $sharing_execution$;

-- Keep the visibility lifecycle body explicit; this is DDL, not a data backfill.
CREATE OR REPLACE FUNCTION public.transition_session_visibility(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text, p_target_visibility text, p_expected_authority_epoch integer, p_operation_key text, p_canonical_request_hash text, p_activation_version integer)
 RETURNS TABLE(operation_id uuid, event_id uuid, event_sequence integer, visibility text, authority_epoch integer, owner_organization_membership_id uuid, changed boolean, replay boolean, interrupted_attempt_count integer, cancelled_turn_count integer, cancelled_update_count integer, paused_goal_count integer, revoked_grant_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor_membership organization_memberships%ROWTYPE;
  session_row sessions%ROWTYPE;
  receipt_row session_command_receipts%ROWTYPE;
  new_epoch integer;
  grant_count integer := 0;
  event_row_id uuid;
  event_row_sequence integer;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_actor_subject_id IS NULL OR p_target_visibility IS NULL
    OR p_expected_authority_epoch IS NULL OR p_operation_key IS NULL
    OR p_canonical_request_hash IS NULL OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session visibility transition requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session visibility transition authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_target_visibility NOT IN ('user_private', 'workspace_shared')
    OR p_expected_authority_epoch < 1
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session visibility transition request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  -- Match the canonical organization-membership lifecycle prefix before any
  -- table/row lock. This keeps visibility changes from reintroducing the
  -- workspace/account lock cycle repaired by migration 0299.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_workspace_id::text, 0
  ));


  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  PERFORM 1 FROM workspaces workspace_row
  WHERE workspace_row.id = p_workspace_id AND workspace_row.account_id = p_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session visibility transition requires active membership'
    USING ERRCODE = '42501'; END IF;

  SELECT session.* INTO session_row FROM sessions session
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  IF session_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR session_row.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  THEN RAISE EXCEPTION 'session visibility transition is owner-only'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_workspace_id, 'human', p_actor_subject_id,
    'session.visibility.change', p_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.actor_type = 'human'
    AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL
    AND receipt.action = 'session.visibility.change'
    AND receipt.target_session_id = p_session_id AND receipt.target_turn_id IS NULL
    AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session visibility transition idempotency conflict'
      USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := nullif(receipt_row.result ->> 'eventSequence', '')::integer;
    visibility := receipt_row.result ->> 'visibility';
    authority_epoch := (receipt_row.result ->> 'authorityEpoch')::integer;
    owner_organization_membership_id := actor_membership.id;
    changed := (receipt_row.result ->> 'changed')::boolean;
    replay := true;
    interrupted_attempt_count := 0; cancelled_turn_count := 0;
    cancelled_update_count := 0; paused_goal_count := 0;
    revoked_grant_count := (receipt_row.result ->> 'revokedGrantCount')::integer;
    RETURN NEXT; RETURN;
  END IF;
  IF session_row.authority_epoch <> p_expected_authority_epoch THEN
    RAISE EXCEPTION 'session visibility transition authority epoch conflict'
      USING ERRCODE = '40001';
  END IF;

  new_epoch := session_row.authority_epoch;
  IF session_row.visibility <> p_target_visibility THEN
    IF p_target_visibility = 'user_private' THEN
      PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, true);
    END IF;
    new_epoch := session_row.authority_epoch + 1;
    IF new_epoch < 2 THEN RAISE EXCEPTION 'session authority epoch exhausted'
      USING ERRCODE = '22003'; END IF;

    IF p_target_visibility = 'user_private' THEN
      UPDATE organization_user_resource_grants grant_row
      SET status = 'revoked', revoked_at = clock_timestamp(),
        generation = grant_row.generation + 1, updated_at = clock_timestamp()
      WHERE grant_row.account_id = p_account_id
        AND grant_row.workspace_id = p_workspace_id
        AND grant_row.session_id = p_session_id
        AND grant_row.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch
        AND grant_row.status = 'active';
      GET DIAGNOSTICS grant_count = ROW_COUNT;
    END IF;

    INSERT INTO session_visibility_write_capabilities (
      backend_pid, transaction_id, capability_id
    ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
    PERFORM set_config('opengeni.session_visibility_write_capability',
      visibility_write_capability_id::text, true);
    UPDATE sessions transition_target SET
      visibility = p_target_visibility,
      authority_epoch = new_epoch,
      initial_personal_connection_delegations = CASE WHEN p_target_visibility = 'user_private'
        THEN '[]'::jsonb ELSE transition_target.initial_personal_connection_delegations END,
      last_sequence = session_row.last_sequence + 1,
      updated_at = clock_timestamp()
    WHERE transition_target.id = p_session_id
      AND transition_target.authority_epoch = session_row.authority_epoch;
    IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition lost authority epoch CAS'
      USING ERRCODE = '40001'; END IF;

    INSERT INTO session_events (
      account_id, workspace_id, session_id, sequence, type, payload, occurred_at
    ) VALUES (
      p_account_id, p_workspace_id, p_session_id, session_row.last_sequence + 1,
      'session.visibility.changed',
      jsonb_build_object(
        'operationId', receipt_row.id,
        'fromVisibility', CASE session_row.visibility WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
        'toVisibility', CASE p_target_visibility WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
        'previousAuthorityEpoch', session_row.authority_epoch,
        'authorityEpoch', new_epoch,
        'interruptedAttemptCount', 0, 'cancelledTurnCount', 0,
        'cancelledUpdateCount', 0, 'pausedGoalCount', 0,
        'revokedGrantCount', grant_count
      ), clock_timestamp()
    ) RETURNING id, sequence INTO event_row_id, event_row_sequence;
    DELETE FROM session_visibility_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = visibility_write_capability_id;
    PERFORM set_config('opengeni.session_visibility_write_capability',
      CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
      true);
  END IF;

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id,
    'eventSequence', event_row_sequence, 'visibility', p_target_visibility,
    'authorityEpoch', new_epoch, 'changed', session_row.visibility <> p_target_visibility,
    'revokedGrantCount', grant_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id;
  event_sequence := event_row_sequence; visibility := p_target_visibility;
  authority_epoch := new_epoch;
  owner_organization_membership_id := actor_membership.id;
  changed := session_row.visibility <> p_target_visibility; replay := false;
  interrupted_attempt_count := 0; cancelled_turn_count := 0;
  cancelled_update_count := 0; paused_goal_count := 0;
  revoked_grant_count := grant_count;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$function$
;
