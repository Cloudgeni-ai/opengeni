-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Human-confirmed Knowledge approval for explicit `remember` facts. A
-- user-directed Knowledge claim (Task-note evidence) is approved only after the
-- exact initiating human answered the bound structured human-input question
-- (`remember:<claimId>` = `save`, canonical prompt, exact note text as help
-- text) on the same live turn. The approval is written through the same
-- guarded service-review path the governed-learning controller uses and is
-- recorded on an immutable, content-free receipt ledger.

CREATE TABLE "remember_knowledge_confirmation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "service_actor_subject_id" text NOT NULL,
  "claim_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "task_note_id" uuid NOT NULL,
  "task_note_text_hash" text NOT NULL,
  "human_input_request_id" uuid NOT NULL,
  "previous_review_id" uuid NOT NULL,
  "previous_review_revision" bigint NOT NULL,
  "approval_review_id" uuid NOT NULL,
  "approval_review_revision" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("workspace_id", "operation_id"),
  UNIQUE ("claim_id"),
  CONSTRAINT "remember_knowledge_confirmation_receipts_actor_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    AND "service_actor_subject_id" LIKE 'service:governed-learning-activation:%'
    AND "execution_generation" > 0
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND "task_note_text_hash" ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX "remember_knowledge_confirmation_receipts_workspace_time_idx"
  ON "remember_knowledge_confirmation_receipts" ("workspace_id", "created_at" DESC, "id" DESC);

