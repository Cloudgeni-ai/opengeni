-- deployment-mode: rolling
-- Migration 0272: let exact pure-service attempts materialize organization-
-- and workspace-scoped Variable Sets. Migration 0254 required every runtime
-- materialization to resolve to an initiating human, which incorrectly failed
-- scheduled runs even though those scopes are not personal resources. Exact
-- secret reads remain human-only through assert_scoped_variable_set_attempt;
-- user-scoped runtime materialization still requires a causal human plus the
-- immutable personal-resource grant admitted for this exact attempt.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION assert_scoped_variable_set_materialization_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer
) RETURNS TABLE (
  actor_subject text,
  causal_human_subject text,
  actor_kind text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  stored_human_subject text;
  exact_initiator_kind text;
  exact_initiator_subject text;
  caller_subject text := nullif(
    pg_catalog.current_setting('opengeni.subject_id', true), ''
  );
  caller_human_subject text := nullif(
    pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''
  );
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_execution_generation <= 0
  THEN
    RAISE EXCEPTION 'variable-set materialization attempt scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    nullif(pg_catalog.btrim(turn_value.initiating_human_subject_id), ''),
    turn_value.initiator_kind,
    nullif(pg_catalog.btrim(turn_value.initiator_subject_id), '')
  INTO STRICT stored_human_subject, exact_initiator_kind, exact_initiator_subject
  FROM sessions session_value
  JOIN session_turns turn_value
    ON turn_value.id = p_turn_id
   AND turn_value.account_id = session_value.account_id
   AND turn_value.workspace_id = session_value.workspace_id
   AND turn_value.session_id = session_value.id
  JOIN session_turn_attempts attempt
    ON attempt.id = p_attempt_id
   AND attempt.account_id = turn_value.account_id
   AND attempt.workspace_id = turn_value.workspace_id
   AND attempt.session_id = turn_value.session_id
   AND attempt.turn_id = turn_value.id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.active_turn_id = p_turn_id
    AND turn_value.active_attempt_id = p_attempt_id
    AND turn_value.execution_generation = p_execution_generation
    AND turn_value.status = 'running'
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND attempt.closed_at IS NULL
    AND attempt.quiesced_at IS NULL
    AND attempt.authority_epoch = session_value.authority_epoch
    AND attempt.authority_visibility = session_value.visibility
    AND attempt.authority_owner_organization_membership_id
      IS NOT DISTINCT FROM session_value.owner_organization_membership_id
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.session_id = p_session_id
        AND interruption.attempt_id = p_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE OF session_value, turn_value
  FOR UPDATE OF attempt;

  causal_human_subject := coalesce(
    stored_human_subject,
    CASE WHEN exact_initiator_kind = 'subject' THEN exact_initiator_subject END
  );
  actor_subject := coalesce(causal_human_subject, exact_initiator_subject);
  actor_kind := CASE WHEN causal_human_subject IS NULL THEN exact_initiator_kind ELSE 'subject' END;
  IF actor_subject IS NULL
    OR caller_subject IS DISTINCT FROM actor_subject
    OR caller_human_subject IS DISTINCT FROM stored_human_subject
  THEN
    RAISE EXCEPTION 'variable-set materialization attempt actor mismatch'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'variable-set materialization requires the exact current uninterrupted attempt'
    USING ERRCODE = '42501';
END
$$;

CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_variable_set_id uuid
) RETURNS TABLE (
  variable_set_id uuid,
  variable_set_name text,
  variable_set_description text,
  authority_scope text,
  variable_set_generation bigint,
  variable_name text,
  value_encrypted text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  audit_subject text;
  causal_human text;
  audit_actor_kind text;
  variable_set_row workspace_variable_sets%ROWTYPE;
  resolved_count integer;
BEGIN
  INSERT INTO opengeni_private.variable_set_authority_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
  ON CONFLICT DO NOTHING;

  SELECT actor_subject, causal_human_subject, actor_kind
  INTO STRICT audit_subject, causal_human, audit_actor_kind
  FROM assert_scoped_variable_set_materialization_attempt(
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
    p_execution_generation
  );

  SELECT variable_set.* INTO STRICT variable_set_row
  FROM workspace_variable_sets variable_set
  WHERE variable_set.id = p_variable_set_id
    AND variable_set.account_id = p_account_id
    AND variable_set.status = 'active'
  FOR SHARE;

  PERFORM 1 FROM sessions session_value
  LEFT JOIN rig_versions rig_version
    ON rig_version.id = session_value.rig_version_id
   AND rig_version.rig_id = session_value.rig_id
   AND rig_version.account_id = session_value.account_id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND (
      session_value.variable_set_id = variable_set_row.id
      OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
        ? variable_set_row.id::text
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime variable set was not selected by the exact session'
      USING ERRCODE = '42501';
  END IF;

  IF variable_set_row.authority_scope = 'workspace'
    AND variable_set_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'workspace variable set is outside the runtime workspace'
      USING ERRCODE = '42501';
  ELSIF variable_set_row.authority_scope = 'user' THEN
    IF causal_human IS NULL THEN
      RAISE EXCEPTION 'personal variable-set materialization requires an initiating human subject'
        USING ERRCODE = '42501';
    END IF;
    SELECT count(*)::integer INTO resolved_count
    FROM resolve_session_attempt_personal_resources(
      p_account_id, p_workspace_id, p_attempt_id
    ) resolved
    WHERE resolved.resource_kind = 'variable_set'
      AND resolved.resource_id = variable_set_row.id
      AND resolved.authority_id = variable_set_row.authority_id
      AND resolved.authority_generation = variable_set_row.generation;
    IF resolved_count <> 1 THEN
      RAISE EXCEPTION 'personal variable-set grant is not exact or current'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO audit_events (
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, audit_subject,
    'variable_set.materialized', 'workspace_variable_set',
    variable_set_row.id::text,
    pg_catalog.jsonb_build_object(
      'variableSetId', variable_set_row.id,
      'scope', variable_set_row.authority_scope,
      'generation', variable_set_row.generation,
      'actorKind', audit_actor_kind,
      'sessionId', p_session_id,
      'turnId', p_turn_id,
      'attemptId', p_attempt_id,
      'executionGeneration', p_execution_generation
    ),
    1
  );

  RETURN QUERY
  SELECT selected.id, selected.name, selected.description,
    selected.authority_scope, selected.generation,
    variable.name, variable.value_encrypted
  FROM workspace_variable_sets selected
  LEFT JOIN workspace_variable_set_variables variable
    ON variable.account_id = selected.account_id
   AND variable.variable_set_id = selected.id
  WHERE selected.id = variable_set_row.id
  ORDER BY variable.name;

  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION assert_scoped_variable_set_materialization_attempt(
  uuid, uuid, uuid, uuid, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION materialize_scoped_variable_set_for_attempt(
      uuid, uuid, uuid, uuid, uuid, integer, uuid
    ) TO opengeni_app;
  END IF;
END
$$;

COMMENT ON FUNCTION materialize_scoped_variable_set_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) IS 'Only ciphertext egress for runtime injection; exact service attempts may materialize organization/workspace sets, while personal sets require an exact causal-human grant.';
