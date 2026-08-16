-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Consume one final governed-learning automatic verdict without turning that
-- inert receipt into a reusable grant. The controller revalidates every live
-- authority and calls only destination-owned service lifecycle functions.

CREATE TABLE "governed_learning_activation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "decision_receipt_id" uuid NOT NULL
    REFERENCES "governed_learning_decision_receipts"("id") ON DELETE RESTRICT,
  "initiating_human_subject_id" text NOT NULL,
  "service_actor_subject_id" text NOT NULL,
  "policy_revision_id" uuid NOT NULL
    REFERENCES "workspace_learning_policy_revisions"("id") ON DELETE RESTRICT,
  "policy_hash" text NOT NULL,
  "policy_activation_version" bigint NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_authority_hash" text NOT NULL,
  "proposal_id" uuid NOT NULL REFERENCES "knowledge_change_proposals"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL REFERENCES "knowledge_claims"("id") ON DELETE RESTRICT,
  "evidence_id" uuid NOT NULL REFERENCES "knowledge_claim_evidence"("id") ON DELETE RESTRICT,
  "knowledge_previous_review_id" uuid NOT NULL
    REFERENCES "knowledge_claim_reviews"("id") ON DELETE RESTRICT,
  "knowledge_previous_review_revision" bigint NOT NULL,
  "knowledge_approval_review_id" uuid NOT NULL
    REFERENCES "knowledge_claim_reviews"("id") ON DELETE RESTRICT,
  "knowledge_approval_review_revision" bigint NOT NULL,
  "knowledge_approval_input_hash" text NOT NULL,
  "destination" text NOT NULL,
  "destination_proposal_id" uuid NOT NULL,
  "destination_revision_id" uuid NOT NULL,
  "destination_old_revision_id" uuid,
  "destination_old_content_hash" text,
  "destination_old_version" bigint NOT NULL,
  "destination_new_content_hash" text NOT NULL,
  "destination_new_version" bigint NOT NULL,
  "destination_event_id" uuid NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT "governed_learning_activation_receipts_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "governed_learning_activation_receipts_decision_uq"
    UNIQUE ("decision_receipt_id"),
  CONSTRAINT "governed_learning_activation_receipts_identity_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    AND octet_length(convert_to("initiating_human_subject_id", 'UTF8')) <= 4096
    AND length(btrim("service_actor_subject_id")) BETWEEN 1 AND 1024
    AND "service_actor_subject_id" LIKE 'service:governed-learning-activation:%'
  ),
  CONSTRAINT "governed_learning_activation_receipts_hash_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "policy_hash" ~ '^[0-9a-f]{64}$'
    AND "source_authority_hash" ~ '^[0-9a-f]{64}$'
    AND "knowledge_approval_input_hash" ~ '^[0-9a-f]{64}$'
    AND "destination_new_content_hash" ~ '^[0-9a-f]{64}$'
    AND ("destination_old_content_hash" IS NULL
      OR "destination_old_content_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "governed_learning_activation_receipts_boundary_chk" CHECK (
    "policy_activation_version" > 0
    AND "source_kind" IN ('scoped-knowledge-evidence', 'task-note')
    AND "knowledge_previous_review_revision" > 0
    AND "knowledge_approval_review_revision" > "knowledge_previous_review_revision"
    AND "destination" IN ('instruction_policy', 'preference')
    AND "destination_old_version" >= 0
    AND "destination_new_version" > "destination_old_version"
    AND (("destination_old_revision_id" IS NULL AND "destination_old_content_hash" IS NULL)
      OR ("destination_old_revision_id" IS NOT NULL
        AND "destination_old_content_hash" IS NOT NULL))
  )
);

CREATE INDEX "governed_learning_activation_receipts_workspace_time_idx"
  ON "governed_learning_activation_receipts" ("workspace_id", "created_at" DESC, "id" DESC);

CREATE TABLE "governed_learning_activation_undo_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "activation_receipt_id" uuid NOT NULL
    REFERENCES "governed_learning_activation_receipts"("id") ON DELETE RESTRICT,
  "initiating_human_subject_id" text NOT NULL,
  "service_actor_subject_id" text NOT NULL,
  "destination" text NOT NULL,
  "knowledge_approval_review_id" uuid NOT NULL
    REFERENCES "knowledge_claim_reviews"("id") ON DELETE RESTRICT,
  "knowledge_revocation_review_id" uuid NOT NULL
    REFERENCES "knowledge_claim_reviews"("id") ON DELETE RESTRICT,
  "knowledge_revocation_review_revision" bigint NOT NULL,
  "knowledge_revocation_input_hash" text NOT NULL,
  "destination_activated_revision_id" uuid NOT NULL,
  "destination_restored_revision_id" uuid,
  "destination_activated_content_hash" text NOT NULL,
  "destination_restored_content_hash" text,
  "destination_old_version" bigint NOT NULL,
  "destination_new_version" bigint NOT NULL,
  "destination_event_id" uuid NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT "governed_learning_activation_undo_receipts_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "governed_learning_activation_undo_receipts_activation_uq"
    UNIQUE ("activation_receipt_id"),
  CONSTRAINT "governed_learning_activation_undo_receipts_identity_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("service_actor_subject_id")) BETWEEN 1 AND 1024
    AND "service_actor_subject_id" LIKE 'service:governed-learning-activation:%'
  ),
  CONSTRAINT "governed_learning_activation_undo_receipts_hash_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "knowledge_revocation_input_hash" ~ '^[0-9a-f]{64}$'
    AND "destination_activated_content_hash" ~ '^[0-9a-f]{64}$'
    AND ("destination_restored_content_hash" IS NULL
      OR "destination_restored_content_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "governed_learning_activation_undo_receipts_boundary_chk" CHECK (
    "destination" IN ('instruction_policy', 'preference')
    AND "knowledge_revocation_review_revision" > 0
    AND "destination_old_version" > 0
    AND "destination_new_version" > "destination_old_version"
    AND (("destination_restored_revision_id" IS NULL
      AND "destination_restored_content_hash" IS NULL)
      OR ("destination_restored_revision_id" IS NOT NULL
        AND "destination_restored_content_hash" IS NOT NULL))
  )
);

