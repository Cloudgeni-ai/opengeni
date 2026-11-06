-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: deletes only retired Knowledge sync schedules (two in production), their runs and sync rows, and stored Knowledge source facets
-- Integration Knowledge sync is gone: integrations give agents tools, and
-- recurring work is an ordinary agent schedule. The previous release already
-- refuses every source task, shows it as "Sync retired" and offers only
-- Delete. This migration does that delete for every remaining source task,
-- so nothing about the old sync stays visible:
--
-- 1. The three SQL routines that read source-sync evidence stop reading it.
--    A Google Drive source copy was only ever readable with live sync state,
--    which step 2 removes, so it stays unreadable (it fails closed), and a
--    citation needed that same evidence. Preparing a document used a sync
--    obligation only for documents a sync run imported; any such document
--    that remains (production has none) is now prepared like an upload.
--    The next release drops the sync tables themselves.
-- 2. Every source task (a `knowledge_source_sync` action, an agent task with
--    `agentConfig.knowledgeSource`, or a task with sync state) is deleted
--    with its runs; its sync state, wakes and item outcomes cascade. Its
--    Temporal schedule is queued for deletion exactly like a workspace
--    deletion queues one. A run that started a chat is chat history: a task
--    with such a run keeps its runs and is deleted the way the app deletes a
--    schedule (hidden, paused), and its sync rows are removed.
-- 3. Connector cleanup that a deleted source task left queued has nothing
--    left to clean and is marked done.
-- 4. Saved Knowledge source facets and their definitions are deleted.
--
-- Idempotent: a second run finds nothing to delete. Production had two
-- paused source tasks, two wakes and no facet bindings.
--
-- Rolling: no schema change. The previous release lists schedules and facets
-- from the same tables; deleted rows simply no longer appear, and a source
-- task the previous release still shows can only be deleted, which is
-- idempotent.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- 1. Routines. Signatures, owners, grants and search paths are unchanged.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION google_drive_file_authorized(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_file_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog'
    AS $$
    DECLARE file_exists boolean := false;
    DECLARE protected boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_request_workspace_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
        OR p_file_id IS NULL
      THEN
        RETURN false;
      END IF;

      INSERT INTO opengeni_private.google_drive_object_acl_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'authorize')
      ON CONFLICT DO NOTHING;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM files file_row
          WHERE file_row.id = p_file_id AND file_row.account_id = p_account_id
        ) INTO file_exists;
        IF file_exists THEN
          -- Bytes a Google Drive source sync imported stay unreadable: their
          -- per-person Drive permission evidence came only from that sync.
          SELECT EXISTS (
            SELECT 1
            FROM knowledge_document_versions version_row
            JOIN knowledge_sources source_row ON source_row.id = version_row.source_id
            JOIN knowledge_providers provider_row ON provider_row.id = source_row.provider_id
            WHERE version_row.account_id = p_account_id
              AND version_row.file_id = p_file_id
              AND provider_row.provider_key = 'google-drive'
          ) INTO protected;
        END IF;

        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'authorize';
        RETURN file_exists AND NOT protected;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'authorize';
        RAISE;
      END;
    END;
    $$;
$create$, data_schema);

  -- A Google Drive citation came from source-sync permission evidence; no
  -- readable document has one.
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION google_drive_document_citation(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_document_id uuid, p_file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog'
    AS $$
    BEGIN
      RETURN NULL;
    END;
    $$;
$create$, data_schema);

  -- Preparing a document no longer looks for a source-sync obligation: every
  -- document is prepared as the upload it is, with its original's existing
  -- authorization. The lease keeps its scheduledTaskRunId key (always null).
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION knowledge_document_prepare(p_account uuid, p_workspace uuid, p_document uuid, p_request jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE document documents%%ROWTYPE; entry knowledge_entries%%ROWTYPE; original files%%ROWTYPE;
  prior knowledge_entry_revisions%%ROWTYPE; lease uuid; policy jsonb; body jsonb; result jsonb; actor jsonb;
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
  IF NOT google_drive_file_authorized(p_account,p_workspace,coalesce(document.authority_subject_id,document.created_by),document.file_id) THEN
    RAISE EXCEPTION 'Document original is no longer authorized' USING ERRCODE='42501'; END IF;
  IF operation='claim' THEN
    -- An explicit old Document upload is human/service-authored source input,
    -- not an automatic finding. Its source copy keeps that existing authority.
    policy:=jsonb_build_object('effective',jsonb_build_object('knowledge','automatic'));
    accepted_at:=document.created_at;
    IF entry.id IS NULL THEN
      INSERT INTO knowledge_entries(account_id,origin_workspace_id,scope,scope_workspace_id,scope_subject_id,
        legacy_document_id,legacy_document_version_id,access_document_id)
      VALUES(p_account,p_workspace,document.authority_kind,
        CASE WHEN document.authority_kind='workspace' THEN document.authority_workspace_id END,
        CASE WHEN document.authority_kind='personal' THEN document.authority_subject_id END,
        p_document,NULL,p_document) RETURNING * INTO entry;
    END IF;
    IF entry.scope IS DISTINCT FROM document.authority_kind
      OR entry.scope_subject_id IS DISTINCT FROM document.authority_subject_id
      OR (entry.scope='workspace' AND entry.scope_workspace_id IS DISTINCT FROM document.authority_workspace_id) THEN
      RAISE EXCEPTION 'Document ownership differs from retained Knowledge' USING ERRCODE='42501'; END IF;
    lease:=gen_random_uuid();
    UPDATE knowledge_entries SET legacy_document_id=p_document,document_preparation=jsonb_build_object('leaseId',lease,
      'leaseUntil',clock_timestamp()+interval '15 minutes','expectedVersion',entry.version,
      'fileId',document.file_id,'policy',policy,'acceptedAt',accepted_at,'scheduledTaskRunId',NULL::uuid)
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
END $_$;
$create$, data_schema);
END
$install$;

