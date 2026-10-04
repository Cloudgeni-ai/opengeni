-- deployment-mode: maintenance
-- Drain API and workers before activation: older clients do not recognize waiting state.
ALTER TABLE session_attempt_codemode_calls
  ADD COLUMN durable_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN approval_request_id uuid REFERENCES connector_action_requests(id),
  ADD COLUMN effect_digest text,
  ADD COLUMN execution_attempt_id uuid,
  ADD COLUMN execution_attempt_generation integer,
  ADD COLUMN execution_catalog_digest text;
ALTER TABLE session_attempt_codemode_calls
  ADD CONSTRAINT session_codemode_execution_catalog_fk
  FOREIGN KEY (account_id, workspace_id, session_id, turn_id, execution_attempt_id, execution_attempt_generation, execution_catalog_digest)
  REFERENCES session_attempt_tool_catalogs(account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation, digest) ON DELETE CASCADE,
  ADD CONSTRAINT session_codemode_continuation_check CHECK (
    ((execution_attempt_id IS NULL AND execution_attempt_generation IS NULL AND execution_catalog_digest IS NULL)
    OR (execution_attempt_id IS NOT NULL AND execution_attempt_generation IS NOT NULL AND execution_attempt_generation > 0 AND execution_catalog_digest IS NOT NULL AND execution_catalog_digest ~ '^[0-9a-f]{64}$'))
    AND (approval_request_id IS NULL OR (durable_approval AND effect_digest IS NOT NULL AND effect_digest ~ '^[0-9a-f]{64}$'))
  ),
  DROP CONSTRAINT session_attempt_codemode_calls_lifecycle_check,
  ADD CONSTRAINT "session_attempt_codemode_calls_lifecycle_check"
    CHECK (
      (
        "state" IN ('queued', 'waiting_for_approval')
      AND ("state" <> 'waiting_for_approval' OR "approval_request_id" IS NOT NULL)
        AND "claim_id" IS NULL
        AND "claimed_at" IS NULL
        AND "execution_started_at" IS NULL
        AND "claim_expires_at" IS NULL
        AND "completed_at" IS NULL
        AND "result" IS NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'running'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NULL
        AND "result" IS NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'completed'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "execution_started_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NOT NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'failed'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      ) OR (
        "state" = 'outcome_unknown'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "execution_started_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      ) OR (
        "state" = 'cancelled'
        AND "claim_id" IS NULL
        AND "claimed_at" IS NULL
        AND "execution_started_at" IS NULL
        AND "claim_expires_at" IS NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      )
    );