ALTER TABLE "remember_knowledge_confirmation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "remember_knowledge_confirmation_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY remember_knowledge_confirmation_receipts_tenant
  ON "remember_knowledge_confirmation_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation
  ON "remember_knowledge_confirmation_receipts" AS RESTRICTIVE
  USING (session_reference_visible("account_id", "workspace_id", "session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "session_id"));

CREATE OR REPLACE FUNCTION reject_remember_knowledge_confirmation_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 AND (
    NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND id = OLD.session_id)
    OR NOT EXISTS (SELECT 1 FROM knowledge_claims WHERE id = OLD.claim_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'remember Knowledge confirmation receipts are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER remember_knowledge_confirmation_receipts_immutable
  BEFORE UPDATE OR DELETE ON "remember_knowledge_confirmation_receipts"
  FOR EACH ROW EXECUTE FUNCTION reject_remember_knowledge_confirmation_receipt_mutation();

CREATE OR REPLACE FUNCTION confirm_remember_knowledge_claim(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_claim_id uuid,
  p_human_input_request_id uuid
) RETURNS SETOF remember_knowledge_confirmation_receipts
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  caller_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  result_row remember_knowledge_confirmation_receipts%ROWTYPE;
  claim_row knowledge_claims%ROWTYPE;
  evidence_row knowledge_claim_evidence%ROWTYPE;
  task_note_row task_notes%ROWTYPE;
  review_row knowledge_claim_reviews%ROWTYPE;
  approval_row knowledge_claim_reviews%ROWTYPE;
  human_input_row session_human_input_requests%ROWTYPE;
  input_hash_value text;
  service_actor text;
  human_question_id text;
  human_question_prompt text := 'Save this as workspace knowledge for everyone in this workspace?';
  human_question_help text;
  human_question_options jsonb := jsonb_build_array(
    jsonb_build_object('id', 'save', 'label', 'Save'),
    jsonb_build_object('id', 'skip', 'label', 'Don''t save')
  );
  conflict_count integer;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
    OR p_execution_generation IS NULL OR p_execution_generation <= 0
    OR p_operation_id IS NULL OR p_claim_id IS NULL OR p_human_input_request_id IS NULL
    OR caller_subject_id IS NULL OR length(btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'remember Knowledge confirmation requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'remember-knowledge-confirmation', 1, p_account_id, p_workspace_id, p_session_id,
    p_turn_id, p_execution_generation, p_operation_id, p_claim_id, p_human_input_request_id
  )::text, 'UTF8')), 'hex');
  service_actor := 'service:governed-learning-activation:' || input_hash_value;

  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO result_row FROM remember_knowledge_confirmation_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.initiating_human_subject_id <> caller_subject_id
    THEN
      RAISE EXCEPTION 'remember Knowledge confirmation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM remember_knowledge_confirmation_receipts receipt WHERE receipt.claim_id = p_claim_id) THEN
    RAISE EXCEPTION 'remember Knowledge claim was already confirmed by another operation'
      USING ERRCODE = '23505';
  END IF;

  -- The live turn must belong to the caller (the initiating human) and hold a
  -- running attempt of the given execution generation without a pending
  -- interruption; the human-input pause resumes on a later attempt.
  PERFORM 1 FROM sessions session
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id AND session.active_turn_id = p_turn_id
    AND session_reference_visible(session.account_id, session.workspace_id, session.id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge session is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM session_turns turn
  JOIN session_turn_attempts attempt
    ON attempt.account_id = turn.account_id AND attempt.workspace_id = turn.workspace_id
   AND attempt.session_id = turn.session_id AND attempt.turn_id = turn.id
   AND attempt.id = turn.active_attempt_id
  WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id AND turn.id = p_turn_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND coalesce(turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ) = caller_subject_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE OF attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge turn is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO claim_row FROM knowledge_claims claim
  WHERE claim.id = p_claim_id AND claim.account_id = p_account_id
    AND claim.scope_kind = 'workspace' AND claim.scope_workspace_id = p_workspace_id
    AND claim.scope_subject_id IS NULL
    AND claim.initiating_human_subject_id = caller_subject_id
    AND claim.effective_at <= transaction_timestamp()
    AND (claim.expires_at IS NULL OR claim.expires_at > transaction_timestamp())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge claim is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO evidence_row FROM knowledge_claim_evidence evidence
  WHERE evidence.account_id = p_account_id AND evidence.scope_kind = 'workspace'
    AND evidence.scope_workspace_id = p_workspace_id AND evidence.scope_subject_id IS NULL
    AND evidence.claim_id = p_claim_id AND evidence.polarity = 'supports'
    AND evidence.task_note_id IS NOT NULL
    AND evidence.initiating_human_subject_id = caller_subject_id
  ORDER BY evidence.created_at ASC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge confirmation requires exact Task-note evidence'
      USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO conflict_count FROM knowledge_claim_evidence contradiction
  WHERE contradiction.account_id = p_account_id AND contradiction.scope_kind = 'workspace'
    AND contradiction.scope_workspace_id = p_workspace_id AND contradiction.scope_subject_id IS NULL
    AND contradiction.claim_id = p_claim_id AND contradiction.polarity = 'contradicts';
  IF conflict_count <> 0 THEN
    RAISE EXCEPTION 'remember Knowledge evidence now conflicts' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO task_note_row FROM task_notes note
  WHERE note.id = evidence_row.task_note_id AND note.account_id = p_account_id
    AND note.workspace_id = p_workspace_id
    AND note.root_session_id = evidence_row.task_note_root_session_id
    AND note.version = evidence_row.task_note_version
    AND note.text_hash = evidence_row.content_hash
    AND note.status = 'active' AND note.expires_at > transaction_timestamp()
    AND session_reference_visible(note.account_id, note.workspace_id, note.root_session_id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remember Knowledge Task-note authority was revoked' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO review_row FROM knowledge_claim_reviews review
  WHERE review.account_id = p_account_id AND review.claim_id = p_claim_id
  ORDER BY review.review_revision DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND OR review_row.state <> 'proposed' THEN
    RAISE EXCEPTION 'remember Knowledge claim is not awaiting confirmation' USING ERRCODE = '42501';
  END IF;

  -- The exact human must have answered the canonical bound question with
  -- `save` on this session/turn generation. The question is reconstructed
  -- here from the note text, so an agent cannot obtain confirmation through a
  -- misleading prompt.
  human_question_id := 'remember:' || p_claim_id::text;
  human_question_help := left(task_note_row.text, 2000);
  SELECT * INTO human_input_row FROM session_human_input_requests request
  WHERE request.id = p_human_input_request_id
    AND request.account_id = p_account_id AND request.workspace_id = p_workspace_id
    AND request.session_id = p_session_id AND request.turn_id = p_turn_id
    AND request.turn_generation = p_execution_generation
    AND request.status = 'answered'
    AND request.responded_by = caller_subject_id
    AND request.response->>'outcome' = 'answered'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(request.questions) question(value)
      WHERE question.value->>'id' = human_question_id
        AND question.value->>'kind' = 'single_select'
        AND question.value->>'prompt' = human_question_prompt
        AND question.value->>'helpText' = human_question_help
        AND question.value->'options' = human_question_options
        AND coalesce((question.value->>'allowOther')::boolean, false) = false
    )
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(request.response->'answers') answer(value)
      WHERE answer.value->>'questionId' = human_question_id
        AND answer.value->'values' = to_jsonb(ARRAY['save'])
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'human confirmation for this Knowledge claim is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO approval_row FROM governed_learning_apply_knowledge_review(
    p_account_id, p_workspace_id,
    opengeni_private.governed_learning_derived_uuid(p_operation_id, 'remember-knowledge-approval'),
    p_claim_id, review_row.id, review_row.review_revision, 'approved',
    service_actor, caller_subject_id
  );

  INSERT INTO remember_knowledge_confirmation_receipts (
    account_id, workspace_id, operation_id, input_hash, session_id, turn_id,
    execution_generation, initiating_human_subject_id, service_actor_subject_id,
    claim_id, evidence_id, task_note_id, task_note_text_hash, human_input_request_id,
    previous_review_id, previous_review_revision, approval_review_id, approval_review_revision
  ) VALUES (
    p_account_id, p_workspace_id, p_operation_id, input_hash_value, p_session_id, p_turn_id,
    p_execution_generation, caller_subject_id, service_actor,
    p_claim_id, evidence_row.id, task_note_row.id, task_note_row.text_hash, p_human_input_request_id,
    review_row.id, review_row.review_revision, approval_row.id, approval_row.review_revision
  ) RETURNING * INTO result_row;
  RETURN NEXT result_row;
END;
$$;
REVOKE ALL ON FUNCTION confirm_remember_knowledge_claim(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON TABLE "remember_knowledge_confirmation_receipts" FROM PUBLIC;

DO $remember_knowledge_confirmation_hardening$
DECLARE
  target_schema text := current_schema();
  runtime_role text := nullif(current_setting('opengeni.runtime_role', true), '');
BEGIN
  IF runtime_role IS NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    runtime_role := 'opengeni_app';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.reject_remember_knowledge_confirmation_receipt_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.confirm_remember_knowledge_claim(uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  IF runtime_role IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.remember_knowledge_confirmation_receipts FROM %I', target_schema, runtime_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.confirm_remember_knowledge_claim(uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) TO %I',
      target_schema, runtime_role
    );
  END IF;
END
$remember_knowledge_confirmation_hardening$;
