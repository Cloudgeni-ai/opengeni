-- deployment-mode: rolling
-- Explicit output publication metadata only. Never infer publications from
-- uploaded inputs, object-key conventions, temporary evidence or old history.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.sandbox_file_publications (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  source_session_id uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_file_publications_pk PRIMARY KEY (account_id, workspace_id, file_id),
  CONSTRAINT sandbox_file_publications_file_fk FOREIGN KEY (account_id, workspace_id, file_id)
    REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_file_publications_session_fk FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (source_session_id)
);
CREATE INDEX sandbox_file_publications_session_idx
  ON opengeni_private.sandbox_file_publications(workspace_id, source_session_id, published_at, file_id);
ALTER TABLE opengeni_private.sandbox_file_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.sandbox_file_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON opengeni_private.sandbox_file_publications
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- A publication never grants access to its file or bypasses personal-file RLS.
CREATE POLICY visible_file ON opengeni_private.sandbox_file_publications AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM files f WHERE f.account_id = sandbox_file_publications.account_id
    AND f.workspace_id = sandbox_file_publications.workspace_id AND f.id = file_id AND f.status = 'ready'))
  WITH CHECK (EXISTS (SELECT 1 FROM files f WHERE f.account_id = sandbox_file_publications.account_id
    AND f.workspace_id = sandbox_file_publications.workspace_id AND f.id = file_id AND f.status = 'ready'));

-- Keep new storage out of the public-schema exact table inventory so older
-- binaries remain ready. Runtime has EXECUTE only, never table DML. Both
-- capabilities bind caller tenant GUCs and retain explicit file-owner checks
-- even when a deployment migrated with a superuser owner.
CREATE FUNCTION opengeni_private.record_sandbox_file_publication(
  p_account uuid, p_workspace uuid, p_file uuid, p_session uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_file IS NULL OR p_session IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'publication scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM files f WHERE f.account_id=p_account AND f.workspace_id=p_workspace AND f.id=p_file AND f.status='ready'
    AND (f.private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(f.private_owner_subject_ids));
  IF NOT FOUND THEN RAISE EXCEPTION 'publication file unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM sessions s WHERE s.account_id=p_account AND s.workspace_id=p_workspace AND s.id=p_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication session unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.sandbox_file_publications(account_id,workspace_id,file_id,source_session_id)
    VALUES(p_account,p_workspace,p_file,p_session) ON CONFLICT DO NOTHING;
  IF EXISTS(SELECT 1 FROM opengeni_private.sandbox_file_publications p
    WHERE p.account_id=p_account AND p.workspace_id=p_workspace AND p.file_id=p_file
      AND p.source_session_id IS DISTINCT FROM p_session)
  THEN RAISE EXCEPTION 'publication identity conflict' USING ERRCODE = '23505'; END IF;
END $body$;

CREATE FUNCTION opengeni_private.list_sandbox_file_publications(
  p_account uuid, p_workspace uuid, p_query jsonb
) RETURNS TABLE(file_id uuid, title text, kind text, source_session_id uuid, published_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_limit integer := (p_query->>'limit')::integer;
  v_sort text := p_query->>'sort';
  v_after text := p_query#>>'{after,key}';
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
  THEN RAISE EXCEPTION 'publication list scope mismatch' USING ERRCODE = '42501'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT p.file_id, f.filename AS title,
      CASE WHEN f.content_type IN ('image/png','image/jpeg','image/gif','image/webp','image/avif','image/svg+xml')
        THEN 'image' ELSE 'file' END AS kind,
      p.source_session_id, p.published_at,
      CASE WHEN v_sort='title' THEN lower(f.filename)
        ELSE to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') END AS sort_key
    FROM opengeni_private.sandbox_file_publications p JOIN files f
      ON f.account_id=p.account_id AND f.workspace_id=p.workspace_id AND f.id=p.file_id
    WHERE p.account_id=p_account AND p.workspace_id=p_workspace AND f.status='ready'
      AND (f.private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(f.private_owner_subject_ids))
      AND (p_query->>'sourceSessionId' IS NULL OR p.source_session_id=(p_query->>'sourceSessionId')::uuid)
      AND p.published_at<=(p_query->>'snapshotAt')::timestamptz
      AND strpos(lower(f.filename),lower(coalesce(p_query->>'q','')))>0
  ) SELECT c.file_id,c.title,c.kind,c.source_session_id,c.published_at FROM candidates c
    WHERE (p_query->'kinds') ? c.kind AND (v_after IS NULL OR
      (v_sort='title' AND c.sort_key COLLATE "C">v_after COLLATE "C") OR
      (v_sort<>'title' AND c.sort_key COLLATE "C"<v_after COLLATE "C") OR
      (c.sort_key=v_after AND (c.kind COLLATE "C",c.file_id::text COLLATE "C")>
        ((p_query#>>'{after,kind}') COLLATE "C",(p_query#>>'{after,id}') COLLATE "C")))
    ORDER BY CASE WHEN v_sort='title' THEN c.sort_key END COLLATE "C" ASC,
      CASE WHEN v_sort<>'title' THEN c.sort_key END COLLATE "C" DESC,c.kind COLLATE "C",c.file_id::text COLLATE "C"
    LIMIT v_limit;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.record_sandbox_file_publication(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_file_publications(uuid,uuid,jsonb) FROM PUBLIC;

-- Preserve existing runtime role recipients; provisionRoles owns future roles.
DO $grants$
DECLARE target_schema text := current_schema(); recipient record;
BEGIN
  -- Explicit pg_temp LAST is load-bearing: omitting it lets PostgreSQL search
  -- caller-controlled temporary relations ahead of the captured data schema.
  -- Pin builtins first and the exact migration target before granting EXECUTE.
  EXECUTE format('ALTER FUNCTION opengeni_private.record_sandbox_file_publication(uuid,uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.list_sandbox_file_publications(uuid,uuid,jsonb) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private' AND c.relname = 'sandbox_file_publications' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.sandbox_file_publications FROM %s',
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname, p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) acl LEFT JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='opengeni_private'
      AND p.proname IN ('record_sandbox_file_publication','list_sandbox_file_publications')
      AND acl.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', recipient.signature,
      CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = target_schema AND c.relname = 'files' AND acl.privilege_type = 'INSERT'
      AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.record_sandbox_file_publication(uuid,uuid,uuid,uuid), opengeni_private.list_sandbox_file_publications(uuid,uuid,jsonb) TO %I', recipient.rolname);
  END LOOP;
END $grants$;