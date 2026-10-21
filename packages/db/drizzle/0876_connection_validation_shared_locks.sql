-- deployment-mode: rolling
-- Independent connection uses validate the same lifecycle rows without changing
-- them. Share those read fences; writers still wait until validation commits.
DO $connection_validation_locks$
DECLARE
  definition text;
  prefix_anchor text := '  -- Canonical lifecycle lock prefix: control -> workspace -> session -> turn -> attempt.';
BEGIN
  definition := pg_get_functiondef(
    'resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)'::regprocedure
  );
  IF (length(definition) - length(replace(definition, 'FOR NO KEY UPDATE;', ''))) / length('FOR NO KEY UPDATE;') <> 1
    OR (length(definition) - length(replace(definition, 'FOR UPDATE;', ''))) / length('FOR UPDATE;') <> 2
    OR (length(definition) - length(replace(definition, prefix_anchor, ''))) / length(prefix_anchor) <> 1
  THEN
    RAISE EXCEPTION '0876 connection validation prerequisites differ' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, 'FOR NO KEY UPDATE;', 'FOR SHARE;');
  definition := replace(definition, 'FOR UPDATE;', 'FOR SHARE;');
  -- Reuse the control plane's existing fair queue. New validators must not
  -- bypass a waiting pause/cancel by joining an already share-locked row.
  definition := replace(definition, prefix_anchor,
    prefix_anchor || E'\n  PERFORM pg_advisory_xact_lock_shared(hashtextextended(''workspace-control:'' || p_workspace_id::text, 0));');
  -- pg_get_functiondef preserves the current body, SECURITY DEFINER and pinned
  -- search_path; CREATE OR REPLACE retains ownership and execution grants.
  EXECUTE definition;
END
$connection_validation_locks$;
