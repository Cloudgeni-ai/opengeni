-- deployment-mode: rolling
-- A turn's workspace governance is resolved when the turn starts running,
-- not when it was accepted. A turn can wait hours between acceptance and its
-- first model request: in the session queue, or for subscription capacity
-- (an attempt that parks the turn as waiting_capacity sends no model
-- request). Until now every attempt resolved the instruction policies and the
-- organization profile active at acceptance, so such a turn acted on rules an
-- owner had since changed.
--
-- Now an attempt's instruction-policy and organization-profile snapshots
-- resolve as of:
--   1. the earliest snapshot an earlier attempt of the same turn took, unless
--      that attempt stopped to wait for capacity. Recovery and every later
--      attempt of a turn that already ran keep exactly what its model
--      requests saw; a change during the turn reaches the next turn;
--   2. otherwise the snapshot's own time, or acceptance if that is later (a
--      snapshot taken in the transaction that accepts the turn can stamp the
--      turn after the transaction began).
-- The get-or-create routines and the insert validation triggers resolve the
-- same way. The validation triggers also refuse a snapshot time after the
-- inserting transaction began. Everything else is unchanged: same
-- signatures, owners, grants and results, and the per-turn Company Brain
-- selection receipt still requires every attempt of a turn to hold the same
-- governance.
--
-- Rolling: the previous release calls the same routines with the same
-- signatures and results. A turn it started keeps its governance across
-- attempts under the rule above, because its first attempt's snapshot is the
-- anchor; only a turn whose earlier attempts all waited for capacity
-- resolves later than before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. The instruction-policy snapshot routine.
DO $policy_snapshot_routine$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
    current_schema())::regprocedure);
  anchor := $a$
      IF NOT FOUND THEN
        RAISE EXCEPTION 'instruction-policy snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_get_or_create_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$
      -- Resolve governance as of the turn's start (migration 1488).
      turn_accepted_at := coalesce(
        (
          SELECT min(earlier.created_at)
          FROM session_turn_attempts earlier_attempt
          JOIN workspace_instruction_policy_snapshots earlier
            ON earlier.account_id = earlier_attempt.account_id
            AND earlier.workspace_id = earlier_attempt.workspace_id
            AND earlier.attempt_id = earlier_attempt.id
          WHERE earlier_attempt.account_id = p_account_id
            AND earlier_attempt.workspace_id = p_workspace_id
            AND earlier_attempt.session_id = p_session_id
            AND earlier_attempt.turn_id = p_turn_id
            AND earlier_attempt.id <> p_attempt_id
            AND earlier_attempt.outcome IS DISTINCT FROM 'waiting_capacity'
        ),
        GREATEST(snapshot_time, turn_accepted_at)
      );$r$);
  EXECUTE definition;
END
$policy_snapshot_routine$;

-- 2. Its insert validation trigger.
DO $policy_snapshot_trigger$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_validate_snapshot()', current_schema())::regprocedure);
  anchor := $a$
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instruction-policy snapshot requires an exact active attempt'
      USING ERRCODE = '23514';
  END IF;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$
  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'instruction-policy snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  -- Resolve governance as of the turn's start (migration 1488).
  turn_accepted_at := coalesce(
    (
      SELECT min(earlier.created_at)
      FROM session_turn_attempts earlier_attempt
      JOIN workspace_instruction_policy_snapshots earlier
        ON earlier.account_id = earlier_attempt.account_id
        AND earlier.workspace_id = earlier_attempt.workspace_id
        AND earlier.attempt_id = earlier_attempt.id
      WHERE earlier_attempt.account_id = NEW.account_id
        AND earlier_attempt.workspace_id = NEW.workspace_id
        AND earlier_attempt.session_id = NEW.session_id
        AND earlier_attempt.turn_id = NEW.turn_id
        AND earlier_attempt.id <> NEW.attempt_id
        AND earlier_attempt.outcome IS DISTINCT FROM 'waiting_capacity'
    ),
    GREATEST(NEW.created_at, turn_accepted_at)
  );$r$);
  EXECUTE definition;
END
$policy_snapshot_trigger$;

-- 3. The organization-profile snapshot routine.
DO $profile_snapshot_routine$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.company_profile_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
    current_schema())::regprocedure);
  anchor := $a$
      IF NOT FOUND THEN
        RAISE EXCEPTION 'company-profile snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_profile_get_or_create_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$
      -- Resolve governance as of the turn's start (migration 1488).
      accepted_at := coalesce(
        (
          SELECT min(earlier.created_at)
          FROM session_turn_attempts earlier_attempt
          JOIN company_profile_snapshots earlier
            ON earlier.account_id = earlier_attempt.account_id
            AND earlier.workspace_id = earlier_attempt.workspace_id
            AND earlier.attempt_id = earlier_attempt.id
          WHERE earlier_attempt.account_id = p_account_id
            AND earlier_attempt.workspace_id = p_workspace_id
            AND earlier_attempt.session_id = p_session_id
            AND earlier_attempt.turn_id = p_turn_id
            AND earlier_attempt.id <> p_attempt_id
            AND earlier_attempt.outcome IS DISTINCT FROM 'waiting_capacity'
        ),
        GREATEST(snapshot_time, accepted_at)
      );$r$);
  EXECUTE definition;
END
$profile_snapshot_routine$;

-- 4. Its insert validation trigger.
DO $profile_snapshot_trigger$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.company_profile_validate_snapshot()', current_schema())::regprocedure);
  anchor := $a$
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile snapshot requires an exact active attempt'
      USING ERRCODE = '23514';
  END IF;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_profile_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$
  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'company-profile snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  -- Resolve governance as of the turn's start (migration 1488).
  accepted_at := coalesce(
    (
      SELECT min(earlier.created_at)
      FROM session_turn_attempts earlier_attempt
      JOIN company_profile_snapshots earlier
        ON earlier.account_id = earlier_attempt.account_id
        AND earlier.workspace_id = earlier_attempt.workspace_id
        AND earlier.attempt_id = earlier_attempt.id
      WHERE earlier_attempt.account_id = NEW.account_id
        AND earlier_attempt.workspace_id = NEW.workspace_id
        AND earlier_attempt.session_id = NEW.session_id
        AND earlier_attempt.turn_id = NEW.turn_id
        AND earlier_attempt.id <> NEW.attempt_id
        AND earlier_attempt.outcome IS DISTINCT FROM 'waiting_capacity'
    ),
    GREATEST(NEW.created_at, accepted_at)
  );$r$);
  EXECUTE definition;
END
$profile_snapshot_trigger$;