CREATE INDEX "governed_learning_activation_undo_receipts_workspace_time_idx"
  ON "governed_learning_activation_undo_receipts" ("workspace_id", "created_at" DESC, "id" DESC);

ALTER TABLE "governed_learning_activation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governed_learning_activation_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "governed_learning_activation_undo_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governed_learning_activation_undo_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY governed_learning_activation_receipts_tenant
  ON "governed_learning_activation_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY governed_learning_activation_receipts_subject
  ON "governed_learning_activation_receipts" AS RESTRICTIVE
  USING ("initiating_human_subject_id" = nullif(current_setting('opengeni.subject_id', true), ''))
  WITH CHECK ("initiating_human_subject_id" = nullif(current_setting('opengeni.subject_id', true), ''));
CREATE POLICY governed_learning_activation_undo_receipts_tenant
  ON "governed_learning_activation_undo_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY governed_learning_activation_undo_receipts_subject
  ON "governed_learning_activation_undo_receipts" AS RESTRICTIVE
  USING ("initiating_human_subject_id" = nullif(current_setting('opengeni.subject_id', true), ''))
  WITH CHECK ("initiating_human_subject_id" = nullif(current_setting('opengeni.subject_id', true), ''));

CREATE OR REPLACE FUNCTION governed_learning_reject_activation_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (
    NOT EXISTS (SELECT 1 FROM managed_accounts WHERE id = OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'governed-learning activation receipts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER governed_learning_activation_receipts_immutable
  BEFORE UPDATE OR DELETE ON "governed_learning_activation_receipts"
  FOR EACH ROW EXECUTE FUNCTION governed_learning_reject_activation_receipt_mutation();
CREATE TRIGGER governed_learning_activation_undo_receipts_immutable
  BEFORE UPDATE OR DELETE ON "governed_learning_activation_undo_receipts"
  FOR EACH ROW EXECUTE FUNCTION governed_learning_reject_activation_receipt_mutation();

CREATE OR REPLACE FUNCTION opengeni_private.governed_learning_derived_uuid(
  p_operation_id uuid,
  p_label text
) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (
    substr(value, 1, 8) || '-' || substr(value, 9, 4) || '-5' || substr(value, 14, 3)
    || '-' || substr('89ab', 1 + (get_byte(decode(substr(value, 17, 2), 'hex'), 0) & 3), 1)
    || substr(value, 18, 3) || '-' || substr(value, 21, 12)
  )::uuid
  FROM (
    SELECT encode(sha256(convert_to(
      concat('governed-learning-activation:v1:', p_operation_id, ':', p_label), 'UTF8'
    )), 'hex') AS value
  ) digest;
$$;
REVOKE ALL ON FUNCTION opengeni_private.governed_learning_derived_uuid(uuid, text) FROM PUBLIC;

-- Service approvals/revocations are admitted only through the private native
-- adapter below. Broadening the row check without this trigger would let any
-- service-shaped direct insert manufacture accepted Knowledge authority.
ALTER TABLE "knowledge_claim_reviews"
  DROP CONSTRAINT "knowledge_claim_reviews_review_chk";
ALTER TABLE "knowledge_claim_reviews"
  ADD CONSTRAINT "knowledge_claim_reviews_review_chk" CHECK (
    "state" IN ('proposed', 'approved', 'rejected', 'revoked')
    AND "review_revision" > 0
    AND length(btrim("reason")) BETWEEN 1 AND 4096
    AND (
      "state" = 'proposed'
      OR ("actor_kind" = 'human' AND "actor_subject_id" = "initiating_human_subject_id")
      OR (
        "actor_kind" = 'service'
        AND "actor_subject_id" LIKE 'service:governed-learning-activation:%'
        AND "initiating_human_subject_id" IS NOT NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION governed_learning_guard_service_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capability_writer boolean;
BEGIN
  SELECT current_user = pg_catalog.pg_get_userbyid(procedure_row.proowner)
  INTO capability_writer
  FROM pg_catalog.pg_proc procedure_row
  WHERE procedure_row.oid = pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.governed_learning_apply_knowledge_review(uuid,uuid,uuid,uuid,uuid,bigint,text,text,text)',
    TG_TABLE_SCHEMA
  ));
  IF NEW.state <> 'proposed' AND NEW.actor_kind = 'service' AND (
    NOT coalesce(capability_writer, false)
    OR current_setting('opengeni.governed_learning_review_operation', true)
      IS DISTINCT FROM NEW.operation_id
    OR current_setting('opengeni.governed_learning_review_claim', true)
      IS DISTINCT FROM NEW.claim_id::text
  ) THEN
    RAISE EXCEPTION 'service Knowledge review requires exact governed-learning capability'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_claim_reviews_05_governed_learning_guard
  BEFORE INSERT ON "knowledge_claim_reviews"
  FOR EACH ROW EXECUTE FUNCTION governed_learning_guard_service_review();

CREATE OR REPLACE FUNCTION governed_learning_apply_knowledge_review(
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_claim_id uuid,
  p_expected_review_id uuid,
  p_expected_review_revision bigint,
  p_state text,
  p_actor_subject_id text,
  p_initiating_human_subject_id text
) RETURNS SETOF knowledge_claim_reviews
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  claim_row knowledge_claims%ROWTYPE;
  current_review knowledge_claim_reviews%ROWTYPE;
  result_row knowledge_claim_reviews%ROWTYPE;
  input_hash_value text;
BEGIN
  IF p_state NOT IN ('approved', 'revoked')
    OR p_actor_subject_id NOT LIKE 'service:governed-learning-activation:%'
    OR length(btrim(p_initiating_human_subject_id)) NOT BETWEEN 1 AND 1024
  THEN
    RAISE EXCEPTION 'governed-learning Knowledge review input is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO claim_row FROM knowledge_claims claim
  WHERE claim.account_id = p_account_id AND claim.id = p_claim_id
    AND claim.scope_kind = 'workspace'
    AND claim.scope_workspace_id = p_workspace_id
    AND claim.scope_subject_id IS NULL
    AND claim.initiating_human_subject_id = p_initiating_human_subject_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning Knowledge claim is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO current_review FROM knowledge_claim_reviews review
  WHERE review.account_id = p_account_id AND review.claim_id = p_claim_id
  ORDER BY review.review_revision DESC LIMIT 1 FOR SHARE;
  IF current_review.id IS DISTINCT FROM p_expected_review_id
    OR current_review.review_revision IS DISTINCT FROM p_expected_review_revision
    OR (p_state = 'approved' AND current_review.state <> 'proposed')
    OR (p_state = 'revoked' AND current_review.state <> 'approved')
  THEN
    RAISE EXCEPTION 'governed-learning Knowledge review was superseded'
      USING ERRCODE = '40001';
  END IF;
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'governed-learning-native-review', 1, p_account_id, p_workspace_id,
    p_operation_id, p_claim_id, p_expected_review_id,
    p_expected_review_revision, p_state, p_actor_subject_id,
    p_initiating_human_subject_id
  )::text, 'UTF8')), 'hex');
  PERFORM set_config('opengeni.governed_learning_review_operation', p_operation_id::text, true);
  PERFORM set_config('opengeni.governed_learning_review_claim', p_claim_id::text, true);
  INSERT INTO knowledge_claim_reviews (
    account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
    claim_id, state, reason, operation_id, input_hash, actor_kind,
    actor_subject_id, initiating_human_subject_id
  ) VALUES (
    p_account_id, claim_row.scope_kind, claim_row.scope_workspace_id,
    claim_row.scope_subject_id, claim_row.scope_key, p_claim_id, p_state,
    CASE p_state WHEN 'approved' THEN 'Automatic governed-learning activation.'
      ELSE 'Exact governed-learning activation undo.' END,
    p_operation_id::text, input_hash_value, 'service', p_actor_subject_id,
    p_initiating_human_subject_id
  ) RETURNING * INTO result_row;
  PERFORM set_config('opengeni.governed_learning_review_operation', '', true);
  PERFORM set_config('opengeni.governed_learning_review_claim', '', true);
  RETURN NEXT result_row;
