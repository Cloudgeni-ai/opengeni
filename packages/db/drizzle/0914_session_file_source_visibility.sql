-- deployment-mode: maintenance
-- maintenance-justification: the new restrictive file read policy requires every producer to stamp source provenance before writes resume.
-- online-safety-exception: maintenance-unbatched-data: Provenance reconciliation and restrictive policy activation must share one maintenance transaction.
-- Session-produced files inherit the live source chat's read boundary unless
-- their owner explicitly shares that file. Ambiguous historical shared upload
-- originals require a private operator decision before activation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE files ADD COLUMN source_session_id uuid;
ALTER TABLE files ADD COLUMN source_session_owner_subject_id text;
ALTER TABLE files ADD COLUMN source_session_audience_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN source_session_provenance_missing boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN source_session_shared_unrestricted boolean NOT NULL DEFAULT false;
ALTER TABLE video_generation_operations ADD COLUMN source_session_id_snapshot uuid;
ALTER TABLE video_generation_operations ADD COLUMN source_session_owner_subject_id text;
ALTER TABLE video_generation_operations ADD COLUMN source_session_shared_unrestricted boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN source_file_has_inherited_audience boolean NOT NULL DEFAULT false;
ALTER TABLE document_chunks ADD COLUMN source_file_has_inherited_audience boolean NOT NULL DEFAULT false;
CREATE INDEX files_source_session_idx ON files(workspace_id, source_session_id)
  WHERE source_session_id IS NOT NULL;

-- A hard connection deletion must not erase a private Slack audience while
-- its session survives. Normal disconnect revokes credentials in place.
DO $slack_connection_fk$
DECLARE prior_constraint text;
BEGIN
  SELECT constraint_row.conname INTO prior_constraint FROM pg_constraint constraint_row
    JOIN pg_attribute column_row ON column_row.attrelid = constraint_row.conrelid
      AND column_row.attnum = ANY(constraint_row.conkey)
    WHERE constraint_row.conrelid = 'slack_interactions'::regclass
      AND constraint_row.confrelid = 'connections'::regclass
      AND constraint_row.contype = 'f' AND column_row.attname = 'connection_id'
    LIMIT 1;
  IF prior_constraint IS NULL THEN
    RAISE EXCEPTION 'Slack connection foreign key unavailable' USING ERRCODE='55000';
  END IF;
  EXECUTE format('ALTER TABLE slack_interactions DROP CONSTRAINT %I', prior_constraint);
