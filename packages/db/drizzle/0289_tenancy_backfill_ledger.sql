-- deployment-mode: rolling
-- Tenancy backfill receipt and unresolved-row ledger (OPE-204 phase D).
--
-- `docs/organization-tenancy.md` phase D requires that backfill "record
-- backfill receipts and unresolved rows without widening access". This
-- migration owns only that ledger. It classifies nothing, reads no resource
-- table, and grants no authority: a receipt is content-free bookkeeping about
-- a backfill run, and an unresolved row records only that one exact resource
-- id could not be deterministically classified, plus a fixed reason code.
--
-- Two properties are load-bearing and deliberately enforced in the schema
-- rather than in application code:
--
--   1. The ledger can never widen access. It stores resource ids and fixed
--      reason codes only - never resource content, names, subjects, owners, or
--      any proposed authority. An unresolved row is an explicit refusal to
--      infer, so it must not carry the inference it declined to make.
--   2. `opengeni_app` holds no direct DML on either table. Both are FORCE RLS
--      and gated by the existing `opengeni.organization_tenancy_lifecycle`
--      GUC (0263's pattern) under the new `tenancy_backfill_ledger` operation
--      name, so the only write path is the SECURITY DEFINER seam below.
--
-- Unresolved rows are append-only: a row is a durable record that a human or a
-- later deterministic rule must resolve it, and silently mutating or deleting
-- one would erase the obligation. Receipts advance only forward through their
-- own lifecycle function.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "tenancy_backfill_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts" ("id") ON DELETE CASCADE,
  "resource_family" text NOT NULL,
  "run_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "classified_count" bigint NOT NULL DEFAULT 0,
  "skipped_count" bigint NOT NULL DEFAULT 0,
  "unresolved_count" bigint NOT NULL DEFAULT 0,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenancy_backfill_receipt_family_chk" CHECK (
    "resource_family" IN (
      'organization_memberships',
      'personal_workspaces',
      'sessions',
      'variable_sets',
      'rigs',
      'machines',
      'connections',
      'documents',
      'codex_credentials'
    )
  ),
  CONSTRAINT "tenancy_backfill_receipt_status_chk" CHECK (
    "status" IN ('open', 'completed', 'failed')
  ),
  CONSTRAINT "tenancy_backfill_receipt_counts_chk" CHECK (
    "classified_count" >= 0 AND "skipped_count" >= 0 AND "unresolved_count" >= 0
  ),
  CONSTRAINT "tenancy_backfill_receipt_run_key_chk" CHECK (
    length("run_key") BETWEEN 1 AND 200
  ),
  -- A terminal receipt must be stamped; an open one must not be.
  CONSTRAINT "tenancy_backfill_receipt_completion_chk" CHECK (
    ("status" = 'open' AND "completed_at" IS NULL)
    OR ("status" <> 'open' AND "completed_at" IS NOT NULL)
  )
);

-- One receipt per (organization, resource family, run). This is the
-- idempotency anchor: a re-run with the same key adopts the existing receipt
-- rather than creating a second, so a retried or resumed sweep cannot
-- double-count.
CREATE UNIQUE INDEX "tenancy_backfill_receipt_run_uq"
  ON "tenancy_backfill_receipts" ("account_id", "resource_family", "run_key");
CREATE INDEX "tenancy_backfill_receipt_account_time_idx"
  ON "tenancy_backfill_receipts" ("account_id", "started_at", "id");

CREATE TABLE "tenancy_backfill_unresolved_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "receipt_id" uuid NOT NULL
    REFERENCES "tenancy_backfill_receipts" ("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts" ("id") ON DELETE CASCADE,
  "resource_family" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenancy_backfill_unresolved_family_chk" CHECK (
    "resource_family" IN (
      'organization_memberships',
      'personal_workspaces',
      'sessions',
      'variable_sets',
      'rigs',
      'machines',
      'connections',
      'documents',
      'codex_credentials'
    )
  ),
  -- Fixed, content-free vocabulary. Every code states why classification was
  -- refused; none of them encodes a guess about what the answer might be.
  CONSTRAINT "tenancy_backfill_unresolved_reason_chk" CHECK (
    "reason_code" IN (
      'no_deterministic_evidence',
      'ambiguous_candidate_authority',
      'missing_organization_membership',
      'conflicting_authority_rows',
      'external_lane_owns_row',
      'legacy_shape_unrecognized'
    )
  )
);

-- One unresolved record per resource per receipt, so a resumed sweep that
-- re-observes the same row does not inflate the obligation count.
CREATE UNIQUE INDEX "tenancy_backfill_unresolved_row_uq"
  ON "tenancy_backfill_unresolved_rows" ("receipt_id", "resource_family", "resource_id");
CREATE INDEX "tenancy_backfill_unresolved_account_family_idx"
  ON "tenancy_backfill_unresolved_rows" ("account_id", "resource_family", "observed_at");

ALTER TABLE "tenancy_backfill_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy_backfill_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenancy_backfill_unresolved_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy_backfill_unresolved_rows" FORCE ROW LEVEL SECURITY;

