-- deployment-mode: rolling
-- Recommendations and user choices have distinct provenance. Existing approval
-- rows and their immutable fingerprints remain unchanged.
ALTER TABLE connector_action_requests
  DROP CONSTRAINT connector_action_requests_policy_source_chk;
ALTER TABLE connector_action_requests
  ADD CONSTRAINT connector_action_requests_policy_source_chk
  CHECK (policy_source IN ('explicit', 'default', 'ambiguous'));
