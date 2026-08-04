-- deployment-mode: rolling
-- Explicit, replay-safe document authority reclassification. This is an
-- additive mixed-version seam: old writers may continue ordinary inserts and
-- metadata updates, while authority changes require one immutable receipt in
-- the same transaction. Collections/bases are recorded only as audit context
-- and never participate in the authority decision.

CREATE TABLE "document_authority_reclassifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "transaction_id" bigint NOT NULL DEFAULT txid_current(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL,
  "base_id_snapshot" uuid NOT NULL,
  "actor_subject_id" text NOT NULL,
  "source_authority_kind" text NOT NULL,
  "source_authority_workspace_id" uuid,
  "source_authority_subject_id" text,
  "target_authority_kind" text NOT NULL,
  "target_authority_workspace_id" uuid,
  "target_authority_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_authority_reclassifications_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "document_authority_reclassifications_request_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
    AND length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "document_authority_reclassifications_source_chk" CHECK (
    ("source_authority_kind" = 'organization'
      AND "source_authority_workspace_id" IS NULL
      AND "source_authority_subject_id" IS NULL)
    OR ("source_authority_kind" = 'workspace'
      AND "source_authority_workspace_id" = "workspace_id"
      AND "source_authority_subject_id" IS NULL)
    OR ("source_authority_kind" = 'personal'
      AND "source_authority_workspace_id" = "workspace_id"
      AND NULLIF(btrim("source_authority_subject_id"), '') IS NOT NULL
      AND octet_length(convert_to("source_authority_subject_id", 'UTF8')) <= 1024)
  ),
  CONSTRAINT "document_authority_reclassifications_target_chk" CHECK (
    ("target_authority_kind" = 'organization'
      AND "target_authority_workspace_id" IS NULL
      AND "target_authority_subject_id" IS NULL)
    OR ("target_authority_kind" = 'workspace'
      AND "target_authority_workspace_id" = "workspace_id"
      AND "target_authority_subject_id" IS NULL)
    OR ("target_authority_kind" = 'personal'
      AND "target_authority_workspace_id" = "workspace_id"
      AND "target_authority_subject_id" = "actor_subject_id"
      AND octet_length(convert_to("target_authority_subject_id", 'UTF8')) <= 1024)
  )
);

CREATE INDEX "document_authority_reclassifications_document_time_idx"
  ON "document_authority_reclassifications" ("document_id", "created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION opengeni_private.reject_document_authority_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'document authority reclassification receipts are immutable';
END
$$;

CREATE TRIGGER document_authority_reclassifications_immutable
BEFORE UPDATE OR DELETE ON "document_authority_reclassifications"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_authority_receipt_mutation();

ALTER TABLE "document_authority_reclassifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_authority_reclassifications" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "document_authority_reclassifications"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- Preserve the ordinary immutable-authority rule, but allow exactly one
-- same-transaction change whose receipt matches the complete before/after
-- tuple. A caller-provided GUC alone is never sufficient: the immutable row,
-- operation id, transaction id, document identity, and both tuples must agree.
CREATE OR REPLACE FUNCTION opengeni_private.apply_document_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_id_text text;
  receipt_matches boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
  ) THEN
    operation_id_text := current_setting('opengeni.document_authority_operation_id', true);
    IF operation_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      SELECT EXISTS (
        SELECT 1
        FROM "document_authority_reclassifications" receipt
        WHERE receipt."operation_id" = operation_id_text::uuid
          AND receipt."transaction_id" = txid_current()
          AND receipt."account_id" = NEW."account_id"
          AND receipt."workspace_id" = NEW."workspace_id"
          AND receipt."document_id" = NEW."id"
          AND receipt."source_authority_kind" = OLD."authority_kind"
          AND receipt."source_authority_workspace_id" IS NOT DISTINCT FROM OLD."authority_workspace_id"
          AND receipt."source_authority_subject_id" IS NOT DISTINCT FROM OLD."authority_subject_id"
          AND receipt."target_authority_kind" = NEW."authority_kind"
          AND receipt."target_authority_workspace_id" IS NOT DISTINCT FROM NEW."authority_workspace_id"
          AND receipt."target_authority_subject_id" IS NOT DISTINCT FROM NEW."authority_subject_id"
      ) INTO receipt_matches;
    END IF;
    IF NOT receipt_matches THEN
      RAISE EXCEPTION 'document authority is immutable outside an explicit reclassification';
    END IF;
  END IF;

  IF NEW.authority_kind IS NULL OR (
    NEW.authority_kind = 'workspace'
    AND NEW.authority_workspace_id IS NULL
    AND NEW.visibility = 'private'
  ) THEN
    NEW.authority_kind := CASE WHEN NEW.visibility = 'private' THEN 'personal' ELSE 'workspace' END;
  END IF;
  CASE NEW.authority_kind
    WHEN 'organization' THEN
      NEW.authority_workspace_id := NULL;
      NEW.authority_subject_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'workspace' THEN
      NEW.authority_workspace_id := NEW.workspace_id;
      NEW.authority_subject_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'personal' THEN
      NEW.authority_workspace_id := NEW.workspace_id;
      NEW.authority_subject_id := coalesce(NULLIF(btrim(NEW.authority_subject_id), ''), NULLIF(btrim(NEW.created_by), ''));
      NEW.visibility := 'private';
    ELSE
      RAISE EXCEPTION 'invalid document authority kind: %', NEW.authority_kind;
  END CASE;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION opengeni_private.apply_document_chunk_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent "documents"%ROWTYPE;
  operation_id_text text;
  receipt_matches boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
  ) THEN
    operation_id_text := current_setting('opengeni.document_authority_operation_id', true);
    IF operation_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      SELECT EXISTS (
        SELECT 1
        FROM "document_authority_reclassifications" receipt
        WHERE receipt."operation_id" = operation_id_text::uuid
          AND receipt."transaction_id" = txid_current()
          AND receipt."account_id" = NEW."account_id"
          AND receipt."workspace_id" = NEW."workspace_id"
          AND receipt."document_id" = NEW."document_id"
          AND receipt."source_authority_kind" = OLD."authority_kind"
          AND receipt."source_authority_workspace_id" IS NOT DISTINCT FROM OLD."authority_workspace_id"
          AND receipt."source_authority_subject_id" IS NOT DISTINCT FROM OLD."authority_subject_id"
          AND receipt."target_authority_kind" = NEW."authority_kind"
          AND receipt."target_authority_workspace_id" IS NOT DISTINCT FROM NEW."authority_workspace_id"
          AND receipt."target_authority_subject_id" IS NOT DISTINCT FROM NEW."authority_subject_id"
      ) INTO receipt_matches;
    END IF;
    IF NOT receipt_matches THEN
      RAISE EXCEPTION 'document chunk authority is immutable outside an explicit reclassification';
    END IF;
  END IF;
  SELECT * INTO parent FROM "documents" WHERE "id" = NEW.document_id;
  IF NOT FOUND
    OR parent.account_id IS DISTINCT FROM NEW.account_id
    OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent.base_id IS DISTINCT FROM NEW.base_id
    OR parent.file_id IS DISTINCT FROM NEW.file_id
  THEN
    RAISE EXCEPTION 'document chunk parent identity mismatch';
  END IF;
  NEW.authority_kind := parent.authority_kind;
  NEW.authority_workspace_id := parent.authority_workspace_id;
  NEW.authority_subject_id := parent.authority_subject_id;
  RETURN NEW;
END
$$;
