-- deployment-mode: rolling
-- Migration 0268: deterministic, inert governed-learning evaluation.
--
-- This leaf authority consumes one exact accepted learning-policy snapshot and
-- one exact workspace-scoped Knowledge proposal/evidence lineage. It records
-- only IDs, hashes, versions, bounded enums, counts, and timestamps. It never
-- copies source/proposal content, calls a destination writer, or activates a
-- policy, preference, Memory record, instruction, or Knowledge head.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.governed_learning_reason_codes_valid(value text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  canonical constant text[] := ARRAY[
    'policy_off', 'evidence_revoked', 'proposal_stale', 'evidence_conflict',
    'confidence_below_floor', 'policy_suggest', 'policy_automatic'
  ]::text[];
  expected text[] := ARRAY[]::text[];
  candidate text;
BEGIN
  IF value IS NULL OR pg_catalog.cardinality(value) NOT BETWEEN 1 AND 7 THEN
    RETURN false;
  END IF;
  FOREACH candidate IN ARRAY canonical LOOP
    IF candidate = ANY(value) THEN
      expected := pg_catalog.array_append(expected, candidate);
    END IF;
  END LOOP;
  RETURN expected = value;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.governed_learning_reason_codes_valid(text[])
  FROM PUBLIC;

CREATE TABLE "governed_learning_decision_receipts" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "policy_snapshot_id" uuid NOT NULL,
  "policy_snapshot_hash" text NOT NULL,
  "policy_revision_id" uuid,
  "policy_activation_version" bigint NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL,
  "proposal_input_hash" text NOT NULL,
  "proposal_content_hash" text NOT NULL,
  "claim_id" uuid NOT NULL,
  "claim_input_hash" text NOT NULL,
  "evidence_id" uuid NOT NULL,
  "evidence_input_hash" text NOT NULL,
  "evidence_content_hash" text NOT NULL,
  "evidence_authority_hash" text NOT NULL,
  "review_revision" bigint NOT NULL,
  "review_state" text NOT NULL,
  "effective_mode" text NOT NULL,
  "confidence_bps" integer NOT NULL,
  "conflict_count" integer NOT NULL,
  "outcome" text NOT NULL,
  "reason_codes" text[] NOT NULL,
  "automatic_eligible" boolean NOT NULL,
  "confidence_floor_bps" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT "governed_learning_decision_receipts_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_snapshot_fk"
    FOREIGN KEY ("policy_snapshot_id")
    REFERENCES "workspace_learning_policy_snapshots" ("id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_proposal_fk"
    FOREIGN KEY ("proposal_id")
    REFERENCES "knowledge_change_proposals" ("id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_claim_fk"
    FOREIGN KEY ("claim_id")
    REFERENCES "knowledge_claims" ("id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_evidence_fk"
    FOREIGN KEY ("evidence_id")
    REFERENCES "knowledge_claim_evidence" ("id") ON DELETE CASCADE,
  CONSTRAINT "governed_learning_decision_receipts_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "governed_learning_decision_receipts_snapshot_proposal_uq"
    UNIQUE ("policy_snapshot_id", "proposal_id"),
  CONSTRAINT "governed_learning_decision_receipts_identity_chk" CHECK (
    "execution_generation" > 0
    AND pg_catalog.length(pg_catalog.btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    AND pg_catalog.octet_length(
      pg_catalog.convert_to("initiating_human_subject_id", 'UTF8')
    ) <= 4096
    AND "policy_activation_version" >= 0
    AND "review_revision" > 0
  ),
  CONSTRAINT "governed_learning_decision_receipts_hashes_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "policy_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "proposal_input_hash" ~ '^[0-9a-f]{64}$'
    AND "proposal_content_hash" ~ '^[0-9a-f]{64}$'
    AND "claim_input_hash" ~ '^[0-9a-f]{64}$'
    AND "evidence_input_hash" ~ '^[0-9a-f]{64}$'
    AND "evidence_content_hash" ~ '^[0-9a-f]{64}$'
    AND "evidence_authority_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "governed_learning_decision_receipts_source_chk" CHECK (
    "source_kind" IN ('scoped-knowledge-evidence', 'task-note')
    AND ("source_kind" <> 'scoped-knowledge-evidence' OR "source_id" = "evidence_id")
  ),
  CONSTRAINT "governed_learning_decision_receipts_facts_chk" CHECK (
    "review_state" IN ('proposed', 'approved', 'rejected', 'revoked')
    AND "effective_mode" IN ('off', 'suggest', 'automatic')
    AND "confidence_bps" BETWEEN 0 AND 10000
    AND "conflict_count" BETWEEN 0 AND 1000
    AND "confidence_floor_bps" = 8500
  ),
  CONSTRAINT "governed_learning_decision_receipts_decision_chk" CHECK (
    "outcome" IN ('off','suggest','automatic','confidence','conflict','stale','revoked')
    AND opengeni_private.governed_learning_reason_codes_valid("reason_codes")
    AND "automatic_eligible" = ("outcome" = 'automatic')
  )
);

CREATE INDEX "governed_learning_decision_receipts_workspace_time_idx"
  ON "governed_learning_decision_receipts" ("workspace_id", "created_at" DESC, "id" DESC);

ALTER TABLE "governed_learning_decision_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governed_learning_decision_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY governed_learning_decision_receipts_tenant
  ON "governed_learning_decision_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation
  ON "governed_learning_decision_receipts" AS RESTRICTIVE
  USING (session_reference_visible("account_id", "workspace_id", "session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "session_id"));

CREATE OR REPLACE FUNCTION reject_governed_learning_decision_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_catalog.pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (
        SELECT 1 FROM sessions
        WHERE workspace_id = OLD.workspace_id AND id = OLD.session_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM session_turns
        WHERE workspace_id = OLD.workspace_id AND id = OLD.turn_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM session_turn_attempts
        WHERE workspace_id = OLD.workspace_id AND id = OLD.attempt_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM workspace_learning_policy_snapshots WHERE id = OLD.policy_snapshot_id
      )
      OR NOT EXISTS (SELECT 1 FROM knowledge_change_proposals WHERE id = OLD.proposal_id)
      OR NOT EXISTS (SELECT 1 FROM knowledge_claims WHERE id = OLD.claim_id)
      OR NOT EXISTS (SELECT 1 FROM knowledge_claim_evidence WHERE id = OLD.evidence_id)
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Governed-learning decision receipts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER governed_learning_decision_receipts_immutable
  BEFORE UPDATE OR DELETE ON "governed_learning_decision_receipts"
  FOR EACH ROW EXECUTE FUNCTION reject_governed_learning_decision_receipt_mutation();

CREATE OR REPLACE FUNCTION evaluate_governed_learning_proposal(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_policy_snapshot_id uuid,
  p_proposal_id uuid,
  p_claim_id uuid,
  p_evidence_id uuid
) RETURNS TABLE (
  receipt_id uuid,
  operation_id uuid,
  input_hash text,
  account_id uuid,
  workspace_id uuid,
  session_id uuid,
  turn_id uuid,
  attempt_id uuid,
  execution_generation integer,
  initiating_human_subject_id text,
  policy_snapshot_id uuid,
  policy_snapshot_hash text,
  policy_revision_id uuid,
  policy_activation_version bigint,
  source_kind text,
  source_id uuid,
  proposal_id uuid,
  proposal_input_hash text,
  proposal_content_hash text,
  claim_id uuid,
  claim_input_hash text,
  evidence_id uuid,
  evidence_input_hash text,
  evidence_content_hash text,
  evidence_authority_hash text,
  review_revision bigint,
  review_state text,
  effective_mode text,
  confidence_bps integer,
  conflict_count integer,
  outcome text,
  reason_codes text[],
  automatic_eligible boolean,
  confidence_floor_bps integer,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  caller_subject_id text := nullif(
    pg_catalog.current_setting('opengeni.subject_id', true), ''
  );
  calculated_input_hash text;
  turn_row session_turns%ROWTYPE;
  snapshot_row workspace_learning_policy_snapshots%ROWTYPE;
  proposal_row knowledge_change_proposals%ROWTYPE;
  claim_row knowledge_claims%ROWTYPE;
  evidence_row knowledge_claim_evidence%ROWTYPE;
  review_row knowledge_claim_reviews%ROWTYPE;
  receipt_row governed_learning_decision_receipts%ROWTYPE;
  document_authority record;
  task_note_row task_notes%ROWTYPE;
  source_kind_value text;
  source_id_value uuid;
  effective_mode_value text;
  authority_hash_value text;
  conflict_count_value integer;
  revoked_value boolean := false;
  stale_value boolean := false;
  outcome_value text;
  reason_codes_value text[] := ARRAY[]::text[];
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_turn_id IS NULL OR p_attempt_id IS NULL OR p_operation_id IS NULL
    OR p_policy_snapshot_id IS NULL OR p_proposal_id IS NULL
    OR p_claim_id IS NULL OR p_evidence_id IS NULL
    OR p_execution_generation IS NULL OR p_execution_generation <= 0
    OR caller_subject_id IS NULL
    OR pg_catalog.length(pg_catalog.btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR pg_catalog.octet_length(pg_catalog.convert_to(caller_subject_id, 'UTF8')) > 4096
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'governed-learning evaluation requires exact bounded tenant authority'
      USING ERRCODE = '42501';
  END IF;

  calculated_input_hash := pg_catalog.encode(sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      'governed-learning-evaluation', 1, p_account_id, p_workspace_id,
      p_session_id, p_turn_id, p_attempt_id, p_execution_generation,
      p_operation_id, p_policy_snapshot_id, p_proposal_id, p_claim_id, p_evidence_id
    )::text,
    'UTF8'
  )), 'hex');

  -- An exact replay remains immutable evidence even after the source changes.
  -- Any later activation controller must perform its own current authorization
  -- recheck; this inert evaluator grants no reusable write capability.
  SELECT receipt.* INTO receipt_row
  FROM governed_learning_decision_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF receipt_row.account_id <> p_account_id
      OR receipt_row.input_hash <> calculated_input_hash
      OR receipt_row.session_id <> p_session_id
      OR receipt_row.turn_id <> p_turn_id
      OR receipt_row.attempt_id <> p_attempt_id
      OR receipt_row.execution_generation <> p_execution_generation
      OR receipt_row.policy_snapshot_id <> p_policy_snapshot_id
      OR receipt_row.proposal_id <> p_proposal_id
      OR receipt_row.claim_id <> p_claim_id
      OR receipt_row.evidence_id <> p_evidence_id
    THEN
      RAISE EXCEPTION 'governed-learning operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    IF receipt_row.initiating_human_subject_id <> caller_subject_id
      OR NOT session_reference_visible(
        receipt_row.account_id, receipt_row.workspace_id, receipt_row.session_id
      )
    THEN
      RAISE EXCEPTION 'governed-learning receipt is unavailable'
        USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT
      receipt_row.id, receipt_row.operation_id, receipt_row.input_hash,
      receipt_row.account_id, receipt_row.workspace_id, receipt_row.session_id,
      receipt_row.turn_id, receipt_row.attempt_id, receipt_row.execution_generation,
      receipt_row.initiating_human_subject_id, receipt_row.policy_snapshot_id,
      receipt_row.policy_snapshot_hash, receipt_row.policy_revision_id,
      receipt_row.policy_activation_version, receipt_row.source_kind,
      receipt_row.source_id, receipt_row.proposal_id, receipt_row.proposal_input_hash,
      receipt_row.proposal_content_hash, receipt_row.claim_id,
      receipt_row.claim_input_hash, receipt_row.evidence_id,
      receipt_row.evidence_input_hash, receipt_row.evidence_content_hash,
      receipt_row.evidence_authority_hash, receipt_row.review_revision,
      receipt_row.review_state, receipt_row.effective_mode,
      receipt_row.confidence_bps, receipt_row.conflict_count,
      receipt_row.outcome, receipt_row.reason_codes, receipt_row.automatic_eligible,
      receipt_row.confidence_floor_bps, receipt_row.created_at;
    RETURN;
  END IF;

  -- Canonical mutation/read lock prefix: workspace, session, turn, attempt.
  PERFORM 1
  FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning workspace is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id
    AND session.active_turn_id = p_turn_id
    AND session_reference_visible(session.account_id, session.workspace_id, session.id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning session is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT turn.* INTO turn_row
  FROM session_turns turn
  WHERE turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.id = p_turn_id
    AND turn.active_attempt_id = p_attempt_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND coalesce(
      turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ) = caller_subject_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning turn authority is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM session_turn_attempts attempt
  WHERE attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = p_session_id
    AND attempt.turn_id = p_turn_id
    AND attempt.id = p_attempt_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace_id
        AND interruption.attempt_id = p_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning attempt authority is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT snapshot.* INTO snapshot_row
  FROM workspace_learning_policy_snapshots snapshot
  WHERE snapshot.id = p_policy_snapshot_id
    AND snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.attempt_id = p_attempt_id
    AND snapshot.execution_generation = p_execution_generation
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning requires the exact accepted policy snapshot'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize all evaluations of the same accepted snapshot/proposal pair.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.concat('governed-learning:', p_policy_snapshot_id, ':', p_proposal_id),
    0::bigint
  ));

  SELECT receipt.* INTO receipt_row
  FROM governed_learning_decision_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND (
      receipt.operation_id = p_operation_id
      OR (
        receipt.policy_snapshot_id = p_policy_snapshot_id
        AND receipt.proposal_id = p_proposal_id
      )
    )
  FOR SHARE;
  IF FOUND THEN
    IF receipt_row.operation_id <> p_operation_id
      OR receipt_row.input_hash <> calculated_input_hash
      OR receipt_row.initiating_human_subject_id <> caller_subject_id
    THEN
      RAISE EXCEPTION 'governed-learning proposal was already evaluated under another operation'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT
      receipt_row.id, receipt_row.operation_id, receipt_row.input_hash,
      receipt_row.account_id, receipt_row.workspace_id, receipt_row.session_id,
      receipt_row.turn_id, receipt_row.attempt_id, receipt_row.execution_generation,
      receipt_row.initiating_human_subject_id, receipt_row.policy_snapshot_id,
      receipt_row.policy_snapshot_hash, receipt_row.policy_revision_id,
      receipt_row.policy_activation_version, receipt_row.source_kind,
      receipt_row.source_id, receipt_row.proposal_id, receipt_row.proposal_input_hash,
      receipt_row.proposal_content_hash, receipt_row.claim_id,
      receipt_row.claim_input_hash, receipt_row.evidence_id,
      receipt_row.evidence_input_hash, receipt_row.evidence_content_hash,
      receipt_row.evidence_authority_hash, receipt_row.review_revision,
      receipt_row.review_state, receipt_row.effective_mode,
      receipt_row.confidence_bps, receipt_row.conflict_count,
      receipt_row.outcome, receipt_row.reason_codes, receipt_row.automatic_eligible,
      receipt_row.confidence_floor_bps, receipt_row.created_at;
    RETURN;
  END IF;

  SELECT proposal.* INTO proposal_row
  FROM knowledge_change_proposals proposal
  WHERE proposal.id = p_proposal_id
    AND proposal.account_id = p_account_id
    AND proposal.scope_kind = 'workspace'
    AND proposal.scope_workspace_id = p_workspace_id
    AND proposal.scope_subject_id IS NULL
    AND proposal.claim_id = p_claim_id
    AND proposal.evidence_id = p_evidence_id
    AND proposal.initiating_human_subject_id = caller_subject_id
  FOR SHARE;
  SELECT claim.* INTO claim_row
  FROM knowledge_claims claim
  WHERE claim.id = p_claim_id
    AND claim.account_id = p_account_id
    AND claim.scope_kind = 'workspace'
    AND claim.scope_workspace_id = p_workspace_id
    AND claim.scope_subject_id IS NULL
    AND claim.initiating_human_subject_id = caller_subject_id
  -- Serialize review, contradictory-evidence, and relation admission through
  -- their referenced claim so the later current-state reads form one exact
  -- evaluation point rather than racing a newly inserted lifecycle row.
  FOR UPDATE;
  SELECT evidence.* INTO evidence_row
  FROM knowledge_claim_evidence evidence
  WHERE evidence.id = p_evidence_id
    AND evidence.account_id = p_account_id
    AND evidence.scope_kind = 'workspace'
    AND evidence.scope_workspace_id = p_workspace_id
    AND evidence.scope_subject_id IS NULL
    AND evidence.claim_id = p_claim_id
    AND evidence.polarity = 'supports'
    AND evidence.initiating_human_subject_id = caller_subject_id
  FOR SHARE;
  IF proposal_row.id IS NULL OR claim_row.id IS NULL OR evidence_row.id IS NULL THEN
    RAISE EXCEPTION 'governed-learning proposal lineage is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT review.* INTO review_row
  FROM knowledge_claim_reviews review
  WHERE review.account_id = p_account_id AND review.claim_id = p_claim_id
  ORDER BY review.review_revision DESC
  LIMIT 1
  FOR SHARE;
  IF review_row.id IS NULL THEN
    RAISE EXCEPTION 'governed-learning proposal has no review lifecycle'
      USING ERRCODE = '23514';
  END IF;

  IF evidence_row.task_note_id IS NOT NULL THEN
    source_kind_value := 'task-note';
    source_id_value := evidence_row.task_note_id;
    SELECT note.* INTO task_note_row
    FROM task_notes note
    WHERE note.id = evidence_row.task_note_id
      AND note.account_id = p_account_id
      AND note.workspace_id = p_workspace_id
      AND note.root_session_id = evidence_row.task_note_root_session_id
      AND note.version = evidence_row.task_note_version
      AND note.text_hash = evidence_row.content_hash
      AND session_reference_visible(note.account_id, note.workspace_id, note.root_session_id)
    FOR SHARE;
    revoked_value := task_note_row.id IS NULL
      OR task_note_row.status <> 'active'
      OR task_note_row.expires_at <= pg_catalog.transaction_timestamp();
    authority_hash_value := pg_catalog.encode(sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'task-note-authority', 1, evidence_row.task_note_id,
        evidence_row.task_note_root_session_id, evidence_row.task_note_version,
        evidence_row.content_hash, coalesce(task_note_row.status, 'unavailable'),
        task_note_row.expires_at
      )::text,
      'UTF8'
    )), 'hex');
  ELSE
    source_kind_value := 'scoped-knowledge-evidence';
    source_id_value := evidence_row.id;
    SELECT
      provider.id AS provider_id,
      provider.lifecycle_state AS provider_state,
      provider.lifecycle_generation AS provider_generation,
      source.id AS source_id,
      source.lifecycle_state AS source_state,
      source.lifecycle_generation AS source_generation,
      source.current_acl_generation,
      object.id AS object_id,
      object.lifecycle_state AS object_state,
      object.lifecycle_generation AS object_generation,
      object.version_generation AS object_version_generation,
      object.current_version_id,
      version.id AS version_id,
      version.version_generation,
      version.content_sha256,
      version.acl_version_id,
      version.acl_generation,
      version.document_id,
      evidence_acl.acl_hash AS evidence_acl_hash,
      evidence_acl.agent_access AS evidence_agent_access,
      current_acl.id AS current_acl_id,
      current_acl.acl_hash AS current_acl_hash,
      current_acl.agent_access AS current_agent_access
    INTO document_authority
    FROM knowledge_document_versions version
    JOIN knowledge_source_objects object
      ON object.account_id = version.account_id
      AND object.id = version.object_id
      AND object.scope_key = version.scope_key
    JOIN knowledge_sources source
      ON source.account_id = version.account_id
      AND source.id = version.source_id
      AND source.scope_key = version.scope_key
    JOIN knowledge_providers provider
      ON provider.account_id = source.account_id
      AND provider.id = source.provider_id
      AND provider.scope_key = source.scope_key
    JOIN knowledge_source_acl_versions evidence_acl
      ON evidence_acl.account_id = version.account_id
      AND evidence_acl.id = version.acl_version_id
      AND evidence_acl.source_id = version.source_id
      AND evidence_acl.generation = version.acl_generation
    LEFT JOIN knowledge_source_acl_versions current_acl
      ON current_acl.account_id = source.account_id
      AND current_acl.source_id = source.id
      AND current_acl.generation = source.current_acl_generation
    WHERE version.id = evidence_row.document_version_id
      AND version.account_id = p_account_id
      AND version.scope_kind = 'workspace'
      AND version.scope_workspace_id = p_workspace_id
      AND version.scope_subject_id IS NULL
    FOR SHARE OF version, object, source, provider, evidence_acl;

    revoked_value := document_authority.version_id IS NULL
      OR document_authority.provider_state IS DISTINCT FROM 'active'
      OR document_authority.source_state IS DISTINCT FROM 'active'
      OR document_authority.object_state IS DISTINCT FROM 'active'
      OR document_authority.current_version_id IS DISTINCT FROM document_authority.version_id
      OR document_authority.object_version_generation IS DISTINCT FROM
        document_authority.version_generation
      OR document_authority.current_acl_id IS NULL
      OR NOT coalesce(document_authority.evidence_agent_access, false)
      OR NOT coalesce(document_authority.current_agent_access, false)
      OR (
        document_authority.document_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM documents document
          WHERE document.id = document_authority.document_id
            AND document.account_id = p_account_id
            AND document.workspace_id = p_workspace_id
            AND document.status = 'ready'
            AND document.agent_access
            AND (
              document.visibility <> 'private'
              OR document.created_by = caller_subject_id
            )
        )
      )
      OR (
        evidence_row.document_chunk_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM document_chunks chunk
          WHERE chunk.id = evidence_row.document_chunk_id
            AND chunk.account_id = p_account_id
            AND chunk.workspace_id = p_workspace_id
            AND chunk.document_id = document_authority.document_id
        )
      );
    authority_hash_value := pg_catalog.encode(sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
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
        evidence_row.document_chunk_id, revoked_value
      )::text,
      'UTF8'
    )), 'hex');
  END IF;

  effective_mode_value := coalesce(
    (
      SELECT override.value->>'mode'
      FROM pg_catalog.jsonb_array_elements(snapshot_row.source_overrides) override(value)
      WHERE override.value->>'kind' = source_kind_value
        AND override.value->>'id' = source_id_value::text
      LIMIT 1
    ),
    snapshot_row.workspace_mode
  );

  SELECT least(1000, pg_catalog.count(*))::integer
  INTO conflict_count_value
  FROM (
    SELECT relation.id
    FROM knowledge_claim_relations relation
    WHERE relation.account_id = p_account_id
      AND relation.scope_kind = 'workspace'
      AND relation.scope_workspace_id = p_workspace_id
      AND relation.scope_subject_id IS NULL
      AND relation.relation_type = 'conflicts_with'
      AND (relation.from_claim_id = p_claim_id OR relation.to_claim_id = p_claim_id)
    UNION ALL
    SELECT contradiction.id
    FROM knowledge_claim_evidence contradiction
    WHERE contradiction.account_id = p_account_id
      AND contradiction.scope_kind = 'workspace'
      AND contradiction.scope_workspace_id = p_workspace_id
      AND contradiction.scope_subject_id IS NULL
      AND contradiction.claim_id = p_claim_id
      AND contradiction.polarity = 'contradicts'
  ) conflicts;

  revoked_value := revoked_value OR review_row.state = 'revoked';
  stale_value := proposal_row.status <> 'proposed'
    OR claim_row.effective_at > pg_catalog.transaction_timestamp()
    OR (
      claim_row.expires_at IS NOT NULL
      AND claim_row.expires_at <= pg_catalog.transaction_timestamp()
    )
    OR review_row.state IN ('approved', 'rejected');

  IF effective_mode_value = 'off' THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'policy_off');
  END IF;
  IF revoked_value THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'evidence_revoked');
  END IF;
  IF stale_value THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'proposal_stale');
  END IF;
  IF conflict_count_value > 0 THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'evidence_conflict');
  END IF;
  IF claim_row.confidence_bps < 8500 THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'confidence_below_floor');
  END IF;
  IF effective_mode_value = 'suggest' THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'policy_suggest');
  END IF;
  IF effective_mode_value = 'automatic' THEN
    reason_codes_value := pg_catalog.array_append(reason_codes_value, 'policy_automatic');
  END IF;

  outcome_value := CASE
    WHEN effective_mode_value = 'off' THEN 'off'
    WHEN revoked_value THEN 'revoked'
    WHEN stale_value THEN 'stale'
    WHEN conflict_count_value > 0 THEN 'conflict'
    WHEN claim_row.confidence_bps < 8500 THEN 'confidence'
    ELSE effective_mode_value
  END;

  INSERT INTO governed_learning_decision_receipts (
    account_id, workspace_id, operation_id, input_hash,
    session_id, turn_id, attempt_id, execution_generation,
    initiating_human_subject_id, policy_snapshot_id, policy_snapshot_hash,
    policy_revision_id, policy_activation_version, source_kind, source_id,
    proposal_id, proposal_input_hash, proposal_content_hash,
    claim_id, claim_input_hash, evidence_id, evidence_input_hash,
    evidence_content_hash, evidence_authority_hash, review_revision, review_state,
    effective_mode, confidence_bps, conflict_count, outcome, reason_codes,
    automatic_eligible, confidence_floor_bps
  ) VALUES (
    p_account_id, p_workspace_id, p_operation_id, calculated_input_hash,
    p_session_id, p_turn_id, p_attempt_id, p_execution_generation,
    caller_subject_id, p_policy_snapshot_id, snapshot_row.snapshot_hash,
    snapshot_row.revision_id, snapshot_row.activation_version, source_kind_value,
    source_id_value, p_proposal_id, proposal_row.input_hash,
    proposal_row.content_hash, p_claim_id, claim_row.input_hash, p_evidence_id,
    evidence_row.input_hash, evidence_row.content_hash, authority_hash_value,
    review_row.review_revision, review_row.state, effective_mode_value,
    claim_row.confidence_bps, conflict_count_value, outcome_value,
    reason_codes_value, outcome_value = 'automatic', 8500
  ) RETURNING * INTO receipt_row;

  RETURN QUERY SELECT
    receipt_row.id, receipt_row.operation_id, receipt_row.input_hash,
    receipt_row.account_id, receipt_row.workspace_id, receipt_row.session_id,
    receipt_row.turn_id, receipt_row.attempt_id, receipt_row.execution_generation,
    receipt_row.initiating_human_subject_id, receipt_row.policy_snapshot_id,
    receipt_row.policy_snapshot_hash, receipt_row.policy_revision_id,
    receipt_row.policy_activation_version, receipt_row.source_kind,
    receipt_row.source_id, receipt_row.proposal_id, receipt_row.proposal_input_hash,
    receipt_row.proposal_content_hash, receipt_row.claim_id,
    receipt_row.claim_input_hash, receipt_row.evidence_id,
    receipt_row.evidence_input_hash, receipt_row.evidence_content_hash,
    receipt_row.evidence_authority_hash, receipt_row.review_revision,
    receipt_row.review_state, receipt_row.effective_mode,
    receipt_row.confidence_bps, receipt_row.conflict_count,
    receipt_row.outcome, receipt_row.reason_codes, receipt_row.automatic_eligible,
    receipt_row.confidence_floor_bps, receipt_row.created_at;
END;
$$;

REVOKE ALL ON TABLE "governed_learning_decision_receipts" FROM PUBLIC;
REVOKE ALL ON FUNCTION evaluate_governed_learning_proposal(
  uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,uuid
) FROM PUBLIC;

DO $governed_learning_authority$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  IF pg_catalog.to_regclass(
      pg_catalog.format('%I.workspace_learning_policy_snapshots', data_schema)
    ) IS NULL
    OR pg_catalog.to_regclass(
      pg_catalog.format('%I.knowledge_change_proposals', data_schema)
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      pg_catalog.format('%I.session_reference_visible(uuid,uuid,uuid)', data_schema)
    ) IS NULL
  THEN
    RAISE EXCEPTION 'governed-learning evaluator predecessor authority is incomplete'
      USING ERRCODE = '42P01';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.reject_governed_learning_decision_receipt_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.evaluate_governed_learning_proposal('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.evaluate_governed_learning_proposal('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC',
    data_schema
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE %I.governed_learning_decision_receipts FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.governed_learning_decision_receipts FROM opengeni_app',
      data_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.evaluate_governed_learning_proposal('
        || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$governed_learning_authority$;