END $slack_connection_fk$;
ALTER TABLE slack_interactions ADD CONSTRAINT slack_interactions_connection_guard_fkey
  FOREIGN KEY (connection_id) REFERENCES connections(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Intersect every private source owner. A missing or conflicting owner leaves
-- retained bytes unavailable rather than selecting one weaker audience.
CREATE FUNCTION file_source_owner_snapshot_0913(
  private_owner text, site_owner text, slack_owner text, memory_owner text
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $body$
  SELECT CASE WHEN count(DISTINCT owner) = 1 THEN nullif(min(owner), '') END
  FROM unnest(ARRAY[private_owner, site_owner, slack_owner, memory_owner]) owner
  WHERE owner IS NOT NULL
$body$;

-- A file has one immutable producer. A conflicting historical receipt needs
-- operator review; choosing either chat would leave a possible access path.
ALTER TABLE files NO FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_image_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_video_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE retained_screenshot_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.sandbox_file_publications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE interaction_resource_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE browser_session_retained_downloads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE browser_session_associations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE video_generation_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks NO FORCE ROW LEVEL SECURITY;
CREATE TEMP TABLE session_file_sources_0913 ON COMMIT DROP AS
  SELECT account_id, workspace_id, file_id, min(session_id::text)::uuid AS session_id,
    count(DISTINCT session_id) AS source_count
  FROM (
    SELECT account_id, workspace_id, artifact_id AS file_id, session_id
      FROM generated_image_artifacts WHERE session_id IS NOT NULL
    UNION ALL
    SELECT account_id, workspace_id, primary_file_id, session_id
      FROM generated_video_artifacts WHERE session_id IS NOT NULL
    UNION ALL
    SELECT account_id, workspace_id, artifact_id, session_id
      FROM retained_screenshot_artifacts WHERE session_id IS NOT NULL
    UNION ALL
    SELECT account_id, workspace_id, file_id, source_session_id
      FROM opengeni_private.sandbox_file_publications WHERE source_session_id IS NOT NULL
    UNION ALL
    SELECT account_id, workspace_id, (metadata->>'fileId')::uuid,
      (metadata->>'sourceSessionId')::uuid
      FROM interaction_resource_operations
      WHERE resource_kind = 'browser_download' AND kind = 'save'
        AND metadata->>'fileId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
        AND metadata->>'sourceSessionId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    UNION ALL
    SELECT retained.account_id, retained.workspace_id, retained.file_id, binding.session_id
      FROM browser_session_retained_downloads retained
      JOIN browser_session_associations binding
        ON binding.account_id = retained.account_id
        AND binding.workspace_id = retained.workspace_id
        AND binding.browser_session_id = retained.browser_session_id
        AND binding.relationship = 'created'
  ) sources GROUP BY account_id, workspace_id, file_id;
DO $conflicts$
BEGIN
  IF EXISTS (SELECT 1 FROM session_file_sources_0913 WHERE source_count <> 1) THEN
    RAISE EXCEPTION 'Conflicting file source sessions require review' USING ERRCODE='55000';
  END IF;
END $conflicts$;
UPDATE files f SET source_session_id = source.session_id,
  source_session_owner_subject_id = file_source_owner_snapshot_0913(
    CASE WHEN session_row.visibility = 'user_private' THEN coalesce(session_row.owner_subject_id,'') END,
    CASE WHEN session_row.site_access_root_id IS NOT NULL THEN coalesce(session_row.site_owner_subject_id,'') END,
    (SELECT slack.owning_subject_id FROM slack_interactions slack
      WHERE slack.account_id = session_row.account_id
        AND slack.workspace_id = session_row.workspace_id
        AND slack.session_reservation_id = session_row.root_session_id
        AND slack.visibility = 'private' LIMIT 1),
    CASE WHEN session_row.memory_scope = 'user' THEN coalesce(session_row.scope_subject_id,'') END),
  source_session_shared_unrestricted = (session_row.visibility = 'workspace_shared'
    AND session_row.memory_scope <> 'user'
    AND session_row.site_access_root_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM slack_interactions slack
      WHERE slack.account_id = session_row.account_id
        AND slack.workspace_id = session_row.workspace_id
        AND slack.session_reservation_id = session_row.root_session_id
        AND slack.visibility = 'private'))
  FROM session_file_sources_0913 source JOIN sessions session_row
    ON session_row.account_id = source.account_id
    AND session_row.workspace_id = source.workspace_id AND session_row.id = source.session_id
  WHERE f.account_id = source.account_id AND f.workspace_id = source.workspace_id
    AND f.id = source.file_id;

UPDATE video_generation_operations op SET source_session_id_snapshot = session_row.id,
  source_session_owner_subject_id = file_source_owner_snapshot_0913(
    CASE WHEN session_row.visibility = 'user_private' THEN coalesce(session_row.owner_subject_id,'') END,
    CASE WHEN session_row.site_access_root_id IS NOT NULL THEN coalesce(session_row.site_owner_subject_id,'') END,
    (SELECT slack.owning_subject_id FROM slack_interactions slack
      WHERE slack.account_id = session_row.account_id AND slack.workspace_id = session_row.workspace_id
        AND slack.session_reservation_id = session_row.root_session_id
        AND slack.visibility = 'private' LIMIT 1),
    CASE WHEN session_row.memory_scope = 'user' THEN coalesce(session_row.scope_subject_id,'') END),
  source_session_shared_unrestricted = (session_row.visibility = 'workspace_shared'
    AND session_row.memory_scope <> 'user' AND session_row.site_access_root_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM slack_interactions slack
      WHERE slack.account_id = session_row.account_id AND slack.workspace_id = session_row.workspace_id
        AND slack.session_reservation_id = session_row.root_session_id
        AND slack.visibility = 'private'))
  FROM sessions session_row WHERE op.account_id = session_row.account_id
    AND op.workspace_id = session_row.workspace_id AND op.session_id = session_row.id;

-- Historical media receipts survive session deletion, but their session_id
-- becomes NULL. Never treat those unknown origins as ordinary uploads.
UPDATE files f SET source_session_provenance_missing = true,
  source_session_owner_subject_id = coalesce(
    (SELECT a.owner_subject_id FROM opengeni_private.file_source_adjudications a
      WHERE a.file_id = f.id AND a.decision = 'owner_only'),
    nullif(trim(f.private_owner_subject_ids[1]), ''),
    nullif(trim(f.owner_subject_id), ''))
  WHERE f.source_session_id IS NULL AND EXISTS (
    SELECT 1 FROM generated_image_artifacts a WHERE a.artifact_id = f.id AND a.session_id IS NULL
    UNION ALL
    SELECT 1 FROM generated_video_artifacts a WHERE a.primary_file_id = f.id AND a.session_id IS NULL
    UNION ALL
    SELECT 1 FROM retained_screenshot_artifacts a WHERE a.artifact_id = f.id AND a.session_id IS NULL
    UNION ALL
    SELECT 1 FROM opengeni_private.sandbox_file_publications a
      WHERE a.file_id = f.id AND a.source_session_id IS NULL
  );

