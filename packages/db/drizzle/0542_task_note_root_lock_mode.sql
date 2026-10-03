-- deployment-mode: rolling
-- Task-tree authority must serialize root/sibling mutations, but does not
-- change session keys. FOR UPDATE also blocks the implicit root-session FK
-- check performed when activity finalization updates a child a second time.
-- A selector holding the root and waiting for child B can then deadlock with
-- child A's finalizer holding the workspace activity counter and child B's
-- finalizer waiting for that counter. NO KEY UPDATE preserves writer exclusion
-- and the active-note cap while permitting those FK KEY SHARE checks.
-- Rewrite only this statement; pg_get_functiondef + CREATE OR REPLACE preserve
-- owner, ACL, SECURITY DEFINER, search_path, and every authority predicate.
DO $migration$
DECLARE
  target regprocedure := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema()) ||
    '.resolve_task_note_attempt_authority(uuid,uuid,uuid,uuid,uuid,integer)'
  );
  definition text := pg_catalog.pg_get_functiondef(target);
  before_lock text := $before$  -- Root authority serializes sibling mutations, including the active-record
  -- cap check. UUID order preserves the canonical multi-session lock order.
  FOR UPDATE;$before$;
  after_lock text := $after$  -- Root authority serializes sibling mutations, including the active-record
  -- cap check. UUID order preserves the canonical multi-session lock order.
  -- Session keys are unchanged: permit concurrent root-session FK checks.
  FOR NO KEY UPDATE;$after$;
  before_count integer;
  after_count integer;
BEGIN
  IF definition IS NULL THEN
    RAISE EXCEPTION 'task-note authority function is missing' USING ERRCODE = '55000';
  END IF;
  before_count := (length(definition) - length(replace(definition, before_lock, '')))
    / length(before_lock);
  after_count := (length(definition) - length(replace(definition, after_lock, '')))
    / length(after_lock);
  IF before_count = 0 AND after_count = 1 THEN
    RETURN;
  END IF;
  IF before_count <> 1 OR after_count <> 0 THEN
    RAISE EXCEPTION 'task-note authority lock source contract changed' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, before_lock, after_lock);
END
$migration$;