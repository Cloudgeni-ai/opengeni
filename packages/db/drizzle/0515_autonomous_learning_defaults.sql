-- deployment-mode: rolling
-- Only absent learning policy changes. Saved defaults, sparse context overrides,
-- accepted snapshots, legacy conversion and every authority check stay intact.
-- Capture the rollout boundary once in the function definition, so work already
-- accepted but not yet snapshotted retains its original absent-policy defaults.
DO $migration$
DECLARE
  target regprocedure;
  definition text;
  old_expression text;
  new_expression text;
  cutover timestamptz := clock_timestamp();
  old_defaults text := '{"knowledge":"automatic","instructions":"review_first","skills":"review_first"}';
  new_defaults text := '{"knowledge":"automatic","instructions":"automatic","skills":"automatic"}';
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'knowledge_learning_resolve(uuid,uuid,text,text,timestamp with time zone)'::regprocedure,
    'agent_learning_manage(uuid,uuid,jsonb,jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    old_expression := format('%L::jsonb', old_defaults);
    new_expression := format('%L::jsonb', new_defaults);
    IF target = 'knowledge_learning_resolve(uuid,uuid,text,text,timestamp with time zone)'::regprocedure THEN
      old_expression := 'base:=coalesce(base,' || old_expression || ');';
      new_expression := format(
        'base:=coalesce(base,CASE WHEN p_at < %L::timestamptz THEN %L::jsonb ELSE %L::jsonb END);',
        cutover, old_defaults, new_defaults);
    END IF;
    IF (length(definition) - length(replace(definition, old_expression, ''))) / length(old_expression) <> 1 THEN
      RAISE EXCEPTION 'autonomous learning defaults source contract changed: %', target;
    END IF;
    EXECUTE replace(definition, old_expression, new_expression);
  END LOOP;
END
$migration$;