-- Legacy share audit records do not store principal kind. Even an audit with
-- the File owner's subject can have come from an agent delegated that subject.
-- A private operator decision is the only migration-time share proof.
UPDATE files f SET source_session_audience_explicit = true
  FROM opengeni_private.file_source_adjudications a
  WHERE a.file_id = f.id AND a.decision = 'human_shared'
    AND (f.source_session_id IS NOT NULL OR f.source_session_provenance_missing
    OR f.object_key ~ '^workspaces/[^/]+/files/[^/]+/(original|sandbox|generated)/')
    AND f.private_owner_subject_ids IS NULL
    AND f.object_key !~ '^workspaces/[^/]+/files/[^/]+/(retained|tool-results)/';

DO $unverified_legacy_share_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files f
    WHERE (f.source_session_id IS NOT NULL OR f.source_session_provenance_missing)
      AND f.private_owner_subject_ids IS NULL
      AND EXISTS (SELECT 1 FROM audit_events e
        WHERE e.account_id = f.account_id AND e.workspace_id = f.workspace_id
          AND e.action = 'file.visibility.changed'
          AND e.target_type = 'workspace_file' AND e.target_id = f.id::text
          AND e.metadata->>'to' = 'workspace')
      AND NOT EXISTS (SELECT 1 FROM opengeni_private.file_source_adjudications a
        WHERE a.file_id = f.id AND a.decision IN ('human_shared', 'owner_only')))
  THEN
    RAISE EXCEPTION 'Legacy file shares require operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $unverified_legacy_share_preflight$;

-- The original upload ledger lacks principal kind and source session. A
-- workspace-visible original could be a person's intentional shared upload or
-- an agent's private-chat output. Do not silently change either audience.
DO $ambiguous_shared_upload_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files f
    WHERE f.source_session_id IS NULL AND NOT f.source_session_provenance_missing
      AND f.private_owner_subject_ids IS NULL
      AND NOT f.source_session_audience_explicit
      AND f.object_key ~ '^workspaces/[^/]+/files/[^/]+/original/'
      AND NOT EXISTS (SELECT 1 FROM opengeni_private.file_source_adjudications a
        WHERE a.file_id = f.id AND a.decision IN ('human_shared', 'owner_only')))
  THEN
    RAISE EXCEPTION 'Ambiguous shared legacy uploads require operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $ambiguous_shared_upload_preflight$;

-- Private originals can also back shared Documents. Their provenance is
-- ambiguous: only an attested ordinary upload may keep independent Document
-- access. An attested session output remains owner-only.
DO $ambiguous_private_upload_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files f
    WHERE f.source_session_id IS NULL AND NOT f.source_session_provenance_missing
      AND f.private_owner_subject_ids IS NOT NULL
      AND f.object_key ~ '^workspaces/[^/]+/files/[^/]+/original/'
      AND NOT EXISTS (SELECT 1 FROM opengeni_private.file_source_adjudications a
        WHERE a.file_id = f.id AND a.decision IN ('ordinary_upload', 'owner_only')))
  THEN
    RAISE EXCEPTION 'Ambiguous private legacy uploads require operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $ambiguous_private_upload_preflight$;

-- A contradictory private owner cannot be resolved by selecting either one.
DO $private_owner_conflict_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files f JOIN opengeni_private.file_source_adjudications a
      ON a.file_id = f.id AND a.decision = 'owner_only'
    WHERE f.source_session_id IS NULL AND f.private_owner_subject_ids IS NOT NULL
      AND a.owner_subject_id IS NOT NULL
      AND (cardinality(f.private_owner_subject_ids) <> 1
        OR f.private_owner_subject_ids[1] IS DISTINCT FROM a.owner_subject_id))
  THEN
    RAISE EXCEPTION 'Legacy private file owner conflicts with operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $private_owner_conflict_preflight$;

-- A verified ordinary upload retains its existing audience. Every attested
-- session-produced original is narrowed to its verified or recorded owner.
UPDATE files f SET source_session_provenance_missing = true,
  source_session_owner_subject_id = coalesce(
    (SELECT a.owner_subject_id FROM opengeni_private.file_source_adjudications a
      WHERE a.file_id = f.id AND a.decision = 'owner_only'),
    nullif(trim(f.private_owner_subject_ids[1]), ''),
    nullif(trim(f.owner_subject_id), ''))
  WHERE f.source_session_id IS NULL AND NOT f.source_session_provenance_missing
    AND NOT f.source_session_audience_explicit
    AND f.object_key ~ '^workspaces/[^/]+/files/[^/]+/original/'
    AND EXISTS (SELECT 1 FROM opengeni_private.file_source_adjudications a
      WHERE a.file_id = f.id AND a.decision = 'owner_only');

-- Old spilled results and partially published generated/sandbox output may
-- have no durable source receipt. Their object-key class still proves they
-- were session-produced, so never treat them as ordinary shared uploads.
UPDATE files f SET source_session_provenance_missing = true,
  source_session_owner_subject_id = coalesce(
    (SELECT a.owner_subject_id FROM opengeni_private.file_source_adjudications a
      WHERE a.file_id = f.id AND a.decision = 'owner_only'),
    nullif(trim(f.private_owner_subject_ids[1]), ''),
    nullif(trim(f.owner_subject_id), ''))
  WHERE f.source_session_id IS NULL AND NOT f.source_session_provenance_missing
    AND f.object_key ~ '^workspaces/[^/]+/files/[^/]+/(tool-results|sandbox|generated|retained)/';

