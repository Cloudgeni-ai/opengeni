-- deployment-mode: rolling
-- Widen admission only; preserve immutable content and all path/authority checks.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
DO $limits$
DECLARE definition text; pair text[];
BEGIN
  definition := pg_get_functiondef('skill_files_valid(jsonb)'::regprocedure);
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['BETWEEN 1 AND 128','BETWEEN 1 AND 1024'],
    ['bytes > 262144','bytes > 2097152'],
    ['total <= 1048576','total <= 8388608']
  ] LOOP
    IF (length(definition)-length(replace(definition,pair[1],'')))/length(pair[1])<>1 THEN
      RAISE EXCEPTION 'Skill limit validator anchor mismatch: %',pair[1];
    END IF;
    definition:=replace(definition,pair[1],pair[2]);
  END LOOP;
  EXECUTE definition;
END $limits$;
ALTER TABLE preference_registry_revisions DROP CONSTRAINT preference_registry_revisions_text_chk;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_revisions_text_chk CHECK (
  length(btrim(title)) BETWEEN 1 AND 120
  AND length(btrim(description)) BETWEEN 1 AND 1024
  AND length(btrim(content)) > 0 AND length(content) <= 2097152
);