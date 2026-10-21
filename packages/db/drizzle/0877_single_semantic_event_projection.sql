-- deployment-mode: rolling
-- The cursor trigger already writes the semantic session projection. Stamp its
-- activity in that same write, so current appenders need no second row update.
-- Old appenders remain compatible during rolling replacement. Raw-only batches
-- still touch only the cursor; actual lifecycle mutations keep their own writes.
DO $single_semantic_projection$
DECLARE
  definition text;
  anchor text := E'SET last_sequence = inserted_group.last_sequence\n      WHERE session.account_id';
BEGIN
  definition := pg_get_functiondef('advance_session_event_cursors_for_inserted_events()'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0877 semantic event projection prerequisites differ' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor,
    E'SET last_sequence = inserted_group.last_sequence,\n          updated_at = greatest(session.updated_at, statement_timestamp())\n      WHERE session.account_id');
  -- Preserve the attention predicate, range validation, tenancy capability,
  -- owner, grants and pinned search_path of the installed function.
  EXECUTE definition;
END
$single_semantic_projection$;
