-- deployment-mode: rolling
-- Shared discovery metadata only. Existing content and authorization domains
-- remain canonical; older binaries keep their original publication capability.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.artifact_catalog_pins (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('site','document','spreadsheet','presentation','image','file')),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 128),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, kind, artifact_id)
);
ALTER TABLE opengeni_private.artifact_catalog_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.artifact_catalog_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON opengeni_private.artifact_catalog_pins
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE FUNCTION opengeni_private.update_artifact_pin(
  p_account uuid, p_workspace uuid, p_kind text, p_id text, p_pinned boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_visible boolean := false;
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_kind IS NULL OR p_id IS NULL OR p_pinned IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_kind NOT IN ('site','document','spreadsheet','presentation','image','file')
    OR length(p_id) NOT BETWEEN 1 AND 128
  THEN RAISE EXCEPTION 'artifact pin scope mismatch' USING ERRCODE = '42501'; END IF;
  -- Serialize opposite writes even before the first row exists.
  PERFORM pg_advisory_xact_lock(hashtextextended('artifact-pin:' || p_account || ':' || p_workspace || ':' || p_kind || ':' || p_id, 0));
  IF p_kind = 'site' THEN
    SELECT EXISTS (SELECT 1 FROM workspace_artifacts a WHERE a.account_id=p_account
      AND a.workspace_id=p_workspace AND a.id::text=p_id) INTO v_visible;
  ELSIF p_kind IN ('document','spreadsheet','presentation') THEN
    SELECT EXISTS (SELECT 1 FROM editable_artifacts a WHERE a.account_id=p_account
      AND a.workspace_id=p_workspace AND a.id=p_id AND a.modality=p_kind) INTO v_visible;
  ELSE
    SELECT EXISTS (SELECT 1 FROM files f WHERE f.account_id=p_account AND f.workspace_id=p_workspace
      AND f.id::text=p_id AND f.status='ready'
      AND (f.private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(f.private_owner_subject_ids))
      AND ((p_kind='image' AND EXISTS (SELECT 1 FROM generated_image_artifacts g
        WHERE g.account_id=p_account AND g.workspace_id=p_workspace AND g.artifact_id=f.id AND g.status='ready'))
        OR (EXISTS (SELECT 1 FROM opengeni_private.sandbox_file_publications p
          WHERE p.account_id=p_account AND p.workspace_id=p_workspace AND p.file_id=f.id)
          AND p_kind=CASE WHEN f.content_type IN ('image/png','image/jpeg','image/gif','image/webp','image/avif','image/svg+xml')
            THEN 'image' ELSE 'file' END))) INTO v_visible;
  END IF;
  -- Also validate unpin: no probe or write for missing, foreign or hidden targets.
  IF NOT v_visible THEN RAISE EXCEPTION 'artifact pin target unavailable' USING ERRCODE = '42501'; END IF;
  IF p_pinned THEN
    INSERT INTO opengeni_private.artifact_catalog_pins(account_id,workspace_id,kind,artifact_id)
      VALUES(p_account,p_workspace,p_kind,p_id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM opengeni_private.artifact_catalog_pins p WHERE p.account_id=p_account
      AND p.workspace_id=p_workspace AND p.kind=p_kind AND p.artifact_id=p_id;
  END IF;
END $body$;

CREATE FUNCTION opengeni_private.list_artifact_pins(p_account uuid, p_workspace uuid)
RETURNS TABLE(kind text, artifact_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'artifact pin scope mismatch' USING ERRCODE = '42501'; END IF;
  -- Only joined to independently authorized candidates. Private files remain
  -- hidden even when the migration owner is a superuser rather than FORCE-RLS-bound.
  RETURN QUERY SELECT p.kind,p.artifact_id FROM opengeni_private.artifact_catalog_pins p
    WHERE p.account_id=p_account AND p.workspace_id=p_workspace
      AND (p.kind NOT IN ('file','image') OR EXISTS (SELECT 1 FROM files f
        WHERE f.account_id=p_account AND f.workspace_id=p_workspace AND f.id::text=p.artifact_id AND f.status='ready'
          AND (f.private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(f.private_owner_subject_ids))));
END $body$;

-- A page-local re-sort is incorrect: this bounded branch must apply the same
-- leading pin key and frontier as the complete union before taking its LIMIT.
CREATE FUNCTION opengeni_private.list_sandbox_file_publications_pinned(
  p_account uuid, p_workspace uuid, p_query jsonb
) RETURNS TABLE(file_id uuid, title text, kind text, source_session_id uuid, published_at timestamptz, pinned boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_limit integer := (p_query->>'limit')::integer;
  v_sort text := p_query->>'sort';
  v_after text := p_query#>>'{after,key}';
  v_after_pinned boolean := coalesce((p_query#>>'{after,pinned}')::boolean,false);
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
REVOKE ALL ON TABLE opengeni_private.artifact_catalog_pins FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.update_artifact_pin(uuid,uuid,text,text,boolean),
  opengeni_private.list_artifact_pins(uuid,uuid),
  opengeni_private.list_sandbox_file_publications_pinned(uuid,uuid,jsonb) FROM PUBLIC;

DO $grants$
DECLARE target_schema text := current_schema(); recipient record; routine text;
BEGIN
  FOREACH routine IN ARRAY ARRAY['update_artifact_pin(uuid,uuid,text,text,boolean)',
    'list_artifact_pins(uuid,uuid)','list_sandbox_file_publications_pinned(uuid,uuid,jsonb)']
  LOOP
    EXECUTE format('ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp', routine, target_schema);
    -- Strip inherited default function ACLs, then grant only existing runtimes.
    FOR recipient IN SELECT DISTINCT acl.grantee,r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl LEFT JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=to_regprocedure('opengeni_private.' || routine) AND acl.grantee<>p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM %s', routine,
        CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
    END LOOP;
  END LOOP;
  FOR recipient IN SELECT DISTINCT acl.grantee,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl LEFT JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='opengeni_private' AND c.relname='artifact_catalog_pins' AND acl.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.artifact_catalog_pins FROM %s',
      CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee
    WHERE p.oid=to_regprocedure('opengeni_private.record_sandbox_file_publication(uuid,uuid,uuid,uuid)')
      AND acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.update_artifact_pin(uuid,uuid,text,text,boolean), opengeni_private.list_artifact_pins(uuid,uuid), opengeni_private.list_sandbox_file_publications_pinned(uuid,uuid,jsonb) TO %I', recipient.rolname);
  END LOOP;
END $grants$;