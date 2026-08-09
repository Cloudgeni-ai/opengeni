-- deployment-mode: rolling

-- The router ledger is audit/idempotency evidence only. It never owns active
-- Memory, Preference Registry, instruction-policy, company-profile, or
-- Documents/RAG state. Attempts and terminal receipts are append-only; the
-- selected canonical authority retains its own lifecycle history.
CREATE TABLE "durable_learning_attempts" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "contract_version" text NOT NULL,
  "operation" text NOT NULL,
  "origin" text NOT NULL,
  "input_hash" text NOT NULL,
  "request" jsonb NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  -- Insert-time trigger validation binds this UUID to the exact tenant. It is
  -- intentionally not an FK: session deletion must not rewrite immutable audit.
  "session_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_learning_attempts_tenant_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "id"),
  CONSTRAINT "durable_learning_attempts_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "durable_learning_attempts_contract_chk" CHECK (
    "contract_version" = 'durable-learning.v1'
    AND "operation" IN ('write', 'rollback')
    AND "origin" IN (
      'explicit_remember',
      'autonomous_learning',
      'legacy_memory_save',
      'human_admin',
      'migration'
    )
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("request") = 'object'
    AND octet_length("request"::text) <= 1048576
    AND "request" ->> 'contractVersion' = "contract_version"
    AND "request" ->> 'operation' = "operation"
    AND "request" ->> 'origin' = "origin"
    AND "request" ->> 'attemptId' = "id"::text
  ),
  CONSTRAINT "durable_learning_attempts_actor_chk" CHECK (
    "actor_kind" IN ('human', 'agent', 'service')
    AND length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND (
      "initiating_human_subject_id" IS NULL
      OR length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    )
    AND ("origin" = 'migration' OR "initiating_human_subject_id" IS NOT NULL)
  )
);

CREATE INDEX "durable_learning_attempts_workspace_time_idx"
  ON "durable_learning_attempts" ("workspace_id", "created_at" DESC, "id" DESC);

CREATE TABLE "durable_learning_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "outcome" text NOT NULL,
  "destination" text,
  "resource_id" text,
  "receipt" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_learning_receipts_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "attempt_id"),
  CONSTRAINT "durable_learning_receipts_attempt_fk"
    FOREIGN KEY ("account_id", "workspace_id", "attempt_id")
    REFERENCES "durable_learning_attempts"("account_id", "workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "durable_learning_receipts_contract_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "outcome" IN (
      'applied',
      'proposed',
      'evidence_recorded',
      'noop',
      'clarification_required',
      'rejected',
      'rolled_back',
      'failed'
    )
    AND (
      "destination" IS NULL
      OR "destination" IN (
        'memory',
        'preference_registry',
        'instruction_policy',
        'company_profile',
        'documents_evidence'
      )
    )
    AND jsonb_typeof("receipt") = 'object'
    AND octet_length("receipt"::text) <= 262144
    AND "receipt" ->> 'contractVersion' = 'durable-learning.v1'
    AND "receipt" ->> 'attemptId' = "attempt_id"::text
    AND "receipt" ->> 'inputHash' = "input_hash"
    AND "receipt" ->> 'outcome' = "outcome"
    AND "receipt" #>> '{decision,destination}' IS NOT DISTINCT FROM "destination"
    AND "receipt" #>> '{resource,id}' IS NOT DISTINCT FROM "resource_id"
  )
);

CREATE INDEX "durable_learning_receipts_workspace_time_idx"
  ON "durable_learning_receipts" ("workspace_id", "created_at" DESC, "id" DESC);

-- The selected authority records its exact compatibility result in the same
-- transaction as the authority effect. This is immutable replay evidence, not
-- active Memory/Documents/policy authority, and terminal replay reads it
-- without invoking the mutable authority again.
CREATE TABLE "durable_learning_authority_results" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "effect_kind" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_learning_authority_results_pk"
    PRIMARY KEY ("account_id", "workspace_id", "attempt_id"),
  CONSTRAINT "durable_learning_authority_results_attempt_fk"
    FOREIGN KEY ("account_id", "workspace_id", "attempt_id")
    REFERENCES "durable_learning_attempts"("account_id", "workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "durable_learning_authority_results_contract_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "effect_kind" IN ('memory_write', 'memory_rollback')
    AND jsonb_typeof("result") = 'object'
    AND octet_length("result"::text) <= 1048576
  )
);

CREATE INDEX "durable_learning_authority_results_workspace_time_idx"
  ON "durable_learning_authority_results" ("workspace_id", "created_at" DESC, "attempt_id" DESC);

-- Coordination is deliberately separate from immutable audit evidence. A live
-- claim excludes concurrent adapter execution; expiry lets a crashed executor
-- retry the same authority operation id without rewriting its attempt.
CREATE TABLE "durable_learning_attempt_claims" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "claimed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "durable_learning_attempt_claims_pk"
    PRIMARY KEY ("account_id", "workspace_id", "attempt_id"),
  CONSTRAINT "durable_learning_attempt_claims_attempt_fk"
    FOREIGN KEY ("account_id", "workspace_id", "attempt_id")
    REFERENCES "durable_learning_attempts"("account_id", "workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "durable_learning_attempt_claims_time_chk"
    CHECK ("expires_at" > "claimed_at")
);

CREATE INDEX "durable_learning_attempt_claims_expiry_idx"
  ON "durable_learning_attempt_claims" ("workspace_id", "expires_at", "attempt_id");

CREATE FUNCTION durable_learning_validate_attempt_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."session_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "sessions" session
    WHERE session."id" = NEW."session_id"
      AND session."account_id" = NEW."account_id"
      AND session."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'durable learning attempt session is outside its exact account/workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER durable_learning_attempts_validate_session
  BEFORE INSERT ON "durable_learning_attempts"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_validate_attempt_session();

CREATE FUNCTION durable_learning_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (
    NOT EXISTS (
      SELECT 1 FROM "managed_accounts" account WHERE account."id" = OLD."account_id"
    )
    OR NOT EXISTS (
      SELECT 1 FROM "workspaces" workspace WHERE workspace."id" = OLD."workspace_id"
    )
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'durable learning attempts and receipts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER durable_learning_attempts_immutable
  BEFORE UPDATE OR DELETE ON "durable_learning_attempts"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_reject_mutation();

CREATE TRIGGER durable_learning_receipts_immutable
  BEFORE UPDATE OR DELETE ON "durable_learning_receipts"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_reject_mutation();

CREATE TRIGGER durable_learning_authority_results_immutable
  BEFORE UPDATE OR DELETE ON "durable_learning_authority_results"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_reject_mutation();

ALTER TABLE "durable_learning_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_authority_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_authority_results" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempt_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempt_claims" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "durable_learning_attempts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "durable_learning_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "durable_learning_authority_results"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "durable_learning_attempt_claims"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

REVOKE ALL ON TABLE
  "durable_learning_attempts",
  "durable_learning_receipts",
  "durable_learning_authority_results",
  "durable_learning_attempt_claims"
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON TABLE
      "durable_learning_attempts", "durable_learning_receipts",
      "durable_learning_authority_results"
      TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "durable_learning_attempt_claims"
      TO opengeni_app;
  END IF;
END $$;
