-- deployment-mode: rolling
-- Public immutable version pinning and materialization idempotency.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "editable_artifact_versions"
  ALTER COLUMN "causal_frontier" DROP NOT NULL,
  ADD COLUMN "native_revision" bigint;

ALTER TABLE "editable_artifact_versions"
  DROP CONSTRAINT "editable_artifact_versions_facts_chk",
  ADD CONSTRAINT "editable_artifact_versions_facts_chk" CHECK (
    "head_sequence" BETWEEN 0 AND 9007199254740991
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length(convert_to("name", 'UTF8')) BETWEEN 1 AND 256
    AND "name" = btrim("name")
    AND opengeni_private.editable_artifact_identity_valid("created_by_subject_id")
    AND ((opengeni_private.editable_artifact_frontier_valid("causal_frontier")
        AND "native_revision" IS NULL)
      OR ("causal_frontier" IS NULL
        AND "native_revision" BETWEEN 0 AND 9007199254740991))
  );

DROP INDEX "editable_artifact_idempotency_receipts_artifact_request_uq";
CREATE UNIQUE INDEX "editable_artifact_idempotency_receipts_artifact_request_uq"
  ON "editable_artifact_idempotency_receipts" (
    "account_id", "workspace_id", "artifact_id", "operation_kind",
    "authority_key_digest", "idempotency_key"
  )
  WHERE "operation_kind" IN ('edit', 'snapshot', 'version', 'materialize');

ALTER TABLE "editable_artifact_idempotency_receipts"
  DROP CONSTRAINT "editable_artifact_idempotency_receipts_key_chk",
  DROP CONSTRAINT "editable_artifact_idempotency_receipts_resource_chk",
  ADD CONSTRAINT "editable_artifact_idempotency_receipts_key_chk" CHECK (
    "operation_kind" IN ('create', 'import', 'edit', 'snapshot', 'version', 'materialize')
    AND octet_length(convert_to("authority_key", 'UTF8')) BETWEEN 1 AND 8192
    AND octet_length("idempotency_key") BETWEEN 1 AND 256
    AND "idempotency_key" = btrim("idempotency_key")
  ),
  ADD CONSTRAINT "editable_artifact_idempotency_receipts_resource_chk" CHECK (
    "resource_type" IN (
      'artifact', 'transaction', 'snapshot', 'artifact_version', 'materialization_job'
    )
    AND (
      ("operation_kind" = 'create' AND "resource_type" = 'artifact'
        AND "resource_id" = "artifact_id" AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'edit' AND "resource_type" = 'transaction'
        AND "resource_id" = "server_transaction_id")
      OR ("operation_kind" = 'snapshot' AND "resource_type" = 'snapshot'
        AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'version' AND "resource_type" = 'artifact_version'
        AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'materialize'
        AND "resource_type" = 'materialization_job'
        AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'import' AND "resource_type" = 'artifact'
        AND "resource_id" = "artifact_id" AND "server_transaction_id" IS NULL)
    )
  );

DROP TRIGGER "editable_artifact_versions_projection_guard"
  ON "editable_artifact_versions";

CREATE OR REPLACE FUNCTION opengeni_private.validate_editable_artifact_version_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE artifact_modality text;
DECLARE checkpoint record;
DECLARE snapshot record;
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );

  SELECT artifact.modality INTO artifact_modality
  FROM editable_artifacts artifact
  WHERE artifact.account_id = NEW.account_id
    AND artifact.workspace_id = NEW.workspace_id
    AND artifact.id = NEW.artifact_id;

  SELECT * INTO checkpoint
  FROM editable_artifact_sequence_checkpoints candidate
  WHERE candidate.account_id = NEW.account_id
    AND candidate.workspace_id = NEW.workspace_id
    AND candidate.artifact_id = NEW.artifact_id
    AND candidate.head_sequence = NEW.head_sequence;

  SELECT * INTO snapshot
  FROM editable_artifact_snapshots candidate
  WHERE candidate.account_id = NEW.account_id
    AND candidate.workspace_id = NEW.workspace_id
    AND candidate.artifact_id = NEW.artifact_id
    AND candidate.id = NEW.snapshot_id;

  IF artifact_modality IS NULL
    OR checkpoint.head_sequence IS NULL
    OR checkpoint.modality <> artifact_modality
    OR checkpoint.state_hash <> NEW.state_hash
    OR snapshot.id IS NULL
    OR snapshot.modality <> artifact_modality
    OR snapshot.covered_head_sequence <> NEW.head_sequence
    OR snapshot.state_hash <> NEW.state_hash
    OR (artifact_modality = 'spreadsheet' AND (
      NEW.native_revision IS NOT NULL
      OR checkpoint.causal_frontier IS DISTINCT FROM NEW.causal_frontier
      OR snapshot.covered_causal_frontier IS DISTINCT FROM NEW.causal_frontier
    ))
    OR (artifact_modality IN ('document', 'presentation') AND (
      NEW.causal_frontier IS NOT NULL
      OR checkpoint.native_revision IS DISTINCT FROM NEW.native_revision
      OR snapshot.native_revision IS DISTINCT FROM NEW.native_revision
    ))
  THEN
    RAISE EXCEPTION 'artifact version does not exactly pin a verified snapshot checkpoint'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM editable_artifact_idempotency_receipts receipt
    WHERE receipt.account_id = NEW.account_id
      AND receipt.workspace_id = NEW.workspace_id
      AND receipt.artifact_id = NEW.artifact_id
      AND receipt.operation_kind = 'version'
      AND receipt.resource_type = 'artifact_version'
      AND receipt.resource_id = NEW.id
      AND receipt.server_transaction_id IS NULL
      AND opengeni_private.editable_artifact_object_has_exact_keys(
        receipt.result, ARRAY['artifactId', 'schemaVersion', 'versionId']
      )
      AND jsonb_typeof(receipt.result->'schemaVersion') = 'number'
      AND receipt.result->>'schemaVersion' = '1'
      AND jsonb_typeof(receipt.result->'artifactId') = 'string'
      AND receipt.result->>'artifactId' = NEW.artifact_id
      AND jsonb_typeof(receipt.result->'versionId') = 'string'
      AND receipt.result->>'versionId' = NEW.id
  ) THEN
    RAISE EXCEPTION 'artifact version idempotency receipt is missing'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$body$;

REVOKE ALL ON FUNCTION
  opengeni_private.validate_editable_artifact_version_projection()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER editable_artifact_versions_projection_guard
AFTER INSERT ON "editable_artifact_versions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_version_projection();

RESET statement_timeout;
RESET lock_timeout;
