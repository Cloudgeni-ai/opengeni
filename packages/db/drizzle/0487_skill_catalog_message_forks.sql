-- deployment-mode: rolling
-- Durable catalog updates precede accepted input at fractional positions.
-- Permit only their marked developer messages; keep compaction and authority
-- checks, ordered JSON copying, and reasoning-control validation unchanged.
DO $migration$
DECLARE candidate oid; definition text; updated text;
BEGIN
  SELECT oid INTO STRICT candidate FROM pg_proc
    WHERE proname = 'fork_session_content'
      AND pronamespace = current_schema()::regnamespace AND pronargs = 11;
  definition := pg_get_functiondef(candidate);
  updated := replace(definition,
    'history.position <> trunc(history.position) AND (',
    $predicate$history.position <> trunc(history.position) AND NOT ((
          history.item ->> 'type' = 'message'
          AND history.item ->> 'role' = 'developer'
          AND jsonb_typeof(history.item -> 'content') = 'string'
          AND starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n')
          AND right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>'
        ) IS TRUE) AND ($predicate$);
  IF updated = definition THEN
    RAISE EXCEPTION 'skill catalog fork predicate rewrite did not match';
  END IF;
  EXECUTE updated;
END
$migration$;
