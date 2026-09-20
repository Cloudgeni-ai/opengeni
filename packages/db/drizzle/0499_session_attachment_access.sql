-- deployment-mode: rolling
-- Session attachment grants do not change original-file ownership or history.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.session_file_attachments (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  file_id uuid NOT NULL,
  accepted_by text NOT NULL,
  accepted_event_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, session_id, file_id),
  FOREIGN KEY (account_id, workspace_id, file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE opengeni_private.session_file_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.session_file_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON opengeni_private.session_file_attachments
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON opengeni_private.session_file_attachments FROM PUBLIC;

CREATE TABLE opengeni_private.session_file_read_capabilities (
  backend_pid integer NOT NULL, transaction_id xid8 NOT NULL,
  nonce uuid NOT NULL, account_id uuid NOT NULL, workspace_id uuid NOT NULL, file_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, nonce, file_id)
);
REVOKE ALL ON opengeni_private.session_file_read_capabilities FROM PUBLIC;
CREATE FUNCTION opengeni_private.session_file_read_allowed(p_account uuid, p_workspace uuid, p_file uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM opengeni_private.session_file_read_capabilities c
    WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id_if_assigned()
      AND c.account_id=p_account AND c.workspace_id=p_workspace AND c.file_id=p_file)
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_file_read_allowed(uuid,uuid,uuid) FROM PUBLIC;
-- Opening a read never opens UPDATE/DELETE or generic personal-file access.
DROP POLICY files_personal_owner ON files;
CREATE POLICY files_personal_owner ON files AS RESTRICTIVE FOR SELECT USING (
  private_owner_subject_ids IS NULL
  OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids)
  OR opengeni_private.session_file_read_allowed(account_id,workspace_id,id)
);
CREATE POLICY files_personal_owner_insert ON files AS RESTRICTIVE FOR INSERT WITH CHECK (
  private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids));
CREATE POLICY files_personal_owner_update ON files AS RESTRICTIVE FOR UPDATE USING (
  private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids)) WITH CHECK (
  private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids));
CREATE POLICY files_personal_owner_delete ON files AS RESTRICTIVE FOR DELETE USING (
  private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids));

CREATE FUNCTION opengeni_private.accept_session_file_attachments(p_account uuid,p_workspace uuid,p_session uuid,p_turn uuid,p_subject text,p_files uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE accepted_turn record;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject IS DISTINCT FROM nullif(current_setting('opengeni.private_file_owner',true),'')
    OR cardinality(p_files)>1000
  THEN RAISE EXCEPTION 'attachment acceptance scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session
    AND (visibility='workspace_shared' OR session_private_actor_visible(account_id,workspace_id,owner_organization_membership_id,owner_subject_id)) FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attachment session unavailable' USING ERRCODE='42501'; END IF;
  SELECT t.* INTO accepted_turn FROM session_turns t WHERE t.account_id=p_account AND t.workspace_id=p_workspace
    AND t.session_id=p_session AND t.id=p_turn AND t.source IN ('user','api')
    AND t.initiator_kind='subject' AND t.initiator_subject_id=p_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'attachment requires accepted human input' USING ERRCODE='42501'; END IF;
  -- Only a completed original upload owned by this verified human is shareable.
  -- Generic personal resources, provider originals and arbitrary history refs do
  -- not become a session grant merely because their UUID appeared in a request.
  INSERT INTO opengeni_private.session_file_attachments(account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id)
    SELECT p_account,p_workspace,p_session,f.id,p_subject,accepted_turn.trigger_event_id FROM files f
    WHERE f.account_id=p_account AND f.workspace_id=p_workspace AND f.id=ANY(p_files) AND f.status='ready'
      AND p_subject=ANY(f.private_owner_subject_ids)
      AND EXISTS (SELECT 1 FROM session_events e CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.payload->'resources')='array' THEN e.payload->'resources' ELSE '[]'::jsonb END) r
        WHERE e.account_id=p_account AND e.workspace_id=p_workspace AND e.session_id=p_session
          AND r->>'kind'='file' AND r->>'fileId'=f.id::text
          AND ((e.id=accepted_turn.trigger_event_id AND e.type='user.message') OR (
            e.type='session.created' AND e.payload#>>'{createdBy,kind}'='subject'
            AND e.payload#>>'{createdBy,subjectId}'=p_subject
            AND NOT EXISTS (SELECT 1 FROM session_events prior, session_events current_input
              WHERE prior.account_id=p_account AND prior.workspace_id=p_workspace AND prior.session_id=p_session
              AND current_input.id=accepted_turn.trigger_event_id AND current_input.session_id=p_session
              AND prior.type='user.message' AND prior.sequence<current_input.sequence))))
      AND EXISTS (SELECT 1 FROM file_uploads u WHERE u.account_id=p_account AND u.workspace_id=p_workspace
        AND u.file_id=f.id AND u.status='completed' AND u.private_file_owner_subject_id=p_subject)
      AND google_drive_file_authorized(p_account,p_workspace,p_subject,f.id)
    ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.accept_session_file_attachments(uuid,uuid,uuid,uuid,text,uuid[]) FROM PUBLIC;

