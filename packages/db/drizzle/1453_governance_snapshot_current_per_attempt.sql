-- deployment-mode: rolling
-- Workspace governance follows the attempt that runs, not the moment a turn
-- was accepted. A turn can wait hours before its first model request (for
-- example for subscription capacity or recovery), and each recovery
-- generation starts a new attempt. Until now every attempt resolved the
-- instruction policies and the organization profile active at turn
-- acceptance, so a turn accepted before a policy change acted on the old
-- rules whenever it ran. Now:
--   1. an attempt's instruction-policy snapshot holds the policies active
--      when the snapshot is taken (its created_at), in the get-or-create
--      routine and in the insert validation trigger alike. A snapshot taken
--      in the transaction that accepted the turn, which can stamp the turn
--      later than the transaction began, still resolves at acceptance, as
--      before: the resolution time is the later of the two;
--   2. the organization-profile snapshot does the same;
--   3. the per-turn Company Brain selection receipt keeps the hashes the
--      turn's first attempt recorded, and a later attempt whose governance
--      snapshots differ no longer conflicts with it. The preference check is
--      unchanged: preference snapshots still resolve at acceptance.
-- The validation triggers also refuse a snapshot time after the inserting
-- transaction began, so a snapshot cannot claim a later state than it saw.
-- Rolling: the previous release calls the same routines with the same
-- signatures and results. Its attempts get the policies current at their
-- start, and its turns keep the model-visible governance item they froze; it
-- never relied on two attempts of one turn sharing snapshot content (each
-- attempt already had its own snapshot row).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $governance_snapshot_current_per_attempt$
DECLARE definition text; anchor text;
BEGIN
  -- 1a. The instruction-policy snapshot routine resolves at snapshot time.
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
    current_schema())::regprocedure);
  anchor := $a$        AND event.created_at <= turn_accepted_at
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_get_or_create_snapshot lock anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$        AND event.created_at <= GREATEST(snapshot_time, turn_accepted_at)
$r$);
  anchor := $a$        canonical_policy_role,
        turn_accepted_at
      );$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_get_or_create_snapshot entries anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$        canonical_policy_role,
        GREATEST(snapshot_time, turn_accepted_at)
      );$r$);
  EXECUTE definition;

  -- 1b. Its validation trigger checks the policies at the snapshot's time.
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_validate_snapshot()', current_schema())::regprocedure);
  anchor := $a$  canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
    NEW.account_id,
    NEW.workspace_id,
    canonical_policy_role,
    turn_accepted_at
  );$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'instruction-policy snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
    NEW.account_id,
    NEW.workspace_id,
    canonical_policy_role,
    GREATEST(NEW.created_at, turn_accepted_at)
  );$r$);
  EXECUTE definition;

  -- 2a. The organization-profile snapshot routine resolves at snapshot time.
  definition := pg_get_functiondef(format(
    '%I.company_profile_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
    current_schema())::regprocedure);
  anchor := $a$company_profile_canonical_snapshot_at(p_account_id, accepted_at);$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_profile_get_or_create_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor,
    $r$company_profile_canonical_snapshot_at(p_account_id, GREATEST(snapshot_time, accepted_at));$r$);
  EXECUTE definition;

  -- 2b. Its validation trigger checks the profile at the snapshot's time.
  definition := pg_get_functiondef(format(
    '%I.company_profile_validate_snapshot()', current_schema())::regprocedure);
  anchor := $a$  canonical_profile := company_profile_canonical_snapshot_at(NEW.account_id, accepted_at);$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_profile_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'company-profile snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  canonical_profile := company_profile_canonical_snapshot_at(
    NEW.account_id, GREATEST(NEW.created_at, accepted_at)
  );$r$);
  EXECUTE definition;

  -- 3. A later attempt's governance may differ from the receipt's first one.
  definition := pg_get_functiondef(format(
    '%I.company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer)',
    current_schema())::regprocedure);
  anchor := $a$      OR receipt_row.instruction_policy_entry_hash IS DISTINCT FROM policy_hash
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_brain_context_get_or_create_selection policy anchor drifted';
  END IF;
  definition := replace(definition, anchor, '');
  anchor := $a$      OR receipt_row.company_profile_snapshot_hash IS DISTINCT FROM profile_hash
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_brain_context_get_or_create_selection profile anchor drifted';
  END IF;
  definition := replace(definition, anchor, '');
  EXECUTE definition;
END
$governance_snapshot_current_per_attempt$;
