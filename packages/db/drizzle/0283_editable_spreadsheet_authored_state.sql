-- deployment-mode: maintenance
-- Hard cut to the single authored-only spreadsheet format. Existing rows are
-- deliberately not converted or validated; every new write must be current.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "editable_artifact_transactions"
  DROP CONSTRAINT "editable_artifact_transactions_result_chk";
ALTER TABLE "editable_artifact_transactions"
  ADD CONSTRAINT "editable_artifact_transactions_result_chk" CHECK (
    "prior_state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length("kernel_version") BETWEEN 1 AND 512
    AND "committed_transaction_byte_size" BETWEEN 1 AND 8388608
    AND octet_length("committed_transaction_bytes") = "committed_transaction_byte_size"
    AND "committed_transaction_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "committed_transaction_hash" =
      'sha256:' || encode(sha256("committed_transaction_bytes"), 'hex')
    AND (("modality" = 'spreadsheet'
      AND "model_schema_version" = 2
      AND "command_protocol_version" = 2
      AND "operation_protocol_version" = 2
      AND "commit_protocol_version" IS NULL
      AND "prior_native_revision" IS NULL AND "native_revision" IS NULL
      AND "command_count" IS NULL AND "native_receipt_byte_size" IS NULL
      AND "native_receipt_hash" IS NULL AND "native_receipt_bytes" IS NULL
      AND substring("committed_transaction_bytes" FROM 1 FOR 8) = convert_to('OGACO002', 'UTF8'))
      OR ("modality" IN ('document', 'presentation')
        AND "model_schema_version" = 1
        AND "command_protocol_version" = 1
        AND "operation_protocol_version" IS NULL
        AND "commit_protocol_version" = 1
        AND "prior_native_revision" BETWEEN 0 AND 9007199254740991
        AND (("modality" = 'document' AND (
          ("native_revision" = "prior_native_revision" AND "state_hash" = "prior_state_hash")
          OR ("native_revision" = "prior_native_revision" + 1
            AND "state_hash" <> "prior_state_hash")
        )) OR ("modality" = 'presentation'
          AND "native_revision" = "prior_native_revision" + 1
          AND "state_hash" <> "prior_state_hash"))
        AND "command_count" BETWEEN 1 AND 4096
        AND "native_receipt_byte_size" BETWEEN 1 AND 524288
        AND octet_length("native_receipt_bytes") = "native_receipt_byte_size"
        AND "native_receipt_hash" ~ '^sha256:[0-9a-f]{64}$'
        AND "native_receipt_hash" = 'sha256:' || encode(sha256("native_receipt_bytes"), 'hex')
        AND substring("committed_transaction_bytes" FROM 1 FOR 8) = convert_to('OGAST001', 'UTF8')
        AND get_byte("committed_transaction_bytes", 12) =
          CASE "modality" WHEN 'document' THEN 1 ELSE 2 END
        AND get_byte("committed_transaction_bytes", 13) = 0
        AND get_byte("committed_transaction_bytes", 14) = 0
        AND get_byte("committed_transaction_bytes", 15) = 0
        AND substring("native_receipt_bytes" FROM 1 FOR 8) = convert_to(
          CASE "modality" WHEN 'document' THEN 'OGADR001' ELSE 'OGAPR001' END,
          'UTF8'
        )))
  ) NOT VALID;

ALTER TABLE "editable_artifact_snapshots"
  DROP CONSTRAINT "editable_artifact_snapshots_facts_chk";
ALTER TABLE "editable_artifact_snapshots"
  ADD CONSTRAINT "editable_artifact_snapshots_facts_chk" CHECK (
    "byte_size" BETWEEN 1 AND 67108864
    AND "content_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "mime_type" = 'application/vnd.opengeni.editable-artifact-snapshot'
    AND "covered_head_sequence" BETWEEN 0 AND 9007199254740991
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND (("modality" = 'spreadsheet'
      AND "model_schema_version" = 2
      AND opengeni_private.editable_artifact_frontier_valid("covered_causal_frontier")
      AND "operation_protocol_version" = 2
      AND "crdt_state_version" = 2
      AND "native_revision" IS NULL)
      OR ("modality" IN ('document', 'presentation')
        AND "model_schema_version" = 1
        AND "covered_causal_frontier" IS NULL
        AND "operation_protocol_version" IS NULL
        AND "crdt_state_version" IS NULL
        AND "native_revision" BETWEEN 0 AND 9007199254740991))
    AND octet_length("kernel_version") BETWEEN 1 AND 512
    AND "verified_at" <= "published_at"
  ) NOT VALID;