END;
$$;
REVOKE ALL ON FUNCTION governed_learning_apply_knowledge_review(
  uuid, uuid, uuid, uuid, uuid, bigint, text, text, text
) FROM PUBLIC;

-- The human lifecycle remains activate/rollback. This one additional event is
-- service-only and exists solely so exact undo can restore a previously absent
-- instruction-policy head without erasing the automatic activation from the
-- accepted-turn event reconstruction.
ALTER TABLE "workspace_instruction_policy_activation_events"
  DROP CONSTRAINT "workspace_instruction_policy_activation_events_type_chk",
  DROP CONSTRAINT "workspace_instruction_policy_activation_events_new_revision_chk";
ALTER TABLE "workspace_instruction_policy_activation_events"
  ALTER COLUMN "new_revision_id" DROP NOT NULL,
  ALTER COLUMN "new_revision" DROP NOT NULL,
  ALTER COLUMN "new_content_hash" DROP NOT NULL;
ALTER TABLE "workspace_instruction_policy_activation_events"
  ADD CONSTRAINT "workspace_instruction_policy_activation_events_type_chk" CHECK (
    "type" IN ('activate', 'rollback', 'automatic_deactivate')
  ),
  ADD CONSTRAINT "workspace_instruction_policy_activation_events_new_revision_chk" CHECK (
    (
      "type" = 'automatic_deactivate'
      AND "new_revision_id" IS NULL
      AND "new_revision" IS NULL
      AND "new_content_hash" IS NULL
      AND "old_revision_id" IS NOT NULL
    ) OR (
      "type" IN ('activate', 'rollback')
      AND "new_revision_id" IS NOT NULL
      AND "new_revision" > 0
      AND "new_content_hash" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type <> 'automatic_deactivate' AND NOT EXISTS (
    SELECT 1 FROM workspace_instruction_policy_revisions revision
    WHERE revision.id = NEW.new_revision_id
      AND revision.account_id = NEW.account_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.kind = NEW.kind
      AND revision.scope = NEW.scope
      AND revision.role_key IS NOT DISTINCT FROM NEW.role_key
      AND revision.revision = NEW.new_revision
      AND revision.content_hash = NEW.new_content_hash
  ) THEN
    RAISE EXCEPTION 'instruction-policy activation event has an invalid new revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.old_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_instruction_policy_revisions revision
    WHERE revision.id = NEW.old_revision_id
      AND revision.account_id = NEW.account_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.kind = NEW.kind
      AND revision.scope = NEW.scope
      AND revision.role_key IS NOT DISTINCT FROM NEW.role_key
      AND revision.revision = NEW.old_revision
      AND revision.content_hash = NEW.old_content_hash
  ) THEN
    RAISE EXCEPTION 'instruction-policy activation event has an invalid old revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION governed_learning_apply_instruction_policy(
  p_action text,
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_proposal_id uuid,
  p_expected_current_revision_id uuid,
  p_expected_activation_version bigint,
  p_target_revision_id uuid,
  p_actor_subject_id text
) RETURNS SETOF workspace_instruction_policy_activation_events
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  proposal_row workspace_instruction_policy_onboarding_proposals%ROWTYPE;
  current_head workspace_instruction_policy_heads%ROWTYPE;
  active_revision workspace_instruction_policy_revisions%ROWTYPE;
  target_revision workspace_instruction_policy_revisions%ROWTYPE;
  event_row workspace_instruction_policy_activation_events%ROWTYPE;
  next_version bigint;
  fingerprint text;
  event_time timestamptz;
