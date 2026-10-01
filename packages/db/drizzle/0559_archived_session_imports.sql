-- deployment-mode: rolling
-- Imports are inert timeline archives. The marker is independent of mutable
-- metadata and the ordinary user's archive/unarchive preference.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE sessions
  ADD COLUMN imported_archive_import_id text,
  ADD COLUMN imported_archive_imported_at timestamptz,
  ADD COLUMN imported_archive_request_hash text,
  ADD COLUMN imported_archive_subject_id text,
  ADD COLUMN imported_archive_next_offset integer,
  ADD CONSTRAINT sessions_imported_archive_identity_check CHECK (
    (imported_archive_import_id IS NULL AND imported_archive_imported_at IS NULL
      AND imported_archive_request_hash IS NULL AND imported_archive_subject_id IS NULL
      AND imported_archive_next_offset IS NULL)
    OR (imported_archive_import_id IS NOT NULL AND octet_length(imported_archive_import_id) BETWEEN 1 AND 800
      AND imported_archive_imported_at IS NOT NULL
      AND imported_archive_request_hash IS NOT NULL AND imported_archive_request_hash ~ '^[0-9a-f]{64}$'
      AND imported_archive_subject_id IS NOT NULL
      AND imported_archive_next_offset IS NOT NULL AND imported_archive_next_offset >= 0)
  ),
  ADD CONSTRAINT sessions_imported_archive_inert_check CHECK (
    imported_archive_import_id IS NULL OR
    (status = 'idle' AND active_turn_id IS NULL AND temporal_workflow_id IS NULL
      AND parent_session_id IS NULL)
  );

CREATE UNIQUE INDEX sessions_workspace_imported_archive_idx
  ON sessions(workspace_id, imported_archive_import_id)
  WHERE imported_archive_import_id IS NOT NULL;

