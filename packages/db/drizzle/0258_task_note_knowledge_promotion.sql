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

CREATE TABLE "task_note_knowledge_promotion_capabilities" (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "note_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "note_version" integer NOT NULL CHECK ("note_version" = 1),
  "note_text_hash" text NOT NULL,
  "evidence_operation_id" text NOT NULL,
  "claim_operation_id" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "learning_policy_snapshot_id" uuid NOT NULL,
  PRIMARY KEY ("backend_pid", "transaction_id", "capability_id")
);

ALTER TABLE "task_note_knowledge_promotion_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_note_knowledge_promotion_capabilities" FORCE ROW LEVEL SECURITY;

DO $promotion_capability_policy$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY task_note_knowledge_promotion_capability_owner '
      || 'ON %I.task_note_knowledge_promotion_capabilities '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
  EXECUTE format(
    'REVOKE ALL ON %I.task_note_knowledge_promotion_capabilities FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON %I.task_note_knowledge_promotion_capabilities FROM opengeni_app',
      data_schema
    );
  END IF;
END
$promotion_capability_policy$;

CREATE OR REPLACE FUNCTION validate_task_note_knowledge_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  note_row task_notes%ROWTYPE;
  capability_row task_note_knowledge_promotion_capabilities%ROWTYPE;
BEGIN
  IF NEW.task_note_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT capability.* INTO capability_row
  FROM task_note_knowledge_promotion_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id()
    AND capability.capability_id = nullif(
      pg_catalog.current_setting('opengeni.task_note_knowledge_promotion_capability', true), ''
    )::uuid
    AND capability.account_id = NEW.account_id
    AND capability.workspace_id = NEW.scope_workspace_id
    AND capability.note_id = NEW.task_note_id
    AND capability.root_session_id = NEW.task_note_root_session_id
    AND capability.note_version = NEW.task_note_version
    AND capability.note_text_hash = NEW.content_hash
    AND capability.evidence_operation_id = NEW.operation_id
    AND capability.actor_subject_id = NEW.actor_subject_id
    AND capability.initiating_human_subject_id = NEW.initiating_human_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task-note Knowledge evidence requires exact promotion capability'
      USING ERRCODE = '42501';
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
  IF NOT EXISTS (
    SELECT 1
    FROM knowledge_claims claim
    JOIN knowledge_facts fact
      ON fact.account_id = claim.account_id
      AND fact.id = claim.fact_id
      AND fact.scope_key = claim.scope_key
    WHERE claim.id = NEW.claim_id
      AND claim.account_id = NEW.account_id
      AND claim.scope_kind = 'workspace'
      AND claim.scope_workspace_id = NEW.scope_workspace_id
      AND claim.scope_subject_id IS NULL
      AND claim.operation_id = capability_row.claim_operation_id
      AND claim.actor_kind = NEW.actor_kind
      AND claim.actor_subject_id = capability_row.actor_subject_id
      AND claim.initiating_human_subject_id = capability_row.initiating_human_subject_id
      AND claim.extraction_method = 'task-note-promotion-v1'
      AND claim.extraction_metadata = pg_catalog.jsonb_build_object(
        'taskNoteId', note_row.id,
        'taskNoteRootSessionId', note_row.root_session_id,
        'taskNoteVersion', note_row.version,
        'taskNoteTextHash', note_row.text_hash
      )
      AND fact.scope_kind = 'workspace'
      AND fact.scope_workspace_id = NEW.scope_workspace_id
      AND fact.scope_subject_id IS NULL
      AND fact.object_kind = 'text'
      AND fact.object_entity_id IS NULL
      AND fact.object_value = pg_catalog.to_jsonb(note_row.text)
      AND fact.actor_kind = NEW.actor_kind
      AND fact.actor_subject_id = capability_row.actor_subject_id
      AND fact.initiating_human_subject_id = capability_row.initiating_human_subject_id
  ) THEN
    RAISE EXCEPTION 'Task-note Knowledge evidence claim/fact is outside the admitted promotion lineage'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM task_note_knowledge_promotion_capabilities capability
  WHERE capability.backend_pid = capability_row.backend_pid
    AND capability.transaction_id = capability_row.transaction_id
    AND capability.capability_id = capability_row.capability_id;
  PERFORM pg_catalog.set_config('opengeni.task_note_knowledge_promotion_capability', '', true);
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
  p_expected_note_version integer,
  p_evidence_operation_id text,
  p_claim_operation_id text,
  p_actor_subject_id text
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
  learning_policy_snapshot_id uuid;
  effective_learning_mode text;
  previous_subject_id text := pg_catalog.current_setting('opengeni.subject_id', true);
  previous_initiating_human_subject_id text := pg_catalog.current_setting(
    'opengeni.initiating_human_subject_id', true
  );
  write_capability_id uuid := pg_catalog.gen_random_uuid();
  previous_write_capability text := pg_catalog.current_setting(
    'opengeni.task_note_knowledge_promotion_capability', true
  );
BEGIN
  IF p_note_id IS NULL
    OR p_expected_note_version IS DISTINCT FROM 1
    OR p_evidence_operation_id IS NULL
    OR p_claim_operation_id IS NULL
    OR length(btrim(coalesce(p_actor_subject_id, ''))) NOT BETWEEN 1 AND 1024
  THEN
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

  SELECT snapshot.id,
    coalesce(
      (
        SELECT override.value->>'mode'
        FROM pg_catalog.jsonb_array_elements(snapshot.source_overrides) override(value)
        WHERE override.value->>'kind' = 'task-note'
          AND override.value->>'id' = p_note_id::text
        LIMIT 1
      ),
      snapshot.workspace_mode
    )
  INTO learning_policy_snapshot_id, effective_learning_mode
  FROM workspace_learning_policy_snapshots snapshot
  WHERE snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.attempt_id = p_attempt_id
    AND snapshot.execution_generation = p_execution_generation;
  IF learning_policy_snapshot_id IS NULL
    OR effective_learning_mode NOT IN ('suggest', 'automatic')
  THEN
    RAISE EXCEPTION 'Task-note promotion is disabled by the exact learning-policy snapshot'
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

  INSERT INTO task_note_knowledge_promotion_capabilities (
    backend_pid, transaction_id, capability_id,
    account_id, workspace_id, note_id, root_session_id, note_version,
    note_text_hash, evidence_operation_id, claim_operation_id,
    actor_subject_id, initiating_human_subject_id, learning_policy_snapshot_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), write_capability_id,
    p_account_id, p_workspace_id, note_row.id, note_row.root_session_id, note_row.version,
    note_row.text_hash, p_evidence_operation_id, p_claim_operation_id,
    p_actor_subject_id, authority.initiating_human_subject_id, learning_policy_snapshot_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.task_note_knowledge_promotion_capability', write_capability_id::text, true
  );

  RETURN QUERY SELECT
    note_row.id,
    note_row.root_session_id,
    note_row.version,
    note_row.text,
    note_row.text_hash,
    note_row.created_at,
    authority.initiating_human_subject_id;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM task_note_knowledge_promotion_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM pg_catalog.set_config(
    'opengeni.task_note_knowledge_promotion_capability',
    coalesce(previous_write_capability, ''), true
  );
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
    || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.validate_task_note_knowledge_evidence() '
      || 'SET search_path = pg_catalog, %I',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_task_note_knowledge_promotion_source('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) '
      || 'SET search_path = pg_catalog, %I',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.resolve_task_note_knowledge_promotion_source('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$function_access$;
