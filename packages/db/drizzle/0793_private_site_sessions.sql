-- deployment-mode: maintenance
-- Freeze an independent viewer audience on native sessions. Published legacy
-- mappings prove their audience; historical console provenance does not, and
-- is deliberately not converted into an asserted private owner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sessions ADD COLUMN site_id uuid,
  ADD COLUMN site_access_root_id uuid,
  ADD COLUMN site_viewer_principal text,
  ADD COLUMN site_owner_subject_id text;
ALTER TABLE model_call_facts ADD COLUMN site_id uuid;

-- Run the bounded source backfill under the same tenant scope as each row.
DO $backfill$
DECLARE scope record;
BEGIN
  FOR scope IN SELECT DISTINCT account_id, workspace_id FROM site_runtime_conversations LOOP
    PERFORM set_config('opengeni.account_id', scope.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', scope.workspace_id::text, true);
    WITH RECURSIVE bound AS (
      SELECT s.id, s.id AS access_root, c.site_id, c.viewer_principal,
        CASE WHEN c.viewer_principal LIKE 'user:%' THEN substr(c.viewer_principal,6) END AS owner
      FROM sessions s JOIN site_runtime_conversations c
        ON c.session_id=s.id AND c.account_id=s.account_id AND c.workspace_id=s.workspace_id
      WHERE s.account_id=scope.account_id AND s.workspace_id=scope.workspace_id
      UNION ALL
      SELECT child.id, b.access_root,b.site_id,b.viewer_principal,b.owner
      FROM sessions child JOIN bound b ON child.parent_session_id=b.id
      WHERE child.account_id=scope.account_id AND child.workspace_id=scope.workspace_id
    ) UPDATE sessions s SET site_id=b.site_id,site_access_root_id=b.access_root,
      site_viewer_principal=b.viewer_principal,site_owner_subject_id=b.owner
      FROM bound b WHERE s.id=b.id AND s.workspace_id=scope.workspace_id;
    UPDATE model_call_facts f SET site_id=s.site_id FROM sessions s
      WHERE f.account_id=scope.account_id AND f.workspace_id=scope.workspace_id
        AND s.id=f.session_id AND s.workspace_id=f.workspace_id AND s.site_id IS NOT NULL;
  END LOOP;
END
$backfill$;

CREATE FUNCTION bind_session_site_audience() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE parent sessions%ROWTYPE; conversation site_runtime_conversations%ROWTYPE;
  origin jsonb; enabled boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.site_access_root_id IS NOT NULL AND NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      RAISE EXCEPTION 'Site conversations keep their viewer audience; publish an output to share it' USING ERRCODE='42501';
    END IF;
    IF ROW(NEW.site_id,NEW.site_access_root_id,NEW.site_viewer_principal,NEW.site_owner_subject_id)
      IS DISTINCT FROM ROW(OLD.site_id,OLD.site_access_root_id,OLD.site_viewer_principal,OLD.site_owner_subject_id)
    THEN RAISE EXCEPTION 'Site session audience is immutable' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.site_id IS NOT NULL OR NEW.site_access_root_id IS NOT NULL
    OR NEW.site_viewer_principal IS NOT NULL OR NEW.site_owner_subject_id IS NOT NULL
  THEN RAISE EXCEPTION 'Site audience is derived by the server' USING ERRCODE='42501'; END IF;
  IF NEW.parent_session_id IS NOT NULL THEN
    SELECT * INTO parent FROM sessions WHERE id=NEW.parent_session_id
      AND account_id=NEW.account_id AND workspace_id=NEW.workspace_id;
    IF parent.site_access_root_id IS NOT NULL THEN
      NEW.site_id:=parent.site_id; NEW.site_access_root_id:=parent.site_access_root_id;
      NEW.site_viewer_principal:=parent.site_viewer_principal;
      NEW.site_owner_subject_id:=parent.site_owner_subject_id;
      RETURN NEW;
    END IF;
  END IF;
  SELECT * INTO conversation FROM site_runtime_conversations
    WHERE session_id=NEW.id AND account_id=NEW.account_id AND workspace_id=NEW.workspace_id;
  IF FOUND THEN
    NEW.site_id:=conversation.site_id; NEW.site_access_root_id:=NEW.id;
    NEW.site_viewer_principal:=conversation.viewer_principal;
    IF conversation.viewer_principal LIKE 'user:%' THEN
      NEW.site_owner_subject_id:=substr(conversation.viewer_principal,6);
    END IF;
  ELSE
    origin:=NEW.metadata->'_opengeniSiteOrigin';
    IF jsonb_typeof(origin) IS DISTINCT FROM 'object' THEN RETURN NEW; END IF;
    -- Native ownership must already have been derived by the authority fence.
    -- Old console writers without private creation fail closed after migration.
    IF NEW.owner_subject_id IS NULL OR
      (NEW.parent_session_id IS NULL AND NEW.visibility<>'user_private') THEN
      RAISE EXCEPTION 'Private Site sessions require verified viewer ownership' USING ERRCODE='42501';
    END IF;
    NEW.site_id:=nullif(origin->>'siteId','')::uuid;
    NEW.site_access_root_id:=NEW.id; NEW.site_owner_subject_id:=NEW.owner_subject_id;
  END IF;
  IF current_setting('opengeni.site_session_audience_v1',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Site session writer upgrade required' USING ERRCODE='55000';
  END IF;
  -- Guest/service execution is not an exception to the organization's private
  -- conversation policy. Native member creation already takes this lock first.
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:'||NEW.account_id,0));
  enabled:=organization_private_sessions_enabled(NEW.account_id);
  IF NOT enabled AND NOT EXISTS(SELECT 1 FROM organization_memberships m
    WHERE m.account_id=NEW.account_id AND m.status='active'
      AND m.personal_workspace_id=NEW.workspace_id AND m.subject_id=NEW.site_owner_subject_id)
  THEN RAISE EXCEPTION 'Private Site conversations are disabled by organization policy' USING ERRCODE='P0793'; END IF;
  RETURN NEW;
END
$body$;
-- Alphabetical trigger order: ownership is frozen before the Site audience.
CREATE TRIGGER zz_sessions_site_audience BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION bind_session_site_audience();

CREATE FUNCTION session_site_actor_visible(p_site uuid,p_access_root uuid,p_root uuid,p_viewer text,p_owner text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $body$
  SELECT p_access_root IS NULL
    OR nullif(current_setting('opengeni.subject_id',true),'') IS NULL
    OR p_owner=nullif(current_setting('opengeni.subject_id',true),'')
    OR p_owner=nullif(current_setting('opengeni.initiating_human_subject_id',true),'')
    OR (p_root::text=nullif(current_setting('opengeni.agent_root_session_id',true),'')
      AND (p_access_root=p_root OR p_owner=nullif(current_setting('opengeni.initiating_human_subject_id',true),'')))
    OR (current_setting('opengeni.subject_id',true)='site:'||p_site::text
      AND p_site::text=current_setting('opengeni.site_id',true)
      AND p_viewer=current_setting('opengeni.site_viewer_principal',true))
$body$;
-- No inventory-owner exception: privileged Insights transcript projections
-- also see only the viewer's Site sessions. Their existing masked raw amount
-- projections retain workspace totals without exposing private session data.
CREATE POLICY site_viewer_isolation ON sessions AS RESTRICTIVE FOR ALL
  USING (session_site_actor_visible(site_id,site_access_root_id,root_session_id,site_viewer_principal,site_owner_subject_id))
  WITH CHECK (session_site_actor_visible(site_id,site_access_root_id,root_session_id,site_viewer_principal,site_owner_subject_id));
CREATE INDEX sessions_site_viewer_idx ON sessions(workspace_id,site_id,site_viewer_principal)
  WHERE site_access_root_id IS NOT NULL;

CREATE FUNCTION stamp_model_call_site() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT s.site_id INTO NEW.site_id FROM sessions s
      WHERE s.account_id=NEW.account_id AND s.workspace_id=NEW.workspace_id AND s.id=NEW.session_id;
  ELSIF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'Model call Site attribution is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER model_call_site_attribution BEFORE INSERT OR UPDATE ON model_call_facts
  FOR EACH ROW EXECUTE FUNCTION stamp_model_call_site();
CREATE INDEX model_call_facts_site_occurred_idx ON model_call_facts(workspace_id,site_id,occurred_at)
  WHERE site_id IS NOT NULL;

REVOKE ALL ON FUNCTION bind_session_site_audience() FROM PUBLIC;
REVOKE ALL ON FUNCTION stamp_model_call_site() FROM PUBLIC;
DO $pin$
DECLARE data_schema text:=current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.bind_session_site_audience() SET search_path=pg_catalog,%I,pg_temp',data_schema,data_schema);
  EXECUTE format('ALTER FUNCTION %I.stamp_model_call_site() SET search_path=pg_catalog,%I,pg_temp',data_schema,data_schema);
END
$pin$;