BEGIN
  IF p_action NOT IN ('activate', 'undo')
    OR p_actor_subject_id NOT LIKE 'service:governed-learning-activation:%'
    OR p_expected_activation_version < 0
  THEN
    RAISE EXCEPTION 'governed-learning instruction-policy input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO proposal_row FROM workspace_instruction_policy_onboarding_proposals proposal
  WHERE proposal.account_id = p_account_id
    AND proposal.workspace_id = p_workspace_id
    AND proposal.id = p_proposal_id
    AND proposal.status = 'proposed'
    AND proposal.source_id ~ '^[0-9a-f-]{36}$'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning instruction-policy proposal is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO active_revision FROM workspace_instruction_policy_revisions revision
  WHERE revision.account_id = p_account_id
    AND revision.workspace_id = p_workspace_id
    AND revision.id = proposal_row.draft_revision_id
    AND revision.content_hash = proposal_row.draft_content_hash
    AND revision.provenance_source = 'knowledge_proposal'
    AND revision.provenance_source_id = proposal_row.source_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning instruction-policy draft is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO current_head FROM workspace_instruction_policy_heads head
  WHERE head.account_id = p_account_id AND head.workspace_id = p_workspace_id
    AND head.kind = proposal_row.kind AND head.scope = proposal_row.scope
    AND head.role_key IS NOT DISTINCT FROM proposal_row.role_key
  FOR UPDATE;
  IF current_head.revision_id IS DISTINCT FROM p_expected_current_revision_id
    OR coalesce(current_head.activation_version, 0) IS DISTINCT FROM p_expected_activation_version
  THEN
    RAISE EXCEPTION 'governed-learning instruction-policy head changed'
      USING ERRCODE = '40001';
  END IF;
  IF p_action = 'activate' THEN
    IF p_target_revision_id IS DISTINCT FROM proposal_row.draft_revision_id
      OR proposal_row.baseline_revision_id IS DISTINCT FROM p_expected_current_revision_id
      OR proposal_row.baseline_activation_version IS DISTINCT FROM p_expected_activation_version
    THEN
      RAISE EXCEPTION 'governed-learning instruction-policy proposal baseline changed'
        USING ERRCODE = '40001';
    END IF;
    target_revision := active_revision;
  ELSE
    IF current_head.revision_id IS DISTINCT FROM proposal_row.draft_revision_id THEN
      RAISE EXCEPTION 'governed-learning instruction-policy activation was superseded'
        USING ERRCODE = '40001';
    END IF;
    IF p_target_revision_id IS NOT NULL THEN
      SELECT * INTO target_revision FROM workspace_instruction_policy_revisions revision
      WHERE revision.account_id = p_account_id AND revision.workspace_id = p_workspace_id
        AND revision.id = p_target_revision_id
        AND revision.kind = proposal_row.kind AND revision.scope = proposal_row.scope
        AND revision.role_key IS NOT DISTINCT FROM proposal_row.role_key
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'governed-learning rollback target is unavailable'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_array(
    'governed-learning-instruction-policy', 1, p_action, p_account_id,
    p_workspace_id, p_operation_id, p_proposal_id, p_expected_current_revision_id,
    p_expected_activation_version, p_target_revision_id, p_actor_subject_id
  )::text, 'UTF8')), 'hex');
  event_time := clock_timestamp();
  next_version := p_expected_activation_version + 1;
  IF p_action = 'activate' THEN
    IF current_head.id IS NULL THEN
      INSERT INTO workspace_instruction_policy_heads (
        account_id, workspace_id, kind, scope, role_key, revision_id, revision,
        content_hash, activation_version, activated_at
      ) VALUES (
        p_account_id, p_workspace_id, proposal_row.kind, proposal_row.scope,
        proposal_row.role_key, target_revision.id, target_revision.revision,
        target_revision.content_hash, next_version, event_time
      );
    ELSE
      UPDATE workspace_instruction_policy_heads SET
        revision_id = target_revision.id, revision = target_revision.revision,
        content_hash = target_revision.content_hash,
        activation_version = next_version, activated_at = event_time
      WHERE id = current_head.id;
    END IF;
  ELSIF p_target_revision_id IS NULL THEN
    DELETE FROM workspace_instruction_policy_heads WHERE id = current_head.id;
  ELSE
    UPDATE workspace_instruction_policy_heads SET
      revision_id = target_revision.id, revision = target_revision.revision,
      content_hash = target_revision.content_hash,
      activation_version = next_version, activated_at = event_time
    WHERE id = current_head.id;
  END IF;
  INSERT INTO workspace_instruction_policy_activation_events (
    operation_id, request_fingerprint, account_id, workspace_id, kind, scope,
    role_key, type, activation_version, old_revision_id, old_revision,
    old_content_hash, new_revision_id, new_revision, new_content_hash,
    actor_subject_id, reason, created_at
  ) VALUES (
    p_operation_id, fingerprint, p_account_id, p_workspace_id, proposal_row.kind,
    proposal_row.scope, proposal_row.role_key,
    CASE WHEN p_action = 'activate' THEN 'activate'
      WHEN p_target_revision_id IS NULL THEN 'automatic_deactivate' ELSE 'rollback' END,
    next_version, current_head.revision_id, current_head.revision,
    current_head.content_hash, target_revision.id, target_revision.revision,
    target_revision.content_hash, p_actor_subject_id,
    CASE WHEN p_action = 'activate' THEN 'Automatic governed-learning activation.'
      ELSE 'Exact governed-learning activation undo.' END,
    event_time
  ) RETURNING * INTO event_row;
  RETURN NEXT event_row;