DO $multiple_private_owners_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files
    WHERE source_session_provenance_missing
      AND private_owner_subject_ids IS NOT NULL
      AND cardinality(private_owner_subject_ids) <> 1)
  THEN
    RAISE EXCEPTION 'Legacy private file has ambiguous owners'
      USING ERRCODE='55000';
  END IF;
END $multiple_private_owners_preflight$;

-- The attested owner controls an old shared File even when the legacy stored
-- owner differs. Set the durable owner under the maintenance lock; the runtime
-- trigger intentionally forbids such ownership changes.
ALTER TABLE files DISABLE TRIGGER files_personal_owner_immutable;
UPDATE files f SET owner_subject_id = f.private_owner_subject_ids[1]
  WHERE f.source_session_provenance_missing
    AND f.private_owner_subject_ids IS NOT NULL
    AND cardinality(f.private_owner_subject_ids) = 1
    AND f.owner_subject_id IS DISTINCT FROM f.private_owner_subject_ids[1];
UPDATE files f SET owner_subject_id = a.owner_subject_id
  FROM opengeni_private.file_source_adjudications a
  WHERE a.file_id = f.id AND a.decision = 'owner_only'
    AND a.owner_subject_id IS NOT NULL
    AND f.owner_subject_id IS DISTINCT FROM a.owner_subject_id
    AND f.private_owner_subject_ids IS NULL
    AND f.source_session_provenance_missing;
ALTER TABLE files ENABLE TRIGGER files_personal_owner_immutable;

-- Existing indexed text follows the originating File. The two independent
-- tables need the same flag because chunks can be read without their parent.
UPDATE documents d SET source_file_has_inherited_audience = true
  FROM files f WHERE d.account_id = f.account_id AND d.file_id = f.id
    AND (f.source_session_id IS NOT NULL OR f.source_session_provenance_missing);
UPDATE document_chunks c SET source_file_has_inherited_audience = true
  FROM documents d WHERE c.account_id = d.account_id AND c.document_id = d.id
    AND d.source_file_has_inherited_audience;

-- A source chat can become private after an ownerless shared File was made.
-- Its verified source owner may explicitly share that File, acquiring the
-- durable File owner in the same change so they can later limit it again.
CREATE OR REPLACE FUNCTION knowledge_file_owner_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE actor text := nullif(current_setting('opengeni.private_file_owner',true),'');
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'File ownership is immutable; share an explicitly authorized copy' USING ERRCODE='55000';
  END IF;
  IF NEW.private_owner_subject_ids IS NOT DISTINCT FROM OLD.private_owner_subject_ids THEN
    IF NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id THEN
      IF OLD.owner_subject_id IS NULL AND actor IS NOT NULL
        AND NEW.owner_subject_id = actor
        AND OLD.source_session_owner_subject_id = actor
        AND (OLD.source_session_id IS NOT NULL OR OLD.source_session_provenance_missing)
        AND NOT OLD.source_session_audience_explicit
        AND NEW.source_session_audience_explicit
        AND OLD.status = 'ready' AND NEW.status = 'ready'
        AND OLD.object_key !~ '^workspaces/[^/]+/files/[^/]+/(retained|tool-results)/'
      THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'File ownership is immutable; share an explicitly authorized copy' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF actor IS NOT NULL AND OLD.status = 'ready' AND NEW.status = 'ready'
    AND OLD.object_key !~ '^workspaces/[^/]+/files/[^/]+/(retained|tool-results)/' THEN
    IF OLD.private_owner_subject_ids IS NOT NULL AND NEW.private_owner_subject_ids IS NULL
      AND actor = ANY(OLD.private_owner_subject_ids)
      AND NEW.owner_subject_id IS NOT DISTINCT FROM coalesce(OLD.owner_subject_id, actor)
    THEN RETURN NEW; END IF;
    IF OLD.private_owner_subject_ids IS NULL AND NEW.private_owner_subject_ids = ARRAY[actor]
      AND OLD.owner_subject_id = actor AND NEW.owner_subject_id = actor
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Only a file''s owner can change who can open it' USING ERRCODE='55000';
END $body$;

-- Do not silently strand a historical file with no owner able to re-share it.
-- Deployment must adjudicate these records from trusted private evidence.
DO $ownerless_legacy_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM files
    WHERE source_session_provenance_missing AND NOT source_session_audience_explicit
      AND nullif(trim(source_session_owner_subject_id), '') IS NULL)
  THEN
    RAISE EXCEPTION 'Ownerless legacy file provenance requires operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $ownerless_legacy_preflight$;
