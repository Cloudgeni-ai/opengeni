-- deployment-mode: rolling
-- Migration 0260 follows the released 0258 three-scope Document authority.
-- Task notes may be promoted only into workspace-local proposed Knowledge.
-- The evidence row retains a value-free immutable source receipt after the
-- short-lived task tree is cleaned up; the source bytes remain in the ordinary
-- Task-note lifecycle and are never copied into evidence metadata.
-- Every new path and the complete invoked 0239/0225 Task-note authority
-- closure explicitly put pg_temp last so caller-created temporary relations
-- cannot shadow target-schema authority relations.

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

-- A replacement is one atomic, append-only correction receipt. The old note
-- remains immutable and archived; the replacement is a fresh version-one note.
-- The receipt deliberately stores no note text.
CREATE TABLE "task_note_replacement_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "replaced_note_id" uuid NOT NULL,
  "replaced_note_version" integer NOT NULL CHECK ("replaced_note_version" = 2),
  "replacement_note_id" uuid NOT NULL,
  "replacement_note_version" integer NOT NULL CHECK ("replacement_note_version" = 1),
  "archive_operation_id" uuid NOT NULL,
  "create_operation_id" uuid NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "actor_session_id" uuid NOT NULL,
  "actor_turn_id" uuid NOT NULL,
  "actor_attempt_id" uuid NOT NULL,
  "actor_execution_generation" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "task_note_replacement_receipts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "task_note_replacement_receipts_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_note_replacement_receipts_replaced_note_fk"
    FOREIGN KEY ("workspace_id", "replaced_note_id")
    REFERENCES "task_notes" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_note_replacement_receipts_replacement_note_fk"
    FOREIGN KEY ("workspace_id", "replacement_note_id")
    REFERENCES "task_notes" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_note_replacement_receipts_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_replacement_receipts_actor_turn_fk"
    FOREIGN KEY ("workspace_id", "actor_turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_replacement_receipts_actor_attempt_fk"
    FOREIGN KEY ("workspace_id", "actor_attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_replacement_receipts_shape_chk" CHECK (
    "replaced_note_id" <> "replacement_note_id"
    AND "archive_operation_id" <> "create_operation_id"
    AND "operation_id" <> "archive_operation_id"
    AND "operation_id" <> "create_operation_id"
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND "actor_kind" IN ('human', 'service')
    AND length("actor_subject_id") BETWEEN 1 AND 1024
    AND octet_length("actor_subject_id") <= 4096
    AND ("initiating_human_subject_id" IS NULL OR (
      length("initiating_human_subject_id") BETWEEN 1 AND 1024
      AND octet_length("initiating_human_subject_id") <= 4096
    ))
    AND "actor_execution_generation" > 0
  ),
  CONSTRAINT "task_note_replacement_receipts_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "task_note_replacement_receipts_workspace_replacement_uq"
    UNIQUE ("workspace_id", "replacement_note_id")
);

CREATE INDEX "task_note_replacement_receipts_root_timeline_idx"
  ON "task_note_replacement_receipts" (
    "workspace_id", "root_session_id", "created_at" DESC, "id" DESC
  );

ALTER TABLE "task_note_knowledge_promotion_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_note_knowledge_promotion_capabilities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_note_replacement_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_note_replacement_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY session_visibility_isolation ON "task_note_replacement_receipts"
  AS RESTRICTIVE
  FOR ALL
  USING (session_reference_visible(
    "account_id", "workspace_id", "actor_session_id"
  ))
  WITH CHECK (session_reference_visible(
    "account_id", "workspace_id", "actor_session_id"
  ));

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
  EXECUTE format(
    'CREATE POLICY task_note_replacement_receipts_owner '
      || 'ON %I.task_note_replacement_receipts '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
  EXECUTE format(
    'REVOKE ALL ON %I.task_note_replacement_receipts FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON %I.task_note_knowledge_promotion_capabilities FROM opengeni_app',
      data_schema
    );
    EXECUTE format(
      'REVOKE ALL ON %I.task_note_replacement_receipts FROM opengeni_app',
      data_schema
    );
  END IF;
END
$promotion_capability_policy$;

CREATE OR REPLACE FUNCTION reject_task_note_replacement_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.root_session_id)
      OR NOT EXISTS (
        SELECT 1 FROM task_notes
        WHERE workspace_id = OLD.workspace_id AND id = OLD.replaced_note_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM task_notes
        WHERE workspace_id = OLD.workspace_id AND id = OLD.replacement_note_id
      )
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Task-note replacement receipts are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER task_note_replacement_receipts_immutable
  BEFORE UPDATE OR DELETE ON "task_note_replacement_receipts"
  FOR EACH ROW EXECUTE FUNCTION reject_task_note_replacement_receipt_mutation();

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

CREATE OR REPLACE FUNCTION replace_task_note_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_archive_operation_id uuid,
  p_create_operation_id uuid,
  p_replaced_note_id uuid,
  p_expected_replaced_version integer,
  p_replacement_kind text,
  p_replacement_text text,
  p_replacement_expires_in_days integer,
  p_reason text
) RETURNS TABLE (
  operation_id uuid,
  input_hash text,
  replaced_note_id uuid,
  replaced_note_version integer,
  replacement_note_id uuid,
  root_session_id uuid,
  replacement_kind text,
  replacement_text text,
  replacement_status text,
  replacement_version integer,
  replacement_expires_at timestamptz,
  replacement_created_at timestamptz,
  replacement_updated_at timestamptz,
  replacement_archived_at timestamptz,
  replacement_actor_kind text,
  replacement_source_session_id uuid,
  replacement_source_turn_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  receipt_row task_note_replacement_receipts%ROWTYPE;
  replaced_row task_notes%ROWTYPE;
  replacement_row task_notes%ROWTYPE;
  archived_result record;
  created_result record;
  calculated_replacement_text_hash text;
  calculated_input_hash text;
BEGIN
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL
    OR p_archive_operation_id IS NULL
    OR p_create_operation_id IS NULL
    OR p_operation_id = p_archive_operation_id
    OR p_operation_id = p_create_operation_id
    OR p_archive_operation_id = p_create_operation_id
    OR p_replaced_note_id IS NULL
    OR p_expected_replaced_version IS DISTINCT FROM 1
    OR p_replacement_kind NOT IN ('finding','decision','blocker','ownership','artifact','handoff')
    OR p_replacement_text IS NULL
    OR octet_length(p_replacement_text) NOT BETWEEN 1 AND 4096
    OR p_replacement_text <> btrim(p_replacement_text)
    OR p_replacement_expires_in_days IS NULL
    OR p_replacement_expires_in_days NOT BETWEEN 1 AND 30
    OR p_reason IS NULL
    OR octet_length(p_reason) NOT BETWEEN 1 AND 2048
    OR p_reason <> btrim(p_reason)
  THEN
    RAISE EXCEPTION 'Task-note replacement input is invalid' USING ERRCODE = '22023';
  END IF;

  calculated_replacement_text_hash := encode(
    sha256(convert_to(p_replacement_text, 'UTF8')), 'hex'
  );
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id,
    'workspaceId', p_workspace_id,
    'rootSessionId', authority.root_session_id,
    'sessionId', p_session_id,
    'turnId', p_turn_id,
    'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation,
    'operationId', p_operation_id,
    'archiveOperationId', p_archive_operation_id,
    'createOperationId', p_create_operation_id,
    'replacedNoteId', p_replaced_note_id,
    'expectedReplacedVersion', p_expected_replaced_version,
    'replacementKind', p_replacement_kind,
    'replacementTextHash', calculated_replacement_text_hash,
    'replacementExpiresInDays', p_replacement_expires_in_days,
    'reason', p_reason
  )::text, 'UTF8')), 'hex');

  SELECT receipt.* INTO receipt_row
  FROM task_note_replacement_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF receipt_row.account_id IS DISTINCT FROM p_account_id
      OR receipt_row.root_session_id IS DISTINCT FROM authority.root_session_id
      OR receipt_row.input_hash IS DISTINCT FROM calculated_input_hash
      OR receipt_row.replaced_note_id IS DISTINCT FROM p_replaced_note_id
      OR receipt_row.archive_operation_id IS DISTINCT FROM p_archive_operation_id
      OR receipt_row.create_operation_id IS DISTINCT FROM p_create_operation_id
      OR receipt_row.actor_session_id IS DISTINCT FROM p_session_id
      OR receipt_row.actor_turn_id IS DISTINCT FROM p_turn_id
      OR receipt_row.actor_attempt_id IS DISTINCT FROM p_attempt_id
      OR receipt_row.actor_execution_generation IS DISTINCT FROM p_execution_generation
      OR receipt_row.actor_kind IS DISTINCT FROM authority.actor_kind
      OR receipt_row.actor_subject_id IS DISTINCT FROM authority.actor_subject_id
      OR receipt_row.initiating_human_subject_id
        IS DISTINCT FROM authority.initiating_human_subject_id
    THEN
      RAISE EXCEPTION 'Task-note replacement operation conflicts with another input or attempt'
        USING ERRCODE = '23505';
    END IF;
    SELECT note.* INTO STRICT replacement_row
    FROM task_notes note
    WHERE note.workspace_id = p_workspace_id
      AND note.root_session_id = authority.root_session_id
      AND note.id = receipt_row.replacement_note_id;
    replayed := true;
  ELSE
    SELECT note.* INTO replaced_row
    FROM task_notes note
    WHERE note.workspace_id = p_workspace_id
      AND note.root_session_id = authority.root_session_id
      AND note.id = p_replaced_note_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task note is unavailable for replacement' USING ERRCODE = 'P0002';
    END IF;
    IF replaced_row.status <> 'active'
      OR replaced_row.version <> p_expected_replaced_version
      OR replaced_row.expires_at <= transaction_timestamp()
    THEN
      RAISE EXCEPTION 'Task-note replacement version or lifecycle conflict'
        USING ERRCODE = '40001';
    END IF;

    SELECT * INTO STRICT archived_result FROM archive_task_note_for_attempt(
      p_account_id, p_workspace_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation, p_archive_operation_id,
      p_replaced_note_id, p_expected_replaced_version, p_reason
    );
    SELECT * INTO STRICT created_result FROM create_task_note_for_attempt(
      p_account_id, p_workspace_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation, p_create_operation_id,
      p_replacement_kind, p_replacement_text, p_replacement_expires_in_days
    );
    IF archived_result.note_id IS DISTINCT FROM p_replaced_note_id
      OR archived_result.status IS DISTINCT FROM 'archived'
      OR archived_result.version IS DISTINCT FROM 2
      OR created_result.status IS DISTINCT FROM 'active'
      OR created_result.version IS DISTINCT FROM 1
      OR created_result.root_session_id IS DISTINCT FROM authority.root_session_id
    THEN
      RAISE EXCEPTION 'Task-note replacement lifecycle returned an invalid projection'
        USING ERRCODE = '23514';
    END IF;
    SELECT note.* INTO STRICT replacement_row
    FROM task_notes note
    WHERE note.workspace_id = p_workspace_id
      AND note.root_session_id = authority.root_session_id
      AND note.id = created_result.note_id;

    INSERT INTO task_note_replacement_receipts (
      account_id, workspace_id, root_session_id, operation_id, input_hash,
      replaced_note_id, replaced_note_version, replacement_note_id,
      replacement_note_version, archive_operation_id, create_operation_id,
      actor_kind, actor_subject_id, initiating_human_subject_id,
      actor_session_id, actor_turn_id, actor_attempt_id, actor_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id,
      p_operation_id, calculated_input_hash, p_replaced_note_id, 2,
      replacement_row.id, 1, p_archive_operation_id, p_create_operation_id,
      authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    ) RETURNING * INTO STRICT receipt_row;
    replayed := false;
  END IF;

  operation_id := receipt_row.operation_id;
  input_hash := receipt_row.input_hash;
  replaced_note_id := receipt_row.replaced_note_id;
  replaced_note_version := receipt_row.replaced_note_version;
  replacement_note_id := replacement_row.id;
  root_session_id := replacement_row.root_session_id;
  replacement_kind := replacement_row.kind;
  replacement_text := replacement_row.text;
  replacement_status := replacement_row.status;
  replacement_version := replacement_row.version;
  replacement_expires_at := replacement_row.expires_at;
  replacement_created_at := replacement_row.created_at;
  replacement_updated_at := replacement_row.updated_at;
  replacement_archived_at := replacement_row.archived_at;
  replacement_actor_kind := replacement_row.created_by_actor_kind;
  replacement_source_session_id := replacement_row.created_by_session_id;
  replacement_source_turn_id := replacement_row.created_by_turn_id;
  RETURN NEXT;
