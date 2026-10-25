-- deployment-mode: rolling
-- When a person finishes setup from a capability card the agent posted
-- (connect, add credentials, enable), the chat now wakes the agent once with a
-- capability_setup_completed internal update so it continues the request that
-- needed the capability, instead of waiting for the person to say "done".
--
-- 1. The kind joins system_updates_kind_check, re-added NOT VALID so the swap
--    does not scan the table under its exclusive lock; 0973 validates it.
-- 2. It is turn-starting machine input, so idle command containment counts a
--    pending one as use, like the other immediate kinds (an anchored edit of
--    the 0961 definition that adds the one kind).
-- 3. It copies its causal receiving turn exactly like a goal continuation, so
--    session_system_update_carries_foreign_authority reads its causalTurnId
--    (0759 definition with the one kind added).
--
-- Rolling: the previous release never writes the kind; an older worker that
-- claims one cancels it as an unrecognized kind, which only loses that single
-- continuation during rollout.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_system_updates"
  DROP CONSTRAINT "system_updates_kind_check",
  ADD CONSTRAINT "system_updates_kind_check" CHECK (
    "kind" IN (
      'scheduled_occurrence',
      'goal_continuation',
      'agent_message',
      'agent_steer_instruction',
      'session_wait_timeout',
      'background_command_result',
      'child_terminal_result',
      'media_generation_result',
      'child_requires_action',
      'child_requires_action_resolved',
      'child_paused',
      'child_waiting_capacity',
      'child_progress',
      'secret_use_approval_decided',
      'capability_setup_completed'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION session_system_update_carries_foreign_authority(
  p_update session_system_updates,
  p_owner_subject_id text,
  p_owner_membership_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT
    -- Personal connection delegations must all be the owner's.
    CASE WHEN jsonb_typeof(p_update.personal_connection_delegations) = 'array'
      THEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_update.personal_connection_delegations) delegation
        WHERE delegation ->> 'ownerSubjectId' IS DISTINCT FROM p_owner_subject_id)
      ELSE true END
    -- Account bindings are workspace-scoped or the owner's own.
    OR CASE WHEN p_update.mcp_account_bindings IS NULL THEN false
      WHEN jsonb_typeof(p_update.mcp_account_bindings) = 'array' THEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_update.mcp_account_bindings) binding
        WHERE NOT (
          (binding ->> 'subjectScope' = 'workspace' AND binding ->> 'ownerSubjectId' IS NULL)
          OR binding ->> 'ownerSubjectId' = p_owner_subject_id))
      ELSE true END
    -- Personal subscription authority belongs to the owner's membership.
    OR CASE WHEN p_update.subscription_authority IS NULL THEN false
      WHEN jsonb_typeof(p_update.subscription_authority -> 'personal') = 'array' THEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_update.subscription_authority -> 'personal') personal
        WHERE personal ->> 'ownerMembershipId' IS DISTINCT FROM p_owner_membership_id::text)
      ELSE true END
    -- Causal authority subjects recorded in the lineage are the owner.
    OR EXISTS (
      SELECT 1 FROM unnest(ARRAY[
        'connectionAuthoritySubjectId', 'xaiAuthoritySubjectId', 'claudeAuthoritySubjectId'
      ]) subject_key
      WHERE p_update.lineage ->> subject_key IS NOT NULL
        AND p_update.lineage ->> subject_key IS DISTINCT FROM p_owner_subject_id)
    -- A user-scoped provider snapshot needs its owner-matching causal subject.
    OR (p_update.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
      AND p_update.lineage ->> 'xaiAuthoritySubjectId' IS NULL)
    OR (p_update.claude_provider_account_authority_snapshot ->> 'scope' = 'user'
      AND p_update.lineage ->> 'claudeAuthoritySubjectId' IS NULL)
    -- The causal human turn the runtime attributes the update to (the same
    -- lineage keys the delivering turn reads) was the owner's or no human's.
    -- A recorded causal turn that cannot be read counts as foreign.
    OR COALESCE((
      SELECT CASE WHEN causal.turn_id !~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
          THEN true
        ELSE NOT EXISTS (
          SELECT 1 FROM session_turns causal_turn
          WHERE causal_turn.id = causal.turn_id::uuid
            AND COALESCE(causal_turn.initiating_human_subject_id,
              CASE WHEN causal_turn.initiator_kind = 'subject'
                THEN causal_turn.initiator_subject_id END,
              p_owner_subject_id) = p_owner_subject_id)
        END
      FROM (SELECT CASE
          WHEN p_update.kind IN ('child_terminal_result', 'child_requires_action',
              'child_requires_action_resolved', 'child_paused', 'child_waiting_capacity',
              'child_progress')
            THEN p_update.lineage ->> 'parentTurnId'
          WHEN p_update.kind IN ('goal_continuation', 'background_command_result',
              'session_wait_timeout', 'capability_setup_completed')
            THEN p_update.lineage ->> 'causalTurnId'
          WHEN p_update.kind IN ('agent_message', 'agent_steer_instruction')
            THEN p_update.lineage ->> 'callerTurnId'
        END AS turn_id) causal
      WHERE causal.turn_id IS NOT NULL), false)
$function$;

REVOKE ALL ON FUNCTION session_system_update_carries_foreign_authority(
  session_system_updates, text, uuid) FROM PUBLIC;

-- CREATE OR REPLACE drops the function's SET clause; pin the install's own
-- schema again exactly as 0759 does.
DO $carries_foreign_authority_path$
BEGIN
  EXECUTE format('ALTER FUNCTION session_system_update_carries_foreign_authority(session_system_updates, text, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$carries_foreign_authority_path$;

-- The continuation starts a turn like any other immediate input, so the idle
-- command-containment screen counts it (0961 definition with the one kind
-- added; the worker's set pins this).
DO $containment$
DECLARE
  definition text;
  anchor text := $old$'media_generation_result', 'secret_use_approval_decided')$old$;
  replacement text := $new$'media_generation_result', 'secret_use_approval_decided', 'capability_setup_completed')$new$;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.list_command_containment_candidates(integer, bigint)'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'command containment update-kind anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $containment$;

RESET statement_timeout;
RESET lock_timeout;
