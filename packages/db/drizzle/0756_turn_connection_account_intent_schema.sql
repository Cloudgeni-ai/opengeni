-- deployment-mode: rolling
-- Qualify 0755's context-turn lookups with the database's own schema.
--
-- 0755 patched two fence functions with a lookup of the context turn written
-- as `public.session_turns`. An install whose tables live in a dedicated
-- schema has no such relation, so every continuation turn there failed to
-- insert ("relation public.session_turns does not exist"); an install that
-- also had an unrelated `public.session_turns` would have read the wrong
-- table. Both lookups now name the schema this migration runs in, like every
-- other fence. On an install in `public` the functions are unchanged.
--
-- Rolling: the functions keep their exact behaviour; only the relation they
-- read is named by the install's own schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $context_turn_schema$
DECLARE
  anchor constant text := 'FROM public.session_turns context_turn';
  replacement constant text := pg_catalog.format('FROM %I.session_turns context_turn', pg_catalog.current_schema());
  signature text;
  target regprocedure;
  definition text;
  count_of integer;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'opengeni_private.fence_mcp_account_bindings()',
    'opengeni_private.capture_accepted_turn_connection_authorities()'
  ] LOOP
    target := pg_catalog.to_regprocedure(signature);
    IF target IS NULL THEN
      RAISE EXCEPTION '0756 % is missing', signature USING ERRCODE = '55000';
    END IF;
    definition := pg_catalog.pg_get_functiondef(target);
    count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
      / pg_catalog.length(anchor);
    IF count_of <> 1 THEN
      RAISE EXCEPTION '0756 % context-turn lookup drift', signature USING ERRCODE = '55000';
    END IF;
    EXECUTE pg_catalog.replace(definition, anchor, replacement);
  END LOOP;
END
$context_turn_schema$;
