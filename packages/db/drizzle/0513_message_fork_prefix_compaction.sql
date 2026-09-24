-- deployment-mode: rolling
-- A message fork copies only the retained prefix through its selected boundary.
-- Later compaction/inactive rows must not invalidate an intact earlier prefix;
-- keep the existing fail-closed checks for every row that will actually be copied.
DO $migration$
DECLARE
  target regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  definition text;
  anchor constant text := E'AND history.session_id = p_source_session_id\n      AND (NOT history.active';
BEGIN
  definition := pg_get_functiondef(target);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'message fork prefix validation rewrite did not match exactly once';
  END IF;
  EXECUTE replace(definition, anchor,
    E'AND history.session_id = p_source_session_id\n      AND history.position <= boundary_position\n      AND (NOT history.active');
END
$migration$;