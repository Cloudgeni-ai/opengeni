-- deployment-mode: rolling
-- Nullable immutable review snapshots. Existing requests retain their original fingerprints.
ALTER TABLE connector_action_requests ADD COLUMN review_arguments text;
ALTER TABLE connector_action_requests ADD COLUMN review_context jsonb;
ALTER TABLE connector_action_requests ADD CONSTRAINT connector_review_arguments_bound CHECK (review_arguments IS NULL OR octet_length(review_arguments) <= 4194304);
ALTER TABLE connector_action_requests ADD CONSTRAINT connector_review_context_bound CHECK (review_context IS NULL OR octet_length(review_context::text) <= 4194304);