END;
$$;
REVOKE ALL ON FUNCTION governed_learning_apply_instruction_policy(
  text, uuid, uuid, uuid, uuid, uuid, bigint, uuid, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION governed_learning_apply_preference(
  p_action text,
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_knowledge_proposal_id uuid,
  p_preference_id uuid,
  p_revision_id uuid,
  p_expected_active_revision_id uuid,
  p_expected_activation_version integer,
  p_actor_subject_id text
) RETURNS SETOF preference_registry_events
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  proposal_receipt company_brain_preference_proposal_receipts%ROWTYPE;
  preference_row preference_registry_preferences%ROWTYPE;
  revision_row preference_registry_revisions%ROWTYPE;
  event_row preference_registry_events%ROWTYPE;
  next_event_version integer;
BEGIN
  IF p_action NOT IN ('activate', 'undo')
    OR p_actor_subject_id NOT LIKE 'service:governed-learning-activation:%'
    OR p_expected_activation_version < 0
  THEN
    RAISE EXCEPTION 'governed-learning preference input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO proposal_receipt FROM company_brain_preference_proposal_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.workspace_id = p_workspace_id
    AND receipt.knowledge_proposal_id = p_knowledge_proposal_id
    AND receipt.preference_id = p_preference_id AND receipt.revision_id = p_revision_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning preference proposal is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO preference_row FROM preference_registry_preferences preference
  WHERE preference.account_id = p_account_id AND preference.id = p_preference_id
    AND preference.scope = 'workspace' AND preference.scope_workspace_id = p_workspace_id
    AND preference.scope_subject_id IS NULL
  FOR UPDATE;
  IF NOT FOUND OR preference_row.scope_version <> 1
    OR preference_row.active_revision_id IS DISTINCT FROM p_expected_active_revision_id
    OR preference_row.activation_version IS DISTINCT FROM p_expected_activation_version
  THEN
    RAISE EXCEPTION 'governed-learning preference head changed' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO revision_row FROM preference_registry_revisions revision
  WHERE revision.account_id = p_account_id AND revision.preference_id = p_preference_id
    AND revision.id = p_revision_id
    AND revision.provenance_source = 'knowledge_proposal'
    AND revision.provenance_source_id = p_knowledge_proposal_id::text
    AND revision.trust = 'untrusted_proposal'
    AND (revision.expires_at IS NULL OR revision.expires_at > transaction_timestamp())
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning preference revision is unavailable' USING ERRCODE = '42501';
  END IF;
  IF (p_action = 'activate' AND (
      preference_row.status <> 'proposed'
      OR p_expected_active_revision_id IS NOT NULL
      OR p_expected_activation_version <> 0
    )) OR (p_action = 'undo' AND (
      preference_row.status <> 'active'
      OR p_expected_active_revision_id IS DISTINCT FROM p_revision_id
    ))
  THEN
    RAISE EXCEPTION 'governed-learning preference lifecycle was superseded'
      USING ERRCODE = '40001';
  END IF;
  PERFORM set_config('opengeni.preference_lifecycle_head_id', preference_row.id::text, true);
  PERFORM set_config('opengeni.preference_lifecycle_operation',
    CASE WHEN p_action = 'activate' THEN 'activate' ELSE 'deactivate' END, true);
  IF p_action = 'activate' THEN
    UPDATE preference_registry_preferences SET
      status = 'active', active_revision_id = revision_row.id,
      active_revision = revision_row.revision,
      active_content_hash = revision_row.content_hash,
      activation_version = activation_version + 1,
      updated_at = clock_timestamp()
    WHERE id = preference_row.id;
  ELSE
    UPDATE preference_registry_preferences SET
      status = 'inactive', active_revision_id = NULL, active_revision = NULL,
      active_content_hash = NULL, activation_version = activation_version + 1,
      updated_at = clock_timestamp()
    WHERE id = preference_row.id;
  END IF;
  PERFORM set_config('opengeni.preference_lifecycle_head_id', '', true);
  PERFORM set_config('opengeni.preference_lifecycle_operation', '', true);
  SELECT coalesce(max(event.version), 0) + 1 INTO next_event_version
  FROM preference_registry_events event WHERE event.preference_id = preference_row.id;
  INSERT INTO preference_registry_events (
    account_id, preference_id, type, version, old_revision_id, new_revision_id,
    actor_subject_id, reason
  ) VALUES (
    p_account_id, p_preference_id,
    CASE WHEN p_action = 'activate' THEN 'activated' ELSE 'deactivated' END,
    next_event_version,
    CASE WHEN p_action = 'undo' THEN revision_row.id ELSE NULL END,
    CASE WHEN p_action = 'activate' THEN revision_row.id ELSE NULL END,
    p_actor_subject_id,
    CASE WHEN p_action = 'activate' THEN 'Automatic governed-learning activation.'
      ELSE 'Exact governed-learning activation undo.' END
  ) RETURNING * INTO event_row;
  RETURN NEXT event_row;
END;
$$;
REVOKE ALL ON FUNCTION governed_learning_apply_preference(
  text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION activate_governed_learning_decision(
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_decision_receipt_id uuid
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
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_operation_id IS NULL
    OR p_decision_receipt_id IS NULL OR caller_subject_id IS NULL
    OR length(btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'governed-learning activation requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'governed-learning-activation', 1, p_account_id, p_workspace_id,
    p_operation_id, p_decision_receipt_id
  )::text, 'UTF8')), 'hex');
  SELECT * INTO result_row FROM governed_learning_activation_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.decision_receipt_id <> p_decision_receipt_id
      OR result_row.initiating_human_subject_id <> caller_subject_id
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
    AND receipt.outcome = 'automatic' AND receipt.automatic_eligible
  FOR UPDATE;
  IF NOT FOUND OR NOT session_reference_visible(
    decision_row.account_id, decision_row.workspace_id, decision_row.session_id
  ) THEN
    RAISE EXCEPTION 'final automatic evaluator receipt is unavailable'
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
  PERFORM 1 FROM session_turns turn
  WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
    AND turn.session_id = decision_row.session_id AND turn.id = decision_row.turn_id
    AND turn.active_attempt_id = decision_row.attempt_id
    AND turn.execution_generation = decision_row.execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND coalesce(turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ) = caller_subject_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning activation turn is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM session_turn_attempts attempt
  WHERE attempt.account_id = p_account_id AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = decision_row.session_id AND attempt.turn_id = decision_row.turn_id
    AND attempt.id = decision_row.attempt_id
    AND attempt.execution_generation = decision_row.execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = p_workspace_id
        AND interruption.attempt_id = decision_row.attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE;
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
  IF current_mode <> 'automatic' THEN
    RAISE EXCEPTION 'governed-learning source is no longer automatic' USING ERRCODE = '42501';
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
  IF current_authority_hash IS DISTINCT FROM decision_row.evidence_authority_hash THEN
    RAISE EXCEPTION 'governed-learning evidence authority changed after evaluation'
      USING ERRCODE = '40001';
  END IF;

  IF proposal_row.target_kind = 'instruction_policy' THEN
    SELECT * INTO instruction_proposal
    FROM workspace_instruction_policy_onboarding_proposals proposal
    WHERE proposal.account_id = p_account_id AND proposal.workspace_id = p_workspace_id
      AND proposal.source_id = proposal_row.id::text
      AND proposal.source_version = proposal_row.content_hash
      AND proposal.status = 'proposed'
    FOR SHARE;
    IF NOT FOUND OR instruction_proposal.draft_content_hash <> proposal_row.content_hash THEN
      RAISE EXCEPTION 'exact inactive instruction-policy proposal is unavailable'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO current_instruction_head FROM workspace_instruction_policy_heads head
    WHERE head.account_id = p_account_id AND head.workspace_id = p_workspace_id
      AND head.kind = instruction_proposal.kind AND head.scope = instruction_proposal.scope
      AND head.role_key IS NOT DISTINCT FROM instruction_proposal.role_key FOR SHARE;
    IF current_instruction_head.revision_id IS DISTINCT FROM instruction_proposal.baseline_revision_id
      OR coalesce(current_instruction_head.activation_version, 0)
        IS DISTINCT FROM instruction_proposal.baseline_activation_version
    THEN
      RAISE EXCEPTION 'instruction-policy proposal baseline is stale' USING ERRCODE = '40001';
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
    review_row.id, review_row.review_revision, 'approved', service_actor, caller_subject_id
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
    effective_at
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
    destination_new_version_value, destination_event_id_value, effective_at_value
  ) RETURNING * INTO result_row;
  RETURN NEXT result_row;