-- A rolling addition must not expand older binaries' closed public authority
-- inventory or their table-grant contract. Use the established private seam.
CREATE TABLE opengeni_private.session_import_batches (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  batch_id text NOT NULL CHECK (octet_length(batch_id) BETWEEN 1 AND 800),
  subject_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  event_offset integer NOT NULL CHECK (event_offset >= 0),
  event_count integer NOT NULL CHECK (event_count BETWEEN 1 AND 100),
  next_offset integer NOT NULL CHECK (next_offset = event_offset + event_count),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, batch_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE opengeni_private.session_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.session_import_batches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE opengeni_private.session_import_batches FROM PUBLIC;
CREATE POLICY workspace_isolation ON opengeni_private.session_import_batches
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON opengeni_private.session_import_batches AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
CREATE POLICY importer_isolation ON opengeni_private.session_import_batches AS RESTRICTIVE
  USING (subject_id = nullif(current_setting('opengeni.subject_id', true), ''))
  WITH CHECK (subject_id = nullif(current_setting('opengeni.subject_id', true), ''));

CREATE FUNCTION opengeni_private.read_archived_session_import_batch(
  p_account uuid,p_workspace uuid,p_session uuid,p_import text,p_subject text,p_batch text
) RETURNS TABLE(request_hash text,event_offset integer,event_count integer,next_offset integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'import batch scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session
    AND imported_archive_import_id=p_import AND imported_archive_subject_id=p_subject
    AND (visibility='workspace_shared' OR session_private_actor_visible(account_id,workspace_id,owner_organization_membership_id,owner_subject_id))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT b.request_hash,b.event_offset,b.event_count,b.next_offset
    FROM opengeni_private.session_import_batches b WHERE b.account_id=p_account AND b.workspace_id=p_workspace
      AND b.session_id=p_session AND b.subject_id=p_subject AND b.batch_id=p_batch;
END $$;
CREATE FUNCTION opengeni_private.record_archived_session_import_batch(
  p_account uuid,p_workspace uuid,p_session uuid,p_import text,p_subject text,p_batch text,
  p_hash text,p_offset integer,p_count integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE archive_offset integer;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'import batch scope mismatch' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_count IS NULL OR p_count NOT BETWEEN 1 AND 100
    OR p_offset::bigint+p_count>2147483647 OR p_batch IS NULL OR octet_length(p_batch) NOT BETWEEN 1 AND 800
    OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid import batch' USING ERRCODE='22023'; END IF;
  SELECT imported_archive_next_offset INTO archive_offset FROM sessions
    WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session
      AND imported_archive_import_id=p_import AND imported_archive_subject_id=p_subject
      AND (visibility='workspace_shared' OR session_private_actor_visible(account_id,workspace_id,owner_organization_membership_id,owner_subject_id))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import unavailable' USING ERRCODE='42501'; END IF;
  IF archive_offset<>p_offset THEN RAISE EXCEPTION 'import prefix mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO opengeni_private.session_import_batches(
    account_id,workspace_id,session_id,batch_id,subject_id,request_hash,event_offset,event_count,next_offset
  ) VALUES(p_account,p_workspace,p_session,p_batch,p_subject,p_hash,p_offset,p_count,p_offset+p_count);
  UPDATE sessions SET imported_archive_next_offset=p_offset+p_count
    WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.read_archived_session_import_batch(uuid,uuid,uuid,text,text,text),
  opengeni_private.record_archived_session_import_batch(uuid,uuid,uuid,text,text,text,text,integer,integer) FROM PUBLIC;
DO $$
DECLARE data_schema text:=current_schema(); recipient record;
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.read_archived_session_import_batch(uuid,uuid,uuid,text,text,text) SET search_path=pg_catalog,%I,pg_temp',data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.record_archived_session_import_batch(uuid,uuid,uuid,text,text,text,text,integer,integer) SET search_path=pg_catalog,%I,pg_temp',data_schema);
  FOR recipient IN SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname=data_schema AND c.relname='sessions' AND acl.privilege_type='INSERT' AND acl.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.session_import_batches FROM %I',recipient.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.read_archived_session_import_batch(uuid,uuid,uuid,text,text,text),opengeni_private.record_archived_session_import_batch(uuid,uuid,uuid,text,text,text,text,integer,integer) TO %I',recipient.rolname);
  END LOOP;
END $$;

CREATE FUNCTION guard_imported_archive_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Old fork/child writers must not turn historical input into executable
  -- content. This is a source guard, not just a guard on the destination marker.
  IF TG_OP = 'INSERT' OR
    (NEW.forked_from_session_id, NEW.parent_session_id) IS DISTINCT FROM
    (OLD.forked_from_session_id, OLD.parent_session_id) THEN
    IF EXISTS (SELECT 1 FROM sessions source WHERE source.account_id = NEW.account_id
      AND source.id IN (NEW.forked_from_session_id, NEW.parent_session_id)
      AND source.imported_archive_import_id IS NOT NULL FOR NO KEY UPDATE) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.imported_archive_import_id IS NOT NULL AND
    (NEW.imported_archive_import_id, NEW.imported_archive_imported_at,
      NEW.imported_archive_request_hash, NEW.imported_archive_subject_id)
    IS DISTINCT FROM
    (OLD.imported_archive_import_id, OLD.imported_archive_imported_at,
      OLD.imported_archive_request_hash, OLD.imported_archive_subject_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  IF NEW.imported_archive_import_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.imported_archive_import_id IS NULL) THEN
    IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_history_items WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_workflow_wake_outbox WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_events WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_imported_archive_identity() FROM PUBLIC;
CREATE TRIGGER sessions_imported_archive_identity_guard
  BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_imported_archive_identity();

-- Old API/control/turn binaries cannot execute an imported archive during a
-- rolling deployment. Lock the session so admission and marker installation
-- cannot race; the normal writers already own the workspace -> session prefix.
CREATE FUNCTION refuse_imported_archive_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE archive_id text;
BEGIN
  SELECT imported_archive_import_id INTO archive_id FROM sessions
    WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id FOR NO KEY UPDATE;
  IF archive_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION refuse_imported_archive_execution() FROM PUBLIC;
