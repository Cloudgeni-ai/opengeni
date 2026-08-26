-- deployment-mode: rolling
-- A human-confirmed `remember` Knowledge claim materializes into one exact
-- Memory record. The confirmation receipt is the idempotency identity: general
-- Memory deduplication must never substitute a normalized lookalike, and replay
-- must keep returning the same Memory id after later archival.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE remember_knowledge_memory_materializations (
  confirmation_receipt_id uuid PRIMARY KEY
    REFERENCES remember_knowledge_confirmation_receipts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  task_note_text_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT remember_knowledge_memory_materializations_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT remember_knowledge_memory_materializations_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT remember_knowledge_memory_materializations_memory_uq
    UNIQUE (workspace_id, memory_id),
  CONSTRAINT remember_knowledge_memory_materializations_hash_chk
    CHECK (task_note_text_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX remember_knowledge_memory_materializations_workspace_time_idx
  ON remember_knowledge_memory_materializations (workspace_id, created_at DESC, memory_id);

ALTER TABLE remember_knowledge_memory_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE remember_knowledge_memory_materializations FORCE ROW LEVEL SECURITY;
CREATE POLICY remember_knowledge_memory_materializations_tenant
  ON remember_knowledge_memory_materializations
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation
  ON remember_knowledge_memory_materializations AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

CREATE OR REPLACE FUNCTION reject_remember_knowledge_memory_materialization_mutation()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 AND (
    NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
    OR NOT EXISTS (
      SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND id = OLD.session_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM remember_knowledge_confirmation_receipts
      WHERE id = OLD.confirmation_receipt_id
    )
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'remember Knowledge Memory materializations are immutable'
    USING ERRCODE = '55000';
END
$body$;

CREATE TRIGGER remember_knowledge_memory_materializations_immutable
  BEFORE UPDATE OR DELETE ON remember_knowledge_memory_materializations
  FOR EACH ROW EXECUTE FUNCTION reject_remember_knowledge_memory_materialization_mutation();

CREATE OR REPLACE FUNCTION materialize_remember_knowledge_memory(
  p_account_id uuid,
  p_workspace_id uuid,
  p_confirmation_receipt_id uuid
) RETURNS SETOF remember_knowledge_memory_materializations
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  caller_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  receipt_row remember_knowledge_confirmation_receipts%ROWTYPE;
  result_row remember_knowledge_memory_materializations%ROWTYPE;
  source_text text;
  memory_id_value uuid;
  normalized_text text;
  normalized_text_hash text;
  visible_count integer;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_confirmation_receipt_id IS NULL
    OR caller_subject_id IS NULL OR length(btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'remember Knowledge Memory materialization requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize every first materialization/replay on the immutable confirmation
  -- identity. The Memory row may later become archived; the mapping remains the
  -- stable answer and is deliberately not foreign-keyed to mutable Memory state.
  SELECT * INTO receipt_row
  FROM remember_knowledge_confirmation_receipts receipt
  WHERE receipt.id = p_confirmation_receipt_id
    AND receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = caller_subject_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge confirmation is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO result_row
  FROM remember_knowledge_memory_materializations materialization
  WHERE materialization.confirmation_receipt_id = p_confirmation_receipt_id;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id
      OR result_row.workspace_id <> p_workspace_id
      OR result_row.session_id <> receipt_row.session_id
      OR result_row.task_note_text_hash <> receipt_row.task_note_text_hash
    THEN
      RAISE EXCEPTION 'remember Knowledge Memory materialization conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;

  SELECT fact.object_value #>> '{}'
  INTO source_text
  FROM knowledge_claims claim
  JOIN knowledge_facts fact
    ON fact.account_id = claim.account_id
   AND fact.scope_key = claim.scope_key
   AND fact.id = claim.fact_id
  JOIN knowledge_claim_evidence evidence
    ON evidence.account_id = claim.account_id
   AND evidence.scope_key = claim.scope_key
   AND evidence.claim_id = claim.id
  JOIN knowledge_claim_reviews review
    ON review.account_id = claim.account_id
   AND review.scope_key = claim.scope_key
   AND review.claim_id = claim.id
  WHERE claim.account_id = p_account_id
    AND claim.scope_kind = 'workspace'
    AND claim.scope_workspace_id = p_workspace_id
    AND claim.scope_subject_id IS NULL
    AND claim.id = receipt_row.claim_id
    AND claim.extraction_method = 'task-note-promotion-v1'
    AND claim.initiating_human_subject_id = caller_subject_id
    AND fact.object_kind = 'text'
    AND evidence.id = receipt_row.evidence_id
    AND evidence.task_note_id = receipt_row.task_note_id
    AND evidence.task_note_version = 1
    AND evidence.content_hash = receipt_row.task_note_text_hash
    AND review.id = receipt_row.approval_review_id
    AND review.review_revision = receipt_row.approval_review_revision
    AND review.state = 'approved'
  LIMIT 1;

  normalized_text := lower(btrim(regexp_replace(source_text, '\s+', ' ', 'g')));
  IF source_text IS NULL OR normalized_text = '' OR length(source_text) > 4000
    OR encode(sha256(convert_to(source_text, 'UTF8')), 'hex')
      <> receipt_row.task_note_text_hash
  THEN
    RAISE EXCEPTION 'remember Knowledge confirmation no longer resolves to its exact approved text'
      USING ERRCODE = '23514';
  END IF;
  normalized_text_hash := encode(sha256(convert_to(normalized_text, 'UTF8')), 'hex');

  SELECT count(*)::integer INTO visible_count
  FROM knowledge_memories memory
  WHERE memory.account_id = p_account_id
    AND memory.workspace_id = p_workspace_id
    AND memory.status IN ('active', 'approved');
  IF visible_count >= 2000 THEN
    RAISE EXCEPTION 'Workspace visible Memory is full (2000 visible records)'
      USING ERRCODE = '54000';
  END IF;

  memory_id_value := gen_random_uuid();
  PERFORM set_config('opengeni.memory_actor_kind', 'subject', true);
  PERFORM set_config('opengeni.memory_actor_id', caller_subject_id, true);
  PERFORM set_config('opengeni.memory_session_id', receipt_row.session_id::text, true);

  INSERT INTO knowledge_memories (
    id, account_id, workspace_id, status, kind, scope, text, text_codec_version,
    source_refs, confidence, metadata, created_by_session_id, pinned,
    scope_type, scope_subject_id, scope_role_key, scope_session_id,
    namespace_key, labels, text_hash
  ) VALUES (
    memory_id_value, p_account_id, p_workspace_id, 'active', 'semantic', 'workspace',
    source_text, NULL,
    jsonb_build_array(jsonb_build_object(
      'kind', 'session_event', 'id', receipt_row.session_id, 'metadata', '{}'::jsonb
    )),
    100,
    jsonb_build_object(
      'origin', 'human',
      'source', 'remember_confirmation',
      'confirmationReceiptId', receipt_row.id,
      'claimId', receipt_row.claim_id,
      'evidenceId', receipt_row.evidence_id,
      'taskNoteId', receipt_row.task_note_id
    ),
    receipt_row.session_id, false,
    'workspace', NULL, NULL, NULL,
    'remember/' || receipt_row.id::text, '{}'::text[], normalized_text_hash
  );

  INSERT INTO remember_knowledge_memory_materializations (
    confirmation_receipt_id, account_id, workspace_id, session_id,
    memory_id, task_note_text_hash
  ) VALUES (
    receipt_row.id, p_account_id, p_workspace_id, receipt_row.session_id,
    memory_id_value, receipt_row.task_note_text_hash
  ) RETURNING * INTO result_row;

  RETURN NEXT result_row;
END
$body$;

REVOKE ALL ON TABLE remember_knowledge_memory_materializations FROM PUBLIC;
REVOKE ALL ON FUNCTION materialize_remember_knowledge_memory(uuid, uuid, uuid) FROM PUBLIC;

DO $remember_knowledge_memory_materialization_hardening$
DECLARE
  target_schema text := current_schema();
  runtime_role text := nullif(current_setting('opengeni.runtime_role', true), '');
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.materialize_remember_knowledge_memory(uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  IF runtime_role IS NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    runtime_role := 'opengeni_app';
  END IF;
  IF runtime_role IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.remember_knowledge_memory_materializations FROM %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.materialize_remember_knowledge_memory(uuid,uuid,uuid) TO %I',
      target_schema, runtime_role
    );
  END IF;
END
$remember_knowledge_memory_materialization_hardening$;

RESET statement_timeout;
RESET lock_timeout;
