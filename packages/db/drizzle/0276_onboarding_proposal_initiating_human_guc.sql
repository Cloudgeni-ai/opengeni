-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- The onboarding-proposal draft validation trigger bound a knowledge-proposal
-- draft to `current_setting('opengeni.subject_id')`. On the real first-party
-- MCP path that GUC carries the *service* subject (`worker:first-party-mcp`)
-- while the frozen human travels in `opengeni.initiating_human_subject_id`,
-- so every real agent `remember` rule call failed the draft check with
-- SQLSTATE 23514 regardless of workspace state. Compare against the canonical
-- initiating-human GUC first (the pattern every authority migration since
-- 0225 uses), falling back to `opengeni.subject_id` for direct human writers
-- that never set the initiating-human GUC. The rest of the function body is
-- byte-identical to migration 0269.

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_onboarding_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.baseline_revision_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM workspace_instruction_policy_heads head
      WHERE head.account_id = NEW.account_id
        AND head.workspace_id = NEW.workspace_id
        AND head.kind = NEW.kind
        AND head.scope = NEW.scope
        AND head.role_key IS NOT DISTINCT FROM NEW.role_key
    ) THEN
      RAISE EXCEPTION 'instruction-policy proposal must capture the exact active head baseline'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (
        NEW.baseline_activation_version = 0
        AND NOT EXISTS (
          SELECT 1 FROM workspace_instruction_policy_heads head
          WHERE head.account_id = NEW.account_id
            AND head.workspace_id = NEW.workspace_id
            AND head.kind = NEW.kind
            AND head.scope = NEW.scope
            AND head.role_key IS NOT DISTINCT FROM NEW.role_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM workspace_instruction_policy_deactivation_events event
          WHERE event.account_id = NEW.account_id
            AND event.workspace_id = NEW.workspace_id
            AND event.kind = NEW.kind
            AND event.scope = NEW.scope
            AND event.role_key IS NOT DISTINCT FROM NEW.role_key
        )
      ) OR (
        NEW.baseline_activation_version > 0
        AND NOT EXISTS (
          SELECT 1 FROM workspace_instruction_policy_heads head
          WHERE head.account_id = NEW.account_id
            AND head.workspace_id = NEW.workspace_id
            AND head.kind = NEW.kind
            AND head.scope = NEW.scope
            AND head.role_key IS NOT DISTINCT FROM NEW.role_key
        )
        AND EXISTS (
          SELECT 1 FROM workspace_instruction_policy_deactivation_events event
          WHERE event.account_id = NEW.account_id
            AND event.workspace_id = NEW.workspace_id
            AND event.kind = NEW.kind
            AND event.scope = NEW.scope
            AND event.role_key IS NOT DISTINCT FROM NEW.role_key
            AND event.activation_version = NEW.baseline_activation_version
            AND NOT EXISTS (
              SELECT 1 FROM workspace_instruction_policy_deactivation_events newer
              WHERE newer.account_id = event.account_id
                AND newer.workspace_id = event.workspace_id
                AND newer.kind = event.kind
                AND newer.scope = event.scope
                AND newer.role_key IS NOT DISTINCT FROM event.role_key
                AND newer.activation_version > event.activation_version
            )
        )
      )
    ) THEN
      RAISE EXCEPTION 'instruction-policy proposal must capture the exact inactive boundary'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM workspace_instruction_policy_heads head
    WHERE head.account_id = NEW.account_id
      AND head.workspace_id = NEW.workspace_id
      AND head.kind = NEW.kind
      AND head.scope = NEW.scope
      AND head.role_key IS NOT DISTINCT FROM NEW.role_key
      AND head.revision_id = NEW.baseline_revision_id
      AND head.revision = NEW.baseline_revision
      AND head.content_hash = NEW.baseline_content_hash
      AND head.activation_version = NEW.baseline_activation_version
      AND head.activated_at = NEW.baseline_activated_at
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must capture the exact active head baseline'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.baseline_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_instruction_policy_revisions revision
    WHERE revision.id = NEW.baseline_revision_id
      AND revision.account_id = NEW.account_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.kind = NEW.kind
      AND revision.scope = NEW.scope
      AND revision.role_key IS NOT DISTINCT FROM NEW.role_key
      AND revision.revision = NEW.baseline_revision
      AND revision.content_hash = NEW.baseline_content_hash
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal has an invalid baseline revision'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM workspace_instruction_policy_revisions revision
    WHERE revision.id = NEW.draft_revision_id
      AND revision.operation_id = NEW.operation_id
      AND revision.request_fingerprint = NEW.request_fingerprint
      AND revision.account_id = NEW.account_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.kind = NEW.kind
      AND revision.scope = NEW.scope
      AND revision.role_key IS NOT DISTINCT FROM NEW.role_key
      AND revision.revision = NEW.draft_revision
      AND revision.content_hash = NEW.draft_content_hash
      AND revision.supersedes_revision_id IS NOT DISTINCT FROM NEW.baseline_revision_id
      AND revision.created_by_subject_id = NEW.created_by_subject_id
      AND (
        (
          revision.provenance_source = 'onboarding'
          AND revision.provenance_source_id = NEW.id::text
        ) OR (
          revision.provenance_source = 'knowledge_proposal'
          AND revision.provenance_source_id = NEW.source_id
          AND NEW.source_version = NEW.draft_content_hash
          AND EXISTS (
            SELECT 1 FROM knowledge_change_proposals proposal
            WHERE proposal.id::text = NEW.source_id
              AND proposal.account_id = NEW.account_id
              AND proposal.scope_kind = 'workspace'
              AND proposal.scope_workspace_id = NEW.workspace_id
              AND proposal.scope_subject_id IS NULL
              AND proposal.target_kind = 'instruction_policy'
              AND proposal.target_scope = NEW.scope
              AND proposal.target_key IS NOT DISTINCT FROM CASE
                WHEN NEW.scope = 'role' THEN NEW.role_key
                ELSE NULL
              END
              AND proposal.content_hash = NEW.source_version
              AND proposal.actor_kind = 'service'
              AND proposal.actor_subject_id = NEW.created_by_subject_id
              AND proposal.initiating_human_subject_id = COALESCE(
                NULLIF(current_setting('opengeni.initiating_human_subject_id', true), ''),
                current_setting('opengeni.subject_id', true)
              )
              AND proposal.claim_id IS NOT NULL
              AND proposal.evidence_id IS NOT NULL
              AND proposal.status = 'proposed'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must identify its exact inactive draft'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM workspace_instruction_policy_heads head
    WHERE head.account_id = NEW.account_id
      AND head.workspace_id = NEW.workspace_id
      AND head.revision_id = NEW.draft_revision_id
  ) OR EXISTS (
    SELECT 1 FROM workspace_instruction_policy_activation_events event
    WHERE event.account_id = NEW.account_id
      AND event.workspace_id = NEW.workspace_id
      AND event.new_revision_id = NEW.draft_revision_id
  ) THEN
    RAISE EXCEPTION 'instruction-policy proposal must identify a never-activated inactive draft'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


-- CREATE OR REPLACE drops the previously pinned search_path; re-pin it exactly
-- as migration 0269's hardening block did.
DO $onboarding_proposal_initiating_human_hardening$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.workspace_instruction_policy_validate_onboarding_proposal() '
      || 'SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema
  );
END
$onboarding_proposal_initiating_human_hardening$;
