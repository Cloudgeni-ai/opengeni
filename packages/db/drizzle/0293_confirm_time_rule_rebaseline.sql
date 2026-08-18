-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Confirm-time rebaseline for user-directed rules.
--
-- When the instruction-policy head moved between proposing a rule and the
-- human confirming it, activation failed with a stale baseline after the human
-- had already answered "save", with no way forward but re-asking them. The
-- confirm path now rebaselines instead: it adds a successor proposal for the
-- SAME knowledge proposal against the current head and retries. The human's
-- confirmation stays bound to `remember:<knowledgeProposalId>`, which does not
-- change, so the exact-binding guarantee in 0272/0274 is untouched.
--
-- That makes more than one inactive instruction-policy proposal per knowledge
-- proposal legitimate, so the uniqueness key moves from "one per source" to
-- "one per source per baseline" - a rebaselined successor is admissible, a
-- duplicate against the same baseline still is not.

DROP INDEX "workspace_instruction_policy_onboarding_proposals_source_versio";
CREATE UNIQUE INDEX "workspace_instruction_policy_onboarding_proposals_source_versio"
  ON "workspace_instruction_policy_onboarding_proposals" (
    "workspace_id", "kind", "scope", COALESCE("role_key", ''),
    "source_id", "source_version", "baseline_activation_version"
  );