CREATE FUNCTION opengeni_private.read_session_file_attachments(p_account uuid,p_workspace uuid,p_session uuid,p_epoch integer,p_files uuid[],p_actor jsonb)
RETURNS SETOF files LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE read_nonce uuid:=gen_random_uuid(); session_row record; caller_row record;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR opengeni_private.current_subject_id() IS NULL OR cardinality(p_files)>1000
  THEN RAISE EXCEPTION 'attachment read scope mismatch' USING ERRCODE='42501'; END IF;
  -- Match lifecycle lock order: workspace, ordered sessions, turn, attempt.
  PERFORM 1 FROM workspaces WHERE account_id=p_account AND id=p_workspace FOR KEY SHARE;
  PERFORM 1 FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace
    AND (id=p_session OR (p_actor->>'kind'='agent_attempt' AND id=(p_actor->>'callerSessionId')::uuid))
    ORDER BY id FOR SHARE;
  SELECT * INTO session_row FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session;
  IF NOT FOUND OR session_row.authority_epoch IS DISTINCT FROM p_epoch
    OR NOT (session_row.visibility='workspace_shared' OR session_private_actor_visible(
      p_account,p_workspace,session_row.owner_organization_membership_id,session_row.owner_subject_id))
  THEN RAISE EXCEPTION 'attachment session changed' USING ERRCODE='42501'; END IF;
  -- Core proves full host/Slack/tree authorization before this read. The DB
  -- additionally rejects a stale exact attempt, including while the host runs.
  IF p_actor->>'kind'='agent_attempt' THEN
    IF p_actor->>'subjectId' IS DISTINCT FROM opengeni_private.current_subject_id() THEN
      RAISE EXCEPTION 'attachment caller identity mismatch' USING ERRCODE='42501';
    END IF;
    SELECT * INTO caller_row FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace
      AND id=(p_actor->>'callerSessionId')::uuid;
    IF NOT FOUND OR caller_row.active_turn_id IS DISTINCT FROM (p_actor->>'turnId')::uuid OR caller_row.status='cancelled' THEN
      RAISE EXCEPTION 'attachment caller stale' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM session_turns t WHERE t.account_id=p_account AND t.workspace_id=p_workspace
      AND t.session_id=caller_row.id AND t.id=(p_actor->>'turnId')::uuid
      AND t.status='running' AND t.active_attempt_id=(p_actor->>'attemptId')::uuid
      AND t.execution_generation=(p_actor->>'executionGeneration')::integer FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'attachment caller stale' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM session_turn_attempts a WHERE a.account_id=p_account AND a.workspace_id=p_workspace
      AND a.session_id=caller_row.id AND a.turn_id=(p_actor->>'turnId')::uuid
      AND a.id=(p_actor->>'attemptId')::uuid AND a.state IN ('claimed','running')
      AND a.execution_generation=(p_actor->>'executionGeneration')::integer
      AND a.closed_at IS NULL AND a.quiesced_at IS NULL
      AND a.authority_epoch=caller_row.authority_epoch AND a.authority_visibility=caller_row.visibility
      AND a.authority_owner_organization_membership_id IS NOT DISTINCT FROM caller_row.owner_organization_membership_id FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM session_attempt_interruptions i
      WHERE i.account_id=p_account AND i.workspace_id=p_workspace AND i.session_id=caller_row.id
        AND i.attempt_id=(p_actor->>'attemptId')::uuid AND i.state IN ('pending','delivered','acknowledged'))
    THEN RAISE EXCEPTION 'attachment caller stale' USING ERRCODE='42501'; END IF;
  ELSIF p_actor->>'kind' IS DISTINCT FROM 'subject' OR p_actor->>'subjectId' IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'attachment actor unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO opengeni_private.session_file_read_capabilities
    SELECT pg_backend_pid(),pg_current_xact_id(),read_nonce,p_account,p_workspace,g.file_id
    FROM opengeni_private.session_file_attachments g
    WHERE g.account_id=p_account AND g.workspace_id=p_workspace AND g.session_id=p_session AND g.file_id=ANY(p_files);
  RETURN QUERY SELECT f.* FROM files f JOIN opengeni_private.session_file_read_capabilities c ON c.file_id=f.id
    WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id() AND c.nonce=read_nonce
      AND f.account_id=p_account AND f.workspace_id=p_workspace AND f.status='ready'
      AND google_drive_file_authorized(p_account,p_workspace,opengeni_private.current_subject_id(),f.id);
  DELETE FROM opengeni_private.session_file_read_capabilities WHERE nonce=read_nonce AND backend_pid=pg_backend_pid();
