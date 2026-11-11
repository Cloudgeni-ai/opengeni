-- deployment-mode: rolling
-- The artifact catalog can list a chat together with its sub-sessions in one
-- read. The published-file branch lists through this routine, which so far
-- filtered by one source session. It now also accepts `sourceSessionIds`, a
-- bounded list of sessions the API has already authorized. Every other check,
-- the ordering and the keyset are unchanged.
--
-- Rolling: CREATE OR REPLACE keeps the routine's owner and grants. The
-- previous release only sends `sourceSessionId`, which keeps its meaning.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_sandbox_file_publications_pinned(
      p_account uuid, p_workspace uuid, p_query jsonb
    ) RETURNS TABLE(file_id uuid, title text, kind text, source_session_id uuid, published_at timestamptz, pinned boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE
      v_limit integer := (p_query->>'limit')::integer;
      v_sort text := p_query->>'sort';
      v_after text := p_query#>>'{after,key}';
      v_after_pinned boolean := coalesce((p_query#>>'{after,pinned}')::boolean,false);
      v_sources uuid[];
    BEGIN
      IF p_account IS NULL OR p_workspace IS NULL
        OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 201
        OR v_sort IS NULL OR v_sort NOT IN ('updated','newest','title')
        OR jsonb_typeof(p_query) IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_query->'kinds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_query->'kinds') NOT BETWEEN 1 AND 2
        OR length(coalesce(p_query->>'q',''))>200
        OR (p_query ? 'sourceSessionIds' AND (
          jsonb_typeof(p_query->'sourceSessionIds') IS DISTINCT FROM 'array'
          OR jsonb_array_length(p_query->'sourceSessionIds') NOT BETWEEN 1 AND 201
          OR p_query ? 'sourceSessionId'))
      THEN RAISE EXCEPTION 'publication list scope mismatch' USING ERRCODE = '42501'; END IF;
      IF p_query ? 'sourceSessionIds' THEN
        v_sources := ARRAY(SELECT jsonb_array_elements_text(p_query->'sourceSessionIds')::uuid);
      ELSIF p_query->>'sourceSessionId' IS NOT NULL THEN
        v_sources := ARRAY[(p_query->>'sourceSessionId')::uuid];
      END IF;
      RETURN QUERY WITH candidates AS (
        SELECT p.file_id, f.filename AS title,
          CASE WHEN f.content_type IN ('image/png','image/jpeg','image/gif','image/webp','image/avif','image/svg+xml')
            THEN 'image' ELSE 'file' END AS kind,
          p.source_session_id, p.published_at,
          CASE WHEN v_sort='title' THEN lower(f.filename)
            ELSE to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') END AS sort_key
        FROM opengeni_private.sandbox_file_publications p JOIN %1$I.files f
          ON f.account_id=p.account_id AND f.workspace_id=p.workspace_id AND f.id=p.file_id
        WHERE p.account_id=p_account AND p.workspace_id=p_workspace AND f.status='ready'
          AND (f.private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(f.private_owner_subject_ids))
          AND (v_sources IS NULL OR p.source_session_id=ANY(v_sources))
          AND p.published_at<=(p_query->>'snapshotAt')::timestamptz
          AND strpos(lower(f.filename),lower(coalesce(p_query->>'q','')))>0
      ), ordered AS (
        SELECT c.*, (pins.artifact_id IS NOT NULL) AS pinned FROM candidates c
          LEFT JOIN opengeni_private.list_artifact_pins(p_account,p_workspace) pins
            ON pins.kind=c.kind AND pins.artifact_id=c.file_id::text
      ) SELECT c.file_id,c.title,c.kind,c.source_session_id,c.published_at,c.pinned FROM ordered c
        WHERE (p_query->'kinds') ? c.kind AND (v_after IS NULL OR c.pinned<v_after_pinned OR
          (c.pinned=v_after_pinned AND (
            (v_sort='title' AND c.sort_key COLLATE "C">v_after COLLATE "C") OR
            (v_sort<>'title' AND c.sort_key COLLATE "C"<v_after COLLATE "C") OR
            (c.sort_key=v_after AND (c.kind COLLATE "C",c.file_id::text COLLATE "C")>
              ((p_query#>>'{after,kind}') COLLATE "C",(p_query#>>'{after,id}') COLLATE "C")))))
        ORDER BY c.pinned DESC, CASE WHEN v_sort='title' THEN c.sort_key END COLLATE "C" ASC,
          CASE WHEN v_sort<>'title' THEN c.sort_key END COLLATE "C" DESC,c.kind COLLATE "C",c.file_id::text COLLATE "C"
        LIMIT v_limit;
    END $body$;
  $create$, data_schema);
END $install$;
