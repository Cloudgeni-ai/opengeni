-- deployment-mode: rolling

-- The historical proposal table keeps its onboarding name, but the canonical
-- instruction revision already supports knowledge_proposal provenance. Broaden
-- only its validator so an exact immutable scoped-Knowledge change proposal can
-- materialize one inactive draft without gaining activation authority.
CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_onboarding_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."baseline_revision_id" IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM "workspace_instruction_policy_heads" head
      WHERE head."account_id" = NEW."account_id"
        AND head."workspace_id" = NEW."workspace_id"
        AND head."kind" = NEW."kind"
        AND head."scope" = NEW."scope"
        AND head."role_key" IS NOT DISTINCT FROM NEW."role_key"
    ) THEN
      RAISE EXCEPTION 'instruction-policy proposal must capture the exact active head baseline'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_heads" head
    WHERE head."account_id" = NEW."account_id"
      AND head."workspace_id" = NEW."workspace_id"
      AND head."kind" = NEW."kind"
      AND head."scope" = NEW."scope"
      AND head."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND head."revision_id" = NEW."baseline_revision_id"
      AND head."revision" = NEW."baseline_revision"
      AND head."content_hash" = NEW."baseline_content_hash"
      AND head."activation_version" = NEW."baseline_activation_version"
      AND head."activated_at" = NEW."baseline_activated_at"
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must capture the exact active head baseline'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."baseline_revision_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."baseline_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."baseline_revision"
      AND revision."content_hash" = NEW."baseline_content_hash"
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal has an invalid baseline revision'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."draft_revision_id"
      AND revision."operation_id" = NEW."operation_id"
      AND revision."request_fingerprint" = NEW."request_fingerprint"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."draft_revision"
      AND revision."content_hash" = NEW."draft_content_hash"
      AND revision."supersedes_revision_id" IS NOT DISTINCT FROM NEW."baseline_revision_id"
      AND revision."created_by_subject_id" = NEW."created_by_subject_id"
      AND (
        (
          revision."provenance_source" = 'onboarding'
          AND revision."provenance_source_id" = NEW."id"::text
        ) OR (
          revision."provenance_source" = 'knowledge_proposal'
          AND revision."provenance_source_id" = NEW."source_id"
          AND NEW."source_version" = NEW."draft_content_hash"
          AND EXISTS (
            SELECT 1
            FROM "knowledge_change_proposals" proposal
            WHERE proposal."id"::text = NEW."source_id"
              AND proposal."account_id" = NEW."account_id"
              AND proposal."scope_kind" = 'workspace'
              AND proposal."scope_workspace_id" = NEW."workspace_id"
              AND proposal."scope_subject_id" IS NULL
              AND proposal."target_kind" = 'instruction_policy'
              AND proposal."target_scope" = 'workspace'
              AND proposal."target_key" = concat(
                NEW."kind", ':', NEW."scope", ':', coalesce(NEW."role_key", 'global')
              )
              AND proposal."content_hash" = NEW."source_version"
              AND proposal."actor_kind" = 'service'
              AND proposal."actor_subject_id" = NEW."created_by_subject_id"
              AND proposal."initiating_human_subject_id"
                = current_setting('opengeni.subject_id', true)
              AND proposal."claim_id" IS NOT NULL
              AND proposal."evidence_id" IS NOT NULL
              AND proposal."status" = 'proposed'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must identify its exact inactive draft'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_heads" head
    WHERE head."account_id" = NEW."account_id"
      AND head."workspace_id" = NEW."workspace_id"
      AND head."revision_id" = NEW."draft_revision_id"
  ) OR EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_activation_events" event
    WHERE event."account_id" = NEW."account_id"
      AND event."workspace_id" = NEW."workspace_id"
      AND event."new_revision_id" = NEW."draft_revision_id"
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must identify a never-activated inactive draft'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "company_brain_preference_proposal_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "knowledge_proposal_id" uuid NOT NULL REFERENCES "knowledge_change_proposals"("id")
    ON DELETE RESTRICT,
  "preference_id" uuid NOT NULL REFERENCES "preference_registry_preferences"("id")
    ON DELETE RESTRICT,
  "revision_id" uuid NOT NULL REFERENCES "preference_registry_revisions"("id")
    ON DELETE RESTRICT,
  "creation_event_id" uuid NOT NULL REFERENCES "preference_registry_events"("id")
    ON DELETE RESTRICT,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE RESTRICT,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE RESTRICT,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE RESTRICT,
  "execution_generation" integer NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_brain_preference_proposal_receipts_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "company_brain_preference_proposal_receipts_knowledge_uq"
    UNIQUE ("account_id", "knowledge_proposal_id"),
  CONSTRAINT "company_brain_preference_proposal_receipts_hash_chk"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "company_brain_preference_proposal_receipts_attempt_chk" CHECK (
    "execution_generation" > 0
    AND length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
  )
);

ALTER TABLE "company_brain_preference_proposal_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_brain_preference_proposal_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "company_brain_preference_proposal_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE TRIGGER company_brain_preference_proposal_receipts_immutable
  BEFORE UPDATE OR DELETE ON "company_brain_preference_proposal_receipts"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_reject_history_mutation();

-- Preference proposals created by an agent attempt are not human governance
-- mutations. This function records a service actor, revalidates the exact live
-- attempt and causal human, and creates only an inactive workspace proposal.
CREATE OR REPLACE FUNCTION preference_registry_create_knowledge_proposal_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_input_hash text,
  p_knowledge_proposal_id uuid,
  p_stable_key text,
  p_title text,
  p_description text,
  p_content text,
  p_precedence_rank integer,
  p_conflict_strategy text,
  p_conflicts_with jsonb,
  p_expires_at timestamptz,
  p_reason text
) RETURNS TABLE (preference_id uuid, revision_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  turn_row record;
  proposal_row knowledge_change_proposals%ROWTYPE;
  preference_row preference_registry_preferences%ROWTYPE;
  revision_row preference_registry_revisions%ROWTYPE;
  event_row preference_registry_events%ROWTYPE;
  receipt_row company_brain_preference_proposal_receipts%ROWTYPE;
  actor_subject_id text;
  expected_proposal_content jsonb;
  normalized_conflicts jsonb;
BEGIN
  IF NULLIF(current_setting('opengeni.account_id', true), '')::uuid
      IS DISTINCT FROM p_account_id
    OR NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid
      IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'preference Knowledge proposal requires exact tenant context'
      USING ERRCODE = '42501';
  END IF;
  IF p_execution_generation IS NULL OR p_execution_generation <= 0
    OR p_operation_id IS NULL
    OR p_input_hash !~ '^[0-9a-f]{64}$'
    OR p_stable_key IS NULL
    OR length(p_stable_key) NOT BETWEEN 1 AND 96
    OR p_stable_key <> lower(btrim(p_stable_key))
    OR p_stable_key !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
    OR p_stable_key ~ '--'
    OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120
    OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 240
    OR p_content IS NULL OR length(btrim(p_content)) = 0 OR length(p_content) > 262144
    OR p_precedence_rank IS NULL OR p_precedence_rank NOT BETWEEN -1000 AND 1000
    OR p_conflict_strategy IS NULL
    OR p_conflict_strategy NOT IN ('override', 'merge', 'reject', 'inform')
    OR p_conflicts_with IS NULL
    OR jsonb_typeof(p_conflicts_with) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_conflicts_with) > 32
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4096
  THEN
    RAISE EXCEPTION 'preference Knowledge proposal input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_conflicts_with) item
    WHERE jsonb_typeof(item) <> 'string'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_conflicts_with) item(value)
    WHERE length(value) NOT BETWEEN 1 AND 96
      OR value <> lower(btrim(value))
      OR value !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      OR value ~ '--'
  ) THEN
    RAISE EXCEPTION 'preference Knowledge proposal conflicts are invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
  INTO normalized_conflicts
  FROM (
    SELECT DISTINCT value
    FROM jsonb_array_elements_text(p_conflicts_with) item(value)
  ) normalized;
  IF normalized_conflicts IS DISTINCT FROM p_conflicts_with THEN
    RAISE EXCEPTION 'preference Knowledge proposal conflicts must be unique and sorted'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM workspaces workspace
  WHERE workspace.id = p_workspace_id AND workspace.account_id = p_account_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preference Knowledge proposal workspace is unavailable'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM sessions session
  WHERE session.id = p_session_id
    AND session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.active_turn_id = p_turn_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preference Knowledge proposal session is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT turn.id, turn.account_id, turn.workspace_id, turn.session_id,
    turn.active_attempt_id, turn.execution_generation,
    coalesce(
      turn.initiating_human_subject_id,
      case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
    ) AS initiating_human_subject_id
  INTO turn_row
  FROM session_turns turn
  WHERE turn.id = p_turn_id
    AND turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.active_attempt_id = p_attempt_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
  FOR SHARE;
  IF NOT FOUND
    OR length(btrim(coalesce(turn_row.initiating_human_subject_id, ''))) NOT BETWEEN 1 AND 1024
    OR current_setting('opengeni.subject_id', true)
      IS DISTINCT FROM turn_row.initiating_human_subject_id
  THEN
    RAISE EXCEPTION 'preference Knowledge proposal requires the immutable initiating human'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = p_session_id
    AND attempt.turn_id = p_turn_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1
      FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = attempt.workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preference Knowledge proposal requires the exact current attempt'
      USING ERRCODE = '42501';
  END IF;

  actor_subject_id := 'service:company-brain-governed-write:' || p_input_hash;
  expected_proposal_content := jsonb_build_object(
    'stableKey', p_stable_key,
    'title', p_title,
    'description', p_description,
    'content', p_content,
    'precedenceRank', p_precedence_rank,
    'conflictStrategy', p_conflict_strategy,
    'conflictsWith', p_conflicts_with,
    'expiresAt', CASE WHEN p_expires_at IS NULL THEN NULL ELSE
      to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
  );
  SELECT * INTO proposal_row
  FROM knowledge_change_proposals proposal
  WHERE proposal.id = p_knowledge_proposal_id
    AND proposal.account_id = p_account_id
    AND proposal.scope_kind = 'workspace'
    AND proposal.scope_workspace_id = p_workspace_id
    AND proposal.scope_subject_id IS NULL
    AND proposal.target_kind = 'preference'
    AND proposal.target_scope = 'workspace'
    AND proposal.target_key = p_stable_key
    AND proposal.status = 'proposed'
    AND proposal.actor_kind = 'service'
    AND proposal.actor_subject_id = actor_subject_id
    AND proposal.initiating_human_subject_id = turn_row.initiating_human_subject_id
  FOR SHARE;
  IF NOT FOUND OR proposal_row.content::jsonb IS DISTINCT FROM expected_proposal_content
    OR NOT EXISTS (
      SELECT 1
      FROM knowledge_claims claim
      JOIN knowledge_claim_evidence evidence
        ON evidence.account_id = claim.account_id
        AND evidence.claim_id = claim.id
      WHERE claim.id = proposal_row.claim_id
        AND claim.account_id = p_account_id
        AND claim.scope_kind = 'workspace'
        AND claim.scope_workspace_id = p_workspace_id
        AND claim.scope_subject_id IS NULL
        AND evidence.id = proposal_row.evidence_id
        AND evidence.scope_kind = 'workspace'
        AND evidence.scope_workspace_id = p_workspace_id
        AND evidence.scope_subject_id IS NULL
        AND evidence.polarity = 'supports'
        AND EXISTS (
          SELECT 1
          FROM knowledge_claim_reviews review
          WHERE review.account_id = p_account_id
            AND review.claim_id = claim.id
            AND review.scope_kind = 'workspace'
            AND review.scope_workspace_id = p_workspace_id
            AND review.scope_subject_id IS NULL
            AND review.state = 'proposed'
            AND review.reason = p_reason
            AND review.actor_kind = 'service'
            AND review.actor_subject_id = actor_subject_id
            AND review.initiating_human_subject_id = turn_row.initiating_human_subject_id
        )
    )
  THEN
    RAISE EXCEPTION 'preference Knowledge proposal provenance is inexact'
      USING ERRCODE = '23514';
  END IF;

  -- Replay resolves only the immutable workspace-local adapter receipt. It is
  -- unaffected by later human activation, rejection, deactivation,
  -- supersession, or scope change on the destination preference.
  SELECT * INTO receipt_row
  FROM company_brain_preference_proposal_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF receipt_row.account_id <> p_account_id
      OR receipt_row.input_hash <> p_input_hash
      OR receipt_row.knowledge_proposal_id <> p_knowledge_proposal_id
      OR receipt_row.session_id <> p_session_id
      OR receipt_row.turn_id <> p_turn_id
      OR receipt_row.attempt_id <> p_attempt_id
      OR receipt_row.execution_generation <> p_execution_generation
      OR receipt_row.actor_subject_id <> actor_subject_id
      OR receipt_row.initiating_human_subject_id <> turn_row.initiating_human_subject_id
    THEN
      RAISE EXCEPTION 'preference proposal operation conflicts with immutable receipt'
        USING ERRCODE = '23505';
    END IF;
    preference_id := receipt_row.preference_id;
    revision_id := receipt_row.revision_id;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM company_brain_preference_proposal_receipts receipt
    WHERE receipt.account_id = p_account_id
      AND receipt.knowledge_proposal_id = p_knowledge_proposal_id
  ) THEN
    RAISE EXCEPTION 'Knowledge proposal is already bound to another preference receipt'
      USING ERRCODE = '23505';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('company-brain-preference:', p_account_id, ':', p_workspace_id, ':', p_stable_key),
    0::bigint
  ));
  SELECT * INTO preference_row
  FROM preference_registry_preferences preference
  WHERE preference.account_id = p_account_id
    AND preference.scope = 'workspace'
    AND preference.scope_workspace_id = p_workspace_id
    AND preference.scope_subject_id IS NULL
    AND preference.stable_key = p_stable_key
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'workspace preference key is bound to another proposal'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO preference_registry_preferences (
    account_id, stable_key, scope, scope_workspace_id, scope_subject_id,
    created_by_subject_id
  ) VALUES (
    p_account_id, p_stable_key, 'workspace', p_workspace_id, NULL,
    actor_subject_id
  ) RETURNING * INTO preference_row;
  INSERT INTO preference_registry_revisions (
    account_id, preference_id, title, description, content, content_hash,
    precedence_rank, conflict_strategy, conflicts_with, provenance_source,
    provenance_source_id, trust, expires_at, corrects_revision_id,
    created_by_subject_id
  ) VALUES (
    p_account_id, preference_row.id, p_title, p_description, p_content,
    encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), p_precedence_rank,
    p_conflict_strategy, p_conflicts_with, 'knowledge_proposal',
    p_knowledge_proposal_id::text, 'untrusted_proposal', p_expires_at, NULL,
    actor_subject_id
  ) RETURNING * INTO revision_row;
  INSERT INTO preference_registry_events (
    account_id, preference_id, type, version, old_revision_id, new_revision_id,
    old_scope, old_workspace_id, old_subject_id, new_scope, new_workspace_id,
    new_subject_id, related_preference_id, actor_subject_id, reason
  ) VALUES (
    p_account_id, preference_row.id, 'proposal_created', 1, NULL, revision_row.id,
    NULL, NULL, NULL, 'workspace', p_workspace_id, NULL, NULL,
    actor_subject_id, p_reason
  ) RETURNING * INTO event_row;
  INSERT INTO company_brain_preference_proposal_receipts (
    account_id, workspace_id, operation_id, input_hash, knowledge_proposal_id,
    preference_id, revision_id, creation_event_id, session_id, turn_id,
    attempt_id, execution_generation, actor_subject_id,
    initiating_human_subject_id
  ) VALUES (
    p_account_id, p_workspace_id, p_operation_id, p_input_hash,
    p_knowledge_proposal_id, preference_row.id, revision_row.id, event_row.id,
    p_session_id, p_turn_id, p_attempt_id, p_execution_generation,
    actor_subject_id, turn_row.initiating_human_subject_id
  );
  preference_id := preference_row.id;
  revision_id := revision_row.id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION preference_registry_create_knowledge_proposal_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text,
  integer, text, jsonb, timestamptz, text
) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE "company_brain_preference_proposal_receipts"
  FROM PUBLIC;

DO $grant_preference_knowledge_proposal$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE "company_brain_preference_proposal_receipts"
      FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION preference_registry_create_knowledge_proposal_for_attempt(
      uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text,
      integer, text, jsonb, timestamptz, text
    ) TO opengeni_app;
  END IF;
END;
$grant_preference_knowledge_proposal$;