-- deployment-mode: rolling
-- A chat a scheduled task starts may carry the task's inline Skills and
-- attached MCP servers (agentConfig.skills, agentConfig.mcpServers). The
-- generated-session identity fence required none; it now requires exactly the
-- accepted task's Skills and servers (id and URL), with no stored headers.
-- Tasks without these fields compare as before, so the previous release,
-- which never sets them, is unaffected. Only the routine is patched; no rows
-- are read or written.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  servers_anchor text;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.fence_scheduled_task_run_connection_session_identity()',
    pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, $a$server_value.headers_encrypted <> '{}'::jsonb$a$) > 0 THEN
    RETURN;
  END IF;
  -- The servers clause is matched once, whitespace-tolerant, then replaced as text.
  servers_anchor := (pg_catalog.regexp_match(definition,
    'OR EXISTS \(\s+SELECT 1 FROM\s+session_mcp_servers\s+server_value\s+WHERE server_value\.session_id = session_row\.id'))[1];
  IF servers_anchor IS NULL
    OR (length(definition) - length(replace(definition, servers_anchor, ''))) / length(servers_anchor) <> 1
    OR (length(definition) - length(replace(definition,
      $a$OR session_row.skills IS DISTINCT FROM '[]'::jsonb$a$, '')))
      / length($a$OR session_row.skills IS DISTINCT FROM '[]'::jsonb$a$) <> 1
  THEN
    RAISE EXCEPTION '1111 scheduled generated session fence drift'
      USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, $a$OR session_row.skills IS DISTINCT FROM '[]'::jsonb$a$,
    $a$OR session_row.skills IS DISTINCT FROM
              coalesce(task_snapshot -> 'agentConfig' -> 'skills', '[]'::jsonb)$a$);
  definition := replace(definition, servers_anchor, $a$OR (
              SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', attached.server_id, 'url', attached.url) ORDER BY attached.server_id), '[]'::jsonb)
              FROM session_mcp_servers attached
              WHERE attached.session_id = session_row.id
                AND attached.account_id = session_row.account_id
                AND attached.workspace_id = session_row.workspace_id
            ) IS DISTINCT FROM (
              SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', expected ->> 'id', 'url', expected ->> 'url') ORDER BY expected ->> 'id'), '[]'::jsonb)
              FROM pg_catalog.jsonb_array_elements(
                coalesce(task_snapshot -> 'agentConfig' -> 'mcpServers', '[]'::jsonb)) expected
            )
            OR EXISTS (
              SELECT 1 FROM session_mcp_servers server_value
              WHERE server_value.headers_encrypted <> '{}'::jsonb
                AND server_value.session_id = session_row.id$a$);
  EXECUTE definition;
END
$migration$;
