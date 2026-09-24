-- deployment-mode: rolling
-- Only absent learning policy changes. Saved defaults, sparse context overrides,
-- accepted snapshots, legacy conversion and every authority check stay intact.
DO $migration$
DECLARE
  target regprocedure;
  definition text;
  old_defaults text := '{"knowledge":"automatic","instructions":"review_first","skills":"review_first"}';
  new_defaults text := '{"knowledge":"automatic","instructions":"automatic","skills":"automatic"}';
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'knowledge_learning_resolve(uuid,uuid,text,text,timestamp with time zone)'::regprocedure,
    'agent_learning_manage(uuid,uuid,jsonb,jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    IF (length(definition) - length(replace(definition, old_defaults, ''))) / length(old_defaults) <> 1 THEN
      RAISE EXCEPTION 'autonomous learning defaults source contract changed: %', target;
    END IF;
    EXECUTE replace(definition, old_defaults, new_defaults);
  END LOOP;
END
$migration$;