DO $video_source_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM video_generation_operations
    WHERE status IN ('preparing','prepared','accepted','submission_uncertain','provider_started','retaining')
      AND source_session_id_snapshot IS NULL AND private_file_owner_subject_id IS NULL)
  THEN
    RAISE EXCEPTION 'Active video provenance requires operator adjudication'
      USING ERRCODE='55000';
  END IF;
END $video_source_preflight$;

ALTER TABLE opengeni_private.sandbox_file_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE retained_screenshot_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_video_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_image_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions FORCE ROW LEVEL SECURITY;
ALTER TABLE interaction_resource_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE browser_session_retained_downloads FORCE ROW LEVEL SECURITY;
ALTER TABLE browser_session_associations FORCE ROW LEVEL SECURITY;
ALTER TABLE video_generation_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;

-- Runtime File provenance is fixed at insert. Owner-run maintenance may repair
-- it, and the companion trigger then narrows any already indexed Document.
CREATE FUNCTION freeze_file_source_provenance_0914() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF (OLD.source_session_id IS DISTINCT FROM NEW.source_session_id
    OR OLD.source_session_provenance_missing IS DISTINCT FROM NEW.source_session_provenance_missing)
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
  THEN RAISE EXCEPTION 'File source provenance is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER freeze_file_source_provenance_0914
  BEFORE UPDATE OF source_session_id, source_session_provenance_missing ON files
  FOR EACH ROW EXECUTE FUNCTION freeze_file_source_provenance_0914();

CREATE FUNCTION sync_document_file_source_0914() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE source_row record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.file_id IS DISTINCT FROM OLD.file_id THEN
    RAISE EXCEPTION 'Document source File is immutable' USING ERRCODE='55000';
  END IF;
  SELECT source_session_id, source_session_provenance_missing,
    source_session_audience_explicit INTO source_row
    FROM files WHERE account_id = NEW.account_id AND id = NEW.file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document source File unavailable' USING ERRCODE='42501'; END IF;
  NEW.source_file_has_inherited_audience :=
    source_row.source_session_id IS NOT NULL OR source_row.source_session_provenance_missing;
  IF NEW.source_file_has_inherited_audience
    AND NOT source_row.source_session_audience_explicit
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
  THEN RAISE EXCEPTION 'Document source requires independent File sharing'
    USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $body$;
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION sync_document_file_source_0914() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
CREATE TRIGGER sync_document_file_source_0914
  BEFORE INSERT OR UPDATE OF file_id, source_file_has_inherited_audience ON documents
  FOR EACH ROW EXECUTE FUNCTION sync_document_file_source_0914();

CREATE FUNCTION sync_document_chunk_file_source_0914() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE inherited boolean;
BEGIN
  SELECT source_file_has_inherited_audience INTO inherited FROM documents
    WHERE account_id = NEW.account_id AND id = NEW.document_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document chunk source unavailable' USING ERRCODE='42501'; END IF;
  NEW.source_file_has_inherited_audience := inherited;
  RETURN NEW;
END $body$;
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION sync_document_chunk_file_source_0914() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
CREATE TRIGGER sync_document_chunk_file_source_0914
  BEFORE INSERT OR UPDATE OF document_id, file_id, source_file_has_inherited_audience ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION sync_document_chunk_file_source_0914();

CREATE FUNCTION sync_documents_for_file_source_0914() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  UPDATE documents SET source_file_has_inherited_audience =
    (NEW.source_session_id IS NOT NULL OR NEW.source_session_provenance_missing)
    WHERE account_id = NEW.account_id AND file_id = NEW.id;
  UPDATE document_chunks SET source_file_has_inherited_audience =
    (NEW.source_session_id IS NOT NULL OR NEW.source_session_provenance_missing)
    WHERE account_id = NEW.account_id AND file_id = NEW.id;
  RETURN NEW;
END $body$;
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION sync_documents_for_file_source_0914() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
CREATE TRIGGER sync_documents_for_file_source_0914
  AFTER UPDATE OF source_session_id, source_session_provenance_missing ON files
  FOR EACH ROW WHEN (OLD.source_session_id IS DISTINCT FROM NEW.source_session_id
    OR OLD.source_session_provenance_missing IS DISTINCT FROM NEW.source_session_provenance_missing)
  EXECUTE FUNCTION sync_documents_for_file_source_0914();

-- Maintenance cutover: a pre-upgrade process must fail closed if restarted
-- after provenance enforcement, including for ordinary-looking originals.
CREATE FUNCTION require_file_provenance_writer_0913() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
    AND current_setting('opengeni.file_provenance_writer_v1', true) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'File writer upgrade required' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER require_file_provenance_writer_0913
  BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION require_file_provenance_writer_0913();