-- Writes are reachable only from the lifecycle seam below, which is the sole
-- setter of this GUC value. Reads additionally stay organization-scoped.
DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "tenancy_backfill_receipts";
CREATE POLICY organization_tenancy_lifecycle ON "tenancy_backfill_receipts"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('tenancy_backfill_ledger'))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('tenancy_backfill_ledger'));

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "tenancy_backfill_unresolved_rows";
CREATE POLICY organization_tenancy_lifecycle ON "tenancy_backfill_unresolved_rows"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('tenancy_backfill_ledger'))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('tenancy_backfill_ledger'));

-- Unresolved rows are append-only evidence. Cascade cleanup from a deleted
-- organization or receipt is permitted; a direct rewrite is not.
--
-- The permitted-cascade test is deliberately NOT "is the parent row gone".
-- This function is SECURITY DEFINER, so its reads run as the table owner, and
-- under FORCE RLS with no lifecycle GUC set the owner sees zero rows in
-- `tenancy_backfill_receipts`. A parent-absence probe therefore reports
-- "parent gone" while the receipt is very much alive, and any nested delete
-- (`pg_trigger_depth() > 1`) would slip through - the guard would be weakest
-- exactly where the caller is most privileged. The test harness cannot catch
-- that, because it migrates as a superuser, for whom FORCE RLS never engages.
--
-- Instead the exemption is proven from referential provenance: PostgreSQL runs
-- FK `ON DELETE CASCADE` as an internal RI trigger, which is the only context
-- this guard may yield to. We claim the lifecycle GUC before probing so the
-- owner's own reads are policy-visible, and restore whatever the caller had.
CREATE OR REPLACE FUNCTION guard_tenancy_backfill_unresolved_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  previous_lifecycle_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  parent_alive boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
      );
      SELECT EXISTS (SELECT 1 FROM managed_accounts WHERE id = OLD.account_id)
         AND EXISTS (SELECT 1 FROM tenancy_backfill_receipts WHERE id = OLD.receipt_id)
        INTO parent_alive;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        coalesce(previous_lifecycle_marker, ''), true
      );
      IF NOT parent_alive THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'tenancy backfill unresolved rows are append-only'
      USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'tenancy backfill unresolved rows are immutable'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER guard_tenancy_backfill_unresolved_row
  BEFORE UPDATE OR DELETE ON "tenancy_backfill_unresolved_rows"
  FOR EACH ROW EXECUTE FUNCTION guard_tenancy_backfill_unresolved_row();

-- Opens or adopts the receipt for one exact (organization, family, run).
-- Idempotent: a resumed sweep re-adopts its own open receipt and never opens a
-- second one. Re-opening a settled receipt is refused rather than silently
-- reviving it, because its counts are already evidence.
--
-- Idempotency is CONCURRENT, not merely serial. `SELECT ... FOR UPDATE` locks
-- nothing when no row exists yet, so two sweeps opening the same run key would
-- both fall through to the INSERT and one would surface a raw `23505` instead
-- of adopting its peer's receipt. The insert therefore yields to the unique
-- index (`ON CONFLICT DO NOTHING`) and re-selects the winner's row under the
-- same lock. Under READ COMMITTED, PostgreSQL's speculative insertion has
-- already waited for the conflicting transaction, so the re-select either sees
-- the committed winner or (if that peer rolled back) the retried insert
-- succeeded and there is nothing to re-read.
CREATE OR REPLACE FUNCTION open_tenancy_backfill_receipt(
  p_account_id uuid,
  p_resource_family text,
  p_run_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  previous_lifecycle_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  receipt_id uuid;
  receipt_status text;
BEGIN
  IF p_account_id IS NULL OR p_resource_family IS NULL OR p_run_key IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill receipt requires organization, family, and run key'
      USING ERRCODE = '22004';
  END IF;

  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy backfill ledger scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
  );

  SELECT existing.id, existing.status INTO receipt_id, receipt_status
  FROM tenancy_backfill_receipts existing
  WHERE existing.account_id = p_account_id
    AND existing.resource_family = p_resource_family
    AND existing.run_key = p_run_key
  FOR UPDATE;

  IF receipt_id IS NULL THEN
    INSERT INTO tenancy_backfill_receipts (account_id, resource_family, run_key)
    VALUES (p_account_id, p_resource_family, p_run_key)
    ON CONFLICT ("account_id", "resource_family", "run_key") DO NOTHING
    RETURNING id, status INTO receipt_id, receipt_status;

    IF receipt_id IS NULL THEN
      -- A concurrent opener committed the same run key first: adopt its row.
      SELECT existing.id, existing.status INTO receipt_id, receipt_status
      FROM tenancy_backfill_receipts existing
      WHERE existing.account_id = p_account_id
        AND existing.resource_family = p_resource_family
        AND existing.run_key = p_run_key
      FOR UPDATE;

      IF receipt_id IS NULL THEN
        RAISE EXCEPTION 'tenancy backfill receipt for run key % could not be opened or adopted',
          p_run_key
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  IF receipt_status <> 'open' THEN
    RAISE EXCEPTION 'tenancy backfill receipt % is already settled', receipt_id
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    coalesce(previous_lifecycle_marker, ''), true
  );
  RETURN receipt_id;