END $$;
REVOKE ALL ON FUNCTION opengeni_private.read_session_file_attachments(uuid,uuid,uuid,integer,uuid[],jsonb) FROM PUBLIC;

DO $grants$
DECLARE data_schema text:=current_schema(); recipient record;
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.accept_session_file_attachments(uuid,uuid,uuid,uuid,text,uuid[]) SET search_path=pg_catalog,%I,pg_temp',data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.read_session_file_attachments(uuid,uuid,uuid,integer,uuid[],jsonb) SET search_path=pg_catalog,%I,pg_temp',data_schema);
  FOR recipient IN SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname=data_schema AND c.relname='files' AND acl.privilege_type='SELECT' AND acl.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.session_file_attachments,opengeni_private.session_file_read_capabilities FROM %I',recipient.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.session_file_read_allowed(uuid,uuid,uuid),opengeni_private.accept_session_file_attachments(uuid,uuid,uuid,uuid,text,uuid[]),opengeni_private.read_session_file_attachments(uuid,uuid,uuid,integer,uuid[],jsonb) TO %I',recipient.rolname);
  END LOOP;
END $grants$;

-- Existing explicit human attachments receive the same grant. Ownership and
-- event history stay untouched. NO FORCE is transaction-local in effect: DDL
-- locks prevent other transactions observing this migration's intermediate state.
ALTER TABLE files NO FORCE ROW LEVEL SECURITY;
ALTER TABLE file_uploads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.session_file_attachments NO FORCE ROW LEVEL SECURITY;
INSERT INTO opengeni_private.session_file_attachments
  (account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id,accepted_at)
SELECT DISTINCT ON (t.account_id,t.workspace_id,t.session_id,f.id)
  t.account_id,t.workspace_id,t.session_id,f.id,t.initiator_subject_id,e.id,e.occurred_at
FROM session_turns t JOIN session_events e ON e.id=t.trigger_event_id
  AND e.account_id=t.account_id AND e.workspace_id=t.workspace_id AND e.session_id=t.session_id
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'resources')='array'
  THEN e.payload->'resources' ELSE '[]'::jsonb END) r
JOIN files f ON f.account_id=t.account_id AND f.workspace_id=t.workspace_id
  AND f.id::text=r->>'fileId' AND r->>'kind'='file'
WHERE t.source IN ('user','api') AND t.initiator_kind='subject' AND e.type='user.message'
  AND f.status='ready' AND t.initiator_subject_id=ANY(f.private_owner_subject_ids)
  AND EXISTS (SELECT 1 FROM file_uploads u WHERE u.account_id=f.account_id AND u.workspace_id=f.workspace_id
    AND u.file_id=f.id AND u.status='completed' AND u.private_file_owner_subject_id=t.initiator_subject_id)
ORDER BY t.account_id,t.workspace_id,t.session_id,f.id,e.sequence
ON CONFLICT DO NOTHING;
-- Copy only already accepted attachment grants at the existing authorized fork
-- boundary. A message fork cannot acquire files attached after its cut point.
DO $forks$
DECLARE candidate record; definition text; replacement text; marker text;
BEGIN
  marker := ') RETURNING id INTO event_row_id;';
  FOR candidate IN SELECT oid,pronargs FROM pg_proc WHERE proname='fork_session_content'
    AND pronamespace=current_schema()::regnamespace AND pronargs IN (10,11)
  LOOP
    definition := pg_get_functiondef(candidate.oid);
    replacement := marker || E'\n\n' || $copy$
  INSERT INTO opengeni_private.session_file_attachments
    (account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id,accepted_at)
  SELECT g.account_id,g.workspace_id,destination_session_id,g.file_id,g.accepted_by,event_row_id,clock_timestamp()
    FROM opengeni_private.session_file_attachments g
    WHERE g.account_id=p_account_id AND g.workspace_id=p_source_workspace_id AND g.session_id=p_source_session_id
$copy$ || CASE WHEN candidate.pronargs=11 THEN $boundary$
      AND EXISTS (SELECT 1 FROM session_events e WHERE e.id=g.accepted_event_id
        AND e.account_id=p_account_id AND e.workspace_id=p_source_workspace_id
        AND e.session_id=p_source_session_id AND e.sequence<=selected_event.sequence)
$boundary$ ELSE '' END || E'    ON CONFLICT DO NOTHING;';
    IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'attachment fork seam missing'; END IF;
    EXECUTE replace(definition,marker,replacement);
  END LOOP;
END $forks$;

-- Restore owner isolation after installing the scoped fork definitions.
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE file_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.session_file_attachments FORCE ROW LEVEL SECURITY;