END;
$$;

DO $function_access$
DECLARE
  data_schema text := current_schema();
  required_routine text;
BEGIN
  -- Migration 0239 predates the explicit pg_temp-last posture. Its lifecycle
  -- functions are invoked by both 0260 entry points, while their RLS path also
  -- invokes the 0225 session-reference/private-actor helpers. A caller with
  -- database TEMP privilege must not be able to shadow any authority relation
  -- reached through that nested closure. Fail closed if the exact predecessor
  -- signatures are absent, then repair only their persisted search paths.
  FOREACH required_routine IN ARRAY ARRAY[
    'guard_task_note_mutation()',
    'guard_task_note_event_mutation()',
    'resolve_task_note_attempt_authority(uuid,uuid,uuid,uuid,uuid,integer)',
    'create_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,integer)',
    'archive_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text)',
    'list_task_notes_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,boolean,integer)',
    'session_private_actor_visible(uuid,uuid,uuid,text)',
    'session_reference_visible(uuid,uuid,uuid)'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', data_schema, required_routine)
    ) IS NULL THEN
      RAISE EXCEPTION 'Task-note authority closure routine is missing: %.%',
        data_schema, required_routine
        USING ERRCODE = '42883';
    END IF;
  END LOOP;

  EXECUTE format(
    'ALTER FUNCTION %I.guard_task_note_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.guard_task_note_event_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_task_note_attempt_authority('
      || 'uuid,uuid,uuid,uuid,uuid,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.create_task_note_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.archive_task_note_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_task_notes_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,boolean,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.session_private_actor_visible(uuid,uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.session_reference_visible(uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.validate_task_note_knowledge_evidence() FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.reject_task_note_replacement_receipt_mutation() FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.replace_task_note_for_attempt('
    || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,integer,text,text,integer,text) '
    || 'FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.resolve_task_note_knowledge_promotion_source('
    || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.validate_task_note_knowledge_evidence() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.reject_task_note_replacement_receipt_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.replace_task_note_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,integer,text,text,integer,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_task_note_knowledge_promotion_source('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.resolve_task_note_knowledge_promotion_source('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.replace_task_note_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,integer,text,text,integer,text) '
      || 'TO opengeni_app',
      data_schema
    );
  END IF;
END
$function_access$;
