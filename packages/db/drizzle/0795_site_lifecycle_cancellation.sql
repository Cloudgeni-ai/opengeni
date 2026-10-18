-- deployment-mode: rolling
-- Cancel-only host lifecycle commands reuse the native session control writer.
-- A private transaction-local witness admits its exact Site root/subtree; it
-- is never a viewer identity, bearer permission, or tenancy-inventory exception.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE INDEX site_runtime_conversations_cancel_page_idx
  ON site_runtime_conversations(account_id, workspace_id, site_id, session_id);

CREATE TABLE opengeni_private.site_session_cancellation_capabilities (
  capability_id uuid NOT NULL UNIQUE,
  target_schema oid NOT NULL,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  root_session_id uuid NOT NULL,
  subject_id text,
  initiating_human_subject_id text,
  PRIMARY KEY (backend_pid, transaction_id)
);
REVOKE ALL ON TABLE opengeni_private.site_session_cancellation_capabilities FROM PUBLIC;

DO $functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.site_session_cancellation_capability_active(
      a uuid,w uuid,site uuid,root uuid
    ) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM opengeni_private.site_session_cancellation_capabilities c
        WHERE c.target_schema=%2$s::oid AND c.backend_pid=pg_backend_pid()
          AND c.transaction_id=pg_current_xact_id_if_assigned()
          AND c.account_id=a AND c.workspace_id=w AND c.site_id=site AND c.root_session_id=root
          AND a=nullif(current_setting('opengeni.account_id',true),'')::uuid
          AND w=nullif(current_setting('opengeni.workspace_id',true),'')::uuid
          AND c.subject_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.subject_id',true),'')
          AND c.initiating_human_subject_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id',true),'')
      )
    $fn$;

    CREATE FUNCTION opengeni_private.begin_site_session_cancellation(a uuid,w uuid,site uuid,root uuid)
    RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE token uuid:=gen_random_uuid(); actor text:=nullif(current_setting('opengeni.subject_id',true),'');
      human text:=nullif(current_setting('opengeni.initiating_human_subject_id',true),'');
    BEGIN
      IF a IS NULL OR w IS NULL OR site IS NULL OR root IS NULL
        OR a IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
        OR w IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid
        OR actor LIKE 'site:%%' THEN
        RAISE EXCEPTION 'Site lifecycle cancellation requires exact host scope' USING ERRCODE='42501';
      END IF;
      -- Trusted application lifecycle only. The mapping proves association
      -- without granting a service principal transcript access.
      IF NOT EXISTS(SELECT 1 FROM %1$I.site_runtime_conversations c
        WHERE c.account_id=a AND c.workspace_id=w AND c.site_id=site AND c.session_id=root) THEN
        RAISE EXCEPTION 'Site cancellation target is unavailable' USING ERRCODE='42501';
      END IF;
      INSERT INTO opengeni_private.site_session_cancellation_capabilities
        VALUES(token,%2$s::oid,pg_backend_pid(),pg_current_xact_id(),a,w,site,root,actor,human);
      -- Root identity avoids the generic hidden-ancestor reader entirely.
      IF NOT EXISTS(SELECT 1 FROM %1$I.sessions s WHERE s.account_id=a AND s.workspace_id=w
        AND s.id=root AND s.site_id=site AND s.site_access_root_id=root
        AND s.root_session_id=root AND s.parent_session_id IS NULL) THEN
        DELETE FROM opengeni_private.site_session_cancellation_capabilities WHERE capability_id=token;
        RETURN NULL;
      END IF;
      RETURN token;
    END
    $fn$;

    CREATE FUNCTION opengeni_private.end_site_session_cancellation(token uuid)
    RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
      DELETE FROM opengeni_private.site_session_cancellation_capabilities c
        WHERE c.capability_id=token AND c.target_schema=%2$s::oid
          AND c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id_if_assigned()
    $fn$;
  $ddl$,data_schema,current_schema()::regnamespace::oid);
END
$functions$;

-- Preserve installed native/private and Site predicates. Both restrictive
-- gates admit only this exact command witness, never general inventory.
DO $policies$
DECLARE p record; n integer:=0;
  allowance text:=format('%I.site_session_cancellation_capability_active(account_id,workspace_id,site_id,site_access_root_id)',current_schema());
BEGIN
  FOR p IN SELECT polname,pg_get_expr(polqual,polrelid) qual,
      pg_get_expr(polwithcheck,polrelid) check_expr,polpermissive,polcmd
    FROM pg_policy WHERE polrelid='sessions'::regclass
      AND polname IN ('session_visibility_isolation','site_viewer_isolation') LOOP
    IF p.polpermissive OR p.polcmd<>'*' OR p.qual IS NULL OR p.check_expr IS NULL THEN
      RAISE EXCEPTION 'Unexpected session cancellation policy contract' USING ERRCODE='55000';
    END IF;
    EXECUTE format('ALTER POLICY %I ON %I.sessions USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
      p.polname,current_schema(),p.qual,allowance,p.check_expr,allowance);
    n:=n+1;
  END LOOP;
  IF n<>2 THEN RAISE EXCEPTION 'Missing session cancellation policy contract' USING ERRCODE='55000'; END IF;
END
$policies$;

REVOKE ALL ON FUNCTION opengeni_private.begin_site_session_cancellation(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.end_site_session_cancellation(uuid) FROM PUBLIC;
-- The policy predicate is value-free; callers cannot mint its witness.
GRANT EXECUTE ON FUNCTION site_session_cancellation_capability_active(uuid,uuid,uuid,uuid) TO PUBLIC;
DO $acl$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_roles r
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      ON r.rolname=configured.value LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.site_session_cancellation_capabilities FROM %I',role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.begin_site_session_cancellation(uuid,uuid,uuid,uuid),opengeni_private.end_site_session_cancellation(uuid) TO %I',role_name);
  END LOOP;
END
$acl$;