END;
$$;
REVOKE ALL ON FUNCTION activate_governed_learning_decision(uuid, uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION undo_governed_learning_activation(
  p_account_id uuid,
  p_workspace_id uuid,
  p_operation_id uuid,
  p_activation_receipt_id uuid
) RETURNS SETOF governed_learning_activation_undo_receipts
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  caller_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  activation_row governed_learning_activation_receipts%ROWTYPE;
  decision_row governed_learning_decision_receipts%ROWTYPE;
  result_row governed_learning_activation_undo_receipts%ROWTYPE;
  latest_review knowledge_claim_reviews%ROWTYPE;
  revocation_row knowledge_claim_reviews%ROWTYPE;
  instruction_head workspace_instruction_policy_heads%ROWTYPE;
  instruction_event workspace_instruction_policy_activation_events%ROWTYPE;
  preference_row preference_registry_preferences%ROWTYPE;
  preference_event preference_registry_events%ROWTYPE;
  input_hash_value text;
  service_actor text;
  review_operation_id uuid;
  destination_operation_id uuid;
  destination_new_version_value bigint;
  destination_event_id_value uuid;
  effective_at_value timestamptz;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_operation_id IS NULL
    OR p_activation_receipt_id IS NULL OR caller_subject_id IS NULL
    OR length(btrim(caller_subject_id)) NOT BETWEEN 1 AND 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'governed-learning undo requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'governed-learning-activation-undo', 1, p_account_id, p_workspace_id,
    p_operation_id, p_activation_receipt_id
  )::text, 'UTF8')), 'hex');
  SELECT * INTO result_row FROM governed_learning_activation_undo_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.activation_receipt_id <> p_activation_receipt_id
      OR result_row.initiating_human_subject_id <> caller_subject_id
    THEN
      RAISE EXCEPTION 'governed-learning undo operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO result_row FROM governed_learning_activation_undo_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF result_row.account_id <> p_account_id OR result_row.input_hash <> input_hash_value
      OR result_row.activation_receipt_id <> p_activation_receipt_id
      OR result_row.initiating_human_subject_id <> caller_subject_id
    THEN
      RAISE EXCEPTION 'governed-learning undo operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEXT result_row;
    RETURN;
  END IF;
  SELECT * INTO activation_row FROM governed_learning_activation_receipts receipt
  WHERE receipt.id = p_activation_receipt_id AND receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = caller_subject_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed-learning activation receipt is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO decision_row FROM governed_learning_decision_receipts receipt
  WHERE receipt.id = activation_row.decision_receipt_id
    AND receipt.account_id = p_account_id AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = caller_subject_id FOR SHARE;
  IF NOT FOUND OR NOT session_reference_visible(
    decision_row.account_id, decision_row.workspace_id, decision_row.session_id
  ) THEN
    RAISE EXCEPTION 'governed-learning undo source is unavailable' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM governed_learning_activation_undo_receipts receipt
    WHERE receipt.activation_receipt_id = p_activation_receipt_id
  ) THEN
    RAISE EXCEPTION 'governed-learning activation was undone by another operation'
      USING ERRCODE = '23505';
  END IF;
  SELECT * INTO latest_review FROM knowledge_claim_reviews review
  WHERE review.account_id = p_account_id AND review.claim_id = activation_row.claim_id
  ORDER BY review.review_revision DESC LIMIT 1 FOR UPDATE;
  IF latest_review.id IS DISTINCT FROM activation_row.knowledge_approval_review_id
    OR latest_review.review_revision IS DISTINCT FROM activation_row.knowledge_approval_review_revision
    OR latest_review.state <> 'approved'
  THEN
    RAISE EXCEPTION 'automatic Knowledge activation was superseded' USING ERRCODE = '40001';
  END IF;
  service_actor := 'service:governed-learning-activation:' || input_hash_value;
  review_operation_id := opengeni_private.governed_learning_derived_uuid(
    p_operation_id, 'knowledge-revoke'
  );
  destination_operation_id := opengeni_private.governed_learning_derived_uuid(
    p_operation_id, 'destination-undo'
  );

  IF activation_row.destination = 'instruction_policy' THEN
    SELECT head.* INTO instruction_head FROM workspace_instruction_policy_heads head
    JOIN workspace_instruction_policy_onboarding_proposals proposal
      ON proposal.account_id = head.account_id AND proposal.workspace_id = head.workspace_id
      AND proposal.id = activation_row.destination_proposal_id
      AND proposal.kind = head.kind AND proposal.scope = head.scope
      AND proposal.role_key IS NOT DISTINCT FROM head.role_key
    WHERE head.account_id = p_account_id AND head.workspace_id = p_workspace_id
      AND head.revision_id = activation_row.destination_revision_id
      AND head.content_hash = activation_row.destination_new_content_hash
      AND head.activation_version = activation_row.destination_new_version
    FOR UPDATE OF head;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'automatic instruction-policy activation was superseded'
        USING ERRCODE = '40001';
    END IF;
    SELECT * INTO instruction_event FROM governed_learning_apply_instruction_policy(
      'undo', p_account_id, p_workspace_id, destination_operation_id,
      activation_row.destination_proposal_id, activation_row.destination_revision_id,
      activation_row.destination_new_version, activation_row.destination_old_revision_id,
      service_actor
    );
    destination_new_version_value := instruction_event.activation_version;
    destination_event_id_value := instruction_event.id;
    effective_at_value := instruction_event.created_at;
  ELSIF activation_row.destination = 'preference' THEN
    SELECT * INTO preference_row FROM preference_registry_preferences preference
    WHERE preference.account_id = p_account_id AND preference.id = activation_row.destination_proposal_id
      AND preference.scope = 'workspace' AND preference.scope_workspace_id = p_workspace_id
      AND preference.status = 'active'
      AND preference.active_revision_id = activation_row.destination_revision_id
      AND preference.active_content_hash = activation_row.destination_new_content_hash
      AND preference.activation_version = activation_row.destination_new_version
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'automatic preference activation was superseded' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO preference_event FROM governed_learning_apply_preference(
      'undo', p_account_id, p_workspace_id, destination_operation_id,
      activation_row.proposal_id, activation_row.destination_proposal_id,
      activation_row.destination_revision_id, activation_row.destination_revision_id,
      activation_row.destination_new_version::integer, service_actor
    );
    SELECT activation_version INTO destination_new_version_value
    FROM preference_registry_preferences WHERE id = activation_row.destination_proposal_id;
    destination_event_id_value := preference_event.id;
    effective_at_value := preference_event.created_at;
  ELSE
    RAISE EXCEPTION 'governed-learning activation destination is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO revocation_row FROM governed_learning_apply_knowledge_review(
    p_account_id, p_workspace_id, review_operation_id, activation_row.claim_id,
    latest_review.id, latest_review.review_revision, 'revoked', service_actor,
    caller_subject_id
  );
  INSERT INTO governed_learning_activation_undo_receipts (
    account_id, workspace_id, operation_id, input_hash, activation_receipt_id,
    initiating_human_subject_id, service_actor_subject_id, destination,
    knowledge_approval_review_id, knowledge_revocation_review_id,
    knowledge_revocation_review_revision, knowledge_revocation_input_hash,
    destination_activated_revision_id, destination_restored_revision_id,
    destination_activated_content_hash, destination_restored_content_hash,
    destination_old_version, destination_new_version, destination_event_id,
    effective_at
  ) VALUES (
    p_account_id, p_workspace_id, p_operation_id, input_hash_value,
    activation_row.id, caller_subject_id, service_actor, activation_row.destination,
    activation_row.knowledge_approval_review_id, revocation_row.id,
    revocation_row.review_revision, revocation_row.input_hash,
    activation_row.destination_revision_id, activation_row.destination_old_revision_id,
    activation_row.destination_new_content_hash, activation_row.destination_old_content_hash,
    activation_row.destination_new_version, destination_new_version_value,
    destination_event_id_value, effective_at_value
  ) RETURNING * INTO result_row;
  RETURN NEXT result_row;
