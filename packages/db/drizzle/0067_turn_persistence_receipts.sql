-- deployment-mode: rolling
-- OPE-73: admit every provider call before its external boundary, then keep
-- full post-effect persistence obligations in PostgreSQL. Temporal heartbeat
-- and activity-result payloads carry only bounded opaque references.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "session_turn_model_call_admissions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "trigger_event_id" uuid NOT NULL,
  "call_index" integer NOT NULL,
  "call_kind" text NOT NULL,
  "provider" text NOT NULL,
  "provider_api" text NOT NULL,
  "model" text NOT NULL,
  "persistence_receipt_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "receipt_established_at" timestamp with time zone,
  CONSTRAINT "session_turn_model_call_admissions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_model_call_admissions_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_model_call_admissions_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_model_call_admissions_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_model_call_admissions_index_check"
    CHECK ("call_index" > 0),
  CONSTRAINT "session_turn_model_call_admissions_kind_check"
    CHECK ("call_kind" IN ('agent_model', 'context_compaction')),
  CONSTRAINT "session_turn_model_call_admissions_api_check"
    CHECK ("provider_api" IN ('responses', 'chat')),
  CONSTRAINT "session_turn_model_call_admissions_receipt_check" CHECK (
    ("persistence_receipt_id" IS NULL AND "receipt_established_at" IS NULL)
    OR ("persistence_receipt_id" IS NOT NULL AND "receipt_established_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "session_turn_model_call_admissions_workspace_id_uq"
  ON "session_turn_model_call_admissions" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_turn_model_call_admissions_attempt_index_uq"
  ON "session_turn_model_call_admissions" ("workspace_id", "attempt_id", "call_index");
CREATE UNIQUE INDEX "session_turn_model_call_admissions_one_unlinked_attempt_uq"
  ON "session_turn_model_call_admissions" ("workspace_id", "attempt_id")
  WHERE "persistence_receipt_id" IS NULL;
CREATE UNIQUE INDEX "session_turn_model_call_admissions_receipt_uq"
  ON "session_turn_model_call_admissions" ("workspace_id", "persistence_receipt_id")
  WHERE "persistence_receipt_id" IS NOT NULL;

CREATE TABLE "session_turn_persistence_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "trigger_event_id" uuid NOT NULL,
  "model_call_admission_id" uuid,
  "obligation_kind" text NOT NULL,
  "obligation_version" integer DEFAULT 1 NOT NULL,
  "obligation_digest" text NOT NULL,
  "obligation" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "quarantine_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "quarantined_at" timestamp with time zone,
  CONSTRAINT "session_turn_persistence_receipts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_persistence_receipts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_workspace_model_call_admission_fk"
    FOREIGN KEY ("workspace_id", "model_call_admission_id")
    REFERENCES "session_turn_model_call_admissions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_kind_check"
    CHECK ("obligation_kind" IN ('pending_tool_call', 'model_call', 'context_compaction')),
  CONSTRAINT "session_turn_persistence_receipts_model_call_admission_check" CHECK (
    ("obligation_kind" = 'pending_tool_call' AND "model_call_admission_id" IS NULL)
    OR ("obligation_kind" IN ('model_call', 'context_compaction') AND "model_call_admission_id" IS NOT NULL)
  ),
  CONSTRAINT "session_turn_persistence_receipts_version_check"
    CHECK ("obligation_version" = 1),
  CONSTRAINT "session_turn_persistence_receipts_digest_check"
    CHECK ("obligation_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_turn_persistence_receipts_state_check"
    CHECK ("state" IN ('pending', 'settled', 'quarantined')),
  CONSTRAINT "session_turn_persistence_receipts_terminal_check" CHECK (
    ("state" = 'pending' AND "settled_at" IS NULL AND "quarantined_at" IS NULL AND "quarantine_reason" IS NULL)
    OR ("state" = 'settled' AND "settled_at" IS NOT NULL AND "quarantined_at" IS NULL AND "quarantine_reason" IS NULL)
    OR ("state" = 'quarantined' AND "settled_at" IS NULL AND "quarantined_at" IS NOT NULL AND "quarantine_reason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "session_turn_persistence_receipts_workspace_id_uq"
  ON "session_turn_persistence_receipts" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_turn_persistence_receipts_model_call_admission_uq"
  ON "session_turn_persistence_receipts" ("workspace_id", "model_call_admission_id")
  WHERE "model_call_admission_id" IS NOT NULL;
CREATE UNIQUE INDEX "session_turn_persistence_receipts_one_pending_attempt_uq"
  ON "session_turn_persistence_receipts" ("workspace_id", "attempt_id")
  WHERE "state" = 'pending';
CREATE INDEX "session_turn_persistence_receipts_attempt_created_idx"
  ON "session_turn_persistence_receipts" ("workspace_id", "attempt_id", "created_at");

ALTER TABLE "session_turn_model_call_admissions"
  ADD CONSTRAINT "session_turn_model_call_admissions_workspace_receipt_fk"
  FOREIGN KEY ("workspace_id", "persistence_receipt_id")
  REFERENCES "session_turn_persistence_receipts"("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "session_turn_model_call_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_model_call_admissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_turn_model_call_admissions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
ALTER TABLE "session_turn_persistence_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_persistence_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_turn_persistence_receipts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_turn_model_call_admissions TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_turn_persistence_receipts TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;