END;
$$;

-- Records that one exact resource could not be deterministically classified.
-- Deliberately takes no authority/owner/subject argument: this seam exists to
-- record a refusal to infer, so it must be impossible to smuggle a guess
-- through it. Idempotent per (receipt, family, resource).
CREATE OR REPLACE FUNCTION record_tenancy_backfill_unresolved(
  p_receipt_id uuid,
  p_resource_id uuid,
  p_reason_code text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  previous_lifecycle_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  receipt_row record;
  inserted_count integer;
BEGIN
  IF p_receipt_id IS NULL OR p_resource_id IS NULL OR p_reason_code IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill unresolved row requires receipt, resource, and reason'
      USING ERRCODE = '22004';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
  );

  SELECT receipt.id, receipt.account_id, receipt.resource_family, receipt.status
    INTO receipt_row
  FROM tenancy_backfill_receipts receipt
  WHERE receipt.id = p_receipt_id
  FOR UPDATE;

  IF receipt_row.id IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill receipt % does not exist', p_receipt_id
      USING ERRCODE = '23503';
  END IF;
  IF receipt_row.account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy backfill ledger scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF receipt_row.status <> 'open' THEN
    RAISE EXCEPTION 'tenancy backfill receipt % is already settled', p_receipt_id
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO tenancy_backfill_unresolved_rows (
    receipt_id, account_id, resource_family, resource_id, reason_code
  )
  VALUES (
    receipt_row.id, receipt_row.account_id, receipt_row.resource_family,
    p_resource_id, p_reason_code
  )
  ON CONFLICT ("receipt_id", "resource_family", "resource_id") DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count > 0 THEN
    UPDATE tenancy_backfill_receipts
    SET unresolved_count = unresolved_count + 1, updated_at = now()
    WHERE id = receipt_row.id;
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    coalesce(previous_lifecycle_marker, ''), true
  );
END;
$$;

-- Settles a receipt. The unresolved count is owned by the append path above
-- and is never supplied by the caller, so a caller cannot understate its own
-- outstanding obligations.
CREATE OR REPLACE FUNCTION complete_tenancy_backfill_receipt(
  p_receipt_id uuid,
  p_classified_count bigint,
  p_skipped_count bigint,
  p_status text DEFAULT 'completed'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  previous_lifecycle_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  receipt_status text;
  receipt_account_id uuid;
BEGIN
  IF p_receipt_id IS NULL OR p_classified_count IS NULL OR p_skipped_count IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill completion requires receipt and counts'
      USING ERRCODE = '22004';
  END IF;
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'tenancy backfill completion status must be completed or failed'
      USING ERRCODE = '22023';
  END IF;
  IF p_classified_count < 0 OR p_skipped_count < 0 THEN
    RAISE EXCEPTION 'tenancy backfill counts must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
  );

  SELECT receipt.status, receipt.account_id INTO receipt_status, receipt_account_id
  FROM tenancy_backfill_receipts receipt
  WHERE receipt.id = p_receipt_id
  FOR UPDATE;

  IF receipt_status IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill receipt % does not exist', p_receipt_id
      USING ERRCODE = '23503';
  END IF;
  IF receipt_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy backfill ledger scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF receipt_status <> 'open' THEN
    RAISE EXCEPTION 'tenancy backfill receipt % is already settled', p_receipt_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE tenancy_backfill_receipts
  SET status = p_status,
      classified_count = p_classified_count,
      skipped_count = p_skipped_count,
      completed_at = now(),
      updated_at = now()
  WHERE id = p_receipt_id;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    coalesce(previous_lifecycle_marker, ''), true
  );
END;
$$;

REVOKE ALL ON TABLE "tenancy_backfill_receipts" FROM PUBLIC;
REVOKE ALL ON TABLE "tenancy_backfill_unresolved_rows" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_tenancy_backfill_unresolved_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION open_tenancy_backfill_receipt(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_tenancy_backfill_unresolved(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_tenancy_backfill_receipt(uuid,bigint,bigint,text) FROM PUBLIC;

DO $tenancy_backfill_ledger_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- No direct DML: the lifecycle seam is the only write path, and reads go
    -- through it or through an operator command running as the owner.
    REVOKE ALL ON TABLE "tenancy_backfill_receipts" FROM opengeni_app;
    REVOKE ALL ON TABLE "tenancy_backfill_unresolved_rows" FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION open_tenancy_backfill_receipt(uuid,text,text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION record_tenancy_backfill_unresolved(uuid,uuid,text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION complete_tenancy_backfill_receipt(uuid,bigint,bigint,text)
      TO opengeni_app;
  END IF;
END $tenancy_backfill_ledger_grants$;
