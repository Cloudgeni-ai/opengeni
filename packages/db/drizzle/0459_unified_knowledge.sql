-- deployment-mode: maintenance
-- Unified retained Knowledge. Old binaries must stay stopped after activation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF to_regclass('pg_temp.knowledge_conversion_0459') IS NULL THEN
    RAISE EXCEPTION '0459 requires the codec-aware TypeScript migration runner' USING ERRCODE='55000';
  END IF;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0459 requires explicit application database roles' USING ERRCODE='55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0459 received invalid application roles' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(roles) r ON r.value=a.usename
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION '0459 requires drained application sessions' USING ERRCODE='55000';
  END IF;
END $drain$;

-- The old toggle remains readable for historical settings bags, but is no
-- longer a writable policy. Full old-client bags may echo the unchanged value.
CREATE FUNCTION knowledge_legacy_memory_setting_retired() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.settings->'memoryEnabled' IS DISTINCT FROM OLD.settings->'memoryEnabled' THEN
    RAISE EXCEPTION 'Memory settings moved to Agent learning' USING ERRCODE='0A000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_legacy_memory_setting_retired BEFORE UPDATE OF settings ON workspaces
  FOR EACH ROW EXECUTE FUNCTION knowledge_legacy_memory_setting_retired();

-- Generated source sessions use the existing private-create capability and
-- remain bound atomically to the exact accepted scheduled execution. All other
-- generated-session identity checks are preserved byte for byte.
DO $source_session_fence$
DECLARE definition text; old_fragment text; new_fragment text;
BEGIN
  definition:=pg_get_functiondef('fence_scheduled_task_run_connection_session_identity()'::regprocedure);
  old_fragment:=$old$OR session_row.visibility <> 'workspace_shared'
        OR session_row.authority_epoch <> 1
        OR session_row.owner_organization_membership_id IS NOT NULL
        OR session_row.owner_subject_id IS NOT NULL$old$;
  new_fragment:=$new$OR session_row.visibility IS DISTINCT FROM (CASE
          WHEN task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal' THEN 'user_private' ELSE 'workspace_shared' END)
        OR session_row.authority_epoch <> 1
        OR session_row.owner_organization_membership_id IS DISTINCT FROM (CASE
          WHEN task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
            THEN (accepted#>>'{causalHumanAuthority,organizationMembershipId}')::uuid END)
        OR session_row.owner_subject_id IS DISTINCT FROM (CASE
          WHEN task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
            THEN accepted->>'causalHumanSubjectId' END)
        OR (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal' AND (
          accepted->>'causalHumanSubjectId' IS NULL
          OR task_snapshot#>>'{agentConfig,knowledgeSource,destination,subjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
          OR task_snapshot#>>'{agentConfig,knowledgeSource,initiatingSubjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
          OR task_snapshot#>>'{agentConfig,knowledgeSource,connection,ownerSubjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
          OR accepted#>>'{causalHumanAuthority,subjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
          OR task_snapshot->>'runMode'<>'new_session_per_run'))$new$;
  IF strpos(definition,old_fragment)=0 THEN RAISE EXCEPTION 'Scheduled generated-session fence changed before 0459'; END IF;
  EXECUTE replace(definition,old_fragment,new_fragment);
END $source_session_fence$;

DO $source_private_create$
DECLARE definition text; old_fragment text; new_fragment text;
BEGIN
  definition:=pg_get_functiondef('guard_session_authority_write()'::regprocedure);
  old_fragment:=$old$AND capability.actor_subject_id = NEW.created_by_subject_id
          AND capability.owner_membership_id = NEW.owner_organization_membership_id
          AND NEW.created_by_kind = 'subject'$old$;
  new_fragment:=$new$AND capability.owner_membership_id = NEW.owner_organization_membership_id
          AND ((NEW.created_by_kind='subject' AND capability.actor_subject_id=NEW.created_by_subject_id)
            OR (NEW.created_by_kind='service' AND NEW.created_by_subject_id='scheduler' AND EXISTS (
              SELECT 1 FROM scheduled_task_runs run WHERE run.account_id=NEW.account_id
                AND run.workspace_id=NEW.workspace_id AND run.id::text=NEW.metadata->>'scheduledTaskRunId'
                AND run.action_kind='agent_turn' AND run.session_id IS NULL AND run.status IN ('queued','dispatched')
                AND run.accepted_execution_snapshot#>>'{generatedSessionBinding,createIdempotencyKey}'=NEW.create_idempotency_key
                AND run.accepted_execution_snapshot->>'causalHumanSubjectId'=capability.actor_subject_id
                AND run.accepted_execution_snapshot#>>'{causalHumanAuthority,subjectId}'=capability.actor_subject_id
                AND run.accepted_execution_snapshot#>>'{causalHumanAuthority,organizationMembershipId}'=capability.owner_membership_id::text
                AND run.accepted_execution_snapshot#>>'{task,runMode}'='new_session_per_run'
                AND run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,destination,kind}'='personal'
                AND run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,destination,subjectId}'=capability.actor_subject_id
                AND run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,connection,ownerSubjectId}'=capability.actor_subject_id
                AND run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,initiatingSubjectId}'=capability.actor_subject_id
            )))$new$;
  IF strpos(definition,old_fragment)=0 THEN RAISE EXCEPTION 'Private-create authority fence changed before 0459'; END IF;
  EXECUTE replace(definition,old_fragment,new_fragment);
END $source_private_create$;


-- Original chat attachments have an explicit owner before any byte upload.
-- Shared files retain the existing workspace policy. Personal files additionally
-- require a host-verified owner scope; a workspace or service subject is not one.
ALTER TABLE files ADD COLUMN private_owner_subject_ids text[] DEFAULT
  CASE WHEN nullif(current_setting('opengeni.private_file_owner',true),'') IS NULL THEN NULL
    ELSE ARRAY[current_setting('opengeni.private_file_owner',true)] END
  CHECK(private_owner_subject_ids IS NULL OR (cardinality(private_owner_subject_ids)>0 AND array_position(private_owner_subject_ids,NULL) IS NULL));
-- Derive old original ownership from typed resource authority, never prose,
-- filenames, or the uploading service's subject. A file that was explicitly
-- shared as well as used privately keeps that existing shared authority.
ALTER TABLE files NO FORCE ROW LEVEL SECURITY;
ALTER TABLE documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_image_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_video_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE retained_screenshot_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;
CREATE TEMP TABLE knowledge_session_file_owners_0459 ON COMMIT DROP AS

  SELECT s.id,s.account_id,s.resources,CASE
    WHEN s.visibility='user_private' THEN s.owner_subject_id
    WHEN s.memory_scope='user' THEN s.scope_subject_id
    ELSE personal.subject_id END AS owner
  FROM sessions s LEFT JOIN organization_memberships personal
    ON personal.account_id=s.account_id AND personal.personal_workspace_id=s.workspace_id
;
CREATE TEMP TABLE knowledge_file_owners_0459 ON COMMIT DROP AS
WITH session_owners AS (SELECT * FROM knowledge_session_file_owners_0459), original_references AS (
  SELECT d.file_id,d.account_id,
    CASE WHEN d.authority_kind='personal' THEN d.authority_subject_id END AS owner
  FROM documents d WHERE d.file_id IS NOT NULL
  UNION ALL
  SELECT (r->>'fileId')::uuid,s.account_id,s.owner FROM session_owners s
    CROSS JOIN LATERAL jsonb_array_elements(s.resources) r
    WHERE r->>'kind'='file' AND r->>'fileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION ALL
  SELECT (r->>'fileId')::uuid,s.account_id,s.owner FROM session_owners s
    JOIN session_turns t ON t.session_id=s.id AND t.account_id=s.account_id
    CROSS JOIN LATERAL jsonb_array_elements(t.resources) r
    WHERE r->>'kind'='file' AND r->>'fileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION ALL
  SELECT a.artifact_id,a.account_id,s.owner FROM generated_image_artifacts a
    JOIN session_owners s ON s.id=a.session_id AND s.account_id=a.account_id
  UNION ALL
  SELECT a.primary_file_id,a.account_id,s.owner FROM generated_video_artifacts a
    JOIN session_owners s ON s.id=a.session_id AND s.account_id=a.account_id
  UNION ALL
  SELECT a.artifact_id,a.account_id,s.owner FROM retained_screenshot_artifacts a
    JOIN session_owners s ON s.id=a.session_id AND s.account_id=a.account_id
)
SELECT file_id,account_id,array_agg(DISTINCT owner ORDER BY owner) AS owners FROM original_references
GROUP BY file_id,account_id
HAVING bool_and(owner IS NOT NULL);
UPDATE files f SET private_owner_subject_ids=ownership.owners
FROM knowledge_file_owners_0459 ownership WHERE f.id=ownership.file_id AND f.account_id=ownership.account_id;
-- Async upload/media settlement and cleanup retain the accepted file owner
-- even after the source session/turn is removed. This is operation provenance,
-- never a grant for a user or agent to read another person's originals.
ALTER TABLE file_uploads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE file_uploads ADD COLUMN private_file_owner_subject_id text
  DEFAULT nullif(current_setting('opengeni.private_file_owner',true),'');
UPDATE file_uploads u SET private_file_owner_subject_id=f.private_owner_subject_ids[1]
  FROM files f WHERE u.file_id=f.id AND u.account_id=f.account_id;
ALTER TABLE file_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE video_generation_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE video_generation_operations ADD COLUMN private_file_owner_subject_id text
  DEFAULT nullif(current_setting('opengeni.private_file_owner',true),'');
ALTER TABLE retained_screenshot_artifacts ADD COLUMN private_file_owner_subject_id text
  DEFAULT nullif(current_setting('opengeni.private_file_owner',true),'');
UPDATE video_generation_operations o SET private_file_owner_subject_id=s.owner
  FROM knowledge_session_file_owners_0459 s WHERE o.session_id=s.id AND o.account_id=s.account_id;
UPDATE retained_screenshot_artifacts a SET private_file_owner_subject_id=s.owner
  FROM knowledge_session_file_owners_0459 s WHERE a.session_id=s.id AND a.account_id=s.account_id;
ALTER TABLE video_generation_operations FORCE ROW LEVEL SECURITY;
CREATE FUNCTION knowledge_media_file_owner_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.private_file_owner_subject_id IS DISTINCT FROM OLD.private_file_owner_subject_id THEN
    RAISE EXCEPTION 'An operation retains its accepted original-file owner' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_upload_owner_immutable BEFORE UPDATE ON file_uploads
  FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();
CREATE TRIGGER video_generation_file_owner_immutable BEFORE UPDATE ON video_generation_operations
  FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();
CREATE TRIGGER retained_screenshot_file_owner_immutable BEFORE UPDATE ON retained_screenshot_artifacts
  FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE retained_screenshot_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_video_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_image_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;

CREATE POLICY files_personal_owner ON files AS RESTRICTIVE FOR ALL
  USING(private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids))
  WITH CHECK(private_owner_subject_ids IS NULL OR nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids));
-- A personal original belongs to its organization/user. Its origin workspace
-- is provenance, while shared files still cascade with their owning workspace.
ALTER TABLE files DROP CONSTRAINT files_workspace_id_fkey;
ALTER TABLE files DROP CONSTRAINT files_workspace_account_fk;
ALTER TABLE files ADD COLUMN retention_workspace_id uuid GENERATED ALWAYS AS
  (CASE WHEN private_owner_subject_ids IS NULL THEN workspace_id END) STORED;
ALTER TABLE files ADD CONSTRAINT files_retention_workspace_account_fk FOREIGN KEY(retention_workspace_id,account_id)
  REFERENCES workspaces(id,account_id) ON DELETE CASCADE;
CREATE POLICY files_personal_read ON files FOR SELECT USING (
  account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
  AND nullif(current_setting('opengeni.private_file_owner',true),'')=ANY(private_owner_subject_ids));
CREATE FUNCTION knowledge_file_owner_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.private_owner_subject_ids IS DISTINCT FROM OLD.private_owner_subject_ids
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'File ownership is immutable; share an explicitly authorized copy' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER files_personal_owner_immutable BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION knowledge_file_owner_immutable();

-- Defaults and context overrides are revisions of one policy authority. Empty
-- overrides mean inheritance. Personal defaults are organization-user owned;
-- origin_workspace_id records provenance, not a cross-workspace access grant.
-- Provenance UUIDs deliberately have no workspace foreign key: deleting an
-- originating workspace must not erase personal/organization retained content
-- or its receipts. Only actual ownership columns cascade workspace deletion.
CREATE TABLE agent_learning_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  origin_workspace_id uuid NOT NULL,
  owner_key text NOT NULL,
  owner_workspace_id uuid GENERATED ALWAYS AS
    (CASE WHEN subject_id IS NULL THEN origin_workspace_id END) STORED,
  subject_id text,
  context_key text NOT NULL DEFAULT 'defaults',
  version integer NOT NULL CHECK (version>0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  actor_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,owner_key,context_key,version),
  UNIQUE(account_id,operation_id),
  FOREIGN KEY(owner_workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  CHECK ((subject_id IS NULL AND owner_key='workspace:'||origin_workspace_id::text)
    OR (length(subject_id) BETWEEN 1 AND 1024 AND owner_key='personal:'||subject_id))
);
CREATE INDEX agent_learning_revisions_current_idx ON agent_learning_revisions
  (account_id,owner_key,context_key,version DESC);

CREATE TABLE agent_learning_snapshots (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,turn_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,turn_id) REFERENCES session_turns(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE knowledge_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  origin_workspace_id uuid NOT NULL,
  scope text NOT NULL CHECK(scope IN ('organization','workspace','personal')),
  scope_workspace_id uuid,
  scope_subject_id text,
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  published_revision_id uuid,
  latest_revision_id uuid,
  archived boolean NOT NULL DEFAULT false,
  -- A migrated scope is an additional restriction, never a broader owner.
  legacy_memory_id uuid UNIQUE,
  legacy_document_id uuid UNIQUE,
  legacy_claim_id uuid UNIQUE,
  prepared_file_id uuid,
  document_preparation jsonb,
  legacy_document_version_id uuid UNIQUE,
  legacy_scope_workspace_id uuid,
  access_document_id uuid,
  access_file_id uuid,
  legacy_scope_type text,
  legacy_scope_role_key text,
  legacy_scope_session_id uuid,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  FOREIGN KEY(scope_workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  CHECK ((scope='organization' AND scope_workspace_id IS NULL AND scope_subject_id IS NULL)
    OR (scope='workspace' AND scope_workspace_id IS NOT NULL AND scope_subject_id IS NULL)
    OR (scope='personal' AND scope_workspace_id IS NULL AND length(scope_subject_id) BETWEEN 1 AND 1024))
);
CREATE INDEX knowledge_entries_scope_idx ON knowledge_entries(account_id,scope,scope_workspace_id,scope_subject_id,id);

CREATE TABLE knowledge_review_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  origin_workspace_id uuid NOT NULL,
  owner_key text NOT NULL,
  session_id uuid,
  turn_id uuid,
  scheduled_task_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  UNIQUE(account_id,owner_key,turn_id)
);
CREATE UNIQUE INDEX knowledge_review_batches_run_idx ON knowledge_review_batches
  (account_id,owner_key,scheduled_task_run_id) WHERE scheduled_task_run_id IS NOT NULL;

CREATE TABLE knowledge_entry_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  number integer NOT NULL CHECK(number>0),
  change_kind text NOT NULL DEFAULT 'upsert' CHECK(change_kind IN ('upsert','archive')),
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
  body_codec_version integer,
  legacy_snapshot jsonb,
  preview text NOT NULL DEFAULT '',
  preview_codec_version integer,
  previous_revision_id uuid,
  restored_from_revision_id uuid,
  actor jsonb NOT NULL,
  created_by_session_id uuid,
  created_by_turn_id uuid,
  review_batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,entry_id,id),
  UNIQUE(account_id,entry_id,number),
  FOREIGN KEY(account_id,entry_id) REFERENCES knowledge_entries(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,entry_id,previous_revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id),
  FOREIGN KEY(account_id,entry_id,restored_from_revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id),
  FOREIGN KEY(account_id,review_batch_id) REFERENCES knowledge_review_batches(account_id,id),
  CHECK(body_codec_version IS NULL OR body_codec_version=1)
);
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_published_fk
  FOREIGN KEY(account_id,id,published_revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_latest_fk
  FOREIGN KEY(account_id,id,latest_revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id)
  DEFERRABLE INITIALLY DEFERRED;

-- Relational indexes of each immutable revision. Labels, quotes and locations
-- live once in its exact body. Membership does not copy or authorize content.
CREATE TABLE knowledge_entry_links (
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  target_entry_id uuid NOT NULL,
  target_revision_id uuid,
  relation text NOT NULL CHECK(relation IN
    ('evidence','group','related_to','depends_on','applies_to','conflicts_with','supersedes')),
  PRIMARY KEY(revision_id,ordinal),
  FOREIGN KEY(account_id,entry_id,revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,target_entry_id) REFERENCES knowledge_entries(account_id,id),
  FOREIGN KEY(account_id,target_entry_id,target_revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id),
  CHECK(entry_id<>target_entry_id),
  CHECK((relation='evidence')=(target_revision_id IS NOT NULL))
);
CREATE INDEX knowledge_entry_links_target_idx ON knowledge_entry_links(account_id,target_entry_id,relation,revision_id);

CREATE TABLE knowledge_entry_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  outcome text NOT NULL CHECK(outcome IN ('published','pending','rejected','archived','restored')),
  actor jsonb NOT NULL,
  policy_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,entry_id,version),
  FOREIGN KEY(account_id,entry_id,revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id) ON DELETE CASCADE
);
CREATE TABLE knowledge_entry_operations (
  account_id uuid NOT NULL,
  origin_workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  actor jsonb NOT NULL,
  request_hash text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,operation_id),
  FOREIGN KEY(account_id,entry_id) REFERENCES knowledge_entries(account_id,id) ON DELETE CASCADE
);

-- Rebuildable search projection. It never owns retained content or publication.
-- Instruction content remains in its native revision/head lifecycle. This
-- append-only ledger owns operation replay and review decisions only.
CREATE TABLE agent_instruction_operations (
  account_id uuid NOT NULL,
  origin_workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES workspace_instruction_policy_revisions(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  actor jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,operation_id),
  FOREIGN KEY(origin_workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE
);
ALTER TABLE workspace_instruction_policy_revisions ADD COLUMN agent_learning_context jsonb;
ALTER TABLE workspace_instruction_policy_revisions DROP CONSTRAINT workspace_instruction_policy_revisions_provenance_chk;
ALTER TABLE workspace_instruction_policy_revisions ADD CONSTRAINT workspace_instruction_policy_revisions_provenance_chk
  CHECK(provenance_source IN ('human','onboarding','knowledge_proposal','legacy_import','agent_learning')
    AND (provenance_source_id IS NULL OR length(provenance_source_id) BETWEEN 1 AND 512)
    AND ((provenance_source='agent_learning')=(agent_learning_context IS NOT NULL)));

-- Search caches are projections, never a content or publication authority.
CREATE TABLE knowledge_index_jobs (
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','obsolete')),
  model text,
  dimensions integer,
  generation integer NOT NULL DEFAULT 0,
  completed_generation integer,
  next_index integer NOT NULL DEFAULT 0,
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failure text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(account_id,entry_id,revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id) ON DELETE CASCADE
);
CREATE INDEX knowledge_index_jobs_due ON knowledge_index_jobs(next_attempt_at,revision_id) WHERE state<>'obsolete';
CREATE TABLE knowledge_entry_vectors (
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  generation integer NOT NULL,
  chunk_index integer NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 4096),
  field text NOT NULL CHECK(field IN ('title','content')),
  start_offset integer NOT NULL CHECK(start_offset>=0),
  end_offset integer NOT NULL CHECK(end_offset>=start_offset),
  text text NOT NULL,
  text_codec_version integer NOT NULL CHECK(text_codec_version=1),
  embedding vector NOT NULL,
  PRIMARY KEY(account_id,entry_id,revision_id,generation,chunk_index),
  FOREIGN KEY(account_id,entry_id,revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id) ON DELETE CASCADE,
  CHECK(vector_dims(embedding)=dimensions AND vector_norm(embedding)>0)
);
CREATE FUNCTION knowledge_enqueue_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.change_kind<>'archive' THEN
    INSERT INTO knowledge_index_jobs(account_id,entry_id,revision_id) VALUES(NEW.account_id,NEW.entry_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_revision_index_queue AFTER INSERT ON knowledge_entry_revisions
  FOR EACH ROW EXECUTE FUNCTION knowledge_enqueue_index();
-- Only the owner-definer dispatcher can use this scope. Setting the GUC on an
-- application connection cannot reveal jobs or turn it into a content reader.
CREATE POLICY knowledge_index_dispatcher ON knowledge_index_jobs USING (
  current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='knowledge_index_jobs'::regclass))
  AND current_setting('opengeni.knowledge_index_dispatcher',true)='1');