-- A shared chat can later become private (or vice versa). Keep the final
-- owner snapshot for retained files when the source chat is deleted.
CREATE FUNCTION sync_file_source_session_owner_0913() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  UPDATE files SET source_session_owner_subject_id = file_source_owner_snapshot_0913(
    CASE WHEN NEW.visibility = 'user_private' THEN coalesce(NEW.owner_subject_id,'') END,
    CASE WHEN NEW.site_access_root_id IS NOT NULL THEN coalesce(NEW.site_owner_subject_id,'') END,
    (SELECT slack.owning_subject_id FROM slack_interactions slack
      WHERE slack.account_id = NEW.account_id AND slack.workspace_id = NEW.workspace_id
        AND slack.session_reservation_id = NEW.root_session_id
        AND slack.visibility = 'private' LIMIT 1),
    CASE WHEN NEW.memory_scope = 'user' THEN coalesce(NEW.scope_subject_id,'') END),
    source_session_shared_unrestricted = (NEW.visibility = 'workspace_shared'
      AND NEW.memory_scope <> 'user'
      AND NEW.site_access_root_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM slack_interactions slack
        WHERE slack.account_id = NEW.account_id AND slack.workspace_id = NEW.workspace_id
          AND slack.session_reservation_id = NEW.root_session_id
          AND slack.visibility = 'private'))
  WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
    AND source_session_id = NEW.id;
  UPDATE video_generation_operations SET source_session_owner_subject_id = file_source_owner_snapshot_0913(
    CASE WHEN NEW.visibility = 'user_private' THEN coalesce(NEW.owner_subject_id,'') END,
    CASE WHEN NEW.site_access_root_id IS NOT NULL THEN coalesce(NEW.site_owner_subject_id,'') END,
    (SELECT slack.owning_subject_id FROM slack_interactions slack
      WHERE slack.account_id = NEW.account_id AND slack.workspace_id = NEW.workspace_id
        AND slack.session_reservation_id = NEW.root_session_id
        AND slack.visibility = 'private' LIMIT 1),
    CASE WHEN NEW.memory_scope = 'user' THEN coalesce(NEW.scope_subject_id,'') END),
    source_session_shared_unrestricted = (NEW.visibility = 'workspace_shared'
      AND NEW.memory_scope <> 'user' AND NEW.site_access_root_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM slack_interactions slack
        WHERE slack.account_id = NEW.account_id AND slack.workspace_id = NEW.workspace_id
          AND slack.session_reservation_id = NEW.root_session_id AND slack.visibility = 'private'))
    WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
      AND source_session_id_snapshot = NEW.id;
  RETURN NEW;
END $body$;
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION sync_file_source_session_owner_0913() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
REVOKE ALL ON FUNCTION sync_file_source_session_owner_0913() FROM PUBLIC;
CREATE TRIGGER sync_file_source_session_owner_0913
  AFTER UPDATE OF visibility, owner_subject_id, memory_scope, scope_subject_id, site_access_root_id ON sessions
  FOR EACH ROW WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility
    OR OLD.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id
    OR OLD.memory_scope IS DISTINCT FROM NEW.memory_scope
    OR OLD.scope_subject_id IS DISTINCT FROM NEW.scope_subject_id
    OR OLD.site_access_root_id IS DISTINCT FROM NEW.site_access_root_id)
  EXECUTE FUNCTION sync_file_source_session_owner_0913();

-- Slack interaction audience is frozen when created. An out-of-band change
-- would invalidate retained-file snapshots after the source chat is deleted.
CREATE FUNCTION freeze_slack_source_audience_0913() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'Slack interaction audience is immutable' USING ERRCODE='55000';
END $body$;
CREATE TRIGGER freeze_slack_source_audience_0913
  BEFORE UPDATE OF visibility, owning_subject_id ON slack_interactions
  FOR EACH ROW WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility
    OR OLD.owning_subject_id IS DISTINCT FROM NEW.owning_subject_id)
  EXECUTE FUNCTION freeze_slack_source_audience_0913();

