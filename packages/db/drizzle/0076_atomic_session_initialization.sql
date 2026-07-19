-- deployment-mode: rolling
-- OPE-51: canonical, retry-verifiable initial session creation.
--
-- This is intentionally not backfilled. A legacy row has no durable copy of
-- every original request semantic (notably an uncommitted goal/client event),
-- so marking it complete or inventing missing history would be unsafe.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS create_request_fingerprint text,
  ADD COLUMN IF NOT EXISTS initialization_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS initial_workflow_wake_revision bigint;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_initialization_version_check
    CHECK (initialization_version IN (0, 1)) NOT VALID,
  ADD CONSTRAINT sessions_create_request_fingerprint_check
    CHECK (
      create_request_fingerprint IS NULL
      OR create_request_fingerprint ~ '^v1:[0-9a-f]{64}$'
    ) NOT VALID,
  ADD CONSTRAINT sessions_initial_workflow_wake_revision_check
    CHECK (
      initial_workflow_wake_revision IS NULL
      OR initial_workflow_wake_revision > 0
    ) NOT VALID,
  ADD CONSTRAINT sessions_canonical_initialization_receipt_check
    CHECK (
      initialization_version = 0
      OR (
        initialization_version = 1
        AND create_request_fingerprint IS NOT NULL
        AND temporal_workflow_id IS NOT NULL
      )
    ) NOT VALID;

COMMENT ON COLUMN sessions.create_request_fingerprint IS
  'Opaque v1 fingerprint of normalized create-request identity; credential material is keyed-HMACed before persistence; NULL means legacy/uncomparable.';
COMMENT ON COLUMN sessions.initialization_version IS
  '0 legacy or fenced repair candidate; 1 complete canonical atomic initialization.';
COMMENT ON COLUMN sessions.initial_workflow_wake_revision IS
  'Exact wake revision committed by canonical initialization; NULL when creation was control-blocked.';