-- deployment-mode: rolling
-- Keep the inlined session visibility probe a keyed per-row lookup.
--
-- Migration 0805 inlined `session_id IS NULL OR EXISTS (SELECT 1 FROM sessions
-- session_row WHERE <account, workspace, id match>)` into every session child
-- policy. PostgreSQL may turn such an EXISTS into a hashed subplan: when it
-- expects a scan to return many rows (a session's events after a sequence, a
-- generic plan's default selectivity), it reads and hashes every sessions row
-- the caller can see, evaluating the sessions policies for each one, before
-- returning the first child row. On a workspace with a few thousand sessions
-- that costs about 60 ms per statement even when the statement returns a
-- handful of rows, while the keyed probe costs about 30 microseconds per row.
--
-- OFFSET 0 keeps the subquery from being flattened or hashed, so the probe
-- always runs as an index lookup on sessions for the rows actually read.
-- Who can see what is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_child_probe_per_row$
DECLARE
  data_schema text := current_schema();
  policy record;
  ident text := '(?:"[^"]+"|[a-z_][a-z0-9_]*)';
  probe_pattern text;
  replacement text;
  new_qual text;
  new_check text;
  rewritten integer := 0;
BEGIN
  probe_pattern :=
    'EXISTS \( SELECT 1\s+FROM ((?:' || ident || '\.)?sessions) session_row\s+'
    || 'WHERE \(\(session_row\.account_id = (' || ident || ')\.(' || ident || ')\) '
    || 'AND \(session_row\.workspace_id = \2\.(' || ident || ')\) '
    || 'AND \(session_row\.id = \2\.(' || ident || ')\)\)\)';
  replacement :=
    'EXISTS (SELECT 1 FROM \1 session_row'
    || ' WHERE session_row.account_id = \2.\3'
    || ' AND session_row.workspace_id = \2.\4'
    || ' AND session_row.id = \2.\5 OFFSET 0)';
  FOR policy IN
    SELECT
      p.polname,
      c.relname,
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = data_schema
      AND (
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ probe_pattern
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) ~ probe_pattern
      )
    ORDER BY c.relname, p.polname
  LOOP
    new_qual := CASE WHEN policy.qual IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.qual, probe_pattern, replacement, 'g') END;
    new_check := CASE WHEN policy.check_expr IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.check_expr, probe_pattern, replacement, 'g') END;
    IF new_qual IS NOT NULL AND new_check IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
        policy.polname, data_schema, policy.relname, new_qual, new_check
      );
    ELSIF new_qual IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I USING (%s)',
        policy.polname, data_schema, policy.relname, new_qual
      );
    ELSE
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
        policy.polname, data_schema, policy.relname, new_check
      );
    END IF;
    rewritten := rewritten + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = data_schema
      AND (
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ probe_pattern
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) ~ probe_pattern
      )
  ) THEN
    RAISE EXCEPTION 'session visibility probe left without OFFSET 0'
      USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'kept the session visibility probe per-row in % policies', rewritten;
END
$session_child_probe_per_row$;
