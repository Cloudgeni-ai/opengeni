-- deployment-mode: rolling
-- A failed session can still attach its managed sandbox for an explicitly
-- consented checkpoint restore. Keep its selected variable sets available to
-- that attach; all existing scope, ownership, and revocation checks still run.
DO $migration$
DECLARE
  target regprocedure := 'materialize_scoped_variable_set_for_session(uuid,uuid,uuid,uuid)'::regprocedure;
  definition text := pg_get_functiondef(target);
  before_status text := $before$AND session_value.status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity'
    )$before$;
  after_status text := $after$AND session_value.status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity', 'failed'
    )$after$;
BEGIN
  IF (length(definition) - length(replace(definition, after_status, ''))) / length(after_status) = 1
    AND (length(definition) - length(replace(definition, before_status, ''))) / length(before_status) = 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, before_status, ''))) / length(before_status) <> 1 THEN
    RAISE EXCEPTION 'failed-session variable-set attach source contract changed';
  END IF;
  EXECUTE replace(definition, before_status, after_status);
END
$migration$;
