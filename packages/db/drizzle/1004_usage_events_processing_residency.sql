-- deployment-mode: rolling
-- Where a model-backed side feature (web search, media, voice, transcription,
-- Knowledge embeddings, decision models) processed the call a usage event
-- records, for EU-only inference: geography, deployment type and regions of
-- the route's residency record, never its evidence. A nullable column without
-- default or check is a catalog-only change; the previous release never
-- writes or reads it, and null means the event did not carry one (written
-- before this column, or not a side-feature model call).
SET LOCAL lock_timeout = '5s';

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS processing_residency jsonb;
COMMENT ON COLUMN usage_events.processing_residency IS
  'Processing residency claim of the side-feature route that served the call: geography, deploymentType and regions. Never evidence text. Null when not recorded.';
