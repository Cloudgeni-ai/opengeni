-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- A recovery attempt belongs to the same accepted logical turn. Its first
-- immutable snapshot is the accepted descriptor truth, even after permanent
-- Skill removal or a later descriptor-rendering change. Do not reconstruct
-- that truth from today's renderer/history, or rewrite any existing receipt.
-- This private invoker helper is reached only inside the existing exact-attempt
-- accessor and insert validator; it grants no new runtime entry point.
CREATE FUNCTION preference_registry_accepted_snapshot_for_recovery(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_execution_generation integer,
  p_initiating_human_subject_id text,
  p_accepted_at timestamptz
) RETURNS TABLE(canonical_descriptors jsonb, canonical_truncated boolean)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE
  frozen preference_registry_snapshots%ROWTYPE;
BEGIN
  SELECT snapshot.* INTO frozen
  FROM session_turn_attempts accepted_attempt
  JOIN preference_registry_snapshots snapshot
    ON snapshot.account_id = accepted_attempt.account_id
    AND snapshot.workspace_id = accepted_attempt.workspace_id
    AND snapshot.session_id = accepted_attempt.session_id
    AND snapshot.turn_id = accepted_attempt.turn_id
    AND snapshot.attempt_id = accepted_attempt.id
    AND snapshot.execution_generation = accepted_attempt.execution_generation
  WHERE snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.execution_generation < p_execution_generation
    AND snapshot.initiating_human_subject_id = p_initiating_human_subject_id
  ORDER BY snapshot.execution_generation, snapshot.created_at, snapshot.id
  LIMIT 1;

  IF FOUND THEN
    IF frozen.created_at > transaction_timestamp()
      OR jsonb_typeof(frozen.descriptors) <> 'array'
      OR jsonb_array_length(frozen.descriptors) > 64
      OR octet_length(convert_to(frozen.descriptors::text, 'UTF8')) > 16384
      OR frozen.descriptor_hash IS DISTINCT FROM encode(
        sha256(convert_to(frozen.descriptors::text, 'UTF8')), 'hex'
      )
      OR (
        SELECT count(*) <> count(DISTINCT descriptor->>'id')
        FROM jsonb_array_elements(frozen.descriptors) descriptor
      )
    THEN
      RAISE EXCEPTION 'accepted preference snapshot failed canonical integrity checks'
        USING ERRCODE = '23514';
    END IF;
    canonical_descriptors := frozen.descriptors;
    canonical_truncated := frozen.truncated;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT result.canonical_descriptors, result.canonical_truncated
  FROM preference_registry_canonical_snapshot_at(
    p_account_id, p_workspace_id, p_initiating_human_subject_id, p_accepted_at
  ) result;
END;
$body$;

DO $recovery$
DECLARE
  target_schema text := current_schema();
  definition text;
  anchor text;
  replacement text;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.preference_registry_accepted_snapshot_for_recovery(uuid,uuid,uuid,uuid,integer,text,timestamptz) SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.preference_registry_accepted_snapshot_for_recovery(uuid,uuid,uuid,uuid,integer,text,timestamptz) FROM PUBLIC',
    target_schema
  );

  -- Preserve the accessor's tenant/attempt/interruption locks, immutable human
  -- binding, current-attempt replay, bounds and winner checks byte-for-byte.
  SELECT pg_get_functiondef(format(
    '%I.preference_registry_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
    target_schema
  )::regprocedure) INTO definition;
  anchor := $old$FROM preference_registry_canonical_snapshot_at(
        p_account_id,
        p_workspace_id,
        authority_subject_id,
        turn_accepted_at
      ) result;$old$;
  replacement := $new$FROM preference_registry_accepted_snapshot_for_recovery(
        p_account_id,
        p_workspace_id,
        p_session_id,
        p_turn_id,
        p_execution_generation,
        authority_subject_id,
        turn_accepted_at
      ) result;$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'preference recovery accessor anchor mismatch';
  END IF;
  EXECUTE replace(definition, anchor, replacement);

  -- The validator must check the same immutable accepted source, not demand
  -- the current renderer's encoding. Exact current attempt/human checks above
  -- this selection and exact descriptor/hash equality below remain unchanged.
  SELECT pg_get_functiondef(format(
    '%I.preference_registry_validate_snapshot()', target_schema
  )::regprocedure) INTO definition;
  anchor := $old$FROM preference_registry_canonical_snapshot_at(
    NEW.account_id,
    NEW.workspace_id,
    authority_subject_id,
    turn_accepted_at
  ) result;$old$;
  replacement := $new$FROM preference_registry_accepted_snapshot_for_recovery(
    NEW.account_id,
    NEW.workspace_id,
    NEW.session_id,
    NEW.turn_id,
    NEW.execution_generation,
    authority_subject_id,
    turn_accepted_at
  ) result;$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'preference recovery validator anchor mismatch';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END;
$recovery$;