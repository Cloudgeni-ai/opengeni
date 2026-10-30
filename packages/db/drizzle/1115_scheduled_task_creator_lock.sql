-- deployment-mode: rolling
-- An opt-in creator lock for scheduled tasks. A locked task can be changed,
-- run, resumed or deleted only by the principal that created it, never by an
-- agent attempt; a workspace admin can still pause it. The lock is mutation
-- authority, not execution configuration, so both execution digest routines
-- leave it out and every existing digest stays byte-identical. The previous
-- release never sets the column and reads rows without it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS creator_locked boolean NOT NULL DEFAULT false;

DO $migration$
DECLARE
  routine text;
  definition text;
  anchor text := $a$'execution_digest', 'owner_subject_id', 'visibility'$a$;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'scheduled_task_execution_digest(scheduled_tasks)',
    'set_scheduled_task_execution_digest()'
  ] LOOP
    definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
      '%I.%s', pg_catalog.current_schema(), routine)::regprocedure);
    IF strpos(definition, anchor || $a$, 'creator_locked'$a$) > 0 THEN
      CONTINUE;
    END IF;
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '1115 scheduled task execution digest drift in %', routine
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, anchor || $a$, 'creator_locked'$a$);
  END LOOP;
END
$migration$;