CREATE TRIGGER session_turns_imported_archive_guard
  BEFORE INSERT OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();
CREATE TRIGGER session_history_items_imported_archive_guard
  BEFORE INSERT OR UPDATE ON session_history_items FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();
CREATE TRIGGER session_goals_imported_archive_guard
  BEFORE INSERT OR UPDATE ON session_goals FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();
CREATE TRIGGER session_workflow_wake_imported_archive_guard
  BEFORE INSERT OR UPDATE ON session_workflow_wake_outbox FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

-- Keep the existing attachment lifecycle as the only authority writer. A NULL
-- turn is permitted only for the verified human's immutable imported archive;
-- its canonical event is the acceptance anchor, never a synthetic input turn.
CREATE OR REPLACE FUNCTION opengeni_private.accept_session_file_attachments(p_account uuid,p_workspace uuid,p_session uuid,p_turn uuid,p_subject text,p_files uuid[])
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
  IF p_turn IS NULL THEN
    PERFORM 1 FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_session
      AND imported_archive_import_id IS NOT NULL AND imported_archive_subject_id=p_subject
      AND created_by_kind='subject' AND created_by_subject_id=p_subject;
    IF NOT FOUND THEN RAISE EXCEPTION 'attachment requires accepted human archive' USING ERRCODE='42501'; END IF;
    INSERT INTO opengeni_private.session_file_attachments(account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id)
      SELECT p_account,p_workspace,p_session,f.id,p_subject,accepted.id FROM files f
      CROSS JOIN LATERAL (
        SELECT e.id FROM session_events e
        WHERE e.account_id=p_account AND e.workspace_id=p_workspace AND e.session_id=p_session
          AND EXISTS (SELECT 1 FROM (
            SELECT jsonb_path_query(e.payload,'lax $.**.fileId') AS ref
            UNION ALL SELECT jsonb_path_query(e.payload,'lax $.**.fileIds[*]') AS ref
          ) refs WHERE lower(refs.ref#>>'{}')=f.id::text)
        ORDER BY e.sequence LIMIT 1
      ) accepted
      WHERE f.account_id=p_account AND f.workspace_id=p_workspace AND f.id=ANY(p_files) AND f.status='ready'
        AND p_subject=ANY(f.private_owner_subject_ids)
        AND EXISTS (SELECT 1 FROM file_uploads u WHERE u.account_id=p_account AND u.workspace_id=p_workspace
          AND u.file_id=f.id AND u.status='completed' AND u.private_file_owner_subject_id=p_subject)
        AND google_drive_file_authorized(p_account,p_workspace,p_subject,f.id)
      ON CONFLICT DO NOTHING;
    RETURN;
  END IF;
  SELECT t.* INTO accepted_turn FROM session_turns t WHERE t.account_id=p_account AND t.workspace_id=p_workspace
    AND t.session_id=p_session AND t.id=p_turn AND t.source IN ('user','api')
    AND t.initiator_kind='subject' AND t.initiator_subject_id=p_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'attachment requires accepted human input' USING ERRCODE='42501'; END IF;
  -- Preserve the ordinary accepted-input path exactly, including its completed
  -- original-upload gate; provider originals never gain a session grant.
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
DO $$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.accept_session_file_attachments(uuid,uuid,uuid,uuid,text,uuid[]) SET search_path=pg_catalog,%I,pg_temp',data_schema);
  EXECUTE format('ALTER FUNCTION guard_imported_archive_identity() SET search_path=pg_catalog,%I,pg_temp',data_schema);
  EXECUTE format('ALTER FUNCTION refuse_imported_archive_execution() SET search_path=pg_catalog,%I,pg_temp',data_schema);
END $$;