-- deployment-mode: rolling
-- Match getScheduledTargetSessionExecution: a non-null [] on a turn is not
-- an override unless tools_provided is true. Preserve explicit empty overrides.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $scheduled_inherited_tools$
DECLARE
  definition text;
  old_expression constant text := 'coalesce(latest_started.tools, target_row.tools)';
  new_expression constant text :=
    '(CASE WHEN latest_started.tools_provided THEN latest_started.tools ELSE target_row.tools END)';
  occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'admit_scheduled_agent_run_execution()'::regprocedure
  ) INTO definition;
  occurrences := (length(definition) - length(replace(definition, old_expression, '')))
    / length(old_expression);
  IF occurrences = 0 AND strpos(definition, new_expression) > 0 THEN RETURN; END IF;
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0416 scheduled inherited tools prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_expression, new_expression);
END
$scheduled_inherited_tools$;