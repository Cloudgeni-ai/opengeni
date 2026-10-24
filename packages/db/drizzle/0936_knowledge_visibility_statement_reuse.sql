-- deployment-mode: rolling
-- Keep every caller and visibility check, but let PL/pgSQL retain the prepared
-- recursive statement. Only statement/plan preparation is reused, never rows or
-- authority. VOLATILE nested ACL calls and per-member checks remain unchanged.
DO $reuse$
DECLARE
  definition text;
  original_body text;
  body text;
  language_name text;
BEGIN
  SELECT pg_get_functiondef(p.oid),p.prosrc,l.lanname
    INTO definition,original_body,language_name
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='knowledge_revisions_visible(uuid,uuid[],uuid[],boolean)'::regprocedure;
  IF language_name IS DISTINCT FROM 'sql'
    OR strpos(original_body,'SELECT DISTINCT entry_id,revision_id'||chr(10)||'    FROM unnest')=0
    OR strpos(original_body,'SELECT entry_id,revision_id,entry_id,revision_id FROM roots')=0
    OR strpos(original_body,'SELECT DISTINCT entry_id,revision_id FROM dependencies')=0 THEN
    RAISE EXCEPTION 'Knowledge visibility statement source contract changed';
  END IF;
  -- RETURNS TABLE names become PL/pgSQL output variables. Qualify the three
  -- otherwise ambiguous column references without changing their SQL meaning.
  body:=replace(original_body,'SELECT DISTINCT entry_id,revision_id'||chr(10)||'    FROM unnest',
    'SELECT DISTINCT x.entry_id,x.revision_id'||chr(10)||'    FROM unnest');
  body:=replace(body,'SELECT entry_id,revision_id,entry_id,revision_id FROM roots',
    'SELECT r.entry_id,r.revision_id,r.entry_id,r.revision_id FROM roots r');
  body:=replace(body,'SELECT DISTINCT entry_id,revision_id FROM dependencies',
    'SELECT DISTINCT d.entry_id,d.revision_id FROM dependencies d');
  definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
  definition:=replace(definition,original_body,
    E'\nBEGIN\nRETURN QUERY\n'||rtrim(body,E' \t\r\n;')||E';\nEND;\n');
  -- pg_get_functiondef preserves volatility and hardened search_path;
  -- CREATE OR REPLACE preserves ownership and ACL. Use a reusable generic plan
  -- for this recursive keyed statement, including after small-array warmup.
  -- Parameter-specific plans can otherwise make a later large-array read slower
  -- than the original SQL helper. The function setting restores on return.
  EXECUTE definition;
  EXECUTE format('ALTER FUNCTION %s SET plan_cache_mode=force_generic_plan',
    'knowledge_revisions_visible(uuid,uuid[],uuid[],boolean)'::regprocedure);
END
$reuse$;
