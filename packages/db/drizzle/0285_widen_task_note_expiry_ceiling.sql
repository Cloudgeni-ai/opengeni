-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Widen the task-note expiry ceiling from 30 to 90 days. Task notes are pure
-- agent-to-agent coordination within one root session tree; a resumed root
-- session/task tree after a long pause otherwise silently loses all
-- coordination notes with no warning, since expiry is a read-time filter, not
-- a deletion. No documented rationale exists for the original 30-day figure.
-- This is fully backward compatible: every existing row and every caller
-- still supplying 1-30 days keeps working unchanged.

ALTER TABLE "task_notes"
  DROP CONSTRAINT "task_notes_expiry_check";
ALTER TABLE "task_notes"
  ADD CONSTRAINT "task_notes_expiry_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '90 days')
    NOT VALID;
ALTER TABLE "task_notes"
  VALIDATE CONSTRAINT "task_notes_expiry_check";

-- Function bodies below are byte-identical to their prior definitions
-- (0239_task_tree_notes.sql / 0260_task_note_knowledge_promotion.sql) except
-- the one numeric bound each enforces in its input-validation check.

CREATE OR REPLACE FUNCTION create_task_note_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_kind text,
  p_text text,
  p_expires_in_days integer
) RETURNS TABLE (
  note_id uuid, root_session_id uuid, kind text, note_text text, status text,
  version integer, expires_at timestamptz, created_at timestamptz,
  updated_at timestamptz, archived_at timestamptz, actor_kind text,
  source_session_id uuid, source_turn_id uuid, replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  existing_event task_note_events%ROWTYPE;
  note_row task_notes%ROWTYPE;
  calculated_text_hash text;
  calculated_input_hash text;
  calculated_expires_at timestamptz;
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting('opengeni.task_note_write_capability', true);
BEGIN
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL
    OR p_kind NOT IN ('finding','decision','blocker','ownership','artifact','handoff')
    OR p_text IS NULL OR octet_length(p_text) NOT BETWEEN 1 AND 4096
    OR p_text <> btrim(p_text)
    OR p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 90
  THEN
    RAISE EXCEPTION 'task note input is invalid' USING ERRCODE = '22023';
  END IF;
  calculated_expires_at := transaction_timestamp()
    + pg_catalog.make_interval(days => p_expires_in_days);
  calculated_text_hash := encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'rootSessionId', authority.root_session_id, 'sessionId', p_session_id,
    'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'kind', p_kind,
    'textHash', calculated_text_hash, 'expiresInDays', p_expires_in_days
  )::text, 'UTF8')), 'hex');

  INSERT INTO task_note_write_capabilities (backend_pid, transaction_id, capability_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config('opengeni.task_note_write_capability', write_capability_id::text, true);

  SELECT * INTO existing_event FROM task_note_events event
  WHERE event.workspace_id = p_workspace_id AND event.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_event.event_type <> 'created'
      OR existing_event.input_hash <> calculated_input_hash
      OR existing_event.root_session_id <> authority.root_session_id
      OR existing_event.actor_session_id <> p_session_id
      OR existing_event.actor_turn_id <> p_turn_id
      OR existing_event.actor_attempt_id <> p_attempt_id
      OR existing_event.actor_execution_generation <> p_execution_generation
    THEN
      RAISE EXCEPTION 'task note operation conflicts with another input or attempt'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO STRICT note_row FROM task_notes note
    WHERE note.workspace_id = p_workspace_id AND note.id = existing_event.note_id;
    replayed := true;
  ELSE
    IF (SELECT count(*) FROM task_notes note
        WHERE note.workspace_id = p_workspace_id
          AND note.root_session_id = authority.root_session_id
          AND note.status = 'active' AND note.expires_at > transaction_timestamp()) >= 500
    THEN
      RAISE EXCEPTION 'task note active-record limit reached' USING ERRCODE = '54000';
    END IF;
    INSERT INTO task_notes (
      account_id, workspace_id, root_session_id, kind, text, text_hash,
      expires_at, create_operation_id, create_input_hash,
      created_by_actor_kind, created_by_actor_subject_id,
      created_by_initiating_human_subject_id, created_by_session_id,
      created_by_turn_id, created_by_attempt_id, created_by_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id, p_kind, p_text,
      calculated_text_hash, calculated_expires_at, p_operation_id, calculated_input_hash,
      authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    ) RETURNING * INTO note_row;
    INSERT INTO task_note_events (
      account_id, workspace_id, root_session_id, note_id, event_type,
      note_version, operation_id, input_hash, text_hash, actor_kind,
      actor_subject_id, initiating_human_subject_id, actor_session_id,
      actor_turn_id, actor_attempt_id, actor_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id, note_row.id,
      'created', 1, p_operation_id, calculated_input_hash,
      calculated_text_hash, authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    );
    replayed := false;
  END IF;

  note_id := note_row.id; root_session_id := note_row.root_session_id;
  kind := note_row.kind; note_text := note_row.text; status := note_row.status;
  version := note_row.version; expires_at := note_row.expires_at;
  created_at := note_row.created_at; updated_at := note_row.updated_at;
  archived_at := note_row.archived_at; actor_kind := note_row.created_by_actor_kind;
  source_session_id := note_row.created_by_session_id;
  source_turn_id := note_row.created_by_turn_id;
  DELETE FROM task_note_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
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
    OR p_replacement_expires_in_days NOT BETWEEN 1 AND 90
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

RESET statement_timeout;
RESET lock_timeout;
