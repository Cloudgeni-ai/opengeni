-- deployment-mode: rolling
-- Scheduled-run admission compares the accepted target snapshot's latencyMode
-- with the target chat's. Before the chat's first turn it reads the session
-- metadata latencyMode, which it accepted only as standard, priority or fast,
-- so a run into an Ultrafast chat would read 'standard' and be refused. The
-- application maps metadata with every latency mode (latencyModeForMetadata);
-- the trigger now uses the same list. Other values still read as standard, so
-- the previous release is unaffected. Only the routine is patched; no rows are
-- read or written.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  anchor constant text := $a$IN ('standard','priority','fast')$a$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.admit_scheduled_agent_run_execution()',
    pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, $a$IN ('standard','priority','fast','ultrafast')$a$) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1306 scheduled admission latency mode drift'
      USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, $a$IN ('standard','priority','fast','ultrafast')$a$);
  EXECUTE definition;
END
$migration$;
