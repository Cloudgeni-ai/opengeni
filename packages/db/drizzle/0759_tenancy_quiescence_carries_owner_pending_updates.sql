-- deployment-mode: rolling
-- A pending session_system_update is machine input (a finished background
-- command, a child's result, an agent message) that an idle session keeps until
-- its next turn. Nothing consumes it while the session stays idle, so counting
-- every pending update as a quiescence blocker refused visibility changes
-- (and whole-session forks) on idle chats indefinitely.
--
-- The blocker exists for authority, not liveness: a pending update freezes the
-- authority it was accepted with (personal connection delegations, MCP account
-- bindings, personal subscription authority, user-scoped provider subjects)
-- and its causal human, and the turn that later delivers it executes with
-- that frozen authority. After privatization only the owner may supply
-- authority to the session, so an update carrying another person's authority
-- must still block. An update whose frozen authority is the session owner's
-- own, or workspace/organization scoped, carries nothing the private session
-- could not already use, and no longer blocks.
--
-- session_system_update_carries_foreign_authority decides that per update,
-- failing closed on any shape it cannot prove is owner-only. The quiescence
-- clause keeps its blocker name; only its predicate changes. Every other
-- blocker, the singleton-group check, SECURITY DEFINER and the search_path
-- posture stay byte-identical.
CREATE FUNCTION session_system_update_carries_foreign_authority(
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
              'session_wait_timeout')
            THEN p_update.lineage ->> 'causalTurnId'
          WHEN p_update.kind IN ('agent_message', 'agent_steer_instruction')
            THEN p_update.lineage ->> 'callerTurnId'
        END AS turn_id) causal
      WHERE causal.turn_id IS NOT NULL), false)
$function$;

REVOKE ALL ON FUNCTION session_system_update_carries_foreign_authority(
  session_system_updates, text, uuid) FROM PUBLIC;

-- Pin the install's own schema (public on a standalone install), as 0494 does:
-- a dedicated-schema install has no public.session_turns.
DO $carries_foreign_authority_path$
BEGIN
  EXECUTE format('ALTER FUNCTION session_system_update_carries_foreign_authority(session_system_updates, text, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$carries_foreign_authority_path$;

DO $migration$
DECLARE
  definition text;
  old_clause constant text := '  ELSIF EXISTS (SELECT 1 FROM session_system_updates WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = ''pending'')
  THEN blocker := ''pending_system_update'';';
BEGIN
  definition := pg_get_functiondef('assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)'::regprocedure);
  -- Exactly-once guard in the 0658 style.
  IF (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1
    OR strpos(definition, 'session_system_update_carries_foreign_authority') > 0
  THEN
    RAISE EXCEPTION 'pending update quiescence rewrite did not match exactly once';
  END IF;
  definition := replace(definition, old_clause, '  ELSIF EXISTS (SELECT 1 FROM session_system_updates pending_update
      JOIN sessions update_owner ON update_owner.id = pending_update.session_id
      WHERE pending_update.workspace_id = p_workspace_id
        AND pending_update.session_id = p_session_id AND pending_update.state = ''pending''
        AND session_system_update_carries_foreign_authority(pending_update,
          update_owner.owner_subject_id, update_owner.owner_organization_membership_id))
  THEN blocker := ''pending_system_update'';');
  EXECUTE definition;
END
$migration$;
