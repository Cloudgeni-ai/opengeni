-- deployment-mode: rolling
-- Task notes may be promoted only into workspace-local proposed Knowledge.
-- The evidence row retains a value-free immutable source receipt after the
-- short-lived task tree is cleaned up; the source bytes remain in the ordinary
-- Task-note lifecycle and are never copied into evidence metadata.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "knowledge_claim_evidence"
  ALTER COLUMN "document_version_id" DROP NOT NULL,
  ADD COLUMN "task_note_id" uuid,
  ADD COLUMN "task_note_root_session_id" uuid,
  ADD COLUMN "task_note_version" integer,
  ADD CONSTRAINT "knowledge_claim_evidence_source_shape_chk" CHECK (
    (
      "document_version_id" IS NOT NULL
      AND "task_note_id" IS NULL
      AND "task_note_root_session_id" IS NULL
      AND "task_note_version" IS NULL
    ) OR (
      "document_version_id" IS NULL
      AND "task_note_id" IS NOT NULL
      AND "task_note_root_session_id" IS NOT NULL
      AND "task_note_version" = 1
      AND "scope_kind" = 'workspace'
      AND "scope_workspace_id" IS NOT NULL
      AND "scope_subject_id" IS NULL
      AND "document_chunk_id" IS NULL
      AND "chunk_index" IS NULL
      AND "locator" IS NULL
      AND "quote_hash" IS NULL
    )
  ) NOT VALID;

ALTER TABLE "knowledge_claim_evidence"
  VALIDATE CONSTRAINT "knowledge_claim_evidence_source_shape_chk";

DROP INDEX "knowledge_claim_evidence_natural_identity_uq";
CREATE UNIQUE INDEX "knowledge_claim_evidence_document_natural_identity_uq"
  ON "knowledge_claim_evidence" (
    "claim_id", "document_version_id", "polarity",
    coalesce("document_chunk_id"::text, ''), coalesce("locator", '')
  ) WHERE "document_version_id" IS NOT NULL;
CREATE UNIQUE INDEX "knowledge_claim_evidence_task_note_natural_identity_uq"
  ON "knowledge_claim_evidence" ("claim_id", "task_note_id", "polarity")
  WHERE "task_note_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_task_note_knowledge_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  note_row task_notes%ROWTYPE;
BEGIN
  IF NEW.task_note_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT note.* INTO note_row
  FROM task_notes note
  WHERE note.id = NEW.task_note_id
    AND note.account_id = NEW.account_id
    AND note.workspace_id = NEW.scope_workspace_id;
  IF NOT FOUND
    OR NEW.task_note_root_session_id IS DISTINCT FROM note_row.root_session_id
    OR NEW.task_note_version IS DISTINCT FROM note_row.version
    OR NEW.content_hash IS DISTINCT FROM note_row.text_hash
  THEN
    RAISE EXCEPTION 'Knowledge evidence does not match the exact Task-note source receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_claim_evidence_15_validate_task_note
  BEFORE INSERT ON "knowledge_claim_evidence"
  FOR EACH ROW EXECUTE FUNCTION validate_task_note_knowledge_evidence();

CREATE OR REPLACE FUNCTION resolve_task_note_knowledge_promotion_source(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_note_id uuid,
  p_expected_note_version integer
) RETURNS TABLE (
  note_id uuid,
  root_session_id uuid,
  note_version integer,
  note_text text,
  note_text_hash text,
  note_created_at timestamptz,
  initiating_human_subject_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  note_row task_notes%ROWTYPE;
  previous_subject_id text := pg_catalog.current_setting('opengeni.subject_id', true);
  previous_initiating_human_subject_id text := pg_catalog.current_setting(
    'opengeni.initiating_human_subject_id', true
  );
BEGIN
  IF p_note_id IS NULL OR p_expected_note_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Task-note promotion requires exact active version one'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO authority
  FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF authority.initiating_human_subject_id IS NULL THEN
    RAISE EXCEPTION 'Task-note promotion requires an immutable initiating human'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.subject_id', authority.initiating_human_subject_id, true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id', authority.initiating_human_subject_id, true
  );
  SELECT note.* INTO note_row
  FROM task_notes note
  WHERE note.account_id = p_account_id
    AND note.workspace_id = p_workspace_id
    AND note.root_session_id = authority.root_session_id
    AND note.id = p_note_id
    AND note.status = 'active'
    AND note.version = p_expected_note_version
    AND note.expires_at > statement_timestamp()
  FOR SHARE;

  PERFORM pg_catalog.set_config(
    'opengeni.subject_id', coalesce(previous_subject_id, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    coalesce(previous_initiating_human_subject_id, ''), true
  );
  IF note_row.id IS NULL THEN
    RAISE EXCEPTION 'Task note is unavailable, archived, expired, or outside this root tree'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT
    note_row.id,
    note_row.root_session_id,
    note_row.version,
    note_row.text,
    note_row.text_hash,
    note_row.created_at,
    authority.initiating_human_subject_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.subject_id', coalesce(previous_subject_id, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    coalesce(previous_initiating_human_subject_id, ''), true
  );
  RAISE;
END;
$$;

DO $function_access$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.validate_task_note_knowledge_evidence() FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.resolve_task_note_knowledge_promotion_source('
    || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.resolve_task_note_knowledge_promotion_source('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer) TO opengeni_app',
      data_schema
    );
  END IF;
END
$function_access$;