-- The migration principal is bound by FORCE ROW LEVEL SECURITY and has no
-- tenant settings, so every table read or written below is owner-visible
-- only for this transaction. The application role stays policy-bound.
ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_states" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_wakes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "temporal_schedule_cleanup_outbox" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_facet_definitions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_facet_bindings" NO FORCE ROW LEVEL SECURITY;

-- 2. Source tasks, including ones their owner already deleted (hidden).
CREATE TEMPORARY TABLE retired_knowledge_source_tasks ON COMMIT DROP AS
SELECT task.id, task.account_id, task.workspace_id, task.temporal_schedule_id
FROM scheduled_tasks task
WHERE task.action ->> 'kind' = 'knowledge_source_sync'
  OR jsonb_typeof(task.agent_config -> 'knowledgeSource') = 'object'
  OR task.id IN (SELECT state.scheduled_task_id FROM knowledge_source_sync_states state)
  OR task.id IN (SELECT wake.scheduled_task_id FROM knowledge_source_sync_wakes wake);

-- The API's cleanup pump deletes each Temporal schedule; a schedule already
-- queued by an earlier delete keeps its row.
INSERT INTO temporal_schedule_cleanup_outbox (account_id, workspace_id, temporal_schedule_id)
SELECT task.account_id, task.workspace_id, task.temporal_schedule_id
FROM retired_knowledge_source_tasks task
ON CONFLICT (temporal_schedule_id) DO NOTHING;

-- Application writes to schedules hold the workspace's session-tenancy fence,
-- which a trigger checks. This transaction's table lock (taken by NO FORCE
-- above, held until commit) already excludes every concurrent writer, so the
-- check is off for these statements only.
ALTER TABLE "scheduled_tasks" DISABLE TRIGGER session_tenancy_workspace_fence;

-- A run that started or updated a chat is referenced by that chat's history
-- (deferred foreign keys). Check those references per task, so such a task
-- falls back to the app's own delete instead of failing the migration.
SET CONSTRAINTS session_turns_scheduled_run_fk, session_system_updates_scheduled_run_fk IMMEDIATE;

DO $retire$
DECLARE
  retired record;
BEGIN
  FOR retired IN SELECT task.id FROM retired_knowledge_source_tasks task ORDER BY task.id LOOP
    BEGIN
      -- The task goes first: its runs then belong to no live schedule, so
      -- deleting them is not deleting a live schedule's run evidence.
      DELETE FROM scheduled_tasks WHERE id = retired.id;
      DELETE FROM scheduled_task_runs WHERE task_id = retired.id;
    EXCEPTION WHEN foreign_key_violation THEN
      UPDATE scheduled_tasks
      SET status = 'paused', deleted_at = clock_timestamp(), reusable_session_id = NULL,
          updated_at = clock_timestamp()
      WHERE id = retired.id AND deleted_at IS NULL;
      DELETE FROM knowledge_source_sync_wakes WHERE scheduled_task_id = retired.id;
      DELETE FROM knowledge_source_sync_states WHERE scheduled_task_id = retired.id;
    END;
  END LOOP;
END
$retire$;

-- Run every check the deletes deferred now, so the table is settled before
-- its fence trigger and row security are restored; then defer them again.
SET CONSTRAINTS scheduled_task_runs_task_id_fkey, zzz_subscription_authority_compat_check IMMEDIATE;
SET CONSTRAINTS scheduled_task_runs_task_id_fkey, zzz_subscription_authority_compat_check,
  session_turns_scheduled_run_fk, session_system_updates_scheduled_run_fk DEFERRED;

ALTER TABLE "scheduled_tasks" ENABLE TRIGGER session_tenancy_workspace_fence;

-- 3. Queued connector cleanup belonged to deleted source tasks only.
UPDATE temporal_schedule_cleanup_outbox
SET connector_cleanup_completed_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE connector_cleanup_snapshot IS NOT NULL
  AND connector_cleanup_completed_at IS NULL;

-- 4. Knowledge source facets. Binding owners cascade.
DELETE FROM integration_facet_bindings binding
USING integration_facet_definitions definition
WHERE definition.id = binding.facet_definition_id
  AND definition.kind = 'knowledge_source';
DELETE FROM integration_facet_definitions WHERE kind = 'knowledge_source';

ALTER TABLE "integration_facet_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_facet_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "temporal_schedule_cleanup_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_wakes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_states" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" FORCE ROW LEVEL SECURITY;
