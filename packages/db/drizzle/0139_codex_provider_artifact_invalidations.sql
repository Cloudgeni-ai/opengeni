-- deployment-mode: rolling
-- Preserve durable conversation truth while allowing an exact Codex provider
-- rejection to invalidate only its opaque, provider-bound reasoning artifact.
-- The item itself remains immutable/auditable; the model read path omits the
-- rejected identity on the next fenced attempt.

ALTER TABLE "session_history_items"
  ADD COLUMN "provider_artifact_invalidated_at" timestamptz,
  ADD COLUMN "provider_artifact_invalidation_reason" text,
  ADD COLUMN "provider_artifact_invalidated_by_attempt_id" uuid,
  ADD CONSTRAINT "session_history_items_provider_artifact_invalidation_shape_chk"
  CHECK (
    (
      "provider_artifact_invalidated_at" IS NULL
      AND "provider_artifact_invalidation_reason" IS NULL
      AND "provider_artifact_invalidated_by_attempt_id" IS NULL
    )
    OR
    (
      "provider_artifact_invalidated_at" IS NOT NULL
      AND "provider_artifact_invalidation_reason" = 'encrypted_content_rejected'
      AND "provider_artifact_invalidated_by_attempt_id" IS NOT NULL
      AND "item" ->> 'type' IN ('reasoning', 'compaction')
    )
  ) NOT VALID;

ALTER TABLE "agent_run_states"
  ADD COLUMN "provider_artifact_invalidated_at" timestamptz,
  ADD COLUMN "provider_artifact_invalidation_reason" text,
  ADD COLUMN "provider_artifact_invalidated_by_attempt_id" uuid,
  ADD CONSTRAINT "agent_run_states_provider_artifact_invalidation_shape_chk"
  CHECK (
    (
      "provider_artifact_invalidated_at" IS NULL
      AND "provider_artifact_invalidation_reason" IS NULL
      AND "provider_artifact_invalidated_by_attempt_id" IS NULL
    )
    OR
    (
      "provider_artifact_invalidated_at" IS NOT NULL
      AND "provider_artifact_invalidation_reason" = 'encrypted_content_rejected'
      AND "provider_artifact_invalidated_by_attempt_id" IS NOT NULL
    )
  ) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
