-- deployment-mode: rolling
-- A fork is a session of its own, so it needs its own durable workflow
-- identity, exactly as session start gives every created session
-- ('session-' || id). Forks were inserted with none, so commands that address
-- the session workflow directly (waiting for input, deadline wakes) failed in
-- every fork with "has no Temporal workflow identity".
--
-- Rolling: only the two fork routine bodies change (signatures, results and
-- receipts are unchanged), and the backfill writes the identity readers
-- already derive for a missing value.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $fork_workflow_identity$
DECLARE
  old_line constant text := E'  destination_row.temporal_workflow_id := NULL;\n';
  new_line constant text :=
    E'  destination_row.temporal_workflow_id := ''session-'' || destination_session_id::text;\n';
  target regprocedure;
  definition text;
  old_count integer;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    old_count := (length(definition) - length(replace(definition, old_line, ''))) / length(old_line);
    IF old_count = 1 THEN
      EXECUTE replace(definition, old_line, new_line);
    ELSIF old_count <> 0 OR strpos(definition, new_line) = 0 THEN
      RAISE EXCEPTION 'session fork workflow identity of % changed before 0856', target;
    END IF;
    IF strpos(pg_get_functiondef(target), new_line) = 0 THEN
      RAISE EXCEPTION 'session fork workflow identity was not installed for %', target;
    END IF;
  END LOOP;
END
$fork_workflow_identity$;

-- Give existing forks the identity they should have had. Migrations run as
-- the NOSUPERUSER/NOBYPASSRLS table owner: as in 0853, temporarily let that
-- owner see the rows and restore the exact fence trigger before commit. An
-- imported archive stays inert and is never a fork.
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" DISABLE TRIGGER session_tenancy_workspace_fence;

UPDATE "sessions"
SET "temporal_workflow_id" = 'session-' || "id"::text
WHERE "forked_from_session_id" IS NOT NULL
  AND "temporal_workflow_id" IS NULL
  AND "imported_archive_import_id" IS NULL;

ALTER TABLE "sessions" ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