CREATE FUNCTION knowledge_index_claim(p_model text,p_dimensions integer,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE previous text:=current_setting('opengeni.knowledge_index_dispatcher',true); result jsonb;
BEGIN
  IF p_model IS NULL OR p_dimensions IS NULL OR p_limit IS NULL OR length(p_model) NOT BETWEEN 1 AND 512 OR p_dimensions NOT BETWEEN 1 AND 4096 OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid Knowledge indexing claim' USING ERRCODE='22023'; END IF;
  PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
  WITH candidates AS (
    SELECT j.revision_id FROM knowledge_index_jobs j WHERE j.state<>'obsolete' AND j.next_attempt_at<=clock_timestamp()
      AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
      AND (j.state<>'ready' OR j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions)
    ORDER BY j.next_attempt_at,j.revision_id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE knowledge_index_jobs j SET state='running',lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',
      generation=CASE WHEN j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions THEN j.generation+1 ELSE j.generation END,
      next_index=CASE WHEN j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions THEN 0 ELSE j.next_index END,
      model=p_model,dimensions=p_dimensions,attempts=j.attempts+1
    FROM candidates c WHERE j.revision_id=c.revision_id RETURNING j.*
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',account_id,'entryId',entry_id,'revisionId',revision_id,
    'leaseId',lease_id,'model',model,'dimensions',dimensions,'generation',generation,'nextIndex',next_index)),'[]'::jsonb) INTO result FROM claimed;
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;
-- Projection processing is a lease capability, never an impersonated human or
-- an agent attempt. It may process retained bytes but cannot publish revisions.
-- Recheck source lifecycle for the entry and its pinned evidence before every
-- provider batch and cache commit; retrieval still applies the requesting
-- subject's current ACL independently.
CREATE FUNCTION knowledge_index_retention_active(p_account uuid,p_entry uuid,p_revision uuid,p_preparing_document uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE dep record; document_id uuid; file_id uuid; file_subject text; allowed boolean:=true;
  previous_workspace text:=current_setting('opengeni.workspace_id',true);
  previous_subject text:=current_setting('opengeni.subject_id',true);
  previous_owner text:=current_setting('opengeni.private_file_owner',true);
BEGIN
  FOR dep IN WITH RECURSIVE dependencies(entry_id,revision_id) AS (
    SELECT p_entry,p_revision UNION
    SELECT l.target_entry_id,l.target_revision_id FROM dependencies d JOIN knowledge_entry_links l
      ON l.account_id=p_account AND l.entry_id=d.entry_id AND l.revision_id=d.revision_id AND l.relation='evidence'
  ) SELECT e.*,r.body,r.id AS revision_id FROM dependencies d
    LEFT JOIN knowledge_entries e ON e.account_id=p_account AND e.id=d.entry_id
    LEFT JOIN knowledge_entry_revisions r ON r.account_id=p_account AND r.entry_id=d.entry_id AND r.id=d.revision_id
  LOOP
    IF dep.id IS NULL OR dep.revision_id IS NULL OR dep.archived
      OR dep.valid_from>clock_timestamp() OR dep.valid_until<=clock_timestamp() THEN allowed:=false; EXIT; END IF;
    PERFORM set_config('opengeni.workspace_id',coalesce(dep.scope_workspace_id,dep.origin_workspace_id)::text,true);
    PERFORM set_config('opengeni.subject_id',coalesce(dep.scope_subject_id,''),true);
    PERFORM set_config('opengeni.private_file_owner',coalesce(dep.scope_subject_id,''),true);
    IF dep.legacy_document_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM knowledge_document_versions v
      JOIN knowledge_source_objects o ON o.account_id=v.account_id AND o.id=v.object_id AND o.lifecycle_state='active'
      JOIN knowledge_sources s ON s.account_id=v.account_id AND s.id=v.source_id AND s.lifecycle_state='active'
      JOIN knowledge_providers p ON p.account_id=s.account_id AND p.id=s.provider_id AND p.lifecycle_state='active'
      JOIN knowledge_source_acl_versions a ON a.account_id=s.account_id AND a.source_id=s.id AND a.generation=s.current_acl_generation
      WHERE v.account_id=p_account AND v.id=dep.legacy_document_version_id
    ) THEN allowed:=false; EXIT; END IF;
    document_id:=coalesce(dep.access_document_id,dep.legacy_document_id,(dep.body#>>'{source,documentId}')::uuid);
    IF document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM documents d
      WHERE d.account_id=p_account AND d.id=document_id AND d.status='ready') THEN allowed:=false; EXIT; END IF;
    file_id:=coalesce(dep.access_file_id,(dep.body#>>'{source,fileId}')::uuid);
    -- The retained original's immutable initiator is processing provenance, not
    -- a human grant. Ordinary Knowledge reads still check the current caller.
    file_subject:=dep.scope_subject_id;
    IF document_id IS NOT NULL THEN
      SELECT coalesce(d.authority_subject_id,d.created_by) INTO file_subject FROM documents d
        WHERE d.account_id=p_account AND d.id=document_id;
    END IF;
    PERFORM set_config('opengeni.subject_id',coalesce(file_subject,''),true);
    IF file_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM files f
      WHERE f.account_id=p_account AND f.id=file_id AND f.status='ready')
      OR ((p_preparing_document IS NULL OR document_id IS DISTINCT FROM p_preparing_document) AND NOT google_drive_file_authorized(p_account,coalesce(dep.scope_workspace_id,dep.origin_workspace_id),file_subject,file_id)))
      THEN allowed:=false; EXIT; END IF;
  END LOOP;
  PERFORM set_config('opengeni.workspace_id',coalesce(previous_workspace,''),true);
  PERFORM set_config('opengeni.subject_id',coalesce(previous_subject,''),true);
  PERFORM set_config('opengeni.private_file_owner',coalesce(previous_owner,''),true);
  RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.workspace_id',coalesce(previous_workspace,''),true);
  PERFORM set_config('opengeni.subject_id',coalesce(previous_subject,''),true);
  PERFORM set_config('opengeni.private_file_owner',coalesce(previous_owner,''),true);
  RAISE;
END $$;

CREATE FUNCTION knowledge_index_work(p_account uuid,p_revision uuid,p_lease uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE job knowledge_index_jobs%ROWTYPE; revision knowledge_entry_revisions%ROWTYPE; entry knowledge_entries%ROWTYPE;
  operation text:=p_request->>'operation'; chunk jsonb; ordinal integer:=0; vector_value vector;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Knowledge index tenant mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account AND j.revision_id=p_revision
    AND j.lease_id=p_lease AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge index lease unavailable' USING ERRCODE='40001'; END IF;
  SELECT * INTO entry FROM knowledge_entries e WHERE e.account_id=p_account AND e.id=job.entry_id;
  SELECT * INTO revision FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.id=p_revision;
  IF entry.id IS NULL OR revision.id IS NULL OR entry.archived OR revision.change_kind='archive'
    OR (p_revision IS DISTINCT FROM entry.latest_revision_id AND p_revision IS DISTINCT FROM entry.published_revision_id) THEN
    UPDATE knowledge_index_jobs SET state='obsolete',lease_id=NULL,lease_until=NULL WHERE revision_id=p_revision;
    DELETE FROM knowledge_entry_vectors WHERE account_id=p_account AND revision_id=p_revision;
    RETURN jsonb_build_object('status','obsolete');
  END IF;
  IF operation NOT IN ('fail','continue') AND NOT knowledge_index_retention_active(p_account,entry.id,p_revision) THEN
    UPDATE knowledge_index_jobs SET state='pending',lease_id=NULL,lease_until=NULL,last_failure='source_unavailable',
      next_attempt_at=clock_timestamp()+interval '1 hour' WHERE revision_id=p_revision;
    RETURN jsonb_build_object('status','pending');
  END IF;
  IF operation='read' THEN
    UPDATE knowledge_index_jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE revision_id=p_revision;
    RETURN jsonb_build_object('status','running','body',revision.body,'codecVersion',revision.body_codec_version,
      'originWorkspaceId',entry.origin_workspace_id,'scope',entry.scope,'subjectId',entry.scope_subject_id,
      'nextIndex',job.next_index,'generation',job.generation);
  ELSIF operation='append' THEN
    IF jsonb_typeof(p_request->'chunks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_request->'chunks') NOT BETWEEN 1 AND 64
      OR (p_request->>'expectedNextIndex')::integer IS DISTINCT FROM job.next_index THEN
      RAISE EXCEPTION 'Knowledge index checkpoint changed' USING ERRCODE='40001'; END IF;
    FOR chunk IN SELECT value FROM jsonb_array_elements(p_request->'chunks') LOOP
      IF (chunk->>'index')::integer IS DISTINCT FROM job.next_index+ordinal
        OR jsonb_typeof(chunk->'text') IS DISTINCT FROM 'string' OR length(chunk->>'text')>16384
        OR jsonb_typeof(chunk->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(chunk->'embedding')<>job.dimensions THEN
        RAISE EXCEPTION 'Invalid Knowledge index chunk' USING ERRCODE='22023'; END IF;
      vector_value:=(chunk->'embedding')::text::vector;
      INSERT INTO knowledge_entry_vectors(account_id,entry_id,revision_id,generation,chunk_index,model,dimensions,
        field,start_offset,end_offset,text,text_codec_version,embedding)
      VALUES(p_account,job.entry_id,p_revision,job.generation,job.next_index+ordinal,job.model,job.dimensions,
        chunk->>'field',(chunk->>'start')::integer,(chunk->>'end')::integer,chunk->>'text',1,vector_value);
      ordinal:=ordinal+1;
    END LOOP;
    UPDATE knowledge_index_jobs SET next_index=next_index+ordinal,lease_until=clock_timestamp()+interval '5 minutes' WHERE revision_id=p_revision;
    RETURN jsonb_build_object('status','running','nextIndex',job.next_index+ordinal);
  ELSIF operation='complete' THEN
    IF (p_request->>'expectedNextIndex')::integer IS DISTINCT FROM job.next_index OR job.next_index<1 THEN
      RAISE EXCEPTION 'Knowledge index checkpoint changed' USING ERRCODE='40001'; END IF;
    UPDATE knowledge_index_jobs SET state='ready',completed_generation=generation,lease_id=NULL,lease_until=NULL,last_failure=NULL WHERE revision_id=p_revision;
    DELETE FROM knowledge_entry_vectors WHERE account_id=p_account AND revision_id=p_revision AND generation<>job.generation;
    RETURN jsonb_build_object('status','ready');
  ELSIF operation='continue' THEN
    UPDATE knowledge_index_jobs SET state='pending',lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),attempts=0
      WHERE revision_id=p_revision;
    RETURN jsonb_build_object('status','pending');
  ELSIF operation='fail' THEN
    UPDATE knowledge_index_jobs SET state='pending',lease_id=NULL,lease_until=NULL,last_failure='embedding_unavailable',
      next_attempt_at=clock_timestamp()+least(3600,power(2,least(attempts,10))*5)*interval '1 second' WHERE revision_id=p_revision;
    RETURN jsonb_build_object('status','pending');
  END IF;
  RAISE EXCEPTION 'Unknown Knowledge index operation' USING ERRCODE='22023';
END $$;

-- A Drive ACL refresh can finish just after the projector deferred a source.
-- Wake its existing job immediately; the normal lease and access checks remain
-- authoritative at read and commit, including a concurrent revocation.
CREATE FUNCTION knowledge_source_index_wake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.status='indexed' AND NEW.acl_eligibility='eligible' THEN
    UPDATE knowledge_index_jobs j SET next_attempt_at=clock_timestamp()
      FROM knowledge_entries e WHERE e.account_id=NEW.account_id AND j.account_id=e.account_id
        AND j.entry_id=e.id AND j.state='pending'
        AND (e.legacy_document_id=NEW.document_id OR e.legacy_document_version_id=NEW.knowledge_document_version_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_source_index_ready AFTER UPDATE OF status,acl_eligibility,google_drive_acl_evidence_id
  ON knowledge_source_sync_index_obligations FOR EACH ROW EXECUTE FUNCTION knowledge_source_index_wake();

CREATE TABLE knowledge_entry_search (
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK(chunk_index>=0),
  search_vector tsvector NOT NULL,
  PRIMARY KEY(account_id,entry_id,revision_id,chunk_index),
  FOREIGN KEY(account_id,entry_id,revision_id) REFERENCES knowledge_entry_revisions(account_id,entry_id,id) ON DELETE CASCADE
);
CREATE INDEX knowledge_entry_search_vector_idx ON knowledge_entry_search USING gin(search_vector);

-- Bounded, overlapping projections avoid PostgreSQL's tsvector size limit for
-- long sources. Canonical text is always the exact revision body above.
CREATE FUNCTION knowledge_index_revision(p_account uuid,p_entry uuid,p_revision uuid,p_text text)
RETURNS void LANGUAGE sql SET search_path FROM CURRENT AS $$
  INSERT INTO knowledge_entry_search(account_id,entry_id,revision_id,chunk_index,search_vector)
  SELECT p_account,p_entry,p_revision,(n/14000)::integer,
    setweight(to_tsvector('simple',r.body->>'title'),'A') ||
      setweight(to_tsvector('simple',substring(p_text FROM n+1 FOR 16000)),'B')
  FROM generate_series(0,greatest(length(p_text)-1,0),14000) n
  JOIN knowledge_entry_revisions r ON r.account_id=p_account AND r.entry_id=p_entry AND r.id=p_revision
$$;

CREATE FUNCTION knowledge_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Knowledge history is immutable' USING ERRCODE='55000';
END $$;

-- Tenant fences apply even inside owner lifecycle functions. No runtime table
-- grants: the read capability also checks publication, source ACLs and links.
DO $tables$
DECLARE t text; runtime_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_learning_revisions','agent_learning_snapshots','agent_instruction_operations','knowledge_entries','knowledge_review_batches',
    'knowledge_entry_revisions','knowledge_entry_links','knowledge_entry_decisions',
    'knowledge_entry_operations','knowledge_entry_search','knowledge_index_jobs','knowledge_entry_vectors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY knowledge_tenant ON %I USING (account_id = nullif(current_setting(''opengeni.account_id'',true),'''')::uuid)',t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
    FOR runtime_role IN SELECT jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) LOOP
      IF runtime_role <> current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',t,runtime_role);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['agent_learning_revisions','agent_learning_snapshots','agent_instruction_operations','knowledge_entry_revisions','knowledge_entry_links',
    'knowledge_entry_decisions','knowledge_entry_operations'] LOOP
    EXECUTE format('CREATE TRIGGER knowledge_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation()',t);
  END LOOP;
END $tables$;

-- Compatibility selectors are retained as restrictions. A migration never
-- interprets a legacy label or source-created identity as a personal owner.
CREATE FUNCTION knowledge_scope_visible(e knowledge_entries) RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce(e.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
    AND (e.scope='organization'
      OR (e.scope='workspace' AND e.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
      OR (e.scope='personal' AND e.scope_subject_id=nullif(current_setting('opengeni.subject_id',true),'')
        AND (current_setting('opengeni.knowledge_actor_kind',true)='human'
          OR current_setting('opengeni.knowledge_default_scope',true)='personal')))
    AND (e.legacy_scope_workspace_id IS NULL OR e.legacy_scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND e.valid_from<=transaction_timestamp() AND (e.valid_until IS NULL OR e.valid_until>transaction_timestamp())
    AND (e.legacy_memory_id IS NULL OR e.origin_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND (e.legacy_scope_type IS NULL OR opengeni_private.memory_scope_visible(
      e.legacy_scope_type,e.scope_subject_id,e.legacy_scope_role_key,e.legacy_scope_session_id,e.valid_from,e.valid_until)),false)
$$;

CREATE FUNCTION knowledge_learning_settings_valid(value jsonb, complete boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(value)='object'
    AND value-'knowledge'-'instructions'-'skills'='{}'::jsonb
    AND (NOT complete OR value ?& ARRAY['knowledge','instructions','skills'])
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(value) p
      WHERE jsonb_typeof(p.value)<>'string' OR p.value#>>'{}' NOT IN ('automatic','review_first','off')),false)
$$;
ALTER TABLE agent_learning_revisions ADD CONSTRAINT agent_learning_settings_valid
  CHECK(knowledge_learning_settings_valid(settings,context_key='defaults'));

CREATE FUNCTION knowledge_learning_resolve(p_account uuid,p_workspace uuid,p_subject text,
  p_context text,p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE base jsonb; overrides jsonb; base_version integer; context_version integer;
  owner text:=CASE WHEN p_subject IS NULL THEN 'workspace:'||p_workspace ELSE 'personal:'||p_subject END;
BEGIN
  SELECT settings,version INTO base,base_version FROM agent_learning_revisions
    WHERE account_id=p_account AND owner_key=owner AND context_key='defaults' AND created_at<=p_at
    ORDER BY version DESC LIMIT 1;
  base:=coalesce(base,'{"knowledge":"automatic","instructions":"review_first","skills":"review_first"}'::jsonb);
  SELECT settings,version INTO overrides,context_version FROM agent_learning_revisions
    WHERE account_id=p_account AND owner_key=owner AND context_key=p_context AND created_at<=p_at
    ORDER BY version DESC LIMIT 1;
  RETURN jsonb_build_object('ownerKey',owner,'defaultsVersion',coalesce(base_version,0),
    'contextKey',p_context,'contextVersion',coalesce(context_version,0),
    'defaults',base,'overrides',coalesce(overrides,'{}'::jsonb),'effective',base||coalesce(overrides,'{}'::jsonb));
END $$;

-- Backfill only policy, not authority. Existing explicit Memory opt-outs and
-- learning modes become category defaults. Per-record source exceptions remain
-- historical proof for retired proposal writers, not new task/chat policy.
ALTER TABLE agent_learning_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_learning_policy_heads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_learning_policy_revisions NO FORCE ROW LEVEL SECURITY;
INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,version,settings,
  operation_id,request_hash,actor_subject_id,created_at)
SELECT w.account_id,w.id,'workspace:'||w.id,1,
  jsonb_build_object('knowledge',CASE WHEN w.settings->>'memoryEnabled'='false' THEN 'off' ELSE 'automatic' END,
    'instructions',CASE WHEN coalesce(r.workspace_mode,'suggest')='suggest' THEN 'review_first' ELSE r.workspace_mode END,
    'skills',CASE WHEN coalesce(r.workspace_mode,'suggest')='suggest' THEN 'review_first' ELSE r.workspace_mode END),
  gen_random_uuid(),'migration:0459','service:knowledge-migration:0459','epoch'::timestamptz
FROM workspaces w LEFT JOIN workspace_learning_policy_heads h ON h.workspace_id=w.id AND h.account_id=w.account_id
LEFT JOIN workspace_learning_policy_revisions r ON r.id=h.revision_id AND r.account_id=w.account_id;
-- The Personal workspace's explicit settings become its owner's defaults.
-- Existing private chats keep a workspace-level opt-out as a sparse chat override.
ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,version,settings,
  operation_id,request_hash,actor_subject_id,created_at)
SELECT m.account_id,w.id,'personal:'||m.subject_id,m.subject_id,1,r.settings,
  gen_random_uuid(),'migration:0459:personal','service:knowledge-migration:0459','epoch'::timestamptz
FROM organization_memberships m JOIN workspaces w ON w.account_id=m.account_id AND w.id=m.personal_workspace_id
JOIN agent_learning_revisions r ON r.account_id=m.account_id AND r.owner_key='workspace:'||w.id AND r.context_key='defaults';
INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,context_key,version,settings,
  operation_id,request_hash,actor_subject_id,created_at)
SELECT s.account_id,s.workspace_id,
  CASE WHEN (s.visibility='user_private' OR s.memory_scope='user' OR pm.id IS NOT NULL) AND coalesce(s.owner_subject_id,s.scope_subject_id,pm.subject_id) IS NOT NULL
    THEN 'personal:'||coalesce(s.owner_subject_id,s.scope_subject_id,pm.subject_id) ELSE 'workspace:'||s.workspace_id END,
  CASE WHEN s.visibility='user_private' OR s.memory_scope='user' OR pm.id IS NOT NULL THEN coalesce(s.owner_subject_id,s.scope_subject_id,pm.subject_id) END,
  'chat:'||s.id,1,'{"knowledge":"off"}',gen_random_uuid(),'migration:0459:chat','service:knowledge-migration:0459','epoch'::timestamptz
FROM sessions s JOIN workspaces w ON w.account_id=s.account_id AND w.id=s.workspace_id
LEFT JOIN organization_memberships pm ON pm.account_id=w.account_id AND pm.personal_workspace_id=w.id
WHERE s.memory_scope='off' OR (w.settings->>'memoryEnabled'='false'
  AND (s.visibility='user_private' OR s.memory_scope='user' OR pm.id IS NOT NULL));
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_learning_policy_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_learning_policy_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_learning_revisions FORCE ROW LEVEL SECURITY;

-- Resolve only immutable accepted-work lineage. A later settings edit cannot
-- alter a run already accepted, including its children and causal resumptions.
CREATE FUNCTION knowledge_learning_for_turn(p_account uuid,p_workspace uuid,p_turn uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE t session_turns%ROWTYPE; s sessions%ROWTYPE; run scheduled_task_runs%ROWTYPE;
  result jsonb; inherited jsonb; current_policy jsonb; subject text; destination text;
  producer uuid; source_context text; accepted_at timestamptz;
BEGIN
  SELECT snapshot INTO result FROM agent_learning_snapshots WHERE account_id=p_account AND turn_id=p_turn;
  IF result IS NOT NULL THEN RETURN result; END IF;
  SELECT * INTO t FROM session_turns WHERE account_id=p_account AND workspace_id=p_workspace AND id=p_turn;
  IF NOT FOUND THEN RAISE EXCEPTION 'Learning accepted turn unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=t.session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Learning session unavailable' USING ERRCODE='42501'; END IF;
  subject:=coalesce(t.initiating_human_subject_id,CASE WHEN t.initiator_kind='subject' THEN t.initiator_subject_id END);
  -- The accepted initiating-human field is authority; subject spelling is not.
  -- Opaque authenticated host/local subjects retain the same personal layer.
  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user'
    OR get_workspace_kind(p_account,p_workspace)='personal' THEN 'personal' ELSE 'workspace' END;
  IF destination='personal' AND (subject IS NULL OR (s.visibility='user_private' AND s.owner_subject_id IS DISTINCT FROM subject)) THEN
    RAISE EXCEPTION 'Personal learning requires an initiating owner' USING ERRCODE='42501';
  END IF;
  IF destination='workspace' THEN subject:=NULL; END IF;
  source_context:='chat:'||s.id; accepted_at:=t.created_at;
  IF t.scheduled_task_run_id IS NOT NULL THEN
    SELECT * INTO run FROM scheduled_task_runs WHERE id=t.scheduled_task_run_id AND account_id=p_account AND workspace_id=p_workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Learning scheduled run unavailable' USING ERRCODE='42501'; END IF;
    source_context:='scheduled_task:'||run.task_id; accepted_at:=run.created_at;
  ELSE
    IF t.source IN ('goal','system') THEN
      SELECT prior.id INTO producer FROM session_system_updates u
        JOIN session_turns prior ON prior.id=CASE WHEN u.kind IN ('goal_continuation','background_command_result','session_wait_timeout')
          THEN (u.lineage->>'causalTurnId')::uuid ELSE (u.lineage->>'parentTurnId')::uuid END
          AND prior.account_id=p_account AND prior.workspace_id=p_workspace AND prior.session_id=s.id
        WHERE u.account_id=p_account AND u.workspace_id=p_workspace AND u.session_id=s.id
          AND u.delivered_turn_id=t.id AND u.state='delivered' AND u.delivered_history_item_id IS NOT NULL
          AND u.kind IN ('goal_continuation','background_command_result','session_wait_timeout','child_terminal_result','child_requires_action','child_requires_action_resolved',
            'child_paused','child_waiting_capacity','child_progress')
          AND prior.created_at<t.created_at
        ORDER BY prior.position DESC LIMIT 1;
    ELSIF s.parent_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM session_turns other
      WHERE other.account_id=p_account AND other.session_id=s.id AND other.position<t.position) THEN
      SELECT prior.id INTO producer FROM session_turns prior JOIN sessions parent ON parent.id=prior.session_id
        AND parent.account_id=prior.account_id AND parent.workspace_id=prior.workspace_id
        WHERE prior.account_id=p_account AND prior.workspace_id=p_workspace AND prior.id=s.parent_turn_id
          AND prior.session_id=s.parent_session_id AND prior.created_at<t.created_at AND parent.visibility=s.visibility
          AND prior.initiating_human_subject_id IS NOT DISTINCT FROM t.initiating_human_subject_id;
    END IF;
  END IF;
  current_policy:=knowledge_learning_resolve(p_account,p_workspace,subject,source_context,accepted_at);
  -- Old clients may still create a session with memoryScope=off. Preserve that
  -- accepted opt-out as a sparse context setting, rather than silently enabling
  -- writes after cutover. A later explicit context revision (including an empty
  -- Use-default reset) owns future turns. Never backfill over such a revision.
  IF s.memory_scope='off' AND (current_policy->>'contextVersion')::integer=0 THEN
    INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,context_key,
      version,settings,operation_id,request_hash,actor_subject_id,created_at)
    SELECT p_account,p_workspace,current_policy->>'ownerKey',subject,source_context,1,'{"knowledge":"off"}'::jsonb,
      gen_random_uuid(),'legacy-session-off:'||s.id,'service:knowledge-compatibility',accepted_at
    WHERE NOT EXISTS(SELECT 1 FROM agent_learning_revisions r WHERE r.account_id=p_account
      AND r.owner_key=current_policy->>'ownerKey' AND r.context_key=source_context)
    ON CONFLICT DO NOTHING;
    current_policy:=knowledge_learning_resolve(p_account,p_workspace,subject,source_context,accepted_at);
    -- A setting can have been edited after this work was accepted. It must not
    -- alter the accepted opt-out, even when that later row prevented the seed.
    current_policy:=jsonb_set(jsonb_set(current_policy,'{effective,knowledge}','"off"'::jsonb),
      '{overrides}',(current_policy->'overrides')||'{"knowledge":"off"}'::jsonb);
  END IF;
  IF producer IS NOT NULL THEN
    inherited:=knowledge_learning_for_turn(p_account,p_workspace,producer);
    IF inherited->>'ownerKey' IS DISTINCT FROM current_policy->>'ownerKey' THEN
      RAISE EXCEPTION 'Learning producer ownership changed' USING ERRCODE='42501';
    END IF;
    -- An explicit child/chat override wins. Otherwise keep the producer's
    -- effective policy, including its scheduled-task override and review batch.
    result:=current_policy||jsonb_build_object('effective',(inherited->'effective')||(current_policy->'overrides'),
      'producerTurnId',producer,'scheduledTaskRunId',inherited->'scheduledTaskRunId');
  ELSE
    result:=current_policy||jsonb_build_object('scheduledTaskRunId',t.scheduled_task_run_id);
  END IF;
  result:=result||jsonb_build_object('defaultScope',destination,'subjectId',subject,'acceptedAt',accepted_at);
  INSERT INTO agent_learning_snapshots(account_id,workspace_id,session_id,turn_id,snapshot)
    VALUES(p_account,p_workspace,s.id,t.id,result) ON CONFLICT(account_id,turn_id) DO NOTHING;
  SELECT snapshot INTO result FROM agent_learning_snapshots WHERE account_id=p_account AND turn_id=t.id;
  RETURN result;
END $$;

-- Internal authority resolver. HTTP principals are already authenticated and
-- permission checked by core; an agent receives only a host-bound attempt tuple.
-- Never expose this function as a runtime capability or accept its actor JSON
-- from a model/client request. Lock order matches the session lifecycle.
CREATE FUNCTION knowledge_resolve_actor(p_account uuid,p_workspace uuid,p_actor jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prepared knowledge_entries%ROWTYPE; s sessions%ROWTYPE; t session_turns%ROWTYPE; a session_turn_attempts%ROWTYPE;
  subject text; destination text; policy jsonb; run scheduled_task_runs%ROWTYPE;
  context_key text; resolved_actor jsonb;
BEGIN
  IF p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Knowledge requires exact workspace authority' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace AND account_id=p_account FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge workspace unavailable' USING ERRCODE='42501'; END IF;
  IF p_actor->>'kind'='source_preparation' THEN
    SELECT * INTO prepared FROM knowledge_entries e WHERE e.account_id=p_account
      AND e.id=(p_actor->>'entryId')::uuid AND e.origin_workspace_id=p_workspace FOR SHARE;
    IF NOT FOUND OR prepared.legacy_document_id IS NULL
      OR prepared.document_preparation ? 'completion'
      OR prepared.document_preparation->>'leaseId' IS DISTINCT FROM p_actor->>'leaseId'
      OR (prepared.document_preparation->>'leaseUntil')::timestamptz<=clock_timestamp() THEN
      RAISE EXCEPTION 'Document preparation lease unavailable' USING ERRCODE='42501'; END IF;
    PERFORM set_config('opengeni.subject_id',coalesce(prepared.scope_subject_id,''),true);
    PERFORM set_config('opengeni.private_file_owner',coalesce(prepared.scope_subject_id,''),true);
    PERFORM set_config('opengeni.knowledge_default_scope',prepared.scope,true);
    PERFORM set_config('opengeni.knowledge_actor_kind','source_preparation',true);
    PERFORM set_config('opengeni.knowledge_prepared_document',prepared.legacy_document_id::text,true);
    RETURN jsonb_build_object('kind','source_preparation','entryId',prepared.id,'defaultScope',prepared.scope,
      'subjectId',prepared.scope_subject_id,'review',false,'policy',prepared.document_preparation->'policy',
      'scheduledTaskRunId',prepared.document_preparation->'scheduledTaskRunId');
  END IF;
  IF p_actor->>'kind'='service' THEN
    IF p_actor->>'principalKind' NOT IN ('service','api_key','configured_key','mcp_gateway')
      OR p_actor->>'principalKind' IS DISTINCT FROM nullif(current_setting('opengeni.principal_kind',true),'')
      OR p_actor->>'subjectId' IS DISTINCT FROM nullif(current_setting('opengeni.subject_id',true),'') THEN
      RAISE EXCEPTION 'Knowledge service authority unavailable' USING ERRCODE='42501'; END IF;
    PERFORM set_config('opengeni.subject_id','',true);
    PERFORM set_config('opengeni.knowledge_actor_kind','service',true);
    PERFORM set_config('opengeni.private_file_owner','',true);
    RETURN jsonb_build_object('kind','service','defaultScope','workspace','review',false,
      'writeScopes',CASE WHEN p_actor->>'principalKind'='mcp_gateway' THEN '[]'::jsonb
        ELSE coalesce(p_actor->'writeScopes','[]'::jsonb)-'personal' END);
  END IF;
  IF p_actor->>'kind'='human' THEN
    subject:=p_actor->>'subjectId';
    IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 1024
      OR subject IS DISTINCT FROM nullif(current_setting('opengeni.subject_id',true),'')
      OR p_actor->>'principalKind' IS DISTINCT FROM 'human_session'
      OR nullif(current_setting('opengeni.principal_kind',true),'') IS DISTINCT FROM 'human_session' THEN
      RAISE EXCEPTION 'Knowledge human authority unavailable' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('opengeni.knowledge_actor_kind','human',true);
    PERFORM set_config('opengeni.private_file_owner',subject,true);
    RETURN jsonb_build_object('kind','human','subjectId',subject,'defaultScope','workspace',
      'writeScopes',coalesce(p_actor->'writeScopes','[]'::jsonb),'review',coalesce((p_actor->>'review')::boolean,false));
  END IF;
  IF p_actor->>'kind' IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'Knowledge requires a human or exact agent attempt' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM sessions WHERE id=(p_actor->>'sessionId')::uuid
    AND workspace_id=p_workspace AND account_id=p_account FOR SHARE;
  IF NOT FOUND OR s.active_turn_id IS DISTINCT FROM (p_actor->>'turnId')::uuid THEN
    RAISE EXCEPTION 'Knowledge session attempt is stale' USING ERRCODE='42501';
  END IF;
  SELECT * INTO t FROM session_turns WHERE id=s.active_turn_id AND session_id=s.id
    AND workspace_id=p_workspace AND account_id=p_account FOR SHARE;
  IF NOT FOUND OR t.active_attempt_id IS DISTINCT FROM (p_actor->>'attemptId')::uuid
    OR t.execution_generation IS DISTINCT FROM (p_actor->>'executionGeneration')::integer
    OR t.status NOT IN ('running','requires_action','recovering','waiting_capacity') THEN
    RAISE EXCEPTION 'Knowledge turn attempt is stale' USING ERRCODE='42501';
  END IF;
  SELECT * INTO a FROM session_turn_attempts WHERE id=t.active_attempt_id AND turn_id=t.id
    AND session_id=s.id AND account_id=p_account AND workspace_id=p_workspace FOR SHARE;
  IF NOT FOUND OR a.state NOT IN ('claimed','running') OR a.execution_generation<>t.execution_generation THEN
    RAISE EXCEPTION 'Knowledge attempt is stale' USING ERRCODE='42501';
  END IF;
  -- Fresh read after locks: interruption writers acquire the attempt FOR UPDATE.
  IF EXISTS(SELECT 1 FROM session_attempt_interruptions WHERE workspace_id=p_workspace
    AND attempt_id=a.id AND state IN ('pending','delivered','acknowledged')) THEN
    RAISE EXCEPTION 'Knowledge attempt is interrupted' USING ERRCODE='42501';
  END IF;
  subject:=coalesce(t.initiating_human_subject_id,CASE WHEN t.initiator_kind='subject' THEN t.initiator_subject_id END);
  -- The accepted initiating-human field is authority; subject spelling is not.
  -- Opaque authenticated host/local subjects retain the same personal layer.
  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user'
    OR get_workspace_kind(p_account,p_workspace)='personal'
    THEN 'personal' ELSE 'workspace' END;
  IF destination='personal' AND (subject IS NULL
    OR (s.visibility='user_private' AND s.owner_subject_id IS DISTINCT FROM subject)) THEN
    RAISE EXCEPTION 'Personal Knowledge requires the verified initiating owner' USING ERRCODE='42501';
  END IF;
  -- Keep the verified subject for provider ACL checks. The independent Knowledge
  -- scope selector prevents a shared agent from ambient-reading personal entries.
  PERFORM set_config('opengeni.subject_id',coalesce(subject,''),true);
  PERFORM set_config('opengeni.knowledge_default_scope',destination,true);
  PERFORM set_config('opengeni.knowledge_actor_kind','agent',true);
  PERFORM set_config('opengeni.private_file_owner',CASE WHEN destination='personal' THEN coalesce(subject,'') ELSE '' END,true);
  PERFORM set_config('opengeni.knowledge_session_id',s.id::text,true);
  PERFORM set_config('opengeni.knowledge_attempt_id',a.id::text,true);
  PERFORM set_config('opengeni.memory_session_id',s.id::text,true);
  PERFORM set_config('opengeni.memory_role_key',coalesce(s.metadata->>'memoryRoleKey',''),true);
  policy:=knowledge_learning_for_turn(p_account,p_workspace,t.id);
  IF policy->>'defaultScope' IS DISTINCT FROM destination OR (destination='personal' AND policy->>'subjectId' IS DISTINCT FROM subject) THEN
    RAISE EXCEPTION 'Learning scope changed after acceptance' USING ERRCODE='42501';
  END IF;
  resolved_actor:=jsonb_build_object('kind','agent','subjectId',subject,'defaultScope',destination,
    'sessionId',s.id,'turnId',t.id,'attemptId',a.id,'executionGeneration',a.execution_generation,
    'scheduledTaskRunId',policy->'scheduledTaskRunId','retentionScope',CASE WHEN s.memory_scope='session' THEN 'session' ELSE 'normal' END,'policy',policy);
  RETURN resolved_actor;
END $$;

-- Read one exact active note through its existing task-tree authority. The
-- temporary read capability is removed before returning retained source bytes.
CREATE FUNCTION knowledge_task_note_source(p_account uuid,p_workspace uuid,p_actor jsonb,p_note uuid,p_version integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE authority record; note task_notes%ROWTYPE; capability uuid:=gen_random_uuid();
  previous text:=current_setting('opengeni.task_note_write_capability',true);
BEGIN
  IF p_actor->>'kind'<>'agent' OR p_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Task-note promotion requires an exact agent and note version' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(p_account,p_workspace,
    (p_actor->>'sessionId')::uuid,(p_actor->>'turnId')::uuid,(p_actor->>'attemptId')::uuid,(p_actor->>'executionGeneration')::integer);
  INSERT INTO task_note_write_capabilities(backend_pid,transaction_id,capability_id)
    VALUES(pg_backend_pid(),pg_current_xact_id(),capability);
  PERFORM set_config('opengeni.task_note_write_capability',capability::text,true);
  SELECT * INTO note FROM task_notes n WHERE n.account_id=p_account AND n.workspace_id=p_workspace
    AND n.root_session_id=authority.root_session_id AND n.id=p_note AND n.version=p_version
    AND n.status='active' AND n.expires_at>statement_timestamp() FOR SHARE;
  DELETE FROM task_note_write_capabilities c WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id()
    AND c.capability_id=capability;
  PERFORM set_config('opengeni.task_note_write_capability',coalesce(previous,''),true);
  IF note.id IS NULL THEN RAISE EXCEPTION 'Task note is expired, archived or outside this task tree' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('content',note.text,'source',jsonb_build_object('kind','task_note','noteId',note.id,
    'sessionId',note.created_by_session_id,'version',note.version::text));
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.task_note_write_capability',coalesce(previous,''),true);
  RAISE;
END $$;

CREATE FUNCTION knowledge_entry_apply(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<knowledge_entry_apply>>
DECLARE actor jsonb; e knowledge_entries%ROWTYPE; r knowledge_entry_revisions%ROWTYPE;
  prior knowledge_entry_operations%ROWTYPE; body jsonb; codec integer; scope_value text;
  operation text:=p_request->>'operation'; operation_id uuid:=(p_request->>'operationId')::uuid;
  entry_id uuid:=(p_request->>'entryId')::uuid; revision_id uuid; old_revision uuid;
  batch_id uuid; owner_key text; disposition text; fingerprint text; result jsonb; next_number integer;
  mode text:='automatic'; restored_id uuid; search_text text;
BEGIN
  IF operation IS NULL OR operation NOT IN ('save','promote_note','approve','approve_edit','reject','restore','archive')
    OR operation_id IS NULL OR entry_id IS NULL OR (p_request->>'expectedVersion')::integer<0 THEN
    RAISE EXCEPTION 'Invalid Knowledge operation' USING ERRCODE='22023';
  END IF;
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  IF actor->>'kind'='agent' AND operation IN ('approve','approve_edit','reject') THEN
    RAISE EXCEPTION 'Agents cannot approve their own Knowledge' USING ERRCODE='42501';
  END IF;
  IF operation IN ('approve','approve_edit','reject') AND actor->>'review' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Knowledge review permission required' USING ERRCODE='42501';
  END IF;
  -- Serialize publications and reference validation within an organization.
  -- No organization row is locked after a workspace: this key has no FK path.
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  -- Authenticate the live attempt above, but bind retries to logical work.
  -- Recovery changes the physical attempt, never the operation's session/turn.
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(
    CASE WHEN p_actor->>'kind'='agent' THEN p_actor-'attemptId'-'executionGeneration' ELSE p_actor END,
    p_request)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM knowledge_entry_operations o WHERE o.account_id=p_account AND o.operation_id=knowledge_entry_apply.operation_id;
  IF FOUND THEN
    IF prior.request_hash<>fingerprint OR prior.origin_workspace_id<>p_workspace THEN
      RAISE EXCEPTION 'Knowledge operation key reused' USING ERRCODE='23505';
    END IF;
    SELECT * INTO e FROM knowledge_entries h WHERE h.account_id=p_account AND h.id=prior.entry_id;
    IF NOT knowledge_scope_visible(e) THEN RAISE EXCEPTION 'Knowledge unavailable' USING ERRCODE='42501'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO e FROM knowledge_entries h WHERE h.account_id=p_account AND h.id=entry_id FOR UPDATE;
  scope_value:=coalesce(e.scope,p_request->>'scope',actor->>'defaultScope');
  IF e.id IS NOT NULL AND (NOT knowledge_scope_visible(e)
    OR (p_request ? 'scope' AND p_request->>'scope'<>e.scope)) THEN
    RAISE EXCEPTION 'Knowledge scope is unavailable or immutable' USING ERRCODE='42501';
  END IF;
  IF actor->>'kind' IN ('agent','source_preparation') THEN
    IF actor->>'kind'='source_preparation' AND (operation<>'save' OR entry_id IS DISTINCT FROM (actor->>'entryId')::uuid
      OR p_request#>>'{entry,kind}' IS DISTINCT FROM 'source' OR p_request#>>'{entry,source,documentId}' IS DISTINCT FROM e.legacy_document_id::text) THEN
      RAISE EXCEPTION 'Source preparation is limited to its retained original' USING ERRCODE='42501'; END IF;
    IF scope_value IS DISTINCT FROM actor->>'defaultScope' OR (actor->>'retentionScope'='session' AND e.id IS NOT NULL
      AND (e.legacy_scope_type IS DISTINCT FROM 'session' OR e.legacy_scope_session_id IS DISTINCT FROM (actor->>'sessionId')::uuid)) THEN
      RAISE EXCEPTION 'Agent Knowledge stays in its accepted scope' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,knowledge}';
    IF mode IS NULL OR mode NOT IN ('automatic','review_first') THEN
      RAISE EXCEPTION 'Knowledge learning is Off for this task' USING ERRCODE='42501';
    END IF;
  ELSIF NOT coalesce((actor->'writeScopes') ? scope_value,false) THEN
    RAISE EXCEPTION 'Knowledge write permission required for this scope' USING ERRCODE='42501';
  END IF;
  IF e.id IS NULL THEN
    IF operation NOT IN ('save','promote_note') OR (p_request->>'expectedVersion')::integer IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Knowledge entry changed or unavailable' USING ERRCODE='40001';
    END IF;
    INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,scope_subject_id,legacy_scope_type,legacy_scope_session_id)
      VALUES(entry_id,p_account,p_workspace,scope_value,CASE WHEN scope_value='workspace' THEN p_workspace END,
        CASE WHEN scope_value='personal' THEN actor->>'subjectId' END,
        CASE WHEN actor->>'retentionScope'='session' THEN 'session' END,
        CASE WHEN actor->>'retentionScope'='session' THEN (actor->>'sessionId')::uuid END) RETURNING * INTO e;
  ELSIF e.version IS DISTINCT FROM (p_request->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'Knowledge entry changed; read its current revision' USING ERRCODE='40001';
  END IF;
  IF e.archived AND operation<>'restore' THEN
    RAISE EXCEPTION 'Restore archived Knowledge before editing it' USING ERRCODE='22023';
  END IF;
  old_revision:=e.published_revision_id;
  disposition:=CASE WHEN mode='review_first' THEN 'pending' ELSE 'published' END;
  IF operation IN ('approve','approve_edit','reject','restore','archive') THEN
    SELECT * INTO r FROM knowledge_entry_revisions v WHERE v.account_id=p_account AND v.entry_id=e.id
      AND v.id=CASE WHEN operation='archive' THEN e.latest_revision_id ELSE (p_request->>'revisionId')::uuid END;
    IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge revision unavailable' USING ERRCODE='42501'; END IF;
    IF operation IN ('approve','approve_edit','reject') AND (r.id IS DISTINCT FROM e.latest_revision_id
      OR NOT EXISTS(SELECT 1 FROM knowledge_entry_decisions d WHERE d.account_id=p_account AND d.entry_id=e.id
        AND d.revision_id=r.id AND d.version=e.version AND d.outcome='pending')) THEN
      RAISE EXCEPTION 'This Knowledge review is no longer current' USING ERRCODE='40001';
    END IF;
    body:=r.body; codec:=r.body_codec_version;
    revision_id:=r.id; batch_id:=r.review_batch_id;
    IF operation IN ('restore','archive') THEN restored_id:=r.id; END IF;
    IF operation='approve_edit' THEN
      IF r.change_kind='archive' THEN RAISE EXCEPTION 'An archive proposal has no editable content' USING ERRCODE='22023'; END IF;
      body:=p_request->'entry'; codec:=(p_request->>'codecVersion')::integer;
    END IF;
  ELSIF operation='save' THEN
    body:=p_request->'entry'; codec:=(p_request->>'codecVersion')::integer;
  ELSIF operation='promote_note' THEN
    body:=knowledge_task_note_source(p_account,p_workspace,p_actor,(p_request->>'noteId')::uuid,
      (p_request->>'expectedNoteVersion')::integer)||jsonb_build_object('kind','note','title',p_request->>'title',
        'evidence','[]'::jsonb,'relationships','[]'::jsonb,'groupIds',p_request->'groupIds');
    codec:=NULL;
  END IF;

  IF operation IN ('save','promote_note','approve_edit','restore','archive') THEN
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR jsonb_typeof(body->'title') IS DISTINCT FROM 'string'
      OR jsonb_typeof(body->'content') IS DISTINCT FROM 'string'
      OR body->>'kind' NOT IN ('source','fact','decision','requirement','incident','note','group')
      OR body->>'kind' IS NULL OR length(body->>'title') NOT BETWEEN 1 AND 8192
      OR (body->>'kind' NOT IN ('group','source') AND length(btrim(body->>'content'))=0)
      OR (body->>'kind'='source' AND jsonb_typeof(body->'source') IS DISTINCT FROM 'object')
      OR jsonb_typeof(body->'evidence') IS DISTINCT FROM 'array' OR (operation IN ('save','promote_note','approve_edit') AND jsonb_array_length(body->'evidence')>256)
      OR jsonb_typeof(body->'groupIds') IS DISTINCT FROM 'array' OR (operation IN ('save','promote_note','approve_edit') AND jsonb_array_length(body->'groupIds')>256)
      OR jsonb_typeof(body->'relationships') IS DISTINCT FROM 'array' OR (operation IN ('save','promote_note','approve_edit') AND jsonb_array_length(body->'relationships')>256)
      OR (codec IS NOT NULL AND codec<>1) THEN
      RAISE EXCEPTION 'Invalid Knowledge entry content' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM knowledge_entry_revisions v WHERE v.account_id=p_account AND v.id=e.latest_revision_id
      AND (v.body->>'kind'='group')<>(knowledge_entry_apply.body->>'kind'='group')) THEN
      RAISE EXCEPTION 'A Knowledge group cannot become a content entry' USING ERRCODE='22023';
    END IF;
    IF disposition='pending' THEN
      owner_key:=CASE scope_value WHEN 'personal' THEN 'personal:'||e.scope_subject_id
        WHEN 'organization' THEN 'organization:'||p_account ELSE 'workspace:'||e.scope_workspace_id END;
      SELECT id INTO batch_id FROM knowledge_review_batches b WHERE b.account_id=p_account AND b.owner_key=knowledge_entry_apply.owner_key
        AND ((actor->>'scheduledTaskRunId' IS NOT NULL AND b.scheduled_task_run_id=(actor->>'scheduledTaskRunId')::uuid)
          OR (actor->>'scheduledTaskRunId' IS NULL AND b.turn_id=(actor->>'turnId')::uuid));
      IF batch_id IS NULL THEN
        INSERT INTO knowledge_review_batches(account_id,origin_workspace_id,owner_key,session_id,turn_id,scheduled_task_run_id)
          VALUES(p_account,p_workspace,owner_key,(actor->>'sessionId')::uuid,(actor->>'turnId')::uuid,
            (actor->>'scheduledTaskRunId')::uuid) RETURNING id INTO batch_id;
      END IF;
    ELSE batch_id:=NULL; END IF;
    IF operation<>'archive' THEN
      PERFORM knowledge_validate_source(p_account,e.id,body);
      PERFORM knowledge_validate_links(p_account,e.id,body,batch_id);
    END IF;
    SELECT coalesce(max(v.number),0)+1 INTO next_number FROM knowledge_entry_revisions v WHERE v.account_id=p_account AND v.entry_id=e.id;
    INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,body_codec_version,preview,preview_codec_version,
      previous_revision_id,restored_from_revision_id,actor,created_by_session_id,created_by_turn_id,review_batch_id,change_kind)
      VALUES(p_account,e.id,next_number,body,codec,coalesce(p_request->>'preview',r.preview,substring(body->>'content' FROM 1 FOR 512)),
        CASE WHEN p_request ? 'preview' THEN 1 ELSE r.preview_codec_version END,e.latest_revision_id,restored_id,p_actor,
        (actor->>'sessionId')::uuid,(actor->>'turnId')::uuid,batch_id,
        CASE WHEN operation='archive' THEN 'archive' ELSE 'upsert' END) RETURNING id INTO revision_id;
    INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
      SELECT p_account,e.id,revision_id,(row_number() OVER ())::integer-1,links.target,links.rev,links.relation
      FROM (
        SELECT (x->>'entryId')::uuid AS target,(x->>'revisionId')::uuid AS rev,'evidence' AS relation
          FROM jsonb_array_elements(body->'evidence') x
        UNION ALL SELECT x::uuid,NULL,'group' FROM jsonb_array_elements_text(body->'groupIds') x
        UNION ALL SELECT (x->>'entryId')::uuid,NULL,x->>'relation' FROM jsonb_array_elements(body->'relationships') x
      ) links;
    IF operation='archive' AND disposition='published' THEN disposition:='archived'; END IF;
  ELSIF operation='approve' THEN
    IF r.change_kind='archive' THEN disposition:='archived';
    ELSE
      PERFORM knowledge_validate_source(p_account,e.id,body);
      PERFORM knowledge_validate_links(p_account,e.id,body,NULL);
      disposition:='published';
    END IF;
  ELSIF operation='reject' THEN disposition:='rejected';
  END IF;
  UPDATE knowledge_entries h SET version=e.version+1,latest_revision_id=revision_id,
    published_revision_id=CASE WHEN disposition='published' THEN revision_id ELSE h.published_revision_id END,
    archived=CASE WHEN disposition='archived' THEN true WHEN operation='restore' AND disposition='published' THEN false ELSE h.archived END,
    updated_at=clock_timestamp() WHERE h.account_id=p_account AND h.id=e.id;
  INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,policy_snapshot)
    VALUES(p_account,e.id,revision_id,e.version+1,disposition,p_actor,actor->'policy');
  IF operation IN ('save','promote_note','approve_edit','restore','archive') THEN
    -- The adapter supplies a lossless-text search projection; it is not evidence.
    search_text:=coalesce(p_request->>'searchText',(body->>'title')||' '||(body->>'content'));
    IF restored_id IS NOT NULL THEN
      INSERT INTO knowledge_entry_search(account_id,entry_id,revision_id,chunk_index,search_vector)
        SELECT p_account,e.id,knowledge_entry_apply.revision_id,v.chunk_index,v.search_vector FROM knowledge_entry_search v
        WHERE v.account_id=p_account AND v.entry_id=e.id AND v.revision_id=restored_id;
    ELSE
      PERFORM knowledge_index_revision(p_account,e.id,revision_id,search_text);
    END IF;
  END IF;
  result:=jsonb_build_object('operationId',operation_id,'entryId',e.id,'revisionId',revision_id,
    'version',e.version+1,'outcome',disposition,'reviewBatchId',batch_id,'replayed',false);
  INSERT INTO knowledge_entry_operations(account_id,origin_workspace_id,operation_id,entry_id,actor,request_hash,receipt)
    VALUES(p_account,p_workspace,operation_id,e.id,p_actor,fingerprint,result);
  RETURN result;
END $$;

CREATE FUNCTION knowledge_entry_read(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<knowledge_entry_read>>
DECLARE actor jsonb; result jsonb; pending boolean:=p_request->>'view'='needs_review';
  operation text:=coalesce(p_request->>'operation','list'); take integer:=coalesce((p_request->>'limit')::integer,20);
  query_embedding vector:=CASE WHEN jsonb_typeof(p_request->'embedding')='array' THEN (p_request->'embedding')::text::vector END;
BEGIN
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  pending:=coalesce(pending,false);
  IF operation='policy' AND actor->>'kind'='agent' THEN RETURN actor->'policy'; END IF;
  IF take NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid Knowledge page size' USING ERRCODE='22023'; END IF;
  IF operation IN ('source_list','source_read') THEN
    IF actor->>'kind'<>'agent' OR actor#>>'{policy,scheduledTaskRunId}' IS NULL THEN
      RAISE EXCEPTION 'Source content requires its accepted agent run' USING ERRCODE='42501'; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY id),'[]'::jsonb) INTO result FROM (
      SELECT e.id,jsonb_build_object('entryId',e.id,'revisionId',r.id,'title',r.body->'title',
        'codecVersion',r.body_codec_version,'pending',r.id IS DISTINCT FROM e.published_revision_id)
        || CASE WHEN operation='source_read' THEN jsonb_build_object('content',r.body->'content') ELSE '{}'::jsonb END AS value
      FROM scheduled_task_runs run
      JOIN knowledge_document_versions v ON v.account_id=run.account_id
        AND v.source_id=(run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,sourceId}')::uuid
      JOIN knowledge_entries e ON e.account_id=v.account_id AND e.legacy_document_version_id=v.id
      JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
        AND r.id=coalesce(CASE WHEN EXISTS(SELECT 1 FROM knowledge_review_batches b
          JOIN knowledge_entry_revisions candidate ON candidate.account_id=b.account_id AND candidate.review_batch_id=b.id
          JOIN knowledge_entry_decisions d ON d.account_id=e.account_id AND d.entry_id=e.id
            AND d.revision_id=candidate.id AND d.version=e.version AND d.outcome='pending'
          WHERE b.account_id=e.account_id AND b.scheduled_task_run_id=run.id AND candidate.id=e.latest_revision_id)
          THEN e.latest_revision_id END,e.published_revision_id)
      WHERE run.account_id=p_account AND run.workspace_id=p_workspace
        AND run.id=(knowledge_entry_read.actor#>>'{policy,scheduledTaskRunId}')::uuid
        AND run.action_kind='agent_turn' AND NOT e.archived AND knowledge_scope_visible(e)
        AND (operation='source_read' OR (r.created_at>=run.created_at
          AND e.document_preparation->>'scheduledTaskRunId'=run.id::text))
        AND knowledge_revision_visible(p_account,e.id,r.id,true)
        AND (NOT(p_request ? 'afterId') OR e.id>(p_request->>'afterId')::uuid)
        AND (operation<>'source_read' OR e.id=(p_request->>'entryId')::uuid)
      ORDER BY e.id LIMIT CASE WHEN operation='source_read' THEN 1 ELSE take+1 END
    ) page;
    RETURN result;
  END IF;

  IF (operation='history' OR p_request->>'view'='rejected')
    AND (actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'Knowledge history requires human review access' USING ERRCODE='42501';
  END IF;
  IF pending AND actor->>'kind'<>'agent'
    AND (actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'Pending Knowledge requires a live agent or human reviewer' USING ERRCODE='42501';
  END IF;
  IF p_request->>'view'='archived' AND actor->>'kind'<>'human' THEN
    RAISE EXCEPTION 'Archived Knowledge is a human management view' USING ERRCODE='42501';
  END IF;
  IF operation='review_batches' THEN
    IF actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Knowledge review groups require human review access' USING ERRCODE='42501'; END IF;
    WITH visible AS MATERIALIZED (
      SELECT b.id,e.scope,b.session_id,b.scheduled_task_run_id,b.created_at,e.id AS entry_id
      FROM knowledge_entries e JOIN knowledge_entry_revisions r
        ON r.account_id=e.account_id AND r.entry_id=e.id AND r.id=e.latest_revision_id
      JOIN knowledge_review_batches b ON b.account_id=e.account_id AND b.id=r.review_batch_id
      JOIN LATERAL (SELECT d.outcome FROM knowledge_entry_decisions d WHERE d.account_id=e.account_id
        AND d.entry_id=e.id AND d.revision_id=r.id ORDER BY d.version DESC LIMIT 1) decision ON true
      WHERE e.account_id=p_account AND decision.outcome='pending' AND knowledge_scope_visible(e)
        AND (knowledge_entry_read.actor->'writeScopes') ? e.scope AND knowledge_revision_visible(p_account,e.id,r.id,true)
        AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
    ), batches AS (
      SELECT id,scope,session_id,scheduled_task_run_id,created_at,count(*) AS pending_count FROM visible
      GROUP BY id,scope,session_id,scheduled_task_run_id,created_at
      HAVING NOT(p_request ? 'afterId') OR id>(p_request->>'afterId')::uuid
      ORDER BY id LIMIT take+1
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'scope',b.scope,'pendingCount',b.pending_count,
      'createdAt',b.created_at,'sessionId',s.id,'scheduledTaskId',task.id,'scheduledTaskRunId',run.id,
      'title',coalesce(task.name,s.title)) ORDER BY b.id),'[]'::jsonb) INTO result
      FROM batches b LEFT JOIN sessions s ON s.account_id=p_account AND s.id=b.session_id
      LEFT JOIN scheduled_task_runs run ON run.account_id=p_account AND run.id=b.scheduled_task_run_id
      LEFT JOIN scheduled_tasks task ON task.account_id=p_account AND task.id=run.task_id;
    RETURN result;
  END IF;
  IF operation NOT IN ('list','get','history','file') OR (operation='file' AND NOT(p_request ? 'entryId')) THEN RAISE EXCEPTION 'Invalid Knowledge read' USING ERRCODE='22023'; END IF;
  -- Materialize access-filtered records before matching, ranking or pagination.
  WITH candidates AS MATERIALIZED (
    SELECT e.*,r.id AS revision_id,r.number,r.change_kind,r.body,r.body_codec_version,r.preview,r.preview_codec_version,
      r.previous_revision_id,r.restored_from_revision_id,r.created_by_session_id,r.review_batch_id,r.created_at AS revision_created_at,
      CASE WHEN r.id=e.published_revision_id THEN 'published'
        WHEN d.outcome='pending' AND r.id=e.latest_revision_id THEN 'pending'
        WHEN d.outcome='rejected' THEN 'rejected' ELSE 'superseded' END AS outcome
    FROM knowledge_entries e
    JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
      AND (operation='history' OR r.id=CASE WHEN p_request ? 'revisionId' THEN (p_request->>'revisionId')::uuid
        WHEN pending THEN e.latest_revision_id
        WHEN p_request->>'view'='rejected' THEN e.latest_revision_id
        WHEN p_request->>'view'='archived' THEN coalesce(e.published_revision_id,e.latest_revision_id)
        ELSE e.published_revision_id END)
    LEFT JOIN LATERAL (SELECT outcome FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
      AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1) d ON true
    WHERE e.account_id=p_account AND knowledge_scope_visible(e)
      AND (operation='history' OR (p_request ? 'revisionId' AND knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true')
        OR e.archived=coalesce(p_request->>'view'='archived',false))
      AND (NOT pending OR (d.outcome='pending' AND r.id=e.latest_revision_id
        AND (knowledge_entry_read.actor->>'kind'='agent' OR (knowledge_entry_read.actor->'writeScopes') ? e.scope)))
      AND (p_request->>'view' IS DISTINCT FROM 'rejected' OR d.outcome='rejected')
      AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
      AND (NOT(p_request ? 'entryId') OR e.id=(p_request->>'entryId')::uuid)
      AND (NOT(p_request ? 'kind') OR r.body->>'kind'=p_request->>'kind')
      AND (NOT(p_request ? 'fileId') OR r.body#>>'{source,fileId}'=p_request->>'fileId'
        OR EXISTS(SELECT 1 FROM knowledge_entry_links l
          JOIN knowledge_entry_revisions source_revision ON source_revision.account_id=l.account_id
            AND source_revision.entry_id=l.target_entry_id AND source_revision.id=l.target_revision_id
          WHERE l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=r.id
            AND l.relation='evidence' AND source_revision.body#>>'{source,fileId}'=p_request->>'fileId'))
      AND (NOT(p_request ? 'sessionId') OR r.created_by_session_id=(p_request->>'sessionId')::uuid)
      AND (NOT(p_request ? 'reviewBatchId') OR r.review_batch_id=(p_request->>'reviewBatchId')::uuid)
      AND (NOT(p_request ? 'groupId') OR EXISTS(SELECT 1 FROM knowledge_entry_links l
        WHERE l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=r.id
          AND l.relation='group' AND l.target_entry_id=(p_request->>'groupId')::uuid
          AND EXISTS(SELECT 1 FROM knowledge_entries g WHERE g.account_id=p_account AND g.id=l.target_entry_id
            AND NOT g.archived AND knowledge_revision_visible(p_account,g.id,
              CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END,pending))))
      AND (NOT(p_request ? 'beforeRevision') OR r.number<(p_request->>'beforeRevision')::integer)
      AND (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'
        OR (pending AND knowledge_entry_read.actor->>'kind'='agent')
        OR EXISTS(SELECT 1 FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
          AND v.entry_id=e.id AND v.revision_id=r.id AND v.outcome='published'))
      AND knowledge_revision_visible(p_account,e.id,r.id,
        pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'))
  ), scored AS (
    SELECT c.*,coalesce(lex.score,0) AS keyword_score,coalesce(semantic.similarity,0) AS similarity,
      CASE WHEN coalesce(p_request->>'query','')='' THEN 0
        WHEN coalesce(p_request->>'mode','hybrid')='vector' THEN coalesce(semantic.similarity,0)
        WHEN coalesce(p_request->>'mode','hybrid')='keyword' THEN coalesce(lex.score/(1+lex.score),0)
        ELSE coalesce(lex.score/(1+lex.score),0)+coalesce(semantic.similarity,0) END AS score,
      CASE WHEN semantic.keyword_match OR semantic.similarity>=0.2 THEN
        jsonb_build_array(jsonb_build_object('field',semantic.field,'start',semantic.start_offset,'end',semantic.end_offset,
          'text',semantic.text,'codecVersion',semantic.text_codec_version)) ELSE '[]'::jsonb END AS excerpts
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT max(ts_rank_cd(s.search_vector,websearch_to_tsquery('simple',p_request->>'query'))) AS score
      FROM knowledge_entry_search s WHERE s.account_id=p_account AND s.entry_id=c.id AND s.revision_id=c.revision_id
        AND coalesce(p_request->>'query','')<>''
    ) lex ON true
    LEFT JOIN LATERAL (
      SELECT v.field,v.start_offset,v.end_offset,v.text,v.text_codec_version,
        v.keyword_match,max(v.similarity) OVER () AS similarity FROM (
        SELECT cache.*,
          to_tsvector('simple',cache.text)@@websearch_to_tsquery('simple',p_request->>'query') AS keyword_match,
          CASE WHEN query_embedding IS NOT NULL AND cache.dimensions=vector_dims(query_embedding)
            AND cache.model=p_request->>'embeddingModel' AND vector_norm(query_embedding)>0
            THEN greatest(0,least(1,1-(cache.embedding<=>query_embedding))) ELSE 0 END AS similarity
        FROM knowledge_entry_vectors cache JOIN knowledge_index_jobs job ON job.account_id=cache.account_id
          AND job.revision_id=cache.revision_id AND job.completed_generation=cache.generation
        WHERE cache.account_id=p_account AND cache.entry_id=c.id AND cache.revision_id=c.revision_id
          AND coalesce(p_request->>'query','')<>''
      ) v ORDER BY CASE WHEN p_request->>'mode'='vector' THEN false ELSE v.keyword_match END DESC,v.similarity DESC,v.chunk_index LIMIT 1
    ) semantic ON true
  ), page AS (
    SELECT * FROM scored s WHERE (coalesce(p_request->>'query','')=''
      OR (coalesce(p_request->>'mode','hybrid')<>'vector' AND s.keyword_score>0)
      OR (coalesce(p_request->>'mode','hybrid')<>'keyword' AND s.similarity>=0.2))
      AND (NOT(p_request ? 'afterId') OR s.score<(p_request->>'afterScore')::double precision
        OR (s.score=(p_request->>'afterScore')::double precision AND s.id>(p_request->>'afterId')::uuid))
    ORDER BY s.score DESC,s.id,s.number DESC LIMIT take+1
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
    'score',c.score,'excerpts',c.excerpts,'id',c.id,'scope',c.scope,'version',c.version,'publishedRevisionId',c.published_revision_id,
    'latestRevisionId',c.latest_revision_id,'archived',c.archived,'createdAt',c.created_at,'updatedAt',c.updated_at,
    'revision',jsonb_build_object('id',c.revision_id,'entryId',c.id,'number',c.number,
      'entry',CASE WHEN operation IN ('get','file') THEN knowledge_entry_visible_body(p_account,c.body,pending) ELSE NULL END,'change',c.change_kind,
      'title',c.body->'title','kind',c.body->>'kind','preview',c.preview,'groupIds',knowledge_entry_visible_body(p_account,c.body,pending)->'groupIds',
      'sourceKind',c.body#>>'{source,kind}','bodyCodecVersion',c.body_codec_version,'previewCodecVersion',c.preview_codec_version,
      'previousRevisionId',c.previous_revision_id,'restoredFromRevisionId',c.restored_from_revision_id,
      'createdAt',c.revision_created_at,'createdBySessionId',c.created_by_session_id,
      'reviewBatchId',c.review_batch_id,'outcome',c.outcome)
  ) ORDER BY c.score DESC,c.id,c.number DESC),'[]'::jsonb) INTO result FROM page c;
  IF operation='file' THEN
    IF result#>>'{0,revision,entry,source,documentId}' IS NOT NULL THEN
      SELECT to_jsonb(f) INTO result FROM resolve_document_original_file(p_account,p_workspace,
        nullif(current_setting('opengeni.subject_id',true),''),(result#>>'{0,revision,entry,source,documentId}')::uuid) f;
    ELSE
      SELECT to_jsonb(f) INTO result FROM files f WHERE f.account_id=p_account AND f.status='ready'
        AND f.id=(result#>>'{0,revision,entry,source,fileId}')::uuid;
    END IF;
  END IF;
  RETURN result;
END $$;

-- Source preparation is an exact-attempt operation on an existing original.
-- The stable owner/file identity makes retries, children and scheduled re-reads
-- converge. A rejected or archived source is never silently re-published.
CREATE FUNCTION knowledge_entry_prepare_file(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE actor jsonb; f files%ROWTYPE; e knowledge_entries%ROWTYPE;
  entry_id uuid; identity_hash text; receipt jsonb; operation text:=p_request->>'operation';
  file_id uuid:=(p_request->>'fileId')::uuid; body jsonb;
BEGIN
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  IF actor->>'kind' IS DISTINCT FROM 'agent' OR file_id IS NULL OR operation IS NULL
    OR operation NOT IN ('inspect','complete') THEN
    RAISE EXCEPTION 'Source preparation requires an exact agent attempt' USING ERRCODE='42501'; END IF;
  IF actor#>>'{policy,effective,knowledge}'='off' THEN RETURN jsonb_build_object('status','disabled','fileId',file_id); END IF;
  SELECT * INTO f FROM files WHERE account_id=p_account AND id=file_id AND status='ready'
    AND (workspace_id=p_workspace OR (actor->>'defaultScope'='personal' AND actor->>'subjectId'=ANY(private_owner_subject_ids)));
  IF NOT FOUND OR NOT knowledge_source_visible(p_account,jsonb_build_object('source',jsonb_build_object('fileId',file_id))) THEN
    RAISE EXCEPTION 'Source file unavailable' USING ERRCODE='42501'; END IF;
  identity_hash:=md5('prepared-knowledge-file:'||p_account||':'||file_id||':'||
    CASE WHEN actor->>'defaultScope'='personal' THEN 'personal:'||(actor->>'subjectId') ELSE 'workspace:'||p_workspace END||
    CASE WHEN actor->>'retentionScope'='session' THEN ':session:'||(actor->>'sessionId') ELSE '' END);
  entry_id:=(substring(identity_hash,1,8)||'-'||substring(identity_hash,9,4)||'-5'||substring(identity_hash,14,3)||'-a'||substring(identity_hash,18,3)||'-'||substring(identity_hash,21,12))::uuid;
  -- Do not keep a transaction open while a parser or object store is running.
  -- Complete rechecks both authority and identity under the publication lock.
  IF operation='complete' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  END IF;
  SELECT * INTO e FROM knowledge_entries WHERE account_id=p_account AND id=entry_id;
  IF FOUND THEN
    IF e.prepared_file_id IS DISTINCT FROM file_id OR NOT knowledge_scope_visible(e) THEN
      RAISE EXCEPTION 'Prepared source identity is unavailable' USING ERRCODE='42501'; END IF;
    SELECT jsonb_build_object('operationId',o.operation_id,'entryId',e.id,'revisionId',e.latest_revision_id,
      'version',e.version,'outcome',CASE WHEN e.archived THEN 'archived' ELSE d.outcome END,
      'reviewBatchId',r.review_batch_id,'replayed',true) INTO receipt
      FROM knowledge_entry_decisions d JOIN knowledge_entry_revisions r ON r.account_id=d.account_id AND r.id=d.revision_id
      JOIN knowledge_entry_operations o ON o.account_id=d.account_id AND o.entry_id=d.entry_id AND o.receipt->>'revisionId'=d.revision_id::text
      WHERE d.account_id=p_account AND d.entry_id=e.id AND d.version=e.version ORDER BY o.created_at DESC LIMIT 1;
    IF receipt IS NULL THEN RAISE EXCEPTION 'Prepared source receipt unavailable' USING ERRCODE='55000'; END IF;
    RETURN jsonb_build_object('status','retained','fileId',file_id,'filename',f.filename,'receipt',receipt);
  END IF;
  IF operation='inspect' THEN
    RETURN jsonb_build_object('status','prepare','fileId',file_id,'file',to_jsonb(f));
  END IF;
  IF jsonb_typeof(p_request->'content') IS DISTINCT FROM 'string' OR p_request->>'codecVersion' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Invalid prepared source content' USING ERRCODE='22023'; END IF;
  body:=jsonb_build_object('title',p_request->'title','kind','source','content',p_request->'content',
    'source',jsonb_build_object('kind','file','fileId',f.id,'version',coalesce(p_request->>'sourceVersion',f.sha256,f.id::text),
      'retention','full_text','capturedAt',clock_timestamp()),'evidence','[]'::jsonb,'groupIds','[]'::jsonb,'relationships','[]'::jsonb);
  receipt:=knowledge_entry_apply(p_account,p_workspace,p_actor,jsonb_build_object('operation','save','operationId',gen_random_uuid(),
    'entryId',entry_id,'expectedVersion',0,'entry',body,'codecVersion',1,'preview',p_request->'preview','searchText',p_request->'searchText'));
  UPDATE knowledge_entries SET prepared_file_id=file_id WHERE account_id=p_account AND id=entry_id;
  RETURN jsonb_build_object('status','retained','fileId',file_id,'filename',f.filename,'receipt',receipt);
END $$;

-- Compatibility adapter for existing Document indexing obligations. New chat
-- ingestion uses exact agent attempts. This mechanical adapter can prepare only
-- its retained original, under its existing document ownership and frozen task
-- policy; it never gains human authority or invents agent findings.
CREATE FUNCTION knowledge_document_prepare(p_account uuid,p_workspace uuid,p_document uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE document documents%ROWTYPE; entry knowledge_entries%ROWTYPE; original files%ROWTYPE;
  obligation knowledge_source_sync_index_obligations%ROWTYPE; scheduled scheduled_task_runs%ROWTYPE;
  prior knowledge_entry_revisions%ROWTYPE; lease uuid; policy jsonb; body jsonb; result jsonb; actor jsonb;
  operation text:=p_request->>'operation'; accepted_at timestamptz; fingerprint text;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR operation IS NULL OR operation NOT IN ('claim','complete') THEN
    RAISE EXCEPTION 'Invalid document preparation authority' USING ERRCODE='42501'; END IF;
  -- Same publication lock order as ordinary Knowledge writes.
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  SELECT * INTO document FROM documents d WHERE d.account_id=p_account AND d.workspace_id=p_workspace
    AND d.id=p_document FOR UPDATE;
  IF NOT FOUND OR document.status NOT IN ('indexing','ready') OR document.file_id IS DISTINCT FROM (p_request->>'fileId')::uuid THEN
    RAISE EXCEPTION 'Document original changed or is unavailable' USING ERRCODE='42501'; END IF;
  PERFORM set_config('opengeni.subject_id',coalesce(document.authority_subject_id,document.created_by,''),true);
  PERFORM set_config('opengeni.private_file_owner',coalesce(document.authority_subject_id,''),true);
  SELECT * INTO original FROM files f WHERE f.account_id=p_account AND f.id=document.file_id AND f.status='ready';
  IF NOT FOUND THEN RAISE EXCEPTION 'Document original unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO entry FROM knowledge_entries e WHERE e.account_id=p_account AND (e.legacy_document_id=p_document
    OR e.legacy_document_version_id IN (SELECT v.id FROM knowledge_document_versions v WHERE v.account_id=p_account AND v.document_id=p_document))
    ORDER BY (e.legacy_document_id=p_document) DESC NULLS LAST,e.created_at DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO obligation FROM knowledge_source_sync_index_obligations o
    WHERE o.account_id=p_account AND o.workspace_id=p_workspace AND o.document_id=p_document
    ORDER BY o.object_version_generation DESC,o.created_at DESC LIMIT 1;
  IF obligation.id IS NOT NULL AND (obligation.status='invalidated' OR NOT EXISTS(
    SELECT 1 FROM knowledge_document_versions v
    JOIN knowledge_source_objects o ON o.account_id=v.account_id AND o.id=v.object_id AND o.lifecycle_state='active'
      AND o.current_version_id=v.id AND o.version_generation=obligation.object_version_generation
      AND o.lifecycle_generation=obligation.object_lifecycle_generation
    JOIN knowledge_sources s ON s.account_id=v.account_id AND s.id=v.source_id AND s.lifecycle_state='active'
      AND s.lifecycle_generation=obligation.source_lifecycle_generation AND s.current_acl_generation=v.acl_generation
    JOIN knowledge_providers p ON p.account_id=s.account_id AND p.id=s.provider_id AND p.lifecycle_state='active'
    WHERE v.account_id=p_account AND v.id=obligation.knowledge_document_version_id
      AND (v.document_id IS NULL OR v.document_id=p_document) AND (v.file_id IS NULL OR v.file_id=document.file_id)
  )) THEN RAISE EXCEPTION 'Source observation changed before preparation' USING ERRCODE='42501'; END IF;
  IF obligation.id IS NULL AND NOT google_drive_file_authorized(p_account,p_workspace,coalesce(document.authority_subject_id,document.created_by),document.file_id) THEN
    -- A normal upload cannot borrow a source-sync processing obligation.
    RAISE EXCEPTION 'Document original is no longer authorized' USING ERRCODE='42501'; END IF;
  IF operation='claim' THEN
    IF obligation.id IS NOT NULL THEN
      SELECT * INTO scheduled FROM scheduled_task_runs r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
        AND r.id=obligation.scheduled_task_run_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Source indexing run is no longer available' USING ERRCODE='42501'; END IF;
      accepted_at:=scheduled.created_at;
      SELECT snapshot.snapshot INTO policy FROM agent_learning_snapshots snapshot
        JOIN session_turns t ON t.account_id=snapshot.account_id AND t.id=snapshot.turn_id
        WHERE t.account_id=p_account AND t.workspace_id=p_workspace AND t.scheduled_task_run_id=scheduled.id
        ORDER BY t.created_at LIMIT 1;
      IF scheduled.action_kind<>'agent_turn' OR policy IS NULL THEN
        RAISE EXCEPTION 'Source preparation requires an accepted agent learning snapshot' USING ERRCODE='42501'; END IF;
    ELSE
      -- An explicit old Document upload is human/service-authored source input,
      -- not an automatic finding. Its source copy keeps that existing authority.
      policy:=jsonb_build_object('effective',jsonb_build_object('knowledge','automatic'));
      accepted_at:=document.created_at;
    END IF;
    IF policy#>>'{effective,knowledge}'='off' THEN
      RETURN jsonb_build_object('status','disabled','fileId',document.file_id);
    END IF;
    IF entry.id IS NULL THEN
      INSERT INTO knowledge_entries(account_id,origin_workspace_id,scope,scope_workspace_id,scope_subject_id,
        legacy_document_id,legacy_document_version_id,access_document_id)
      VALUES(p_account,p_workspace,document.authority_kind,
        CASE WHEN document.authority_kind='workspace' THEN document.authority_workspace_id END,
        CASE WHEN document.authority_kind='personal' THEN document.authority_subject_id END,
        p_document,obligation.knowledge_document_version_id,p_document) RETURNING * INTO entry;
    END IF;
    IF entry.scope IS DISTINCT FROM document.authority_kind
      OR entry.scope_subject_id IS DISTINCT FROM document.authority_subject_id
      OR (entry.scope='workspace' AND entry.scope_workspace_id IS DISTINCT FROM document.authority_workspace_id) THEN
      RAISE EXCEPTION 'Document ownership differs from retained Knowledge' USING ERRCODE='42501'; END IF;
    lease:=gen_random_uuid();
    UPDATE knowledge_entries SET legacy_document_id=p_document,document_preparation=jsonb_build_object('leaseId',lease,
      'leaseUntil',clock_timestamp()+interval '15 minutes','expectedVersion',entry.version,
      'fileId',document.file_id,'policy',policy,'acceptedAt',accepted_at,'scheduledTaskRunId',scheduled.id)
      WHERE id=entry.id;
    RETURN jsonb_build_object('status','prepare','entryId',entry.id,'leaseId',lease,'fileId',document.file_id,'file',to_jsonb(original));
  END IF;
  IF entry.id IS NULL OR entry.document_preparation->>'leaseId' IS DISTINCT FROM p_request->>'leaseId'
    OR entry.document_preparation->>'fileId' IS DISTINCT FROM document.file_id::text THEN
    RAISE EXCEPTION 'Document preparation lease changed' USING ERRCODE='40001'; END IF;
  fingerprint:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
  IF entry.document_preparation ? 'completion' THEN
    IF entry.document_preparation->>'completionHash' IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'Document preparation replay differs' USING ERRCODE='23505'; END IF;
    result:=entry.document_preparation->'completion';
    RETURN CASE WHEN result->>'status'='retained' THEN jsonb_set(result,'{receipt,replayed}','true'::jsonb) ELSE result END;
  END IF;
  IF (entry.document_preparation->>'leaseUntil')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'Document preparation lease expired' USING ERRCODE='40001'; END IF;
  IF p_request->>'codecVersion' IS DISTINCT FROM '1' OR jsonb_typeof(p_request->'content') IS DISTINCT FROM 'string'
    OR p_request->>'sourceVersion' !~ '^[0-9a-f]{64}$'
    OR (original.sha256 IS NOT NULL AND lower(original.sha256) IS DISTINCT FROM p_request->>'sourceVersion') THEN
    RAISE EXCEPTION 'Document extraction does not match its original' USING ERRCODE='22023'; END IF;
  IF entry.version IS DISTINCT FROM (entry.document_preparation->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'Knowledge changed during document processing' USING ERRCODE='40001'; END IF;
  SELECT * INTO prior FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.id=entry.latest_revision_id;
  -- Re-reading an unchanged, rejected or archived source cannot publish it.
  IF prior.id IS NOT NULL AND (entry.archived OR (prior.body->'content'=p_request->'content'
    AND prior.body_codec_version=1 AND prior.body#>>'{source,version}'=p_request->>'sourceVersion')) THEN
    result:=jsonb_build_object('status','unchanged','entryId',entry.id,'revisionId',prior.id);
    UPDATE knowledge_entries SET document_preparation=document_preparation||jsonb_build_object('completionHash',fingerprint,'completion',result)
      WHERE id=entry.id;
    RETURN result;
  END IF;
  actor:=jsonb_build_object('kind','source_preparation','entryId',entry.id,'leaseId',p_request->'leaseId');
  UPDATE documents SET status='ready' WHERE id=p_document AND account_id=p_account;
  body:=jsonb_build_object('kind','source','title',p_request->'title','content',p_request->'content',
    'groupIds',coalesce(prior.body->'groupIds','[]'::jsonb),'relationships',coalesce(prior.body->'relationships','[]'::jsonb),
    'evidence',coalesce(prior.body->'evidence','[]'::jsonb),
    'source',jsonb_build_object('kind','file','documentId',p_document,'fileId',document.file_id,
      'version',p_request->'sourceVersion','retention','full_text'));
  result:=knowledge_entry_apply(p_account,p_workspace,actor,jsonb_build_object('operation','save',
    'operationId',p_request->'leaseId','entryId',entry.id,'expectedVersion',entry.version,
    'entry',body,'codecVersion',1,'preview',p_request->'preview','searchText',p_request->'searchText'));
  IF NOT knowledge_index_retention_active(p_account,entry.id,(result->>'revisionId')::uuid,p_document) THEN
    RAISE EXCEPTION 'Document source was withdrawn during processing' USING ERRCODE='42501'; END IF;
  result:=jsonb_build_object('status','retained','receipt',result);
  UPDATE knowledge_entries SET document_preparation=document_preparation||jsonb_build_object('completionHash',fingerprint,'completion',result) WHERE id=entry.id;
  RETURN result;
END $$;

-- Configuration follows the same owner layer as accepted execution.
CREATE FUNCTION knowledge_learning_context_visible(p_account uuid,p_workspace uuid,p_subject text,p_scope text,p_context text)
RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE session sessions%ROWTYPE; task scheduled_tasks%ROWTYPE; target uuid;
BEGIN
  IF p_context ~ '^chat:[0-9a-f-]{36}$' THEN
    SELECT * INTO session FROM sessions WHERE account_id=p_account AND workspace_id=p_workspace AND id=substring(p_context FROM 6)::uuid;
    IF NOT FOUND THEN RETURN false; END IF;
    IF get_workspace_kind(p_account,p_workspace)='personal' THEN RETURN p_scope='personal' AND p_subject IS NOT NULL; END IF;
    IF session.visibility='user_private' THEN RETURN coalesce(p_scope='personal' AND session.owner_subject_id=p_subject,false); END IF;
    IF session.memory_scope='user' THEN RETURN coalesce(p_scope='personal' AND session.scope_subject_id=p_subject,false); END IF;
    RETURN p_scope='workspace';
  ELSIF p_context ~ '^scheduled_task:[0-9a-f-]{36}$' THEN
    SELECT * INTO task FROM scheduled_tasks WHERE account_id=p_account AND workspace_id=p_workspace AND id=substring(p_context FROM 16)::uuid AND deleted_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    IF task.agent_config#>>'{knowledgeSource,destination,kind}'='personal' THEN
      RETURN coalesce(p_scope='personal' AND p_subject=task.agent_config#>>'{knowledgeSource,destination,subjectId}',false); END IF;
    IF get_workspace_kind(p_account,p_workspace)='personal' THEN RETURN p_scope='personal' AND p_subject IS NOT NULL; END IF;
    target:=CASE WHEN task.run_mode IN ('existing_session','reusable_session') THEN task.reusable_session_id END;
    IF target IS NOT NULL THEN RETURN knowledge_learning_context_visible(p_account,p_workspace,p_subject,p_scope,'chat:'||target); END IF;
    IF task.run_mode='existing_session' THEN RETURN false; END IF;
    IF task.creator_session_policy->>'memoryScope'='user' THEN RETURN coalesce(p_scope='personal' AND task.creator_session_policy->>'scopeSubjectId'=p_subject,false); END IF;
    RETURN p_scope='workspace';
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION agent_learning_manage(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<agent_learning_manage>>
DECLARE actor jsonb; owner text; subject text; context_key text:=coalesce(p_request->>'contextKey','defaults');
  scope_value text:=coalesce(p_request->>'scope','workspace'); prior agent_learning_revisions%ROWTYPE;
  current_revision agent_learning_revisions%ROWTYPE; settings jsonb; patch jsonb; key text; val text;
  request_hash text; operation_id uuid:=(p_request->>'operationId')::uuid; result jsonb;
BEGIN
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  -- Read-only contextual scope discovery uses the same exact authority check as
  -- writes. A bounded UI session picker is never the source of owner identity.
  IF actor->>'kind'='human' AND p_request->>'operation'='read' AND scope_value='context' THEN
    IF knowledge_learning_context_visible(p_account,p_workspace,actor->>'subjectId','workspace',context_key) THEN scope_value:='workspace';
    ELSIF knowledge_learning_context_visible(p_account,p_workspace,actor->>'subjectId','personal',context_key) THEN scope_value:='personal';
    ELSE RAISE EXCEPTION 'Agent learning context is unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF actor->>'kind'<>'human' OR scope_value NOT IN ('workspace','personal') THEN
    RAISE EXCEPTION 'Only humans configure Agent learning' USING ERRCODE='42501';
  END IF;
  subject:=CASE WHEN scope_value='personal' THEN actor->>'subjectId' END;
  owner:=CASE WHEN subject IS NULL THEN 'workspace:'||p_workspace ELSE 'personal:'||subject END;
  IF context_key<>'defaults' AND NOT knowledge_learning_context_visible(p_account,p_workspace,actor->>'subjectId',scope_value,context_key) THEN
    RAISE EXCEPTION 'Agent learning context is unavailable in this owner scope' USING ERRCODE='42501';
  END IF;
  IF p_request->>'operation'='list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('contextKey',r.context_key,'version',r.version,
      'settings',r.settings,'updatedAt',r.created_at,'label',coalesce(s.title,t.name,'Untitled chat')) ORDER BY r.context_key),'[]'::jsonb) INTO result
    FROM (SELECT DISTINCT ON (v.context_key) v.* FROM agent_learning_revisions v
      WHERE v.account_id=p_account AND v.owner_key=owner AND v.origin_workspace_id=p_workspace AND v.context_key<>'defaults'
      ORDER BY v.context_key,v.version DESC) r
    LEFT JOIN sessions s ON s.account_id=p_account AND s.workspace_id=p_workspace AND r.context_key='chat:'||s.id

    LEFT JOIN scheduled_tasks t ON t.account_id=p_account AND t.workspace_id=p_workspace AND r.context_key='scheduled_task:'||t.id
      AND t.deleted_at IS NULL
    WHERE r.settings<>'{}'::jsonb AND (s.id IS NOT NULL OR t.id IS NOT NULL)
      AND knowledge_learning_context_visible(p_account,p_workspace,agent_learning_manage.actor->>'subjectId',scope_value,r.context_key);
    RETURN result;
  END IF;
  SELECT * INTO current_revision FROM agent_learning_revisions r WHERE r.account_id=p_account
    AND r.owner_key=owner AND r.context_key=agent_learning_manage.context_key ORDER BY r.version DESC LIMIT 1;
  IF p_request->>'operation'='read' THEN
    RETURN jsonb_build_object('ownerKey',owner,'contextKey',context_key,'version',coalesce(current_revision.version,0),
      'settings',coalesce(current_revision.settings,CASE WHEN context_key='defaults' THEN
        '{"knowledge":"automatic","instructions":"review_first","skills":"review_first"}'::jsonb ELSE '{}'::jsonb END));
  END IF;
  IF p_request->>'operation' IS DISTINCT FROM 'save' OR operation_id IS NULL
    OR NOT coalesce((p_actor->'settingsScopes') ? scope_value,false) THEN
    RAISE EXCEPTION 'Agent learning settings permission required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-learning:'||p_account||':'||owner,0));
  request_hash:=encode(sha256(convert_to(jsonb_build_array(p_actor,p_request)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM agent_learning_revisions r WHERE r.account_id=p_account AND r.operation_id=agent_learning_manage.operation_id;
  IF FOUND THEN
    IF prior.request_hash<>request_hash THEN RAISE EXCEPTION 'Agent learning operation reused' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('ownerKey',owner,'contextKey',context_key,'version',prior.version,'settings',prior.settings);
  END IF;
  SELECT * INTO current_revision FROM agent_learning_revisions r WHERE r.account_id=p_account
    AND r.owner_key=owner AND r.context_key=agent_learning_manage.context_key ORDER BY r.version DESC LIMIT 1;
  IF coalesce(current_revision.version,0) IS DISTINCT FROM (p_request->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'Agent learning settings changed' USING ERRCODE='40001';
  END IF;
  IF context_key='defaults' THEN settings:=p_request->'settings';
  ELSE
    settings:=coalesce(current_revision.settings,'{}'::jsonb); patch:=p_request->'settings';
    IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR patch-'knowledge'-'instructions'-'skills'<>'{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid Agent learning override' USING ERRCODE='22023';
    END IF;
    FOR key,val IN SELECT k,v#>>'{}' FROM jsonb_each(patch) p(k,v) LOOP
      IF val='inherit' THEN settings:=settings-key;
      ELSE settings:=jsonb_set(settings,ARRAY[key],to_jsonb(val),true); END IF;
    END LOOP;
  END IF;
  IF NOT knowledge_learning_settings_valid(settings,context_key='defaults') THEN
    RAISE EXCEPTION 'Invalid Agent learning settings' USING ERRCODE='22023';
  END IF;
  INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,context_key,version,
    settings,operation_id,request_hash,actor_subject_id)
    VALUES(p_account,p_workspace,owner,subject,context_key,coalesce(current_revision.version,0)+1,
      settings,operation_id,request_hash,actor->>'subjectId') RETURNING * INTO prior;
  RETURN jsonb_build_object('ownerKey',owner,'contextKey',context_key,'version',prior.version,'settings',settings);
END $$;

-- Evidence is checked transitively. A stored reference is never an authority
-- shortcut, and a retired/restricted source withdraws dependent retrieval.
CREATE FUNCTION knowledge_document_visible(p_document uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT EXISTS(SELECT 1 FROM documents d
    WHERE d.id=p_document AND d.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
      AND d.status='ready'
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
$$;

CREATE FUNCTION knowledge_source_visible(p_account uuid,p_body jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
<<knowledge_source_visible>>
DECLARE document_id uuid:=(p_body#>>'{source,documentId}')::uuid;
  file_id uuid:=(p_body#>>'{source,fileId}')::uuid;
BEGIN
  IF document_id IS NOT NULL THEN
    RETURN knowledge_document_visible(document_id) AND (file_id IS NULL OR EXISTS(
      SELECT 1 FROM documents d WHERE d.account_id=p_account AND d.id=document_id AND d.file_id=knowledge_source_visible.file_id));
  END IF;
  IF file_id IS NOT NULL THEN
    RETURN EXISTS(SELECT 1 FROM files f WHERE f.account_id=p_account AND f.id=knowledge_source_visible.file_id
      AND f.status='ready') AND google_drive_file_authorized(p_account,nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
      nullif(current_setting('opengeni.subject_id',true),''),file_id);
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION knowledge_validate_source(p_account uuid,p_entry uuid,p_body jsonb) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE e knowledge_entries%ROWTYPE; d documents%ROWTYPE;
BEGIN
  IF NOT knowledge_source_visible(p_account,p_body) THEN
    RAISE EXCEPTION 'Knowledge source unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT e FROM knowledge_entries WHERE account_id=p_account AND id=p_entry;
  IF (e.access_document_id IS NOT NULL AND (p_body#>>'{source,documentId}')::uuid IS DISTINCT FROM e.access_document_id)
    OR (e.access_file_id IS NOT NULL AND (p_body#>>'{source,fileId}')::uuid IS DISTINCT FROM e.access_file_id) THEN
    RAISE EXCEPTION 'A source identity is immutable; retain a different source as a new entry' USING ERRCODE='22023'; END IF;
  IF p_body#>>'{source,documentId}' IS NOT NULL THEN
    SELECT * INTO STRICT d FROM documents WHERE account_id=p_account AND id=(p_body#>>'{source,documentId}')::uuid;
    IF NOT (d.authority_kind='organization'
      OR (d.authority_kind='workspace' AND e.scope IN ('workspace','personal') AND d.authority_workspace_id=e.origin_workspace_id)
      OR (d.authority_kind='personal' AND e.scope='personal' AND d.authority_subject_id=e.scope_subject_id)) THEN
      RAISE EXCEPTION 'Knowledge source would widen document access' USING ERRCODE='42501'; END IF;
  ELSIF p_body#>>'{source,fileId}' IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM files f WHERE f.account_id=p_account
      AND (f.workspace_id=e.origin_workspace_id OR (e.scope='personal' AND e.scope_subject_id=ANY(f.private_owner_subject_ids)))
      AND f.id=(p_body#>>'{source,fileId}')::uuid AND f.status='ready'
      AND (f.private_owner_subject_ids IS NULL OR (e.scope='personal' AND e.scope_subject_id=ANY(f.private_owner_subject_ids)))) OR e.scope='organization' THEN
      RAISE EXCEPTION 'File source requires its authorized scope' USING ERRCODE='42501'; END IF;
  END IF;
  IF e.access_document_id IS NULL AND e.access_file_id IS NULL THEN
    UPDATE knowledge_entries SET access_document_id=(p_body#>>'{source,documentId}')::uuid,
      access_file_id=CASE WHEN p_body#>>'{source,documentId}' IS NULL THEN (p_body#>>'{source,fileId}')::uuid END
      WHERE account_id=p_account AND id=p_entry;
  END IF;
END $$;

-- Imported provider evidence retains both the captured ACL and current source
-- lifecycle. Migrating text into Knowledge never turns revoked input into a
-- workspace-wide grant. These old rows remain provenance/access authority only.
CREATE FUNCTION knowledge_legacy_version_visible(p_account uuid,p_version uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge_document_versions v
    JOIN knowledge_source_objects o ON o.account_id=v.account_id AND o.id=v.object_id AND o.lifecycle_state='active'
    JOIN knowledge_sources s ON s.account_id=v.account_id AND s.id=v.source_id AND s.lifecycle_state='active'
    JOIN knowledge_providers p ON p.account_id=s.account_id AND p.id=s.provider_id AND p.lifecycle_state='active'
    JOIN knowledge_source_acl_versions captured ON captured.account_id=v.account_id AND captured.id=v.acl_version_id
      AND captured.source_id=v.source_id AND captured.generation=v.acl_generation
    JOIN knowledge_source_acl_versions current_acl ON current_acl.account_id=s.account_id AND current_acl.source_id=s.id
      AND current_acl.generation=s.current_acl_generation
    WHERE v.account_id=p_account AND v.id=p_version
      AND (current_setting('opengeni.knowledge_actor_kind',true)='human' OR (captured.agent_access AND current_acl.agent_access))
      AND (v.document_id IS NULL OR knowledge_document_visible(v.document_id))
      AND (v.file_id IS NULL OR google_drive_file_authorized(p_account,
        nullif(current_setting('opengeni.workspace_id',true),'')::uuid,nullif(current_setting('opengeni.subject_id',true),''),v.file_id)))
$$;

CREATE FUNCTION knowledge_revision_visible(p_account uuid,p_entry uuid,p_revision uuid,p_pending boolean)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  WITH RECURSIVE dependencies(entry_id,revision_id) AS (
    SELECT p_entry,p_revision
    UNION
    SELECT l.target_entry_id,l.target_revision_id FROM dependencies d
      JOIN knowledge_entry_links l ON l.account_id=p_account AND l.entry_id=d.entry_id
        AND l.revision_id=d.revision_id AND l.relation='evidence'
  ) SELECT EXISTS(SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
    AND r.entry_id=p_entry AND r.id=p_revision)
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d LEFT JOIN knowledge_entries e ON e.account_id=p_account AND e.id=d.entry_id
        LEFT JOIN knowledge_entry_revisions r ON r.account_id=p_account AND r.entry_id=d.entry_id AND r.id=d.revision_id
      WHERE e.id IS NULL OR NOT knowledge_scope_visible(e) OR (e.archived AND e.id<>p_entry)
        OR (NOT p_pending AND NOT EXISTS(SELECT 1 FROM knowledge_entry_decisions v
          WHERE v.account_id=p_account AND v.entry_id=d.entry_id AND v.revision_id=d.revision_id AND v.outcome='published'))
        OR (e.legacy_document_version_id IS NOT NULL AND NOT knowledge_legacy_version_visible(p_account,e.legacy_document_version_id))
        OR (e.legacy_document_id IS NOT NULL AND NOT knowledge_document_visible(e.legacy_document_id))
        OR (e.access_document_id IS NOT NULL AND NOT knowledge_document_visible(e.access_document_id))
        OR (e.access_file_id IS NOT NULL AND NOT google_drive_file_authorized(p_account,
          nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
          nullif(current_setting('opengeni.subject_id',true),''),e.access_file_id))
        OR r.id IS NULL OR NOT knowledge_source_visible(p_account,r.body)
    )
$$;

-- Relationship labels and group IDs are discovery metadata. Filter unavailable
-- endpoints on every projection; their disappearance does not erase the retained
-- entry or rewrite its immutable revision. Evidence remains a content dependency.
CREATE FUNCTION knowledge_entry_visible_body(p_account uuid,p_body jsonb,p_pending boolean)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT p_body || jsonb_build_object(
    'groupIds',coalesce((SELECT jsonb_agg(g.value ORDER BY g.ordinality)
      FROM jsonb_array_elements(p_body->'groupIds') WITH ORDINALITY g(value,ordinality)
      JOIN knowledge_entries e ON e.account_id=p_account AND e.id=(g.value#>>'{}')::uuid
      WHERE NOT e.archived AND knowledge_revision_visible(p_account,e.id,
        coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)), '[]'::jsonb),
    'relationships',coalesce((SELECT jsonb_agg(l.value ORDER BY l.ordinality)
      FROM jsonb_array_elements(p_body->'relationships') WITH ORDINALITY l(value,ordinality)
      JOIN knowledge_entries e ON e.account_id=p_account AND e.id=(l.value->>'entryId')::uuid
      WHERE NOT e.archived AND knowledge_revision_visible(p_account,e.id,
        coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)), '[]'::jsonb))
$$;

CREATE FUNCTION knowledge_validate_links(p_account uuid,p_entry uuid,p_body jsonb,p_batch uuid)
RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source knowledge_entries%ROWTYPE; target knowledge_entries%ROWTYPE; link record; target_revision uuid;
BEGIN
  SELECT * INTO source FROM knowledge_entries WHERE account_id=p_account AND id=p_entry;
  FOR link IN
    SELECT (x->>'entryId')::uuid AS id,(x->>'revisionId')::uuid AS revision,'evidence' AS relation
      FROM jsonb_array_elements(coalesce(p_body->'evidence','[]'::jsonb)) x
    UNION ALL SELECT x::uuid,NULL,'group' FROM jsonb_array_elements_text(coalesce(p_body->'groupIds','[]'::jsonb)) x
    UNION ALL SELECT (x->>'entryId')::uuid,NULL,x->>'relation'
      FROM jsonb_array_elements(coalesce(p_body->'relationships','[]'::jsonb)) x
    ORDER BY id,relation
  LOOP
    SELECT * INTO target FROM knowledge_entries WHERE account_id=p_account AND id=link.id;
    IF NOT FOUND OR target.id=source.id OR target.archived OR NOT knowledge_scope_visible(target) THEN
      RAISE EXCEPTION 'Knowledge reference unavailable' USING ERRCODE='42501';
    END IF;
    -- The destination's readers must all be eligible to see linked identities.
    IF NOT ((target.scope='organization')
      OR (target.scope='workspace' AND source.scope IN ('workspace','personal')
        AND target.scope_workspace_id=source.origin_workspace_id)
      OR (target.scope='personal' AND source.scope='personal' AND target.scope_subject_id=source.scope_subject_id))
      OR (target.legacy_scope_type IS NOT NULL AND (source.legacy_scope_type IS DISTINCT FROM target.legacy_scope_type
        OR source.legacy_scope_role_key IS DISTINCT FROM target.legacy_scope_role_key
        OR source.legacy_scope_session_id IS DISTINCT FROM target.legacy_scope_session_id)) THEN
      RAISE EXCEPTION 'Knowledge reference would widen source access' USING ERRCODE='42501';
    END IF;
    target_revision:=coalesce(link.revision,target.published_revision_id);
    IF target_revision IS NULL AND p_batch IS NOT NULL THEN
      SELECT id INTO target_revision FROM knowledge_entry_revisions r WHERE r.account_id=p_account
        AND r.entry_id=target.id AND r.id=target.latest_revision_id;
    END IF;
    IF NOT knowledge_revision_visible(p_account,target.id,target_revision,false) AND NOT (
      p_batch IS NOT NULL AND target_revision=target.latest_revision_id
      AND EXISTS(SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
        AND r.entry_id=target.id AND r.id=target_revision)
      AND EXISTS(SELECT 1 FROM knowledge_entry_decisions d WHERE d.account_id=p_account
        AND d.entry_id=target.id AND d.revision_id=target_revision AND d.version=target.version AND d.outcome='pending')
      AND knowledge_revision_visible(p_account,target.id,target_revision,true)) THEN
      RAISE EXCEPTION 'Knowledge evidence has not been published' USING ERRCODE='42501';
    END IF;
    IF link.relation='group' AND NOT EXISTS(SELECT 1 FROM knowledge_entry_revisions r
      WHERE r.account_id=p_account AND r.entry_id=target.id AND r.id=target_revision AND r.body->>'kind'='group') THEN
      RAISE EXCEPTION 'Knowledge membership requires a group' USING ERRCODE='22023';
    END IF;
    IF link.relation='evidence' AND EXISTS(
      WITH RECURSIVE refs(id,rev) AS (
        SELECT target.id,target_revision UNION SELECT l.target_entry_id,l.target_revision_id FROM refs
        JOIN knowledge_entry_links l ON l.account_id=p_account AND l.entry_id=refs.id AND l.revision_id=refs.rev AND l.relation='evidence'
      ) SELECT 1 FROM refs WHERE id=source.id
    ) THEN RAISE EXCEPTION 'Knowledge evidence cannot contain a cycle' USING ERRCODE='22023'; END IF;
  END LOOP;
END $$;

-- Batches are review presentation only. They grant no content or publication authority.
CREATE FUNCTION knowledge_review_batch_for_actor(p_account uuid,p_workspace uuid,p_actor jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE batch uuid; owner text:=CASE WHEN p_actor->>'defaultScope'='personal'
  THEN 'personal:'||(p_actor->>'subjectId') ELSE 'workspace:'||p_workspace END;
BEGIN
  SELECT b.id INTO batch FROM knowledge_review_batches b WHERE b.account_id=p_account AND b.owner_key=owner
    AND ((p_actor->>'scheduledTaskRunId' IS NOT NULL AND b.scheduled_task_run_id=(p_actor->>'scheduledTaskRunId')::uuid)
      OR (p_actor->>'scheduledTaskRunId' IS NULL AND b.turn_id=(p_actor->>'turnId')::uuid));
  IF batch IS NULL THEN
    INSERT INTO knowledge_review_batches(account_id,origin_workspace_id,owner_key,session_id,turn_id,scheduled_task_run_id)
      VALUES(p_account,p_workspace,owner,(p_actor->>'sessionId')::uuid,(p_actor->>'turnId')::uuid,
        (p_actor->>'scheduledTaskRunId')::uuid) RETURNING id INTO batch;
  END IF;
  RETURN batch;
END $$;

-- Historical proposals keep their native revision and immutable provenance.
-- Only maintenance-imported receipts bridge them into the current review list;
-- creating a new legacy proposal cannot become a second authoring path.
CREATE FUNCTION knowledge_instruction_context(p_revision workspace_instruction_policy_revisions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce(p_revision.agent_learning_context,(SELECT op.actor->'legacyInstructionContext'
    FROM agent_instruction_operations op WHERE op.account_id=p_revision.account_id AND op.revision_id=p_revision.id
      AND op.request_hash='migration:0459:instruction-review' AND op.actor->>'kind'='migration' LIMIT 1))
$$;

CREATE FUNCTION agent_instruction_apply(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<instruction_change>>
DECLARE actor jsonb; mode text; operation text:=p_request->>'operation'; fingerprint text; result jsonb;
  operation_id uuid:=(p_request->>'operationId')::uuid; revision_id uuid; batch uuid; actor_subject text;
  target jsonb:=p_request->'target'; context jsonb; expected_revision uuid; expected_version bigint;
  head workspace_instruction_policy_heads%ROWTYPE; revision workspace_instruction_policy_revisions%ROWTYPE;
  prior agent_instruction_operations%ROWTYPE; content_hash text; outcome text; link record; version bigint;
BEGIN
  IF p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Instruction changes require exact tenant scope' USING ERRCODE='42501';
  END IF;
  -- Native instruction activation serializes on this workspace row.
  IF operation IN ('get','list') THEN
    PERFORM 1 FROM workspaces WHERE id=p_workspace AND account_id=p_account FOR KEY SHARE;
  ELSE
    PERFORM 1 FROM workspaces WHERE id=p_workspace AND account_id=p_account FOR UPDATE;
  END IF;
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  IF operation='get' THEN
    SELECT * INTO head FROM workspace_instruction_policy_heads h WHERE h.account_id=p_account AND h.workspace_id=p_workspace
      AND h.kind=target->>'kind' AND h.scope=target->>'scope' AND h.role_key IS NOT DISTINCT FROM target->>'roleKey';
    SELECT * INTO revision FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
      AND r.id=head.revision_id;
    RETURN jsonb_build_object('target',target,'expectedCurrentRevisionId',head.revision_id,
      'expectedActivationVersion',coalesce(head.activation_version,(SELECT max(d.activation_version)
        FROM workspace_instruction_policy_deactivation_events d WHERE d.account_id=p_account AND d.workspace_id=p_workspace
          AND d.kind=target->>'kind' AND d.scope=target->>'scope' AND d.role_key IS NOT DISTINCT FROM target->>'roleKey'),0),
      'content',revision.content);
  END IF;
  IF operation='save' THEN
    IF actor->>'kind'<>'agent' OR (actor->>'defaultScope'='personal' AND get_workspace_kind(p_account,p_workspace)<>'personal') THEN
      RAISE EXCEPTION 'Workspace instructions require a workspace agent context' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,instructions}';
    IF mode NOT IN ('automatic','review_first') OR mode IS NULL THEN
      RAISE EXCEPTION 'Instruction learning is Off' USING ERRCODE='42501';
    END IF;
    actor_subject:='service:agent-learning:'||(p_actor->>'attemptId');
  ELSE
    IF actor->>'kind'<>'human' OR NOT coalesce((p_actor->'settingsScopes') ? 'workspace',false) THEN
      RAISE EXCEPTION 'Instruction review requires workspace administration' USING ERRCODE='42501';
    END IF;
    actor_subject:=actor->>'subjectId';
  END IF;
  IF operation='list' THEN
    RETURN (SELECT coalesce(jsonb_agg(item ORDER BY identity),'[]'::jsonb) FROM (
      SELECT r.id AS identity,jsonb_build_object('revisionId',r.id,'target',jsonb_build_object('kind',r.kind,'scope',r.scope,'roleKey',r.role_key),
        'content',r.content,'createdAt',r.created_at,'reviewBatchId',knowledge_instruction_context(r)->'reviewBatchId',
        'sessionId',knowledge_instruction_context(r)#>'{actor,sessionId}','reason',knowledge_instruction_context(r)->'reason') AS item
      FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
        AND knowledge_instruction_context(r) IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM workspace_instruction_policy_activation_events ev WHERE ev.account_id=p_account
          AND ev.workspace_id=p_workspace AND ev.new_revision_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.revision_id=r.id
          AND op.receipt->>'outcome' IN ('published','rejected'))
        AND NOT EXISTS(SELECT 1 FROM workspace_instruction_policy_revisions newer WHERE newer.account_id=p_account
          AND newer.workspace_id=p_workspace AND newer.kind=r.kind AND newer.scope=r.scope
          AND newer.role_key IS NOT DISTINCT FROM r.role_key AND newer.revision>r.revision)
        AND (NOT(p_request ? 'cursor') OR r.id>(p_request->>'cursor')::uuid)
      ORDER BY r.id LIMIT 51) visible);
  END IF;
  IF operation_id IS NULL OR operation NOT IN ('save','approve','reject') OR length(btrim(p_request->>'reason')) NOT BETWEEN 1 AND 4096 THEN
    RAISE EXCEPTION 'Invalid instruction change' USING ERRCODE='22023';
  END IF;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(
    CASE WHEN p_actor->>'kind'='agent' THEN p_actor-'attemptId'-'executionGeneration' ELSE p_actor END,
    p_request)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.operation_id=instruction_change.operation_id;
  IF FOUND THEN
    IF prior.request_hash<>fingerprint OR prior.origin_workspace_id<>p_workspace THEN
      RAISE EXCEPTION 'Instruction operation key reused' USING ERRCODE='23505'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  IF operation<>'save' THEN
    SELECT * INTO revision FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
      AND r.id=(p_request->>'revisionId')::uuid AND knowledge_instruction_context(r) IS NOT NULL;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.revision_id=revision.id
      AND op.receipt->>'outcome' IN ('published','rejected')) OR EXISTS(SELECT 1 FROM workspace_instruction_policy_revisions newer
      WHERE newer.account_id=p_account AND newer.workspace_id=p_workspace AND newer.kind=revision.kind AND newer.scope=revision.scope
        AND newer.role_key IS NOT DISTINCT FROM revision.role_key AND newer.revision>revision.revision) THEN
      RAISE EXCEPTION 'Instruction review is no longer current' USING ERRCODE='40001'; END IF;
    revision_id:=revision.id; context:=knowledge_instruction_context(revision);
    target:=jsonb_build_object('kind',revision.kind,'scope',revision.scope,'roleKey',revision.role_key);
    expected_revision:=(context->>'expectedCurrentRevisionId')::uuid;
    expected_version:=(context->>'expectedActivationVersion')::bigint;
    batch:=(context->>'reviewBatchId')::uuid;
    outcome:=CASE WHEN operation='approve' THEN 'published' ELSE 'rejected' END;
  ELSE
    IF length(p_request->>'content') NOT BETWEEN 1 AND 600 OR length(btrim(p_request->>'content'))=0
      OR jsonb_typeof(p_request->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(p_request->'evidence')>32 THEN
      RAISE EXCEPTION 'Invalid agent-authored instruction content' USING ERRCODE='22023'; END IF;
    expected_revision:=(p_request->>'expectedCurrentRevisionId')::uuid;
    expected_version:=(p_request->>'expectedActivationVersion')::bigint;
    outcome:=CASE WHEN mode='automatic' THEN 'published' ELSE 'pending' END;
    IF outcome='pending' THEN batch:=knowledge_review_batch_for_actor(p_account,p_workspace,actor); END IF;
    context:=jsonb_build_object('actor',p_actor,'policy',actor->'policy','evidence',p_request->'evidence','reason',p_request->'reason',
      'expectedCurrentRevisionId',expected_revision,'expectedActivationVersion',expected_version,'reviewBatchId',batch);
  END IF;
  SELECT * INTO head FROM workspace_instruction_policy_heads h WHERE h.account_id=p_account AND h.workspace_id=p_workspace
    AND h.kind=target->>'kind' AND h.scope=target->>'scope' AND h.role_key IS NOT DISTINCT FROM target->>'roleKey' FOR UPDATE;
  version:=coalesce(head.activation_version,(SELECT max(d.activation_version) FROM workspace_instruction_policy_deactivation_events d
    WHERE d.account_id=p_account AND d.workspace_id=p_workspace AND d.kind=target->>'kind' AND d.scope=target->>'scope'
      AND d.role_key IS NOT DISTINCT FROM target->>'roleKey'),0);
  IF operation<>'reject' AND (head.revision_id IS DISTINCT FROM expected_revision OR version IS DISTINCT FROM expected_version) THEN
    RAISE EXCEPTION 'Instruction head changed; read its current baseline' USING ERRCODE='40001'; END IF;
  IF operation<>'reject' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
    FOR link IN SELECT * FROM jsonb_array_elements(context->'evidence') LOOP
      IF NOT EXISTS(SELECT 1 FROM knowledge_entries e WHERE e.account_id=p_account AND e.id=(link.value->>'entryId')::uuid
        AND NOT e.archived AND e.scope IN ('workspace','organization') AND knowledge_scope_visible(e)
        AND knowledge_revision_visible(p_account,e.id,(link.value->>'revisionId')::uuid,false)) THEN
        RAISE EXCEPTION 'Instruction evidence is unavailable to workspace readers' USING ERRCODE='42501'; END IF;
    END LOOP;
  END IF;
  IF operation='save' THEN
    content_hash:=encode(sha256(convert_to(p_request->>'content','UTF8')),'hex');
    INSERT INTO workspace_instruction_policy_revisions(account_id,workspace_id,operation_id,request_fingerprint,kind,scope,role_key,
      content,content_hash,provenance_source,provenance_source_id,created_by_subject_id,supersedes_revision_id,agent_learning_context)
      VALUES(p_account,p_workspace,operation_id,fingerprint,target->>'kind',target->>'scope',target->>'roleKey',p_request->>'content',
        content_hash,'agent_learning',p_actor->>'attemptId',actor_subject,expected_revision,context) RETURNING * INTO revision;
    revision_id:=revision.id;
  END IF;
  IF outcome='published' THEN
    INSERT INTO workspace_instruction_policy_activation_events(account_id,workspace_id,operation_id,request_fingerprint,
      kind,scope,role_key,type,activation_version,old_revision_id,old_revision,old_content_hash,new_revision_id,new_revision,new_content_hash,
      actor_subject_id,reason)
      VALUES(p_account,p_workspace,operation_id,fingerprint,revision.kind,revision.scope,revision.role_key,'activate',version+1,
        head.revision_id,head.revision,head.content_hash,revision.id,revision.revision,revision.content_hash,actor_subject,p_request->>'reason');
    IF head.id IS NULL THEN
      INSERT INTO workspace_instruction_policy_heads(account_id,workspace_id,kind,scope,role_key,revision_id,revision,content_hash,activation_version)
        VALUES(p_account,p_workspace,revision.kind,revision.scope,revision.role_key,revision.id,revision.revision,revision.content_hash,version+1);
    ELSE
      UPDATE workspace_instruction_policy_heads h SET revision_id=revision.id,revision=revision.revision,content_hash=revision.content_hash,
        activation_version=version+1,activated_at=transaction_timestamp() WHERE h.account_id=p_account AND h.id=head.id;
    END IF;
  END IF;
  result:=jsonb_build_object('operationId',operation_id,'revisionId',revision_id,'outcome',outcome,'reviewBatchId',batch,'replayed',false);
  INSERT INTO agent_instruction_operations(account_id,origin_workspace_id,operation_id,revision_id,request_hash,actor,receipt)
    VALUES(p_account,p_workspace,operation_id,revision_id,fingerprint,p_actor,result);
  RETURN result;
END $$;

-- Native Skill storage remains the destination; its policy is now unified.
CREATE OR REPLACE FUNCTION skill_apply_lifecycle(p_account_id uuid, p_workspace_id uuid, p_actor jsonb, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
<<lifecycle>>
DECLARE
  actor_subject text; mode text := 'automatic'; operation text := p_request->>'operation';
  operation_id uuid := (p_request->>'operationId')::uuid;
  skill_id uuid := (p_request->>'skillId')::uuid;
  revision_id uuid; activation_event_id uuid; files jsonb := p_request->'files'; main_content text;
  head preference_registry_preferences%ROWTYPE; rev preference_registry_revisions%ROWTYPE;
  source record; binding skill_source_bindings%ROWTYPE;
  prior skill_write_receipts%ROWTYPE; result jsonb; fingerprint text;
  scope text := coalesce(p_request->>'scope','workspace'); next_event integer;
  title text := p_request->>'title'; description text := p_request->>'description';
  stable_key text := p_request->>'stableKey'; outcome text; source_id text;
  activation_mode text := 'workspace_managed';
  deferred_publication jsonb; source_effective boolean := true;
  confirmation_source skill_write_receipts%ROWTYPE;
  skill_review jsonb; initiating_human text; confirmation_generation integer;
  human_choice text; learning_actor jsonb; learning_policy jsonb;
  original_operation text := p_request->>'operation';
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid
    OR p_account_id IS NULL OR p_workspace_id IS NULL OR operation_id IS NULL
    OR operation NOT IN ('save','install','approve','reject','restore','confirm_response') OR operation IS NULL
  THEN RAISE EXCEPTION 'Skill lifecycle requires exact tenant context' USING ERRCODE='42501'; END IF;
  IF operation='confirm_response' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:'||p_account_id,0));
  END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace_id AND account_id=p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill workspace unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-publication:'||p_workspace_id,0));
  IF p_actor->>'kind' = 'agent' THEN
    learning_actor:=knowledge_resolve_actor(p_account_id,p_workspace_id,p_actor);
    learning_policy:=learning_actor->'policy';
    scope:=CASE WHEN learning_actor->>'defaultScope'='personal' THEN 'user' ELSE 'workspace' END;
    IF operation IN ('approve','reject') OR (scope='user' AND operation='install') THEN
      RAISE EXCEPTION 'Agents cannot review Skills or install workspace plugins from personal learning' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM sessions s JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
      WHERE s.id=(p_actor->>'sessionId')::uuid AND s.account_id=p_account_id AND s.workspace_id=p_workspace_id
        AND t.id=(p_actor->>'turnId')::uuid AND t.account_id=p_account_id AND t.workspace_id=p_workspace_id
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
        AND a.id=(p_actor->>'attemptId')::uuid AND a.account_id=p_account_id AND a.workspace_id=p_workspace_id
        AND a.session_id=s.id AND a.execution_generation=(p_actor->>'executionGeneration')::integer
        AND t.execution_generation=a.execution_generation AND a.state IN ('claimed','running')
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i WHERE i.workspace_id=p_workspace_id
          AND i.attempt_id=a.id AND i.state IN ('pending','delivered','acknowledged'))
      FOR SHARE OF s,t,a;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill write requires exact live attempt' USING ERRCODE='42501'; END IF;
    actor_subject := 'service:skill-attempt:' || (p_actor->>'attemptId');
  ELSIF p_actor->>'kind' = 'human' AND p_actor->>'principalKind' = 'human_session'
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND current_setting('opengeni.principal_kind',true) = 'human_session' THEN
    actor_subject := p_actor->>'subjectId';
  ELSIF p_actor->>'kind' = 'service' AND operation = 'install' AND scope = 'workspace'
    AND p_actor->>'principalKind' IN ('service','api_key','configured_key')
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND p_actor->>'principalKind' = current_setting('opengeni.principal_kind',true) THEN
    actor_subject := p_actor->>'subjectId';
  ELSE RAISE EXCEPTION 'Skill lifecycle actor is not authorized' USING ERRCODE='42501'; END IF;

  IF operation='confirm_response' THEN
    IF p_actor->>'kind' <> 'human' THEN
      RAISE EXCEPTION 'Skill chat confirmation requires verified human response admission' USING ERRCODE='42501';
    END IF;
    SELECT * INTO confirmation_source FROM skill_write_receipts r
      WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id
        AND r.operation_id=(p_request->>'sourceOperationId')::uuid;
    skill_review := confirmation_source.receipt->'skillReview';
    IF NOT FOUND OR skill_review IS NULL OR confirmation_source.actor->>'kind'<>'agent'
 THEN
      RAISE EXCEPTION 'Skill confirmation source unavailable' USING ERRCODE='42501';
    END IF;
    SELECT coalesce(t.initiating_human_subject_id, CASE WHEN t.initiator_kind='subject' THEN t.initiator_subject_id END),
      t.execution_generation INTO initiating_human,confirmation_generation
      FROM session_turns t JOIN sessions session ON session.active_turn_id=t.id AND session.id=t.session_id
      JOIN session_human_input_requests response_request ON response_request.session_id=t.session_id
        AND response_request.turn_id=t.id AND response_request.account_id=p_account_id
        AND response_request.workspace_id=p_workspace_id
        AND response_request.id=(p_request->>'humanInputRequestId')::uuid
      WHERE t.id=(confirmation_source.actor->>'turnId')::uuid
        AND t.session_id=(confirmation_source.actor->>'sessionId')::uuid AND t.workspace_id=p_workspace_id
        AND t.account_id=p_account_id AND session.workspace_id=p_workspace_id AND session.account_id=p_account_id
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
      FOR SHARE OF t,session;
    IF initiating_human IS NULL OR initiating_human IS DISTINCT FROM p_actor->>'subjectId' OR NOT (
      EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=p_workspace_id AND m.subject_id=initiating_human)
      OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.account_id=p_account_id
        AND m.subject_id=initiating_human AND m.status='active' AND m.personal_workspace_id=p_workspace_id)
    ) OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.account_id=p_account_id
      AND m.subject_id=initiating_human AND m.status<>'active') THEN
      RAISE EXCEPTION 'Skill confirming human no longer has workspace authority' USING ERRCODE='42501';
    END IF;
    SELECT answer->'values'->>0 INTO human_choice
      FROM session_human_input_requests h
      CROSS JOIN LATERAL jsonb_array_elements(h.response->'answers') answer
      WHERE h.id=(p_request->>'humanInputRequestId')::uuid AND h.account_id=p_account_id AND h.workspace_id=p_workspace_id
        AND h.session_id=(confirmation_source.actor->>'sessionId')::uuid AND h.turn_id=(confirmation_source.actor->>'turnId')::uuid
        AND h.turn_generation >= (confirmation_source.actor->>'executionGeneration')::integer
        AND h.turn_generation <= confirmation_generation AND h.status='answered' AND h.responded_by=initiating_human
        AND h.skill_review_human_authorized AND h.allow_skip=false
        AND h.response->>'outcome'='answered'
        AND jsonb_array_length(h.questions)=1 AND jsonb_array_length(h.response->'answers')=1
        AND h.questions->0->>'id'='skill:'||(skill_review->>'revisionId')
        AND h.questions->0->>'kind'='single_select'
        AND h.questions->0->>'label'='Save this Skill?'
        AND h.questions->0->>'helpText'='Review the complete files before saving. Saving activates this revision immediately.'
        AND h.questions->0->'required'='true'::jsonb
        AND coalesce(h.questions->0->'allowOther','false'::jsonb) IN ('false'::jsonb,'true'::jsonb)
        AND (answer->'other' IS NULL OR answer->'other'='null'::jsonb OR answer->'other'='""'::jsonb)
        AND h.responded_at IS NOT NULL AND h.created_at >= confirmation_source.created_at
        AND (h.expires_at IS NULL OR h.responded_at <= h.expires_at)
        AND h.questions->0->>'prompt'='Save this exact Skill revision for this workspace?'
        AND h.questions->0->'skillReview'=skill_review
        AND jsonb_array_length(h.questions->0->'options')=2
        AND ((h.questions->0->'options'->0) - 'description')='{"id":"save","label":"Save"}'::jsonb
        AND ((h.questions->0->'options'->1) - 'description')='{"id":"skip","label":"Don''t save"}'::jsonb
        AND coalesce(h.questions->0->'options'->0->'description','null'::jsonb)='null'::jsonb
        AND coalesce(h.questions->0->'options'->1->'description','null'::jsonb)='null'::jsonb
        AND answer->>'questionId'='skill:'||(skill_review->>'revisionId')
        AND answer->'values' IN ('["save"]'::jsonb,'["skip"]'::jsonb)
      FOR SHARE OF h;
    IF NOT FOUND THEN RAISE EXCEPTION 'Exact human Skill confirmation unavailable' USING ERRCODE='42501'; END IF;
    skill_id := (skill_review->>'skillId')::uuid;
    p_request := p_request || skill_review || jsonb_build_object('operationId',operation_id,
      'reason','Approved once by the initiating human in chat');
    operation := CASE WHEN human_choice='skip' THEN 'reject' ELSE 'approve' END;
    actor_subject := initiating_human;
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_array(p_actor,p_request)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-operation:'||p_workspace_id||':'||operation_id,0));
  SELECT * INTO prior FROM skill_write_receipts r WHERE r.workspace_id=p_workspace_id AND r.operation_id=lifecycle.operation_id;
  IF FOUND THEN
    IF prior.fingerprint <> fingerprint OR prior.account_id <> p_account_id THEN
      RAISE EXCEPTION 'Skill operation key reused with different input' USING ERRCODE='23505'; END IF;
    RETURN (prior.receipt - 'portableInstall' - 'deferredPublication') || jsonb_build_object('replayed',true);
  END IF;
  IF p_actor->>'kind' IN ('agent','service') THEN
    learning_policy:=coalesce(learning_policy,knowledge_learning_resolve(p_account_id,p_workspace_id,NULL,'defaults',transaction_timestamp()));
    mode:=learning_policy#>>'{effective,skills}';
    IF mode='review_first' THEN mode:='suggest'; END IF;
    IF mode = 'off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
  END IF;

  IF original_operation='confirm_response' THEN mode := 'automatic'; END IF;

  IF operation = 'install' THEN
    SELECT f.facet_key, f.activation_mode, v.plugin_id, sf.*, coalesce(jsonb_agg(jsonb_build_object('path',ff.path,'content',ff.content) ORDER BY ff.path COLLATE "C")
      FILTER (WHERE ff.id IS NOT NULL),'[]'::jsonb) AS files INTO source
      FROM capability_skill_facets sf JOIN capability_facets f ON f.id=sf.facet_id
      JOIN capability_plugin_versions v ON v.id=f.plugin_version_id
      JOIN capability_plugin_installations i ON i.plugin_version_id=v.id AND i.plugin_id=v.plugin_id
      JOIN capability_facet_installations fi ON fi.plugin_installation_id=i.id AND fi.facet_id=f.id AND fi.status='active'
      LEFT JOIN capability_skill_files ff ON ff.skill_facet_id=sf.facet_id
      WHERE sf.facet_id=(p_request->>'skillFacetId')::uuid AND i.account_id=p_account_id
        AND i.workspace_id=p_workspace_id AND i.status='active'
      GROUP BY f.facet_key,f.activation_mode,v.plugin_id,sf.facet_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill source is not installed in this workspace' USING ERRCODE='42501'; END IF;
    source_effective := skill_source_has_effective_owner(p_account_id,p_workspace_id,source.facet_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('skill-source:'||p_workspace_id||':'||source.plugin_id||':'||source.facet_key,0));
    SELECT * INTO binding FROM skill_source_bindings b WHERE b.workspace_id=p_workspace_id
      AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
    skill_id := coalesce(binding.preference_id,gen_random_uuid());
    files := source.files; title := p_request->>'title'; description := p_request->>'description';
    stable_key := 'installed-'||replace(skill_id::text,'-',''); source_id := source.facet_id::text;
    activation_mode := source.activation_mode;
  END IF;
  SELECT * INTO head FROM preference_registry_preferences h WHERE h.id=skill_id AND h.account_id=p_account_id FOR UPDATE;
  IF FOUND THEN
    IF p_actor->>'kind'='agent' AND head.scope<>scope THEN
      RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;
    scope := head.scope;
    IF operation <> 'install' THEN
      SELECT coalesce(r.skill_activation_mode,'workspace_managed') INTO activation_mode
        FROM preference_registry_revisions r WHERE r.preference_id=head.id
        ORDER BY (r.id=head.active_revision_id) DESC NULLS LAST,r.revision DESC LIMIT 1;
    END IF;
    IF (p_actor->>'kind'='service' AND (head.scope<>'workspace' OR head.scope_workspace_id<>p_workspace_id))
      OR (p_actor->>'kind'='agent' AND ((head.scope='workspace' AND head.scope_workspace_id<>p_workspace_id)
        OR (head.scope='user' AND head.scope_subject_id IS DISTINCT FROM learning_actor->>'subjectId')))
      OR (p_actor->>'kind' = 'human' AND NOT opengeni_private.preference_registry_scope_visible(
        head.account_id,head.scope,head.scope_workspace_id,head.scope_subject_id)) THEN
      RAISE EXCEPTION 'Skill is outside authorized scope' USING ERRCODE='42501'; END IF;
    IF operation = 'install' THEN
      SELECT * INTO rev FROM preference_registry_revisions WHERE id=head.active_revision_id;
      IF head.active_revision_id IS NOT NULL AND (rev.provenance_source <> 'portable_skill' OR rev.provenance_source_id=source_id) THEN
        revision_id := head.active_revision_id; outcome := 'preserved';
      END IF;
    ELSIF head.active_revision_id IS DISTINCT FROM (p_request->>'expectedRevisionId')::uuid
      OR head.scope_version IS DISTINCT FROM (p_request->>'expectedScopeVersion')::integer THEN
      RAISE EXCEPTION 'Skill head changed' USING ERRCODE='40001';
    END IF;
    IF head.status IN ('rejected','superseded') THEN RAISE EXCEPTION 'Skill head is retired' USING ERRCODE='23514'; END IF;
  ELSE
    IF operation NOT IN ('save','install') OR (p_request->>'expectedRevisionId') IS NOT NULL
      OR (operation='save' AND (p_request->>'expectedScopeVersion')::integer IS DISTINCT FROM 1) THEN
      RAISE EXCEPTION 'Skill head missing or changed' USING ERRCODE='40001'; END IF;
    INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,scope_subject_id,created_by_subject_id)
      VALUES(skill_id,p_account_id,stable_key,scope,CASE WHEN scope='workspace' THEN p_workspace_id END,
        CASE WHEN scope='user' THEN coalesce(learning_actor->>'subjectId',actor_subject) END,actor_subject) RETURNING * INTO head;
  END IF;

  IF outcome IS NULL THEN
    IF operation IN ('approve','restore','reject') THEN
      SELECT * INTO rev FROM preference_registry_revisions r WHERE r.id=(p_request->>'revisionId')::uuid
        AND r.account_id=p_account_id AND r.preference_id=skill_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Skill revision unavailable' USING ERRCODE='42501'; END IF;
      IF operation IN ('approve','reject') AND EXISTS(SELECT 1 FROM preference_registry_revisions newer
        WHERE newer.preference_id=skill_id AND newer.revision>rev.revision) THEN
        RAISE EXCEPTION 'Skill changed after chat proposal' USING ERRCODE='40001';
      END IF;
      IF operation IN ('approve','reject') AND (
        (operation='reject' AND rev.id=head.active_revision_id)
        OR EXISTS(SELECT 1 FROM preference_registry_events event
          WHERE event.preference_id=skill_id AND event.new_revision_id=rev.id AND event.type='rejected')
      ) THEN RAISE EXCEPTION 'Skill proposal was already settled' USING ERRCODE='40001'; END IF;
      files := coalesce(rev.skill_files,jsonb_build_array(jsonb_build_object('path','SKILL.md','content',rev.content)));
      title := p_request->>'title'; description := p_request->>'description';
      activation_mode := coalesce(rev.skill_activation_mode,'workspace_managed');
      IF operation='approve' AND rev.provenance_source='portable_skill' AND EXISTS(
        SELECT 1 FROM skill_source_bindings b WHERE b.preference_id=skill_id AND b.account_id=p_account_id
          AND NOT skill_source_has_effective_owner(p_account_id,b.workspace_id,rev.provenance_source_id::uuid)) THEN
        RAISE EXCEPTION 'Skill approval requires a finalized source owner' USING ERRCODE='42501';
      END IF;
    END IF;
    IF NOT skill_files_valid(files) THEN RAISE EXCEPTION 'Invalid Skill text folder' USING ERRCODE='22023'; END IF;
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(files) f WHERE f->>'path'='SKILL.md';
    IF operation IN ('approve','reject') THEN revision_id := rev.id;
    ELSE
      INSERT INTO preference_registry_revisions(account_id,preference_id,title,description,content,content_hash,
        conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,corrects_revision_id,skill_files,skill_activation_mode)
      VALUES(p_account_id,skill_id,title,description,main_content,encode(sha256(convert_to(main_content,'UTF8')),'hex'),
        'override',CASE WHEN operation='install' THEN 'portable_skill' WHEN p_actor->>'kind'='agent' THEN 'agent' ELSE 'human' END,
        CASE WHEN operation='install' THEN source_id WHEN p_actor->>'kind'='agent' THEN p_actor->>'attemptId' END,
        CASE WHEN p_actor->>'kind' IN ('agent','service') THEN 'untrusted_proposal' WHEN scope='user' THEN 'personal'
          WHEN scope='organization' THEN 'organization_managed' ELSE 'workspace_managed' END,
        actor_subject,head.active_revision_id,files,activation_mode) RETURNING id INTO revision_id;
    END IF;
    SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=skill_id;
    IF next_event=1 THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,new_subject_id,actor_subject_id,reason)
      VALUES(p_account_id,skill_id,'proposal_created',next_event,revision_id,head.scope,head.scope_workspace_id,head.scope_subject_id,actor_subject,p_request->>'reason');
      next_event := next_event+1;
    END IF;
    IF mode='automatic' AND operation='install' AND NOT source_effective THEN
      deferred_publication := jsonb_build_object('expectedRevisionId',head.active_revision_id,
        'expectedScopeVersion',head.scope_version,'sourceFacetId',source.facet_id);
    END IF;
    IF operation='reject' THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'rejected',next_event,revision_id,actor_subject,coalesce(p_request->>'reason','Declined during review'));
      outcome := 'preserved';
    ELSIF mode='automatic' AND deferred_publication IS NULL THEN
      PERFORM set_config('opengeni.preference_lifecycle_head_id',skill_id::text,true);
      PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
      UPDATE preference_registry_preferences h SET status='active',active_revision_id=revision_id,
        active_revision=r.revision,active_content_hash=r.content_hash,activation_version=h.activation_version+1,updated_at=clock_timestamp()
        FROM preference_registry_revisions r WHERE h.id=skill_id AND r.id=revision_id;
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'activated',next_event,head.active_revision_id,revision_id,actor_subject,p_request->>'reason') RETURNING id INTO activation_event_id;
      outcome := 'applied';
    ELSE outcome := 'pending'; END IF;
    IF operation='install' THEN
      INSERT INTO skill_source_bindings VALUES(p_account_id,p_workspace_id,source.plugin_id,source.facet_key,skill_id,source.facet_id)
      ON CONFLICT(workspace_id,plugin_id,facet_key) DO UPDATE SET skill_facet_id=excluded.skill_facet_id;
    END IF;
  END IF;
  IF operation='install' AND outcome='preserved' THEN
    UPDATE skill_source_bindings b SET skill_facet_id=source.facet_id
      WHERE b.workspace_id=p_workspace_id AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
  END IF;
  result := jsonb_build_object('operationId',operation_id,'skillId',skill_id,'revisionId',revision_id,'outcome',outcome,'replayed',false);
  IF operation='reject' THEN result := result || jsonb_build_object('decision','rejected'); END IF;
  IF outcome='pending' AND deferred_publication IS NULL AND p_actor->>'kind'='agent' THEN
    result := result || jsonb_build_object('pendingReason','approval','skillReview',
      jsonb_build_object('sourceOperationId',operation_id,'skillId',skill_id,'revisionId',revision_id,
        'expectedRevisionId',head.active_revision_id,'expectedScopeVersion',head.scope_version));
  END IF;
  IF deferred_publication IS NOT NULL THEN result := result || jsonb_build_object('pendingReason','source_finalization'); END IF;
  IF learning_policy IS NOT NULL THEN result:=result||jsonb_build_object('learningPolicy',learning_policy); END IF;
  INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
    VALUES(p_account_id,p_workspace_id,operation_id,fingerprint,p_actor,
      (CASE WHEN operation='install' AND p_request ? 'portableInstall'
        THEN result || jsonb_build_object('portableInstall',p_request->'portableInstall') ELSE result END)
      || CASE WHEN deferred_publication IS NOT NULL THEN jsonb_build_object('deferredPublication',deferred_publication) ELSE '{}'::jsonb END,
      activation_event_id);
  RETURN result;
END $body$;

CREATE OR REPLACE FUNCTION skill_publish_finalized_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  publication_owner_kind text := CASE TG_TABLE_NAME WHEN 'pack_installations' THEN 'pack' ELSE 'plugin' END;
  pending record; head preference_registry_preferences%ROWTYPE; revision preference_registry_revisions%ROWTYPE;
  publication_id uuid; publication_hash text; publication_operation uuid; expected_fingerprint text; event_id uuid;
  next_event integer; result jsonb; disposition text; current_mode text; parent_target text;
  publication_actor jsonb := jsonb_build_object('kind','service','subjectId','service:skill-publication','principalKind','service');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-publication:'||NEW.workspace_id,0));
  FOR pending IN
    SELECT DISTINCT receipt.* FROM skill_write_receipts receipt
    JOIN skill_source_bindings binding ON binding.preference_id=(receipt.receipt->>'skillId')::uuid
      AND binding.account_id=receipt.account_id AND binding.workspace_id=receipt.workspace_id
    JOIN capability_facet_installations fi ON fi.facet_id=binding.skill_facet_id
      AND fi.account_id=binding.account_id AND fi.workspace_id=binding.workspace_id
    JOIN capability_component_owners owner ON owner.facet_installation_id=fi.id
      AND owner.account_id=fi.account_id AND owner.workspace_id=fi.workspace_id
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.receipt ? 'deferredPublication' AND owner.owner_kind=publication_owner_kind AND owner.owner_id=NEW.id::text
    ORDER BY receipt.created_at,receipt.operation_id
  LOOP
    publication_hash := md5('skill-publication:'||pending.operation_id);
    publication_id := (substr(publication_hash,1,12)||'5'||substr(publication_hash,14,3)||'a'||substr(publication_hash,18,15))::uuid;
    expected_fingerprint := encode(sha256(convert_to('skill-publication:'||pending.fingerprint,'UTF8')),'hex');
    IF EXISTS(SELECT 1 FROM skill_write_receipts existing WHERE existing.workspace_id=NEW.workspace_id AND existing.operation_id=publication_id) THEN
      IF NOT EXISTS(SELECT 1 FROM skill_write_receipts existing WHERE existing.workspace_id=NEW.workspace_id AND existing.operation_id=publication_id
        AND existing.fingerprint=expected_fingerprint AND existing.receipt->>'sourceOperationId'=pending.operation_id::text) THEN
        RAISE EXCEPTION 'Skill publication operation identity collision' USING ERRCODE='23505';
      END IF;
      CONTINUE;
    END IF;
    publication_operation := nullif(current_setting('opengeni.skill_publication_operation_id',true),'')::uuid;
    IF publication_owner_kind='pack' THEN parent_target := NEW.pack_id;
    ELSE SELECT plugin_key INTO parent_target FROM capability_plugins WHERE id=NEW.plugin_id; END IF;
    IF publication_operation IS NULL OR NOT EXISTS(SELECT 1 FROM capability_operations operation
      WHERE operation.id=publication_operation AND operation.account_id=NEW.account_id AND operation.workspace_id=NEW.workspace_id
        AND operation.target_kind=publication_owner_kind AND operation.target_id=parent_target AND operation.status='running') THEN
      RAISE EXCEPTION 'Skill publication requires a claimed parent finalization' USING ERRCODE='42501';
    END IF;
    SELECT * INTO head FROM preference_registry_preferences WHERE id=(pending.receipt->>'skillId')::uuid AND account_id=NEW.account_id FOR UPDATE;
    SELECT * INTO revision FROM preference_registry_revisions WHERE id=(pending.receipt->>'revisionId')::uuid AND account_id=NEW.account_id;
    disposition := 'preserved'; event_id := NULL; current_mode := 'automatic';
    IF pending.actor->>'kind' <> 'human' THEN
      -- Deferred publication uses its original accepted policy. Historical
      -- receipts receive no new automatic authority during migration.
      current_mode:=coalesce(pending.receipt#>>'{learningPolicy,effective,skills}','review_first');
      IF current_mode='review_first' THEN current_mode:='suggest'; END IF;
    END IF;
    IF pending.actor->>'kind'='agent' THEN
      PERFORM 1 FROM sessions session JOIN session_turns turn ON turn.id=session.active_turn_id AND turn.session_id=session.id
        JOIN session_turn_attempts attempt ON attempt.id=turn.active_attempt_id AND attempt.turn_id=turn.id
      WHERE session.id=(pending.actor->>'sessionId')::uuid AND session.account_id=NEW.account_id AND session.workspace_id=NEW.workspace_id
        AND turn.id=(pending.actor->>'turnId')::uuid AND turn.account_id=NEW.account_id AND turn.workspace_id=NEW.workspace_id
        AND turn.status IN ('running','requires_action','recovering','waiting_capacity')
        AND attempt.id=(pending.actor->>'attemptId')::uuid AND attempt.account_id=NEW.account_id AND attempt.workspace_id=NEW.workspace_id
        AND attempt.session_id=session.id AND attempt.execution_generation=(pending.actor->>'executionGeneration')::integer
        AND turn.execution_generation=attempt.execution_generation AND attempt.state IN ('claimed','running')
        AND NOT EXISTS(SELECT 1 FROM session_attempt_interruptions interruption WHERE interruption.workspace_id=NEW.workspace_id
          AND interruption.attempt_id=attempt.id AND interruption.state IN ('pending','delivered','acknowledged'))
      FOR SHARE OF session,turn,attempt;
      IF NOT FOUND THEN current_mode := 'suggest'; END IF;
    END IF;
    IF head.status NOT IN ('rejected','superseded') AND head.scope='workspace' AND head.scope_workspace_id=NEW.workspace_id
      AND head.scope_version=(pending.receipt->'deferredPublication'->>'expectedScopeVersion')::integer
      AND head.active_revision_id IS NOT DISTINCT FROM (pending.receipt->'deferredPublication'->>'expectedRevisionId')::uuid
      AND revision.revision=(SELECT max(r.revision) FROM preference_registry_revisions r WHERE r.preference_id=head.id)
      AND (revision.expires_at IS NULL OR revision.expires_at>clock_timestamp())
      AND EXISTS(SELECT 1 FROM skill_source_bindings binding WHERE binding.preference_id=head.id
        AND binding.skill_facet_id=(pending.receipt->'deferredPublication'->>'sourceFacetId')::uuid)
      AND skill_source_has_effective_owner(NEW.account_id,NEW.workspace_id,(pending.receipt->'deferredPublication'->>'sourceFacetId')::uuid)
    THEN
      IF current_mode='automatic' THEN
        PERFORM set_config('opengeni.preference_lifecycle_head_id',head.id::text,true);
        PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
        UPDATE preference_registry_preferences SET status='active',active_revision_id=revision.id,
          active_revision=revision.revision,active_content_hash=revision.content_hash,activation_version=activation_version+1,updated_at=clock_timestamp()
          WHERE id=head.id;
        SELECT coalesce(max(version),0)+1 INTO next_event FROM preference_registry_events WHERE preference_id=head.id;
        INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
          VALUES(NEW.account_id,head.id,'activated',next_event,head.active_revision_id,revision.id,'service:skill-publication',
            'Publish previously authorized Skill after composite owner finalization') RETURNING id INTO event_id;
        disposition := 'applied';
      ELSE disposition := 'pending'; END IF;
    END IF;
    result := jsonb_build_object('operationId',publication_id,'sourceOperationId',pending.operation_id,
      'skillId',pending.receipt->>'skillId','revisionId',pending.receipt->>'revisionId','outcome',disposition,
      'activationEventId',event_id,'replayed',false,'publicationOperationId',publication_operation);
    IF disposition='pending' THEN result := result || jsonb_build_object('pendingReason','approval'); END IF;
    INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
      VALUES(NEW.account_id,NEW.workspace_id,publication_id,expected_fingerprint,publication_actor,result,event_id);
  END LOOP;
  RETURN NEW;
END $$;

-- Locking an immutable claim needs a narrowly scoped UPDATE policy even though
-- no update is permitted. Only the native recovery definer's exact claim can be
-- locked; runtime DML grants and the WITH CHECK false remain unchanged.
DO $legacy_claim_lock$
DECLARE table_name text; claim_column text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['knowledge_claims','knowledge_claim_evidence','knowledge_change_proposals','knowledge_claim_reviews'] LOOP
    claim_column:=CASE WHEN table_name='knowledge_claims' THEN 'id' ELSE 'claim_id' END;
    EXECUTE format('CREATE POLICY knowledge_legacy_confirmation_lock ON %I FOR UPDATE '
      || 'USING (current_user=%L AND scope_kind=''workspace'' AND account_id=current_setting(''opengeni.account_id'',true)::uuid '
      || 'AND scope_workspace_id=current_setting(''opengeni.workspace_id'',true)::uuid '
      || 'AND %I::text=current_setting(''opengeni.knowledge_legacy_lock_claim'',true)) WITH CHECK (false)',table_name,current_user,claim_column);
  END LOOP;
END $legacy_claim_lock$;

-- Owner-only bridge for answers already bound to native instruction proposals
-- at cutover. The original confirmation capability still verifies the exact
-- question, initiating human, Task-note evidence and current destination CAS.
-- No rebaseline, new draft, or new human authority is synthesized here.
CREATE FUNCTION knowledge_instruction_confirm_legacy(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE actor jsonb; subject text; candidate record; result jsonb; recovered jsonb;
  revision workspace_instruction_policy_revisions%ROWTYPE; prior agent_instruction_operations%ROWTYPE;
  activation governed_learning_activation_receipts%ROWTYPE; unavailable integer:=0; receipts jsonb:='[]'::jsonb;
  legacy_operation_id uuid; fingerprint text; note_capability uuid:=gen_random_uuid();
  previous_note_capability text:=current_setting('opengeni.task_note_write_capability',true);
  previous_legacy_claim text:=current_setting('opengeni.knowledge_legacy_lock_claim',true);
BEGIN
  IF p_actor->>'kind' IS DISTINCT FROM 'agent'
    OR p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Legacy instruction confirmation requires exact tenant and agent authority' USING ERRCODE='42501'; END IF;
  IF p_request->>'operation'='recover' THEN
    FOR candidate IN
      SELECT DISTINCT d.proposal_id,d.id AS decision_id,q.id AS request_id
      FROM agent_instruction_operations imported
      JOIN governed_learning_decision_receipts d ON d.account_id=imported.account_id AND d.workspace_id=imported.origin_workspace_id
        AND d.proposal_id::text=imported.actor#>>'{legacyInstructionContext,legacyProposalId}'
      JOIN session_human_input_requests q ON q.account_id=d.account_id AND q.workspace_id=d.workspace_id
        AND q.session_id=d.session_id AND q.turn_id=d.turn_id AND q.status='answered'
      WHERE imported.account_id=p_account AND imported.origin_workspace_id=p_workspace
        AND imported.request_hash='migration:0459:instruction-review' AND imported.actor->>'kind'='migration'
        AND d.session_id=(p_actor->>'sessionId')::uuid AND d.turn_id=(p_actor->>'turnId')::uuid
        AND q.responded_by=d.initiating_human_subject_id
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.response->'answers') a
          WHERE a->>'questionId'='remember:'||d.proposal_id AND a->'values'='["save"]'::jsonb)
      ORDER BY d.proposal_id,d.id,q.id
    LOOP
      BEGIN
        recovered:=knowledge_instruction_confirm_legacy(p_account,p_workspace,p_actor,jsonb_build_object(
          'operationId',overlay(overlay(md5('0459:instruction-confirm:'||candidate.request_id||':'||candidate.decision_id) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid,
          'proposalId',candidate.proposal_id,'decisionReceiptId',candidate.decision_id,'humanInputRequestId',candidate.request_id));
        receipts:=receipts||jsonb_build_array(recovered);
      EXCEPTION WHEN insufficient_privilege OR serialization_failure OR unique_violation OR check_violation THEN unavailable:=unavailable+1;
      END;
    END LOOP;
    RETURN jsonb_build_object('receipts',receipts,'unavailable',unavailable);
  END IF;
  -- Match the native activation lock prefix before validating the live attempt.
  PERFORM 1 FROM workspaces WHERE account_id=p_account AND id=p_workspace FOR UPDATE;
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  subject:=nullif(current_setting('opengeni.subject_id',true),'');
  SELECT r.* INTO revision FROM workspace_instruction_policy_revisions r
    JOIN agent_instruction_operations imported ON imported.account_id=r.account_id AND imported.revision_id=r.id
    JOIN governed_learning_decision_receipts d ON d.account_id=r.account_id AND d.workspace_id=r.workspace_id
      AND d.proposal_id::text=imported.actor#>>'{legacyInstructionContext,legacyProposalId}'
    WHERE r.account_id=p_account AND r.workspace_id=p_workspace
      AND imported.request_hash='migration:0459:instruction-review' AND imported.actor->>'kind'='migration'
      AND d.id=(p_request->>'decisionReceiptId')::uuid AND d.proposal_id=(p_request->>'proposalId')::uuid
      AND d.initiating_human_subject_id=subject AND d.session_id=(p_actor->>'sessionId')::uuid
      AND d.turn_id=(p_actor->>'turnId')::uuid
    ORDER BY r.revision DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No imported instruction matches this confirmation' USING ERRCODE='42501'; END IF;
  legacy_operation_id:=(p_request->>'operationId')::uuid;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array('legacy-instruction-confirmation',p_request,subject)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.operation_id=legacy_operation_id;
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM fingerprint OR prior.revision_id<>revision.id OR prior.origin_workspace_id<>p_workspace THEN
      RAISE EXCEPTION 'Legacy instruction confirmation operation conflicts' USING ERRCODE='23505'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.revision_id=revision.id
      AND op.receipt->>'outcome' IN ('published','rejected'))
    OR EXISTS(SELECT 1 FROM workspace_instruction_policy_revisions newer WHERE newer.account_id=p_account AND newer.workspace_id=p_workspace
      AND newer.kind=revision.kind AND newer.scope=revision.scope AND newer.role_key IS NOT DISTINCT FROM revision.role_key
      AND newer.revision>revision.revision) THEN
    RAISE EXCEPTION 'Imported instruction review is no longer current' USING ERRCODE='40001'; END IF;
  PERFORM set_config('opengeni.knowledge_legacy_lock_claim',(SELECT d.claim_id::text FROM governed_learning_decision_receipts d
    WHERE d.account_id=p_account AND d.id=(p_request->>'decisionReceiptId')::uuid),true);
  -- The exact attempt was validated above. The existing native confirmation
  -- checks the bound note/root/version/hash; its read needs the note lifecycle lease.
  INSERT INTO task_note_write_capabilities(backend_pid,transaction_id,capability_id)
    VALUES(pg_backend_pid(),pg_current_xact_id(),note_capability);
  PERFORM set_config('opengeni.task_note_write_capability',note_capability::text,true);
  SELECT * INTO activation FROM activate_human_confirmed_learning_decision(p_account,p_workspace,
    legacy_operation_id,(p_request->>'decisionReceiptId')::uuid,(p_request->>'humanInputRequestId')::uuid);
  DELETE FROM task_note_write_capabilities WHERE backend_pid=pg_backend_pid()
    AND transaction_id=pg_current_xact_id() AND capability_id=note_capability;
  PERFORM set_config('opengeni.task_note_write_capability',coalesce(previous_note_capability,''),true);
  PERFORM set_config('opengeni.knowledge_legacy_lock_claim',coalesce(previous_legacy_claim,''),true);
  IF activation.id IS NULL OR activation.destination_revision_id IS DISTINCT FROM revision.id THEN
    RAISE EXCEPTION 'Confirmation must activate the exact imported instruction' USING ERRCODE='40001'; END IF;
  result:=jsonb_build_object('operationId',legacy_operation_id,'revisionId',revision.id,'outcome','published','reviewBatchId',NULL,'replayed',false);
  INSERT INTO agent_instruction_operations(account_id,origin_workspace_id,operation_id,revision_id,request_hash,actor,receipt)
    VALUES(p_account,p_workspace,legacy_operation_id,revision.id,fingerprint,p_actor||jsonb_build_object(
      'legacyHumanInputRequestId',p_request->'humanInputRequestId','activationReceiptId',activation.id,'initiatingHumanSubjectId',subject),result);
  RETURN result;
END $$;

-- Recovery only. A migration-bound claim and the exact initiating human's
-- canonical answer authorize publication; no legacy Memory or claim is written.
CREATE FUNCTION knowledge_entry_confirm_legacy(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE actor jsonb; entry knowledge_entries%ROWTYPE; revision knowledge_entry_revisions%ROWTYPE;
  question session_human_input_requests%ROWTYPE; evidence knowledge_claim_evidence%ROWTYPE;
  prior knowledge_entry_operations%ROWTYPE; human_actor jsonb; note jsonb; subject text;
  candidate record; recovered jsonb; native_recovery jsonb; unavailable integer:=0;
  prior_principal text:=current_setting('opengeni.principal_kind',true); result jsonb; exact_text text;
BEGIN
  IF p_actor->>'kind' IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'Legacy confirmation requires an exact agent attempt' USING ERRCODE='42501'; END IF;
  IF p_request ? 'proposalId' THEN
    RETURN knowledge_instruction_confirm_legacy(p_account,p_workspace,p_actor,p_request);
  END IF;
  IF p_request->>'operation'='recover' THEN
    native_recovery:=knowledge_instruction_confirm_legacy(p_account,p_workspace,p_actor,p_request);
  END IF;
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  subject:=nullif(current_setting('opengeni.subject_id',true),'');
  IF p_request->>'operation'='recover' THEN
    result:='[]'::jsonb;
    FOR candidate IN
      SELECT DISTINCT e.legacy_claim_id AS claim_id,q.id AS request_id
      FROM session_human_input_requests q CROSS JOIN LATERAL jsonb_array_elements(q.questions) question_value
      JOIN knowledge_entries e ON e.legacy_claim_id::text=substring(question_value->>'id' FROM 10)
        AND e.account_id=q.account_id AND e.scope_workspace_id=q.workspace_id
      JOIN knowledge_entry_revisions r ON r.id=e.latest_revision_id AND r.account_id=e.account_id
      WHERE q.account_id=p_account AND q.workspace_id=p_workspace AND q.session_id=(p_actor->>'sessionId')::uuid
        AND q.turn_id=(p_actor->>'turnId')::uuid AND q.status='answered' AND q.responded_by=subject
        AND question_value->>'id' LIKE 'remember:%' AND r.number=1 AND r.legacy_snapshot IS NOT NULL
      ORDER BY e.legacy_claim_id,q.id
    LOOP
      BEGIN
        recovered:=knowledge_entry_confirm_legacy(p_account,p_workspace,p_actor,jsonb_build_object(
          'operationId',overlay(overlay(md5('opengeni:legacy-confirmation:'||candidate.request_id||':'||candidate.claim_id) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid,
          'claimId',candidate.claim_id,'humanInputRequestId',candidate.request_id));
        result:=result||jsonb_build_array(recovered);
      EXCEPTION WHEN insufficient_privilege OR serialization_failure THEN unavailable:=unavailable+1;
      END;
    END LOOP;
    RETURN jsonb_build_object('receipts',result,'instructionReceipts',native_recovery->'receipts',
      'unavailable',unavailable+coalesce((native_recovery->>'unavailable')::integer,0));
  END IF;

  SELECT * INTO entry FROM knowledge_entries e WHERE e.account_id=p_account
    AND e.legacy_claim_id=(p_request->>'claimId')::uuid AND e.scope='workspace' AND e.scope_workspace_id=p_workspace;
  IF NOT FOUND OR NOT knowledge_scope_visible(entry) OR subject IS NULL THEN
    RAISE EXCEPTION 'No migrated Knowledge confirmation matches this claim' USING ERRCODE='42501'; END IF;
  SELECT f.object_value#>>'{}' INTO exact_text FROM knowledge_claims c JOIN knowledge_facts f ON f.id=c.fact_id AND f.account_id=c.account_id
    WHERE c.account_id=p_account AND c.id=entry.legacy_claim_id AND c.scope_kind='workspace'
      AND c.scope_workspace_id=p_workspace AND c.initiating_human_subject_id=subject
      AND c.extraction_method='task-note-promotion-v1' AND f.object_kind='text';
  IF NOT FOUND THEN RAISE EXCEPTION 'Migrated confirmation content unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO question FROM session_human_input_requests q WHERE q.account_id=p_account AND q.workspace_id=p_workspace
    AND q.id=(p_request->>'humanInputRequestId')::uuid AND q.session_id=(p_actor->>'sessionId')::uuid
    AND q.turn_id=(p_actor->>'turnId')::uuid AND q.turn_generation<=(p_actor->>'executionGeneration')::integer
    AND q.status='answered' AND q.responded_by=subject AND q.response->>'outcome'='answered'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.questions) value WHERE value->>'id'='remember:'||entry.legacy_claim_id
      AND value->>'kind'='single_select' AND value->>'prompt'='Save this as workspace knowledge for everyone in this workspace?'
      AND value->>'helpText'=left(exact_text,2000) AND value->'options'='[{"id":"save","label":"Save"},{"id":"skip","label":"Don''t save"}]'::jsonb
      AND coalesce((value->>'allowOther')::boolean,false)=false)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.response->'answers') value
      WHERE value->>'questionId'='remember:'||entry.legacy_claim_id AND value->'values'='["save"]'::jsonb);
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact human confirmation unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  SELECT * INTO prior FROM knowledge_entry_operations o WHERE o.account_id=p_account AND o.operation_id=(p_request->>'operationId')::uuid;
  IF FOUND THEN
    IF prior.entry_id<>entry.id OR prior.actor->>'legacyHumanInputRequestId' IS DISTINCT FROM question.id::text THEN
      RAISE EXCEPTION 'Legacy confirmation operation conflicts' USING ERRCODE='23505'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO entry FROM knowledge_entries e WHERE e.id=entry.id AND e.account_id=p_account FOR UPDATE;
  SELECT * INTO revision FROM knowledge_entry_revisions r WHERE r.id=entry.latest_revision_id AND r.account_id=p_account;
  IF revision.legacy_snapshot IS NULL OR revision.number<>1 THEN
    RAISE EXCEPTION 'Migrated Knowledge changed; inspect its current review' USING ERRCODE='40001'; END IF;
  IF entry.published_revision_id=revision.id THEN
    RETURN jsonb_build_object('operationId',p_request->>'operationId','entryId',entry.id,'revisionId',revision.id,
      'version',entry.version,'outcome','published','reviewBatchId',NULL,'replayed',true);
  END IF;
  SELECT * INTO evidence FROM knowledge_claim_evidence e WHERE e.account_id=p_account AND e.claim_id=entry.legacy_claim_id
    AND e.scope_kind='workspace' AND e.scope_workspace_id=p_workspace AND e.polarity='supports'
    AND e.task_note_id IS NOT NULL AND e.initiating_human_subject_id=subject ORDER BY e.created_at,e.id LIMIT 1;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM knowledge_claim_evidence e WHERE e.account_id=p_account
    AND e.claim_id=entry.legacy_claim_id AND e.polarity='contradicts') THEN
    RAISE EXCEPTION 'Migrated confirmation evidence unavailable' USING ERRCODE='42501'; END IF;
  note:=knowledge_task_note_source(p_account,p_workspace,p_actor,evidence.task_note_id,evidence.task_note_version);
  IF note->>'content' IS DISTINCT FROM exact_text OR encode(sha256(convert_to(exact_text,'UTF8')),'hex')<>evidence.content_hash THEN
    RAISE EXCEPTION 'Migrated confirmation evidence changed' USING ERRCODE='42501'; END IF;
  human_actor:=jsonb_build_object('kind','human','principalKind','human_session','subjectId',subject,
    'writeScopes',jsonb_build_array('workspace'),'settingsScopes','[]'::jsonb,'review',true,
    'legacyHumanInputRequestId',question.id,'confirmedFromAttempt',p_actor);
  PERFORM set_config('opengeni.principal_kind','human_session',true);
  result:=knowledge_entry_apply(p_account,p_workspace,human_actor,jsonb_build_object('operation','approve',
    'operationId',p_request->>'operationId','entryId',entry.id,'revisionId',revision.id,'expectedVersion',entry.version));
  PERFORM set_config('opengeni.principal_kind',coalesce(prior_principal,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.principal_kind',coalesce(prior_principal,''),true);
  RAISE;
END $$;

-- Only the named gateways are runtime capabilities. Helpers remain owner-only,
-- with a pinned dedicated-schema search path and no inherited default grants.
DO $secure$
DECLARE f record; runtime_role text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS identity FROM pg_proc p
    WHERE p.pronamespace=current_schema()::regnamespace AND (p.proname LIKE 'knowledge_entry_%'
      OR p.proname IN ('knowledge_reject_history_mutation','knowledge_scope_visible','knowledge_learning_settings_valid',
        'knowledge_task_note_source','knowledge_instruction_confirm_legacy','knowledge_instruction_context','agent_instruction_apply','knowledge_review_batch_for_actor','knowledge_learning_context_visible','knowledge_learning_resolve','knowledge_learning_for_turn','knowledge_resolve_actor','knowledge_revision_visible','knowledge_document_visible','knowledge_index_revision',
        'knowledge_enqueue_index','knowledge_source_index_wake','knowledge_index_claim','knowledge_index_work','knowledge_index_retention_active','knowledge_document_prepare',
        'knowledge_file_owner_immutable','knowledge_media_file_owner_immutable','knowledge_legacy_memory_setting_retired','knowledge_legacy_version_visible','knowledge_validate_links','knowledge_validate_source','knowledge_source_visible','agent_learning_manage')) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_catalog, pg_temp',f.identity,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.identity);
    FOR runtime_role IN SELECT jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) LOOP
      IF runtime_role <> current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.identity,runtime_role);
      END IF;
    END LOOP;
  END LOOP;
END $secure$;

-- The codec-aware conversion runs inside this same maintenance transaction.
-- Published source/memory bytes and IDs are preserved; old tables remain audit
-- evidence until their retention boundary, not active retrieval authorities.
ALTER TABLE knowledge_review_batches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_lifecycle_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entity_aliases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_facts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claims NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_evidence NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_reviews NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_relations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_change_proposals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_document_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_objects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_providers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_acl_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memories NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_relationships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_bases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_decisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_search NO FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_index_jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE remember_knowledge_confirmation_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE remember_knowledge_memory_materializations NO FORCE ROW LEVEL SECURITY;
-- Keep pending instruction drafts in the one review surface without changing
-- their text, provenance, original baseline, or native activation authority.
ALTER TABLE workspace_instruction_policy_onboarding_proposals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_instruction_policy_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_instruction_policy_activation_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE governed_learning_decision_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_instruction_operations NO FORCE ROW LEVEL SECURITY;
INSERT INTO agent_instruction_operations(account_id,origin_workspace_id,operation_id,revision_id,request_hash,actor,receipt,created_at)
SELECT r.account_id,r.workspace_id,md5('0459:instruction-review:'||r.id)::uuid,r.id,'migration:0459:instruction-review',
  jsonb_build_object('kind','migration','subjectId','service:knowledge-migration:0459','legacyInstructionContext',
    jsonb_build_object('actor',jsonb_build_object('kind','migration','sessionId',decision.session_id),
      'reason','Pending instruction from the previous review system','reviewBatchId',NULL,'evidence','[]'::jsonb,
      'legacyProposalId',proposal.id,'legacyOnboardingId',onboarding.id,
      'expectedCurrentRevisionId',onboarding.baseline_revision_id,'expectedActivationVersion',onboarding.baseline_activation_version)),
  jsonb_build_object('operationId',md5('0459:instruction-review:'||r.id)::uuid,'revisionId',r.id,
    'outcome','pending','reviewBatchId',NULL,'replayed',false),r.created_at
FROM workspace_instruction_policy_revisions r
JOIN workspace_instruction_policy_onboarding_proposals onboarding ON onboarding.account_id=r.account_id
  AND onboarding.workspace_id=r.workspace_id AND onboarding.draft_revision_id=r.id AND onboarding.status='proposed'
JOIN knowledge_change_proposals proposal ON proposal.account_id=r.account_id AND proposal.id::text=onboarding.source_id
  AND proposal.target_kind='instruction_policy' AND proposal.status='proposed' AND proposal.scope_kind='workspace'
  AND proposal.scope_workspace_id=r.workspace_id AND proposal.content_hash=onboarding.source_version
LEFT JOIN LATERAL (SELECT d.session_id FROM governed_learning_decision_receipts d
  WHERE d.account_id=proposal.account_id AND d.workspace_id=r.workspace_id AND d.proposal_id=proposal.id
  ORDER BY d.created_at DESC,d.id DESC LIMIT 1) decision ON true
WHERE NOT EXISTS(SELECT 1 FROM workspace_instruction_policy_activation_events ev
  WHERE ev.account_id=r.account_id AND ev.workspace_id=r.workspace_id AND ev.new_revision_id=r.id)
  AND coalesce((SELECT review.state FROM knowledge_claim_reviews review WHERE review.account_id=r.account_id
    AND review.claim_id=proposal.claim_id ORDER BY review.review_revision DESC LIMIT 1),'proposed') IN ('proposed','approved');
ALTER TABLE agent_instruction_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE governed_learning_decision_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_instruction_policy_activation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_instruction_policy_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_instruction_policy_onboarding_proposals FORCE ROW LEVEL SECURITY;
-- Native pending preference proposals become reviewable Skill folder revisions.
ALTER TABLE preference_registry_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company_brain_preference_proposal_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_write_receipts NO FORCE ROW LEVEL SECURITY;
-- opengeni:unified-knowledge-copy-v1
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE preference_registry_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE company_brain_preference_proposal_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_write_receipts FORCE ROW LEVEL SECURITY;
DO $copied$
BEGIN
  IF (SELECT count(*) FROM pg_temp.knowledge_conversion_0459 WHERE completed)<>1 THEN
    RAISE EXCEPTION '0459 Knowledge conversion did not complete' USING ERRCODE='55000';
  END IF;
END $copied$;
-- Validate deferred head/revision references before restoring table posture.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE knowledge_review_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_lifecycle_events FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entity_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_claim_relations FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_change_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_acl_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memories FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_relationships FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE document_bases FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_links FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_search FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_index_jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE remember_knowledge_confirmation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE remember_knowledge_memory_materializations FORCE ROW LEVEL SECURITY;

-- Retired Memory is historical evidence only. Even an accidentally retained
-- owner-definer helper cannot start a competing Memory writer after cutover.
CREATE FUNCTION knowledge_retired_memory_read_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND (
    NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id)
    OR NOT EXISTS(SELECT 1 FROM managed_accounts WHERE id=OLD.account_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Memory was replaced by Knowledge; historical Memory is read-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER knowledge_memories_retired BEFORE INSERT OR UPDATE OR DELETE ON knowledge_memories
  FOR EACH ROW EXECUTE FUNCTION knowledge_retired_memory_read_only();
DO $retire_memory$
DECLARE f record; grantee text;
BEGIN
  FOR f IN SELECT p.oid,p.oid::regprocedure AS identity,p.proowner FROM pg_proc p
    WHERE p.pronamespace=current_schema()::regnamespace AND p.proname IN (
      'knowledge_memory_apply_operation','knowledge_memory_revert_operation',
      'materialize_remember_knowledge_memory','confirm_remember_knowledge_claim','knowledge_retired_memory_read_only',
      'evaluate_governed_learning_proposal','activate_governed_learning_decision','activate_human_confirmed_learning_decision') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_catalog, pg_temp',f.identity,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.identity);
    FOR grantee IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=f.oid AND acl.grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.identity,grantee);
    END LOOP;
  END LOOP;
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_class t,
    LATERAL aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee WHERE t.oid='knowledge_memories'::regclass AND acl.grantee<>t.relowner LOOP
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON knowledge_memories FROM %I',grantee);
  END LOOP;
END $retire_memory$;

-- Historical learning snapshots still explain old decisions. Their policy
-- authority is frozen: all new settings mutations use agent_learning_manage.
CREATE FUNCTION knowledge_retired_learning_read_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND (
    NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id)
    OR NOT EXISTS(SELECT 1 FROM managed_accounts WHERE id=OLD.account_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Learning settings moved to Agent learning' USING ERRCODE='55000';
END $$;
CREATE TRIGGER knowledge_learning_revisions_retired BEFORE INSERT OR UPDATE OR DELETE ON workspace_learning_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();
CREATE TRIGGER knowledge_learning_heads_retired BEFORE INSERT OR UPDATE OR DELETE ON workspace_learning_policy_heads
  FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();
CREATE TRIGGER knowledge_learning_events_retired BEFORE INSERT OR UPDATE OR DELETE ON workspace_learning_policy_activation_events
  FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();
DO $retire_learning$
DECLARE f record; grantee text; t text;
BEGIN
  FOR f IN SELECT p.oid,p.oid::regprocedure AS identity,p.proowner FROM pg_proc p
    WHERE p.pronamespace=current_schema()::regnamespace AND p.proname IN (
      'workspace_learning_policy_apply_activation','knowledge_retired_learning_read_only') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_catalog, pg_temp',f.identity,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.identity);
    FOR grantee IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=f.oid AND acl.grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.identity,grantee);
    END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workspace_learning_policy_revisions','workspace_learning_policy_heads','workspace_learning_policy_activation_events'] LOOP
    FOR grantee IN SELECT DISTINCT r.rolname FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE c.oid=t::regclass AND acl.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON %I FROM %I',t,grantee);
    END LOOP;
  END LOOP;
END $retire_learning$;