-- Body is byte-identical to migration 0284 except the instruction-policy
-- branch, which now resolves the live head before selecting the proposal so
-- multiple candidates are disambiguated deterministically.
CREATE OR REPLACE FUNCTION activate_human_confirmed_learning_decision(
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_decision_receipt_id uuid,
  p_human_input_request_id uuid
) RETURNS SETOF governed_learning_activation_receipts
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  caller_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  decision_row governed_learning_decision_receipts%ROWTYPE;
  result_row governed_learning_activation_receipts%ROWTYPE;
  proposal_row knowledge_change_proposals%ROWTYPE;
  claim_row knowledge_claims%ROWTYPE;
  evidence_row knowledge_claim_evidence%ROWTYPE;
  review_row knowledge_claim_reviews%ROWTYPE;
  approval_row knowledge_claim_reviews%ROWTYPE;
  policy_head workspace_learning_policy_heads%ROWTYPE;
  policy_revision workspace_learning_policy_revisions%ROWTYPE;
  policy_snapshot workspace_learning_policy_snapshots%ROWTYPE;
  task_note_row task_notes%ROWTYPE;
  document_authority record;
  instruction_proposal workspace_instruction_policy_onboarding_proposals%ROWTYPE;
  instruction_event workspace_instruction_policy_activation_events%ROWTYPE;
  preference_receipt company_brain_preference_proposal_receipts%ROWTYPE;
  preference_row preference_registry_preferences%ROWTYPE;
  preference_revision preference_registry_revisions%ROWTYPE;
  preference_event preference_registry_events%ROWTYPE;
  current_instruction_head workspace_instruction_policy_heads%ROWTYPE;
  current_instruction_activation_version bigint;
  input_hash_value text;
  service_actor text;
  current_authority_hash text;
  current_mode text;
  conflict_count integer;
  destination_value text;
  destination_proposal_id_value uuid;
  destination_revision_id_value uuid;
  destination_old_revision_id_value uuid;
  destination_old_content_hash_value text;
  destination_old_version_value bigint;
  destination_new_content_hash_value text;
  destination_new_version_value bigint;
  destination_event_id_value uuid;
  effective_at_value timestamptz;
  review_operation_id uuid;
  destination_operation_id uuid;
  human_input_row session_human_input_requests%ROWTYPE;
  human_question_id text;
  human_question_lane text;
  human_question_prompt text;
  human_question_help text;
  human_question_options jsonb := jsonb_build_array(
    jsonb_build_object('id', 'save', 'label', 'Save'),
    jsonb_build_object('id', 'skip', 'label', 'Don''t save')
  );
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_operation_id IS NULL
    OR p_decision_receipt_id IS NULL OR p_human_input_request_id IS NULL
    OR caller_subject_id IS NULL
    OR length(btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'governed-learning activation requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'governed-learning-human-confirmed-activation', 1, p_account_id, p_workspace_id,
    p_operation_id, p_decision_receipt_id, p_human_input_request_id
  )::text, 'UTF8')), 'hex');
  SELECT * INTO result_row FROM governed_learning_activation_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.decision_receipt_id <> p_decision_receipt_id
      OR result_row.initiating_human_subject_id <> caller_subject_id
      OR result_row.authority_kind <> 'human_confirmed'
      OR result_row.human_input_request_id IS DISTINCT FROM p_human_input_request_id
    THEN
      RAISE EXCEPTION 'governed-learning activation operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;

  -- Canonical shared prefix. The workspace UPDATE lock also gives all three
  -- destination adapters one order, avoiding claim/head inversion.
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO result_row FROM governed_learning_activation_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.decision_receipt_id <> p_decision_receipt_id
      OR result_row.initiating_human_subject_id <> caller_subject_id
      OR result_row.authority_kind <> 'human_confirmed'
      OR result_row.human_input_request_id IS DISTINCT FROM p_human_input_request_id
    THEN
      RAISE EXCEPTION 'governed-learning activation operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;
  SELECT * INTO decision_row FROM governed_learning_decision_receipts receipt
  WHERE receipt.id = p_decision_receipt_id AND receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = caller_subject_id
    AND receipt.outcome IN ('suggest', 'automatic', 'confidence')
  FOR UPDATE;
  IF NOT FOUND OR NOT session_reference_visible(
    decision_row.account_id, decision_row.workspace_id, decision_row.session_id
  ) THEN
    RAISE EXCEPTION 'confirmable evaluator receipt is unavailable'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM governed_learning_activation_receipts receipt
    WHERE receipt.decision_receipt_id = p_decision_receipt_id
  ) THEN
    RAISE EXCEPTION 'automatic evaluator receipt was consumed by another operation'
      USING ERRCODE = '23505';
  END IF;
  PERFORM 1 FROM sessions session
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = decision_row.session_id AND session.active_turn_id = decision_row.turn_id
    AND session_reference_visible(session.account_id, session.workspace_id, session.id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning activation session is unavailable' USING ERRCODE = '42501';
  END IF;
  -- The decision receipt was minted before the human-input pause, so the
  -- turn's active attempt is normally a later attempt of the same logical
  -- turn and execution generation. Require that live attempt instead of the
  -- exact minting attempt; the human answer is bound to the same generation.
  PERFORM 1 FROM session_turns turn
  WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
    AND turn.session_id = decision_row.session_id AND turn.id = decision_row.turn_id
    AND turn.execution_generation = decision_row.execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND coalesce(turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ) = caller_subject_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning activation turn is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM session_turns turn
  JOIN session_turn_attempts attempt
    ON attempt.account_id = turn.account_id AND attempt.workspace_id = turn.workspace_id
   AND attempt.session_id = turn.session_id AND attempt.turn_id = turn.id
   AND attempt.id = turn.active_attempt_id
  WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
    AND turn.session_id = decision_row.session_id AND turn.id = decision_row.turn_id
    AND attempt.execution_generation = decision_row.execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE OF attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning activation attempt is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO policy_snapshot FROM workspace_learning_policy_snapshots snapshot
  WHERE snapshot.id = decision_row.policy_snapshot_id
    AND snapshot.account_id = p_account_id AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = decision_row.session_id
    AND snapshot.turn_id = decision_row.turn_id
    AND snapshot.attempt_id = decision_row.attempt_id
    AND snapshot.execution_generation = decision_row.execution_generation
    AND snapshot.snapshot_hash = decision_row.policy_snapshot_hash
  FOR SHARE;
  SELECT * INTO policy_head FROM workspace_learning_policy_heads head
  WHERE head.account_id = p_account_id AND head.workspace_id = p_workspace_id
  FOR SHARE;
  SELECT * INTO policy_revision FROM workspace_learning_policy_revisions revision
  WHERE revision.account_id = p_account_id AND revision.workspace_id = p_workspace_id
    AND revision.id = policy_head.revision_id
  FOR SHARE;
  IF policy_snapshot.id IS NULL
    OR policy_head.revision_id IS DISTINCT FROM decision_row.policy_revision_id
    OR policy_head.policy_hash IS DISTINCT FROM policy_snapshot.policy_hash
    OR policy_head.activation_version IS DISTINCT FROM decision_row.policy_activation_version
    OR policy_revision.policy_hash IS DISTINCT FROM policy_snapshot.policy_hash
  THEN
    RAISE EXCEPTION 'governed-learning policy authority changed after evaluation'
      USING ERRCODE = '40001';
  END IF;
  current_mode := coalesce((
    SELECT override.value->>'mode'
    FROM jsonb_array_elements(policy_revision.source_overrides) override(value)
    WHERE override.value->>'kind' = decision_row.source_kind
      AND override.value->>'id' = decision_row.source_id::text LIMIT 1
  ), policy_revision.workspace_mode);
  IF current_mode = 'off' THEN
    RAISE EXCEPTION 'governed-learning source is off' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO proposal_row FROM knowledge_change_proposals proposal
  WHERE proposal.id = decision_row.proposal_id AND proposal.account_id = p_account_id
    AND proposal.scope_kind = 'workspace' AND proposal.scope_workspace_id = p_workspace_id
    AND proposal.scope_subject_id IS NULL AND proposal.status = 'proposed'
    AND proposal.input_hash = decision_row.proposal_input_hash
    AND proposal.content_hash = decision_row.proposal_content_hash
    AND proposal.claim_id = decision_row.claim_id
    AND proposal.evidence_id = decision_row.evidence_id
    AND proposal.initiating_human_subject_id = caller_subject_id
  FOR SHARE;
  SELECT * INTO claim_row FROM knowledge_claims claim
  WHERE claim.id = decision_row.claim_id AND claim.account_id = p_account_id
    AND claim.scope_kind = 'workspace' AND claim.scope_workspace_id = p_workspace_id
    AND claim.scope_subject_id IS NULL AND claim.input_hash = decision_row.claim_input_hash
    AND claim.initiating_human_subject_id = caller_subject_id
    AND claim.confidence_bps >= decision_row.confidence_floor_bps
    AND claim.effective_at <= transaction_timestamp()
    AND (claim.expires_at IS NULL OR claim.expires_at > transaction_timestamp())
  FOR UPDATE;
  SELECT * INTO evidence_row FROM knowledge_claim_evidence evidence
  WHERE evidence.id = decision_row.evidence_id AND evidence.account_id = p_account_id
    AND evidence.scope_kind = 'workspace' AND evidence.scope_workspace_id = p_workspace_id
    AND evidence.scope_subject_id IS NULL AND evidence.claim_id = decision_row.claim_id
    AND evidence.polarity = 'supports' AND evidence.input_hash = decision_row.evidence_input_hash
    AND evidence.content_hash = decision_row.evidence_content_hash
    AND evidence.initiating_human_subject_id = caller_subject_id
  FOR SHARE;
  IF proposal_row.id IS NULL OR claim_row.id IS NULL OR evidence_row.id IS NULL THEN
    RAISE EXCEPTION 'governed-learning proposal lineage changed after evaluation'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO review_row FROM knowledge_claim_reviews review
  WHERE review.account_id = p_account_id AND review.claim_id = decision_row.claim_id
  ORDER BY review.review_revision DESC LIMIT 1 FOR SHARE;
  IF review_row.id IS NULL OR review_row.state <> 'proposed'
    OR review_row.review_revision <> decision_row.review_revision
  THEN
    RAISE EXCEPTION 'governed-learning review was superseded after evaluation'
      USING ERRCODE = '40001';
  END IF;
  SELECT least(1000, count(*))::integer INTO conflict_count FROM (
    SELECT relation.id FROM knowledge_claim_relations relation
    WHERE relation.account_id = p_account_id AND relation.scope_kind = 'workspace'
      AND relation.scope_workspace_id = p_workspace_id AND relation.scope_subject_id IS NULL
      AND relation.relation_type = 'conflicts_with'
      AND (relation.from_claim_id = decision_row.claim_id
        OR relation.to_claim_id = decision_row.claim_id)
    UNION ALL
    SELECT contradiction.id FROM knowledge_claim_evidence contradiction
    WHERE contradiction.account_id = p_account_id AND contradiction.scope_kind = 'workspace'
      AND contradiction.scope_workspace_id = p_workspace_id
      AND contradiction.scope_subject_id IS NULL
      AND contradiction.claim_id = decision_row.claim_id
      AND contradiction.polarity = 'contradicts'
  ) conflicts;
  IF conflict_count <> 0 THEN
    RAISE EXCEPTION 'governed-learning evidence now conflicts' USING ERRCODE = '23514';
  END IF;

  IF evidence_row.task_note_id IS NOT NULL THEN
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
      RAISE EXCEPTION 'governed-learning Task-note authority was revoked' USING ERRCODE = '42501';
    END IF;
    current_authority_hash := encode(sha256(convert_to(jsonb_build_array(
      'task-note-authority', 1, evidence_row.task_note_id,
      evidence_row.task_note_root_session_id, evidence_row.task_note_version,
      evidence_row.content_hash, task_note_row.status, task_note_row.expires_at
    )::text, 'UTF8')), 'hex');
  ELSE
    SELECT provider.id AS provider_id, provider.lifecycle_state AS provider_state,
      provider.lifecycle_generation AS provider_generation, source.id AS source_id,
      source.lifecycle_state AS source_state, source.lifecycle_generation AS source_generation,
      source.current_acl_generation, object.id AS object_id,
      object.lifecycle_state AS object_state, object.lifecycle_generation AS object_generation,
      object.version_generation AS object_version_generation, object.current_version_id,
      version.id AS version_id, version.version_generation, version.content_sha256,
      version.acl_version_id, version.acl_generation, version.document_id,
      evidence_acl.acl_hash AS evidence_acl_hash,
      evidence_acl.agent_access AS evidence_agent_access,
      current_acl.id AS current_acl_id, current_acl.acl_hash AS current_acl_hash,
      current_acl.agent_access AS current_agent_access
    INTO document_authority
    FROM knowledge_document_versions version
    JOIN knowledge_source_objects object ON object.account_id = version.account_id
      AND object.id = version.object_id AND object.scope_key = version.scope_key
    JOIN knowledge_sources source ON source.account_id = version.account_id
      AND source.id = version.source_id AND source.scope_key = version.scope_key
    JOIN knowledge_providers provider ON provider.account_id = source.account_id
      AND provider.id = source.provider_id AND provider.scope_key = source.scope_key
    JOIN knowledge_source_acl_versions evidence_acl ON evidence_acl.account_id = version.account_id
      AND evidence_acl.id = version.acl_version_id AND evidence_acl.source_id = version.source_id
      AND evidence_acl.generation = version.acl_generation
    LEFT JOIN knowledge_source_acl_versions current_acl ON current_acl.account_id = source.account_id
      AND current_acl.source_id = source.id AND current_acl.generation = source.current_acl_generation
    WHERE version.id = evidence_row.document_version_id AND version.account_id = p_account_id
      AND version.scope_kind = 'workspace' AND version.scope_workspace_id = p_workspace_id
      AND version.scope_subject_id IS NULL
    FOR SHARE OF version, object, source, provider, evidence_acl;
    IF document_authority.version_id IS NULL
      OR document_authority.provider_state IS DISTINCT FROM 'active'
      OR document_authority.source_state IS DISTINCT FROM 'active'
      OR document_authority.object_state IS DISTINCT FROM 'active'
      OR document_authority.current_version_id IS DISTINCT FROM document_authority.version_id
      OR document_authority.object_version_generation IS DISTINCT FROM document_authority.version_generation
      OR document_authority.current_acl_id IS NULL
      OR NOT coalesce(document_authority.evidence_agent_access, false)
      OR NOT coalesce(document_authority.current_agent_access, false)
      OR (document_authority.document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document WHERE document.id = document_authority.document_id
          AND document.account_id = p_account_id AND document.workspace_id = p_workspace_id
          AND document.status = 'ready' AND document.agent_access
          AND (document.visibility <> 'private' OR document.created_by = caller_subject_id)
      ))
      OR (evidence_row.document_chunk_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_chunks chunk WHERE chunk.id = evidence_row.document_chunk_id
          AND chunk.account_id = p_account_id AND chunk.workspace_id = p_workspace_id
          AND chunk.document_id = document_authority.document_id
      ))
    THEN
      RAISE EXCEPTION 'governed-learning document authority was revoked' USING ERRCODE = '42501';
    END IF;
    current_authority_hash := encode(sha256(convert_to(jsonb_build_array(
      'document-evidence-authority', 1, evidence_row.document_version_id,
      document_authority.provider_id, document_authority.provider_state,
      document_authority.provider_generation, document_authority.source_id,
      document_authority.source_state, document_authority.source_generation,
      document_authority.current_acl_generation, document_authority.object_id,
      document_authority.object_state, document_authority.object_generation,
      document_authority.object_version_generation, document_authority.current_version_id,
      document_authority.version_id, document_authority.version_generation,
      document_authority.content_sha256, document_authority.acl_version_id,
      document_authority.acl_generation, document_authority.evidence_acl_hash,
      document_authority.current_acl_id, document_authority.current_acl_hash,
      evidence_row.document_chunk_id, false
    )::text, 'UTF8')), 'hex');
  END IF;

  -- The exact human must have answered the bound question for this proposal
  -- on the same session/turn, in the same execution generation, with `save`.
  -- The question the human saw is reconstructed here from the proposal itself
  -- (canonical prompt, exact proposal content as help text, fixed options), so
  -- an agent cannot obtain confirmation through a misleading prompt.
  human_question_id := 'remember:' || decision_row.proposal_id::text;
  -- Only Task-note evidence (the exact user-directed text) is confirmable; the
  -- proposal content of a preference is a normalized envelope, not the words
  -- the human was shown.
  IF task_note_row.id IS NULL THEN
    RAISE EXCEPTION 'human confirmation requires exact Task-note evidence' USING ERRCODE = '42501';
  END IF;
  human_question_lane := proposal_row.target_kind;
  human_question_help := left(task_note_row.text, 2000);
  human_question_prompt := 'Save this as a ' || CASE human_question_lane
      WHEN 'instruction_policy' THEN 'mandatory workspace rule'
      WHEN 'preference' THEN 'workspace preference'
      ELSE 'workspace knowledge' END
    || ' for everyone in this workspace?';
  SELECT * INTO human_input_row FROM session_human_input_requests request
  WHERE request.id = p_human_input_request_id
    AND request.account_id = p_account_id AND request.workspace_id = p_workspace_id
    AND request.session_id = decision_row.session_id
    AND request.turn_id = decision_row.turn_id
    AND request.turn_generation = decision_row.execution_generation
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
    RAISE EXCEPTION 'human confirmation for this proposal is unavailable'
      USING ERRCODE = '42501';
  END IF;
  IF current_authority_hash IS DISTINCT FROM decision_row.evidence_authority_hash THEN
    RAISE EXCEPTION 'governed-learning evidence authority changed after evaluation'
      USING ERRCODE = '40001';
  END IF;

  IF proposal_row.target_kind = 'instruction_policy' THEN
    -- One knowledge proposal may now own more than one inactive
    -- instruction-policy proposal: when the head moves after the human already
    -- confirmed, the confirm path rebaselines by adding a successor against the
    -- current head rather than stranding the human's answer. Exactly one of
    -- them can match the live head, so resolve the head first and select by it
    -- instead of assuming a single row.
    SELECT * INTO instruction_proposal
    FROM workspace_instruction_policy_onboarding_proposals proposal
    WHERE proposal.account_id = p_account_id AND proposal.workspace_id = p_workspace_id
      AND proposal.source_id = proposal_row.id::text
      AND proposal.source_version = proposal_row.content_hash
      AND proposal.status = 'proposed'
    ORDER BY proposal.baseline_activation_version DESC, proposal.created_at DESC, proposal.id DESC
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND OR instruction_proposal.draft_content_hash <> proposal_row.content_hash THEN
      RAISE EXCEPTION 'exact inactive instruction-policy proposal is unavailable'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO current_instruction_head FROM workspace_instruction_policy_heads head
    WHERE head.account_id = p_account_id AND head.workspace_id = p_workspace_id
      AND head.kind = instruction_proposal.kind AND head.scope = instruction_proposal.scope
      AND head.role_key IS NOT DISTINCT FROM instruction_proposal.role_key FOR SHARE;
    IF NOT FOUND THEN
      SELECT event.activation_version INTO current_instruction_activation_version
      FROM workspace_instruction_policy_deactivation_events event
      WHERE event.account_id = p_account_id AND event.workspace_id = p_workspace_id
        AND event.kind = instruction_proposal.kind AND event.scope = instruction_proposal.scope
        AND event.role_key IS NOT DISTINCT FROM instruction_proposal.role_key
      ORDER BY event.activation_version DESC, event.id DESC
      LIMIT 1;
    END IF;
    current_instruction_activation_version := coalesce(
      current_instruction_head.activation_version,
      current_instruction_activation_version,
      0
    );
    -- Prefer the successor bound to the live head. The ordering above already
    -- puts the newest baseline first, so this only re-selects when an older
    -- proposal is the matching one.
    IF current_instruction_head.revision_id IS DISTINCT FROM instruction_proposal.baseline_revision_id
      OR current_instruction_activation_version
        IS DISTINCT FROM instruction_proposal.baseline_activation_version
    THEN
      SELECT * INTO instruction_proposal
      FROM workspace_instruction_policy_onboarding_proposals proposal
      WHERE proposal.account_id = p_account_id AND proposal.workspace_id = p_workspace_id
        AND proposal.source_id = proposal_row.id::text
        AND proposal.source_version = proposal_row.content_hash
        AND proposal.status = 'proposed'
        AND proposal.baseline_revision_id IS NOT DISTINCT FROM current_instruction_head.revision_id
        AND proposal.baseline_activation_version = current_instruction_activation_version
      FOR SHARE;
      IF NOT FOUND OR instruction_proposal.draft_content_hash <> proposal_row.content_hash THEN
        RAISE EXCEPTION 'instruction-policy proposal baseline is stale' USING ERRCODE = '40001';
      END IF;
    END IF;
    destination_value := 'instruction_policy';
    destination_proposal_id_value := instruction_proposal.id;
    destination_revision_id_value := instruction_proposal.draft_revision_id;
    destination_old_revision_id_value := instruction_proposal.baseline_revision_id;
    destination_old_content_hash_value := instruction_proposal.baseline_content_hash;
    destination_old_version_value := instruction_proposal.baseline_activation_version;
    destination_new_content_hash_value := instruction_proposal.draft_content_hash;
  ELSIF proposal_row.target_kind = 'preference' THEN
    SELECT * INTO preference_receipt FROM company_brain_preference_proposal_receipts receipt
    WHERE receipt.account_id = p_account_id AND receipt.workspace_id = p_workspace_id
      AND receipt.knowledge_proposal_id = proposal_row.id FOR SHARE;
    SELECT * INTO preference_row FROM preference_registry_preferences preference
    WHERE preference.account_id = p_account_id AND preference.id = preference_receipt.preference_id
      AND preference.scope = 'workspace' AND preference.scope_workspace_id = p_workspace_id
      AND preference.scope_subject_id IS NULL AND preference.status = 'proposed'
      AND preference.active_revision_id IS NULL AND preference.activation_version = 0
      AND preference.scope_version = 1 FOR SHARE;
    SELECT * INTO preference_revision FROM preference_registry_revisions revision
    WHERE revision.account_id = p_account_id AND revision.id = preference_receipt.revision_id
      AND revision.preference_id = preference_receipt.preference_id
      AND revision.provenance_source = 'knowledge_proposal'
      AND revision.provenance_source_id = proposal_row.id::text
      AND revision.trust = 'untrusted_proposal'
      AND (revision.expires_at IS NULL OR revision.expires_at > transaction_timestamp())
    FOR SHARE;
    IF preference_receipt.id IS NULL OR preference_row.id IS NULL OR preference_revision.id IS NULL
      OR proposal_row.target_scope <> 'workspace'
      OR proposal_row.target_key <> preference_row.stable_key
    THEN
      RAISE EXCEPTION 'exact inactive preference proposal is unavailable'
        USING ERRCODE = '42501';
    END IF;
    destination_value := 'preference';
    destination_proposal_id_value := preference_row.id;
    destination_revision_id_value := preference_revision.id;
    destination_old_revision_id_value := NULL;
    destination_old_content_hash_value := NULL;
    destination_old_version_value := 0;
    destination_new_content_hash_value := preference_revision.content_hash;
  ELSE
    RAISE EXCEPTION 'unsupported governed-learning destination' USING ERRCODE = '23514';
  END IF;

  service_actor := 'service:governed-learning-activation:' || input_hash_value;
  review_operation_id := opengeni_private.governed_learning_derived_uuid(
    p_operation_id, 'knowledge-approve'
  );
  destination_operation_id := opengeni_private.governed_learning_derived_uuid(
    p_operation_id, 'destination-activate'
  );
  SELECT * INTO approval_row FROM governed_learning_apply_knowledge_review(
    p_account_id, p_workspace_id, review_operation_id, decision_row.claim_id,
    review_row.id, review_row.review_revision, 'approved', service_actor, caller_subject_id,
    'Approved by the exact initiating human through human-confirmed learning activation.'
  );
  IF destination_value = 'instruction_policy' THEN
    SELECT * INTO instruction_event FROM governed_learning_apply_instruction_policy(
      'activate', p_account_id, p_workspace_id, destination_operation_id,
      destination_proposal_id_value, destination_old_revision_id_value,
      destination_old_version_value, destination_revision_id_value, service_actor
    );
    destination_new_version_value := instruction_event.activation_version;
    destination_event_id_value := instruction_event.id;
    effective_at_value := instruction_event.created_at;
  ELSE
    SELECT * INTO preference_event FROM governed_learning_apply_preference(
      'activate', p_account_id, p_workspace_id, destination_operation_id,
      proposal_row.id, destination_proposal_id_value, destination_revision_id_value,
      NULL, 0, service_actor
    );
    SELECT activation_version INTO destination_new_version_value
    FROM preference_registry_preferences WHERE id = destination_proposal_id_value;
    destination_event_id_value := preference_event.id;
    effective_at_value := preference_event.created_at;
  END IF;

  INSERT INTO governed_learning_activation_receipts (
    account_id, workspace_id, operation_id, input_hash, decision_receipt_id,
    initiating_human_subject_id, service_actor_subject_id, policy_revision_id,
    policy_hash, policy_activation_version, source_kind, source_id,
    source_authority_hash, proposal_id, claim_id, evidence_id,
    knowledge_previous_review_id, knowledge_previous_review_revision,
    knowledge_approval_review_id, knowledge_approval_review_revision,
    knowledge_approval_input_hash, destination, destination_proposal_id,
    destination_revision_id, destination_old_revision_id,
    destination_old_content_hash, destination_old_version,
    destination_new_content_hash, destination_new_version, destination_event_id,
    effective_at, authority_kind, human_input_request_id
  ) VALUES (
    p_account_id, p_workspace_id, p_operation_id, input_hash_value,
    p_decision_receipt_id, caller_subject_id, service_actor, policy_revision.id,
    policy_revision.policy_hash, policy_head.activation_version,
    decision_row.source_kind, decision_row.source_id, current_authority_hash,
    decision_row.proposal_id, decision_row.claim_id, decision_row.evidence_id,
    review_row.id, review_row.review_revision, approval_row.id,
    approval_row.review_revision, approval_row.input_hash, destination_value,
    destination_proposal_id_value, destination_revision_id_value,
    destination_old_revision_id_value, destination_old_content_hash_value,
    destination_old_version_value, destination_new_content_hash_value,
    destination_new_version_value, destination_event_id_value, effective_at_value,
    'human_confirmed', p_human_input_request_id
  ) RETURNING * INTO result_row;
  RETURN NEXT result_row;
END;
$$;

DO $confirm_rebaseline_hardening$
DECLARE
  target_schema text := current_schema();
BEGIN
  -- CREATE OR REPLACE drops proconfig; re-apply the pin 0272/0284 established.
  EXECUTE format(
    'ALTER FUNCTION %I.activate_human_confirmed_learning_decision(uuid,uuid,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
END
$confirm_rebaseline_hardening$;

RESET statement_timeout;
RESET lock_timeout;