END;
$$;
REVOKE ALL ON FUNCTION undo_governed_learning_activation(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- Target-schema hardening is mandatory because runtime roles may have TEMP.
DO $governed_learning_activation_hardening$
DECLARE
  target_schema text := current_schema();
  runtime_role text := nullif(current_setting('opengeni.runtime_role', true), '');
BEGIN
  IF runtime_role IS NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    runtime_role := 'opengeni_app';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.governed_learning_reject_activation_receipt_mutation() '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.governed_learning_guard_service_review() '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.governed_learning_apply_knowledge_review('
      || 'uuid,uuid,uuid,uuid,uuid,bigint,text,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.workspace_instruction_policy_validate_event() '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.governed_learning_apply_instruction_policy('
      || 'text,uuid,uuid,uuid,uuid,uuid,bigint,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.governed_learning_apply_preference('
      || 'text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.activate_governed_learning_decision(uuid,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.undo_governed_learning_activation(uuid,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
  EXECUTE format('REVOKE ALL ON TABLE %I.governed_learning_activation_receipts FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL ON TABLE %I.governed_learning_activation_undo_receipts FROM PUBLIC', target_schema);
  IF runtime_role IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.governed_learning_activation_receipts FROM %I', target_schema, runtime_role);
    EXECUTE format('REVOKE ALL ON TABLE %I.governed_learning_activation_undo_receipts FROM %I', target_schema, runtime_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.activate_governed_learning_decision(uuid,uuid,uuid,uuid) TO %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.undo_governed_learning_activation(uuid,uuid,uuid,uuid) TO %I',
      target_schema, runtime_role
    );
  END IF;
END
$governed_learning_activation_hardening$;
