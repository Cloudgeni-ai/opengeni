-- deployment-mode: rolling
-- Creation receipts are internal and survive token refresh and disconnect.
ALTER TABLE connections
  ADD COLUMN create_operation_id text,
  ADD COLUMN create_request_digest text;

ALTER TABLE connections ADD CONSTRAINT connections_create_operation_pair_check
  CHECK (
    (create_operation_id IS NULL AND create_request_digest IS NULL)
    OR (create_operation_id IS NOT NULL AND create_request_digest IS NOT NULL
        AND created_by_subject_id IS NOT NULL)
  );

CREATE UNIQUE INDEX connections_create_operation_uq
  ON connections (workspace_id, created_by_subject_id, create_operation_id)
  WHERE create_operation_id IS NOT NULL;