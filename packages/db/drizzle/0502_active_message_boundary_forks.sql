-- deployment-mode: rolling
-- A message fork copies a validated prefix, not live execution or sandbox state.
-- The existing exclusive workspace tenancy fence, workspace FOR UPDATE and
-- source session FOR UPDATE serialize history append, replacement/compaction,
-- attachment grants and authority changes through validation and spool copying.
-- Writers retain their ordinary shared tenancy / canonical row-lock protocol.
-- Do not relax quiescence for the whole-session overload or visibility changes.
DO $migration$
DECLARE
  definition text;
  updated text;
  target regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  anchor constant text := $anchor$  PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, true
  );$anchor$;
BEGIN
  definition := pg_get_functiondef(target);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'active message fork quiescence rewrite did not match exactly once';
  END IF;
  updated := replace(definition, anchor,
    '  -- Active source work is allowed: the held locks stabilize the selected prefix.');
  updated := replace(updated,
    '-- Authority, source locks, keyed replay, and quiescence have already been',
    '-- Authority, source locks, and keyed replay have already been');
  -- Reuse the current definition, preserving ordered JSON, fractional controls,
  -- attachment boundaries, authorization, receipt replay and routine posture.
  EXECUTE updated;
END
$migration$;