-- A hidden live chat must never look deleted to a file-read policy. Check
-- existence under the system's empty-subject posture, then restore the actor.
CREATE FUNCTION file_source_session_exists_0913(p_account uuid, p_workspace uuid, p_session uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $body$
DECLARE
  previous_subject text := current_setting('opengeni.subject_id', true);
  found boolean := false;
BEGIN
  IF p_session IS NULL THEN RETURN false; END IF;
  PERFORM set_config('opengeni.subject_id', '', true);
  SELECT EXISTS (SELECT 1 FROM sessions source_session
    WHERE source_session.account_id = p_account
      AND source_session.workspace_id = p_workspace
      AND source_session.id = p_session) INTO found;
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
  RETURN found;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
  RAISE;
END $body$;
DO $search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION file_source_session_exists_0913(uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
REVOKE ALL ON FUNCTION file_source_session_exists_0913(uuid,uuid,uuid) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION file_source_session_exists_0913(uuid,uuid,uuid) TO opengeni_app;
  END IF;
END $grant$;

CREATE POLICY files_source_session_visible ON files AS RESTRICTIVE FOR SELECT USING (
  opengeni_private.session_file_read_allowed(account_id,workspace_id,id)
  OR (source_session_id IS NULL AND NOT source_session_provenance_missing)
  OR source_session_audience_explicit
  OR EXISTS (SELECT 1 FROM sessions source_session
    WHERE source_session.account_id = files.account_id
      AND source_session.workspace_id = files.workspace_id
      AND source_session.id = files.source_session_id
      AND (NOT EXISTS (SELECT 1 FROM slack_interactions slack
          WHERE slack.account_id = files.account_id AND slack.workspace_id = files.workspace_id
            AND slack.session_reservation_id = source_session.root_session_id
            AND slack.visibility = 'private')
        OR EXISTS (SELECT 1 FROM slack_interactions slack
          WHERE slack.account_id = files.account_id AND slack.workspace_id = files.workspace_id
            AND slack.session_reservation_id = source_session.root_session_id
            AND slack.visibility = 'private'
            AND ((nullif(current_setting('opengeni.agent_root_session_id', true), '') IS NULL
                AND slack.owning_subject_id = nullif(current_setting('opengeni.subject_id', true), ''))
              OR (nullif(current_setting('opengeni.agent_root_session_id', true), '') =
                  source_session.root_session_id::text))))
      AND (source_session.site_access_root_id IS NULL
        OR (nullif(current_setting('opengeni.subject_id', true), '') IS NOT NULL
          AND (nullif(current_setting('opengeni.agent_root_session_id', true), '') IS NULL
            OR source_session.root_session_id::text =
              nullif(current_setting('opengeni.agent_root_session_id', true), ''))))
      AND (source_session.visibility = 'workspace_shared'
        OR (nullif(current_setting('opengeni.subject_id', true), '') IS NOT NULL
          AND (nullif(current_setting('opengeni.agent_root_session_id', true), '') IS NULL
            OR source_session.root_session_id::text =
              nullif(current_setting('opengeni.agent_root_session_id', true), ''))))
      AND (source_session.memory_scope <> 'user'
        OR source_session.scope_subject_id =
          nullif(current_setting('opengeni.subject_id', true), '')
        OR source_session.root_session_id::text =
          nullif(current_setting('opengeni.agent_root_session_id', true), ''))
      -- A deleted Slack connection must not erase a private audience snapshot.
      AND (files.source_session_shared_unrestricted
        OR source_session.visibility = 'user_private'
        OR source_session.site_access_root_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM slack_interactions slack
          WHERE slack.account_id = files.account_id AND slack.workspace_id = files.workspace_id
            AND slack.session_reservation_id = source_session.root_session_id
            AND slack.visibility = 'private')
        OR files.source_session_owner_subject_id =
          nullif(current_setting('opengeni.subject_id', true), '')
        OR source_session.root_session_id::text =
          nullif(current_setting('opengeni.agent_root_session_id', true), '')))
  OR ((source_session_owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
      OR (source_session_owner_subject_id =
          nullif(current_setting('opengeni.private_file_owner', true), '')
        AND source_session_owner_subject_id = ANY(private_owner_subject_ids)))
    AND NOT source_session_shared_unrestricted
    AND nullif(current_setting('opengeni.agent_root_session_id', true), '') IS NULL
    AND (source_session_id IS NULL OR NOT file_source_session_exists_0913(
      account_id, workspace_id, source_session_id)))
  -- A private File row can be invisible to the session-update trigger's
  -- invoker. After deletion, never trust its stale shared snapshot.
  OR (source_session_id IS NOT NULL AND source_session_shared_unrestricted
    AND (private_owner_subject_ids IS NULL
      OR (cardinality(private_owner_subject_ids) = 1
        AND private_owner_subject_ids[1] =
          nullif(current_setting('opengeni.private_file_owner', true), '')))
    AND nullif(current_setting('opengeni.agent_root_session_id', true), '') IS NULL
    AND NOT file_source_session_exists_0913(account_id, workspace_id, source_session_id))
);

CREATE POLICY documents_file_source_visible ON documents AS RESTRICTIVE FOR SELECT USING (
  NOT source_file_has_inherited_audience OR EXISTS (
    SELECT 1 FROM files source_file WHERE source_file.account_id = documents.account_id
      AND source_file.id = documents.file_id AND source_file.status = 'ready'
      AND source_file.source_session_audience_explicit
      AND source_file.private_owner_subject_ids IS NULL)
);
CREATE POLICY document_chunks_file_source_visible ON document_chunks AS RESTRICTIVE FOR SELECT USING (
  NOT source_file_has_inherited_audience OR EXISTS (
    SELECT 1 FROM files source_file WHERE source_file.account_id = document_chunks.account_id
      AND source_file.id = document_chunks.file_id AND source_file.status = 'ready'
      AND source_file.source_session_audience_explicit
      AND source_file.private_owner_subject_ids IS NULL)
);

-- The original-file resolver is a definer and bypasses Document RLS. Preserve
-- its authority checks, then apply the same independent-share condition.
ALTER FUNCTION resolve_document_original_file(uuid, uuid, text, uuid)
  RENAME TO resolve_document_original_file_authority_0914;
REVOKE ALL ON FUNCTION resolve_document_original_file_authority_0914(uuid, uuid, text, uuid)
  FROM PUBLIC;
DO $document_resolver_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON FUNCTION resolve_document_original_file_authority_0914(uuid, uuid, text, uuid)
      FROM opengeni_app;
  END IF;
END $document_resolver_grant$;
CREATE FUNCTION resolve_document_original_file(
  p_account_id uuid, p_request_workspace_id uuid, p_actor_id text, p_document_id uuid
) RETURNS SETOF files LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $body$
  SELECT original_file.*
  FROM resolve_document_original_file_authority_0914(
    p_account_id, p_request_workspace_id, p_actor_id, p_document_id
  ) original_file
  JOIN documents source_document ON source_document.id = p_document_id
    AND source_document.account_id = original_file.account_id
    AND source_document.file_id = original_file.id
  WHERE NOT source_document.source_file_has_inherited_audience
    OR (original_file.status = 'ready'
      AND original_file.source_session_audience_explicit
      AND original_file.private_owner_subject_ids IS NULL)
$body$;
REVOKE ALL ON FUNCTION resolve_document_original_file(uuid, uuid, text, uuid) FROM PUBLIC;
DO $document_resolver_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_document_original_file(uuid, uuid, text, uuid)
      TO opengeni_app;
  END IF;
END $document_resolver_grant$;

-- Knowledge stores a durable text copy. A source-chat File may be retained
-- there only after the File owner explicitly gives it independent access.
CREATE OR REPLACE FUNCTION knowledge_document_visible(p_document uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $body$
  SELECT EXISTS(SELECT 1 FROM documents d
    WHERE d.id=p_document AND d.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
      AND d.status='ready'
      AND (NOT d.source_file_has_inherited_audience OR EXISTS (
        SELECT 1 FROM files source_file WHERE source_file.account_id=d.account_id
          AND source_file.id=d.file_id AND source_file.status='ready'
          AND source_file.source_session_audience_explicit
          AND source_file.private_owner_subject_ids IS NULL))
      AND ((current_setting('opengeni.knowledge_actor_kind',true)='human' OR (current_setting('opengeni.knowledge_actor_kind',true)='source_preparation' AND d.id::text=current_setting('opengeni.knowledge_prepared_document',true))) OR d.agent_access)
      AND (d.authority_kind='organization'
        OR (d.authority_kind='workspace' AND d.authority_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
        OR (d.authority_kind='personal' AND d.authority_subject_id=nullif(current_setting('opengeni.subject_id',true),'')
          AND ((d.authority_id IS NULL AND d.authority_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
            OR (d.authority_id IS NOT NULL AND ((current_setting('opengeni.knowledge_actor_kind',true)='human' OR (current_setting('opengeni.knowledge_actor_kind',true)='source_preparation' AND d.id::text=current_setting('opengeni.knowledge_prepared_document',true)))
              OR d.id IN (SELECT resolve_session_attempt_personal_document_reads(d.account_id,
                nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
                nullif(current_setting('opengeni.knowledge_session_id',true),'')::uuid,
                nullif(current_setting('opengeni.knowledge_attempt_id',true),'')::uuid)))))))
      AND ((current_setting('opengeni.knowledge_actor_kind',true)='source_preparation'
        AND d.id::text=current_setting('opengeni.knowledge_prepared_document',true))
        OR google_drive_file_authorized(d.account_id,nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
          nullif(current_setting('opengeni.subject_id',true),''),d.file_id)))
$body$;

CREATE OR REPLACE FUNCTION knowledge_source_visible(p_account uuid,p_body jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
<<knowledge_source_visible>>
DECLARE document_id uuid:=(p_body#>>'{source,documentId}')::uuid;
  file_id uuid:=(p_body#>>'{source,fileId}')::uuid;
BEGIN
  IF document_id IS NOT NULL THEN
    RETURN knowledge_document_visible(document_id) AND (file_id IS NULL OR EXISTS(
      SELECT 1 FROM documents d WHERE d.account_id=p_account AND d.id=document_id
        AND d.file_id=knowledge_source_visible.file_id));
  END IF;
  IF file_id IS NOT NULL THEN
    RETURN EXISTS(SELECT 1 FROM files f WHERE f.account_id=p_account
      AND f.id=knowledge_source_visible.file_id AND f.status='ready'
      AND ((f.source_session_id IS NULL AND NOT f.source_session_provenance_missing)
        OR f.source_session_audience_explicit))
      AND google_drive_file_authorized(p_account,
        nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
        nullif(current_setting('opengeni.subject_id',true),''),file_id);
  END IF;
  RETURN true;
END $body$;
RESET statement_timeout;
RESET lock_timeout;
