-- deployment-mode: rolling
-- The archive export read each bundle page under row-level security. PostgreSQL
-- evaluates the policies before any comparison that is not leakproof, and
-- numeric and row comparisons are not, so the keyset predicate could not seek:
-- every page of session_history_items re-filtered all earlier rows of the
-- session through session_reference_visible. Page time grew with the cursor
-- (3.8 s per 200 rows at row 40,000 on staging) and the largest sessions ran
-- past the archive activity limit.
--
-- This definer reads one keyset page of one export table as exact JSON text,
-- only while that session is being archived, so the predicate is an index
-- condition again. The worker's spec supplies the key columns; every table,
-- column and cast is validated before it is quoted into the statement. It
-- raises instead of returning nothing for a session that is not archiving: an
-- empty page would be recorded as a complete bundle and then purged.
CREATE FUNCTION opengeni_private.session_archive_export_rows(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_table text,
  p_keys text[],
  p_casts text[],
  p_after text[],
  p_limit integer
)
RETURNS TABLE (row_json text, key_values text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
DECLARE
  v_count integer := coalesce(array_length(p_keys, 1), 0);
  v_order text;
  v_key_text text;
  v_after text := 'true';
BEGIN
  IF p_table NOT IN (
    'session_turns', 'session_turn_attempts', 'session_goals', 'session_goal_revisions',
    'session_events', 'session_history_items', 'session_system_updates',
    'session_realtime_entries', 'session_attempt_codemode_calls',
    'session_attempt_tool_catalogs', 'session_attempt_model_context_snapshots',
    'session_content_blobs', 'session_pending_tool_calls'
  ) THEN
    RAISE EXCEPTION 'session archive export: % is not an export table', p_table
      USING ERRCODE = '22023';
  END IF;
  IF v_count = 0
    OR coalesce(array_length(p_casts, 1), 0) <> v_count
    OR (p_after IS NOT NULL AND coalesce(array_length(p_after, 1), 0) <> v_count) THEN
    RAISE EXCEPTION 'session archive export: keys, casts and cursor must have the same length'
      USING ERRCODE = '22023';
  END IF;
  -- Refuse rather than clamp: the worker ends a table at its first short page.
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'session archive export: page size % is outside 1..1000', p_limit
      USING ERRCODE = '22023';
  END IF;
  FOR i IN 1..v_count LOOP
    IF p_casts[i] NOT IN ('uuid', 'bigint', 'integer', 'numeric', 'text', 'timestamptz') THEN
      RAISE EXCEPTION 'session archive export: unsupported key cast %', p_casts[i]
        USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute A
      WHERE A.attrelid = to_regclass(quote_ident(p_table))
        AND A.attname = p_keys[i] AND A.attnum > 0 AND NOT A.attisdropped
    ) THEN
      RAISE EXCEPTION 'session archive export: % has no column %', p_table, p_keys[i]
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM sessions S
    WHERE S.workspace_id = p_workspace_id AND S.id = p_session_id
      AND S.account_id = p_account_id
      AND S.content_archive_state = 'archiving'
  ) THEN
    RAISE EXCEPTION 'session archive export: session % is not being archived', p_session_id
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(format('t.%I', u.k), ', ' ORDER BY u.i),
         string_agg(format('t.%I::text', u.k), ', ' ORDER BY u.i)
    INTO v_order, v_key_text
    FROM unnest(p_keys) WITH ORDINALITY AS u(k, i);
  IF p_after IS NOT NULL THEN
    SELECT format('(%s) > (%s)', v_order,
             string_agg(format('$4[%s]::%s', g.i, p_casts[g.i]), ', ' ORDER BY g.i))
      INTO v_after
      FROM generate_subscripts(p_keys, 1) AS g(i);
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT row_to_json(t)::text, ARRAY[%s] FROM %I t
      WHERE t.account_id = $1 AND t.workspace_id = $2 AND t.session_id = $3 AND %s
      ORDER BY %s LIMIT $5',
    v_key_text, p_table, v_after, v_order)
  USING p_account_id, p_workspace_id, p_session_id, p_after, p_limit;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_archive_export_rows(
  uuid, uuid, uuid, text, text[], text[], text[], integer) FROM PUBLIC;
DO $archive_export_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.session_archive_export_rows(
      uuid, uuid, uuid, text, text[], text[], text[], integer) TO opengeni_app;
  END IF;
END
$archive_export_grants$;
