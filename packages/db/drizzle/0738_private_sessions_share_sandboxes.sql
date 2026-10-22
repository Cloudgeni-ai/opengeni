-- deployment-mode: rolling
-- Who can read a session and who can use a sandbox are separate properties.
-- A session's conversation, events, command records, terminals and stream
-- access are already scoped to the session's own audience by the
-- session_visibility_isolation policies; files on a sandbox are as shared as
-- the sandbox. Requiring a singleton sandbox group before a session could be
-- made "Only me" (0303) therefore protected nothing those policies do not, and
-- it refused privacy for nearly every real session: parents and children, and
-- sessions on a Connected Machine, share a group.
--
-- 1. transition_session_visibility no longer requires a singleton group when
--    the target is user_private. Every other quiescence blocker stays.
-- 2. fork_session_content no longer requires a singleton source group. A fork
--    already creates a fresh singleton destination and copies no box state.
-- 3. The active_sandbox_access blocker counts only viewer and interaction
--    holders attributed to this session (or unattributed ones). A sibling's
--    open terminal is access to the shared box, not to this conversation.
-- 4. A top-level private create may join an existing sandbox group in its own
--    workspace instead of requiring a fresh singleton group. The API still
--    resolves the group through the creator's own visibility.
--
-- Variable Set changes keep their own singleton-group refusal: a box's
-- Variable Sets and environment are fixed and homogeneous across its group.
DO $migration$
DECLARE
  signature regprocedure;
  definition text;
  old_call text := 'PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, true);';
BEGIN
  signature := 'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure;
  definition := pg_get_functiondef(signature);
  IF (length(definition) - length(replace(definition, old_call, ''))) / length(old_call) <> 1 THEN
    RAISE EXCEPTION 'visibility transition singleton-group rewrite did not match exactly once';
  END IF;
  definition := replace(
    definition,
    old_call,
    'PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, false);'
  );
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  old_call text := 'PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, true
  );';
BEGIN
  definition := pg_get_functiondef(
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure
  );
  IF (length(definition) - length(replace(definition, old_call, ''))) / length(old_call) <> 1 THEN
    RAISE EXCEPTION 'fork singleton-group rewrite did not match exactly once';
  END IF;
  definition := replace(
    definition,
    old_call,
    'PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, false
  );'
  );
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  old_clause text := '        AND lease.sandbox_group_id = session_group_id
        AND holder.kind IN (''viewer'', ''interaction'')';
BEGIN
  definition := pg_get_functiondef('assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)'::regprocedure);
  IF (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1
    OR strpos(definition, 'holder.subject_id') > 0
  THEN
    RAISE EXCEPTION 'sandbox access quiescence rewrite did not match exactly once';
  END IF;
  -- Reuse the current definition so every other blocker, SECURITY DEFINER and
  -- the search_path posture stay byte-identical.
  definition := replace(
    definition,
    old_clause,
    old_clause || '
        AND (holder.subject_id IS NULL OR holder.subject_id = p_session_id)'
  );
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  old_clause text := '          AND NEW.sandbox_group_id = NEW.id
';
BEGIN
  definition := pg_get_functiondef('guard_session_authority_write()'::regprocedure);
  IF (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'private create sandbox group rewrite did not match exactly once';
  END IF;
  definition := replace(
    definition,
    old_clause,
    '          AND (
            NEW.sandbox_group_id = NEW.id
            OR EXISTS (
              SELECT 1
              FROM sessions group_member
              WHERE group_member.account_id = NEW.account_id
                AND group_member.workspace_id = NEW.workspace_id
                AND group_member.sandbox_group_id = NEW.sandbox_group_id
                AND group_member.id <> NEW.id
            )
          )
'
  );
  EXECUTE definition;
END
$migration$;
